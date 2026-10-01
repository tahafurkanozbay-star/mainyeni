export type ArcGisSelectionHighlightIntent = 'primary' | 'linked' | 'hover'
export type ArcGisSelectionHighlightPhase = 'queued' | 'resolving' | 'active'

export interface ArcGisSelectionHighlightBudget {
  maxEntries: number
  maxEntriesPerView: number
  maxResolving: number
  maxActive: number
  maxObjectIdsPerEntry: number
  maxAggregateActiveObjectIds: number
  queueTtlMs: number
  resolveLeaseMs: number
  activeTtlMs: number
}

export interface ArcGisSelectionHighlightRequest {
  viewId: string
  layerId: string
  selectionId: string
  revision: number
  intent: ArcGisSelectionHighlightIntent
  requestedAt: number
  objectIdCount: number
}

export interface ArcGisSelectionHighlightSnapshot extends ArcGisSelectionHighlightRequest {
  phase: ArcGisSelectionHighlightPhase
  resolvedObjectIdCount: number
  expiresAt: number
}

type Entry = ArcGisSelectionHighlightSnapshot & { sequence: number }

const intentRank: Record<ArcGisSelectionHighlightIntent, number> = {
  primary: 0,
  linked: 1,
  hover: 2,
}
const separator = '\u0000'

/**
 * Scalar-only lifecycle authority for ArcGIS selection/highlight ownership.
 *
 * The caller remains the sole owner of Graphic, Geometry, LayerView, Handle,
 * AbortController and object-id arrays. This policy stores only bounded scalar
 * facts required to make scheduling, stale-completion and teardown decisions.
 */
export class ArcGisSelectionHighlightLifecyclePolicy {
  private readonly entries = new Map<string, Entry>()
  private readonly revisions = new Map<string, number>()
  private sequence = 0
  private disposed = false

  constructor(private readonly budget: ArcGisSelectionHighlightBudget) {
    this.validateBudget()
  }

  enqueue(raw: ArcGisSelectionHighlightRequest): boolean {
    this.assertLive()
    const request = this.normalize(raw)
    const revisionKey = this.revisionKey(request.viewId, request.layerId)
    const watermark = this.revisions.get(revisionKey) ?? 0
    if (request.revision < watermark) return false
    if (request.objectIdCount > this.budget.maxObjectIdsPerEntry) return false

    const key = this.key(request.viewId, request.layerId, request.selectionId)
    const previous = this.entries.get(key)
    if (previous && request.revision <= previous.revision) return false

    const replacement = previous ? 1 : 0
    if (this.entries.size - replacement >= this.budget.maxEntries) return false
    const previousInView = previous?.viewId === request.viewId ? 1 : 0
    if (this.countView(request.viewId) - previousInView >= this.budget.maxEntriesPerView) return false

    if (previous) this.entries.delete(key)
    this.revisions.set(revisionKey, Math.max(watermark, request.revision))
    this.entries.set(key, {
      ...request,
      phase: 'queued',
      resolvedObjectIdCount: 0,
      expiresAt: request.requestedAt + this.budget.queueTtlMs,
      sequence: this.sequence++,
    })
    return true
  }

  takeNext(now: number): ArcGisSelectionHighlightSnapshot | undefined {
    this.assertLive()
    this.timestamp(now, 'now')
    this.expire(now)
    if (this.countPhase('resolving') >= this.budget.maxResolving) return undefined

    const next = [...this.entries.values()]
      .filter((entry) => entry.phase === 'queued')
      .sort((a, b) =>
        intentRank[a.intent] - intentRank[b.intent]
        || a.requestedAt - b.requestedAt
        || a.sequence - b.sequence)[0]
    if (!next) return undefined

    next.phase = 'resolving'
    next.expiresAt = now + this.budget.resolveLeaseMs
    return this.toPublic(next)
  }

  complete(
    viewId: string,
    layerId: string,
    selectionId: string,
    revision: number,
    resolvedObjectIdCount: number,
    now: number,
  ): boolean {
    this.assertLive()
    this.positive(revision, 'revision')
    this.nonNegative(resolvedObjectIdCount, 'resolvedObjectIdCount')
    this.timestamp(now, 'now')
    const view = this.id(viewId, 'viewId')
    const layer = this.id(layerId, 'layerId')
    const selection = this.id(selectionId, 'selectionId')
    const entry = this.entries.get(this.key(view, layer, selection))
    if (!entry || entry.phase !== 'resolving' || entry.revision !== revision) return false

    const watermark = this.revisions.get(this.revisionKey(view, layer)) ?? 0
    if (now >= entry.expiresAt || revision < watermark) {
      this.remove(entry)
      return false
    }
    if (resolvedObjectIdCount > entry.objectIdCount || resolvedObjectIdCount > this.budget.maxObjectIdsPerEntry) {
      this.remove(entry)
      return false
    }
    if (this.countPhase('active') >= this.budget.maxActive) {
      this.remove(entry)
      return false
    }
    if (this.activeObjectIds() + resolvedObjectIdCount > this.budget.maxAggregateActiveObjectIds) {
      this.remove(entry)
      return false
    }

    entry.phase = 'active'
    entry.resolvedObjectIdCount = resolvedObjectIdCount
    entry.expiresAt = now + this.budget.activeTtlMs
    return true
  }

  touch(viewId: string, layerId: string, selectionId: string, revision: number, now: number): boolean {
    this.assertLive()
    this.positive(revision, 'revision')
    this.timestamp(now, 'now')
    const entry = this.entries.get(this.key(
      this.id(viewId, 'viewId'),
      this.id(layerId, 'layerId'),
      this.id(selectionId, 'selectionId'),
    ))
    if (!entry || entry.phase !== 'active' || entry.revision !== revision) return false
    if (now >= entry.expiresAt) {
      this.remove(entry)
      return false
    }
    entry.expiresAt = now + this.budget.activeTtlMs
    return true
  }

  release(viewId: string, layerId: string, selectionId: string, revision: number): boolean {
    this.assertLive()
    this.positive(revision, 'revision')
    const entry = this.entries.get(this.key(
      this.id(viewId, 'viewId'),
      this.id(layerId, 'layerId'),
      this.id(selectionId, 'selectionId'),
    ))
    if (!entry || entry.revision !== revision) return false
    this.remove(entry)
    return true
  }

  invalidateLayer(viewId: string, layerId: string, revision: number): number {
    this.assertLive()
    const view = this.id(viewId, 'viewId')
    const layer = this.id(layerId, 'layerId')
    this.positive(revision, 'revision')
    const revisionKey = this.revisionKey(view, layer)
    const current = this.revisions.get(revisionKey) ?? 0
    if (revision <= current) return 0
    this.revisions.set(revisionKey, revision)
    let removed = 0
    for (const entry of [...this.entries.values()]) {
      if (entry.viewId === view && entry.layerId === layer && entry.revision < revision) {
        this.remove(entry)
        removed++
      }
    }
    return removed
  }

  releaseLayer(viewId: string, layerId: string): number {
    this.assertLive()
    const view = this.id(viewId, 'viewId')
    const layer = this.id(layerId, 'layerId')
    let removed = 0
    for (const entry of [...this.entries.values()]) {
      if (entry.viewId === view && entry.layerId === layer) {
        this.remove(entry)
        removed++
      }
    }
    this.revisions.delete(this.revisionKey(view, layer))
    return removed
  }

  releaseView(viewId: string): number {
    this.assertLive()
    const view = this.id(viewId, 'viewId')
    let removed = 0
    for (const entry of [...this.entries.values()]) {
      if (entry.viewId === view) {
        this.remove(entry)
        removed++
      }
    }
    for (const key of [...this.revisions.keys()]) {
      if (key.startsWith(`${view}${separator}`)) this.revisions.delete(key)
    }
    return removed
  }

  expire(now: number): number {
    this.assertLive()
    this.timestamp(now, 'now')
    let removed = 0
    for (const entry of [...this.entries.values()]) {
      if (now >= entry.expiresAt) {
        this.remove(entry)
        removed++
      }
    }
    return removed
  }

  snapshot(): ArcGisSelectionHighlightSnapshot[] {
    this.assertLive()
    return [...this.entries.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .map((entry) => this.toPublic(entry))
  }

  fingerprint(): string {
    return this.snapshot()
      .map((entry) => `${entry.viewId}:${entry.layerId}:${entry.selectionId}:${entry.revision}:${entry.phase}:${entry.resolvedObjectIdCount}`)
      .join('|')
  }

  dispose(): void {
    if (this.disposed) return
    this.entries.clear()
    this.revisions.clear()
    this.disposed = true
  }

  private activeObjectIds(): number {
    let count = 0
    for (const entry of this.entries.values()) {
      if (entry.phase === 'active') count += entry.resolvedObjectIdCount
    }
    return count
  }

  private countPhase(phase: ArcGisSelectionHighlightPhase): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.phase === phase) count++
    return count
  }

  private countView(viewId: string): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.viewId === viewId) count++
    return count
  }

  private remove(entry: Entry): void {
    this.entries.delete(this.key(entry.viewId, entry.layerId, entry.selectionId))
  }

  private toPublic(entry: Entry): ArcGisSelectionHighlightSnapshot {
    const { sequence: _sequence, ...snapshot } = entry
    return { ...snapshot }
  }

  private normalize(request: ArcGisSelectionHighlightRequest): ArcGisSelectionHighlightRequest {
    if (!(request.intent in intentRank)) throw new Error('intent is invalid')
    this.positive(request.revision, 'revision')
    this.timestamp(request.requestedAt, 'requestedAt')
    this.positive(request.objectIdCount, 'objectIdCount')
    return {
      ...request,
      viewId: this.id(request.viewId, 'viewId'),
      layerId: this.id(request.layerId, 'layerId'),
      selectionId: this.id(request.selectionId, 'selectionId'),
    }
  }

  private id(value: string, name: string): string {
    if (typeof value !== 'string') throw new Error(`${name} must be a string`)
    const normalized = value.trim()
    if (!normalized || normalized.includes(separator) || normalized.includes(':') || normalized.length > 160) {
      throw new Error(`${name} must contain safe characters`)
    }
    return normalized
  }

  private key(viewId: string, layerId: string, selectionId: string): string {
    return `${viewId}${separator}${layerId}${separator}${selectionId}`
  }

  private revisionKey(viewId: string, layerId: string): string {
    return `${viewId}${separator}${layerId}`
  }

  private positive(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  }

  private nonNegative(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
  }

  private timestamp(value: number, name: string): void {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative timestamp`)
  }

  private validateBudget(): void {
    for (const [name, value] of Object.entries(this.budget)) this.positive(value, name)
    if (this.budget.maxEntriesPerView > this.budget.maxEntries) throw new Error('maxEntriesPerView cannot exceed maxEntries')
    if (this.budget.maxResolving > this.budget.maxEntries) throw new Error('maxResolving cannot exceed maxEntries')
    if (this.budget.maxActive > this.budget.maxEntries) throw new Error('maxActive cannot exceed maxEntries')
    if (this.budget.maxAggregateActiveObjectIds < this.budget.maxObjectIdsPerEntry) {
      throw new Error('maxAggregateActiveObjectIds must admit one maximum entry')
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('ArcGisSelectionHighlightLifecyclePolicy is disposed')
  }
}
