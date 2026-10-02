export type ArcGisRendererFrameIntent = 'interaction' | 'navigation' | 'background'
export type ArcGisRendererFramePhase = 'queued' | 'rendering' | 'resident'

export interface ArcGisRendererFrameBudget {
  maxFrames: number
  maxFramesPerView: number
  maxRendering: number
  maxResident: number
  maxCommandsPerFrame: number
  maxVerticesPerFrame: number
  maxBytesPerFrame: number
  maxAggregateResidentBytes: number
  maxAggregateResidentVertices: number
  queueTtlMs: number
  renderLeaseMs: number
  residentTtlMs: number
}

export interface ArcGisRendererFrameRequest {
  viewId: string
  layerId: string
  frameId: string
  revision: number
  intent: ArcGisRendererFrameIntent
  requestedAt: number
  lod: number
  commandCount: number
  estimatedVertices: number
  estimatedBytes: number
}

export interface ArcGisRendererFrameSnapshot extends ArcGisRendererFrameRequest {
  phase: ArcGisRendererFramePhase
  sequence: number
  startedAt?: number
  expiresAt: number
  actualVertices?: number
  actualBytes?: number
}

type Entry = ArcGisRendererFrameSnapshot

const intentRank: Record<ArcGisRendererFrameIntent, number> = {
  interaction: 0,
  navigation: 1,
  background: 2,
}

const finiteInteger = (value: number, min = 0) => Number.isSafeInteger(value) && value >= min
const finiteNumber = (value: number, min = 0) => Number.isFinite(value) && value >= min

function identifier(value: string): string | undefined {
  const normalized = value.trim()
  if (!normalized || normalized.length > 160 || /[|\u0000-\u001f\u007f]/u.test(normalized)) return undefined
  return normalized
}

function key(viewId: string, layerId: string, frameId: string): string {
  return `${viewId}|${layerId}|${frameId}`
}

export class ArcGisRendererFrameLifecyclePolicy {
  private readonly entries = new Map<string, Entry>()
  private readonly viewRevisions = new Map<string, number>()
  private sequence = 0

  constructor(private readonly budget: ArcGisRendererFrameBudget) {
    this.validateBudget(budget)
  }

  enqueue(request: ArcGisRendererFrameRequest): boolean {
    const normalized = this.normalize(request)
    if (!normalized) return false
    const watermark = this.viewRevisions.get(normalized.viewId) ?? 0
    if (normalized.revision < watermark) return false
    if (normalized.revision > watermark) this.invalidateView(normalized.viewId, normalized.revision)

    const entryKey = key(normalized.viewId, normalized.layerId, normalized.frameId)
    const previous = this.entries.get(entryKey)
    if (previous && previous.revision >= normalized.revision) return false
    if (previous) this.entries.delete(entryKey)

    if (this.entries.size >= this.budget.maxFrames) return false
    if (this.count(entry => entry.viewId === normalized.viewId) >= this.budget.maxFramesPerView) return false

    this.entries.set(entryKey, {
      ...normalized,
      phase: 'queued',
      sequence: ++this.sequence,
      expiresAt: normalized.requestedAt + this.budget.queueTtlMs,
    })
    return true
  }

  takeNext(now: number): ArcGisRendererFrameSnapshot | undefined {
    if (!finiteNumber(now)) return undefined
    this.expire(now)
    if (this.count(entry => entry.phase === 'rendering') >= this.budget.maxRendering) return undefined
    const queued = [...this.entries.values()].filter(entry => entry.phase === 'queued')
    queued.sort((a, b) => intentRank[a.intent] - intentRank[b.intent] || b.lod - a.lod || a.requestedAt - b.requestedAt || a.sequence - b.sequence)
    const next = queued[0]
    if (!next) return undefined
    next.phase = 'rendering'
    next.startedAt = now
    next.expiresAt = now + this.budget.renderLeaseMs
    return this.detach(next)
  }

  complete(viewId: string, layerId: string, frameId: string, revision: number, actualVertices: number, actualBytes: number, now: number): boolean {
    const ids = [identifier(viewId), identifier(layerId), identifier(frameId)]
    if (ids.some(value => !value) || !finiteInteger(revision, 1) || !finiteInteger(actualVertices) || !finiteInteger(actualBytes) || !finiteNumber(now)) return false
    const entryKey = key(ids[0]!, ids[1]!, ids[2]!)
    const entry = this.entries.get(entryKey)
    if (!entry || entry.phase !== 'rendering' || entry.revision !== revision) return false
    if (now >= entry.expiresAt || revision !== (this.viewRevisions.get(entry.viewId) ?? revision)) {
      this.entries.delete(entryKey)
      return false
    }
    if (actualVertices > this.budget.maxVerticesPerFrame || actualBytes > this.budget.maxBytesPerFrame) {
      this.entries.delete(entryKey)
      return false
    }
    if (this.count(item => item.phase === 'resident') >= this.budget.maxResident) {
      this.entries.delete(entryKey)
      return false
    }
    if (this.residentBytes() + actualBytes > this.budget.maxAggregateResidentBytes || this.residentVertices() + actualVertices > this.budget.maxAggregateResidentVertices) {
      this.entries.delete(entryKey)
      return false
    }
    entry.phase = 'resident'
    entry.actualVertices = actualVertices
    entry.actualBytes = actualBytes
    entry.expiresAt = now + this.budget.residentTtlMs
    return true
  }

  touch(viewId: string, layerId: string, frameId: string, revision: number, now: number): boolean {
    const entry = this.lookup(viewId, layerId, frameId)
    if (!entry || entry.phase !== 'resident' || entry.revision !== revision || !finiteNumber(now) || now >= entry.expiresAt) return false
    entry.expiresAt = now + this.budget.residentTtlMs
    return true
  }

  consume(viewId: string, layerId: string, frameId: string, revision: number): boolean {
    const entry = this.lookup(viewId, layerId, frameId)
    if (!entry || entry.phase !== 'resident' || entry.revision !== revision) return false
    return this.entries.delete(key(entry.viewId, entry.layerId, entry.frameId))
  }

  cancel(viewId: string, layerId: string, frameId: string, revision: number): boolean {
    const entry = this.lookup(viewId, layerId, frameId)
    if (!entry || entry.revision !== revision) return false
    return this.entries.delete(key(entry.viewId, entry.layerId, entry.frameId))
  }

  invalidateView(viewId: string, revision: number): number {
    const normalized = identifier(viewId)
    if (!normalized || !finiteInteger(revision, 1)) return 0
    const previous = this.viewRevisions.get(normalized) ?? 0
    if (revision < previous) return 0
    this.viewRevisions.set(normalized, revision)
    let removed = 0
    for (const [entryKey, entry] of this.entries) {
      if (entry.viewId === normalized && entry.revision < revision) {
        this.entries.delete(entryKey)
        removed++
      }
    }
    return removed
  }

  expire(now: number): number {
    if (!finiteNumber(now)) return 0
    let removed = 0
    for (const [entryKey, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(entryKey)
        removed++
      }
    }
    return removed
  }

  releaseLayer(viewId: string, layerId: string): number {
    const view = identifier(viewId)
    const layer = identifier(layerId)
    if (!view || !layer) return 0
    return this.release(entry => entry.viewId === view && entry.layerId === layer)
  }

  releaseView(viewId: string): number {
    const view = identifier(viewId)
    if (!view) return 0
    this.viewRevisions.delete(view)
    return this.release(entry => entry.viewId === view)
  }

  snapshot(): ArcGisRendererFrameSnapshot[] {
    return [...this.entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.detach(entry))
  }

  fingerprint(): string {
    return this.snapshot().map(entry => [entry.viewId, entry.layerId, entry.frameId, entry.revision, entry.phase, entry.intent, entry.lod, entry.commandCount, entry.estimatedVertices, entry.estimatedBytes, entry.actualVertices ?? 0, entry.actualBytes ?? 0].join(':')).join('|')
  }

  private lookup(viewId: string, layerId: string, frameId: string): Entry | undefined {
    const view = identifier(viewId)
    const layer = identifier(layerId)
    const frame = identifier(frameId)
    return view && layer && frame ? this.entries.get(key(view, layer, frame)) : undefined
  }

  private normalize(request: ArcGisRendererFrameRequest): ArcGisRendererFrameRequest | undefined {
    const viewId = identifier(request.viewId)
    const layerId = identifier(request.layerId)
    const frameId = identifier(request.frameId)
    if (!viewId || !layerId || !frameId) return undefined
    if (!finiteInteger(request.revision, 1) || !finiteNumber(request.requestedAt) || !finiteInteger(request.lod) || !finiteInteger(request.commandCount) || !finiteInteger(request.estimatedVertices) || !finiteInteger(request.estimatedBytes)) return undefined
    if (!(request.intent in intentRank) || request.commandCount > this.budget.maxCommandsPerFrame || request.estimatedVertices > this.budget.maxVerticesPerFrame || request.estimatedBytes > this.budget.maxBytesPerFrame) return undefined
    return { ...request, viewId, layerId, frameId }
  }

  private validateBudget(budget: ArcGisRendererFrameBudget): void {
    const positive = [budget.maxFrames, budget.maxFramesPerView, budget.maxRendering, budget.maxResident, budget.maxCommandsPerFrame, budget.maxVerticesPerFrame, budget.maxBytesPerFrame, budget.maxAggregateResidentBytes, budget.maxAggregateResidentVertices, budget.queueTtlMs, budget.renderLeaseMs, budget.residentTtlMs]
    if (positive.some(value => !finiteInteger(value, 1))) throw new RangeError('ArcGIS renderer frame budget values must be positive safe integers')
    if (budget.maxFramesPerView > budget.maxFrames || budget.maxRendering > budget.maxFrames || budget.maxResident > budget.maxFrames) throw new RangeError('ArcGIS renderer frame cardinality budget is inconsistent')
  }

  private count(predicate: (entry: Entry) => boolean): number {
    let total = 0
    for (const entry of this.entries.values()) if (predicate(entry)) total++
    return total
  }

  private residentBytes(): number {
    let total = 0
    for (const entry of this.entries.values()) if (entry.phase === 'resident') total += entry.actualBytes ?? 0
    return total
  }

  private residentVertices(): number {
    let total = 0
    for (const entry of this.entries.values()) if (entry.phase === 'resident') total += entry.actualVertices ?? 0
    return total
  }

  private release(predicate: (entry: Entry) => boolean): number {
    let removed = 0
    for (const [entryKey, entry] of this.entries) if (predicate(entry)) { this.entries.delete(entryKey); removed++ }
    return removed
  }

  private detach(entry: Entry): ArcGisRendererFrameSnapshot {
    return { ...entry }
  }
}
