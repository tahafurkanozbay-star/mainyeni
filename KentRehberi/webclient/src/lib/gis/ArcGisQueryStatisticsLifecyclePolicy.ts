export type QueryStatisticsIntent = 'interactive' | 'visible' | 'background'
export type QueryStatisticType = 'count' | 'sum' | 'min' | 'max' | 'avg' | 'stddev' | 'var'

export interface QueryStatisticsBudget {
  maxLayers: number
  maxPlans: number
  maxPlansPerLayer: number
  maxStatisticsPerPlan: number
  maxGroupFieldsPerPlan: number
  maxResidentStatisticRefs: number
  maxResidentGroupFieldRefs: number
  maxIdentifierBytes: number
  planTtlMs: number
}

export interface QueryStatisticDefinition {
  fieldName: string
  statisticType: QueryStatisticType
  outputName: string
}

export interface QueryStatisticsRequest {
  planId: string
  layerId: string
  revision: number
  intent: QueryStatisticsIntent
  statistics: readonly QueryStatisticDefinition[]
  groupByFields: readonly string[]
  createdAt: number
}

export interface QueryStatisticsView {
  readonly planId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: QueryStatisticsIntent
  readonly statisticCount: number
  readonly groupFieldCount: number
  readonly identifierBytes: number
  readonly sequence: number
  readonly createdAt: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface StatisticsEntry extends QueryStatisticsView { signature: string }
const intents: readonly QueryStatisticsIntent[] = ['interactive', 'visible', 'background']
const statisticTypes: readonly QueryStatisticType[] = ['count', 'sum', 'min', 'max', 'avg', 'stddev', 'var']
const rank: Readonly<Record<QueryStatisticsIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })

function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f]/.test(normalized) || /[*;,()=]/.test(normalized)) throw new Error(`${name} is invalid`)
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

/** Payload-free authority for ArcGIS REST outStatistics/groupByFieldsForStatistics plans. */
export class ArcGisQueryStatisticsLifecyclePolicy {
  readonly #budget: Readonly<QueryStatisticsBudget>
  readonly #entries = new Map<string, StatisticsEntry>()
  readonly #signatures = new Map<string, string>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: QueryStatisticsBudget) {
    for (const key of ['maxLayers','maxPlans','maxPlansPerLayer','maxStatisticsPerPlan','maxGroupFieldsPerPlan','maxResidentStatisticRefs','maxResidentGroupFieldRefs','maxIdentifierBytes'] as const) integer(key, budget[key], 1)
    clock('planTtlMs', budget.planTtlMs)
    if (budget.maxPlansPerLayer > budget.maxPlans) throw new Error('maxPlansPerLayer exceeds maxPlans')
    if (budget.maxStatisticsPerPlan > budget.maxResidentStatisticRefs) throw new Error('maxStatisticsPerPlan exceeds maxResidentStatisticRefs')
    if (budget.maxGroupFieldsPerPlan > budget.maxResidentGroupFieldRefs) throw new Error('maxGroupFieldsPerPlan exceeds maxResidentGroupFieldRefs')
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

  admit(request: QueryStatisticsRequest): QueryStatisticsView | null {
    this.#live(); const planId = identifier('planId', request.planId); const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision); clock('createdAt', request.createdAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(planId)) return null
    const statistics = this.#normalizeStatistics(request.statistics)
    const groups = this.#normalizeGroups(request.groupByFields)
    if (statistics.length > this.#budget.maxStatisticsPerPlan || groups.length > this.#budget.maxGroupFieldsPerPlan) return null
    const identifierBytes = statistics.reduce((sum, item) => sum + utf8Bytes(item.fieldName) + utf8Bytes(item.outputName), 0) + groups.reduce((sum, field) => sum + utf8Bytes(field), 0)
    if (identifierBytes > this.#budget.maxIdentifierBytes) return null
    const signature = `${layerId}\u0000${request.revision}\u0000${statistics.map(item => `${item.statisticType}:${item.fieldName}:${item.outputName}`).join('\u001f')}\u0000${groups.join('\u001f')}`
    if (this.#signatures.has(signature) || this.#layerCount(layerId) >= this.#budget.maxPlansPerLayer) return null
    if (this.#entries.size >= this.#budget.maxPlans || this.#residentStatistics() + statistics.length > this.#budget.maxResidentStatisticRefs || this.#residentGroups() + groups.length > this.#budget.maxResidentGroupFieldRefs) {
      this.#evictFor(request.intent, request.createdAt, statistics.length, groups.length)
      if (this.#entries.size >= this.#budget.maxPlans || this.#residentStatistics() + statistics.length > this.#budget.maxResidentStatisticRefs || this.#residentGroups() + groups.length > this.#budget.maxResidentGroupFieldRefs) return null
    }
    const entry: StatisticsEntry = Object.freeze({ planId, layerId, revision: request.revision, intent: request.intent, statisticCount: statistics.length, groupFieldCount: groups.length, identifierBytes, sequence: ++this.#sequence, createdAt: request.createdAt, touchedAt: request.createdAt, expiresAt: request.createdAt + this.#budget.planTtlMs, signature })
    this.#entries.set(planId, entry); this.#signatures.set(signature, planId); return this.#view(entry)
  }

  touch(planId: string, revision: number, now: number): boolean {
    this.#live(); const key = identifier('planId', planId); integer('revision', revision); clock('now', now); this.expire(now)
    const current = this.#entries.get(key)
    if (!current || current.revision !== revision || this.#revisions.get(current.layerId) !== revision) return false
    this.#entries.set(key, Object.freeze({ ...current, touchedAt: now, expiresAt: now + this.#budget.planTtlMs })); return true
  }
  release(planId: string): boolean { this.#live(); const key = identifier('planId', planId); if (!this.#entries.has(key)) return false; this.#remove(key); return true }
  releaseLayer(layerId: string): number { this.#live(); const layer = identifier('layerId', layerId); let removed = 0; for (const [key, entry] of this.#entries) if (entry.layerId === layer) { this.#remove(key); removed++ } this.#revisions.delete(layer); return removed }
  expire(now: number): number { this.#live(); clock('now', now); let removed = 0; for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) { this.#remove(key); removed++ } return removed }
  snapshot(): Readonly<{layers:number;plans:number;statisticRefs:number;groupFieldRefs:number;identifierBytes:number}> { this.#live(); let statisticRefs=0,groupFieldRefs=0,identifierBytes=0; for(const entry of this.#entries.values()){statisticRefs+=entry.statisticCount;groupFieldRefs+=entry.groupFieldCount;identifierBytes+=entry.identifierBytes} return Object.freeze({layers:this.#revisions.size,plans:this.#entries.size,statisticRefs,groupFieldRefs,identifierBytes}) }
  fingerprint(): string { this.#live(); return [...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.signature.localeCompare(b.signature)).map(entry=>`${entry.layerId}:${entry.revision}:${entry.intent}:${entry.statisticCount}:${entry.groupFieldCount}:${entry.identifierBytes}:${entry.signature}`).join('|') }
  dispose(): void { if(this.#disposed)return;this.#entries.clear();this.#signatures.clear();this.#revisions.clear();this.#disposed=true }

  #normalizeStatistics(values: readonly QueryStatisticDefinition[]): QueryStatisticDefinition[] {
    if (!Array.isArray(values) || values.length === 0) throw new Error('statistics must be non-empty')
    const outputs = new Set<string>(); const normalized: QueryStatisticDefinition[] = []
    for (const value of values) {
      const fieldName = identifier('fieldName', value.fieldName); const outputName = identifier('outputName', value.outputName)
      if (!statisticTypes.includes(value.statisticType)) throw new Error('statisticType is invalid')
      const outputKey = outputName.toLocaleLowerCase('en-US'); if(outputs.has(outputKey)) throw new Error('duplicate statistic outputName'); outputs.add(outputKey)
      normalized.push(Object.freeze({fieldName, statisticType:value.statisticType, outputName}))
    }
    return normalized
  }
  #normalizeGroups(values: readonly string[]): string[] {
    if(!Array.isArray(values)) throw new Error('groupByFields must be an array')
    const seen=new Set<string>(); const normalized:string[]=[]
    for(const value of values){const field=identifier('groupByField',value);const key=field.toLocaleLowerCase('en-US');if(seen.has(key))throw new Error('duplicate group field');seen.add(key);normalized.push(field)}
    return normalized
  }
  #layerCount(layer:string):number{let count=0;for(const entry of this.#entries.values())if(entry.layerId===layer)count++;return count}
  #residentStatistics():number{let count=0;for(const entry of this.#entries.values())count+=entry.statisticCount;return count}
  #residentGroups():number{let count=0;for(const entry of this.#entries.values())count+=entry.groupFieldCount;return count}
  #evictFor(intent:QueryStatisticsIntent,now:number,statistics:number,groups:number):void{const candidates=[...this.#entries.values()].filter(entry=>rank[entry.intent]<=rank[intent]).sort((a,b)=>rank[a.intent]-rank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence);for(const entry of candidates){if(this.#entries.size<this.#budget.maxPlans&&this.#residentStatistics()+statistics<=this.#budget.maxResidentStatisticRefs&&this.#residentGroups()+groups<=this.#budget.maxResidentGroupFieldRefs)break;if(entry.touchedAt>now)continue;this.#remove(entry.planId)}}
  #remove(key:string):void{const entry=this.#entries.get(key);if(!entry)return;this.#entries.delete(key);this.#signatures.delete(entry.signature)}
  #view(entry:StatisticsEntry):QueryStatisticsView{return Object.freeze({planId:entry.planId,layerId:entry.layerId,revision:entry.revision,intent:entry.intent,statisticCount:entry.statisticCount,groupFieldCount:entry.groupFieldCount,identifierBytes:entry.identifierBytes,sequence:entry.sequence,createdAt:entry.createdAt,touchedAt:entry.touchedAt,expiresAt:entry.expiresAt})}
  #live():void{if(this.#disposed)throw new Error('query statistics lifecycle policy is disposed')}
}
