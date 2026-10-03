export type ArcGisLayerViewWarmupIntent = 'background' | 'visible' | 'interactive'
export type ArcGisLayerViewWarmupPhase = 'queued' | 'warming' | 'ready'

export interface ArcGisLayerViewWarmupBudget {
  maxViews: number
  maxJobs: number
  maxJobsPerView: number
  maxWarming: number
  maxWarmingPerView: number
  maxReady: number
  maxReadyPerView: number
  maxEstimatedBytesPerJob: number
  maxActualBytesPerJob: number
  maxAggregateReadyBytes: number
  queueTtlMs: number
  warmLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisLayerViewWarmupRequest {
  viewId: string
  layerId: string
  jobId: string
  revision: number
  intent: ArcGisLayerViewWarmupIntent
  requestedAt: number
  estimatedBytes: number
  scaleBucket: number
  is3d: boolean
}

export interface ArcGisLayerViewWarmupSnapshot extends ArcGisLayerViewWarmupRequest {
  phase: ArcGisLayerViewWarmupPhase
  sequence: number
  actualBytes: number
  expiresAt: number
  lastAccessedAt: number
}

type Entry = ArcGisLayerViewWarmupSnapshot
const rank: Readonly<Record<ArcGisLayerViewWarmupIntent, number>> = Object.freeze({ interactive: 0, visible: 1, background: 2 })
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/

/** Scalar-only authority for 2D/3D LayerView warmup work. SDK objects remain caller-owned. */
export class ArcGisLayerViewWarmupLifecyclePolicy {
  readonly #budget: Readonly<ArcGisLayerViewWarmupBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisLayerViewWarmupBudget) {
    for (const [name, value] of Object.entries(budget)) this.#positive(name, value)
    if (budget.maxJobsPerView > budget.maxJobs) throw new RangeError('maxJobsPerView exceeds maxJobs')
    if (budget.maxWarming > budget.maxJobs) throw new RangeError('maxWarming exceeds maxJobs')
    if (budget.maxWarmingPerView > budget.maxWarming) throw new RangeError('maxWarmingPerView exceeds maxWarming')
    if (budget.maxReady > budget.maxJobs) throw new RangeError('maxReady exceeds maxJobs')
    if (budget.maxReadyPerView > budget.maxReady) throw new RangeError('maxReadyPerView exceeds maxReady')
    if (budget.maxActualBytesPerJob > budget.maxAggregateReadyBytes) throw new RangeError('ready byte budget is inconsistent')
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(source: ArcGisLayerViewWarmupRequest): boolean {
    this.#active()
    const request = this.#normalize(source)
    if (request.estimatedBytes > this.#budget.maxEstimatedBytesPerJob) return false
    const scope = this.#scope(request.viewId, request.layerId)
    const watermark = this.#revisions.get(scope) ?? 0
    if (request.revision < watermark) return false
    const key = this.#key(request.viewId, request.layerId, request.jobId)
    const previous = this.#entries.get(key)
    if (previous && request.revision < previous.revision) return false
    if (previous && request.revision === previous.revision && rank[request.intent] >= rank[previous.intent]) return false
    const advances = request.revision > watermark
    const survives = (entry: Entry) => entry !== previous && !(advances && this.#scope(entry.viewId, entry.layerId) === scope && entry.revision < request.revision)
    if (this.#count(survives) + 1 > this.#budget.maxJobs) return false
    if (this.#count(entry => survives(entry) && entry.viewId === request.viewId) + 1 > this.#budget.maxJobsPerView) return false
    const views = new Set([...this.#entries.values()].filter(survives).map(entry => entry.viewId))
    if (!views.has(request.viewId) && views.size >= this.#budget.maxViews) return false
    if (advances) this.invalidateLayer(request.viewId, request.layerId, request.revision)
    else if (previous) this.#entries.delete(key)
    this.#revisions.set(scope, request.revision)
    this.#entries.set(key, Object.freeze({ ...request, phase: 'queued', sequence: previous?.sequence ?? this.#sequence++, actualBytes: 0, expiresAt: request.requestedAt + this.#budget.queueTtlMs, lastAccessedAt: request.requestedAt }))
    return true
  }

  takeNext(now: number): Readonly<ArcGisLayerViewWarmupSnapshot> | undefined {
    this.#active()
    this.#time('now', now)
    this.expire(now)
    if (this.#phaseCount('warming') >= this.#budget.maxWarming) return undefined
    const next = [...this.#entries.values()]
      .filter(entry => entry.phase === 'queued' && this.#phaseCountForView('warming', entry.viewId) < this.#budget.maxWarmingPerView)
      .sort((a, b) => rank[a.intent] - rank[b.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence || a.jobId.localeCompare(b.jobId))[0]
    if (!next) return undefined
    const warming: Entry = Object.freeze({ ...next, phase: 'warming', expiresAt: now + this.#budget.warmLeaseMs, lastAccessedAt: now })
    this.#entries.set(this.#key(next.viewId, next.layerId, next.jobId), warming)
    return this.#detach(warming)
  }

  complete(viewId: string, layerId: string, jobId: string, revision: number, actualBytes: number, now: number): boolean {
    this.#active()
    const view = this.#id('viewId', viewId)
    const layer = this.#id('layerId', layerId)
    const job = this.#id('jobId', jobId)
    this.#nonNegativeInteger('revision', revision)
    this.#nonNegativeInteger('actualBytes', actualBytes)
    this.#time('now', now)
    const key = this.#key(view, layer, job)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'warming' || entry.revision !== revision) return false
    if (now >= entry.expiresAt || revision < (this.#revisions.get(this.#scope(view, layer)) ?? 0)) {
      this.#entries.delete(key)
      return false
    }
    if (actualBytes > this.#budget.maxActualBytesPerJob) {
      this.#entries.delete(key)
      return false
    }
    this.#release(candidate => candidate !== entry && now >= candidate.expiresAt)
    this.#evictForAdmission(view, actualBytes)
    if (this.#phaseCount('ready') >= this.#budget.maxReady || this.#phaseCountForView('ready', view) >= this.#budget.maxReadyPerView || this.#readyBytes() + actualBytes > this.#budget.maxAggregateReadyBytes) {
      this.#entries.delete(key)
      return false
    }
    this.#entries.set(key, Object.freeze({ ...entry, phase: 'ready', actualBytes, expiresAt: now + this.#budget.readyTtlMs, lastAccessedAt: now }))
    return true
  }

  touch(viewId: string, layerId: string, jobId: string, revision: number, now: number): boolean {
    this.#active()
    this.#time('now', now)
    const key = this.#key(this.#id('viewId', viewId), this.#id('layerId', layerId), this.#id('jobId', jobId))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready' || entry.revision !== revision || now >= entry.expiresAt) return false
    this.#entries.set(key, Object.freeze({ ...entry, lastAccessedAt: now }))
    return true
  }

  consume(viewId: string, layerId: string, jobId: string, revision: number): boolean {
    this.#active()
    this.#nonNegativeInteger('revision', revision)
    const key = this.#key(this.#id('viewId', viewId), this.#id('layerId', layerId), this.#id('jobId', jobId))
    const entry = this.#entries.get(key)
    return !!entry && entry.phase === 'ready' && entry.revision === revision && this.#entries.delete(key)
  }

  cancel(viewId: string, layerId: string, jobId: string, revision: number): boolean {
    this.#active()
    this.#nonNegativeInteger('revision', revision)
    const key = this.#key(this.#id('viewId', viewId), this.#id('layerId', layerId), this.#id('jobId', jobId))
    const entry = this.#entries.get(key)
    return !!entry && entry.revision === revision && this.#entries.delete(key)
  }

  invalidateLayer(viewId: string, layerId: string, revision: number): number {
    this.#active()
    const view = this.#id('viewId', viewId)
    const layer = this.#id('layerId', layerId)
    this.#nonNegativeInteger('revision', revision)
    const scope = this.#scope(view, layer)
    const current = this.#revisions.get(scope) ?? 0
    if (revision <= current) return 0
    this.#revisions.set(scope, revision)
    return this.#release(entry => entry.viewId === view && entry.layerId === layer && entry.revision < revision)
  }

  releaseView(viewId: string): number {
    this.#active()
    const view = this.#id('viewId', viewId)
    for (const key of [...this.#revisions.keys()]) if (key.startsWith(`${view}\u0000`)) this.#revisions.delete(key)
    return this.#release(entry => entry.viewId === view)
  }

  expire(now: number): number {
    this.#active()
    this.#time('now', now)
    return this.#release(entry => now >= entry.expiresAt)
  }

  snapshot(): readonly Readonly<ArcGisLayerViewWarmupSnapshot>[] {
    this.#active()
    return Object.freeze([...this.#entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.#detach(entry)))
  }

  fingerprint(): string {
    return this.snapshot().map(entry => `${entry.viewId}:${entry.layerId}:${entry.jobId}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.scaleBucket}:${entry.is3d ? 1 : 0}:${entry.actualBytes}`).join('|')
  }

  dispose(): void {
    if (this.#disposed) return
    this.#entries.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #normalize(source: ArcGisLayerViewWarmupRequest): ArcGisLayerViewWarmupRequest {
    const viewId = this.#id('viewId', source.viewId)
    const layerId = this.#id('layerId', source.layerId)
    const jobId = this.#id('jobId', source.jobId)
    this.#nonNegativeInteger('revision', source.revision)
    this.#time('requestedAt', source.requestedAt)
    this.#nonNegativeInteger('estimatedBytes', source.estimatedBytes)
    this.#nonNegativeInteger('scaleBucket', source.scaleBucket)
    if (!(source.intent in rank)) throw new Error('intent is invalid')
    if (typeof source.is3d !== 'boolean') throw new TypeError('is3d must be boolean')
    return Object.freeze({ ...source, viewId, layerId, jobId })
  }

  #evictForAdmission(viewId: string, bytes: number): void {
    const candidates = [...this.#entries.values()].filter(entry => entry.phase === 'ready').sort((a, b) => rank[b.intent] - rank[a.intent] || a.lastAccessedAt - b.lastAccessedAt || a.sequence - b.sequence)
    for (const candidate of candidates) {
      const globalPressure = this.#phaseCount('ready') >= this.#budget.maxReady || this.#readyBytes() + bytes > this.#budget.maxAggregateReadyBytes
      const viewPressure = this.#phaseCountForView('ready', viewId) >= this.#budget.maxReadyPerView
      if (!globalPressure && !viewPressure) break
      if (viewPressure && candidate.viewId !== viewId && !globalPressure) continue
      this.#entries.delete(this.#key(candidate.viewId, candidate.layerId, candidate.jobId))
    }
  }

  #readyBytes(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualBytes; return total }
  #phaseCount(phase: ArcGisLayerViewWarmupPhase): number { return this.#count(entry => entry.phase === phase) }
  #phaseCountForView(phase: ArcGisLayerViewWarmupPhase, viewId: string): number { return this.#count(entry => entry.phase === phase && entry.viewId === viewId) }
  #count(predicate: (entry: Entry) => boolean): number { let total = 0; for (const entry of this.#entries.values()) if (predicate(entry)) total += 1; return total }
  #release(predicate: (entry: Entry) => boolean): number { let removed = 0; for (const [key, entry] of this.#entries) if (predicate(entry)) { this.#entries.delete(key); removed += 1 } return removed }
  #detach(entry: Entry): Readonly<ArcGisLayerViewWarmupSnapshot> { return Object.freeze({ ...entry }) }
  #scope(viewId: string, layerId: string): string { return `${viewId}\u0000${layerId}` }
  #key(viewId: string, layerId: string, jobId: string): string { return `${viewId}\u0000${layerId}\u0000${jobId}` }
  #id(name: string, value: string): string { const normalized = value.trim(); if (!SAFE_ID.test(normalized)) throw new Error(`${name} is invalid`); return normalized }
  #positive(name: string, value: number): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`) }
  #nonNegativeInteger(name: string, value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`) }
  #time(name: string, value: number): void { if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative`) }
  #active(): void { if (this.#disposed) throw new Error('ArcGisLayerViewWarmupLifecyclePolicy is disposed') }
}
