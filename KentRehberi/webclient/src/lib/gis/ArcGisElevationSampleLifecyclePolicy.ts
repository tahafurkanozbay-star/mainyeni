export type ArcGisElevationIntent = 'background' | 'visible' | 'interactive'
export type ArcGisElevationPhase = 'queued' | 'sampling' | 'ready'

export interface ArcGisElevationSampleBudget {
  maxJobs: number
  maxJobsPerView: number
  maxSampling: number
  maxReady: number
  maxPointsPerJob: number
  maxBytesPerJob: number
  maxAggregateReadyPoints: number
  maxAggregateReadyBytes: number
  queueTtlMs: number
  samplingLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisElevationSampleRequest {
  viewId: string
  surfaceId: string
  jobId: string
  revision: number
  intent: ArcGisElevationIntent
  requestedAt: number
  inputWkid: number
  outputWkid: number
  pointCount: number
  estimatedBytes: number
}

export interface ArcGisElevationSampleView {
  readonly viewId: string
  readonly surfaceId: string
  readonly jobId: string
  readonly revision: number
  readonly intent: ArcGisElevationIntent
  readonly phase: ArcGisElevationPhase
  readonly inputWkid: number
  readonly outputWkid: number
  readonly pointCount: number
  readonly bytes: number
  readonly expiresAt: number
}

interface Entry extends ArcGisElevationSampleRequest {
  phase: ArcGisElevationPhase
  sequence: number
  bytes: number
  expiresAt: number
}

const priority: Readonly<Record<ArcGisElevationIntent, number>> = Object.freeze({ background: 0, visible: 1, interactive: 2 })

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}
function finite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
}
function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || normalized.includes('\u0000')) throw new Error(`${name} must contain 1..256 safe characters`)
  return normalized
}

/**
 * Payload-free lifecycle authority for ArcGIS elevation sampling.
 * Geometry, Graphic, ElevationLayer, AbortController and transferable buffers stay outside this policy.
 */
export class ArcGisElevationSampleLifecyclePolicy {
  readonly #budget: Readonly<ArcGisElevationSampleBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisElevationSampleBudget) {
    integer('maxJobs', budget.maxJobs, 1)
    integer('maxJobsPerView', budget.maxJobsPerView, 1)
    integer('maxSampling', budget.maxSampling, 1)
    integer('maxReady', budget.maxReady, 1)
    integer('maxPointsPerJob', budget.maxPointsPerJob, 1)
    integer('maxBytesPerJob', budget.maxBytesPerJob, 1)
    integer('maxAggregateReadyPoints', budget.maxAggregateReadyPoints, 1)
    integer('maxAggregateReadyBytes', budget.maxAggregateReadyBytes, 1)
    integer('queueTtlMs', budget.queueTtlMs, 1)
    integer('samplingLeaseMs', budget.samplingLeaseMs, 1)
    integer('readyTtlMs', budget.readyTtlMs, 1)
    if (budget.maxJobsPerView > budget.maxJobs || budget.maxSampling > budget.maxJobs || budget.maxReady > budget.maxJobs) {
      throw new Error('phase/per-view limits cannot exceed maxJobs')
    }
    if (budget.maxAggregateReadyPoints < budget.maxPointsPerJob || budget.maxAggregateReadyBytes < budget.maxBytesPerJob) {
      throw new Error('aggregate ready budgets must admit one maximum job')
    }
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(request: ArcGisElevationSampleRequest): boolean {
    this.#active()
    const viewId = identifier('viewId', request.viewId)
    const surfaceId = identifier('surfaceId', request.surfaceId)
    const jobId = identifier('jobId', request.jobId)
    integer('revision', request.revision, 0)
    finite('requestedAt', request.requestedAt)
    integer('inputWkid', request.inputWkid, 1)
    integer('outputWkid', request.outputWkid, 1)
    integer('pointCount', request.pointCount, 1)
    integer('estimatedBytes', request.estimatedBytes, 1)
    if (request.pointCount > this.#budget.maxPointsPerJob || request.estimatedBytes > this.#budget.maxBytesPerJob) return false

    const watermark = this.#revisions.get(viewId)
    if (watermark !== undefined && request.revision < watermark) return false
    const key = this.#key(viewId, surfaceId, jobId)
    const existing = this.#entries.get(key)
    if (existing) {
      if (existing.revision >= request.revision) return false
      this.#entries.delete(key)
    }
    if (this.#entries.size >= this.#budget.maxJobs || this.#countView(viewId) >= this.#budget.maxJobsPerView) return false

    this.#revisions.set(viewId, Math.max(watermark ?? request.revision, request.revision))
    this.#entries.set(key, {
      ...request,
      viewId,
      surfaceId,
      jobId,
      phase: 'queued',
      sequence: this.#sequence++,
      bytes: 0,
      expiresAt: request.requestedAt + this.#budget.queueTtlMs,
    })
    return true
  }

  takeNext(now: number): ArcGisElevationSampleView | undefined {
    this.#active()
    finite('now', now)
    this.expire(now)
    if (this.#countPhase('sampling') >= this.#budget.maxSampling) return undefined
    const next = [...this.#entries.values()]
      .filter(entry => entry.phase === 'queued')
      .sort((a, b) => priority[b.intent] - priority[a.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence)[0]
    if (!next) return undefined
    next.phase = 'sampling'
    next.expiresAt = now + this.#budget.samplingLeaseMs
    return this.#view(next)
  }

  complete(viewValue: string, surfaceValue: string, jobValue: string, revision: number, pointCount: number, bytes: number, now: number): boolean {
    this.#active()
    const viewId = identifier('viewId', viewValue)
    const surfaceId = identifier('surfaceId', surfaceValue)
    const jobId = identifier('jobId', jobValue)
    integer('revision', revision, 0)
    integer('pointCount', pointCount, 1)
    integer('bytes', bytes, 1)
    finite('now', now)
    this.expire(now)
    const key = this.#key(viewId, surfaceId, jobId)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'sampling' || entry.revision !== revision) return false
    if (this.#revisions.get(viewId) !== revision || pointCount !== entry.pointCount || pointCount > this.#budget.maxPointsPerJob || bytes > this.#budget.maxBytesPerJob) {
      this.#entries.delete(key)
      return false
    }
    if (this.#countPhase('ready') >= this.#budget.maxReady || this.#readyPoints() + pointCount > this.#budget.maxAggregateReadyPoints || this.#readyBytes() + bytes > this.#budget.maxAggregateReadyBytes) {
      return false
    }
    entry.phase = 'ready'
    entry.bytes = bytes
    entry.expiresAt = now + this.#budget.readyTtlMs
    return true
  }

  consume(viewValue: string, surfaceValue: string, jobValue: string, revision: number): boolean {
    this.#active()
    const key = this.#key(identifier('viewId', viewValue), identifier('surfaceId', surfaceValue), identifier('jobId', jobValue))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready' || entry.revision !== revision) return false
    this.#entries.delete(key)
    return true
  }

  cancel(viewValue: string, surfaceValue: string, jobValue: string, revision: number): boolean {
    this.#active()
    const key = this.#key(identifier('viewId', viewValue), identifier('surfaceId', surfaceValue), identifier('jobId', jobValue))
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision) return false
    this.#entries.delete(key)
    return true
  }

  invalidateView(viewValue: string, revision: number): number {
    this.#active()
    const viewId = identifier('viewId', viewValue)
    integer('revision', revision, 0)
    const current = this.#revisions.get(viewId) ?? -1
    if (revision <= current) return 0
    this.#revisions.set(viewId, revision)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.viewId === viewId && entry.revision < revision) {
        this.#entries.delete(key)
        removed++
      }
    }
    return removed
  }

  releaseView(viewValue: string): number {
    this.#active()
    const viewId = identifier('viewId', viewValue)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.viewId === viewId) {
        this.#entries.delete(key)
        removed++
      }
    }
    this.#revisions.delete(viewId)
    return removed
  }

  expire(now: number): number {
    this.#active()
    finite('now', now)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key)
        removed++
      }
    }
    return removed
  }

  snapshot(): readonly ArcGisElevationSampleView[] {
    this.#active()
    return [...this.#entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.#view(entry))
  }

  fingerprint(): string {
    return this.snapshot().map(entry => `${entry.viewId}:${entry.surfaceId}:${entry.jobId}:${entry.revision}:${entry.phase}:${entry.pointCount}:${entry.bytes}`).join('|')
  }

  dispose(): void {
    this.#entries.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #active(): void {
    if (this.#disposed) throw new Error('ArcGisElevationSampleLifecyclePolicy is disposed')
  }
  #key(viewId: string, surfaceId: string, jobId: string): string { return `${viewId}\u0000${surfaceId}\u0000${jobId}` }
  #countView(viewId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.viewId === viewId) count++; return count }
  #countPhase(phase: ArcGisElevationPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count++; return count }
  #readyPoints(): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') count += entry.pointCount; return count }
  #readyBytes(): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') count += entry.bytes; return count }
  #view(entry: Entry): ArcGisElevationSampleView {
    return Object.freeze({ viewId: entry.viewId, surfaceId: entry.surfaceId, jobId: entry.jobId, revision: entry.revision, intent: entry.intent, phase: entry.phase, inputWkid: entry.inputWkid, outputWkid: entry.outputWkid, pointCount: entry.pointCount, bytes: entry.bytes, expiresAt: entry.expiresAt })
  }
}
