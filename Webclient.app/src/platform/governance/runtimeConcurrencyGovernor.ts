export type RuntimeWorkPriority = 'background' | 'interactive' | 'critical'
export type RuntimeWorkKind = 'compute' | 'render' | 'network' | 'storage'

export interface RuntimeConcurrencyPolicy {
  readonly maxScopes: number
  readonly maxActiveGlobal: number
  readonly maxActivePerScope: number
  readonly maxQueuedGlobal: number
  readonly maxQueuedPerScope: number
  readonly criticalActiveReserve: number
  readonly leaseTtlMs: number
  readonly queueTtlMs: number
  readonly idleScopeTtlMs: number
}

export interface RuntimeWorkRequest {
  readonly scope: string
  readonly kind: RuntimeWorkKind
  readonly priority: RuntimeWorkPriority
  readonly now: number
}

export interface RuntimeWorkLease {
  readonly id: string
  readonly scope: string
  readonly kind: RuntimeWorkKind
  readonly priority: RuntimeWorkPriority
  readonly generation: number
  readonly acquiredAt: number
  readonly expiresAt: number
}

export interface RuntimeQueueTicket {
  readonly id: string
  readonly scope: string
  readonly kind: RuntimeWorkKind
  readonly priority: RuntimeWorkPriority
  readonly generation: number
  readonly queuedAt: number
  readonly expiresAt: number
}

export interface RuntimeConcurrencySnapshot {
  readonly scopes: number
  readonly active: number
  readonly queued: number
  readonly activeCompute: number
  readonly activeRender: number
  readonly activeNetwork: number
  readonly activeStorage: number
  readonly queuedBackground: number
  readonly queuedInteractive: number
  readonly queuedCritical: number
}

interface ScopeState {
  readonly scope: string
  generation: number
  active: number
  queued: number
  lastTouchedAt: number
}

interface LeaseState {
  readonly id: string
  readonly scope: string
  readonly kind: RuntimeWorkKind
  readonly priority: RuntimeWorkPriority
  readonly generation: number
  readonly acquiredAt: number
  expiresAt: number
}

interface TicketState {
  readonly id: string
  readonly scope: string
  readonly kind: RuntimeWorkKind
  readonly priority: RuntimeWorkPriority
  readonly generation: number
  readonly queuedAt: number
  readonly sequence: number
  expiresAt: number
}

const DEFAULT_POLICY: RuntimeConcurrencyPolicy = Object.freeze({
  maxScopes: 128,
  maxActiveGlobal: 24,
  maxActivePerScope: 8,
  maxQueuedGlobal: 256,
  maxQueuedPerScope: 32,
  criticalActiveReserve: 4,
  leaseTtlMs: 30_000,
  queueTtlMs: 20_000,
  idleScopeTtlMs: 120_000,
})

const positiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback

const nonNegativeInteger = (value: number | undefined, fallback: number): number =>
  Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : fallback

const timestamp = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid timestamp')
  return value
}

const scopeId = (value: string): string => {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 128) throw new Error('invalid scope')
  return normalized
}

const frozenLease = (state: LeaseState): RuntimeWorkLease => Object.freeze({
  id: state.id,
  scope: state.scope,
  kind: state.kind,
  priority: state.priority,
  generation: state.generation,
  acquiredAt: state.acquiredAt,
  expiresAt: state.expiresAt,
})

const frozenTicket = (state: TicketState): RuntimeQueueTicket => Object.freeze({
  id: state.id,
  scope: state.scope,
  kind: state.kind,
  priority: state.priority,
  generation: state.generation,
  queuedAt: state.queuedAt,
  expiresAt: state.expiresAt,
})

/**
 * Payload-free authority for bounded shared runtime concurrency.
 * It deliberately stores scalar scheduling metadata only: no request payload,
 * URL, credential, callback, Promise, SDK object, DOM node or AbortController.
 */
export class RuntimeConcurrencyGovernor {
  readonly policy: RuntimeConcurrencyPolicy
  private readonly scopes = new Map<string, ScopeState>()
  private readonly leases = new Map<string, LeaseState>()
  private readonly tickets = new Map<string, TicketState>()
  private nextLease = 1
  private nextTicket = 1
  private nextSequence = 1
  private disposed = false

  constructor(policy: Partial<RuntimeConcurrencyPolicy> = {}) {
    const maxActiveGlobal = positiveInteger(policy.maxActiveGlobal, DEFAULT_POLICY.maxActiveGlobal)
    const maxActivePerScope = Math.min(positiveInteger(policy.maxActivePerScope, DEFAULT_POLICY.maxActivePerScope), maxActiveGlobal)
    const maxQueuedGlobal = positiveInteger(policy.maxQueuedGlobal, DEFAULT_POLICY.maxQueuedGlobal)
    const maxQueuedPerScope = Math.min(positiveInteger(policy.maxQueuedPerScope, DEFAULT_POLICY.maxQueuedPerScope), maxQueuedGlobal)
    this.policy = Object.freeze({
      maxScopes: positiveInteger(policy.maxScopes, DEFAULT_POLICY.maxScopes),
      maxActiveGlobal,
      maxActivePerScope,
      maxQueuedGlobal,
      maxQueuedPerScope,
      criticalActiveReserve: Math.min(nonNegativeInteger(policy.criticalActiveReserve, DEFAULT_POLICY.criticalActiveReserve), maxActiveGlobal),
      leaseTtlMs: positiveInteger(policy.leaseTtlMs, DEFAULT_POLICY.leaseTtlMs),
      queueTtlMs: positiveInteger(policy.queueTtlMs, DEFAULT_POLICY.queueTtlMs),
      idleScopeTtlMs: positiveInteger(policy.idleScopeTtlMs, DEFAULT_POLICY.idleScopeTtlMs),
    })
  }

  canAcquire(request: RuntimeWorkRequest): boolean {
    this.assertLive()
    const now = timestamp(request.now)
    const scope = scopeId(request.scope)
    this.sweep(now)
    const state = this.scopes.get(scope)
    if ((state?.active ?? 0) >= this.policy.maxActivePerScope) return false
    const active = this.leases.size
    const ceiling = request.priority === 'critical'
      ? this.policy.maxActiveGlobal
      : this.policy.maxActiveGlobal - this.policy.criticalActiveReserve
    return active < ceiling
  }

  acquire(request: RuntimeWorkRequest): RuntimeWorkLease | null {
    this.assertLive()
    const now = timestamp(request.now)
    const scope = scopeId(request.scope)
    this.sweep(now)
    if (!this.canAcquire({ ...request, scope, now })) return null
    const state = this.ensureScope(scope, now)
    const lease: LeaseState = {
      id: `work-${this.nextLease++}`,
      scope,
      kind: request.kind,
      priority: request.priority,
      generation: state.generation,
      acquiredAt: now,
      expiresAt: now + this.policy.leaseTtlMs,
    }
    state.active += 1
    state.lastTouchedAt = now
    this.leases.set(lease.id, lease)
    return frozenLease(lease)
  }

  renew(lease: RuntimeWorkLease, nowValue: number): RuntimeWorkLease | null {
    this.assertLive()
    const now = timestamp(nowValue)
    this.sweep(now)
    const state = this.validLease(lease)
    if (!state) return null
    state.expiresAt = now + this.policy.leaseTtlMs
    const scope = this.scopes.get(state.scope)
    if (scope) scope.lastTouchedAt = now
    return frozenLease(state)
  }

  release(lease: RuntimeWorkLease, nowValue: number): boolean {
    this.assertLive()
    const now = timestamp(nowValue)
    this.sweep(now)
    const state = this.validLease(lease)
    if (!state) return false
    this.leases.delete(state.id)
    const scope = this.scopes.get(state.scope)
    if (scope) {
      scope.active = Math.max(0, scope.active - 1)
      scope.lastTouchedAt = now
    }
    return true
  }

  enqueue(request: RuntimeWorkRequest): RuntimeQueueTicket | null {
    this.assertLive()
    const now = timestamp(request.now)
    const scope = scopeId(request.scope)
    this.sweep(now)
    const existing = this.scopes.get(scope)
    if (this.tickets.size >= this.policy.maxQueuedGlobal || (existing?.queued ?? 0) >= this.policy.maxQueuedPerScope) return null
    const state = this.ensureScope(scope, now)
    const ticket: TicketState = {
      id: `queue-${this.nextTicket++}`,
      scope,
      kind: request.kind,
      priority: request.priority,
      generation: state.generation,
      queuedAt: now,
      sequence: this.nextSequence++,
      expiresAt: now + this.policy.queueTtlMs,
    }
    state.queued += 1
    state.lastTouchedAt = now
    this.tickets.set(ticket.id, ticket)
    return frozenTicket(ticket)
  }

  cancel(ticket: RuntimeQueueTicket, nowValue: number): boolean {
    this.assertLive()
    const now = timestamp(nowValue)
    this.sweep(now)
    const state = this.validTicket(ticket)
    if (!state) return false
    this.removeTicket(state, now)
    return true
  }

  promoteNext(nowValue: number): RuntimeWorkLease | null {
    this.assertLive()
    const now = timestamp(nowValue)
    this.sweep(now)
    let candidate: TicketState | undefined
    for (const ticket of this.tickets.values()) {
      if (!this.canAcquire({ scope: ticket.scope, kind: ticket.kind, priority: ticket.priority, now })) continue
      if (!candidate || this.compareTickets(ticket, candidate) < 0) candidate = ticket
    }
    if (!candidate) return null
    const request: RuntimeWorkRequest = { scope: candidate.scope, kind: candidate.kind, priority: candidate.priority, now }
    this.removeTicket(candidate, now)
    return this.acquire(request)
  }

  resetScope(scopeValue: string, nowValue: number): boolean {
    this.assertLive()
    const now = timestamp(nowValue)
    const scope = scopeId(scopeValue)
    this.sweep(now)
    const state = this.scopes.get(scope)
    if (!state) return false
    for (const lease of this.leases.values()) if (lease.scope === scope) this.leases.delete(lease.id)
    for (const ticket of this.tickets.values()) if (ticket.scope === scope) this.tickets.delete(ticket.id)
    state.active = 0
    state.queued = 0
    state.generation += 1
    state.lastTouchedAt = now
    return true
  }

  removeScope(scopeValue: string): boolean {
    this.assertLive()
    const scope = scopeId(scopeValue)
    const state = this.scopes.get(scope)
    if (!state || state.active > 0 || state.queued > 0) return false
    return this.scopes.delete(scope)
  }

  snapshot(nowValue: number): RuntimeConcurrencySnapshot {
    this.assertLive()
    const now = timestamp(nowValue)
    this.sweep(now)
    let activeCompute = 0
    let activeRender = 0
    let activeNetwork = 0
    let activeStorage = 0
    for (const lease of this.leases.values()) {
      if (lease.kind === 'compute') activeCompute += 1
      else if (lease.kind === 'render') activeRender += 1
      else if (lease.kind === 'network') activeNetwork += 1
      else activeStorage += 1
    }
    let queuedBackground = 0
    let queuedInteractive = 0
    let queuedCritical = 0
    for (const ticket of this.tickets.values()) {
      if (ticket.priority === 'background') queuedBackground += 1
      else if (ticket.priority === 'interactive') queuedInteractive += 1
      else queuedCritical += 1
    }
    return Object.freeze({ scopes: this.scopes.size, active: this.leases.size, queued: this.tickets.size, activeCompute, activeRender, activeNetwork, activeStorage, queuedBackground, queuedInteractive, queuedCritical })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.leases.clear()
    this.tickets.clear()
    this.scopes.clear()
  }

  private ensureScope(scope: string, now: number): ScopeState {
    const existing = this.scopes.get(scope)
    if (existing) return existing
    if (this.scopes.size >= this.policy.maxScopes) this.evictInactiveScope()
    if (this.scopes.size >= this.policy.maxScopes) throw new Error('scope capacity exhausted')
    const state: ScopeState = { scope, generation: 1, active: 0, queued: 0, lastTouchedAt: now }
    this.scopes.set(scope, state)
    return state
  }

  private evictInactiveScope(): void {
    let candidate: ScopeState | undefined
    for (const state of this.scopes.values()) {
      if (state.active > 0 || state.queued > 0) continue
      if (!candidate || state.lastTouchedAt < candidate.lastTouchedAt || (state.lastTouchedAt === candidate.lastTouchedAt && state.scope < candidate.scope)) candidate = state
    }
    if (candidate) this.scopes.delete(candidate.scope)
  }

  private validLease(value: RuntimeWorkLease): LeaseState | undefined {
    const state = this.leases.get(value.id)
    if (!state) return undefined
    if (state.scope !== value.scope || state.kind !== value.kind || state.priority !== value.priority || state.generation !== value.generation || state.acquiredAt !== value.acquiredAt || state.expiresAt !== value.expiresAt) return undefined
    return state
  }

  private validTicket(value: RuntimeQueueTicket): TicketState | undefined {
    const state = this.tickets.get(value.id)
    if (!state) return undefined
    if (state.scope !== value.scope || state.kind !== value.kind || state.priority !== value.priority || state.generation !== value.generation || state.queuedAt !== value.queuedAt || state.expiresAt !== value.expiresAt) return undefined
    return state
  }

  private removeTicket(ticket: TicketState, now: number): void {
    this.tickets.delete(ticket.id)
    const scope = this.scopes.get(ticket.scope)
    if (scope) {
      scope.queued = Math.max(0, scope.queued - 1)
      scope.lastTouchedAt = now
    }
  }

  private compareTickets(left: TicketState, right: TicketState): number {
    const rank = (priority: RuntimeWorkPriority): number => priority === 'critical' ? 0 : priority === 'interactive' ? 1 : 2
    const priority = rank(left.priority) - rank(right.priority)
    if (priority !== 0) return priority
    if (left.queuedAt !== right.queuedAt) return left.queuedAt - right.queuedAt
    if (left.scope !== right.scope) return left.scope < right.scope ? -1 : 1
    return left.sequence - right.sequence
  }

  private sweep(now: number): void {
    for (const lease of this.leases.values()) {
      if (lease.expiresAt > now) continue
      this.leases.delete(lease.id)
      const scope = this.scopes.get(lease.scope)
      if (scope) {
        scope.active = Math.max(0, scope.active - 1)
        scope.lastTouchedAt = now
      }
    }
    for (const ticket of this.tickets.values()) if (ticket.expiresAt <= now) this.removeTicket(ticket, now)
    for (const state of this.scopes.values()) {
      if (state.active === 0 && state.queued === 0 && now - state.lastTouchedAt >= this.policy.idleScopeTtlMs) this.scopes.delete(state.scope)
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('disposed')
  }
}
