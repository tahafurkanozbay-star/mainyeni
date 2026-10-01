export type ArcGisProjectionIntent = 'background' | 'visible' | 'interactive'
export type ArcGisProjectionPhase = 'queued' | 'running' | 'ready'

export interface ArcGisProjectionCacheBudget {
  maxEntries: number
  maxEntriesPerView: number
  maxRunning: number
  maxReady: number
  maxVerticesPerEntry: number
  maxBytesPerEntry: number
  maxAggregateVertices: number
  maxAggregateBytes: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisProjectionRequest {
  viewId: string
  projectionKey: string
  revision: number
  intent: ArcGisProjectionIntent
  requestedAt: number
  vertices: number
  estimatedBytes: number
  inputWkid: number
  outputWkid: number
}

export interface ArcGisProjectionView {
  readonly viewId: string
  readonly projectionKey: string
  readonly revision: number
  readonly intent: ArcGisProjectionIntent
  readonly phase: ArcGisProjectionPhase
  readonly vertices: number
  readonly bytes: number
  readonly inputWkid: number
  readonly outputWkid: number
  readonly expiresAt: number
}

interface Entry extends ArcGisProjectionRequest {
  phase: ArcGisProjectionPhase
  sequence: number
  bytes: number
  expiresAt: number
}

const priority: Readonly<Record<ArcGisProjectionIntent, number>> = Object.freeze({ background: 0, visible: 1, interactive: 2 })

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
 * Payload-free authority for projection result residency. Geometry instances,
 * projection engine handles and transferable buffers stay with the caller.
 */
export class ArcGisProjectionCacheLifecyclePolicy {
  readonly #budget: Readonly<ArcGisProjectionCacheBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisProjectionCacheBudget) {
    integer('maxEntries', budget.maxEntries, 1)
    integer('maxEntriesPerView', budget.maxEntriesPerView, 1)
    integer('maxRunning', budget.maxRunning, 1)
    integer('maxReady', budget.maxReady, 1)
    integer('maxVerticesPerEntry', budget.maxVerticesPerEntry, 1)
    integer('maxBytesPerEntry', budget.maxBytesPerEntry, 1)
    integer('maxAggregateVertices', budget.maxAggregateVertices, 1)
    integer('maxAggregateBytes', budget.maxAggregateBytes, 1)
    finite('queueTtlMs', budget.queueTtlMs)
    finite('runLeaseMs', budget.runLeaseMs)
    finite('readyTtlMs', budget.readyTtlMs)
    if (budget.maxEntriesPerView > budget.maxEntries) throw new Error('maxEntriesPerView cannot exceed maxEntries')
    if (budget.maxRunning > budget.maxEntries || budget.maxReady > budget.maxEntries) throw new Error('phase limits cannot exceed maxEntries')
    if (budget.maxVerticesPerEntry > budget.maxAggregateVertices) throw new Error('vertex budget is inconsistent')
    if (budget.maxBytesPerEntry > budget.maxAggregateBytes) throw new Error('byte budget is inconsistent')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisProjectionRequest): boolean {
    this.#active()
    const viewId = identifier('viewId', request.viewId)
    const projectionKey = identifier('projectionKey', request.projectionKey)
    integer('revision', request.revision, 0)
    finite('requestedAt', request.requestedAt)
    integer('vertices', request.vertices, 0)
    integer('estimatedBytes', request.estimatedBytes, 0)
    integer('inputWkid', request.inputWkid, 1)
    integer('outputWkid', request.outputWkid, 1)
    if (request.vertices > this.#budget.maxVerticesPerEntry || request.estimatedBytes > this.#budget.maxBytesPerEntry) return false
    if (request.inputWkid === request.outputWkid) return false

    const watermark = this.#revisions.get(viewId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidateView(viewId, request.revision)

    const key = this.#key(viewId, projectionKey)
    const existing = this.#entries.get(key)
    if (existing && existing.revision === request.revision && priority[existing.intent] > priority[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxEntries) return false
    if (!existing && this.#countView(viewId) >= this.#budget.maxEntriesPerView) return false
    if (this.#sum('vertices') - (existing?.vertices ?? 0) + request.vertices > this.#budget.maxAggregateVertices) return false
    if (this.#sum('bytes') - (existing?.bytes ?? 0) + request.estimatedBytes > this.#budget.maxAggregateBytes) return false

    this.#entries.set(key, Object.freeze({ ...request, viewId, projectionKey, phase: 'queued', sequence: existing?.sequence ?? this.#sequence++, bytes: request.estimatedBytes, expiresAt: request.requestedAt + this.#budget.queueTtlMs }))
    this.#revisions.set(viewId, request.revision)
    return true
  }

  next(now: number): Readonly<ArcGisProjectionView> | null {
    this.#active(); finite('now', now); this.expire(now)
    if (this.#countPhase('running') >= this.#budget.maxRunning) return null
    const entry = [...this.#entries.values()].filter(candidate => candidate.phase === 'queued').sort((a, b) => priority[b.intent] - priority[a.intent] || a.sequence - b.sequence)[0]
    if (!entry) return null
    const running = Object.freeze({ ...entry, phase: 'running' as const, expiresAt: now + this.#budget.runLeaseMs })
    this.#entries.set(this.#key(entry.viewId, entry.projectionKey), running)
    return this.#view(running)
  }

  complete(viewId: string, projectionKey: string, revision: number, now: number, actualBytes: number): boolean {
    this.#active(); integer('revision', revision, 0); finite('now', now); integer('actualBytes', actualBytes, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('projectionKey', projectionKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision || now > entry.expiresAt) return false
    if (actualBytes > this.#budget.maxBytesPerEntry || this.#countPhase('ready') >= this.#budget.maxReady) return false
    if (this.#sum('bytes') - entry.bytes + actualBytes > this.#budget.maxAggregateBytes) return false
    this.#entries.set(key, Object.freeze({ ...entry, phase: 'ready', bytes: actualBytes, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  consume(viewId: string, projectionKey: string, revision: number): boolean {
    this.#active(); integer('revision', revision, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('projectionKey', projectionKey))
    const entry = this.#entries.get(key)
    return !!entry && entry.phase === 'ready' && entry.revision === revision && this.#entries.delete(key)
  }

  cancel(viewId: string, projectionKey: string): boolean {
    this.#active(); return this.#entries.delete(this.#key(identifier('viewId', viewId), identifier('projectionKey', projectionKey)))
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

  entriesForView(viewId: string): readonly Readonly<ArcGisProjectionView>[] {
    this.#active(); const view = identifier('viewId', viewId)
    return Object.freeze([...this.#entries.values()].filter(entry => entry.viewId === view).sort((a, b) => a.sequence - b.sequence).map(entry => this.#view(entry)))
  }

  snapshot(): Readonly<{ entries: number; queued: number; running: number; ready: number; vertices: number; bytes: number; revisionWatermark: Readonly<Record<string, number>> }> {
    this.#active()
    return Object.freeze({ entries: this.#entries.size, queued: this.#countPhase('queued'), running: this.#countPhase('running'), ready: this.#countPhase('ready'), vertices: this.#sum('vertices'), bytes: this.#sum('bytes'), revisionWatermark: Object.freeze(Object.fromEntries([...this.#revisions.entries()].sort(([a], [b]) => a.localeCompare(b)))) })
  }

  fingerprint(): string {
    this.#active()
    return [...this.#entries.values()].sort((a, b) => a.viewId.localeCompare(b.viewId) || a.projectionKey.localeCompare(b.projectionKey)).map(entry => [entry.viewId, entry.projectionKey, entry.revision, entry.intent, entry.phase, entry.vertices, entry.bytes, entry.inputWkid, entry.outputWkid].join(':')).join('|')
  }

  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }
  #key(viewId: string, projectionKey: string): string { return `${viewId}\u0000${projectionKey}` }
  #countView(viewId: string): number { let total = 0; for (const entry of this.#entries.values()) if (entry.viewId === viewId) total += 1; return total }
  #countPhase(phase: ArcGisProjectionPhase): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) total += 1; return total }
  #sum(field: 'vertices' | 'bytes'): number { let total = 0; for (const entry of this.#entries.values()) total += entry[field]; return total }
  #view(entry: Entry): Readonly<ArcGisProjectionView> { return Object.freeze({ viewId: entry.viewId, projectionKey: entry.projectionKey, revision: entry.revision, intent: entry.intent, phase: entry.phase, vertices: entry.vertices, bytes: entry.bytes, inputWkid: entry.inputWkid, outputWkid: entry.outputWkid, expiresAt: entry.expiresAt }) }
  #active(): void { if (this.#disposed) throw new Error('ArcGisProjectionCacheLifecyclePolicy is disposed') }
}
