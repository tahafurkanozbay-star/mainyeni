export type QueryFieldProjectionIntent = 'interactive' | 'visible' | 'background'

export interface QueryFieldProjectionBudget {
  maxLayers: number
  maxProjections: number
  maxProjectionsPerLayer: number
  maxFieldsPerProjection: number
  maxFieldNameBytes: number
  maxResidentFieldRefs: number
  projectionTtlMs: number
}

export interface QueryFieldProjectionRequest {
  projectionId: string
  layerId: string
  revision: number
  intent: QueryFieldProjectionIntent
  fieldNames: readonly string[]
  createdAt: number
}

export interface QueryFieldProjectionView {
  readonly projectionId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: QueryFieldProjectionIntent
  readonly fieldCount: number
  readonly fieldNameBytes: number
  readonly sequence: number
  readonly createdAt: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface ProjectionEntry extends QueryFieldProjectionView {
  signature: string
}

const intents: readonly QueryFieldProjectionIntent[] = ['interactive', 'visible', 'background']
const rank: Readonly<Record<QueryFieldProjectionIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })

function boundedId(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f]/.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}
function safeInteger(name: string, value: number, min = 0): void {
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

/**
 * Payload-free authority for ArcGIS REST outFields projections. It keeps only
 * normalized field identifiers and scalar accounting; query/feature payloads,
 * geometry, credentials and SDK objects remain owned by the caller.
 */
export class ArcGisQueryFieldProjectionLifecyclePolicy {
  readonly #budget: Readonly<QueryFieldProjectionBudget>
  readonly #entries = new Map<string, ProjectionEntry>()
  readonly #signatures = new Map<string, string>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: QueryFieldProjectionBudget) {
    for (const key of ['maxLayers','maxProjections','maxProjectionsPerLayer','maxFieldsPerProjection','maxFieldNameBytes','maxResidentFieldRefs'] as const) safeInteger(key, budget[key], 1)
    clock('projectionTtlMs', budget.projectionTtlMs)
    if (budget.maxProjectionsPerLayer > budget.maxProjections) throw new Error('maxProjectionsPerLayer exceeds maxProjections')
    if (budget.maxFieldsPerProjection > budget.maxResidentFieldRefs) throw new Error('maxFieldsPerProjection exceeds maxResidentFieldRefs')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#live()
    const layer = boundedId('layerId', layerId)
    safeInteger('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, revision)
    if (current === undefined || current === revision) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer && entry.revision !== revision) { this.#remove(key); removed++ }
    return removed
  }

  admit(request: QueryFieldProjectionRequest): QueryFieldProjectionView | null {
    this.#live()
    const projectionId = boundedId('projectionId', request.projectionId)
    const layerId = boundedId('layerId', request.layerId)
    safeInteger('revision', request.revision)
    clock('createdAt', request.createdAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(projectionId)) return null
    const fields = this.#normalizeFields(request.fieldNames)
    if (fields.length > this.#budget.maxFieldsPerProjection) return null
    const fieldNameBytes = fields.reduce((total, field) => total + utf8Bytes(field), 0)
    if (fieldNameBytes > this.#budget.maxFieldNameBytes) return null
    const signature = this.#signature(layerId, request.revision, fields)
    if (this.#signatures.has(signature)) return null
    if (this.#layerCount(layerId) >= this.#budget.maxProjectionsPerLayer) return null
    if (this.#entries.size >= this.#budget.maxProjections || this.#residentFieldRefs() + fields.length > this.#budget.maxResidentFieldRefs) {
      this.#evictFor(request.intent, request.createdAt, fields.length)
      if (this.#entries.size >= this.#budget.maxProjections || this.#residentFieldRefs() + fields.length > this.#budget.maxResidentFieldRefs) return null
    }
    const entry: ProjectionEntry = Object.freeze({ projectionId, layerId, revision: request.revision, intent: request.intent, fieldCount: fields.length, fieldNameBytes, sequence: ++this.#sequence, createdAt: request.createdAt, touchedAt: request.createdAt, expiresAt: request.createdAt + this.#budget.projectionTtlMs, signature })
    this.#entries.set(projectionId, entry)
    this.#signatures.set(signature, projectionId)
    return this.#view(entry)
  }

  touch(projectionId: string, revision: number, now: number): boolean {
    this.#live(); const key = boundedId('projectionId', projectionId); safeInteger('revision', revision); clock('now', now); this.expire(now)
    const current = this.#entries.get(key)
    if (!current || current.revision !== revision || this.#revisions.get(current.layerId) !== revision) return false
    this.#entries.set(key, Object.freeze({ ...current, touchedAt: now, expiresAt: now + this.#budget.projectionTtlMs }))
    return true
  }

  release(projectionId: string): boolean { this.#live(); const key = boundedId('projectionId', projectionId); if (!this.#entries.has(key)) return false; this.#remove(key); return true }
  releaseLayer(layerId: string): number { this.#live(); const layer = boundedId('layerId', layerId); let removed = 0; for (const [key, entry] of this.#entries) if (entry.layerId === layer) { this.#remove(key); removed++ } this.#revisions.delete(layer); return removed }
  expire(now: number): number { this.#live(); clock('now', now); let removed = 0; for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) { this.#remove(key); removed++ } return removed }
  snapshot(): Readonly<{layers:number;projections:number;fieldRefs:number;fieldNameBytes:number}> { this.#live(); let fieldRefs=0,fieldNameBytes=0; for(const entry of this.#entries.values()){fieldRefs+=entry.fieldCount;fieldNameBytes+=entry.fieldNameBytes} return Object.freeze({layers:this.#revisions.size,projections:this.#entries.size,fieldRefs,fieldNameBytes}) }
  fingerprint(): string { this.#live(); return [...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.signature.localeCompare(b.signature)).map(entry=>`${entry.layerId}:${entry.revision}:${entry.intent}:${entry.fieldCount}:${entry.fieldNameBytes}:${entry.signature}`).join('|') }
  dispose(): void { if(this.#disposed)return; this.#entries.clear();this.#signatures.clear();this.#revisions.clear();this.#disposed=true }

  #normalizeFields(values: readonly string[]): string[] {
    if (!Array.isArray(values) || values.length === 0) throw new Error('fieldNames must be non-empty')
    const unique = new Set<string>()
    for (const raw of values) {
      const field = boundedId('fieldName', raw)
      if (field === '*' || /[,;()=]/.test(field)) throw new Error('fieldName is unsafe')
      unique.add(field)
    }
    return [...unique].sort((a,b)=>a.localeCompare(b))
  }
  #signature(layer: string, revision: number, fields: readonly string[]): string { return `${layer}\u0000${revision}\u0000${fields.join('\u001f')}` }
  #layerCount(layer: string): number { let count=0;for(const entry of this.#entries.values())if(entry.layerId===layer)count++;return count }
  #residentFieldRefs(): number { let count=0;for(const entry of this.#entries.values())count+=entry.fieldCount;return count }
  #evictFor(intent: QueryFieldProjectionIntent, now: number, neededFields: number): void {
    const candidates=[...this.#entries.values()].filter(entry=>rank[entry.intent] <= rank[intent]).sort((a,b)=>rank[a.intent]-rank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence)
    for(const entry of candidates){if(this.#entries.size<this.#budget.maxProjections&&this.#residentFieldRefs()+neededFields<=this.#budget.maxResidentFieldRefs)break;if(entry.touchedAt>now)continue;this.#remove(entry.projectionId)}
  }
  #remove(key:string):void{const entry=this.#entries.get(key);if(!entry)return;this.#entries.delete(key);this.#signatures.delete(entry.signature)}
  #view(entry:ProjectionEntry):QueryFieldProjectionView{return Object.freeze({projectionId:entry.projectionId,layerId:entry.layerId,revision:entry.revision,intent:entry.intent,fieldCount:entry.fieldCount,fieldNameBytes:entry.fieldNameBytes,sequence:entry.sequence,createdAt:entry.createdAt,touchedAt:entry.touchedAt,expiresAt:entry.expiresAt})}
  #live():void{if(this.#disposed)throw new Error('query field projection lifecycle policy is disposed')}
}
