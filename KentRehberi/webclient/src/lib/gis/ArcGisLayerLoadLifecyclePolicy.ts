export type ArcGisLayerLoadIntent = 'background' | 'visible' | 'interactive'
export type ArcGisLayerLoadPhase = 'queued' | 'loading' | 'ready'

export interface ArcGisLayerLoadBudget {
  maxLoads: number
  maxLoadsPerView: number
  maxLoading: number
  maxReady: number
  maxReadyBytesPerLayer: number
  maxAggregateReadyBytes: number
  queueTtlMs: number
  loadTtlMs: number
  readyTtlMs: number
}

export interface ArcGisLayerLoadRequest {
  loadId: string
  viewId: string
  serviceId: string
  layerId: string
  revision: number
  intent: ArcGisLayerLoadIntent
  requestedAt: number
  estimatedBytes: number
}

export interface ArcGisLayerLoadView {
  readonly loadId: string
  readonly viewId: string
  readonly serviceId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: ArcGisLayerLoadIntent
  readonly phase: ArcGisLayerLoadPhase
  readonly requestedAt: number
  readonly estimatedBytes: number
  readonly actualBytes: number
  readonly sequence: number
  readonly expiresAt: number
}

interface Entry extends ArcGisLayerLoadRequest {
  phase: ArcGisLayerLoadPhase
  actualBytes: number
  sequence: number
  expiresAt: number
}

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,160}$/
const PRIORITY: Readonly<Record<ArcGisLayerLoadIntent, number>> = Object.freeze({ background: 0, visible: 1, interactive: 2 })

function id(name: string, value: string): string {
  const normalized = value.trim()
  if (!IDENTIFIER.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}
function integer(name: string, value: number, minimum = 0): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}
function finite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}
function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`)
}

/**
 * Payload-free lifecycle authority for ArcGIS layer loading/hydration.
 * Layer/LayerView instances, renderer/popup JSON, feature payloads, credentials,
 * response bodies and AbortControllers remain caller-owned. The authority only
 * tracks bounded scalar ownership and byte accounting, so view/service teardown
 * deterministically releases residency and stale revisions cannot become ready.
 */
export class ArcGisLayerLoadLifecyclePolicy {
  readonly #budget: Readonly<ArcGisLayerLoadBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisLayerLoadBudget) {
    integer('maxLoads', budget.maxLoads, 1)
    integer('maxLoadsPerView', budget.maxLoadsPerView, 1)
    integer('maxLoading', budget.maxLoading, 1)
    integer('maxReady', budget.maxReady, 1)
    integer('maxReadyBytesPerLayer', budget.maxReadyBytesPerLayer, 1)
    integer('maxAggregateReadyBytes', budget.maxAggregateReadyBytes, 1)
    positive('queueTtlMs', budget.queueTtlMs)
    positive('loadTtlMs', budget.loadTtlMs)
    positive('readyTtlMs', budget.readyTtlMs)
    if (budget.maxLoadsPerView > budget.maxLoads) throw new Error('maxLoadsPerView is impossible')
    if (budget.maxLoading > budget.maxLoads || budget.maxReady > budget.maxLoads) throw new Error('phase limit is impossible')
    if (budget.maxReadyBytesPerLayer > budget.maxAggregateReadyBytes) throw new Error('ready byte budget is inconsistent')
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(request: ArcGisLayerLoadRequest): Readonly<ArcGisLayerLoadView> {
    this.#active()
    const normalized = this.#normalize(request)
    this.expire(normalized.requestedAt)
    const key = this.#key(normalized.viewId, normalized.serviceId, normalized.layerId, normalized.loadId)
    if (this.#entries.has(key)) throw new Error('duplicate layer load authority')
    if (this.#entries.size >= this.#budget.maxLoads) throw new Error('layer load capacity exceeded')
    if (this.#countView(normalized.viewId) >= this.#budget.maxLoadsPerView) throw new Error('view layer load capacity exceeded')
    const revisionKey = this.#revisionKey(normalized.serviceId, normalized.layerId)
    const watermark = this.#revisions.get(revisionKey)
    if (watermark !== undefined && normalized.revision < watermark) throw new Error('stale layer revision')
    if (watermark === undefined || normalized.revision > watermark) this.advanceRevision(normalized.serviceId, normalized.layerId, normalized.revision)
    const entry: Entry = Object.freeze({ ...normalized, phase: 'queued', actualBytes: 0, sequence: this.#sequence++, expiresAt: normalized.requestedAt + this.#budget.queueTtlMs })
    this.#entries.set(key, entry)
    return this.#view(entry)
  }

  takeNext(now: number): Readonly<ArcGisLayerLoadView> | undefined {
    this.#active(); finite('now', now); this.expire(now)
    if (this.#countPhase('loading') >= this.#budget.maxLoading) return undefined
    const entry = [...this.#entries.values()].filter(value => value.phase === 'queued')
      .sort((a, b) => PRIORITY[b.intent] - PRIORITY[a.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence)[0]
    if (!entry) return undefined
    const loading: Entry = Object.freeze({ ...entry, phase: 'loading', expiresAt: now + this.#budget.loadTtlMs })
    this.#entries.set(this.#entryKey(entry), loading)
    return this.#view(loading)
  }

  complete(identity: Pick<ArcGisLayerLoadRequest, 'loadId' | 'viewId' | 'serviceId' | 'layerId' | 'revision'>, actualBytes: number, now: number): Readonly<ArcGisLayerLoadView> {
    this.#active(); integer('actualBytes', actualBytes); finite('now', now)
    const loadId = id('loadId', identity.loadId), viewId = id('viewId', identity.viewId), serviceId = id('serviceId', identity.serviceId), layerId = id('layerId', identity.layerId)
    integer('revision', identity.revision)
    const key = this.#key(viewId, serviceId, layerId, loadId)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'loading') throw new Error('layer load is not loading')
    if (now > entry.expiresAt) { this.#entries.delete(key); throw new Error('layer load lease expired') }
    if (entry.revision !== identity.revision || this.#revisions.get(this.#revisionKey(serviceId, layerId)) !== identity.revision) { this.#entries.delete(key); throw new Error('stale layer load completion') }
    if (actualBytes > this.#budget.maxReadyBytesPerLayer) { this.#entries.delete(key); throw new Error('layer ready byte budget exceeded') }
    if (this.#countPhase('ready') >= this.#budget.maxReady) { this.#entries.delete(key); throw new Error('ready layer capacity exceeded') }
    if (this.#readyBytes() + actualBytes > this.#budget.maxAggregateReadyBytes) { this.#entries.delete(key); throw new Error('aggregate ready byte budget exceeded') }
    const ready: Entry = Object.freeze({ ...entry, phase: 'ready', actualBytes, expiresAt: now + this.#budget.readyTtlMs })
    this.#entries.set(key, ready)
    return this.#view(ready)
  }

  touch(viewId: string, serviceId: string, layerId: string, loadId: string, now: number): boolean {
    this.#active(); finite('now', now)
    const key = this.#key(id('viewId', viewId), id('serviceId', serviceId), id('layerId', layerId), id('loadId', loadId))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready' || now > entry.expiresAt) return false
    this.#entries.set(key, Object.freeze({ ...entry, expiresAt: now + this.#budget.readyTtlMs }))
    return true
  }

  consume(viewId: string, serviceId: string, layerId: string, loadId: string): Readonly<ArcGisLayerLoadView> | undefined {
    this.#active()
    const key = this.#key(id('viewId', viewId), id('serviceId', serviceId), id('layerId', layerId), id('loadId', loadId))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready') return undefined
    this.#entries.delete(key)
    return this.#view(entry)
  }

  cancel(viewId: string, serviceId: string, layerId: string, loadId: string): boolean {
    this.#active()
    const key = this.#key(id('viewId', viewId), id('serviceId', serviceId), id('layerId', layerId), id('loadId', loadId))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase === 'ready') return false
    return this.#entries.delete(key)
  }

  advanceRevision(serviceId: string, layerId: string, revision: number): number {
    this.#active(); const service = id('serviceId', serviceId), layer = id('layerId', layerId); integer('revision', revision)
    const revisionKey = this.#revisionKey(service, layer), current = this.#revisions.get(revisionKey)
    if (current !== undefined && revision < current) throw new Error('layer revision cannot move backwards')
    if (current === revision) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.serviceId === service && entry.layerId === layer && entry.revision < revision) { this.#entries.delete(key); removed += 1 }
    this.#revisions.set(revisionKey, revision)
    return removed
  }

  releaseView(viewId: string): number { return this.#release(entry => entry.viewId === id('viewId', viewId)) }
  releaseLayer(serviceId: string, layerId: string): number {
    const service = id('serviceId', serviceId), layer = id('layerId', layerId)
    const removed = this.#release(entry => entry.serviceId === service && entry.layerId === layer)
    this.#revisions.delete(this.#revisionKey(service, layer)); return removed
  }
  releaseService(serviceId: string): number {
    const service = id('serviceId', serviceId), removed = this.#release(entry => entry.serviceId === service)
    for (const key of [...this.#revisions.keys()]) if (key.startsWith(`${service}\u0000`)) this.#revisions.delete(key)
    return removed
  }

  expire(now: number): number {
    this.#active(); finite('now', now); let removed = 0
    for (const [key, entry] of this.#entries) if (now > entry.expiresAt) { this.#entries.delete(key); removed += 1 }
    return removed
  }

  snapshot(): readonly Readonly<ArcGisLayerLoadView>[] {
    this.#active(); return Object.freeze([...this.#entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.#view(entry)))
  }
  fingerprint(): string {
    return this.snapshot().slice().sort((a, b) => a.serviceId.localeCompare(b.serviceId) || a.layerId.localeCompare(b.layerId) || a.loadId.localeCompare(b.loadId))
      .map(entry => [entry.serviceId, entry.layerId, entry.loadId, entry.revision, entry.intent, entry.phase, entry.estimatedBytes, entry.actualBytes].join(':')).join('|')
  }
  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }

  #normalize(request: ArcGisLayerLoadRequest): ArcGisLayerLoadRequest {
    const normalized = { ...request, loadId: id('loadId', request.loadId), viewId: id('viewId', request.viewId), serviceId: id('serviceId', request.serviceId), layerId: id('layerId', request.layerId) }
    integer('revision', normalized.revision); finite('requestedAt', normalized.requestedAt); integer('estimatedBytes', normalized.estimatedBytes)
    if (normalized.estimatedBytes > this.#budget.maxReadyBytesPerLayer) throw new Error('estimated layer bytes exceed budget')
    return normalized
  }
  #release(predicate: (entry: Entry) => boolean): number { this.#active(); let removed = 0; for (const [key, entry] of this.#entries) if (predicate(entry)) { this.#entries.delete(key); removed += 1 } return removed }
  #countView(viewId: string): number { let total = 0; for (const entry of this.#entries.values()) if (entry.viewId === viewId) total += 1; return total }
  #countPhase(phase: ArcGisLayerLoadPhase): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) total += 1; return total }
  #readyBytes(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualBytes; return total }
  #entryKey(entry: Entry): string { return this.#key(entry.viewId, entry.serviceId, entry.layerId, entry.loadId) }
  #key(viewId: string, serviceId: string, layerId: string, loadId: string): string { return `${viewId}\u0000${serviceId}\u0000${layerId}\u0000${loadId}` }
  #revisionKey(serviceId: string, layerId: string): string { return `${serviceId}\u0000${layerId}` }
  #view(entry: Entry): Readonly<ArcGisLayerLoadView> { return Object.freeze({ loadId: entry.loadId, viewId: entry.viewId, serviceId: entry.serviceId, layerId: entry.layerId, revision: entry.revision, intent: entry.intent, phase: entry.phase, requestedAt: entry.requestedAt, estimatedBytes: entry.estimatedBytes, actualBytes: entry.actualBytes, sequence: entry.sequence, expiresAt: entry.expiresAt }) }
  #active(): void { if (this.#disposed) throw new Error('ArcGisLayerLoadLifecyclePolicy is disposed') }
}
