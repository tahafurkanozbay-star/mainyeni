export type WorkBudgetPriority = 'critical' | 'high' | 'normal' | 'background';
export type WorkBudgetDecision = 'admitted' | 'queued' | 'rejected';

export interface WorkBudgetRequest {
  readonly key: string;
  readonly scope?: string;
  readonly priority?: WorkBudgetPriority;
  readonly units?: number;
  readonly bytes?: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface WorkBudgetPolicy {
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly maxUnits: number;
  readonly maxBytes: number;
  readonly maxQueueAgeMs: number;
  readonly maxLeaseAgeMs: number;
  readonly maxScopes: number;
  readonly maxKeys: number;
  readonly scopeMaxActive?: Readonly<Record<string, number>>;
  readonly scopeMaxUnits?: Readonly<Record<string, number>>;
  readonly scopeMaxBytes?: Readonly<Record<string, number>>;
}

export interface WorkBudgetLease {
  readonly id: string;
  readonly key: string;
  readonly scope: string;
  readonly units: number;
  readonly bytes: number;
  readonly priority: WorkBudgetPriority;
  readonly acquiredAt: number;
  readonly release: () => void;
  readonly renew: () => boolean;
}

export interface WorkBudgetSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly activeUnits: number;
  readonly activeBytes: number;
  readonly admitted: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly expiredQueued: number;
  readonly expiredLeases: number;
  readonly scopes: Readonly<Record<string, Readonly<{
    active: number;
    queued: number;
    units: number;
    bytes: number;
  }>>>;
}

export class WorkBudgetRejectedError extends Error {
  readonly code = 'PLATFORM_WORK_BUDGET_REJECTED';
  constructor(message = 'Runtime work budget is exhausted.') {
    super(message);
    this.name = 'WorkBudgetRejectedError';
  }
}

export class WorkBudgetCancelledError extends Error {
  readonly code = 'PLATFORM_WORK_BUDGET_CANCELLED';
  constructor(message = 'Runtime work request was cancelled.') {
    super(message);
    this.name = 'AbortError';
  }
}

interface NormalizedRequest {
  readonly key: string;
  readonly scope: string;
  readonly priority: WorkBudgetPriority;
  readonly units: number;
  readonly bytes: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

interface QueueEntry {
  readonly id: string;
  readonly request: NormalizedRequest;
  readonly enqueuedAt: number;
  readonly sequence: number;
  readonly resolve: (lease: WorkBudgetLease) => void;
  readonly reject: (reason: unknown) => void;
  cleanup?: () => void;
}

interface ActiveEntry {
  readonly id: string;
  readonly request: NormalizedRequest;
  readonly acquiredAt: number;
  expiresAt: number;
  released: boolean;
}

const priorityRank: Readonly<Record<WorkBudgetPriority, number>> = Object.freeze({
  critical: 0,
  high: 1,
  normal: 2,
  background: 3,
});

const boundedPositive = (value: number, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
};

const normalizeIdentifier = (value: string, fallback: string): string => {
  const normalized = value.trim().slice(0, 128);
  return normalized || fallback;
};

export const createWorkBudgetCoordinator = (
  input: WorkBudgetPolicy,
  now: () => number = Date.now,
) => {
  const policy = Object.freeze({
    maxActive: boundedPositive(input.maxActive, 8, 10_000),
    maxQueued: boundedPositive(input.maxQueued, 64, 100_000),
    maxUnits: boundedPositive(input.maxUnits, 64),
    maxBytes: boundedPositive(input.maxBytes, 64 * 1024 * 1024),
    maxQueueAgeMs: boundedPositive(input.maxQueueAgeMs, 30_000),
    maxLeaseAgeMs: boundedPositive(input.maxLeaseAgeMs, 60_000),
    maxScopes: boundedPositive(input.maxScopes, 128, 10_000),
    maxKeys: boundedPositive(input.maxKeys, 4096, 100_000),
    scopeMaxActive: Object.freeze({ ...input.scopeMaxActive }),
    scopeMaxUnits: Object.freeze({ ...input.scopeMaxUnits }),
    scopeMaxBytes: Object.freeze({ ...input.scopeMaxBytes }),
  });

  const queue: QueueEntry[] = [];
  const active = new Map<string, ActiveEntry>();
  const knownScopes = new Set<string>();
  const knownKeys = new Set<string>();
  let sequence = 0;
  let admitted = 0;
  let completed = 0;
  let cancelled = 0;
  let rejected = 0;
  let expiredQueued = 0;
  let expiredLeases = 0;
  let disposed = false;

  const nextId = (): string => {
    sequence += 1;
    return `work-budget-${sequence.toString(36)}`;
  };

  const normalize = (request: WorkBudgetRequest): NormalizedRequest => ({
    key: normalizeIdentifier(request.key, ''),
    scope: normalizeIdentifier(request.scope ?? 'default', 'default'),
    priority: request.priority ?? 'normal',
    units: boundedPositive(request.units ?? 1, 1, policy.maxUnits),
    bytes: boundedPositive(request.bytes ?? 1, 1, policy.maxBytes),
    ...(request.deadlineMs !== undefined && Number.isFinite(request.deadlineMs)
      ? { deadlineMs: Math.floor(request.deadlineMs) }
      : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  const activeTotals = (): { units: number; bytes: number } => {
    let units = 0;
    let bytes = 0;
    for (const entry of active.values()) {
      units += entry.request.units;
      bytes += entry.request.bytes;
    }
    return { units, bytes };
  };

  const scopeTotals = (scope: string): { active: number; units: number; bytes: number } => {
    let count = 0;
    let units = 0;
    let bytes = 0;
    for (const entry of active.values()) {
      if (entry.request.scope !== scope) continue;
      count += 1;
      units += entry.request.units;
      bytes += entry.request.bytes;
    }
    return { active: count, units, bytes };
  };

  const canAdmit = (request: NormalizedRequest): boolean => {
    if (active.size >= policy.maxActive) return false;
    const totals = activeTotals();
    if (totals.units + request.units > policy.maxUnits) return false;
    if (totals.bytes + request.bytes > policy.maxBytes) return false;
    const scoped = scopeTotals(request.scope);
    const maxActive = policy.scopeMaxActive[request.scope];
    const maxUnits = policy.scopeMaxUnits[request.scope];
    const maxBytes = policy.scopeMaxBytes[request.scope];
    if (maxActive !== undefined && scoped.active >= Math.max(0, Math.floor(maxActive))) return false;
    if (maxUnits !== undefined && scoped.units + request.units > Math.max(0, Math.floor(maxUnits))) return false;
    if (maxBytes !== undefined && scoped.bytes + request.bytes > Math.max(0, Math.floor(maxBytes))) return false;
    return true;
  };

  const removeQueued = (entry: QueueEntry): boolean => {
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    entry.cleanup?.();
    return true;
  };

  const rejectEntry = (entry: QueueEntry, error: Error): void => {
    if (!removeQueued(entry)) return;
    rejected += 1;
    entry.reject(error);
  };

  const expire = (): void => {
    const timestamp = now();
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index];
      if (!entry) continue;
      const deadlineExpired = entry.request.deadlineMs !== undefined && timestamp > entry.request.deadlineMs;
      const ageExpired = timestamp - entry.enqueuedAt > policy.maxQueueAgeMs;
      if (!deadlineExpired && !ageExpired) continue;
      if (!removeQueued(entry)) continue;
      expiredQueued += 1;
      entry.reject(new WorkBudgetRejectedError('Runtime work request expired while queued.'));
    }
    for (const entry of active.values()) {
      if (timestamp <= entry.expiresAt) continue;
      if (!active.delete(entry.id)) continue;
      entry.released = true;
      expiredLeases += 1;
    }
  };

  const createLease = (entry: QueueEntry): WorkBudgetLease => {
    const acquiredAt = now();
    const state: ActiveEntry = {
      id: entry.id,
      request: entry.request,
      acquiredAt,
      expiresAt: acquiredAt + policy.maxLeaseAgeMs,
      released: false,
    };
    active.set(entry.id, state);
    admitted += 1;
    return Object.freeze({
      id: entry.id,
      key: entry.request.key,
      scope: entry.request.scope,
      units: entry.request.units,
      bytes: entry.request.bytes,
      priority: entry.request.priority,
      acquiredAt,
      release: () => {
        if (state.released) return;
        state.released = true;
        if (active.delete(state.id)) completed += 1;
        pump();
      },
      renew: () => {
        if (state.released || !active.has(state.id) || disposed) return false;
        state.expiresAt = now() + policy.maxLeaseAgeMs;
        return true;
      },
    });
  };

  function pump(): void {
    if (disposed) return;
    expire();
    queue.sort((left, right) =>
      priorityRank[left.request.priority] - priorityRank[right.request.priority]
      || left.sequence - right.sequence);
    let candidate = queue.find((entry) => canAdmit(entry.request));
    while (candidate) {
      removeQueued(candidate);
      candidate.resolve(createLease(candidate));
      candidate = queue.find((entry) => canAdmit(entry.request));
    }
  }

  const admitIdentity = (request: NormalizedRequest): boolean => {
    if (!knownScopes.has(request.scope) && knownScopes.size >= policy.maxScopes) return false;
    if (!knownKeys.has(request.key) && knownKeys.size >= policy.maxKeys) return false;
    knownScopes.add(request.scope);
    knownKeys.add(request.key);
    return true;
  };

  const acquire = (request: WorkBudgetRequest): Promise<WorkBudgetLease> => {
    if (disposed) return Promise.reject(new WorkBudgetRejectedError('Work budget coordinator is disposed.'));
    const normalized = normalize(request);
    if (!normalized.key) return Promise.reject(new WorkBudgetRejectedError('Work budget key is required.'));
    if (normalized.signal?.aborted) {
      cancelled += 1;
      return Promise.reject(normalized.signal.reason instanceof Error
        ? normalized.signal.reason
        : new WorkBudgetCancelledError());
    }
    if (!admitIdentity(normalized)) {
      rejected += 1;
      return Promise.reject(new WorkBudgetRejectedError('Work budget identity cardinality exceeded.'));
    }
    if (queue.length >= policy.maxQueued) {
      rejected += 1;
      return Promise.reject(new WorkBudgetRejectedError());
    }
    const id = nextId();
    return new Promise<WorkBudgetLease>((resolve, reject) => {
      const entry: QueueEntry = {
        id,
        request: normalized,
        enqueuedAt: now(),
        sequence,
        resolve,
        reject,
      };
      if (normalized.signal) {
        const onAbort = (): void => {
          if (!removeQueued(entry)) return;
          cancelled += 1;
          reject(normalized.signal?.reason instanceof Error
            ? normalized.signal.reason
            : new WorkBudgetCancelledError());
        };
        normalized.signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => normalized.signal?.removeEventListener('abort', onAbort);
      }
      queue.push(entry);
      pump();
    });
  };

  const cancelQueued = (predicate: (request: Readonly<WorkBudgetRequest>) => boolean = () => true): number => {
    let count = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index];
      if (!entry || !predicate(entry.request)) continue;
      if (!removeQueued(entry)) continue;
      cancelled += 1;
      count += 1;
      entry.reject(new WorkBudgetCancelledError());
    }
    return count;
  };

  const releaseScope = (scope: string): number => {
    const normalized = normalizeIdentifier(scope, 'default');
    let count = 0;
    for (const entry of active.values()) {
      if (entry.request.scope !== normalized || entry.released) continue;
      entry.released = true;
      if (active.delete(entry.id)) {
        completed += 1;
        count += 1;
      }
    }
    if (count > 0) pump();
    return count;
  };

  const sweep = (): void => {
    expire();
    pump();
  };

  const snapshot = (): WorkBudgetSnapshot => {
    expire();
    const scopes: Record<string, { active: number; queued: number; units: number; bytes: number }> = {};
    const ensure = (scope: string) => {
      scopes[scope] ??= { active: 0, queued: 0, units: 0, bytes: 0 };
      return scopes[scope];
    };
    for (const entry of active.values()) {
      const target = ensure(entry.request.scope);
      target.active += 1;
      target.units += entry.request.units;
      target.bytes += entry.request.bytes;
    }
    for (const entry of queue) ensure(entry.request.scope).queued += 1;
    const totals = activeTotals();
    return Object.freeze({
      active: active.size,
      queued: queue.length,
      activeUnits: totals.units,
      activeBytes: totals.bytes,
      admitted,
      completed,
      cancelled,
      rejected,
      expiredQueued,
      expiredLeases,
      scopes: Object.freeze(Object.fromEntries(
        Object.entries(scopes).map(([key, value]) => [key, Object.freeze({ ...value })]),
      )),
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    while (queue.length > 0) {
      const entry = queue[queue.length - 1];
      if (!entry) break;
      rejectEntry(entry, new WorkBudgetCancelledError('Work budget coordinator disposed.'));
    }
    for (const entry of active.values()) entry.released = true;
    active.clear();
    knownScopes.clear();
    knownKeys.clear();
  };

  return Object.freeze({ acquire, cancelQueued, releaseScope, sweep, snapshot, dispose });
};
