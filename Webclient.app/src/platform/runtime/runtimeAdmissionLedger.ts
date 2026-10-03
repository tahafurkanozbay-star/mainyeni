export type RuntimeAdmissionLane = 'background' | 'interactive' | 'critical';
export type RuntimeAdmissionOutcome = 'success' | 'failure' | 'timeout' | 'cancelled';
export type RuntimeAdmissionReason =
  | 'admitted'
  | 'scope-capacity'
  | 'global-capacity'
  | 'lane-capacity'
  | 'cooldown'
  | 'duplicate'
  | 'invalid'
  | 'disposed';

export interface RuntimeAdmissionPolicy {
  maxScopes: number;
  maxActiveGlobal: number;
  maxActivePerScope: number;
  maxActiveBackground: number;
  maxActiveInteractive: number;
  maxActiveCritical: number;
  maxLeaseAgeMs: number;
  maxIdleScopeAgeMs: number;
  maxIdentifierLength: number;
  failureWindowMs: number;
  maxFailuresInWindow: number;
  cooldownMs: number;
  criticalBypassesCooldown: boolean;
}

export interface RuntimeAdmissionRequest {
  readonly scope: string;
  readonly key: string;
  readonly lane?: RuntimeAdmissionLane;
}

export interface RuntimeAdmissionLease {
  readonly scope: string;
  readonly key: string;
  readonly lane: RuntimeAdmissionLane;
  readonly generation: number;
  readonly admittedAt: number;
  readonly expiresAt: number;
}

export interface RuntimeAdmissionDecision {
  readonly accepted: boolean;
  readonly reason: RuntimeAdmissionReason;
  readonly lease: RuntimeAdmissionLease | null;
}

export interface RuntimeAdmissionScopeSnapshot {
  readonly scope: string;
  readonly generation: number;
  readonly active: number;
  readonly background: number;
  readonly interactive: number;
  readonly critical: number;
  readonly failuresInWindow: number;
  readonly cooldownUntil: number;
  readonly lastTouchedAt: number;
}

export interface RuntimeAdmissionSnapshot {
  readonly disposed: boolean;
  readonly scopeCount: number;
  readonly active: number;
  readonly background: number;
  readonly interactive: number;
  readonly critical: number;
  readonly scopes: readonly RuntimeAdmissionScopeSnapshot[];
}

interface ActiveLease extends RuntimeAdmissionLease {
  readonly token: number;
}

interface ScopeState {
  readonly scope: string;
  readonly generation: number;
  readonly leases: Map<string, ActiveLease>;
  failures: number[];
  cooldownUntil: number;
  lastTouchedAt: number;
}

const DEFAULT_POLICY: RuntimeAdmissionPolicy = {
  maxScopes: 64,
  maxActiveGlobal: 128,
  maxActivePerScope: 16,
  maxActiveBackground: 32,
  maxActiveInteractive: 96,
  maxActiveCritical: 32,
  maxLeaseAgeMs: 30_000,
  maxIdleScopeAgeMs: 120_000,
  maxIdentifierLength: 96,
  failureWindowMs: 30_000,
  maxFailuresInWindow: 5,
  cooldownMs: 10_000,
  criticalBypassesCooldown: true,
};

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function safeClock(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeIdentifier(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > maxLength) return null;
  return /^[a-z0-9][a-z0-9._:/-]*$/.test(normalized) ? normalized : null;
}

function normalizeLane(value: unknown): RuntimeAdmissionLane {
  if (value === 'background' || value === 'critical') return value;
  return 'interactive';
}

function decision(
  accepted: boolean,
  reason: RuntimeAdmissionReason,
  lease: RuntimeAdmissionLease | null = null,
): RuntimeAdmissionDecision {
  return Object.freeze({ accepted, reason, lease });
}

function publicLease(lease: ActiveLease): RuntimeAdmissionLease {
  return Object.freeze({
    scope: lease.scope,
    key: lease.key,
    lane: lease.lane,
    generation: lease.generation,
    admittedAt: lease.admittedAt,
    expiresAt: lease.expiresAt,
  });
}

/**
 * Payload-free admission authority for runtime work.
 *
 * The ledger deliberately owns only normalized identifiers, scalar timestamps and
 * counters. It never retains callbacks, promises, request payloads, URLs,
 * credentials, AbortControllers, DOM nodes, SDK objects or error instances.
 */
export class RuntimeAdmissionLedger {
  readonly policy: Readonly<RuntimeAdmissionPolicy>;

  private readonly now: () => number;
  private readonly scopes = new Map<string, ScopeState>();
  private readonly generations = new Map<string, number>();
  private nextToken = 1;
  private disposed = false;

  constructor(options: {
    policy?: Partial<RuntimeAdmissionPolicy>;
    now?: () => number;
  } = {}) {
    const supplied = options.policy ?? {};
    const maxActiveGlobal = positiveInteger(
      supplied.maxActiveGlobal,
      DEFAULT_POLICY.maxActiveGlobal,
    );

    this.policy = Object.freeze({
      maxScopes: positiveInteger(supplied.maxScopes, DEFAULT_POLICY.maxScopes),
      maxActiveGlobal,
      maxActivePerScope: Math.min(
        maxActiveGlobal,
        positiveInteger(supplied.maxActivePerScope, DEFAULT_POLICY.maxActivePerScope),
      ),
      maxActiveBackground: Math.min(
        maxActiveGlobal,
        positiveInteger(supplied.maxActiveBackground, DEFAULT_POLICY.maxActiveBackground),
      ),
      maxActiveInteractive: Math.min(
        maxActiveGlobal,
        positiveInteger(supplied.maxActiveInteractive, DEFAULT_POLICY.maxActiveInteractive),
      ),
      maxActiveCritical: Math.min(
        maxActiveGlobal,
        positiveInteger(supplied.maxActiveCritical, DEFAULT_POLICY.maxActiveCritical),
      ),
      maxLeaseAgeMs: positiveInteger(supplied.maxLeaseAgeMs, DEFAULT_POLICY.maxLeaseAgeMs),
      maxIdleScopeAgeMs: positiveInteger(
        supplied.maxIdleScopeAgeMs,
        DEFAULT_POLICY.maxIdleScopeAgeMs,
      ),
      maxIdentifierLength: positiveInteger(
        supplied.maxIdentifierLength,
        DEFAULT_POLICY.maxIdentifierLength,
      ),
      failureWindowMs: positiveInteger(
        supplied.failureWindowMs,
        DEFAULT_POLICY.failureWindowMs,
      ),
      maxFailuresInWindow: positiveInteger(
        supplied.maxFailuresInWindow,
        DEFAULT_POLICY.maxFailuresInWindow,
      ),
      cooldownMs: positiveInteger(supplied.cooldownMs, DEFAULT_POLICY.cooldownMs),
      criticalBypassesCooldown:
        supplied.criticalBypassesCooldown ?? DEFAULT_POLICY.criticalBypassesCooldown,
    });
    this.now = options.now ?? Date.now;
  }

  admit(request: RuntimeAdmissionRequest): RuntimeAdmissionDecision {
    if (this.disposed) return decision(false, 'disposed');
    const now = this.readNow();
    this.sweep(now);

    const scope = normalizeIdentifier(request.scope, this.policy.maxIdentifierLength);
    const key = normalizeIdentifier(request.key, this.policy.maxIdentifierLength);
    if (!scope || !key) return decision(false, 'invalid');

    const lane = normalizeLane(request.lane);
    let state = this.scopes.get(scope);
    if (!state) {
      if (!this.ensureScopeCapacity(now)) return decision(false, 'scope-capacity');
      state = this.createScope(scope, now);
    }

    this.pruneFailures(state, now);
    if (state.leases.has(key)) return decision(false, 'duplicate');
    if (
      state.cooldownUntil > now &&
      !(lane === 'critical' && this.policy.criticalBypassesCooldown)
    ) {
      return decision(false, 'cooldown');
    }
    if (state.leases.size >= this.policy.maxActivePerScope) {
      return decision(false, 'scope-capacity');
    }

    const totals = this.totals();
    if (totals.active >= this.policy.maxActiveGlobal) {
      return decision(false, 'global-capacity');
    }
    if (!this.hasLaneCapacity(lane, totals)) {
      return decision(false, 'lane-capacity');
    }

    const active: ActiveLease = Object.freeze({
      scope,
      key,
      lane,
      generation: state.generation,
      admittedAt: now,
      expiresAt: now + this.policy.maxLeaseAgeMs,
      token: this.nextToken++,
    });
    state.leases.set(key, active);
    state.lastTouchedAt = now;
    return decision(true, 'admitted', publicLease(active));
  }

  settle(lease: RuntimeAdmissionLease, outcome: RuntimeAdmissionOutcome): boolean {
    if (this.disposed) return false;
    const now = this.readNow();
    const active = this.resolve(lease, now);
    if (!active) return false;
    const state = this.scopes.get(active.scope);
    if (!state) return false;

    state.leases.delete(active.key);
    state.lastTouchedAt = now;
    if (outcome === 'failure' || outcome === 'timeout') {
      this.recordFailure(state, now);
    } else if (outcome === 'success') {
      this.pruneFailures(state, now);
    }
    return true;
  }

  renew(lease: RuntimeAdmissionLease): RuntimeAdmissionLease | null {
    if (this.disposed) return null;
    const now = this.readNow();
    const active = this.resolve(lease, now);
    if (!active) return null;
    const state = this.scopes.get(active.scope);
    if (!state) return null;

    const renewed: ActiveLease = Object.freeze({
      ...active,
      admittedAt: now,
      expiresAt: now + this.policy.maxLeaseAgeMs,
      token: this.nextToken++,
    });
    state.leases.set(active.key, renewed);
    state.lastTouchedAt = now;
    return publicLease(renewed);
  }

  sweep(at = this.readNow()): number {
    if (this.disposed) return 0;
    const now = safeClock(at);
    let removed = 0;

    for (const state of this.scopes.values()) {
      for (const [key, lease] of state.leases) {
        if (lease.expiresAt <= now) {
          state.leases.delete(key);
          removed += 1;
        }
      }
      this.pruneFailures(state, now);
      if (state.cooldownUntil <= now) state.cooldownUntil = 0;
    }

    for (const [scope, state] of this.scopes) {
      if (
        state.leases.size === 0 &&
        state.failures.length === 0 &&
        state.cooldownUntil === 0 &&
        now - state.lastTouchedAt >= this.policy.maxIdleScopeAgeMs
      ) {
        this.scopes.delete(scope);
        removed += 1;
      }
    }
    return removed;
  }

  resetScope(rawScope: string): boolean {
    if (this.disposed) return false;
    const scope = normalizeIdentifier(rawScope, this.policy.maxIdentifierLength);
    if (!scope || !this.scopes.has(scope)) return false;
    this.scopes.delete(scope);
    this.createScope(scope, this.readNow());
    return true;
  }

  retireScope(rawScope: string): boolean {
    if (this.disposed) return false;
    const scope = normalizeIdentifier(rawScope, this.policy.maxIdentifierLength);
    return scope ? this.scopes.delete(scope) : false;
  }

  snapshot(): RuntimeAdmissionSnapshot {
    if (!this.disposed) this.sweep();
    const scopes = [...this.scopes.values()]
      .sort((left, right) => left.scope.localeCompare(right.scope))
      .map((state) => {
        let background = 0;
        let interactive = 0;
        let critical = 0;
        for (const lease of state.leases.values()) {
          if (lease.lane === 'background') background += 1;
          else if (lease.lane === 'critical') critical += 1;
          else interactive += 1;
        }
        return Object.freeze({
          scope: state.scope,
          generation: state.generation,
          active: state.leases.size,
          background,
          interactive,
          critical,
          failuresInWindow: state.failures.length,
          cooldownUntil: state.cooldownUntil,
          lastTouchedAt: state.lastTouchedAt,
        });
      });
    const totals = this.totals();
    return Object.freeze({
      disposed: this.disposed,
      scopeCount: scopes.length,
      active: totals.active,
      background: totals.background,
      interactive: totals.interactive,
      critical: totals.critical,
      scopes: Object.freeze(scopes),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scopes.clear();
    this.generations.clear();
  }

  private resolve(lease: RuntimeAdmissionLease, now: number): ActiveLease | null {
    const scope = normalizeIdentifier(lease?.scope, this.policy.maxIdentifierLength);
    const key = normalizeIdentifier(lease?.key, this.policy.maxIdentifierLength);
    if (!scope || !key) return null;
    const state = this.scopes.get(scope);
    const active = state?.leases.get(key);
    if (!state || !active) return null;
    if (active.expiresAt <= now) {
      state.leases.delete(key);
      return null;
    }
    if (
      active.generation !== lease.generation ||
      active.lane !== lease.lane ||
      active.admittedAt !== lease.admittedAt ||
      active.expiresAt !== lease.expiresAt
    ) {
      return null;
    }
    return active;
  }

  private recordFailure(state: ScopeState, now: number): void {
    this.pruneFailures(state, now);
    state.failures.push(now);
    if (state.failures.length >= this.policy.maxFailuresInWindow) {
      state.cooldownUntil = Math.max(state.cooldownUntil, now + this.policy.cooldownMs);
    }
  }

  private pruneFailures(state: ScopeState, now: number): void {
    const cutoff = now - this.policy.failureWindowMs;
    state.failures = state.failures.filter((timestamp) => timestamp > cutoff);
  }

  private hasLaneCapacity(
    lane: RuntimeAdmissionLane,
    totals: ReturnType<RuntimeAdmissionLedger['totals']>,
  ): boolean {
    if (lane === 'background') return totals.background < this.policy.maxActiveBackground;
    if (lane === 'critical') return totals.critical < this.policy.maxActiveCritical;
    return totals.interactive < this.policy.maxActiveInteractive;
  }

  private ensureScopeCapacity(now: number): boolean {
    if (this.scopes.size < this.policy.maxScopes) return true;
    const candidate = [...this.scopes.values()]
      .filter(
        (state) =>
          state.leases.size === 0 &&
          state.failures.length === 0 &&
          state.cooldownUntil <= now,
      )
      .sort(
        (left, right) =>
          left.lastTouchedAt - right.lastTouchedAt || left.scope.localeCompare(right.scope),
      )[0];
    if (!candidate) return false;
    this.scopes.delete(candidate.scope);
    return true;
  }

  private createScope(scope: string, now: number): ScopeState {
    const generation = (this.generations.get(scope) ?? 0) + 1;
    this.generations.set(scope, generation);
    const state: ScopeState = {
      scope,
      generation,
      leases: new Map(),
      failures: [],
      cooldownUntil: 0,
      lastTouchedAt: now,
    };
    this.scopes.set(scope, state);
    return state;
  }

  private totals(): {
    active: number;
    background: number;
    interactive: number;
    critical: number;
  } {
    let active = 0;
    let background = 0;
    let interactive = 0;
    let critical = 0;
    for (const state of this.scopes.values()) {
      for (const lease of state.leases.values()) {
        active += 1;
        if (lease.lane === 'background') background += 1;
        else if (lease.lane === 'critical') critical += 1;
        else interactive += 1;
      }
    }
    return { active, background, interactive, critical };
  }

  private readNow(): number {
    return safeClock(this.now());
  }
}

export function createRuntimeAdmissionLedger(
  options: ConstructorParameters<typeof RuntimeAdmissionLedger>[0] = {},
): RuntimeAdmissionLedger {
  return new RuntimeAdmissionLedger(options);
}