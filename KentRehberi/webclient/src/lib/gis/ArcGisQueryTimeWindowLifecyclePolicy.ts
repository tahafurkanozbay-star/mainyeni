export type QueryTimeWindowIntent = 'interactive' | 'visible' | 'background'

export interface QueryTimeWindowBudget {
  maxLayers: number
  maxWindows: number
  maxWindowsPerLayer: number
  maxOpenEndedWindows: number
  maxSpanMs: number
  maxResidentSpanMs: number
  windowTtlMs: number
}

export interface QueryTimeWindowRequest {
  windowId: string
  layerId: string
  revision: number
  intent: QueryTimeWindowIntent
  startTime: number | null
  endTime: number | null
  createdAt: number
}

export interface QueryTimeWindowView {
  readonly windowId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: QueryTimeWindowIntent
  readonly startTime: number | null
  readonly endTime: number | null
  readonly spanMs: number
  readonly openEnded: boolean
  readonly sequence: number
  readonly createdAt: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface TimeWindowEntry extends QueryTimeWindowView { signature: string }
const intents: readonly QueryTimeWindowIntent[] = ['interactive', 'visible', 'background']
const rank: Readonly<Record<QueryTimeWindowIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })

function identifier(name: string, value: string): string {
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
function instant(name: string, value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${name} must be null or a non-negative safe integer`)
}

/**
 * Payload-free authority for ArcGIS REST time/timeExtent query windows.
 * It retains scalar epoch bounds only: no Date, Query, Layer, credential or response graph.
 */
export class ArcGisQueryTimeWindowLifecyclePolicy {
  readonly #budget: Readonly<QueryTimeWindowBudget>
  readonly #entries = new Map<string, TimeWindowEntry>()
  readonly #signatures = new Map<string, string>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: QueryTimeWindowBudget) {
    for (const key of ['maxLayers','maxWindows','maxWindowsPerLayer','maxOpenEndedWindows','maxSpanMs','maxResidentSpanMs'] as const) integer(key, budget[key], 1)
    clock('windowTtlMs', budget.windowTtlMs)
    if (budget.maxWindowsPerLayer > budget.maxWindows) throw new Error('maxWindowsPerLayer exceeds maxWindows')
    if (budget.maxOpenEndedWindows > budget.maxWindows) throw new Error('maxOpenEndedWindows exceeds maxWindows')
    if (budget.maxSpanMs > budget.maxResidentSpanMs) throw new Error('maxSpanMs exceeds maxResidentSpanMs')
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

  admit(request: QueryTimeWindowRequest): QueryTimeWindowView | null {
    this.#live()
    const windowId = identifier('windowId', request.windowId); const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision); clock('createdAt', request.createdAt); instant('startTime', request.startTime); instant('endTime', request.endTime)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (request.startTime === null && request.endTime === null) throw new Error('time window must have at least one bound')
    if (request.startTime !== null && request.endTime !== null && request.endTime < request.startTime) throw new Error('endTime precedes startTime')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(windowId)) return null
    const openEnded = request.startTime === null || request.endTime === null
    const spanMs = openEnded ? 0 : (request.endTime as number) - (request.startTime as number)
    if (spanMs > this.#budget.maxSpanMs || this.#layerCount(layerId) >= this.#budget.maxWindowsPerLayer) return null
    const signature = `${layerId}\u0000${request.revision}\u0000${request.startTime ?? 'open'}\u0000${request.endTime ?? 'open'}`
    if (this.#signatures.has(signature)) return null
    if (this.#needsPressure(spanMs, openEnded)) {
      this.#evictFor(request.intent, request.createdAt, spanMs, openEnded)
      if (this.#needsPressure(spanMs, openEnded)) return null
    }
    const entry: TimeWindowEntry = Object.freeze({ windowId, layerId, revision: request.revision, intent: request.intent, startTime: request.startTime, endTime: request.endTime, spanMs, openEnded, sequence: ++this.#sequence, createdAt: request.createdAt, touchedAt: request.createdAt, expiresAt: request.createdAt + this.#budget.windowTtlMs, signature })
    this.#entries.set(windowId, entry); this.#signatures.set(signature, windowId)
    return this.#view(entry)
  }

  touch(windowId: string, revision: number, now: number): boolean {
    this.#live(); const key = identifier('windowId', windowId); integer('revision', revision); clock('now', now); this.expire(now)
    const current = this.#entries.get(key)
    if (!current || current.revision !== revision || this.#revisions.get(current.layerId) !== revision) return false
    this.#entries.set(key, Object.freeze({ ...current, touchedAt: now, expiresAt: now + this.#budget.windowTtlMs })); return true
  }

  consume(windowId: string, revision: number, now: number): QueryTimeWindowView | null {
    this.#live(); const key = identifier('windowId', windowId); integer('revision', revision); clock('now', now); this.expire(now)
    const current = this.#entries.get(key)
    if (!current || current.revision !== revision || this.#revisions.get(current.layerId) !== revision) return null
    this.#remove(key); return this.#view(current)
  }

  release(windowId: string): boolean { this.#live(); const key=identifier('windowId',windowId); if(!this.#entries.has(key))return false;this.#remove(key);return true }
  releaseLayer(layerId: string): number { this.#live(); const layer=identifier('layerId',layerId);let removed=0;for(const [key,entry] of this.#entries)if(entry.layerId===layer){this.#remove(key);removed++}this.#revisions.delete(layer);return removed }
  expire(now: number): number { this.#live();clock('now',now);let removed=0;for(const [key,entry] of this.#entries)if(entry.expiresAt<=now){this.#remove(key);removed++}return removed }

  snapshot(): Readonly<{layers:number;windows:number;openEndedWindows:number;residentSpanMs:number}> {
    this.#live(); return Object.freeze({ layers:this.#revisions.size, windows:this.#entries.size, openEndedWindows:this.#openEndedCount(), residentSpanMs:this.#residentSpan() })
  }
  fingerprint(): string {
    this.#live(); return [...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.signature.localeCompare(b.signature)).map(entry=>`${entry.layerId}:${entry.revision}:${entry.intent}:${entry.startTime ?? 'open'}:${entry.endTime ?? 'open'}:${entry.spanMs}`).join('|')
  }
  dispose(): void { if(this.#disposed)return;this.#entries.clear();this.#signatures.clear();this.#revisions.clear();this.#disposed=true }

  #needsPressure(spanMs:number,openEnded:boolean):boolean{return this.#entries.size>=this.#budget.maxWindows||this.#residentSpan()+spanMs>this.#budget.maxResidentSpanMs||(openEnded&&this.#openEndedCount()>=this.#budget.maxOpenEndedWindows)}
  #layerCount(layer:string):number{let count=0;for(const entry of this.#entries.values())if(entry.layerId===layer)count++;return count}
  #residentSpan():number{let total=0;for(const entry of this.#entries.values())total+=entry.spanMs;return total}
  #openEndedCount():number{let total=0;for(const entry of this.#entries.values())if(entry.openEnded)total++;return total}
  #evictFor(intent:QueryTimeWindowIntent,now:number,spanMs:number,openEnded:boolean):void{const candidates=[...this.#entries.values()].filter(entry=>rank[entry.intent]<=rank[intent]).sort((a,b)=>rank[a.intent]-rank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence);for(const entry of candidates){if(!this.#needsPressure(spanMs,openEnded))break;if(entry.touchedAt>now)continue;this.#remove(entry.windowId)}}
  #remove(key:string):void{const entry=this.#entries.get(key);if(!entry)return;this.#entries.delete(key);this.#signatures.delete(entry.signature)}
  #view(entry:TimeWindowEntry):QueryTimeWindowView{return Object.freeze({windowId:entry.windowId,layerId:entry.layerId,revision:entry.revision,intent:entry.intent,startTime:entry.startTime,endTime:entry.endTime,spanMs:entry.spanMs,openEnded:entry.openEnded,sequence:entry.sequence,createdAt:entry.createdAt,touchedAt:entry.touchedAt,expiresAt:entry.expiresAt})}
  #live():void{if(this.#disposed)throw new Error('query time window lifecycle policy is disposed')}
}
