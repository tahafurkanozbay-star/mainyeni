export type QuerySpatialRelationIntent = 'interactive' | 'visible' | 'background'
export type QuerySpatialRelation = 'intersects' | 'contains' | 'crosses' | 'envelope-intersects' | 'index-intersects' | 'overlaps' | 'touches' | 'within'

export interface QuerySpatialRelationBudget {
  maxLayers: number
  maxPlans: number
  maxPlansPerLayer: number
  maxAggregateDistance: number
  maxDistance: number
  maxUnitsLength: number
  planTtlMs: number
}

export interface QuerySpatialRelationRequest {
  planId: string
  layerId: string
  revision: number
  intent: QuerySpatialRelationIntent
  relation: QuerySpatialRelation
  distance: number
  units: string | null
  returnGeometry: boolean
  createdAt: number
}

export interface QuerySpatialRelationView extends QuerySpatialRelationRequest {
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Entry extends QuerySpatialRelationView { readonly signature: string }
const intents: readonly QuerySpatialRelationIntent[] = ['interactive', 'visible', 'background']
const relations: readonly QuerySpatialRelation[] = ['intersects','contains','crosses','envelope-intersects','index-intersects','overlaps','touches','within']
const rank: Readonly<Record<QuerySpatialRelationIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })

function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f]/.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}
function integer(name: string, value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`)
}
function finite(name: string, value: number, min = 0): void {
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be finite and >= ${min}`)
}
function normalizeUnits(value: string | null, maxLength: number): string | null {
  if (value === null) return null
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized.length > maxLength || !/^[a-z][a-z-]*$/.test(normalized)) throw new Error('units is invalid')
  return normalized
}

/** Payload-free authority for ArcGIS REST spatial relationship query plans. */
export class ArcGisQuerySpatialRelationLifecyclePolicy {
  readonly #budget: Readonly<QuerySpatialRelationBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #signatures = new Map<string, string>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: QuerySpatialRelationBudget) {
    integer('maxLayers', budget.maxLayers, 1)
    integer('maxPlans', budget.maxPlans, 1)
    integer('maxPlansPerLayer', budget.maxPlansPerLayer, 1)
    finite('maxAggregateDistance', budget.maxAggregateDistance)
    finite('maxDistance', budget.maxDistance)
    integer('maxUnitsLength', budget.maxUnitsLength, 1)
    finite('planTtlMs', budget.planTtlMs)
    if (budget.maxPlansPerLayer > budget.maxPlans) throw new Error('maxPlansPerLayer exceeds maxPlans')
    if (budget.maxDistance > budget.maxAggregateDistance) throw new Error('maxDistance exceeds maxAggregateDistance')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#live()
    const layer = identifier('layerId', layerId); integer('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, revision)
    if (current === undefined || current === revision) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer && entry.revision !== revision) { this.#remove(key); removed++ }
    return removed
  }

  admit(request: QuerySpatialRelationRequest): QuerySpatialRelationView | null {
    this.#live()
    const planId = identifier('planId', request.planId)
    const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision); finite('distance', request.distance); finite('createdAt', request.createdAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (!relations.includes(request.relation)) throw new Error('relation is invalid')
    if (typeof request.returnGeometry !== 'boolean') throw new Error('returnGeometry must be boolean')
    const units = normalizeUnits(request.units, this.#budget.maxUnitsLength)
    if ((request.distance === 0) !== (units === null)) throw new Error('distance and units must be supplied together')
    if (request.distance > this.#budget.maxDistance) return null
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(planId) || this.#layerCount(layerId) >= this.#budget.maxPlansPerLayer) return null
    const signature = `${layerId}\u0000${request.revision}\u0000${request.relation}\u0000${request.distance}\u0000${units ?? ''}\u0000${request.returnGeometry ? 1 : 0}`
    if (this.#signatures.has(signature)) return null
    if (this.#needsPressure(request.distance)) {
      this.#evictFor(request.intent, request.createdAt, request.distance)
      if (this.#needsPressure(request.distance)) return null
    }
    const entry: Entry = Object.freeze({ ...request, planId, layerId, units, sequence: ++this.#sequence, touchedAt: request.createdAt, expiresAt: request.createdAt + this.#budget.planTtlMs, signature })
    this.#entries.set(planId, entry); this.#signatures.set(signature, planId)
    return this.#view(entry)
  }

  touch(planId: string, revision: number, now: number): boolean {
    this.#live(); const key = identifier('planId', planId); integer('revision', revision); finite('now', now); this.expire(now)
    const current = this.#entries.get(key)
    if (!current || current.revision !== revision || this.#revisions.get(current.layerId) !== revision) return false
    this.#entries.set(key, Object.freeze({ ...current, touchedAt: now, expiresAt: now + this.#budget.planTtlMs })); return true
  }
  consume(planId: string, revision: number, now: number): QuerySpatialRelationView | null {
    this.#live(); const key = identifier('planId', planId); integer('revision', revision); finite('now', now); this.expire(now)
    const current = this.#entries.get(key)
    if (!current || current.revision !== revision || this.#revisions.get(current.layerId) !== revision) return null
    this.#remove(key); return this.#view(current)
  }
  release(planId: string): boolean { this.#live(); const key=identifier('planId',planId); if(!this.#entries.has(key))return false;this.#remove(key);return true }
  releaseLayer(layerId: string): number { this.#live();const layer=identifier('layerId',layerId);let removed=0;for(const[key,e]of this.#entries)if(e.layerId===layer){this.#remove(key);removed++}this.#revisions.delete(layer);return removed }
  expire(now: number): number { this.#live();finite('now',now);let removed=0;for(const[key,e]of this.#entries)if(e.expiresAt<=now){this.#remove(key);removed++}return removed }
  snapshot(): Readonly<{layers:number;plans:number;aggregateDistance:number}> { this.#live();return Object.freeze({layers:this.#revisions.size,plans:this.#entries.size,aggregateDistance:this.#totalDistance()}) }
  fingerprint(): string { this.#live();return [...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.signature.localeCompare(b.signature)).map(e=>`${e.layerId}:${e.revision}:${e.intent}:${e.relation}:${e.distance}:${e.units??'-'}:${e.returnGeometry?1:0}`).join('|') }
  dispose(): void { if(this.#disposed)return;this.#entries.clear();this.#signatures.clear();this.#revisions.clear();this.#disposed=true }

  #totalDistance(): number { let total=0;for(const e of this.#entries.values())total+=e.distance;return total }
  #needsPressure(incoming:number):boolean{return this.#entries.size>=this.#budget.maxPlans||this.#totalDistance()+incoming>this.#budget.maxAggregateDistance}
  #layerCount(layer:string):number{let total=0;for(const e of this.#entries.values())if(e.layerId===layer)total++;return total}
  #evictFor(intent:QuerySpatialRelationIntent,now:number,incoming:number):void{const candidates=[...this.#entries.values()].filter(e=>rank[e.intent]<=rank[intent]).sort((a,b)=>rank[a.intent]-rank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence);for(const e of candidates){if(!this.#needsPressure(incoming))break;if(e.touchedAt>now)continue;this.#remove(e.planId)}}
  #remove(key:string):void{const e=this.#entries.get(key);if(!e)return;this.#entries.delete(key);this.#signatures.delete(e.signature)}
  #view(e:Entry):QuerySpatialRelationView{return Object.freeze({planId:e.planId,layerId:e.layerId,revision:e.revision,intent:e.intent,relation:e.relation,distance:e.distance,units:e.units,returnGeometry:e.returnGeometry,createdAt:e.createdAt,sequence:e.sequence,touchedAt:e.touchedAt,expiresAt:e.expiresAt})}
  #live():void{if(this.#disposed)throw new Error('query spatial relation lifecycle policy is disposed')}
}
