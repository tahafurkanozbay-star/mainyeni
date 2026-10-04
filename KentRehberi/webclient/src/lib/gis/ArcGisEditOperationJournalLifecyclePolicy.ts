export type EditJournalIntent = 'interactive' | 'visible' | 'background'
export type EditJournalPhase = 'staged' | 'committed' | 'acknowledged'

export interface EditJournalBudget {
  maxLayers: number
  maxEntries: number
  maxEntriesPerLayer: number
  maxOperations: number
  maxBytes: number
  stagedTtlMs: number
  committedTtlMs: number
}

export interface EditJournalEntryRequest {
  entryId: string
  layerId: string
  revision: number
  intent: EditJournalIntent
  operationCount: number
  estimatedBytes: number
  createdAt: number
}

export interface EditJournalEntryView extends EditJournalEntryRequest {
  readonly phase: EditJournalPhase
  readonly sequence: number
  readonly touchedAt: number
  readonly expiresAt: number
  readonly actualBytes: number | null
}

interface Entry extends EditJournalEntryRequest {
  phase: EditJournalPhase
  sequence: number
  touchedAt: number
  expiresAt: number
  actualBytes: number | null
}

const intents: readonly EditJournalIntent[] = ['interactive', 'visible', 'background']
const intentRank: Readonly<Record<EditJournalIntent, number>> = Object.freeze({ interactive: 2, visible: 1, background: 0 })

function id(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 192 || /[\u0000-\u001f]/.test(normalized)) throw new Error(`${name} must contain 1..192 safe characters`)
  return normalized
}
function integer(name: string, value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}`)
}
function time(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

/**
 * Bounded, payload-free authority for edit operation journal metadata.
 * Geometry, Graphic, attributes, request bodies, credentials and inverse edit payloads
 * remain caller-owned. The journal stores only scalar scheduling/accounting metadata.
 */
export class ArcGisEditOperationJournalLifecyclePolicy {
  readonly #budget: Readonly<EditJournalBudget>
  readonly #entries = new Map<string, Entry>()
  readonly #revisions = new Map<string, number>()
  #sequence = 0
  #disposed = false

  constructor(budget: EditJournalBudget) {
    for (const key of ['maxLayers', 'maxEntries', 'maxEntriesPerLayer', 'maxOperations', 'maxBytes'] as const) integer(key, budget[key], 1)
    time('stagedTtlMs', budget.stagedTtlMs)
    time('committedTtlMs', budget.committedTtlMs)
    if (budget.maxEntriesPerLayer > budget.maxEntries) throw new Error('maxEntriesPerLayer cannot exceed maxEntries')
    this.#budget = Object.freeze({ ...budget })
  }

  setRevision(layerId: string, nextRevision: number): number {
    this.#assertLive()
    const layer = id('layerId', layerId)
    integer('revision', nextRevision)
    const current = this.#revisions.get(layer)
    if (current !== undefined && nextRevision < current) return -1
    if (current === undefined && this.#revisions.size >= this.#budget.maxLayers) return -1
    this.#revisions.set(layer, nextRevision)
    if (current === undefined || current === nextRevision) return 0
    let removed = 0
    for (const [entryId, entry] of this.#entries) if (entry.layerId === layer && entry.revision !== nextRevision) { this.#entries.delete(entryId); removed++ }
    return removed
  }

  stage(request: EditJournalEntryRequest): boolean {
    this.#assertLive()
    const entryId = id('entryId', request.entryId)
    const layerId = id('layerId', request.layerId)
    integer('revision', request.revision)
    integer('operationCount', request.operationCount, 1)
    integer('estimatedBytes', request.estimatedBytes, 1)
    time('createdAt', request.createdAt)
    if (!intents.includes(request.intent)) throw new Error('intent is invalid')
    if (this.#revisions.get(layerId) !== request.revision || this.#entries.has(entryId)) return false
    if (this.#entries.size >= this.#budget.maxEntries || this.#countLayer(layerId) >= this.#budget.maxEntriesPerLayer) return false
    if (this.#operations() + request.operationCount > this.#budget.maxOperations || this.#bytes() + request.estimatedBytes > this.#budget.maxBytes) return false
    const sequence = ++this.#sequence
    this.#entries.set(entryId, { ...request, entryId, layerId, phase: 'staged', sequence, touchedAt: request.createdAt, expiresAt: request.createdAt + this.#budget.stagedTtlMs, actualBytes: null })
    return true
  }

  commit(entryId: string, revisionValue: number, actualBytes: number, now: number): boolean {
    this.#assertLive()
    const entry = this.#entries.get(id('entryId', entryId))
    integer('revision', revisionValue)
    integer('actualBytes', actualBytes, 1)
    time('now', now)
    this.expire(now)
    if (!entry || entry.phase !== 'staged' || entry.revision !== revisionValue || this.#revisions.get(entry.layerId) !== revisionValue) return false
    const projected = this.#bytes() - entry.estimatedBytes + actualBytes
    if (projected > this.#budget.maxBytes) return false
    entry.phase = 'committed'
    entry.actualBytes = actualBytes
    entry.touchedAt = now
    entry.expiresAt = now + this.#budget.committedTtlMs
    return true
  }

  acknowledge(entryId: string, revisionValue: number, now: number): boolean {
    this.#assertLive()
    const entry = this.#entries.get(id('entryId', entryId))
    integer('revision', revisionValue)
    time('now', now)
    this.expire(now)
    if (!entry || entry.phase !== 'committed' || entry.revision !== revisionValue || this.#revisions.get(entry.layerId) !== revisionValue) return false
    entry.phase = 'acknowledged'
    entry.touchedAt = now
    entry.expiresAt = now + this.#budget.committedTtlMs
    return true
  }

  next(phase: EditJournalPhase, now: number): EditJournalEntryView | null {
    this.#assertLive()
    if (!['staged', 'committed', 'acknowledged'].includes(phase)) throw new Error('phase is invalid')
    time('now', now)
    this.expire(now)
    let candidate: Entry | undefined
    for (const entry of this.#entries.values()) {
      if (entry.phase !== phase) continue
      if (!candidate || intentRank[entry.intent] > intentRank[candidate.intent] || (intentRank[entry.intent] === intentRank[candidate.intent] && (entry.createdAt < candidate.createdAt || (entry.createdAt === candidate.createdAt && entry.sequence < candidate.sequence)))) candidate = entry
    }
    return candidate ? this.#view(candidate) : null
  }

  touch(entryId: string, revisionValue: number, now: number): boolean {
    this.#assertLive()
    const entry = this.#entries.get(id('entryId', entryId))
    integer('revision', revisionValue)
    time('now', now)
    this.expire(now)
    if (!entry || entry.revision !== revisionValue || this.#revisions.get(entry.layerId) !== revisionValue) return false
    entry.touchedAt = now
    entry.expiresAt = now + (entry.phase === 'staged' ? this.#budget.stagedTtlMs : this.#budget.committedTtlMs)
    return true
  }

  consume(entryId: string, revisionValue: number): EditJournalEntryView | null {
    this.#assertLive()
    const key = id('entryId', entryId)
    integer('revision', revisionValue)
    const entry = this.#entries.get(key)
    if (!entry || entry.phase !== 'acknowledged' || entry.revision !== revisionValue || this.#revisions.get(entry.layerId) !== revisionValue) return null
    this.#entries.delete(key)
    return this.#view(entry)
  }

  cancel(entryId: string): boolean { this.#assertLive(); return this.#entries.delete(id('entryId', entryId)) }

  releaseLayer(layerId: string): number {
    this.#assertLive()
    const layer = id('layerId', layerId)
    let removed = 0
    for (const [entryId, entry] of this.#entries) if (entry.layerId === layer) { this.#entries.delete(entryId); removed++ }
    this.#revisions.delete(layer)
    return removed
  }

  expire(now: number): number {
    this.#assertLive()
    time('now', now)
    let removed = 0
    for (const [entryId, entry] of this.#entries) if (entry.expiresAt <= now) { this.#entries.delete(entryId); removed++ }
    return removed
  }

  snapshot(): Readonly<{ layers: number; entries: number; staged: number; committed: number; acknowledged: number; operations: number; bytes: number }> {
    this.#assertLive()
    return Object.freeze({ layers: this.#revisions.size, entries: this.#entries.size, staged: this.#countPhase('staged'), committed: this.#countPhase('committed'), acknowledged: this.#countPhase('acknowledged'), operations: this.#operations(), bytes: this.#bytes() })
  }

  fingerprint(): string {
    this.#assertLive()
    return [...this.#entries.values()].sort((a, b) => a.layerId.localeCompare(b.layerId) || a.sequence - b.sequence).map(entry => `${entry.layerId}:${entry.entryId}:${entry.revision}:${entry.intent}:${entry.phase}:${entry.operationCount}:${entry.actualBytes ?? entry.estimatedBytes}`).join('|')
  }

  dispose(): void { if (this.#disposed) return; this.#entries.clear(); this.#revisions.clear(); this.#disposed = true }

  #countLayer(layerId: string): number { let count = 0; for (const entry of this.#entries.values()) if (entry.layerId === layerId) count++; return count }
  #countPhase(phase: EditJournalPhase): number { let count = 0; for (const entry of this.#entries.values()) if (entry.phase === phase) count++; return count }
  #operations(): number { let total = 0; for (const entry of this.#entries.values()) total += entry.operationCount; return total }
  #bytes(): number { let total = 0; for (const entry of this.#entries.values()) total += entry.actualBytes ?? entry.estimatedBytes; return total }
  #view(entry: Entry): EditJournalEntryView { return Object.freeze({ entryId: entry.entryId, layerId: entry.layerId, revision: entry.revision, intent: entry.intent, operationCount: entry.operationCount, estimatedBytes: entry.estimatedBytes, createdAt: entry.createdAt, phase: entry.phase, sequence: entry.sequence, touchedAt: entry.touchedAt, expiresAt: entry.expiresAt, actualBytes: entry.actualBytes }) }
  #assertLive(): void { if (this.#disposed) throw new Error('edit operation journal lifecycle policy is disposed') }
}
