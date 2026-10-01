export type ArcGisPopupHydrationIntent = 'hover' | 'visible' | 'interactive'
export type ArcGisPopupHydrationPhase = 'queued' | 'loading' | 'ready'
export interface ArcGisPopupHydrationBudget { maxJobs:number;maxJobsPerView:number;maxLoading:number;maxReady:number;maxFieldsPerJob:number;maxBytesPerJob:number;maxAggregateReadyBytes:number;queueTtlMs:number;loadLeaseMs:number;readyTtlMs:number }
export interface ArcGisPopupHydrationRequest { viewId:string;layerId:string;objectId:string;jobId:string;revision:number;intent:ArcGisPopupHydrationIntent;requestedAt:number;fieldCount:number;estimatedBytes:number }
export interface ArcGisPopupHydrationSnapshot extends ArcGisPopupHydrationRequest { phase:ArcGisPopupHydrationPhase;bytes:number;expiresAt:number }
type Entry=ArcGisPopupHydrationSnapshot&{sequence:number}
const rank:Record<ArcGisPopupHydrationIntent,number>={interactive:0,visible:1,hover:2}
const sep='\u0000'

/** Bounded scalar authority for popup attribute hydration; never retains Graphic/Geometry/attributes. */
export class ArcGisPopupHydrationLifecyclePolicy{
 private readonly jobs=new Map<string,Entry>();private readonly revisions=new Map<string,number>();private sequence=0;private disposed=false
 constructor(private readonly budget:ArcGisPopupHydrationBudget){this.validateBudget()}
 enqueue(raw:ArcGisPopupHydrationRequest):boolean{
  this.live();const r=this.normalize(raw);const watermark=this.revisions.get(r.viewId)??0
  if(r.revision<watermark||r.fieldCount>this.budget.maxFieldsPerJob||r.estimatedBytes>this.budget.maxBytesPerJob)return false
  const key=this.key(r.viewId,r.layerId,r.objectId,r.jobId),old=this.jobs.get(key);if(old&&r.revision<=old.revision)return false
  const replacing=old?1:0;if(this.jobs.size-replacing>=this.budget.maxJobs)return false
  if(this.countView(r.viewId)-(old?.viewId===r.viewId?1:0)>=this.budget.maxJobsPerView)return false
  if(old)this.jobs.delete(key);this.revisions.set(r.viewId,Math.max(watermark,r.revision));this.jobs.set(key,{...r,phase:'queued',bytes:0,expiresAt:r.requestedAt+this.budget.queueTtlMs,sequence:this.sequence++});return true
 }
 takeNext(now:number):ArcGisPopupHydrationSnapshot|undefined{
  this.live();this.timestamp(now,'now');this.expire(now);if(this.countPhase('loading')>=this.budget.maxLoading)return undefined
  const item=[...this.jobs.values()].filter(x=>x.phase==='queued').sort((a,b)=>rank[a.intent]-rank[b.intent]||a.requestedAt-b.requestedAt||a.sequence-b.sequence)[0];if(!item)return undefined
  item.phase='loading';item.expiresAt=now+this.budget.loadLeaseMs;return this.public(item)
 }
 complete(viewId:string,layerId:string,objectId:string,jobId:string,revision:number,actualBytes:number,now:number):boolean{
  this.live();this.positive(revision,'revision');this.nonNegative(actualBytes,'actualBytes');this.timestamp(now,'now')
  const item=this.jobs.get(this.key(this.id(viewId,'viewId'),this.id(layerId,'layerId'),this.id(objectId,'objectId'),this.id(jobId,'jobId')))
  if(!item||item.phase!=='loading'||item.revision!==revision)return false
  if(now>=item.expiresAt||revision<(this.revisions.get(item.viewId)??0)){this.remove(item);return false}
  if(actualBytes>this.budget.maxBytesPerJob||this.countPhase('ready')>=this.budget.maxReady||this.readyBytes()+actualBytes>this.budget.maxAggregateReadyBytes){this.remove(item);return false}
  item.phase='ready';item.bytes=actualBytes;item.expiresAt=now+this.budget.readyTtlMs;return true
 }
 consume(viewId:string,layerId:string,objectId:string,jobId:string,revision:number):boolean{this.live();this.positive(revision,'revision');const item=this.jobs.get(this.key(this.id(viewId,'viewId'),this.id(layerId,'layerId'),this.id(objectId,'objectId'),this.id(jobId,'jobId')));if(!item||item.phase!=='ready'||item.revision!==revision)return false;this.remove(item);return true}
 cancel(viewId:string,layerId:string,objectId:string,jobId:string,revision:number):boolean{this.live();this.positive(revision,'revision');const item=this.jobs.get(this.key(this.id(viewId,'viewId'),this.id(layerId,'layerId'),this.id(objectId,'objectId'),this.id(jobId,'jobId')));if(!item||item.revision!==revision)return false;this.remove(item);return true}
 invalidateView(viewId:string,revision:number):number{this.live();const id=this.id(viewId,'viewId');this.positive(revision,'revision');const current=this.revisions.get(id)??0;if(revision<=current)return 0;this.revisions.set(id,revision);let n=0;for(const item of [...this.jobs.values()])if(item.viewId===id&&item.revision<revision){this.remove(item);n++}return n}
 releaseLayer(viewId:string,layerId:string):number{this.live();const v=this.id(viewId,'viewId'),l=this.id(layerId,'layerId');let n=0;for(const item of [...this.jobs.values()])if(item.viewId===v&&item.layerId===l){this.remove(item);n++}return n}
 releaseView(viewId:string):number{this.live();const v=this.id(viewId,'viewId');let n=0;for(const item of [...this.jobs.values()])if(item.viewId===v){this.remove(item);n++}this.revisions.delete(v);return n}
 expire(now:number):number{this.live();this.timestamp(now,'now');let n=0;for(const item of [...this.jobs.values()])if(now>=item.expiresAt){this.remove(item);n++}return n}
 snapshot():ArcGisPopupHydrationSnapshot[]{this.live();return[...this.jobs.values()].sort((a,b)=>a.sequence-b.sequence).map(x=>this.public(x))}
 fingerprint():string{return this.snapshot().map(x=>`${x.viewId}:${x.layerId}:${x.objectId}:${x.jobId}:${x.revision}:${x.phase}:${x.bytes}`).join('|')}
 dispose():void{if(this.disposed)return;this.jobs.clear();this.revisions.clear();this.disposed=true}
 private readyBytes():number{let n=0;for(const x of this.jobs.values())if(x.phase==='ready')n+=x.bytes;return n}
 private countPhase(p:ArcGisPopupHydrationPhase):number{let n=0;for(const x of this.jobs.values())if(x.phase===p)n++;return n}
 private countView(v:string):number{let n=0;for(const x of this.jobs.values())if(x.viewId===v)n++;return n}
 private remove(x:Entry):void{this.jobs.delete(this.key(x.viewId,x.layerId,x.objectId,x.jobId))}
 private public(x:Entry):ArcGisPopupHydrationSnapshot{const{sequence:_s,...out}=x;return{...out}}
 private normalize(r:ArcGisPopupHydrationRequest):ArcGisPopupHydrationRequest{if(!(r.intent in rank))throw new Error('intent is invalid');this.positive(r.revision,'revision');this.timestamp(r.requestedAt,'requestedAt');this.positive(r.fieldCount,'fieldCount');this.nonNegative(r.estimatedBytes,'estimatedBytes');return{...r,viewId:this.id(r.viewId,'viewId'),layerId:this.id(r.layerId,'layerId'),objectId:this.id(r.objectId,'objectId'),jobId:this.id(r.jobId,'jobId')}}
 private id(v:string,n:string):string{if(typeof v!=='string')throw new Error(`${n} must be a string`);const x=v.trim();if(!x||x.includes(sep)||x.includes(':')||x.length>160)throw new Error(`${n} must contain safe characters`);return x}
 private key(v:string,l:string,o:string,j:string):string{return`${v}${sep}${l}${sep}${o}${sep}${j}`}
 private positive(v:number,n:string):void{if(!Number.isSafeInteger(v)||v<=0)throw new Error(`${n} must be a positive safe integer`)}
 private nonNegative(v:number,n:string):void{if(!Number.isSafeInteger(v)||v<0)throw new Error(`${n} must be a non-negative safe integer`)}
 private timestamp(v:number,n:string):void{if(!Number.isFinite(v)||v<0)throw new Error(`${n} must be a finite non-negative timestamp`)}
 private validateBudget():void{for(const[n,v]of Object.entries(this.budget))this.positive(v,n);if(this.budget.maxJobsPerView>this.budget.maxJobs)throw new Error('maxJobsPerView cannot exceed maxJobs');if(this.budget.maxLoading>this.budget.maxJobs)throw new Error('maxLoading cannot exceed maxJobs');if(this.budget.maxReady>this.budget.maxJobs)throw new Error('maxReady cannot exceed maxJobs');if(this.budget.maxAggregateReadyBytes<this.budget.maxBytesPerJob)throw new Error('maxAggregateReadyBytes must admit one maximum job')}
 private live():void{if(this.disposed)throw new Error('ArcGisPopupHydrationLifecyclePolicy is disposed')}
}
