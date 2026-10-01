export type ArcGisSceneAssetKind = 'building' | 'mesh' | 'elevation' | 'symbol'
export type ArcGisSceneAssetIntent = 'visible' | 'prefetch' | 'background'
export type ArcGisSceneAssetState = 'queued' | 'resident'

export interface ArcGisSceneAssetBudget {
  maxViews: number
  maxAssets: number
  maxAssetsPerView: number
  maxResidentAssets: number
  maxGpuBytes: number
  maxGpuBytesPerAsset: number
  maxCpuBytes: number
  maxCpuBytesPerAsset: number
  maxTriangles: number
  maxTrianglesPerAsset: number
  maxLod: number
  queueTtlMs: number
  residentTtlMs: number
}

export interface ArcGisSceneAssetRequest {
  viewId: string
  assetId: string
  revision: number
  kind: ArcGisSceneAssetKind
  intent: ArcGisSceneAssetIntent
  requestedAt: number
  lod: number
  estimatedGpuBytes: number
  estimatedCpuBytes: number
  estimatedTriangles: number
}

export interface ArcGisSceneAssetEntry extends ArcGisSceneAssetRequest {
  state: ArcGisSceneAssetState
  sequence: number
  expiresAt: number
  actualGpuBytes: number
  actualCpuBytes: number
  actualTriangles: number
}

export interface ArcGisSceneAssetSnapshot {
  views: number
  assets: number
  queued: number
  resident: number
  estimatedGpuBytes: number
  estimatedCpuBytes: number
  estimatedTriangles: number
  actualGpuBytes: number
  actualCpuBytes: number
  actualTriangles: number
  fingerprint: string
}

const PRIORITY: Readonly<Record<ArcGisSceneAssetIntent, number>> = Object.freeze({ background:0,prefetch:1,visible:2 })
function integer(name:string,value:number,minimum:number):void { if(!Number.isSafeInteger(value)||value<minimum) throw new Error(`${name} must be a safe integer >= ${minimum}`) }
function finite(name:string,value:number,minimum:number):void { if(!Number.isFinite(value)||value<minimum) throw new Error(`${name} must be finite and >= ${minimum}`) }
function identifier(name:string,value:string):string { const normalized=value.trim(); if(normalized!==value||!normalized||normalized.length>192||normalized.includes('\u0000')) throw new Error(`${name} is invalid`); return normalized }
function hash(value:string):string { let result=2166136261; for(let i=0;i<value.length;i+=1){result^=value.charCodeAt(i);result=Math.imul(result,16777619)} return (result>>>0).toString(16).padStart(8,'0') }

export class ArcGisSceneAssetLifecyclePolicy {
  readonly #budget: Readonly<ArcGisSceneAssetBudget>
  readonly #entries = new Map<string,ArcGisSceneAssetEntry>()
  readonly #watermark = new Map<string,number>()
  #sequence=0
  #disposed=false

  constructor(budget:ArcGisSceneAssetBudget){
    for(const key of ['maxViews','maxAssets','maxAssetsPerView','maxResidentAssets','maxGpuBytes','maxGpuBytesPerAsset','maxCpuBytes','maxCpuBytesPerAsset','maxTriangles','maxTrianglesPerAsset','maxLod'] as const) integer(key,budget[key],1)
    finite('queueTtlMs',budget.queueTtlMs,1)
    finite('residentTtlMs',budget.residentTtlMs,1)
    if(budget.maxAssetsPerView>budget.maxAssets) throw new Error('per-view asset budget exceeds aggregate')
    if(budget.maxResidentAssets>budget.maxAssets) throw new Error('resident budget exceeds aggregate')
    if(budget.maxGpuBytesPerAsset>budget.maxGpuBytes) throw new Error('per-asset gpu budget exceeds aggregate')
    if(budget.maxCpuBytesPerAsset>budget.maxCpuBytes) throw new Error('per-asset cpu budget exceeds aggregate')
    if(budget.maxTrianglesPerAsset>budget.maxTriangles) throw new Error('per-asset triangle budget exceeds aggregate')
    this.#budget=Object.freeze({...budget})
  }

  admit(raw:ArcGisSceneAssetRequest):boolean{
    this.#assertLive()
    const request=this.#normalize(raw)
    const watermark=this.#watermark.get(request.viewId)
    if(watermark!==undefined&&request.revision<watermark) return false
    if(watermark===undefined||request.revision>watermark){this.#dropView(request.viewId);this.#watermark.set(request.viewId,request.revision)}
    const key=this.#key(request.viewId,request.assetId)
    const existing=this.#entries.get(key)
    if(existing){
      if(existing.revision!==request.revision||existing.state!=='queued'||PRIORITY[request.intent]<=PRIORITY[existing.intent]) return false
      const replacement:ArcGisSceneAssetEntry={...request,state:'queued',sequence:existing.sequence,expiresAt:request.requestedAt+this.#budget.queueTtlMs,actualGpuBytes:0,actualCpuBytes:0,actualTriangles:0}
      if(!this.#fits(replacement,existing)) return false
      this.#entries.set(key,replacement)
      return true
    }
    if(this.#entries.size>=this.#budget.maxAssets) return false
    const viewEntries=[...this.#entries.values()].filter(e=>e.viewId===request.viewId)
    if(viewEntries.length>=this.#budget.maxAssetsPerView) return false
    if(viewEntries.length===0&&new Set([...this.#entries.values()].map(e=>e.viewId)).size>=this.#budget.maxViews) return false
    const entry:ArcGisSceneAssetEntry={...request,state:'queued',sequence:this.#sequence++,expiresAt:request.requestedAt+this.#budget.queueTtlMs,actualGpuBytes:0,actualCpuBytes:0,actualTriangles:0}
    if(!this.#fits(entry)) return false
    this.#entries.set(key,entry)
    return true
  }

  nextQueued():Readonly<ArcGisSceneAssetEntry>|null{
    this.#assertLive()
    const entries=[...this.#entries.values()].filter(e=>e.state==='queued')
    entries.sort((a,b)=>PRIORITY[b.intent]-PRIORITY[a.intent]||a.lod-b.lod||a.requestedAt-b.requestedAt||a.sequence-b.sequence)
    return entries[0]?Object.freeze({...entries[0]}):null
  }

  markResident(viewId:string,assetId:string,revision:number,now:number,gpuBytes:number,cpuBytes:number,triangles:number):boolean{
    this.#assertLive()
    finite('now',now,0)
    integer('revision',revision,0)
    integer('gpuBytes',gpuBytes,0)
    integer('cpuBytes',cpuBytes,0)
    integer('triangles',triangles,0)
    const key=this.#key(identifier('viewId',viewId),identifier('assetId',assetId))
    const entry=this.#entries.get(key)
    if(!entry||entry.revision!==revision||entry.state!=='queued') return false
    if(now>entry.expiresAt){this.#entries.delete(key);return false}
    if(this.#countState('resident')>=this.#budget.maxResidentAssets) return false
    if(gpuBytes>this.#budget.maxGpuBytesPerAsset||cpuBytes>this.#budget.maxCpuBytesPerAsset||triangles>this.#budget.maxTrianglesPerAsset) return false
    if(this.#sumActual('actualGpuBytes')+gpuBytes>this.#budget.maxGpuBytes) return false
    if(this.#sumActual('actualCpuBytes')+cpuBytes>this.#budget.maxCpuBytes) return false
    if(this.#sumActual('actualTriangles')+triangles>this.#budget.maxTriangles) return false
    entry.state='resident'
    entry.actualGpuBytes=gpuBytes
    entry.actualCpuBytes=cpuBytes
    entry.actualTriangles=triangles
    entry.expiresAt=now+this.#budget.residentTtlMs
    return true
  }

  touch(viewId:string,assetId:string,revision:number,now:number):boolean{
    this.#assertLive();finite('now',now,0);integer('revision',revision,0)
    const entry=this.#entries.get(this.#key(identifier('viewId',viewId),identifier('assetId',assetId)))
    if(!entry||entry.revision!==revision||entry.state!=='resident') return false
    if(now>entry.expiresAt) return false
    entry.expiresAt=now+this.#budget.residentTtlMs
    return true
  }

  release(viewId:string,assetId:string):boolean{
    this.#assertLive()
    return this.#entries.delete(this.#key(identifier('viewId',viewId),identifier('assetId',assetId)))
  }

  expire(now:number):number{
    this.#assertLive();finite('now',now,0);let removed=0
    for(const [key,entry] of this.#entries) if(now>entry.expiresAt){this.#entries.delete(key);removed+=1}
    return removed
  }

  entriesForView(viewId:string):readonly Readonly<ArcGisSceneAssetEntry>[] {
    this.#assertLive();const id=identifier('viewId',viewId)
    return Object.freeze([...this.#entries.values()].filter(e=>e.viewId===id).sort((a,b)=>a.sequence-b.sequence).map(e=>Object.freeze({...e})))
  }

  snapshot():Readonly<ArcGisSceneAssetSnapshot>{
    this.#assertLive()
    const entries=[...this.#entries.values()]
    const canonical=entries.slice().sort((a,b)=>a.viewId.localeCompare(b.viewId)||a.assetId.localeCompare(b.assetId)).map(e=>[e.viewId,e.assetId,e.revision,e.kind,e.intent,e.state,e.lod,e.estimatedGpuBytes,e.estimatedCpuBytes,e.estimatedTriangles,e.actualGpuBytes,e.actualCpuBytes,e.actualTriangles])
    return Object.freeze({views:new Set(entries.map(e=>e.viewId)).size,assets:entries.length,queued:this.#countState('queued'),resident:this.#countState('resident'),estimatedGpuBytes:this.#sumEstimated('estimatedGpuBytes'),estimatedCpuBytes:this.#sumEstimated('estimatedCpuBytes'),estimatedTriangles:this.#sumEstimated('estimatedTriangles'),actualGpuBytes:this.#sumActual('actualGpuBytes'),actualCpuBytes:this.#sumActual('actualCpuBytes'),actualTriangles:this.#sumActual('actualTriangles'),fingerprint:hash(JSON.stringify(canonical))})
  }

  dispose():void{this.#entries.clear();this.#watermark.clear();this.#disposed=true}

  #normalize(raw:ArcGisSceneAssetRequest):ArcGisSceneAssetRequest{
    const request={...raw,viewId:identifier('viewId',raw.viewId),assetId:identifier('assetId',raw.assetId)}
    integer('revision',request.revision,0)
    finite('requestedAt',request.requestedAt,0)
    integer('lod',request.lod,0)
    integer('estimatedGpuBytes',request.estimatedGpuBytes,0)
    integer('estimatedCpuBytes',request.estimatedCpuBytes,0)
    integer('estimatedTriangles',request.estimatedTriangles,0)
    if(request.lod>this.#budget.maxLod) throw new Error('lod budget exceeded')
    if(!(request.intent in PRIORITY)) throw new Error('intent is invalid')
    if(!['building','mesh','elevation','symbol'].includes(request.kind)) throw new Error('kind is invalid')
    return request
  }
  #fits(candidate:ArcGisSceneAssetEntry,replacing?:ArcGisSceneAssetEntry):boolean{
    if(candidate.estimatedGpuBytes>this.#budget.maxGpuBytesPerAsset||candidate.estimatedCpuBytes>this.#budget.maxCpuBytesPerAsset||candidate.estimatedTriangles>this.#budget.maxTrianglesPerAsset) return false
    const gpu=this.#sumEstimated('estimatedGpuBytes')-(replacing?.estimatedGpuBytes??0)+candidate.estimatedGpuBytes
    const cpu=this.#sumEstimated('estimatedCpuBytes')-(replacing?.estimatedCpuBytes??0)+candidate.estimatedCpuBytes
    const triangles=this.#sumEstimated('estimatedTriangles')-(replacing?.estimatedTriangles??0)+candidate.estimatedTriangles
    return gpu<=this.#budget.maxGpuBytes&&cpu<=this.#budget.maxCpuBytes&&triangles<=this.#budget.maxTriangles
  }
  #sumEstimated(field:'estimatedGpuBytes'|'estimatedCpuBytes'|'estimatedTriangles'):number{let total=0;for(const entry of this.#entries.values())total+=entry[field];return total}
  #sumActual(field:'actualGpuBytes'|'actualCpuBytes'|'actualTriangles'):number{let total=0;for(const entry of this.#entries.values())total+=entry[field];return total}
  #countState(state:ArcGisSceneAssetState):number{let total=0;for(const entry of this.#entries.values())if(entry.state===state)total+=1;return total}
  #dropView(viewId:string):void{for(const [key,entry] of this.#entries)if(entry.viewId===viewId)this.#entries.delete(key)}
  #key(viewId:string,assetId:string):string{return `${viewId}\u0000${assetId}`}
  #assertLive():void{if(this.#disposed)throw new Error('ArcGisSceneAssetLifecyclePolicy is disposed')}
}
