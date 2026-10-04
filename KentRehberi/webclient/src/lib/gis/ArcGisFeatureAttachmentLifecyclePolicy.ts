export type AttachmentIntent = 'interactive' | 'visible' | 'background'
export type AttachmentPhase = 'queued' | 'uploading' | 'resident'

export interface AttachmentLifecycleBudget {
  maxLayers: number
  maxJobs: number
  maxJobsPerLayer: number
  maxUploading: number
  maxUploadingPerLayer: number
  maxResident: number
  maxResidentPerLayer: number
  maxBytesPerAttachment: number
  maxResidentBytes: number
  queueTtlMs: number
  uploadLeaseMs: number
  residentTtlMs: number
}

export interface AttachmentRequest {
  jobId: string
  layerId: string
  featureId: string
  revision: number
  intent: AttachmentIntent
  estimatedBytes: number
  requestedAt: number
}

export interface AttachmentView {
  readonly jobId: string
  readonly layerId: string
  readonly featureId: string
  readonly revision: number
  readonly intent: AttachmentIntent
  readonly phase: AttachmentPhase
  readonly bytes: number
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Entry extends AttachmentRequest {
  phase: AttachmentPhase
  bytes: number
  sequence: number
  touchedAt: number
  expiresAt: number
}

const rank: Readonly<Record<AttachmentIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const intents: readonly AttachmentIntent[] = ['interactive', 'visible', 'background']

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
 * Payload-free lifecycle authority for ArcGIS feature attachment work.
 * Blob/File/ArrayBuffer, upload bodies, credentials and AbortSignal remain caller-owned.
 */
export class ArcGisFeatureAttachmentLifecyclePolicy {
  readonly #budget: Readonly<AttachmentLifecycleBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: AttachmentLifecycleBudget) {
    for (const key of ['maxLayers','maxJobs','maxJobsPerLayer','maxUploading','maxUploadingPerLayer','maxResident','maxResidentPerLayer','maxBytesPerAttachment','maxResidentBytes'] as const) integer(key, budget[key], 1)
    for (const key of ['queueTtlMs','uploadLeaseMs','residentTtlMs'] as const) finite(key, budget[key])
    if (budget.maxJobsPerLayer > budget.maxJobs) throw new Error('maxJobsPerLayer cannot exceed maxJobs')
    if (budget.maxUploadingPerLayer > budget.maxUploading) throw new Error('maxUploadingPerLayer cannot exceed maxUploading')
    if (budget.maxResidentPerLayer > budget.maxResident) throw new Error('maxResidentPerLayer cannot exceed maxResident')
    if (budget.maxBytesPerAttachment > budget.maxResidentBytes) throw new Error('maxBytesPerAttachment cannot exceed maxResidentBytes')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, revision: number): number {
    this.#assertLive()
    const layer = identifier('layerId', layerId); integer('revision', revision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && revision < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, revision)
    if (current === undefined || current === revision) return 0
    let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer && entry.revision !== revision) { this.#entries.delete(key); removed++ }
    return removed
  }

  admit(request: AttachmentRequest): boolean {
    this.#assertLive()
    const jobId = identifier('jobId', request.jobId)
    const layerId = identifier('layerId', request.layerId)
    const featureId = identifier('featureId', request.featureId)
    integer('revision', request.revision); integer('estimatedBytes', request.estimatedBytes, 1); finite('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(jobId)) return false
    if (request.estimatedBytes > this.#budget.maxBytesPerAttachment) return false
    if (this.#entries.size >= this.#budget.maxJobs || this.#countLayer(layerId) >= this.#budget.maxJobsPerLayer) return false
    const sequence = ++this.#sequence
    this.#entries.set(jobId, { ...request, jobId, layerId, featureId, phase: 'queued', bytes: request.estimatedBytes, sequence, touchedAt: request.requestedAt, expiresAt: request.requestedAt + this.#budget.queueTtlMs })
    return true
  }

  startNext(now: number): AttachmentView | null {
    this.#assertLive(); finite('now', now); this.expire(now)
    if (this.#countPhase('uploading') >= this.#budget.maxUploading) return null
    let candidate: Entry | undefined
    for (const entry of this.#entries.values()) {
      if (entry.phase !== 'queued' || this.#countLayerPhase(entry.layerId, 'uploading') >= this.#budget.maxUploadingPerLayer) continue
      if (!candidate || rank[entry.intent] > rank[candidate.intent] || (rank[entry.intent] === rank[candidate.intent] && entry.sequence < candidate.sequence)) candidate = entry
    }
    if (!candidate) return null
    candidate.phase = 'uploading'; candidate.touchedAt = now; candidate.expiresAt = now + this.#budget.uploadLeaseMs
    return this.#view(candidate)
  }

  complete(jobId: string, revision: number, actualBytes: number, now: number): boolean {
    this.#assertLive(); const id = identifier('jobId', jobId); integer('revision', revision); integer('actualBytes', actualBytes, 1); finite('now', now)
    this.expire(now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'uploading' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return false
    if (actualBytes > this.#budget.maxBytesPerAttachment) { this.#entries.delete(id); return false }
    this.#evictFor(entry, actualBytes)
    if (this.#countPhase('resident') >= this.#budget.maxResident || this.#countLayerPhase(entry.layerId, 'resident') >= this.#budget.maxResidentPerLayer || this.#residentBytes() + actualBytes > this.#budget.maxResidentBytes) {
      this.#entries.delete(id); return false
    }
    entry.phase = 'resident'; entry.bytes = actualBytes; entry.touchedAt = now; entry.expiresAt = now + this.#budget.residentTtlMs
    return true
  }

  touch(jobId: string, now: number): boolean {
    this.#assertLive(); const id = identifier('jobId', jobId); finite('now', now); const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'resident') return false
    entry.touchedAt = now; entry.expiresAt = now + this.#budget.residentTtlMs; return true
  }

  consume(jobId: string, revision: number): AttachmentView | null {
    this.#assertLive(); const id = identifier('jobId', jobId); integer('revision', revision); const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'resident' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return null
    this.#entries.delete(id); return this.#view(entry)
  }

  cancel(jobId: string): boolean { this.#assertLive(); return this.#entries.delete(identifier('jobId', jobId)) }

  releaseLayer(layerId: string): number {
    this.#assertLive(); const layer = identifier('layerId', layerId); let removed = 0
    for (const [key, entry] of this.#entries) if (entry.layerId === layer) { this.#entries.delete(key); removed++ }
    this.#revisions.delete(layer); return removed
  }

  expire(now: number): number {
    this.#assertLive(); finite('now', now); let removed = 0
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) { this.#entries.delete(key); removed++ }
    return removed
  }

  snapshot(): Readonly<{ layers: number; jobs: number; queued: number; uploading: number; resident: number; residentBytes: number }> {
    this.#assertLive(); return Object.freeze({ layers: this.#revisions.size, jobs: this.#entries.size, queued: this.#countPhase('queued'), uploading: this.#countPhase('uploading'), resident: this.#countPhase('resident'), residentBytes: this.#residentBytes() })
  }

  fingerprint(): string {
    this.#assertLive(); return [...this.#entries.values()].sort((a,b) => a.layerId.localeCompare(b.layerId) || a.jobId.localeCompare(b.jobId)).map(entry => `${entry.layerId}:${entry.featureId}:${entry.jobId}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.bytes}`).join('|')
  }

  dispose(): void { if (this.#disposed) return; this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }

  #evictFor(incoming: Entry, bytes: number): void {
    while (this.#countPhase('resident') >= this.#budget.maxResident || this.#countLayerPhase(incoming.layerId, 'resident') >= this.#budget.maxResidentPerLayer || this.#residentBytes() + bytes > this.#budget.maxResidentBytes) {
      let victim: Entry | undefined
      for (const entry of this.#entries.values()) if (entry.phase === 'resident' && (!victim || rank[entry.intent] < rank[victim.intent] || (rank[entry.intent] === rank[victim.intent] && (entry.touchedAt < victim.touchedAt || (entry.touchedAt === victim.touchedAt && entry.sequence < victim.sequence))))) victim = entry
      if (!victim || rank[victim.intent] > rank[incoming.intent]) return
      this.#entries.delete(victim.jobId)
    }
  }

  #countLayer(layerId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.layerId === layerId) count++; return count }
  #countPhase(phase: AttachmentPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count++; return count }
  #countLayerPhase(layerId: string, phase: AttachmentPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.layerId === layerId && entry.phase === phase) count++; return count }
  #residentBytes(): number { let bytes = 0; for (const entry of this.#entries.values()) if (entry.phase === 'resident') bytes += entry.bytes; return bytes }
  #view(entry: Entry): AttachmentView { return Object.freeze({ jobId: entry.jobId, layerId: entry.layerId, featureId: entry.featureId, revision: entry.revision, intent: entry.intent, phase: entry.phase, bytes: entry.bytes, sequence: entry.sequence, touchedAt: entry.touchedAt, expiresAt: entry.expiresAt }) }
  #assertLive(): void { if (this.#disposed) throw new Error('feature attachment lifecycle policy is disposed') }
}
