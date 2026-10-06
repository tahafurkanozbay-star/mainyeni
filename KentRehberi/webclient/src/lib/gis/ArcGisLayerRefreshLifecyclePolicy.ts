export type ArcGisLayerRefreshIntent = 'prefetch' | 'background' | 'visible' | 'interactive'
export type ArcGisLayerRefreshPhase = 'queued' | 'running' | 'ready'

export interface ArcGisLayerRefreshBudget {
  maxLayers: number
  maxRequests: number
  maxRequestsPerLayer: number
  maxRunning: number
  maxReady: number
  maxEstimatedBytes: number
  maxEstimatedBytesPerRequest: number
  maxFeaturesPerRequest: number
  maxAggregateFeatures: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisLayerRefreshRequest {
  layerId: string
  refreshKey: string
  revision: number
  intent: ArcGisLayerRefreshIntent
  requestedAt: number
  estimatedBytes: number
  estimatedFeatures: number
  spatialReferenceWkid?: number
  minScale?: number
  maxScale?: number
}

export interface ArcGisLayerRefreshEntry extends ArcGisLayerRefreshRequest {
  phase: ArcGisLayerRefreshPhase
  sequence: number
  phaseStartedAt: number
  expiresAt: number
}

export interface ArcGisLayerRefreshSnapshot {
  layers: number
  requests: number
  queued: number
  running: number
  ready: number
  estimatedBytes: number
  estimatedFeatures: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const INTENT_WEIGHT: Readonly<Record<ArcGisLayerRefreshIntent, number>> = Object.freeze({
  prefetch: 0,
  background: 1,
  visible: 2,
  interactive: 3,
})

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}

function finite(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`)
}

function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) throw new Error(`${name} must contain 1..256 characters`)
  return normalized
}

function validateScale(name: string, value: number | undefined): void {
  if (value === undefined) return
  finite(name, value, 0)
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

/**
 * Metadata-only governance for ArcGIS layer refresh work.
 * Layer/LayerView/FeatureSet/Graphic/AbortController objects remain runtime-owned.
 * Keeping this registry payload-free makes cancellation and disposal deterministic
 * and prevents lifecycle bookkeeping from retaining SDK object graphs.
 */
export class ArcGisLayerRefreshLifecyclePolicy {
  readonly #budget: Readonly<ArcGisLayerRefreshBudget>
  readonly #entries = new Map<string, ArcGisLayerRefreshEntry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisLayerRefreshBudget) {
    integer('maxLayers', budget.maxLayers, 1)
    integer('maxRequests', budget.maxRequests, 1)
    integer('maxRequestsPerLayer', budget.maxRequestsPerLayer, 1)
    integer('maxRunning', budget.maxRunning, 1)
    integer('maxReady', budget.maxReady, 1)
    finite('maxEstimatedBytes', budget.maxEstimatedBytes, 1)
    finite('maxEstimatedBytesPerRequest', budget.maxEstimatedBytesPerRequest, 1)
    integer('maxFeaturesPerRequest', budget.maxFeaturesPerRequest, 1)
    integer('maxAggregateFeatures', budget.maxAggregateFeatures, 1)
    finite('queueTtlMs', budget.queueTtlMs, 1)
    finite('runLeaseMs', budget.runLeaseMs, 1)
    finite('readyTtlMs', budget.readyTtlMs, 1)
    if (budget.maxRequestsPerLayer > budget.maxRequests) throw new Error('maxRequestsPerLayer cannot exceed maxRequests')
    if (budget.maxRunning > budget.maxRequests) throw new Error('maxRunning cannot exceed maxRequests')
    if (budget.maxReady > budget.maxRequests) throw new Error('maxReady cannot exceed maxRequests')
    if (budget.maxEstimatedBytesPerRequest > budget.maxEstimatedBytes) throw new Error('per-request byte budget cannot exceed aggregate budget')
    if (budget.maxFeaturesPerRequest > budget.maxAggregateFeatures) throw new Error('per-request feature budget cannot exceed aggregate budget')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisLayerRefreshRequest): boolean {
    this.#active()
    const layerId = identifier('layerId', request.layerId)
    const refreshKey = identifier('refreshKey', request.refreshKey)
    integer('revision', request.revision, 0)
    finite('requestedAt', request.requestedAt, 0)
    finite('estimatedBytes', request.estimatedBytes, 0)
    integer('estimatedFeatures', request.estimatedFeatures, 0)
    if (request.spatialReferenceWkid !== undefined) integer('spatialReferenceWkid', request.spatialReferenceWkid, 1)
    validateScale('minScale', request.minScale)
    validateScale('maxScale', request.maxScale)
    if (request.minScale !== undefined && request.maxScale !== undefined && request.minScale > 0 && request.maxScale > 0 && request.minScale < request.maxScale) {
      throw new Error('minScale must be >= maxScale when both are non-zero ArcGIS scales')
    }
    if (request.estimatedBytes > this.#budget.maxEstimatedBytesPerRequest) return false
    if (request.estimatedFeatures > this.#budget.maxFeaturesPerRequest) return false

    const key = this.#key(layerId, refreshKey)
    const watermark = this.#revisions.get(key)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidate(layerId, refreshKey, request.revision)
    const existing = this.#entries.get(key)
    if (existing && existing.revision === request.revision && INTENT_WEIGHT[existing.intent] > INTENT_WEIGHT[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxRequests) return false
    if (!existing && this.#layerCount(layerId) >= this.#budget.maxRequestsPerLayer) return false
    if (!existing && !this.#hasLayer(layerId) && this.#layers() >= this.#budget.maxLayers) return false

    const bytes = this.#bytes() - (existing?.estimatedBytes ?? 0) + request.estimatedBytes
    const features = this.#features() - (existing?.estimatedFeatures ?? 0) + request.estimatedFeatures
    if (bytes > this.#budget.maxEstimatedBytes || features > this.#budget.maxAggregateFeatures) return false

    this.#entries.set(key, Object.freeze({
      ...request,
      layerId,
      refreshKey,
      phase: 'queued',
      sequence: existing?.sequence ?? this.#sequence++,
      phaseStartedAt: request.requestedAt,
      expiresAt: request.requestedAt + this.#budget.queueTtlMs,
    }))
    this.#revisions.set(key, request.revision)
    return true
  }

  next(now: number): Readonly<ArcGisLayerRefreshEntry> | null {
    this.#active()
    finite('now', now, 0)
    this.expire(now)
    if (this.#phaseCount('running') >= this.#budget.maxRunning) return null
    const candidate = [...this.#entries.values()]
      .filter(entry => entry.phase === 'queued')
      .sort((a, b) => INTENT_WEIGHT[b.intent] - INTENT_WEIGHT[a.intent] || a.sequence - b.sequence || a.refreshKey.localeCompare(b.refreshKey))[0]
    if (!candidate) return null
    const running = Object.freeze({ ...candidate, phase: 'running' as const, phaseStartedAt: now, expiresAt: now + this.#budget.runLeaseMs })
    this.#entries.set(this.#key(candidate.layerId, candidate.refreshKey), running)
    return running
  }

  complete(layerId: string, refreshKey: string, revision: number, now: number, actualBytes?: number, actualFeatures?: number): boolean {
    this.#active()
    integer('revision', revision, 0)
    finite('now', now, 0)
    const key = this.#key(identifier('layerId', layerId), identifier('refreshKey', refreshKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision || now > entry.expiresAt) return false
    const bytes = actualBytes ?? entry.estimatedBytes
    const features = actualFeatures ?? entry.estimatedFeatures
    finite('actualBytes', bytes, 0)
    integer('actualFeatures', features, 0)
    if (bytes > this.#budget.maxEstimatedBytesPerRequest || features > this.#budget.maxFeaturesPerRequest) return false
    const aggregateBytes = this.#bytes() - entry.estimatedBytes + bytes
    const aggregateFeatures = this.#features() - entry.estimatedFeatures + features
    if (aggregateBytes > this.#budget.maxEstimatedBytes || aggregateFeatures > this.#budget.maxAggregateFeatures) return false
    if (this.#phaseCount('ready') >= this.#budget.maxReady) return false
    this.#entries.set(key, Object.freeze({ ...entry, estimatedBytes: bytes, estimatedFeatures: features, phase: 'ready', phaseStartedAt: now, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  consume(layerId: string, refreshKey: string, revision: number): boolean {
    this.#active()
    integer('revision', revision, 0)
    const key = this.#key(identifier('layerId', layerId), identifier('refreshKey', refreshKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready' || entry.revision !== revision) return false
    return this.#entries.delete(key)
  }

  invalidate(layerId: string, refreshKey: string, revision: number): number {
    this.#active()
    const key = this.#key(identifier('layerId', layerId), identifier('refreshKey', refreshKey))
    integer('revision', revision, 0)
    const current = this.#revisions.get(key)
    if (current !== undefined && revision <= current) return 0
    const removed = this.#entries.delete(key) ? 1 : 0
    this.#revisions.set(key, revision)
    return removed
  }

  invalidateLayer(layerId: string, minimumRevision: number): number {
    this.#active()
    const layer = identifier('layerId', layerId)
    integer('minimumRevision', minimumRevision, 0)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId !== layer || entry.revision >= minimumRevision) continue
      this.#entries.delete(key)
      this.#revisions.set(key, minimumRevision)
      removed += 1
    }
    return removed
  }

  cancel(layerId: string, refreshKey: string): boolean {
    this.#active()
    return this.#entries.delete(this.#key(identifier('layerId', layerId), identifier('refreshKey', refreshKey)))
  }

  releaseLayer(layerId: string): number {
    this.#active()
    const layer = identifier('layerId', layerId)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId === layer) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    for (const key of [...this.#revisions.keys()]) if (key.startsWith(`${layer}\u0000`)) this.#revisions.delete(key)
    return removed
  }

  expire(now: number): number {
    this.#active()
    finite('now', now, 0)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (now > entry.expiresAt) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  entriesForLayer(layerId: string): readonly ArcGisLayerRefreshEntry[] {
    this.#active()
    const layer = identifier('layerId', layerId)
    return Object.freeze([...this.#entries.values()].filter(entry => entry.layerId === layer).sort((a, b) => INTENT_WEIGHT[b.intent] - INTENT_WEIGHT[a.intent] || a.sequence - b.sequence))
  }

  snapshot(): Readonly<ArcGisLayerRefreshSnapshot> {
    this.#active()
    const revisions = Object.fromEntries([...this.#revisions.entries()].sort(([a], [b]) => a.localeCompare(b)))
    const facts = [...this.#entries.values()]
      .sort((a, b) => a.layerId.localeCompare(b.layerId) || a.refreshKey.localeCompare(b.refreshKey))
      .map(entry => `${entry.layerId}:${entry.refreshKey}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.estimatedBytes}:${entry.estimatedFeatures}:${entry.spatialReferenceWkid ?? 0}:${entry.minScale ?? 0}:${entry.maxScale ?? 0}`)
      .join('|')
    return Object.freeze({
      layers: this.#layers(),
      requests: this.#entries.size,
      queued: this.#phaseCount('queued'),
      running: this.#phaseCount('running'),
      ready: this.#phaseCount('ready'),
      estimatedBytes: this.#bytes(),
      estimatedFeatures: this.#features(),
      revisionWatermark: Object.freeze(revisions),
      fingerprint: hash(facts),
    })
  }

  dispose(): void {
    this.#entries.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #key(layerId: string, refreshKey: string): string { return `${layerId}\u0000${refreshKey}` }
  #hasLayer(layerId: string): boolean { for (const entry of this.#entries.values()) if (entry.layerId === layerId) return true; return false }
  #layers(): number { return new Set([...this.#entries.values()].map(entry => entry.layerId)).size }
  #layerCount(layerId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.layerId === layerId) count += 1; return count }
  #phaseCount(phase: ArcGisLayerRefreshPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count += 1; return count }
  #bytes(): number { let total = 0; for (const entry of this.#entries.values()) total += entry.estimatedBytes; return total }
  #features(): number { let total = 0; for (const entry of this.#entries.values()) total += entry.estimatedFeatures; return total }
  #active(): void { if (this.#disposed) throw new Error('ArcGisLayerRefreshLifecyclePolicy is disposed') }
}
