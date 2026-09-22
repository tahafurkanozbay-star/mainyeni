import type {
  ResourceKind,
  ResourceReservation,
} from './contracts';
import type { ResourceBudgetManager } from './resourceBudget';
import {
  type AdmissionLease,
  type AdmissionRequest,
  type AdmissionSnapshot,
} from './admissionController';
import type {
  AdaptiveRuntimeControl,
  AdaptiveRuntimeSnapshot,
} from './adaptiveRuntimeControl';
import {
  createRuntimeHealthJournal,
  type RuntimeHealthJournal,
  type RuntimeHealthSummary,
} from './runtimeHealthJournal';
import {
  RuntimeResilienceRejectedError,
  type RuntimeResilienceLane,
  type RuntimeResilienceLease,
  type RuntimeResilienceOutcome,
  type RuntimeResilienceSupervisor,
  type RuntimeResilienceSupervisorSnapshot,
} from './runtimeResilienceSupervisor';

export interface RuntimeWorkloadResourceClaim {
  readonly kind: ResourceKind;
  readonly units?: number;
  readonly ttlMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeWorkloadRequest extends AdmissionRequest {
  readonly owner?: string;
  readonly resources?: readonly RuntimeWorkloadResourceClaim[];
  readonly deadlineMs?: number;
  readonly parentDeadlineMs?: number;
}

export interface RuntimeWorkloadLease {
  readonly id: string;
  readonly key: string;
  readonly lane: string;
  readonly owner: string | null;
  readonly cost: number;
  readonly signal: AbortSignal;
  readonly resources: readonly ResourceReservation[];
  readonly released: boolean;
  readonly release: () => void;
}

export interface RuntimeWorkloadExecutionContext {
  readonly signal: AbortSignal;
  readonly lease: RuntimeWorkloadLease;
}

export interface RuntimeWorkloadGovernorPolicy {
  readonly maxClaimsPerWorkload: number;
  readonly defaultDeadlineMs: number;
  readonly maxDeadlineMs: number;
  readonly maxOwnerLength: number;
}

export interface RuntimeWorkloadGovernorOptions {
  readonly control: AdaptiveRuntimeControl;
  readonly budget: ResourceBudgetManager;
  readonly journal?: RuntimeHealthJournal;
  readonly now?: () => number;
  readonly policy?: Partial<RuntimeWorkloadGovernorPolicy>;
  readonly resilience?: RuntimeResilienceSupervisor;
  readonly disposeControl?: boolean;
  readonly disposeResilience?: boolean;
}

export interface RuntimeWorkloadGovernorCounters {
  readonly acquired: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly timedOut: number;
  readonly rejected: number;
  readonly resourceRejected: number;
}

export interface RuntimeWorkloadGovernorSnapshot {
  readonly disposed: boolean;
  readonly active: number;
  readonly admission: AdmissionSnapshot;
  readonly adaptive: AdaptiveRuntimeSnapshot;
  readonly counters: RuntimeWorkloadGovernorCounters;
  readonly activeByLane: Readonly<Record<string, number>>;
  readonly activeResources: Readonly<Record<ResourceKind, number>>;
  readonly health: RuntimeHealthSummary;
  readonly resilience: RuntimeResilienceSupervisorSnapshot | null;
}

export interface RuntimeWorkloadGovernor {
  readonly acquire: (request: RuntimeWorkloadRequest) => Promise<RuntimeWorkloadLease>;
  readonly execute: <TValue>(
    request: RuntimeWorkloadRequest,
    operation: (context: RuntimeWorkloadExecutionContext) => Promise<TValue> | TValue,
  ) => Promise<TValue>;
  readonly cancelQueued: (predicate?: (request: Readonly<AdmissionRequest>) => boolean) => number;
  readonly cancelActive: (
    predicate?: (lease: Readonly<RuntimeWorkloadLease>) => boolean,
    reason?: unknown,
  ) => number;
  readonly cancelOwner: (owner: string, reason?: unknown) => number;
  readonly snapshot: () => RuntimeWorkloadGovernorSnapshot;
  readonly dispose: (reason?: unknown) => void;
}

export class RuntimeWorkloadResourceRejectedError extends Error {
  readonly code = 'PLATFORM_WORKLOAD_RESOURCE_REJECTED';

  constructor(message = 'Runtime resource capacity is exhausted.') {
    super(message);
    this.name = 'RuntimeWorkloadResourceRejectedError';
  }
}

export class RuntimeWorkloadTimeoutError extends Error {
  readonly code = 'PLATFORM_WORKLOAD_TIMEOUT';
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Runtime workload exceeded its ${timeoutMs}ms deadline.`);
    this.name = 'RuntimeWorkloadTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class RuntimeWorkloadDisposedError extends Error {
  readonly code = 'PLATFORM_WORKLOAD_DISPOSED';

  constructor() {
    super('Runtime workload governor is disposed.');
    this.name = 'RuntimeWorkloadDisposedError';
  }
}

type ReleaseOutcome = 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'disposed';

interface InternalWorkload {
  readonly admission: AdmissionLease;
  readonly controller: AbortController;
  readonly resources: ResourceReservation[];
  readonly publicLease: RuntimeWorkloadLease;
  readonly startedAt: number;
  readonly externalSignal: AbortSignal | null;
  readonly externalAbort: (() => void) | null;
  readonly resilience: RuntimeResilienceLease | null;
  timer: ReturnType<typeof setTimeout> | null;
  internalAbortCleanup: (() => void) | null;
  released: boolean;
  outcome: ReleaseOutcome | null;
}

const DEFAULT_POLICY: RuntimeWorkloadGovernorPolicy = Object.freeze({
  maxClaimsPerWorkload: 8,
  defaultDeadlineMs: 30_000,
  maxDeadlineMs: 5 * 60_000,
  maxOwnerLength: 96,
});

const RESOURCE_KINDS: readonly ResourceKind[] = Object.freeze([
  'network',
  'cpu',
  'memory',
  'render',
  'storage',
]);

const positiveInteger = (value: number | undefined, fallback: number, maximum: number): number => {
  if (!Number.isFinite(value) || Number(value) <= 0) return fallback;
  return Math.min(maximum, Math.floor(Number(value)));
};

const normalizePolicy = (
  input: Partial<RuntimeWorkloadGovernorPolicy> = {},
): RuntimeWorkloadGovernorPolicy => Object.freeze({
  maxClaimsPerWorkload: positiveInteger(input.maxClaimsPerWorkload, DEFAULT_POLICY.maxClaimsPerWorkload, 32),
  defaultDeadlineMs: positiveInteger(input.defaultDeadlineMs, DEFAULT_POLICY.defaultDeadlineMs, 5 * 60_000),
  maxDeadlineMs: positiveInteger(input.maxDeadlineMs, DEFAULT_POLICY.maxDeadlineMs, 30 * 60_000),
  maxOwnerLength: positiveInteger(input.maxOwnerLength, DEFAULT_POLICY.maxOwnerLength, 240),
});

const normalizeOwner = (owner: string | undefined, limit: number): string | null => {
  const normalized = owner?.trim();
  return normalized ? normalized.slice(0, limit) : null;
};

const emptyResourceCounts = (): Record<ResourceKind, number> => ({
  network: 0,
  cpu: 0,
  memory: 0,
  render: 0,
  storage: 0,
});

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('Runtime workload cancelled.', 'AbortError');

const classifyOutcome = (reason: unknown): ReleaseOutcome => {
  if (reason instanceof RuntimeWorkloadTimeoutError) return 'timed-out';
  if (reason instanceof RuntimeWorkloadDisposedError) return 'disposed';
  if (reason instanceof DOMException && reason.name === 'AbortError') return 'cancelled';
  if (reason instanceof Error && reason.name === 'AbortError') return 'cancelled';
  return 'failed';
};

const resilienceLaneFor = (
  request: RuntimeWorkloadRequest,
): RuntimeResilienceLane => {
  if (request.priority === 'critical') return 'critical';
  const lane = request.lane?.trim().toLowerCase();
  if (
    request.priority === 'background'
    || lane === 'background'
    || lane === 'prefetch'
    || lane === 'maintenance'
  ) {
    return 'background';
  }
  return 'interactive';
};

const resilienceOutcomeFor = (
  outcome: ReleaseOutcome,
): RuntimeResilienceOutcome => {
  if (outcome === 'completed') return 'success';
  if (outcome === 'failed') return 'failure';
  if (outcome === 'timed-out') return 'timeout';
  if (outcome === 'disposed') return 'released';
  return 'cancelled';
};

export const createRuntimeWorkloadGovernor = (
  options: RuntimeWorkloadGovernorOptions,
): RuntimeWorkloadGovernor => {
  const now = options.now ?? Date.now;
  const policy = normalizePolicy(options.policy);
  const journal = options.journal ?? createRuntimeHealthJournal({}, now);
  const ownsJournal = options.journal === undefined;
  const active = new Map<string, InternalWorkload>();
  let acquired = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let timedOut = 0;
  let rejected = 0;
  let resourceRejected = 0;
  let resilienceSequence = 0;
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new RuntimeWorkloadDisposedError();
  };

  const record = (
    kind: 'admission' | 'resource' | 'latency' | 'failure' | 'recovery',
    severity: 'debug' | 'info' | 'warning' | 'error',
    code: string,
    lane: string,
    durationMs?: number,
  ): void => {
    if (disposed) return;
    journal.record({
      at: now(),
      kind,
      severity,
      code,
      lane,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  };

  const releaseResources = (resources: readonly ResourceReservation[]): void => {
    for (const reservation of resources) reservation.release();
  };

  const incrementOutcome = (outcome: ReleaseOutcome): void => {
    if (outcome === 'completed') completed += 1;
    else if (outcome === 'failed') failed += 1;
    else if (outcome === 'timed-out') timedOut += 1;
    else cancelled += 1;
  };

  const releaseInternal = (internal: InternalWorkload, outcome: ReleaseOutcome): void => {
    if (internal.released) return;
    internal.released = true;
    internal.outcome = outcome;
    if (internal.timer) {
      clearTimeout(internal.timer);
      internal.timer = null;
    }
    if (internal.externalSignal && internal.externalAbort) {
      internal.externalSignal.removeEventListener('abort', internal.externalAbort);
    }
    internal.internalAbortCleanup?.();
    internal.internalAbortCleanup = null;
    active.delete(internal.admission.id);
    releaseResources(internal.resources);
    internal.admission.release();
    incrementOutcome(outcome);
    const finishedAt = now();
    const durationMs = Math.max(0, finishedAt - internal.startedAt);
    internal.resilience?.finish({
      outcome: resilienceOutcomeFor(outcome),
      nowMs: finishedAt,
      latencyMs: durationMs,
    });
    if (outcome === 'completed') {
      record('latency', 'info', 'workload-completed', internal.admission.lane, durationMs);
    } else if (outcome === 'timed-out') {
      record('failure', 'warning', 'workload-timed-out', internal.admission.lane, durationMs);
    } else if (outcome === 'cancelled' || outcome === 'disposed') {
      record('admission', 'info', 'workload-cancelled', internal.admission.lane, durationMs);
    } else {
      record('failure', 'error', 'workload-failed', internal.admission.lane, durationMs);
    }
  };

  const normalizeClaims = (
    request: RuntimeWorkloadRequest,
  ): readonly RuntimeWorkloadResourceClaim[] => {
    const claims = request.resources ?? [];
    if (claims.length > policy.maxClaimsPerWorkload) {
      throw new RuntimeWorkloadResourceRejectedError(
        `Runtime workload exceeds the maximum of ${policy.maxClaimsPerWorkload} resource claims.`,
      );
    }
    return claims;
  };

  const reserveAll = (
    claims: readonly RuntimeWorkloadResourceClaim[],
    owner: string | null,
    lane: string,
  ): ResourceReservation[] => {
    const reservations: ResourceReservation[] = [];
    try {
      for (const claim of claims) {
        const reservation = options.budget.reserve({
          kind: claim.kind,
          ...(claim.units === undefined ? {} : { units: claim.units }),
          ...(owner === null ? {} : { owner }),
          ...(claim.ttlMs === undefined ? {} : { ttlMs: claim.ttlMs }),
          ...(claim.metadata === undefined ? {} : { metadata: claim.metadata }),
        });
        if (!reservation) {
          resourceRejected += 1;
          record('resource', 'warning', 'resource-rejected', lane);
          throw new RuntimeWorkloadResourceRejectedError(
            `Runtime resource claim was rejected for ${claim.kind}.`,
          );
        }
        reservations.push(reservation);
      }
      return reservations;
    } catch (error) {
      releaseResources(reservations);
      throw error;
    }
  };

  const acquire = async (request: RuntimeWorkloadRequest): Promise<RuntimeWorkloadLease> => {
    assertActive();
    const claims = normalizeClaims(request);
    const owner = normalizeOwner(request.owner, policy.maxOwnerLength);
    const controller = new AbortController();
    const externalSignal = request.signal ?? null;
    const requestedDeadlineMs = positiveInteger(
      request.deadlineMs,
      policy.defaultDeadlineMs,
      Math.max(policy.defaultDeadlineMs, policy.maxDeadlineMs),
    );
    const startedAt = now();
    let resilienceLease: RuntimeResilienceLease | null = null;

    if (options.resilience) {
      const adaptive = options.control.snapshot();
      resilienceSequence += 1;
      const result = options.resilience.begin({
        key: 'workload:' + resilienceSequence.toString(36),
        lane: resilienceLaneFor(request),
        nowMs: startedAt,
        timeoutMs: requestedDeadlineMs,
        ...(request.parentDeadlineMs === undefined
          ? {}
          : { parentDeadlineMs: request.parentDeadlineMs }),
        load: {
          active: adaptive.admission.active,
          queued: adaptive.admission.queued,
        },
      });
      if (!result.admitted) {
        rejected += 1;
        record(
          'admission',
          'warning',
          'resilience-shed',
          request.lane?.trim() || 'default',
        );
        throw new RuntimeResilienceRejectedError(
          result.reason,
          result.decision,
        );
      }
      resilienceLease = result.lease;
    }

    const deadlineMs = resilienceLease?.timeoutMs ?? requestedDeadlineMs;

    const externalAbort = externalSignal
      ? (): void => {
          if (!controller.signal.aborted) controller.abort(abortReason(externalSignal));
        }
      : null;

    if (externalSignal?.aborted) {
      controller.abort(abortReason(externalSignal));
      resilienceLease?.finish({
        outcome: 'cancelled',
        nowMs: startedAt,
        latencyMs: 0,
      });
    } else if (externalSignal && externalAbort) {
      externalSignal.addEventListener('abort', externalAbort, { once: true });
    }

    const timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(new RuntimeWorkloadTimeoutError(deadlineMs));
    }, deadlineMs);

    let admission: AdmissionLease;
    try {
      admission = await options.control.acquire({
        key: request.key,
        ...(request.lane === undefined ? {} : { lane: request.lane }),
        ...(request.priority === undefined ? {} : { priority: request.priority }),
        ...(request.cost === undefined ? {} : { cost: request.cost }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', externalAbort as EventListener);
      rejected += 1;
      const outcome = controller.signal.aborted ? classifyOutcome(abortReason(controller.signal)) : 'failed';
      if (outcome === 'timed-out') timedOut += 1;
      else if (outcome === 'cancelled') cancelled += 1;
      resilienceLease?.finish({
        outcome: outcome === 'timed-out'
          ? 'timeout'
          : outcome === 'cancelled'
            ? 'cancelled'
            : 'rejected',
        nowMs: now(),
      });
      record(
        outcome === 'timed-out' ? 'failure' : 'admission',
        outcome === 'timed-out' ? 'warning' : 'info',
        outcome === 'timed-out' ? 'admission-deadline' : 'admission-rejected',
        request.lane?.trim() || 'default',
      );
      throw error;
    }

    let resources: ResourceReservation[];
    try {
      resources = reserveAll(claims, owner, admission.lane);
    } catch (error) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', externalAbort as EventListener);
      admission.release();
      resilienceLease?.finish({
        outcome: 'rejected',
        nowMs: now(),
      });
      throw error;
    }

    if (controller.signal.aborted) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', externalAbort as EventListener);
      releaseResources(resources);
      admission.release();
      const reason = abortReason(controller.signal);
      const outcome = classifyOutcome(reason);
      incrementOutcome(outcome);
      resilienceLease?.finish({
        outcome: resilienceOutcomeFor(outcome),
        nowMs: now(),
      });
      throw reason;
    }

    let internal: InternalWorkload;
    const publicLease: RuntimeWorkloadLease = {
      id: admission.id,
      key: admission.key,
      lane: admission.lane,
      owner,
      cost: admission.cost,
      signal: controller.signal,
      resources: Object.freeze([...resources]),
      get released() {
        return internal.released;
      },
      release: () => releaseInternal(internal, 'completed'),
    };

    internal = {
      admission,
      controller,
      resources,
      publicLease: Object.freeze(publicLease),
      startedAt,
      externalSignal,
      externalAbort,
      resilience: resilienceLease,
      timer,
      internalAbortCleanup: null,
      released: false,
      outcome: null,
    };

    const onAbort = (): void => {
      releaseInternal(internal, classifyOutcome(abortReason(controller.signal)));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    internal.internalAbortCleanup = () => {
      controller.signal.removeEventListener('abort', onAbort);
    };

    active.set(admission.id, internal);
    acquired += 1;
    record('admission', 'debug', 'workload-acquired', admission.lane);
    return internal.publicLease;
  };

  const execute = async <TValue>(
    request: RuntimeWorkloadRequest,
    operation: (context: RuntimeWorkloadExecutionContext) => Promise<TValue> | TValue,
  ): Promise<TValue> => {
    const lease = await acquire(request);
    const internal = active.get(lease.id);
    if (!internal) throw new Error('Runtime workload lease ownership was lost.');
    try {
      if (lease.signal.aborted) throw abortReason(lease.signal);
      const value = await operation(Object.freeze({ signal: lease.signal, lease }));
      if (lease.signal.aborted) throw abortReason(lease.signal);
      releaseInternal(internal, 'completed');
      return value;
    } catch (error) {
      if (!internal.released) releaseInternal(internal, classifyOutcome(error));
      throw error;
    }
  };

  const cancelQueued = (
    predicate?: (request: Readonly<AdmissionRequest>) => boolean,
  ): number => predicate ? options.control.cancelQueued(predicate) : options.control.cancelQueued();

  const cancelActive = (
    predicate: (lease: Readonly<RuntimeWorkloadLease>) => boolean = () => true,
    reason: unknown = new DOMException('Runtime workload cancelled.', 'AbortError'),
  ): number => {
    let count = 0;
    for (const internal of active.values()) {
      if (!predicate(internal.publicLease) || internal.controller.signal.aborted) continue;
      internal.controller.abort(reason);
      count += 1;
    }
    return count;
  };

  const cancelOwner = (
    owner: string,
    reason: unknown = new DOMException('Runtime workload owner cancelled.', 'AbortError'),
  ): number => {
    const normalized = normalizeOwner(owner, policy.maxOwnerLength);
    if (!normalized) return 0;
    return cancelActive((lease) => lease.owner === normalized, reason);
  };

  const snapshot = (): RuntimeWorkloadGovernorSnapshot => {
    assertActive();
    const activeByLane: Record<string, number> = {};
    const activeResources = emptyResourceCounts();
    for (const internal of active.values()) {
      activeByLane[internal.admission.lane] = (activeByLane[internal.admission.lane] ?? 0) + 1;
      for (const reservation of internal.resources) {
        if (!reservation.released) activeResources[reservation.kind] += reservation.units;
      }
    }
    const adaptive = options.control.snapshot();
    const counters: RuntimeWorkloadGovernorCounters = Object.freeze({
      acquired,
      completed,
      failed,
      cancelled,
      timedOut,
      rejected,
      resourceRejected,
    });
    for (const kind of RESOURCE_KINDS) activeResources[kind] = Math.max(0, activeResources[kind]);
    return Object.freeze({
      disposed,
      active: active.size,
      admission: adaptive.admission,
      adaptive,
      counters,
      activeByLane: Object.freeze(activeByLane),
      activeResources: Object.freeze(activeResources),
      health: journal.summary(),
      resilience: options.resilience?.snapshot() ?? null,
    });
  };

  const dispose = (reason: unknown = new RuntimeWorkloadDisposedError()): void => {
    if (disposed) return;
    disposed = true;
    cancelQueued();
    cancelActive(() => true, reason);
    if (options.disposeControl === true) options.control.dispose();
    if (options.disposeResilience === true && options.resilience) {
      options.resilience.dispose(now());
    }
    if (ownsJournal) journal.dispose();
  };

  return Object.freeze({
    acquire,
    execute,
    cancelQueued,
    cancelActive,
    cancelOwner,
    snapshot,
    dispose,
  });
};
