export type TopologyIntent = 'interactive' | 'visible' | 'background'
export type TopologyPhase = 'queued' | 'validating' | 'resident'

export interface TopologyValidationBudget {
  maxLayers: number
  maxJobs: number
  maxJobsPerLayer: number
  maxValidating: number
  maxValidatingPerLayer: number
  maxResident: number
  maxResidentPerLayer: number
  maxVerticesPerJob: number
  maxBytesPerJob: number
  maxResidentErrors: number
  maxResidentBytes: number
  queueTtlMs: number
  validationLeaseMs: number
  residentTtlMs: number
}

export interface TopologyValidationRequest {
  jobId: string
  layerId: string
  revision: number
  intent: TopologyIntent
  vertexCount: number
  estimatedBytes: number
  requestedAt: number
}

export interface TopologyValidationView {
  readonly jobId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: TopologyIntent
  readonly phase: TopologyPhase
  readonly vertexCount: number
  readonly errorCount: number
  readonly bytes: number
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Entry extends TopologyValidationRequest {
  phase: TopologyPhase
  errorCount: number
  bytes: number
  sequence: number
  touchedAt: number
  expiresAt: number
}

const rank: Readonly<Record<TopologyIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const intents: readonly TopologyIntent[] = ['interactive', 'visible', 'background']

function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f]/.test(normalized)) throw new Error(`${name} must contain 1..192 safe characters`)
  return normalized
}
function integer(name: string, value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`)
}
function finite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

/**
 * Payload-free lifecycle authority for client-side ArcGIS topology validation.
 * Geometry, Graphic, feature attributes, credentials and AbortSignal instances remain caller-owned.
 */
export class ArcGisTopologyValidationLifecyclePolicy {
  readonly #budget: Readonly<TopologyValidationBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: TopologyValidationBudget) {
    for (const key of ['maxLayers','maxJobs','maxJobsPerLayer','maxValidating','maxValidatingPerLayer','maxResident','maxResidentPerLayer','maxVerticesPerJob','maxBytesPerJob','maxResidentErrors','maxResidentBytes'] as const) integer(key, budget[key], 1)
    for (const key of ['queueTtlMs','validationLeaseMs','residentTtlMs'] as const) finite(key, budget[key])
    if (budget.maxJobsPerLayer > budget.maxJobs) throw new Error('maxJobsPerLayer cannot exceed maxJobs')
    if (budget.maxValidatingPerLayer > budget.maxValidating) throw new Error('maxValidatingPerLayer cannot exceed maxValidating')
    if (budget.maxResidentPerLayer > budget.maxResident) throw new Error('maxResidentPerLayer cannot exceed maxResident')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#assertLive(); const layer = identifier('layerId', layerId); integer('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, revision)
    if (current === undefined || revision === current) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer && entry.revision !== revision) { this.#entries.delete(key); removed++ }
    return removed
  }

  admit(request: TopologyValidationRequest): boolean {
    this.#assertLive()
    const jobId = identifier('jobId', request.jobId); const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision); integer('vertexCount', request.vertexCount, 1); integer('estimatedBytes', request.estimatedBytes, 1); finite('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(jobId)) return false
    if (request.vertexCount > this.#budget.maxVerticesPerJob || request.estimatedBytes > this.#budget.maxBytesPerJob) return false
    if (this.#entries.size >= this.#budget.maxJobs || this.#countLayer(layerId) >= this.#budget.maxJobsPerLayer) return false
    const sequence = ++this.#sequence
    this.#entries.set(jobId, { ...request, jobId, layerId, phase:'queued', errorCount:0, bytes:request.estimatedBytes, sequence, touchedAt:request.requestedAt, expiresAt:request.requestedAt + this.#budget.queueTtlMs })
    return true
  }

  startNext(now: number): TopologyValidationView | null {
    this.#assertLive(); finite('now', now); this.expire(now)
    if (this.#countPhase('validating') >= this.#budget.maxValidating) return null
    let candidate: Entry | undefined
    for (const entry of this.#entries.values()) {
      if (entry.phase !== 'queued' || this.#countLayerPhase(entry.layerId, 'validating') >= this.#budget.maxValidatingPerLayer) continue
      if (!candidate || rank[entry.intent] > rank[candidate.intent] || (rank[entry.intent] === rank[candidate.intent] && entry.sequence < candidate.sequence)) candidate = entry
    }
    if (!candidate) return null
    candidate.phase='validating'; candidate.touchedAt=now; candidate.expiresAt=now + this.#budget.validationLeaseMs
    return this.#view(candidate)
  }

  complete(jobId: string, revision: number, errorCount: number, actualBytes: number, now: number): boolean {
    this.#assertLive(); const id = identifier('jobId', jobId); integer('revision', revision); integer('errorCount', errorCount); integer('actualBytes', actualBytes, 1); finite('now', now)
    this.expire(now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'validating' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return false
    if (actualBytes > this.#budget.maxBytesPerJob || errorCount > this.#budget.maxResidentErrors) { this.#entries.delete(id); return false }
    this.#evictFor(entry, errorCount, actualBytes)
    if (this.#countPhase('resident') >= this.#budget.maxResident || this.#countLayerPhase(entry.layerId,'resident') >= this.#budget.maxResidentPerLayer) { this.#entries.delete(id); return false }
    if (this.#residentErrors() + errorCount > this.#budget.maxResidentErrors || this.#residentBytes() + actualBytes > this.#budget.maxResidentBytes) { this.#entries.delete(id); return false }
    entry.phase='resident'; entry.errorCount=errorCount; entry.bytes=actualBytes; entry.touchedAt=now; entry.expiresAt=now + this.#budget.residentTtlMs
    return true
  }

  touch(jobId: string, now: number): boolean {
    this.#assertLive(); const id=identifier('jobId',jobId); finite('now',now); const entry=this.#entries.get(id)
    if (!entry || entry.phase !== 'resident') return false
    entry.touchedAt=now; entry.expiresAt=now + this.#budget.residentTtlMs; return true
  }

  consume(jobId: string, revision: number): TopologyValidationView | null {
    this.#assertLive(); const id=identifier('jobId',jobId); integer('revision',revision); const entry=this.#entries.get(id)
    if (!entry || entry.phase !== 'resident' || entry.revision !== revision) return null
    this.#entries.delete(id); return this.#view(entry)
  }

  cancel(jobId: string): boolean { this.#assertLive(); return this.#entries.delete(identifier('jobId',jobId)) }
  releaseLayer(layerId: string): number {
    this.#assertLive(); const layer=identifier('layerId',layerId); let removed=0
    for (const [key,entry] of this.#entries) if(entry.layerId===layer){this.#entries.delete(key);removed++}
    this.#revisions.delete(layer); return removed
  }
  expire(now: number): number {
    this.#assertLive(); finite('now',now); let removed=0
    for(const [key,entry] of this.#entries) if(entry.expiresAt<=now){this.#entries.delete(key);removed++}
    return removed
  }
  snapshot(): Readonly<{layers:number;jobs:number;queued:number;validating:number;resident:number;residentErrors:number;residentBytes:number}> {
    this.#assertLive(); return Object.freeze({layers:this.#revisions.size,jobs:this.#entries.size,queued:this.#countPhase('queued'),validating:this.#countPhase('validating'),resident:this.#countPhase('resident'),residentErrors:this.#residentErrors(),residentBytes:this.#residentBytes()})
  }
  fingerprint(): string {
    this.#assertLive(); return [...this.#entries.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.jobId.localeCompare(b.jobId)).map(e=>`${e.layerId}:${e.jobId}:${e.revision}:${e.intent}:${e.phase}:${e.vertexCount}:${e.errorCount}:${e.bytes}`).join('|')
  }
  dispose(): void { if(this.#disposed)return; this.#entries.clear();this.#revisions.clear();this.#disposed=true }

  #evictFor(incoming: Entry, errors: number, bytes: number): void {
    while (this.#countPhase('resident') >= this.#budget.maxResident || this.#countLayerPhase(incoming.layerId,'resident') >= this.#budget.maxResidentPerLayer || this.#residentErrors()+errors>this.#budget.maxResidentErrors || this.#residentBytes()+bytes>this.#budget.maxResidentBytes) {
      let victim: Entry | undefined
      for(const entry of this.#entries.values()) if(entry.phase==='resident' && (!victim || rank[entry.intent]<rank[victim.intent] || (rank[entry.intent]===rank[victim.intent] && (entry.touchedAt<victim.touchedAt || (entry.touchedAt===victim.touchedAt && entry.sequence<victim.sequence))))) victim=entry
      if(!victim || rank[victim.intent]>rank[incoming.intent]) return
      this.#entries.delete(victim.jobId)
    }
  }
  #countLayer(layerId:string):number { let n=0;for(const e of this.#entries.values())if(e.layerId===layerId)n++;return n }
  #countPhase(phase:TopologyPhase):number { let n=0;for(const e of this.#entries.values())if(e.phase===phase)n++;return n }
  #countLayerPhase(layerId:string,phase:TopologyPhase):number { let n=0;for(const e of this.#entries.values())if(e.layerId===layerId&&e.phase===phase)n++;return n }
  #residentErrors():number { let n=0;for(const e of this.#entries.values())if(e.phase==='resident')n+=e.errorCount;return n }
  #residentBytes():number { let n=0;for(const e of this.#entries.values())if(e.phase==='resident')n+=e.bytes;return n }
  #view(entry:Entry):TopologyValidationView { return Object.freeze({jobId:entry.jobId,layerId:entry.layerId,revision:entry.revision,intent:entry.intent,phase:entry.phase,vertexCount:entry.vertexCount,errorCount:entry.errorCount,bytes:entry.bytes,sequence:entry.sequence,touchedAt:entry.touchedAt,expiresAt:entry.expiresAt}) }
  #assertLive():void { if(this.#disposed)throw new Error('topology validation lifecycle policy is disposed') }
}
