export type QueryCacheIntent = 'interactive' | 'visible' | 'background'

export interface QueryResponseCacheBudget {
  maxLayers: number
  maxEntries: number
  maxEntriesPerLayer: number
  maxFeaturesPerEntry: number
  maxBytesPerEntry: number
  maxResidentFeatures: number
  maxResidentBytes: number
  ttlMs: number
}

export interface QueryResponseCacheRequest {
  cacheKey: string
  layerId: string
  revision: number
  intent: QueryCacheIntent
  featureCount: number
  byteCount: number
  storedAt: number
  signature: string
}

export interface QueryResponseCacheView extends QueryResponseCacheRequest {
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

export interface QueryResponseCacheSnapshot {
  readonly layers: number
  readonly entries: number
  readonly residentFeatures: number
  readonly residentBytes: number
}

interface CacheEntry extends QueryResponseCacheRequest {
  sequence: number
  touchedAt: number
  expiresAt: number
}

const intentRank: Readonly<Record<QueryCacheIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const intents: readonly QueryCacheIntent[] = ['interactive', 'visible', 'background']

function identifier(name: string, value: string, max = 256): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
}

function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
}

function clock(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

/**
 * Payload-free authority for ArcGIS REST query-response cache residency.
 *
 * The cache payload itself intentionally remains owned by the caller. This policy stores only
 * bounded scalar metadata needed to decide whether a response may remain resident. Geometry,
 * Graphic, FeatureSet, Query, AbortSignal, credentials, response JSON and binary buffers must
 * never be attached to this authority. A caller can use cacheKey + signature to address its
 * separately managed payload and must drop that payload whenever this authority evicts/rejects it.
 */
export class ArcGisQueryResponseCacheLifecyclePolicy {
  readonly #budget: Readonly<QueryResponseCacheBudget>
  readonly #entries = new Map<string, CacheEntry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: QueryResponseCacheBudget) {
    for (const key of ['maxLayers','maxEntries','maxEntriesPerLayer','maxFeaturesPerEntry','maxBytesPerEntry','maxResidentFeatures','maxResidentBytes'] as const) positiveInteger(key, budget[key])
    clock('ttlMs', budget.ttlMs)
    if (budget.ttlMs === 0) throw new Error('ttlMs must be positive')
    if (budget.maxEntriesPerLayer > budget.maxEntries) throw new Error('maxEntriesPerLayer cannot exceed maxEntries')
    if (budget.maxResidentFeatures < budget.maxFeaturesPerEntry) throw new Error('maxResidentFeatures cannot be smaller than maxFeaturesPerEntry')
    if (budget.maxResidentBytes < budget.maxBytesPerEntry) throw new Error('maxResidentBytes cannot be smaller than maxBytesPerEntry')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#assertLive()
    const layer = identifier('layerId', layerId)
    nonNegativeInteger('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === revision) return 0
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) throw new Error('maxLayers exceeded')
    this.#revisions.set(layer, revision)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId === layer && entry.revision !== revision) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  admit(request: QueryResponseCacheRequest): QueryResponseCacheView | null {
    this.#assertLive()
    const normalized = this.#normalize(request)
    if (this.#revisions.get(normalized.layerId) !== normalized.revision) return null
    if (normalized.featureCount > this.#budget.maxFeaturesPerEntry || normalized.byteCount > this.#budget.maxBytesPerEntry) return null

    const existing = this.#entries.get(normalized.cacheKey)
    if (existing) {
      if (existing.layerId !== normalized.layerId || existing.revision !== normalized.revision || existing.signature !== normalized.signature) return null
      existing.touchedAt = normalized.storedAt
      existing.expiresAt = normalized.storedAt + this.#budget.ttlMs
      return this.#view(existing)
    }

    const sameLogical = [...this.#entries.values()].find(entry =>
      entry.layerId === normalized.layerId &&
      entry.revision === normalized.revision &&
      entry.signature === normalized.signature,
    )
    if (sameLogical) {
      sameLogical.touchedAt = normalized.storedAt
      sameLogical.expiresAt = normalized.storedAt + this.#budget.ttlMs
      return this.#view(sameLogical)
    }

    if (this.#layerCount(normalized.layerId) >= this.#budget.maxEntriesPerLayer) {
      if (!this.#evictOne(normalized.intent, normalized.layerId)) return null
    }
    if (this.#entries.size >= this.#budget.maxEntries) {
      if (!this.#evictOne(normalized.intent)) return null
    }

    const entry: CacheEntry = {
      ...normalized,
      sequence: ++this.#sequence,
      touchedAt: normalized.storedAt,
      expiresAt: normalized.storedAt + this.#budget.ttlMs,
    }
    this.#entries.set(entry.cacheKey, entry)
    if (!this.#relievePressure(entry)) {
      this.#entries.delete(entry.cacheKey)
      return null
    }
    return this.#view(entry)
  }

  get(cacheKey: string, revision: number, now: number): QueryResponseCacheView | null {
    this.#assertLive()
    const key = identifier('cacheKey', cacheKey)
    nonNegativeInteger('revision', revision)
    clock('now', now)
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return null
    if (now >= entry.expiresAt) {
      this.#entries.delete(key)
      return null
    }
    return this.#view(entry)
  }

  touch(cacheKey: string, revision: number, now: number): boolean {
    this.#assertLive()
    const key = identifier('cacheKey', cacheKey)
    nonNegativeInteger('revision', revision)
    clock('now', now)
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision || now >= entry.expiresAt) return false
    entry.touchedAt = now
    entry.expiresAt = now + this.#budget.ttlMs
    return true
  }

  invalidate(cacheKey: string): boolean {
    this.#assertLive()
    return this.#entries.delete(identifier('cacheKey', cacheKey))
  }

  releaseLayer(layerId: string): number {
    this.#assertLive()
    const layer = identifier('layerId', layerId)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId === layer) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    this.#revisions.delete(layer)
    return removed
  }

  expire(now: number): number {
    this.#assertLive()
    clock('now', now)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (now >= entry.expiresAt) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  snapshot(): QueryResponseCacheSnapshot {
    this.#assertLive()
    let residentFeatures = 0
    let residentBytes = 0
    for (const entry of this.#entries.values()) {
      residentFeatures += entry.featureCount
      residentBytes += entry.byteCount
    }
    return Object.freeze({ layers: this.#revisions.size, entries: this.#entries.size, residentFeatures, residentBytes })
  }

  fingerprint(): string {
    this.#assertLive()
    return [...this.#entries.values()]
      .sort((a, b) => a.layerId.localeCompare(b.layerId) || a.cacheKey.localeCompare(b.cacheKey))
      .map(entry => `${entry.layerId}:${entry.cacheKey}:${entry.revision}:${entry.intent}:${entry.featureCount}:${entry.byteCount}:${entry.signature}`)
      .join('|')
  }

  dispose(): void {
    if (this.#disposed) return
    this.#entries.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #normalize(request: QueryResponseCacheRequest): QueryResponseCacheRequest {
    const cacheKey = identifier('cacheKey', request.cacheKey)
    const layerId = identifier('layerId', request.layerId)
    const signature = identifier('signature', request.signature, 512)
    nonNegativeInteger('revision', request.revision)
    nonNegativeInteger('featureCount', request.featureCount)
    nonNegativeInteger('byteCount', request.byteCount)
    clock('storedAt', request.storedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    return { ...request, cacheKey, layerId, signature }
  }

  #layerCount(layerId: string): number {
    let count = 0
    for (const entry of this.#entries.values()) if (entry.layerId === layerId) count += 1
    return count
  }

  #totals(): { features: number; bytes: number } {
    let features = 0
    let bytes = 0
    for (const entry of this.#entries.values()) {
      features += entry.featureCount
      bytes += entry.byteCount
    }
    return { features, bytes }
  }

  #relievePressure(protectedEntry: CacheEntry): boolean {
    for (;;) {
      const totals = this.#totals()
      if (totals.features <= this.#budget.maxResidentFeatures && totals.bytes <= this.#budget.maxResidentBytes) return true
      const candidate = this.#evictionCandidate(protectedEntry.intent, undefined, protectedEntry.cacheKey)
      if (!candidate) return false
      this.#entries.delete(candidate.cacheKey)
    }
  }

  #evictOne(incomingIntent: QueryCacheIntent, layerId?: string): boolean {
    const candidate = this.#evictionCandidate(incomingIntent, layerId)
    if (!candidate) return false
    this.#entries.delete(candidate.cacheKey)
    return true
  }

  #evictionCandidate(incomingIntent: QueryCacheIntent, layerId?: string, protectedKey?: string): CacheEntry | null {
    const candidates = [...this.#entries.values()].filter(entry =>
      entry.cacheKey !== protectedKey &&
      (layerId === undefined || entry.layerId === layerId) &&
      intentRank[entry.intent] <= intentRank[incomingIntent],
    )
    candidates.sort((a, b) =>
      intentRank[a.intent] - intentRank[b.intent] ||
      a.touchedAt - b.touchedAt ||
      a.sequence - b.sequence ||
      a.cacheKey.localeCompare(b.cacheKey),
    )
    return candidates[0] ?? null
  }

  #view(entry: CacheEntry): QueryResponseCacheView {
    return Object.freeze({
      cacheKey: entry.cacheKey,
      layerId: entry.layerId,
      revision: entry.revision,
      intent: entry.intent,
      featureCount: entry.featureCount,
      byteCount: entry.byteCount,
      storedAt: entry.storedAt,
      signature: entry.signature,
      sequence: entry.sequence,
      touchedAt: entry.touchedAt,
      expiresAt: entry.expiresAt,
    })
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('ArcGisQueryResponseCacheLifecyclePolicy is disposed')
  }
}
