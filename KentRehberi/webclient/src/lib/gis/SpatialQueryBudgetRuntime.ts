export type SpatialQueryPriority = 'critical' | 'interactive' | 'background'

export interface SpatialQueryIdentity {
  readonly layerId: string
  readonly operation: string
  readonly spatialKey: string
}

export interface SpatialQueryRequest extends SpatialQueryIdentity {
  readonly estimatedBytes: number
  readonly estimatedFeatures: number
  readonly priority: SpatialQueryPriority
  readonly timeoutMs?: number
}

export interface SpatialQueryBudgetOptions {
  readonly maxActive: number
  readonly maxActivePerLayer: number
  readonly maxQueued: number
  readonly maxQueuedPerLayer: number
  readonly maxActiveBytes: number
  readonly maxQueuedBytes: number
  readonly maxFeaturesPerQuery: number
  readonly defaultTimeoutMs: number
  readonly maxTimeoutMs: number
}

export interface SpatialQueryLease {
  readonly key: string
  readonly generation: number
  readonly layerId: string
  readonly estimatedBytes: number
  readonly estimatedFeatures: number
  readonly timeoutMs: number
}

export interface SpatialQueryQueued {
  readonly key: string
  readonly generation: number
  readonly position: number
}

export type SpatialQueryAdmission =
  | { readonly kind: 'active'; readonly lease: SpatialQueryLease }
  | { readonly kind: 'queued'; readonly queued: SpatialQueryQueued }
  | { readonly kind: 'duplicate'; readonly key: string; readonly generation: number }
  | { readonly kind: 'rejected'; readonly reason: SpatialQueryRejectionReason }

export type SpatialQueryRejectionReason =
  | 'invalid-identity'
  | 'invalid-estimate'
  | 'feature-budget'
  | 'active-byte-budget'
  | 'queue-budget'
  | 'queue-byte-budget'
  | 'layer-queue-budget'

export interface SpatialQueryPromotion {
  readonly lease: SpatialQueryLease
  readonly waitedTurns: number
}

export interface SpatialQuerySnapshot {
  readonly active: number
  readonly queued: number
  readonly activeBytes: number
  readonly queuedBytes: number
  readonly activeFeatures: number
  readonly queuedFeatures: number
  readonly layers: readonly SpatialQueryLayerSnapshot[]
}

export interface SpatialQueryLayerSnapshot {
  readonly layerId: string
  readonly active: number
  readonly queued: number
  readonly activeBytes: number
  readonly queuedBytes: number
}

interface InternalRequest extends SpatialQueryRequest {
  readonly key: string
  readonly generation: number
  readonly sequence: number
  readonly timeoutMsResolved: number
  readonly enqueuedTurn: number
}

const DEFAULTS: SpatialQueryBudgetOptions = {
  maxActive: 8,
  maxActivePerLayer: 3,
  maxQueued: 96,
  maxQueuedPerLayer: 24,
  maxActiveBytes: 32 * 1024 * 1024,
  maxQueuedBytes: 96 * 1024 * 1024,
  maxFeaturesPerQuery: 10_000,
  defaultTimeoutMs: 20_000,
  maxTimeoutMs: 60_000,
}

const PRIORITY: Readonly<Record<SpatialQueryPriority, number>> = {
  critical: 0,
  interactive: 1,
  background: 2,
}

const CONTROL = /[\u0000-\u001f\u007f]/u

function finitePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function validSegment(value: string): boolean {
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 256 && !CONTROL.test(normalized)
}

function identityKey(identity: SpatialQueryIdentity): string | null {
  if (!validSegment(identity.layerId) || !validSegment(identity.operation) || !validSegment(identity.spatialKey)) {
    return null
  }
  return `${identity.layerId.trim()}\u001e${identity.operation.trim()}\u001e${identity.spatialKey.trim()}`
}

function clampTimeout(value: number | undefined, options: SpatialQueryBudgetOptions): number {
  if (value === undefined || !finitePositiveInteger(value)) return options.defaultTimeoutMs
  return Math.min(value, options.maxTimeoutMs)
}

function normalizeOptions(options: Partial<SpatialQueryBudgetOptions>): SpatialQueryBudgetOptions {
  const merged = { ...DEFAULTS, ...options }
  for (const [name, value] of Object.entries(merged)) {
    if (!finitePositiveInteger(value)) throw new Error(`Invalid spatial query budget: ${name}`)
  }
  if (merged.maxActivePerLayer > merged.maxActive) throw new Error('maxActivePerLayer exceeds maxActive')
  if (merged.maxQueuedPerLayer > merged.maxQueued) throw new Error('maxQueuedPerLayer exceeds maxQueued')
  if (merged.defaultTimeoutMs > merged.maxTimeoutMs) throw new Error('defaultTimeoutMs exceeds maxTimeoutMs')
  return Object.freeze(merged)
}

export class SpatialQueryBudgetRuntime {
  readonly #options: SpatialQueryBudgetOptions
  readonly #active = new Map<string, InternalRequest>()
  readonly #queued = new Map<string, InternalRequest>()
  readonly #generation = new Map<string, number>()
  #sequence = 0
  #turn = 0
  #activeBytes = 0
  #queuedBytes = 0
  #activeFeatures = 0
  #queuedFeatures = 0

  constructor(options: Partial<SpatialQueryBudgetOptions> = {}) {
    this.#options = normalizeOptions(options)
  }

  admit(request: SpatialQueryRequest): SpatialQueryAdmission {
    this.#turn += 1
    const key = identityKey(request)
    if (key === null) return { kind: 'rejected', reason: 'invalid-identity' }
    if (!finitePositiveInteger(request.estimatedBytes) || !finitePositiveInteger(request.estimatedFeatures)) {
      return { kind: 'rejected', reason: 'invalid-estimate' }
    }
    if (request.estimatedFeatures > this.#options.maxFeaturesPerQuery) {
      return { kind: 'rejected', reason: 'feature-budget' }
    }
    const existing = this.#active.get(key) ?? this.#queued.get(key)
    if (existing !== undefined) return { kind: 'duplicate', key, generation: existing.generation }
    const generation = (this.#generation.get(key) ?? 0) + 1
    this.#generation.set(key, generation)
    const internal: InternalRequest = {
      ...request,
      key,
      generation,
      sequence: ++this.#sequence,
      timeoutMsResolved: clampTimeout(request.timeoutMs, this.#options),
      enqueuedTurn: this.#turn,
    }
    if (this.#canActivate(internal)) {
      this.#activate(internal)
      return { kind: 'active', lease: this.#lease(internal) }
    }
    const rejection = this.#queueRejection(internal)
    if (rejection !== null) return { kind: 'rejected', reason: rejection }
    this.#queued.set(key, internal)
    this.#queuedBytes += internal.estimatedBytes
    this.#queuedFeatures += internal.estimatedFeatures
    return { kind: 'queued', queued: { key, generation, position: this.#orderedQueue().findIndex(item => item.key === key) + 1 } }
  }

  release(lease: Pick<SpatialQueryLease, 'key' | 'generation'>): readonly SpatialQueryPromotion[] {
    this.#turn += 1
    const active = this.#active.get(lease.key)
    if (active === undefined || active.generation !== lease.generation) return Object.freeze([])
    this.#removeActive(active)
    return this.#promote()
  }

  cancel(identity: SpatialQueryIdentity): readonly SpatialQueryPromotion[] {
    this.#turn += 1
    const key = identityKey(identity)
    if (key === null) return Object.freeze([])
    const active = this.#active.get(key)
    if (active !== undefined) {
      this.#removeActive(active)
      return this.#promote()
    }
    const queued = this.#queued.get(key)
    if (queued !== undefined) this.#removeQueued(queued)
    return Object.freeze([])
  }

  cancelLayer(layerId: string): readonly SpatialQueryPromotion[] {
    this.#turn += 1
    if (!validSegment(layerId)) return Object.freeze([])
    const normalized = layerId.trim()
    for (const request of [...this.#active.values()]) if (request.layerId.trim() === normalized) this.#removeActive(request)
    for (const request of [...this.#queued.values()]) if (request.layerId.trim() === normalized) this.#removeQueued(request)
    return this.#promote()
  }

  clear(): void {
    this.#turn += 1
    this.#active.clear()
    this.#queued.clear()
    this.#activeBytes = 0
    this.#queuedBytes = 0
    this.#activeFeatures = 0
    this.#queuedFeatures = 0
  }

  has(identity: SpatialQueryIdentity): boolean {
    const key = identityKey(identity)
    return key !== null && (this.#active.has(key) || this.#queued.has(key))
  }

  snapshot(): SpatialQuerySnapshot {
    const layerIds = new Set<string>()
    for (const request of this.#active.values()) layerIds.add(request.layerId.trim())
    for (const request of this.#queued.values()) layerIds.add(request.layerId.trim())
    const layers = [...layerIds].sort().map(layerId => {
      const active = [...this.#active.values()].filter(item => item.layerId.trim() === layerId)
      const queued = [...this.#queued.values()].filter(item => item.layerId.trim() === layerId)
      return Object.freeze({
        layerId,
        active: active.length,
        queued: queued.length,
        activeBytes: active.reduce((sum, item) => sum + item.estimatedBytes, 0),
        queuedBytes: queued.reduce((sum, item) => sum + item.estimatedBytes, 0),
      })
    })
    return Object.freeze({
      active: this.#active.size,
      queued: this.#queued.size,
      activeBytes: this.#activeBytes,
      queuedBytes: this.#queuedBytes,
      activeFeatures: this.#activeFeatures,
      queuedFeatures: this.#queuedFeatures,
      layers: Object.freeze(layers),
    })
  }

  queuedKeys(): readonly string[] {
    return Object.freeze(this.#orderedQueue().map(item => item.key))
  }

  #canActivate(request: InternalRequest): boolean {
    if (this.#active.size >= this.#options.maxActive) return false
    if (this.#activeBytes + request.estimatedBytes > this.#options.maxActiveBytes) return false
    let layerActive = 0
    for (const active of this.#active.values()) if (active.layerId.trim() === request.layerId.trim()) layerActive += 1
    return layerActive < this.#options.maxActivePerLayer
  }

  #queueRejection(request: InternalRequest): SpatialQueryRejectionReason | null {
    if (request.estimatedBytes > this.#options.maxActiveBytes) return 'active-byte-budget'
    if (this.#queued.size >= this.#options.maxQueued) return 'queue-budget'
    if (this.#queuedBytes + request.estimatedBytes > this.#options.maxQueuedBytes) return 'queue-byte-budget'
    let layerQueued = 0
    for (const queued of this.#queued.values()) if (queued.layerId.trim() === request.layerId.trim()) layerQueued += 1
    return layerQueued >= this.#options.maxQueuedPerLayer ? 'layer-queue-budget' : null
  }

  #activate(request: InternalRequest): void {
    this.#active.set(request.key, request)
    this.#activeBytes += request.estimatedBytes
    this.#activeFeatures += request.estimatedFeatures
  }

  #removeActive(request: InternalRequest): void {
    if (!this.#active.delete(request.key)) return
    this.#activeBytes -= request.estimatedBytes
    this.#activeFeatures -= request.estimatedFeatures
  }

  #removeQueued(request: InternalRequest): void {
    if (!this.#queued.delete(request.key)) return
    this.#queuedBytes -= request.estimatedBytes
    this.#queuedFeatures -= request.estimatedFeatures
  }

  #orderedQueue(): InternalRequest[] {
    return [...this.#queued.values()].sort((left, right) => {
      const priority = PRIORITY[left.priority] - PRIORITY[right.priority]
      return priority !== 0 ? priority : left.sequence - right.sequence
    })
  }

  #promote(): readonly SpatialQueryPromotion[] {
    const promoted: SpatialQueryPromotion[] = []
    let progressed = true
    while (progressed) {
      progressed = false
      for (const request of this.#orderedQueue()) {
        if (!this.#canActivate(request)) continue
        this.#removeQueued(request)
        this.#activate(request)
        promoted.push(Object.freeze({ lease: this.#lease(request), waitedTurns: Math.max(0, this.#turn - request.enqueuedTurn) }))
        progressed = true
        break
      }
    }
    return Object.freeze(promoted)
  }

  #lease(request: InternalRequest): SpatialQueryLease {
    return Object.freeze({
      key: request.key,
      generation: request.generation,
      layerId: request.layerId.trim(),
      estimatedBytes: request.estimatedBytes,
      estimatedFeatures: request.estimatedFeatures,
      timeoutMs: request.timeoutMsResolved,
    })
  }
}
