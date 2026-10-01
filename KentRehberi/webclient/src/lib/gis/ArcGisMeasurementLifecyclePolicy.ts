export type ArcGisMeasurementIntent = 'inspect' | 'distance' | 'area' | 'height'
export type ArcGisMeasurementState = 'draft' | 'computing' | 'ready'

export interface ArcGisMeasurementBudget {
  maxViews: number
  maxSessions: number
  maxSessionsPerView: number
  maxComputingSessions: number
  maxReadySessions: number
  maxVerticesPerSession: number
  maxVertices: number
  maxEstimatedBytes: number
  maxEstimatedBytesPerSession: number
  draftTtlMs: number
  computeLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisMeasurementRequest {
  viewId: string
  sessionId: string
  revision: number
  intent: ArcGisMeasurementIntent
  requestedAt: number
  vertexCount: number
  estimatedBytes: number
  spatialReferenceWkid: number
}

export interface ArcGisMeasurementEntry extends ArcGisMeasurementRequest {
  state: ArcGisMeasurementState
  sequence: number
  expiresAt: number
  computeLeaseUntil: number | null
  resultBytes: number
}

export interface ArcGisMeasurementSnapshot {
  views: number
  sessions: number
  draft: number
  computing: number
  ready: number
  vertices: number
  estimatedBytes: number
  resultBytes: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const PRIORITY: Readonly<Record<ArcGisMeasurementIntent, number>> = Object.freeze({ inspect: 0, distance: 1, area: 2, height: 3 })

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}
function finite(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`)
}
function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || normalized.includes('\u0000')) throw new Error(`${name} is invalid`)
  return normalized
}
function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

export class ArcGisMeasurementLifecyclePolicy {
  private readonly entries = new Map<string, ArcGisMeasurementEntry>()
  private readonly revisions = new Map<string, number>()
  private sequence = 0
  private disposed = false

  constructor(private readonly budget: ArcGisMeasurementBudget) {
    integer('maxViews', budget.maxViews, 1)
    integer('maxSessions', budget.maxSessions, 1)
    integer('maxSessionsPerView', budget.maxSessionsPerView, 1)
    integer('maxComputingSessions', budget.maxComputingSessions, 1)
    integer('maxReadySessions', budget.maxReadySessions, 1)
    integer('maxVerticesPerSession', budget.maxVerticesPerSession, 2)
    integer('maxVertices', budget.maxVertices, 2)
    finite('maxEstimatedBytes', budget.maxEstimatedBytes, 1)
    finite('maxEstimatedBytesPerSession', budget.maxEstimatedBytesPerSession, 1)
    finite('draftTtlMs', budget.draftTtlMs, 1)
    finite('computeLeaseMs', budget.computeLeaseMs, 1)
    finite('readyTtlMs', budget.readyTtlMs, 1)
    if (budget.maxSessionsPerView > budget.maxSessions) throw new Error('maxSessionsPerView exceeds maxSessions')
    if (budget.maxComputingSessions > budget.maxSessions) throw new Error('maxComputingSessions exceeds maxSessions')
    if (budget.maxReadySessions > budget.maxSessions) throw new Error('maxReadySessions exceeds maxSessions')
    if (budget.maxVerticesPerSession > budget.maxVertices) throw new Error('maxVerticesPerSession exceeds maxVertices')
    if (budget.maxEstimatedBytesPerSession > budget.maxEstimatedBytes) throw new Error('maxEstimatedBytesPerSession exceeds maxEstimatedBytes')
  }

  admit(input: ArcGisMeasurementRequest): boolean {
    this.assertActive()
    const request = this.normalize(input)
    const watermark = this.revisions.get(request.viewId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark === undefined && this.revisions.size >= this.budget.maxViews) return false
    if (request.vertexCount > this.budget.maxVerticesPerSession || request.estimatedBytes > this.budget.maxEstimatedBytesPerSession) return false

    if (watermark === undefined || request.revision > watermark) this.invalidateView(request.viewId, request.revision)
    const key = this.key(request.viewId, request.sessionId)
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.revision !== request.revision || existing.state !== 'draft') return false
      if (PRIORITY[request.intent] < PRIORITY[existing.intent]) return false
      const deltaVertices = request.vertexCount - existing.vertexCount
      const deltaBytes = request.estimatedBytes - existing.estimatedBytes
      if (this.totalVertices() + deltaVertices > this.budget.maxVertices) return false
      if (this.totalEstimatedBytes() + deltaBytes > this.budget.maxEstimatedBytes) return false
      this.entries.set(key, Object.freeze({ ...request, state: 'draft', sequence: existing.sequence, expiresAt: request.requestedAt + this.budget.draftTtlMs, computeLeaseUntil: null, resultBytes: 0 }))
      return true
    }

    if (this.entries.size >= this.budget.maxSessions) return false
    if (this.entriesForViewInternal(request.viewId).length >= this.budget.maxSessionsPerView) return false
    if (this.totalVertices() + request.vertexCount > this.budget.maxVertices) return false
    if (this.totalEstimatedBytes() + request.estimatedBytes > this.budget.maxEstimatedBytes) return false
    this.sequence += 1
    this.entries.set(key, Object.freeze({ ...request, state: 'draft', sequence: this.sequence, expiresAt: request.requestedAt + this.budget.draftTtlMs, computeLeaseUntil: null, resultBytes: 0 }))
    return true
  }

  begin(viewId: string, sessionId: string, revision: number, now: number): boolean {
    this.assertActive()
    finite('now', now, 0)
    const entry = this.entries.get(this.key(identifier('viewId', viewId), identifier('sessionId', sessionId)))
    if (!entry || entry.revision !== revision || entry.state !== 'draft' || now > entry.expiresAt) return false
    if (this.count('computing') >= this.budget.maxComputingSessions) return false
    this.entries.set(this.key(entry.viewId, entry.sessionId), Object.freeze({ ...entry, state: 'computing', computeLeaseUntil: now + this.budget.computeLeaseMs, expiresAt: now + this.budget.computeLeaseMs }))
    return true
  }

  markReady(viewId: string, sessionId: string, revision: number, now: number, resultBytes: number): boolean {
    this.assertActive()
    finite('now', now, 0)
    finite('resultBytes', resultBytes, 0)
    const key = this.key(identifier('viewId', viewId), identifier('sessionId', sessionId))
    const entry = this.entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'computing' || entry.computeLeaseUntil === null || now > entry.computeLeaseUntil) return false
    if (this.count('ready') >= this.budget.maxReadySessions) return false
    if (resultBytes > this.budget.maxEstimatedBytesPerSession || this.totalResultBytes() + resultBytes > this.budget.maxEstimatedBytes) return false
    this.entries.set(key, Object.freeze({ ...entry, state: 'ready', resultBytes, computeLeaseUntil: null, expiresAt: now + this.budget.readyTtlMs }))
    return true
  }

  nextDraft(): Readonly<ArcGisMeasurementEntry> | null {
    this.assertActive()
    return this.sorted(this.entries.values()).find(entry => entry.state === 'draft') ?? null
  }

  cancel(viewId: string, sessionId: string): boolean {
    this.assertActive()
    return this.entries.delete(this.key(identifier('viewId', viewId), identifier('sessionId', sessionId)))
  }

  consume(viewId: string, sessionId: string, revision: number): boolean {
    this.assertActive()
    const key = this.key(identifier('viewId', viewId), identifier('sessionId', sessionId))
    const entry = this.entries.get(key)
    if (!entry || entry.state !== 'ready' || entry.revision !== revision) return false
    return this.entries.delete(key)
  }

  invalidateView(viewId: string, revision: number): number {
    this.assertActive()
    const normalized = identifier('viewId', viewId)
    integer('revision', revision, 0)
    const current = this.revisions.get(normalized)
    if (current !== undefined && revision <= current) return 0
    if (current === undefined && this.revisions.size >= this.budget.maxViews) return 0
    this.revisions.set(normalized, revision)
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (entry.viewId === normalized && entry.revision < revision) {
        this.entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  expire(now: number): number {
    this.assertActive()
    finite('now', now, 0)
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  entriesForView(viewId: string): readonly Readonly<ArcGisMeasurementEntry>[] {
    this.assertActive()
    return Object.freeze(this.sorted(this.entriesForViewInternal(identifier('viewId', viewId))).map(entry => Object.freeze({ ...entry })))
  }

  snapshot(): Readonly<ArcGisMeasurementSnapshot> {
    this.assertActive()
    const revisionWatermark = Object.freeze(Object.fromEntries([...this.revisions.entries()].sort(([a], [b]) => a.localeCompare(b))))
    const ordered = this.sorted(this.entries.values())
    const fingerprint = hash(ordered.map(entry => `${entry.viewId}|${entry.sessionId}|${entry.revision}|${entry.intent}|${entry.state}|${entry.vertexCount}|${entry.estimatedBytes}|${entry.resultBytes}`).join('\n'))
    return Object.freeze({ views: this.revisions.size, sessions: this.entries.size, draft: this.count('draft'), computing: this.count('computing'), ready: this.count('ready'), vertices: this.totalVertices(), estimatedBytes: this.totalEstimatedBytes(), resultBytes: this.totalResultBytes(), revisionWatermark, fingerprint })
  }

  dispose(): void {
    if (this.disposed) return
    this.entries.clear()
    this.revisions.clear()
    this.disposed = true
  }

  private normalize(input: ArcGisMeasurementRequest): ArcGisMeasurementRequest {
    const viewId = identifier('viewId', input.viewId)
    const sessionId = identifier('sessionId', input.sessionId)
    integer('revision', input.revision, 0)
    finite('requestedAt', input.requestedAt, 0)
    integer('vertexCount', input.vertexCount, 2)
    finite('estimatedBytes', input.estimatedBytes, 0)
    integer('spatialReferenceWkid', input.spatialReferenceWkid, 1)
    return { ...input, viewId, sessionId }
  }
  private key(viewId: string, sessionId: string): string { return `${viewId}\u0001${sessionId}` }
  private count(state: ArcGisMeasurementState): number { let count = 0; for (const entry of this.entries.values()) if (entry.state === state) count += 1; return count }
  private totalVertices(): number { let total = 0; for (const entry of this.entries.values()) total += entry.vertexCount; return total }
  private totalEstimatedBytes(): number { let total = 0; for (const entry of this.entries.values()) total += entry.estimatedBytes; return total }
  private totalResultBytes(): number { let total = 0; for (const entry of this.entries.values()) total += entry.resultBytes; return total }
  private entriesForViewInternal(viewId: string): ArcGisMeasurementEntry[] { return [...this.entries.values()].filter(entry => entry.viewId === viewId) }
  private sorted(values: Iterable<ArcGisMeasurementEntry>): ArcGisMeasurementEntry[] {
    return [...values].sort((a, b) => PRIORITY[b.intent] - PRIORITY[a.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence || a.sessionId.localeCompare(b.sessionId))
  }
  private assertActive(): void { if (this.disposed) throw new Error('ArcGisMeasurementLifecyclePolicy is disposed') }
}
