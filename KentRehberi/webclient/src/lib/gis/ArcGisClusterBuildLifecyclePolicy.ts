export type ArcGisClusterBuildIntent = 'background' | 'visible' | 'interactive'
export type ArcGisClusterBuildPhase = 'queued' | 'building' | 'ready'

export interface ArcGisClusterBuildBudget {
  maxJobs: number
  maxJobsPerView: number
  maxBuilding: number
  maxReady: number
  maxFeaturesPerJob: number
  maxClustersPerJob: number
  maxBytesPerJob: number
  maxAggregateReadyClusters: number
  maxAggregateReadyBytes: number
  queueTtlMs: number
  buildLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisClusterBuildRequest {
  viewId: string
  layerId: string
  jobId: string
  revision: number
  intent: ArcGisClusterBuildIntent
  requestedAt: number
  wkid: number
  zoomBucket: number
  featureCount: number
  estimatedBytes: number
}

export interface ArcGisClusterBuildSnapshot {
  viewId: string
  layerId: string
  jobId: string
  revision: number
  intent: ArcGisClusterBuildIntent
  phase: ArcGisClusterBuildPhase
  wkid: number
  zoomBucket: number
  featureCount: number
  clusterCount: number
  bytes: number
  requestedAt: number
  expiresAt: number
}

type Entry = ArcGisClusterBuildSnapshot & { sequence: number }

const intentRank: Record<ArcGisClusterBuildIntent, number> = { interactive: 0, visible: 1, background: 2 }
const separator = '\u0000'

export class ArcGisClusterBuildLifecyclePolicy {
  private readonly jobs = new Map<string, Entry>()
  private readonly viewRevisions = new Map<string, number>()
  private sequence = 0
  private disposed = false

  constructor(private readonly budget: ArcGisClusterBuildBudget) {
    this.validateBudget(budget)
  }

  enqueue(request: ArcGisClusterBuildRequest): boolean {
    this.assertActive()
    const normalized = this.normalizeRequest(request)
    const watermark = this.viewRevisions.get(normalized.viewId) ?? 0
    if (normalized.revision < watermark) return false
    if (normalized.featureCount > this.budget.maxFeaturesPerJob || normalized.estimatedBytes > this.budget.maxBytesPerJob) return false

    const key = this.key(normalized.viewId, normalized.layerId, normalized.jobId)
    const previous = this.jobs.get(key)
    if (previous && normalized.revision <= previous.revision) return false
    if (previous) this.jobs.delete(key)

    if (this.jobs.size >= this.budget.maxJobs) return false
    if (this.countView(normalized.viewId) >= this.budget.maxJobsPerView) return false

    this.viewRevisions.set(normalized.viewId, Math.max(watermark, normalized.revision))
    this.jobs.set(key, {
      ...normalized,
      phase: 'queued',
      clusterCount: 0,
      bytes: 0,
      expiresAt: normalized.requestedAt + this.budget.queueTtlMs,
      sequence: this.sequence++,
    })
    return true
  }

  takeNext(now: number): ArcGisClusterBuildSnapshot | undefined {
    this.assertActive()
    this.assertTimestamp(now, 'now')
    this.expire(now)
    if (this.countPhase('building') >= this.budget.maxBuilding) return undefined
    const candidate = [...this.jobs.values()]
      .filter(job => job.phase === 'queued')
      .sort((a, b) => intentRank[a.intent] - intentRank[b.intent] || b.zoomBucket - a.zoomBucket || a.requestedAt - b.requestedAt || a.sequence - b.sequence)[0]
    if (!candidate) return undefined
    candidate.phase = 'building'
    candidate.expiresAt = now + this.budget.buildLeaseMs
    return this.publicSnapshot(candidate)
  }

  complete(viewId: string, layerId: string, jobId: string, revision: number, clusterCount: number, actualBytes: number, now: number): boolean {
    this.assertActive()
    this.assertTimestamp(now, 'now')
    this.assertNonNegativeInteger(clusterCount, 'clusterCount')
    this.assertNonNegativeInteger(actualBytes, 'actualBytes')
    const entry = this.jobs.get(this.key(this.cleanId(viewId, 'viewId'), this.cleanId(layerId, 'layerId'), this.cleanId(jobId, 'jobId')))
    if (!entry || entry.phase !== 'building' || entry.revision !== revision) return false
    if (now >= entry.expiresAt || revision < (this.viewRevisions.get(entry.viewId) ?? 0)) {
      this.remove(entry)
      return false
    }
    if (clusterCount > this.budget.maxClustersPerJob || clusterCount > entry.featureCount || actualBytes > this.budget.maxBytesPerJob) {
      this.remove(entry)
      return false
    }
    if (this.countPhase('ready') >= this.budget.maxReady || this.readyClusters() + clusterCount > this.budget.maxAggregateReadyClusters || this.readyBytes() + actualBytes > this.budget.maxAggregateReadyBytes) {
      this.remove(entry)
      return false
    }
    entry.phase = 'ready'
    entry.clusterCount = clusterCount
    entry.bytes = actualBytes
    entry.expiresAt = now + this.budget.readyTtlMs
    return true
  }

  consume(viewId: string, layerId: string, jobId: string, revision: number): boolean {
    this.assertActive()
    const entry = this.jobs.get(this.key(this.cleanId(viewId, 'viewId'), this.cleanId(layerId, 'layerId'), this.cleanId(jobId, 'jobId')))
    if (!entry || entry.phase !== 'ready' || entry.revision !== revision) return false
    this.remove(entry)
    return true
  }

  cancel(viewId: string, layerId: string, jobId: string, revision: number): boolean {
    this.assertActive()
    const entry = this.jobs.get(this.key(this.cleanId(viewId, 'viewId'), this.cleanId(layerId, 'layerId'), this.cleanId(jobId, 'jobId')))
    if (!entry || entry.revision !== revision) return false
    this.remove(entry)
    return true
  }

  invalidateView(viewId: string, revision: number): number {
    this.assertActive()
    const id = this.cleanId(viewId, 'viewId')
    this.assertPositiveInteger(revision, 'revision')
    const current = this.viewRevisions.get(id) ?? 0
    if (revision <= current) return 0
    this.viewRevisions.set(id, revision)
    let removed = 0
    for (const entry of [...this.jobs.values()]) {
      if (entry.viewId === id && entry.revision < revision) {
        this.remove(entry)
        removed++
      }
    }
    return removed
  }

  releaseLayer(viewId: string, layerId: string): number {
    this.assertActive()
    const view = this.cleanId(viewId, 'viewId')
    const layer = this.cleanId(layerId, 'layerId')
    let removed = 0
    for (const entry of [...this.jobs.values()]) {
      if (entry.viewId === view && entry.layerId === layer) {
        this.remove(entry)
        removed++
      }
    }
    return removed
  }

  releaseView(viewId: string): number {
    this.assertActive()
    const id = this.cleanId(viewId, 'viewId')
    let removed = 0
    for (const entry of [...this.jobs.values()]) {
      if (entry.viewId === id) {
        this.remove(entry)
        removed++
      }
    }
    this.viewRevisions.delete(id)
    return removed
  }

  expire(now: number): number {
    this.assertActive()
    this.assertTimestamp(now, 'now')
    let removed = 0
    for (const entry of [...this.jobs.values()]) {
      if (now >= entry.expiresAt) {
        this.remove(entry)
        removed++
      }
    }
    return removed
  }

  snapshot(): ArcGisClusterBuildSnapshot[] {
    this.assertActive()
    return [...this.jobs.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.publicSnapshot(entry))
  }

  fingerprint(): string {
    return this.snapshot().map(job => `${job.viewId}:${job.layerId}:${job.jobId}:${job.revision}:${job.phase}:${job.zoomBucket}:${job.clusterCount}:${job.bytes}`).join('|')
  }

  dispose(): void {
    if (this.disposed) return
    this.jobs.clear()
    this.viewRevisions.clear()
    this.disposed = true
  }

  private readyClusters(): number {
    let total = 0
    for (const job of this.jobs.values()) if (job.phase === 'ready') total += job.clusterCount
    return total
  }

  private readyBytes(): number {
    let total = 0
    for (const job of this.jobs.values()) if (job.phase === 'ready') total += job.bytes
    return total
  }

  private countPhase(phase: ArcGisClusterBuildPhase): number {
    let count = 0
    for (const job of this.jobs.values()) if (job.phase === phase) count++
    return count
  }

  private countView(viewId: string): number {
    let count = 0
    for (const job of this.jobs.values()) if (job.viewId === viewId) count++
    return count
  }

  private remove(entry: Entry): void {
    this.jobs.delete(this.key(entry.viewId, entry.layerId, entry.jobId))
  }

  private publicSnapshot(entry: Entry): ArcGisClusterBuildSnapshot {
    const { sequence: _sequence, ...snapshot } = entry
    return { ...snapshot }
  }

  private normalizeRequest(request: ArcGisClusterBuildRequest): ArcGisClusterBuildRequest {
    const intent = request.intent
    if (!(intent in intentRank)) throw new Error('intent is invalid')
    this.assertPositiveInteger(request.revision, 'revision')
    this.assertPositiveInteger(request.wkid, 'wkid')
    this.assertNonNegativeInteger(request.zoomBucket, 'zoomBucket')
    this.assertPositiveInteger(request.featureCount, 'featureCount')
    this.assertNonNegativeInteger(request.estimatedBytes, 'estimatedBytes')
    this.assertTimestamp(request.requestedAt, 'requestedAt')
    return { ...request, viewId: this.cleanId(request.viewId, 'viewId'), layerId: this.cleanId(request.layerId, 'layerId'), jobId: this.cleanId(request.jobId, 'jobId') }
  }

  private cleanId(value: string, name: string): string {
    if (typeof value !== 'string') throw new Error(`${name} must be a string`)
    const normalized = value.trim()
    if (!normalized || normalized.includes(separator) || normalized.includes(':') || normalized.length > 160) throw new Error(`${name} must contain safe characters`)
    return normalized
  }

  private key(viewId: string, layerId: string, jobId: string): string {
    return `${viewId}${separator}${layerId}${separator}${jobId}`
  }

  private assertPositiveInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  }

  private assertNonNegativeInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  }

  private assertTimestamp(value: number, name: string): void {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative timestamp`)
  }

  private validateBudget(budget: ArcGisClusterBuildBudget): void {
    for (const [name, value] of Object.entries(budget)) this.assertPositiveInteger(value, name)
    if (budget.maxJobsPerView > budget.maxJobs) throw new Error('maxJobsPerView cannot exceed maxJobs')
    if (budget.maxBuilding > budget.maxJobs) throw new Error('maxBuilding cannot exceed maxJobs')
    if (budget.maxReady > budget.maxJobs) throw new Error('maxReady cannot exceed maxJobs')
    if (budget.maxClustersPerJob > budget.maxFeaturesPerJob) throw new Error('maxClustersPerJob cannot exceed maxFeaturesPerJob')
    if (budget.maxAggregateReadyClusters < budget.maxClustersPerJob) throw new Error('maxAggregateReadyClusters must admit one maximum job')
    if (budget.maxAggregateReadyBytes < budget.maxBytesPerJob) throw new Error('maxAggregateReadyBytes must admit one maximum job')
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('ArcGisClusterBuildLifecyclePolicy is disposed')
  }
}
