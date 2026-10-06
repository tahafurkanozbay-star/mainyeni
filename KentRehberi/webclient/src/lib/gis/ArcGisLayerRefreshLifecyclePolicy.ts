export type LayerRefreshIntent = 'interactive' | 'visible' | 'background'
export type LayerRefreshPhase = 'queued' | 'running' | 'resident'

export interface LayerRefreshBudget {
  maxLayers: number
  maxJobs: number
  maxJobsPerLayer: number
  maxRunning: number
  maxRunningPerLayer: number
  maxResident: number
  maxResidentBytes: number
  maxBytesPerJob: number
  queueTtlMs: number
  leaseMs: number
  residentTtlMs: number
}

export interface LayerRefreshRequest {
  jobId: string
  layerId: string
  revision: number
  intent: LayerRefreshIntent
  estimatedBytes: number
  requestedAt: number
}

export interface LayerRefreshView extends LayerRefreshRequest {
  readonly phase: LayerRefreshPhase
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
  readonly residentBytes: number
}

export interface LayerRefreshSnapshot {
  readonly layers: number
  readonly jobs: number
  readonly queued: number
  readonly running: number
  readonly resident: number
  readonly residentBytes: number
}

interface LayerRefreshJob extends LayerRefreshRequest {
  phase: LayerRefreshPhase
  sequence: number
  touchedAt: number
  expiresAt: number
  residentBytes: number
}

const intents: readonly LayerRefreshIntent[] = ['interactive', 'visible', 'background']
const intentRank: Readonly<Record<LayerRefreshIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })

function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}
function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
}
function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
}
function clock(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

/** Payload-free bounded authority for ArcGIS layer refresh work. */
export class ArcGisLayerRefreshLifecyclePolicy {
  readonly #budget: Readonly<LayerRefreshBudget>
  readonly #jobs = new Map<string, LayerRefreshJob>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: LayerRefreshBudget) {
    for (const key of ['maxLayers','maxJobs','maxJobsPerLayer','maxRunning','maxRunningPerLayer','maxResident','maxResidentBytes','maxBytesPerJob'] as const) positiveInteger(key, budget[key])
    for (const key of ['queueTtlMs','leaseMs','residentTtlMs'] as const) { clock(key, budget[key]); if (budget[key] === 0) throw new Error(`${key} must be positive`) }
    if (budget.maxJobsPerLayer > budget.maxJobs) throw new Error('maxJobsPerLayer cannot exceed maxJobs')
    if (budget.maxRunning > budget.maxJobs || budget.maxResident > budget.maxJobs) throw new Error('phase budget cannot exceed maxJobs')
    if (budget.maxRunningPerLayer > budget.maxRunning || budget.maxRunningPerLayer > budget.maxJobsPerLayer) throw new Error('maxRunningPerLayer exceeds parent budget')
    if (budget.maxResidentBytes < budget.maxBytesPerJob) throw new Error('maxResidentBytes must fit one admitted job')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#assertLive(); const layer = identifier('layerId', layerId); nonNegativeInteger('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === revision) return 0
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, revision)
    let removed = 0
    for (const [jobId, job] of this.#jobs) if (job.layerId === layer && job.revision !== revision) { this.#jobs.delete(jobId); removed += 1 }
    return removed
  }

  admit(request: LayerRefreshRequest): boolean {
    this.#assertLive()
    const jobId = identifier('jobId', request.jobId), layerId = identifier('layerId', request.layerId)
    nonNegativeInteger('revision', request.revision); positiveInteger('estimatedBytes', request.estimatedBytes); clock('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#jobs.has(jobId)) return false
    if (request.estimatedBytes > this.#budget.maxBytesPerJob) return false
    if (this.#jobs.size >= this.#budget.maxJobs || this.#layerCount(layerId) >= this.#budget.maxJobsPerLayer) return false
    this.#jobs.set(jobId, { ...request, jobId, layerId, phase:'queued', sequence:++this.#sequence, touchedAt:request.requestedAt, expiresAt:request.requestedAt+this.#budget.queueTtlMs, residentBytes:0 })
    return true
  }

  startNext(now: number): LayerRefreshView | null {
    this.#assertLive(); clock('now', now); this.expire(now)
    if (this.#phaseCount('running') >= this.#budget.maxRunning) return null
    let candidate: LayerRefreshJob | undefined
    for (const job of this.#jobs.values()) {
      if (job.phase !== 'queued' || this.#layerPhaseCount(job.layerId,'running') >= this.#budget.maxRunningPerLayer) continue
      if (!candidate || this.#precedes(job,candidate)) candidate = job
    }
    if (!candidate) return null
    candidate.phase='running'; candidate.touchedAt=now; candidate.expiresAt=now+this.#budget.leaseMs
    return this.#view(candidate)
  }

  renew(jobId: string, revision: number, now: number): boolean {
    this.#assertLive(); const key=identifier('jobId',jobId); nonNegativeInteger('revision',revision); clock('now',now); this.expire(now)
    const job=this.#jobs.get(key)
    if (!job || job.phase!=='running' || job.revision!==revision || this.#revisions.get(job.layerId)!==revision) return false
    job.touchedAt=now; job.expiresAt=now+this.#budget.leaseMs; return true
  }

  complete(jobId: string, revision: number, actualBytes: number, now: number): LayerRefreshView | null {
    this.#assertLive(); const key=identifier('jobId',jobId); nonNegativeInteger('revision',revision); nonNegativeInteger('actualBytes',actualBytes); clock('now',now); this.expire(now)
    const job=this.#jobs.get(key)
    if (!job || job.phase!=='running' || job.revision!==revision || this.#revisions.get(job.layerId)!==revision) return null
    if (actualBytes > this.#budget.maxBytesPerJob) { this.#jobs.delete(key); return null }
    job.residentBytes=actualBytes
    while (this.#phaseCount('resident') >= this.#budget.maxResident || this.#residentBytes()+actualBytes > this.#budget.maxResidentBytes) {
      const victim=this.#residentVictim(job.intent,key)
      if (!victim) { this.#jobs.delete(key); return null }
      this.#jobs.delete(victim.jobId)
    }
    job.phase='resident'; job.touchedAt=now; job.expiresAt=now+this.#budget.residentTtlMs
    return this.#view(job)
  }

  get(jobId: string, revision: number, now: number): LayerRefreshView | null {
    this.#assertLive(); const key=identifier('jobId',jobId); nonNegativeInteger('revision',revision); clock('now',now)
    const job=this.#jobs.get(key)
    if (!job || job.phase!=='resident' || job.revision!==revision || this.#revisions.get(job.layerId)!==revision) return null
    if (now >= job.expiresAt) { this.#jobs.delete(key); return null }
    return this.#view(job)
  }

  touch(jobId: string, revision: number, now: number): boolean {
    const view=this.get(jobId,revision,now); if (!view) return false
    const job=this.#jobs.get(view.jobId); if (!job) return false
    job.touchedAt=now; job.expiresAt=now+this.#budget.residentTtlMs; return true
  }

  consume(jobId: string, revision: number, now: number): LayerRefreshView | null {
    const view=this.get(jobId,revision,now); if (!view) return null
    this.#jobs.delete(view.jobId); return view
  }

  cancel(jobId: string): boolean { this.#assertLive(); return this.#jobs.delete(identifier('jobId',jobId)) }
  expire(now: number): number { this.#assertLive(); clock('now',now); let removed=0; for (const [key,job] of this.#jobs) if (now>=job.expiresAt) { this.#jobs.delete(key); removed+=1 }; return removed }
  releaseLayer(layerId: string): number { this.#assertLive(); const layer=identifier('layerId',layerId); let removed=0; for (const [key,job] of this.#jobs) if (job.layerId===layer) { this.#jobs.delete(key); removed+=1 }; this.#revisions.delete(layer); return removed }

  snapshot(): LayerRefreshSnapshot {
    this.#assertLive()
    return Object.freeze({ layers:this.#revisions.size, jobs:this.#jobs.size, queued:this.#phaseCount('queued'), running:this.#phaseCount('running'), resident:this.#phaseCount('resident'), residentBytes:this.#residentBytes() })
  }

  fingerprint(): string {
    this.#assertLive()
    return [...this.#jobs.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.sequence-b.sequence||a.jobId.localeCompare(b.jobId)).map(job=>`${job.layerId}:${job.jobId}:${job.revision}:${job.intent}:${job.phase}:${job.residentBytes}`).join('|')
  }

  dispose(): void { if (this.#disposed) return; this.#jobs.clear(); this.#revisions.clear(); this.#disposed=true }

  #precedes(left:LayerRefreshJob,right:LayerRefreshJob):boolean { return intentRank[left.intent]>intentRank[right.intent] || (intentRank[left.intent]===intentRank[right.intent] && (left.requestedAt<right.requestedAt || (left.requestedAt===right.requestedAt && left.sequence<right.sequence))) }
  #residentVictim(incoming:LayerRefreshIntent,protectedKey:string):LayerRefreshJob|undefined { const candidates=[...this.#jobs.values()].filter(job=>job.jobId!==protectedKey&&job.phase==='resident'&&intentRank[job.intent]<=intentRank[incoming]); candidates.sort((a,b)=>intentRank[a.intent]-intentRank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence||a.jobId.localeCompare(b.jobId)); return candidates[0] }
  #phaseCount(phase:LayerRefreshPhase):number { let count=0; for (const job of this.#jobs.values()) if (job.phase===phase) count+=1; return count }
  #layerCount(layerId:string):number { let count=0; for (const job of this.#jobs.values()) if (job.layerId===layerId) count+=1; return count }
  #layerPhaseCount(layerId:string,phase:LayerRefreshPhase):number { let count=0; for (const job of this.#jobs.values()) if (job.layerId===layerId&&job.phase===phase) count+=1; return count }
  #residentBytes():number { let total=0; for (const job of this.#jobs.values()) if (job.phase==='resident') total+=job.residentBytes; return total }
  #view(job:LayerRefreshJob):LayerRefreshView { return Object.freeze({ jobId:job.jobId,layerId:job.layerId,revision:job.revision,intent:job.intent,estimatedBytes:job.estimatedBytes,requestedAt:job.requestedAt,phase:job.phase,sequence:job.sequence,touchedAt:job.touchedAt,expiresAt:job.expiresAt,residentBytes:job.residentBytes }) }
  #assertLive():void { if (this.#disposed) throw new Error('ArcGisLayerRefreshLifecyclePolicy is disposed') }
}
