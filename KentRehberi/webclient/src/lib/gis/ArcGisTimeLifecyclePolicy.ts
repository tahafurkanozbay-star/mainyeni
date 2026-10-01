export type ArcGisTimeIntent = 'prefetch' | 'playback' | 'scrub' | 'commit'
export type ArcGisTimeState = 'queued' | 'running' | 'ready'

export interface ArcGisTimeBudget {
  maxViews: number
  maxRequests: number
  maxRequestsPerView: number
  maxRunning: number
  maxReady: number
  maxLayersPerRequest: number
  maxLayers: number
  maxEstimatedBytes: number
  maxEstimatedBytesPerRequest: number
  queueTtlMs: number
  runLeaseMs: number
  readyTtlMs: number
}

export interface ArcGisTimeRequest {
  viewId: string
  requestId: string
  revision: number
  intent: ArcGisTimeIntent
  requestedAt: number
  startEpochMs: number
  endEpochMs: number
  layerCount: number
  estimatedBytes: number
}

export interface ArcGisTimeEntry extends ArcGisTimeRequest {
  state: ArcGisTimeState
  sequence: number
  expiresAt: number
  leaseUntil: number | null
  resultBytes: number
}

export interface ArcGisTimeSnapshot {
  views: number
  requests: number
  queued: number
  running: number
  ready: number
  layers: number
  estimatedBytes: number
  resultBytes: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

const PRIORITY: Readonly<Record<ArcGisTimeIntent, number>> = Object.freeze({ prefetch: 0, playback: 1, scrub: 2, commit: 3 })

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

/**
 * Payload-free temporal request admission for ArcGIS time sliders and time-aware layers.
 * SDK objects, features and response payloads deliberately remain outside this policy.
 */
export class ArcGisTimeLifecyclePolicy {
  private readonly entries = new Map<string, ArcGisTimeEntry>()
  private readonly revisions = new Map<string, number>()
  private sequence = 0
  private disposed = false

  constructor(private readonly budget: ArcGisTimeBudget) {
    integer('maxViews', budget.maxViews, 1)
    integer('maxRequests', budget.maxRequests, 1)
    integer('maxRequestsPerView', budget.maxRequestsPerView, 1)
    integer('maxRunning', budget.maxRunning, 1)
    integer('maxReady', budget.maxReady, 1)
    integer('maxLayersPerRequest', budget.maxLayersPerRequest, 1)
    integer('maxLayers', budget.maxLayers, 1)
    finite('maxEstimatedBytes', budget.maxEstimatedBytes, 1)
    finite('maxEstimatedBytesPerRequest', budget.maxEstimatedBytesPerRequest, 1)
    finite('queueTtlMs', budget.queueTtlMs, 1)
    finite('runLeaseMs', budget.runLeaseMs, 1)
    finite('readyTtlMs', budget.readyTtlMs, 1)
    if (budget.maxRequestsPerView > budget.maxRequests) throw new Error('maxRequestsPerView exceeds maxRequests')
    if (budget.maxRunning > budget.maxRequests || budget.maxReady > budget.maxRequests) throw new Error('state limit exceeds maxRequests')
    if (budget.maxLayersPerRequest > budget.maxLayers) throw new Error('maxLayersPerRequest exceeds maxLayers')
    if (budget.maxEstimatedBytesPerRequest > budget.maxEstimatedBytes) throw new Error('maxEstimatedBytesPerRequest exceeds maxEstimatedBytes')
  }

  admit(input: ArcGisTimeRequest): boolean {
    this.assertActive()
    const request = this.normalize(input)
    const watermark = this.revisions.get(request.viewId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark === undefined && this.revisions.size >= this.budget.maxViews) return false
    if (request.layerCount > this.budget.maxLayersPerRequest || request.estimatedBytes > this.budget.maxEstimatedBytesPerRequest) return false
    if (watermark === undefined || request.revision > watermark) this.invalidateView(request.viewId, request.revision)

    const key = this.key(request.viewId, request.requestId)
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.revision !== request.revision || existing.state !== 'queued') return false
      if (PRIORITY[request.intent] < PRIORITY[existing.intent]) return false
      if (this.totalLayers() - existing.layerCount + request.layerCount > this.budget.maxLayers) return false
      if (this.totalEstimatedBytes() - existing.estimatedBytes + request.estimatedBytes > this.budget.maxEstimatedBytes) return false
      this.entries.set(key, Object.freeze({ ...request, state: 'queued', sequence: existing.sequence, expiresAt: request.requestedAt + this.budget.queueTtlMs, leaseUntil: null, resultBytes: 0 }))
      return true
    }

    if (this.entries.size >= this.budget.maxRequests) return false
    if (this.entriesForViewInternal(request.viewId).length >= this.budget.maxRequestsPerView) return false
    if (this.totalLayers() + request.layerCount > this.budget.maxLayers) return false
    if (this.totalEstimatedBytes() + request.estimatedBytes > this.budget.maxEstimatedBytes) return false
    this.sequence += 1
    this.entries.set(key, Object.freeze({ ...request, state: 'queued', sequence: this.sequence, expiresAt: request.requestedAt + this.budget.queueTtlMs, leaseUntil: null, resultBytes: 0 }))
    return true
  }

  begin(viewId: string, requestId: string, revision: number, now: number): boolean {
    this.assertActive()
    finite('now', now, 0)
    const key = this.key(identifier('viewId', viewId), identifier('requestId', requestId))
    const entry = this.entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'queued' || now > entry.expiresAt) return false
    if (this.count('running') >= this.budget.maxRunning) return false
    this.entries.set(key, Object.freeze({ ...entry, state: 'running', leaseUntil: now + this.budget.runLeaseMs, expiresAt: now + this.budget.runLeaseMs }))
    return true
  }

  markReady(viewId: string, requestId: string, revision: number, now: number, resultBytes: number): boolean {
    this.assertActive()
    finite('now', now, 0)
    finite('resultBytes', resultBytes, 0)
    const key = this.key(identifier('viewId', viewId), identifier('requestId', requestId))
    const entry = this.entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'running' || entry.leaseUntil === null || now > entry.leaseUntil) return false
    if (this.count('ready') >= this.budget.maxReady) return false
    if (resultBytes > this.budget.maxEstimatedBytesPerRequest || this.totalResultBytes() + resultBytes > this.budget.maxEstimatedBytes) return false
    this.entries.set(key, Object.freeze({ ...entry, state: 'ready', leaseUntil: null, expiresAt: now + this.budget.readyTtlMs, resultBytes }))
    return true
  }

  nextQueued(): Readonly<ArcGisTimeEntry> | null {
    this.assertActive()
    return this.sorted(this.entries.values()).find(entry => entry.state === 'queued') ?? null
  }

  consume(viewId: string, requestId: string, revision: number): boolean {
    this.assertActive()
    const key = this.key(identifier('viewId', viewId), identifier('requestId', requestId))
    const entry = this.entries.get(key)
    if (!entry || entry.revision !== revision || entry.state !== 'ready') return false
    return this.entries.delete(key)
  }

  cancel(viewId: string, requestId: string): boolean {
    this.assertActive()
    return this.entries.delete(this.key(identifier('viewId', viewId), identifier('requestId', requestId)))
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

  entriesForView(viewId: string): readonly Readonly<ArcGisTimeEntry>[] {
    this.assertActive()
    return Object.freeze(this.sorted(this.entriesForViewInternal(identifier('viewId', viewId))).map(entry => Object.freeze({ ...entry })))
  }

  snapshot(): Readonly<ArcGisTimeSnapshot> {
    this.assertActive()
    const revisionWatermark = Object.freeze(Object.fromEntries([...this.revisions.entries()].sort(([a], [b]) => a.localeCompare(b))))
    const ordered = this.sorted(this.entries.values())
    const fingerprint = hash(ordered.map(entry => `${entry.viewId}|${entry.requestId}|${entry.revision}|${entry.intent}|${entry.state}|${entry.startEpochMs}|${entry.endEpochMs}|${entry.layerCount}|${entry.estimatedBytes}|${entry.resultBytes}`).join('\n'))
    return Object.freeze({ views: this.revisions.size, requests: this.entries.size, queued: this.count('queued'), running: this.count('running'), ready: this.count('ready'), layers: this.totalLayers(), estimatedBytes: this.totalEstimatedBytes(), resultBytes: this.totalResultBytes(), revisionWatermark, fingerprint })
  }

  dispose(): void {
    if (this.disposed) return
    this.entries.clear()
    this.revisions.clear()
    this.disposed = true
  }

  private normalize(input: ArcGisTimeRequest): ArcGisTimeRequest {
    const viewId = identifier('viewId', input.viewId)
    const requestId = identifier('requestId', input.requestId)
    integer('revision', input.revision, 0)
    finite('requestedAt', input.requestedAt, 0)
    finite('startEpochMs', input.startEpochMs, 0)
    finite('endEpochMs', input.endEpochMs, 0)
    if (input.endEpochMs < input.startEpochMs) throw new Error('endEpochMs precedes startEpochMs')
    integer('layerCount', input.layerCount, 1)
    finite('estimatedBytes', input.estimatedBytes, 0)
    return { ...input, viewId, requestId }
  }
  private key(viewId: string, requestId: string): string { return `${viewId}\u0001${requestId}` }
  private count(state: ArcGisTimeState): number { let total = 0; for (const entry of this.entries.values()) if (entry.state === state) total += 1; return total }
  private totalLayers(): number { let total = 0; for (const entry of this.entries.values()) total += entry.layerCount; return total }
  private totalEstimatedBytes(): number { let total = 0; for (const entry of this.entries.values()) total += entry.estimatedBytes; return total }
  private totalResultBytes(): number { let total = 0; for (const entry of this.entries.values()) total += entry.resultBytes; return total }
  private entriesForViewInternal(viewId: string): ArcGisTimeEntry[] { return [...this.entries.values()].filter(entry => entry.viewId === viewId) }
  private sorted(values: Iterable<ArcGisTimeEntry>): ArcGisTimeEntry[] {
    return [...values].sort((a, b) => PRIORITY[b.intent] - PRIORITY[a.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence || a.requestId.localeCompare(b.requestId))
  }
  private assertActive(): void { if (this.disposed) throw new Error('ArcGisTimeLifecyclePolicy is disposed') }
}
