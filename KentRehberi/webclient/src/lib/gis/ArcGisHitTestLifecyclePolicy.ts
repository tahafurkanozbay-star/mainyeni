export type ArcGisHitTestIntent = 'hover' | 'click' | 'context'
export type ArcGisHitTestState = 'queued' | 'running'

export interface ArcGisHitTestBudget {
  maxViews: number
  maxRequests: number
  maxRequestsPerView: number
  maxRunningRequests: number
  maxCandidateLayersPerRequest: number
  maxEstimatedResultBytes: number
  maxEstimatedResultBytesPerRequest: number
  hoverTtlMs: number
  clickTtlMs: number
  contextTtlMs: number
  runLeaseMs: number
}

export interface ArcGisHitTestRequest {
  viewId: string
  pointerKey: string
  revision: number
  intent: ArcGisHitTestIntent
  candidateLayerIds: readonly string[]
  estimatedResultBytes: number
  requestedAt: number
}

export interface ArcGisHitTestEntry {
  viewId: string
  pointerKey: string
  revision: number
  intent: ArcGisHitTestIntent
  state: ArcGisHitTestState
  candidateLayerIds: readonly string[]
  estimatedResultBytes: number
  requestedAt: number
  expiresAt: number
  runLeaseUntil: number | null
  sequence: number
}

export interface ArcGisHitTestSnapshot {
  views: number
  requests: number
  running: number
  estimatedResultBytes: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const INTENT_WEIGHT: Readonly<Record<ArcGisHitTestIntent, number>> = Object.freeze({ hover: 0, click: 1, context: 2 })

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}

function finite(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`)
}

function id(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192) throw new Error(`${name} must contain 1..192 characters`)
  return normalized
}

function candidates(values: readonly string[], limit: number): readonly string[] {
  if (values.length > limit) throw new Error(`candidateLayerIds exceeds maxCandidateLayersPerRequest (${limit})`)
  const unique = new Set<string>()
  for (const value of values) unique.add(id('candidateLayerId', value))
  return Object.freeze([...unique].sort((a, b) => a.localeCompare(b)))
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

export class ArcGisHitTestLifecyclePolicy {
  readonly #budget: Readonly<ArcGisHitTestBudget>
  readonly #entries = new Map<string, ArcGisHitTestEntry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisHitTestBudget) {
    integer('maxViews', budget.maxViews, 1)
    integer('maxRequests', budget.maxRequests, 1)
    integer('maxRequestsPerView', budget.maxRequestsPerView, 1)
    integer('maxRunningRequests', budget.maxRunningRequests, 1)
    integer('maxCandidateLayersPerRequest', budget.maxCandidateLayersPerRequest, 1)
    finite('maxEstimatedResultBytes', budget.maxEstimatedResultBytes, 1)
    finite('maxEstimatedResultBytesPerRequest', budget.maxEstimatedResultBytesPerRequest, 1)
    finite('hoverTtlMs', budget.hoverTtlMs, 1)
    finite('clickTtlMs', budget.clickTtlMs, 1)
    finite('contextTtlMs', budget.contextTtlMs, 1)
    finite('runLeaseMs', budget.runLeaseMs, 1)
    if (budget.maxRequestsPerView > budget.maxRequests) throw new Error('maxRequestsPerView cannot exceed maxRequests')
    if (budget.maxRunningRequests > budget.maxRequests) throw new Error('maxRunningRequests cannot exceed maxRequests')
    if (budget.maxEstimatedResultBytesPerRequest > budget.maxEstimatedResultBytes) throw new Error('per-request byte budget cannot exceed aggregate byte budget')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisHitTestRequest): boolean {
    this.#active()
    const viewId = id('viewId', request.viewId)
    const pointerKey = id('pointerKey', request.pointerKey)
    integer('revision', request.revision, 0)
    finite('estimatedResultBytes', request.estimatedResultBytes, 0)
    finite('requestedAt', request.requestedAt, 0)
    if (request.estimatedResultBytes > this.#budget.maxEstimatedResultBytesPerRequest) return false
    const candidateLayerIds = candidates(request.candidateLayerIds, this.#budget.maxCandidateLayersPerRequest)
    const watermark = this.#revisions.get(viewId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidateView(viewId, request.revision)
    if (watermark === undefined && this.#revisions.size >= this.#budget.maxViews) return false
    const key = this.#key(viewId, pointerKey)
    const existing = this.#entries.get(key)
    if (existing && existing.revision === request.revision && INTENT_WEIGHT[existing.intent] > INTENT_WEIGHT[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxRequests) return false
    if (!existing && this.#viewCount(viewId) >= this.#budget.maxRequestsPerView) return false
    const bytes = this.#bytes() - (existing?.estimatedResultBytes ?? 0) + request.estimatedResultBytes
    if (bytes > this.#budget.maxEstimatedResultBytes) return false
    this.#revisions.set(viewId, request.revision)
    this.#entries.set(key, Object.freeze({
      viewId,
      pointerKey,
      revision: request.revision,
      intent: request.intent,
      state: 'queued',
      candidateLayerIds,
      estimatedResultBytes: request.estimatedResultBytes,
      requestedAt: request.requestedAt,
      expiresAt: request.requestedAt + this.#ttl(request.intent),
      runLeaseUntil: null,
      sequence: existing?.sequence ?? this.#sequence++,
    }))
    return true
  }

  begin(viewId: string, pointerKey: string, revision: number, now: number): boolean {
    this.#active(); integer('revision', revision, 0); finite('now', now, 0)
    const key = this.#key(id('viewId', viewId), id('pointerKey', pointerKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'queued' || now > entry.expiresAt) return false
    if (this.#running() >= this.#budget.maxRunningRequests) return false
    this.#entries.set(key, Object.freeze({ ...entry, state: 'running', runLeaseUntil: now + this.#budget.runLeaseMs }))
    return true
  }

  complete(viewId: string, pointerKey: string, revision: number): boolean {
    this.#active(); integer('revision', revision, 0)
    const key = this.#key(id('viewId', viewId), id('pointerKey', pointerKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'running') return false
    return this.#entries.delete(key)
  }

  cancel(viewId: string, pointerKey: string): boolean {
    this.#active()
    return this.#entries.delete(this.#key(id('viewId', viewId), id('pointerKey', pointerKey)))
  }

  invalidateView(viewId: string, revision: number): number {
    this.#active(); const normalized = id('viewId', viewId); integer('revision', revision, 0)
    const current = this.#revisions.get(normalized)
    if (current !== undefined && revision <= current) return 0
    if (current === undefined && this.#revisions.size >= this.#budget.maxViews) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.viewId === normalized) { this.#entries.delete(key); removed += 1 }
    }
    this.#revisions.set(normalized, revision)
    return removed
  }

  expire(now: number): number {
    this.#active(); finite('now', now, 0)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      const ttlExpired = now > entry.expiresAt
      const leaseExpired = entry.state === 'running' && entry.runLeaseUntil !== null && now > entry.runLeaseUntil
      if (ttlExpired || leaseExpired) { this.#entries.delete(key); removed += 1 }
    }
    return removed
  }

  nextQueued(): Readonly<ArcGisHitTestEntry> | null {
    this.#active()
    const entry = [...this.#entries.values()]
      .filter(candidate => candidate.state === 'queued')
      .sort((a, b) => INTENT_WEIGHT[b.intent] - INTENT_WEIGHT[a.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence || a.viewId.localeCompare(b.viewId) || a.pointerKey.localeCompare(b.pointerKey))[0]
    return entry ?? null
  }

  entriesForView(viewId: string): readonly Readonly<ArcGisHitTestEntry>[] {
    this.#active(); const normalized = id('viewId', viewId)
    return Object.freeze([...this.#entries.values()].filter(entry => entry.viewId === normalized).sort((a, b) => INTENT_WEIGHT[b.intent] - INTENT_WEIGHT[a.intent] || a.sequence - b.sequence || a.pointerKey.localeCompare(b.pointerKey)))
  }

  snapshot(): Readonly<ArcGisHitTestSnapshot> {
    this.#active()
    const revisions = Object.fromEntries([...this.#revisions.entries()].sort(([a], [b]) => a.localeCompare(b)))
    const facts = [...this.#entries.values()].sort((a, b) => a.viewId.localeCompare(b.viewId) || a.pointerKey.localeCompare(b.pointerKey)).map(entry => `${entry.viewId}:${entry.pointerKey}:${entry.revision}:${entry.intent}:${entry.state}:${entry.candidateLayerIds.join(',')}:${entry.estimatedResultBytes}`).join('|')
    return Object.freeze({ views: this.#revisions.size, requests: this.#entries.size, running: this.#running(), estimatedResultBytes: this.#bytes(), revisionWatermark: Object.freeze(revisions), fingerprint: hash(facts) })
  }

  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }

  #ttl(intent: ArcGisHitTestIntent): number {
    if (intent === 'hover') return this.#budget.hoverTtlMs
    if (intent === 'click') return this.#budget.clickTtlMs
    return this.#budget.contextTtlMs
  }
  #key(viewId: string, pointerKey: string): string { return `${viewId}\u0000${pointerKey}` }
  #viewCount(viewId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.viewId === viewId) count += 1; return count }
  #running(): number { let count = 0; for (const entry of this.#entries.values()) if (entry.state === 'running') count += 1; return count }
  #bytes(): number { let bytes = 0; for (const entry of this.#entries.values()) bytes += entry.estimatedResultBytes; return bytes }
  #active(): void { if (this.#disposed) throw new Error('ArcGisHitTestLifecyclePolicy is disposed') }
}
