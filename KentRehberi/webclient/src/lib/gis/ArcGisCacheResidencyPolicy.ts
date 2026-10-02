export type ArcGisCacheIntent = 'background' | 'visible' | 'interactive'
export type ArcGisCachePhase = 'loading' | 'resident'

export interface ArcGisCacheBudget {
  maxEntries: number
  maxEntriesPerService: number
  maxLoading: number
  maxResident: number
  maxBytesPerEntry: number
  maxResidentBytes: number
  loadingTtlMs: number
  residentTtlMs: number
}

export interface ArcGisCacheRequest {
  cacheKey: string
  serviceId: string
  layerId: string
  revision: number
  intent: ArcGisCacheIntent
  estimatedBytes: number
  requestedAt: number
}

export interface ArcGisCacheEntryView {
  readonly cacheKey: string
  readonly serviceId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: ArcGisCacheIntent
  readonly phase: ArcGisCachePhase
  readonly estimatedBytes: number
  readonly actualBytes: number
  readonly sequence: number
  readonly expiresAt: number
}

type Entry = ArcGisCacheRequest & { phase: ArcGisCachePhase; actualBytes: number; sequence: number; expiresAt: number }
const priority: Readonly<Record<ArcGisCacheIntent, number>> = Object.freeze({ background: 0, visible: 1, interactive: 2 })

function finite(name: string, value: number): void { if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`) }
function integer(name: string, value: number, min = 0): void { if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`) }
function id(name: string, value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9._:/-]{1,256}$/.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}

/** Payload-free cache authority for ArcGIS REST-derived metadata/query results.
 * It never stores response JSON, FeatureSet, Graphic, credential, URL, request
 * body or AbortController graphs. Callers own payload storage and eviction.
 */
export class ArcGisCacheResidencyPolicy {
  readonly #budget: Readonly<ArcGisCacheBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisCacheBudget) {
    for (const [name, value] of Object.entries(budget)) {
      if (name.endsWith('Ms')) finite(name, value); else integer(name, value, 1)
    }
    if (budget.maxEntriesPerService > budget.maxEntries || budget.maxLoading > budget.maxEntries || budget.maxResident > budget.maxEntries) throw new Error('impossible cardinality budget')
    if (budget.maxBytesPerEntry > budget.maxResidentBytes) throw new Error('impossible byte budget')
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(request: ArcGisCacheRequest): Readonly<ArcGisCacheEntryView> {
    this.#active()
    const cacheKey = id('cacheKey', request.cacheKey); const serviceId = id('serviceId', request.serviceId); const layerId = id('layerId', request.layerId)
    integer('revision', request.revision); integer('estimatedBytes', request.estimatedBytes); finite('requestedAt', request.requestedAt)
    if (request.estimatedBytes > this.#budget.maxBytesPerEntry) throw new Error('entry byte budget exceeded')
    if (this.#entries.has(cacheKey)) throw new Error('duplicate cache authority')
    const watermark = this.#revisions.get(layerId)
    if (watermark !== undefined && request.revision < watermark) throw new Error('stale cache revision')
    if (watermark !== undefined && request.revision > watermark) this.advanceLayerRevision(layerId, request.revision)
    if (this.#entries.size >= this.#budget.maxEntries) throw new Error('cache capacity exceeded')
    if (this.#countService(serviceId) >= this.#budget.maxEntriesPerService) throw new Error('service cache capacity exceeded')
    if (this.#countPhase('loading') >= this.#budget.maxLoading) throw new Error('loading capacity exceeded')
    const entry: Entry = Object.freeze({ ...request, cacheKey, serviceId, layerId, phase: 'loading', actualBytes: 0, sequence: this.#sequence++, expiresAt: request.requestedAt + this.#budget.loadingTtlMs })
    this.#entries.set(cacheKey, entry); this.#revisions.set(layerId, request.revision)
    return this.#view(entry)
  }

  complete(cacheKey: string, revision: number, actualBytes: number, now: number): Readonly<ArcGisCacheEntryView> {
    this.#active(); const key = id('cacheKey', cacheKey); integer('revision', revision); integer('actualBytes', actualBytes); finite('now', now)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'loading') throw new Error('cache entry is not loading')
    if (entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) { this.#entries.delete(key); throw new Error('stale cache completion') }
    if (now > entry.expiresAt) { this.#entries.delete(key); throw new Error('expired cache completion') }
    if (actualBytes > this.#budget.maxBytesPerEntry) { this.#entries.delete(key); throw new Error('entry byte budget exceeded') }
    if (this.#countPhase('resident') >= this.#budget.maxResident) { this.#entries.delete(key); throw new Error('resident capacity exceeded') }
    if (this.#residentBytes() + actualBytes > this.#budget.maxResidentBytes) { this.#entries.delete(key); throw new Error('resident byte budget exceeded') }
    const resident: Entry = Object.freeze({ ...entry, phase: 'resident', actualBytes, expiresAt: now + this.#budget.residentTtlMs })
    this.#entries.set(key, resident); return this.#view(resident)
  }

  touch(cacheKey: string, now: number): boolean {
    this.#active(); const key = id('cacheKey', cacheKey); finite('now', now); const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'resident' || now > entry.expiresAt) return false
    this.#entries.set(key, Object.freeze({ ...entry, expiresAt: now + this.#budget.residentTtlMs })); return true
  }

  consume(cacheKey: string, revision: number): Readonly<ArcGisCacheEntryView> | undefined {
    this.#active(); const key = id('cacheKey', cacheKey); integer('revision', revision); const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'resident' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return undefined
    this.#entries.delete(key); return this.#view(entry)
  }

  invalidate(cacheKey: string): boolean { this.#active(); return this.#entries.delete(id('cacheKey', cacheKey)) }

  advanceLayerRevision(layerId: string, revision: number): number {
    this.#active(); const layer = id('layerId', layerId); integer('revision', revision); const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) throw new Error('revision cannot move backwards')
    if (current === revision) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer && entry.revision < revision) { this.#entries.delete(key); removed++ }
    this.#revisions.set(layer, revision); return removed
  }

  releaseLayer(layerId: string): number {
    this.#active(); const layer = id('layerId', layerId); let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer) { this.#entries.delete(key); removed++ }
    this.#revisions.delete(layer); return removed
  }

  releaseService(serviceId: string): number {
    this.#active(); const service = id('serviceId', serviceId); let removed = 0; const layers = new Set<string>()
    for (const [key, entry] of this.#entries) if (entry.serviceId === service) { layers.add(entry.layerId); this.#entries.delete(key); removed++ }
    for (const layer of layers) if (![...this.#entries.values()].some(entry => entry.layerId === layer)) this.#revisions.delete(layer)
    return removed
  }

  expire(now: number): number {
    this.#active(); finite('now', now); let removed = 0
    for (const [key, entry] of this.#entries) if (now > entry.expiresAt) { this.#entries.delete(key); removed++ }
    return removed
  }

  evictToBudget(targetBytes: number): readonly string[] {
    this.#active(); integer('targetBytes', targetBytes); const evicted: string[] = []
    const residents = [...this.#entries.values()].filter(e => e.phase === 'resident').sort((a,b) => priority[a.intent]-priority[b.intent] || a.expiresAt-b.expiresAt || a.sequence-b.sequence || a.cacheKey.localeCompare(b.cacheKey))
    let bytes = this.#residentBytes()
    for (const entry of residents) { if (bytes <= targetBytes) break; this.#entries.delete(entry.cacheKey); bytes -= entry.actualBytes; evicted.push(entry.cacheKey) }
    return Object.freeze(evicted)
  }

  snapshot(): readonly Readonly<ArcGisCacheEntryView>[] { this.#active(); return Object.freeze([...this.#entries.values()].sort((a,b)=>a.sequence-b.sequence).map(e=>this.#view(e))) }
  fingerprint(): string { this.#active(); return [...this.#entries.values()].sort((a,b)=>a.cacheKey.localeCompare(b.cacheKey)).map(e=>[e.cacheKey,e.serviceId,e.layerId,e.revision,e.intent,e.phase,e.actualBytes].join(':')).join('|') }
  dispose(): void { this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }
  #countService(serviceId:string):number { let n=0; for(const e of this.#entries.values()) if(e.serviceId===serviceId)n++; return n }
  #countPhase(phase:ArcGisCachePhase):number { let n=0; for(const e of this.#entries.values()) if(e.phase===phase)n++; return n }
  #residentBytes():number { let n=0; for(const e of this.#entries.values()) if(e.phase==='resident')n+=e.actualBytes; return n }
  #view(e:Entry):Readonly<ArcGisCacheEntryView>{ return Object.freeze({cacheKey:e.cacheKey,serviceId:e.serviceId,layerId:e.layerId,revision:e.revision,intent:e.intent,phase:e.phase,estimatedBytes:e.estimatedBytes,actualBytes:e.actualBytes,sequence:e.sequence,expiresAt:e.expiresAt}) }
  #active():void { if(this.#disposed) throw new Error('ArcGisCacheResidencyPolicy is disposed') }
}
