export type ArcGisIdentifyIntent = 'hover' | 'visible' | 'interactive'
export type ArcGisIdentifyPhase = 'queued' | 'running' | 'ready'

export interface ArcGisIdentifyBudget {
  maxRequests: number
  maxRunning: number
  maxReady: number
  maxResults: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisIdentifyRequest {
  viewId: string
  requestKey: string
  revision: number
  intent: ArcGisIdentifyIntent
  requestedAt: number
  estimatedResults: number
  spatialReferenceWkid: number
}

interface Entry extends ArcGisIdentifyRequest {
  phase: ArcGisIdentifyPhase
  sequence: number
  expiresAt: number
}

const priority: Readonly<Record<ArcGisIdentifyIntent, number>> = Object.freeze({ hover: 0, visible: 1, interactive: 2 })

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}

function finite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

function id(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) throw new Error(`${name} must contain 1..256 characters`)
  return normalized
}

/** Payload-free scheduling metadata for ArcGIS identify requests. */
export class ArcGisIdentifyLifecyclePolicy {
  readonly #budget: Readonly<ArcGisIdentifyBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisIdentifyBudget) {
    integer('maxRequests', budget.maxRequests, 1)
    integer('maxRunning', budget.maxRunning, 1)
    integer('maxReady', budget.maxReady, 1)
    integer('maxResults', budget.maxResults, 1)
    finite('queueTtlMs', budget.queueTtlMs); finite('runLeaseMs', budget.runLeaseMs); finite('readyTtlMs', budget.readyTtlMs)
    if (budget.maxRunning > budget.maxRequests || budget.maxReady > budget.maxRequests) throw new Error('phase limits cannot exceed maxRequests')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisIdentifyRequest): boolean {
    this.#active()
    const viewId = id('viewId', request.viewId); const requestKey = id('requestKey', request.requestKey)
    integer('revision', request.revision, 0); finite('requestedAt', request.requestedAt); integer('estimatedResults', request.estimatedResults, 0); integer('spatialReferenceWkid', request.spatialReferenceWkid, 1)
    if (request.estimatedResults > this.#budget.maxResults) return false
    const watermark = this.#revisions.get(viewId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidateView(viewId, request.revision)
    const key = this.#key(viewId, requestKey); const existing = this.#entries.get(key)
    if (existing && existing.revision === request.revision && priority[existing.intent] > priority[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxRequests) return false
    this.#entries.set(key, Object.freeze({ ...request, viewId, requestKey, phase: 'queued', sequence: existing?.sequence ?? this.#sequence++, expiresAt: request.requestedAt + this.#budget.queueTtlMs }))
    this.#revisions.set(viewId, request.revision)
    return true
  }

  next(now: number): Readonly<Entry> | null {
    this.#active(); finite('now', now); this.expire(now)
    if (this.#count('running') >= this.#budget.maxRunning) return null
    const entry = [...this.#entries.values()].filter(item => item.phase === 'queued').sort((a, b) => priority[b.intent] - priority[a.intent] || a.sequence - b.sequence)[0]
    if (!entry) return null
    const running = Object.freeze({ ...entry, phase: 'running' as const, expiresAt: now + this.#budget.runLeaseMs })
    this.#entries.set(this.#key(entry.viewId, entry.requestKey), running); return running
  }

  complete(viewId: string, requestKey: string, revision: number, now: number, actualResults?: number): boolean {
    this.#active(); integer('revision', revision, 0); finite('now', now)
    const key = this.#key(id('viewId', viewId), id('requestKey', requestKey)); const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision || now > entry.expiresAt) return false
    const results = actualResults ?? entry.estimatedResults; integer('actualResults', results, 0)
    if (results > this.#budget.maxResults || this.#count('ready') >= this.#budget.maxReady) return false
    this.#entries.set(key, Object.freeze({ ...entry, estimatedResults: results, phase: 'ready', expiresAt: now + this.#budget.readyTtlMs })); return true
  }

  consume(viewId: string, requestKey: string, revision: number): boolean {
    this.#active(); integer('revision', revision, 0); const key = this.#key(id('viewId', viewId), id('requestKey', requestKey)); const entry = this.#entries.get(key)
    return !!entry && entry.phase === 'ready' && entry.revision === revision && this.#entries.delete(key)
  }

  invalidateView(viewId: string, revision: number): number {
    this.#active(); const view = id('viewId', viewId); integer('revision', revision, 0); const current = this.#revisions.get(view)
    if (current !== undefined && revision <= current) return 0
    let removed = 0; for (const [key, entry] of this.#entries) if (entry.viewId === view && entry.revision < revision) { this.#entries.delete(key); removed += 1 }
    this.#revisions.set(view, revision); return removed
  }

  releaseView(viewId: string): number {
    this.#active(); const view = id('viewId', viewId); let removed = 0
    for (const [key, entry] of this.#entries) if (entry.viewId === view) { this.#entries.delete(key); removed += 1 }
    this.#revisions.delete(view); return removed
  }

  expire(now: number): number {
    this.#active(); finite('now', now); let removed = 0
    for (const [key, entry] of this.#entries) if (now > entry.expiresAt) { this.#entries.delete(key); removed += 1 }
    return removed
  }

  snapshot(): Readonly<{ requests: number; queued: number; running: number; ready: number }> {
    this.#active(); return Object.freeze({ requests: this.#entries.size, queued: this.#count('queued'), running: this.#count('running'), ready: this.#count('ready') })
  }

  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }
  #key(viewId: string, requestKey: string): string { return `${viewId}\u0000${requestKey}` }
  #count(phase: ArcGisIdentifyPhase): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) total += 1; return total }
  #active(): void { if (this.#disposed) throw new Error('ArcGisIdentifyLifecyclePolicy is disposed') }
}
