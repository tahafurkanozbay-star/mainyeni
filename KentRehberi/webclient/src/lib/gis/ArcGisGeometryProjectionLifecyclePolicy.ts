export type ProjectionIntent = 'interactive' | 'visible' | 'background'
export type ProjectionPhase = 'queued' | 'running' | 'resident'

export interface ProjectionBudget {
  maxSpatialReferences: number
  maxJobs: number
  maxJobsPerSpatialReference: number
  maxRunning: number
  maxRunningPerSpatialReference: number
  maxResident: number
  maxResidentVertices: number
  maxResidentBytes: number
  maxVerticesPerJob: number
  maxBytesPerJob: number
  queueTtlMs: number
  leaseMs: number
  residentTtlMs: number
}

export interface ProjectionRequest {
  jobId: string
  sourceWkid: number
  targetWkid: number
  revision: number
  intent: ProjectionIntent
  vertices: number
  estimatedBytes: number
  requestedAt: number
}

export interface ProjectionView extends ProjectionRequest {
  readonly phase: ProjectionPhase
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
  readonly residentBytes: number
}

interface Job extends ProjectionRequest {
  phase: ProjectionPhase
  sequence: number
  touchedAt: number
  expiresAt: number
  residentBytes: number
}

const intentRank: Readonly<Record<ProjectionIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const intents: readonly ProjectionIntent[] = ['interactive', 'visible', 'background']

function safeInteger(name: string, value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`)
}
function clock(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}
function id(name: string, value: string): string {
  // Check raw identity before trimming. Otherwise boundary controls can
  // disappear and distinct transport jobs can alias the same lease.
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} is invalid`)
  const normalized = value.trim()
  if (!normalized || normalized.length > 192) throw new Error(`${name} is invalid`)
  return normalized
}

function deadline(now: number, ttl: number): number {
  const expires = now + ttl
  if (!Number.isFinite(expires) || expires <= now) {
    throw new Error('projection deadline cannot be represented safely')
  }
  return expires
}
function pairKey(sourceWkid: number, targetWkid: number): string { return `${sourceWkid}->${targetWkid}` }

/**
 * Payload-free authority for expensive ArcGIS geometry projection work.
 * Geometry, SpatialReference and projection-engine objects remain request-local;
 * this class owns only scalar lifecycle metadata and deterministic budgets.
 */
export class ArcGisGeometryProjectionLifecyclePolicy {
  readonly #budget: Readonly<ProjectionBudget>
  readonly #jobs = new Map<string, Job>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ProjectionBudget) {
    for (const key of ['maxSpatialReferences','maxJobs','maxJobsPerSpatialReference','maxRunning','maxRunningPerSpatialReference','maxResident','maxResidentVertices','maxResidentBytes','maxVerticesPerJob','maxBytesPerJob'] as const) safeInteger(key, budget[key], 1)
    clock('queueTtlMs', budget.queueTtlMs); clock('leaseMs', budget.leaseMs); clock('residentTtlMs', budget.residentTtlMs)
    if (!budget.queueTtlMs || !budget.leaseMs || !budget.residentTtlMs) throw new Error('ttl and lease budgets must be positive')
    if (budget.maxJobsPerSpatialReference > budget.maxJobs) throw new Error('per-spatial-reference job budget exceeds maxJobs')
    if (budget.maxRunning > budget.maxJobs || budget.maxResident > budget.maxJobs) throw new Error('phase budget exceeds maxJobs')
    if (budget.maxRunningPerSpatialReference > budget.maxRunning || budget.maxRunningPerSpatialReference > budget.maxJobsPerSpatialReference) throw new Error('per-spatial-reference running budget exceeds parent budget')
    if (budget.maxResidentVertices < budget.maxVerticesPerJob || budget.maxResidentBytes < budget.maxBytesPerJob) throw new Error('resident budget must fit one admitted job')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(sourceWkid: number, targetWkid: number, revision: number): number {
    this.#live(); this.#wkid(sourceWkid); this.#wkid(targetWkid); safeInteger('revision', revision)
    const key = pairKey(sourceWkid, targetWkid), current = this.#revisions.get(key)
    if (current !== undefined && revision < current) return -1
    if (current === revision) return 0
    if (current === undefined && this.#revisions.size >= this.#budget.maxSpatialReferences) return -1
    this.#revisions.set(key, revision)
    let removed = 0
    for (const [jobId, job] of this.#jobs) if (pairKey(job.sourceWkid, job.targetWkid) === key && job.revision !== revision) { this.#jobs.delete(jobId); removed++ }
    return removed
  }

  admit(request: ProjectionRequest): boolean {
    this.#live(); const jobId = id('jobId', request.jobId); this.#wkid(request.sourceWkid); this.#wkid(request.targetWkid)
    safeInteger('revision', request.revision); safeInteger('vertices', request.vertices, 1); safeInteger('estimatedBytes', request.estimatedBytes, 1); clock('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    const key = pairKey(request.sourceWkid, request.targetWkid)
    if (this.#revisions.get(key) !== request.revision || this.#jobs.has(jobId)) return false
    if (request.vertices > this.#budget.maxVerticesPerJob || request.estimatedBytes > this.#budget.maxBytesPerJob) return false
    if (this.#jobs.size >= this.#budget.maxJobs || this.#pairCount(key) >= this.#budget.maxJobsPerSpatialReference) return false
    const expiresAt = deadline(request.requestedAt, this.#budget.queueTtlMs)
    const sequence = ++this.#sequence
    this.#jobs.set(jobId, { ...request, jobId, phase: 'queued', sequence, touchedAt: request.requestedAt, expiresAt, residentBytes: 0 })
    return true
  }

  startNext(now: number): ProjectionView | null {
    this.#live(); clock('now', now); this.expire(now)
    if (this.#phaseCount('running') >= this.#budget.maxRunning) return null
    let candidate: Job | undefined
    for (const job of this.#jobs.values()) {
      if (job.phase !== 'queued' || job.requestedAt > now) continue
      const key = pairKey(job.sourceWkid, job.targetWkid)
      if (this.#pairPhaseCount(key, 'running') >= this.#budget.maxRunningPerSpatialReference) continue
      if (!candidate || intentRank[job.intent] > intentRank[candidate.intent] || (intentRank[job.intent] === intentRank[candidate.intent] && (job.requestedAt < candidate.requestedAt || (job.requestedAt === candidate.requestedAt && job.sequence < candidate.sequence)))) candidate = job
    }
    if (!candidate) return null
    const expiresAt = deadline(now, this.#budget.leaseMs)
    candidate.phase = 'running'; candidate.touchedAt = now; candidate.expiresAt = expiresAt
    return this.#view(candidate)
  }

  renew(jobId: string, revision: number, now: number): boolean {
    this.#live(); const job = this.#jobs.get(id('jobId', jobId)); safeInteger('revision', revision); clock('now', now); this.expire(now)
    if (!job || job.phase !== 'running' || job.revision !== revision ||
        now < job.touchedAt || now < job.requestedAt ||
        this.#revisions.get(pairKey(job.sourceWkid, job.targetWkid)) !== revision) return false
    const expiresAt = deadline(now, this.#budget.leaseMs)
    job.touchedAt = now; job.expiresAt = expiresAt; return true
  }

  complete(jobId: string, revision: number, actualBytes: number, now: number): ProjectionView | null {
    this.#live(); const key = id('jobId', jobId); safeInteger('revision', revision); safeInteger('actualBytes', actualBytes); clock('now', now); this.expire(now)
    const job = this.#jobs.get(key)
    if (!job || job.phase !== 'running' || job.revision !== revision ||
        now < job.touchedAt || now < job.requestedAt ||
        this.#revisions.get(pairKey(job.sourceWkid, job.targetWkid)) !== revision) return null
    if (actualBytes > this.#budget.maxBytesPerJob) { this.#jobs.delete(key); return null }
    const expiresAt = deadline(now, this.#budget.residentTtlMs)
    job.residentBytes = actualBytes
    while (this.#phaseCount('resident') >= this.#budget.maxResident || this.#residentVertices() + job.vertices > this.#budget.maxResidentVertices || this.#residentBytes() + actualBytes > this.#budget.maxResidentBytes) {
      const victim = this.#residentVictim(job.intent)
      if (!victim) { this.#jobs.delete(key); return null }
      this.#jobs.delete(victim.jobId)
    }
    job.phase = 'resident'; job.touchedAt = now; job.expiresAt = expiresAt
    return this.#view(job)
  }

  consume(jobId: string, revision: number): ProjectionView | null {
    this.#live(); const key = id('jobId', jobId); safeInteger('revision', revision); const job = this.#jobs.get(key)
    if (!job || job.phase !== 'resident' || job.revision !== revision || this.#revisions.get(pairKey(job.sourceWkid, job.targetWkid)) !== revision) return null
    this.#jobs.delete(key); return this.#view(job)
  }
  cancel(jobId: string): boolean { this.#live(); return this.#jobs.delete(id('jobId', jobId)) }
  expire(now: number): number { this.#live(); clock('now', now); let removed = 0; for (const [key, job] of this.#jobs) if (job.expiresAt <= now) { this.#jobs.delete(key); removed++ } return removed }
  release(sourceWkid: number, targetWkid: number): number { this.#live(); this.#wkid(sourceWkid); this.#wkid(targetWkid); const pair = pairKey(sourceWkid, targetWkid); let removed = 0; for (const [key, job] of this.#jobs) if (pairKey(job.sourceWkid, job.targetWkid) === pair) { this.#jobs.delete(key); removed++ } this.#revisions.delete(pair); return removed }
  snapshot(): Readonly<{ spatialReferences:number; jobs:number; queued:number; running:number; resident:number; residentVertices:number; residentBytes:number }> { this.#live(); return Object.freeze({ spatialReferences:this.#revisions.size, jobs:this.#jobs.size, queued:this.#phaseCount('queued'), running:this.#phaseCount('running'), resident:this.#phaseCount('resident'), residentVertices:this.#residentVertices(), residentBytes:this.#residentBytes() }) }
  fingerprint(): string { this.#live(); return [...this.#jobs.values()].sort((a,b)=>a.sourceWkid-b.sourceWkid||a.targetWkid-b.targetWkid||a.sequence-b.sequence).map(j=>`${j.sourceWkid}>${j.targetWkid}:${j.jobId}:${j.revision}:${j.intent}:${j.phase}:${j.vertices}:${j.residentBytes}`).join('|') }
  dispose(): void { if (this.#disposed) return; this.#jobs.clear(); this.#revisions.clear(); this.#disposed = true }

  #residentVictim(incoming: ProjectionIntent): Job | undefined { const jobs=[...this.#jobs.values()].filter(j=>j.phase==='resident'&&intentRank[j.intent]<=intentRank[incoming]); jobs.sort((a,b)=>intentRank[a.intent]-intentRank[b.intent]||a.touchedAt-b.touchedAt||a.sequence-b.sequence); return jobs[0] }
  #phaseCount(phase: ProjectionPhase): number { let n=0; for (const job of this.#jobs.values()) if (job.phase===phase) n++; return n }
  #pairCount(pair: string): number { let n=0; for (const job of this.#jobs.values()) if (pairKey(job.sourceWkid,job.targetWkid)===pair) n++; return n }
  #pairPhaseCount(pair: string, phase: ProjectionPhase): number { let n=0; for (const job of this.#jobs.values()) if (pairKey(job.sourceWkid,job.targetWkid)===pair&&job.phase===phase) n++; return n }
  #residentVertices(): number { let n=0; for (const job of this.#jobs.values()) if (job.phase==='resident') n+=job.vertices; return n }
  #residentBytes(): number { let n=0; for (const job of this.#jobs.values()) if (job.phase==='resident') n+=job.residentBytes; return n }
  #wkid(value: number): void { safeInteger('wkid', value, 1) }
  #view(job: Job): ProjectionView { return Object.freeze({ jobId:job.jobId, sourceWkid:job.sourceWkid, targetWkid:job.targetWkid, revision:job.revision, intent:job.intent, vertices:job.vertices, estimatedBytes:job.estimatedBytes, requestedAt:job.requestedAt, phase:job.phase, sequence:job.sequence, touchedAt:job.touchedAt, expiresAt:job.expiresAt, residentBytes:job.residentBytes }) }
  #live(): void { if (this.#disposed) throw new Error('geometry projection lifecycle policy is disposed') }
}
