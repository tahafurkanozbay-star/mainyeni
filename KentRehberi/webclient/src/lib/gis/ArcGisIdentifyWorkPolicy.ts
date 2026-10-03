export type ArcGisIdentifyIntent = 'interactive' | 'foreground' | 'background'

export interface ArcGisIdentifyWorkBudget {
  maxQueued: number
  maxQueuedPerView: number
  maxRunning: number
  maxRunningPerView: number
  maxLayersPerRequest: number
  maxTolerancePixels: number
  maxResponseBytes: number
  maxAggregateResponseBytes: number
  queueTtlMs: number
  runTtlMs: number
  maxViews: number
}

export interface ArcGisIdentifyWorkInput {
  requestId: string
  viewId: string
  revision: number
  intent: ArcGisIdentifyIntent
  layerCount: number
  tolerancePixels: number
  queuedAt: number
}

export interface ArcGisIdentifyWorkSnapshot extends ArcGisIdentifyWorkInput {
  state: 'queued' | 'running'
  sequence: number
  startedAt?: number
}

export interface ArcGisIdentifyCompletion {
  requestId: string
  viewId: string
  revision: number
  responseBytes: number
  completedAt: number
}

export interface ArcGisIdentifyDiagnostics {
  queued: number
  running: number
  residentResponseBytes: number
  rejected: number
  expired: number
  cancelled: number
  staleCompletions: number
}

type Work = ArcGisIdentifyWorkSnapshot

const INTENT_RANK: Record<ArcGisIdentifyIntent, number> = { interactive: 0, foreground: 1, background: 2 }
const KEY_SEPARATOR = '\u0000'

/** Bounded, payload-free admission authority for ArcGIS REST identify work. */
export class ArcGisIdentifyWorkPolicy {
  private readonly work = new Map<string, Work>()
  private readonly viewRevisions = new Map<string, number>()
  private readonly residentBytes = new Map<string, number>()
  private sequence = 0
  private rejected = 0
  private expired = 0
  private cancelled = 0
  private staleCompletions = 0
  private disposed = false

  constructor(private readonly budget: ArcGisIdentifyWorkBudget) {
    this.assertPositive(budget.maxQueued, 'maxQueued')
    this.assertPositive(budget.maxQueuedPerView, 'maxQueuedPerView')
    this.assertPositive(budget.maxRunning, 'maxRunning')
    this.assertPositive(budget.maxRunningPerView, 'maxRunningPerView')
    this.assertPositive(budget.maxLayersPerRequest, 'maxLayersPerRequest')
    this.assertPositive(budget.maxTolerancePixels, 'maxTolerancePixels')
    this.assertPositive(budget.maxResponseBytes, 'maxResponseBytes')
    this.assertPositive(budget.maxAggregateResponseBytes, 'maxAggregateResponseBytes')
    this.assertPositive(budget.queueTtlMs, 'queueTtlMs')
    this.assertPositive(budget.runTtlMs, 'runTtlMs')
    this.assertPositive(budget.maxViews, 'maxViews')
    if (budget.maxQueuedPerView > budget.maxQueued) throw new RangeError('per-view queue exceeds global queue')
    if (budget.maxRunningPerView > budget.maxRunning) throw new RangeError('per-view running exceeds global running')
    if (budget.maxResponseBytes > budget.maxAggregateResponseBytes) throw new RangeError('response bytes exceed aggregate bytes')
  }

  admit(input: ArcGisIdentifyWorkInput): boolean {
    this.assertActive()
    const item = this.normalize(input)
    this.expire(item.queuedAt)
    const watermark = this.viewRevisions.get(item.viewId) ?? 0
    if (item.revision < watermark) return this.reject()
    const key = this.key(item.viewId, item.requestId)
    if (this.work.has(key)) return this.reject()
    if (item.layerCount > this.budget.maxLayersPerRequest || item.tolerancePixels > this.budget.maxTolerancePixels) return this.reject()
    if (!this.viewRevisions.has(item.viewId) && this.viewRevisions.size >= this.budget.maxViews) return this.reject()
    if (item.revision > watermark) this.advanceRevision(item.viewId, item.revision)
    if (this.count('queued') >= this.budget.maxQueued || this.count('queued', item.viewId) >= this.budget.maxQueuedPerView) return this.reject()
    this.viewRevisions.set(item.viewId, Math.max(watermark, item.revision))
    this.work.set(key, { ...item, state: 'queued', sequence: this.sequence++ })
    return true
  }

  startNext(now: number): ArcGisIdentifyWorkSnapshot | undefined {
    this.assertActive()
    this.assertTimestamp(now)
    this.expire(now)
    if (this.count('running') >= this.budget.maxRunning) return undefined
    const next = [...this.work.values()]
      .filter((item) => item.state === 'queued' && this.count('running', item.viewId) < this.budget.maxRunningPerView)
      .sort((a, b) => INTENT_RANK[a.intent] - INTENT_RANK[b.intent] || a.queuedAt - b.queuedAt || a.sequence - b.sequence)[0]
    if (!next) return undefined
    next.state = 'running'
    next.startedAt = now
    return this.detach(next)
  }

  complete(input: ArcGisIdentifyCompletion): boolean {
    this.assertActive()
    const viewId = this.assertId(input.viewId, 'viewId')
    const requestId = this.assertId(input.requestId, 'requestId')
    this.assertPositive(input.revision, 'revision')
    this.assertNonNegative(input.responseBytes, 'responseBytes')
    this.assertTimestamp(input.completedAt)
    const key = this.key(viewId, requestId)
    const item = this.work.get(key)
    const watermark = this.viewRevisions.get(viewId) ?? 0
    if (!item || item.state !== 'running' || item.revision !== input.revision || input.revision < watermark) {
      this.staleCompletions++
      return false
    }
    if (item.startedAt === undefined || input.completedAt - item.startedAt > this.budget.runTtlMs) {
      this.work.delete(key)
      this.expired++
      return false
    }
    if (input.responseBytes > this.budget.maxResponseBytes || this.totalResidentBytes() + input.responseBytes > this.budget.maxAggregateResponseBytes) {
      this.work.delete(key)
      this.rejected++
      return false
    }
    this.work.delete(key)
    this.residentBytes.set(key, input.responseBytes)
    return true
  }

  releaseResponse(viewId: string, requestId: string): boolean {
    this.assertActive()
    return this.residentBytes.delete(this.key(this.assertId(viewId, 'viewId'), this.assertId(requestId, 'requestId')))
  }

  advanceRevision(viewId: string, revision: number): number {
    this.assertActive()
    const id = this.assertId(viewId, 'viewId')
    this.assertPositive(revision, 'revision')
    const current = this.viewRevisions.get(id) ?? 0
    if (revision <= current) return 0
    this.viewRevisions.set(id, revision)
    let removed = 0
    for (const [key, item] of this.work) if (item.viewId === id && item.revision < revision) {
      this.work.delete(key); this.cancelled++; removed++
    }
    for (const key of [...this.residentBytes.keys()]) if (key.startsWith(`${id}${KEY_SEPARATOR}`)) this.residentBytes.delete(key)
    return removed
  }

  cancelView(viewId: string): number {
    this.assertActive()
    const id = this.assertId(viewId, 'viewId')
    let removed = 0
    for (const [key, item] of this.work) if (item.viewId === id) {
      this.work.delete(key); this.cancelled++; removed++
    }
    for (const key of [...this.residentBytes.keys()]) if (key.startsWith(`${id}${KEY_SEPARATOR}`)) this.residentBytes.delete(key)
    this.viewRevisions.delete(id)
    return removed
  }

  cancelRequest(viewId: string, requestId: string): boolean {
    this.assertActive()
    const key = this.key(this.assertId(viewId, 'viewId'), this.assertId(requestId, 'requestId'))
    const removed = this.work.delete(key)
    if (removed) this.cancelled++
    this.residentBytes.delete(key)
    return removed
  }

  expire(now: number): number {
    this.assertActive()
    this.assertTimestamp(now)
    let removed = 0
    for (const [key, item] of this.work) {
      const deadline = item.state === 'queued' ? item.queuedAt + this.budget.queueTtlMs : (item.startedAt ?? item.queuedAt) + this.budget.runTtlMs
      if (now >= deadline) { this.work.delete(key); this.expired++; removed++ }
    }
    return removed
  }

  snapshot(): ArcGisIdentifyWorkSnapshot[] {
    this.assertActive()
    return [...this.work.values()].sort((a, b) => a.sequence - b.sequence).map((item) => this.detach(item))
  }

  diagnostics(): ArcGisIdentifyDiagnostics {
    this.assertActive()
    return { queued: this.count('queued'), running: this.count('running'), residentResponseBytes: this.totalResidentBytes(), rejected: this.rejected, expired: this.expired, cancelled: this.cancelled, staleCompletions: this.staleCompletions }
  }

  fingerprint(): string {
    return this.snapshot().map((item) => `${item.viewId}:${item.requestId}:${item.revision}:${item.intent}:${item.state}:${item.layerCount}:${item.tolerancePixels}`).join('|')
  }

  dispose(): void {
    if (this.disposed) return
    this.work.clear(); this.viewRevisions.clear(); this.residentBytes.clear(); this.disposed = true
  }

  private normalize(input: ArcGisIdentifyWorkInput): ArcGisIdentifyWorkInput {
    if (!(input.intent in INTENT_RANK)) throw new Error('intent is invalid')
    this.assertPositive(input.revision, 'revision'); this.assertPositive(input.layerCount, 'layerCount')
    this.assertNonNegative(input.tolerancePixels, 'tolerancePixels'); this.assertTimestamp(input.queuedAt)
    return { ...input, requestId: this.assertId(input.requestId, 'requestId'), viewId: this.assertId(input.viewId, 'viewId') }
  }
  private count(state: Work['state'], viewId?: string): number { let count = 0; for (const item of this.work.values()) if (item.state === state && (!viewId || item.viewId === viewId)) count++; return count }
  private totalResidentBytes(): number { let bytes = 0; for (const value of this.residentBytes.values()) bytes += value; return bytes }
  private detach(item: Work): ArcGisIdentifyWorkSnapshot { return { ...item } }
  private reject(): false { this.rejected++; return false }
  private key(viewId: string, requestId: string): string { return `${viewId}${KEY_SEPARATOR}${requestId}` }
  private assertId(value: string, name: string): string { const normalized = value.trim(); if (!normalized || normalized.length > 160 || normalized.includes(KEY_SEPARATOR) || normalized.includes(':')) throw new Error(`${name} must contain safe characters`); return normalized }
  private assertPositive(value: number, name: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`) }
  private assertNonNegative(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`) }
  private assertTimestamp(value: number): void { if (!Number.isFinite(value) || value < 0) throw new RangeError('timestamp must be finite and non-negative') }
  private assertActive(): void { if (this.disposed) throw new Error('ArcGisIdentifyWorkPolicy is disposed') }
}
