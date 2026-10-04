export type EditRecoveryIntent = 'interactive' | 'visible' | 'background'
export type EditRecoveryPhase = 'queued' | 'recovering' | 'resident'
export type EditRecoveryStrategy = 'retry' | 'reconcile' | 'manual'

export interface EditRecoveryBudget {
  maxLayers: number
  maxJobs: number
  maxJobsPerLayer: number
  maxRecovering: number
  maxRecoveringPerLayer: number
  maxOperationsPerJob: number
  maxBytesPerJob: number
  maxResidentOperations: number
  maxResidentBytes: number
  queueTtlMs: number
  recoveryLeaseMs: number
  residentTtlMs: number
}

export interface EditRecoveryRequest {
  jobId: string
  layerId: string
  revision: number
  intent: EditRecoveryIntent
  strategy: EditRecoveryStrategy
  operationCount: number
  estimatedBytes: number
  requestedAt: number
}

export interface EditRecoveryView {
  readonly jobId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: EditRecoveryIntent
  readonly strategy: EditRecoveryStrategy
  readonly phase: EditRecoveryPhase
  readonly operationCount: number
  readonly bytes: number
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Job extends EditRecoveryRequest {
  phase: EditRecoveryPhase
  bytes: number
  sequence: number
  touchedAt: number
  expiresAt: number
}

const intentRank: Readonly<Record<EditRecoveryIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const intents: readonly EditRecoveryIntent[] = ['interactive', 'visible', 'background']
const strategies: readonly EditRecoveryStrategy[] = ['retry', 'reconcile', 'manual']

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

/** Payload-free authority for bounded ArcGIS edit recovery orchestration. */
export class ArcGisEditRecoveryLifecyclePolicy {
  readonly #budget: Readonly<EditRecoveryBudget>
  readonly #jobs = new Map<string, Job>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: EditRecoveryBudget) {
    for (const key of ['maxLayers','maxJobs','maxJobsPerLayer','maxRecovering','maxRecoveringPerLayer','maxOperationsPerJob','maxBytesPerJob','maxResidentOperations','maxResidentBytes'] as const) integer(key, budget[key], 1)
    for (const key of ['queueTtlMs','recoveryLeaseMs','residentTtlMs'] as const) finite(key, budget[key])
    if (budget.maxJobsPerLayer > budget.maxJobs) throw new Error('maxJobsPerLayer cannot exceed maxJobs')
    if (budget.maxRecoveringPerLayer > budget.maxRecovering) throw new Error('maxRecoveringPerLayer cannot exceed maxRecovering')
    if (budget.maxOperationsPerJob > budget.maxResidentOperations) throw new Error('maxOperationsPerJob cannot exceed maxResidentOperations')
    if (budget.maxBytesPerJob > budget.maxResidentBytes) throw new Error('maxBytesPerJob cannot exceed maxResidentBytes')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#assertLive(); const layer = identifier('layerId', layerId); integer('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, revision)
    if (current === undefined || current === revision) return 0
    let removed = 0
    for (const [id, job] of this.#jobs) if (job.layerId === layer && job.revision !== revision) { this.#jobs.delete(id); removed++ }
    return removed
  }

  enqueue(request: EditRecoveryRequest): boolean {
    this.#assertLive()
    const jobId = identifier('jobId', request.jobId); const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision); integer('operationCount', request.operationCount, 1); integer('estimatedBytes', request.estimatedBytes, 1); finite('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (!strategies.includes(request.strategy)) throw new Error('strategy is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#jobs.has(jobId)) return false
    if (request.operationCount > this.#budget.maxOperationsPerJob || request.estimatedBytes > this.#budget.maxBytesPerJob) return false
    if (this.#jobs.size >= this.#budget.maxJobs || this.#countLayer(layerId) >= this.#budget.maxJobsPerLayer) return false
    const sequence = ++this.#sequence
    this.#jobs.set(jobId, { ...request, jobId, layerId, phase: 'queued', bytes: request.estimatedBytes, sequence, touchedAt: request.requestedAt, expiresAt: request.requestedAt + this.#budget.queueTtlMs })
    return true
  }

  startNext(now: number): EditRecoveryView | null {
    this.#assertLive(); finite('now', now); this.expire(now)
    if (this.#countPhase('recovering') >= this.#budget.maxRecovering) return null
    let candidate: Job | undefined
    for (const job of this.#jobs.values()) {
      if (job.phase !== 'queued' || this.#countLayerPhase(job.layerId, 'recovering') >= this.#budget.maxRecoveringPerLayer) continue
      if (!candidate || intentRank[job.intent] > intentRank[candidate.intent] || (intentRank[job.intent] === intentRank[candidate.intent] && (job.requestedAt < candidate.requestedAt || (job.requestedAt === candidate.requestedAt && job.sequence < candidate.sequence)))) candidate = job
    }
    if (!candidate) return null
    candidate.phase = 'recovering'; candidate.touchedAt = now; candidate.expiresAt = now + this.#budget.recoveryLeaseMs
    return this.#view(candidate)
  }

  complete(jobId: string, revision: number, actualOperations: number, actualBytes: number, now: number): boolean {
    this.#assertLive(); const id = identifier('jobId', jobId); integer('revision', revision); integer('actualOperations', actualOperations, 1); integer('actualBytes', actualBytes, 1); finite('now', now)
    this.expire(now)
    const job = this.#jobs.get(id)
    if (!job || job.phase !== 'recovering' || job.revision !== revision || this.#revisions.get(job.layerId) !== revision) return false
    if (actualOperations > this.#budget.maxOperationsPerJob || actualBytes > this.#budget.maxBytesPerJob) { this.#jobs.delete(id); return false }
    this.#evictFor(job, actualOperations, actualBytes)
    if (this.#residentOperationsExcluding(id) + actualOperations > this.#budget.maxResidentOperations || this.#residentBytesExcluding(id) + actualBytes > this.#budget.maxResidentBytes) { this.#jobs.delete(id); return false }
    job.phase = 'resident'; job.operationCount = actualOperations; job.bytes = actualBytes; job.touchedAt = now; job.expiresAt = now + this.#budget.residentTtlMs
    return true
  }

  fail(jobId: string, now: number, retry: boolean): boolean {
    this.#assertLive(); const job = this.#jobs.get(identifier('jobId', jobId)); finite('now', now)
    if (!job || job.phase !== 'recovering') return false
    if (!retry) return this.#jobs.delete(job.jobId)
    job.phase = 'queued'; job.touchedAt = now; job.requestedAt = now; job.expiresAt = now + this.#budget.queueTtlMs; return true
  }

  touch(jobId: string, now: number): boolean {
    this.#assertLive(); const job = this.#jobs.get(identifier('jobId', jobId)); finite('now', now)
    if (!job || job.phase !== 'resident') return false
    job.touchedAt = now; job.expiresAt = now + this.#budget.residentTtlMs; return true
  }

  consume(jobId: string): EditRecoveryView | null {
    this.#assertLive(); const id = identifier('jobId', jobId); const job = this.#jobs.get(id)
    if (!job || job.phase !== 'resident') return null
    this.#jobs.delete(id); return this.#view(job)
  }

  cancel(jobId: string): boolean { this.#assertLive(); return this.#jobs.delete(identifier('jobId', jobId)) }

  releaseLayer(layerId: string): number {
    this.#assertLive(); const layer = identifier('layerId', layerId); let removed = 0
    for (const [id, job] of this.#jobs) if (job.layerId === layer) { this.#jobs.delete(id); removed++ }
    this.#revisions.delete(layer); return removed
  }

  expire(now: number): number {
    this.#assertLive(); finite('now', now); let removed = 0
    for (const [id, job] of this.#jobs) if (job.expiresAt <= now) { this.#jobs.delete(id); removed++ }
    return removed
  }

  snapshot(): Readonly<{ layers: number; jobs: number; queued: number; recovering: number; resident: number; residentOperations: number; residentBytes: number }> {
    this.#assertLive(); return Object.freeze({ layers: this.#revisions.size, jobs: this.#jobs.size, queued: this.#countPhase('queued'), recovering: this.#countPhase('recovering'), resident: this.#countPhase('resident'), residentOperations: this.#residentOperationsExcluding(''), residentBytes: this.#residentBytesExcluding('') })
  }

  fingerprint(): string {
    this.#assertLive(); return [...this.#jobs.values()].sort((a,b) => a.layerId.localeCompare(b.layerId) || a.sequence - b.sequence).map(job => `${job.layerId}:${job.jobId}:${job.revision}:${job.intent}:${job.strategy}:${job.phase}:${job.operationCount}:${job.bytes}`).join('|')
  }

  dispose(): void { if (this.#disposed) return; this.#jobs.clear(); this.#revisions.clear(); this.#disposed = true }

  #evictFor(incoming: Job, operations: number, bytes: number): void {
    while (this.#residentOperationsExcluding(incoming.jobId) + operations > this.#budget.maxResidentOperations || this.#residentBytesExcluding(incoming.jobId) + bytes > this.#budget.maxResidentBytes) {
      let victim: Job | undefined
      for (const job of this.#jobs.values()) {
        if (job.jobId === incoming.jobId || job.phase !== 'resident') continue
        if (!victim || intentRank[job.intent] < intentRank[victim.intent] || (intentRank[job.intent] === intentRank[victim.intent] && (job.touchedAt < victim.touchedAt || (job.touchedAt === victim.touchedAt && job.sequence < victim.sequence)))) victim = job
      }
      if (!victim || intentRank[victim.intent] > intentRank[incoming.intent]) return
      this.#jobs.delete(victim.jobId)
    }
  }

  #countLayer(layerId: string): number { let count = 0; for (const job of this.#jobs.values()) if (job.layerId === layerId) count++; return count }
  #countPhase(phase: EditRecoveryPhase): number { let count = 0; for (const job of this.#jobs.values()) if (job.phase === phase) count++; return count }
  #countLayerPhase(layerId: string, phase: EditRecoveryPhase): number { let count = 0; for (const job of this.#jobs.values()) if (job.layerId === layerId && job.phase === phase) count++; return count }
  #residentOperationsExcluding(excluded: string): number { let count = 0; for (const job of this.#jobs.values()) if (job.jobId !== excluded && job.phase === 'resident') count += job.operationCount; return count }
  #residentBytesExcluding(excluded: string): number { let bytes = 0; for (const job of this.#jobs.values()) if (job.jobId !== excluded && job.phase === 'resident') bytes += job.bytes; return bytes }
  #view(job: Job): EditRecoveryView { return Object.freeze({ jobId: job.jobId, layerId: job.layerId, revision: job.revision, intent: job.intent, strategy: job.strategy, phase: job.phase, operationCount: job.operationCount, bytes: job.bytes, sequence: job.sequence, touchedAt: job.touchedAt, expiresAt: job.expiresAt }) }
  #assertLive(): void { if (this.#disposed) throw new Error('edit recovery lifecycle policy is disposed') }
}
