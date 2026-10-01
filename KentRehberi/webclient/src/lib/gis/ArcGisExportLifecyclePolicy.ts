export type ArcGisExportIntent = 'preview' | 'download' | 'print'
export type ArcGisExportState = 'queued' | 'running' | 'ready'

export interface ArcGisExportBudget {
  maxViews: number
  maxJobs: number
  maxJobsPerView: number
  maxRunningJobs: number
  maxReadyJobs: number
  maxEstimatedBytes: number
  maxEstimatedBytesPerJob: number
  maxPixelsPerJob: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisExportRequest {
  viewId: string
  jobId: string
  revision: number
  intent: ArcGisExportIntent
  requestedAt: number
  estimatedBytes: number
  width: number
  height: number
  dpi: number
}

export interface ArcGisExportEntry extends ArcGisExportRequest {
  state: ArcGisExportState
  sequence: number
  expiresAt: number
  runLeaseUntil: number | null
  readyBytes: number
}

export interface ArcGisExportSnapshot {
  views: number
  jobs: number
  queued: number
  running: number
  ready: number
  estimatedBytes: number
  readyBytes: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const PRIORITY: Readonly<Record<ArcGisExportIntent, number>> = Object.freeze({ preview: 0, download: 1, print: 2 })

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}
function finite(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`)
}
function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || normalized.includes('\u0000')) throw new Error(`${name} is invalid`)
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
 * Bounded metadata owner for screenshot/print/export work. It deliberately stores neither
 * ArcGIS View instances nor generated Blob/ArrayBuffer payloads, so cancellation/disposal
 * cannot retain SDK graphs, canvases, DOM nodes, or large binary exports.
 */
export class ArcGisExportLifecyclePolicy {
  readonly #budget: Readonly<ArcGisExportBudget>
  readonly #entries = new Map<string, Readonly<ArcGisExportEntry>>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisExportBudget) {
    integer('maxViews', budget.maxViews, 1)
    integer('maxJobs', budget.maxJobs, 1)
    integer('maxJobsPerView', budget.maxJobsPerView, 1)
    integer('maxRunningJobs', budget.maxRunningJobs, 1)
    integer('maxReadyJobs', budget.maxReadyJobs, 1)
    finite('maxEstimatedBytes', budget.maxEstimatedBytes, 1)
    finite('maxEstimatedBytesPerJob', budget.maxEstimatedBytesPerJob, 1)
    integer('maxPixelsPerJob', budget.maxPixelsPerJob, 1)
    finite('queueTtlMs', budget.queueTtlMs, 1)
    finite('runLeaseMs', budget.runLeaseMs, 1)
    finite('readyTtlMs', budget.readyTtlMs, 1)
    if (budget.maxJobsPerView > budget.maxJobs) throw new Error('per-view job budget exceeds aggregate job budget')
    if (budget.maxRunningJobs > budget.maxJobs) throw new Error('running job budget exceeds aggregate job budget')
    if (budget.maxReadyJobs > budget.maxJobs) throw new Error('ready job budget exceeds aggregate job budget')
    if (budget.maxEstimatedBytesPerJob > budget.maxEstimatedBytes) throw new Error('per-job byte budget exceeds aggregate byte budget')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisExportRequest): boolean {
    this.#active()
    const viewId = identifier('viewId', request.viewId)
    const jobId = identifier('jobId', request.jobId)
    integer('revision', request.revision, 0)
    finite('requestedAt', request.requestedAt, 0)
    finite('estimatedBytes', request.estimatedBytes, 0)
    integer('width', request.width, 1)
    integer('height', request.height, 1)
    finite('dpi', request.dpi, 1)
    if (!Object.prototype.hasOwnProperty.call(PRIORITY, request.intent)) throw new Error('intent is invalid')
    const pixels = request.width * request.height
    if (!Number.isSafeInteger(pixels) || pixels > this.#budget.maxPixelsPerJob) return false
    if (request.estimatedBytes > this.#budget.maxEstimatedBytesPerJob) return false
    const watermark = this.#revisions.get(viewId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidateView(viewId, request.revision)
    if (watermark === undefined && this.#revisions.size >= this.#budget.maxViews) return false
    const key = this.#key(viewId, jobId)
    const existing = this.#entries.get(key)
    if (existing && existing.revision !== request.revision) return false
    if (existing && existing.state !== 'queued') return false
    if (existing && PRIORITY[existing.intent] > PRIORITY[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxJobs) return false
    if (!existing && this.#viewCount(viewId) >= this.#budget.maxJobsPerView) return false
    const projected = this.#estimatedBytes() - (existing?.estimatedBytes ?? 0) + request.estimatedBytes
    if (projected > this.#budget.maxEstimatedBytes) return false
    this.#revisions.set(viewId, request.revision)
    this.#entries.set(key, Object.freeze({
      ...request,
      viewId,
      jobId,
      state: 'queued',
      sequence: existing?.sequence ?? this.#sequence++,
      expiresAt: request.requestedAt + this.#budget.queueTtlMs,
      runLeaseUntil: null,
      readyBytes: 0,
    }))
    return true
  }

  begin(viewId: string, jobId: string, revision: number, now: number): boolean {
    this.#active()
    integer('revision', revision, 0)
    finite('now', now, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('jobId', jobId))
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'queued' || now > entry.expiresAt) return false
    if (this.#count('running') >= this.#budget.maxRunningJobs) return false
    this.#entries.set(key, Object.freeze({ ...entry, state: 'running', expiresAt: now + this.#budget.runLeaseMs, runLeaseUntil: now + this.#budget.runLeaseMs }))
    return true
  }

  markReady(viewId: string, jobId: string, revision: number, now: number, readyBytes: number): boolean {
    this.#active()
    integer('revision', revision, 0)
    finite('now', now, 0)
    finite('readyBytes', readyBytes, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('jobId', jobId))
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'running') return false
    if (entry.runLeaseUntil !== null && now > entry.runLeaseUntil) return false
    if (readyBytes > this.#budget.maxEstimatedBytesPerJob) return false
    if (this.#count('ready') >= this.#budget.maxReadyJobs) return false
    const projectedReady = this.#readyBytes() + readyBytes
    if (projectedReady > this.#budget.maxEstimatedBytes) return false
    this.#entries.set(key, Object.freeze({ ...entry, state: 'ready', expiresAt: now + this.#budget.readyTtlMs, runLeaseUntil: null, readyBytes }))
    return true
  }

  consume(viewId: string, jobId: string, revision: number): boolean {
    this.#active()
    integer('revision', revision, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('jobId', jobId))
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'ready') return false
    return this.#entries.delete(key)
  }

  cancel(viewId: string, jobId: string): boolean {
    this.#active()
    return this.#entries.delete(this.#key(identifier('viewId', viewId), identifier('jobId', jobId)))
  }

  invalidateView(viewId: string, revision: number): number {
    this.#active()
    const normalized = identifier('viewId', viewId)
    integer('revision', revision, 0)
    const current = this.#revisions.get(normalized)
    if (current !== undefined && revision <= current) return 0
    if (current === undefined && this.#revisions.size >= this.#budget.maxViews) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.viewId === normalized) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    this.#revisions.set(normalized, revision)
    return removed
  }

  expire(now: number): number {
    this.#active()
    finite('now', now, 0)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (now > entry.expiresAt) {
        this.#entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  nextQueued(): Readonly<ArcGisExportEntry> | null {
    this.#active()
    return [...this.#entries.values()]
      .filter(entry => entry.state === 'queued')
      .sort((a, b) => PRIORITY[b.intent] - PRIORITY[a.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence || a.viewId.localeCompare(b.viewId) || a.jobId.localeCompare(b.jobId))[0] ?? null
  }

  entriesForView(viewId: string): readonly Readonly<ArcGisExportEntry>[] {
    this.#active()
    const normalized = identifier('viewId', viewId)
    return Object.freeze([...this.#entries.values()]
      .filter(entry => entry.viewId === normalized)
      .sort((a, b) => this.#stateRank(b.state) - this.#stateRank(a.state) || PRIORITY[b.intent] - PRIORITY[a.intent] || a.sequence - b.sequence || a.jobId.localeCompare(b.jobId)))
  }

  snapshot(): Readonly<ArcGisExportSnapshot> {
    this.#active()
    const revisionWatermark = Object.freeze(Object.fromEntries([...this.#revisions.entries()].sort(([a], [b]) => a.localeCompare(b))))
    const ordered = [...this.#entries.values()].sort((a, b) => a.viewId.localeCompare(b.viewId) || a.jobId.localeCompare(b.jobId))
    const facts = ordered.map(entry => `${entry.viewId}:${entry.jobId}:${entry.revision}:${entry.intent}:${entry.state}:${entry.estimatedBytes}:${entry.readyBytes}:${entry.width}x${entry.height}:${entry.dpi}`).join('|')
    return Object.freeze({
      views: this.#revisions.size,
      jobs: this.#entries.size,
      queued: this.#count('queued'),
      running: this.#count('running'),
      ready: this.#count('ready'),
      estimatedBytes: this.#estimatedBytes(),
      readyBytes: this.#readyBytes(),
      revisionWatermark,
      fingerprint: hash(facts),
    })
  }

  dispose(): void {
    this.#entries.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #key(viewId: string, jobId: string): string { return `${viewId}\u0000${jobId}` }
  #viewCount(viewId: string): number {
    let count = 0
    for (const entry of this.#entries.values()) if (entry.viewId === viewId) count += 1
    return count
  }
  #count(state: ArcGisExportState): number {
    let count = 0
    for (const entry of this.#entries.values()) if (entry.state === state) count += 1
    return count
  }
  #estimatedBytes(): number {
    let bytes = 0
    for (const entry of this.#entries.values()) bytes += entry.estimatedBytes
    return bytes
  }
  #readyBytes(): number {
    let bytes = 0
    for (const entry of this.#entries.values()) if (entry.state === 'ready') bytes += entry.readyBytes
    return bytes
  }
  #stateRank(state: ArcGisExportState): number { return state === 'ready' ? 2 : state === 'running' ? 1 : 0 }
  #active(): void { if (this.#disposed) throw new Error('ArcGisExportLifecyclePolicy is disposed') }
}
