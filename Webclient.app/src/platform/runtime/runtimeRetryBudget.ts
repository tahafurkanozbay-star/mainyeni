export type RetryLane = 'critical' | 'interactive' | 'background';

export interface RetryLanePolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly jitterRatio: number;
}

export interface RuntimeRetryBudgetConfig {
  readonly lanes: Readonly<Record<RetryLane, RetryLanePolicy>>;
  readonly maxActive: number;
  readonly maxHistory: number;
  readonly maxRetryAfterMs: number;
}

export interface RetryRequest {
  readonly lane: RetryLane;
  readonly now: number;
  readonly key?: string;
  readonly deadline?: number;
}

export type RetryRejectReason = 'invalid-time' | 'capacity' | 'duplicate-key' | 'deadline-expired';
export type RetryDecisionReason = 'attempt-limit' | 'deadline-budget' | 'retry-after-budget';

export interface RetryLease {
  readonly id: number;
  readonly lane: RetryLane;
  readonly startedAt: number;
  readonly key?: string;
  readonly deadline?: number;
}

export type RetryAdmission =
  | { readonly kind: 'admitted'; readonly lease: RetryLease }
  | { readonly kind: 'rejected'; readonly reason: RetryRejectReason };

export type RetryDecision =
  | { readonly kind: 'retry'; readonly attempt: number; readonly delayMs: number; readonly scheduledAt: number }
  | { readonly kind: 'stop'; readonly reason: RetryDecisionReason };

export interface RetryHistoryEntry {
  readonly at: number;
  readonly event: 'admit' | 'retry' | 'complete' | 'cancel' | 'reject' | 'stop';
  readonly lane: RetryLane;
  readonly leaseId?: number;
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly reason?: RetryRejectReason | RetryDecisionReason;
}

export interface RetrySnapshot {
  readonly active: number;
  readonly activeByLane: Readonly<Record<RetryLane, number>>;
  readonly attempts: number;
  readonly history: readonly RetryHistoryEntry[];
}

type ActiveRetry = { readonly lease: RetryLease; attempts: number };
const LANES: readonly RetryLane[] = ['critical', 'interactive', 'background'];

function integer(name: string, value: number, minimum: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}`);
  return value;
}

function finiteTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Timer/network-free retry budget. Callers own execution and scheduling; this class
 * only decides whether another attempt is allowed and computes a bounded delay.
 * Deterministic jitter is derived from lease/attempt identity so tests and diagnostics
 * remain reproducible without Math.random or hidden global state.
 */
export class RuntimeRetryBudget {
  private readonly config: RuntimeRetryBudgetConfig;
  private readonly active = new Map<number, ActiveRetry>();
  private readonly keys = new Map<string, number>();
  private readonly history: RetryHistoryEntry[] = [];
  private nextId = 1;

  public constructor(config: RuntimeRetryBudgetConfig) {
    integer('maxActive', config.maxActive, 1);
    integer('maxHistory', config.maxHistory, 1);
    integer('maxRetryAfterMs', config.maxRetryAfterMs, 0);
    for (const lane of LANES) {
      const policy = config.lanes[lane];
      integer(`${lane}.maxAttempts`, policy.maxAttempts, 1);
      integer(`${lane}.baseDelayMs`, policy.baseDelayMs, 0);
      integer(`${lane}.maxDelayMs`, policy.maxDelayMs, policy.baseDelayMs);
      if (!Number.isFinite(policy.multiplier) || policy.multiplier < 1) throw new RangeError(`${lane}.multiplier must be >= 1`);
      if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) throw new RangeError(`${lane}.jitterRatio must be between 0 and 1`);
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

  public admit(request: RetryRequest): RetryAdmission {
    if (!finiteTime(request.now)) return this.reject(request.lane, 0, 'invalid-time');
    if (request.deadline !== undefined && (!finiteTime(request.deadline) || request.deadline <= request.now)) {
      return this.reject(request.lane, request.now, 'deadline-expired');
    }
    if (request.key && this.keys.has(request.key)) return this.reject(request.lane, request.now, 'duplicate-key');
    if (this.active.size >= this.config.maxActive) return this.reject(request.lane, request.now, 'capacity');
    const lease: RetryLease = Object.freeze({
      id: this.nextId++, lane: request.lane, startedAt: request.now,
      ...(request.key ? { key: request.key } : {}),
      ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
    });
    this.active.set(lease.id, { lease, attempts: 0 });
    if (lease.key) this.keys.set(lease.key, lease.id);
    this.record({ at: request.now, event: 'admit', lane: lease.lane, leaseId: lease.id });
    return { kind: 'admitted', lease };
  }

  public next(leaseId: number, now: number, retryAfterMs?: number): RetryDecision | null {
    const state = this.active.get(leaseId);
    if (!state || !finiteTime(now)) return null;
    const policy = this.config.lanes[state.lease.lane];
    const attempt = state.attempts + 1;
    if (attempt >= policy.maxAttempts) return this.stop(state, now, 'attempt-limit');
    let delayMs: number;
    if (retryAfterMs !== undefined) {
      if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > this.config.maxRetryAfterMs) {
        return this.stop(state, now, 'retry-after-budget');
      }
      delayMs = Math.floor(retryAfterMs);
    } else {
      const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.multiplier ** Math.max(0, attempt - 1));
      delayMs = Math.floor(exponential * this.jitterFactor(leaseId, attempt, policy.jitterRatio));
    }
    const scheduledAt = now + delayMs;
    if (!Number.isSafeInteger(scheduledAt) || (state.lease.deadline !== undefined && scheduledAt >= state.lease.deadline)) {
      return this.stop(state, now, 'deadline-budget');
    }
    state.attempts = attempt;
    this.record({ at: now, event: 'retry', lane: state.lease.lane, leaseId, attempt, delayMs });
    return Object.freeze({ kind: 'retry', attempt, delayMs, scheduledAt });
  }

  public complete(leaseId: number, now: number): boolean { return this.release(leaseId, now, 'complete'); }
  public cancel(leaseId: number, now: number): boolean { return this.release(leaseId, now, 'cancel'); }

  public snapshot(): RetrySnapshot {
    const counts: Record<RetryLane, number> = { critical: 0, interactive: 0, background: 0 };
    let attempts = 0;
    for (const state of this.active.values()) { counts[state.lease.lane] += 1; attempts += state.attempts; }
    return Object.freeze({ active: this.active.size, activeByLane: Object.freeze(counts), attempts, history: Object.freeze(this.history.map((e) => Object.freeze({ ...e }))) });
  }

  public reset(now: number): void {
    const at = finiteTime(now) ? now : 0;
    for (const state of this.active.values()) this.record({ at, event: 'cancel', lane: state.lease.lane, leaseId: state.lease.id });
    this.active.clear(); this.keys.clear();
  }

  private stop(state: ActiveRetry, now: number, reason: RetryDecisionReason): RetryDecision {
    this.record({ at: now, event: 'stop', lane: state.lease.lane, leaseId: state.lease.id, attempt: state.attempts + 1, reason });
    return Object.freeze({ kind: 'stop', reason });
  }

  private release(leaseId: number, now: number, event: 'complete' | 'cancel'): boolean {
    const state = this.active.get(leaseId);
    if (!state || !finiteTime(now)) return false;
    this.active.delete(leaseId);
    if (state.lease.key) this.keys.delete(state.lease.key);
    this.record({ at: now, event, lane: state.lease.lane, leaseId });
    return true;
  }

  private reject(lane: RetryLane, at: number, reason: RetryRejectReason): RetryAdmission {
    this.record({ at, event: 'reject', lane, reason }); return { kind: 'rejected', reason };
  }

  private jitterFactor(leaseId: number, attempt: number, ratio: number): number {
    if (ratio === 0) return 1;
    let value = (leaseId * 1103515245 + attempt * 12345) >>> 0;
    value ^= value >>> 16;
    const unit = (value >>> 0) / 0xffffffff;
    return 1 - ratio + unit * ratio * 2;
  }

  private record(entry: RetryHistoryEntry): void {
    this.history.push(Object.freeze({ ...entry }));
    const overflow = this.history.length - this.config.maxHistory;
    if (overflow > 0) this.history.splice(0, overflow);
  }
}
