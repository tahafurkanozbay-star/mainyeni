export type SketchIntent = 'interactive' | 'visible' | 'background'
export type SketchGeometryKind = 'point' | 'polyline' | 'polygon'
export type SketchPhase = 'queued' | 'active' | 'resident'

export interface SketchSessionBudget {
  maxViews: number
  maxSessions: number
  maxSessionsPerView: number
  maxActive: number
  maxActivePerView: number
  maxResident: number
  maxResidentPerView: number
  maxVerticesPerSession: number
  maxBytesPerSession: number
  maxResidentVertices: number
  maxResidentBytes: number
  queueTtlMs: number
  activeLeaseMs: number
  residentTtlMs: number
}

export interface SketchSessionRequest {
  sessionId: string
  viewId: string
  revision: number
  intent: SketchIntent
  geometryKind: SketchGeometryKind
  vertexCount: number
  estimatedBytes: number
  requestedAt: number
}

export interface SketchSessionView {
  readonly sessionId: string
  readonly viewId: string
  readonly revision: number
  readonly intent: SketchIntent
  readonly geometryKind: SketchGeometryKind
  readonly phase: SketchPhase
  readonly vertexCount: number
  readonly bytes: number
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Entry extends SketchSessionRequest {
  phase: SketchPhase
  bytes: number
  sequence: number
  touchedAt: number
  expiresAt: number
}

const rank: Readonly<Record<SketchIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })

function safeId(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f]/.test(normalized)) throw new Error(`${name} must contain 1..192 safe characters`)
  return normalized
}

function integer(name: string, value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}

function finite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

/**
 * Payload-free authority for ArcGIS SketchViewModel style work.
 * Geometry, Graphic, symbol, attributes, pointer events and credentials remain
 * caller-owned. Only bounded scalar accounting metadata is retained.
 */
export class ArcGisSketchSessionLifecyclePolicy {
  readonly #budget: Readonly<SketchSessionBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: SketchSessionBudget) {
    for (const key of ['maxViews', 'maxSessions', 'maxSessionsPerView', 'maxActive', 'maxActivePerView', 'maxResident', 'maxResidentPerView', 'maxVerticesPerSession', 'maxBytesPerSession', 'maxResidentVertices', 'maxResidentBytes'] as const) integer(key, budget[key], 1)
    for (const key of ['queueTtlMs', 'activeLeaseMs', 'residentTtlMs'] as const) finite(key, budget[key])
    if (budget.maxSessionsPerView > budget.maxSessions) throw new Error('maxSessionsPerView cannot exceed maxSessions')
    if (budget.maxActivePerView > budget.maxActive) throw new Error('maxActivePerView cannot exceed maxActive')
    if (budget.maxResidentPerView > budget.maxResident) throw new Error('maxResidentPerView cannot exceed maxResident')
    if (budget.maxVerticesPerSession > budget.maxResidentVertices) throw new Error('vertex budgets are inconsistent')
    if (budget.maxBytesPerSession > budget.maxResidentBytes) throw new Error('byte budgets are inconsistent')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(viewId: string, revision: number): number {
    this.#active()
    const view = safeId('viewId', viewId)
    integer('revision', revision)
    const current = this.#revisions.get(view)
    if (current === undefined && this.#revisions.size >= this.#budget.maxViews) return -1
    if (current !== undefined && revision < current) return -1
    if (current === revision) return 0
    let removed = 0
    for (const [id, entry] of this.#entries) {
      if (entry.viewId === view && entry.revision < revision) {
        this.#entries.delete(id)
        removed += 1
      }
    }
    this.#revisions.set(view, revision)
    return removed
  }

  admit(request: SketchSessionRequest): boolean {
    this.#active()
    const sessionId = safeId('sessionId', request.sessionId)
    const viewId = safeId('viewId', request.viewId)
    integer('revision', request.revision)
    integer('vertexCount', request.vertexCount)
    integer('estimatedBytes', request.estimatedBytes)
    finite('requestedAt', request.requestedAt)
    if (!(request.intent in rank) || !['point', 'polyline', 'polygon'].includes(request.geometryKind)) return false
    if (request.vertexCount > this.#budget.maxVerticesPerSession || request.estimatedBytes > this.#budget.maxBytesPerSession) return false
    if (this.#revisions.get(viewId) !== request.revision || this.#entries.has(sessionId)) return false
    if (this.#entries.size >= this.#budget.maxSessions || this.#countView(viewId) >= this.#budget.maxSessionsPerView) return false
    this.#entries.set(sessionId, Object.freeze({ ...request, sessionId, viewId, phase: 'queued', bytes: request.estimatedBytes, sequence: this.#sequence++, touchedAt: request.requestedAt, expiresAt: request.requestedAt + this.#budget.queueTtlMs }))
    return true
  }

  startNext(now: number): Readonly<SketchSessionView> | null {
    this.#active(); finite('now', now); this.expire(now)
    if (this.#countPhase('active') >= this.#budget.maxActive) return null
    const entry = [...this.#entries.values()]
      .filter(candidate => candidate.phase === 'queued' && this.#countViewPhase(candidate.viewId, 'active') < this.#budget.maxActivePerView)
      .sort((a, b) => rank[b.intent] - rank[a.intent] || a.sequence - b.sequence || a.sessionId.localeCompare(b.sessionId))[0]
    if (!entry) return null
    const active: Entry = Object.freeze({ ...entry, phase: 'active', touchedAt: now, expiresAt: now + this.#budget.activeLeaseMs })
    this.#entries.set(entry.sessionId, active)
    return this.#view(active)
  }

  complete(sessionId: string, revision: number, vertexCount: number, bytes: number, now: number): boolean {
    this.#active(); const id = safeId('sessionId', sessionId); integer('revision', revision); integer('vertexCount', vertexCount); integer('bytes', bytes); finite('now', now)
    this.expire(now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'active' || entry.revision !== revision || this.#revisions.get(entry.viewId) !== revision) return false
    if (vertexCount > this.#budget.maxVerticesPerSession || bytes > this.#budget.maxBytesPerSession) { this.#entries.delete(id); return false }
    this.#evictFor(entry.viewId, vertexCount, bytes)
    if (this.#countPhase('resident') >= this.#budget.maxResident || this.#countViewPhase(entry.viewId, 'resident') >= this.#budget.maxResidentPerView) return false
    if (this.#residentVertices() + vertexCount > this.#budget.maxResidentVertices || this.#residentBytes() + bytes > this.#budget.maxResidentBytes) return false
    this.#entries.set(id, Object.freeze({ ...entry, phase: 'resident', vertexCount, bytes, touchedAt: now, expiresAt: now + this.#budget.residentTtlMs }))
    return true
  }

  touch(sessionId: string, now: number): boolean {
    this.#active(); const id = safeId('sessionId', sessionId); finite('now', now); this.expire(now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'resident') return false
    this.#entries.set(id, Object.freeze({ ...entry, touchedAt: now, expiresAt: now + this.#budget.residentTtlMs }))
    return true
  }

  consume(sessionId: string, revision: number): Readonly<SketchSessionView> | null {
    this.#active(); const id = safeId('sessionId', sessionId); integer('revision', revision)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'resident' || entry.revision !== revision) return null
    this.#entries.delete(id)
    return this.#view(entry)
  }

  cancel(sessionId: string): boolean {
    this.#active(); return this.#entries.delete(safeId('sessionId', sessionId))
  }

  releaseView(viewId: string): number {
    this.#active(); const view = safeId('viewId', viewId); let removed = 0
    for (const [id, entry] of this.#entries) if (entry.viewId === view) { this.#entries.delete(id); removed += 1 }
    this.#revisions.delete(view)
    return removed
  }

  expire(now: number): number {
    this.#active(); finite('now', now); let removed = 0
    for (const [id, entry] of this.#entries) if (now >= entry.expiresAt) { this.#entries.delete(id); removed += 1 }
    return removed
  }

  snapshot(): Readonly<{ views: number; sessions: number; queued: number; active: number; resident: number; residentVertices: number; residentBytes: number }> {
    this.#active()
    return Object.freeze({ views: this.#revisions.size, sessions: this.#entries.size, queued: this.#countPhase('queued'), active: this.#countPhase('active'), resident: this.#countPhase('resident'), residentVertices: this.#residentVertices(), residentBytes: this.#residentBytes() })
  }

  fingerprint(): string {
    this.#active()
    return [...this.#entries.values()].sort((a, b) => a.viewId.localeCompare(b.viewId) || a.sessionId.localeCompare(b.sessionId)).map(entry => [entry.viewId, entry.sessionId, entry.revision, entry.intent, entry.geometryKind, entry.phase, entry.vertexCount, entry.bytes].join(':')).join('|')
  }

  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }

  #evictFor(viewId: string, vertices: number, bytes: number): void {
    const candidates = [...this.#entries.values()].filter(entry => entry.phase === 'resident').sort((a, b) => rank[a.intent] - rank[b.intent] || a.touchedAt - b.touchedAt || a.sequence - b.sequence)
    for (const entry of candidates) {
      const globalPressure = this.#countPhase('resident') >= this.#budget.maxResident || this.#residentVertices() + vertices > this.#budget.maxResidentVertices || this.#residentBytes() + bytes > this.#budget.maxResidentBytes
      const viewPressure = this.#countViewPhase(viewId, 'resident') >= this.#budget.maxResidentPerView
      if (!globalPressure && !viewPressure) break
      if (viewPressure && entry.viewId !== viewId && !globalPressure) continue
      this.#entries.delete(entry.sessionId)
    }
  }

  #countView(viewId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.viewId === viewId) count += 1; return count }
  #countPhase(phase: SketchPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count += 1; return count }
  #countViewPhase(viewId: string, phase: SketchPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.viewId === viewId && entry.phase === phase) count += 1; return count }
  #residentVertices(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'resident') total += entry.vertexCount; return total }
  #residentBytes(): number { let total = 0; for (const entry of this.#entries.values()) if (entry.phase === 'resident') total += entry.bytes; return total }
  #view(entry: Entry): Readonly<SketchSessionView> { return Object.freeze({ sessionId: entry.sessionId, viewId: entry.viewId, revision: entry.revision, intent: entry.intent, geometryKind: entry.geometryKind, phase: entry.phase, vertexCount: entry.vertexCount, bytes: entry.bytes, sequence: entry.sequence, touchedAt: entry.touchedAt, expiresAt: entry.expiresAt }) }
  #active(): void { if (this.#disposed) throw new Error('ArcGisSketchSessionLifecyclePolicy is disposed') }
}
