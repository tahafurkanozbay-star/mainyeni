export type ArcGisQueryPriority = 'interactive' | 'foreground' | 'background'

export interface ArcGisQuerySchedulerBudget {
  readonly maxQueued: number
  readonly maxRunning: number
  readonly maxPerLayerRunning: number
  readonly maxEstimatedResponseBytes: number
  readonly maxAggregateRunningBytes: number
  readonly maxWaitMs: number
  readonly maxRunMs: number
  readonly maxLayerIdLength: number
  readonly maxRequestIdLength: number
}

export interface ArcGisQueryAdmission {
  readonly requestId: string
  readonly layerId: string
  readonly revision: number
  readonly priority: ArcGisQueryPriority
  readonly estimatedResponseBytes: number
  readonly enqueuedAtMs: number
  readonly deadlineAtMs: number
}

export interface ArcGisQueryLease extends ArcGisQueryAdmission {
  readonly startedAtMs: number
  readonly expiresAtMs: number
}

export interface ArcGisQuerySchedulerSnapshot {
  readonly queued: readonly ArcGisQueryAdmission[]
  readonly running: readonly ArcGisQueryLease[]
  readonly runningBytes: number
}

const PRIORITY: Readonly<Record<ArcGisQueryPriority, number>> = Object.freeze({ interactive: 0, foreground: 1, background: 2 })

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

function text(value: string, name: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`invalid-${name}`)
  return normalized
}

function priority(value: ArcGisQueryPriority): ArcGisQueryPriority {
  if (value !== 'interactive' && value !== 'foreground' && value !== 'background') throw new Error('invalid-query-priority')
  return value
}

/**
 * Transport-independent admission authority for ArcGIS query work.
 *
 * The scheduler deliberately owns no fetch, AbortController, SDK Query or payload
 * object. It only governs bounded metadata, so transport cancellation and SDK
 * lifecycle remain with their existing authorities while query concurrency stays
 * deterministic and auditable.
 */
export class ArcGisQuerySchedulerPolicy {
  private readonly budget: Readonly<ArcGisQuerySchedulerBudget>
  private readonly queued = new Map<string, ArcGisQueryAdmission>()
  private readonly running = new Map<string, ArcGisQueryLease>()
  private runningBytes = 0
  private disposed = false

  constructor(budget: ArcGisQuerySchedulerBudget) {
    this.budget = Object.freeze({
      maxQueued: integer(budget.maxQueued, 'maxQueued', 1, 100_000),
      maxRunning: integer(budget.maxRunning, 'maxRunning', 1, 10_000),
      maxPerLayerRunning: integer(budget.maxPerLayerRunning, 'maxPerLayerRunning', 1, 10_000),
      maxEstimatedResponseBytes: integer(budget.maxEstimatedResponseBytes, 'maxEstimatedResponseBytes', 1, 512 * 1024 * 1024),
      maxAggregateRunningBytes: integer(budget.maxAggregateRunningBytes, 'maxAggregateRunningBytes', 1, 2 * 1024 * 1024 * 1024),
      maxWaitMs: integer(budget.maxWaitMs, 'maxWaitMs', 1, 60 * 60 * 1000),
      maxRunMs: integer(budget.maxRunMs, 'maxRunMs', 1, 60 * 60 * 1000),
      maxLayerIdLength: integer(budget.maxLayerIdLength, 'maxLayerIdLength', 1, 512),
      maxRequestIdLength: integer(budget.maxRequestIdLength, 'maxRequestIdLength', 1, 512),
    })
    if (this.budget.maxPerLayerRunning > this.budget.maxRunning) throw new Error('maxPerLayerRunning must be <= maxRunning')
    if (this.budget.maxEstimatedResponseBytes > this.budget.maxAggregateRunningBytes) throw new Error('maxEstimatedResponseBytes must be <= maxAggregateRunningBytes')
  }

  enqueue(input: {
    readonly requestId: string
    readonly layerId: string
    readonly revision: number
    readonly priority: ArcGisQueryPriority
    readonly estimatedResponseBytes: number
    readonly nowMs: number
    readonly waitMs: number
  }): ArcGisQueryAdmission {
    this.assertLive()
    const requestId = text(input.requestId, 'request-id', this.budget.maxRequestIdLength)
    const layerId = text(input.layerId, 'layer-id', this.budget.maxLayerIdLength)
    const revision = integer(input.revision, 'revision', 0, Number.MAX_SAFE_INTEGER)
    const estimatedResponseBytes = integer(input.estimatedResponseBytes, 'estimatedResponseBytes', 0, this.budget.maxEstimatedResponseBytes)
    const nowMs = integer(input.nowMs, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    const waitMs = integer(input.waitMs, 'waitMs', 1, this.budget.maxWaitMs)
    if (nowMs > Number.MAX_SAFE_INTEGER - waitMs) throw new Error('query-deadline-overflow')
    if (this.queued.has(requestId) || this.running.has(requestId)) throw new Error('duplicate-query-request')
    if (this.queued.size >= this.budget.maxQueued) throw new Error('query-queue-budget-exceeded')
    const admission = Object.freeze({ requestId, layerId, revision, priority: priority(input.priority), estimatedResponseBytes, enqueuedAtMs: nowMs, deadlineAtMs: nowMs + waitMs })
    this.queued.set(requestId, admission)
    return admission
  }

  cancel(requestIdInput: string): boolean {
    this.assertLive()
    const requestId = text(requestIdInput, 'request-id', this.budget.maxRequestIdLength)
    return this.queued.delete(requestId)
  }

  startNext(nowMsInput: number): ArcGisQueryLease | undefined {
    this.assertLive()
    const nowMs = integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    this.pruneExpiredQueued(nowMs)
    this.expireRunning(nowMs)
    if (this.running.size >= this.budget.maxRunning) return undefined
    const candidates = [...this.queued.values()].sort((a, b) =>
      PRIORITY[a.priority] - PRIORITY[b.priority] ||
      a.deadlineAtMs - b.deadlineAtMs ||
      a.enqueuedAtMs - b.enqueuedAtMs ||
      a.requestId.localeCompare(b.requestId) ||
      a.layerId.localeCompare(b.layerId),
    )
    for (const candidate of candidates) {
      if (this.runningForLayer(candidate.layerId) >= this.budget.maxPerLayerRunning) continue
      if (this.runningBytes + candidate.estimatedResponseBytes > this.budget.maxAggregateRunningBytes) continue
      if (nowMs > Number.MAX_SAFE_INTEGER - this.budget.maxRunMs) throw new Error('query-lease-overflow')
      this.queued.delete(candidate.requestId)
      const lease = Object.freeze({ ...candidate, startedAtMs: nowMs, expiresAtMs: nowMs + this.budget.maxRunMs })
      this.running.set(lease.requestId, lease)
      this.runningBytes += lease.estimatedResponseBytes
      return lease
    }
    return undefined
  }

  complete(requestIdInput: string, revisionInput: number): boolean {
    this.assertLive()
    const requestId = text(requestIdInput, 'request-id', this.budget.maxRequestIdLength)
    const revision = integer(revisionInput, 'revision', 0, Number.MAX_SAFE_INTEGER)
    const lease = this.running.get(requestId)
    if (!lease) return false
    if (lease.revision !== revision) return false
    this.release(lease)
    return true
  }

  fail(requestIdInput: string): boolean {
    this.assertLive()
    const requestId = text(requestIdInput, 'request-id', this.budget.maxRequestIdLength)
    const lease = this.running.get(requestId)
    if (!lease) return false
    this.release(lease)
    return true
  }

  invalidateLayerRevision(layerIdInput: string, minimumRevisionInput: number): number {
    this.assertLive()
    const layerId = text(layerIdInput, 'layer-id', this.budget.maxLayerIdLength)
    const minimumRevision = integer(minimumRevisionInput, 'minimumRevision', 0, Number.MAX_SAFE_INTEGER)
    let removed = 0
    for (const admission of [...this.queued.values()]) {
      if (admission.layerId === layerId && admission.revision < minimumRevision && this.queued.delete(admission.requestId)) removed += 1
    }
    for (const lease of [...this.running.values()]) {
      if (lease.layerId === layerId && lease.revision < minimumRevision) {
        this.release(lease)
        removed += 1
      }
    }
    return removed
  }

  tick(nowMsInput: number): { readonly queuedExpired: number; readonly runningExpired: number } {
    this.assertLive()
    const nowMs = integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    return Object.freeze({ queuedExpired: this.pruneExpiredQueued(nowMs), runningExpired: this.expireRunning(nowMs) })
  }

  snapshot(): ArcGisQuerySchedulerSnapshot {
    this.assertLive()
    const queued = [...this.queued.values()].sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.deadlineAtMs - b.deadlineAtMs || a.requestId.localeCompare(b.requestId))
    const running = [...this.running.values()].sort((a, b) => a.startedAtMs - b.startedAtMs || a.requestId.localeCompare(b.requestId))
    return Object.freeze({ queued: Object.freeze(queued), running: Object.freeze(running), runningBytes: this.runningBytes })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.queued.clear()
    this.running.clear()
    this.runningBytes = 0
  }

  private runningForLayer(layerId: string): number {
    let count = 0
    for (const lease of this.running.values()) if (lease.layerId === layerId) count += 1
    return count
  }

  private pruneExpiredQueued(nowMs: number): number {
    let removed = 0
    for (const admission of [...this.queued.values()]) if (admission.deadlineAtMs <= nowMs && this.queued.delete(admission.requestId)) removed += 1
    return removed
  }

  private expireRunning(nowMs: number): number {
    let removed = 0
    for (const lease of [...this.running.values()]) if (lease.expiresAtMs <= nowMs) { this.release(lease); removed += 1 }
    return removed
  }

  private release(lease: ArcGisQueryLease): void {
    if (!this.running.delete(lease.requestId)) return
    this.runningBytes -= lease.estimatedResponseBytes
    if (this.runningBytes < 0) throw new Error('query-byte-accounting-invalid')
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('arcgis-query-scheduler-disposed')
  }
}
