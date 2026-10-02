export type ArcGisSpatialExecutionIntent = 'background' | 'visible' | 'interactive'
export type ArcGisSpatialExecutionKind = 'query' | 'identify' | 'buffer' | 'nearest' | 'projection' | 'measurement'
export type ArcGisSpatialExecutionPhase = 'queued' | 'running' | 'ready'

export interface ArcGisSpatialExecutionBudget {
  maxExecutions: number
  maxExecutionsPerView: number
  maxExecutionsPerLayer: number
  maxRunning: number
  maxRunningPerView: number
  maxReady: number
  maxEstimatedVerticesPerExecution: number
  maxActualVerticesPerExecution: number
  maxReadyVertices: number
  maxEstimatedBytesPerExecution: number
  maxActualBytesPerExecution: number
  maxReadyBytes: number
  queueTtlMs: number
  runTtlMs: number
  readyTtlMs: number
}

export interface ArcGisSpatialExecutionRequest {
  executionId: string; viewId: string; layerId: string; revision: number
  kind: ArcGisSpatialExecutionKind; intent: ArcGisSpatialExecutionIntent; requestedAt: number
  estimatedVertices: number; estimatedBytes: number
}
export interface ArcGisSpatialExecutionCompletion {
  executionId: string; viewId: string; layerId: string; revision: number
  actualVertices: number; actualBytes: number; completedAt: number
}
export interface ArcGisSpatialExecutionView extends Readonly<ArcGisSpatialExecutionRequest> {
  readonly phase: ArcGisSpatialExecutionPhase; readonly actualVertices: number; readonly actualBytes: number
  readonly sequence: number; readonly expiresAt: number
}
interface Entry extends ArcGisSpatialExecutionRequest { phase: ArcGisSpatialExecutionPhase; actualVertices: number; actualBytes: number; sequence: number; expiresAt: number }
const priority = Object.freeze({ background: 0, visible: 1, interactive: 2 } satisfies Record<ArcGisSpatialExecutionIntent, number>)
const idPattern = /^[A-Za-z0-9._:-]{1,160}$/
function id(name: string, value: string): string { const v = value.trim(); if (!idPattern.test(v)) throw new Error(`${name} is invalid`); return v }
function integer(name: string, value: number, minimum = 0): void { if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`) }
function finite(name: string, value: number): void { if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`) }

/** Payload-free authority for expensive ArcGIS geometry/query execution. */
export class ArcGisSpatialExecutionLifecyclePolicy {
  readonly #budget: Readonly<ArcGisSpatialExecutionBudget>; readonly #entries = new Map<string, Entry>(); readonly #layerRevisions = new Map<string, number>(); #sequence = 0; #disposed = false
  constructor(budget: ArcGisSpatialExecutionBudget) {
    for (const [name, value] of Object.entries(budget)) name.endsWith('Ms') ? finite(name, value) : integer(name, value, 1)
    if (budget.maxExecutionsPerView > budget.maxExecutions || budget.maxExecutionsPerLayer > budget.maxExecutions) throw new Error('execution cardinality budget is impossible')
    if (budget.maxRunning > budget.maxExecutions || budget.maxRunningPerView > budget.maxRunning || budget.maxReady > budget.maxExecutions) throw new Error('phase budget is impossible')
    if (budget.maxEstimatedVerticesPerExecution > budget.maxActualVerticesPerExecution || budget.maxActualVerticesPerExecution > budget.maxReadyVertices) throw new Error('vertex budget is impossible')
    if (budget.maxEstimatedBytesPerExecution > budget.maxActualBytesPerExecution || budget.maxActualBytesPerExecution > budget.maxReadyBytes) throw new Error('byte budget is impossible')
    this.#budget = Object.freeze({ ...budget })
  }
  enqueue(request: ArcGisSpatialExecutionRequest): Readonly<ArcGisSpatialExecutionView> {
    this.#active(); const executionId = id('executionId', request.executionId); const viewId = id('viewId', request.viewId); const layerId = id('layerId', request.layerId)
    integer('revision', request.revision); finite('requestedAt', request.requestedAt); integer('estimatedVertices', request.estimatedVertices); integer('estimatedBytes', request.estimatedBytes)
    if (request.estimatedVertices > this.#budget.maxEstimatedVerticesPerExecution) throw new Error('estimated vertex budget exceeded')
    if (request.estimatedBytes > this.#budget.maxEstimatedBytesPerExecution) throw new Error('estimated byte budget exceeded')
    if (this.#entries.has(executionId)) throw new Error('duplicate execution authority')
    if (this.#entries.size >= this.#budget.maxExecutions) throw new Error('execution capacity exceeded')
    if (this.#count(e => e.viewId === viewId) >= this.#budget.maxExecutionsPerView) throw new Error('view execution capacity exceeded')
    if (this.#count(e => e.layerId === layerId) >= this.#budget.maxExecutionsPerLayer) throw new Error('layer execution capacity exceeded')
    const watermark = this.#layerRevisions.get(layerId); if (watermark !== undefined && request.revision < watermark) throw new Error('stale layer revision'); if (watermark === undefined || request.revision > watermark) this.advanceLayerRevision(layerId, request.revision)
    const entry: Entry = Object.freeze({ ...request, executionId, viewId, layerId, phase: 'queued', actualVertices: 0, actualBytes: 0, sequence: this.#sequence++, expiresAt: request.requestedAt + this.#budget.queueTtlMs }); this.#entries.set(executionId, entry); return this.#view(entry)
  }
  takeNext(now: number): Readonly<ArcGisSpatialExecutionView> | undefined {
    this.#active(); finite('now', now); this.expire(now); if (this.#count(e => e.phase === 'running') >= this.#budget.maxRunning) return undefined
    const selected = [...this.#entries.values()].filter(e => e.phase === 'queued').sort((a,b) => priority[b.intent]-priority[a.intent] || a.requestedAt-b.requestedAt || a.executionId.localeCompare(b.executionId)).find(c => this.#count(e => e.phase === 'running' && e.viewId === c.viewId) < this.#budget.maxRunningPerView)
    if (!selected) return undefined; const running: Entry = Object.freeze({ ...selected, phase: 'running', expiresAt: now + this.#budget.runTtlMs }); this.#entries.set(selected.executionId, running); return this.#view(running)
  }
  complete(c: ArcGisSpatialExecutionCompletion): Readonly<ArcGisSpatialExecutionView> {
    this.#active(); const executionId=id('executionId',c.executionId), viewId=id('viewId',c.viewId), layerId=id('layerId',c.layerId); integer('revision',c.revision); integer('actualVertices',c.actualVertices); integer('actualBytes',c.actualBytes); finite('completedAt',c.completedAt)
    const e=this.#entries.get(executionId); if(!e||e.phase!=='running') throw new Error('execution is not running'); if(e.viewId!==viewId||e.layerId!==layerId||e.revision!==c.revision) throw new Error('completion identity mismatch')
    if(c.completedAt>e.expiresAt){this.#entries.delete(executionId);throw new Error('execution lease expired')} if(this.#layerRevisions.get(layerId)!==c.revision){this.#entries.delete(executionId);throw new Error('stale completion revision')}
    if(c.actualVertices>this.#budget.maxActualVerticesPerExecution){this.#entries.delete(executionId);throw new Error('actual vertex budget exceeded')} if(c.actualBytes>this.#budget.maxActualBytesPerExecution){this.#entries.delete(executionId);throw new Error('actual byte budget exceeded')}
    if(this.#count(x=>x.phase==='ready')>=this.#budget.maxReady){this.#entries.delete(executionId);throw new Error('ready capacity exceeded')} if(this.#sumReady('vertices')+c.actualVertices>this.#budget.maxReadyVertices){this.#entries.delete(executionId);throw new Error('ready vertex residency exceeded')} if(this.#sumReady('bytes')+c.actualBytes>this.#budget.maxReadyBytes){this.#entries.delete(executionId);throw new Error('ready byte residency exceeded')}
    const ready: Entry=Object.freeze({...e,phase:'ready',actualVertices:c.actualVertices,actualBytes:c.actualBytes,expiresAt:c.completedAt+this.#budget.readyTtlMs});this.#entries.set(executionId,ready);return this.#view(ready)
  }
  touch(executionId:string,now:number):boolean{this.#active();const key=id('executionId',executionId);finite('now',now);const e=this.#entries.get(key);if(!e||e.phase!=='ready'||now>e.expiresAt)return false;this.#entries.set(key,Object.freeze({...e,expiresAt:now+this.#budget.readyTtlMs}));return true}
  consume(executionId:string):Readonly<ArcGisSpatialExecutionView>|undefined{this.#active();const key=id('executionId',executionId),e=this.#entries.get(key);if(!e||e.phase!=='ready')return undefined;this.#entries.delete(key);return this.#view(e)}
  cancel(executionId:string):boolean{this.#active();const key=id('executionId',executionId),e=this.#entries.get(key);return !!e&&e.phase!=='ready'&&this.#entries.delete(key)}
  advanceLayerRevision(layerId:string,revision:number):number{this.#active();const layer=id('layerId',layerId);integer('revision',revision);const current=this.#layerRevisions.get(layer);if(current!==undefined&&revision<current)throw new Error('layer revision cannot move backwards');if(current===revision)return 0;let removed=0;for(const[key,e]of this.#entries)if(e.layerId===layer&&e.revision<revision){this.#entries.delete(key);removed++}this.#layerRevisions.set(layer,revision);return removed}
  expire(now:number):number{this.#active();finite('now',now);let removed=0;for(const[key,e]of this.#entries)if(now>e.expiresAt){this.#entries.delete(key);removed++}return removed}
  releaseView(viewId:string):number{const view=id('viewId',viewId);return this.#release(e=>e.viewId===view)}
  releaseLayer(layerId:string):number{const layer=id('layerId',layerId),removed=this.#release(e=>e.layerId===layer);this.#layerRevisions.delete(layer);return removed}
  snapshot():readonly Readonly<ArcGisSpatialExecutionView>[]{this.#active();return Object.freeze([...this.#entries.values()].sort((a,b)=>a.sequence-b.sequence).map(e=>this.#view(e)))}
  fingerprint():string{this.#active();return [...this.#entries.values()].sort((a,b)=>a.executionId.localeCompare(b.executionId)).map(e=>[e.executionId,e.viewId,e.layerId,e.revision,e.kind,e.intent,e.phase,e.actualVertices,e.actualBytes].join(':')).join('|')}
  dispose():void{this.#entries.clear();this.#layerRevisions.clear();this.#disposed=true}
  #release(predicate:(e:Entry)=>boolean):number{this.#active();let total=0;for(const[key,e]of this.#entries)if(predicate(e)){this.#entries.delete(key);total++}return total}
  #count(predicate:(e:Entry)=>boolean):number{let total=0;for(const e of this.#entries.values())if(predicate(e))total++;return total}
  #sumReady(metric:'vertices'|'bytes'):number{let total=0;for(const e of this.#entries.values())if(e.phase==='ready')total+=metric==='vertices'?e.actualVertices:e.actualBytes;return total}
  #view(e:Entry):Readonly<ArcGisSpatialExecutionView>{return Object.freeze({executionId:e.executionId,viewId:e.viewId,layerId:e.layerId,revision:e.revision,kind:e.kind,intent:e.intent,requestedAt:e.requestedAt,estimatedVertices:e.estimatedVertices,estimatedBytes:e.estimatedBytes,phase:e.phase,actualVertices:e.actualVertices,actualBytes:e.actualBytes,sequence:e.sequence,expiresAt:e.expiresAt})}
  #active():void{if(this.#disposed)throw new Error('ArcGisSpatialExecutionLifecyclePolicy is disposed')}
}
