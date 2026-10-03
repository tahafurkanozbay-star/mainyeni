export type ArcGisQueryCacheIntent = 'interactive' | 'visible' | 'background'

export interface ArcGisQueryResultCacheBudget {
  maxEntries: number
  maxEntriesPerLayer: number
  maxObjectIdsPerEntry: number
  maxBytesPerEntry: number
  maxAggregateBytes: number
  maxAggregateBytesPerLayer: number
  ttlMs: number
}

export interface ArcGisQueryResultDescriptor {
  layerId: string
  queryKey: string
  revision: number
  intent: ArcGisQueryCacheIntent
  objectIdCount: number
  byteSize: number
  storedAt: number
  expiresAt: number
  fingerprint: string
}

type Entry = ArcGisQueryResultDescriptor & { sequence: number; lastAccessedAt: number }
const intentRank: Record<ArcGisQueryCacheIntent, number> = { interactive: 0, visible: 1, background: 2 }
const separator = '\u0000'

/** Bounded scalar-only authority for ArcGIS query-result cache metadata. */
export class ArcGisQueryResultCachePolicy {
  private readonly entries = new Map<string, Entry>()
  private readonly revisions = new Map<string, number>()
  private sequence = 0
  private disposed = false

  constructor(private readonly budget: ArcGisQueryResultCacheBudget) { this.validateBudget() }

  put(input: Omit<ArcGisQueryResultDescriptor, 'expiresAt'>): boolean {
    this.active()
    const candidate = this.normalize(input)
    this.expire(candidate.storedAt)
    const watermark = this.revisions.get(candidate.layerId) ?? 0
    if (candidate.revision < watermark) return false
    if (candidate.objectIdCount > this.budget.maxObjectIdsPerEntry || candidate.byteSize > this.budget.maxBytesPerEntry) return false
    const key = this.key(candidate.layerId, candidate.queryKey)
    const previous = this.entries.get(key)
    if (previous && candidate.revision < previous.revision) return false
    const advances = candidate.revision > watermark
    const survives = (entry: Entry) => entry !== previous && !(advances && entry.layerId === candidate.layerId && entry.revision < candidate.revision)
    if (this.count(entry => survives(entry) && entry.layerId === candidate.layerId) + 1 > this.budget.maxEntriesPerLayer) return false
    const victims = this.planEvictions(candidate, survives)
    if (!victims) return false
    if (advances) this.invalidateLayer(candidate.layerId, candidate.revision)
    else if (previous) this.entries.delete(key)
    for (const victim of victims) this.entries.delete(this.key(victim.layerId, victim.queryKey))
    if (this.entries.size + 1 > this.budget.maxEntries) return false
    if (this.totalBytes() + candidate.byteSize > this.budget.maxAggregateBytes) return false
    if (this.layerBytes(candidate.layerId) + candidate.byteSize > this.budget.maxAggregateBytesPerLayer) return false
    this.revisions.set(candidate.layerId, Math.max(watermark, candidate.revision))
    this.entries.set(key, { ...candidate, expiresAt: candidate.storedAt + this.budget.ttlMs, lastAccessedAt: candidate.storedAt, sequence: this.sequence++ })
    return true
  }

  get(layerId: string, queryKey: string, revision: number, now: number): ArcGisQueryResultDescriptor | undefined {
    this.active(); this.timestamp(now); this.positive(revision, 'revision')
    const layer = this.id(layerId, 'layerId'), query = this.id(queryKey, 'queryKey')
    const key = this.key(layer, query), entry = this.entries.get(key)
    if (!entry || entry.revision !== revision || revision < (this.revisions.get(layer) ?? 0)) return undefined
    if (now >= entry.expiresAt) { this.entries.delete(key); return undefined }
    entry.lastAccessedAt = Math.max(entry.lastAccessedAt, now)
    return this.detach(entry)
  }

  touch(layerId: string, queryKey: string, revision: number, now: number): boolean { return this.get(layerId, queryKey, revision, now) !== undefined }
  invalidateLayer(layerId: string, revision: number): number { this.active(); const layer = this.id(layerId, 'layerId'); this.positive(revision, 'revision'); const current = this.revisions.get(layer) ?? 0; if (revision <= current) return 0; this.revisions.set(layer, revision); return this.release(entry => entry.layerId === layer && entry.revision < revision) }
  expire(now: number): number { this.active(); this.timestamp(now); return this.release(entry => now >= entry.expiresAt) }
  releaseLayer(layerId: string): number { this.active(); const layer = this.id(layerId, 'layerId'); this.revisions.delete(layer); return this.release(entry => entry.layerId === layer) }
  snapshot(): ArcGisQueryResultDescriptor[] { this.active(); return [...this.entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.detach(entry)) }
  fingerprint(): string { return this.snapshot().map(entry => `${entry.layerId}:${entry.queryKey}:${entry.revision}:${entry.intent}:${entry.objectIdCount}:${entry.byteSize}:${entry.fingerprint}`).join('|') }
  dispose(): void { if (!this.disposed) { this.entries.clear(); this.revisions.clear(); this.disposed = true } }

  private planEvictions(candidate: Omit<ArcGisQueryResultDescriptor, 'expiresAt'>, survives: (entry: Entry) => boolean): Entry[] | undefined {
    let count = this.count(survives), bytes = this.sumBytes(survives), layerBytes = this.sumBytes(entry => survives(entry) && entry.layerId === candidate.layerId)
    if (this.fits(count, bytes, layerBytes, candidate)) return []
    const victims: Entry[] = []
    for (const entry of this.evictionOrder(candidate).filter(survives)) { victims.push(entry); count--; bytes -= entry.byteSize; if (entry.layerId === candidate.layerId) layerBytes -= entry.byteSize; if (this.fits(count, bytes, layerBytes, candidate)) return victims }
    return undefined
  }
  private fits(count: number, bytes: number, layerBytes: number, candidate: Omit<ArcGisQueryResultDescriptor, 'expiresAt'>): boolean { return count + 1 <= this.budget.maxEntries && bytes + candidate.byteSize <= this.budget.maxAggregateBytes && layerBytes + candidate.byteSize <= this.budget.maxAggregateBytesPerLayer }
  private evictionOrder(candidate: Omit<ArcGisQueryResultDescriptor, 'expiresAt'>): Entry[] { return [...this.entries.values()].filter(entry => intentRank[entry.intent] >= intentRank[candidate.intent]).sort((a, b) => intentRank[b.intent] - intentRank[a.intent] || a.lastAccessedAt - b.lastAccessedAt || a.sequence - b.sequence) }
  private normalize(input: Omit<ArcGisQueryResultDescriptor, 'expiresAt'>): Omit<ArcGisQueryResultDescriptor, 'expiresAt'> { if (!(input.intent in intentRank)) throw new Error('intent is invalid'); this.positive(input.revision, 'revision'); this.nonNegative(input.objectIdCount, 'objectIdCount'); this.nonNegative(input.byteSize, 'byteSize'); this.timestamp(input.storedAt); return { ...input, layerId: this.id(input.layerId, 'layerId'), queryKey: this.id(input.queryKey, 'queryKey'), fingerprint: this.id(input.fingerprint, 'fingerprint') } }
  private validateBudget(): void { for (const [name, value] of Object.entries(this.budget)) this.positive(value, name); if (this.budget.maxEntriesPerLayer > this.budget.maxEntries) throw new RangeError('per-layer entries exceed global entries'); if (this.budget.maxBytesPerEntry > this.budget.maxAggregateBytesPerLayer) throw new RangeError('entry bytes exceed per-layer aggregate bytes'); if (this.budget.maxAggregateBytesPerLayer > this.budget.maxAggregateBytes) throw new RangeError('per-layer aggregate bytes exceed global aggregate bytes') }
  private detach(entry: Entry): ArcGisQueryResultDescriptor { const { sequence: _sequence, lastAccessedAt: _lastAccessedAt, ...descriptor } = entry; return { ...descriptor } }
  private count(predicate: (entry: Entry) => boolean): number { let count = 0; for (const entry of this.entries.values()) if (predicate(entry)) count++; return count }
  private sumBytes(predicate: (entry: Entry) => boolean): number { let bytes = 0; for (const entry of this.entries.values()) if (predicate(entry)) bytes += entry.byteSize; return bytes }
  private totalBytes(): number { return this.sumBytes(() => true) }
  private layerBytes(layerId: string): number { return this.sumBytes(entry => entry.layerId === layerId) }
  private release(predicate: (entry: Entry) => boolean): number { let count = 0; for (const [key, entry] of this.entries) if (predicate(entry)) { this.entries.delete(key); count++ } return count }
  private key(layerId: string, queryKey: string): string { return `${layerId}${separator}${queryKey}` }
  private id(value: string, name: string): string { const normalized = value.trim(); if (!normalized || normalized.length > 192 || normalized.includes(separator) || normalized.includes(':')) throw new Error(`${name} must contain safe characters`); return normalized }
  private positive(value: number, name: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`) }
  private nonNegative(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`) }
  private timestamp(value: number): void { if (!Number.isFinite(value) || value < 0) throw new RangeError('timestamp must be finite and non-negative') }
  private active(): void { if (this.disposed) throw new Error('ArcGisQueryResultCachePolicy is disposed') }
}
