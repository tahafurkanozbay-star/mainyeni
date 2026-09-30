export type ArcGisProjectionState='queued'|'running'|'ready'
export interface ArcGisProjectionBudget{
 maxRequests:number
 maxRunning:number
 maxReady:number
 maxPoints:number
 maxPointsPerRequest:number
 maxEstimatedBytes:number
 maxEstimatedBytesPerRequest:number
 queueTtlMs:number
 runLeaseMs:number
 readyTtlMs:number
}
export interface ArcGisProjectionRequest{
 requestId:string
 revision:number
 requestedAt:number
 sourceWkid:number
 targetWkid:number
 pointCount:number
 estimatedBytes:number
}
export interface ArcGisProjectionEntry extends ArcGisProjectionRequest{
 state:ArcGisProjectionState
 sequence:number
 expiresAt:number
 resultBytes:number
}
export interface ArcGisProjectionSnapshot{
 requests:number
 queued:number
 running:number
 ready:number
 points:number
 estimatedBytes:number
 resultBytes:number
 revision:number
 fingerprint:string
}
function integer(name:string,value:number,minimum:number):void{
 if(!Number.isSafeInteger(value)||value<minimum)throw new Error(`${name} must be a safe integer >= ${minimum}`)
}
function finite(name:string,value:number,minimum:number):void{
 if(!Number.isFinite(value)||value<minimum)throw new Error(`${name} must be finite and >= ${minimum}`)
}
function identifier(value:string):string{
 const normalized=value.trim()
 if(normalized!==value||!normalized||normalized.length>192||normalized.includes('\u0000'))throw new Error('requestId is invalid')
 return normalized
}
function canonicalWkid(value:number):number{
 integer('wkid',value,1)
 return value===102100||value===102113||value===900913?3857:value
}
function hash(value:string):string{
 let result=2166136261
 for(let i=0;i<value.length;i+=1){result^=value.charCodeAt(i);result=Math.imul(result,16777619)}
 return(result>>>0).toString(16).padStart(8,'0')
}
export class ArcGisProjectionLifecyclePolicy{
 readonly #budget:Readonly<ArcGisProjectionBudget>
 readonly #entries=new Map<string,ArcGisProjectionEntry>()
 #revision=0
 #sequence=0
 #disposed=false
 constructor(budget:ArcGisProjectionBudget){
  for(const key of ['maxRequests','maxRunning','maxReady','maxPoints','maxPointsPerRequest','maxEstimatedBytes','maxEstimatedBytesPerRequest']as const)integer(key,budget[key],1)
  for(const key of ['queueTtlMs','runLeaseMs','readyTtlMs']as const)finite(key,budget[key],1)
  if(budget.maxRunning>budget.maxRequests||budget.maxReady>budget.maxRequests)throw new Error('state budget exceeds request budget')
  if(budget.maxPointsPerRequest>budget.maxPoints)throw new Error('per-request point budget exceeds aggregate')
  if(budget.maxEstimatedBytesPerRequest>budget.maxEstimatedBytes)throw new Error('per-request byte budget exceeds aggregate')
  this.#budget=Object.freeze({...budget})
 }
 admit(raw:ArcGisProjectionRequest):boolean{
  this.#assertLive()
  const request=this.#normalize(raw)
  if(request.revision<this.#revision)return false
  if(request.revision>this.#revision){this.#entries.clear();this.#revision=request.revision}
  if(this.#entries.has(request.requestId))return false
  if(this.#entries.size>=this.#budget.maxRequests)return false
  if(request.pointCount>this.#budget.maxPointsPerRequest||request.estimatedBytes>this.#budget.maxEstimatedBytesPerRequest)return false
  if(this.#sum('pointCount')+request.pointCount>this.#budget.maxPoints)return false
  if(this.#sum('estimatedBytes')+request.estimatedBytes>this.#budget.maxEstimatedBytes)return false
  this.#entries.set(request.requestId,{...request,state:'queued',sequence:this.#sequence++,expiresAt:request.requestedAt+this.#budget.queueTtlMs,resultBytes:0})
  return true
 }
 nextQueued():Readonly<ArcGisProjectionEntry>|null{
  this.#assertLive()
  const entries=[...this.#entries.values()].filter(e=>e.state==='queued').sort((a,b)=>a.pointCount-b.pointCount||a.requestedAt-b.requestedAt||a.sequence-b.sequence)
  return entries[0]?Object.freeze({...entries[0]}):null
 }
 begin(requestId:string,revision:number,now:number):boolean{
  this.#assertLive();integer('revision',revision,0);finite('now',now,0)
  const id=identifier(requestId);const entry=this.#entries.get(id)
  if(!entry||entry.revision!==revision||entry.state!=='queued')return false
  if(now>entry.expiresAt){this.#entries.delete(id);return false}
  if(this.#count('running')>=this.#budget.maxRunning)return false
  entry.state='running';entry.expiresAt=now+this.#budget.runLeaseMs
  return true
 }
 markReady(requestId:string,revision:number,now:number,resultBytes:number):boolean{
  this.#assertLive();integer('revision',revision,0);finite('now',now,0);integer('resultBytes',resultBytes,0)
  const id=identifier(requestId);const entry=this.#entries.get(id)
  if(!entry||entry.revision!==revision||entry.state!=='running')return false
  if(now>entry.expiresAt){this.#entries.delete(id);return false}
  if(this.#count('ready')>=this.#budget.maxReady)return false
  if(resultBytes>this.#budget.maxEstimatedBytesPerRequest)return false
  entry.state='ready';entry.resultBytes=resultBytes;entry.expiresAt=now+this.#budget.readyTtlMs
  return true
 }
 consume(requestId:string,revision:number):boolean{
  this.#assertLive();integer('revision',revision,0)
  const id=identifier(requestId);const entry=this.#entries.get(id)
  if(!entry||entry.revision!==revision||entry.state!=='ready')return false
  this.#entries.delete(id);return true
 }
 cancel(requestId:string):boolean{
  this.#assertLive();return this.#entries.delete(identifier(requestId))
 }
 expire(now:number):number{
  this.#assertLive();finite('now',now,0);let removed=0
  for(const[id,entry]of this.#entries)if(now>entry.expiresAt){this.#entries.delete(id);removed+=1}
  return removed
 }
 entries():readonly Readonly<ArcGisProjectionEntry>[] {
  this.#assertLive()
  return Object.freeze([...this.#entries.values()].sort((a,b)=>a.sequence-b.sequence).map(e=>Object.freeze({...e})))
 }
 snapshot():Readonly<ArcGisProjectionSnapshot>{
  this.#assertLive()
  const entries=[...this.#entries.values()]
  const canonical=entries.slice().sort((a,b)=>a.requestId.localeCompare(b.requestId)).map(e=>[e.requestId,e.revision,e.sourceWkid,e.targetWkid,e.pointCount,e.estimatedBytes,e.state,e.resultBytes])
  return Object.freeze({requests:entries.length,queued:this.#count('queued'),running:this.#count('running'),ready:this.#count('ready'),points:this.#sum('pointCount'),estimatedBytes:this.#sum('estimatedBytes'),resultBytes:this.#sum('resultBytes'),revision:this.#revision,fingerprint:hash(JSON.stringify(canonical))})
 }
 dispose():void{
  this.#entries.clear();this.#disposed=true
 }
 #normalize(raw:ArcGisProjectionRequest):ArcGisProjectionRequest{
  const request={...raw,requestId:identifier(raw.requestId),sourceWkid:canonicalWkid(raw.sourceWkid),targetWkid:canonicalWkid(raw.targetWkid)}
  integer('revision',request.revision,0);finite('requestedAt',request.requestedAt,0);integer('pointCount',request.pointCount,1);integer('estimatedBytes',request.estimatedBytes,0)
  if(request.sourceWkid===request.targetWkid)throw new Error('projection requires distinct spatial references')
  return request
 }
 #sum(field:'pointCount'|'estimatedBytes'|'resultBytes'):number{
  let total=0;for(const entry of this.#entries.values())total+=entry[field];return total
 }
 #count(state:ArcGisProjectionState):number{
  let total=0;for(const entry of this.#entries.values())if(entry.state===state)total+=1;return total
 }
 #assertLive():void{
  if(this.#disposed)throw new Error('ArcGisProjectionLifecyclePolicy is disposed')
 }
}
