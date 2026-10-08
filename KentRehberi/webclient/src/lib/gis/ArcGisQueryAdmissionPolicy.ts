export type ArcGisQueryPriority = 'interactive' | 'foreground' | 'background'
export type ArcGisQueryGeometryKind = 'point' | 'polyline' | 'polygon' | 'extent' | 'none'

export interface ArcGisQueryAdmissionBudget {
  maxServices: number
  maxLayersPerService: number
  maxActiveQueries: number
  maxQueuedQueries: number
  maxActivePerLayer: number
  maxQueuedPerLayer: number
  maxResultRecords: number
  maxOffset: number
  maxOutFields: number
  maxWhereLength: number
  maxGeometryVertices: number
  maxEstimatedResponseBytes: number
  maxAggregateEstimatedResponseBytes: number
  maxQueueAgeMs: number
  maxExecutionAgeMs: number
}

export interface ArcGisQueryIntent {
  id: string
  serviceId: string
  layerId: string
  revision: number
  priority: ArcGisQueryPriority
  geometryKind: ArcGisQueryGeometryKind
  geometryVertices: number
  resultRecordCount: number
  resultOffset: number
  outFields: readonly string[]
  whereLength: number
  estimatedResponseBytes: number
  createdAt: number
}

export interface ArcGisQueryLease {
  readonly id: string
  readonly serviceId: string
  readonly layerId: string
  readonly revision: number
  readonly admittedAt: number
  readonly expiresAt: number
  readonly estimatedResponseBytes: number
}

export interface ArcGisQueryAdmissionSnapshot {
  readonly active: number
  readonly queued: number
  readonly activeEstimatedResponseBytes: number
  readonly services: number
  readonly layers: number
  readonly admitted: number
  readonly rejected: number
  readonly expired: number
  readonly cancelled: number
}

interface StoredIntent extends ArcGisQueryIntent { sequence: number }
interface StoredLease extends ArcGisQueryLease { sequence: number }

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,160}$/
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const PRIORITY_WEIGHT: Readonly<Record<ArcGisQueryPriority, number>> = Object.freeze({ interactive: 0, foreground: 1, background: 2 })

function positiveInteger(name: string, value: number) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
}
function nonNegativeInteger(name: string, value: number) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}
function finiteTime(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}
function safeId(name: string, value: string) {
  const normalized = value.trim()
  if (!IDENTIFIER.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}
function layerKey(serviceId: string, layerId: string) { return `${serviceId}\u0000${layerId}` }

/**
 * Bounded, payload-free admission authority for ArcGIS REST query work.
 * It deliberately stores scalar intent metadata only: no URL, token, where clause,
 * geometry payload, SDK object, response body, AbortController, Graphic or LayerView.
 */
export class ArcGisQueryAdmissionPolicy {
  readonly #budget: Readonly<ArcGisQueryAdmissionBudget>
  readonly #queue = new Map<string, StoredIntent>()
  readonly #active = new Map<string, StoredLease>()
  #sequence = 0
  #admitted = 0
  #rejected = 0
  #expired = 0
  #cancelled = 0
  #disposed = false

  constructor(budget: ArcGisQueryAdmissionBudget) {
    positiveInteger('maxServices', budget.maxServices)
    positiveInteger('maxLayersPerService', budget.maxLayersPerService)
    positiveInteger('maxActiveQueries', budget.maxActiveQueries)
    positiveInteger('maxQueuedQueries', budget.maxQueuedQueries)
    positiveInteger('maxActivePerLayer', budget.maxActivePerLayer)
    positiveInteger('maxQueuedPerLayer', budget.maxQueuedPerLayer)
    positiveInteger('maxResultRecords', budget.maxResultRecords)
    nonNegativeInteger('maxOffset', budget.maxOffset)
    positiveInteger('maxOutFields', budget.maxOutFields)
    positiveInteger('maxWhereLength', budget.maxWhereLength)
    positiveInteger('maxGeometryVertices', budget.maxGeometryVertices)
    positiveInteger('maxEstimatedResponseBytes', budget.maxEstimatedResponseBytes)
    positiveInteger('maxAggregateEstimatedResponseBytes', budget.maxAggregateEstimatedResponseBytes)
    positiveInteger('maxQueueAgeMs', budget.maxQueueAgeMs)
    positiveInteger('maxExecutionAgeMs', budget.maxExecutionAgeMs)
    if (budget.maxActivePerLayer > budget.maxActiveQueries) throw new Error('active per-layer budget exceeds global budget')
    if (budget.maxQueuedPerLayer > budget.maxQueuedQueries) throw new Error('queued per-layer budget exceeds global budget')
    if (budget.maxEstimatedResponseBytes > budget.maxAggregateEstimatedResponseBytes) throw new Error('response byte budget is inconsistent')
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(source: ArcGisQueryIntent, now: number): Readonly<ArcGisQueryIntent> {
    this.#assertActive(); finiteTime('now', now)
    const intent = this.#normalize(source)
    if (intent.createdAt > now) return this.#reject('query creation time cannot be in the future')
    if (now - intent.createdAt > this.#budget.maxQueueAgeMs) return this.#reject('query intent is already expired')
    if (this.#queue.has(intent.id) || this.#active.has(intent.id)) return this.#reject('query id is already registered')
    if (this.#queue.size >= this.#budget.maxQueuedQueries) return this.#reject('query queue capacity exceeded')
    if (this.#queuedForLayer(intent.serviceId, intent.layerId) >= this.#budget.maxQueuedPerLayer) return this.#reject('layer queue capacity exceeded')
    this.#assertCardinality(intent.serviceId, intent.layerId)
    const stored: StoredIntent = Object.freeze({ ...intent, sequence: ++this.#sequence })
    this.#queue.set(stored.id, stored)
    return this.#intentView(stored)
  }

  admitNext(now: number): Readonly<ArcGisQueryLease> | undefined {
    this.#assertActive(); finiteTime('now', now); this.sweep(now)
    if (this.#active.size >= this.#budget.maxActiveQueries) return undefined
    const candidates = [...this.#queue.values()]
      .filter(intent => this.#activeForLayer(intent.serviceId, intent.layerId) < this.#budget.maxActivePerLayer)
      .filter(intent => this.#activeBytes() + intent.estimatedResponseBytes <= this.#budget.maxAggregateEstimatedResponseBytes)
      .sort((a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] || a.createdAt - b.createdAt || a.sequence - b.sequence || a.id.localeCompare(b.id))
    const next = candidates[0]
    if (!next) return undefined
    this.#queue.delete(next.id)
    const lease: StoredLease = Object.freeze({ id: next.id, serviceId: next.serviceId, layerId: next.layerId, revision: next.revision, admittedAt: now, expiresAt: now + this.#budget.maxExecutionAgeMs, estimatedResponseBytes: next.estimatedResponseBytes, sequence: ++this.#sequence })
    this.#active.set(lease.id, lease); this.#admitted++
    return this.#leaseView(lease)
  }

  complete(id: string, revision: number): boolean {
    this.#assertActive(); const key = safeId('id', id); nonNegativeInteger('revision', revision)
    const lease = this.#active.get(key)
    if (!lease || lease.revision !== revision) return false
    this.#active.delete(key); return true
  }

  cancel(id: string): boolean {
    this.#assertActive(); const key = safeId('id', id)
    const removed = this.#queue.delete(key) || this.#active.delete(key)
    if (removed) this.#cancelled++
    return removed
  }

  cancelLayer(serviceId: string, layerId: string): number {
    this.#assertActive(); const service = safeId('serviceId', serviceId), layer = safeId('layerId', layerId)
    let removed = 0
    for (const [id, intent] of this.#queue) if (intent.serviceId === service && intent.layerId === layer) { this.#queue.delete(id); removed++ }
    for (const [id, lease] of this.#active) if (lease.serviceId === service && lease.layerId === layer) { this.#active.delete(id); removed++ }
    this.#cancelled += removed; return removed
  }

  sweep(now: number): number {
    this.#assertActive(); finiteTime('now', now); let removed = 0
    for (const [id, intent] of this.#queue) if (now - intent.createdAt > this.#budget.maxQueueAgeMs) { this.#queue.delete(id); removed++; this.#expired++ }
    for (const [id, lease] of this.#active) if (now >= lease.expiresAt) { this.#active.delete(id); removed++; this.#expired++ }
    return removed
  }

  queued(): readonly Readonly<ArcGisQueryIntent>[] {
    this.#assertActive()
    return Object.freeze([...this.#queue.values()].sort((a,b)=>a.sequence-b.sequence).map(value => this.#intentView(value)))
  }

  active(): readonly Readonly<ArcGisQueryLease>[] {
    this.#assertActive()
    return Object.freeze([...this.#active.values()].sort((a,b)=>a.sequence-b.sequence).map(value => this.#leaseView(value)))
  }

  snapshot(): Readonly<ArcGisQueryAdmissionSnapshot> {
    this.#assertActive()
    const services = new Set<string>(), layers = new Set<string>()
    for (const item of [...this.#queue.values(), ...this.#active.values()]) { services.add(item.serviceId); layers.add(layerKey(item.serviceId,item.layerId)) }
    return Object.freeze({ active:this.#active.size, queued:this.#queue.size, activeEstimatedResponseBytes:this.#activeBytes(), services:services.size, layers:layers.size, admitted:this.#admitted, rejected:this.#rejected, expired:this.#expired, cancelled:this.#cancelled })
  }

  dispose() { if (this.#disposed) return; this.#queue.clear(); this.#active.clear(); this.#disposed = true }

  #normalize(source: ArcGisQueryIntent): ArcGisQueryIntent {
    const id=safeId('id',source.id), serviceId=safeId('serviceId',source.serviceId), layerId=safeId('layerId',source.layerId)
    nonNegativeInteger('revision',source.revision); nonNegativeInteger('geometryVertices',source.geometryVertices); positiveInteger('resultRecordCount',source.resultRecordCount); nonNegativeInteger('offset',source.resultOffset); nonNegativeInteger('whereLength',source.whereLength); positiveInteger('estimatedResponseBytes',source.estimatedResponseBytes); finiteTime('createdAt',source.createdAt)
    if (source.resultRecordCount>this.#budget.maxResultRecords) return this.#reject('result record count exceeds budget')
    if (source.resultOffset>this.#budget.maxOffset) return this.#reject('result offset exceeds budget')
    if (source.whereLength>this.#budget.maxWhereLength) return this.#reject('where length exceeds budget')
    if (source.geometryVertices>this.#budget.maxGeometryVertices) return this.#reject('geometry vertex count exceeds budget')
    if (source.geometryKind==='none' && source.geometryVertices!==0) return this.#reject('non-spatial query cannot declare geometry vertices')
    if (source.geometryKind!=='none' && source.geometryVertices===0) return this.#reject('spatial query requires geometry vertices')
    if (source.estimatedResponseBytes>this.#budget.maxEstimatedResponseBytes) return this.#reject('estimated response bytes exceed budget')
    if (source.outFields.length===0 || source.outFields.length>this.#budget.maxOutFields) return this.#reject('outFields count exceeds budget')
    const seen=new Set<string>(), outFields:string[]=[]
    for(const raw of source.outFields){const field=raw.trim();if(field!=='*'&&!FIELD.test(field))return this.#reject('outField is invalid');const folded=field.toLocaleLowerCase('en-US');if(seen.has(folded))return this.#reject('duplicate outField');seen.add(folded);outFields.push(field)}
    if(outFields.includes('*')&&outFields.length!==1)return this.#reject('wildcard outField must be exclusive')
    return Object.freeze({ ...source,id,serviceId,layerId,outFields:Object.freeze(outFields) })
  }

  #assertCardinality(serviceId:string,layerId:string){const services=new Set<string>(), layersByService=new Map<string,Set<string>>();for(const item of [...this.#queue.values(),...this.#active.values()]){services.add(item.serviceId);const set=layersByService.get(item.serviceId)??new Set<string>();set.add(item.layerId);layersByService.set(item.serviceId,set)}if(!services.has(serviceId)&&services.size>=this.#budget.maxServices)this.#reject('service cardinality exceeded');const layers=layersByService.get(serviceId);if(!layers?.has(layerId)&&(layers?.size??0)>=this.#budget.maxLayersPerService)this.#reject('layer cardinality exceeded')}
  #queuedForLayer(s:string,l:string){let n=0;for(const x of this.#queue.values())if(x.serviceId===s&&x.layerId===l)n++;return n}
  #activeForLayer(s:string,l:string){let n=0;for(const x of this.#active.values())if(x.serviceId===s&&x.layerId===l)n++;return n}
  #activeBytes(){let n=0;for(const x of this.#active.values())n+=x.estimatedResponseBytes;return n}
  #intentView(x:StoredIntent|ArcGisQueryIntent):Readonly<ArcGisQueryIntent>{return Object.freeze({id:x.id,serviceId:x.serviceId,layerId:x.layerId,revision:x.revision,priority:x.priority,geometryKind:x.geometryKind,geometryVertices:x.geometryVertices,resultRecordCount:x.resultRecordCount,resultOffset:x.resultOffset,outFields:Object.freeze([...x.outFields]),whereLength:x.whereLength,estimatedResponseBytes:x.estimatedResponseBytes,createdAt:x.createdAt})}
  #leaseView(x:StoredLease):Readonly<ArcGisQueryLease>{return Object.freeze({id:x.id,serviceId:x.serviceId,layerId:x.layerId,revision:x.revision,admittedAt:x.admittedAt,expiresAt:x.expiresAt,estimatedResponseBytes:x.estimatedResponseBytes})}
  #reject(message:string):never{this.#rejected++;throw new Error(message)}
  #assertActive(){if(this.#disposed)throw new Error('query admission policy is disposed')}
}
