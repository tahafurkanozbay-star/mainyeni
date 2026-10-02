export type ArcGisTimeSliceIntent = 'prefetch' | 'visible' | 'interactive'
export type ArcGisTimeSlicePhase = 'queued' | 'loading' | 'resident'

export interface ArcGisTimeSliceBudget {
  maxSlices: number
  maxSlicesPerView: number
  maxLoading: number
  maxResident: number
  maxFeaturesPerSlice: number
  maxBytesPerSlice: number
  maxAggregateResidentBytes: number
  queueTtlMs: number
  loadLeaseMs: number
  residentTtlMs: number
}

export interface ArcGisTimeSliceRequest {
  viewId: string
  layerId: string
  sliceId: string
  revision: number
  intent: ArcGisTimeSliceIntent
  requestedAt: number
  estimatedFeatures: number
  estimatedBytes: number
  timeStart: number
  timeEnd: number
}

export interface ArcGisTimeSliceView {
  readonly viewId: string
  readonly layerId: string
  readonly sliceId: string
  readonly revision: number
  readonly intent: ArcGisTimeSliceIntent
  readonly phase: ArcGisTimeSlicePhase
  readonly features: number
  readonly bytes: number
  readonly timeStart: number
  readonly timeEnd: number
  readonly expiresAt: number
}

interface Entry extends ArcGisTimeSliceRequest { phase: ArcGisTimeSlicePhase; sequence: number; features: number; bytes: number; expiresAt: number }
const priority: Readonly<Record<ArcGisTimeSliceIntent, number>> = Object.freeze({ prefetch: 0, visible: 1, interactive: 2 })
function integer(name: string, value: number, minimum: number): void { if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`) }
function finite(name: string, value: number): void { if (!Number.isFinite(value)) throw new Error(`${name} must be finite`) }
function id(name: string, value: string): string { const normalized = value.trim(); if (!normalized || normalized.length > 256) throw new Error(`${name} must contain 1..256 characters`); return normalized }

/** Payload-free authority for time-enabled ArcGIS layer slice residency. */
export class ArcGisTimeSliceLifecyclePolicy {
  readonly #budget: Readonly<ArcGisTimeSliceBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisTimeSliceBudget) {
    integer('maxSlices', budget.maxSlices, 1); integer('maxSlicesPerView', budget.maxSlicesPerView, 1); integer('maxLoading', budget.maxLoading, 1); integer('maxResident', budget.maxResident, 1)
    integer('maxFeaturesPerSlice', budget.maxFeaturesPerSlice, 1); integer('maxBytesPerSlice', budget.maxBytesPerSlice, 1); integer('maxAggregateResidentBytes', budget.maxAggregateResidentBytes, 1)
    integer('queueTtlMs', budget.queueTtlMs, 1); integer('loadLeaseMs', budget.loadLeaseMs, 1); integer('residentTtlMs', budget.residentTtlMs, 1)
    if (budget.maxSlicesPerView > budget.maxSlices || budget.maxLoading > budget.maxSlices || budget.maxResident > budget.maxSlices) throw new Error('phase/per-view limits cannot exceed maxSlices')
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(request: ArcGisTimeSliceRequest): boolean {
    this.#active(); const viewId = id('viewId', request.viewId); const layerId = id('layerId', request.layerId); const sliceId = id('sliceId', request.sliceId)
    integer('revision', request.revision, 0); finite('requestedAt', request.requestedAt); integer('estimatedFeatures', request.estimatedFeatures, 0); integer('estimatedBytes', request.estimatedBytes, 0); finite('timeStart', request.timeStart); finite('timeEnd', request.timeEnd)
    if (request.timeEnd < request.timeStart || request.estimatedFeatures > this.#budget.maxFeaturesPerSlice || request.estimatedBytes > this.#budget.maxBytesPerSlice) return false
    const watermark = this.#revisions.get(viewId); if (watermark !== undefined && request.revision < watermark) return false
    const key = this.#key(viewId, layerId, sliceId); const existing = this.#entries.get(key)
    if (existing) { if (existing.revision >= request.revision) return false; this.#entries.delete(key) }
    if (this.#entries.size >= this.#budget.maxSlices || this.#countView(viewId) >= this.#budget.maxSlicesPerView) return false
    this.#revisions.set(viewId, Math.max(watermark ?? request.revision, request.revision))
    this.#entries.set(key, { ...request, viewId, layerId, sliceId, phase: 'queued', sequence: this.#sequence++, features: 0, bytes: 0, expiresAt: request.requestedAt + this.#budget.queueTtlMs })
    return true
  }

  takeNext(now: number): ArcGisTimeSliceView | undefined {
    this.#active(); finite('now', now); this.expire(now); if (this.#countPhase('loading') >= this.#budget.maxLoading) return undefined
    const candidates = [...this.#entries.values()].filter(entry => entry.phase === 'queued').sort((a, b) => priority[b.intent] - priority[a.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence)
    const next = candidates[0]; if (!next) return undefined; next.phase = 'loading'; next.expiresAt = now + this.#budget.loadLeaseMs; return this.#view(next)
  }

  complete(viewValue: string, layerValue: string, sliceValue: string, revision: number, features: number, bytes: number, now: number): boolean {
    this.#active(); const viewId = id('viewId', viewValue); const layerId = id('layerId', layerValue); const sliceId = id('sliceId', sliceValue); integer('revision', revision, 0); integer('features', features, 0); integer('bytes', bytes, 0); finite('now', now); this.expire(now)
    const key = this.#key(viewId, layerId, sliceId); const entry = this.#entries.get(key); if (!entry || entry.phase !== 'loading' || entry.revision !== revision) return false
    if (this.#revisions.get(viewId) !== revision || features > this.#budget.maxFeaturesPerSlice || bytes > this.#budget.maxBytesPerSlice) { this.#entries.delete(key); return false }
    if (this.#countPhase('resident') >= this.#budget.maxResident || this.#residentBytes() + bytes > this.#budget.maxAggregateResidentBytes) return false
    entry.phase = 'resident'; entry.features = features; entry.bytes = bytes; entry.expiresAt = now + this.#budget.residentTtlMs; return true
  }

  touch(viewValue: string, layerValue: string, sliceValue: string, revision: number, now: number): boolean {
    this.#active(); finite('now', now); this.expire(now); const entry = this.#entries.get(this.#key(id('viewId', viewValue), id('layerId', layerValue), id('sliceId', sliceValue)))
    if (!entry || entry.phase !== 'resident' || entry.revision !== revision) return false; entry.expiresAt = now + this.#budget.residentTtlMs; return true
  }

  invalidateView(viewValue: string, revision: number): number {
    this.#active(); const viewId = id('viewId', viewValue); integer('revision', revision, 0); const current = this.#revisions.get(viewId) ?? -1; if (revision <= current) return 0; this.#revisions.set(viewId, revision); let removed = 0
    for (const [key, entry] of this.#entries) if (entry.viewId === viewId && entry.revision < revision) { this.#entries.delete(key); removed++ } return removed
  }

  releaseView(viewValue: string): number { this.#active(); const viewId = id('viewId', viewValue); let removed = 0; for (const [key, entry] of this.#entries) if (entry.viewId === viewId) { this.#entries.delete(key); removed++ }; this.#revisions.delete(viewId); return removed }
  expire(now: number): number { this.#active(); finite('now', now); let removed = 0; for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) { this.#entries.delete(key); removed++ }; return removed }
  snapshot(): readonly ArcGisTimeSliceView[] { this.#active(); return [...this.#entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.#view(entry)) }
  fingerprint(): string { return this.snapshot().map(entry => `${entry.viewId}:${entry.layerId}:${entry.sliceId}:${entry.revision}:${entry.phase}:${entry.features}:${entry.bytes}`).join('|') }
  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }
  #active(): void { if (this.#disposed) throw new Error('ArcGisTimeSliceLifecyclePolicy is disposed') }
  #key(viewId: string, layerId: string, sliceId: string): string { return `${viewId}\u0000${layerId}\u0000${sliceId}` }
  #countView(viewId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.viewId === viewId) count++; return count }
  #countPhase(phase: ArcGisTimeSlicePhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count++; return count }
  #residentBytes(): number { let bytes = 0; for (const entry of this.#entries.values()) if (entry.phase === 'resident') bytes += entry.bytes; return bytes }
  #view(entry: Entry): ArcGisTimeSliceView { return Object.freeze({ viewId: entry.viewId, layerId: entry.layerId, sliceId: entry.sliceId, revision: entry.revision, intent: entry.intent, phase: entry.phase, features: entry.features, bytes: entry.bytes, timeStart: entry.timeStart, timeEnd: entry.timeEnd, expiresAt: entry.expiresAt }) }
}
