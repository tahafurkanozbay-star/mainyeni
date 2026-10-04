export type EditRetryClass = 'conflict' | 'transport' | 'server'
export interface EditRetryBudget { maxLayers:number; maxEntries:number; maxAttempts:number; maxAttemptsPerLayer:number; maxDelayMs:number; entryTtlMs:number }
export interface EditRetryRequest { retryId:string; layerId:string; revision:number; retryClass:EditRetryClass; createdAt:number }
export interface EditRetryView extends EditRetryRequest { readonly attempts:number; readonly nextEligibleAt:number; readonly expiresAt:number; readonly sequence:number }
interface Retry extends EditRetryRequest { attempts:number; nextEligibleAt:number; expiresAt:number; sequence:number }
const classes:readonly EditRetryClass[]=['conflict','transport','server']
function id(name:string,value:string):string{const v=value.trim();if(!v||v.length>192||/[\u0000-\u001f]/.test(v))throw new Error(`${name} is invalid`);return v}
function integer(name:string,value:number,min=0):void{if(!Number.isSafeInteger(value)||value<min)throw new Error(`${name} must be a safe integer >= ${min}`)}
function time(name:string,value:number):void{if(!Number.isFinite(value)||value<0)throw new Error(`${name} must be finite and non-negative`)}

/** Bounded retry metadata authority; edit payloads and credentials remain caller-owned. */
export class ArcGisEditRetryBudgetPolicy {
  readonly #budget:Readonly<EditRetryBudget>
  readonly #entries=new Map<string,Retry>()
  readonly #revisions=new Map<string,number>()
  #sequence=0
  #disposed=false
  constructor(budget:EditRetryBudget){for(const key of ['maxLayers','maxEntries','maxAttempts','maxAttemptsPerLayer','maxDelayMs'] as const)integer(key,budget[key],1);time('entryTtlMs',budget.entryTtlMs);if(budget.maxAttemptsPerLayer>budget.maxAttempts)throw new Error('maxAttemptsPerLayer cannot exceed maxAttempts');this.#budget=Object.freeze({...budget})}
  setRevision(layerId:string,next:number):number{this.#live();const layer=id('layerId',layerId);integer('revision',next);const current=this.#revisions.get(layer);if(current!==undefined&&next<current)return-1;if(current===undefined&&this.#revisions.size>=this.#budget.maxLayers)return-1;this.#revisions.set(layer,next);if(current===undefined||current===next)return 0;let removed=0;for(const[key,e]of this.#entries)if(e.layerId===layer&&e.revision!==next){this.#entries.delete(key);removed++}return removed}
  register(request:EditRetryRequest):boolean{this.#live();const retryId=id('retryId',request.retryId),layerId=id('layerId',request.layerId);integer('revision',request.revision);time('createdAt',request.createdAt);if(!classes.includes(request.retryClass))throw new Error('retryClass is invalid');if(this.#revisions.get(layerId)!==request.revision||this.#entries.has(retryId)||this.#entries.size>=this.#budget.maxEntries)return false;this.#entries.set(retryId,{...request,retryId,layerId,attempts:0,nextEligibleAt:request.createdAt,expiresAt:request.createdAt+this.#budget.entryTtlMs,sequence:++this.#sequence});return true}
  schedule(retryId:string,revision:number,now:number,delayMs:number):boolean{this.#live();const e=this.#entries.get(id('retryId',retryId));integer('revision',revision);time('now',now);time('delayMs',delayMs);this.expire(now);if(!e||e.revision!==revision||this.#revisions.get(e.layerId)!==revision||delayMs>this.#budget.maxDelayMs)return false;if(this.#attempts()>=this.#budget.maxAttempts||this.#layerAttempts(e.layerId)>=this.#budget.maxAttemptsPerLayer)return false;e.attempts++;e.nextEligibleAt=now+delayMs;e.expiresAt=now+this.#budget.entryTtlMs;return true}
  nextEligible(now:number):EditRetryView|null{this.#live();time('now',now);this.expire(now);let candidate:Retry|undefined;for(const e of this.#entries.values()){if(e.attempts<1||e.nextEligibleAt>now)continue;if(!candidate||e.nextEligibleAt<candidate.nextEligibleAt||(e.nextEligibleAt===candidate.nextEligibleAt&&e.sequence<candidate.sequence))candidate=e}return candidate?this.#view(candidate):null}
  resolve(retryId:string,revision:number):EditRetryView|null{this.#live();const key=id('retryId',retryId);integer('revision',revision);const e=this.#entries.get(key);if(!e||e.revision!==revision||this.#revisions.get(e.layerId)!==revision)return null;this.#entries.delete(key);return this.#view(e)}
  cancel(retryId:string):boolean{this.#live();return this.#entries.delete(id('retryId',retryId))}
  releaseLayer(layerId:string):number{this.#live();const layer=id('layerId',layerId);let n=0;for(const[key,e]of this.#entries)if(e.layerId===layer){this.#entries.delete(key);n++}this.#revisions.delete(layer);return n}
  expire(now:number):number{this.#live();time('now',now);let n=0;for(const[key,e]of this.#entries)if(e.expiresAt<=now){this.#entries.delete(key);n++}return n}
  snapshot():Readonly<{layers:number;entries:number;attempts:number}>{this.#live();return Object.freeze({layers:this.#revisions.size,entries:this.#entries.size,attempts:this.#attempts()})}
  fingerprint():string{this.#live();return[...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.sequence-b.sequence).map(e=>`${e.layerId}:${e.retryId}:${e.revision}:${e.retryClass}:${e.attempts}:${e.nextEligibleAt}`).join('|')}
  dispose():void{if(this.#disposed)return;this.#entries.clear();this.#revisions.clear();this.#disposed=true}
  #attempts():number{let n=0;for(const e of this.#entries.values())n+=e.attempts;return n}
  #layerAttempts(layerId:string):number{let n=0;for(const e of this.#entries.values())if(e.layerId===layerId)n+=e.attempts;return n}
  #view(e:Retry):EditRetryView{return Object.freeze({retryId:e.retryId,layerId:e.layerId,revision:e.revision,retryClass:e.retryClass,createdAt:e.createdAt,attempts:e.attempts,nextEligibleAt:e.nextEligibleAt,expiresAt:e.expiresAt,sequence:e.sequence})}
  #live():void{if(this.#disposed)throw new Error('edit retry budget policy is disposed')}
}
