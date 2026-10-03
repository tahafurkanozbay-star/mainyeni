export type RuntimeDeadlinePriority = 'critical' | 'interactive' | 'background';
export type RuntimeDeadlineOutcome = 'completed' | 'expired' | 'cancelled';

export interface RuntimeDeadlinePolicy {
  readonly maxScopes: number;
  readonly maxActiveGlobal: number;
  readonly maxActivePerScope: number;
  readonly maxDeadlineMs: number;
  readonly minDeadlineMs: number;
  readonly maxClockSkewMs: number;
  readonly idleScopeTtlMs: number;
  readonly criticalReserve: number;
}

export interface RuntimeDeadlineRequest {
  readonly scope: string;
  readonly priority: RuntimeDeadlinePriority;
  readonly deadlineMs: number;
}

export interface RuntimeDeadlineLease {
  readonly id: string;
  readonly scope: string;
  readonly priority: RuntimeDeadlinePriority;
  readonly generation: number;
  readonly startedAt: number;
  readonly expiresAt: number;
}

export interface RuntimeDeadlineSnapshot {
  readonly active: number;
  readonly scopes: number;
  readonly critical: number;
  readonly interactive: number;
  readonly background: number;
  readonly completed: number;
  readonly expired: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly generation: number;
  readonly disposed: boolean;
}

interface LeaseState extends RuntimeDeadlineLease {
  expiresAt: number;
}

interface ScopeState {
  readonly leases: Map<string, LeaseState>;
  touchedAt: number;
}

const DEFAULT_POLICY: RuntimeDeadlinePolicy = Object.freeze({
  maxScopes: 128,
  maxActiveGlobal: 64,
  maxActivePerScope: 8,
  maxDeadlineMs: 120_000,
  minDeadlineMs: 25,
  maxClockSkewMs: 1_000,
  idleScopeTtlMs: 300_000,
  criticalReserve: 4,
});

const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER - 1;

function finiteInteger(value: number, name: string, minimum: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function validatePolicy(input: Partial<RuntimeDeadlinePolicy>): RuntimeDeadlinePolicy {
  const policy = { ...DEFAULT_POLICY, ...input };
  finiteInteger(policy.maxScopes, 'maxScopes', 1);
  finiteInteger(policy.maxActiveGlobal, 'maxActiveGlobal', 1);
  finiteInteger(policy.maxActivePerScope, 'maxActivePerScope', 1);
  finiteInteger(policy.maxDeadlineMs, 'maxDeadlineMs', 1);
  finiteInteger(policy.minDeadlineMs, 'minDeadlineMs', 1);
  finiteInteger(policy.maxClockSkewMs, 'maxClockSkewMs', 0);
  finiteInteger(policy.idleScopeTtlMs, 'idleScopeTtlMs', 1);
  finiteInteger(policy.criticalReserve, 'criticalReserve', 0);
  if (policy.minDeadlineMs > policy.maxDeadlineMs) {
    throw new RangeError('minDeadlineMs must not exceed maxDeadlineMs');
  }
  if (policy.maxActivePerScope > policy.maxActiveGlobal) {
    throw new RangeError('maxActivePerScope must not exceed maxActiveGlobal');
  }
  if (policy.criticalReserve >= policy.maxActiveGlobal) {
    throw new RangeError('criticalReserve must be smaller than maxActiveGlobal');
  }
  return Object.freeze(policy);
}

function validateScope(scope: string): string {
  if (!SAFE_SCOPE.test(scope)) {
    throw new TypeError('scope must be a bounded platform identifier');
  }
  return scope;
}

function validatePriority(priority: RuntimeDeadlinePriority): RuntimeDeadlinePriority {
  if (priority !== 'critical' && priority !== 'interactive' && priority !== 'background') {
    throw new TypeError('unsupported deadline priority');
  }
  return priority;
}

export class RuntimeDeadlineGovernor {
  private readonly policy: RuntimeDeadlinePolicy;
  private readonly now: () => number;
  private readonly scopes = new Map<string, ScopeState>();
  private readonly leases = new Map<string, LeaseState>();
  private sequence = 0;
  private generation = 1;
  private lastNow = 0;
  private completed = 0;
  private expired = 0;
  private cancelled = 0;
  private rejected = 0;
  private disposed = false;

  constructor(policy: Partial<RuntimeDeadlinePolicy> = {}, now: () => number = Date.now) {
    this.policy = validatePolicy(policy);
    this.now = now;
    this.lastNow = this.readClock();
  }

  acquire(request: RuntimeDeadlineRequest): RuntimeDeadlineLease | null {
    this.assertUsable();
    const scope = validateScope(request.scope);
    const priority = validatePriority(request.priority);
    finiteInteger(request.deadlineMs, 'deadlineMs', this.policy.minDeadlineMs);
    if (request.deadlineMs > this.policy.maxDeadlineMs) {
      throw new RangeError('deadlineMs exceeds policy maximum');
    }

    const now = this.tick();
    this.sweepAt(now);
    const existing = this.scopes.get(scope);
    if (!existing && !this.ensureScopeCapacity(now)) {
      this.bumpRejected();
      return null;
    }
    const state = existing ?? this.createScope(scope, now);
    if (state.leases.size >= this.policy.maxActivePerScope) {
      this.bumpRejected();
      return null;
    }
    if (!this.hasGlobalCapacity(priority)) {
      this.bumpRejected();
      return null;
    }

    const id = this.nextId(scope);
    const lease: LeaseState = {
      id,
      scope,
      priority,
      generation: this.generation,
      startedAt: now,
      expiresAt: now + request.deadlineMs,
    };
    state.leases.set(id, lease);
    state.touchedAt = now;
    this.leases.set(id, lease);
    return this.detach(lease);
  }

  renew(lease: RuntimeDeadlineLease, deadlineMs: number): RuntimeDeadlineLease | null {
    this.assertUsable();
    finiteInteger(deadlineMs, 'deadlineMs', this.policy.minDeadlineMs);
    if (deadlineMs > this.policy.maxDeadlineMs) {
      throw new RangeError('deadlineMs exceeds policy maximum');
    }
    const now = this.tick();
    this.sweepAt(now);
    const state = this.resolve(lease);
    if (!state) return null;
    state.expiresAt = now + deadlineMs;
    const scope = this.scopes.get(state.scope);
    if (scope) scope.touchedAt = now;
    return this.detach(state);
  }

  complete(lease: RuntimeDeadlineLease): boolean {
    return this.finish(lease, 'completed');
  }

  cancel(lease: RuntimeDeadlineLease): boolean {
    return this.finish(lease, 'cancelled');
  }

  isActive(lease: RuntimeDeadlineLease): boolean {
    if (this.disposed) return false;
    const now = this.tick();
    this.sweepAt(now);
    return this.resolve(lease) !== null;
  }

  remainingMs(lease: RuntimeDeadlineLease): number | null {
    if (this.disposed) return null;
    const now = this.tick();
    this.sweepAt(now);
    const state = this.resolve(lease);
    return state ? Math.max(0, state.expiresAt - now) : null;
  }

  resetScope(scopeInput: string): number {
    this.assertUsable();
    const scope = validateScope(scopeInput);
    const now = this.tick();
    this.sweepAt(now);
    const state = this.scopes.get(scope);
    if (!state) return 0;
    let removed = 0;
    for (const lease of state.leases.values()) {
      this.leases.delete(lease.id);
      removed += 1;
      this.bumpCancelled();
    }
    this.scopes.delete(scope);
    this.advanceGeneration();
    return removed;
  }

  sweep(): number {
    this.assertUsable();
    return this.sweepAt(this.tick());
  }

  snapshot(): RuntimeDeadlineSnapshot {
    let critical = 0;
    let interactive = 0;
    let background = 0;
    for (const lease of this.leases.values()) {
      if (lease.priority === 'critical') critical += 1;
      else if (lease.priority === 'interactive') interactive += 1;
      else background += 1;
    }
    return Object.freeze({
      active: this.leases.size,
      scopes: this.scopes.size,
      critical,
      interactive,
      background,
      completed: this.completed,
      expired: this.expired,
      cancelled: this.cancelled,
      rejected: this.rejected,
      generation: this.generation,
      disposed: this.disposed,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.leases.clear();
    this.scopes.clear();
    this.advanceGeneration();
    this.disposed = true;
  }

  private finish(lease: RuntimeDeadlineLease, outcome: Exclude<RuntimeDeadlineOutcome, 'expired'>): boolean {
    if (this.disposed) return false;
    const now = this.tick();
    this.sweepAt(now);
    const state = this.resolve(lease);
    if (!state) return false;
    this.remove(state, now);
    if (outcome === 'completed') this.bumpCompleted();
    else this.bumpCancelled();
    return true;
  }

  private resolve(candidate: RuntimeDeadlineLease): LeaseState | null {
    if (!candidate || candidate.generation !== this.generation) return null;
    const state = this.leases.get(candidate.id);
    if (!state) return null;
    if (
      state.scope !== candidate.scope ||
      state.priority !== candidate.priority ||
      state.startedAt !== candidate.startedAt ||
      state.expiresAt !== candidate.expiresAt
    ) return null;
    return state;
  }

  private remove(lease: LeaseState, now: number): void {
    this.leases.delete(lease.id);
    const scope = this.scopes.get(lease.scope);
    if (!scope) return;
    scope.leases.delete(lease.id);
    scope.touchedAt = now;
  }

  private sweepAt(now: number): number {
    let removed = 0;
    for (const lease of this.leases.values()) {
      if (lease.expiresAt <= now) {
        this.remove(lease, now);
        this.bumpExpired();
        removed += 1;
      }
    }
    for (const [scope, state] of this.scopes) {
      if (state.leases.size === 0 && now - state.touchedAt >= this.policy.idleScopeTtlMs) {
        this.scopes.delete(scope);
      }
    }
    return removed;
  }

  private hasGlobalCapacity(priority: RuntimeDeadlinePriority): boolean {
    if (this.leases.size >= this.policy.maxActiveGlobal) return false;
    if (priority === 'critical') return true;
    return this.leases.size < this.policy.maxActiveGlobal - this.policy.criticalReserve;
  }

  private ensureScopeCapacity(now: number): boolean {
    if (this.scopes.size < this.policy.maxScopes) return true;
    let candidate: string | null = null;
    let candidateTouched = Number.POSITIVE_INFINITY;
    for (const [scope, state] of this.scopes) {
      if (state.leases.size === 0 && state.touchedAt < candidateTouched) {
        candidate = scope;
        candidateTouched = state.touchedAt;
      }
    }
    if (candidate === null) return false;
    this.scopes.delete(candidate);
    return this.scopes.size < this.policy.maxScopes && candidateTouched <= now;
  }

  private createScope(scope: string, now: number): ScopeState {
    const state: ScopeState = { leases: new Map(), touchedAt: now };
    this.scopes.set(scope, state);
    return state;
  }

  private nextId(scope: string): string {
    this.sequence = this.sequence >= MAX_SAFE_COUNTER ? 1 : this.sequence + 1;
    return `${this.generation}:${this.sequence}:${scope}`;
  }

  private tick(): number {
    const current = this.readClock();
    if (current + this.policy.maxClockSkewMs < this.lastNow) {
      throw new Error('runtime deadline clock moved backwards beyond policy');
    }
    this.lastNow = Math.max(this.lastNow, current);
    return this.lastNow;
  }

  private readClock(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('runtime deadline clock must return a finite non-negative value');
    }
    return value;
  }

  private detach(lease: LeaseState): RuntimeDeadlineLease {
    return Object.freeze({ ...lease });
  }

  private advanceGeneration(): void {
    this.generation = this.generation >= MAX_SAFE_COUNTER ? 1 : this.generation + 1;
  }

  private bumpCompleted(): void { this.completed = this.bump(this.completed); }
  private bumpExpired(): void { this.expired = this.bump(this.expired); }
  private bumpCancelled(): void { this.cancelled = this.bump(this.cancelled); }
  private bumpRejected(): void { this.rejected = this.bump(this.rejected); }
  private bump(value: number): number { return value >= MAX_SAFE_COUNTER ? MAX_SAFE_COUNTER : value + 1; }

  private assertUsable(): void {
    if (this.disposed) throw new Error('RuntimeDeadlineGovernor is disposed');
  }
}

export function createRuntimeDeadlineGovernor(
  policy: Partial<RuntimeDeadlinePolicy> = {},
  now: () => number = Date.now,
): RuntimeDeadlineGovernor {
  return new RuntimeDeadlineGovernor(policy, now);
}
