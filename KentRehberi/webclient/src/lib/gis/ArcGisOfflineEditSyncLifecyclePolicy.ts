export type OfflineEditIntent = 'interactive' | 'visible' | 'background'
export type OfflineEditPhase = 'queued' | 'syncing' | 'resident'
export type OfflineEditOperation = 'add' | 'update' | 'delete'

export interface OfflineEditSyncBudget {
  maxLayers: number
  maxJobs: number
  maxJobsPerLayer: number
  maxSyncing: number
  maxSyncingPerLayer: number
  maxResident: number
  maxResidentPerLayer: number
  maxEditsPerJob: number
  maxBytesPerJob: number
  maxResidentBytes: number
  queueTtlMs: number
  syncLeaseMs: number
  residentTtlMs: number
}

export interface OfflineEditSyncRequest {
  jobId: string
  layerId: string
  replicaId: string
  revision: number
  intent: OfflineEditIntent
  operation: OfflineEditOperation
  editCount: number
  estimatedBytes: number
  requestedAt: number
}

export interface OfflineEditSyncView {
  readonly jobId: string
  readonly layerId: string
  readonly replicaId: string
  readonly revision: number
  readonly intent: OfflineEditIntent
  readonly operation: OfflineEditOperation
  readonly phase: OfflineEditPhase
  readonly editCount: number
  readonly bytes: number
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Entry extends OfflineEditSyncRequest {
  phase: OfflineEditPhase
  bytes: number
  sequence: number
  touchedAt: number
  expiresAt: number
}

const intentRank: Readonly<Record<OfflineEditIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const intents: readonly OfflineEditIntent[] = ['interactive', 'visible', 'background']
const operations: readonly OfflineEditOperation[] = ['add', 'update', 'delete']

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
 * Payload-free lifecycle authority for ArcGIS offline edit synchronization.
 *
 * This class intentionally owns only scalar scheduling/accounting metadata. Feature,
 * Graphic, Geometry, attachment, credential, token, request body and AbortSignal
 * payloads remain caller-owned. That boundary keeps long-lived offline queues from
 * retaining SDK object graphs while still giving the runtime deterministic pressure,
 * revision and lease semantics.
 */
export class ArcGisOfflineEditSyncLifecyclePolicy {
  readonly #budget: Readonly<OfflineEditSyncBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: OfflineEditSyncBudget) {
    for (const key of ['maxLayers','maxJobs','maxJobsPerLayer','maxSyncing','maxSyncingPerLayer','maxResident','maxResidentPerLayer','maxEditsPerJob','maxBytesPerJob','maxResidentBytes'] as const) integer(key, budget[key], 1)
    for (const key of ['queueTtlMs','syncLeaseMs','residentTtlMs'] as const) finite(key, budget[key])
    if (budget.maxJobsPerLayer > budget.maxJobs) throw new Error('maxJobsPerLayer cannot exceed maxJobs')
    if (budget.maxSyncingPerLayer > budget.maxSyncing) throw new Error('maxSyncingPerLayer cannot exceed maxSyncing')
    if (budget.maxResidentPerLayer > budget.maxResident) throw new Error('maxResidentPerLayer cannot exceed maxResident')
    if (budget.maxBytesPerJob > budget.maxResidentBytes) throw new Error('maxBytesPerJob cannot exceed maxResidentBytes')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#assertLive()
    const layer = identifier('layerId', layerId)
    integer('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, revision)
    if (current === undefined || current === revision) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId === layer && entry.revision !== revision) {
        this.#entries.delete(key)
        removed++
      }
    }
    return removed
  }

  admit(request: OfflineEditSyncRequest): boolean {
    this.#assertLive()
    const jobId = identifier('jobId', request.jobId)
    const layerId = identifier('layerId', request.layerId)
    const replicaId = identifier('replicaId', request.replicaId)
    integer('revision', request.revision)
    integer('editCount', request.editCount, 1)
    integer('estimatedBytes', request.estimatedBytes, 1)
    finite('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (!operations.includes(request.operation)) throw new Error('operation is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(jobId)) return false
    if (request.editCount > this.#budget.maxEditsPerJob || request.estimatedBytes > this.#budget.maxBytesPerJob) return false
    if (this.#entries.size >= this.#budget.maxJobs || this.#countLayer(layerId) >= this.#budget.maxJobsPerLayer) return false
    const sequence = ++this.#sequence
    this.#entries.set(jobId, {
      ...request,
      jobId,
      layerId,
      replicaId,
      phase: 'queued',
      bytes: request.estimatedBytes,
      sequence,
      touchedAt: request.requestedAt,
      expiresAt: request.requestedAt + this.#budget.queueTtlMs,
    })
    return true
  }

  startNext(now: number): OfflineEditSyncView | null {
    this.#assertLive()
    finite('now', now)
    this.expire(now)
    if (this.#countPhase('syncing') >= this.#budget.maxSyncing) return null
    let candidate: Entry | undefined
    for (const entry of this.#entries.values()) {
      if (entry.phase !== 'queued') continue
      if (this.#countLayerPhase(entry.layerId, 'syncing') >= this.#budget.maxSyncingPerLayer) continue
      if (!candidate || intentRank[entry.intent] > intentRank[candidate.intent] || (intentRank[entry.intent] === intentRank[candidate.intent] && entry.sequence < candidate.sequence)) candidate = entry
    }
    if (!candidate) return null
    candidate.phase = 'syncing'
    candidate.touchedAt = now
    candidate.expiresAt = now + this.#budget.syncLeaseMs
    return this.#view(candidate)
  }

  complete(jobId: string, revision: number, actualEditCount: number, actualBytes: number, now: number): boolean {
    this.#assertLive()
    const id = identifier('jobId', jobId)
    integer('revision', revision)
    integer('actualEditCount', actualEditCount, 1)
    integer('actualBytes', actualBytes, 1)
    finite('now', now)
    this.expire(now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'syncing' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return false
    if (actualEditCount > this.#budget.maxEditsPerJob || actualBytes > this.#budget.maxBytesPerJob) {
      this.#entries.delete(id)
      return false
    }
    this.#evictFor(entry, actualBytes)
    if (this.#countPhase('resident') >= this.#budget.maxResident || this.#countLayerPhase(entry.layerId, 'resident') >= this.#budget.maxResidentPerLayer || this.#residentBytes() + actualBytes > this.#budget.maxResidentBytes) {
      this.#entries.delete(id)
      return false
    }
    entry.phase = 'resident'
    entry.editCount = actualEditCount
    entry.bytes = actualBytes
    entry.touchedAt = now
    entry.expiresAt = now + this.#budget.residentTtlMs
    return true
  }

  touch(jobId: string, now: number): boolean {
    this.#assertLive()
    const id = identifier('jobId', jobId)
    finite('now', now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'resident') return false
    entry.touchedAt = now
    entry.expiresAt = now + this.#budget.residentTtlMs
    return true
  }

  consume(jobId: string, revision: number): OfflineEditSyncView | null {
    this.#assertLive()
    const id = identifier('jobId', jobId)
    integer('revision', revision)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'resident' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return null
    this.#entries.delete(id)
    return this.#view(entry)
  }

  cancel(jobId: string): boolean {
    this.#assertLive()
    return this.#entries.delete(identifier('jobId', jobId))
  }

  releaseLayer(layerId: string): number {
    this.#assertLive()
    const layer = identifier('layerId', layerId)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.layerId === layer) {
        this.#entries.delete(key)
        removed++
      }
    }
    this.#revisions.delete(layer)
    return removed
  }

  expire(now: number): number {
    this.#assertLive()
    finite('now', now)
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key)
        removed++
      }
    }
    return removed
  }

  snapshot(): Readonly<{ layers: number; jobs: number; queued: number; syncing: number; resident: number; residentEdits: number; residentBytes: number }> {
    this.#assertLive()
    let residentEdits = 0
    for (const entry of this.#entries.values()) if (entry.phase === 'resident') residentEdits += entry.editCount
    return Object.freeze({
      layers: this.#revisions.size,
      jobs: this.#entries.size,
      queued: this.#countPhase('queued'),
      syncing: this.#countPhase('syncing'),
      resident: this.#countPhase('resident'),
      residentEdits,
      residentBytes: this.#residentBytes(),
    })
  }

  fingerprint(): string {
    this.#assertLive()
    return [...this.#entries.values()]
      .sort((a, b) => a.layerId.localeCompare(b.layerId) || a.replicaId.localeCompare(b.replicaId) || a.jobId.localeCompare(b.jobId))
      .map(entry => `${entry.layerId}:${entry.replicaId}:${entry.jobId}:${entry.revision}:${entry.intent}:${entry.operation}:${entry.phase}:${entry.editCount}:${entry.bytes}`)
      .join('|')
  }

  dispose(): void {
    if (this.#disposed) return
    this.#entries.clear()
    this.#revisions.clear()
    this.#disposed = true
  }

  #evictFor(incoming: Entry, bytes: number): void {
    while (this.#countPhase('resident') >= this.#budget.maxResident || this.#countLayerPhase(incoming.layerId, 'resident') >= this.#budget.maxResidentPerLayer || this.#residentBytes() + bytes > this.#budget.maxResidentBytes) {
      let victim: Entry | undefined
      for (const entry of this.#entries.values()) {
        if (entry.phase !== 'resident') continue
        if (!victim || intentRank[entry.intent] < intentRank[victim.intent] || (intentRank[entry.intent] === intentRank[victim.intent] && (entry.touchedAt < victim.touchedAt || (entry.touchedAt === victim.touchedAt && entry.sequence < victim.sequence)))) victim = entry
      }
      if (!victim || intentRank[victim.intent] > intentRank[incoming.intent]) return
      this.#entries.delete(victim.jobId)
    }
  }

  #countLayer(layerId: string): number {
    let count = 0
    for (const entry of this.#entries.values()) if (entry.layerId === layerId) count++
    return count
  }

  #countPhase(phase: OfflineEditPhase): number {
    let count = 0
    for (const entry of this.#entries.values()) if (entry.phase === phase) count++
    return count
  }

  #countLayerPhase(layerId: string, phase: OfflineEditPhase): number {
    let count = 0
    for (const entry of this.#entries.values()) if (entry.layerId === layerId && entry.phase === phase) count++
    return count
  }

  #residentBytes(): number {
    let bytes = 0
    for (const entry of this.#entries.values()) if (entry.phase === 'resident') bytes += entry.bytes
    return bytes
  }

  #view(entry: Entry): OfflineEditSyncView {
    return Object.freeze({
      jobId: entry.jobId,
      layerId: entry.layerId,
      replicaId: entry.replicaId,
      revision: entry.revision,
      intent: entry.intent,
      operation: entry.operation,
      phase: entry.phase,
      editCount: entry.editCount,
      bytes: entry.bytes,
      sequence: entry.sequence,
      touchedAt: entry.touchedAt,
      expiresAt: entry.expiresAt,
    })
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('offline edit sync lifecycle policy is disposed')
  }
}
