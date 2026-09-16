export type RuntimePhase =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'suspending'
  | 'suspended'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type RuntimeTier = 'minimal' | 'balanced' | 'enhanced';
export type TaskPriority = 'critical' | 'high' | 'normal' | 'low' | 'background';
export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';
export type ResourceKind = 'network' | 'cpu' | 'memory' | 'render' | 'storage';
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface Clock {
  now(): number;
  wallTime(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RuntimeCapabilities {
  readonly tier: RuntimeTier;
  readonly hardwareConcurrency: number;
  readonly deviceMemoryGb: number | null;
  readonly reducedMotion: boolean;
  readonly saveData: boolean;
  readonly effectiveConnectionType: string | null;
  readonly downlinkMbps: number | null;
  readonly roundTripTimeMs: number | null;
  readonly online: boolean;
  readonly supportsWebGL2: boolean;
  readonly supportsWorker: boolean;
  readonly supportsOffscreenCanvas: boolean;
  readonly supportsAbortSignalTimeout: boolean;
  readonly supportsStructuredClone: boolean;
  readonly supportsIntersectionObserver: boolean;
  readonly supportsResizeObserver: boolean;
  readonly supportsPerformanceObserver: boolean;
  readonly supportsSchedulerPostTask: boolean;
  readonly supportsViewTransition: boolean;
  readonly supportsTrustedTypes: boolean;
  readonly measuredAt: number;
}

export interface RuntimeBudget {
  readonly tier: RuntimeTier;
  readonly maxConcurrentNetwork: number;
  readonly maxConcurrentCpu: number;
  readonly maxQueuedTasks: number;
  readonly maxCacheEntries: number;
  readonly maxCacheBytes: number;
  readonly maxVisibleFeatures2d: number;
  readonly maxVisibleFeatures3d: number;
  readonly maxGpuHeavyLayers: number;
  readonly frameBudgetMs: number;
  readonly backgroundSliceMs: number;
  readonly telemetryCapacity: number;
}

export interface RuntimeBudgetOverrides {
  readonly maxConcurrentNetwork?: number;
  readonly maxConcurrentCpu?: number;
  readonly maxQueuedTasks?: number;
  readonly maxCacheEntries?: number;
  readonly maxCacheBytes?: number;
  readonly maxVisibleFeatures2d?: number;
  readonly maxVisibleFeatures3d?: number;
  readonly maxGpuHeavyLayers?: number;
  readonly frameBudgetMs?: number;
  readonly backgroundSliceMs?: number;
  readonly telemetryCapacity?: number;
}

export interface TaskContext {
  readonly signal: AbortSignal;
  readonly taskId: string;
  readonly attempt: number;
  readonly enqueuedAt: number;
  readonly startedAt: number;
}

export interface ScheduledTaskOptions {
  readonly id?: string;
  readonly key?: string;
  readonly priority?: TaskPriority;
  readonly kind?: ResourceKind;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly deduplicate?: boolean;
  readonly replaceQueued?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SchedulerSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly timedOut: number;
  readonly deduplicated: number;
  readonly rejected: number;
  readonly activeByKind: Readonly<Record<ResourceKind, number>>;
  readonly queuedByPriority: Readonly<Record<TaskPriority, number>>;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly retryable?: (error: unknown, attempt: number) => boolean;
}

export interface CircuitBreakerPolicy {
  readonly failureThreshold: number;
  readonly successThreshold: number;
  readonly openDurationMs: number;
  readonly rollingWindowMs: number;
  readonly minimumSamples: number;
}

export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly failures: number;
  readonly successes: number;
  readonly consecutiveHalfOpenSuccesses: number;
  readonly openedAt: number | null;
  readonly sampleCount: number;
}

export interface TelemetryEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly level: TelemetryLevel;
  readonly domain: string;
  readonly name: string;
  readonly durationMs?: number;
  readonly attributes?: Readonly<Record<string, TelemetryValue>>;
}

export type TelemetryPrimitive = string | number | boolean | null;
export type TelemetryValue = TelemetryPrimitive | readonly TelemetryPrimitive[];

export interface TelemetrySummary {
  readonly generatedAt: number;
  readonly totalEvents: number;
  readonly droppedEvents: number;
  readonly countsByLevel: Readonly<Record<TelemetryLevel, number>>;
  readonly countsByDomain: Readonly<Record<string, number>>;
  readonly countsByName: Readonly<Record<string, number>>;
  readonly durations: Readonly<Record<string, DurationSummary>>;
}

export interface DurationSummary {
  readonly count: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly averageMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface StateSnapshot<TState> {
  readonly version: number;
  readonly updatedAt: number;
  readonly state: Readonly<TState>;
}

export interface StateChange<TState> {
  readonly previous: StateSnapshot<TState>;
  readonly current: StateSnapshot<TState>;
  readonly reason: string;
}

export type StateListener<TState> = (change: StateChange<TState>) => void;

export interface RuntimeKernelSnapshot {
  readonly phase: RuntimePhase;
  readonly capabilities: RuntimeCapabilities;
  readonly budget: RuntimeBudget;
  readonly scheduler: SchedulerSnapshot;
  readonly telemetry: TelemetrySummary;
  readonly startedAt: number | null;
  readonly lastTransitionAt: number;
  readonly failures: readonly RuntimeFailure[];
}

export interface RuntimeFailure {
  readonly timestamp: number;
  readonly domain: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface RuntimeKernelStartOptions {
  readonly signal?: AbortSignal;
  readonly budgetOverrides?: RuntimeBudgetOverrides;
  readonly warmup?: boolean;
}

export interface RuntimeKernelStopOptions {
  readonly signal?: AbortSignal;
  readonly drain?: boolean;
  readonly timeoutMs?: number;
}

export interface ReservationRequest {
  readonly kind: ResourceKind;
  readonly units?: number;
  readonly owner?: string;
  readonly ttlMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ResourceReservation extends Disposable {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly units: number;
  readonly owner: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly released: boolean;
  release(): boolean;
}

export interface ResourceBudgetSnapshot {
  readonly budget: RuntimeBudget;
  readonly used: Readonly<Record<ResourceKind, number>>;
  readonly available: Readonly<Record<ResourceKind, number>>;
  readonly reservationCount: number;
  readonly rejectedReservations: number;
  readonly expiredReservations: number;
}

export interface PersistenceAdapter<TState> {
  read(): Promise<TState | null> | TState | null;
  write(state: Readonly<TState>): Promise<void> | void;
  clear?(): Promise<void> | void;
}

export type Result<TValue, TError = Error> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

export const ok = <TValue>(value: TValue): Result<TValue, never> => ({ ok: true, value });
export const err = <TError>(error: TError): Result<never, TError> => ({ ok: false, error });

export const TASK_PRIORITY_ORDER: Readonly<Record<TaskPriority, number>> = Object.freeze({
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
  background: 4,
});

export const RESOURCE_KINDS: readonly ResourceKind[] = Object.freeze([
  'network',
  'cpu',
  'memory',
  'render',
  'storage',
]);

export const TASK_PRIORITIES: readonly TaskPriority[] = Object.freeze([
  'critical',
  'high',
  'normal',
  'low',
  'background',
]);

export const TELEMETRY_LEVELS: readonly TelemetryLevel[] = Object.freeze([
  'debug',
  'info',
  'warn',
  'error',
]);

export const clampNumber = (value: unknown, minimum: number, maximum: number, fallback: number): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
};

export const positiveInteger = (value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number =>
  Math.trunc(clampNumber(value, 1, maximum, fallback));

export const nonNegativeInteger = (value: unknown, fallback = 0, maximum = Number.MAX_SAFE_INTEGER): number =>
  Math.trunc(clampNumber(value, 0, maximum, fallback));

export const asFiniteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export const asNonEmptyString = (value: unknown, maximumLength = 256): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, Math.max(1, maximumLength));
};

export const freezeRecord = <TValue>(value: Record<string, TValue>): Readonly<Record<string, TValue>> =>
  Object.freeze({ ...value });

export const exhaustive = (value: never, message = 'Unexpected value'): never => {
  throw new Error(`${message}: ${String(value)}`);
};

export const abortError = (message = 'Operation aborted'): Error => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

export const throwIfAborted = (signal?: AbortSignal, message?: string): void => {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw abortError(message);
  }
};

export const isAbortLike = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 'ABORTED' || candidate.code === 'ERR_CANCELED';
};

export const createMonotonicIdFactory = (prefix: string, wallTime: () => number = Date.now): (() => string) => {
  let sequence = 0;
  const safePrefix = asNonEmptyString(prefix, 48) ?? 'runtime';
  return () => {
    sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
    return `${safePrefix}-${wallTime().toString(36)}-${sequence.toString(36)}`;
  };
};

export const immutableArray = <TValue>(values: Iterable<TValue>): readonly TValue[] =>
  Object.freeze(Array.from(values));

export const immutableObject = <TValue extends Record<string, unknown>>(value: TValue): Readonly<TValue> =>
  Object.freeze({ ...value });
