export type ArcGisEditIntent = 'background' | 'user' | 'critical'
export type ArcGisEditOperation = 'add' | 'update' | 'delete'
export type ArcGisEditPhase = 'queued' | 'running' | 'committed'

export interface ArcGisEditTransactionBudget {
  maxTransactions: number
  maxTransactionsPerLayer: number
  maxRunning: number
  maxCommitted: number
  maxOperationsPerTransaction: number
  maxAggregateOperations: number
  maxEstimatedBytesPerTransaction: number
  maxAggregateEstimatedBytes: number
  queueTtlMs: number
  runLeaseMs: number
  committedTtlMs: number
}

export interface ArcGisEditTransactionRequest {
  transactionId: string
  layerId: string
  revision: number
  intent: ArcGisEditIntent
  requestedAt: number
  operationCount: number
  estimatedBytes: number
  operation: ArcGisEditOperation
}

export interface ArcGisEditTransactionView {
  readonly transactionId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: ArcGisEditIntent
  readonly operation: ArcGisEditOperation
  readonly phase: ArcGisEditPhase
  readonly operationCount: number
  readonly estimatedBytes: number
  readonly sequence: number
  readonly expiresAt: number
}

interface Entry extends ArcGisEditTransactionRequest {
  phase: ArcGisEditPhase
  sequence: number
  expiresAt: number
}

const priority: Readonly<Record<ArcGisEditIntent, number>> = Object.freeze({ background: 0, user: 1, critical: 2 })

function integer(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}

function finite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

function identifier(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || normalized.includes('\u0000')) throw new Error(`${name} must contain 1..256 safe characters`)
  return normalized
}

/**
 * Payload-free admission and lifecycle authority for ArcGIS applyEdits-style
 * transactions. Graphic/Geometry objects, attributes, credentials, request
 * bodies and AbortControllers remain caller-owned. This class intentionally
 * stores only bounded accounting metadata so edit payloads cannot become a
 * second client-side data store and layer teardown releases all references.
 *
 * Revision watermarks make stale queued/running completions fail closed after
 * a layer refresh or authoritative server revision advances. Transaction ids
 * provide deterministic dedupe without hashing or retaining feature content.
 */
export class ArcGisEditTransactionLifecyclePolicy {
  readonly #budget: Readonly<ArcGisEditTransactionBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #layerRevisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisEditTransactionBudget) {
    integer('maxTransactions', budget.maxTransactions, 1)
    integer('maxTransactionsPerLayer', budget.maxTransactionsPerLayer, 1)
    integer('maxRunning', budget.maxRunning, 1)
    integer('maxCommitted', budget.maxCommitted, 1)
    integer('maxOperationsPerTransaction', budget.maxOperationsPerTransaction, 1)
    integer('maxAggregateOperations', budget.maxAggregateOperations, 1)
    integer('maxEstimatedBytesPerTransaction', budget.maxEstimatedBytesPerTransaction, 1)
    integer('maxAggregateEstimatedBytes', budget.maxAggregateEstimatedBytes, 1)
    finite('queueTtlMs', budget.queueTtlMs)
    finite('runLeaseMs', budget.runLeaseMs)
    finite('committedTtlMs', budget.committedTtlMs)
    if (budget.maxTransactionsPerLayer > budget.maxTransactions) throw new Error('maxTransactionsPerLayer cannot exceed maxTransactions')
    if (budget.maxRunning > budget.maxTransactions || budget.maxCommitted > budget.maxTransactions) throw new Error('phase limits cannot exceed maxTransactions')
    if (budget.maxOperationsPerTransaction > budget.maxAggregateOperations) throw new Error('operation budget is inconsistent')
    if (budget.maxEstimatedBytesPerTransaction > budget.maxAggregateEstimatedBytes) throw new Error('byte budget is inconsistent')
    this.#budget = Object.freeze({ ...budget })
  }

  admit(request: ArcGisEditTransactionRequest): boolean {
    this.#active()
    const transactionId = identifier('transactionId', request.transactionId)
    const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision, 0)
    finite('requestedAt', request.requestedAt)
    integer('operationCount', request.operationCount, 1)
    integer('estimatedBytes', request.estimatedBytes, 0)
    if (request.operationCount > this.#budget.maxOperationsPerTransaction) return false
    if (request.estimatedBytes > this.#budget.maxEstimatedBytesPerTransaction) return false

    const watermark = this.#layerRevisions.get(layerId)
    if (watermark !== undefined && request.revision < watermark) return false
    if (watermark !== undefined && request.revision > watermark) this.invalidateLayer(layerId, request.revision)

    const existing = this.#entries.get(transactionId)
    if (existing) {
      if (existing.layerId !== layerId || existing.revision !== request.revision || existing.operation !== request.operation) return false
      if (existing.phase !== 'queued' || priority[existing.intent] > priority[request.intent]) return false
    }
    if (!existing && this.#entries.size >= this.#budget.maxTransactions) return false
    if (!existing && this.#countLayer(layerId) >= this.#budget.maxTransactionsPerLayer) return false
    if (this.#sumOperations() - (existing?.operationCount ?? 0) + request.operationCount > this.#budget.maxAggregateOperations) return false
    if (this.#sumBytes() - (existing?.estimatedBytes ?? 0) + request.estimatedBytes > this.#budget.maxAggregateEstimatedBytes) return false

    const entry: Entry = {
      ...request,
      transactionId,
      layerId,
      phase: 'queued',
      sequence: existing?.sequence ?? this.#sequence++,
      expiresAt: request.requestedAt + this.#budget.queueTtlMs,
    }
    this.#entries.set(transactionId, Object.freeze(entry))
    this.#layerRevisions.set(layerId, request.revision)
    return true
  }

  next(now: number): Readonly<ArcGisEditTransactionView> | null {
    this.#active()
    finite('now', now)
    this.expire(now)
    if (this.#countPhase('running') >= this.#budget.maxRunning) return null
    const entry = [...this.#entries.values()]
      .filter(candidate => candidate.phase === 'queued')
      .sort((a, b) => priority[b.intent] - priority[a.intent] || a.sequence - b.sequence)[0]
    if (!entry) return null
    const running: Entry = Object.freeze({ ...entry, phase: 'running', expiresAt: now + this.#budget.runLeaseMs })
    this.#entries.set(entry.transactionId, running)
    return this.#view(running)
  }

  commit(transactionId: string, revision: number, now: number): boolean {
    this.#active()
    const id = identifier('transactionId', transactionId)
    integer('revision', revision, 0)
    finite('now', now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision || now > entry.expiresAt) return false
    if (this.#layerRevisions.get(entry.layerId) !== revision) return false
    if (this.#countPhase('committed') >= this.#budget.maxCommitted) return false
    this.#entries.set(id, Object.freeze({ ...entry, phase: 'committed', expiresAt: now + this.#budget.committedTtlMs }))
    return true
  }

  consume(transactionId: string, revision: number): boolean {
    this.#active()
    const id = identifier('transactionId', transactionId)
    integer('revision', revision, 0)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'committed' || entry.revision !== revision) return false
    return this.#entries.delete(id)
  }

  cancel(transactionId: string): boolean {
    this.#active()
    const id = identifier('transactionId', transactionId)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase === 'committed') return false
    return this.#entries.delete(id)
  }

  invalidateLayer(layerId: string, revision: number): number {
    this.#active()
    const layer = identifier('layerId', layerId)
    integer('revision', revision, 0)
    const current = this.#layerRevisions.get(layer)
    if (current !== undefined && revision <= current) return 0
    let removed = 0
    for (const [id, entry] of this.#entries) {
      if (entry.layerId === layer && entry.revision < revision) {
        this.#entries.delete(id)
        removed += 1
      }
    }
    this.#layerRevisions.set(layer, revision)
    return removed
  }

  releaseLayer(layerId: string): number {
    this.#active()
    const layer = identifier('layerId', layerId)
    let removed = 0
    for (const [id, entry] of this.#entries) {
      if (entry.layerId === layer) {
        this.#entries.delete(id)
        removed += 1
      }
    }
    this.#layerRevisions.delete(layer)
    return removed
  }

  expire(now: number): number {
    this.#active()
    finite('now', now)
    let removed = 0
    for (const [id, entry] of this.#entries) {
      if (now > entry.expiresAt) {
        this.#entries.delete(id)
        removed += 1
      }
    }
    return removed
  }

  entriesForLayer(layerId: string): readonly Readonly<ArcGisEditTransactionView>[] {
    this.#active()
    const layer = identifier('layerId', layerId)
    return Object.freeze([...this.#entries.values()]
      .filter(entry => entry.layerId === layer)
      .sort((a, b) => a.sequence - b.sequence)
      .map(entry => this.#view(entry)))
  }

  snapshot(): Readonly<{ transactions: number; queued: number; running: number; committed: number; operations: number; estimatedBytes: number }> {
    this.#active()
    return Object.freeze({
      transactions: this.#entries.size,
      queued: this.#countPhase('queued'),
      running: this.#countPhase('running'),
      committed: this.#countPhase('committed'),
      operations: this.#sumOperations(),
      estimatedBytes: this.#sumBytes(),
    })
  }

  fingerprint(): string {
    this.#active()
    return [...this.#entries.values()]
      .sort((a, b) => a.layerId.localeCompare(b.layerId) || a.transactionId.localeCompare(b.transactionId))
      .map(entry => [entry.layerId, entry.transactionId, entry.revision, entry.intent, entry.operation, entry.phase, entry.operationCount, entry.estimatedBytes].join(':'))
      .join('|')
  }

  dispose(): void {
    this.#entries.clear()
    this.#layerRevisions.clear()
    this.#disposed = true
  }

  #countLayer(layerId: string): number {
    let total = 0
    for (const entry of this.#entries.values()) if (entry.layerId === layerId) total += 1
    return total
  }

  #countPhase(phase: ArcGisEditPhase): number {
    let total = 0
    for (const entry of this.#entries.values()) if (entry.phase === phase) total += 1
    return total
  }

  #sumOperations(): number {
    let total = 0
    for (const entry of this.#entries.values()) total += entry.operationCount
    return total
  }

  #sumBytes(): number {
    let total = 0
    for (const entry of this.#entries.values()) total += entry.estimatedBytes
    return total
  }

  #view(entry: Entry): Readonly<ArcGisEditTransactionView> {
    return Object.freeze({
      transactionId: entry.transactionId,
      layerId: entry.layerId,
      revision: entry.revision,
      intent: entry.intent,
      operation: entry.operation,
      phase: entry.phase,
      operationCount: entry.operationCount,
      estimatedBytes: entry.estimatedBytes,
      sequence: entry.sequence,
      expiresAt: entry.expiresAt,
    })
  }

  #active(): void {
    if (this.#disposed) throw new Error('ArcGisEditTransactionLifecyclePolicy is disposed')
  }
}
