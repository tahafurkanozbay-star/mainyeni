export type RuntimeRetryPriority = 'background' | 'normal' | 'critical'
export type RuntimeRetryOutcome = 'success' | 'failure' | 'timeout' | 'cancelled'

export interface RuntimeRetryBudgetPolicy {
  readonly maxScopes: number
  readonly maxTokensPerScope: number
  readonly initialTokens: number
  readonly successRefill: number
  readonly refillIntervalMs: number
  readonly refillTokens: number
  readonly failurePenalty: number
  readonly timeoutPenalty: number
  readonly maxConsecutiveFailures: number
  readonly cooldownMs: number
  readonly leaseMs: number
}

export interface RuntimeRetryAcquireRequest {
  readonly scope: string
  readonly priority: RuntimeRetryPriority
  readonly now: number
  readonly cost?: number
}

export interface RuntimeRetryLease {
  readonly id: number
  readonly scope: string
  readonly generation: number
  readonly cost: number
  readonly acquiredAt: number
  readonly expiresAt: number
}

export interface RuntimeRetryScopeSnapshot {
  readonly scope: string
  readonly generation: number
  readonly tokens: number
  readonly activeLeases: number
  readonly consecutiveFailures: number
  readonly cooldownUntil: number | null
  readonly lastRefillAt: number
  readonly touchedAt: number
}

export interface RuntimeRetryBudgetSnapshot {
  readonly disposed: boolean
  readonly scopeCount: number
  readonly activeLeaseCount: number
  readonly scopes: readonly RuntimeRetryScopeSnapshot[]
}

type ScopeState = {
  readonly scope: string
  generation: number
  tokens: number
  consecutiveFailures: number
  cooldownUntil: number | null
  lastRefillAt: number
  touchedAt: number
}

type StoredLease = RuntimeRetryLease & { readonly priority: RuntimeRetryPriority }

const DEFAULT_POLICY: RuntimeRetryBudgetPolicy = Object.freeze({
  maxScopes: 64,
  maxTokensPerScope: 8,
  initialTokens: 4,
  successRefill: 1,
  refillIntervalMs: 30_000,
  refillTokens: 1,
  failurePenalty: 1,
  timeoutPenalty: 2,
  maxConsecutiveFailures: 4,
  cooldownMs: 15_000,
  leaseMs: 30_000,
})

const positiveInteger = (value: number, fallback: number): number =>
  Number.isSafeInteger(value) && value > 0 ? value : fallback

const nonNegativeInteger = (value: number, fallback: number): number =>
  Number.isSafeInteger(value) && value >= 0 ? value : fallback

const timestamp = (value: number): number | null => Number.isFinite(value) && value >= 0 ? value : null

const scopeName = (value: string): string | null => {
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 128 ? normalized : null
}

const priorityRank = (priority: RuntimeRetryPriority): number =>
  priority === 'critical' ? 2 : priority === 'normal' ? 1 : 0

/**
 * Bounded retry authority for browser runtime work.
 *
 * This registry intentionally owns no timers, callbacks, AbortControllers,
 * request payloads, errors, URLs, credentials, or SDK objects. Callers advance
 * time explicitly, making expiry/refill deterministic and teardown immediate.
 */
export class RuntimeRetryBudgetRegistry {
  private readonly policy: RuntimeRetryBudgetPolicy
  private readonly scopes = new Map<string, ScopeState>()
  private readonly leases = new Map<number, StoredLease>()
  private nextLeaseId = 1
  private disposed = false

  constructor(policy: Partial<RuntimeRetryBudgetPolicy> = {}) {
    const maxTokensPerScope = positiveInteger(policy.maxTokensPerScope ?? DEFAULT_POLICY.maxTokensPerScope, DEFAULT_POLICY.maxTokensPerScope)
    this.policy = Object.freeze({
      maxScopes: positiveInteger(policy.maxScopes ?? DEFAULT_POLICY.maxScopes, DEFAULT_POLICY.maxScopes),
      maxTokensPerScope,
      initialTokens: Math.min(maxTokensPerScope, nonNegativeInteger(policy.initialTokens ?? DEFAULT_POLICY.initialTokens, DEFAULT_POLICY.initialTokens)),
      successRefill: nonNegativeInteger(policy.successRefill ?? DEFAULT_POLICY.successRefill, DEFAULT_POLICY.successRefill),
      refillIntervalMs: positiveInteger(policy.refillIntervalMs ?? DEFAULT_POLICY.refillIntervalMs, DEFAULT_POLICY.refillIntervalMs),
      refillTokens: nonNegativeInteger(policy.refillTokens ?? DEFAULT_POLICY.refillTokens, DEFAULT_POLICY.refillTokens),
      failurePenalty: nonNegativeInteger(policy.failurePenalty ?? DEFAULT_POLICY.failurePenalty, DEFAULT_POLICY.failurePenalty),
      timeoutPenalty: nonNegativeInteger(policy.timeoutPenalty ?? DEFAULT_POLICY.timeoutPenalty, DEFAULT_POLICY.timeoutPenalty),
      maxConsecutiveFailures: positiveInteger(policy.maxConsecutiveFailures ?? DEFAULT_POLICY.maxConsecutiveFailures, DEFAULT_POLICY.maxConsecutiveFailures),
      cooldownMs: positiveInteger(policy.cooldownMs ?? DEFAULT_POLICY.cooldownMs, DEFAULT_POLICY.cooldownMs),
      leaseMs: positiveInteger(policy.leaseMs ?? DEFAULT_POLICY.leaseMs, DEFAULT_POLICY.leaseMs),
    })
  }

  acquire(request: RuntimeRetryAcquireRequest): RuntimeRetryLease | null {
    if (this.disposed) return null
    const scope = scopeName(request.scope)
    const now = timestamp(request.now)
    const cost = positiveInteger(request.cost ?? 1, 0)
    if (scope === null || now === null || cost <= 0 || cost > this.policy.maxTokensPerScope) return null
    this.sweep(now)
    let state = this.scopes.get(scope)
    if (!state) {
      this.ensureScopeCapacity(now)
      state = {
        scope,
        generation: 1,
        tokens: this.policy.initialTokens,
        consecutiveFailures: 0,
        cooldownUntil: null,
        lastRefillAt: now,
        touchedAt: now,
      }
      this.scopes.set(scope, state)
    }
    this.refill(state, now)
    state.touchedAt = Math.max(state.touchedAt, now)
    if (state.cooldownUntil !== null && now < state.cooldownUntil && request.priority !== 'critical') return null
    if (state.tokens < cost) return null
    state.tokens -= cost
    const lease: StoredLease = Object.freeze({
      id: this.nextLeaseId++,
      scope,
      generation: state.generation,
      cost,
      acquiredAt: now,
      expiresAt: now + this.policy.leaseMs,
      priority: request.priority,
    })
    this.leases.set(lease.id, lease)
    return this.publicLease(lease)
  }

  settle(lease: RuntimeRetryLease, outcome: RuntimeRetryOutcome, now: number): boolean {
    if (this.disposed) return false
    const at = timestamp(now)
    if (at === null) return false
    const stored = this.leases.get(lease.id)
    if (!stored || stored.scope !== lease.scope || stored.generation !== lease.generation) return false
    const state = this.scopes.get(stored.scope)
    if (!state || state.generation !== stored.generation) {
      this.leases.delete(stored.id)
      return false
    }
    this.leases.delete(stored.id)
    this.refill(state, at)
    state.touchedAt = Math.max(state.touchedAt, at)
    if (outcome === 'success') {
      state.consecutiveFailures = 0
      state.cooldownUntil = null
      state.tokens = Math.min(this.policy.maxTokensPerScope, state.tokens + this.policy.successRefill)
      return true
    }
    if (outcome === 'cancelled') {
      state.tokens = Math.min(this.policy.maxTokensPerScope, state.tokens + stored.cost)
      return true
    }
    state.consecutiveFailures += 1
    const penalty = outcome === 'timeout' ? this.policy.timeoutPenalty : this.policy.failurePenalty
    state.tokens = Math.max(0, state.tokens - penalty)
    if (state.consecutiveFailures >= this.policy.maxConsecutiveFailures) {
      state.cooldownUntil = at + this.policy.cooldownMs
    }
    return true
  }

  sweep(now: number): number {
    if (this.disposed) return 0
    const at = timestamp(now)
    if (at === null) return 0
    let expired = 0
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt > at) continue
      this.leases.delete(id)
      expired += 1
      const state = this.scopes.get(lease.scope)
      if (state && state.generation === lease.generation) {
        state.consecutiveFailures += 1
        state.tokens = Math.max(0, state.tokens - this.policy.timeoutPenalty)
        state.touchedAt = Math.max(state.touchedAt, at)
        if (state.consecutiveFailures >= this.policy.maxConsecutiveFailures) state.cooldownUntil = at + this.policy.cooldownMs
      }
    }
    for (const state of this.scopes.values()) this.refill(state, at)
    return expired
  }

  resetScope(scope: string, now: number): boolean {
    if (this.disposed) return false
    const normalized = scopeName(scope)
    const at = timestamp(now)
    if (normalized === null || at === null) return false
    const state = this.scopes.get(normalized)
    if (!state) return false
    this.removeScopeLeases(normalized)
    state.generation += 1
    state.tokens = this.policy.initialTokens
    state.consecutiveFailures = 0
    state.cooldownUntil = null
    state.lastRefillAt = at
    state.touchedAt = at
    return true
  }

  removeScope(scope: string): boolean {
    if (this.disposed) return false
    const normalized = scopeName(scope)
    if (normalized === null || !this.scopes.has(normalized)) return false
    this.removeScopeLeases(normalized)
    return this.scopes.delete(normalized)
  }

  getScope(scope: string, now?: number): RuntimeRetryScopeSnapshot | null {
    if (this.disposed) return null
    if (now !== undefined) this.sweep(now)
    const normalized = scopeName(scope)
    if (normalized === null) return null
    const state = this.scopes.get(normalized)
    return state ? this.scopeSnapshot(state) : null
  }

  snapshot(now?: number): RuntimeRetryBudgetSnapshot {
    if (now !== undefined) this.sweep(now)
    if (this.disposed) return Object.freeze({ disposed: true, scopeCount: 0, activeLeaseCount: 0, scopes: Object.freeze([]) })
    const scopes = [...this.scopes.values()]
      .sort((left, right) => left.scope.localeCompare(right.scope))
      .map((state) => this.scopeSnapshot(state))
    return Object.freeze({ disposed: false, scopeCount: scopes.length, activeLeaseCount: this.leases.size, scopes: Object.freeze(scopes) })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.leases.clear()
    this.scopes.clear()
  }

  private refill(state: ScopeState, now: number): void {
    if (now <= state.lastRefillAt) return
    const intervals = Math.floor((now - state.lastRefillAt) / this.policy.refillIntervalMs)
    if (intervals <= 0) return
    state.tokens = Math.min(this.policy.maxTokensPerScope, state.tokens + intervals * this.policy.refillTokens)
    state.lastRefillAt += intervals * this.policy.refillIntervalMs
    if (state.cooldownUntil !== null && now >= state.cooldownUntil) {
      state.cooldownUntil = null
      state.consecutiveFailures = 0
    }
  }

  private ensureScopeCapacity(now: number): void {
    if (this.scopes.size < this.policy.maxScopes) return
    let victim: ScopeState | null = null
    let victimRank = Number.POSITIVE_INFINITY
    for (const candidate of this.scopes.values()) {
      const highestPriority = [...this.leases.values()]
        .filter((lease) => lease.scope === candidate.scope)
        .reduce((rank, lease) => Math.max(rank, priorityRank(lease.priority)), -1)
      if (victim === null || highestPriority < victimRank || (highestPriority === victimRank && (candidate.touchedAt < victim.touchedAt || (candidate.touchedAt === victim.touchedAt && candidate.scope.localeCompare(victim.scope) < 0)))) {
        victim = candidate
        victimRank = highestPriority
      }
    }
    if (victim) {
      this.removeScopeLeases(victim.scope)
      this.scopes.delete(victim.scope)
    }
    void now
  }

  private removeScopeLeases(scope: string): void {
    for (const [id, lease] of this.leases) if (lease.scope === scope) this.leases.delete(id)
  }

  private scopeSnapshot(state: ScopeState): RuntimeRetryScopeSnapshot {
    let activeLeases = 0
    for (const lease of this.leases.values()) if (lease.scope === state.scope && lease.generation === state.generation) activeLeases += 1
    return Object.freeze({
      scope: state.scope,
      generation: state.generation,
      tokens: state.tokens,
      activeLeases,
      consecutiveFailures: state.consecutiveFailures,
      cooldownUntil: state.cooldownUntil,
      lastRefillAt: state.lastRefillAt,
      touchedAt: state.touchedAt,
    })
  }

  private publicLease(lease: StoredLease): RuntimeRetryLease {
    return Object.freeze({ id: lease.id, scope: lease.scope, generation: lease.generation, cost: lease.cost, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt })
  }
}
