export type EditBatchIntent = 'interactive' | 'visible' | 'background'
export type EditBatchPhase = 'queued' | 'committing' | 'resident'

export interface EditBatchCommitBudget {
  maxLayers: number
  maxBatches: number
  maxBatchesPerLayer: number
  maxCommitting: number
  maxCommittingPerLayer: number
  maxResident: number
  maxResidentPerLayer: number
  maxOperationsPerBatch: number
  maxBytesPerBatch: number
  maxResidentOperations: number
  maxResidentBytes: number
  queueTtlMs: number
  commitLeaseMs: number
  residentTtlMs: number
}

export interface EditBatchCommitRequest {
  batchId: string
  layerId: string
  revision: number
  intent: EditBatchIntent
  operationCount: number
  estimatedBytes: number
  requestedAt: number
}

export interface EditBatchCommitView {
  readonly batchId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: EditBatchIntent
  readonly phase: EditBatchPhase
  readonly operationCount: number
  readonly bytes: number
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Entry extends EditBatchCommitRequest {
  phase: EditBatchPhase
  bytes: number
  sequence: number
  touchedAt: number
  expiresAt: number
}

const intentRank: Readonly<Record<EditBatchIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const intents: readonly EditBatchIntent[] = ['interactive', 'visible', 'background']

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

/** Payload-free authority for applyEdits-style batch commit scheduling and residency. */
export class ArcGisEditBatchCommitLifecyclePolicy {
  readonly #budget: Readonly<EditBatchCommitBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: EditBatchCommitBudget) {
    for (const key of ['maxLayers','maxBatches','maxBatchesPerLayer','maxCommitting','maxCommittingPerLayer','maxResident','maxResidentPerLayer','maxOperationsPerBatch','maxBytesPerBatch','maxResidentOperations','maxResidentBytes'] as const) integer(key, budget[key], 1)
    for (const key of ['queueTtlMs','commitLeaseMs','residentTtlMs'] as const) finite(key, budget[key])
    if (budget.maxBatchesPerLayer > budget.maxBatches) throw new Error('maxBatchesPerLayer cannot exceed maxBatches')
    if (budget.maxCommittingPerLayer > budget.maxCommitting) throw new Error('maxCommittingPerLayer cannot exceed maxCommitting')
    if (budget.maxResidentPerLayer > budget.maxResident) throw new Error('maxResidentPerLayer cannot exceed maxResident')
    if (budget.maxBytesPerBatch > budget.maxResidentBytes) throw new Error('maxBytesPerBatch cannot exceed maxResidentBytes')
    if (budget.maxOperationsPerBatch > budget.maxResidentOperations) throw new Error('maxOperationsPerBatch cannot exceed maxResidentOperations')
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
    for (const [id, entry] of this.#entries) if (entry.layerId === layer && entry.revision !== revision) { this.#entries.delete(id); removed++ }
    return removed
  }

  admit(request: EditBatchCommitRequest): boolean {
    this.#assertLive()
    const batchId = identifier('batchId', request.batchId)
    const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision)
    integer('operationCount', request.operationCount, 1)
    integer('estimatedBytes', request.estimatedBytes, 1)
    finite('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(batchId)) return false
    if (request.operationCount > this.#budget.maxOperationsPerBatch || request.estimatedBytes > this.#budget.maxBytesPerBatch) return false
    if (this.#entries.size >= this.#budget.maxBatches || this.#countLayer(layerId) >= this.#budget.maxBatchesPerLayer) return false
    const sequence = ++this.#sequence
    this.#entries.set(batchId, { ...request, batchId, layerId, phase: 'queued', bytes: request.estimatedBytes, sequence, touchedAt: request.requestedAt, expiresAt: request.requestedAt + this.#budget.queueTtlMs })
    return true
  }

  startNext(now: number): EditBatchCommitView | null {
    this.#assertLive(); finite('now', now); this.expire(now)
    if (this.#countPhase('committing') >= this.#budget.maxCommitting) return null
    let candidate: Entry | undefined
    for (const entry of this.#entries.values()) {
      if (entry.phase !== 'queued' || this.#countLayerPhase(entry.layerId, 'committing') >= this.#budget.maxCommittingPerLayer) continue
      if (!candidate || intentRank[entry.intent] > intentRank[candidate.intent] || (intentRank[entry.intent] === intentRank[candidate.intent] && entry.sequence < candidate.sequence)) candidate = entry
    }
    if (!candidate) return null
    candidate.phase = 'committing'; candidate.touchedAt = now; candidate.expiresAt = now + this.#budget.commitLeaseMs
    return this.#view(candidate)
  }

  complete(batchId: string, revision: number, actualOperations: number, actualBytes: number, now: number): boolean {
    this.#assertLive(); const id = identifier('batchId', batchId); integer('revision', revision); integer('actualOperations', actualOperations, 1); integer('actualBytes', actualBytes, 1); finite('now', now); this.expire(now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'committing' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return false
    if (actualOperations > this.#budget.maxOperationsPerBatch || actualBytes > this.#budget.maxBytesPerBatch) { this.#entries.delete(id); return false }
    this.#evictFor(entry, actualOperations, actualBytes)
    if (this.#countPhase('resident') >= this.#budget.maxResident || this.#countLayerPhase(entry.layerId, 'resident') >= this.#budget.maxResidentPerLayer || this.#residentOperations() + actualOperations > this.#budget.maxResidentOperations || this.#residentBytes() + actualBytes > this.#budget.maxResidentBytes) { this.#entries.delete(id); return false }
    entry.phase = 'resident'; entry.operationCount = actualOperations; entry.bytes = actualBytes; entry.touchedAt = now; entry.expiresAt = now + this.#budget.residentTtlMs
    return true
  }

  touch(batchId: string, now: number): boolean {
    this.#assertLive(); const entry = this.#entries.get(identifier('batchId', batchId)); finite('now', now)
    if (!entry || entry.phase !== 'resident') return false
    entry.touchedAt = now; entry.expiresAt = now + this.#budget.residentTtlMs; return true
  }

  consume(batchId: string, revision: number): EditBatchCommitView | null {
    this.#assertLive(); const id = identifier('batchId', batchId); integer('revision', revision); const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'resident' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return null
    this.#entries.delete(id); return this.#view(entry)
  }

  cancel(batchId: string): boolean { this.#assertLive(); return this.#entries.delete(identifier('batchId', batchId)) }

  releaseLayer(layerId: string): number {
    this.#assertLive(); const layer = identifier('layerId', layerId); let removed = 0
    for (const [id, entry] of this.#entries) if (entry.layerId === layer) { this.#entries.delete(id); removed++ }
    this.#revisions.delete(layer); return removed
  }

  expire(now: number): number {
    this.#assertLive(); finite('now', now); let removed = 0
    for (const [id, entry] of this.#entries) if (entry.expiresAt <= now) { this.#entries.delete(id); removed++ }
    return removed
  }

  snapshot(): Readonly<{ layers: number; batches: number; queued: number; committing: number; resident: number; residentOperations: number; residentBytes: number }> {
    this.#assertLive()
    return Object.freeze({ layers: this.#revisions.size, batches: this.#entries.size, queued: this.#countPhase('queued'), committing: this.#countPhase('committing'), resident: this.#countPhase('resident'), residentOperations: this.#residentOperations(), residentBytes: this.#residentBytes() })
  }

  fingerprint(): string {
    this.#assertLive()
    return [...this.#entries.values()].sort((a,b) => a.layerId.localeCompare(b.layerId) || a.batchId.localeCompare(b.batchId)).map(entry => `${entry.layerId}:${entry.batchId}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.operationCount}:${entry.bytes}`).join('|')
  }

  dispose(): void { if (this.#disposed) return; this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }

  #evictFor(incoming: Entry, operations: number, bytes: number): void {
    while (this.#countPhase('resident') >= this.#budget.maxResident || this.#countLayerPhase(incoming.layerId, 'resident') >= this.#budget.maxResidentPerLayer || this.#residentOperations() + operations > this.#budget.maxResidentOperations || this.#residentBytes() + bytes > this.#budget.maxResidentBytes) {
      let victim: Entry | undefined
      for (const entry of this.#entries.values()) {
        if (entry.phase !== 'resident') continue
        if (!victim || intentRank[entry.intent] < intentRank[victim.intent] || (intentRank[entry.intent] === intentRank[victim.intent] && (entry.touchedAt < victim.touchedAt || (entry.touchedAt === victim.touchedAt && entry.sequence < victim.sequence)))) victim = entry
      }
      if (!victim || intentRank[victim.intent] > intentRank[incoming.intent]) return
      this.#entries.delete(victim.batchId)
    }
  }

  #countLayer(layerId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.layerId === layerId) count++; return count }
  #countPhase(phase: EditBatchPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count++; return count }
  #countLayerPhase(layerId: string, phase: EditBatchPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.layerId === layerId && entry.phase === phase) count++; return count }
  #residentOperations(): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === 'resident') count += entry.operationCount; return count }
  #residentBytes(): number { let bytes = 0; for (const entry of this.#entries.values()) if (entry.phase === 'resident') bytes += entry.bytes; return bytes }
  #view(entry: Entry): EditBatchCommitView { return Object.freeze({ batchId: entry.batchId, layerId: entry.layerId, revision: entry.revision, intent: entry.intent, phase: entry.phase, operationCount: entry.operationCount, bytes: entry.bytes, sequence: entry.sequence, touchedAt: entry.touchedAt, expiresAt: entry.expiresAt }) }
  #assertLive(): void { if (this.#disposed) throw new Error('edit batch commit lifecycle policy is disposed') }
}
