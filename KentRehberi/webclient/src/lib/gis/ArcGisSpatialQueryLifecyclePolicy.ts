export type ArcGisSpatialQueryIntent = 'interactive' | 'visible' | 'background'
export type ArcGisSpatialQueryPhase = 'queued' | 'running' | 'ready'

export interface ArcGisSpatialQueryBudget {
  maxQueries: number
  maxQueriesPerView: number
  maxRunning: number
  maxReady: number
  maxFeaturesPerQuery: number
  maxReadyFeatures: number
  maxBytesPerQuery: number
  maxReadyBytes: number
  queueTtlMs: number
  runTtlMs: number
  readyTtlMs: number
}

export interface ArcGisSpatialQueryRequest {
  viewId: string
  layerId: string
  queryId: string
  revision: number
  intent: ArcGisSpatialQueryIntent
  estimatedFeatures: number
  estimatedBytes: number
  requestedAt: number
}

export interface ArcGisSpatialQuerySnapshot extends ArcGisSpatialQueryRequest {
  phase: ArcGisSpatialQueryPhase
  expiresAt: number
  actualFeatures?: number
  actualBytes?: number
}

type Entry = ArcGisSpatialQuerySnapshot

const intentRank: Record<ArcGisSpatialQueryIntent, number> = { interactive: 0, visible: 1, background: 2 }
const idPattern = /^[A-Za-z0-9._:/-]{1,160}$/

export class ArcGisSpatialQueryLifecyclePolicy {
  readonly #budget: Readonly<ArcGisSpatialQueryBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #layerRevision = new Map<string, number>()
  #disposed = false

  constructor(budget: ArcGisSpatialQueryBudget) {
    this.#validateBudget(budget)
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(request: ArcGisSpatialQueryRequest): ArcGisSpatialQuerySnapshot {
    this.#assertActive()
    this.#validateRequest(request)
    this.expire(request.requestedAt)
    const key = this.#key(request)
    if (this.#entries.has(key)) throw new Error(`duplicate spatial query: ${request.queryId}`)
    if (this.#entries.size >= this.#budget.maxQueries) throw new Error('spatial query capacity exceeded')
    if (this.#count(entry => entry.viewId === request.viewId) >= this.#budget.maxQueriesPerView) throw new Error('view spatial query capacity exceeded')
    const watermark = this.#layerRevision.get(request.layerId) ?? request.revision
    if (request.revision < watermark) throw new Error('stale spatial query revision')
    this.#layerRevision.set(request.layerId, Math.max(watermark, request.revision))
    const entry: Entry = Object.freeze({ ...request, phase: 'queued', expiresAt: request.requestedAt + this.#budget.queueTtlMs })
    this.#entries.set(key, entry)
    return this.#detach(entry)
  }

  takeNext(now: number): ArcGisSpatialQuerySnapshot | undefined {
    this.#assertActive(); this.#finite(now, 'now'); this.expire(now)
    if (this.#count(entry => entry.phase === 'running') >= this.#budget.maxRunning) return undefined
    const queued = [...this.#entries.values()].filter(entry => entry.phase === 'queued')
    queued.sort((a, b) => intentRank[a.intent] - intentRank[b.intent] || a.requestedAt - b.requestedAt || a.queryId.localeCompare(b.queryId))
    const next = queued[0]
    if (!next) return undefined
    const running: Entry = Object.freeze({ ...next, phase: 'running', expiresAt: now + this.#budget.runTtlMs })
    this.#entries.set(this.#key(next), running)
    return this.#detach(running)
  }

  complete(query: Pick<ArcGisSpatialQueryRequest, 'viewId' | 'layerId' | 'queryId' | 'revision'>, actualFeatures: number, actualBytes: number, now: number): ArcGisSpatialQuerySnapshot {
    this.#assertActive(); this.#finite(now, 'now'); this.#natural(actualFeatures, 'actualFeatures'); this.#natural(actualBytes, 'actualBytes')
    const key = this.#key(query)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'running') throw new Error('spatial query is not running')
    if (entry.revision !== query.revision || query.revision < (this.#layerRevision.get(query.layerId) ?? query.revision)) { this.#entries.delete(key); throw new Error('stale spatial query completion') }
    if (now > entry.expiresAt) { this.#entries.delete(key); throw new Error('expired spatial query completion') }
    if (actualFeatures > this.#budget.maxFeaturesPerQuery || actualBytes > this.#budget.maxBytesPerQuery) { this.#entries.delete(key); throw new Error('spatial query result budget exceeded') }
    if (this.#count(item => item.phase === 'ready') >= this.#budget.maxReady) throw new Error('ready spatial query capacity exceeded')
    if (this.#readyFeatures() + actualFeatures > this.#budget.maxReadyFeatures) throw new Error('ready feature budget exceeded')
    if (this.#readyBytes() + actualBytes > this.#budget.maxReadyBytes) throw new Error('ready byte budget exceeded')
    const ready: Entry = Object.freeze({ ...entry, phase: 'ready', actualFeatures, actualBytes, expiresAt: now + this.#budget.readyTtlMs })
    this.#entries.set(key, ready)
    return this.#detach(ready)
  }

  advanceLayerRevision(layerId: string, revision: number): number {
    this.#assertActive(); this.#identifier(layerId, 'layerId'); this.#natural(revision, 'revision')
    const current = this.#layerRevision.get(layerId) ?? -1
    if (revision < current) throw new Error('layer revision cannot move backwards')
    this.#layerRevision.set(layerId, revision)
    return this.#release(entry => entry.layerId === layerId && entry.revision < revision)
  }

  touch(viewId: string, layerId: string, queryId: string, now: number): boolean {
    this.#assertActive(); this.#finite(now, 'now')
    const key = this.#key({ viewId, layerId, queryId })
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready' || now > entry.expiresAt) return false
    this.#entries.set(key, Object.freeze({ ...entry, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  consume(viewId: string, layerId: string, queryId: string): ArcGisSpatialQuerySnapshot | undefined {
    this.#assertActive()
    const key = this.#key({ viewId, layerId, queryId })
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready') return undefined
    this.#entries.delete(key)
    return this.#detach(entry)
  }

  cancel(viewId: string, layerId: string, queryId: string): boolean { this.#assertActive(); return this.#entries.delete(this.#key({ viewId, layerId, queryId })) }
  releaseView(viewId: string): number { this.#assertActive(); this.#identifier(viewId, 'viewId'); return this.#release(entry => entry.viewId === viewId) }
  releaseLayer(layerId: string): number { this.#assertActive(); this.#identifier(layerId, 'layerId'); this.#layerRevision.delete(layerId); return this.#release(entry => entry.layerId === layerId) }

  expire(now: number): number {
    this.#assertActive(); this.#finite(now, 'now')
    return this.#release(entry => now > entry.expiresAt)
  }

  snapshot(): readonly ArcGisSpatialQuerySnapshot[] {
    this.#assertActive()
    return Object.freeze([...this.#entries.values()].map(entry => this.#detach(entry)).sort((a, b) => a.viewId.localeCompare(b.viewId) || a.layerId.localeCompare(b.layerId) || a.queryId.localeCompare(b.queryId)))
  }

  fingerprint(): string {
    this.#assertActive()
    return this.snapshot().map(entry => [entry.viewId, entry.layerId, entry.queryId, entry.revision, entry.intent, entry.phase, entry.estimatedFeatures, entry.estimatedBytes, entry.actualFeatures ?? '-', entry.actualBytes ?? '-', entry.expiresAt].join(':')).join('|')
  }

  dispose(): void { this.#entries.clear(); this.#layerRevision.clear(); this.#disposed = true }

  #validateBudget(budget: ArcGisSpatialQueryBudget): void {
    for (const [name, value] of Object.entries(budget)) this.#positive(value, name)
    if (budget.maxQueriesPerView > budget.maxQueries || budget.maxRunning > budget.maxQueries || budget.maxReady > budget.maxQueries) throw new RangeError('spatial query cardinality budget is impossible')
    if (budget.maxFeaturesPerQuery > budget.maxReadyFeatures || budget.maxBytesPerQuery > budget.maxReadyBytes) throw new RangeError('spatial query residency budget is impossible')
  }

  #validateRequest(request: ArcGisSpatialQueryRequest): void {
    this.#identifier(request.viewId, 'viewId'); this.#identifier(request.layerId, 'layerId'); this.#identifier(request.queryId, 'queryId')
    this.#natural(request.revision, 'revision'); this.#positive(request.estimatedFeatures, 'estimatedFeatures'); this.#positive(request.estimatedBytes, 'estimatedBytes'); this.#finite(request.requestedAt, 'requestedAt')
    if (!(request.intent in intentRank)) throw new TypeError('invalid spatial query intent')
    if (request.estimatedFeatures > this.#budget.maxFeaturesPerQuery || request.estimatedBytes > this.#budget.maxBytesPerQuery) throw new RangeError('estimated spatial query result exceeds budget')
  }

  #key(value: Pick<ArcGisSpatialQueryRequest, 'viewId' | 'layerId' | 'queryId'>): string { return `${value.viewId}\u0000${value.layerId}\u0000${value.queryId}` }
  #readyFeatures(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualFeatures ?? 0; return total }
  #readyBytes(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualBytes ?? 0; return total }
  #count(predicate: (entry: Entry) => boolean): number { let total = 0; for (const entry of this.#entries.values()) if (predicate(entry)) total++; return total }
  #release(predicate: (entry: Entry) => boolean): number { let total = 0; for (const [key, entry] of this.#entries) if (predicate(entry)) { this.#entries.delete(key); total++ } return total }
  #detach(entry: Entry): ArcGisSpatialQuerySnapshot { return Object.freeze({ ...entry }) }
  #identifier(value: string, name: string): void { if (typeof value !== 'string' || !idPattern.test(value)) throw new TypeError(`${name} is invalid`) }
  #finite(value: number, name: string): void { if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`) }
  #natural(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`) }
  #positive(value: number, name: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`) }
  #assertActive(): void { if (this.#disposed) throw new Error('ArcGisSpatialQueryLifecyclePolicy is disposed') }
}
