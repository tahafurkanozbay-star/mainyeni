export type QueryPrecisionIntent = 'interactive' | 'visible' | 'background'

export interface QueryPrecisionBudget {
  maxLayers: number
  maxPlans: number
  maxPlansPerLayer: number
  maxTotalTolerance: number
  maxTolerance: number
  maxDecimals: number
  planTtlMs: number
}

export interface QueryPrecisionRequest {
  planId: string
  layerId: string
  revision: number
  intent: QueryPrecisionIntent
  spatialReferenceWkid: number
  tolerance: number
  geometryPrecision: number
  maxAllowableOffset: number
  returnGeometry: boolean
  createdAt: number
}

export interface QueryPrecisionView extends QueryPrecisionRequest {
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Entry extends QueryPrecisionView { readonly signature: string }
const intents: readonly QueryPrecisionIntent[] = ['interactive', 'visible', 'background']
const rank: Readonly<Record<QueryPrecisionIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })

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

/**
 * Bounded, payload-free authority for ArcGIS REST query precision knobs.
 * Geometry precision and generalization affect response size and topology, so the
 * chosen scalar plan is revision-scoped and pressure-governed rather than being
 * retained on Query/Geometry SDK objects.
 */
export class ArcGisQueryPrecisionLifecyclePolicy {
  readonly #budget: Readonly<QueryPrecisionBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #signatures = new Map<string, string>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: QueryPrecisionBudget) {
    integer('maxLayers', budget.maxLayers, 1)
    integer('maxPlans', budget.maxPlans, 1)
    integer('maxPlansPerLayer', budget.maxPlansPerLayer, 1)
    finite('maxTotalTolerance', budget.maxTotalTolerance)
    finite('maxTolerance', budget.maxTolerance)
    integer('maxDecimals', budget.maxDecimals)
    finite('planTtlMs', budget.planTtlMs)
    if (budget.maxPlansPerLayer > budget.maxPlans) throw new Error('maxPlansPerLayer exceeds maxPlans')
    if (budget.maxTolerance > budget.maxTotalTolerance) throw new Error('maxTolerance exceeds maxTotalTolerance')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#live(); const layer = identifier('layerId', layerId); integer('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, revision)
    if (current === undefined || current === revision) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer && entry.revision !== revision) { this.#remove(key); removed++ }
    return removed
  }

  admit(request: QueryPrecisionRequest): QueryPrecisionView | null {
    this.#live()
    const planId = identifier('planId', request.planId); const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision); integer('spatialReferenceWkid', request.spatialReferenceWkid, 1)
    finite('tolerance', request.tolerance); integer('geometryPrecision', request.geometryPrecision); finite('maxAllowableOffset', request.maxAllowableOffset); finite('createdAt', request.createdAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (typeof request.returnGeometry !== 'boolean') throw new Error('returnGeometry must be boolean')
    if (request.geometryPrecision > this.#budget.maxDecimals) return null
    if (request.tolerance > this.#budget.maxTolerance || request.maxAllowableOffset > this.#budget.maxTolerance) return null
    if (!request.returnGeometry && (request.geometryPrecision !== 0 || request.maxAllowableOffset !== 0)) throw new Error('geometry precision requires returnGeometry')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(planId) || this.#layerCount(layerId) >= this.#budget.maxPlansPerLayer) return null
    const signature = `${layerId}\u0000${request.revision}\u0000${request.spatialReferenceWkid}\u0000${request.tolerance}\u0000${request.geometryPrecision}\u0000${request.maxAllowableOffset}\u0000${request.returnGeometry ? 1 : 0}`
    if (this.#signatures.has(signature)) return null
    const pressure = request.tolerance + request.maxAllowableOffset
    if (this.#needsPressure(pressure)) {
      this.#evictFor(request.intent, request.createdAt, pressure)
      if (this.#needsPressure(pressure)) return null
    }
    const entry: Entry = Object.freeze({ ...request, planId, layerId, sequence: ++this.#sequence, touchedAt: request.createdAt, expiresAt: request.createdAt + this.#budget.planTtlMs, signature })
    this.#entries.set(planId, entry); this.#signatures.set(signature, planId)
    return this.#view(entry)
  }

  touch(planId: string, revision: number, now: number): boolean {
    this.#live(); const key = identifier('planId', planId); integer('revision', revision); finite('now', now); this.expire(now)
    const current = this.#entries.get(key)
    if (!current || current.revision !== revision || this.#revisions.get(current.layerId) !== revision) return false
    this.#entries.set(key, Object.freeze({ ...current, touchedAt: now, expiresAt: now + this.#budget.planTtlMs })); return true
  }
  consume(planId: string, revision: number, now: number): QueryPrecisionView | null {
    this.#live(); const key = identifier('planId', planId); integer('revision', revision); finite('now', now); this.expire(now)
    const current = this.#entries.get(key)
    if (!current || current.revision !== revision || this.#revisions.get(current.layerId) !== revision) return null
    this.#remove(key); return this.#view(current)
  }
  release(planId: string): boolean { this.#live(); const key=identifier('planId',planId); if(!this.#entries.has(key)) return false; this.#remove(key); return true }
  releaseLayer(layerId: string): number { this.#live(); const layer=identifier('layerId',layerId); let removed=0; for(const[key,e]of this.#entries)if(e.layerId===layer){this.#remove(key);removed++}this.#revisions.delete(layer);return removed }
  expire(now: number): number { this.#live(); finite('now',now); let removed=0; for(const[key,e]of this.#entries)if(e.expiresAt<=now){this.#remove(key);removed++}return removed }
  snapshot(): Readonly<{layers:number;plans:number;totalTolerance:number}> { this.#live(); return Object.freeze({layers:this.#revisions.size,plans:this.#entries.size,totalTolerance:this.#totalPressure()}) }
  fingerprint(): string { this.#live(); return [...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.signature.localeCompare(b.signature)).map(e=>`${e.layerId}:${e.revision}:${e.intent}:${e.spatialReferenceWkid}:${e.tolerance}:${e.geometryPrecision}:${e.maxAllowableOffset}:${e.returnGeometry?1:0}`).join('|') }
  dispose(): void { if(this.#disposed)return; this.#entries.clear();this.#signatures.clear();this.#revisions.clear();this.#disposed=true }

  #pressure(e: QueryPrecisionRequest): number { return e.tolerance + e.maxAllowableOffset }
  #totalPressure(): number { let total=0; for(const e of this.#entries.values()) total+=this.#pressure(e); return total }
  #needsPressure(incoming:number):boolean{return this.#entries.size>=this.#budget.maxPlans||this.#totalPressure()+incoming>this.#budget.maxTotalTolerance}
  #layerCount(layer:string):number{let total=0;for(const e of this.#entries.values())if(e.layerId===layer)total++;return total}
  #evictFor(intent:QueryPrecisionIntent,now:number,incoming:number):void{const candidates=[...this.#entries.values()].filter(e=>rank[e.intent]<=rank[intent]).sort((a,b)=>rank[a.intent]-rank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence);for(const e of candidates){if(!this.#needsPressure(incoming))break;if(e.touchedAt>now)continue;this.#remove(e.planId)}}
  #remove(key:string):void{const e=this.#entries.get(key);if(!e)return;this.#entries.delete(key);this.#signatures.delete(e.signature)}
  #view(e:Entry):QueryPrecisionView{return Object.freeze({planId:e.planId,layerId:e.layerId,revision:e.revision,intent:e.intent,spatialReferenceWkid:e.spatialReferenceWkid,tolerance:e.tolerance,geometryPrecision:e.geometryPrecision,maxAllowableOffset:e.maxAllowableOffset,returnGeometry:e.returnGeometry,createdAt:e.createdAt,sequence:e.sequence,touchedAt:e.touchedAt,expiresAt:e.expiresAt})}
  #live():void{if(this.#disposed)throw new Error('query precision lifecycle policy is disposed')}
}
