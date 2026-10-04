export type EditHistoryIntent = 'interactive' | 'visible' | 'background'
export type EditHistoryPhase = 'staged' | 'committed' | 'undone'

export interface EditHistoryBudget {
  maxLayers: number
  maxEntries: number
  maxEntriesPerLayer: number
  maxOperationsPerEntry: number
  maxBytesPerEntry: number
  maxResidentOperations: number
  maxResidentBytes: number
  stagedTtlMs: number
  historyTtlMs: number
}

export interface EditHistoryRequest {
  entryId: string
  layerId: string
  revision: number
  intent: EditHistoryIntent
  operationCount: number
  estimatedBytes: number
  requestedAt: number
}

export interface EditHistoryView {
  readonly entryId: string
  readonly layerId: string
  readonly revision: number
  readonly intent: EditHistoryIntent
  readonly phase: EditHistoryPhase
  readonly operationCount: number
  readonly bytes: number
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
}

interface Entry extends EditHistoryRequest {
  phase: EditHistoryPhase
  bytes: number
  sequence: number
  touchedAt: number
  expiresAt: number
}

const intentRank: Readonly<Record<EditHistoryIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })
const intents: readonly EditHistoryIntent[] = ['interactive', 'visible', 'background']

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
 * Payload-free authority for bounded ArcGIS edit undo/redo history.
 * Geometry, Graphic, attributes and inverse-operation payloads stay caller-owned.
 */
export class ArcGisEditHistoryLifecyclePolicy {
  readonly #budget: Readonly<EditHistoryBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: EditHistoryBudget) {
    for (const key of ['maxLayers','maxEntries','maxEntriesPerLayer','maxOperationsPerEntry','maxBytesPerEntry','maxResidentOperations','maxResidentBytes'] as const) integer(key, budget[key], 1)
    for (const key of ['stagedTtlMs','historyTtlMs'] as const) finite(key, budget[key])
    if (budget.maxEntriesPerLayer > budget.maxEntries) throw new Error('maxEntriesPerLayer cannot exceed maxEntries')
    if (budget.maxOperationsPerEntry > budget.maxResidentOperations) throw new Error('maxOperationsPerEntry cannot exceed maxResidentOperations')
    if (budget.maxBytesPerEntry > budget.maxResidentBytes) throw new Error('maxBytesPerEntry cannot exceed maxResidentBytes')
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

  stage(request: EditHistoryRequest): boolean {
    this.#assertLive()
    const entryId = identifier('entryId', request.entryId)
    const layerId = identifier('layerId', request.layerId)
    integer('revision', request.revision)
    integer('operationCount', request.operationCount, 1)
    integer('estimatedBytes', request.estimatedBytes, 1)
    finite('requestedAt', request.requestedAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(entryId)) return false
    if (request.operationCount > this.#budget.maxOperationsPerEntry || request.estimatedBytes > this.#budget.maxBytesPerEntry) return false
    if (this.#entries.size >= this.#budget.maxEntries || this.#countLayer(layerId) >= this.#budget.maxEntriesPerLayer) return false
    const sequence = ++this.#sequence
    this.#entries.set(entryId, { ...request, entryId, layerId, phase: 'staged', bytes: request.estimatedBytes, sequence, touchedAt: request.requestedAt, expiresAt: request.requestedAt + this.#budget.stagedTtlMs })
    return true
  }

  commit(entryId: string, revision: number, actualOperations: number, actualBytes: number, now: number): boolean {
    this.#assertLive()
    const id = identifier('entryId', entryId)
    integer('revision', revision); integer('actualOperations', actualOperations, 1); integer('actualBytes', actualBytes, 1); finite('now', now)
    this.expire(now)
    const entry = this.#entries.get(id)
    if (!entry || entry.phase !== 'staged' || entry.revision !== revision || this.#revisions.get(entry.layerId) !== revision) return false
    if (actualOperations > this.#budget.maxOperationsPerEntry || actualBytes > this.#budget.maxBytesPerEntry) { this.#entries.delete(id); return false }
    this.#evictFor(entry, actualOperations, actualBytes)
    if (this.#residentOperationsExcluding(id) + actualOperations > this.#budget.maxResidentOperations || this.#residentBytesExcluding(id) + actualBytes > this.#budget.maxResidentBytes) { this.#entries.delete(id); return false }
    entry.phase = 'committed'; entry.operationCount = actualOperations; entry.bytes = actualBytes; entry.touchedAt = now; entry.expiresAt = now + this.#budget.historyTtlMs
    this.#dropRedoTail(entry.layerId, entry.sequence)
    return true
  }

  undo(layerId: string, revision: number, now: number): EditHistoryView | null {
    this.#assertLive(); const layer = identifier('layerId', layerId); integer('revision', revision); finite('now', now); this.expire(now)
    if (this.#revisions.get(layer) !== revision) return null
    let candidate: Entry | undefined
    for (const entry of this.#entries.values()) if (entry.layerId === layer && entry.revision === revision && entry.phase === 'committed' && (!candidate || entry.sequence > candidate.sequence)) candidate = entry
    if (!candidate) return null
    candidate.phase = 'undone'; candidate.touchedAt = now; candidate.expiresAt = now + this.#budget.historyTtlMs
    return this.#view(candidate)
  }

  redo(layerId: string, revision: number, now: number): EditHistoryView | null {
    this.#assertLive(); const layer = identifier('layerId', layerId); integer('revision', revision); finite('now', now); this.expire(now)
    if (this.#revisions.get(layer) !== revision) return null
    let candidate: Entry | undefined
    for (const entry of this.#entries.values()) if (entry.layerId === layer && entry.revision === revision && entry.phase === 'undone' && (!candidate || entry.sequence < candidate.sequence)) candidate = entry
    if (!candidate) return null
    candidate.phase = 'committed'; candidate.touchedAt = now; candidate.expiresAt = now + this.#budget.historyTtlMs
    return this.#view(candidate)
  }

  touch(entryId: string, now: number): boolean {
    this.#assertLive(); const entry = this.#entries.get(identifier('entryId', entryId)); finite('now', now)
    if (!entry || entry.phase === 'staged') return false
    entry.touchedAt = now; entry.expiresAt = now + this.#budget.historyTtlMs; return true
  }

  cancel(entryId: string): boolean { this.#assertLive(); return this.#entries.delete(identifier('entryId', entryId)) }

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

  snapshot(): Readonly<{ layers: number; entries: number; staged: number; committed: number; undone: number; residentOperations: number; residentBytes: number }> {
    this.#assertLive()
    return Object.freeze({ layers: this.#revisions.size, entries: this.#entries.size, staged: this.#countPhase('staged'), committed: this.#countPhase('committed'), undone: this.#countPhase('undone'), residentOperations: this.#residentOperationsExcluding(''), residentBytes: this.#residentBytesExcluding('') })
  }

  fingerprint(): string {
    this.#assertLive()
    return [...this.#entries.values()].sort((a,b) => a.layerId.localeCompare(b.layerId) || a.sequence - b.sequence).map(entry => `${entry.layerId}:${entry.entryId}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.operationCount}:${entry.bytes}`).join('|')
  }

  dispose(): void { if (this.#disposed) return; this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }

  #dropRedoTail(layerId: string, committedSequence: number): void {
    for (const [id, entry] of this.#entries) if (entry.layerId === layerId && entry.phase === 'undone' && entry.sequence < committedSequence) this.#entries.delete(id)
  }

  #evictFor(incoming: Entry, operations: number, bytes: number): void {
    while (this.#residentOperationsExcluding(incoming.entryId) + operations > this.#budget.maxResidentOperations || this.#residentBytesExcluding(incoming.entryId) + bytes > this.#budget.maxResidentBytes) {
      let victim: Entry | undefined
      for (const entry of this.#entries.values()) {
        if (entry.entryId === incoming.entryId || entry.phase === 'staged') continue
        if (!victim || intentRank[entry.intent] < intentRank[victim.intent] || (intentRank[entry.intent] === intentRank[victim.intent] && (entry.touchedAt < victim.touchedAt || (entry.touchedAt === victim.touchedAt && entry.sequence < victim.sequence)))) victim = entry
      }
      if (!victim || intentRank[victim.intent] > intentRank[incoming.intent]) return
      this.#entries.delete(victim.entryId)
    }
  }

  #countLayer(layerId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.layerId === layerId) count++; return count }
  #countPhase(phase: EditHistoryPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count++; return count }
  #residentOperationsExcluding(excluded: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.entryId !== excluded && entry.phase !== 'staged') count += entry.operationCount; return count }
  #residentBytesExcluding(excluded: string): number { let bytes = 0; for (const entry of this.#entries.values()) if (entry.entryId !== excluded && entry.phase !== 'staged') bytes += entry.bytes; return bytes }
  #view(entry: Entry): EditHistoryView { return Object.freeze({ entryId: entry.entryId, layerId: entry.layerId, revision: entry.revision, intent: entry.intent, phase: entry.phase, operationCount: entry.operationCount, bytes: entry.bytes, sequence: entry.sequence, touchedAt: entry.touchedAt, expiresAt: entry.expiresAt }) }
  #assertLive(): void { if (this.#disposed) throw new Error('edit history lifecycle policy is disposed') }
}
