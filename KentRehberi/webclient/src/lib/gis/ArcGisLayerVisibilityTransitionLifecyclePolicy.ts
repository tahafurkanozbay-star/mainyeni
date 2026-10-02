export type ArcGisVisibilityIntent =
  | 'user'
  | 'scale'
  | 'restore'

export type ArcGisVisibilityPhase =
  | 'queued'
  | 'applying'
  | 'settled'

export interface ArcGisVisibilityTransitionBudget {
  maxTransitions: number
  maxTransitionsPerView: number
  maxApplying: number
  maxSettled: number
  maxLayerCountPerTransition: number
  maxEstimatedBytesPerTransition: number
  maxAggregateSettledBytes: number
  queueTtlMs: number
  applyLeaseMs: number
  settledTtlMs: number
}

export interface ArcGisVisibilityTransitionRequest {
  viewId: string
  transitionId: string
  revision: number
  intent: ArcGisVisibilityIntent
  requestedAt: number
  layerCount: number
  estimatedBytes: number
  targetScale: number
}

export interface ArcGisVisibilityTransitionEntry
  extends ArcGisVisibilityTransitionRequest {
  phase: ArcGisVisibilityPhase
  sequence: number
  expiresAt: number
  actualBytes?: number
  appliedLayerCount?: number
}

const intentRank: Record<ArcGisVisibilityIntent, number> = {
  user: 0,
  scale: 1,
  restore: 2,
}

const safeId = /^[A-Za-z0-9_.:@/-]{1,180}$/

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function nonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export class ArcGisLayerVisibilityTransitionLifecyclePolicy {
  private readonly entries = new Map<string, ArcGisVisibilityTransitionEntry>()
  private readonly revisions = new Map<string, number>()
  private sequence = 0

  constructor(private readonly budget: ArcGisVisibilityTransitionBudget) {
    const values = [
      budget.maxTransitions,
      budget.maxTransitionsPerView,
      budget.maxApplying,
      budget.maxSettled,
      budget.maxLayerCountPerTransition,
      budget.maxEstimatedBytesPerTransition,
      budget.maxAggregateSettledBytes,
      budget.queueTtlMs,
      budget.applyLeaseMs,
      budget.settledTtlMs,
    ]
    if (!values.every(positive)) {
      throw new RangeError('visibility budgets must be positive safe integers')
    }
    if (
      budget.maxTransitionsPerView > budget.maxTransitions ||
      budget.maxApplying > budget.maxTransitions ||
      budget.maxSettled > budget.maxTransitions
    ) {
      throw new RangeError('visibility sub-budget exceeds aggregate')
    }
  }

  enqueue(raw: ArcGisVisibilityTransitionRequest): boolean {
    const request = this.normalize(raw)
    if (!request) return false

    const watermark = this.revisions.get(request.viewId) ?? 0
    if (request.revision < watermark) return false

    const key = this.key(request.viewId, request.transitionId)
    const existing = this.entries.get(key)
    if (existing && request.revision <= existing.revision) return false

    const otherForView = [...this.entries.values()].filter(
      entry =>
        entry.viewId === request.viewId &&
        this.key(entry.viewId, entry.transitionId) !== key,
    ).length
    if (otherForView >= this.budget.maxTransitionsPerView) return false
    if (!existing && this.entries.size >= this.budget.maxTransitions) return false

    if (existing) this.entries.delete(key)
    this.revisions.set(request.viewId, Math.max(watermark, request.revision))
    this.entries.set(key, {
      ...request,
      phase: 'queued',
      sequence: ++this.sequence,
      expiresAt: request.requestedAt + this.budget.queueTtlMs,
    })
    return true
  }

  takeNext(now: number): ArcGisVisibilityTransitionEntry | undefined {
    if (!Number.isFinite(now)) return undefined
    this.expire(now)

    const applying = [...this.entries.values()].filter(
      entry => entry.phase === 'applying',
    ).length
    if (applying >= this.budget.maxApplying) return undefined

    const next = [...this.entries.values()]
      .filter(entry => entry.phase === 'queued')
      .sort(
        (a, b) =>
          intentRank[a.intent] - intentRank[b.intent] ||
          a.requestedAt - b.requestedAt ||
          a.sequence - b.sequence,
      )[0]
    if (!next) return undefined

    next.phase = 'applying'
    next.expiresAt = now + this.budget.applyLeaseMs
    return { ...next }
  }

  complete(
    viewId: string,
    transitionId: string,
    revision: number,
    appliedLayerCount: number,
    actualBytes: number,
    now: number,
  ): boolean {
    const entry = this.get(viewId, transitionId)
    if (!entry || entry.phase !== 'applying' || entry.revision !== revision) {
      return false
    }
    if (
      !nonNegative(appliedLayerCount) ||
      !nonNegative(actualBytes) ||
      !Number.isFinite(now)
    ) {
      return false
    }

    const key = this.key(entry.viewId, entry.transitionId)
    if (
      now >= entry.expiresAt ||
      revision < (this.revisions.get(entry.viewId) ?? 0)
    ) {
      this.entries.delete(key)
      return false
    }
    if (
      appliedLayerCount > entry.layerCount ||
      actualBytes > this.budget.maxEstimatedBytesPerTransition
    ) {
      this.entries.delete(key)
      return false
    }

    const settled = [...this.entries.values()].filter(
      candidate => candidate.phase === 'settled',
    )
    const residentBytes = settled.reduce(
      (sum, candidate) => sum + (candidate.actualBytes ?? 0),
      0,
    )
    if (
      settled.length >= this.budget.maxSettled ||
      residentBytes + actualBytes > this.budget.maxAggregateSettledBytes
    ) {
      this.entries.delete(key)
      return false
    }

    entry.phase = 'settled'
    entry.appliedLayerCount = appliedLayerCount
    entry.actualBytes = actualBytes
    entry.expiresAt = now + this.budget.settledTtlMs
    return true
  }

  touch(
    viewId: string,
    transitionId: string,
    revision: number,
    now: number,
  ): boolean {
    const entry = this.get(viewId, transitionId)
    if (
      !entry ||
      entry.phase !== 'settled' ||
      entry.revision !== revision ||
      !Number.isFinite(now) ||
      now >= entry.expiresAt
    ) {
      return false
    }
    entry.expiresAt = now + this.budget.settledTtlMs
    return true
  }

  consume(viewId: string, transitionId: string, revision: number): boolean {
    const entry = this.get(viewId, transitionId)
    return !!entry &&
      entry.phase === 'settled' &&
      entry.revision === revision &&
      this.entries.delete(this.key(entry.viewId, entry.transitionId))
  }

  cancel(viewId: string, transitionId: string, revision: number): boolean {
    const entry = this.get(viewId, transitionId)
    return !!entry &&
      entry.revision === revision &&
      this.entries.delete(this.key(entry.viewId, entry.transitionId))
  }

  invalidateView(viewId: string, revision: number): number {
    const normalized = viewId.trim()
    if (
      !safeId.test(normalized) ||
      !positive(revision) ||
      revision <= (this.revisions.get(normalized) ?? 0)
    ) {
      return 0
    }

    this.revisions.set(normalized, revision)
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (entry.viewId === normalized && entry.revision < revision) {
        this.entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  expire(now: number): number {
    if (!Number.isFinite(now)) return 0
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  releaseView(viewId: string): number {
    const normalized = viewId.trim()
    if (!safeId.test(normalized)) return 0
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (entry.viewId === normalized) {
        this.entries.delete(key)
        removed += 1
      }
    }
    this.revisions.delete(normalized)
    return removed
  }

  snapshot(): ArcGisVisibilityTransitionEntry[] {
    return [...this.entries.values()].map(entry => ({ ...entry }))
  }

  fingerprint(): string {
    return this.snapshot()
      .sort((a, b) => a.sequence - b.sequence)
      .map(
        entry =>
          `${entry.viewId}:${entry.transitionId}:${entry.revision}:` +
          `${entry.phase}:${entry.intent}:${entry.layerCount}:` +
          `${entry.appliedLayerCount ?? 0}:${entry.actualBytes ?? 0}`,
      )
      .join('|')
  }

  dispose(): void {
    this.entries.clear()
    this.revisions.clear()
    this.sequence = 0
  }

  private key(viewId: string, transitionId: string): string {
    return `${viewId}|${transitionId}`
  }

  private get(
    viewId: string,
    transitionId: string,
  ): ArcGisVisibilityTransitionEntry | undefined {
    const view = viewId.trim()
    const transition = transitionId.trim()
    if (!safeId.test(view) || !safeId.test(transition)) return undefined
    return this.entries.get(this.key(view, transition))
  }

  private normalize(
    raw: ArcGisVisibilityTransitionRequest,
  ): ArcGisVisibilityTransitionRequest | undefined {
    const viewId = raw.viewId.trim()
    const transitionId = raw.transitionId.trim()
    if (!safeId.test(viewId) || !safeId.test(transitionId)) return undefined
    if (!positive(raw.revision)) return undefined
    if (!Number.isFinite(raw.requestedAt)) return undefined
    if (!nonNegative(raw.layerCount)) return undefined
    if (raw.layerCount > this.budget.maxLayerCountPerTransition) return undefined
    if (!nonNegative(raw.estimatedBytes)) return undefined
    if (raw.estimatedBytes > this.budget.maxEstimatedBytesPerTransition) return undefined
    if (!Number.isFinite(raw.targetScale) || raw.targetScale <= 0) return undefined
    if (!(raw.intent in intentRank)) return undefined
    return { ...raw, viewId, transitionId }
  }
}