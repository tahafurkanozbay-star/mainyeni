export type FeatureEditLockIntent = 'interactive' | 'visible' | 'background'
export type FeatureEditLockPhase = 'waiting' | 'held'

export interface FeatureEditLockBudget {
  maxLayers: number
  maxLocks: number
  maxLocksPerLayer: number
  maxHeld: number
  maxHeldPerLayer: number
  waitTtlMs: number
  leaseMs: number
}

export interface FeatureEditLockRequest {
  lockId: string
  layerId: string
  featureId: string
  revision: number
  intent: FeatureEditLockIntent
  requestedAt: number
}

export interface FeatureEditLockView {
  readonly lockId: string
  readonly layerId: string
  readonly featureId: string
  readonly revision: number
  readonly intent: FeatureEditLockIntent
  readonly phase: FeatureEditLockPhase
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Lock extends FeatureEditLockRequest {
  phase: FeatureEditLockPhase
  sequence: number
  touchedAt: number
  expiresAt: number
}

const intentRank: Readonly<Record<FeatureEditLockIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const intents: readonly FeatureEditLockIntent[] = ['interactive', 'visible', 'background']

function safeIdentifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f]/.test(normalized)) throw new Error(`${name} must contain 1..192 safe characters`)
  return normalized
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('revision must be a non-negative integer')
}

function time(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

/**
 * Payload-free authority for feature-scoped edit exclusivity.
 *
 * The policy intentionally stores only scalar identity and scheduling metadata. Geometry,
 * Graphic, attributes, credentials, request bodies and AbortSignals stay caller-owned.
 * Revision watermarks invalidate stale locks when a layer refreshes, while bounded
 * cardinality, deterministic intent ordering and leases prevent unbounded authority state.
 */
export class ArcGisFeatureEditLockLifecyclePolicy {
  readonly #budget: Readonly<FeatureEditLockBudget>
  readonly #locks = new Map<string, Lock>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: FeatureEditLockBudget) {
    for (const key of ['maxLayers', 'maxLocks', 'maxLocksPerLayer', 'maxHeld', 'maxHeldPerLayer'] as const) positiveInteger(key, budget[key])
    time('waitTtlMs', budget.waitTtlMs)
    time('leaseMs', budget.leaseMs)
    if (budget.maxLocksPerLayer > budget.maxLocks) throw new Error('maxLocksPerLayer cannot exceed maxLocks')
    if (budget.maxHeld > budget.maxLocks) throw new Error('maxHeld cannot exceed maxLocks')
    if (budget.maxHeldPerLayer > budget.maxHeld || budget.maxHeldPerLayer > budget.maxLocksPerLayer) throw new Error('maxHeldPerLayer exceeds a parent budget')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, nextRevision: number): number {
    this.#assertLive()
    const layer = safeIdentifier('layerId', layerId)
    revision(nextRevision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && nextRevision < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, nextRevision)
    if (current === undefined || current === nextRevision) return 0
    let removed = 0
    for (const [id, lock] of this.#locks) {
      if (lock.layerId === layer && lock.revision !== nextRevision) {
        this.#locks.delete(id)
        removed++
      }
    }
    return removed
  }

  enqueue(request: FeatureEditLockRequest): boolean {
    this.#assertLive()
    const lockId = safeIdentifier('lockId', request.lockId)
    const layerId = safeIdentifier('layerId', request.layerId)
    const featureId = safeIdentifier('featureId', request.featureId)
    revision(request.revision)
    time('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#locks.has(lockId)) return false
    if (this.#locks.size >= this.#budget.maxLocks || this.#countLayer(layerId) >= this.#budget.maxLocksPerLayer) return false
    if (this.#hasFeatureAuthority(layerId, featureId)) return false
    const sequence = ++this.#sequence
    this.#locks.set(lockId, { ...request, lockId, layerId, featureId, phase: 'waiting', sequence, touchedAt: request.requestedAt, expiresAt: request.requestedAt + this.#budget.waitTtlMs })
    return true
  }

  acquireNext(now: number): FeatureEditLockView | null {
    this.#assertLive()
    time('now', now)
    this.expire(now)
    if (this.#countPhase('held') >= this.#budget.maxHeld) return null
    let candidate: Lock | undefined
    for (const lock of this.#locks.values()) {
      if (lock.phase !== 'waiting' || this.#countLayerPhase(lock.layerId, 'held') >= this.#budget.maxHeldPerLayer) continue
      if (!candidate || intentRank[lock.intent] > intentRank[candidate.intent] || (intentRank[lock.intent] === intentRank[candidate.intent] && (lock.requestedAt < candidate.requestedAt || (lock.requestedAt === candidate.requestedAt && lock.sequence < candidate.sequence)))) candidate = lock
    }
    if (!candidate) return null
    candidate.phase = 'held'
    candidate.touchedAt = now
    candidate.expiresAt = now + this.#budget.leaseMs
    return this.#view(candidate)
  }

  renew(lockId: string, revisionValue: number, now: number): boolean {
    this.#assertLive()
    const lock = this.#locks.get(safeIdentifier('lockId', lockId))
    revision(revisionValue)
    time('now', now)
    this.expire(now)
    if (!lock || lock.phase !== 'held' || lock.revision !== revisionValue || this.#revisions.get(lock.layerId) !== revisionValue) return false
    lock.touchedAt = now
    lock.expiresAt = now + this.#budget.leaseMs
    return true
  }

  release(lockId: string): boolean {
    this.#assertLive()
    return this.#locks.delete(safeIdentifier('lockId', lockId))
  }

  releaseLayer(layerId: string): number {
    this.#assertLive()
    const layer = safeIdentifier('layerId', layerId)
    let removed = 0
    for (const [id, lock] of this.#locks) if (lock.layerId === layer) { this.#locks.delete(id); removed++ }
    this.#revisions.delete(layer)
    return removed
  }

  expire(now: number): number {
    this.#assertLive()
    time('now', now)
    let removed = 0
    for (const [id, lock] of this.#locks) if (lock.expiresAt <= now) { this.#locks.delete(id); removed++ }
    return removed
  }

  snapshot(): Readonly<{ layers: number; locks: number; waiting: number; held: number }> {
    this.#assertLive()
    return Object.freeze({ layers: this.#revisions.size, locks: this.#locks.size, waiting: this.#countPhase('waiting'), held: this.#countPhase('held') })
  }

  fingerprint(): string {
    this.#assertLive()
    return [...this.#locks.values()].sort((a, b) => a.layerId.localeCompare(b.layerId) || a.featureId.localeCompare(b.featureId) || a.sequence - b.sequence).map(lock => `${lock.layerId}:${lock.featureId}:${lock.lockId}:${lock.revision}:${lock.intent}:${lock.phase}`).join('|')
  }

  dispose(): void {
    if (this.#disposed) return
    this.#locks.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #hasFeatureAuthority(layerId: string, featureId: string): boolean {
    for (const lock of this.#locks.values()) if (lock.layerId === layerId && lock.featureId === featureId) return true
    return false
  }

  #countLayer(layerId: string): number {
    let count = 0
    for (const lock of this.#locks.values()) if (lock.layerId === layerId) count++
    return count
  }

  #countPhase(phase: FeatureEditLockPhase): number {
    let count = 0
    for (const lock of this.#locks.values()) if (lock.phase === phase) count++
    return count
  }

  #countLayerPhase(layerId: string, phase: FeatureEditLockPhase): number {
    let count = 0
    for (const lock of this.#locks.values()) if (lock.layerId === layerId && lock.phase === phase) count++
    return count
  }

  #view(lock: Lock): FeatureEditLockView {
    return Object.freeze({ lockId: lock.lockId, layerId: lock.layerId, featureId: lock.featureId, revision: lock.revision, intent: lock.intent, phase: lock.phase, sequence: lock.sequence, touchedAt: lock.touchedAt, expiresAt: lock.expiresAt })
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('feature edit lock lifecycle policy is disposed')
  }
}
