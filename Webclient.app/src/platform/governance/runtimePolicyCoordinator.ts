export type RuntimePolicyLane = 'background' | 'interactive' | 'critical'
export type RuntimePolicyDecision = 'allow' | 'defer' | 'reject'

export interface RuntimePolicyCoordinatorPolicy {
  readonly maxScopes: number
  readonly maxActivePerScope: number
  readonly maxActiveGlobal: number
  readonly maxQueuedPerScope: number
  readonly leaseTtlMs: number
  readonly idleScopeTtlMs: number
  readonly failureWindowMs: number
  readonly maxFailuresBeforeCooldown: number
  readonly cooldownMs: number
  readonly criticalReserve: number
}

export interface RuntimePolicyAdmission {
  readonly scope: string
  readonly lane: RuntimePolicyLane
  readonly units?: number
  readonly now: number
}

export interface RuntimePolicyLease {
  readonly id: string
  readonly scope: string
  readonly lane: RuntimePolicyLane
  readonly generation: number
  readonly units: number
  readonly acquiredAt: number
  readonly expiresAt: number
}

export interface RuntimePolicySnapshot {
  readonly scopes: number
  readonly active: number
  readonly queued: number
  readonly failures: number
  readonly coolingScopes: number
  readonly generation: number
  readonly disposed: boolean
}

interface ScopeState {
  generation: number
  active: number
  queued: number
  failures: number[]
  cooldownUntil: number
  lastTouchedAt: number
}

interface LeaseState extends Omit<RuntimePolicyLease, 'expiresAt'> {
  expiresAt: number
  settled: boolean
}

const DEFAULT_POLICY: RuntimePolicyCoordinatorPolicy = Object.freeze({
  maxScopes: 128,
  maxActivePerScope: 8,
  maxActiveGlobal: 32,
  maxQueuedPerScope: 24,
  leaseTtlMs: 30_000,
  idleScopeTtlMs: 120_000,
  failureWindowMs: 60_000,
  maxFailuresBeforeCooldown: 5,
  cooldownMs: 15_000,
  criticalReserve: 2,
})

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function finiteNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('now must be a finite non-negative number')
  return value
}

function normalizeScope(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 128) throw new RangeError('scope must contain 1..128 characters')
  return normalized
}

function normalizeUnits(value: number | undefined): number {
  if (value === undefined) return 1
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024) throw new RangeError('units must be an integer in 1..1024')
  return value
}

export class RuntimePolicyCoordinator {
  private readonly policy: RuntimePolicyCoordinatorPolicy
  private readonly scopes = new Map<string, ScopeState>()
  private readonly leases = new Map<string, LeaseState>()
  private sequence = 0
  private generation = 1
  private disposed = false

  constructor(policy: Partial<RuntimePolicyCoordinatorPolicy> = {}) {
    this.policy = Object.freeze({
      maxScopes: positiveInteger(policy.maxScopes ?? DEFAULT_POLICY.maxScopes, DEFAULT_POLICY.maxScopes),
      maxActivePerScope: positiveInteger(policy.maxActivePerScope ?? DEFAULT_POLICY.maxActivePerScope, DEFAULT_POLICY.maxActivePerScope),
      maxActiveGlobal: positiveInteger(policy.maxActiveGlobal ?? DEFAULT_POLICY.maxActiveGlobal, DEFAULT_POLICY.maxActiveGlobal),
      maxQueuedPerScope: nonNegativeInteger(policy.maxQueuedPerScope ?? DEFAULT_POLICY.maxQueuedPerScope, DEFAULT_POLICY.maxQueuedPerScope),
      leaseTtlMs: positiveInteger(policy.leaseTtlMs ?? DEFAULT_POLICY.leaseTtlMs, DEFAULT_POLICY.leaseTtlMs),
      idleScopeTtlMs: positiveInteger(policy.idleScopeTtlMs ?? DEFAULT_POLICY.idleScopeTtlMs, DEFAULT_POLICY.idleScopeTtlMs),
      failureWindowMs: positiveInteger(policy.failureWindowMs ?? DEFAULT_POLICY.failureWindowMs, DEFAULT_POLICY.failureWindowMs),
      maxFailuresBeforeCooldown: positiveInteger(policy.maxFailuresBeforeCooldown ?? DEFAULT_POLICY.maxFailuresBeforeCooldown, DEFAULT_POLICY.maxFailuresBeforeCooldown),
      cooldownMs: positiveInteger(policy.cooldownMs ?? DEFAULT_POLICY.cooldownMs, DEFAULT_POLICY.cooldownMs),
      criticalReserve: nonNegativeInteger(policy.criticalReserve ?? DEFAULT_POLICY.criticalReserve, DEFAULT_POLICY.criticalReserve),
    })
  }

  decide(input: RuntimePolicyAdmission): RuntimePolicyDecision {
    this.assertUsable()
    const now = finiteNow(input.now)
    const scope = normalizeScope(input.scope)
    this.sweep(now)
    const state = this.getOrCreateScope(scope, now)
    state.lastTouchedAt = now
    this.trimFailures(state, now)
    if (state.cooldownUntil > now && input.lane !== 'critical') return 'reject'
    const globalActive = this.activeCount()
    const reserve = input.lane === 'critical' ? 0 : Math.min(this.policy.criticalReserve, this.policy.maxActiveGlobal)
    if (state.active < this.policy.maxActivePerScope && globalActive < this.policy.maxActiveGlobal - reserve) return 'allow'
    if (state.queued < this.policy.maxQueuedPerScope) return 'defer'
    return 'reject'
  }

  acquire(input: RuntimePolicyAdmission): RuntimePolicyLease | null {
    const decision = this.decide(input)
    if (decision !== 'allow') return null
    const now = finiteNow(input.now)
    const scope = normalizeScope(input.scope)
    const units = normalizeUnits(input.units)
    const state = this.scopes.get(scope)
    if (!state) return null
    state.active += 1
    state.lastTouchedAt = now
    const id = `rpc-${this.generation}-${++this.sequence}`
    const lease: LeaseState = {
      id,
      scope,
      lane: input.lane,
      generation: state.generation,
      units,
      acquiredAt: now,
      expiresAt: now + this.policy.leaseTtlMs,
      settled: false,
    }
    this.leases.set(id, lease)
    return Object.freeze({ ...lease })
  }

  enqueue(scopeValue: string, nowValue: number): boolean {
    this.assertUsable()
    const now = finiteNow(nowValue)
    const scope = normalizeScope(scopeValue)
    this.sweep(now)
    const state = this.getOrCreateScope(scope, now)
    if (state.queued >= this.policy.maxQueuedPerScope) return false
    state.queued += 1
    state.lastTouchedAt = now
    return true
  }

  dequeue(scopeValue: string, nowValue: number): boolean {
    this.assertUsable()
    const now = finiteNow(nowValue)
    const scope = normalizeScope(scopeValue)
    const state = this.scopes.get(scope)
    if (!state || state.queued === 0) return false
    state.queued -= 1
    state.lastTouchedAt = now
    return true
  }

  renew(lease: RuntimePolicyLease, nowValue: number): RuntimePolicyLease | null {
    this.assertUsable()
    const now = finiteNow(nowValue)
    this.sweep(now)
    const current = this.validateLease(lease)
    if (!current || current.expiresAt <= now) return null
    current.expiresAt = now + this.policy.leaseTtlMs
    const scope = this.scopes.get(current.scope)
    if (scope) scope.lastTouchedAt = now
    return Object.freeze({ ...current })
  }

  succeed(lease: RuntimePolicyLease, nowValue: number): boolean {
    return this.settle(lease, finiteNow(nowValue), false)
  }

  fail(lease: RuntimePolicyLease, nowValue: number): boolean {
    return this.settle(lease, finiteNow(nowValue), true)
  }

  resetScope(scopeValue: string, nowValue: number): boolean {
    this.assertUsable()
    const now = finiteNow(nowValue)
    const scope = normalizeScope(scopeValue)
    const state = this.scopes.get(scope)
    if (!state) return false
    for (const lease of this.leases.values()) {
      if (lease.scope === scope) this.expireLease(lease, now)
    }
    state.generation += 1
    state.active = 0
    state.queued = 0
    state.failures = []
    state.cooldownUntil = 0
    state.lastTouchedAt = now
    return true
  }

  removeScope(scopeValue: string): boolean {
    this.assertUsable()
    const scope = normalizeScope(scopeValue)
    for (const lease of this.leases.values()) {
      if (lease.scope === scope) this.leases.delete(lease.id)
    }
    return this.scopes.delete(scope)
  }

  sweep(nowValue: number): void {
    this.assertUsable()
    const now = finiteNow(nowValue)
    for (const lease of this.leases.values()) {
      if (!lease.settled && lease.expiresAt <= now) this.expireLease(lease, now)
    }
    for (const state of this.scopes.values()) {
      this.trimFailures(state, now)
      if (state.cooldownUntil <= now) state.cooldownUntil = 0
    }
    for (const [scope, state] of this.scopes.entries()) {
      if (state.active === 0 && state.queued === 0 && now - state.lastTouchedAt >= this.policy.idleScopeTtlMs) this.scopes.delete(scope)
    }
  }

  snapshot(nowValue: number): RuntimePolicySnapshot {
    this.assertUsable()
    const now = finiteNow(nowValue)
    this.sweep(now)
    let queued = 0
    let failures = 0
    let coolingScopes = 0
    for (const state of this.scopes.values()) {
      queued += state.queued
      failures += state.failures.length
      if (state.cooldownUntil > now) coolingScopes += 1
    }
    return Object.freeze({
      scopes: this.scopes.size,
      active: this.activeCount(),
      queued,
      failures,
      coolingScopes,
      generation: this.generation,
      disposed: false,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.scopes.clear()
    this.leases.clear()
  }

  private settle(lease: RuntimePolicyLease, now: number, failed: boolean): boolean {
    this.assertUsable()
    this.sweep(now)
    const current = this.validateLease(lease)
    if (!current || current.settled) return false
    const state = this.scopes.get(current.scope)
    if (!state || state.generation !== current.generation) return false
    current.settled = true
    this.leases.delete(current.id)
    state.active = Math.max(0, state.active - 1)
    state.lastTouchedAt = now
    if (failed) {
      state.failures.push(now)
      this.trimFailures(state, now)
      if (state.failures.length >= this.policy.maxFailuresBeforeCooldown) state.cooldownUntil = Math.max(state.cooldownUntil, now + this.policy.cooldownMs)
    }
    return true
  }

  private validateLease(lease: RuntimePolicyLease): LeaseState | null {
    if (typeof lease.id !== 'string') return null
    const current = this.leases.get(lease.id)
    if (!current) return null
    if (current.scope !== lease.scope || current.lane !== lease.lane || current.generation !== lease.generation || current.units !== lease.units || current.acquiredAt !== lease.acquiredAt) return null
    return current
  }

  private expireLease(lease: LeaseState, now: number): void {
    if (lease.settled) return
    lease.settled = true
    this.leases.delete(lease.id)
    const state = this.scopes.get(lease.scope)
    if (state && state.generation === lease.generation) {
      state.active = Math.max(0, state.active - 1)
      state.lastTouchedAt = now
    }
  }

  private getOrCreateScope(scope: string, now: number): ScopeState {
    const existing = this.scopes.get(scope)
    if (existing) return existing
    if (this.scopes.size >= this.policy.maxScopes) this.evictInactiveScope()
    if (this.scopes.size >= this.policy.maxScopes) throw new Error('runtime policy scope capacity exhausted')
    const state: ScopeState = { generation: 1, active: 0, queued: 0, failures: [], cooldownUntil: 0, lastTouchedAt: now }
    this.scopes.set(scope, state)
    return state
  }

  private evictInactiveScope(): void {
    let candidate: [string, ScopeState] | undefined
    for (const entry of this.scopes.entries()) {
      const [name, state] = entry
      if (state.active !== 0 || state.queued !== 0) continue
      if (!candidate || state.lastTouchedAt < candidate[1].lastTouchedAt || (state.lastTouchedAt === candidate[1].lastTouchedAt && name.localeCompare(candidate[0]) < 0)) candidate = entry
    }
    if (candidate) this.scopes.delete(candidate[0])
  }

  private trimFailures(state: ScopeState, now: number): void {
    const cutoff = now - this.policy.failureWindowMs
    while (state.failures.length && state.failures[0]! < cutoff) state.failures.shift()
  }

  private activeCount(): number {
    let total = 0
    for (const state of this.scopes.values()) total += state.active
    return total
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('RuntimePolicyCoordinator is disposed')
  }
}
