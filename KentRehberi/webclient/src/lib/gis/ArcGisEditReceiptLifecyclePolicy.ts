export type EditReceiptOutcome = 'applied' | 'partial' | 'rejected'
export interface EditReceiptBudget { maxLayers:number; maxReceipts:number; maxReceiptsPerLayer:number; maxOperations:number; ttlMs:number }
export interface EditReceiptRequest { receiptId:string; layerId:string; revision:number; outcome:EditReceiptOutcome; operations:number; createdAt:number }
export interface EditReceiptView extends EditReceiptRequest { readonly sequence:number; readonly touchedAt:number; readonly expiresAt:number }
interface Receipt extends EditReceiptRequest { sequence:number; touchedAt:number; expiresAt:number }
const outcomes:readonly EditReceiptOutcome[]=['applied','partial','rejected']
function id(name:string,value:string):string{const v=value.trim();if(!v||v.length>192||/[\u0000-\u001f]/.test(v))throw new Error(`${name} is invalid`);return v}
function integer(name:string,value:number,min=0):void{if(!Number.isSafeInteger(value)||value<min)throw new Error(`${name} must be a safe integer >= ${min}`)}
function time(name:string,value:number):void{if(!Number.isFinite(value)||value<0)throw new Error(`${name} must be finite and non-negative`)}

/** Payload-free bounded retention for applyEdits result receipts. */
export class ArcGisEditReceiptLifecyclePolicy {
 readonly #budget:Readonly<EditReceiptBudget>
 readonly #receipts=new Map<string,Receipt>()
 readonly #revisions=new Map<string,number>()
 #sequence=0
 #disposed=false
 constructor(budget:EditReceiptBudget){for(const key of ['maxLayers','maxReceipts','maxReceiptsPerLayer','maxOperations'] as const)integer(key,budget[key],1);time('ttlMs',budget.ttlMs);if(budget.maxReceiptsPerLayer>budget.maxReceipts)throw new Error('maxReceiptsPerLayer cannot exceed maxReceipts');this.#budget=Object.freeze({...budget})}
 setRevision(layerId:string,next:number):number{this.#live();const layer=id('layerId',layerId);integer('revision',next);const current=this.#revisions.get(layer);if(current!==undefined&&next<current)return-1;if(current===undefined&&this.#revisions.size>=this.#budget.maxLayers)return-1;this.#revisions.set(layer,next);if(current===undefined||current===next)return 0;let removed=0;for(const[key,r]of this.#receipts)if(r.layerId===layer&&r.revision!==next){this.#receipts.delete(key);removed++}return removed}
 record(request:EditReceiptRequest):boolean{this.#live();const receiptId=id('receiptId',request.receiptId),layerId=id('layerId',request.layerId);integer('revision',request.revision);integer('operations',request.operations,1);time('createdAt',request.createdAt);if(!outcomes.includes(request.outcome))throw new Error('outcome is invalid');if(this.#revisions.get(layerId)!==request.revision||this.#receipts.has(receiptId))return false;if(this.#receipts.size>=this.#budget.maxReceipts||this.#layerCount(layerId)>=this.#budget.maxReceiptsPerLayer||this.#operations()+request.operations>this.#budget.maxOperations)return false;this.#receipts.set(receiptId,{...request,receiptId,layerId,sequence:++this.#sequence,touchedAt:request.createdAt,expiresAt:request.createdAt+this.#budget.ttlMs});return true}
 get(receiptId:string,revision:number,now:number):EditReceiptView|null{this.#live();const r=this.#receipts.get(id('receiptId',receiptId));integer('revision',revision);time('now',now);this.expire(now);if(!r||r.revision!==revision||this.#revisions.get(r.layerId)!==revision)return null;r.touchedAt=now;r.expiresAt=now+this.#budget.ttlMs;return this.#view(r)}
 consume(receiptId:string,revision:number):EditReceiptView|null{this.#live();const key=id('receiptId',receiptId);integer('revision',revision);const r=this.#receipts.get(key);if(!r||r.revision!==revision||this.#revisions.get(r.layerId)!==revision)return null;this.#receipts.delete(key);return this.#view(r)}
 releaseLayer(layerId:string):number{this.#live();const layer=id('layerId',layerId);let n=0;for(const[key,r]of this.#receipts)if(r.layerId===layer){this.#receipts.delete(key);n++}this.#revisions.delete(layer);return n}
 expire(now:number):number{this.#live();time('now',now);let n=0;for(const[key,r]of this.#receipts)if(r.expiresAt<=now){this.#receipts.delete(key);n++}return n}
 snapshot():Readonly<{layers:number;receipts:number;operations:number;applied:number;partial:number;rejected:number}>{this.#live();return Object.freeze({layers:this.#revisions.size,receipts:this.#receipts.size,operations:this.#operations(),applied:this.#outcomeCount('applied'),partial:this.#outcomeCount('partial'),rejected:this.#outcomeCount('rejected')})}
 fingerprint():string{this.#live();return[...this.#receipts.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.sequence-b.sequence).map(r=>`${r.layerId}:${r.receiptId}:${r.revision}:${r.outcome}:${r.operations}`).join('|')}
 dispose():void{if(this.#disposed)return;this.#receipts.clear();this.#revisions.clear();this.#disposed=true}
 #layerCount(layerId:string):number{let n=0;for(const r of this.#receipts.values())if(r.layerId===layerId)n++;return n}
 #operations():number{let n=0;for(const r of this.#receipts.values())n+=r.operations;return n}
 #outcomeCount(outcome:EditReceiptOutcome):number{let n=0;for(const r of this.#receipts.values())if(r.outcome===outcome)n++;return n}
 #view(r:Receipt):EditReceiptView{return Object.freeze({receiptId:r.receiptId,layerId:r.layerId,revision:r.revision,outcome:r.outcome,operations:r.operations,createdAt:r.createdAt,sequence:r.sequence,touchedAt:r.touchedAt,expiresAt:r.expiresAt})}
 #live():void{if(this.#disposed)throw new Error('edit receipt lifecycle policy is disposed')}
}
