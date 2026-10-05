export type QueryDedupeIntent = 'interactive' | 'visible' | 'background'
export type QueryDedupePhase = 'pending' | 'inflight' | 'cached'

export interface QueryDedupeBudget {
  maxLayers: number
  maxEntries: number
  maxEntriesPerLayer: number
  maxInflight: number
  maxInflightPerLayer: number
  maxCached: number
  maxCachedPerLayer: number
  maxFeaturesPerEntry: number
  maxBytesPerEntry: number
  maxCachedFeatures: number
  maxCachedBytes: number
  pendingTtlMs: number
  requestLeaseMs: number
  cacheTtlMs: number
}

export interface QueryDedupeRequest {
  requestId: string
  signature: string
  layerId: string
  revision: number
  intent: QueryDedupeIntent
  estimatedFeatures: number
  estimatedBytes: number
  requestedAt: number
}

export interface QueryDedupeView extends QueryDedupeRequest {
  readonly phase: QueryDedupePhase
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
  readonly features: number
  readonly bytes: number
}

interface Entry extends QueryDedupeRequest {
  phase: QueryDedupePhase
  sequence: number
  touchedAt: number
  expiresAt: number
  features: number
  bytes: number
}

const intents: readonly QueryDedupeIntent[] = ['interactive', 'visible', 'background']
const priority: Readonly<Record<QueryDedupeIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
function id(name:string,value:string):string { const v=value.trim(); if(!v||v.length>256||/[\u0000-\u001f]/.test(v)) throw new Error(`${name} is invalid`); return v }
function integer(name:string,value:number,min=0):void { if(!Number.isSafeInteger(value)||value<min) throw new Error(`${name} must be a safe integer >= ${min}`) }
function time(name:string,value:number):void { if(!Number.isFinite(value)||value<0) throw new Error(`${name} must be finite and non-negative`) }

/** Payload-free request coalescing and bounded result-cache authority for ArcGIS query work. */
export class ArcGisQueryDedupeLifecyclePolicy {
  readonly #budget: Readonly<QueryDedupeBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #signatures = new Map<string, string>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: QueryDedupeBudget) {
    for(const key of ['maxLayers','maxEntries','maxEntriesPerLayer','maxInflight','maxInflightPerLayer','maxCached','maxCachedPerLayer','maxFeaturesPerEntry','maxBytesPerEntry','maxCachedFeatures','maxCachedBytes'] as const) integer(key,budget[key],1)
    time('pendingTtlMs',budget.pendingTtlMs); time('requestLeaseMs',budget.requestLeaseMs); time('cacheTtlMs',budget.cacheTtlMs)
    if(budget.maxEntriesPerLayer>budget.maxEntries) throw new Error('maxEntriesPerLayer exceeds maxEntries')
    if(budget.maxInflight>budget.maxEntries||budget.maxCached>budget.maxEntries) throw new Error('phase budget exceeds maxEntries')
    if(budget.maxInflightPerLayer>budget.maxInflight||budget.maxInflightPerLayer>budget.maxEntriesPerLayer) throw new Error('maxInflightPerLayer exceeds parent budget')
    if(budget.maxCachedPerLayer>budget.maxCached||budget.maxCachedPerLayer>budget.maxEntriesPerLayer) throw new Error('maxCachedPerLayer exceeds parent budget')
    if(budget.maxCachedFeatures<budget.maxFeaturesPerEntry||budget.maxCachedBytes<budget.maxBytesPerEntry) throw new Error('aggregate cache budget must fit one entry')
    this.#budget=Object.freeze({...budget})
  }

  setRevision(layerId:string,next:number):number {
    this.#live(); const layer=id('layerId',layerId); integer('revision',next)
    const current=this.#revisions.get(layer)
    if(current!==undefined&&next<current) return -1
    if(current===undefined&&this.#revisions.size>=this.#budget.maxLayers) return -1
    this.#revisions.set(layer,next)
    if(current===undefined||current===next) return 0
    let removed=0
    for(const [requestId,e] of this.#entries) if(e.layerId===layer&&e.revision!==next){this.#remove(requestId);removed++}
    return removed
  }

  lookup(signature:string,layerId:string,revision:number,now:number):QueryDedupeView|null {
    this.#live(); const sig=id('signature',signature); const layer=id('layerId',layerId); integer('revision',revision); time('now',now); this.expire(now)
    const requestId=this.#signatures.get(this.#signatureKey(layer,revision,sig)); if(!requestId) return null
    const e=this.#entries.get(requestId); if(!e||e.phase!=='cached'||this.#revisions.get(layer)!==revision) return null
    e.touchedAt=now; e.expiresAt=now+this.#budget.cacheTtlMs; return this.#view(e)
  }

  admit(request:QueryDedupeRequest):'admitted'|'duplicate'|'rejected' {
    this.#live(); const requestId=id('requestId',request.requestId); const signature=id('signature',request.signature); const layerId=id('layerId',request.layerId)
    integer('revision',request.revision); integer('estimatedFeatures',request.estimatedFeatures,1); integer('estimatedBytes',request.estimatedBytes,1); time('requestedAt',request.requestedAt)
    if(!intents.includes(request.intent)) throw new Error('intent is invalid')
    if(this.#revisions.get(layerId)!==request.revision) return 'rejected'
    if(request.estimatedFeatures>this.#budget.maxFeaturesPerEntry||request.estimatedBytes>this.#budget.maxBytesPerEntry) return 'rejected'
    if(this.#entries.has(requestId)) return 'duplicate'
    const key=this.#signatureKey(layerId,request.revision,signature)
    if(this.#signatures.has(key)) return 'duplicate'
    if(this.#entries.size>=this.#budget.maxEntries||this.#layerCount(layerId)>=this.#budget.maxEntriesPerLayer) return 'rejected'
    const sequence=++this.#sequence
    const entry:Entry={...request,requestId,signature,layerId,phase:'pending',sequence,touchedAt:request.requestedAt,expiresAt:request.requestedAt+this.#budget.pendingTtlMs,features:request.estimatedFeatures,bytes:request.estimatedBytes}
    this.#entries.set(requestId,entry); this.#signatures.set(key,requestId); return 'admitted'
  }

  startNext(now:number):QueryDedupeView|null {
    this.#live(); time('now',now); this.expire(now)
    if(this.#phaseCount('inflight')>=this.#budget.maxInflight) return null
    let candidate:Entry|undefined
    for(const e of this.#entries.values()) {
      if(e.phase!=='pending'||this.#layerPhaseCount(e.layerId,'inflight')>=this.#budget.maxInflightPerLayer) continue
      if(!candidate||priority[e.intent]>priority[candidate.intent]||(priority[e.intent]===priority[candidate.intent]&&(e.requestedAt<candidate.requestedAt||(e.requestedAt===candidate.requestedAt&&e.sequence<candidate.sequence)))) candidate=e
    }
    if(!candidate) return null
    candidate.phase='inflight'; candidate.touchedAt=now; candidate.expiresAt=now+this.#budget.requestLeaseMs; return this.#view(candidate)
  }

  renew(requestId:string,revision:number,now:number):boolean {
    this.#live(); const e=this.#entries.get(id('requestId',requestId)); integer('revision',revision); time('now',now); this.expire(now)
    if(!e||e.phase!=='inflight'||e.revision!==revision||this.#revisions.get(e.layerId)!==revision) return false
    e.touchedAt=now; e.expiresAt=now+this.#budget.requestLeaseMs; return true
  }

  complete(requestId:string,revision:number,features:number,bytes:number,now:number):QueryDedupeView|null {
    this.#live(); const key=id('requestId',requestId); integer('revision',revision); integer('features',features); integer('bytes',bytes); time('now',now); this.expire(now)
    const e=this.#entries.get(key)
    if(!e||e.phase!=='inflight'||e.revision!==revision||this.#revisions.get(e.layerId)!==revision) return null
    if(features>this.#budget.maxFeaturesPerEntry||bytes>this.#budget.maxBytesPerEntry){this.#remove(key);return null}
    e.features=features; e.bytes=bytes
    while(this.#phaseCount('cached')>=this.#budget.maxCached||this.#layerPhaseCount(e.layerId,'cached')>=this.#budget.maxCachedPerLayer||this.#cachedFeatures()+features>this.#budget.maxCachedFeatures||this.#cachedBytes()+bytes>this.#budget.maxCachedBytes){
      const victim=this.#victim(e.layerId); if(!victim){this.#remove(key);return null}; this.#remove(victim.requestId)
    }
    e.phase='cached'; e.touchedAt=now; e.expiresAt=now+this.#budget.cacheTtlMs; return this.#view(e)
  }

  cancel(requestId:string):boolean { this.#live(); const key=id('requestId',requestId); if(!this.#entries.has(key))return false; this.#remove(key); return true }
  releaseLayer(layerId:string):number { this.#live(); const layer=id('layerId',layerId); let n=0; for(const [key,e] of this.#entries)if(e.layerId===layer){this.#remove(key);n++}; this.#revisions.delete(layer); return n }
  expire(now:number):number { this.#live(); time('now',now); let n=0; for(const [key,e] of this.#entries)if(e.expiresAt<=now){this.#remove(key);n++}; return n }
  snapshot():Readonly<{layers:number;entries:number;pending:number;inflight:number;cached:number;cachedFeatures:number;cachedBytes:number}> { this.#live(); return Object.freeze({layers:this.#revisions.size,entries:this.#entries.size,pending:this.#phaseCount('pending'),inflight:this.#phaseCount('inflight'),cached:this.#phaseCount('cached'),cachedFeatures:this.#cachedFeatures(),cachedBytes:this.#cachedBytes()}) }
  fingerprint():string { this.#live(); return [...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.sequence-b.sequence).map(e=>`${e.layerId}:${e.signature}:${e.revision}:${e.intent}:${e.phase}:${e.features}:${e.bytes}`).join('|') }
  dispose():void { if(this.#disposed)return; this.#entries.clear(); this.#signatures.clear(); this.#revisions.clear(); this.#disposed=true }
  #remove(requestId:string):void { const e=this.#entries.get(requestId); if(!e)return; this.#entries.delete(requestId); this.#signatures.delete(this.#signatureKey(e.layerId,e.revision,e.signature)) }
  #signatureKey(layerId:string,revision:number,signature:string):string { return `${layerId}\u0000${revision}\u0000${signature}` }
  #victim(preferred:string):Entry|undefined { const values=[...this.#entries.values()].filter(e=>e.phase==='cached'); values.sort((a,b)=>(a.layerId===preferred?0:1)-(b.layerId===preferred?0:1)||priority[a.intent]-priority[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence); return values[0] }
  #layerCount(layer:string):number { let n=0; for(const e of this.#entries.values())if(e.layerId===layer)n++; return n }
  #phaseCount(phase:QueryDedupePhase):number { let n=0; for(const e of this.#entries.values())if(e.phase===phase)n++; return n }
  #layerPhaseCount(layer:string,phase:QueryDedupePhase):number { let n=0; for(const e of this.#entries.values())if(e.layerId===layer&&e.phase===phase)n++; return n }
  #cachedFeatures():number { let n=0; for(const e of this.#entries.values())if(e.phase==='cached')n+=e.features; return n }
  #cachedBytes():number { let n=0; for(const e of this.#entries.values())if(e.phase==='cached')n+=e.bytes; return n }
  #view(e:Entry):QueryDedupeView { return Object.freeze({requestId:e.requestId,signature:e.signature,layerId:e.layerId,revision:e.revision,intent:e.intent,estimatedFeatures:e.estimatedFeatures,estimatedBytes:e.estimatedBytes,requestedAt:e.requestedAt,phase:e.phase,sequence:e.sequence,touchedAt:e.touchedAt,expiresAt:e.expiresAt,features:e.features,bytes:e.bytes}) }
  #live():void { if(this.#disposed)throw new Error('query dedupe lifecycle policy is disposed') }
}
