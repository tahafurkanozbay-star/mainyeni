export type ArcGisFeaturePageIntent = 'prefetch' | 'visible' | 'interactive'
export type ArcGisFeaturePagePhase = 'queued' | 'running' | 'ready'

export interface ArcGisFeaturePageBudget {
  maxLayers: number
  maxPages: number
  maxPagesPerLayer: number
  maxRunning: number
  maxReady: number
  maxFeaturesPerPage: number
  maxAggregateFeatures: number
  maxBytesPerPage: number
  maxAggregateBytes: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisFeaturePageRequest {
  layerId: string
  queryKey: string
  offset: number
  revision: number
  intent: ArcGisFeaturePageIntent
  requestedAt: number
  estimatedFeatures: number
  estimatedBytes: number
  spatialReferenceWkid?: number
}

export interface ArcGisFeaturePageEntry extends ArcGisFeaturePageRequest {
  phase: ArcGisFeaturePagePhase
  sequence: number
  phaseStartedAt: number
  expiresAt: number
}

export interface ArcGisFeaturePageSnapshot {
  layers: number
  pages: number
  queued: number
  running: number
  ready: number
  estimatedFeatures: number
  estimatedBytes: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const INTENT_WEIGHT: Readonly<Record<ArcGisFeaturePageIntent, number>> = Object.freeze({ prefetch: 0, visible: 1, interactive: 2 })

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

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

/**
 * Payload-free governance for paged ArcGIS FeatureServer query work.
 * FeatureSet, Graphic, Geometry, Query and AbortController instances stay runtime-owned.
 * The policy tracks only bounded scheduling/accounting metadata so large result pages
 * cannot be accidentally retained by lifecycle bookkeeping.
 */
export class ArcGisFeaturePageLifecyclePolicy {
  readonly #budget: Readonly<ArcGisFeaturePageBudget>
  readonly #entries = new Map<string, ArcGisFeaturePageEntry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisFeaturePageBudget) {
    integer('maxLayers', budget.maxLayers, 1)
    integer('maxPages', budget.maxPages, 1)
    integer('maxPagesPerLayer', budget.maxPagesPerLayer, 1)
    integer('maxRunning', budget.maxRunning, 1)
    integer('maxReady', budget.maxReady, 1)
    integer('maxFeaturesPerPage', budget.maxFeaturesPerPage, 1)
    integer('maxAggregateFeatures', budget.maxAggregateFeatures, 1)
    finite('maxBytesPerPage', budget.maxBytesPerPage, 1)
    finite('maxAggregateBytes', budget.maxAggregateBytes, 1)
    finite('queueTtlMs', budget.queueTtlMs, 1)
    finite('runLeaseMs', budget.runLeaseMs, 1)
    finite('readyTtlMs', budget.readyTtlMs, 1)
    if (budget.maxPagesPerLayer > budget.maxPages) throw new Error('maxPagesPerLayer cannot exceed maxPages')
    if (budget.maxRunning > budget.maxPages) throw new Error('maxRunning cannot exceed maxPages')
    if (budget.maxReady > budget.maxPages) throw new Error('maxReady cannot exceed maxPages')
    if (budget.maxFeaturesPerPage > budget.maxAggregateFeatures) throw new Error('per-page feature budget cannot exceed aggregate budget')
    if (budget.maxBytesPerPage > budget.maxAggregateBytes) throw new Error('per-page byte budget cannot exceed aggregate budget')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisFeaturePageRequest): boolean {
    this.#active()
    const layerId = identifier('layerId', request.layerId)
    const queryKey = identifier('queryKey', request.queryKey)
    integer('offset', request.offset, 0)
    integer('revision', request.revision, 0)
    finite('requestedAt', request.requestedAt, 0)
    integer('estimatedFeatures', request.estimatedFeatures, 0)
    finite('estimatedBytes', request.estimatedBytes, 0)
    if (request.spatialReferenceWkid !== undefined) integer('spatialReferenceWkid', request.spatialReferenceWkid, 1)
    if (request.estimatedFeatures > this.#budget.maxFeaturesPerPage || request.estimatedBytes > this.#budget.maxBytesPerPage) return false

    const family = this.#family(layerId, queryKey)
    const watermark = this.#revisions.get(family)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidateQuery(layerId, queryKey, request.revision)
    const key = this.#key(layerId, queryKey, request.offset)
    const existing = this.#entries.get(key)
    if (existing && existing.revision === request.revision && INTENT_WEIGHT[existing.intent] > INTENT_WEIGHT[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxPages) return false
    if (!existing && this.#layerCount(layerId) >= this.#budget.maxPagesPerLayer) return false
    if (!existing && !this.#hasLayer(layerId) && this.#layers() >= this.#budget.maxLayers) return false
    const features = this.#features() - (existing?.estimatedFeatures ?? 0) + request.estimatedFeatures
    const bytes = this.#bytes() - (existing?.estimatedBytes ?? 0) + request.estimatedBytes
    if (features > this.#budget.maxAggregateFeatures || bytes > this.#budget.maxAggregateBytes) return false

    this.#entries.set(key, Object.freeze({ ...request, layerId, queryKey, phase: 'queued', sequence: existing?.sequence ?? this.#sequence++, phaseStartedAt: request.requestedAt, expiresAt: request.requestedAt + this.#budget.queueTtlMs }))
    this.#revisions.set(family, request.revision)
    return true
  }

  next(now: number): Readonly<ArcGisFeaturePageEntry> | null {
    this.#active(); finite('now', now, 0); this.expire(now)
    if (this.#phaseCount('running') >= this.#budget.maxRunning) return null
    const candidate = [...this.#entries.values()].filter(entry => entry.phase === 'queued').sort((a, b) => INTENT_WEIGHT[b.intent] - INTENT_WEIGHT[a.intent] || a.sequence - b.sequence || a.offset - b.offset)[0]
    if (!candidate) return null
    const running = Object.freeze({ ...candidate, phase: 'running' as const, phaseStartedAt: now, expiresAt: now + this.#budget.runLeaseMs })
    this.#entries.set(this.#key(candidate.layerId, candidate.queryKey, candidate.offset), running)
    return running
  }

  complete(layerId: string, queryKey: string, offset: number, revision: number, now: number, actualFeatures?: number, actualBytes?: number): boolean {
    this.#active(); integer('offset', offset, 0); integer('revision', revision, 0); finite('now', now, 0)
    const key = this.#key(identifier('layerId', layerId), identifier('queryKey', queryKey), offset)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision || now > entry.expiresAt) return false
    const features = actualFeatures ?? entry.estimatedFeatures
    const bytes = actualBytes ?? entry.estimatedBytes
    integer('actualFeatures', features, 0); finite('actualBytes', bytes, 0)
    if (features > this.#budget.maxFeaturesPerPage || bytes > this.#budget.maxBytesPerPage) return false
    if (this.#features() - entry.estimatedFeatures + features > this.#budget.maxAggregateFeatures) return false
    if (this.#bytes() - entry.estimatedBytes + bytes > this.#budget.maxAggregateBytes) return false
    if (this.#phaseCount('ready') >= this.#budget.maxReady) return false
    this.#entries.set(key, Object.freeze({ ...entry, estimatedFeatures: features, estimatedBytes: bytes, phase: 'ready', phaseStartedAt: now, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  consume(layerId: string, queryKey: string, offset: number, revision: number): boolean {
    this.#active(); integer('offset', offset, 0); integer('revision', revision, 0)
    const key = this.#key(identifier('layerId', layerId), identifier('queryKey', queryKey), offset)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready' || entry.revision !== revision) return false
    return this.#entries.delete(key)
  }

  invalidateQuery(layerId: string, queryKey: string, revision: number): number {
    this.#active(); const layer = identifier('layerId', layerId); const query = identifier('queryKey', queryKey); integer('revision', revision, 0)
    const family = this.#family(layer, query)
    const current = this.#revisions.get(family)
    if (current !== undefined && revision <= current) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer && entry.queryKey === query && entry.revision < revision) { this.#entries.delete(key); removed += 1 }
    this.#revisions.set(family, revision)
    return removed
  }

  cancel(layerId: string, queryKey: string, offset: number): boolean {
    this.#active(); integer('offset', offset, 0)
    return this.#entries.delete(this.#key(identifier('layerId', layerId), identifier('queryKey', queryKey), offset))
  }

  releaseLayer(layerId: string): number {
    this.#active(); const layer = identifier('layerId', layerId); let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer) { this.#entries.delete(key); removed += 1 }
    for (const key of [...this.#revisions.keys()]) if (key.startsWith(`${layer}\u0000`)) this.#revisions.delete(key)
    return removed
  }

  expire(now: number): number {
    this.#active(); finite('now', now, 0); let removed = 0
    for (const [key, entry] of this.#entries) if (now > entry.expiresAt) { this.#entries.delete(key); removed += 1 }
    return removed
  }

  entriesForQuery(layerId: string, queryKey: string): readonly ArcGisFeaturePageEntry[] {
    this.#active(); const layer = identifier('layerId', layerId); const query = identifier('queryKey', queryKey)
    return Object.freeze([...this.#entries.values()].filter(entry => entry.layerId === layer && entry.queryKey === query).sort((a, b) => a.offset - b.offset || a.sequence - b.sequence))
  }

  snapshot(): Readonly<ArcGisFeaturePageSnapshot> {
    this.#active()
    const revisions = Object.fromEntries([...this.#revisions.entries()].sort(([a], [b]) => a.localeCompare(b)))
    const facts = [...this.#entries.values()].sort((a, b) => a.layerId.localeCompare(b.layerId) || a.queryKey.localeCompare(b.queryKey) || a.offset - b.offset).map(entry => `${entry.layerId}:${entry.queryKey}:${entry.offset}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.estimatedFeatures}:${entry.estimatedBytes}:${entry.spatialReferenceWkid ?? 0}`).join('|')
    return Object.freeze({ layers: this.#layers(), pages: this.#entries.size, queued: this.#phaseCount('queued'), running: this.#phaseCount('running'), ready: this.#phaseCount('ready'), estimatedFeatures: this.#features(), estimatedBytes: this.#bytes(), revisionWatermark: Object.freeze(revisions), fingerprint: hash(facts) })
  }

  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }
  #family(layerId: string, queryKey: string): string { return `${layerId}\u0000${queryKey}` }
  #key(layerId: string, queryKey: string, offset: number): string { return `${this.#family(layerId, queryKey)}\u0000${offset}` }
  #hasLayer(layerId: string): boolean { for (const entry of this.#entries.values()) if (entry.layerId === layerId) return true; return false }
  #layers(): number { return new Set([...this.#entries.values()].map(entry => entry.layerId)).size }
  #layerCount(layerId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.layerId === layerId) count += 1; return count }
  #phaseCount(phase: ArcGisFeaturePagePhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count += 1; return count }
  #features(): number { let total = 0; for (const entry of this.#entries.values()) total += entry.estimatedFeatures; return total }
  #bytes(): number { let total = 0; for (const entry of this.#entries.values()) total += entry.estimatedBytes; return total }
  #active(): void { if (this.#disposed) throw new Error('ArcGisFeaturePageLifecyclePolicy is disposed') }
}
