export type EditTransactionIntent = 'interactive' | 'visible' | 'background'
export type EditTransactionPhase = 'queued' | 'preparing' | 'prepared' | 'committing' | 'resident'

export interface EditTransactionBudget {
  maxLayers: number
  maxTransactions: number
  maxTransactionsPerLayer: number
  maxPreparing: number
  maxPreparingPerLayer: number
  maxCommitting: number
  maxCommittingPerLayer: number
  maxResident: number
  maxResidentPerLayer: number
  maxOperationsPerTransaction: number
  maxBytesPerTransaction: number
  maxResidentOperations: number
  maxResidentBytes: number
  queueTtlMs: number
  prepareLeaseMs: number
  preparedTtlMs: number
  commitLeaseMs: number
  residentTtlMs: number
}

export interface EditTransactionRequest {
  transactionId: string
  layerId: string
  revision: number
  intent: EditTransactionIntent
  operationCount: number
  estimatedBytes: number
  requestedAt: number
}

export interface EditTransactionView {
  readonly transactionId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: EditTransactionIntent
  readonly phase: EditTransactionPhase
  readonly operationCount: number
  readonly bytes: number
  readonly attempt: number
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Entry extends EditTransactionRequest {
  phase: EditTransactionPhase
  bytes: number
  attempt: number
  sequence: number
  touchedAt: number
  expiresAt: number
}

const intentRank: Readonly<Record<EditTransactionIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const intents: readonly EditTransactionIntent[] = ['interactive', 'visible', 'background']

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
 * Payload-free authority for multi-stage ArcGIS edit transactions.
 * Caller-owned Graphic/Geometry/attributes/request bodies never enter lifecycle state.
 */
export class ArcGisEditTransactionLifecyclePolicy {
  readonly #budget: Readonly<EditTransactionBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: EditTransactionBudget) {
    for (const key of ['maxLayers','maxTransactions','maxTransactionsPerLayer','maxPreparing','maxPreparingPerLayer','maxCommitting','maxCommittingPerLayer','maxResident','maxResidentPerLayer','maxOperationsPerTransaction','maxBytesPerTransaction','maxResidentOperations','maxResidentBytes'] as const) integer(key, budget[key], 1)
    for (const key of ['queueTtlMs','prepareLeaseMs','preparedTtlMs','commitLeaseMs','residentTtlMs'] as const) finite(key, budget[key])
    if (budget.maxTransactionsPerLayer > budget.maxTransactions) throw new Error('maxTransactionsPerLayer cannot exceed maxTransactions')
    if (budget.maxPreparingPerLayer > budget.maxPreparing) throw new Error('maxPreparingPerLayer cannot exceed maxPreparing')
    if (budget.maxCommittingPerLayer > budget.maxCommitting) throw new Error('maxCommittingPerLayer cannot exceed maxCommitting')
    if (budget.maxResidentPerLayer > budget.maxResident) throw new Error('maxResidentPerLayer cannot exceed maxResident')
    if (budget.maxOperationsPerTransaction > budget.maxResidentOperations) throw new Error('maxOperationsPerTransaction cannot exceed maxResidentOperations')
    if (budget.maxBytesPerTransaction > budget.maxResidentBytes) throw new Error('maxBytesPerTransaction cannot exceed maxResidentBytes')
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
    for (const [id, entry] of this.#entries) if (entry.layerId === layer && entry.revision !== revision) { this.#entries.delete(id); removed++ }
    return removed
  }

  admit(request: EditTransactionRequest): boolean {
    this.#assertLive()
    const transactionId = identifier('transactionId', request.transactionId)
    const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision); integer('operationCount', request.operationCount, 1); integer('estimatedBytes', request.estimatedBytes, 1); finite('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(transactionId)) return false
    if (request.operationCount > this.#budget.maxOperationsPerTransaction || request.estimatedBytes > this.#budget.maxBytesPerTransaction) return false
    if (this.#entries.size >= this.#budget.maxTransactions || this.#countLayer(layerId) >= this.#budget.maxTransactionsPerLayer) return false
    const sequence = ++this.#sequence
    this.#entries.set(transactionId, { ...request, transactionId, layerId, phase: 'queued', bytes: request.estimatedBytes, attempt: 0, sequence, touchedAt: request.requestedAt, expiresAt: request.requestedAt + this.#budget.queueTtlMs })
    return true
  }

  startPrepare(now: number): EditTransactionView | null {
    this.#assertLive(); finite('now', now); this.expire(now)
    if (this.#countPhase('preparing') >= this.#budget.maxPreparing) return null
    const candidate = this.#candidate('queued', 'preparing', this.#budget.maxPreparingPerLayer)
    if (!candidate) return null
    candidate.phase = 'preparing'; candidate.attempt++; candidate.touchedAt = now; candidate.expiresAt = now + this.#budget.prepareLeaseMs
    return this.#view(candidate)
  }

  finishPrepare(transactionId: string, revision: number, actualOperations: number, actualBytes: number, now: number): boolean {
    this.#assertLive(); const id = identifier('transactionId', transactionId); integer('revision', revision); integer('actualOperations', actualOperations, 1); integer('actualBytes', actualBytes, 1); finite('now', now); this.expire(now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'preparing' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return false
    if (actualOperations > this.#budget.maxOperationsPerTransaction || actualBytes > this.#budget.maxBytesPerTransaction) { this.#entries.delete(id); return false }
    entry.phase = 'prepared'; entry.operationCount = actualOperations; entry.bytes = actualBytes; entry.touchedAt = now; entry.expiresAt = now + this.#budget.preparedTtlMs
    return true
  }

  startCommit(now: number): EditTransactionView | null {
    this.#assertLive(); finite('now', now); this.expire(now)
    if (this.#countPhase('committing') >= this.#budget.maxCommitting) return null
    const candidate = this.#candidate('prepared', 'committing', this.#budget.maxCommittingPerLayer)
    if (!candidate) return null
    candidate.phase = 'committing'; candidate.attempt++; candidate.touchedAt = now; candidate.expiresAt = now + this.#budget.commitLeaseMs
    return this.#view(candidate)
  }

  finishCommit(transactionId: string, revision: number, now: number): boolean {
    this.#assertLive(); const id = identifier('transactionId', transactionId); integer('revision', revision); finite('now', now); this.expire(now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'committing' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return false
    this.#evictFor(entry)
    if (this.#countPhase('resident') >= this.#budget.maxResident || this.#countLayerPhase(entry.layerId, 'resident') >= this.#budget.maxResidentPerLayer || this.#residentOperations() + entry.operationCount > this.#budget.maxResidentOperations || this.#residentBytes() + entry.bytes > this.#budget.maxResidentBytes) { this.#entries.delete(id); return false }
    entry.phase = 'resident'; entry.touchedAt = now; entry.expiresAt = now + this.#budget.residentTtlMs
    return true
  }

  retry(transactionId: string, now: number): boolean {
    this.#assertLive(); const entry = this.#entries.get(identifier('transactionId', transactionId)); finite('now', now)
    if (!entry || (entry.phase !== 'preparing' && entry.phase !== 'prepared' && entry.phase !== 'committing')) return false
    if (this.#revisions.get(entry.layerId) !== entry.revision) { this.#entries.delete(entry.transactionId); return false }
    entry.phase = 'queued'; entry.touchedAt = now; entry.expiresAt = now + this.#budget.queueTtlMs; return true
  }

  touch(transactionId: string, now: number): boolean {
    this.#assertLive(); const entry = this.#entries.get(identifier('transactionId', transactionId)); finite('now', now)
    if (!entry || entry.phase !== 'resident') return false
    entry.touchedAt = now; entry.expiresAt = now + this.#budget.residentTtlMs; return true
  }

  consume(transactionId: string, revision: number): EditTransactionView | null {
    this.#assertLive(); const id = identifier('transactionId', transactionId); integer('revision', revision); const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'resident' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return null
    this.#entries.delete(id); return this.#view(entry)
  }

  cancel(transactionId: string): boolean { this.#assertLive(); return this.#entries.delete(identifier('transactionId', transactionId)) }
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

  snapshot(): Readonly<{ layers: number; transactions: number; queued: number; preparing: number; prepared: number; committing: number; resident: number; residentOperations: number; residentBytes: number }> {
    this.#assertLive(); return Object.freeze({ layers: this.#revisions.size, transactions: this.#entries.size, queued: this.#countPhase('queued'), preparing: this.#countPhase('preparing'), prepared: this.#countPhase('prepared'), committing: this.#countPhase('committing'), resident: this.#countPhase('resident'), residentOperations: this.#residentOperations(), residentBytes: this.#residentBytes() })
  }
  fingerprint(): string {
    this.#assertLive(); return [...this.#entries.values()].sort((a,b) => a.layerId.localeCompare(b.layerId) || a.transactionId.localeCompare(b.transactionId)).map(entry => `${entry.layerId}:${entry.transactionId}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.operationCount}:${entry.bytes}:${entry.attempt}`).join('|')
  }
  dispose(): void { if (this.#disposed) return; this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }

  #candidate(phase: EditTransactionPhase, activePhase: EditTransactionPhase, perLayer: number): Entry | undefined {
    let candidate: Entry | undefined
    for (const entry of this.#entries.values()) {
      if (entry.phase !== phase || this.#countLayerPhase(entry.layerId, activePhase) >= perLayer) continue
      if (!candidate || intentRank[entry.intent] > intentRank[candidate.intent] || (intentRank[entry.intent] === intentRank[candidate.intent] && entry.sequence < candidate.sequence)) candidate = entry
    }
    return candidate
  }
  #evictFor(incoming: Entry): void {
    while (this.#countPhase('resident') >= this.#budget.maxResident || this.#countLayerPhase(incoming.layerId, 'resident') >= this.#budget.maxResidentPerLayer || this.#residentOperations() + incoming.operationCount > this.#budget.maxResidentOperations || this.#residentBytes() + incoming.bytes > this.#budget.maxResidentBytes) {
      let victim: Entry | undefined
      for (const entry of this.#entries.values()) {
        if (entry.phase !== 'resident') continue
        if (!victim || intentRank[entry.intent] < intentRank[victim.intent] || (intentRank[entry.intent] === intentRank[victim.intent] && (entry.touchedAt < victim.touchedAt || (entry.touchedAt === victim.touchedAt && entry.sequence < victim.sequence)))) victim = entry
      }
      if (!victim || intentRank[victim.intent] > intentRank[incoming.intent]) return
      this.#entries.delete(victim.transactionId)
    }
  }
  #countLayer(layerId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.layerId === layerId) count++; return count }
  #countPhase(phase: EditTransactionPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count++; return count }
  #countLayerPhase(layerId: string, phase: EditTransactionPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.layerId === layerId && entry.phase === phase) count++; return count }
  #residentOperations(): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === 'resident') count += entry.operationCount; return count }
  #residentBytes(): number { let bytes = 0; for (const entry of this.#entries.values()) if (entry.phase === 'resident') bytes += entry.bytes; return bytes }
  #view(entry: Entry): EditTransactionView { return Object.freeze({ transactionId: entry.transactionId, layerId: entry.layerId, revision: entry.revision, intent: entry.intent, phase: entry.phase, operationCount: entry.operationCount, bytes: entry.bytes, attempt: entry.attempt, sequence: entry.sequence, touchedAt: entry.touchedAt, expiresAt: entry.expiresAt }) }
  #assertLive(): void { if (this.#disposed) throw new Error('edit transaction lifecycle policy is disposed') }
}
