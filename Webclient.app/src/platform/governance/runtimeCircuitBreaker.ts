export type RuntimeCircuitPriority = 'background' | 'interactive' | 'critical'
export type RuntimeCircuitState = 'closed' | 'open' | 'half-open'

export interface RuntimeCircuitPolicy {
  readonly maxScopes: number
  readonly failureThreshold: number
  readonly successThreshold: number
  readonly windowMs: number
  readonly openMs: number
  readonly halfOpenMaxProbes: number
  readonly idleScopeTtlMs: number
}

export interface RuntimeCircuitPermit {
  readonly id: string
  readonly scope: string
  readonly generation: number
  readonly priority: RuntimeCircuitPriority
  readonly probe: boolean
  readonly issuedAt: number
}

export interface RuntimeCircuitSnapshot {
  readonly scopes: number
  readonly closed: number
  readonly open: number
  readonly halfOpen: number
  readonly probes: number
  readonly failures: number
}

interface ScopeState {
  readonly scope: string
  generation: number
  state: RuntimeCircuitState
  failures: number[]
  successes: number
  openedAt: number | null
  probes: Map<string, RuntimeCircuitPermit>
  lastTouchedAt: number
}

const DEFAULT_POLICY: RuntimeCircuitPolicy = Object.freeze({
  maxScopes: 128,
  failureThreshold: 5,
  successThreshold: 2,
  windowMs: 30_000,
  openMs: 15_000,
  halfOpenMaxProbes: 1,
  idleScopeTtlMs: 120_000,
})

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback
}

function nonNegativeTime(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('now must be a finite non-negative number')
  return value
}

function normalizeScope(value: string): string {
  const scope = value.trim()
  if (scope.length === 0 || scope.length > 128) throw new TypeError('scope must contain 1..128 characters')
  return scope
}

function priority(value: RuntimeCircuitPriority): RuntimeCircuitPriority {
  if (value !== 'background' && value !== 'interactive' && value !== 'critical') throw new TypeError('invalid priority')
  return value
}

export class RuntimeCircuitBreaker {
  readonly policy: RuntimeCircuitPolicy
  private readonly scopes = new Map<string, ScopeState>()
  private nextId = 1
  private disposed = false

  constructor(policy: Partial<RuntimeCircuitPolicy> = {}) {
    this.policy = Object.freeze({
      maxScopes: positiveInteger(policy.maxScopes, DEFAULT_POLICY.maxScopes),
      failureThreshold: positiveInteger(policy.failureThreshold, DEFAULT_POLICY.failureThreshold),
      successThreshold: positiveInteger(policy.successThreshold, DEFAULT_POLICY.successThreshold),
      windowMs: positiveInteger(policy.windowMs, DEFAULT_POLICY.windowMs),
      openMs: positiveInteger(policy.openMs, DEFAULT_POLICY.openMs),
      halfOpenMaxProbes: positiveInteger(policy.halfOpenMaxProbes, DEFAULT_POLICY.halfOpenMaxProbes),
      idleScopeTtlMs: positiveInteger(policy.idleScopeTtlMs, DEFAULT_POLICY.idleScopeTtlMs),
    })
  }

  acquire(scopeValue: string, priorityValue: RuntimeCircuitPriority, nowValue: number): RuntimeCircuitPermit | null {
    this.assertLive()
    const now = nonNegativeTime(nowValue)
    const scope = normalizeScope(scopeValue)
    const requestPriority = priority(priorityValue)
    this.sweep(now)
    const state = this.ensureScope(scope, now)
    this.advance(state, now)
    state.lastTouchedAt = now
    if (state.state === 'open') return null
    const probe = state.state === 'half-open'
    if (probe && state.probes.size >= this.policy.halfOpenMaxProbes) return null
    const permit = Object.freeze({
      id: `circuit-${this.nextId++}`,
      scope,
      generation: state.generation,
      priority: requestPriority,
      probe,
      issuedAt: now,
    })
    if (probe) state.probes.set(permit.id, permit)
    return permit
  }

  succeed(permit: RuntimeCircuitPermit, nowValue: number): boolean {
    this.assertLive()
    const now = nonNegativeTime(nowValue)
    const state = this.validatePermit(permit)
    if (!state) return false
    state.lastTouchedAt = now
    this.trimFailures(state, now)
    if (!permit.probe) return true
    state.probes.delete(permit.id)
    state.successes += 1
    if (state.successes >= this.policy.successThreshold) this.close(state)
    return true
  }

  fail(permit: RuntimeCircuitPermit, nowValue: number): boolean {
    this.assertLive()
    const now = nonNegativeTime(nowValue)
    const state = this.validatePermit(permit)
    if (!state) return false
    state.lastTouchedAt = now
    if (permit.probe) {
      state.probes.delete(permit.id)
      this.open(state, now)
      return true
    }
    this.trimFailures(state, now)
    state.failures.push(now)
    if (state.failures.length >= this.policy.failureThreshold) this.open(state, now)
    return true
  }

  cancel(permit: RuntimeCircuitPermit, nowValue: number): boolean {
    this.assertLive()
    const now = nonNegativeTime(nowValue)
    const state = this.validatePermit(permit)
    if (!state) return false
    state.lastTouchedAt = now
    if (permit.probe) state.probes.delete(permit.id)
    return true
  }

  stateOf(scopeValue: string, nowValue: number): RuntimeCircuitState | null {
    this.assertLive()
    const now = nonNegativeTime(nowValue)
    const scope = normalizeScope(scopeValue)
    this.sweep(now)
    const state = this.scopes.get(scope)
    if (!state) return null
    this.advance(state, now)
    return state.state
  }

  resetScope(scopeValue: string, nowValue: number): boolean {
    this.assertLive()
    const now = nonNegativeTime(nowValue)
    const scope = normalizeScope(scopeValue)
    const state = this.scopes.get(scope)
    if (!state) return false
    state.generation += 1
    state.state = 'closed'
    state.failures = []
    state.successes = 0
    state.openedAt = null
    state.probes.clear()
    state.lastTouchedAt = now
    return true
  }

  removeScope(scopeValue: string): boolean {
    this.assertLive()
    const scope = normalizeScope(scopeValue)
    const state = this.scopes.get(scope)
    if (!state || state.probes.size > 0) return false
    return this.scopes.delete(scope)
  }

  snapshot(nowValue: number): RuntimeCircuitSnapshot {
    this.assertLive()
    const now = nonNegativeTime(nowValue)
    this.sweep(now)
    let closed = 0
    let open = 0
    let halfOpen = 0
    let probes = 0
    let failures = 0
    for (const state of this.scopes.values()) {
      this.advance(state, now)
      if (state.state === 'closed') closed += 1
      else if (state.state === 'open') open += 1
      else halfOpen += 1
      probes += state.probes.size
      failures += state.failures.length
    }
    return Object.freeze({ scopes: this.scopes.size, closed, open, halfOpen, probes, failures })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scopes.clear()
  }

  private validatePermit(permit: RuntimeCircuitPermit): ScopeState | null {
    if (!permit || typeof permit.id !== 'string') return null
    const state = this.scopes.get(permit.scope)
    if (!state || permit.generation !== state.generation) return null
    if (!permit.probe) return state.state === 'closed' ? state : null
    const stored = state.probes.get(permit.id)
    if (!stored) return null
    if (stored.scope !== permit.scope || stored.generation !== permit.generation || stored.priority !== permit.priority || stored.issuedAt !== permit.issuedAt || stored.probe !== permit.probe) return null
    return state
  }

  private ensureScope(scope: string, now: number): ScopeState {
    const existing = this.scopes.get(scope)
    if (existing) return existing
    if (this.scopes.size >= this.policy.maxScopes) this.evictInactive(now)
    if (this.scopes.size >= this.policy.maxScopes) throw new Error('scope capacity exhausted')
    const state: ScopeState = { scope, generation: 1, state: 'closed', failures: [], successes: 0, openedAt: null, probes: new Map(), lastTouchedAt: now }
    this.scopes.set(scope, state)
    return state
  }

  private advance(state: ScopeState, now: number): void {
    this.trimFailures(state, now)
    if (state.state === 'open' && state.openedAt !== null && now - state.openedAt >= this.policy.openMs) {
      state.state = 'half-open'
      state.successes = 0
      state.probes.clear()
    }
  }

  private open(state: ScopeState, now: number): void {
    state.state = 'open'
    state.openedAt = now
    state.successes = 0
    state.probes.clear()
  }

  private close(state: ScopeState): void {
    state.state = 'closed'
    state.openedAt = null
    state.failures = []
    state.successes = 0
    state.probes.clear()
  }

  private trimFailures(state: ScopeState, now: number): void {
    const cutoff = now - this.policy.windowMs
    while (state.failures.length > 0 && state.failures[0]! <= cutoff) state.failures.shift()
  }

  private sweep(now: number): void {
    for (const state of this.scopes.values()) {
      this.advance(state, now)
      if (state.probes.size === 0 && state.state === 'closed' && now - state.lastTouchedAt >= this.policy.idleScopeTtlMs) this.scopes.delete(state.scope)
    }
  }

  private evictInactive(now: number): void {
    let candidate: ScopeState | null = null
    for (const state of this.scopes.values()) {
      this.advance(state, now)
      if (state.probes.size > 0 || state.state !== 'closed') continue
      if (!candidate || state.lastTouchedAt < candidate.lastTouchedAt || (state.lastTouchedAt === candidate.lastTouchedAt && state.scope < candidate.scope)) candidate = state
    }
    if (candidate) this.scopes.delete(candidate.scope)
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('RuntimeCircuitBreaker is disposed')
  }
}
