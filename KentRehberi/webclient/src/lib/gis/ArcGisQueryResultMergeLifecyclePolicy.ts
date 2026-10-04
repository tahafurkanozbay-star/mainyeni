export type QueryMergeIntent = 'interactive' | 'visible' | 'background'
export type QueryMergePhase = 'collecting' | 'complete'

export interface QueryMergeBudget {
  maxLayers: number
  maxQueries: number
  maxQueriesPerLayer: number
  maxPagesPerQuery: number
  maxFeaturesPerQuery: number
  maxBytesPerQuery: number
  maxResidentFeatures: number
  maxResidentBytes: number
  queryTtlMs: number
}

export interface QueryMergeRequest {
  mergeId: string
  queryKey: string
  layerId: string
  revision: number
  intent: QueryMergeIntent
  requestedAt: number
}

export interface QueryMergePage {
  pageIndex: number
  featureCount: number
  estimatedBytes: number
  exceededTransferLimit: boolean
}

export interface QueryMergeView extends QueryMergeRequest {
  readonly phase: QueryMergePhase
  readonly sequence: number
  readonly pages: number
  readonly featureCount: number
  readonly estimatedBytes: number
  readonly nextPageIndex: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface MergeEntry extends QueryMergeRequest {
  phase: QueryMergePhase
  sequence: number
  pages: number
  featureCount: number
  estimatedBytes: number
  nextPageIndex: number
  touchedAt: number
  expiresAt: number
}

const intents: readonly QueryMergeIntent[] = ['interactive', 'visible', 'background']
const rank: Readonly<Record<QueryMergeIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })

function id(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f]/.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}
function integer(name: string, value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`)
}
function clock(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

/**
 * Payload-free authority for merging ArcGIS REST paged query results.
 * Feature payloads stay with the caller; this class retains only scalar accounting
 * required to reject stale/out-of-order pages and bound aggregate residency.
 */
export class ArcGisQueryResultMergeLifecyclePolicy {
  readonly #budget: Readonly<QueryMergeBudget>
  readonly #entries = new Map<string, MergeEntry>()
  readonly #queryKeys = new Map<string, string>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: QueryMergeBudget) {
    for (const key of ['maxLayers','maxQueries','maxQueriesPerLayer','maxPagesPerQuery','maxFeaturesPerQuery','maxBytesPerQuery','maxResidentFeatures','maxResidentBytes'] as const) integer(key, budget[key], 1)
    clock('queryTtlMs', budget.queryTtlMs)
    if (budget.maxQueriesPerLayer > budget.maxQueries) throw new Error('maxQueriesPerLayer exceeds maxQueries')
    if (budget.maxFeaturesPerQuery > budget.maxResidentFeatures) throw new Error('maxFeaturesPerQuery exceeds maxResidentFeatures')
    if (budget.maxBytesPerQuery > budget.maxResidentBytes) throw new Error('maxBytesPerQuery exceeds maxResidentBytes')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#live(); const layer = id('layerId', layerId); integer('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, revision)
    if (current === undefined || current === revision) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer && entry.revision !== revision) { this.#remove(key); removed++ }
    return removed
  }

  admit(request: QueryMergeRequest): boolean {
    this.#live()
    const mergeId = id('mergeId', request.mergeId), queryKey = id('queryKey', request.queryKey), layerId = id('layerId', request.layerId)
    integer('revision', request.revision); clock('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(mergeId)) return false
    const logical = this.#logical(layerId, request.revision, queryKey)
    if (this.#queryKeys.has(logical)) return false
    if (this.#entries.size >= this.#budget.maxQueries || this.#layerCount(layerId) >= this.#budget.maxQueriesPerLayer) return false
    const entry: MergeEntry = { ...request, mergeId, queryKey, layerId, phase:'collecting', sequence:++this.#sequence, pages:0, featureCount:0, estimatedBytes:0, nextPageIndex:0, touchedAt:request.requestedAt, expiresAt:request.requestedAt + this.#budget.queryTtlMs }
    this.#entries.set(mergeId, entry); this.#queryKeys.set(logical, mergeId); return true
  }

  append(mergeId: string, revision: number, page: QueryMergePage, now: number): QueryMergeView | null {
    this.#live(); const key=id('mergeId',mergeId); integer('revision',revision); integer('pageIndex',page.pageIndex); integer('featureCount',page.featureCount); integer('estimatedBytes',page.estimatedBytes); clock('now',now)
    this.expire(now)
    const entry=this.#entries.get(key)
    if(!entry || entry.phase!=='collecting' || entry.revision!==revision || this.#revisions.get(entry.layerId)!==revision || page.pageIndex!==entry.nextPageIndex) return null
    if(entry.pages+1>this.#budget.maxPagesPerQuery || entry.featureCount+page.featureCount>this.#budget.maxFeaturesPerQuery || entry.estimatedBytes+page.estimatedBytes>this.#budget.maxBytesPerQuery) return null
    if(this.#residentFeatures()+page.featureCount>this.#budget.maxResidentFeatures || this.#residentBytes()+page.estimatedBytes>this.#budget.maxResidentBytes) {
      this.#evictFor(entry, page.featureCount, page.estimatedBytes)
      if(!this.#entries.has(key) || this.#residentFeatures()+page.featureCount>this.#budget.maxResidentFeatures || this.#residentBytes()+page.estimatedBytes>this.#budget.maxResidentBytes) return null
    }
    entry.pages++; entry.featureCount+=page.featureCount; entry.estimatedBytes+=page.estimatedBytes; entry.nextPageIndex++; entry.touchedAt=now; entry.expiresAt=now+this.#budget.queryTtlMs
    if(!page.exceededTransferLimit) entry.phase='complete'
    return this.#view(entry)
  }

  touch(mergeId:string,revision:number,now:number):boolean{this.#live();const e=this.#entries.get(id('mergeId',mergeId));integer('revision',revision);clock('now',now);this.expire(now);if(!e||e.revision!==revision||this.#revisions.get(e.layerId)!==revision)return false;e.touchedAt=now;e.expiresAt=now+this.#budget.queryTtlMs;return true}
  consume(mergeId:string,revision:number):QueryMergeView|null{this.#live();const key=id('mergeId',mergeId);integer('revision',revision);const e=this.#entries.get(key);if(!e||e.phase!=='complete'||e.revision!==revision||this.#revisions.get(e.layerId)!==revision)return null;const view=this.#view(e);this.#remove(key);return view}
  cancel(mergeId:string):boolean{this.#live();const key=id('mergeId',mergeId);if(!this.#entries.has(key))return false;this.#remove(key);return true}
  releaseLayer(layerId:string):number{this.#live();const layer=id('layerId',layerId);let n=0;for(const[key,e]of this.#entries)if(e.layerId===layer){this.#remove(key);n++}this.#revisions.delete(layer);return n}
  expire(now:number):number{this.#live();clock('now',now);let n=0;for(const[key,e]of this.#entries)if(e.expiresAt<=now){this.#remove(key);n++}return n}
  snapshot():Readonly<{layers:number;queries:number;collecting:number;complete:number;pages:number;features:number;bytes:number}>{this.#live();let pages=0,features=0,bytes=0,collecting=0,complete=0;for(const e of this.#entries.values()){pages+=e.pages;features+=e.featureCount;bytes+=e.estimatedBytes;e.phase==='collecting'?collecting++:complete++}return Object.freeze({layers:this.#revisions.size,queries:this.#entries.size,collecting,complete,pages,features,bytes})}
  fingerprint():string{this.#live();return[...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.queryKey.localeCompare(b.queryKey)).map(e=>`${e.layerId}:${e.queryKey}:${e.revision}:${e.intent}:${e.phase}:${e.pages}:${e.featureCount}:${e.estimatedBytes}`).join('|')}
  dispose():void{if(this.#disposed)return;this.#entries.clear();this.#queryKeys.clear();this.#revisions.clear();this.#disposed=true}

  #evictFor(protectedEntry:MergeEntry,features:number,bytes:number):void{const candidates=[...this.#entries.values()].filter(e=>e.mergeId!==protectedEntry.mergeId).sort((a,b)=>rank[a.intent]-rank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence);for(const e of candidates){if(this.#residentFeatures()+features<=this.#budget.maxResidentFeatures&&this.#residentBytes()+bytes<=this.#budget.maxResidentBytes)break;this.#remove(e.mergeId)}}
  #remove(key:string):void{const e=this.#entries.get(key);if(!e)return;this.#entries.delete(key);this.#queryKeys.delete(this.#logical(e.layerId,e.revision,e.queryKey))}
  #logical(layer:string,revision:number,query:string):string{return`${layer}\u0000${revision}\u0000${query}`}
  #layerCount(layer:string):number{let n=0;for(const e of this.#entries.values())if(e.layerId===layer)n++;return n}
  #residentFeatures():number{let n=0;for(const e of this.#entries.values())n+=e.featureCount;return n}
  #residentBytes():number{let n=0;for(const e of this.#entries.values())n+=e.estimatedBytes;return n}
  #view(e:MergeEntry):QueryMergeView{return Object.freeze({mergeId:e.mergeId,queryKey:e.queryKey,layerId:e.layerId,revision:e.revision,intent:e.intent,requestedAt:e.requestedAt,phase:e.phase,sequence:e.sequence,pages:e.pages,featureCount:e.featureCount,estimatedBytes:e.estimatedBytes,nextPageIndex:e.nextPageIndex,touchedAt:e.touchedAt,expiresAt:e.expiresAt})}
  #live():void{if(this.#disposed)throw new Error('query result merge lifecycle policy is disposed')}
}
