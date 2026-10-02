export type ArcGisSceneLodIntent = 'background' | 'visible' | 'interactive'
export type ArcGisSceneLodPhase = 'queued' | 'loading' | 'resident'

export interface ArcGisSceneLodBudget {
  maxTiles: number
  maxTilesPerView: number
  maxTilesPerLayer: number
  maxLoading: number
  maxLoadingPerView: number
  maxResident: number
  maxEstimatedTrianglesPerTile: number
  maxActualTrianglesPerTile: number
  maxResidentTriangles: number
  maxEstimatedBytesPerTile: number
  maxActualBytesPerTile: number
  maxResidentBytes: number
  minLevel: number
  maxLevel: number
  queueTtlMs: number
  loadTtlMs: number
  residentTtlMs: number
}

export interface ArcGisSceneLodRequest {
  tileId: string
  viewId: string
  layerId: string
  revision: number
  level: number
  intent: ArcGisSceneLodIntent
  requestedAt: number
  estimatedTriangles: number
  estimatedBytes: number
}

export interface ArcGisSceneLodCompletion {
  tileId: string
  viewId: string
  layerId: string
  revision: number
  level: number
  actualTriangles: number
  actualBytes: number
  completedAt: number
}

export interface ArcGisSceneLodView extends Readonly<ArcGisSceneLodRequest> {
  readonly phase: ArcGisSceneLodPhase
  readonly actualTriangles: number
  readonly actualBytes: number
  readonly sequence: number
  readonly expiresAt: number
}

interface Entry extends ArcGisSceneLodRequest {
  phase: ArcGisSceneLodPhase
  actualTriangles: number
  actualBytes: number
  sequence: number
  expiresAt: number
}

const priority = Object.freeze({ background: 0, visible: 1, interactive: 2 } satisfies Record<ArcGisSceneLodIntent, number>)
const idPattern = /^[A-Za-z0-9._:-]{1,160}$/

function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!idPattern.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}
function integer(name: string, value: number, minimum = 0): void { if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`) }
function finite(name: string, value: number): void { if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`) }

/** Payload-free authority for SceneLayer/3D tile LOD loading and GPU residency metadata. */
export class ArcGisSceneLodResidencyPolicy {
  readonly #budget: Readonly<ArcGisSceneLodBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #layerRevisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisSceneLodBudget) {
    for (const [name, value] of Object.entries(budget)) { if (name.endsWith('Ms')) finite(name, value); else integer(name, value, name === 'minLevel' ? 0 : 1) }
    if (budget.minLevel > budget.maxLevel) throw new Error('LOD level budget is impossible')
    if (budget.maxTilesPerView > budget.maxTiles || budget.maxTilesPerLayer > budget.maxTiles) throw new Error('LOD cardinality budget is impossible')
    if (budget.maxLoading > budget.maxTiles || budget.maxLoadingPerView > budget.maxLoading || budget.maxResident > budget.maxTiles) throw new Error('LOD phase budget is impossible')
    if (budget.maxEstimatedTrianglesPerTile > budget.maxActualTrianglesPerTile || budget.maxActualTrianglesPerTile > budget.maxResidentTriangles) throw new Error('LOD triangle budget is impossible')
    if (budget.maxEstimatedBytesPerTile > budget.maxActualBytesPerTile || budget.maxActualBytesPerTile > budget.maxResidentBytes) throw new Error('LOD byte budget is impossible')
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(request: ArcGisSceneLodRequest): Readonly<ArcGisSceneLodView> {
    this.#active(); const tileId = identifier('tileId', request.tileId); const viewId = identifier('viewId', request.viewId); const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision); integer('level', request.level); finite('requestedAt', request.requestedAt); integer('estimatedTriangles', request.estimatedTriangles); integer('estimatedBytes', request.estimatedBytes)
    if (!(request.intent in priority)) throw new Error('LOD intent is invalid')
    if (request.level < this.#budget.minLevel || request.level > this.#budget.maxLevel) throw new Error('LOD level outside budget')
    if (request.estimatedTriangles > this.#budget.maxEstimatedTrianglesPerTile) throw new Error('estimated triangle budget exceeded')
    if (request.estimatedBytes > this.#budget.maxEstimatedBytesPerTile) throw new Error('estimated byte budget exceeded')
    if (this.#entries.has(tileId)) throw new Error('duplicate LOD tile authority')
    if (this.#entries.size >= this.#budget.maxTiles) throw new Error('LOD capacity exceeded')
    if (this.#count(entry => entry.viewId === viewId) >= this.#budget.maxTilesPerView) throw new Error('view LOD capacity exceeded')
    if (this.#count(entry => entry.layerId === layerId) >= this.#budget.maxTilesPerLayer) throw new Error('layer LOD capacity exceeded')
    const watermark = this.#layerRevisions.get(layerId)
    if (watermark !== undefined && request.revision < watermark) throw new Error('stale layer revision')
    if (watermark === undefined || request.revision > watermark) this.advanceLayerRevision(layerId, request.revision)
    const entry: Entry = Object.freeze({ ...request, tileId, viewId, layerId, phase: 'queued', actualTriangles: 0, actualBytes: 0, sequence: this.#sequence++, expiresAt: request.requestedAt + this.#budget.queueTtlMs })
    this.#entries.set(tileId, entry); return this.#view(entry)
  }

  takeNext(now: number): Readonly<ArcGisSceneLodView> | undefined {
    this.#active(); finite('now', now); this.expire(now)
    if (this.#count(entry => entry.phase === 'loading') >= this.#budget.maxLoading) return undefined
    const selected = [...this.#entries.values()].filter(entry => entry.phase === 'queued').sort((a, b) => priority[b.intent] - priority[a.intent] || b.level - a.level || a.requestedAt - b.requestedAt || a.tileId.localeCompare(b.tileId)).find(candidate => this.#count(entry => entry.phase === 'loading' && entry.viewId === candidate.viewId) < this.#budget.maxLoadingPerView)
    if (!selected) return undefined
    const loading: Entry = Object.freeze({ ...selected, phase: 'loading', expiresAt: now + this.#budget.loadTtlMs }); this.#entries.set(selected.tileId, loading); return this.#view(loading)
  }

  complete(completion: ArcGisSceneLodCompletion): Readonly<ArcGisSceneLodView> {
    this.#active(); const tileId = identifier('tileId', completion.tileId); const viewId = identifier('viewId', completion.viewId); const layerId = identifier('layerId', completion.layerId)
    integer('revision', completion.revision); integer('level', completion.level); integer('actualTriangles', completion.actualTriangles); integer('actualBytes', completion.actualBytes); finite('completedAt', completion.completedAt)
    const entry = this.#entries.get(tileId)
    if (!entry || entry.phase !== 'loading') throw new Error('LOD tile is not loading')
    if (entry.viewId !== viewId || entry.layerId !== layerId || entry.revision !== completion.revision || entry.level !== completion.level) throw new Error('LOD completion identity mismatch')
    if (completion.completedAt > entry.expiresAt) { this.#entries.delete(tileId); throw new Error('LOD load lease expired') }
    if (this.#layerRevisions.get(layerId) !== completion.revision) { this.#entries.delete(tileId); throw new Error('stale LOD completion revision') }
    if (completion.actualTriangles > this.#budget.maxActualTrianglesPerTile) { this.#entries.delete(tileId); throw new Error('actual triangle budget exceeded') }
    if (completion.actualBytes > this.#budget.maxActualBytesPerTile) { this.#entries.delete(tileId); throw new Error('actual byte budget exceeded') }
    this.#evictForPressure(completion.actualTriangles, completion.actualBytes, tileId)
    if (this.#count(item => item.phase === 'resident') >= this.#budget.maxResident) { this.#entries.delete(tileId); throw new Error('resident LOD capacity exceeded') }
    if (this.#sumResident('triangles') + completion.actualTriangles > this.#budget.maxResidentTriangles) { this.#entries.delete(tileId); throw new Error('resident triangle budget exceeded') }
    if (this.#sumResident('bytes') + completion.actualBytes > this.#budget.maxResidentBytes) { this.#entries.delete(tileId); throw new Error('resident byte budget exceeded') }
    const resident: Entry = Object.freeze({ ...entry, phase: 'resident', actualTriangles: completion.actualTriangles, actualBytes: completion.actualBytes, expiresAt: completion.completedAt + this.#budget.residentTtlMs }); this.#entries.set(tileId, resident); return this.#view(resident)
  }

  touch(tileId: string, now: number): boolean { this.#active(); const key = identifier('tileId', tileId); finite('now', now); const entry = this.#entries.get(key); if (!entry || entry.phase !== 'resident' || now > entry.expiresAt) return false; this.#entries.set(key, Object.freeze({ ...entry, expiresAt: now + this.#budget.residentTtlMs })); return true }
  consume(tileId: string): Readonly<ArcGisSceneLodView> | undefined { this.#active(); const key = identifier('tileId', tileId); const entry = this.#entries.get(key); if (!entry || entry.phase !== 'resident') return undefined; this.#entries.delete(key); return this.#view(entry) }
  cancel(tileId: string): boolean { this.#active(); const key = identifier('tileId', tileId); const entry = this.#entries.get(key); return !!entry && entry.phase !== 'resident' && this.#entries.delete(key) }

  advanceLayerRevision(layerId: string, revision: number): number {
    this.#active(); const layer = identifier('layerId', layerId); integer('revision', revision); const current = this.#layerRevisions.get(layer)
    if (current !== undefined && revision < current) throw new Error('layer revision cannot move backwards'); if (current === revision) return 0
    let removed = 0; for (const [key, entry] of this.#entries) if (entry.layerId === layer && entry.revision < revision) { this.#entries.delete(key); removed++ }
    this.#layerRevisions.set(layer, revision); return removed
  }
  expire(now: number): number { this.#active(); finite('now', now); let removed = 0; for (const [key, entry] of this.#entries) if (now > entry.expiresAt) { this.#entries.delete(key); removed++ } return removed }
  releaseView(viewId: string): number { const view = identifier('viewId', viewId); return this.#release(entry => entry.viewId === view) }
  releaseLayer(layerId: string): number { const layer = identifier('layerId', layerId); const removed = this.#release(entry => entry.layerId === layer); this.#layerRevisions.delete(layer); return removed }
  snapshot(): readonly Readonly<ArcGisSceneLodView>[] { this.#active(); return Object.freeze([...this.#entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.#view(entry))) }
  fingerprint(): string { this.#active(); return [...this.#entries.values()].sort((a, b) => a.tileId.localeCompare(b.tileId)).map(entry => [entry.tileId, entry.viewId, entry.layerId, entry.revision, entry.level, entry.intent, entry.phase, entry.actualTriangles, entry.actualBytes].join(':')).join('|') }
  dispose(): void { this.#entries.clear(); this.#layerRevisions.clear(); this.#disposed = true }

  #evictForPressure(incomingTriangles: number, incomingBytes: number, incomingId: string): void {
    const residents = () => [...this.#entries.values()].filter(entry => entry.phase === 'resident' && entry.tileId !== incomingId)
    while (residents().length >= this.#budget.maxResident || this.#sumResident('triangles') + incomingTriangles > this.#budget.maxResidentTriangles || this.#sumResident('bytes') + incomingBytes > this.#budget.maxResidentBytes) {
      const victim = residents().sort((a, b) => priority[a.intent] - priority[b.intent] || a.level - b.level || a.expiresAt - b.expiresAt || a.sequence - b.sequence || a.tileId.localeCompare(b.tileId))[0]
      if (!victim || priority[victim.intent] >= priority[this.#entries.get(incomingId)?.intent ?? 'background']) break
      this.#entries.delete(victim.tileId)
    }
  }
  #release(predicate: (entry: Entry) => boolean): number { this.#active(); let total = 0; for (const [key, entry] of this.#entries) if (predicate(entry)) { this.#entries.delete(key); total++ } return total }
  #count(predicate: (entry: Entry) => boolean): number { let total = 0; for (const entry of this.#entries.values()) if (predicate(entry)) total++; return total }
  #sumResident(metric: 'triangles' | 'bytes'): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'resident') total += metric === 'triangles' ? entry.actualTriangles : entry.actualBytes; return total }
  #view(entry: Entry): Readonly<ArcGisSceneLodView> { return Object.freeze({ tileId: entry.tileId, viewId: entry.viewId, layerId: entry.layerId, revision: entry.revision, level: entry.level, intent: entry.intent, requestedAt: entry.requestedAt, estimatedTriangles: entry.estimatedTriangles, estimatedBytes: entry.estimatedBytes, phase: entry.phase, actualTriangles: entry.actualTriangles, actualBytes: entry.actualBytes, sequence: entry.sequence, expiresAt: entry.expiresAt }) }
  #active(): void { if (this.#disposed) throw new Error('ArcGisSceneLodResidencyPolicy is disposed') }
}
