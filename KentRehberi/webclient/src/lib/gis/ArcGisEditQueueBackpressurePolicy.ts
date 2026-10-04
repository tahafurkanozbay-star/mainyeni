export type EditQueueIntent = 'interactive' | 'visible' | 'background'
export type EditQueuePhase = 'queued' | 'running'

export interface EditQueueBudget { maxLayers: number; maxJobs: number; maxJobsPerLayer: number; maxRunning: number; maxRunningPerLayer: number; maxOperations: number; maxBytes: number; queueTtlMs: number; leaseMs: number }
export interface EditQueueRequest { jobId: string; layerId: string; revision: number; intent: EditQueueIntent; operations: number; bytes: number; queuedAt: number }
export interface EditQueueView extends EditQueueRequest { readonly phase: EditQueuePhase; readonly sequence: number; readonly touchedAt: number; readonly expiresAt: number }
interface Job extends EditQueueRequest { phase: EditQueuePhase; sequence: number; touchedAt: number; expiresAt: number }

const intents: readonly EditQueueIntent[] = ['interactive', 'visible', 'background']
const rank: Readonly<Record<EditQueueIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
function identifier(name: string, value: string): string { const v = value.trim(); if (!v || v.length > 192 || /[\u0000-\u001f]/.test(v)) throw new Error(`${name} is invalid`); return v }
function count(name: string, value: number, min = 0): void { if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`) }
function clock(name: string, value: number): void { if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`) }

/** Payload-free bounded backpressure authority for ArcGIS applyEdits scheduling. */
export class ArcGisEditQueueBackpressurePolicy {
  readonly #budget: Readonly<EditQueueBudget>
  readonly #jobs = new Map<string, Job>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: EditQueueBudget) {
    for (const key of ['maxLayers','maxJobs','maxJobsPerLayer','maxRunning','maxRunningPerLayer','maxOperations','maxBytes'] as const) count(key, budget[key], 1)
    clock('queueTtlMs', budget.queueTtlMs); clock('leaseMs', budget.leaseMs)
    if (budget.maxJobsPerLayer > budget.maxJobs) throw new Error('maxJobsPerLayer cannot exceed maxJobs')
    if (budget.maxRunning > budget.maxJobs) throw new Error('maxRunning cannot exceed maxJobs')
    if (budget.maxRunningPerLayer > budget.maxRunning || budget.maxRunningPerLayer > budget.maxJobsPerLayer) throw new Error('maxRunningPerLayer exceeds parent budget')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, next: number): number {
    this.#live(); const layer = identifier('layerId', layerId); count('revision', next)
    const current = this.#revisions.get(layer)
    if (current !== undefined && next < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, next)
    if (current === undefined || current === next) return 0
    let removed = 0; for (const [key, job] of this.#jobs) if (job.layerId === layer && job.revision !== next) { this.#jobs.delete(key); removed++ }
    return removed
  }

  enqueue(request: EditQueueRequest): boolean {
    this.#live(); const jobId = identifier('jobId', request.jobId); const layerId = identifier('layerId', request.layerId)
    count('revision', request.revision); count('operations', request.operations, 1); count('bytes', request.bytes, 1); clock('queuedAt', request.queuedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#jobs.has(jobId)) return false
    if (this.#jobs.size >= this.#budget.maxJobs || this.#layerCount(layerId) >= this.#budget.maxJobsPerLayer) return false
    if (this.#operations() + request.operations > this.#budget.maxOperations || this.#bytes() + request.bytes > this.#budget.maxBytes) return false
    const sequence = ++this.#sequence
    this.#jobs.set(jobId, { ...request, jobId, layerId, phase: 'queued', sequence, touchedAt: request.queuedAt, expiresAt: request.queuedAt + this.#budget.queueTtlMs })
    return true
  }

  startNext(now: number): EditQueueView | null {
    this.#live(); clock('now', now); this.expire(now)
    if (this.#phaseCount('running') >= this.#budget.maxRunning) return null
    let candidate: Job | undefined
    for (const job of this.#jobs.values()) {
      if (job.phase !== 'queued' || this.#layerPhaseCount(job.layerId, 'running') >= this.#budget.maxRunningPerLayer) continue
      if (!candidate || rank[job.intent] > rank[candidate.intent] || (rank[job.intent] === rank[candidate.intent] && (job.queuedAt < candidate.queuedAt || (job.queuedAt === candidate.queuedAt && job.sequence < candidate.sequence)))) candidate = job
    }
    if (!candidate) return null
    candidate.phase = 'running'; candidate.touchedAt = now; candidate.expiresAt = now + this.#budget.leaseMs
    return this.#view(candidate)
  }

  renew(jobId: string, revision: number, now: number): boolean {
    this.#live(); const job = this.#jobs.get(identifier('jobId', jobId)); count('revision', revision); clock('now', now); this.expire(now)
    if (!job || job.phase !== 'running' || job.revision !== revision || this.#revisions.get(job.layerId) !== revision) return false
    job.touchedAt = now; job.expiresAt = now + this.#budget.leaseMs; return true
  }

  complete(jobId: string, revision: number): EditQueueView | null {
    this.#live(); const key = identifier('jobId', jobId); count('revision', revision); const job = this.#jobs.get(key)
    if (!job || job.phase !== 'running' || job.revision !== revision || this.#revisions.get(job.layerId) !== revision) return null
    this.#jobs.delete(key); return this.#view(job)
  }

  cancel(jobId: string): boolean { this.#live(); return this.#jobs.delete(identifier('jobId', jobId)) }
  releaseLayer(layerId: string): number { this.#live(); const layer = identifier('layerId', layerId); let removed = 0; for (const [key, job] of this.#jobs) if (job.layerId === layer) { this.#jobs.delete(key); removed++ }; this.#revisions.delete(layer); return removed }
  expire(now: number): number { this.#live(); clock('now', now); let removed = 0; for (const [key, job] of this.#jobs) if (job.expiresAt <= now) { this.#jobs.delete(key); removed++ }; return removed }
  snapshot(): Readonly<{layers:number;jobs:number;queued:number;running:number;operations:number;bytes:number}> { this.#live(); return Object.freeze({ layers:this.#revisions.size, jobs:this.#jobs.size, queued:this.#phaseCount('queued'), running:this.#phaseCount('running'), operations:this.#operations(), bytes:this.#bytes() }) }
  fingerprint(): string { this.#live(); return [...this.#jobs.values()].sort((a,b)=>a.layerId.localeCompare(b.layerId)||a.sequence-b.sequence).map(j=>`${j.layerId}:${j.jobId}:${j.revision}:${j.intent}:${j.phase}:${j.operations}:${j.bytes}`).join('|') }
  dispose(): void { if (this.#disposed) return; this.#jobs.clear(); this.#revisions.clear(); this.#disposed = true }
  #layerCount(layerId:string):number { let n=0; for(const j of this.#jobs.values()) if(j.layerId===layerId)n++; return n }
  #phaseCount(phase:EditQueuePhase):number { let n=0; for(const j of this.#jobs.values()) if(j.phase===phase)n++; return n }
  #layerPhaseCount(layerId:string,phase:EditQueuePhase):number { let n=0; for(const j of this.#jobs.values()) if(j.layerId===layerId&&j.phase===phase)n++; return n }
  #operations():number { let n=0; for(const j of this.#jobs.values())n+=j.operations; return n }
  #bytes():number { let n=0; for(const j of this.#jobs.values())n+=j.bytes; return n }
  #view(j:Job):EditQueueView { return Object.freeze({ jobId:j.jobId,layerId:j.layerId,revision:j.revision,intent:j.intent,operations:j.operations,bytes:j.bytes,queuedAt:j.queuedAt,phase:j.phase,sequence:j.sequence,touchedAt:j.touchedAt,expiresAt:j.expiresAt }) }
  #live():void { if(this.#disposed) throw new Error('edit queue backpressure policy is disposed') }
}
