export type RuntimeBackpressureLane = 'background' | 'interactive' | 'critical'
export type RuntimeBackpressureDecision = 'admit' | 'defer' | 'shed'

export interface RuntimeBackpressurePolicy {
  readonly maxScopes: number
  readonly maxInflightGlobal: number
  readonly maxInflightPerScope: number
  readonly maxQueuedGlobal: number
  readonly maxQueuedPerScope: number
  readonly highWatermarkRatio: number
  readonly criticalReserve: number
  readonly leaseTtlMs: number
  readonly idleScopeTtlMs: number
  readonly maxClockRollbackMs: number
}

export interface RuntimeBackpressureRequest {
  readonly scope: string
  readonly lane: RuntimeBackpressureLane
  readonly now: number
}

export interface RuntimeBackpressureLease {
  readonly id: string
  readonly scope: string
  readonly lane: RuntimeBackpressureLane
  readonly generation: number
  readonly acquiredAt: number
  readonly expiresAt: number
}

export interface RuntimeBackpressureSnapshot {
  readonly scopes: number
  readonly inflight: number
  readonly queued: number
  readonly pressure: number
  readonly generation: number
  readonly disposed: boolean
}

interface ScopeState {
  generation: number
  inflight: number
  queued: number
  lastTouchedAt: number
}

interface LeaseState extends RuntimeBackpressureLease {
  settled: boolean
}

const DEFAULT_POLICY: RuntimeBackpressurePolicy = Object.freeze({
  maxScopes: 128,
  maxInflightGlobal: 32,
  maxInflightPerScope: 8,
  maxQueuedGlobal: 128,
  maxQueuedPerScope: 24,
  highWatermarkRatio: 0.75,
  criticalReserve: 2,
  leaseTtlMs: 30_000,
  idleScopeTtlMs: 120_000,
  maxClockRollbackMs: 250,
})

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
  return value
}

function ratio(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new RangeError('highWatermarkRatio must be in (0, 1]')
  return value
}

function scopeName(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 128) throw new RangeError('scope must contain 1..128 characters')
  return normalized
}

function finiteNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('now must be a finite non-negative number')
  return value
}

function isLeaseShape(value: unknown): value is RuntimeBackpressureLease {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value) || !('scope' in value) || !('lane' in value) || !('generation' in value) || !('acquiredAt' in value) || !('expiresAt' in value)) return false
  return typeof value.id === 'string'
    && typeof value.scope === 'string'
    && (value.lane === 'background' || value.lane === 'interactive' || value.lane === 'critical')
    && typeof value.generation === 'number'
    && typeof value.acquiredAt === 'number'
    && typeof value.expiresAt === 'number'
}

export class RuntimeBackpressureGovernor {
  private readonly policy: RuntimeBackpressurePolicy
  private readonly scopes = new Map<string, ScopeState>()
  private readonly leases = new Map<string, LeaseState>()
  private generation = 1
  private sequence = 0
  private lastNow = 0
  private disposed = false

  constructor(policy: Partial<RuntimeBackpressurePolicy> = {}) {
    const resolved: RuntimeBackpressurePolicy = {
      maxScopes: positiveInteger(policy.maxScopes ?? DEFAULT_POLICY.maxScopes, 'maxScopes'),
      maxInflightGlobal: positiveInteger(policy.maxInflightGlobal ?? DEFAULT_POLICY.maxInflightGlobal, 'maxInflightGlobal'),
      maxInflightPerScope: positiveInteger(policy.maxInflightPerScope ?? DEFAULT_POLICY.maxInflightPerScope, 'maxInflightPerScope'),
      maxQueuedGlobal: nonNegativeInteger(policy.maxQueuedGlobal ?? DEFAULT_POLICY.maxQueuedGlobal, 'maxQueuedGlobal'),
      maxQueuedPerScope: nonNegativeInteger(policy.maxQueuedPerScope ?? DEFAULT_POLICY.maxQueuedPerScope, 'maxQueuedPerScope'),
      highWatermarkRatio: ratio(policy.highWatermarkRatio ?? DEFAULT_POLICY.highWatermarkRatio),
      criticalReserve: nonNegativeInteger(policy.criticalReserve ?? DEFAULT_POLICY.criticalReserve, 'criticalReserve'),
      leaseTtlMs: positiveInteger(policy.leaseTtlMs ?? DEFAULT_POLICY.leaseTtlMs, 'leaseTtlMs'),
      idleScopeTtlMs: positiveInteger(policy.idleScopeTtlMs ?? DEFAULT_POLICY.idleScopeTtlMs, 'idleScopeTtlMs'),
      maxClockRollbackMs: nonNegativeInteger(policy.maxClockRollbackMs ?? DEFAULT_POLICY.maxClockRollbackMs, 'maxClockRollbackMs'),
    }
    if (resolved.maxInflightPerScope > resolved.maxInflightGlobal) throw new RangeError('maxInflightPerScope must not exceed maxInflightGlobal')
    if (resolved.maxQueuedPerScope > resolved.maxQueuedGlobal) throw new RangeError('maxQueuedPerScope must not exceed maxQueuedGlobal')
    if (resolved.criticalReserve >= resolved.maxInflightGlobal) throw new RangeError('criticalReserve must be smaller than maxInflightGlobal')
    this.policy = Object.freeze(resolved)
  }

  decide(request: RuntimeBackpressureRequest): RuntimeBackpressureDecision {
    this.assertUsable()
    const now = this.tick(request.now)
    const scope = scopeName(request.scope)
    this.sweepInternal(now)
    const state = this.getOrCreateScope(scope, now)
    state.lastTouchedAt = now
    const inflight = this.inflightCount()
    const queued = this.queuedCount()
    const reserve = request.lane === 'critical' ? 0 : this.policy.criticalReserve
    const usableGlobal = this.policy.maxInflightGlobal - reserve
    if (state.inflight < this.policy.maxInflightPerScope && inflight < usableGlobal) {
      if (request.lane === 'background' && this.pressure(inflight, queued) >= this.policy.highWatermarkRatio) return 'defer'
      return 'admit'
    }
    if (state.queued >= this.policy.maxQueuedPerScope || queued >= this.policy.maxQueuedGlobal) return 'shed'
    if (request.lane === 'background' && this.pressure(inflight, queued) >= 1) return 'shed'
    return 'defer'
  }

  acquire(request: RuntimeBackpressureRequest): RuntimeBackpressureLease | null {
    if (this.decide(request) !== 'admit') return null
    const now = this.tick(request.now)
    const scope = scopeName(request.scope)
    const state = this.scopes.get(scope)
    if (!state) return null
    state.inflight += 1
    state.lastTouchedAt = now
    const lease: LeaseState = {
      id: `rbg-${this.generation}-${++this.sequence}`,
      scope,
      lane: request.lane,
      generation: state.generation,
      acquiredAt: now,
      expiresAt: now + this.policy.leaseTtlMs,
      settled: false,
    }
    this.leases.set(lease.id, lease)
    return this.publicLease(lease)
  }

  enqueue(scopeValue: string, nowValue: number): boolean {
    this.assertUsable()
    const now = this.tick(nowValue)
    const scope = scopeName(scopeValue)
    this.sweepInternal(now)
    const state = this.getOrCreateScope(scope, now)
    if (state.queued >= this.policy.maxQueuedPerScope || this.queuedCount() >= this.policy.maxQueuedGlobal) return false
    state.queued += 1
    state.lastTouchedAt = now
    return true
  }

  dequeue(scopeValue: string, nowValue: number): boolean {
    this.assertUsable()
    const now = this.tick(nowValue)
    const scope = scopeName(scopeValue)
    this.sweepInternal(now)
    const state = this.scopes.get(scope)
    if (!state || state.queued === 0) return false
    state.queued -= 1
    state.lastTouchedAt = now
    return true
  }

  release(lease: RuntimeBackpressureLease, nowValue: number): boolean {
    this.assertUsable()
    const now = this.tick(nowValue)
    this.sweepInternal(now)
    const current = this.validateLease(lease)
    if (!current || current.settled) return false
    this.settle(current, now)
    return true
  }

  renew(lease: RuntimeBackpressureLease, nowValue: number): RuntimeBackpressureLease | null {
    this.assertUsable()
    const now = this.tick(nowValue)
    this.sweepInternal(now)
    const current = this.validateLease(lease)
    if (!current || current.settled || current.expiresAt <= now) return null
    current.expiresAt = now + this.policy.leaseTtlMs
    const state = this.scopes.get(current.scope)
    if (state) state.lastTouchedAt = now
    return this.publicLease(current)
  }

  resetScope(scopeValue: string, nowValue: number): boolean {
    this.assertUsable()
    const now = this.tick(nowValue)
    const scope = scopeName(scopeValue)
    this.sweepInternal(now)
    const state = this.scopes.get(scope)
    if (!state) return false
    for (const lease of [...this.leases.values()]) if (lease.scope === scope) this.settle(lease, now)
    state.generation += 1
    state.inflight = 0
    state.queued = 0
    state.lastTouchedAt = now
    return true
  }

  sweep(nowValue: number): void {
    this.assertUsable()
    this.sweepInternal(this.tick(nowValue))
  }

  snapshot(): RuntimeBackpressureSnapshot {
    this.assertUsable()
    const inflight = this.inflightCount()
    const queued = this.queuedCount()
    return Object.freeze({ scopes: this.scopes.size, inflight, queued, pressure: this.pressure(inflight, queued), generation: this.generation, disposed: false })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.scopes.clear()
    this.leases.clear()
  }

  private tick(value: number): number {
    const now = finiteNow(value)
    if (now + this.policy.maxClockRollbackMs < this.lastNow) throw new RangeError('clock rollback exceeds maxClockRollbackMs')
    const monotonic = Math.max(now, this.lastNow)
    this.lastNow = monotonic
    return monotonic
  }

  private sweepInternal(now: number): void {
    for (const lease of [...this.leases.values()]) if (!lease.settled && lease.expiresAt <= now) this.settle(lease, now)
    for (const [scope, state] of this.scopes) {
      if (state.inflight === 0 && state.queued === 0 && now - state.lastTouchedAt >= this.policy.idleScopeTtlMs) this.scopes.delete(scope)
    }
  }

  private getOrCreateScope(scope: string, now: number): ScopeState {
    const existing = this.scopes.get(scope)
    if (existing) return existing
    if (this.scopes.size >= this.policy.maxScopes) this.evictIdleScope()
    if (this.scopes.size >= this.policy.maxScopes) throw new Error('runtime backpressure scope capacity exhausted')
    const state: ScopeState = { generation: 1, inflight: 0, queued: 0, lastTouchedAt: now }
    this.scopes.set(scope, state)
    return state
  }

  private evictIdleScope(): void {
    let candidate: [string, ScopeState] | undefined
    for (const entry of this.scopes) {
      const [name, state] = entry
      if (state.inflight !== 0 || state.queued !== 0) continue
      if (!candidate || state.lastTouchedAt < candidate[1].lastTouchedAt || (state.lastTouchedAt === candidate[1].lastTouchedAt && name.localeCompare(candidate[0]) < 0)) candidate = entry
    }
    if (candidate) this.scopes.delete(candidate[0])
  }

  private validateLease(lease: unknown): LeaseState | null {
    if (!isLeaseShape(lease)) return null
    const current = this.leases.get(lease.id)
    if (!current) return null
    if (current.scope !== lease.scope || current.lane !== lease.lane || current.generation !== lease.generation || current.acquiredAt !== lease.acquiredAt || current.expiresAt !== lease.expiresAt) return null
    return current
  }

  private settle(lease: LeaseState, now: number): void {
    if (lease.settled) return
    lease.settled = true
    this.leases.delete(lease.id)
    const state = this.scopes.get(lease.scope)
    if (state && state.generation === lease.generation) {
      state.inflight = Math.max(0, state.inflight - 1)
      state.lastTouchedAt = now
    }
  }

  private publicLease(lease: LeaseState): RuntimeBackpressureLease {
    return Object.freeze({ id: lease.id, scope: lease.scope, lane: lease.lane, generation: lease.generation, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt })
  }

  private inflightCount(): number {
    let total = 0
    for (const state of this.scopes.values()) total += state.inflight
    return total
  }

  private queuedCount(): number {
    let total = 0
    for (const state of this.scopes.values()) total += state.queued
    return total
  }

  private pressure(inflight: number, queued: number): number {
    const inflightPressure = inflight / this.policy.maxInflightGlobal
    const queuePressure = this.policy.maxQueuedGlobal === 0 ? (queued === 0 ? 0 : 1) : queued / this.policy.maxQueuedGlobal
    return Math.min(1, Math.max(inflightPressure, queuePressure))
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('RuntimeBackpressureGovernor is disposed')
  }
}
