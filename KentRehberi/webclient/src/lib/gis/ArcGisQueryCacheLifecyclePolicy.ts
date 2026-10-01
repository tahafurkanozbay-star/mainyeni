export type ArcGisQueryCacheIntent = 'prefetch' | 'background' | 'visible' | 'interactive'
export type ArcGisQueryCachePhase = 'queued' | 'running' | 'ready'

export interface ArcGisQueryCacheBudget {
  maxServices: number
  maxEntries: number
  maxEntriesPerService: number
  maxRunning: number
  maxReady: number
  maxEstimatedBytes: number
  maxEstimatedBytesPerEntry: number
  maxFeaturesPerEntry: number
  maxAggregateFeatures: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisQueryCacheRequest {
  serviceId: string
  queryKey: string
  revision: number
  intent: ArcGisQueryCacheIntent
  requestedAt: number
  estimatedBytes: number
  estimatedFeatures: number
  spatialReferenceWkid?: number
}

export interface ArcGisQueryCacheEntry extends ArcGisQueryCacheRequest {
  phase: ArcGisQueryCachePhase
  sequence: number
  phaseStartedAt: number
  expiresAt: number
}

export interface ArcGisQueryCacheSnapshot {
  services: number
  entries: number
  queued: number
  running: number
  ready: number
  estimatedBytes: number
  estimatedFeatures: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const INTENT_WEIGHT: Readonly<Record<ArcGisQueryCacheIntent, number>> = Object.freeze({ prefetch: 0, background: 1, visible: 2, interactive: 3 })

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}

function finite(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`)
}

function id(name: string, value: string): string {
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
 * Metadata-only governance for ArcGIS REST query work and cache residency.
 * FeatureSet/Graphic/Geometry/AbortController objects deliberately remain owned by
 * the runtime adapter; this policy only tracks bounded accounting metadata.
 */
export class ArcGisQueryCacheLifecyclePolicy {
  readonly #budget: Readonly<ArcGisQueryCacheBudget>
  readonly #entries = new Map<string, ArcGisQueryCacheEntry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisQueryCacheBudget) {
    integer('maxServices', budget.maxServices, 1)
    integer('maxEntries', budget.maxEntries, 1)
    integer('maxEntriesPerService', budget.maxEntriesPerService, 1)
    integer('maxRunning', budget.maxRunning, 1)
    integer('maxReady', budget.maxReady, 1)
    finite('maxEstimatedBytes', budget.maxEstimatedBytes, 1)
    finite('maxEstimatedBytesPerEntry', budget.maxEstimatedBytesPerEntry, 1)
    integer('maxFeaturesPerEntry', budget.maxFeaturesPerEntry, 1)
    integer('maxAggregateFeatures', budget.maxAggregateFeatures, 1)
    finite('queueTtlMs', budget.queueTtlMs, 1)
    finite('runLeaseMs', budget.runLeaseMs, 1)
    finite('readyTtlMs', budget.readyTtlMs, 1)
    if (budget.maxEntriesPerService > budget.maxEntries) throw new Error('maxEntriesPerService cannot exceed maxEntries')
    if (budget.maxRunning > budget.maxEntries) throw new Error('maxRunning cannot exceed maxEntries')
    if (budget.maxReady > budget.maxEntries) throw new Error('maxReady cannot exceed maxEntries')
    if (budget.maxEstimatedBytesPerEntry > budget.maxEstimatedBytes) throw new Error('per-entry byte budget cannot exceed aggregate budget')
    if (budget.maxFeaturesPerEntry > budget.maxAggregateFeatures) throw new Error('per-entry feature budget cannot exceed aggregate budget')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisQueryCacheRequest): boolean {
    this.#active()
    const serviceId = id('serviceId', request.serviceId)
    const queryKey = id('queryKey', request.queryKey)
    integer('revision', request.revision, 0)
    finite('requestedAt', request.requestedAt, 0)
    finite('estimatedBytes', request.estimatedBytes, 0)
    integer('estimatedFeatures', request.estimatedFeatures, 0)
    if (request.spatialReferenceWkid !== undefined) integer('spatialReferenceWkid', request.spatialReferenceWkid, 1)
    if (request.estimatedBytes > this.#budget.maxEstimatedBytesPerEntry) return false
    if (request.estimatedFeatures > this.#budget.maxFeaturesPerEntry) return false

    const key = this.#key(serviceId, queryKey)
    const watermark = this.#revisions.get(key)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidate(serviceId, queryKey, request.revision)
    const existing = this.#entries.get(key)
    if (existing && existing.revision === request.revision && INTENT_WEIGHT[existing.intent] > INTENT_WEIGHT[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxEntries) return false
    if (!existing && this.#serviceCount(serviceId) >= this.#budget.maxEntriesPerService) return false
    if (!existing && !this.#hasService(serviceId) && this.#services() >= this.#budget.maxServices) return false

    const bytes = this.#bytes() - (existing?.estimatedBytes ?? 0) + request.estimatedBytes
    const features = this.#features() - (existing?.estimatedFeatures ?? 0) + request.estimatedFeatures
    if (bytes > this.#budget.maxEstimatedBytes || features > this.#budget.maxAggregateFeatures) return false

    this.#entries.set(key, Object.freeze({
      ...request,
      serviceId,
      queryKey,
      phase: 'queued',
      sequence: existing?.sequence ?? this.#sequence++,
      phaseStartedAt: request.requestedAt,
      expiresAt: request.requestedAt + this.#budget.queueTtlMs,
    }))
    this.#revisions.set(key, request.revision)
    return true
  }

  next(now: number): Readonly<ArcGisQueryCacheEntry> | null {
    this.#active()
    finite('now', now, 0)
    this.expire(now)
    if (this.#phaseCount('running') >= this.#budget.maxRunning) return null
    const candidate = [...this.#entries.values()]
      .filter(entry => entry.phase === 'queued')
      .sort((a, b) => INTENT_WEIGHT[b.intent] - INTENT_WEIGHT[a.intent] || a.sequence - b.sequence || a.queryKey.localeCompare(b.queryKey))[0]
    if (!candidate) return null
    const running = Object.freeze({ ...candidate, phase: 'running' as const, phaseStartedAt: now, expiresAt: now + this.#budget.runLeaseMs })
    this.#entries.set(this.#key(candidate.serviceId, candidate.queryKey), running)
    return running
  }

  complete(serviceId: string, queryKey: string, revision: number, now: number, actualBytes?: number, actualFeatures?: number): boolean {
    this.#active()
    integer('revision', revision, 0)
    finite('now', now, 0)
    const key = this.#key(id('serviceId', serviceId), id('queryKey', queryKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision || now > entry.expiresAt) return false
    const bytes = actualBytes ?? entry.estimatedBytes
    const features = actualFeatures ?? entry.estimatedFeatures
    finite('actualBytes', bytes, 0)
    integer('actualFeatures', features, 0)
    if (bytes > this.#budget.maxEstimatedBytesPerEntry || features > this.#budget.maxFeaturesPerEntry) return false
    const aggregateBytes = this.#bytes() - entry.estimatedBytes + bytes
    const aggregateFeatures = this.#features() - entry.estimatedFeatures + features
    if (aggregateBytes > this.#budget.maxEstimatedBytes || aggregateFeatures > this.#budget.maxAggregateFeatures) return false
    if (this.#phaseCount('ready') >= this.#budget.maxReady) return false
    this.#entries.set(key, Object.freeze({ ...entry, estimatedBytes: bytes, estimatedFeatures: features, phase: 'ready', phaseStartedAt: now, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  touch(serviceId: string, queryKey: string, now: number): boolean {
    this.#active()
    finite('now', now, 0)
    const key = this.#key(id('serviceId', serviceId), id('queryKey', queryKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready' || now > entry.expiresAt) return false
    this.#entries.set(key, Object.freeze({ ...entry, phaseStartedAt: now, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  invalidate(serviceId: string, queryKey: string, revision: number): number {
    this.#active()
    const key = this.#key(id('serviceId', serviceId), id('queryKey', queryKey))
    integer('revision', revision, 0)
    const current = this.#revisions.get(key)
    if (current !== undefined && revision <= current) return 0
    const removed = this.#entries.delete(key) ? 1 : 0
    this.#revisions.set(key, revision)
    return removed
  }

  invalidateService(serviceId: string, minimumRevision: number): number {
    this.#active()
    const service = id('serviceId', serviceId)
    integer('minimumRevision', minimumRevision, 0)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.serviceId !== service || entry.revision >= minimumRevision) continue
      this.#entries.delete(key)
      this.#revisions.set(key, minimumRevision)
      removed += 1
    }
    return removed
  }

  cancel(serviceId: string, queryKey: string): boolean {
    this.#active()
    return this.#entries.delete(this.#key(id('serviceId', serviceId), id('queryKey', queryKey)))
  }

  releaseService(serviceId: string): number {
    this.#active()
    const service = id('serviceId', serviceId)
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.serviceId === service) { this.#entries.delete(key); removed += 1 }
    for (const key of [...this.#revisions.keys()]) if (key.startsWith(`${service}\u0000`)) this.#revisions.delete(key)
    return removed
  }

  expire(now: number): number {
    this.#active()
    finite('now', now, 0)
    let removed = 0
    for (const [key, entry] of this.#entries) if (now > entry.expiresAt) { this.#entries.delete(key); removed += 1 }
    return removed
  }

  entriesForService(serviceId: string): readonly ArcGisQueryCacheEntry[] {
    this.#active()
    const service = id('serviceId', serviceId)
    return Object.freeze([...this.#entries.values()].filter(entry => entry.serviceId === service).sort((a, b) => INTENT_WEIGHT[b.intent] - INTENT_WEIGHT[a.intent] || a.sequence - b.sequence))
  }

  snapshot(): Readonly<ArcGisQueryCacheSnapshot> {
    this.#active()
    const revisions = Object.fromEntries([...this.#revisions.entries()].sort(([a], [b]) => a.localeCompare(b)))
    const facts = [...this.#entries.values()].sort((a, b) => a.serviceId.localeCompare(b.serviceId) || a.queryKey.localeCompare(b.queryKey)).map(entry => `${entry.serviceId}:${entry.queryKey}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.estimatedBytes}:${entry.estimatedFeatures}:${entry.spatialReferenceWkid ?? 0}`).join('|')
    return Object.freeze({ services: this.#services(), entries: this.#entries.size, queued: this.#phaseCount('queued'), running: this.#phaseCount('running'), ready: this.#phaseCount('ready'), estimatedBytes: this.#bytes(), estimatedFeatures: this.#features(), revisionWatermark: Object.freeze(revisions), fingerprint: hash(facts) })
  }

  dispose(): void {
    this.#entries.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #key(serviceId: string, queryKey: string): string { return `${serviceId}\u0000${queryKey}` }
  #hasService(serviceId: string): boolean { for (const entry of this.#entries.values()) if (entry.serviceId === serviceId) return true; return false }
  #services(): number { return new Set([...this.#entries.values()].map(entry => entry.serviceId)).size }
  #serviceCount(serviceId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.serviceId === serviceId) count += 1; return count }
  #phaseCount(phase: ArcGisQueryCachePhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count += 1; return count }
  #bytes(): number { let total = 0; for (const entry of this.#entries.values()) total += entry.estimatedBytes; return total }
  #features(): number { let total = 0; for (const entry of this.#entries.values()) total += entry.estimatedFeatures; return total }
  #active(): void { if (this.#disposed) throw new Error('ArcGisQueryCacheLifecyclePolicy is disposed') }
}
