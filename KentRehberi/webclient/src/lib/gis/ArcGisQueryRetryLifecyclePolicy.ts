export type QueryRetryIntent = 'interactive' | 'visible' | 'background'
export type QueryRetryPhase = 'waiting' | 'ready' | 'running' | 'exhausted'

export interface QueryRetryBudget {
  maxLayers: number
  maxEntries: number
  maxEntriesPerLayer: number
  maxRunning: number
  maxRunningPerLayer: number
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  maxTotalDelayMs: number
  runningLeaseMs: number
  entryTtlMs: number
}

export interface QueryRetryRequest {
  retryId: string
  queryKey: string
  layerId: string
  revision: number
  intent: QueryRetryIntent
  requestedAt: number
}

export interface QueryRetryView extends QueryRetryRequest {
  readonly phase: QueryRetryPhase
  readonly sequence: number
  readonly attempt: number
  readonly totalDelayMs: number
  readonly readyAt: number
  readonly touchedAt: number
  readonly expiresAt: number
  readonly lastStatus: number | null
}

interface RetryEntry extends QueryRetryRequest {
  phase: QueryRetryPhase
  sequence: number
  attempt: number
  totalDelayMs: number
  readyAt: number
  touchedAt: number
  expiresAt: number
  lastStatus: number | null
}

const intents: readonly QueryRetryIntent[] = ['interactive', 'visible', 'background']
const rank: Readonly<Record<QueryRetryIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

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

/**
 * Payload-free retry authority for ArcGIS REST query failures.
 * It deliberately stores no URL, query body, geometry, credentials, response body,
 * Error object, AbortSignal or SDK object. Callers retain transport state locally.
 */
export class ArcGisQueryRetryLifecyclePolicy {
  readonly #budget: Readonly<QueryRetryBudget>
  readonly #entries = new Map<string, RetryEntry>()
  readonly #revisions = new Map<string, number>()
  readonly #queryKeys = new Map<string, string>()
  #sequence = 0
  #disposed = false

  constructor(budget: QueryRetryBudget) {
    for (const key of ['maxLayers','maxEntries','maxEntriesPerLayer','maxRunning','maxRunningPerLayer','maxAttempts'] as const) integer(key, budget[key], 1)
    for (const key of ['baseDelayMs','maxDelayMs','maxTotalDelayMs','runningLeaseMs','entryTtlMs'] as const) clock(key, budget[key])
    if (budget.maxEntriesPerLayer > budget.maxEntries) throw new Error('maxEntriesPerLayer exceeds maxEntries')
    if (budget.maxRunning > budget.maxEntries) throw new Error('maxRunning exceeds maxEntries')
    if (budget.maxRunningPerLayer > budget.maxRunning || budget.maxRunningPerLayer > budget.maxEntriesPerLayer) throw new Error('maxRunningPerLayer exceeds parent budget')
    if (budget.baseDelayMs > budget.maxDelayMs) throw new Error('baseDelayMs exceeds maxDelayMs')
    if (budget.maxDelayMs > budget.maxTotalDelayMs) throw new Error('maxDelayMs exceeds maxTotalDelayMs')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, next: number): number {
    this.#live()
    const layer = identifier('layerId', layerId)
    integer('revision', next)
    const current = this.#revisions.get(layer)
    if (current !== undefined && next < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, next)
    if (current === undefined || current === next) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer && entry.revision !== next) { this.#remove(key); removed++ }
    return removed
  }

  admit(request: QueryRetryRequest): boolean {
    this.#live()
    const retryId = identifier('retryId', request.retryId)
    const queryKey = identifier('queryKey', request.queryKey)
    const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision)
    clock('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision) return false
    if (this.#entries.has(retryId) || this.#queryKeys.has(this.#key(layerId, request.revision, queryKey))) return false
    if (this.#entries.size >= this.#budget.maxEntries || this.#layerCount(layerId) >= this.#budget.maxEntriesPerLayer) return false
    const entry: RetryEntry = {
      ...request, retryId, queryKey, layerId,
      phase: 'ready', sequence: ++this.#sequence, attempt: 0, totalDelayMs: 0,
      readyAt: request.requestedAt, touchedAt: request.requestedAt,
      expiresAt: request.requestedAt + this.#budget.entryTtlMs, lastStatus: null,
    }
    this.#entries.set(retryId, entry)
    this.#queryKeys.set(this.#key(layerId, request.revision, queryKey), retryId)
    return true
  }

  startNext(now: number): QueryRetryView | null {
    this.#live(); clock('now', now); this.expire(now); this.#promote(now)
    if (this.#phaseCount('running') >= this.#budget.maxRunning) return null
    let candidate: RetryEntry | undefined
    for (const entry of this.#entries.values()) {
      if (entry.phase !== 'ready' || this.#layerPhaseCount(entry.layerId, 'running') >= this.#budget.maxRunningPerLayer) continue
      if (!candidate || rank[entry.intent] > rank[candidate.intent] || (rank[entry.intent] === rank[candidate.intent] && (entry.readyAt < candidate.readyAt || (entry.readyAt === candidate.readyAt && entry.sequence < candidate.sequence)))) candidate = entry
    }
    if (!candidate) return null
    candidate.phase = 'running'; candidate.attempt++; candidate.touchedAt = now; candidate.expiresAt = now + this.#budget.runningLeaseMs
    return this.#view(candidate)
  }

  renew(retryId: string, revision: number, now: number): boolean {
    this.#live(); const entry = this.#entries.get(identifier('retryId', retryId)); integer('revision', revision); clock('now', now); this.expire(now)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return false
    entry.touchedAt = now; entry.expiresAt = now + this.#budget.runningLeaseMs; return true
  }

  fail(retryId: string, revision: number, status: number, now: number, retryAfterMs?: number): QueryRetryView | null {
    this.#live(); const key = identifier('retryId', retryId); integer('revision', revision); integer('status', status, 100); clock('now', now)
    if (retryAfterMs !== undefined) clock('retryAfterMs', retryAfterMs)
    const entry = this.#entries.get(key); this.expire(now)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return null
    entry.lastStatus = status; entry.touchedAt = now
    if (!RETRYABLE.has(status) || entry.attempt >= this.#budget.maxAttempts) { entry.phase = 'exhausted'; entry.readyAt = now; entry.expiresAt = now + this.#budget.entryTtlMs; return this.#view(entry) }
    const delay = this.#delay(entry.attempt, retryAfterMs)
    if (entry.totalDelayMs + delay > this.#budget.maxTotalDelayMs) { entry.phase = 'exhausted'; entry.readyAt = now; entry.expiresAt = now + this.#budget.entryTtlMs; return this.#view(entry) }
    entry.totalDelayMs += delay; entry.phase = delay === 0 ? 'ready' : 'waiting'; entry.readyAt = now + delay; entry.expiresAt = entry.readyAt + this.#budget.entryTtlMs
    return this.#view(entry)
  }

  succeed(retryId: string, revision: number): QueryRetryView | null {
    this.#live(); const key = identifier('retryId', retryId); integer('revision', revision); const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return null
    const view = this.#view(entry); this.#remove(key); return view
  }

  cancel(retryId: string): boolean { this.#live(); const key = identifier('retryId', retryId); if (!this.#entries.has(key)) return false; this.#remove(key); return true }
  releaseLayer(layerId: string): number { this.#live(); const layer = identifier('layerId', layerId); let n=0; for (const [key,entry] of this.#entries) if(entry.layerId===layer){this.#remove(key);n++} this.#revisions.delete(layer); return n }
  expire(now: number): number { this.#live(); clock('now', now); this.#promote(now); let n=0; for(const[key,entry]of this.#entries)if(entry.expiresAt<=now){this.#remove(key);n++}return n }
  snapshot(): Readonly<{layers:number;entries:number;waiting:number;ready:number;running:number;exhausted:number;attempts:number;totalDelayMs:number}> { this.#live(); let attempts=0,totalDelayMs=0;for(const e of this.#entries.values()){attempts+=e.attempt;totalDelayMs+=e.totalDelayMs}return Object.freeze({layers:this.#revisions.size,entries:this.#entries.size,waiting:this.#phaseCount('waiting'),ready:this.#phaseCount('ready'),running:this.#phaseCount('running'),exhausted:this.#phaseCount('exhausted'),attempts,totalDelayMs}) }
  fingerprint(): string { this.#live(); return [...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.queryKey.localeCompare(b.queryKey)).map(e=>`${e.layerId}:${e.queryKey}:${e.revision}:${e.intent}:${e.phase}:${e.attempt}:${e.totalDelayMs}:${e.lastStatus??0}`).join('|') }
  dispose(): void { if(this.#disposed)return;this.#entries.clear();this.#queryKeys.clear();this.#revisions.clear();this.#disposed=true }

  #delay(attempt: number, retryAfterMs?: number): number { const exponential=Math.min(this.#budget.maxDelayMs,this.#budget.baseDelayMs*(2**Math.max(0,attempt-1)));const hinted=retryAfterMs===undefined?0:Math.min(retryAfterMs,this.#budget.maxDelayMs);return Math.max(exponential,hinted) }
  #promote(now:number):void{for(const e of this.#entries.values())if(e.phase==='waiting'&&e.readyAt<=now){e.phase='ready';e.touchedAt=now}}
  #remove(retryId:string):void{const e=this.#entries.get(retryId);if(!e)return;this.#entries.delete(retryId);this.#queryKeys.delete(this.#key(e.layerId,e.revision,e.queryKey))}
  #key(layer:string,revision:number,query:string):string{return`${layer}\u0000${revision}\u0000${query}`}
  #layerCount(layer:string):number{let n=0;for(const e of this.#entries.values())if(e.layerId===layer)n++;return n}
  #phaseCount(phase:QueryRetryPhase):number{let n=0;for(const e of this.#entries.values())if(e.phase===phase)n++;return n}
  #layerPhaseCount(layer:string,phase:QueryRetryPhase):number{let n=0;for(const e of this.#entries.values())if(e.layerId===layer&&e.phase===phase)n++;return n}
  #view(e:RetryEntry):QueryRetryView{return Object.freeze({retryId:e.retryId,queryKey:e.queryKey,layerId:e.layerId,revision:e.revision,intent:e.intent,requestedAt:e.requestedAt,phase:e.phase,sequence:e.sequence,attempt:e.attempt,totalDelayMs:e.totalDelayMs,readyAt:e.readyAt,touchedAt:e.touchedAt,expiresAt:e.expiresAt,lastStatus:e.lastStatus})}
  #live():void{if(this.#disposed)throw new Error('query retry lifecycle policy is disposed')}
}
