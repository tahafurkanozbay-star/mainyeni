export type ArcGisCameraTransitionIntent = 'user' | 'selection' | 'restore'
export type ArcGisCameraTransitionPhase = 'queued' | 'running' | 'settled'

export interface ArcGisCameraTransitionBudget {
  maxTransitions: number
  maxTransitionsPerView: number
  maxRunning: number
  maxSettled: number
  maxWaypointsPerTransition: number
  maxEstimatedBytesPerTransition: number
  maxAggregateSettledBytes: number
  queueTtlMs: number
  runLeaseMs: number
  settledTtlMs: number
}

export interface ArcGisCameraTransitionRequest {
  viewId: string
  transitionId: string
  revision: number
  intent: ArcGisCameraTransitionIntent
  requestedAt: number
  waypointCount: number
  estimatedBytes: number
  targetScale: number
}

export interface ArcGisCameraTransitionSnapshot extends ArcGisCameraTransitionRequest {
  phase: ArcGisCameraTransitionPhase
  sequence: number
  startedAt?: number
  expiresAt: number
  actualBytes?: number
}

type Entry = ArcGisCameraTransitionSnapshot

const intentRank: Record<ArcGisCameraTransitionIntent, number> = { user: 0, selection: 1, restore: 2 }
const safeInteger = (value: number, min = 0) => Number.isSafeInteger(value) && value >= min
const finite = (value: number, min = 0) => Number.isFinite(value) && value >= min

function identifier(value: string): string | undefined {
  const normalized = value.trim()
  if (!normalized || normalized.length > 160 || /[|\u0000-\u001f\u007f]/u.test(normalized)) return undefined
  return normalized
}

const key = (viewId: string, transitionId: string) => `${viewId}|${transitionId}`

/**
 * Scalar-only ownership policy for 2D/3D ArcGIS camera transitions.
 * Camera/Viewpoint/Geometry/AbortController objects remain caller-owned so a
 * cancelled navigation cannot retain SDK graphs after a view is destroyed.
 */
export class ArcGisCameraTransitionLifecyclePolicy {
  private readonly entries = new Map<string, Entry>()
  private readonly viewRevisions = new Map<string, number>()
  private sequence = 0

  constructor(private readonly budget: ArcGisCameraTransitionBudget) { this.validateBudget(budget) }

  enqueue(request: ArcGisCameraTransitionRequest): boolean {
    const normalized = this.normalize(request)
    if (!normalized) return false
    const watermark = this.viewRevisions.get(normalized.viewId) ?? 0
    if (normalized.revision < watermark) return false
    if (normalized.revision > watermark) this.invalidateView(normalized.viewId, normalized.revision)
    const entryKey = key(normalized.viewId, normalized.transitionId)
    const previous = this.entries.get(entryKey)
    if (previous && previous.revision >= normalized.revision) return false
    if (previous) this.entries.delete(entryKey)
    if (this.entries.size >= this.budget.maxTransitions) return false
    if (this.count(entry => entry.viewId === normalized.viewId) >= this.budget.maxTransitionsPerView) return false
    this.entries.set(entryKey, { ...normalized, phase: 'queued', sequence: ++this.sequence, expiresAt: normalized.requestedAt + this.budget.queueTtlMs })
    return true
  }

  takeNext(now: number): ArcGisCameraTransitionSnapshot | undefined {
    if (!finite(now)) return undefined
    this.expire(now)
    if (this.count(entry => entry.phase === 'running') >= this.budget.maxRunning) return undefined
    const queued = [...this.entries.values()].filter(entry => entry.phase === 'queued')
    queued.sort((a, b) => intentRank[a.intent] - intentRank[b.intent] || a.requestedAt - b.requestedAt || a.sequence - b.sequence)
    const next = queued[0]
    if (!next) return undefined
    next.phase = 'running'
    next.startedAt = now
    next.expiresAt = now + this.budget.runLeaseMs
    return this.detach(next)
  }

  complete(viewId: string, transitionId: string, revision: number, actualBytes: number, now: number): boolean {
    const view = identifier(viewId), transition = identifier(transitionId)
    if (!view || !transition || !safeInteger(revision, 1) || !safeInteger(actualBytes) || !finite(now)) return false
    const entryKey = key(view, transition)
    const entry = this.entries.get(entryKey)
    if (!entry || entry.phase !== 'running' || entry.revision !== revision) return false
    if (now >= entry.expiresAt || revision !== (this.viewRevisions.get(view) ?? revision)) { this.entries.delete(entryKey); return false }
    if (actualBytes > this.budget.maxEstimatedBytesPerTransition || this.count(item => item.phase === 'settled') >= this.budget.maxSettled || this.settledBytes() + actualBytes > this.budget.maxAggregateSettledBytes) {
      this.entries.delete(entryKey)
      return false
    }
    entry.phase = 'settled'
    entry.actualBytes = actualBytes
    entry.expiresAt = now + this.budget.settledTtlMs
    return true
  }

  touch(viewId: string, transitionId: string, revision: number, now: number): boolean {
    const entry = this.lookup(viewId, transitionId)
    if (!entry || entry.phase !== 'settled' || entry.revision !== revision || !finite(now) || now >= entry.expiresAt) return false
    entry.expiresAt = now + this.budget.settledTtlMs
    return true
  }

  consume(viewId: string, transitionId: string, revision: number): boolean {
    const entry = this.lookup(viewId, transitionId)
    if (!entry || entry.phase !== 'settled' || entry.revision !== revision) return false
    return this.entries.delete(key(entry.viewId, entry.transitionId))
  }

  cancel(viewId: string, transitionId: string, revision: number): boolean {
    const entry = this.lookup(viewId, transitionId)
    if (!entry || entry.revision !== revision) return false
    return this.entries.delete(key(entry.viewId, entry.transitionId))
  }

  invalidateView(viewId: string, revision: number): number {
    const view = identifier(viewId)
    if (!view || !safeInteger(revision, 1)) return 0
    const previous = this.viewRevisions.get(view) ?? 0
    if (revision < previous) return 0
    this.viewRevisions.set(view, revision)
    return this.release(entry => entry.viewId === view && entry.revision < revision)
  }

  expire(now: number): number {
    if (!finite(now)) return 0
    return this.release(entry => now >= entry.expiresAt)
  }

  releaseView(viewId: string): number {
    const view = identifier(viewId)
    if (!view) return 0
    this.viewRevisions.delete(view)
    return this.release(entry => entry.viewId === view)
  }

  snapshot(): ArcGisCameraTransitionSnapshot[] {
    return [...this.entries.values()].sort((a, b) => a.sequence - b.sequence).map(entry => this.detach(entry))
  }

  fingerprint(): string {
    return this.snapshot().map(entry => [entry.viewId, entry.transitionId, entry.revision, entry.phase, entry.intent, entry.waypointCount, entry.estimatedBytes, entry.targetScale, entry.actualBytes ?? 0].join(':')).join('|')
  }

  private lookup(viewId: string, transitionId: string): Entry | undefined {
    const view = identifier(viewId), transition = identifier(transitionId)
    return view && transition ? this.entries.get(key(view, transition)) : undefined
  }

  private normalize(request: ArcGisCameraTransitionRequest): ArcGisCameraTransitionRequest | undefined {
    const viewId = identifier(request.viewId), transitionId = identifier(request.transitionId)
    if (!viewId || !transitionId || !safeInteger(request.revision, 1) || !finite(request.requestedAt) || !safeInteger(request.waypointCount, 1) || !safeInteger(request.estimatedBytes) || !finite(request.targetScale, 1)) return undefined
    if (!(request.intent in intentRank) || request.waypointCount > this.budget.maxWaypointsPerTransition || request.estimatedBytes > this.budget.maxEstimatedBytesPerTransition) return undefined
    return { ...request, viewId, transitionId }
  }

  private validateBudget(budget: ArcGisCameraTransitionBudget): void {
    const values = [budget.maxTransitions, budget.maxTransitionsPerView, budget.maxRunning, budget.maxSettled, budget.maxWaypointsPerTransition, budget.maxEstimatedBytesPerTransition, budget.maxAggregateSettledBytes, budget.queueTtlMs, budget.runLeaseMs, budget.settledTtlMs]
    if (values.some(value => !safeInteger(value, 1))) throw new RangeError('ArcGIS camera transition budget values must be positive safe integers')
    if (budget.maxTransitionsPerView > budget.maxTransitions || budget.maxRunning > budget.maxTransitions || budget.maxSettled > budget.maxTransitions) throw new RangeError('ArcGIS camera transition cardinality budget is inconsistent')
  }

  private count(predicate: (entry: Entry) => boolean): number { let total = 0; for (const entry of this.entries.values()) if (predicate(entry)) total++; return total }
  private settledBytes(): number { let total = 0; for (const entry of this.entries.values()) if (entry.phase === 'settled') total += entry.actualBytes ?? 0; return total }
  private release(predicate: (entry: Entry) => boolean): number { let removed = 0; for (const [entryKey, entry] of this.entries) if (predicate(entry)) { this.entries.delete(entryKey); removed++ } return removed }
  private detach(entry: Entry): ArcGisCameraTransitionSnapshot { return { ...entry } }
}
