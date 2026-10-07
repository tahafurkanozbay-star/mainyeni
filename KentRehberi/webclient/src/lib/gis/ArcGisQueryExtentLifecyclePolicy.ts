export type ArcGisExtentIntent = "interactive" | "visible" | "background";

export interface ArcGisExtentBudget {
  maxLayers: number;
  maxQueued: number;
  maxRunning: number;
  maxRunningPerLayer: number;
  maxResident: number;
  queueTtlMs: number;
  leaseTtlMs: number;
  residentTtlMs: number;
}
export interface ArcGisExtentRequest {
  requestId: string; layerId: string; revision: number; signature: string;
  intent: ArcGisExtentIntent; queuedAt: number;
}
export interface ArcGisExtentLease {
  readonly requestId: string; readonly layerId: string; readonly revision: number;
  readonly signature: string; readonly intent: ArcGisExtentIntent; readonly expiresAt: number;
}
export interface ArcGisExtentValue {
  xmin: number; ymin: number; xmax: number; ymax: number; spatialReferenceWkid: number;
}
export interface ArcGisExtentCompletion extends ArcGisExtentValue {
  requestId: string; revision: number; completedAt: number;
}
export interface ArcGisExtentResident extends Readonly<ArcGisExtentValue> {
  readonly layerId: string; readonly revision: number; readonly signature: string;
  readonly capturedAt: number; readonly expiresAt: number;
}
type Queued = ArcGisExtentRequest & { sequence:number; expiresAt:number };
type Running = Queued & { leaseExpiresAt:number };
type Resident = ArcGisExtentResident & { requestId:string; touchedAt:number; sequence:number };

const priority: Readonly<Record<ArcGisExtentIntent,number>> = Object.freeze({interactive:2,visible:1,background:0});
const intents: readonly ArcGisExtentIntent[] = ["interactive","visible","background"];
function id(name:string,value:string,max=2048){const v=value.trim();if(!v||v.length>max||/[\u0000-\u001f\u007f]/.test(v))throw new Error(`${name} is invalid`);return v}
function nat(name:string,value:number){if(!Number.isSafeInteger(value)||value<0)throw new Error(`${name} must be a non-negative safe integer`);return value}
function pos(name:string,value:number){if(!Number.isSafeInteger(value)||value<1)throw new Error(`${name} must be a positive safe integer`);return value}
function time(name:string,value:number){if(!Number.isFinite(value)||value<0)throw new Error(`${name} must be finite and non-negative`);return value}
function coordinate(name:string,value:number){if(!Number.isFinite(value))throw new Error(`${name} must be finite`);return value}

export class ArcGisQueryExtentLifecyclePolicy {
  readonly #budget: Readonly<ArcGisExtentBudget>;
  readonly #revisions=new Map<string,number>();
  readonly #queued=new Map<string,Queued>();
  readonly #running=new Map<string,Running>();
  readonly #resident=new Map<string,Resident>();
  #sequence=0; #disposed=false;
  constructor(budget:ArcGisExtentBudget){
    for(const key of ["maxLayers","maxQueued","maxRunning","maxRunningPerLayer","maxResident","queueTtlMs","leaseTtlMs","residentTtlMs"] as const)pos(key,budget[key]);
    if(budget.maxRunningPerLayer>budget.maxRunning)throw new Error("maxRunningPerLayer cannot exceed maxRunning");
    this.#budget=Object.freeze({...budget});
  }
  setRevision(layerId:string,revision:number):number{
    this.#live();const layer=id("layerId",layerId,512);nat("revision",revision);const current=this.#revisions.get(layer);
    if(current!==undefined&&revision<current)return -1;if(current===revision)return 0;
    if(current===undefined&&this.#revisions.size>=this.#budget.maxLayers)throw new Error("maxLayers exceeded");
    this.#revisions.set(layer,revision);let removed=0;
    for(const map of [this.#queued,this.#running,this.#resident])for(const [key,item] of map)if(item.layerId===layer&&item.revision!==revision){map.delete(key);removed++}
    return removed;
  }
  enqueue(request:ArcGisExtentRequest):"queued"|"deduped"|"rejected"{
    this.#live();const item=this.#normalize(request);this.expire(item.queuedAt);
    if(this.#revisions.get(item.layerId)!==item.revision)return "rejected";
    const collision=this.#queued.get(item.requestId)??this.#running.get(item.requestId)??[...this.#resident.values()].find(x=>x.requestId===item.requestId);
    if(collision)return this.#same(collision,item)?"deduped":"rejected";
    if(this.#logicalExists(item))return "deduped";
    if(this.#queued.size>=this.#budget.maxQueued&&!this.#evictQueued(item.intent))return "rejected";
    this.#queued.set(item.requestId,{...item,sequence:++this.#sequence,expiresAt:item.queuedAt+this.#budget.queueTtlMs});return "queued";
  }
  acquire(now:number):ArcGisExtentLease|null{
    this.#live();time("now",now);this.expire(now);if(this.#running.size>=this.#budget.maxRunning)return null;
    const next=[...this.#queued.values()].filter(x=>this.#runningFor(x.layerId)<this.#budget.maxRunningPerLayer)
      .sort((a,b)=>priority[b.intent]-priority[a.intent]||a.sequence-b.sequence||a.requestId.localeCompare(b.requestId))[0];
    if(!next)return null;this.#queued.delete(next.requestId);
    const running:Running={...next,leaseExpiresAt:now+this.#budget.leaseTtlMs};this.#running.set(next.requestId,running);return this.#lease(running);
  }
  renew(requestId:string,revision:number,now:number):ArcGisExtentLease|null{
    this.#live();const key=id("requestId",requestId,512);nat("revision",revision);time("now",now);const item=this.#running.get(key);
    if(!item||item.revision!==revision||this.#revisions.get(item.layerId)!==revision||now>=item.leaseExpiresAt)return null;
    item.leaseExpiresAt=now+this.#budget.leaseTtlMs;return this.#lease(item);
  }
  complete(result:ArcGisExtentCompletion):ArcGisExtentResident|null{
    this.#live();const key=id("requestId",result.requestId,512);nat("revision",result.revision);time("completedAt",result.completedAt);
    const xmin=coordinate("xmin",result.xmin),ymin=coordinate("ymin",result.ymin),xmax=coordinate("xmax",result.xmax),ymax=coordinate("ymax",result.ymax);
    pos("spatialReferenceWkid",result.spatialReferenceWkid);if(xmin>xmax||ymin>ymax)throw new Error("extent bounds are invalid");
    const item=this.#running.get(key);if(!item||item.revision!==result.revision||this.#revisions.get(item.layerId)!==result.revision||result.completedAt>=item.leaseExpiresAt)return null;
    this.#running.delete(key);const logical=this.#logicalKey(item);
    const resident:Resident={requestId:key,layerId:item.layerId,revision:item.revision,signature:item.signature,xmin,ymin,xmax,ymax,
      spatialReferenceWkid:result.spatialReferenceWkid,capturedAt:result.completedAt,expiresAt:result.completedAt+this.#budget.residentTtlMs,touchedAt:result.completedAt,sequence:item.sequence};
    this.#resident.set(logical,resident);this.#trim(logical);return this.#view(resident);
  }
  lookup(layerId:string,revision:number,signature:string,now:number):ArcGisExtentResident|null{
    this.#live();const probe={layerId:id("layerId",layerId,512),revision:nat("revision",revision),signature:id("signature",signature)};time("now",now);this.expire(now);
    if(this.#revisions.get(probe.layerId)!==revision)return null;const item=this.#resident.get(this.#logicalKey(probe));if(!item)return null;
    item.touchedAt=now;item.expiresAt=now+this.#budget.residentTtlMs;return this.#view(item);
  }
  cancel(requestId:string):boolean{this.#live();const key=id("requestId",requestId,512);return this.#queued.delete(key)||this.#running.delete(key)}
  releaseLayer(layerId:string):number{this.#live();const layer=id("layerId",layerId,512);let n=0;for(const map of [this.#queued,this.#running,this.#resident])for(const [key,x] of map)if(x.layerId===layer){map.delete(key);n++}this.#revisions.delete(layer);return n}
  expire(now:number):number{this.#live();time("now",now);let n=0;for(const [k,x] of this.#queued)if(now>=x.expiresAt){this.#queued.delete(k);n++}for(const [k,x] of this.#running)if(now>=x.leaseExpiresAt){this.#running.delete(k);n++}for(const [k,x] of this.#resident)if(now>=x.expiresAt){this.#resident.delete(k);n++}return n}
  snapshot(){this.#live();return Object.freeze({layers:this.#revisions.size,queued:this.#queued.size,running:this.#running.size,resident:this.#resident.size})}
  fingerprint(){this.#live();return [...this.#resident.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.signature.localeCompare(b.signature)).map(x=>`${x.layerId}:${x.revision}:${x.signature}:${x.xmin},${x.ymin},${x.xmax},${x.ymax}:${x.spatialReferenceWkid}`).join("|")}
  dispose(){if(this.#disposed)return;this.#queued.clear();this.#running.clear();this.#resident.clear();this.#revisions.clear();this.#disposed=true}
  #normalize(r:ArcGisExtentRequest):ArcGisExtentRequest{if(!intents.includes(r.intent))throw new Error("intent is invalid");return{requestId:id("requestId",r.requestId,512),layerId:id("layerId",r.layerId,512),revision:nat("revision",r.revision),signature:id("signature",r.signature),intent:r.intent,queuedAt:time("queuedAt",r.queuedAt)}}
  #logicalKey(x:{layerId:string;revision:number;signature:string}){return JSON.stringify([x.layerId,x.revision,x.signature])}
  #same(a:{layerId:string;revision:number;signature:string},b:{layerId:string;revision:number;signature:string}){return a.layerId===b.layerId&&a.revision===b.revision&&a.signature===b.signature}
  #logicalExists(x:ArcGisExtentRequest){const k=this.#logicalKey(x);return [...this.#queued.values(),...this.#running.values()].some(v=>this.#logicalKey(v)===k)||this.#resident.has(k)}
  #runningFor(layer:string){let n=0;for(const x of this.#running.values())if(x.layerId===layer)n++;return n}
  #evictQueued(intent:ArcGisExtentIntent){const victim=[...this.#queued.values()].filter(x=>priority[x.intent]<=priority[intent]).sort((a,b)=>priority[a.intent]-priority[b.intent]||a.sequence-b.sequence||a.requestId.localeCompare(b.requestId))[0];if(!victim)return false;this.#queued.delete(victim.requestId);return true}
  #trim(protectedKey:string){while(this.#resident.size>this.#budget.maxResident){const victim=[...this.#resident.entries()].filter(([k])=>k!==protectedKey).sort((a,b)=>a[1].touchedAt-b[1].touchedAt||a[1].sequence-b[1].sequence||a[0].localeCompare(b[0]))[0];if(!victim){this.#resident.delete(protectedKey);return}this.#resident.delete(victim[0])}}
  #lease(x:Running):ArcGisExtentLease{return Object.freeze({requestId:x.requestId,layerId:x.layerId,revision:x.revision,signature:x.signature,intent:x.intent,expiresAt:x.leaseExpiresAt})}
  #view(x:Resident):ArcGisExtentResident{return Object.freeze({layerId:x.layerId,revision:x.revision,signature:x.signature,xmin:x.xmin,ymin:x.ymin,xmax:x.xmax,ymax:x.ymax,spatialReferenceWkid:x.spatialReferenceWkid,capturedAt:x.capturedAt,expiresAt:x.expiresAt})}
  #live(){if(this.#disposed)throw new Error("ArcGisQueryExtentLifecyclePolicy is disposed")}
}
