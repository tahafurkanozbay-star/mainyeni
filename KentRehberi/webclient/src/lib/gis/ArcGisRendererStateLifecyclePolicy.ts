export type ArcGisRendererIntent = 'background' | 'visible' | 'interactive'
export type ArcGisRendererMode = '2d' | '3d'
export type ArcGisRendererPhase = 'queued' | 'compiling' | 'resident'

export interface ArcGisRendererStateBudget {
  maxStates: number; maxStatesPerView: number; maxStatesPerLayer: number
  maxCompiling: number; maxCompilingPerView: number; maxResident: number
  maxEstimatedSymbolsPerState: number; maxActualSymbolsPerState: number; maxResidentSymbols: number
  maxEstimatedBytesPerState: number; maxActualBytesPerState: number; maxResidentBytes: number
  queueTtlMs: number; compileTtlMs: number; residentTtlMs: number
}
export interface ArcGisRendererStateRequest {
  stateId: string; viewId: string; layerId: string; revision: number; mode: ArcGisRendererMode
  intent: ArcGisRendererIntent; requestedAt: number; estimatedSymbols: number; estimatedBytes: number
}
export interface ArcGisRendererStateCompletion {
  stateId: string; viewId: string; layerId: string; revision: number
  actualSymbols: number; actualBytes: number; completedAt: number
}
export interface ArcGisRendererStateView extends Readonly<ArcGisRendererStateRequest> {
  readonly phase: ArcGisRendererPhase; readonly actualSymbols: number; readonly actualBytes: number
  readonly sequence: number; readonly expiresAt: number
}
interface Entry extends ArcGisRendererStateRequest { phase: ArcGisRendererPhase; actualSymbols: number; actualBytes: number; sequence: number; expiresAt: number }
const priority = Object.freeze({ background: 0, visible: 1, interactive: 2 } satisfies Record<ArcGisRendererIntent, number>)
const idPattern = /^[A-Za-z0-9._:-]{1,160}$/
function id(name:string,value:string):string{const v=value.trim();if(!idPattern.test(v))throw new Error(`${name} is invalid`);return v}
function integer(name:string,value:number,minimum=0):void{if(!Number.isInteger(value)||value<minimum)throw new Error(`${name} must be an integer >= ${minimum}`)}
function finite(name:string,value:number):void{if(!Number.isFinite(value)||value<0)throw new Error(`${name} must be finite and non-negative`)}

/** Payload-free authority for renderer compilation and GPU-facing residency metadata. */
export class ArcGisRendererStateLifecyclePolicy {
  readonly #budget:Readonly<ArcGisRendererStateBudget>;readonly #entries=new Map<string,Entry>();readonly #layerRevisions=new Map<string,number>();#sequence=0;#disposed=false
  constructor(budget:ArcGisRendererStateBudget){
    for(const[name,value]of Object.entries(budget))name.endsWith('Ms')?finite(name,value):integer(name,value,1)
    if(budget.maxStatesPerView>budget.maxStates||budget.maxStatesPerLayer>budget.maxStates)throw new Error('renderer cardinality budget is impossible')
    if(budget.maxCompiling>budget.maxStates||budget.maxCompilingPerView>budget.maxCompiling||budget.maxResident>budget.maxStates)throw new Error('renderer phase budget is impossible')
    if(budget.maxEstimatedSymbolsPerState>budget.maxActualSymbolsPerState||budget.maxActualSymbolsPerState>budget.maxResidentSymbols)throw new Error('renderer symbol budget is impossible')
    if(budget.maxEstimatedBytesPerState>budget.maxActualBytesPerState||budget.maxActualBytesPerState>budget.maxResidentBytes)throw new Error('renderer byte budget is impossible')
    this.#budget=Object.freeze({...budget})
  }
  enqueue(request:ArcGisRendererStateRequest):Readonly<ArcGisRendererStateView>{
    this.#active();const stateId=id('stateId',request.stateId),viewId=id('viewId',request.viewId),layerId=id('layerId',request.layerId);integer('revision',request.revision);finite('requestedAt',request.requestedAt);integer('estimatedSymbols',request.estimatedSymbols);integer('estimatedBytes',request.estimatedBytes)
    if(request.mode!=='2d'&&request.mode!=='3d')throw new Error('renderer mode is invalid')
    if(request.estimatedSymbols>this.#budget.maxEstimatedSymbolsPerState)throw new Error('estimated symbol budget exceeded');if(request.estimatedBytes>this.#budget.maxEstimatedBytesPerState)throw new Error('estimated byte budget exceeded')
    if(this.#entries.has(stateId))throw new Error('duplicate renderer state authority');if(this.#entries.size>=this.#budget.maxStates)throw new Error('renderer capacity exceeded')
    if(this.#count(e=>e.viewId===viewId)>=this.#budget.maxStatesPerView)throw new Error('view renderer capacity exceeded');if(this.#count(e=>e.layerId===layerId)>=this.#budget.maxStatesPerLayer)throw new Error('layer renderer capacity exceeded')
    const watermark=this.#layerRevisions.get(layerId);if(watermark!==undefined&&request.revision<watermark)throw new Error('stale layer revision');if(watermark===undefined||request.revision>watermark)this.advanceLayerRevision(layerId,request.revision)
    const entry:Entry=Object.freeze({...request,stateId,viewId,layerId,phase:'queued',actualSymbols:0,actualBytes:0,sequence:this.#sequence++,expiresAt:request.requestedAt+this.#budget.queueTtlMs});this.#entries.set(stateId,entry);return this.#view(entry)
  }
  takeNext(now:number):Readonly<ArcGisRendererStateView>|undefined{
    this.#active();finite('now',now);this.expire(now);if(this.#count(e=>e.phase==='compiling')>=this.#budget.maxCompiling)return undefined
    const selected=[...this.#entries.values()].filter(e=>e.phase==='queued').sort((a,b)=>priority[b.intent]-priority[a.intent]||a.requestedAt-b.requestedAt||a.stateId.localeCompare(b.stateId)).find(c=>this.#count(e=>e.phase==='compiling'&&e.viewId===c.viewId)<this.#budget.maxCompilingPerView)
    if(!selected)return undefined;const compiling:Entry=Object.freeze({...selected,phase:'compiling',expiresAt:now+this.#budget.compileTtlMs});this.#entries.set(selected.stateId,compiling);return this.#view(compiling)
  }
  complete(c:ArcGisRendererStateCompletion):Readonly<ArcGisRendererStateView>{
    this.#active();const stateId=id('stateId',c.stateId),viewId=id('viewId',c.viewId),layerId=id('layerId',c.layerId);integer('revision',c.revision);integer('actualSymbols',c.actualSymbols);integer('actualBytes',c.actualBytes);finite('completedAt',c.completedAt)
    const e=this.#entries.get(stateId);if(!e||e.phase!=='compiling')throw new Error('renderer state is not compiling');if(e.viewId!==viewId||e.layerId!==layerId||e.revision!==c.revision)throw new Error('renderer completion identity mismatch')
    if(c.completedAt>e.expiresAt){this.#entries.delete(stateId);throw new Error('renderer compile lease expired')}if(this.#layerRevisions.get(layerId)!==c.revision){this.#entries.delete(stateId);throw new Error('stale renderer completion revision')}
    if(c.actualSymbols>this.#budget.maxActualSymbolsPerState){this.#entries.delete(stateId);throw new Error('actual symbol budget exceeded')}if(c.actualBytes>this.#budget.maxActualBytesPerState){this.#entries.delete(stateId);throw new Error('actual byte budget exceeded')}
    if(this.#count(x=>x.phase==='resident')>=this.#budget.maxResident){this.#entries.delete(stateId);throw new Error('resident renderer capacity exceeded')}if(this.#sumResident('symbols')+c.actualSymbols>this.#budget.maxResidentSymbols){this.#entries.delete(stateId);throw new Error('resident symbol budget exceeded')}if(this.#sumResident('bytes')+c.actualBytes>this.#budget.maxResidentBytes){this.#entries.delete(stateId);throw new Error('resident byte budget exceeded')}
    const resident:Entry=Object.freeze({...e,phase:'resident',actualSymbols:c.actualSymbols,actualBytes:c.actualBytes,expiresAt:c.completedAt+this.#budget.residentTtlMs});this.#entries.set(stateId,resident);return this.#view(resident)
  }
  touch(stateId:string,now:number):boolean{this.#active();const key=id('stateId',stateId);finite('now',now);const e=this.#entries.get(key);if(!e||e.phase!=='resident'||now>e.expiresAt)return false;this.#entries.set(key,Object.freeze({...e,expiresAt:now+this.#budget.residentTtlMs}));return true}
  consume(stateId:string):Readonly<ArcGisRendererStateView>|undefined{this.#active();const key=id('stateId',stateId),e=this.#entries.get(key);if(!e||e.phase!=='resident')return undefined;this.#entries.delete(key);return this.#view(e)}
  cancel(stateId:string):boolean{this.#active();const key=id('stateId',stateId),e=this.#entries.get(key);return!!e&&e.phase!=='resident'&&this.#entries.delete(key)}
  advanceLayerRevision(layerId:string,revision:number):number{this.#active();const layer=id('layerId',layerId);integer('revision',revision);const current=this.#layerRevisions.get(layer);if(current!==undefined&&revision<current)throw new Error('layer revision cannot move backwards');if(current===revision)return 0;let removed=0;for(const[key,e]of this.#entries)if(e.layerId===layer&&e.revision<revision){this.#entries.delete(key);removed++}this.#layerRevisions.set(layer,revision);return removed}
  expire(now:number):number{this.#active();finite('now',now);let removed=0;for(const[key,e]of this.#entries)if(now>e.expiresAt){this.#entries.delete(key);removed++}return removed}
  releaseView(viewId:string):number{const view=id('viewId',viewId);return this.#release(e=>e.viewId===view)}
  releaseLayer(layerId:string):number{const layer=id('layerId',layerId),removed=this.#release(e=>e.layerId===layer);this.#layerRevisions.delete(layer);return removed}
  snapshot():readonly Readonly<ArcGisRendererStateView>[]{this.#active();return Object.freeze([...this.#entries.values()].sort((a,b)=>a.sequence-b.sequence).map(e=>this.#view(e)))}
  fingerprint():string{this.#active();return[...this.#entries.values()].sort((a,b)=>a.stateId.localeCompare(b.stateId)).map(e=>[e.stateId,e.viewId,e.layerId,e.revision,e.mode,e.intent,e.phase,e.actualSymbols,e.actualBytes].join(':')).join('|')}
  dispose():void{this.#entries.clear();this.#layerRevisions.clear();this.#disposed=true}
  #release(predicate:(e:Entry)=>boolean):number{this.#active();let total=0;for(const[key,e]of this.#entries)if(predicate(e)){this.#entries.delete(key);total++}return total}
  #count(predicate:(e:Entry)=>boolean):number{let total=0;for(const e of this.#entries.values())if(predicate(e))total++;return total}
  #sumResident(metric:'symbols'|'bytes'):number{let total=0;for(const e of this.#entries.values())if(e.phase==='resident')total+=metric==='symbols'?e.actualSymbols:e.actualBytes;return total}
  #view(e:Entry):Readonly<ArcGisRendererStateView>{return Object.freeze({stateId:e.stateId,viewId:e.viewId,layerId:e.layerId,revision:e.revision,mode:e.mode,intent:e.intent,requestedAt:e.requestedAt,estimatedSymbols:e.estimatedSymbols,estimatedBytes:e.estimatedBytes,phase:e.phase,actualSymbols:e.actualSymbols,actualBytes:e.actualBytes,sequence:e.sequence,expiresAt:e.expiresAt})}
  #active():void{if(this.#disposed)throw new Error('ArcGisRendererStateLifecyclePolicy is disposed')}
}
