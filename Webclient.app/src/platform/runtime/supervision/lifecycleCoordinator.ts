import {
  LifecycleDeadlineError,
  LifecycleTransitionError,
  errorMessage,
  normalizeIdentifier,
  safeObserver,
  throwIfAbortedSignal,
  boundedInteger,
  type ComponentLifecycleSnapshot,
  type ComponentRuntimeState,
  type LifecycleComponent,
  type LifecycleEvent,
  type RuntimeClock,
  DEFAULT_RUNTIME_CLOCK,
} from './contracts';
import {
  DependencyGraphRegistry,
  type DependencyGraphSnapshot,
} from './dependencyGraph';
import { HealthRegistry } from './healthRegistry';

export interface LifecycleCoordinatorOptions {
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly concurrency?: number;
  readonly rollbackOnFailure?: boolean;
  readonly continueOnOptionalFailure?: boolean;
  readonly continueOnImportantFailure?: boolean;
  readonly clock?: Partial<RuntimeClock>;
  readonly health?: HealthRegistry;
  readonly onEvent?: (event: LifecycleEvent) => void;
}

export interface LifecycleRunResult {
  readonly success: boolean;
  readonly started: readonly string[];
  readonly stopped: readonly string[];
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
  readonly rolledBack: readonly string[];
  readonly durationMs: number;
  readonly graphRevision: number;
}

interface MutableLifecycleRecord {
  state: ComponentRuntimeState;
  starts: number;
  stops: number;
  failures: number;
  lastStartedAt: number | null;
  lastStoppedAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}

interface DeadlineResult<TValue> {
  readonly value: TValue;
  readonly signal: AbortSignal;
}

const createRecord = (): MutableLifecycleRecord => ({
  state: 'registered',
  starts: 0,
  stops: 0,
  failures: 0,
  lastStartedAt: null,
  lastStoppedAt: null,
  lastFailureAt: null,
  lastError: null,
});

const snapshotRecord = (id: string, record: MutableLifecycleRecord): ComponentLifecycleSnapshot => Object.freeze({
  id,
  state: record.state,
  starts: record.starts,
  stops: record.stops,
  failures: record.failures,
  lastStartedAt: record.lastStartedAt,
  lastStoppedAt: record.lastStoppedAt,
  lastFailureAt: record.lastFailureAt,
  lastError: record.lastError,
});

const composeSignals = (
  signals: readonly (AbortSignal | undefined)[],
): { readonly signal: AbortSignal; readonly dispose: () => void } => {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const handler = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    signal.addEventListener('abort', handler, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', handler));
  }
  return Object.freeze({
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  });
};

const runWithDeadline = async <TValue>(
  operation: (signal: AbortSignal) => Promise<TValue> | TValue,
  options: {
    readonly componentId: string;
    readonly operationName: 'start' | 'stop';
    readonly timeoutMs: number;
    readonly parentSignal?: AbortSignal;
    readonly clock: RuntimeClock;
  },
): Promise<DeadlineResult<TValue>> => {
  throwIfAbortedSignal(options.parentSignal);
  const deadlineController = new AbortController();
  const combined = composeSignals([options.parentSignal, deadlineController.signal]);
  let rejectDeadline: (reason: unknown) => void = () => undefined;
  let settled = false;
  const deadlineError = new LifecycleDeadlineError(
    options.componentId,
    options.operationName,
    options.timeoutMs,
  );
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = options.clock.setTimeout(() => {
    if (settled) return;
    deadlineController.abort(deadlineError);
    rejectDeadline(deadlineError);
  }, options.timeoutMs);

  try {
    const operationPromise = Promise.resolve().then(() => operation(combined.signal));
    const value = await Promise.race([operationPromise, deadline]);
    return Object.freeze({ value, signal: combined.signal });
  } finally {
    settled = true;
    options.clock.clearTimeout(timer);
    combined.dispose();
  }
};

const mapConcurrent = async <TValue, TResult>(
  values: readonly TValue[],
  concurrency: number,
  worker: (value: TValue, index: number) => Promise<TResult>,
): Promise<readonly TResult[]> => {
  if (values.length === 0) return Object.freeze([]);
  const output: TResult[] = new Array<TResult>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value === undefined) return;
      output[index] = await worker(value, index);
    }
  });
  await Promise.all(workers);
  return Object.freeze(output);
};

export class LifecycleCoordinator {
  readonly #components = new Map<string, LifecycleComponent>();
  readonly #records = new Map<string, MutableLifecycleRecord>();
  readonly #graph = new DependencyGraphRegistry();
  readonly #health: HealthRegistry;
  readonly #clock: RuntimeClock;
  readonly #startTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  readonly #concurrency: number;
  readonly #rollbackOnFailure: boolean;
  readonly #continueOnOptionalFailure: boolean;
  readonly #continueOnImportantFailure: boolean;
  readonly #onEvent: ((event: LifecycleEvent) => void) | undefined;
  #run: 'idle' | 'starting' | 'running' | 'stopping' = 'idle';

  constructor(options: LifecycleCoordinatorOptions = {}) {
    this.#health = options.health ?? new HealthRegistry();
    this.#clock = Object.freeze({
      now: options.clock?.now ?? DEFAULT_RUNTIME_CLOCK.now,
      setTimeout: options.clock?.setTimeout ?? DEFAULT_RUNTIME_CLOCK.setTimeout,
      clearTimeout: options.clock?.clearTimeout ?? DEFAULT_RUNTIME_CLOCK.clearTimeout,
    });
    this.#startTimeoutMs = boundedInteger(options.startTimeoutMs, 15_000, 1, 10 * 60 * 1000);
    this.#stopTimeoutMs = boundedInteger(options.stopTimeoutMs, 10_000, 1, 10 * 60 * 1000);
    this.#concurrency = boundedInteger(options.concurrency, 4, 1, 64);
    this.#rollbackOnFailure = options.rollbackOnFailure !== false;
    this.#continueOnOptionalFailure = options.continueOnOptionalFailure !== false;
    this.#continueOnImportantFailure = options.continueOnImportantFailure === true;
    this.#onEvent = options.onEvent;
  }

  get health(): HealthRegistry {
    return this.#health;
  }

  get size(): number {
    return this.#components.size;
  }

  get running(): boolean {
    return this.#run === 'running';
  }

  register(component: LifecycleComponent): void {
    if (this.#run !== 'idle') {
      throw new LifecycleTransitionError(component.id, 'registered', 'components can only be registered while idle');
    }
    const normalized = this.#graph.register(component);
    this.#components.set(normalized.id, component);
    this.#records.set(normalized.id, createRecord());
    if (normalized.criticality === 'critical') {
      this.#health.setReadinessRequired(
        Object.freeze([
          ...this.#graph.list().filter((entry) => entry.criticality === 'critical').map((entry) => entry.id),
        ]),
      );
    }
  }

  unregister(componentId: string): boolean {
    if (this.#run !== 'idle') {
      const id = normalizeIdentifier(componentId, 'component id');
      const state = this.#records.get(id)?.state ?? 'registered';
      throw new LifecycleTransitionError(id, state, 'components can only be removed while idle');
    }
    const id = normalizeIdentifier(componentId, 'component id');
    const removed = this.#components.delete(id);
    this.#records.delete(id);
    this.#graph.remove(id);
    this.#health.remove(id);
    this.#health.setReadinessRequired(
      Object.freeze(
        this.#graph.list().filter((entry) => entry.criticality === 'critical').map((entry) => entry.id),
      ),
    );
    return removed;
  }

  graph(): DependencyGraphSnapshot {
    return this.#graph.compile();
  }

  state(componentId: string): ComponentLifecycleSnapshot | null {
    let id: string;
    try {
      id = normalizeIdentifier(componentId, 'component id');
    } catch {
      return null;
    }
    const record = this.#records.get(id);
    return record ? snapshotRecord(id, record) : null;
  }

  states(): readonly ComponentLifecycleSnapshot[] {
    return Object.freeze(
      [...this.#records.entries()]
        .map(([id, record]) => snapshotRecord(id, record))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  async startAll(signal?: AbortSignal): Promise<LifecycleRunResult> {
    if (this.#run === 'running') {
      const graph = this.#graph.compile();
      return Object.freeze({
        success: true,
        started: Object.freeze([]),
        stopped: Object.freeze([]),
        failed: Object.freeze([]),
        skipped: Object.freeze([]),
        rolledBack: Object.freeze([]),
        durationMs: 0,
        graphRevision: graph.revision,
      });
    }
    if (this.#run !== 'idle') {
      throw new LifecycleTransitionError('platform', 'starting', `cannot start while coordinator is ${this.#run}`);
    }

    const startedAt = this.#clock.now();
    const graph = this.#graph.compile();
    const started: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    const rolledBack: string[] = [];
    this.#run = 'starting';

    try {
      for (const level of graph.levels) {
        throwIfAbortedSignal(signal);
        const outcomes = await mapConcurrent(level, this.#concurrency, async (id) => {
          const dependencies = graph.requiredDependencies[id] ?? [];
          const unavailable = dependencies.filter((dependencyId) => {
            const record = this.#records.get(dependencyId);
            return record?.state !== 'running';
          });
          if (unavailable.length > 0) {
            const record = this.#requireRecord(id);
            record.state = 'failed';
            record.failures += 1;
            record.lastFailureAt = this.#clock.now();
            record.lastError = `Required dependencies not running: ${unavailable.join(', ')}`;
            this.#health.unhealthy(id, record.lastError);
            this.#event('component-start-failed', id, record.lastError);
            return Object.freeze({ id, status: 'skipped' as const, error: new Error(record.lastError) });
          }

          try {
            await this.#startOne(id, signal);
            return Object.freeze({ id, status: 'started' as const, error: null });
          } catch (error) {
            return Object.freeze({ id, status: 'failed' as const, error });
          }
        });

        let fatalError: unknown = null;
        for (const outcome of outcomes) {
          if (outcome.status === 'started') {
            started.push(outcome.id);
            continue;
          }
          if (outcome.status === 'skipped') skipped.push(outcome.id);
          else failed.push(outcome.id);
          const descriptor = this.#graph.get(outcome.id);
          if (!descriptor) continue;
          const canContinue = descriptor.criticality === 'optional'
            ? this.#continueOnOptionalFailure
            : descriptor.criticality === 'important'
              ? this.#continueOnImportantFailure
              : false;
          if (!canContinue && fatalError === null) fatalError = outcome.error;
        }

        if (fatalError !== null) throw fatalError;
      }

      this.#run = 'running';
      this.#event('startup-complete', null, null);
      return Object.freeze({
        success: failed.length === 0 && skipped.length === 0,
        started: Object.freeze(started),
        stopped: Object.freeze([]),
        failed: Object.freeze(failed),
        skipped: Object.freeze(skipped),
        rolledBack: Object.freeze([]),
        durationMs: Math.max(0, this.#clock.now() - startedAt),
        graphRevision: graph.revision,
      });
    } catch (error) {
      this.#event('startup-failed', null, errorMessage(error));
      if (this.#rollbackOnFailure && started.length > 0) {
        const rollbackOrder = graph.shutdownOrder.filter((id) => started.includes(id));
        for (const id of rollbackOrder) {
          try {
            await this.#stopOne(id, 'rollback');
            rolledBack.push(id);
          } catch {
            // The stop failure is already recorded by #stopOne; rollback proceeds best-effort.
          }
        }
      }
      this.#run = 'idle';
      return Object.freeze({
        success: false,
        started: Object.freeze(started),
        stopped: Object.freeze([]),
        failed: Object.freeze(failed.length ? failed : ['platform-startup']),
        skipped: Object.freeze(skipped),
        rolledBack: Object.freeze(rolledBack),
        durationMs: Math.max(0, this.#clock.now() - startedAt),
        graphRevision: graph.revision,
      });
    }
  }

  async stopAll(signal?: AbortSignal): Promise<LifecycleRunResult> {
    if (this.#run === 'idle') {
      const graph = this.#graph.compile();
      return Object.freeze({
        success: true,
        started: Object.freeze([]),
        stopped: Object.freeze([]),
        failed: Object.freeze([]),
        skipped: Object.freeze([]),
        rolledBack: Object.freeze([]),
        durationMs: 0,
        graphRevision: graph.revision,
      });
    }
    if (this.#run !== 'running') {
      throw new LifecycleTransitionError('platform', 'stopping', `cannot stop while coordinator is ${this.#run}`);
    }

    const startedAt = this.#clock.now();
    const graph = this.#graph.compile();
    const stopped: string[] = [];
    const failed: string[] = [];
    this.#run = 'stopping';
    try {
      for (const id of graph.shutdownOrder) {
        throwIfAbortedSignal(signal);
        const record = this.#records.get(id);
        if (!record || (record.state !== 'running' && record.state !== 'failed')) continue;
        try {
          await this.#stopOne(id, 'shutdown', signal);
          stopped.push(id);
        } catch {
          failed.push(id);
        }
      }
      this.#run = 'idle';
      this.#event('shutdown-complete', null, failed.length ? `${failed.length} stop failures` : null);
      return Object.freeze({
        success: failed.length === 0,
        started: Object.freeze([]),
        stopped: Object.freeze(stopped),
        failed: Object.freeze(failed),
        skipped: Object.freeze([]),
        rolledBack: Object.freeze([]),
        durationMs: Math.max(0, this.#clock.now() - startedAt),
        graphRevision: graph.revision,
      });
    } finally {
      if (this.#run === 'stopping') this.#run = 'idle';
    }
  }

  async restart(componentId: string, signal?: AbortSignal): Promise<void> {
    if (this.#run !== 'running') {
      const id = normalizeIdentifier(componentId, 'component id');
      const state = this.#records.get(id)?.state ?? 'registered';
      throw new LifecycleTransitionError(id, state, 'restart requires a running coordinator');
    }
    const id = normalizeIdentifier(componentId, 'component id');
    const dependents = this.#graph.dependentsOf(id, true);
    const affected = new Set<string>([id, ...dependents]);
    const graph = this.#graph.compile();

    for (const candidate of graph.shutdownOrder) {
      if (!affected.has(candidate)) continue;
      const record = this.#records.get(candidate);
      if (record?.state === 'running' || record?.state === 'failed') {
        await this.#stopOne(candidate, 'replace', signal);
      }
    }
    for (const candidate of graph.startupOrder) {
      if (!affected.has(candidate)) continue;
      await this.#startOne(candidate, signal);
    }
  }

  async #startOne(id: string, signal?: AbortSignal): Promise<void> {
    const component = this.#requireComponent(id);
    const record = this.#requireRecord(id);
    if (record.state === 'running') return;
    if (record.state === 'starting' || record.state === 'stopping') {
      throw new LifecycleTransitionError(id, record.state, 'component is already transitioning');
    }
    record.state = 'starting';
    record.starts += 1;
    const attempt = record.starts;
    const startedAt = this.#clock.now();
    this.#event('component-starting', id, null);
    this.#health.unknown(id, 'Component is starting');

    try {
      await runWithDeadline(
        (childSignal) => component.start(Object.freeze({ id, signal: childSignal, attempt, startedAt })),
        {
          componentId: id,
          operationName: 'start',
          timeoutMs: this.#startTimeoutMs,
          ...(signal === undefined ? {} : { parentSignal: signal }),
          clock: this.#clock,
        },
      );
      record.state = 'running';
      record.lastStartedAt = this.#clock.now();
      record.lastError = null;
      this.#health.healthy(id, 'Component running');
      this.#event('component-started', id, null);
    } catch (error) {
      record.state = 'failed';
      record.failures += 1;
      record.lastFailureAt = this.#clock.now();
      record.lastError = errorMessage(error);
      this.#health.unhealthy(id, record.lastError);
      this.#event('component-start-failed', id, record.lastError);
      throw error;
    }
  }

  async #stopOne(
    id: string,
    reason: 'shutdown' | 'rollback' | 'replace' | 'failure',
    signal?: AbortSignal,
  ): Promise<void> {
    const component = this.#requireComponent(id);
    const record = this.#requireRecord(id);
    if (record.state === 'stopped' || record.state === 'registered') return;
    if (record.state === 'starting' || record.state === 'stopping') {
      throw new LifecycleTransitionError(id, record.state, 'component is already transitioning');
    }
    record.state = 'stopping';
    record.stops += 1;
    const startedAt = this.#clock.now();
    this.#event('component-stopping', id, reason);
    this.#health.unknown(id, `Component stopping (${reason})`);

    try {
      if (component.stop) {
        await runWithDeadline(
          (childSignal) => component.stop?.(Object.freeze({ id, signal: childSignal, reason, startedAt })),
          {
            componentId: id,
            operationName: 'stop',
            timeoutMs: this.#stopTimeoutMs,
            ...(signal === undefined ? {} : { parentSignal: signal }),
            clock: this.#clock,
          },
        );
      }
      record.state = 'stopped';
      record.lastStoppedAt = this.#clock.now();
      record.lastError = null;
      this.#health.disabled(id, 'Component stopped');
      this.#event('component-stopped', id, reason);
    } catch (error) {
      record.state = 'failed';
      record.failures += 1;
      record.lastFailureAt = this.#clock.now();
      record.lastError = errorMessage(error);
      this.#health.unhealthy(id, record.lastError);
      this.#event('component-stop-failed', id, record.lastError);
      throw error;
    }
  }

  #requireComponent(id: string): LifecycleComponent {
    const component = this.#components.get(id);
    if (!component) throw new Error(`Lifecycle component "${id}" is not registered.`);
    return component;
  }

  #requireRecord(id: string): MutableLifecycleRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`Lifecycle state for "${id}" is not registered.`);
    return record;
  }

  #event(type: LifecycleEvent['type'], componentId: string | null, message: string | null): void {
    safeObserver(this.#onEvent, Object.freeze({
      type,
      componentId,
      timestamp: this.#clock.now(),
      message,
    }));
  }
}
