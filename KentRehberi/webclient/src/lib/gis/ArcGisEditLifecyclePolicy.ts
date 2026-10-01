export type ArcGisEditIntent = 'commit' | 'update' | 'create' | 'delete'
export type ArcGisEditState = 'queued' | 'running' | 'ready'

export interface ArcGisEditBudget {
  maxLayers: number
  maxSessions: number
  maxRunning: number
  maxVerticesPerSession: number
  maxBytesPerSession: number
  maxTotalVertices: number
  maxTotalBytes: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisEditRequest {
  id: string
  layerId: string
  revision: number
  intent: ArcGisEditIntent
  objectId?: number
  vertexCount: number
  estimatedBytes: number
  wkid: number
}

export interface ArcGisEditSnapshot extends ArcGisEditRequest {
  state: ArcGisEditState
  createdAt: number
  startedAt?: number
  readyAt?: number
  token: number
}

const priority: Record<ArcGisEditIntent, number> = { commit: 0, delete: 1, update: 2, create: 3 }
const integer = (value: number, name: string, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`invalid ${name}`)
}
const id = (value: string, name: string) => {
  const normalized = value.trim()
  if (!normalized || normalized.length > 160) throw new Error(`invalid ${name}`)
  return normalized
}
const positive = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid ${name}`)
}

/**
 * Payload-free admission and lifecycle policy for ArcGIS feature editing.
 * Geometry, Graphic, FeatureSet and applyEdits response objects deliberately never
 * enter this registry; callers retain those objects only for the SDK operation.
 */
export class ArcGisEditLifecyclePolicy {
  private readonly sessions = new Map<string, ArcGisEditSnapshot>()
  private readonly layerRevision = new Map<string, number>()
  private sequence = 0
  private disposed = false

  constructor(private readonly budget: ArcGisEditBudget) {
    for (const [key, value] of Object.entries(budget)) positive(value, key)
    integer(budget.maxLayers, 'maxLayers', 1)
    integer(budget.maxSessions, 'maxSessions', 1)
    integer(budget.maxRunning, 'maxRunning', 1)
  }

  setLayerRevision(layerId: string, revision: number): void {
    this.assertActive()
    const layer = id(layerId, 'layerId')
    integer(revision, 'revision')
    const previous = this.layerRevision.get(layer)
    this.layerRevision.set(layer, revision)
    if (previous !== undefined && previous !== revision) {
      for (const [key, session] of this.sessions) if (session.layerId === layer) this.sessions.delete(key)
    }
    if (this.layerRevision.size > this.budget.maxLayers) {
      this.layerRevision.delete(layer)
      throw new Error('edit layer budget exceeded')
    }
  }

  enqueue(request: ArcGisEditRequest, now: number): Readonly<ArcGisEditSnapshot> {
    this.assertActive(); this.expire(now); integer(now, 'now')
    const normalized = this.validate(request)
    if (this.sessions.has(normalized.id)) throw new Error('duplicate edit session')
    if (this.sessions.size >= this.budget.maxSessions) throw new Error('edit session budget exceeded')
    this.assertAggregate(normalized.vertexCount, normalized.estimatedBytes)
    const snapshot: ArcGisEditSnapshot = { ...normalized, state: 'queued', createdAt: now, token: ++this.sequence }
    this.sessions.set(snapshot.id, snapshot)
    return Object.freeze({ ...snapshot })
  }

  next(now: number): Readonly<ArcGisEditSnapshot> | undefined {
    this.assertActive(); this.expire(now)
    if ([...this.sessions.values()].filter(x => x.state === 'running').length >= this.budget.maxRunning) return undefined
    const queued = [...this.sessions.values()].filter(x => x.state === 'queued').sort((a, b) =>
      priority[a.intent] - priority[b.intent] || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const selected = queued[0]
    if (!selected) return undefined
    const running = { ...selected, state: 'running' as const, startedAt: now, token: ++this.sequence }
    this.sessions.set(running.id, running)
    return Object.freeze({ ...running })
  }

  complete(sessionId: string, token: number, now: number): Readonly<ArcGisEditSnapshot> {
    this.assertActive(); this.expire(now)
    const key = id(sessionId, 'sessionId'); integer(token, 'token', 1)
    const current = this.sessions.get(key)
    if (!current || current.state !== 'running' || current.token !== token) throw new Error('stale edit completion')
    if (this.layerRevision.get(current.layerId) !== current.revision) {
      this.sessions.delete(key); throw new Error('stale edit revision')
    }
    const ready = { ...current, state: 'ready' as const, readyAt: now, token: ++this.sequence }
    this.sessions.set(key, ready)
    return Object.freeze({ ...ready })
  }

  consume(sessionId: string, token: number): void {
    this.assertActive()
    const key = id(sessionId, 'sessionId'); integer(token, 'token', 1)
    const current = this.sessions.get(key)
    if (!current || current.state !== 'ready' || current.token !== token) throw new Error('stale edit consume')
    this.sessions.delete(key)
  }

  cancel(sessionId: string): boolean {
    this.assertActive(); return this.sessions.delete(id(sessionId, 'sessionId'))
  }

  expire(now: number): number {
    this.assertActive(); integer(now, 'now')
    let removed = 0
    for (const [key, value] of this.sessions) {
      const deadline = value.state === 'queued' ? value.createdAt + this.budget.queueTtlMs
        : value.state === 'running' ? (value.startedAt ?? value.createdAt) + this.budget.runLeaseMs
        : (value.readyAt ?? value.createdAt) + this.budget.readyTtlMs
      if (now >= deadline) { this.sessions.delete(key); removed++ }
    }
    return removed
  }

  snapshot(): readonly Readonly<ArcGisEditSnapshot>[] {
    this.assertActive()
    return [...this.sessions.values()].sort((a, b) => a.id.localeCompare(b.id)).map(x => Object.freeze({ ...x }))
  }

  fingerprint(): string {
    this.assertActive()
    return this.snapshot().map(x => `${x.id}:${x.layerId}:${x.revision}:${x.intent}:${x.state}:${x.vertexCount}:${x.estimatedBytes}`).join('|')
  }

  dispose(): void { this.sessions.clear(); this.layerRevision.clear(); this.disposed = true }

  private validate(request: ArcGisEditRequest): ArcGisEditRequest {
    const normalized = { ...request, id: id(request.id, 'id'), layerId: id(request.layerId, 'layerId') }
    integer(normalized.revision, 'revision'); integer(normalized.vertexCount, 'vertexCount'); integer(normalized.estimatedBytes, 'estimatedBytes')
    integer(normalized.wkid, 'wkid', 1)
    if (normalized.objectId !== undefined) integer(normalized.objectId, 'objectId', 0)
    if (normalized.vertexCount > this.budget.maxVerticesPerSession) throw new Error('edit vertex budget exceeded')
    if (normalized.estimatedBytes > this.budget.maxBytesPerSession) throw new Error('edit byte budget exceeded')
    if (this.layerRevision.get(normalized.layerId) !== normalized.revision) throw new Error('stale edit request')
    return normalized
  }

  private assertAggregate(vertices: number, bytes: number): void {
    let totalVertices = vertices, totalBytes = bytes
    for (const value of this.sessions.values()) { totalVertices += value.vertexCount; totalBytes += value.estimatedBytes }
    if (totalVertices > this.budget.maxTotalVertices) throw new Error('aggregate edit vertex budget exceeded')
    if (totalBytes > this.budget.maxTotalBytes) throw new Error('aggregate edit byte budget exceeded')
  }

  private assertActive(): void { if (this.disposed) throw new Error('edit lifecycle policy disposed') }
}
