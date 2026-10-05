export type QueryGeometryIntent = 'interactive' | 'visible' | 'background'
export type QueryGeometryKind = 'point' | 'multipoint' | 'polyline' | 'polygon' | 'envelope'

export interface QueryGeometryBudget {
  maxLayers: number
  maxGeometries: number
  maxGeometriesPerLayer: number
  maxVerticesPerGeometry: number
  maxResidentVertices: number
  maxCoordinateMagnitude: number
  geometryTtlMs: number
}

export interface QueryGeometryRequest {
  geometryId: string
  layerId: string
  revision: number
  intent: QueryGeometryIntent
  kind: QueryGeometryKind
  spatialReferenceWkid: number
  vertexCount: number
  minX: number
  minY: number
  maxX: number
  maxY: number
  createdAt: number
}

export interface QueryGeometryView extends QueryGeometryRequest {
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Entry extends QueryGeometryView { readonly signature: string }
const intents: readonly QueryGeometryIntent[] = ['interactive', 'visible', 'background']
const kinds: readonly QueryGeometryKind[] = ['point', 'multipoint', 'polyline', 'polygon', 'envelope']
const rank: Readonly<Record<QueryGeometryIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })

function id(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f]/.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}
function integer(name: string, value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`)
}
function finite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
}
function clock(name: string, value: number): void {
  finite(name, value); if (value < 0) throw new Error(`${name} must be non-negative`)
}

/**
 * Payload-free authority for geometry used by ArcGIS REST spatial queries.
 * It intentionally retains only scalar bounds/counts and never Geometry/Graphic/Query SDK graphs.
 */
export class ArcGisQueryGeometryLifecyclePolicy {
  readonly #budget: Readonly<QueryGeometryBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #signatures = new Map<string, string>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: QueryGeometryBudget) {
    for (const key of ['maxLayers','maxGeometries','maxGeometriesPerLayer','maxVerticesPerGeometry','maxResidentVertices'] as const) integer(key, budget[key], 1)
    finite('maxCoordinateMagnitude', budget.maxCoordinateMagnitude)
    if (budget.maxCoordinateMagnitude <= 0) throw new Error('maxCoordinateMagnitude must be positive')
    clock('geometryTtlMs', budget.geometryTtlMs)
    if (budget.maxGeometriesPerLayer > budget.maxGeometries) throw new Error('maxGeometriesPerLayer exceeds maxGeometries')
    if (budget.maxVerticesPerGeometry > budget.maxResidentVertices) throw new Error('maxVerticesPerGeometry exceeds maxResidentVertices')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#live(); const layer = id('layerId', layerId); integer('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, revision)
    if (current === undefined || current === revision) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer && entry.revision !== revision) { this.#remove(key); removed++ }
    return removed
  }

  admit(request: QueryGeometryRequest): QueryGeometryView | null {
    this.#live()
    const geometryId = id('geometryId', request.geometryId); const layerId = id('layerId', request.layerId)
    integer('revision', request.revision); integer('spatialReferenceWkid', request.spatialReferenceWkid, 1); integer('vertexCount', request.vertexCount, 1); clock('createdAt', request.createdAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (!kinds.includes(request.kind)) throw new Error('kind is invalid')
    for (const [name, value] of [['minX',request.minX],['minY',request.minY],['maxX',request.maxX],['maxY',request.maxY]] as const) {
      finite(name, value); if (Math.abs(value) > this.#budget.maxCoordinateMagnitude) throw new Error(`${name} exceeds coordinate magnitude budget`)
    }
    if (request.minX > request.maxX || request.minY > request.maxY) throw new Error('geometry bounds are inverted')
    if (request.kind === 'point' && request.vertexCount !== 1) throw new Error('point geometry must have exactly one vertex')
    if (request.vertexCount > this.#budget.maxVerticesPerGeometry) return null
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(geometryId) || this.#layerCount(layerId) >= this.#budget.maxGeometriesPerLayer) return null
    const signature = `${layerId}\u0000${request.revision}\u0000${request.kind}\u0000${request.spatialReferenceWkid}\u0000${request.vertexCount}\u0000${request.minX},${request.minY},${request.maxX},${request.maxY}`
    if (this.#signatures.has(signature)) return null
    if (this.#needsPressure(request.vertexCount)) {
      this.#evictFor(request.intent, request.createdAt, request.vertexCount)
      if (this.#needsPressure(request.vertexCount)) return null
    }
    const entry: Entry = Object.freeze({ ...request, geometryId, layerId, sequence: ++this.#sequence, touchedAt: request.createdAt, expiresAt: request.createdAt + this.#budget.geometryTtlMs, signature })
    this.#entries.set(geometryId, entry); this.#signatures.set(signature, geometryId)
    return this.#view(entry)
  }

  touch(geometryId: string, revision: number, now: number): boolean {
    this.#live(); const key=id('geometryId',geometryId); integer('revision',revision); clock('now',now); this.expire(now)
    const current=this.#entries.get(key)
    if(!current||current.revision!==revision||this.#revisions.get(current.layerId)!==revision)return false
    this.#entries.set(key,Object.freeze({...current,touchedAt:now,expiresAt:now+this.#budget.geometryTtlMs})); return true
  }
  consume(geometryId:string,revision:number,now:number):QueryGeometryView|null {
    this.#live();const key=id('geometryId',geometryId);integer('revision',revision);clock('now',now);this.expire(now)
    const current=this.#entries.get(key);if(!current||current.revision!==revision||this.#revisions.get(current.layerId)!==revision)return null
    this.#remove(key);return this.#view(current)
  }
  release(geometryId:string):boolean{this.#live();const key=id('geometryId',geometryId);if(!this.#entries.has(key))return false;this.#remove(key);return true}
  releaseLayer(layerId:string):number{this.#live();const layer=id('layerId',layerId);let removed=0;for(const[key,entry]of this.#entries)if(entry.layerId===layer){this.#remove(key);removed++}this.#revisions.delete(layer);return removed}
  expire(now:number):number{this.#live();clock('now',now);let removed=0;for(const[key,entry]of this.#entries)if(entry.expiresAt<=now){this.#remove(key);removed++}return removed}
  snapshot():Readonly<{layers:number;geometries:number;residentVertices:number}>{this.#live();return Object.freeze({layers:this.#revisions.size,geometries:this.#entries.size,residentVertices:this.#residentVertices()})}
  fingerprint():string{this.#live();return[...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.signature.localeCompare(b.signature)).map(e=>`${e.layerId}:${e.revision}:${e.intent}:${e.kind}:${e.spatialReferenceWkid}:${e.vertexCount}:${e.minX},${e.minY},${e.maxX},${e.maxY}`).join('|')}
  dispose():void{if(this.#disposed)return;this.#entries.clear();this.#signatures.clear();this.#revisions.clear();this.#disposed=true}

  #needsPressure(vertices:number):boolean{return this.#entries.size>=this.#budget.maxGeometries||this.#residentVertices()+vertices>this.#budget.maxResidentVertices}
  #residentVertices():number{let total=0;for(const entry of this.#entries.values())total+=entry.vertexCount;return total}
  #layerCount(layer:string):number{let total=0;for(const entry of this.#entries.values())if(entry.layerId===layer)total++;return total}
  #evictFor(intent:QueryGeometryIntent,now:number,vertices:number):void{const candidates=[...this.#entries.values()].filter(e=>rank[e.intent]<=rank[intent]).sort((a,b)=>rank[a.intent]-rank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence);for(const entry of candidates){if(!this.#needsPressure(vertices))break;if(entry.touchedAt>now)continue;this.#remove(entry.geometryId)}}
  #remove(key:string):void{const entry=this.#entries.get(key);if(!entry)return;this.#entries.delete(key);this.#signatures.delete(entry.signature)}
  #view(entry:Entry):QueryGeometryView{return Object.freeze({geometryId:entry.geometryId,layerId:entry.layerId,revision:entry.revision,intent:entry.intent,kind:entry.kind,spatialReferenceWkid:entry.spatialReferenceWkid,vertexCount:entry.vertexCount,minX:entry.minX,minY:entry.minY,maxX:entry.maxX,maxY:entry.maxY,createdAt:entry.createdAt,sequence:entry.sequence,touchedAt:entry.touchedAt,expiresAt:entry.expiresAt})}
  #live():void{if(this.#disposed)throw new Error('query geometry lifecycle policy is disposed')}
}
