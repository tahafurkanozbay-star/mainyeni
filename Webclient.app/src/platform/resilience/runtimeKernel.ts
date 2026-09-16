import { createRequestCache } from '../cache/requestCache';
import type { RequestCache, RequestCacheSnapshot } from '../cache/requestCache';
import { runtimeConfig } from '../config/runtimeConfig';
import type { RuntimeConfig } from '../config/runtimeConfig';
import { AppError, isAbortError } from '../errors/appError';
import { createRuntimeSupervisor } from '../lifecycle/runtimeSupervisor';
import type { RuntimeLease, RuntimeSupervisor, RuntimeSupervisorSnapshot } from '../lifecycle/runtimeSupervisor';
import { createRuntimeHealthMonitor } from '../observability/runtimeHealth';
import type {
  RuntimeHealthMonitor,
  RuntimeHealthSnapshot,
  RuntimeHealthSeverity
} from '../observability/runtimeHealth';
import { createOfflineMemoryStore, decideOfflineStrategy } from '../offline/offlinePolicy';
import type { OfflineDecision, OfflinePolicyInput, OfflineMemoryStore } from '../offline/offlinePolicy';
import { createPerformanceMonitor } from '../performance/performanceMonitor';
import type { PerformanceSnapshot } from '../performance/performanceMonitor';
import { deriveRuntimeBudget } from '../performance/runtimeBudget';
import type { RuntimeBudget, RuntimeCapabilitySample } from '../performance/runtimeBudget';
import { createCircuitBreakerRegistry } from './circuitBreaker';
import type { CircuitBreakerRegistry, CircuitBreakerSnapshot } from './circuitBreaker';

export type RuntimeKernelState = 'idle' | 'running' | 'stopping' | 'stopped';

export interface RuntimeKernelOptions {
  config?: RuntimeConfig;
  cache?: RequestCache<unknown>;
  supervisor?: RuntimeSupervisor;
  health?: RuntimeHealthMonitor;
  performanceMonitor?: ReturnType<typeof createPerformanceMonitor>;
  breakers?: CircuitBreakerRegistry;
  offlineStore?: OfflineMemoryStore<unknown>;
  clock?: () => number;
}

export interface RuntimeSession {
  readonly id: number;
  readonly label: string;
  readonly signal: AbortSignal;
  readonly supervisor: RuntimeSupervisor;
  readonly startedAt: number;
  readonly disposed: boolean;
  register(dispose: () => void | Promise<void>, label?: string): RuntimeLease;
  dispose(): Promise<boolean>;
}

export interface RuntimeKernelSnapshot {
  readonly state: RuntimeKernelState;
  readonly startedAt: number | null;
  readonly uptimeMs: number;
  readonly sessions: number;
  readonly config: Readonly<{
    environment: string;
    release: string;
    apiBaseUrl: string;
    diagnosticsEnabled: boolean;
    offlineEnabled: boolean;
    performanceBudgetProfile: string;
  }>;
  readonly budget: RuntimeBudget;
  readonly performance: PerformanceSnapshot;
  readonly health: RuntimeHealthSnapshot;
  readonly resources: RuntimeSupervisorSnapshot;
  readonly cache: RequestCacheSnapshot;
  readonly breakers: Readonly<Record<string, CircuitBreakerSnapshot>>;
  readonly offlineEntries: number;
}

export interface ResilientExecutionOptions {
  signal?: AbortSignal;
  domain?: string;
  operation?: string;
  timeoutMs?: number;
  countAbortAsWarning?: boolean;
}

interface SessionRecord {
  id: number;
  label: string;
  startedAt: number;
  controller: AbortController;
  supervisor: RuntimeSupervisor;
  parentLease: RuntimeLease;
  disposed: boolean;
}

const safeLabel = (value: unknown, fallback = 'runtime'): string => {
  const normalized = String(value || fallback)
    .replace(/[?#].*$/, '')
    .replace(/[^a-zA-Z0-9._:/-]+/g, '-')
    .slice(0, 120);
  return normalized || fallback;
};

const boundedTimeout = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(100, Math.min(120000, Math.round(numeric)));
};

const capabilitySample = (
  snapshot: PerformanceSnapshot,
  navigatorRef: Navigator | null = typeof navigator !== 'undefined' ? navigator : null
): RuntimeCapabilitySample => {
  const extendedNavigator = navigatorRef as Navigator & { deviceMemory?: number };
  const network = snapshot.network;
  const memory = snapshot.memory;
  return Object.freeze({
    hardwareConcurrency: Number.isFinite(Number(extendedNavigator?.hardwareConcurrency))
      ? Number(extendedNavigator.hardwareConcurrency)
      : null,
    deviceMemoryGb: Number.isFinite(Number(extendedNavigator?.deviceMemory))
      ? Number(extendedNavigator.deviceMemory)
      : null,
    effectiveType: typeof network?.effectiveType === 'string' ? network.effectiveType : null,
    saveData: network?.saveData === true,
    downlinkMbps: Number.isFinite(Number(network?.downlinkMbps)) ? Number(network?.downlinkMbps) : null,
    rttMs: Number.isFinite(Number(network?.rttMs)) ? Number(network?.rttMs) : null,
    heapUtilization: Number.isFinite(Number(memory?.utilization)) ? Number(memory?.utilization) : null,
    longTaskCount: snapshot.longTasks.count,
    longTaskMaxMs: Number.isFinite(Number(snapshot.longTasks.maxDurationMs))
      ? Number(snapshot.longTasks.maxDurationMs)
      : null
  });
};

const timeoutError = (): AppError => new AppError('İşlem zaman aşımına uğradı.', {
  code: 'TIMEOUT',
  status: 408,
  retryable: true
});

const abortError = (): AppError => new AppError('İşlem iptal edildi.', {
  code: 'ABORTED',
  retryable: false
});

interface ComposedSignal {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
}

const composeAbortSignals = (
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): ComposedSignal => {
  const controller = new AbortController();

  const onCallerAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(callerSignal?.reason || abortError());
  };

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason || abortError());
  } else if (callerSignal && typeof callerSignal.addEventListener === 'function') {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(timeoutError());
  }, timeoutMs);

  return Object.freeze({
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      if (callerSignal && typeof callerSignal.removeEventListener === 'function') {
        callerSignal.removeEventListener('abort', onCallerAbort);
      }
    }
  });
};

const abortPromiseFor = (signal: AbortSignal): Readonly<{
  promise: Promise<never>;
  cleanup: () => void;
}> => {
  let listener: (() => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    const rejectFromSignal = (): void => {
      const reason = signal.reason;
      if (reason instanceof Error) reject(reason);
      else reject(isAbortError(reason) ? reason : abortError());
    };

    if (signal.aborted) {
      rejectFromSignal();
      return;
    }

    listener = rejectFromSignal;
    signal.addEventListener('abort', rejectFromSignal, { once: true });
  });

  return Object.freeze({
    promise,
    cleanup: () => {
      if (listener) signal.removeEventListener('abort', listener);
      listener = null;
    }
  });
};

export class RuntimeKernel {
  readonly config: RuntimeConfig;
  readonly cache: RequestCache<unknown>;
  readonly supervisor: RuntimeSupervisor;
  readonly health: RuntimeHealthMonitor;
  readonly performanceMonitor: ReturnType<typeof createPerformanceMonitor>;
  readonly breakers: CircuitBreakerRegistry;
  readonly offlineStore: OfflineMemoryStore<unknown>;
  private readonly clock: () => number;
  private readonly sessions = new Map<number, SessionRecord>();
  private sessionSequence = 0;
  private state: RuntimeKernelState = 'idle';
  private startedAt: number | null = null;
  private latestBudget: RuntimeBudget;

  constructor(options: RuntimeKernelOptions = {}) {
    this.config = options.config || runtimeConfig;
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.health = options.health || createRuntimeHealthMonitor();
    this.supervisor = options.supervisor || createRuntimeSupervisor({
      onError: (error, context) => this.safeHealth('warning', 'lifecycle', 'dispose-failed', {
        error,
        ...context
      })
    });
    this.cache = options.cache || createRequestCache({
      ttlMs: this.config.cacheTtlMs,
      maxEntries: 120
    });
    this.performanceMonitor = options.performanceMonitor || createPerformanceMonitor({ clock: this.clock });
    this.offlineStore = options.offlineStore || createOfflineMemoryStore({ maxEntries: 80 });
    this.breakers = options.breakers || createCircuitBreakerRegistry({
      onTransition: (transition) => this.safeHealth('info', 'resilience', 'circuit-transition', transition)
    });
    this.latestBudget = deriveRuntimeBudget({}, this.config.performanceBudgetProfile);
  }

  private safeHealth(
    severity: RuntimeHealthSeverity,
    domain: string,
    code: string,
    metadata: unknown = {}
  ): void {
    try {
      this.health.record(domain, code, severity, metadata);
    } catch (_error) {
      // Local observability must never alter application control flow.
    }
  }

  start(): boolean {
    if (this.state === 'running') return false;
    if (this.state === 'stopping' || this.state === 'stopped') {
      throw new AppError('Runtime kernel yeniden başlatılamaz.', {
        code: 'RUNTIME_KERNEL_CLOSED',
        retryable: false
      });
    }
    this.state = 'running';
    this.startedAt = this.clock();
    this.performanceMonitor.start();
    this.refreshBudget();
    this.safeHealth('info', 'runtime', 'kernel-started', {
      environment: this.config.environment,
      release: this.config.release,
      budgetProfile: this.config.performanceBudgetProfile
    });
    return true;
  }

  refreshBudget(sample?: RuntimeCapabilitySample): RuntimeBudget {
    const currentPerformance = this.performanceMonitor.snapshot();
    const derivedSample = sample || capabilitySample(currentPerformance);
    this.latestBudget = deriveRuntimeBudget(derivedSample, this.config.performanceBudgetProfile);
    if (this.latestBudget.pressure === 'high' || this.latestBudget.pressure === 'critical') {
      this.safeHealth('warning', 'performance', 'runtime-pressure', {
        pressure: this.latestBudget.pressure,
        reasons: this.latestBudget.reasons,
        requestConcurrency: this.latestBudget.maxConcurrentRequests,
        visibleFeatures: this.latestBudget.maxVisibleFeatures
      });
    }
    return this.latestBudget;
  }

  createSession(label = 'runtime-session'): RuntimeSession {
    if (this.state !== 'running') {
      throw new AppError('Runtime session yalnız çalışan kernel üzerinde oluşturulabilir.', {
        code: 'RUNTIME_KERNEL_NOT_RUNNING',
        retryable: false
      });
    }
    const id = ++this.sessionSequence;
    const normalizedLabel = safeLabel(label, `session-${id}`);
    const controller = new AbortController();
    const child = createRuntimeSupervisor({
      onError: (error, context) => this.safeHealth('warning', 'lifecycle', 'session-dispose-failed', {
        error,
        session: normalizedLabel,
        ...context
      })
    });
    const parentLease = this.supervisor.register(() => {
      if (!controller.signal.aborted) controller.abort();
      return child.close();
    }, { label: `session-owner:${normalizedLabel}`, kind: 'disposable' });
    const record: SessionRecord = {
      id,
      label: normalizedLabel,
      startedAt: this.clock(),
      controller,
      supervisor: child,
      parentLease,
      disposed: false
    };
    this.sessions.set(id, record);
    const kernel = this;

    const dispose = async (): Promise<boolean> => {
      if (record.disposed) return false;
      record.disposed = true;
      kernel.sessions.delete(id);
      if (!controller.signal.aborted) controller.abort();
      await child.close();
      await parentLease.dispose();
      kernel.safeHealth('info', 'runtime', 'session-disposed', {
        label: normalizedLabel,
        ageMs: Math.max(0, kernel.clock() - record.startedAt)
      });
      return true;
    };

    return {
      get id() { return record.id; },
      get label() { return record.label; },
      get signal() { return record.controller.signal; },
      get supervisor() { return record.supervisor; },
      get startedAt() { return record.startedAt; },
      get disposed() { return record.disposed; },
      register(disposer, resourceLabel = 'session-resource') {
        return child.register(disposer, {
          label: `${normalizedLabel}:${safeLabel(resourceLabel)}`,
          kind: 'disposable'
        });
      },
      dispose
    };
  }

  async executeResilient<T>(
    key: string,
    operation: (signal: AbortSignal) => Promise<T> | T,
    options: ResilientExecutionOptions = {}
  ): Promise<T> {
    if (this.state !== 'running') {
      throw new AppError('Runtime kernel çalışmıyor.', {
        code: 'RUNTIME_KERNEL_NOT_RUNNING',
        retryable: false
      });
    }
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const domain = safeLabel(options.domain, 'runtime');
    const operationName = safeLabel(options.operation, 'operation');
    const timeoutMs = boundedTimeout(options.timeoutMs, this.config.requestTimeoutMs);
    const composed = composeAbortSignals(options.signal, timeoutMs);
    const abortRace = abortPromiseFor(composed.signal);
    const started = this.clock();

    try {
      if (composed.signal.aborted) {
        throw options.signal?.aborted ? abortError() : timeoutError();
      }
      const result = await this.breakers.execute(key, () => Promise.race([
        Promise.resolve().then(() => operation(composed.signal)),
        abortRace.promise
      ]));
      this.safeHealth('info', domain, 'operation-success', {
        operation: operationName,
        durationMs: Math.max(0, this.clock() - started)
      });
      return result;
    } catch (error) {
      const callerAborted = options.signal?.aborted === true;
      const timedOrAborted = isAbortError(error) || composed.signal.aborted;
      if (timedOrAborted && callerAborted) {
        if (options.countAbortAsWarning) {
          this.safeHealth('warning', domain, 'operation-aborted', { operation: operationName });
        }
        throw abortError();
      }
      if (timedOrAborted) {
        this.safeHealth('warning', domain, 'operation-timeout', {
          operation: operationName,
          timeoutMs
        });
        throw timeoutError();
      }
      this.safeHealth('warning', domain, 'operation-failed', {
        operation: operationName,
        durationMs: Math.max(0, this.clock() - started),
        error
      });
      throw error;
    } finally {
      abortRace.cleanup();
      composed.cleanup();
    }
  }

  offlineDecision(input: OfflinePolicyInput): OfflineDecision {
    const online = input.online ?? (typeof navigator !== 'undefined' ? navigator.onLine !== false : true);
    return decideOfflineStrategy({ ...input, online });
  }

  snapshot(): RuntimeKernelSnapshot {
    const performance = this.performanceMonitor.snapshot();
    const startedAt = this.startedAt;
    return Object.freeze({
      state: this.state,
      startedAt,
      uptimeMs: startedAt === null ? 0 : Math.max(0, this.clock() - startedAt),
      sessions: this.sessions.size,
      config: Object.freeze({
        environment: this.config.environment,
        release: this.config.release,
        apiBaseUrl: this.config.apiBaseUrl,
        diagnosticsEnabled: this.config.diagnosticsEnabled,
        offlineEnabled: this.config.offlineEnabled,
        performanceBudgetProfile: this.config.performanceBudgetProfile
      }),
      budget: this.latestBudget,
      performance,
      health: this.health.snapshot(),
      resources: this.supervisor.snapshot(),
      cache: this.cache.snapshot(),
      breakers: this.breakers.snapshot(),
      offlineEntries: this.offlineStore.size()
    });
  }

  async stop(): Promise<boolean> {
    if (this.state === 'stopped' || this.state === 'stopping') return false;
    this.state = 'stopping';
    const activeSessions = Array.from(this.sessions.values());
    this.sessions.clear();
    for (const session of activeSessions.reverse()) {
      session.disposed = true;
      if (!session.controller.signal.aborted) session.controller.abort();
      await session.supervisor.close();
      await session.parentLease.dispose();
    }
    this.performanceMonitor.stop();
    await this.supervisor.close();
    this.cache.clear();
    this.offlineStore.clear();
    this.breakers.clear();
    this.safeHealth('info', 'runtime', 'kernel-stopped', {
      uptimeMs: this.startedAt === null ? 0 : Math.max(0, this.clock() - this.startedAt)
    });
    this.state = 'stopped';
    return true;
  }
}

export const createRuntimeKernel = (options: RuntimeKernelOptions = {}): RuntimeKernel =>
  new RuntimeKernel(options);
