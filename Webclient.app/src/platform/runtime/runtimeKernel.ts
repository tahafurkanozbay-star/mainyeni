import {
  abortError,
  asNonEmptyString,
  immutableArray,
  isAbortLike,
  positiveInteger,
  throwIfAborted,
  type ResourceReservation,
  type ReservationRequest,
  type RuntimeBudgetOverrides,
  type RuntimeFailure,
  type RuntimeKernelSnapshot,
  type RuntimeKernelStartOptions,
  type RuntimeKernelStopOptions,
  type RuntimePhase,
  type ScheduledTaskOptions,
} from './contracts';
import {
  createCapabilityWatcher,
  type CapabilityDependencies,
  type CapabilityWatcher,
} from './capabilityProfile';
import {
  createResourceBudgetManager,
  createRuntimeBudget,
  type ResourceBudgetManager,
} from './resourceBudget';
import {
  createTaskScheduler,
  type RuntimeTaskScheduler,
  type TaskExecutor,
} from './taskScheduler';
import {
  createRuntimeTelemetry,
  type RuntimeTelemetry,
} from './privacyTelemetry';
import {
  createCircuitBreaker,
  executeWithRetry,
  type CircuitBreaker,
  type CircuitBreakerOptions,
  type RetryExecutionOptions,
} from './resilience';

export interface RuntimeKernelModuleContext {
  readonly signal: AbortSignal;
  readonly telemetry: RuntimeTelemetry;
  readonly scheduler: RuntimeTaskScheduler;
  readonly budget: ResourceBudgetManager;
  readonly kernel: RuntimeKernel;
}

export interface RuntimeKernelModule {
  readonly id: string;
  readonly order?: number;
  readonly required?: boolean;
  readonly start?: (context: RuntimeKernelModuleContext) => Promise<void> | void;
  readonly ready?: (context: RuntimeKernelModuleContext) => Promise<void> | void;
  readonly suspend?: (context: RuntimeKernelModuleContext) => Promise<void> | void;
  readonly resume?: (context: RuntimeKernelModuleContext) => Promise<void> | void;
  readonly stop?: (context: RuntimeKernelModuleContext) => Promise<void> | void;
  readonly dispose?: () => Promise<void> | void;
}

export interface RuntimeKernelOptions {
  readonly capabilityDependencies?: CapabilityDependencies;
  readonly budgetOverrides?: RuntimeBudgetOverrides;
  readonly telemetryCapacity?: number;
  readonly maxFailures?: number;
  readonly warmupTasks?: readonly RuntimeWarmupTask[];
  readonly onTransition?: (next: RuntimePhase, previous: RuntimePhase) => void;
}

export interface RuntimeWarmupTask {
  readonly id: string;
  readonly required?: boolean;
  readonly priority?: ScheduledTaskOptions['priority'];
  readonly kind?: ScheduledTaskOptions['kind'];
  readonly run: TaskExecutor<void>;
}

export interface RuntimeKernel {
  readonly start: (options?: RuntimeKernelStartOptions) => Promise<RuntimeKernelSnapshot>;
  readonly stop: (options?: RuntimeKernelStopOptions) => Promise<RuntimeKernelSnapshot>;
  readonly suspend: (signal?: AbortSignal) => Promise<RuntimeKernelSnapshot>;
  readonly resume: (signal?: AbortSignal) => Promise<RuntimeKernelSnapshot>;
  readonly registerModule: (module: RuntimeKernelModule) => () => void;
  readonly registerCircuit: (name: string, options?: CircuitBreakerOptions) => CircuitBreaker;
  readonly circuit: (name: string) => CircuitBreaker | null;
  readonly schedule: <TValue>(executor: TaskExecutor<TValue>, options?: ScheduledTaskOptions) => Promise<TValue>;
  readonly resilient: <TValue>(operation: () => Promise<TValue> | TValue, options?: RetryExecutionOptions & { circuit?: string }) => Promise<TValue>;
  readonly reserve: (request: ReservationRequest) => ResourceReservation | null;
  readonly snapshot: () => RuntimeKernelSnapshot;
  readonly telemetry: RuntimeTelemetry;
  readonly scheduler: RuntimeTaskScheduler;
  readonly budget: ResourceBudgetManager;
  readonly capabilities: CapabilityWatcher;
  readonly phase: () => RuntimePhase;
  readonly dispose: () => Promise<void>;
}

interface RegisteredModule {
  readonly id: string;
  readonly order: number;
  readonly required: boolean;
  readonly module: RuntimeKernelModule;
  started: boolean;
  ready: boolean;
}

const canTransition: Readonly<Record<RuntimePhase, readonly RuntimePhase[]>> = Object.freeze({
  idle: Object.freeze(['starting', 'stopped']),
  starting: Object.freeze(['ready', 'degraded', 'failed', 'stopping']),
  ready: Object.freeze(['degraded', 'suspending', 'stopping', 'failed']),
  degraded: Object.freeze(['ready', 'suspending', 'stopping', 'failed']),
  suspending: Object.freeze(['suspended', 'stopping', 'failed']),
  suspended: Object.freeze(['starting', 'stopping', 'failed']),
  stopping: Object.freeze(['stopped', 'failed']),
  stopped: Object.freeze(['starting']),
  failed: Object.freeze(['starting', 'stopping', 'stopped']),
} satisfies Record<RuntimePhase, readonly RuntimePhase[]>);

const normalizeModuleId = (value: unknown): string => {
  const normalized = asNonEmptyString(value, 100);
  if (!normalized) throw new Error('Runtime module id is required.');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) {
    throw new Error(`Runtime module id contains unsupported characters: ${normalized}`);
  }
  return normalized;
};

const normalizeCircuitName = (value: unknown): string => {
  const normalized = asNonEmptyString(value, 80);
  if (!normalized) throw new Error('Circuit name is required.');
  return normalized.toLowerCase();
};

const normalizeFailure = (domain: string, error: unknown, timestamp: number): RuntimeFailure => {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; retryable?: unknown }
    : null;
  return Object.freeze({
    timestamp,
    domain: domain.slice(0, 80),
    code: String(candidate?.code ?? 'RUNTIME_FAILURE').slice(0, 80),
    message: String(candidate?.message ?? 'Runtime operation failed.').slice(0, 240),
    retryable: candidate?.retryable === true,
  });
};

export const createRuntimeKernel = (options: RuntimeKernelOptions = {}): RuntimeKernel => {
  const capabilities = createCapabilityWatcher(options.capabilityDependencies);
  let budgetOverrides = options.budgetOverrides ?? {};
  let currentBudget = createRuntimeBudget(capabilities.snapshot(), budgetOverrides);
  const telemetry = createRuntimeTelemetry({
    capacity: options.telemetryCapacity ?? currentBudget.telemetryCapacity,
  });
  const budget = createResourceBudgetManager({
    budget: currentBudget,
    onRejected: (request) => telemetry.warn('budget', 'reservation-rejected', {
      kind: request.kind,
      count: request.units ?? 1,
      tier: currentBudget.tier,
    }),
    onExpired: (reservation) => telemetry.debug('budget', 'reservation-expired', {
      kind: reservation.kind,
      count: reservation.units,
    }),
  });
  const scheduler = createTaskScheduler({
    budget: currentBudget,
    onEvent: (name, attributes) => telemetry.record({
      level: name.includes('failed') || name.includes('timed-out') ? 'warn' : 'debug',
      domain: 'scheduler',
      name,
      attributes,
    }),
  });
  const modules = new Map<string, RegisteredModule>();
  const circuits = new Map<string, CircuitBreaker>();
  const failures: RuntimeFailure[] = [];
  const maxFailures = positiveInteger(options.maxFailures, 30, 200);
  let phase: RuntimePhase = 'idle';
  let startedAt: number | null = null;
  let lastTransitionAt = Date.now();
  let lifecycleController: AbortController | null = null;
  let disposed = false;
  let lifecyclePromise: Promise<RuntimeKernelSnapshot> | null = null;

  const rememberFailure = (domain: string, error: unknown): void => {
    failures.push(normalizeFailure(domain, error, Date.now()));
    while (failures.length > maxFailures) failures.shift();
  };

  const transition = (next: RuntimePhase): void => {
    if (next === phase) return;
    if (!canTransition[phase].includes(next)) {
      throw new Error(`Invalid runtime phase transition: ${phase} -> ${next}`);
    }
    const previous = phase;
    phase = next;
    lastTransitionAt = Date.now();
    telemetry.info('kernel', 'phase-transition', { phase: next, reason: previous });
    options.onTransition?.(next, previous);
  };

  const sortedModules = (): RegisteredModule[] => [...modules.values()]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));

  const snapshot = (): RuntimeKernelSnapshot => Object.freeze({
    phase,
    capabilities: capabilities.snapshot(),
    budget: currentBudget,
    scheduler: scheduler.snapshot(),
    telemetry: telemetry.summary(),
    startedAt,
    lastTransitionAt,
    failures: immutableArray(failures),
  });

  const contextFor = (signal: AbortSignal): RuntimeKernelModuleContext => Object.freeze({
    signal,
    telemetry,
    scheduler,
    budget,
    kernel,
  });

  const refreshBudget = (overrides: RuntimeBudgetOverrides = budgetOverrides): void => {
    budgetOverrides = overrides;
    currentBudget = createRuntimeBudget(capabilities.snapshot(), overrides);
    budget.updateBudget(currentBudget);
    scheduler.updateBudget(currentBudget);
    telemetry.debug('kernel', 'budget-refreshed', { tier: currentBudget.tier });
  };

  const capabilityUnsubscribe = capabilities.subscribe((next, previous) => {
    refreshBudget();
    telemetry.info('capability', 'profile-changed', {
      tier: next.tier,
      reason: `${previous.tier}->${next.tier}`,
      networktype: next.effectiveConnectionType,
    });
  });

  const runModuleHook = async (
    registered: RegisteredModule,
    hook: keyof Pick<RuntimeKernelModule, 'start' | 'ready' | 'suspend' | 'resume' | 'stop'>,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const fn = registered.module[hook];
    if (!fn) return true;
    throwIfAborted(signal);
    try {
      await telemetry.measure('module', `${registered.id}.${hook}`, () => fn(contextFor(signal)), {
        phase,
        result: 'pending',
      });
      return true;
    } catch (error) {
      if (isAbortLike(error) || signal.aborted) throw error;
      rememberFailure(`module:${registered.id}:${hook}`, error);
      telemetry.error('module', 'hook-failed', {
        operation: hook,
        result: registered.required ? 'required-failure' : 'optional-failure',
        code: error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? 'error')
          : 'error',
      });
      if (registered.required) throw error;
      return false;
    }
  };

  const runWarmup = async (signal: AbortSignal): Promise<boolean> => {
    const warmups = options.warmupTasks ?? [];
    if (warmups.length === 0) return true;
    let healthy = true;
    await Promise.all(warmups.map(async (warmup) => {
      try {
        await scheduler.schedule(warmup.run, {
          key: `warmup:${warmup.id}`,
          priority: warmup.priority ?? 'low',
          kind: warmup.kind ?? 'cpu',
          signal,
          timeoutMs: 15000,
          deduplicate: true,
          metadata: { operation: 'runtime-warmup' },
        });
      } catch (error) {
        if (isAbortLike(error) || signal.aborted) throw error;
        rememberFailure(`warmup:${warmup.id}`, error);
        telemetry.warn('kernel', 'warmup-failed', {
          operation: warmup.id,
          result: warmup.required ? 'required-failure' : 'optional-failure',
        });
        healthy = false;
        if (warmup.required) throw error;
      }
    }));
    return healthy;
  };

  const start = (startOptions: RuntimeKernelStartOptions = {}): Promise<RuntimeKernelSnapshot> => {
    if (disposed) return Promise.reject(new Error('Runtime kernel has been disposed.'));
    if (phase === 'ready' || phase === 'degraded') return Promise.resolve(snapshot());
    if (lifecyclePromise) return lifecyclePromise;

    lifecyclePromise = (async () => {
      if (phase === 'suspended') transition('starting');
      else if (phase === 'stopped' || phase === 'failed' || phase === 'idle') transition('starting');
      else throw new Error(`Runtime kernel cannot start from ${phase}.`);

      lifecycleController?.abort(abortError('Superseded runtime lifecycle.'));
      lifecycleController = new AbortController();
      const parentAbort = () => lifecycleController?.abort(startOptions.signal?.reason ?? abortError());
      startOptions.signal?.addEventListener('abort', parentAbort, { once: true });
      const signal = lifecycleController.signal;
      startedAt = Date.now();
      refreshBudget(startOptions.budgetOverrides ?? budgetOverrides);
      let healthy = true;

      try {
        telemetry.info('kernel', 'start', { tier: currentBudget.tier });
        for (const registered of sortedModules()) {
          const success = await runModuleHook(registered, registered.started ? 'resume' : 'start', signal);
          registered.started = success || registered.started;
          healthy = healthy && success;
        }

        if (startOptions.warmup !== false) healthy = (await runWarmup(signal)) && healthy;

        for (const registered of sortedModules()) {
          if (!registered.started) continue;
          const success = await runModuleHook(registered, 'ready', signal);
          registered.ready = success;
          healthy = healthy && success;
        }

        throwIfAborted(signal);
        transition(healthy ? 'ready' : 'degraded');
        telemetry.info('kernel', 'started', { tier: currentBudget.tier, result: healthy ? 'ready' : 'degraded' });
        return snapshot();
      } catch (error) {
        if (isAbortLike(error) || signal.aborted) {
          telemetry.warn('kernel', 'start-aborted', { phase });
          if ((phase as RuntimePhase) === 'starting') transition('stopping');
          scheduler.cancelAll(signal.reason ?? error);
          if ((phase as RuntimePhase) === 'stopping') transition('stopped');
          throw error;
        }
        rememberFailure('kernel:start', error);
        transition('failed');
        telemetry.error('kernel', 'start-failed', { result: 'failure' });
        throw error;
      } finally {
        startOptions.signal?.removeEventListener('abort', parentAbort);
        lifecyclePromise = null;
      }
    })();

    return lifecyclePromise;
  };

  const suspend = async (signal?: AbortSignal): Promise<RuntimeKernelSnapshot> => {
    if (phase === 'suspended') return snapshot();
    if (phase !== 'ready' && phase !== 'degraded') throw new Error(`Runtime kernel cannot suspend from ${phase}.`);
    transition('suspending');
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason ?? abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (const registered of sortedModules().reverse()) {
        if (registered.started) await runModuleHook(registered, 'suspend', controller.signal);
      }
      transition('suspended');
      return snapshot();
    } catch (error) {
      rememberFailure('kernel:suspend', error);
      transition('failed');
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };

  const resume = async (signal?: AbortSignal): Promise<RuntimeKernelSnapshot> => {
    return start({ ...(signal ? { signal } : {}), warmup: false });
  };

  const stop = (stopOptions: RuntimeKernelStopOptions = {}): Promise<RuntimeKernelSnapshot> => {
    if (phase === 'stopped' || phase === 'idle') {
      if (phase === 'idle') transition('stopped');
      return Promise.resolve(snapshot());
    }
    if (lifecyclePromise) lifecycleController?.abort(abortError('Runtime stop requested.'));

    const operation = (async () => {
      if (phase !== 'stopping') transition('stopping');
      const controller = new AbortController();
      const timeoutMs = positiveInteger(stopOptions.timeoutMs, 10000, 120000);
      const timer = setTimeout(() => controller.abort(new Error(`Runtime stop timed out after ${timeoutMs}ms.`)), timeoutMs);
      const onAbort = () => controller.abort(stopOptions.signal?.reason ?? abortError());
      stopOptions.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        if (stopOptions.drain !== false) {
          try {
            await scheduler.drain(controller.signal);
          } catch (error) {
            if (!controller.signal.aborted) throw error;
          }
        }
        scheduler.cancelAll(abortError('Runtime stopping.'));
        for (const registered of sortedModules().reverse()) {
          if (!registered.started) continue;
          try {
            await runModuleHook(registered, 'stop', controller.signal);
          } catch (error) {
            if (!controller.signal.aborted) rememberFailure(`module:${registered.id}:stop`, error);
          }
          registered.started = false;
          registered.ready = false;
        }
        transition('stopped');
        telemetry.info('kernel', 'stopped', { result: 'success' });
        return snapshot();
      } catch (error) {
        rememberFailure('kernel:stop', error);
        transition('failed');
        throw error;
      } finally {
        clearTimeout(timer);
        stopOptions.signal?.removeEventListener('abort', onAbort);
      }
    })();
    return operation;
  };

  const registerModule = (module: RuntimeKernelModule): (() => void) => {
    if (disposed) throw new Error('Runtime kernel has been disposed.');
    const id = normalizeModuleId(module.id);
    if (modules.has(id)) throw new Error(`Runtime module already registered: ${id}`);
    const registered: RegisteredModule = {
      id,
      order: Number.isFinite(module.order) ? Number(module.order) : 100,
      required: module.required === true,
      module,
      started: false,
      ready: false,
    };
    modules.set(id, registered);
    telemetry.debug('kernel', 'module-registered', { operation: id });
    return () => {
      const current = modules.get(id);
      if (!current) return;
      modules.delete(id);
      void current.module.dispose?.();
      telemetry.debug('kernel', 'module-unregistered', { operation: id });
    };
  };

  const registerCircuit = (name: string, circuitOptions: CircuitBreakerOptions = {}): CircuitBreaker => {
    const normalized = normalizeCircuitName(name);
    const existing = circuits.get(normalized);
    if (existing) return existing;
    const breaker = createCircuitBreaker({
      ...circuitOptions,
      onTransition: (next, previous, circuitSnapshot) => {
        telemetry.warn('resilience', 'circuit-transition', {
          operation: normalized,
          status: next,
          reason: previous,
          count: circuitSnapshot.failures,
        });
        circuitOptions.onTransition?.(next, previous, circuitSnapshot);
      },
    });
    circuits.set(normalized, breaker);
    return breaker;
  };

  const circuit = (name: string): CircuitBreaker | null => circuits.get(normalizeCircuitName(name)) ?? null;

  const schedule = <TValue>(executor: TaskExecutor<TValue>, scheduleOptions?: ScheduledTaskOptions): Promise<TValue> =>
    scheduler.schedule(executor, scheduleOptions);

  const resilient = async <TValue>(
    operation: () => Promise<TValue> | TValue,
    resilienceOptions: RetryExecutionOptions & { circuit?: string } = {},
  ): Promise<TValue> => {
    const breaker = resilienceOptions.circuit ? registerCircuit(resilienceOptions.circuit) : null;
    return executeWithRetry(
      () => breaker ? breaker.execute(operation) : operation(),
      resilienceOptions,
    );
  };

  const reserve = (request: ReservationRequest): ResourceReservation | null => budget.reserve(request);

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    if (phase !== 'stopped' && phase !== 'idle') {
      try { await stop({ drain: false, timeoutMs: 5000 }); } catch { /* dispose continues */ }
    }
    disposed = true;
    capabilityUnsubscribe();
    capabilities.dispose();
    scheduler.dispose();
    budget.dispose();
    for (const registered of sortedModules().reverse()) {
      try { await registered.module.dispose?.(); } catch { /* disposal is best effort */ }
    }
    modules.clear();
    circuits.clear();
  };

  const kernel: RuntimeKernel = Object.freeze({
    start,
    stop,
    suspend,
    resume,
    registerModule,
    registerCircuit,
    circuit,
    schedule,
    resilient,
    reserve,
    snapshot,
    telemetry,
    scheduler,
    budget,
    capabilities,
    phase: () => phase,
    dispose,
  });

  return kernel;
};

export const runtimeKernel = createRuntimeKernel();
