export type DeadlineLane = 'critical' | 'interactive' | 'background';

export interface DeadlineLanePolicy {
  readonly minMs: number;
  readonly targetMs: number;
  readonly maxMs: number;
  readonly reserveMs: number;
}

export interface RuntimeDeadlineBudgetConfig {
  readonly lanes: Readonly<Record<DeadlineLane, DeadlineLanePolicy>>;
  readonly maxDepth: number;
  readonly maxHistory: number;
  readonly maxClockSkewMs: number;
}

export interface DeadlineRequest {
  readonly lane: DeadlineLane;
  readonly now: number;
  readonly parentDeadline?: number;
  readonly requestedMs?: number;
  readonly key?: string;
}

export type DeadlineRejectReason = 'invalid-time' | 'expired-parent' | 'insufficient-parent-budget' | 'duplicate-key' | 'depth-limit';

export interface DeadlineLease {
  readonly id: number;
  readonly lane: DeadlineLane;
  readonly startedAt: number;
  readonly deadline: number;
  readonly budgetMs: number;
  readonly parentDeadline?: number;
  readonly key?: string;
  readonly depth: number;
}

export type DeadlineAdmission =
  | { readonly kind: 'admitted'; readonly lease: DeadlineLease }
  | { readonly kind: 'rejected'; readonly reason: DeadlineRejectReason };

export interface DeadlineCompletion {
  readonly leaseId: number;
  readonly finishedAt: number;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly timedOut: boolean;
}

export interface DeadlineHistoryEntry {
  readonly at: number;
  readonly event: 'admit' | 'complete' | 'cancel' | 'expire' | 'reject';
  readonly lane: DeadlineLane;
  readonly leaseId?: number;
  readonly reason?: DeadlineRejectReason;
  readonly elapsedMs?: number;
}

export interface DeadlineSnapshot {
  readonly active: number;
  readonly activeByLane: Readonly<Record<DeadlineLane, number>>;
  readonly earliestDeadline: number | null;
  readonly overdue: number;
  readonly history: readonly DeadlineHistoryEntry[];
}

const LANES: readonly DeadlineLane[] = ['critical', 'interactive', 'background'];

function integer(name: string, value: number, minimum: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function finiteTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Timer-free deadline allocator for nested runtime operations.
 *
 * The allocator converts lane policy and an optional parent deadline into explicit,
 * immutable leases. It intentionally does not create timers, promises or AbortSignals:
 * callers remain responsible for transport/execution ownership and drive expiration
 * through `sweep(now)`. Parent reserve prevents a child from consuming the caller's
 * entire remaining deadline, while min/target/max bounds prevent accidental unbounded
 * waits from configuration or user-controlled duration hints.
 */
export class RuntimeDeadlineBudget {
  private readonly config: RuntimeDeadlineBudgetConfig;
  private readonly active = new Map<number, DeadlineLease>();
  private readonly keys = new Map<string, number>();
  private readonly history: DeadlineHistoryEntry[] = [];
  private nextId = 1;

  public constructor(config: RuntimeDeadlineBudgetConfig) {
    integer('maxDepth', config.maxDepth, 1);
    integer('maxHistory', config.maxHistory, 1);
    integer('maxClockSkewMs', config.maxClockSkewMs, 0);
    for (const lane of LANES) {
      const policy = config.lanes[lane];
      integer(`${lane}.minMs`, policy.minMs, 1);
      integer(`${lane}.targetMs`, policy.targetMs, 1);
      integer(`${lane}.maxMs`, policy.maxMs, 1);
      integer(`${lane}.reserveMs`, policy.reserveMs, 0);
      if (policy.minMs > policy.targetMs || policy.targetMs > policy.maxMs) {
        throw new RangeError(`${lane} deadline policy must satisfy minMs <= targetMs <= maxMs`);
      }
    }
    this.config = Object.freeze({
      ...config,
      lanes: Object.freeze({
        critical: Object.freeze({ ...config.lanes.critical }),
        interactive: Object.freeze({ ...config.lanes.interactive }),
        background: Object.freeze({ ...config.lanes.background }),
      }),
    });
  }

  public admit(request: DeadlineRequest, depth = 1): DeadlineAdmission {
    if (!finiteTime(request.now)) return this.reject(request.lane, 0, 'invalid-time');
    if (!Number.isInteger(depth) || depth < 1 || depth > this.config.maxDepth) {
      return this.reject(request.lane, request.now, 'depth-limit');
    }
    if (request.key && this.keys.has(request.key)) return this.reject(request.lane, request.now, 'duplicate-key');

    const policy = this.config.lanes[request.lane];
    const requested = request.requestedMs ?? policy.targetMs;
    if (!Number.isFinite(requested) || requested <= 0) return this.reject(request.lane, request.now, 'invalid-time');
    let budgetMs = Math.min(policy.maxMs, Math.max(policy.minMs, Math.floor(requested)));

    if (request.parentDeadline !== undefined) {
      if (!finiteTime(request.parentDeadline)) return this.reject(request.lane, request.now, 'invalid-time');
      const parentRemaining = request.parentDeadline - request.now;
      if (parentRemaining <= 0) return this.reject(request.lane, request.now, 'expired-parent');
      const available = Math.floor(parentRemaining - policy.reserveMs);
      if (available < policy.minMs) return this.reject(request.lane, request.now, 'insufficient-parent-budget');
      budgetMs = Math.min(budgetMs, available);
    }

    const lease: DeadlineLease = Object.freeze({
      id: this.nextId++,
      lane: request.lane,
      startedAt: request.now,
      deadline: request.now + budgetMs,
      budgetMs,
      ...(request.parentDeadline !== undefined ? { parentDeadline: request.parentDeadline } : {}),
      ...(request.key ? { key: request.key } : {}),
      depth,
    });
    this.active.set(lease.id, lease);
    if (lease.key) this.keys.set(lease.key, lease.id);
    this.record({ at: request.now, event: 'admit', lane: lease.lane, leaseId: lease.id });
    return { kind: 'admitted', lease };
  }

  public child(parentLeaseId: number, request: Omit<DeadlineRequest, 'parentDeadline'>): DeadlineAdmission {
    const parent = this.active.get(parentLeaseId);
    if (!parent) return this.reject(request.lane, finiteTime(request.now) ? request.now : 0, 'expired-parent');
    return this.admit({ ...request, parentDeadline: parent.deadline }, parent.depth + 1);
  }

  public complete(leaseId: number, finishedAt: number): DeadlineCompletion | null {
    const lease = this.active.get(leaseId);
    if (!lease || !finiteTime(finishedAt)) return null;
    if (finishedAt + this.config.maxClockSkewMs < lease.startedAt) return null;
    this.releaseKey(lease);
    this.active.delete(leaseId);
    const elapsedMs = Math.max(0, finishedAt - lease.startedAt);
    const remainingMs = Math.max(0, lease.deadline - finishedAt);
    const completion = Object.freeze({ leaseId, finishedAt, elapsedMs, remainingMs, timedOut: finishedAt > lease.deadline });
    this.record({ at: finishedAt, event: 'complete', lane: lease.lane, leaseId, elapsedMs });
    return completion;
  }

  public cancel(leaseId: number, now: number): boolean {
    const lease = this.active.get(leaseId);
    if (!lease || !finiteTime(now)) return false;
    this.active.delete(leaseId);
    this.releaseKey(lease);
    this.record({ at: now, event: 'cancel', lane: lease.lane, leaseId });
    return true;
  }

  public sweep(now: number): readonly DeadlineLease[] {
    if (!finiteTime(now)) return Object.freeze([]);
    const expired: DeadlineLease[] = [];
    for (const lease of this.active.values()) {
      if (now <= lease.deadline) continue;
      this.active.delete(lease.id);
      this.releaseKey(lease);
      expired.push(lease);
      this.record({ at: now, event: 'expire', lane: lease.lane, leaseId: lease.id });
    }
    expired.sort((a, b) => a.deadline - b.deadline || a.id - b.id);
    return Object.freeze(expired);
  }

  public remaining(leaseId: number, now: number): number | null {
    const lease = this.active.get(leaseId);
    if (!lease || !finiteTime(now)) return null;
    return Math.max(0, lease.deadline - now);
  }

  public snapshot(now: number): DeadlineSnapshot {
    const counts: Record<DeadlineLane, number> = { critical: 0, interactive: 0, background: 0 };
    let earliest = Number.POSITIVE_INFINITY;
    let overdue = 0;
    for (const lease of this.active.values()) {
      counts[lease.lane] += 1;
      earliest = Math.min(earliest, lease.deadline);
      if (finiteTime(now) && now > lease.deadline) overdue += 1;
    }
    return Object.freeze({
      active: this.active.size,
      activeByLane: Object.freeze(counts),
      earliestDeadline: Number.isFinite(earliest) ? earliest : null,
      overdue,
      history: Object.freeze(this.history.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  public reset(now: number): void {
    for (const lease of this.active.values()) {
      this.record({ at: finiteTime(now) ? now : lease.startedAt, event: 'cancel', lane: lease.lane, leaseId: lease.id });
    }
    this.active.clear();
    this.keys.clear();
  }

  private releaseKey(lease: DeadlineLease): void {
    if (lease.key) this.keys.delete(lease.key);
  }

  private reject(lane: DeadlineLane, at: number, reason: DeadlineRejectReason): DeadlineAdmission {
    this.record({ at, event: 'reject', lane, reason });
    return { kind: 'rejected', reason };
  }

  private record(entry: DeadlineHistoryEntry): void {
    this.history.push(Object.freeze({ ...entry }));
    const overflow = this.history.length - this.config.maxHistory;
    if (overflow > 0) this.history.splice(0, overflow);
  }
}
