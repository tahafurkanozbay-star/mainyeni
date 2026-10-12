export type DistinctValueIntent = 'interactive' | 'visible' | 'background'

export interface DistinctValueBudget {
  maxLayers: number
  maxQueries: number
  maxQueriesPerLayer: number
  maxFieldsPerQuery: number
  maxValuesPerQuery: number
  maxBytesPerQuery: number
  maxResidentValues: number
  maxResidentBytes: number
  ttlMs: number
}
export interface DistinctValueRequest { queryId:string; layerId:string; revision:number; fields:readonly string[]; intent:DistinctValueIntent; requestedAt:number }
export interface DistinctValueView { readonly queryId:string; readonly layerId:string; readonly revision:number; readonly fields:readonly string[]; readonly intent:DistinctValueIntent; readonly values:number; readonly bytes:number; readonly touchedAt:number; readonly expiresAt:number }
interface Entry extends DistinctValueView { sequence:number }
const rank:Readonly<Record<DistinctValueIntent,number>>=Object.freeze({interactive:2,visible:1,background:0})
function id(name:string,value:string):string{const v=value.trim();if(!v||v.length>192||/[\u0000-\u001f]/.test(v))throw new Error(`${name} is invalid`);return v}
function integer(name:string,value:number,min=0):void{if(!Number.isSafeInteger(value)||value<min)throw new Error(`${name} must be a safe integer >= ${min}`)}
function clock(name:string,value:number):void{if(!Number.isFinite(value)||value<0)throw new Error(`${name} must be finite and non-negative`)}
function canonicalFields(fields:readonly string[],max:number):readonly string[]{if(!Array.isArray(fields)||fields.length===0||fields.length>max)throw new Error('fields exceed budget');const values=fields.map((field)=>id('field',field));if(new Set(values).size!==values.length)throw new Error('fields must be unique');return Object.freeze([...values].sort((a,b)=>a.localeCompare(b)))}

/** Payload-free authority for ArcGIS REST returnDistinctValues query result residency. */
export class ArcGisQueryDistinctValueLifecyclePolicy {
  readonly #budget:Readonly<DistinctValueBudget>;readonly #entries=new Map<string,Entry>();readonly #revisions=new Map<string,number>();#sequence=0;#disposed=false
  constructor(budget:DistinctValueBudget){for(const key of ['maxLayers','maxQueries','maxQueriesPerLayer','maxFieldsPerQuery','maxValuesPerQuery','maxBytesPerQuery','maxResidentValues','maxResidentBytes'] as const)integer(key,budget[key],1);clock('ttlMs',budget.ttlMs);if(budget.ttlMs===0)throw new Error('ttlMs must be positive');if(budget.maxQueriesPerLayer>budget.maxQueries)throw new Error('maxQueriesPerLayer cannot exceed maxQueries');if(budget.maxResidentValues<budget.maxValuesPerQuery||budget.maxResidentBytes<budget.maxBytesPerQuery)throw new Error('aggregate budget must fit one query');this.#budget=Object.freeze({...budget})}
  setRevision(layerId:string,next:number):number{this.#live();const layer=id('layerId',layerId);integer('revision',next);const current=this.#revisions.get(layer);if(current!==undefined&&next<current)return -1;if(current===undefined&&this.#revisions.size>=this.#budget.maxLayers)return -1;this.#revisions.set(layer,next);if(current===undefined||current===next)return 0;let removed=0;for(const[key,entry]of this.#entries)if(entry.layerId===layer&&entry.revision!==next){this.#entries.delete(key);removed++}return removed}
  admit(request:DistinctValueRequest,values:number,bytes:number,now=request.requestedAt):DistinctValueView|null{this.#live();const queryId=id('queryId',request.queryId),layerId=id('layerId',request.layerId);integer('revision',request.revision);clock('requestedAt',request.requestedAt);clock('now',now);integer('values',values);integer('bytes',bytes);if(!Object.prototype.hasOwnProperty.call(rank,request.intent))throw new Error('intent is invalid');const fields=canonicalFields(request.fields,this.#budget.maxFieldsPerQuery);if(this.#revisions.get(layerId)!==request.revision||values>this.#budget.maxValuesPerQuery||bytes>this.#budget.maxBytesPerQuery)return null;const existing=this.#entries.get(queryId),signature=`${layerId}|${request.revision}|${fields.join(',')}`;if(existing){const old=`${existing.layerId}|${existing.revision}|${existing.fields.join(',')}`;if(old!==signature)throw new Error('queryId collision');return this.#view(existing)}if([...this.#entries.values()].some((entry)=>entry.layerId===layerId&&entry.revision===request.revision&&entry.fields.join(',')===fields.join(',')))return null;if([...this.#entries.values()].filter((entry)=>entry.layerId===layerId).length>=this.#budget.maxQueriesPerLayer)return null;const entry:Entry={queryId,layerId,revision:request.revision,fields,intent:request.intent,values,bytes,touchedAt:now,expiresAt:now+this.#budget.ttlMs,sequence:++this.#sequence};this.#entries.set(queryId,entry);this.#evict();return this.#entries.has(queryId)?this.#view(entry):null}
  touch(queryId:string,revision:number,now:number):boolean{this.#live();const key=id('queryId',queryId);integer('revision',revision);clock('now',now);this.expire(now);const entry=this.#entries.get(key);if(!entry||entry.revision!==revision||this.#revisions.get(entry.layerId)!==revision)return false;entry.touchedAt=now;entry.expiresAt=now+this.#budget.ttlMs;return true}
  consume(queryId:string,revision:number,now?:number):DistinctValueView|null{this.#live();const key=id('queryId',queryId);integer('revision',revision);if(now!==undefined){clock('now',now);this.expire(now)}const entry=this.#entries.get(key);if(!entry||entry.revision!==revision||this.#revisions.get(entry.layerId)!==revision)return null;return this.#view(entry)}
  invalidate(queryId:string):boolean{this.#live();return this.#entries.delete(id('queryId',queryId))}
  releaseLayer(layerId:string):number{this.#live();const layer=id('layerId',layerId);let removed=0;for(const[key,entry]of this.#entries)if(entry.layerId===layer){this.#entries.delete(key);removed++}this.#revisions.delete(layer);return removed}
  expire(now:number):number{this.#live();clock('now',now);let removed=0;for(const[key,entry]of this.#entries)if(entry.expiresAt<=now){this.#entries.delete(key);removed++}return removed}
  snapshot(){this.#live();let values=0,bytes=0;for(const entry of this.#entries.values()){values+=entry.values;bytes+=entry.bytes}return Object.freeze({layers:this.#revisions.size,queries:this.#entries.size,residentValues:values,residentBytes:bytes})}
  fingerprint():string{this.#live();return[...this.#entries.values()].sort((a,b)=>a.queryId.localeCompare(b.queryId)).map((entry)=>`${entry.layerId}:${entry.queryId}:${entry.revision}:${entry.fields.join(',')}:${entry.values}:${entry.bytes}`).join('|')}
  dispose():void{if(this.#disposed)return;this.#entries.clear();this.#revisions.clear();this.#disposed=true}
  #evict():void{const totals=()=>{let values=0,bytes=0;for(const entry of this.#entries.values()){values+=entry.values;bytes+=entry.bytes}return{values,bytes}};while(this.#entries.size>this.#budget.maxQueries||totals().values>this.#budget.maxResidentValues||totals().bytes>this.#budget.maxResidentBytes){const victim=[...this.#entries.values()].sort((a,b)=>rank[a.intent]-rank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence||a.queryId.localeCompare(b.queryId))[0];if(!victim)break;this.#entries.delete(victim.queryId)}}
  #view(entry:Entry):DistinctValueView{return Object.freeze({queryId:entry.queryId,layerId:entry.layerId,revision:entry.revision,fields:Object.freeze([...entry.fields]),intent:entry.intent,values:entry.values,bytes:entry.bytes,touchedAt:entry.touchedAt,expiresAt:entry.expiresAt})}
  #live():void{if(this.#disposed)throw new Error('ArcGisQueryDistinctValueLifecyclePolicy is disposed')}
}
