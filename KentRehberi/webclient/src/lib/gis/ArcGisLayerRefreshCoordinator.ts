export type ArcGisRefreshIntent = 'interactive' | 'visible' | 'background'
export type ArcGisRefreshState = 'queued' | 'loading' | 'ready'

export interface ArcGisLayerRefreshBudget {
  maxJobs: number
  maxJobsPerLayer: number
  maxConcurrent: number
  maxConcurrentPerLayer: number
  maxReadyBytes: number
  maxReadyBytesPerLayer: number
  maxBytesPerJob: number
  queueLeaseMs: number
  loadingLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisLayerRefreshRequest {
  layerId: string
  refreshKey: string
  revision: number
  intent: ArcGisRefreshIntent
  estimatedBytes: number
  requestedAt: number
}

export interface ArcGisLayerRefreshSnapshot extends ArcGisLayerRefreshRequest {
  state: ArcGisRefreshState
  actualBytes: number
  sequence: number
  expiresAt: number
}

type Job = ArcGisLayerRefreshSnapshot
const intentRank: Record<ArcGisRefreshIntent, number> = { interactive: 0, visible: 1, background: 2 }
const separator = '\u0000'

/**
 * Scalar-only authority for ArcGIS layer refresh work.
 *
 * The coordinator intentionally owns no Layer, LayerView, Graphic, response,
 * credential, AbortController, or transport object. Callers retain those heavy
 * objects and use the returned scalar identity to bind completion safely.
 */
export class ArcGisLayerRefreshCoordinator {
  private readonly jobs = new Map<string, Job>()
  private readonly revisions = new Map<string, number>()
  private sequence = 0
  private disposed = false

  constructor(private readonly budget: ArcGisLayerRefreshBudget) {
    this.validateBudget()
  }

  enqueue(input: ArcGisLayerRefreshRequest): boolean {
    this.active()
    const request = this.normalize(input)
    this.expire(request.requestedAt)
    const watermark = this.revisions.get(request.layerId) ?? 0
    if (request.revision < watermark) return false
    const key = this.key(request.layerId, request.refreshKey)
    const previous = this.jobs.get(key)
    if (previous && request.revision < previous.revision) return false

    const advances = request.revision > watermark
    const survives = (job: Job) => job !== previous && !(advances && job.layerId === request.layerId && job.revision < request.revision)
    if (this.count(job => survives(job) && job.layerId === request.layerId) + 1 > this.budget.maxJobsPerLayer) return false
    if (this.count(survives) + 1 > this.budget.maxJobs) return false

    if (advances) this.invalidateLayer(request.layerId, request.revision)
    else if (previous) this.jobs.delete(key)
    this.revisions.set(request.layerId, Math.max(watermark, request.revision))
    this.jobs.set(key, {
      ...request,
      state: 'queued',
      actualBytes: 0,
      sequence: this.sequence++,
      expiresAt: request.requestedAt + this.budget.queueLeaseMs,
    })
    return true
  }

  takeNext(now: number): ArcGisLayerRefreshSnapshot | undefined {
    this.active(); this.timestamp(now); this.expire(now)
    const loading = this.count(job => job.state === 'loading')
    if (loading >= this.budget.maxConcurrent) return undefined
    const candidate = [...this.jobs.values()]
      .filter(job => job.state === 'queued' && this.count(other => other.state === 'loading' && other.layerId === job.layerId) < this.budget.maxConcurrentPerLayer)
      .sort((a, b) => intentRank[a.intent] - intentRank[b.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence)[0]
    if (!candidate) return undefined
    candidate.state = 'loading'
    candidate.expiresAt = now + this.budget.loadingLeaseMs
    return this.detach(candidate)
  }

  complete(layerId: string, refreshKey: string, revision: number, actualBytes: number, now: number): boolean {
    this.active(); this.timestamp(now); this.positive(revision, 'revision'); this.nonNegative(actualBytes, 'actualBytes')
    const layer = this.id(layerId, 'layerId'), refresh = this.id(refreshKey, 'refreshKey')
    const key = this.key(layer, refresh), job = this.jobs.get(key)
    if (!job || job.state !== 'loading' || job.revision !== revision) return false
    if (revision < (this.revisions.get(layer) ?? 0) || now >= job.expiresAt || actualBytes > this.budget.maxBytesPerJob) {
      this.jobs.delete(key); return false
    }
    this.expire(now)
    const layerReady = this.sumBytes(candidate => candidate !== job && candidate.state === 'ready' && candidate.layerId === layer)
    const totalReady = this.sumBytes(candidate => candidate !== job && candidate.state === 'ready')
    if (layerReady + actualBytes > this.budget.maxReadyBytesPerLayer || totalReady + actualBytes > this.budget.maxReadyBytes) {
      this.jobs.delete(key); return false
    }
    job.state = 'ready'; job.actualBytes = actualBytes; job.expiresAt = now + this.budget.readyTtlMs
    return true
  }

  consume(layerId: string, refreshKey: string, revision: number, now: number): ArcGisLayerRefreshSnapshot | undefined {
    this.active(); this.timestamp(now); this.positive(revision, 'revision')
    const key = this.key(this.id(layerId, 'layerId'), this.id(refreshKey, 'refreshKey'))
    const job = this.jobs.get(key)
    if (!job || job.state !== 'ready' || job.revision !== revision || now >= job.expiresAt) {
      if (job && now >= job.expiresAt) this.jobs.delete(key)
      return undefined
    }
    this.jobs.delete(key)
    return this.detach(job)
  }

  cancel(layerId: string, refreshKey: string): boolean {
    this.active(); return this.jobs.delete(this.key(this.id(layerId, 'layerId'), this.id(refreshKey, 'refreshKey')))
  }

  invalidateLayer(layerId: string, revision: number): number {
    this.active(); const layer = this.id(layerId, 'layerId'); this.positive(revision, 'revision')
    const current = this.revisions.get(layer) ?? 0
    if (revision <= current) return 0
    this.revisions.set(layer, revision)
    return this.release(job => job.layerId === layer && job.revision < revision)
  }

  releaseLayer(layerId: string): number {
    this.active(); const layer = this.id(layerId, 'layerId'); this.revisions.delete(layer)
    return this.release(job => job.layerId === layer)
  }

  expire(now: number): number {
    this.active(); this.timestamp(now)
    return this.release(job => now >= job.expiresAt)
  }

  snapshot(): ArcGisLayerRefreshSnapshot[] {
    this.active(); return [...this.jobs.values()].sort((a, b) => a.sequence - b.sequence).map(job => this.detach(job))
  }

  dispose(): void {
    if (!this.disposed) { this.jobs.clear(); this.revisions.clear(); this.disposed = true }
  }

  private normalize(input: ArcGisLayerRefreshRequest): ArcGisLayerRefreshRequest {
    if (!(input.intent in intentRank)) throw new Error('intent is invalid')
    this.positive(input.revision, 'revision'); this.nonNegative(input.estimatedBytes, 'estimatedBytes'); this.timestamp(input.requestedAt)
    if (input.estimatedBytes > this.budget.maxBytesPerJob) throw new RangeError('estimatedBytes exceeds per-job budget')
    return { ...input, layerId: this.id(input.layerId, 'layerId'), refreshKey: this.id(input.refreshKey, 'refreshKey') }
  }

  private validateBudget(): void {
    for (const [name, value] of Object.entries(this.budget)) this.positive(value, name)
    if (this.budget.maxJobsPerLayer > this.budget.maxJobs) throw new RangeError('per-layer jobs exceed global jobs')
    if (this.budget.maxConcurrentPerLayer > this.budget.maxConcurrent) throw new RangeError('per-layer concurrency exceeds global concurrency')
    if (this.budget.maxReadyBytesPerLayer > this.budget.maxReadyBytes) throw new RangeError('per-layer ready bytes exceed global ready bytes')
    if (this.budget.maxBytesPerJob > this.budget.maxReadyBytesPerLayer) throw new RangeError('job bytes exceed per-layer ready bytes')
  }

  private detach(job: Job): ArcGisLayerRefreshSnapshot { return { ...job } }
  private count(predicate: (job: Job) => boolean): number { let count = 0; for (const job of this.jobs.values()) if (predicate(job)) count++; return count }
  private sumBytes(predicate: (job: Job) => boolean): number { let bytes = 0; for (const job of this.jobs.values()) if (predicate(job)) bytes += job.actualBytes; return bytes }
  private release(predicate: (job: Job) => boolean): number { let count = 0; for (const [key, job] of this.jobs) if (predicate(job)) { this.jobs.delete(key); count++ } return count }
  private key(layerId: string, refreshKey: string): string { return `${layerId}${separator}${refreshKey}` }
  private id(value: string, name: string): string { const normalized = value.trim(); if (!normalized || normalized.length > 160 || normalized.includes(separator)) throw new Error(`${name} is invalid`); return normalized }
  private positive(value: number, name: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`) }
  private nonNegative(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`) }
  private timestamp(value: number): void { if (!Number.isFinite(value) || value < 0) throw new RangeError('timestamp must be finite and non-negative') }
  private active(): void { if (this.disposed) throw new Error('ArcGisLayerRefreshCoordinator is disposed') }
}
