export type LifecyclePhase = 'bootstrap' | 'core' | 'feature' | 'background';
export type ComponentCriticality = 'critical' | 'important' | 'optional';
export type DependencyKind = 'required' | 'optional' | 'after';
export type ComponentRuntimeState =
  | 'registered'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type HealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
export type ReadinessStatus = 'ready' | 'degraded' | 'not-ready';

export interface DependencyReference {
  readonly id: string;
  readonly kind?: DependencyKind;
}

export interface ComponentDescriptor {
  readonly id: string;
  readonly phase?: LifecyclePhase;
  readonly criticality?: ComponentCriticality;
  readonly dependencies?: readonly DependencyReference[];
  readonly tags?: readonly string[];
  readonly description?: string;
}

export interface NormalizedDependencyReference {
  readonly id: string;
  readonly kind: DependencyKind;
}

export interface NormalizedComponentDescriptor {
  readonly id: string;
  readonly phase: LifecyclePhase;
  readonly criticality: ComponentCriticality;
  readonly dependencies: readonly NormalizedDependencyReference[];
  readonly tags: readonly string[];
  readonly description: string | null;
}

export interface ComponentStartContext {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly startedAt: number;
}

export interface ComponentStopContext {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly reason: 'shutdown' | 'rollback' | 'replace' | 'failure';
  readonly startedAt: number;
}

export interface LifecycleComponent extends ComponentDescriptor {
  readonly start: (context: ComponentStartContext) => Promise<void> | void;
  readonly stop?: (context: ComponentStopContext) => Promise<void> | void;
}

export interface ComponentLifecycleSnapshot {
  readonly id: string;
  readonly state: ComponentRuntimeState;
  readonly starts: number;
  readonly stops: number;
  readonly failures: number;
  readonly lastStartedAt: number | null;
  readonly lastStoppedAt: number | null;
  readonly lastFailureAt: number | null;
  readonly lastError: string | null;
}

export interface HealthSignal {
  readonly componentId: string;
  readonly status: HealthStatus;
  readonly observedAt?: number;
  readonly ttlMs?: number;
  readonly message?: string;
  readonly source?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface NormalizedHealthSignal {
  readonly componentId: string;
  readonly status: HealthStatus;
  readonly observedAt: number;
  readonly expiresAt: number | null;
  readonly message: string | null;
  readonly source: string | null;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ComponentHealthSnapshot extends NormalizedHealthSignal {
  readonly stale: boolean;
  readonly ageMs: number;
}

export interface ReadinessReport {
  readonly status: ReadinessStatus;
  readonly generatedAt: number;
  readonly required: readonly string[];
  readonly healthy: readonly string[];
  readonly degraded: readonly string[];
  readonly unhealthy: readonly string[];
  readonly unknown: readonly string[];
  readonly disabled: readonly string[];
  readonly stale: readonly string[];
  readonly summary: string;
}

export interface LifecycleEvent {
  readonly type:
    | 'component-starting'
    | 'component-started'
    | 'component-start-failed'
    | 'component-stopping'
    | 'component-stopped'
    | 'component-stop-failed'
    | 'startup-complete'
    | 'startup-failed'
    | 'shutdown-complete';
  readonly componentId: string | null;
  readonly timestamp: number;
  readonly message: string | null;
}

export interface RuntimeClock {
  readonly now: () => number;
  readonly setTimeout: (handler: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface RequestExecutionContext {
  readonly key: string;
  readonly lane: string;
  readonly signal: AbortSignal;
  readonly enqueuedAt: number;
  readonly startedAt: number;
  readonly priority: number;
}

export interface RequestCoordinatorSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly inFlightKeys: readonly string[];
  readonly queueKeys: readonly string[];
  readonly lanes: Readonly<Record<string, { readonly active: number; readonly queued: number }>>;
  readonly accepted: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly deduplicated: number;
  readonly rejected: number;
}

export class PlatformInvariantError extends Error {
  readonly code = 'PLATFORM_INVARIANT';

  constructor(message: string) {
    super(message);
    this.name = 'PlatformInvariantError';
  }
}

export class DuplicateComponentError extends PlatformInvariantError {
  readonly componentId: string;

  constructor(componentId: string) {
    super(`Component "${componentId}" is registered more than once.`);
    this.name = 'DuplicateComponentError';
    this.componentId = componentId;
  }
}

export class MissingDependencyError extends PlatformInvariantError {
  readonly componentId: string;
  readonly dependencyId: string;

  constructor(componentId: string, dependencyId: string) {
    super(`Component "${componentId}" requires missing dependency "${dependencyId}".`);
    this.name = 'MissingDependencyError';
    this.componentId = componentId;
    this.dependencyId = dependencyId;
  }
}

export class DependencyCycleError extends PlatformInvariantError {
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super(`Component dependency cycle detected: ${cycle.join(' -> ')}.`);
    this.name = 'DependencyCycleError';
    this.cycle = Object.freeze([...cycle]);
  }
}

export class LifecycleTransitionError extends PlatformInvariantError {
  readonly componentId: string;
  readonly state: ComponentRuntimeState;

  constructor(componentId: string, state: ComponentRuntimeState, message: string) {
    super(`Lifecycle transition rejected for "${componentId}" in state "${state}": ${message}`);
    this.name = 'LifecycleTransitionError';
    this.componentId = componentId;
    this.state = state;
  }
}

export class LifecycleDeadlineError extends Error {
  readonly code = 'LIFECYCLE_DEADLINE';
  readonly componentId: string;
  readonly timeoutMs: number;
  readonly operation: 'start' | 'stop';

  constructor(componentId: string, operation: 'start' | 'stop', timeoutMs: number) {
    super(`Component "${componentId}" ${operation} exceeded ${timeoutMs}ms deadline.`);
    this.name = 'LifecycleDeadlineError';
    this.componentId = componentId;
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}

export class RequestQueueOverflowError extends Error {
  readonly code = 'REQUEST_QUEUE_OVERFLOW';
  readonly lane: string;

  constructor(lane: string) {
    super(`Request queue for lane "${lane}" is full.`);
    this.name = 'RequestQueueOverflowError';
    this.lane = lane;
  }
}

export class RequestCoordinatorDisposedError extends Error {
  readonly code = 'REQUEST_COORDINATOR_DISPOSED';

  constructor() {
    super('Request coordinator has been disposed.');
    this.name = 'RequestCoordinatorDisposedError';
  }
}

export const DEFAULT_RUNTIME_CLOCK: RuntimeClock = Object.freeze({
  now: Date.now,
  setTimeout: (handler: () => void, timeoutMs: number) => setTimeout(handler, timeoutMs),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
});

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export const normalizeIdentifier = (value: unknown, label = 'identifier'): string => {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  if (CONTROL_CHARACTER.test(value)) throw new TypeError(`${label} cannot contain control characters.`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} cannot be empty.`);
  if (normalized.length > 160) throw new TypeError(`${label} exceeds 160 characters.`);
  return normalized;
};

export const normalizeOptionalText = (value: unknown, maxLength = 500): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  if (CONTROL_CHARACTER.test(value)) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, Math.max(1, maxLength));
};

export const normalizeTags = (values: readonly string[] | undefined): readonly string[] => {
  if (!values?.length) return Object.freeze([]);
  const tags = new Set<string>();
  for (const value of values) {
    try {
      tags.add(normalizeIdentifier(value, 'tag').toLocaleLowerCase('en-US'));
    } catch {
      // Invalid tags are intentionally ignored instead of corrupting runtime registration.
    }
    if (tags.size >= 32) break;
  }
  return Object.freeze([...tags].sort((left, right) => left.localeCompare(right)));
};

export const boundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

export const boundedNumber = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
};

export const safeObserver = <TArgs extends readonly unknown[]>(
  observer: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void => {
  if (!observer) return;
  try {
    observer(...args);
  } catch {
    // Observability is deliberately isolated from platform control flow.
  }
};

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message.slice(0, 1000);
  if (typeof error === 'string') return error.slice(0, 1000);
  return 'Unknown platform error';
};

export const abortReason = (signal: AbortSignal | undefined): unknown => {
  if (!signal?.aborted) return undefined;
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
};

export const throwIfAbortedSignal = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) return;
  throw abortReason(signal);
};

export const phaseWeight = (phase: LifecyclePhase): number => {
  switch (phase) {
    case 'bootstrap': return 0;
    case 'core': return 1;
    case 'feature': return 2;
    case 'background': return 3;
  }
};

export const criticalityWeight = (criticality: ComponentCriticality): number => {
  switch (criticality) {
    case 'critical': return 0;
    case 'important': return 1;
    case 'optional': return 2;
  }
};

export const normalizeDependencyKind = (value: unknown): DependencyKind => {
  if (value === 'optional' || value === 'after') return value;
  return 'required';
};

export const normalizeHealthStatus = (value: unknown): HealthStatus => {
  if (value === 'healthy' || value === 'degraded' || value === 'unhealthy' || value === 'disabled') {
    return value;
  }
  return 'unknown';
};
