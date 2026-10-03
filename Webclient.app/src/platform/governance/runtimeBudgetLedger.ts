export type RuntimeBudgetClass = 'cpu' | 'memory' | 'network' | 'gpu'
export type RuntimeBudgetPriority = 'background' | 'interactive' | 'critical'

export interface RuntimeBudgetPolicy {
  readonly maxScopes: number
  readonly maxReservations: number
  readonly maxUnitsPerScope: number
  readonly maxUnitsGlobal: number
  readonly reservationTtlMs: number
  readonly idleScopeTtlMs: number
  readonly criticalReserveUnits: number
}

export interface RuntimeBudgetRequest {
  readonly scope: string
  readonly budget: RuntimeBudgetClass
  readonly priority: RuntimeBudgetPriority
  readonly units: number
  readonly now: number
}

export interface RuntimeBudgetReservation {
  readonly id: string
  readonly scope: string
  readonly budget: RuntimeBudgetClass
  readonly priority: RuntimeBudgetPriority
  readonly units: number
  readonly generation: number
  readonly acquiredAt: number
  readonly expiresAt: number
}

export interface RuntimeBudgetSnapshot {
  readonly scopes: number
  readonly reservations: number
  readonly units: number
  readonly cpuUnits: number
  readonly memoryUnits: number
  readonly networkUnits: number
  readonly gpuUnits: number
  readonly generation: number
}

interface ScopeState {
  generation: number
  units: number
  lastTouchedAt: number
}

interface ReservationState {
  id: string
  scope: string
  budget: RuntimeBudgetClass
  priority: RuntimeBudgetPriority
  units: number
  generation: number
  acquiredAt: number
  expiresAt: number
}

const DEFAULT_POLICY: RuntimeBudgetPolicy = Object.freeze({
  maxScopes: 128,
  maxReservations: 256,
  maxUnitsPerScope: 64,
  maxUnitsGlobal: 256,
  reservationTtlMs: 30_000,
  idleScopeTtlMs: 120_000,
  criticalReserveUnits: 16,
})

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function normalizeScope(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 128) throw new RangeError('scope must contain 1..128 characters')
  return normalized
}

function validateNow(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('now must be finite and non-negative')
  return value
}

function validateUnits(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('units must be a positive safe integer')
  return value
}

function isBudgetClass(value: RuntimeBudgetClass): boolean {
  return value === 'cpu' || value === 'memory' || value === 'network' || value === 'gpu'
}

function isPriority(value: RuntimeBudgetPriority): boolean {
  return value === 'background' || value === 'interactive' || value === 'critical'
}

export class RuntimeBudgetLedger {
  readonly policy: RuntimeBudgetPolicy
  private readonly scopes = new Map<string, ScopeState>()
  private readonly reservations = new Map<string, ReservationState>()
  private generation = 1
  private sequence = 0
  private totalUnits = 0
  private disposed = false

  constructor(policy: Partial<RuntimeBudgetPolicy> = {}) {
    const maxUnitsGlobal = positiveInteger(policy.maxUnitsGlobal, DEFAULT_POLICY.maxUnitsGlobal)
    this.policy = Object.freeze({
      maxScopes: positiveInteger(policy.maxScopes, DEFAULT_POLICY.maxScopes),
      maxReservations: positiveInteger(policy.maxReservations, DEFAULT_POLICY.maxReservations),
      maxUnitsPerScope: positiveInteger(policy.maxUnitsPerScope, DEFAULT_POLICY.maxUnitsPerScope),
      maxUnitsGlobal,
      reservationTtlMs: positiveInteger(policy.reservationTtlMs, DEFAULT_POLICY.reservationTtlMs),
      idleScopeTtlMs: positiveInteger(policy.idleScopeTtlMs, DEFAULT_POLICY.idleScopeTtlMs),
      criticalReserveUnits: Math.min(nonNegativeInteger(policy.criticalReserveUnits, DEFAULT_POLICY.criticalReserveUnits), maxUnitsGlobal),
    })
  }

  canReserve(request: RuntimeBudgetRequest): boolean {
    this.assertLive()
    const normalized = this.normalizeRequest(request)
    this.sweep(normalized.now)
    const scope = this.ensureScope(normalized.scope, normalized.now)
    if (scope.units + normalized.units > this.policy.maxUnitsPerScope) return false
    if (this.reservations.size >= this.policy.maxReservations) return false
    const effectiveLimit = normalized.priority === 'critical'
      ? this.policy.maxUnitsGlobal
      : Math.max(0, this.policy.maxUnitsGlobal - this.policy.criticalReserveUnits)
    return this.totalUnits + normalized.units <= effectiveLimit
  }

  reserve(request: RuntimeBudgetRequest): RuntimeBudgetReservation | null {
    this.assertLive()
    const normalized = this.normalizeRequest(request)
    this.sweep(normalized.now)
    const scope = this.ensureScope(normalized.scope, normalized.now)
    if (scope.units + normalized.units > this.policy.maxUnitsPerScope) return null
    if (this.reservations.size >= this.policy.maxReservations) return null
    const effectiveLimit = normalized.priority === 'critical'
      ? this.policy.maxUnitsGlobal
      : Math.max(0, this.policy.maxUnitsGlobal - this.policy.criticalReserveUnits)
    if (this.totalUnits + normalized.units > effectiveLimit) return null

    const id = `${this.generation}:${++this.sequence}`
    const state: ReservationState = {
      id,
      scope: normalized.scope,
      budget: normalized.budget,
      priority: normalized.priority,
      units: normalized.units,
      generation: scope.generation,
      acquiredAt: normalized.now,
      expiresAt: normalized.now + this.policy.reservationTtlMs,
    }
    this.reservations.set(id, state)
    scope.units += normalized.units
    scope.lastTouchedAt = normalized.now
    this.totalUnits += normalized.units
    return this.publicReservation(state)
  }

  renew(reservation: RuntimeBudgetReservation, now: number): RuntimeBudgetReservation | null {
    this.assertLive()
    const timestamp = validateNow(now)
    this.sweep(timestamp)
    const state = this.validateReservation(reservation)
    if (!state || timestamp >= state.expiresAt) return null
    state.expiresAt = timestamp + this.policy.reservationTtlMs
    const scope = this.scopes.get(state.scope)
    if (scope) scope.lastTouchedAt = timestamp
    return this.publicReservation(state)
  }

  release(reservation: RuntimeBudgetReservation, now: number): boolean {
    this.assertLive()
    const timestamp = validateNow(now)
    this.sweep(timestamp)
    const state = this.validateReservation(reservation)
    if (!state) return false
    this.releaseState(state, timestamp)
    return true
  }

  resetScope(scopeValue: string, now: number): boolean {
    this.assertLive()
    const scopeName = normalizeScope(scopeValue)
    const timestamp = validateNow(now)
    this.sweep(timestamp)
    const scope = this.scopes.get(scopeName)
    if (!scope) return false
    for (const reservation of this.reservations.values()) {
      if (reservation.scope === scopeName) this.releaseState(reservation, timestamp)
    }
    scope.generation += 1
    scope.units = 0
    scope.lastTouchedAt = timestamp
    return true
  }

  removeScope(scopeValue: string): boolean {
    this.assertLive()
    const scopeName = normalizeScope(scopeValue)
    const scope = this.scopes.get(scopeName)
    if (!scope || scope.units !== 0) return false
    return this.scopes.delete(scopeName)
  }

  sweep(now: number): number {
    this.assertLive()
    const timestamp = validateNow(now)
    let removed = 0
    for (const reservation of this.reservations.values()) {
      if (timestamp >= reservation.expiresAt) {
        this.releaseState(reservation, timestamp)
        removed += 1
      }
    }
    for (const [name, scope] of this.scopes) {
      if (scope.units === 0 && timestamp - scope.lastTouchedAt >= this.policy.idleScopeTtlMs) {
        this.scopes.delete(name)
        removed += 1
      }
    }
    return removed
  }

  snapshot(now: number): RuntimeBudgetSnapshot {
    this.assertLive()
    const timestamp = validateNow(now)
    this.sweep(timestamp)
    let cpuUnits = 0
    let memoryUnits = 0
    let networkUnits = 0
    let gpuUnits = 0
    for (const reservation of this.reservations.values()) {
      if (reservation.budget === 'cpu') cpuUnits += reservation.units
      else if (reservation.budget === 'memory') memoryUnits += reservation.units
      else if (reservation.budget === 'network') networkUnits += reservation.units
      else gpuUnits += reservation.units
    }
    return Object.freeze({
      scopes: this.scopes.size,
      reservations: this.reservations.size,
      units: this.totalUnits,
      cpuUnits,
      memoryUnits,
      networkUnits,
      gpuUnits,
      generation: this.generation,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.reservations.clear()
    this.scopes.clear()
    this.totalUnits = 0
    this.generation += 1
  }

  private normalizeRequest(request: RuntimeBudgetRequest): RuntimeBudgetRequest {
    const scope = normalizeScope(request.scope)
    const now = validateNow(request.now)
    const units = validateUnits(request.units)
    if (!isBudgetClass(request.budget)) throw new RangeError('unsupported budget class')
    if (!isPriority(request.priority)) throw new RangeError('unsupported priority')
    return { scope, budget: request.budget, priority: request.priority, units, now }
  }

  private ensureScope(name: string, now: number): ScopeState {
    const existing = this.scopes.get(name)
    if (existing) {
      existing.lastTouchedAt = now
      return existing
    }
    if (this.scopes.size >= this.policy.maxScopes) this.evictInactiveScope()
    if (this.scopes.size >= this.policy.maxScopes) throw new Error('scope capacity exhausted')
    const state: ScopeState = { generation: 1, units: 0, lastTouchedAt: now }
    this.scopes.set(name, state)
    return state
  }

  private evictInactiveScope(): void {
    let candidateName: string | null = null
    let candidateTouched = Number.POSITIVE_INFINITY
    for (const [name, scope] of this.scopes) {
      if (scope.units !== 0) continue
      if (scope.lastTouchedAt < candidateTouched || (scope.lastTouchedAt === candidateTouched && (candidateName === null || name < candidateName))) {
        candidateName = name
        candidateTouched = scope.lastTouchedAt
      }
    }
    if (candidateName !== null) this.scopes.delete(candidateName)
  }

  private validateReservation(reservation: RuntimeBudgetReservation): ReservationState | null {
    const state = this.reservations.get(reservation.id)
    if (!state) return null
    if (state.scope !== reservation.scope || state.budget !== reservation.budget || state.priority !== reservation.priority) return null
    if (state.units !== reservation.units || state.generation !== reservation.generation) return null
    if (state.acquiredAt !== reservation.acquiredAt || state.expiresAt !== reservation.expiresAt) return null
    const scope = this.scopes.get(state.scope)
    if (!scope || scope.generation !== state.generation) return null
    return state
  }

  private releaseState(state: ReservationState, now: number): void {
    if (!this.reservations.delete(state.id)) return
    const scope = this.scopes.get(state.scope)
    if (scope) {
      scope.units = Math.max(0, scope.units - state.units)
      scope.lastTouchedAt = now
    }
    this.totalUnits = Math.max(0, this.totalUnits - state.units)
  }

  private publicReservation(state: ReservationState): RuntimeBudgetReservation {
    return Object.freeze({
      id: state.id,
      scope: state.scope,
      budget: state.budget,
      priority: state.priority,
      units: state.units,
      generation: state.generation,
      acquiredAt: state.acquiredAt,
      expiresAt: state.expiresAt,
    })
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('RuntimeBudgetLedger is disposed')
  }
}
