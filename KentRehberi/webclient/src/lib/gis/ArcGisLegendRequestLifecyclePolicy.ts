export type ArcGisLegendIntent = 'background' | 'visible' | 'interactive'
export type ArcGisLegendPhase = 'queued' | 'loading' | 'ready'

export interface ArcGisLegendBudget {
  maxServices: number
  maxRequests: number
  maxRequestsPerService: number
  maxLoading: number
  maxLoadingPerService: number
  maxReady: number
  maxReadyPerService: number
  maxItemsPerResponse: number
  maxBytesPerResponse: number
  maxAggregateReadyBytes: number
  queueTtlMs: number
  loadLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisLegendRequest {
  serviceId: string
  requestId: string
  revision: number
  intent: ArcGisLegendIntent
  requestedAt: number
  estimatedItems: number
  estimatedBytes: number
}

export interface ArcGisLegendSnapshot extends ArcGisLegendRequest {
  phase: ArcGisLegendPhase
  sequence: number
  actualItems: number
  actualBytes: number
  expiresAt: number
  lastAccessedAt: number
}

type Entry = ArcGisLegendSnapshot
const rank: Readonly<Record<ArcGisLegendIntent, number>> = Object.freeze({ interactive: 0, visible: 1, background: 2 })
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/

/** Metadata-only authority for ArcGIS REST legend hydration; image/data payloads remain caller-owned. */
export class ArcGisLegendRequestLifecyclePolicy {
  readonly #budget: Readonly<ArcGisLegendBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisLegendBudget) {
    for (const [name, value] of Object.entries(budget)) this.#positive(name, value)
    if (budget.maxRequestsPerService > budget.maxRequests) throw new RangeError('maxRequestsPerService exceeds maxRequests')
    if (budget.maxLoading > budget.maxRequests || budget.maxReady > budget.maxRequests) throw new RangeError('phase cardinality exceeds maxRequests')
    if (budget.maxLoadingPerService > budget.maxLoading || budget.maxReadyPerService > budget.maxReady) throw new RangeError('per-service phase cardinality exceeds global cardinality')
    if (budget.maxBytesPerResponse > budget.maxAggregateReadyBytes) throw new RangeError('byte budget is inconsistent')
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(source: ArcGisLegendRequest): boolean {
    this.#active()
    const request = this.#normalize(source)
    if (request.estimatedItems > this.#budget.maxItemsPerResponse || request.estimatedBytes > this.#budget.maxBytesPerResponse) return false
    const watermark = this.#revisions.get(request.serviceId) ?? 0
    if (request.revision < watermark) return false
    const key = this.#key(request.serviceId, request.requestId)
    const previous = this.#entries.get(key)
    if (previous && request.revision < previous.revision) return false
    if (previous && request.revision === previous.revision && rank[request.intent] >= rank[previous.intent]) return false
    const advances = request.revision > watermark
    const survives = (entry: Entry) => entry !== previous && !(advances && entry.serviceId === request.serviceId && entry.revision < request.revision)
    if (this.#count(survives) + 1 > this.#budget.maxRequests) return false
    if (this.#count(entry => survives(entry) && entry.serviceId === request.serviceId) + 1 > this.#budget.maxRequestsPerService) return false
    const services = new Set([...this.#entries.values()].filter(survives).map(entry => entry.serviceId))
    if (!services.has(request.serviceId) && services.size >= this.#budget.maxServices) return false
    if (advances) this.invalidateService(request.serviceId, request.revision)
    else if (previous) this.#entries.delete(key)
    this.#revisions.set(request.serviceId, request.revision)
    this.#entries.set(key, Object.freeze({ ...request, phase: 'queued', sequence: previous?.sequence ?? this.#sequence++, actualItems: 0, actualBytes: 0, expiresAt: request.requestedAt + this.#budget.queueTtlMs, lastAccessedAt: request.requestedAt }))
    return true
  }

  takeNext(now: number): Readonly<ArcGisLegendSnapshot> | undefined {
    this.#active(); this.#time('now', now); this.expire(now)
    if (this.#phaseCount('loading') >= this.#budget.maxLoading) return undefined
    const next = [...this.#entries.values()].filter(entry => entry.phase === 'queued' && this.#phaseCountForService('loading', entry.serviceId) < this.#budget.maxLoadingPerService).sort((a, b) => rank[a.intent] - rank[b.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence)[0]
    if (!next) return undefined
    const loading: Entry = Object.freeze({ ...next, phase: 'loading', expiresAt: now + this.#budget.loadLeaseMs, lastAccessedAt: now })
    this.#entries.set(this.#key(next.serviceId, next.requestId), loading)
    return this.#detach(loading)
  }

  complete(serviceId: string, requestId: string, revision: number, actualItems: number, actualBytes: number, now: number): boolean {
    this.#active()
    const service = this.#id('serviceId', serviceId), request = this.#id('requestId', requestId)
    this.#nonNegativeInteger('revision', revision); this.#nonNegativeInteger('actualItems', actualItems); this.#nonNegativeInteger('actualBytes', actualBytes); this.#time('now', now)
    const key = this.#key(service, request), entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'loading' || entry.revision !== revision) return false
    if (now >= entry.expiresAt || revision < (this.#revisions.get(service) ?? 0)) { this.#entries.delete(key); return false }
    if (actualItems > this.#budget.maxItemsPerResponse || actualBytes > this.#budget.maxBytesPerResponse) { this.#entries.delete(key); return false }
    this.#release(candidate => candidate !== entry && now >= candidate.expiresAt)
    this.#evictForAdmission(service, actualBytes)
    if (this.#phaseCount('ready') >= this.#budget.maxReady || this.#phaseCountForService('ready', service) >= this.#budget.maxReadyPerService || this.#readyBytes() + actualBytes > this.#budget.maxAggregateReadyBytes) { this.#entries.delete(key); return false }
    this.#entries.set(key, Object.freeze({ ...entry, phase: 'ready', actualItems, actualBytes, expiresAt: now + this.#budget.readyTtlMs, lastAccessedAt: now }))
    return true
  }

  touch(serviceId: string, requestId: string, revision: number, now: number): boolean {
    this.#active(); this.#time('now', now)
    const key = this.#key(this.#id('serviceId', serviceId), this.#id('requestId', requestId)), entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready' || entry.revision !== revision || now >= entry.expiresAt) return false
    this.#entries.set(key, Object.freeze({ ...entry, lastAccessedAt: now })); return true
  }

  consume(serviceId: string, requestId: string, revision: number): boolean {
    this.#active(); this.#nonNegativeInteger('revision', revision)
    const key = this.#key(this.#id('serviceId', serviceId), this.#id('requestId', requestId)), entry = this.#entries.get(key)
    return !!entry && entry.phase === 'ready' && entry.revision === revision && this.#entries.delete(key)
  }

  cancel(serviceId: string, requestId: string, revision: number): boolean {
    this.#active(); this.#nonNegativeInteger('revision', revision)
    const key = this.#key(this.#id('serviceId', serviceId), this.#id('requestId', requestId)), entry = this.#entries.get(key)
    return !!entry && entry.revision === revision && this.#entries.delete(key)
  }

  invalidateService(serviceId: string, revision: number): number {
    this.#active(); const service = this.#id('serviceId', serviceId); this.#nonNegativeInteger('revision', revision)
    const current = this.#revisions.get(service) ?? 0
    if (revision <= current) return 0
    this.#revisions.set(service, revision)
    return this.#release(entry => entry.serviceId === service && entry.revision < revision)
  }

  releaseService(serviceId: string): number {
    this.#active(); const service = this.#id('serviceId', serviceId); this.#revisions.delete(service); return this.#release(entry => entry.serviceId === service)
  }

  expire(now: number): number { this.#active(); this.#time('now', now); return this.#release(entry => now >= entry.expiresAt) }
  snapshot(): readonly Readonly<ArcGisLegendSnapshot>[] { this.#active(); return Object.freeze([...this.#entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.#detach(entry))) }
  fingerprint(): string { return this.snapshot().map(entry => `${entry.serviceId}:${entry.requestId}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.actualItems}:${entry.actualBytes}`).join('|') }
  dispose(): void { if (this.#disposed) return; this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }

  #normalize(source: ArcGisLegendRequest): ArcGisLegendRequest {
    const serviceId = this.#id('serviceId', source.serviceId), requestId = this.#id('requestId', source.requestId)
    this.#nonNegativeInteger('revision', source.revision); this.#time('requestedAt', source.requestedAt); this.#nonNegativeInteger('estimatedItems', source.estimatedItems); this.#nonNegativeInteger('estimatedBytes', source.estimatedBytes)
    if (!(source.intent in rank)) throw new Error('intent is invalid')
    return Object.freeze({ ...source, serviceId, requestId })
  }

  #evictForAdmission(serviceId: string, bytes: number): void {
    const candidates = [...this.#entries.values()].filter(entry => entry.phase === 'ready').sort((a, b) => rank[b.intent] - rank[a.intent] || a.lastAccessedAt - b.lastAccessedAt || a.sequence - b.sequence)
    for (const candidate of candidates) {
      const globalPressure = this.#phaseCount('ready') >= this.#budget.maxReady || this.#readyBytes() + bytes > this.#budget.maxAggregateReadyBytes
      const servicePressure = this.#phaseCountForService('ready', serviceId) >= this.#budget.maxReadyPerService
      if (!globalPressure && !servicePressure) break
      if (servicePressure && candidate.serviceId !== serviceId && !globalPressure) continue
      this.#entries.delete(this.#key(candidate.serviceId, candidate.requestId))
    }
  }

  #readyBytes(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualBytes; return total }
  #phaseCount(phase: ArcGisLegendPhase): number { return this.#count(entry => entry.phase === phase) }
  #phaseCountForService(phase: ArcGisLegendPhase, serviceId: string): number { return this.#count(entry => entry.phase === phase && entry.serviceId === serviceId) }
  #count(predicate: (entry: Entry) => boolean): number { let total = 0; for (const entry of this.#entries.values()) if (predicate(entry)) total += 1; return total }
  #release(predicate: (entry: Entry) => boolean): number { let removed = 0; for (const [key, entry] of this.#entries) if (predicate(entry)) { this.#entries.delete(key); removed += 1 } return removed }
  #detach(entry: Entry): Readonly<ArcGisLegendSnapshot> { return Object.freeze({ ...entry }) }
  #key(serviceId: string, requestId: string): string { return `${serviceId}\u0000${requestId}` }
  #id(name: string, value: string): string { const normalized = value.trim(); if (!SAFE_ID.test(normalized)) throw new Error(`${name} is invalid`); return normalized }
  #positive(name: string, value: number): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`) }
  #nonNegativeInteger(name: string, value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`) }
  #time(name: string, value: number): void { if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative`) }
  #active(): void { if (this.#disposed) throw new Error('ArcGisLegendRequestLifecyclePolicy is disposed') }
}
