export type ArcGisSpatialAnalysisIntent = 'nearest' | 'proximity' | 'filter' | 'buffer'
export type ArcGisSpatialAnalysisState = 'queued' | 'running' | 'ready'

export interface ArcGisSpatialAnalysisBudget {
  maxViews: number
  maxRequests: number
  maxRequestsPerView: number
  maxRunning: number
  maxReady: number
  maxInputVertices: number
  maxInputVerticesPerRequest: number
  maxCandidateFeatures: number
  maxCandidateFeaturesPerRequest: number
  maxEstimatedBytes: number
  maxEstimatedBytesPerRequest: number
  maxDistanceMeters: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisSpatialAnalysisRequest {
  viewId: string
  requestId: string
  revision: number
  intent: ArcGisSpatialAnalysisIntent
  requestedAt: number
  inputVertices: number
  candidateFeatures: number
  estimatedBytes: number
  inputWkid: number
  distanceMeters: number | null
}

export interface ArcGisSpatialAnalysisEntry extends ArcGisSpatialAnalysisRequest {
  state: ArcGisSpatialAnalysisState
  sequence: number
  expiresAt: number
  leaseUntil: number | null
  resultFeatures: number
  resultBytes: number
}

export interface ArcGisSpatialAnalysisSnapshot {
  views: number
  requests: number
  queued: number
  running: number
  ready: number
  inputVertices: number
  candidateFeatures: number
  estimatedBytes: number
  resultFeatures: number
  resultBytes: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const PRIORITY: Readonly<Record<ArcGisSpatialAnalysisIntent, number>> = Object.freeze({ buffer: 0, filter: 1, proximity: 2, nearest: 3 })

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}`)
}
function finite(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`)
}
function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (normalized !== value || !normalized || normalized.length > 192 || normalized.includes('\u0000')) throw new Error(`${name} is invalid`)
  return normalized
}
function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) { result ^= value.charCodeAt(index); result = Math.imul(result, 16777619) }
  return (result >>> 0).toString(16).padStart(8, '0')
}

export class ArcGisSpatialAnalysisLifecyclePolicy {
  readonly #budget: Readonly<ArcGisSpatialAnalysisBudget>
  readonly #entries = new Map<string, ArcGisSpatialAnalysisEntry>()
  readonly #watermark = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisSpatialAnalysisBudget) {
    for (const key of ['maxViews','maxRequests','maxRequestsPerView','maxRunning','maxReady','maxInputVertices','maxInputVerticesPerRequest','maxCandidateFeatures','maxCandidateFeaturesPerRequest','maxEstimatedBytes','maxEstimatedBytesPerRequest'] as const) integer(key, budget[key], 1)
    for (const key of ['maxDistanceMeters','queueTtlMs','runLeaseMs','readyTtlMs'] as const) finite(key, budget[key], 1)
    if (budget.maxRequestsPerView > budget.maxRequests) throw new Error('per-view request budget exceeds aggregate request budget')
    if (budget.maxRunning > budget.maxRequests || budget.maxReady > budget.maxRequests) throw new Error('state budget exceeds request budget')
    if (budget.maxInputVerticesPerRequest > budget.maxInputVertices) throw new Error('per-request vertex budget exceeds aggregate budget')
    if (budget.maxCandidateFeaturesPerRequest > budget.maxCandidateFeatures) throw new Error('per-request candidate budget exceeds aggregate budget')
    if (budget.maxEstimatedBytesPerRequest > budget.maxEstimatedBytes) throw new Error('per-request byte budget exceeds aggregate budget')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(raw: ArcGisSpatialAnalysisRequest): boolean {
    this.#assertLive()
    const request = this.#normalize(raw)
    const watermark = this.#watermark.get(request.viewId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark === undefined || request.revision > watermark) {
      this.#dropView(request.viewId)
      this.#watermark.set(request.viewId, request.revision)
    }
    const key = this.#key(request.viewId, request.requestId)
    const existing = this.#entries.get(key)
    if (existing) {
      if (existing.revision !== request.revision || existing.state !== 'queued' || PRIORITY[request.intent] <= PRIORITY[existing.intent]) return false
      const replacement: ArcGisSpatialAnalysisEntry = { ...request, state: 'queued', sequence: existing.sequence, expiresAt: request.requestedAt + this.#budget.queueTtlMs, leaseUntil: null, resultFeatures: 0, resultBytes: 0 }
      if (!this.#fits(replacement, existing)) return false
      this.#entries.set(key, replacement)
      return true
    }
    if (!this.#fitsRequest(request)) return false
    const entry: ArcGisSpatialAnalysisEntry = { ...request, state: 'queued', sequence: this.#sequence++, expiresAt: request.requestedAt + this.#budget.queueTtlMs, leaseUntil: null, resultFeatures: 0, resultBytes: 0 }
    this.#entries.set(key, entry)
    return true
  }

  nextQueued(): Readonly<ArcGisSpatialAnalysisEntry> | null {
    this.#assertLive()
    const entries = [...this.#entries.values()].filter((entry) => entry.state === 'queued')
    entries.sort((a, b) => PRIORITY[b.intent] - PRIORITY[a.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence)
    return entries[0] ? Object.freeze({ ...entries[0] }) : null
  }

  begin(viewId: string, requestId: string, revision: number, now: number): boolean {
    this.#assertLive(); finite('now', now, 0); integer('revision', revision, 0)
    const entry = this.#entries.get(this.#key(identifier('viewId', viewId), identifier('requestId', requestId)))
    if (!entry || entry.revision !== revision || entry.state !== 'queued') return false
    if (now > entry.expiresAt) { this.#entries.delete(this.#key(viewId, requestId)); return false }
    if (this.#countState('running') >= this.#budget.maxRunning) return false
    entry.state = 'running'; entry.leaseUntil = now + this.#budget.runLeaseMs; entry.expiresAt = entry.leaseUntil
    return true
  }

  markReady(viewId: string, requestId: string, revision: number, now: number, resultFeatures: number, resultBytes: number): boolean {
    this.#assertLive(); finite('now', now, 0); integer('revision', revision, 0); integer('resultFeatures', resultFeatures, 0); integer('resultBytes', resultBytes, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('requestId', requestId)); const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'running') return false
    if (entry.leaseUntil === null || now > entry.leaseUntil) { this.#entries.delete(key); return false }
    if (this.#countState('ready') >= this.#budget.maxReady) return false
    if (resultFeatures > entry.candidateFeatures || resultFeatures > this.#budget.maxCandidateFeaturesPerRequest) return false
    if (resultBytes > this.#budget.maxEstimatedBytesPerRequest) return false
    entry.state = 'ready'; entry.resultFeatures = resultFeatures; entry.resultBytes = resultBytes; entry.leaseUntil = null; entry.expiresAt = now + this.#budget.readyTtlMs
    return true
  }

  consume(viewId: string, requestId: string, revision: number): boolean {
    this.#assertLive(); integer('revision', revision, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('requestId', requestId)); const entry = this.#entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'ready') return false
    this.#entries.delete(key); return true
  }

  cancel(viewId: string, requestId: string): boolean {
    this.#assertLive(); return this.#entries.delete(this.#key(identifier('viewId', viewId), identifier('requestId', requestId)))
  }

  expire(now: number): number {
    this.#assertLive(); finite('now', now, 0); let removed = 0
    for (const [key, entry] of this.#entries) if (now > entry.expiresAt) { this.#entries.delete(key); removed += 1 }
    return removed
  }

  entriesForView(viewId: string): readonly Readonly<ArcGisSpatialAnalysisEntry>[] {
    this.#assertLive(); const id = identifier('viewId', viewId)
    return Object.freeze([...this.#entries.values()].filter((entry) => entry.viewId === id).sort((a,b) => a.sequence-b.sequence).map((entry) => Object.freeze({ ...entry })))
  }

  snapshot(): Readonly<ArcGisSpatialAnalysisSnapshot> {
    this.#assertLive(); const entries = [...this.#entries.values()]; const views = new Set(entries.map((entry) => entry.viewId))
    const revisionWatermark = Object.freeze(Object.fromEntries([...this.#watermark.entries()].sort(([a],[b]) => a.localeCompare(b))))
    const canonical = entries.slice().sort((a,b) => a.viewId.localeCompare(b.viewId) || a.requestId.localeCompare(b.requestId)).map((entry) => [entry.viewId,entry.requestId,entry.revision,entry.intent,entry.state,entry.inputVertices,entry.candidateFeatures,entry.estimatedBytes,entry.resultFeatures,entry.resultBytes])
    return Object.freeze({ views: views.size, requests: entries.length, queued: this.#countState('queued'), running: this.#countState('running'), ready: this.#countState('ready'), inputVertices: this.#sum('inputVertices'), candidateFeatures: this.#sum('candidateFeatures'), estimatedBytes: this.#sum('estimatedBytes'), resultFeatures: this.#sum('resultFeatures'), resultBytes: this.#sum('resultBytes'), revisionWatermark, fingerprint: hash(JSON.stringify([revisionWatermark, canonical])) })
  }

  dispose(): void { this.#entries.clear(); this.#watermark.clear(); this.#disposed = true }

  #normalize(raw: ArcGisSpatialAnalysisRequest): ArcGisSpatialAnalysisRequest {
    const request = { ...raw, viewId: identifier('viewId', raw.viewId), requestId: identifier('requestId', raw.requestId) }
    integer('revision', request.revision, 0); finite('requestedAt', request.requestedAt, 0); integer('inputVertices', request.inputVertices, 1); integer('candidateFeatures', request.candidateFeatures, 0); integer('estimatedBytes', request.estimatedBytes, 0); integer('inputWkid', request.inputWkid, 1)
    if (!(request.intent in PRIORITY)) throw new Error('intent is invalid')
    if (request.distanceMeters !== null) finite('distanceMeters', request.distanceMeters, 0)
    if ((request.intent === 'nearest' || request.intent === 'proximity' || request.intent === 'buffer') && request.distanceMeters === null) throw new Error('distance is required for distance-based analysis')
    if (request.distanceMeters !== null && request.distanceMeters > this.#budget.maxDistanceMeters) throw new Error('distance budget exceeded')
    return request
  }
  #fitsRequest(request: ArcGisSpatialAnalysisRequest): boolean {
    if (this.#entries.size >= this.#budget.maxRequests) return false
    if (!this.#entries.has(this.#key(request.viewId, request.requestId)) && ![...this.#entries.values()].some((entry) => entry.viewId === request.viewId) && new Set([...this.#entries.values()].map((entry) => entry.viewId)).size >= this.#budget.maxViews) return false
    if ([...this.#entries.values()].filter((entry) => entry.viewId === request.viewId).length >= this.#budget.maxRequestsPerView) return false
    const candidate: ArcGisSpatialAnalysisEntry = { ...request, state:'queued', sequence:0, expiresAt:0, leaseUntil:null, resultFeatures:0, resultBytes:0 }
    return this.#fits(candidate)
  }
  #fits(candidate: ArcGisSpatialAnalysisEntry, replacing?: ArcGisSpatialAnalysisEntry): boolean {
    if (candidate.inputVertices > this.#budget.maxInputVerticesPerRequest || candidate.candidateFeatures > this.#budget.maxCandidateFeaturesPerRequest || candidate.estimatedBytes > this.#budget.maxEstimatedBytesPerRequest) return false
    const subtract = replacing ?? ({ inputVertices:0, candidateFeatures:0, estimatedBytes:0 } as ArcGisSpatialAnalysisEntry)
    return this.#sum('inputVertices') - subtract.inputVertices + candidate.inputVertices <= this.#budget.maxInputVertices && this.#sum('candidateFeatures') - subtract.candidateFeatures + candidate.candidateFeatures <= this.#budget.maxCandidateFeatures && this.#sum('estimatedBytes') - subtract.estimatedBytes + candidate.estimatedBytes <= this.#budget.maxEstimatedBytes
  }
  #sum(field: 'inputVertices'|'candidateFeatures'|'estimatedBytes'|'resultFeatures'|'resultBytes'): number { let total=0; for (const entry of this.#entries.values()) total += entry[field]; return total }
  #countState(state: ArcGisSpatialAnalysisState): number { let total=0; for (const entry of this.#entries.values()) if (entry.state===state) total+=1; return total }
  #dropView(viewId: string): void { for (const [key,entry] of this.#entries) if (entry.viewId===viewId) this.#entries.delete(key) }
  #key(viewId: string, requestId: string): string { return `${viewId}\u0000${requestId}` }
  #assertLive(): void { if (this.#disposed) throw new Error('ArcGisSpatialAnalysisLifecyclePolicy is disposed') }
}
