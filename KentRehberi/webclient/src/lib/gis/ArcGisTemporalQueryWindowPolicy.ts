export type ArcGisTemporalIntent = 'background' | 'visible' | 'interactive'
export type ArcGisTemporalPhase = 'queued' | 'running' | 'ready'

export interface ArcGisTemporalWindowBudget {
  maxLayers: number
  maxWindows: number
  maxWindowsPerLayer: number
  maxRunning: number
  maxRunningPerLayer: number
  maxReady: number
  maxReadyPerLayer: number
  maxFeaturesPerWindow: number
  maxBytesPerWindow: number
  maxAggregateReadyFeatures: number
  maxAggregateReadyBytes: number
  maxWindowSpanMs: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisTemporalWindowRequest {
  layerId: string
  windowId: string
  revision: number
  intent: ArcGisTemporalIntent
  startTime: number
  endTime: number
  requestedAt: number
  estimatedFeatures: number
  estimatedBytes: number
}

export interface ArcGisTemporalWindowSnapshot extends ArcGisTemporalWindowRequest {
  phase: ArcGisTemporalPhase
  sequence: number
  actualFeatures: number
  actualBytes: number
  expiresAt: number
  lastAccessedAt: number
}

type Entry = ArcGisTemporalWindowSnapshot
const rank: Readonly<Record<ArcGisTemporalIntent, number>> = Object.freeze({ interactive: 0, visible: 1, background: 2 })
const ID = /^[A-Za-z0-9_.:-]{1,160}$/

/**
 * Scalar-only authority for time-enabled ArcGIS REST query windows.
 * FeatureSet, Graphic, Geometry, Query, credential and AbortSignal objects stay caller-owned.
 * It bounds temporal fan-out, in-flight work and ready metadata while preserving monotonic
 * layer revisions so a time-slider change cannot resurrect stale results.
 */
export class ArcGisTemporalQueryWindowPolicy {
  readonly #budget: Readonly<ArcGisTemporalWindowBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisTemporalWindowBudget) {
    for (const [name, value] of Object.entries(budget)) this.#positive(name, value)
    if (budget.maxWindowsPerLayer > budget.maxWindows) throw new RangeError('maxWindowsPerLayer exceeds maxWindows')
    if (budget.maxRunning > budget.maxWindows || budget.maxReady > budget.maxWindows) throw new RangeError('phase cardinality exceeds maxWindows')
    if (budget.maxRunningPerLayer > budget.maxRunning || budget.maxReadyPerLayer > budget.maxReady) throw new RangeError('per-layer phase cardinality exceeds global cardinality')
    if (budget.maxFeaturesPerWindow > budget.maxAggregateReadyFeatures) throw new RangeError('feature budget is inconsistent')
    if (budget.maxBytesPerWindow > budget.maxAggregateReadyBytes) throw new RangeError('byte budget is inconsistent')
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(source: ArcGisTemporalWindowRequest): boolean {
    this.#active()
    const request = this.#normalize(source)
    const watermark = this.#revisions.get(request.layerId) ?? 0
    if (request.revision < watermark) return false
    const key = this.#key(request.layerId, request.windowId)
    const previous = this.#entries.get(key)
    if (previous && request.revision < previous.revision) return false
    if (previous && request.revision === previous.revision && rank[request.intent] >= rank[previous.intent]) return false
    if (request.estimatedFeatures > this.#budget.maxFeaturesPerWindow || request.estimatedBytes > this.#budget.maxBytesPerWindow) return false
    const advances = request.revision > watermark
    const survives = (entry: Entry) => entry !== previous && !(advances && entry.layerId === request.layerId && entry.revision < request.revision)
    if (this.#count(survives) + 1 > this.#budget.maxWindows) return false
    if (this.#count(entry => survives(entry) && entry.layerId === request.layerId) + 1 > this.#budget.maxWindowsPerLayer) return false
    const layers = new Set([...this.#entries.values()].filter(survives).map(entry => entry.layerId))
    if (!layers.has(request.layerId) && layers.size >= this.#budget.maxLayers) return false
    if (advances) this.invalidateLayer(request.layerId, request.revision)
    else if (previous) this.#entries.delete(key)
    this.#revisions.set(request.layerId, request.revision)
    this.#entries.set(key, Object.freeze({ ...request, phase: 'queued', sequence: previous?.sequence ?? this.#sequence++, actualFeatures: 0, actualBytes: 0, expiresAt: request.requestedAt + this.#budget.queueTtlMs, lastAccessedAt: request.requestedAt }))
    return true
  }

  takeNext(now: number): Readonly<ArcGisTemporalWindowSnapshot> | undefined {
    this.#active(); this.#time('now', now); this.expire(now)
    if (this.#phaseCount('running') >= this.#budget.maxRunning) return undefined
    const next = [...this.#entries.values()]
      .filter(entry => entry.phase === 'queued' && this.#phaseCountForLayer('running', entry.layerId) < this.#budget.maxRunningPerLayer)
      .sort((a, b) => rank[a.intent] - rank[b.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence || a.windowId.localeCompare(b.windowId))[0]
    if (!next) return undefined
    const running: Entry = Object.freeze({ ...next, phase: 'running', expiresAt: now + this.#budget.runLeaseMs, lastAccessedAt: now })
    this.#entries.set(this.#key(next.layerId, next.windowId), running)
    return this.#detach(running)
  }

  complete(layerId: string, windowId: string, revision: number, actualFeatures: number, actualBytes: number, now: number): boolean {
    this.#active(); const layer = this.#id('layerId', layerId), window = this.#id('windowId', windowId)
    this.#nonNegativeInteger('revision', revision); this.#nonNegativeInteger('actualFeatures', actualFeatures); this.#nonNegativeInteger('actualBytes', actualBytes); this.#time('now', now)
    const key = this.#key(layer, window), entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision) return false
    if (now >= entry.expiresAt || revision < (this.#revisions.get(layer) ?? 0)) { this.#entries.delete(key); return false }
    if (actualFeatures > this.#budget.maxFeaturesPerWindow || actualBytes > this.#budget.maxBytesPerWindow) { this.#entries.delete(key); return false }
    this.#release(candidate => candidate !== entry && now >= candidate.expiresAt)
    this.#evictForAdmission(layer, actualFeatures, actualBytes)
    if (this.#phaseCount('ready') >= this.#budget.maxReady || this.#phaseCountForLayer('ready', layer) >= this.#budget.maxReadyPerLayer) { this.#entries.delete(key); return false }
    if (this.#readyFeatures() + actualFeatures > this.#budget.maxAggregateReadyFeatures || this.#readyBytes() + actualBytes > this.#budget.maxAggregateReadyBytes) { this.#entries.delete(key); return false }
    const ready: Entry = Object.freeze({ ...entry, phase: 'ready', actualFeatures, actualBytes, expiresAt: now + this.#budget.readyTtlMs, lastAccessedAt: now })
    this.#entries.set(key, ready); return true
  }

  touch(layerId: string, windowId: string, revision: number, now: number): boolean {
    this.#active(); this.#time('now', now); const key = this.#key(this.#id('layerId', layerId), this.#id('windowId', windowId)); const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'ready' || entry.revision !== revision || now >= entry.expiresAt) return false
    this.#entries.set(key, Object.freeze({ ...entry, lastAccessedAt: now })); return true
  }

  consume(layerId: string, windowId: string, revision: number): boolean {
    this.#active(); this.#nonNegativeInteger('revision', revision); const key = this.#key(this.#id('layerId', layerId), this.#id('windowId', windowId)); const entry = this.#entries.get(key)
    return !!entry && entry.phase === 'ready' && entry.revision === revision && this.#entries.delete(key)
  }

  cancel(layerId: string, windowId: string, revision: number): boolean {
    this.#active(); this.#nonNegativeInteger('revision', revision); const key = this.#key(this.#id('layerId', layerId), this.#id('windowId', windowId)); const entry = this.#entries.get(key)
    return !!entry && entry.revision === revision && this.#entries.delete(key)
  }

  invalidateLayer(layerId: string, revision: number): number {
    this.#active(); const layer = this.#id('layerId', layerId); this.#nonNegativeInteger('revision', revision); const current = this.#revisions.get(layer) ?? 0
    if (revision <= current) return 0
    this.#revisions.set(layer, revision)
    return this.#release(entry => entry.layerId === layer && entry.revision < revision)
  }

  releaseLayer(layerId: string): number {
    this.#active(); const layer = this.#id('layerId', layerId); this.#revisions.delete(layer); return this.#release(entry => entry.layerId === layer)
  }

  expire(now: number): number { this.#active(); this.#time('now', now); return this.#release(entry => now >= entry.expiresAt) }

  snapshot(): readonly Readonly<ArcGisTemporalWindowSnapshot>[] {
    this.#active(); return Object.freeze([...this.#entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.#detach(entry)))
  }

  fingerprint(): string {
    return this.snapshot().map(entry => `${entry.layerId}:${entry.windowId}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.startTime}:${entry.endTime}:${entry.actualFeatures}:${entry.actualBytes}`).join('|')
  }

  dispose(): void { if (this.#disposed) return; this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }

  #normalize(source: ArcGisTemporalWindowRequest): ArcGisTemporalWindowRequest {
    const layerId = this.#id('layerId', source.layerId), windowId = this.#id('windowId', source.windowId)
    this.#nonNegativeInteger('revision', source.revision); this.#time('startTime', source.startTime); this.#time('endTime', source.endTime); this.#time('requestedAt', source.requestedAt)
    this.#nonNegativeInteger('estimatedFeatures', source.estimatedFeatures); this.#nonNegativeInteger('estimatedBytes', source.estimatedBytes)
    if (!(source.intent in rank)) throw new Error('intent is invalid')
    if (source.endTime <= source.startTime) throw new RangeError('temporal window must have positive span')
    if (source.endTime - source.startTime > this.#budget.maxWindowSpanMs) throw new RangeError('temporal window span exceeds budget')
    return Object.freeze({ ...source, layerId, windowId })
  }

  #evictForAdmission(layerId: string, features: number, bytes: number): void {
    const candidates = [...this.#entries.values()].filter(entry => entry.phase === 'ready').sort((a, b) => rank[b.intent] - rank[a.intent] || a.lastAccessedAt - b.lastAccessedAt || a.sequence - b.sequence)
    for (const candidate of candidates) {
      const globalPressure = this.#phaseCount('ready') >= this.#budget.maxReady || this.#readyFeatures() + features > this.#budget.maxAggregateReadyFeatures || this.#readyBytes() + bytes > this.#budget.maxAggregateReadyBytes
      const layerPressure = this.#phaseCountForLayer('ready', layerId) >= this.#budget.maxReadyPerLayer
      if (!globalPressure && !layerPressure) break
      if (layerPressure && candidate.layerId !== layerId && !globalPressure) continue
      this.#entries.delete(this.#key(candidate.layerId, candidate.windowId))
    }
  }

  #readyFeatures(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualFeatures; return total }
  #readyBytes(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'ready') total += entry.actualBytes; return total }
  #phaseCount(phase: ArcGisTemporalPhase): number { return this.#count(entry => entry.phase === phase) }
  #phaseCountForLayer(phase: ArcGisTemporalPhase, layerId: string): number { return this.#count(entry => entry.phase === phase && entry.layerId === layerId) }
  #count(predicate: (entry: Entry) => boolean): number { let total = 0; for (const entry of this.#entries.values()) if (predicate(entry)) total += 1; return total }
  #release(predicate: (entry: Entry) => boolean): number { let removed = 0; for (const [key, entry] of this.#entries) if (predicate(entry)) { this.#entries.delete(key); removed += 1 } return removed }
  #detach(entry: Entry): Readonly<ArcGisTemporalWindowSnapshot> { return Object.freeze({ ...entry }) }
  #key(layerId: string, windowId: string): string { return `${layerId}\u0000${windowId}` }
  #id(name: string, value: string): string { const normalized = value.trim(); if (!ID.test(normalized)) throw new Error(`${name} is invalid`); return normalized }
  #positive(name: string, value: number): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`) }
  #nonNegativeInteger(name: string, value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`) }
  #time(name: string, value: number): void { if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative`) }
  #active(): void { if (this.#disposed) throw new Error('ArcGisTemporalQueryWindowPolicy is disposed') }
}
