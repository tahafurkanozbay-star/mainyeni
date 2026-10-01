export type ArcGisNavigationIntent = 'restore' | 'user' | 'search' | 'selection'
export type ArcGisNavigationState = 'queued' | 'running'

export interface ArcGisNavigationBudget {
  maxViews: number
  maxRequests: number
  maxRequestsPerView: number
  maxRunningRequests: number
  maxEstimatedBytes: number
  maxEstimatedBytesPerRequest: number
  queueTtlMs: number
  runLeaseMs: number
}

export interface ArcGisNavigationRequest {
  viewId: string
  requestId: string
  revision: number
  intent: ArcGisNavigationIntent
  estimatedBytes: number
  requestedAt: number
  targetScale?: number | null
}

export interface ArcGisNavigationEntry extends ArcGisNavigationRequest {
  state: ArcGisNavigationState
  expiresAt: number
  runLeaseUntil: number | null
  sequence: number
}

export interface ArcGisNavigationSnapshot {
  views: number
  requests: number
  running: number
  estimatedBytes: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const PRIORITY: Readonly<Record<ArcGisNavigationIntent, number>> = Object.freeze({ restore: 0, user: 1, search: 2, selection: 3 })

function finite(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`)
}
function integer(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}
function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || normalized.includes('\u0000')) throw new Error(`${name} is invalid`)
  return normalized
}
function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) { result ^= value.charCodeAt(index); result = Math.imul(result, 16777619) }
  return (result >>> 0).toString(16).padStart(8, '0')
}

/**
 * Owns only navigation scheduling metadata. ArcGIS View/Geometry instances are deliberately
 * excluded so cancellation and disposal cannot accidentally retain SDK graphs or DOM nodes.
 */
export class ArcGisNavigationLifecyclePolicy {
  readonly #budget: Readonly<ArcGisNavigationBudget>
  readonly #entries = new Map<string, Readonly<ArcGisNavigationEntry>>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisNavigationBudget) {
    integer('maxViews', budget.maxViews, 1)
    integer('maxRequests', budget.maxRequests, 1)
    integer('maxRequestsPerView', budget.maxRequestsPerView, 1)
    integer('maxRunningRequests', budget.maxRunningRequests, 1)
    finite('maxEstimatedBytes', budget.maxEstimatedBytes, 1)
    finite('maxEstimatedBytesPerRequest', budget.maxEstimatedBytesPerRequest, 1)
    finite('queueTtlMs', budget.queueTtlMs, 1)
    finite('runLeaseMs', budget.runLeaseMs, 1)
    if (budget.maxRequestsPerView > budget.maxRequests) throw new Error('per-view request budget exceeds aggregate request budget')
    if (budget.maxRunningRequests > budget.maxRequests) throw new Error('running request budget exceeds aggregate request budget')
    if (budget.maxEstimatedBytesPerRequest > budget.maxEstimatedBytes) throw new Error('per-request byte budget exceeds aggregate byte budget')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisNavigationRequest): boolean {
    this.#active()
    const viewId = identifier('viewId', request.viewId)
    const requestId = identifier('requestId', request.requestId)
    integer('revision', request.revision, 0)
    finite('estimatedBytes', request.estimatedBytes, 0)
    finite('requestedAt', request.requestedAt, 0)
    if (request.targetScale !== undefined && request.targetScale !== null) finite('targetScale', request.targetScale, 1)
    if (request.estimatedBytes > this.#budget.maxEstimatedBytesPerRequest) return false
    const watermark = this.#revisions.get(viewId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidateView(viewId, request.revision)
    if (watermark === undefined && this.#revisions.size >= this.#budget.maxViews) return false
    const key = this.#key(viewId, requestId)
    const existing = this.#entries.get(key)
    if (existing && existing.revision === request.revision && PRIORITY[existing.intent] > PRIORITY[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxRequests) return false
    if (!existing && this.#viewCount(viewId) >= this.#budget.maxRequestsPerView) return false
    const projectedBytes = this.#bytes() - (existing?.estimatedBytes ?? 0) + request.estimatedBytes
    if (projectedBytes > this.#budget.maxEstimatedBytes) return false
    this.#revisions.set(viewId, request.revision)
    this.#entries.set(key, Object.freeze({ ...request, viewId, requestId, targetScale: request.targetScale ?? null, state: 'queued', expiresAt: request.requestedAt + this.#budget.queueTtlMs, runLeaseUntil: null, sequence: existing?.sequence ?? this.#sequence++ }))
    return true
  }

  begin(viewId: string, requestId: string, revision: number, now: number): boolean {
    this.#active(); integer('revision', revision, 0); finite('now', now, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('requestId', requestId))
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'queued' || now > entry.expiresAt) return false
    if (this.#running() >= this.#budget.maxRunningRequests) return false
    this.#entries.set(key, Object.freeze({ ...entry, state: 'running', runLeaseUntil: now + this.#budget.runLeaseMs }))
    return true
  }

  complete(viewId: string, requestId: string, revision: number): boolean {
    this.#active(); integer('revision', revision, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('requestId', requestId))
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'running') return false
    return this.#entries.delete(key)
  }

  cancel(viewId: string, requestId: string): boolean {
    this.#active()
    return this.#entries.delete(this.#key(identifier('viewId', viewId), identifier('requestId', requestId)))
  }

  invalidateView(viewId: string, revision: number): number {
    this.#active(); const normalized = identifier('viewId', viewId); integer('revision', revision, 0)
    const current = this.#revisions.get(normalized)
    if (current !== undefined && revision <= current) return 0
    if (current === undefined && this.#revisions.size >= this.#budget.maxViews) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.viewId === normalized) { this.#entries.delete(key); removed += 1 }
    this.#revisions.set(normalized, revision)
    return removed
  }

  expire(now: number): number {
    this.#active(); finite('now', now, 0)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      const expired = entry.state === 'queued' ? now > entry.expiresAt : entry.runLeaseUntil !== null && now > entry.runLeaseUntil
      if (expired) { this.#entries.delete(key); removed += 1 }
    }
    return removed
  }

  nextQueued(): Readonly<ArcGisNavigationEntry> | null {
    this.#active()
    return [...this.#entries.values()].filter(entry => entry.state === 'queued').sort((a, b) => PRIORITY[b.intent] - PRIORITY[a.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence || a.viewId.localeCompare(b.viewId) || a.requestId.localeCompare(b.requestId))[0] ?? null
  }

  entriesForView(viewId: string): readonly Readonly<ArcGisNavigationEntry>[] {
    this.#active(); const normalized = identifier('viewId', viewId)
    return Object.freeze([...this.#entries.values()].filter(entry => entry.viewId === normalized).sort((a, b) => PRIORITY[b.intent] - PRIORITY[a.intent] || a.sequence - b.sequence || a.requestId.localeCompare(b.requestId)))
  }

  snapshot(): Readonly<ArcGisNavigationSnapshot> {
    this.#active()
    const revisionWatermark = Object.freeze(Object.fromEntries([...this.#revisions.entries()].sort(([a], [b]) => a.localeCompare(b))))
    const facts = [...this.#entries.values()].sort((a, b) => a.viewId.localeCompare(b.viewId) || a.requestId.localeCompare(b.requestId)).map(entry => `${entry.viewId}:${entry.requestId}:${entry.revision}:${entry.intent}:${entry.state}:${entry.estimatedBytes}:${entry.targetScale ?? ''}`).join('|')
    return Object.freeze({ views: this.#revisions.size, requests: this.#entries.size, running: this.#running(), estimatedBytes: this.#bytes(), revisionWatermark, fingerprint: hash(facts) })
  }

  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }
  #key(viewId: string, requestId: string): string { return `${viewId}\u0000${requestId}` }
  #viewCount(viewId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.viewId === viewId) count += 1; return count }
  #running(): number { let count = 0; for (const entry of this.#entries.values()) if (entry.state === 'running') count += 1; return count }
  #bytes(): number { let bytes = 0; for (const entry of this.#entries.values()) bytes += entry.estimatedBytes; return bytes }
  #active(): void { if (this.#disposed) throw new Error('ArcGisNavigationLifecyclePolicy is disposed') }
}
