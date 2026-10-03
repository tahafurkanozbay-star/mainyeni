export type RuntimeRetryPriority = 'background' | 'interactive' | 'critical'
export type RuntimeRetryOutcome = 'success' | 'failure' | 'cancelled'

export interface RuntimeRetryPolicy {
  readonly maxScopes: number
  readonly maxAttemptsPerWindow: number
  readonly maxAttemptsPerScope: number
  readonly windowMs: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly jitterPermille: number
  readonly idleScopeTtlMs: number
  readonly criticalReserveAttempts: number
}

export interface RuntimeRetryTicket {
  readonly id: string
  readonly scope: string
  readonly generation: number
  readonly priority: RuntimeRetryPriority
  readonly attempt: number
  readonly issuedAt: number
  readonly notBefore: number
}

export interface RuntimeRetrySnapshot {
  readonly scopes: number
  readonly activeTickets: number
  readonly attemptsInWindow: number
  readonly failuresInWindow: number
  readonly successesInWindow: number
}

interface EventState { readonly at: number; readonly outcome: RuntimeRetryOutcome }
interface ScopeState {
  readonly scope: string
  generation: number
  consecutiveFailures: number
  attempts: number[]
  events: EventState[]
  tickets: Map<string, RuntimeRetryTicket>
  lastTouchedAt: number
}

const DEFAULT_POLICY: RuntimeRetryPolicy = Object.freeze({
  maxScopes: 128,
  maxAttemptsPerWindow: 128,
  maxAttemptsPerScope: 16,
  windowMs: 30_000,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  jitterPermille: 100,
  idleScopeTtlMs: 120_000,
  criticalReserveAttempts: 8,
})

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback
}
function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : fallback
}
function nowValue(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('now must be finite and non-negative')
  return value
}
function scopeValue(value: string): string {
  const scope = value.trim()
  if (scope.length === 0 || scope.length > 128) throw new TypeError('scope must contain 1..128 characters')
  return scope
}
function priorityValue(value: RuntimeRetryPriority): RuntimeRetryPriority {
  if (value !== 'background' && value !== 'interactive' && value !== 'critical') throw new TypeError('invalid priority')
  return value
}

export class RuntimeRetryGovernor {
  readonly policy: RuntimeRetryPolicy
  private readonly scopes = new Map<string, ScopeState>()
  private nextId = 1
  private disposed = false

  constructor(policy: Partial<RuntimeRetryPolicy> = {}) {
    const maxAttemptsPerWindow = positiveInteger(policy.maxAttemptsPerWindow, DEFAULT_POLICY.maxAttemptsPerWindow)
    this.policy = Object.freeze({
      maxScopes: positiveInteger(policy.maxScopes, DEFAULT_POLICY.maxScopes),
      maxAttemptsPerWindow,
      maxAttemptsPerScope: positiveInteger(policy.maxAttemptsPerScope, DEFAULT_POLICY.maxAttemptsPerScope),
      windowMs: positiveInteger(policy.windowMs, DEFAULT_POLICY.windowMs),
      baseDelayMs: positiveInteger(policy.baseDelayMs, DEFAULT_POLICY.baseDelayMs),
      maxDelayMs: positiveInteger(policy.maxDelayMs, DEFAULT_POLICY.maxDelayMs),
      jitterPermille: Math.min(1000, nonNegativeInteger(policy.jitterPermille, DEFAULT_POLICY.jitterPermille)),
      idleScopeTtlMs: positiveInteger(policy.idleScopeTtlMs, DEFAULT_POLICY.idleScopeTtlMs),
      criticalReserveAttempts: Math.min(maxAttemptsPerWindow, nonNegativeInteger(policy.criticalReserveAttempts, DEFAULT_POLICY.criticalReserveAttempts)),
    })
  }

  acquire(scopeInput: string, priorityInput: RuntimeRetryPriority, nowInput: number): RuntimeRetryTicket | null {
    this.assertLive()
    const now = nowValue(nowInput)
    const scope = scopeValue(scopeInput)
    const priority = priorityValue(priorityInput)
    this.sweep(now)
    const state = this.ensureScope(scope, now)
    this.trim(state, now)
    const globalAttempts = this.globalAttempts(now)
    const globalLimit = priority === 'critical' ? this.policy.maxAttemptsPerWindow : this.policy.maxAttemptsPerWindow - this.policy.criticalReserveAttempts
    if (globalAttempts >= globalLimit || state.attempts.length >= this.policy.maxAttemptsPerScope) return null
    const attempt = state.consecutiveFailures + 1
    const delay = this.delayFor(scope, attempt)
    const ticket = Object.freeze({ id: `retry-${this.nextId++}`, scope, generation: state.generation, priority, attempt, issuedAt: now, notBefore: now + delay })
    state.attempts.push(now)
    state.tickets.set(ticket.id, ticket)
    state.lastTouchedAt = now
    return ticket
  }

  complete(ticket: RuntimeRetryTicket, outcome: RuntimeRetryOutcome, nowInput: number): boolean {
    this.assertLive()
    const now = nowValue(nowInput)
    if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'cancelled') throw new TypeError('invalid outcome')
    const state = this.validate(ticket)
    if (!state) return false
    state.tickets.delete(ticket.id)
    state.lastTouchedAt = now
    if (outcome === 'failure') state.consecutiveFailures += 1
    else if (outcome === 'success') state.consecutiveFailures = 0
    state.events.push({ at: now, outcome })
    this.trim(state, now)
    return true
  }

  canRun(ticket: RuntimeRetryTicket, nowInput: number): boolean {
    this.assertLive()
    const now = nowValue(nowInput)
    return this.validate(ticket) !== null && now >= ticket.notBefore
  }

  resetScope(scopeInput: string, nowInput: number): boolean {
    this.assertLive()
    const now = nowValue(nowInput)
    const scope = scopeValue(scopeInput)
    const state = this.scopes.get(scope)
    if (!state) return false
    state.generation += 1
    state.consecutiveFailures = 0
    state.attempts = []
    state.events = []
    state.tickets.clear()
    state.lastTouchedAt = now
    return true
  }

  removeScope(scopeInput: string): boolean {
    this.assertLive()
    const state = this.scopes.get(scopeValue(scopeInput))
    if (!state || state.tickets.size > 0) return false
    return this.scopes.delete(state.scope)
  }

  snapshot(nowInput: number): RuntimeRetrySnapshot {
    this.assertLive()
    const now = nowValue(nowInput)
    this.sweep(now)
    let activeTickets = 0
    let attemptsInWindow = 0
    let failuresInWindow = 0
    let successesInWindow = 0
    for (const state of this.scopes.values()) {
      this.trim(state, now)
      activeTickets += state.tickets.size
      attemptsInWindow += state.attempts.length
      for (const event of state.events) {
        if (event.outcome === 'failure') failuresInWindow += 1
        else if (event.outcome === 'success') successesInWindow += 1
      }
    }
    return Object.freeze({ scopes: this.scopes.size, activeTickets, attemptsInWindow, failuresInWindow, successesInWindow })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scopes.clear()
  }

  private delayFor(scope: string, attempt: number): number {
    const exponent = Math.min(20, Math.max(0, attempt - 1))
    const raw = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** exponent)
    if (this.policy.jitterPermille === 0) return raw
    let hash = 2166136261
    for (let index = 0; index < scope.length; index += 1) hash = Math.imul(hash ^ scope.charCodeAt(index), 16777619)
    hash = Math.imul(hash ^ attempt, 16777619) >>> 0
    const signed = (hash % 2001) - 1000
    const adjustment = Math.trunc((raw * this.policy.jitterPermille * signed) / 1_000_000)
    return Math.max(0, Math.min(this.policy.maxDelayMs, raw + adjustment))
  }

  private validate(ticket: RuntimeRetryTicket): ScopeState | null {
    if (!ticket || typeof ticket.id !== 'string') return null
    const state = this.scopes.get(ticket.scope)
    if (!state || state.generation !== ticket.generation) return null
    const stored = state.tickets.get(ticket.id)
    if (!stored) return null
    if (stored.scope !== ticket.scope || stored.generation !== ticket.generation || stored.priority !== ticket.priority || stored.attempt !== ticket.attempt || stored.issuedAt !== ticket.issuedAt || stored.notBefore !== ticket.notBefore) return null
    return state
  }

  private ensureScope(scope: string, now: number): ScopeState {
    const existing = this.scopes.get(scope)
    if (existing) return existing
    if (this.scopes.size >= this.policy.maxScopes) this.evictInactive(now)
    if (this.scopes.size >= this.policy.maxScopes) throw new Error('scope capacity exhausted')
    const state: ScopeState = { scope, generation: 1, consecutiveFailures: 0, attempts: [], events: [], tickets: new Map(), lastTouchedAt: now }
    this.scopes.set(scope, state)
    return state
  }

  private trim(state: ScopeState, now: number): void {
    const cutoff = now - this.policy.windowMs
    while (state.attempts.length > 0 && state.attempts[0]! <= cutoff) state.attempts.shift()
    while (state.events.length > 0 && state.events[0]!.at <= cutoff) state.events.shift()
  }

  private globalAttempts(now: number): number {
    let total = 0
    for (const state of this.scopes.values()) {
      this.trim(state, now)
      total += state.attempts.length
    }
    return total
  }

  private sweep(now: number): void {
    for (const state of this.scopes.values()) {
      this.trim(state, now)
      if (state.tickets.size === 0 && now - state.lastTouchedAt >= this.policy.idleScopeTtlMs) this.scopes.delete(state.scope)
    }
  }

  private evictInactive(now: number): void {
    let candidate: ScopeState | null = null
    for (const state of this.scopes.values()) {
      this.trim(state, now)
      if (state.tickets.size > 0) continue
      if (!candidate || state.lastTouchedAt < candidate.lastTouchedAt || (state.lastTouchedAt === candidate.lastTouchedAt && state.scope < candidate.scope)) candidate = state
    }
    if (candidate) this.scopes.delete(candidate.scope)
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('RuntimeRetryGovernor is disposed')
  }
}
