export type ArcGisExportIntent = 'interactive' | 'share' | 'background'
export type ArcGisExportPhase = 'queued' | 'running' | 'ready'
export type ArcGisExportFormat = 'pdf' | 'png' | 'jpg'

export interface ArcGisExportJobBudget {
  maxJobs: number
  maxJobsPerView: number
  maxRunning: number
  maxReady: number
  maxEstimatedBytesPerJob: number
  maxAggregateReadyBytes: number
  maxPixelCount: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisExportJobRequest {
  viewId: string
  jobId: string
  revision: number
  intent: ArcGisExportIntent
  format: ArcGisExportFormat
  requestedAt: number
  width: number
  height: number
  dpi: number
  estimatedBytes: number
}

export interface ArcGisExportJobSnapshot extends ArcGisExportJobRequest {
  phase: ArcGisExportPhase
  sequence: number
  expiresAt: number
  startedAt?: number
  actualBytes?: number
}

type Entry = ArcGisExportJobSnapshot
const rank: Record<ArcGisExportIntent, number> = { interactive: 0, share: 1, background: 2 }
const formats: Record<ArcGisExportFormat, true> = { pdf: true, png: true, jpg: true }
const safeInteger = (value: number, min = 0) => Number.isSafeInteger(value) && value >= min
const finite = (value: number, min = 0) => Number.isFinite(value) && value >= min
function identifier(value: string): string | undefined {
  const normalized = value.trim()
  if (!normalized || normalized.length > 160 || /[|\u0000-\u001f\u007f]/u.test(normalized)) return undefined
  return normalized
}
const key = (viewId: string, jobId: string) => `${viewId}|${jobId}`

/**
 * Bounded scalar authority for ArcGIS print/export orchestration. It never owns
 * MapView/SceneView, WebMap JSON, credentials, Blob/ArrayBuffer, response bodies,
 * AbortController or download URLs. Transport and payload disposal stay caller-owned.
 */
export class ArcGisExportJobLifecyclePolicy {
  private readonly entries = new Map<string, Entry>()
  private readonly viewRevisions = new Map<string, number>()
  private sequence = 0

  constructor(private readonly budget: ArcGisExportJobBudget) { this.validateBudget(budget) }

  enqueue(input: ArcGisExportJobRequest): boolean {
    const request = this.normalize(input)
    if (!request) return false
    const watermark = this.viewRevisions.get(request.viewId) ?? 0
    if (request.revision < watermark) return false
    if (request.revision > watermark) this.invalidateView(request.viewId, request.revision)
    const entryKey = key(request.viewId, request.jobId)
    const previous = this.entries.get(entryKey)
    if (previous && previous.revision >= request.revision) return false
    if (previous) this.entries.delete(entryKey)
    if (this.entries.size >= this.budget.maxJobs) return false
    if (this.count(entry => entry.viewId === request.viewId) >= this.budget.maxJobsPerView) return false
    this.entries.set(entryKey, { ...request, phase: 'queued', sequence: ++this.sequence, expiresAt: request.requestedAt + this.budget.queueTtlMs })
    return true
  }

  takeNext(now: number): ArcGisExportJobSnapshot | undefined {
    if (!finite(now)) return undefined
    this.expire(now)
    if (this.count(entry => entry.phase === 'running') >= this.budget.maxRunning) return undefined
    const queued = [...this.entries.values()].filter(entry => entry.phase === 'queued')
    queued.sort((a, b) => rank[a.intent] - rank[b.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence)
    const next = queued[0]
    if (!next) return undefined
    next.phase = 'running'
    next.startedAt = now
    next.expiresAt = now + this.budget.runLeaseMs
    return this.detach(next)
  }

  complete(viewId: string, jobId: string, revision: number, actualBytes: number, now: number): boolean {
    const view = identifier(viewId), job = identifier(jobId)
    if (!view || !job || !safeInteger(revision, 1) || !safeInteger(actualBytes) || !finite(now)) return false
    const entryKey = key(view, job)
    const entry = this.entries.get(entryKey)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision) return false
    if (now >= entry.expiresAt || revision !== (this.viewRevisions.get(view) ?? revision)) { this.entries.delete(entryKey); return false }
    if (actualBytes > this.budget.maxEstimatedBytesPerJob || this.count(item => item.phase === 'ready') >= this.budget.maxReady || this.readyBytes() + actualBytes > this.budget.maxAggregateReadyBytes) {
      this.entries.delete(entryKey)
      return false
    }
    entry.phase = 'ready'
    entry.actualBytes = actualBytes
    entry.expiresAt = now + this.budget.readyTtlMs
    return true
  }

  touch(viewId: string, jobId: string, revision: number, now: number): boolean {
    const entry = this.lookup(viewId, jobId)
    if (!entry || entry.phase !== 'ready' || entry.revision !== revision || !finite(now) || now >= entry.expiresAt) return false
    entry.expiresAt = now + this.budget.readyTtlMs
    return true
  }

  consume(viewId: string, jobId: string, revision: number): boolean {
    const entry = this.lookup(viewId, jobId)
    if (!entry || entry.phase !== 'ready' || entry.revision !== revision) return false
    return this.entries.delete(key(entry.viewId, entry.jobId))
  }

  cancel(viewId: string, jobId: string, revision: number): boolean {
    const entry = this.lookup(viewId, jobId)
    if (!entry || entry.revision !== revision) return false
    return this.entries.delete(key(entry.viewId, entry.jobId))
  }

  invalidateView(viewId: string, revision: number): number {
    const view = identifier(viewId)
    if (!view || !safeInteger(revision, 1)) return 0
    const previous = this.viewRevisions.get(view) ?? 0
    if (revision < previous) return 0
    this.viewRevisions.set(view, revision)
    return this.release(entry => entry.viewId === view && entry.revision < revision)
  }

  expire(now: number): number {
    if (!finite(now)) return 0
    return this.release(entry => now >= entry.expiresAt)
  }

  releaseView(viewId: string): number {
    const view = identifier(viewId)
    if (!view) return 0
    this.viewRevisions.delete(view)
    return this.release(entry => entry.viewId === view)
  }

  snapshot(): ArcGisExportJobSnapshot[] {
    return [...this.entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.detach(entry))
  }

  fingerprint(): string {
    return this.snapshot().map(entry => [entry.viewId, entry.jobId, entry.revision, entry.intent, entry.format, entry.phase, entry.width, entry.height, entry.dpi, entry.estimatedBytes, entry.actualBytes ?? 0].join(':')).join('|')
  }

  private lookup(viewId: string, jobId: string): Entry | undefined {
    const view = identifier(viewId), job = identifier(jobId)
    return view && job ? this.entries.get(key(view, job)) : undefined
  }

  private normalize(input: ArcGisExportJobRequest): ArcGisExportJobRequest | undefined {
    const viewId = identifier(input.viewId), jobId = identifier(input.jobId)
    if (!viewId || !jobId || !safeInteger(input.revision, 1) || !finite(input.requestedAt) || !safeInteger(input.width, 1) || !safeInteger(input.height, 1) || !safeInteger(input.dpi, 1) || !safeInteger(input.estimatedBytes)) return undefined
    if (!(input.intent in rank) || !(input.format in formats) || input.estimatedBytes > this.budget.maxEstimatedBytesPerJob) return undefined
    if (input.width > Math.floor(this.budget.maxPixelCount / input.height) || input.width * input.height > this.budget.maxPixelCount) return undefined
    return { ...input, viewId, jobId }
  }

  private validateBudget(budget: ArcGisExportJobBudget): void {
    const values = [budget.maxJobs, budget.maxJobsPerView, budget.maxRunning, budget.maxReady, budget.maxEstimatedBytesPerJob, budget.maxAggregateReadyBytes, budget.maxPixelCount, budget.queueTtlMs, budget.runLeaseMs, budget.readyTtlMs]
    if (values.some(value => !safeInteger(value, 1))) throw new RangeError('ArcGIS export job budget values must be positive safe integers')
    if (budget.maxJobsPerView > budget.maxJobs || budget.maxRunning > budget.maxJobs || budget.maxReady > budget.maxJobs) throw new RangeError('ArcGIS export job cardinality budget is inconsistent')
  }

  private count(predicate: (entry: Entry) => boolean): number { let total = 0; for (const entry of this.entries.values()) if (predicate(entry)) total++; return total }
  private readyBytes(): number { let total = 0; for (const entry of this.entries.values()) if (entry.phase === 'ready') total += entry.actualBytes ?? 0; return total }
  private release(predicate: (entry: Entry) => boolean): number { let removed = 0; for (const [entryKey, entry] of this.entries) if (predicate(entry)) { this.entries.delete(entryKey); removed++ } return removed }
  private detach(entry: Entry): ArcGisExportJobSnapshot { return { ...entry } }
}
