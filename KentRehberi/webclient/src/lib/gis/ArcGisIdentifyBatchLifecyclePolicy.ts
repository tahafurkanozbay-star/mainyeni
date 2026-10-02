export type ArcGisIdentifyPriority = 'click' | 'keyboard' | 'inspection'
export type ArcGisIdentifyPhase = 'queued' | 'running' | 'ready'

export interface ArcGisIdentifyBatchBudget {
  maxBatches: number
  maxBatchesPerView: number
  maxRunning: number
  maxReady: number
  maxLayersPerBatch: number
  maxHitsPerBatch: number
  maxReadyHits: number
  maxBytesPerBatch: number
  maxReadyBytes: number
  queueTtlMs: number
  runTtlMs: number
  readyTtlMs: number
}

export interface ArcGisIdentifyBatchRequest {
  viewId: string
  batchId: string
  mapRevision: number
  priority: ArcGisIdentifyPriority
  layerCount: number
  estimatedHits: number
  estimatedBytes: number
  requestedAt: number
}

export interface ArcGisIdentifyBatchSnapshot extends ArcGisIdentifyBatchRequest {
  phase: ArcGisIdentifyPhase
  expiresAt: number
  actualHits?: number
  actualBytes?: number
}

type Entry = ArcGisIdentifyBatchSnapshot

const priorityRank: Record<ArcGisIdentifyPriority, number> = { click: 0, keyboard: 1, inspection: 2 }
const idPattern = /^[A-Za-z0-9._:/-]{1,160}$/

/**
 * Payload-free authority for ArcGIS identify fan-out. The policy intentionally owns
 * only scalar scheduling/accounting facts: MapView, screenPoint, Geometry,
 * Graphic[], response payloads, credentials and AbortController stay with callers.
 */
export class ArcGisIdentifyBatchLifecyclePolicy {
  readonly #budget: Readonly<ArcGisIdentifyBatchBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #viewRevision = new Map<string, number>()
  #disposed = false

  constructor(budget: ArcGisIdentifyBatchBudget) {
    this.#validateBudget(budget)
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(request: ArcGisIdentifyBatchRequest): ArcGisIdentifyBatchSnapshot {
    this.#assertActive()
    this.#validateRequest(request)
    this.expire(request.requestedAt)
    const key = this.#key(request.viewId, request.batchId)
    if (this.#entries.has(key)) throw new Error(`duplicate identify batch: ${request.batchId}`)
    if (this.#entries.size >= this.#budget.maxBatches) throw new Error('identify batch capacity exceeded')
    if (this.#count(entry => entry.viewId === request.viewId) >= this.#budget.maxBatchesPerView) throw new Error('view identify batch capacity exceeded')
    const watermark = this.#viewRevision.get(request.viewId) ?? request.mapRevision
    if (request.mapRevision < watermark) throw new Error('stale identify map revision')
    this.#viewRevision.set(request.viewId, Math.max(watermark, request.mapRevision))
    const entry: Entry = Object.freeze({ ...request, phase: 'queued', expiresAt: request.requestedAt + this.#budget.queueTtlMs })
    this.#entries.set(key, entry)
    return this.#detach(entry)
  }

  takeNext(now: number): ArcGisIdentifyBatchSnapshot | undefined {
    this.#assertActive(); this.#finite(now, 'now'); this.expire(now)
    if (this.#count(entry => entry.phase === 'running') >= this.#budget.maxRunning) return undefined
    const queued = [...this.#entries.values()].filter(entry => entry.phase === 'queued')
    queued.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.requestedAt - b.requestedAt || a.batchId.localeCompare(b.batchId))
    const next = queued[0]
    if (!next) return undefined
    const running: Entry = Object.freeze({ ...next, phase: 'running', expiresAt: now + this.#budget.runTtlMs })
    this.#entries.set(this.#key(next.viewId, next.batchId), running)
    return this.#detach(running)
  }

  complete(viewId: string, batchId: string, mapRevision: number, actualHits: number, actualBytes: number, now: number): ArcGisIdentifyBatchSnapshot {
    this.#assertActive(); this.#identifier(viewId, 'viewId'); this.#identifier(batchId, 'batchId')
    this.#natural(mapRevision, 'mapRevision'); this.#natural(actualHits, 'actualHits'); this.#natural(actualBytes, 'actualBytes'); this.#finite(now, 'now')
    const key = this.#key(viewId, batchId)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'running') throw new Error('identify batch is not running')
    const watermark = this.#viewRevision.get(viewId) ?? mapRevision
    if (entry.mapRevision !== mapRevision || mapRevision < watermark) { this.#entries.delete(key); throw new Error('stale identify completion') }
    if (now > entry.expiresAt) { this.#entries.delete(key); throw new Error('expired identify completion') }
    if (actualHits > this.#budget.maxHitsPerBatch || actualBytes > this.#budget.maxBytesPerBatch) { this.#entries.delete(key); throw new Error('identify result budget exceeded') }
    if (this.#count(item => item.phase === 'ready') >= this.#budget.maxReady) { this.#entries.delete(key); throw new Error('ready identify capacity exceeded') }
    if (this.#readyHits() + actualHits > this.#budget.maxReadyHits) { this.#entries.delete(key); throw new Error('ready identify hit budget exceeded') }
    if (this.#readyBytes() + actualBytes > this.#budget.maxReadyBytes) { this.#entries.delete(key); throw new Error('ready identify byte budget exceeded') }
    const ready: Entry = Object.freeze({ ...entry, phase: 'ready', actualHits, actualBytes, expiresAt: now + this.#budget.readyTtlMs })
    this.#entries.set(key, ready)
    return this.#detach(ready)
  }

  advanceViewRevision(viewId: string, revision: number): number {
    this.#assertActive(); this.#identifier(viewId, 'viewId'); this.#natural(revision, 'revision')
    const current = this.#viewRevision.get(viewId) ?? -1
    if (revision < current) throw new Error('view revision cannot move backwards')
    this.#viewRevision.set(viewId, revision)
    return this.#release(entry => entry.viewId === viewId && entry.mapRevision < revision)
  }

  touch(viewId: string, batchId: string, now: number): boolean {
    this.#assertActive(); this.#finite(now, 'now')
    const key = this.#key(viewId, batchId)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready') return false
    if (now > entry.expiresAt) { this.#entries.delete(key); return false }
    this.#entries.set(key, Object.freeze({ ...entry, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  consume(viewId: string, batchId: string): ArcGisIdentifyBatchSnapshot | undefined {
    this.#assertActive(); this.#identifier(viewId, 'viewId'); this.#identifier(batchId, 'batchId')
    const key = this.#key(viewId, batchId)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready') return undefined
    this.#entries.delete(key)
    return this.#detach(entry)
  }

  cancel(viewId: string, batchId: string): boolean {
    this.#assertActive(); this.#identifier(viewId, 'viewId'); this.#identifier(batchId, 'batchId')
    return this.#entries.delete(this.#key(viewId, batchId))
  }

  releaseView(viewId: string): number {
    this.#assertActive(); this.#identifier(viewId, 'viewId'); this.#viewRevision.delete(viewId)
    return this.#release(entry => entry.viewId === viewId)
  }

  expire(now: number): number {
    this.#assertActive(); this.#finite(now, 'now')
    return this.#release(entry => now > entry.expiresAt)
  }

  snapshot(): readonly ArcGisIdentifyBatchSnapshot[] {
    this.#assertActive()
    return Object.freeze([...this.#entries.values()].map(entry => this.#detach(entry)).sort((a, b) => a.viewId.localeCompare(b.viewId) || a.batchId.localeCompare(b.batchId)))
  }

  fingerprint(): string {
    this.#assertActive()
    return this.snapshot().map(entry => [entry.viewId, entry.batchId, entry.mapRevision, entry.priority, entry.phase, entry.layerCount, entry.estimatedHits, entry.estimatedBytes, entry.actualHits ?? '-', entry.actualBytes ?? '-', entry.expiresAt].join(':')).join('|')
  }

  dispose(): void {
    this.#entries.clear(); this.#viewRevision.clear(); this.#disposed = true
  }

  #validateBudget(budget: ArcGisIdentifyBatchBudget): void {
    for (const [name, value] of Object.entries(budget)) this.#positive(value, name)
    if (budget.maxBatchesPerView > budget.maxBatches || budget.maxRunning > budget.maxBatches || budget.maxReady > budget.maxBatches) throw new RangeError('identify cardinality budget is impossible')
    if (budget.maxHitsPerBatch > budget.maxReadyHits || budget.maxBytesPerBatch > budget.maxReadyBytes) throw new RangeError('identify residency budget is impossible')
  }

  #validateRequest(request: ArcGisIdentifyBatchRequest): void {
    this.#identifier(request.viewId, 'viewId'); this.#identifier(request.batchId, 'batchId')
    this.#natural(request.mapRevision, 'mapRevision'); this.#positive(request.layerCount, 'layerCount')
    this.#positive(request.estimatedHits, 'estimatedHits'); this.#positive(request.estimatedBytes, 'estimatedBytes'); this.#finite(request.requestedAt, 'requestedAt')
    if (!(request.priority in priorityRank)) throw new TypeError('invalid identify priority')
    if (request.layerCount > this.#budget.maxLayersPerBatch) throw new RangeError('identify layer budget exceeded')
    if (request.estimatedHits > this.#budget.maxHitsPerBatch || request.estimatedBytes > this.#budget.maxBytesPerBatch) throw new RangeError('estimated identify result exceeds budget')
  }

  #key(viewId: string, batchId: string): string { return `${viewId}\u0000${batchId}` }
  #readyHits(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualHits ?? 0; return total }
  #readyBytes(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualBytes ?? 0; return total }
  #count(predicate: (entry: Entry) => boolean): number { let total = 0; for (const entry of this.#entries.values()) if (predicate(entry)) total++; return total }
  #release(predicate: (entry: Entry) => boolean): number { let total = 0; for (const [key, entry] of this.#entries) if (predicate(entry)) { this.#entries.delete(key); total++ } return total }
  #detach(entry: Entry): ArcGisIdentifyBatchSnapshot { return Object.freeze({ ...entry }) }
  #identifier(value: string, name: string): void { if (typeof value !== 'string' || !idPattern.test(value)) throw new TypeError(`${name} is invalid`) }
  #finite(value: number, name: string): void { if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`) }
  #natural(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`) }
  #positive(value: number, name: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`) }
  #assertActive(): void { if (this.#disposed) throw new Error('ArcGisIdentifyBatchLifecyclePolicy is disposed') }
}
