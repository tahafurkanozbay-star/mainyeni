export type ArcGisFeatureHydrationIntent = 'interactive' | 'visible' | 'background'
export type ArcGisFeatureHydrationPhase = 'queued' | 'loading' | 'ready'

export interface ArcGisFeatureHydrationBudget {
  maxJobs: number
  maxJobsPerLayer: number
  maxLoading: number
  maxReady: number
  maxObjectIdsPerJob: number
  maxEstimatedBytesPerJob: number
  maxAggregateReadyBytes: number
  queueTtlMs: number
  loadLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisFeatureHydrationRequest {
  layerId: string
  jobId: string
  revision: number
  intent: ArcGisFeatureHydrationIntent
  requestedAt: number
  objectIdCount: number
  fieldCount: number
  estimatedBytes: number
}

export interface ArcGisFeatureHydrationSnapshot extends ArcGisFeatureHydrationRequest {
  phase: ArcGisFeatureHydrationPhase
  actualBytes: number
  featureCount: number
  expiresAt: number
}

type Entry = ArcGisFeatureHydrationSnapshot & { sequence: number }
const rank: Record<ArcGisFeatureHydrationIntent, number> = { interactive: 0, visible: 1, background: 2 }
const sep = '\u0000'

/** Scalar-only authority for FeatureServer result hydration. Feature/Graphic,
 * attributes, geometry, credentials, response JSON and AbortSignal stay caller-owned. */
export class ArcGisFeatureHydrationLifecyclePolicy {
  private readonly jobs = new Map<string, Entry>()
  private readonly revisions = new Map<string, number>()
  private sequence = 0
  private disposed = false

  constructor(private readonly budget: ArcGisFeatureHydrationBudget) { this.validateBudget() }

  enqueue(input: ArcGisFeatureHydrationRequest): boolean {
    this.active()
    const request = this.normalize(input)
    const watermark = this.revisions.get(request.layerId) ?? 0
    if (request.revision < watermark) return false
    const key = this.key(request.layerId, request.jobId)
    const previous = this.jobs.get(key)
    if (previous && request.revision <= previous.revision) return false
    if (request.objectIdCount > this.budget.maxObjectIdsPerJob || request.estimatedBytes > this.budget.maxEstimatedBytesPerJob) return false

    // Admission is evaluated against the state that would remain after a
    // monotonic revision supersession. This avoids rejecting a fresh revision
    // merely because stale generations currently occupy the bounded registry,
    // while still leaving all existing ownership untouched when admission fails.
    const supersedesLayer = request.revision > watermark
    const survivesReplacement = (entry: Entry): boolean => {
      if (entry === previous) return false
      if (supersedesLayer && entry.layerId === request.layerId && entry.revision < request.revision) return false
      return true
    }
    const totalAfterReplacement = this.count(survivesReplacement) + 1
    const layerAfterReplacement = this.count(entry => survivesReplacement(entry) && entry.layerId === request.layerId) + 1
    if (totalAfterReplacement > this.budget.maxJobs || layerAfterReplacement > this.budget.maxJobsPerLayer) return false

    if (supersedesLayer) this.invalidateLayer(request.layerId, request.revision)
    else if (previous) this.jobs.delete(key)
    this.revisions.set(request.layerId, request.revision)
    this.jobs.set(key, { ...request, phase: 'queued', actualBytes: 0, featureCount: 0, expiresAt: request.requestedAt + this.budget.queueTtlMs, sequence: this.sequence++ })
    return true
  }

  takeNext(now: number): ArcGisFeatureHydrationSnapshot | undefined {
    this.active(); this.timestamp(now); this.expire(now)
    if (this.count(entry => entry.phase === 'loading') >= this.budget.maxLoading) return undefined
    const next = [...this.jobs.values()].filter(entry => entry.phase === 'queued')
      .sort((a, b) => rank[a.intent] - rank[b.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence)[0]
    if (!next) return undefined
    next.phase = 'loading'; next.expiresAt = now + this.budget.loadLeaseMs
    return this.detach(next)
  }

  complete(layerId: string, jobId: string, revision: number, featureCount: number, actualBytes: number, now: number): boolean {
    this.active(); this.timestamp(now); this.nonNegative(featureCount, 'featureCount'); this.nonNegative(actualBytes, 'actualBytes')
    const layer = this.id(layerId, 'layerId'), job = this.id(jobId, 'jobId')
    const entry = this.jobs.get(this.key(layer, job))
    if (!entry || entry.phase !== 'loading' || entry.revision !== revision) return false
    if (now >= entry.expiresAt || revision < (this.revisions.get(layer) ?? 0) || featureCount > entry.objectIdCount || actualBytes > this.budget.maxEstimatedBytesPerJob) { this.jobs.delete(this.key(layer, job)); return false }
    if (this.count(item => item.phase === 'ready') >= this.budget.maxReady || this.readyBytes() + actualBytes > this.budget.maxAggregateReadyBytes) { this.jobs.delete(this.key(layer, job)); return false }
    entry.phase = 'ready'; entry.featureCount = featureCount; entry.actualBytes = actualBytes; entry.expiresAt = now + this.budget.readyTtlMs
    return true
  }

  consume(layerId: string, jobId: string, revision: number): boolean { return this.removeMatching(layerId, jobId, revision, 'ready') }
  cancel(layerId: string, jobId: string, revision: number): boolean { return this.removeMatching(layerId, jobId, revision) }

  invalidateLayer(layerId: string, revision: number): number {
    this.active(); const layer = this.id(layerId, 'layerId'); this.positive(revision, 'revision')
    const current = this.revisions.get(layer) ?? 0
    if (revision <= current) return 0
    this.revisions.set(layer, revision)
    return this.release(entry => entry.layerId === layer && entry.revision < revision)
  }

  expire(now: number): number { this.active(); this.timestamp(now); return this.release(entry => now >= entry.expiresAt) }
  releaseLayer(layerId: string): number { this.active(); const layer = this.id(layerId, 'layerId'); this.revisions.delete(layer); return this.release(entry => entry.layerId === layer) }
  snapshot(): ArcGisFeatureHydrationSnapshot[] { this.active(); return [...this.jobs.values()].sort((a,b) => a.sequence-b.sequence).map(entry => this.detach(entry)) }
  fingerprint(): string { return this.snapshot().map(entry => `${entry.layerId}:${entry.jobId}:${entry.revision}:${entry.phase}:${entry.intent}:${entry.objectIdCount}:${entry.fieldCount}:${entry.actualBytes}`).join('|') }
  dispose(): void { if (!this.disposed) { this.jobs.clear(); this.revisions.clear(); this.disposed = true } }

  private removeMatching(layerId: string, jobId: string, revision: number, phase?: ArcGisFeatureHydrationPhase): boolean {
    this.active(); const key = this.key(this.id(layerId, 'layerId'), this.id(jobId, 'jobId')); const entry = this.jobs.get(key)
    if (!entry || entry.revision !== revision || (phase && entry.phase !== phase)) return false
    this.jobs.delete(key); return true
  }
  private normalize(request: ArcGisFeatureHydrationRequest): ArcGisFeatureHydrationRequest {
    if (!(request.intent in rank)) throw new Error('intent is invalid')
    this.positive(request.revision, 'revision'); this.timestamp(request.requestedAt); this.positive(request.objectIdCount, 'objectIdCount'); this.positive(request.fieldCount, 'fieldCount'); this.nonNegative(request.estimatedBytes, 'estimatedBytes')
    return { ...request, layerId: this.id(request.layerId, 'layerId'), jobId: this.id(request.jobId, 'jobId') }
  }
  private validateBudget(): void {
    for (const [name, value] of Object.entries(this.budget)) this.positive(value, name)
    if (this.budget.maxJobsPerLayer > this.budget.maxJobs || this.budget.maxLoading > this.budget.maxJobs || this.budget.maxReady > this.budget.maxJobs) throw new RangeError('hydration cardinality budget is inconsistent')
    if (this.budget.maxAggregateReadyBytes < this.budget.maxEstimatedBytesPerJob) throw new RangeError('aggregate ready bytes must admit one maximum job')
  }
  private id(value: string, name: string): string { const normalized = value.trim(); if (!normalized || normalized.length > 160 || normalized.includes(sep) || normalized.includes(':')) throw new Error(`${name} must contain safe characters`); return normalized }
  private key(layer: string, job: string): string { return `${layer}${sep}${job}` }
  private positive(value: number, name: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`) }
  private nonNegative(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`) }
  private timestamp(value: number): void { if (!Number.isFinite(value) || value < 0) throw new RangeError('timestamp must be finite and non-negative') }
  private count(predicate: (entry: Entry) => boolean): number { let n=0; for (const entry of this.jobs.values()) if (predicate(entry)) n++; return n }
  private readyBytes(): number { let n=0; for (const entry of this.jobs.values()) if (entry.phase === 'ready') n += entry.actualBytes; return n }
  private release(predicate: (entry: Entry) => boolean): number { let n=0; for (const [key, entry] of this.jobs) if (predicate(entry)) { this.jobs.delete(key); n++ } return n }
  private detach(entry: Entry): ArcGisFeatureHydrationSnapshot { const { sequence: _sequence, ...snapshot } = entry; return { ...snapshot } }
  private active(): void { if (this.disposed) throw new Error('ArcGisFeatureHydrationLifecyclePolicy is disposed') }
}
