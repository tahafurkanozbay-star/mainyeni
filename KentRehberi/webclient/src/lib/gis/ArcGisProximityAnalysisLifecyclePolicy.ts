export type ArcGisProximityIntent = 'interactive' | 'selection' | 'background'
export type ArcGisProximityPhase = 'queued' | 'running' | 'ready'

export interface ArcGisProximityBudget {
  maxAnalyses: number
  maxAnalysesPerView: number
  maxRunning: number
  maxReady: number
  maxCandidatesPerAnalysis: number
  maxReadyCandidates: number
  maxVerticesPerAnalysis: number
  maxReadyVertices: number
  maxBytesPerAnalysis: number
  maxReadyBytes: number
  queueTtlMs: number
  runTtlMs: number
  readyTtlMs: number
}

export interface ArcGisProximityRequest {
  viewId: string
  layerId: string
  analysisId: string
  revision: number
  intent: ArcGisProximityIntent
  estimatedCandidates: number
  estimatedVertices: number
  estimatedBytes: number
  requestedAt: number
}

export interface ArcGisProximitySnapshot extends ArcGisProximityRequest {
  phase: ArcGisProximityPhase
  expiresAt: number
  actualCandidates?: number
  actualVertices?: number
  actualBytes?: number
}

type Entry = ArcGisProximitySnapshot
const intentRank: Record<ArcGisProximityIntent, number> = { interactive: 0, selection: 1, background: 2 }
const idPattern = /^[A-Za-z0-9._:/-]{1,160}$/

/**
 * Payload-free authority for buffer/nearest/proximity CPU work. Geometry, Graphic,
 * FeatureSet, workers and AbortControllers remain owned by the execution adapter.
 */
export class ArcGisProximityAnalysisLifecyclePolicy {
  readonly #budget: Readonly<ArcGisProximityBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #layerRevision = new Map<string, number>()
  #disposed = false

  constructor(budget: ArcGisProximityBudget) {
    this.#validateBudget(budget)
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(request: ArcGisProximityRequest): ArcGisProximitySnapshot {
    this.#assertActive(); this.#validateRequest(request); this.expire(request.requestedAt)
    const key = this.#key(request)
    if (this.#entries.has(key)) throw new Error(`duplicate proximity analysis: ${request.analysisId}`)
    if (this.#entries.size >= this.#budget.maxAnalyses) throw new Error('proximity analysis capacity exceeded')
    if (this.#count(entry => entry.viewId === request.viewId) >= this.#budget.maxAnalysesPerView) throw new Error('view proximity capacity exceeded')
    const watermark = this.#layerRevision.get(request.layerId) ?? request.revision
    if (request.revision < watermark) throw new Error('stale proximity revision')
    this.#layerRevision.set(request.layerId, Math.max(watermark, request.revision))
    const entry: Entry = Object.freeze({ ...request, phase: 'queued', expiresAt: request.requestedAt + this.#budget.queueTtlMs })
    this.#entries.set(key, entry)
    return this.#detach(entry)
  }

  takeNext(now: number): ArcGisProximitySnapshot | undefined {
    this.#assertActive(); this.#finite(now, 'now'); this.expire(now)
    if (this.#count(entry => entry.phase === 'running') >= this.#budget.maxRunning) return undefined
    const queued = [...this.#entries.values()].filter(entry => entry.phase === 'queued')
    queued.sort((a, b) => intentRank[a.intent] - intentRank[b.intent] || a.requestedAt - b.requestedAt || a.analysisId.localeCompare(b.analysisId))
    const next = queued[0]
    if (!next) return undefined
    const running: Entry = Object.freeze({ ...next, phase: 'running', expiresAt: now + this.#budget.runTtlMs })
    this.#entries.set(this.#key(next), running)
    return this.#detach(running)
  }

  complete(identity: Pick<ArcGisProximityRequest, 'viewId' | 'layerId' | 'analysisId' | 'revision'>, actualCandidates: number, actualVertices: number, actualBytes: number, now: number): ArcGisProximitySnapshot {
    this.#assertActive(); this.#natural(actualCandidates, 'actualCandidates'); this.#natural(actualVertices, 'actualVertices'); this.#natural(actualBytes, 'actualBytes'); this.#finite(now, 'now')
    const key = this.#key(identity)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'running') throw new Error('proximity analysis is not running')
    if (entry.revision !== identity.revision || identity.revision < (this.#layerRevision.get(identity.layerId) ?? identity.revision)) { this.#entries.delete(key); throw new Error('stale proximity completion') }
    if (now > entry.expiresAt) { this.#entries.delete(key); throw new Error('expired proximity completion') }
    if (actualCandidates > this.#budget.maxCandidatesPerAnalysis || actualVertices > this.#budget.maxVerticesPerAnalysis || actualBytes > this.#budget.maxBytesPerAnalysis) { this.#entries.delete(key); throw new Error('proximity result budget exceeded') }
    if (this.#count(item => item.phase === 'ready') >= this.#budget.maxReady) { this.#entries.delete(key); throw new Error('ready proximity capacity exceeded') }
    if (this.#readyCandidates() + actualCandidates > this.#budget.maxReadyCandidates) { this.#entries.delete(key); throw new Error('ready candidate budget exceeded') }
    if (this.#readyVertices() + actualVertices > this.#budget.maxReadyVertices) { this.#entries.delete(key); throw new Error('ready vertex budget exceeded') }
    if (this.#readyBytes() + actualBytes > this.#budget.maxReadyBytes) { this.#entries.delete(key); throw new Error('ready byte budget exceeded') }
    const ready: Entry = Object.freeze({ ...entry, phase: 'ready', actualCandidates, actualVertices, actualBytes, expiresAt: now + this.#budget.readyTtlMs })
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

  touch(viewId: string, layerId: string, analysisId: string, now: number): boolean {
    this.#assertActive(); this.#finite(now, 'now')
    const key = this.#key({ viewId, layerId, analysisId })
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready' || now > entry.expiresAt) return false
    this.#entries.set(key, Object.freeze({ ...entry, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  consume(viewId: string, layerId: string, analysisId: string): ArcGisProximitySnapshot | undefined {
    this.#assertActive()
    const key = this.#key({ viewId, layerId, analysisId })
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready') return undefined
    this.#entries.delete(key)
    return this.#detach(entry)
  }

  cancel(viewId: string, layerId: string, analysisId: string): boolean { this.#assertActive(); return this.#entries.delete(this.#key({ viewId, layerId, analysisId })) }
  releaseView(viewId: string): number { this.#assertActive(); this.#identifier(viewId, 'viewId'); return this.#release(entry => entry.viewId === viewId) }
  releaseLayer(layerId: string): number { this.#assertActive(); this.#identifier(layerId, 'layerId'); this.#layerRevision.delete(layerId); return this.#release(entry => entry.layerId === layerId) }
  expire(now: number): number { this.#assertActive(); this.#finite(now, 'now'); return this.#release(entry => now > entry.expiresAt) }

  snapshot(): readonly ArcGisProximitySnapshot[] {
    this.#assertActive()
    return Object.freeze([...this.#entries.values()].map(entry => this.#detach(entry)).sort((a, b) => a.viewId.localeCompare(b.viewId) || a.layerId.localeCompare(b.layerId) || a.analysisId.localeCompare(b.analysisId)))
  }

  fingerprint(): string {
    this.#assertActive()
    return this.snapshot().map(entry => [entry.viewId, entry.layerId, entry.analysisId, entry.revision, entry.intent, entry.phase, entry.estimatedCandidates, entry.estimatedVertices, entry.estimatedBytes, entry.actualCandidates ?? '-', entry.actualVertices ?? '-', entry.actualBytes ?? '-', entry.expiresAt].join(':')).join('|')
  }

  dispose(): void { this.#entries.clear(); this.#layerRevision.clear(); this.#disposed = true }

  #validateBudget(budget: ArcGisProximityBudget): void {
    for (const [name, value] of Object.entries(budget)) this.#positive(value, name)
    if (budget.maxAnalysesPerView > budget.maxAnalyses || budget.maxRunning > budget.maxAnalyses || budget.maxReady > budget.maxAnalyses) throw new RangeError('proximity cardinality budget is impossible')
    if (budget.maxCandidatesPerAnalysis > budget.maxReadyCandidates || budget.maxVerticesPerAnalysis > budget.maxReadyVertices || budget.maxBytesPerAnalysis > budget.maxReadyBytes) throw new RangeError('proximity residency budget is impossible')
  }

  #validateRequest(request: ArcGisProximityRequest): void {
    this.#identifier(request.viewId, 'viewId'); this.#identifier(request.layerId, 'layerId'); this.#identifier(request.analysisId, 'analysisId')
    this.#natural(request.revision, 'revision'); this.#positive(request.estimatedCandidates, 'estimatedCandidates'); this.#positive(request.estimatedVertices, 'estimatedVertices'); this.#positive(request.estimatedBytes, 'estimatedBytes'); this.#finite(request.requestedAt, 'requestedAt')
    if (!(request.intent in intentRank)) throw new TypeError('invalid proximity intent')
    if (request.estimatedCandidates > this.#budget.maxCandidatesPerAnalysis || request.estimatedVertices > this.#budget.maxVerticesPerAnalysis || request.estimatedBytes > this.#budget.maxBytesPerAnalysis) throw new RangeError('estimated proximity result exceeds budget')
  }

  #key(value: Pick<ArcGisProximityRequest, 'viewId' | 'layerId' | 'analysisId'>): string { return `${value.viewId}\u0000${value.layerId}\u0000${value.analysisId}` }
  #readyCandidates(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualCandidates ?? 0; return total }
  #readyVertices(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualVertices ?? 0; return total }
  #readyBytes(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualBytes ?? 0; return total }
  #count(predicate: (entry: Entry) => boolean): number { let total = 0; for (const entry of this.#entries.values()) if (predicate(entry)) total++; return total }
  #release(predicate: (entry: Entry) => boolean): number { let total = 0; for (const [key, entry] of this.#entries) if (predicate(entry)) { this.#entries.delete(key); total++ } return total }
  #detach(entry: Entry): ArcGisProximitySnapshot { return Object.freeze({ ...entry }) }
  #identifier(value: string, name: string): void { if (typeof value !== 'string' || !idPattern.test(value)) throw new TypeError(`${name} is invalid`) }
  #finite(value: number, name: string): void { if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`) }
  #natural(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`) }
  #positive(value: number, name: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`) }
  #assertActive(): void { if (this.#disposed) throw new Error('ArcGisProximityAnalysisLifecyclePolicy is disposed') }
}
