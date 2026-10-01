export type ArcGisSceneTileIntent = 'prefetch' | 'visible' | 'interactive'
export type ArcGisSceneTilePhase = 'queued' | 'loading' | 'resident'

export interface ArcGisSceneTileBudget {
  maxTiles: number
  maxTilesPerView: number
  maxLoading: number
  maxResident: number
  maxBytesPerTile: number
  maxTrianglesPerTile: number
  maxAggregateBytes: number
  maxAggregateTriangles: number
  queueTtlMs: number
  loadLeaseMs: number
  residentTtlMs: number
}

export interface ArcGisSceneTileRequest {
  viewId: string
  layerId: string
  tileKey: string
  revision: number
  intent: ArcGisSceneTileIntent
  requestedAt: number
  estimatedBytes: number
  estimatedTriangles: number
  level: number
}

export interface ArcGisSceneTileView {
  readonly viewId: string
  readonly layerId: string
  readonly tileKey: string
  readonly revision: number
  readonly intent: ArcGisSceneTileIntent
  readonly phase: ArcGisSceneTilePhase
  readonly bytes: number
  readonly triangles: number
  readonly level: number
  readonly expiresAt: number
}

interface Entry extends ArcGisSceneTileRequest {
  phase: ArcGisSceneTilePhase
  sequence: number
  bytes: number
  triangles: number
  expiresAt: number
}

const priority: Readonly<Record<ArcGisSceneTileIntent, number>> = Object.freeze({ prefetch: 0, visible: 1, interactive: 2 })

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
 * Payload-free lifecycle authority for ArcGIS SceneLayer / integrated-mesh tile
 * residency. GPU resources, ArrayBuffers, Mesh instances and AbortControllers
 * deliberately remain owned by the caller. The policy stores only bounded
 * accounting metadata so view teardown cannot retain SDK object graphs.
 */
export class ArcGisSceneTileLifecyclePolicy {
  readonly #budget: Readonly<ArcGisSceneTileBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisSceneTileBudget) {
    integer('maxTiles', budget.maxTiles, 1)
    integer('maxTilesPerView', budget.maxTilesPerView, 1)
    integer('maxLoading', budget.maxLoading, 1)
    integer('maxResident', budget.maxResident, 1)
    integer('maxBytesPerTile', budget.maxBytesPerTile, 1)
    integer('maxTrianglesPerTile', budget.maxTrianglesPerTile, 1)
    integer('maxAggregateBytes', budget.maxAggregateBytes, 1)
    integer('maxAggregateTriangles', budget.maxAggregateTriangles, 1)
    finite('queueTtlMs', budget.queueTtlMs)
    finite('loadLeaseMs', budget.loadLeaseMs)
    finite('residentTtlMs', budget.residentTtlMs)
    if (budget.maxTilesPerView > budget.maxTiles) throw new Error('maxTilesPerView cannot exceed maxTiles')
    if (budget.maxLoading > budget.maxTiles || budget.maxResident > budget.maxTiles) throw new Error('phase limits cannot exceed maxTiles')
    if (budget.maxBytesPerTile > budget.maxAggregateBytes) throw new Error('byte budget is inconsistent')
    if (budget.maxTrianglesPerTile > budget.maxAggregateTriangles) throw new Error('triangle budget is inconsistent')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisSceneTileRequest): boolean {
    this.#active()
    const viewId = identifier('viewId', request.viewId)
    const layerId = identifier('layerId', request.layerId)
    const tileKey = identifier('tileKey', request.tileKey)
    integer('revision', request.revision, 0)
    finite('requestedAt', request.requestedAt)
    integer('estimatedBytes', request.estimatedBytes, 0)
    integer('estimatedTriangles', request.estimatedTriangles, 0)
    integer('level', request.level, 0)
    if (request.estimatedBytes > this.#budget.maxBytesPerTile || request.estimatedTriangles > this.#budget.maxTrianglesPerTile) return false

    const revisionKey = this.#revisionKey(viewId, layerId)
    const watermark = this.#revisions.get(revisionKey)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidateLayer(viewId, layerId, request.revision)

    const key = this.#key(viewId, layerId, tileKey)
    const existing = this.#entries.get(key)
    if (existing && existing.revision === request.revision && priority[existing.intent] > priority[request.intent]) return false
    if (!existing && this.#entries.size >= this.#budget.maxTiles) return false
    if (!existing && this.#countView(viewId) >= this.#budget.maxTilesPerView) return false
    if (this.#sum('bytes') - (existing?.bytes ?? 0) + request.estimatedBytes > this.#budget.maxAggregateBytes) return false
    if (this.#sum('triangles') - (existing?.triangles ?? 0) + request.estimatedTriangles > this.#budget.maxAggregateTriangles) return false

    this.#entries.set(key, Object.freeze({ ...request, viewId, layerId, tileKey, phase: 'queued', sequence: existing?.sequence ?? this.#sequence++, bytes: request.estimatedBytes, triangles: request.estimatedTriangles, expiresAt: request.requestedAt + this.#budget.queueTtlMs }))
    this.#revisions.set(revisionKey, request.revision)
    return true
  }

  next(now: number): Readonly<ArcGisSceneTileView> | null {
    this.#active(); finite('now', now); this.expire(now)
    if (this.#countPhase('loading') >= this.#budget.maxLoading) return null
    const entry = [...this.#entries.values()].filter(candidate => candidate.phase === 'queued').sort((a, b) => priority[b.intent] - priority[a.intent] || a.level - b.level || a.sequence - b.sequence)[0]
    if (!entry) return null
    const loading = Object.freeze({ ...entry, phase: 'loading' as const, expiresAt: now + this.#budget.loadLeaseMs })
    this.#entries.set(this.#key(entry.viewId, entry.layerId, entry.tileKey), loading)
    return this.#view(loading)
  }

  complete(viewId: string, layerId: string, tileKey: string, revision: number, now: number, actualBytes: number, actualTriangles: number): boolean {
    this.#active(); integer('revision', revision, 0); finite('now', now); integer('actualBytes', actualBytes, 0); integer('actualTriangles', actualTriangles, 0)
    const key = this.#key(identifier('viewId', viewId), identifier('layerId', layerId), identifier('tileKey', tileKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'loading' || entry.revision !== revision || now > entry.expiresAt) return false
    if (actualBytes > this.#budget.maxBytesPerTile || actualTriangles > this.#budget.maxTrianglesPerTile) return false
    if (this.#countPhase('resident') >= this.#budget.maxResident) return false
    if (this.#sum('bytes') - entry.bytes + actualBytes > this.#budget.maxAggregateBytes) return false
    if (this.#sum('triangles') - entry.triangles + actualTriangles > this.#budget.maxAggregateTriangles) return false
    this.#entries.set(key, Object.freeze({ ...entry, phase: 'resident', bytes: actualBytes, triangles: actualTriangles, expiresAt: now + this.#budget.residentTtlMs }))
    return true
  }

  touch(viewId: string, layerId: string, tileKey: string, revision: number, now: number): boolean {
    this.#active(); integer('revision', revision, 0); finite('now', now)
    const key = this.#key(identifier('viewId', viewId), identifier('layerId', layerId), identifier('tileKey', tileKey))
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'resident' || entry.revision !== revision || now > entry.expiresAt) return false
    this.#entries.set(key, Object.freeze({ ...entry, expiresAt: now + this.#budget.residentTtlMs }))
    return true
  }

  evict(viewId: string, layerId: string, tileKey: string): boolean {
    this.#active()
    return this.#entries.delete(this.#key(identifier('viewId', viewId), identifier('layerId', layerId), identifier('tileKey', tileKey)))
  }

  invalidateLayer(viewId: string, layerId: string, revision: number): number {
    this.#active(); const view = identifier('viewId', viewId); const layer = identifier('layerId', layerId); integer('revision', revision, 0)
    const revisionKey = this.#revisionKey(view, layer)
    const current = this.#revisions.get(revisionKey)
    if (current !== undefined && revision <= current) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.viewId === view && entry.layerId === layer && entry.revision < revision) { this.#entries.delete(key); removed += 1 }
    this.#revisions.set(revisionKey, revision)
    return removed
  }

  releaseLayer(viewId: string, layerId: string): number {
    this.#active(); const view = identifier('viewId', viewId); const layer = identifier('layerId', layerId); let removed = 0
    for (const [key, entry] of this.#entries) if (entry.viewId === view && entry.layerId === layer) { this.#entries.delete(key); removed += 1 }
    this.#revisions.delete(this.#revisionKey(view, layer))
    return removed
  }

  releaseView(viewId: string): number {
    this.#active(); const view = identifier('viewId', viewId); let removed = 0
    for (const [key, entry] of this.#entries) if (entry.viewId === view) { this.#entries.delete(key); removed += 1 }
    for (const key of [...this.#revisions.keys()]) if (key.startsWith(`${view}\u0000`)) this.#revisions.delete(key)
    return removed
  }

  expire(now: number): number {
    this.#active(); finite('now', now); let removed = 0
    for (const [key, entry] of this.#entries) if (now > entry.expiresAt) { this.#entries.delete(key); removed += 1 }
    return removed
  }

  entriesForView(viewId: string): readonly Readonly<ArcGisSceneTileView>[] {
    this.#active(); const view = identifier('viewId', viewId)
    return Object.freeze([...this.#entries.values()].filter(entry => entry.viewId === view).sort((a, b) => a.sequence - b.sequence).map(entry => this.#view(entry)))
  }

  snapshot(): Readonly<{ tiles: number; queued: number; loading: number; resident: number; bytes: number; triangles: number }> {
    this.#active()
    return Object.freeze({ tiles: this.#entries.size, queued: this.#countPhase('queued'), loading: this.#countPhase('loading'), resident: this.#countPhase('resident'), bytes: this.#sum('bytes'), triangles: this.#sum('triangles') })
  }

  fingerprint(): string {
    this.#active()
    return [...this.#entries.values()].sort((a, b) => a.viewId.localeCompare(b.viewId) || a.layerId.localeCompare(b.layerId) || a.tileKey.localeCompare(b.tileKey)).map(entry => [entry.viewId, entry.layerId, entry.tileKey, entry.revision, entry.intent, entry.phase, entry.level, entry.bytes, entry.triangles].join(':')).join('|')
  }

  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }
  #key(viewId: string, layerId: string, tileKey: string): string { return `${viewId}\u0000${layerId}\u0000${tileKey}` }
  #revisionKey(viewId: string, layerId: string): string { return `${viewId}\u0000${layerId}` }
  #countView(viewId: string): number { let total = 0; for (const entry of this.#entries.values()) if (entry.viewId === viewId) total += 1; return total }
  #countPhase(phase: ArcGisSceneTilePhase): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) total += 1; return total }
  #sum(field: 'bytes' | 'triangles'): number { let total = 0; for (const entry of this.#entries.values()) total += entry[field]; return total }
  #view(entry: Entry): Readonly<ArcGisSceneTileView> { return Object.freeze({ viewId: entry.viewId, layerId: entry.layerId, tileKey: entry.tileKey, revision: entry.revision, intent: entry.intent, phase: entry.phase, bytes: entry.bytes, triangles: entry.triangles, level: entry.level, expiresAt: entry.expiresAt }) }
  #active(): void { if (this.#disposed) throw new Error('ArcGisSceneTileLifecyclePolicy is disposed') }
}
