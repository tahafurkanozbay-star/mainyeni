export type QueryOrderIntent = 'interactive' | 'visible' | 'background'
export type QueryOrderDirection = 'ASC' | 'DESC'

export interface QueryOrderBudget {
  maxLayers: number
  maxOrders: number
  maxOrdersPerLayer: number
  maxFieldsPerOrder: number
  maxResidentFieldRefs: number
  maxFieldNameBytes: number
  orderTtlMs: number
}

export interface QueryOrderField {
  fieldName: string
  direction: QueryOrderDirection
}

export interface QueryOrderRequest {
  orderId: string
  layerId: string
  revision: number
  intent: QueryOrderIntent
  fields: readonly QueryOrderField[]
  createdAt: number
}

export interface QueryOrderView {
  readonly orderId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: QueryOrderIntent
  readonly fieldCount: number
  readonly fieldNameBytes: number
  readonly sequence: number
  readonly createdAt: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface OrderEntry extends QueryOrderView { signature: string }
const intents: readonly QueryOrderIntent[] = ['interactive', 'visible', 'background']
const rank: Readonly<Record<QueryOrderIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })

function id(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f]/.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}
function integer(name: string, value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`)
}
function clock(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}
function utf8Bytes(value: string): number {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
  }
  return bytes
}

/** Payload-free authority for ArcGIS REST orderByFields clauses. */
export class ArcGisQueryOrderByLifecyclePolicy {
  readonly #budget: Readonly<QueryOrderBudget>
  readonly #entries = new Map<string, OrderEntry>()
  readonly #signatures = new Map<string, string>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: QueryOrderBudget) {
    for (const key of ['maxLayers','maxOrders','maxOrdersPerLayer','maxFieldsPerOrder','maxResidentFieldRefs','maxFieldNameBytes'] as const) integer(key, budget[key], 1)
    clock('orderTtlMs', budget.orderTtlMs)
    if (budget.maxOrdersPerLayer > budget.maxOrders) throw new Error('maxOrdersPerLayer exceeds maxOrders')
    if (budget.maxFieldsPerOrder > budget.maxResidentFieldRefs) throw new Error('maxFieldsPerOrder exceeds maxResidentFieldRefs')
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

  admit(request: QueryOrderRequest): QueryOrderView | null {
    this.#live(); const orderId = id('orderId', request.orderId); const layerId = id('layerId', request.layerId)
    integer('revision', request.revision); clock('createdAt', request.createdAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(orderId)) return null
    const fields = this.#normalize(request.fields)
    if (fields.length > this.#budget.maxFieldsPerOrder) return null
    const fieldNameBytes = fields.reduce((sum, field) => sum + utf8Bytes(field.fieldName), 0)
    if (fieldNameBytes > this.#budget.maxFieldNameBytes) return null
    const signature = `${layerId}\u0000${request.revision}\u0000${fields.map(field => `${field.fieldName}:${field.direction}`).join('\u001f')}`
    if (this.#signatures.has(signature) || this.#layerCount(layerId) >= this.#budget.maxOrdersPerLayer) return null
    if (this.#entries.size >= this.#budget.maxOrders || this.#residentFieldRefs() + fields.length > this.#budget.maxResidentFieldRefs) {
      this.#evictFor(request.intent, request.createdAt, fields.length)
      if (this.#entries.size >= this.#budget.maxOrders || this.#residentFieldRefs() + fields.length > this.#budget.maxResidentFieldRefs) return null
    }
    const entry: OrderEntry = Object.freeze({ orderId, layerId, revision: request.revision, intent: request.intent, fieldCount: fields.length, fieldNameBytes, sequence: ++this.#sequence, createdAt: request.createdAt, touchedAt: request.createdAt, expiresAt: request.createdAt + this.#budget.orderTtlMs, signature })
    this.#entries.set(orderId, entry); this.#signatures.set(signature, orderId); return this.#view(entry)
  }

  touch(orderId: string, revision: number, now: number): boolean {
    this.#live(); const key=id('orderId',orderId); integer('revision',revision); clock('now',now); this.expire(now)
    const current=this.#entries.get(key)
    if(!current||current.revision!==revision||this.#revisions.get(current.layerId)!==revision)return false
    this.#entries.set(key,Object.freeze({...current,touchedAt:now,expiresAt:now+this.#budget.orderTtlMs}));return true
  }
  release(orderId:string):boolean{this.#live();const key=id('orderId',orderId);if(!this.#entries.has(key))return false;this.#remove(key);return true}
  releaseLayer(layerId:string):number{this.#live();const layer=id('layerId',layerId);let removed=0;for(const[key,entry]of this.#entries)if(entry.layerId===layer){this.#remove(key);removed++}this.#revisions.delete(layer);return removed}
  expire(now:number):number{this.#live();clock('now',now);let removed=0;for(const[key,entry]of this.#entries)if(entry.expiresAt<=now){this.#remove(key);removed++}return removed}
  snapshot():Readonly<{layers:number;orders:number;fieldRefs:number;fieldNameBytes:number}>{this.#live();let fieldRefs=0,fieldNameBytes=0;for(const entry of this.#entries.values()){fieldRefs+=entry.fieldCount;fieldNameBytes+=entry.fieldNameBytes}return Object.freeze({layers:this.#revisions.size,orders:this.#entries.size,fieldRefs,fieldNameBytes})}
  fingerprint():string{this.#live();return[...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.signature.localeCompare(b.signature)).map(entry=>`${entry.layerId}:${entry.revision}:${entry.intent}:${entry.fieldCount}:${entry.fieldNameBytes}:${entry.signature}`).join('|')}
  dispose():void{if(this.#disposed)return;this.#entries.clear();this.#signatures.clear();this.#revisions.clear();this.#disposed=true}

  #normalize(values:readonly QueryOrderField[]):QueryOrderField[]{
    if(!Array.isArray(values)||values.length===0)throw new Error('fields must be non-empty')
    const seen=new Set<string>();const normalized:QueryOrderField[]=[]
    for(const value of values){const fieldName=id('fieldName',value.fieldName);if(/[*;,()=]/.test(fieldName))throw new Error('fieldName is unsafe');if(value.direction!=='ASC'&&value.direction!=='DESC')throw new Error('direction is invalid');const key=fieldName.toLocaleLowerCase('en-US');if(seen.has(key))throw new Error('duplicate order field');seen.add(key);normalized.push(Object.freeze({fieldName,direction:value.direction}))}
    return normalized
  }
  #layerCount(layer:string):number{let count=0;for(const entry of this.#entries.values())if(entry.layerId===layer)count++;return count}
  #residentFieldRefs():number{let count=0;for(const entry of this.#entries.values())count+=entry.fieldCount;return count}
  #evictFor(intent:QueryOrderIntent,now:number,needed:number):void{const candidates=[...this.#entries.values()].filter(entry=>rank[entry.intent]<=rank[intent]).sort((a,b)=>rank[a.intent]-rank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence);for(const entry of candidates){if(this.#entries.size<this.#budget.maxOrders&&this.#residentFieldRefs()+needed<=this.#budget.maxResidentFieldRefs)break;if(entry.touchedAt>now)continue;this.#remove(entry.orderId)}}
  #remove(key:string):void{const entry=this.#entries.get(key);if(!entry)return;this.#entries.delete(key);this.#signatures.delete(entry.signature)}
  #view(entry:OrderEntry):QueryOrderView{return Object.freeze({orderId:entry.orderId,layerId:entry.layerId,revision:entry.revision,intent:entry.intent,fieldCount:entry.fieldCount,fieldNameBytes:entry.fieldNameBytes,sequence:entry.sequence,createdAt:entry.createdAt,touchedAt:entry.touchedAt,expiresAt:entry.expiresAt})}
  #live():void{if(this.#disposed)throw new Error('query order lifecycle policy is disposed')}
}
