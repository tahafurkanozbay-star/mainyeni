import {
  createMutationIdempotencyRegistry,
  MutationIdempotencyError,
  type MutationIdempotencyRegistry,
  type MutationIdempotencyRegistryOptions,
  type MutationIdempotencyRegistrySnapshot,
} from './mutationIdempotency';
import {
  getErrorCode,
  isAbortSignalLike,
  normalizeSchedulerGroup,
  type NormalizedRequestConfig,
} from './contracts';

export type MutationSafetyEventKind =
  | 'bypassed'
  | 'admitted'
  | 'attempt'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'disposed'
  | 'observer-failed';

export interface MutationSafetyEvent {
  readonly sequence: number;
  readonly at: number;
  readonly kind: MutationSafetyEventKind;
  readonly method?: string;
  readonly owner?: string;
  readonly route?: string;
  readonly attempt?: number;
  readonly errorCode?: string;
  readonly errorName?: string;
}

export interface MutationSafetyRuntimeOptions {
  readonly registry?: MutationIdempotencyRegistry;
  readonly registryOptions?: MutationIdempotencyRegistryOptions;
  readonly clock?: () => number;
  readonly onEvent?: (event: MutationSafetyEvent) => void;
}

export interface MutationSafetyRunControls {
  readonly markAttempt: (attempt: number) => void;
}

export interface MutationSafetyRuntimeSnapshot {
  readonly disposed: boolean;
  readonly protectedExecutions: number;
  readonly bypassedExecutions: number;
  readonly completedExecutions: number;
  readonly failedExecutions: number;
  readonly cancelledExecutions: number;
  readonly rejectedExecutions: number;
  readonly observerFailures: number;
  readonly registry: MutationIdempotencyRegistrySnapshot;
}

export interface MutationSafetyRuntime {
  readonly run: <T>(
    config: NormalizedRequestConfig,
    operation: (controls: MutationSafetyRunControls) => Promise<T>,
  ) => Promise<T>;
  readonly snapshot: () => MutationSafetyRuntimeSnapshot;
  readonly prune: () => number;
  readonly dispose: (reason?: unknown) => void;
}

const safeErrorName = (reason: unknown): string | undefined => {
  if (reason === undefined || reason === null) return undefined;
  if (reason instanceof Error && reason.name.trim()) return reason.name.slice(0, 80);
  return 'UnknownError';
};

const safeErrorCode = (reason: unknown): string | undefined => {
  const code = getErrorCode(reason);
  return code ? code.slice(0, 80) : undefined;
};

const isCancellation = (
  error: unknown,
  signal: AbortSignal | undefined,
): boolean => {
  if (signal?.aborted) return true;
  const code = getErrorCode(error);
  return code === 'ABORTED'
    || code === 'TASK_CANCELLED'
    || code === 'subscriber-aborted'
    || code === 'operation-cancelled'
    || code === 'MUTATION_ABORTED';
};

const routeOwner = (config: NormalizedRequestConfig): string =>
  config.schedulerGroup
    ? normalizeSchedulerGroup(config.schedulerGroup).slice(0, 160)
    : normalizeSchedulerGroup(config.url).slice(0, 160);

class BoundedMutationSafetyRuntime implements MutationSafetyRuntime {
  readonly #registry: MutationIdempotencyRegistry;
  readonly #clock: () => number;
  readonly #onEvent: ((event: MutationSafetyEvent) => void) | undefined;

  #disposed = false;
  #sequence = 0;
  #lastObservedAt: number | undefined;
  #protectedExecutions = 0;
  #bypassedExecutions = 0;
  #completedExecutions = 0;
  #failedExecutions = 0;
  #cancelledExecutions = 0;
  #rejectedExecutions = 0;
  #observerFailures = 0;

  constructor(options: MutationSafetyRuntimeOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#onEvent = options.onEvent;
    this.#registry = options.registry ?? createMutationIdempotencyRegistry({
      ...options.registryOptions,
      ...(options.registryOptions?.clock ? {} : { clock: this.#clock }),
    });
  }

  async run<T>(
    config: NormalizedRequestConfig,
    operation: (controls: MutationSafetyRunControls) => Promise<T>,
  ): Promise<T> {
    if (this.#disposed) {
      this.#rejectedExecutions += 1;
      const error = new MutationIdempotencyError(
        'REGISTRY_DISPOSED',
        'Mutation safety runtime is disposed.',
      );
      this.#emit({
        kind: 'rejected',
        method: config.method,
        route: config.url,
        errorCode: error.code,
        errorName: error.name,
      });
      throw error;
    }

    if (
      config.mutationProtected !== true
      || typeof config.idempotencyKey !== 'string'
      || !config.idempotencyKey
    ) {
      this.#bypassedExecutions += 1;
      this.#emit({
        kind: 'bypassed',
        method: config.method,
        route: config.url,
      });
      return operation(Object.freeze({ markAttempt: () => undefined }));
    }

    const signal = isAbortSignalLike(config.signal) ? config.signal : undefined;
    const owner = routeOwner(config);
    let lease;
    try {
      lease = this.#registry.begin({
        key: config.idempotencyKey,
        owner,
        method: config.method,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      this.#rejectedExecutions += 1;
      this.#emit({
        kind: 'rejected',
        method: config.method,
        owner,
        route: config.url,
        ...(safeErrorCode(error) ? { errorCode: safeErrorCode(error) } : {}),
        ...(safeErrorName(error) ? { errorName: safeErrorName(error) } : {}),
      });
      throw error;
    }

    this.#protectedExecutions += 1;
    this.#emit({
      kind: 'admitted',
      method: config.method,
      owner,
      route: config.url,
    });

    const controls: MutationSafetyRunControls = Object.freeze({
      markAttempt: (attempt: number) => {
        if (!Number.isFinite(attempt) || attempt < 0 || attempt > config.maxRetries) {
          throw new MutationIdempotencyError(
            'ATTEMPT_LIMIT_EXCEEDED',
            'Mutation attempt exceeds normalized maxRetries.',
          );
        }
        if (!lease.markAttempt()) return;
        this.#emit({
          kind: 'attempt',
          method: config.method,
          owner,
          route: config.url,
          attempt: Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0,
        });
      },
    });

    try {
      const value = await operation(controls);
      if (lease.complete()) {
        this.#completedExecutions += 1;
        this.#emit({
          kind: 'completed',
          method: config.method,
          owner,
          route: config.url,
        });
      }
      return value;
    } catch (error) {
      if (isCancellation(error, signal)) {
        if (lease.cancel(error)) {
          this.#cancelledExecutions += 1;
          this.#emit({
            kind: 'cancelled',
            method: config.method,
            owner,
            route: config.url,
            ...(safeErrorCode(error) ? { errorCode: safeErrorCode(error) } : {}),
            ...(safeErrorName(error) ? { errorName: safeErrorName(error) } : {}),
          });
        }
      } else if (lease.fail(error)) {
        this.#failedExecutions += 1;
        this.#emit({
          kind: 'failed',
          method: config.method,
          owner,
          route: config.url,
          ...(safeErrorCode(error) ? { errorCode: safeErrorCode(error) } : {}),
          ...(safeErrorName(error) ? { errorName: safeErrorName(error) } : {}),
        });
      }
      throw error;
    }
  }

  snapshot(): MutationSafetyRuntimeSnapshot {
    return Object.freeze({
      disposed: this.#disposed,
      protectedExecutions: this.#protectedExecutions,
      bypassedExecutions: this.#bypassedExecutions,
      completedExecutions: this.#completedExecutions,
      failedExecutions: this.#failedExecutions,
      cancelledExecutions: this.#cancelledExecutions,
      rejectedExecutions: this.#rejectedExecutions,
      observerFailures: this.#observerFailures,
      registry: this.#registry.snapshot(),
    });
  }

  prune(): number {
    if (this.#disposed) return 0;
    return this.#registry.prune();
  }

  dispose(reason?: unknown): void {
    if (this.#disposed) return;
    this.#registry.dispose(reason);
    this.#disposed = true;
    this.#emit({
      kind: 'disposed',
      ...(safeErrorName(reason) ? { errorName: safeErrorName(reason) } : {}),
    });
  }

  #emit(event: Omit<MutationSafetyEvent, 'sequence' | 'at'>): void {
    if (!this.#onEvent) return;
    const payload = Object.freeze({
      sequence: ++this.#sequence,
      at: this.#now(),
      ...event,
    });
    try {
      this.#onEvent(payload);
    } catch {
      this.#observerFailures += 1;
    }
  }

  #now(): number {
    const value = Number(this.#clock());
    if (!Number.isFinite(value) || value < 0) {
      throw new MutationIdempotencyError(
        'INVALID_CLOCK',
        'Mutation safety clock returned an invalid timestamp.',
      );
    }
    if (this.#lastObservedAt !== undefined && value < this.#lastObservedAt) {
      throw new MutationIdempotencyError(
        'INVALID_CLOCK',
        'Mutation safety clock must be monotonic.',
      );
    }
    this.#lastObservedAt = value;
    return value;
  }
}

export const createMutationSafetyRuntime = (
  options: MutationSafetyRuntimeOptions = {},
): MutationSafetyRuntime => new BoundedMutationSafetyRuntime(options);
