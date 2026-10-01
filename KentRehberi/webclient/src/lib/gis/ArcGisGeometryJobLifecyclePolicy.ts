export type ArcGisGeometryJobIntent = 'background' | 'visible' | 'interactive'
export type ArcGisGeometryJobPhase = 'queued' | 'running' | 'ready'
export type ArcGisGeometryOperation = 'buffer' | 'clip' | 'intersect' | 'union' | 'simplify' | 'project' | 'nearest'

export interface ArcGisGeometryJobBudget {
  maxJobs: number
  maxJobsPerView: number
  maxRunning: number
  maxReady: number
  maxInputVerticesPerJob: number
  maxOutputVerticesPerJob: number
  maxAggregateInputVertices: number
  maxAggregateOutputVertices: number
  maxBytesPerJob: number
  maxAggregateBytes: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisGeometryJobRequest {
  viewId: string
  jobKey: string
  revision: number
  operation: ArcGisGeometryOperation
  intent: ArcGisGeometryJobIntent
  requestedAt: number
  inputVertices: number
  estimatedOutputVertices: number
  estimatedBytes: number
  inputWkid: number
  outputWkid: number
}

export interface ArcGisGeometryJobView {
  readonly viewId: string
  readonly jobKey: string
  readonly revision: number
  readonly operation: ArcGisGeometryOperation
  readonly intent: ArcGisGeometryJobIntent
  readonly phase: ArcGisGeometryJobPhase
  readonly inputVertices: number
  readonly outputVertices: number
  readonly bytes: number
  readonly inputWkid: number
  readonly outputWkid: number
  readonly expiresAt: number
}

interface Entry extends ArcGisGeometryJobRequest {
  phase: ArcGisGeometryJobPhase
  sequence: number
  outputVertices: number
  bytes: number
  expiresAt: number
}

const priority: Readonly<Record<ArcGisGeometryJobIntent, number>> = Object.freeze({ background: 0, visible: 1, interactive: 2 })
const operations = new Set<ArcGisGeometryOperation>(['buffer', 'clip', 'intersect', 'union', 'simplify', 'project', 'nearest'])

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}

function finite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) throw new Error(`${name} must contain 1..256 characters`)
  return normalized
}

/**
 * Payload-free lifecycle authority for CPU/worker ArcGIS geometry operations.
 * Geometry instances, transferable buffers and AbortControllers intentionally stay
 * outside this policy; callers own those resources and cancel them when a lease is
 * rejected, invalidated, expired or released.
 */
export class ArcGisGeometryJobLifecyclePolicy {
  readonly #budget: Readonly<ArcGisGeometryJobBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisGeometryJobBudget) {
    integer('maxJobs', budget.maxJobs, 1)
    integer('maxJobsPerView', budget.maxJobsPerView, 1)
    integer('maxRunning', budget.maxRunning, 1)
    integer('maxReady', budget.maxReady, 1)
    integer('maxInputVerticesPerJob', budget.maxInputVerticesPerJob, 1)
    integer('maxOutputVerticesPerJob', budget.maxOutputVerticesPerJob, 1)
    integer('maxAggregateInputVertices', budget.maxAggregateInputVertices, 1)
    integer('maxAggregateOutputVertices', budget.maxAggregateOutputVertices, 1)
    integer('maxBytesPerJob', budget.maxBytesPerJob, 1)
    integer('maxAggregateBytes', budget.maxAggregateBytes, 1)
    finite('queueTtlMs', budget.queueTtlMs)
    finite('runLeaseMs', budget.runLeaseMs)
    finite('readyTtlMs', budget.readyTtlMs)
    if (budget.maxJobsPerView > budget.maxJobs) throw new Error('maxJobsPerView cannot exceed maxJobs')
    if (budget.maxRunning > budget.maxJobs || budget.maxReady > budget.maxJobs) throw new Error('phase limits cannot exceed maxJobs')
    if (budget.maxInputVerticesPerJob > budget.maxAggregateInputVertices) throw new Error('input vertex budget is inconsistent')
    if (budget.maxOutputVerticesPerJob > budget.maxAggregateOutputVertices) throw new Error('output vertex budget is inconsistent')
    if (budget.maxBytesPerJob > budget.maxAggregateBytes) throw new Error('byte budget is inconsistent')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisGeometryJobRequest): boolean {
    this.#active()
    const viewId = identifier('viewId', request.viewId)
    const jobKey = identifier('jobKey', request.jobKey)
    integer('revision', request.revision, 0)
    finite('requestedAt', request.requestedAt)
    integer('inputVertices', request.inputVertices, 0)
    integer('estimatedOutputVertices', request.estimatedOutputVertices, 0)
    integer('estimatedBytes', request.estimatedBytes, 0)
    integer('inputWkid', request.inputWkid, 1)
    integer('outputWkid', request.outputWkid, 1)
    if (!operations.has(request.operation)) throw new Error('operation is not supported')
    if (request.inputVertices > this.#budget.maxInputVerticesPerJob || request.estimatedOutputVertices > this.#budget.maxOutputVerticesPerJob || request.estimatedBytes > this.#budget.maxBytesPerJob) return false

    const watermark = this.#revisions.get(viewId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidateView(viewId, request.revision)

    const key = this.#key(viewId, jobKey)
    const existing = this.#entries.get(key)
    if (existing && existing.revision === request.revision && priority[existing.intent] > priority[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxJobs) return false
    if (!existing && this.#countView(viewId) >= this.#budget.maxJobsPerView) return false

    const inputDelta = request.inputVertices - (existing?.inputVertices ?? 0)
    const outputDelta = request.estimatedOutputVertices - (existing?.outputVertices ?? 0)
    const byteDelta = request.estimatedBytes - (existing?.bytes ?? 0)
    if (this.#sum('inputVertices') + inputDelta > this.#budget.maxAggregateInputVertices) return false
    if (this.#sum('outputVertices') + outputDelta > this.#budget.maxAggregateOutputVertices) return false
    if (this.#sum('bytes') + byteDelta > this.#budget.maxAggregateBytes) return false

    this.#entries.set(key, Object.freeze({
      ...request,
      viewId,
      jobKey,
      phase: 'queued',
      sequence: existing?.sequence ?? this.#sequence++,
      outputVertices: request.estimatedOutputVertices,
      bytes: request.estimatedBytes,
      expiresAt: request.requestedAt + this.#budget.queueTtlMs,
    }))
    this.#revisions.set(viewId, request.revision)
    return true
  }

  next(now: number): Readonly<ArcGisGeometryJobView> | null {
    this.#active(); finite('now', now); this.expire(now)
    if (this.#countPhase('running') >= this.#budget.maxRunning) return null
    const entry = [...this.#entries.values()]
      .filter(candidate => candidate.phase === 'queued')
      .sort((a, b) => priority[b.intent] - priority[a.intent] || a.sequence - b.sequence)[0]
    if (!entry) return null
    const running = Object.freeze({ ...entry, phase: 'running' as const, expiresAt: now + this.#budget.runLeaseMs })
    this.#entries.set(this.#key(entry.viewId, entry.jobKey), running)
    return this.#view(running)
  }

  complete(viewId: string, jobKey: string, revision: number, now: number, actualOutputVertices: number, actualBytes: number): boolean {
    this.#active(); integer('revision', revision, 0); finite('now', now); integer('actualOutputVertices', actualOutputVertices, 0); integer('actualBytes', actualBytes, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('jobKey', jobKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision || now > entry.expiresAt) return false
    if (actualOutputVertices > this.#budget.maxOutputVerticesPerJob || actualBytes > this.#budget.maxBytesPerJob) return false
    if (this.#countPhase('ready') >= this.#budget.maxReady) return false
    if (this.#sum('outputVertices') - entry.outputVertices + actualOutputVertices > this.#budget.maxAggregateOutputVertices) return false
    if (this.#sum('bytes') - entry.bytes + actualBytes > this.#budget.maxAggregateBytes) return false
    this.#entries.set(key, Object.freeze({ ...entry, phase: 'ready', outputVertices: actualOutputVertices, bytes: actualBytes, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  consume(viewId: string, jobKey: string, revision: number): boolean {
    this.#active(); integer('revision', revision, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('jobKey', jobKey))
    const entry = this.#entries.get(key)
    return !!entry && entry.phase === 'ready' && entry.revision === revision && this.#entries.delete(key)
  }

  cancel(viewId: string, jobKey: string): boolean {
    this.#active(); return this.#entries.delete(this.#key(identifier('viewId', viewId), identifier('jobKey', jobKey)))
  }

  invalidateView(viewId: string, revision: number): number {
    this.#active(); const view = identifier('viewId', viewId); integer('revision', revision, 0)
    const current = this.#revisions.get(view)
    if (current !== undefined && revision <= current) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.viewId === view && entry.revision < revision) { this.#entries.delete(key); removed += 1 }
    this.#revisions.set(view, revision)
    return removed
  }

  releaseView(viewId: string): number {
    this.#active(); const view = identifier('viewId', viewId); let removed = 0
    for (const [key, entry] of this.#entries) if (entry.viewId === view) { this.#entries.delete(key); removed += 1 }
    this.#revisions.delete(view)
    return removed
  }

  expire(now: number): number {
    this.#active(); finite('now', now); let removed = 0
    for (const [key, entry] of this.#entries) if (now > entry.expiresAt) { this.#entries.delete(key); removed += 1 }
    return removed
  }

  entriesForView(viewId: string): readonly Readonly<ArcGisGeometryJobView>[] {
    this.#active(); const view = identifier('viewId', viewId)
    return Object.freeze([...this.#entries.values()].filter(entry => entry.viewId === view).sort((a, b) => a.sequence - b.sequence).map(entry => this.#view(entry)))
  }

  snapshot(): Readonly<{ jobs: number; queued: number; running: number; ready: number; inputVertices: number; outputVertices: number; bytes: number; revisionWatermark: Readonly<Record<string, number>> }> {
    this.#active()
    return Object.freeze({
      jobs: this.#entries.size,
      queued: this.#countPhase('queued'),
      running: this.#countPhase('running'),
      ready: this.#countPhase('ready'),
      inputVertices: this.#sum('inputVertices'),
      outputVertices: this.#sum('outputVertices'),
      bytes: this.#sum('bytes'),
      revisionWatermark: Object.freeze(Object.fromEntries([...this.#revisions.entries()].sort(([a], [b]) => a.localeCompare(b)))),
    })
  }

  fingerprint(): string {
    this.#active()
    return [...this.#entries.values()].sort((a, b) => a.viewId.localeCompare(b.viewId) || a.jobKey.localeCompare(b.jobKey)).map(entry => [entry.viewId, entry.jobKey, entry.revision, entry.operation, entry.intent, entry.phase, entry.inputVertices, entry.outputVertices, entry.bytes, entry.inputWkid, entry.outputWkid].join(':')).join('|')
  }

  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }

  #key(viewId: string, jobKey: string): string { return `${viewId}\u0000${jobKey}` }
  #countView(viewId: string): number { let total = 0; for (const entry of this.#entries.values()) if (entry.viewId === viewId) total += 1; return total }
  #countPhase(phase: ArcGisGeometryJobPhase): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) total += 1; return total }
  #sum(field: 'inputVertices' | 'outputVertices' | 'bytes'): number { let total = 0; for (const entry of this.#entries.values()) total += entry[field]; return total }
  #view(entry: Entry): Readonly<ArcGisGeometryJobView> { return Object.freeze({ viewId: entry.viewId, jobKey: entry.jobKey, revision: entry.revision, operation: entry.operation, intent: entry.intent, phase: entry.phase, inputVertices: entry.inputVertices, outputVertices: entry.outputVertices, bytes: entry.bytes, inputWkid: entry.inputWkid, outputWkid: entry.outputWkid, expiresAt: entry.expiresAt }) }
  #active(): void { if (this.#disposed) throw new Error('ArcGisGeometryJobLifecyclePolicy is disposed') }
}
