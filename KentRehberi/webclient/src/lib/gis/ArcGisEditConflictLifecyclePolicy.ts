export type EditConflictIntent = 'interactive' | 'visible' | 'background'
export type EditConflictPhase = 'queued' | 'resolving' | 'resident'
export type EditConflictStrategy = 'server-wins' | 'client-retry' | 'manual'

export interface EditConflictBudget {
  maxLayers: number
  maxConflicts: number
  maxConflictsPerLayer: number
  maxResolving: number
  maxResolvingPerLayer: number
  maxResident: number
  maxResidentPerLayer: number
  maxFieldsPerConflict: number
  maxBytesPerConflict: number
  maxResidentFields: number
  maxResidentBytes: number
  queueTtlMs: number
  resolveLeaseMs: number
  residentTtlMs: number
}
export interface EditConflictRequest {
  conflictId: string
  layerId: string
  revision: number
  intent: EditConflictIntent
  strategy: EditConflictStrategy
  fieldCount: number
  estimatedBytes: number
  requestedAt: number
}
export interface EditConflictView {
  readonly conflictId: string; readonly layerId: string; readonly revision: number
  readonly intent: EditConflictIntent; readonly strategy: EditConflictStrategy; readonly phase: EditConflictPhase
  readonly fieldCount: number; readonly bytes: number; readonly sequence: number; readonly touchedAt: number; readonly expiresAt: number
}
interface Entry extends EditConflictRequest { phase: EditConflictPhase; bytes: number; sequence: number; touchedAt: number; expiresAt: number }
const rank: Readonly<Record<EditConflictIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const strategies: readonly EditConflictStrategy[] = ['server-wins', 'client-retry', 'manual']
function id(name:string,value:string):string { const v=value.trim(); if(!v||v.length>192||/[\u0000-\u001f]/.test(v)) throw new Error(`${name} must contain 1..192 safe characters`); return v }
function integer(name:string,value:number,min=0):void { if(!Number.isSafeInteger(value)||value<min) throw new Error(`${name} must be an integer >= ${min}`) }
function finite(name:string,value:number):void { if(!Number.isFinite(value)||value<0) throw new Error(`${name} must be finite and non-negative`) }

/** Bounded metadata authority for optimistic ArcGIS edit conflicts. Feature/attribute payloads stay caller-owned. */
export class ArcGisEditConflictLifecyclePolicy {
  readonly #budget: Readonly<EditConflictBudget>; readonly #entries=new Map<string,Entry>(); readonly #revisions=new Map<string,number>(); #sequence=0; #disposed=false
  constructor(b:EditConflictBudget){
    for(const k of ['maxLayers','maxConflicts','maxConflictsPerLayer','maxResolving','maxResolvingPerLayer','maxResident','maxResidentPerLayer','maxFieldsPerConflict','maxBytesPerConflict','maxResidentFields','maxResidentBytes'] as const) integer(k,b[k],1)
    for(const k of ['queueTtlMs','resolveLeaseMs','residentTtlMs'] as const) finite(k,b[k])
    if(b.maxConflictsPerLayer>b.maxConflicts) throw new Error('maxConflictsPerLayer cannot exceed maxConflicts')
    if(b.maxResolvingPerLayer>b.maxResolving) throw new Error('maxResolvingPerLayer cannot exceed maxResolving')
    if(b.maxResidentPerLayer>b.maxResident) throw new Error('maxResidentPerLayer cannot exceed maxResident')
    if(b.maxFieldsPerConflict>b.maxResidentFields) throw new Error('field budgets are inconsistent')
    if(b.maxBytesPerConflict>b.maxResidentBytes) throw new Error('byte budgets are inconsistent')
    this.#budget=Object.freeze({...b})
  }
  setRevision(layerId:string,revision:number):number{
    this.#active(); const layer=id('layerId',layerId); integer('revision',revision); const current=this.#revisions.get(layer)
    if(current===undefined&&this.#revisions.size>=this.#budget.maxLayers)return -1
    if(current!==undefined&&revision<current)return -1
    if(current===revision)return 0
    let removed=0; for(const [key,e] of this.#entries) if(e.layerId===layer&&e.revision<revision){this.#entries.delete(key);removed++}
    this.#revisions.set(layer,revision); return removed
  }
  admit(r:EditConflictRequest):boolean{
    this.#active(); const conflictId=id('conflictId',r.conflictId),layerId=id('layerId',r.layerId); integer('revision',r.revision);integer('fieldCount',r.fieldCount);integer('estimatedBytes',r.estimatedBytes);finite('requestedAt',r.requestedAt)
    if(!(r.intent in rank)||!strategies.includes(r.strategy))return false
    if(r.fieldCount>this.#budget.maxFieldsPerConflict||r.estimatedBytes>this.#budget.maxBytesPerConflict)return false
    if(this.#revisions.get(layerId)!==r.revision||this.#entries.has(conflictId))return false
    if(this.#entries.size>=this.#budget.maxConflicts||this.#countLayer(layerId)>=this.#budget.maxConflictsPerLayer)return false
    this.#entries.set(conflictId,Object.freeze({...r,conflictId,layerId,phase:'queued',bytes:r.estimatedBytes,sequence:this.#sequence++,touchedAt:r.requestedAt,expiresAt:r.requestedAt+this.#budget.queueTtlMs}));return true
  }
  startNext(now:number):Readonly<EditConflictView>|null{
    this.#active();finite('now',now);this.expire(now);if(this.#countPhase('resolving')>=this.#budget.maxResolving)return null
    const e=[...this.#entries.values()].filter(x=>x.phase==='queued'&&this.#countLayerPhase(x.layerId,'resolving')<this.#budget.maxResolvingPerLayer).sort((a,b)=>rank[b.intent]-rank[a.intent]||a.sequence-b.sequence||a.conflictId.localeCompare(b.conflictId))[0]
    if(!e)return null; const next:Entry=Object.freeze({...e,phase:'resolving',touchedAt:now,expiresAt:now+this.#budget.resolveLeaseMs});this.#entries.set(e.conflictId,next);return this.#view(next)
  }
  complete(conflictId:string,revision:number,fieldCount:number,bytes:number,now:number):boolean{
    this.#active();const key=id('conflictId',conflictId);integer('revision',revision);integer('fieldCount',fieldCount);integer('bytes',bytes);finite('now',now);this.expire(now)
    const e=this.#entries.get(key);if(!e||e.phase!=='resolving'||e.revision!==revision||this.#revisions.get(e.layerId)!==revision)return false
    if(fieldCount>this.#budget.maxFieldsPerConflict||bytes>this.#budget.maxBytesPerConflict){this.#entries.delete(key);return false}
    this.#evict(e.layerId,fieldCount,bytes)
    if(this.#countPhase('resident')>=this.#budget.maxResident||this.#countLayerPhase(e.layerId,'resident')>=this.#budget.maxResidentPerLayer)return false
    if(this.#residentFields()+fieldCount>this.#budget.maxResidentFields||this.#residentBytes()+bytes>this.#budget.maxResidentBytes)return false
    this.#entries.set(key,Object.freeze({...e,phase:'resident',fieldCount,bytes,touchedAt:now,expiresAt:now+this.#budget.residentTtlMs}));return true
  }
  touch(conflictId:string,now:number):boolean{this.#active();const key=id('conflictId',conflictId);finite('now',now);this.expire(now);const e=this.#entries.get(key);if(!e||e.phase!=='resident')return false;this.#entries.set(key,Object.freeze({...e,touchedAt:now,expiresAt:now+this.#budget.residentTtlMs}));return true}
  consume(conflictId:string,revision:number):Readonly<EditConflictView>|null{this.#active();const key=id('conflictId',conflictId);integer('revision',revision);const e=this.#entries.get(key);if(!e||e.phase!=='resident'||e.revision!==revision||this.#revisions.get(e.layerId)!==revision)return null;this.#entries.delete(key);return this.#view(e)}
  cancel(conflictId:string):boolean{this.#active();return this.#entries.delete(id('conflictId',conflictId))}
  releaseLayer(layerId:string):number{this.#active();const layer=id('layerId',layerId);let n=0;for(const[key,e]of this.#entries)if(e.layerId===layer){this.#entries.delete(key);n++}this.#revisions.delete(layer);return n}
  expire(now:number):number{this.#active();finite('now',now);let n=0;for(const[key,e]of this.#entries)if(now>=e.expiresAt){this.#entries.delete(key);n++}return n}
  snapshot():Readonly<{layers:number;conflicts:number;queued:number;resolving:number;resident:number;residentFields:number;residentBytes:number}>{this.#active();return Object.freeze({layers:this.#revisions.size,conflicts:this.#entries.size,queued:this.#countPhase('queued'),resolving:this.#countPhase('resolving'),resident:this.#countPhase('resident'),residentFields:this.#residentFields(),residentBytes:this.#residentBytes()})}
  fingerprint():string{this.#active();return [...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.conflictId.localeCompare(b.conflictId)).map(e=>[e.layerId,e.conflictId,e.revision,e.intent,e.strategy,e.phase,e.fieldCount,e.bytes].join(':')).join('|')}
  dispose():void{this.#entries.clear();this.#revisions.clear();this.#disposed=true}
  #evict(layerId:string,fields:number,bytes:number):void{const candidates=[...this.#entries.values()].filter(e=>e.phase==='resident').sort((a,b)=>rank[a.intent]-rank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence);for(const e of candidates){const gp=this.#countPhase('resident')>=this.#budget.maxResident||this.#residentFields()+fields>this.#budget.maxResidentFields||this.#residentBytes()+bytes>this.#budget.maxResidentBytes;const lp=this.#countLayerPhase(layerId,'resident')>=this.#budget.maxResidentPerLayer;if(!gp&&!lp)break;if(lp&&e.layerId!==layerId&&!gp)continue;this.#entries.delete(e.conflictId)}}
  #countLayer(layer:string):number{let n=0;for(const e of this.#entries.values())if(e.layerId===layer)n++;return n} #countPhase(p:EditConflictPhase):number{let n=0;for(const e of this.#entries.values())if(e.phase===p)n++;return n} #countLayerPhase(layer:string,p:EditConflictPhase):number{let n=0;for(const e of this.#entries.values())if(e.layerId===layer&&e.phase===p)n++;return n} #residentFields():number{let n=0;for(const e of this.#entries.values())if(e.phase==='resident')n+=e.fieldCount;return n} #residentBytes():number{let n=0;for(const e of this.#entries.values())if(e.phase==='resident')n+=e.bytes;return n}
  #view(e:Entry):Readonly<EditConflictView>{return Object.freeze({conflictId:e.conflictId,layerId:e.layerId,revision:e.revision,intent:e.intent,strategy:e.strategy,phase:e.phase,fieldCount:e.fieldCount,bytes:e.bytes,sequence:e.sequence,touchedAt:e.touchedAt,expiresAt:e.expiresAt})} #active():void{if(this.#disposed)throw new Error('ArcGisEditConflictLifecyclePolicy is disposed')}
}
