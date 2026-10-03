export type ArcGisFeaturePageIntent = 'interactive' | 'visible' | 'background'

export interface ArcGisFeaturePageCacheBudget {
  maxEntries: number
  maxEntriesPerLayer: number
  maxObjectIdsPerPage: number
  maxBytesPerPage: number
  maxAggregateBytes: number
  ttlMs: number
}

export interface ArcGisFeaturePageDescriptor {
  layerId: string
  pageKey: string
  revision: number
  intent: ArcGisFeaturePageIntent
  objectIdCount: number
  byteSize: number
  storedAt: number
  expiresAt: number
  fingerprint: string
}

type Entry = ArcGisFeaturePageDescriptor & { sequence: number; lastAccessedAt: number }
const intentRank: Record<ArcGisFeaturePageIntent, number> = { interactive: 0, visible: 1, background: 2 }
const separator = '\u0000'

/** Scalar-only bounded authority for FeatureServer page cache metadata. */
export class ArcGisFeaturePageCachePolicy {
  private readonly entries = new Map<string, Entry>()
  private readonly revisions = new Map<string, number>()
  private sequence = 0
  private disposed = false

  constructor(private readonly budget: ArcGisFeaturePageCacheBudget) { this.validateBudget() }

  put(input: Omit<ArcGisFeaturePageDescriptor, 'expiresAt'>): boolean {
    this.active()
    const page = this.normalize(input)
    const watermark = this.revisions.get(page.layerId) ?? 0
    if (page.revision < watermark) return false
    const key = this.key(page.layerId, page.pageKey)
    const previous = this.entries.get(key)
    if (previous && page.revision < previous.revision) return false
    if (page.objectIdCount > this.budget.maxObjectIdsPerPage || page.byteSize > this.budget.maxBytesPerPage) return false

    const advances = page.revision > watermark
    const survives = (entry: Entry) => entry !== previous && !(advances && entry.layerId === page.layerId && entry.revision < page.revision)
    const layerCount = this.count(entry => survives(entry) && entry.layerId === page.layerId)
    if (layerCount + 1 > this.budget.maxEntriesPerLayer) return false
    if (!this.canFit(page, survives)) return false

    if (advances) this.invalidateLayer(page.layerId, page.revision)
    else if (previous) this.entries.delete(key)
    this.revisions.set(page.layerId, Math.max(watermark, page.revision))
    this.evictUntilFits(page)
    if (this.entries.size >= this.budget.maxEntries) this.evictOne(page)
    if (this.entries.size >= this.budget.maxEntries || this.totalBytes() + page.byteSize > this.budget.maxAggregateBytes) return false

    this.entries.set(key, { ...page, expiresAt: page.storedAt + this.budget.ttlMs, lastAccessedAt: page.storedAt, sequence: this.sequence++ })
    return true
  }

  get(layerId: string, pageKey: string, revision: number, now: number): ArcGisFeaturePageDescriptor | undefined {
    this.active(); this.timestamp(now); this.positive(revision, 'revision')
    const layer = this.id(layerId, 'layerId'), page = this.id(pageKey, 'pageKey')
    const key = this.key(layer, page), entry = this.entries.get(key)
    if (!entry || entry.revision !== revision || revision < (this.revisions.get(layer) ?? 0)) return undefined
    if (now >= entry.expiresAt) { this.entries.delete(key); return undefined }
    entry.lastAccessedAt = Math.max(entry.lastAccessedAt, now)
    return this.detach(entry)
  }

  invalidateLayer(layerId: string, revision: number): number {
    this.active(); const layer = this.id(layerId, 'layerId'); this.positive(revision, 'revision')
    const current = this.revisions.get(layer) ?? 0
    if (revision <= current) return 0
    this.revisions.set(layer, revision)
    return this.release(entry => entry.layerId === layer && entry.revision < revision)
  }

  expire(now: number): number { this.active(); this.timestamp(now); return this.release(entry => now >= entry.expiresAt) }
  releaseLayer(layerId: string): number { this.active(); const layer = this.id(layerId, 'layerId'); this.revisions.delete(layer); return this.release(entry => entry.layerId === layer) }
  snapshot(): ArcGisFeaturePageDescriptor[] { this.active(); return [...this.entries.values()].sort((a,b) => a.sequence-b.sequence).map(entry => this.detach(entry)) }
  fingerprint(): string { return this.snapshot().map(entry => `${entry.layerId}:${entry.pageKey}:${entry.revision}:${entry.intent}:${entry.objectIdCount}:${entry.byteSize}:${entry.fingerprint}`).join('|') }
  dispose(): void { if (!this.disposed) { this.entries.clear(); this.revisions.clear(); this.disposed = true } }

  private canFit(candidate: Omit<ArcGisFeaturePageDescriptor, 'expiresAt'>, survives: (entry: Entry) => boolean): boolean {
    let count = this.count(survives), bytes = this.sumBytes(survives)
    if (count + 1 <= this.budget.maxEntries && bytes + candidate.byteSize <= this.budget.maxAggregateBytes) return true
    for (const entry of this.evictionOrder(candidate).filter(survives)) {
      count--; bytes -= entry.byteSize
      if (count + 1 <= this.budget.maxEntries && bytes + candidate.byteSize <= this.budget.maxAggregateBytes) return true
    }
    return false
  }

  private evictUntilFits(candidate: Omit<ArcGisFeaturePageDescriptor, 'expiresAt'>): void {
    for (const entry of this.evictionOrder(candidate)) {
      if (this.entries.size < this.budget.maxEntries && this.totalBytes() + candidate.byteSize <= this.budget.maxAggregateBytes) return
      this.entries.delete(this.key(entry.layerId, entry.pageKey))
    }
  }
  private evictOne(candidate: Omit<ArcGisFeaturePageDescriptor, 'expiresAt'>): void { const victim = this.evictionOrder(candidate)[0]; if (victim) this.entries.delete(this.key(victim.layerId, victim.pageKey)) }
  private evictionOrder(candidate: Omit<ArcGisFeaturePageDescriptor, 'expiresAt'>): Entry[] {
    return [...this.entries.values()].filter(entry => intentRank[entry.intent] >= intentRank[candidate.intent])
      .sort((a,b) => intentRank[b.intent]-intentRank[a.intent] || a.lastAccessedAt-b.lastAccessedAt || a.sequence-b.sequence)
  }
  private normalize(input: Omit<ArcGisFeaturePageDescriptor, 'expiresAt'>): Omit<ArcGisFeaturePageDescriptor, 'expiresAt'> {
    if (!(input.intent in intentRank)) throw new Error('intent is invalid')
    this.positive(input.revision,'revision'); this.positive(input.objectIdCount,'objectIdCount'); this.nonNegative(input.byteSize,'byteSize'); this.timestamp(input.storedAt)
    return { ...input, layerId: this.id(input.layerId,'layerId'), pageKey: this.id(input.pageKey,'pageKey'), fingerprint: this.id(input.fingerprint,'fingerprint') }
  }
  private validateBudget(): void { for (const [name,value] of Object.entries(this.budget)) this.positive(value,name); if (this.budget.maxEntriesPerLayer > this.budget.maxEntries) throw new RangeError('per-layer entries exceed global entries'); if (this.budget.maxBytesPerPage > this.budget.maxAggregateBytes) throw new RangeError('page bytes exceed aggregate bytes') }
  private detach(entry: Entry): ArcGisFeaturePageDescriptor { const { sequence: _s, lastAccessedAt: _a, ...page } = entry; return { ...page } }
  private count(predicate: (entry: Entry) => boolean): number { let n=0; for (const entry of this.entries.values()) if (predicate(entry)) n++; return n }
  private sumBytes(predicate: (entry: Entry) => boolean): number { let n=0; for (const entry of this.entries.values()) if (predicate(entry)) n += entry.byteSize; return n }
  private totalBytes(): number { return this.sumBytes(() => true) }
  private release(predicate: (entry: Entry) => boolean): number { let n=0; for (const [key,entry] of this.entries) if (predicate(entry)) { this.entries.delete(key); n++ } return n }
  private key(layer: string, page: string): string { return `${layer}${separator}${page}` }
  private id(value: string, name: string): string { const normalized=value.trim(); if (!normalized || normalized.length>160 || normalized.includes(separator) || normalized.includes(':')) throw new Error(`${name} must contain safe characters`); return normalized }
  private positive(value:number,name:string):void { if(!Number.isSafeInteger(value)||value<=0) throw new RangeError(`${name} must be a positive safe integer`) }
  private nonNegative(value:number,name:string):void { if(!Number.isSafeInteger(value)||value<0) throw new RangeError(`${name} must be a non-negative safe integer`) }
  private timestamp(value:number):void { if(!Number.isFinite(value)||value<0) throw new RangeError('timestamp must be finite and non-negative') }
  private active():void { if(this.disposed) throw new Error('ArcGisFeaturePageCachePolicy is disposed') }
}
