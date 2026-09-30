export type ArcGisRefreshPriority = 'interactive' | 'foreground' | 'background'
export type ArcGisRefreshState = 'idle' | 'queued' | 'running' | 'cooldown' | 'disposed'

export interface ArcGisLayerRefreshBudget {
  maxLayers: number
  maxQueued: number
  maxRunning: number
  maxRunningPerGroup: number
  maxEstimatedBytesInFlight: number
  minRefreshIntervalMs: number
  maxQueueAgeMs: number
  maxRunLeaseMs: number
  maxBackoffMs: number
}

export interface ArcGisLayerRefreshRequest {
  layerId: string
  groupId: string
  revision: number
  priority: ArcGisRefreshPriority
  estimatedBytes: number
  requestedAt: number
  notBefore?: number
}

export interface ArcGisLayerRefreshLease {
  layerId: string
  groupId: string
  revision: number
  priority: ArcGisRefreshPriority
  estimatedBytes: number
  startedAt: number
  expiresAt: number
  token: string
}

export interface ArcGisLayerRefreshSnapshot {
  state: ArcGisRefreshState
  queued: number
  running: number
  estimatedBytesInFlight: number
  trackedLayers: number
  revisionWatermark: Readonly<Record<string, number>>
  fingerprint: string
}

interface QueueEntry extends ArcGisLayerRefreshRequest {
  sequence: number
}

interface RunningEntry extends ArcGisLayerRefreshLease {
  sequence: number
}

interface LayerState {
  revision: number
  lastCompletedAt: number | null
  failures: number
  cooldownUntil: number
}

const PRIORITY_WEIGHT: Readonly<Record<ArcGisRefreshPriority, number>> = Object.freeze({
  interactive: 0,
  foreground: 1,
  background: 2,
})

function assertInteger(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
}

function assertFinite(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be finite and >= ${minimum}`)
}

function assertId(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 160) throw new Error(`${name} must contain 1..160 characters`)
  return normalized
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export class ArcGisLayerRefreshPolicy {
  readonly #budget: Readonly<ArcGisLayerRefreshBudget>
  readonly #queue = new Map<string, QueueEntry>()
  readonly #running = new Map<string, RunningEntry>()
  readonly #layers = new Map<string, LayerState>()
  #sequence = 0
  #disposed = false

  constructor(budget: ArcGisLayerRefreshBudget) {
    assertInteger('maxLayers', budget.maxLayers, 1)
    assertInteger('maxQueued', budget.maxQueued, 1)
    assertInteger('maxRunning', budget.maxRunning, 1)
    assertInteger('maxRunningPerGroup', budget.maxRunningPerGroup, 1)
    assertFinite('maxEstimatedBytesInFlight', budget.maxEstimatedBytesInFlight, 1)
    assertFinite('minRefreshIntervalMs', budget.minRefreshIntervalMs, 0)
    assertFinite('maxQueueAgeMs', budget.maxQueueAgeMs, 1)
    assertFinite('maxRunLeaseMs', budget.maxRunLeaseMs, 1)
    assertFinite('maxBackoffMs', budget.maxBackoffMs, 0)
    if (budget.maxRunningPerGroup > budget.maxRunning) throw new Error('maxRunningPerGroup cannot exceed maxRunning')
    this.#budget = Object.freeze({ ...budget })
  }

  enqueue(request: ArcGisLayerRefreshRequest): boolean {
    this.#assertActive()
    const layerId = assertId('layerId', request.layerId)
    const groupId = assertId('groupId', request.groupId)
    assertInteger('revision', request.revision, 0)
    assertFinite('estimatedBytes', request.estimatedBytes, 1)
    assertFinite('requestedAt', request.requestedAt, 0)
    if (request.estimatedBytes > this.#budget.maxEstimatedBytesInFlight) return false
    const notBefore = request.notBefore ?? request.requestedAt
    assertFinite('notBefore', notBefore, request.requestedAt)

    const current = this.#layers.get(layerId)
    if (current && request.revision < current.revision) return false
    if (current && request.revision > current.revision && (this.#queue.has(layerId) || this.#running.has(layerId))) {
      this.cancel(layerId)
    }
    if (!current && this.#layers.size >= this.#budget.maxLayers) return false
    if (this.#running.has(layerId)) return false

    const existing = this.#queue.get(layerId)
    if (existing) {
      if (existing.revision > request.revision) return false
      if (existing.revision === request.revision && PRIORITY_WEIGHT[existing.priority] <= PRIORITY_WEIGHT[request.priority]) return false
      this.#queue.delete(layerId)
    }
    if (this.#queue.size >= this.#budget.maxQueued) return false

    const state = current ?? { revision: request.revision, lastCompletedAt: null, failures: 0, cooldownUntil: 0 }
    state.revision = request.revision
    this.#layers.set(layerId, state)
    this.#queue.set(layerId, {
      layerId,
      groupId,
      revision: request.revision,
      priority: request.priority,
      estimatedBytes: request.estimatedBytes,
      requestedAt: request.requestedAt,
      notBefore,
      sequence: this.#sequence++,
    })
    return true
  }

  startNext(now: number): ArcGisLayerRefreshLease | null {
    this.#assertActive()
    assertFinite('now', now, 0)
    this.expire(now)
    if (this.#running.size >= this.#budget.maxRunning) return null

    const candidates = [...this.#queue.values()]
      .filter(entry => this.#eligible(entry, now))
      .sort((left, right) => {
        const priority = PRIORITY_WEIGHT[left.priority] - PRIORITY_WEIGHT[right.priority]
        if (priority !== 0) return priority
        if (left.requestedAt !== right.requestedAt) return left.requestedAt - right.requestedAt
        if (left.sequence !== right.sequence) return left.sequence - right.sequence
        return left.layerId.localeCompare(right.layerId)
      })

    for (const entry of candidates) {
      if (this.#groupRunning(entry.groupId) >= this.#budget.maxRunningPerGroup) continue
      if (this.#bytesInFlight() + entry.estimatedBytes > this.#budget.maxEstimatedBytesInFlight) continue
      this.#queue.delete(entry.layerId)
      const token = `${entry.layerId}:${entry.revision}:${entry.sequence}:${stableHash(`${entry.groupId}:${entry.requestedAt}`)}`
      const lease: RunningEntry = {
        layerId: entry.layerId,
        groupId: entry.groupId,
        revision: entry.revision,
        priority: entry.priority,
        estimatedBytes: entry.estimatedBytes,
        startedAt: now,
        expiresAt: now + this.#budget.maxRunLeaseMs,
        token,
        sequence: entry.sequence,
      }
      this.#running.set(entry.layerId, lease)
      return Object.freeze({ ...lease })
    }
    return null
  }

  complete(token: string, now: number): boolean {
    this.#assertActive()
    assertFinite('now', now, 0)
    const running = this.#findLease(token)
    if (!running) return false
    this.#running.delete(running.layerId)
    const state = this.#layers.get(running.layerId)
    if (!state || state.revision !== running.revision) return false
    state.lastCompletedAt = now
    state.failures = 0
    state.cooldownUntil = now + this.#budget.minRefreshIntervalMs
    return true
  }

  fail(token: string, now: number): boolean {
    this.#assertActive()
    assertFinite('now', now, 0)
    const running = this.#findLease(token)
    if (!running) return false
    this.#running.delete(running.layerId)
    const state = this.#layers.get(running.layerId)
    if (!state || state.revision !== running.revision) return false
    state.failures = Math.min(state.failures + 1, 30)
    const exponential = this.#budget.minRefreshIntervalMs * 2 ** Math.min(state.failures - 1, 10)
    state.cooldownUntil = now + Math.min(this.#budget.maxBackoffMs, exponential)
    return true
  }

  cancel(layerId: string): boolean {
    this.#assertActive()
    const id = assertId('layerId', layerId)
    const queued = this.#queue.delete(id)
    const running = this.#running.delete(id)
    return queued || running
  }

  invalidate(layerId: string, revision: number): boolean {
    this.#assertActive()
    const id = assertId('layerId', layerId)
    assertInteger('revision', revision, 0)
    const state = this.#layers.get(id)
    if (state && revision <= state.revision) return false
    if (!state && this.#layers.size >= this.#budget.maxLayers) return false
    this.#queue.delete(id)
    this.#running.delete(id)
    this.#layers.set(id, { revision, lastCompletedAt: null, failures: 0, cooldownUntil: 0 })
    return true
  }

  releaseLayer(layerId: string): boolean {
    this.#assertActive()
    const id = assertId('layerId', layerId)
    this.#queue.delete(id)
    this.#running.delete(id)
    return this.#layers.delete(id)
  }

  expire(now: number): number {
    this.#assertActive()
    assertFinite('now', now, 0)
    let expired = 0
    for (const [layerId, entry] of this.#queue) {
      if (now - entry.requestedAt > this.#budget.maxQueueAgeMs) {
        this.#queue.delete(layerId)
        expired += 1
      }
    }
    for (const [layerId, entry] of this.#running) {
      if (now > entry.expiresAt) {
        this.#running.delete(layerId)
        const state = this.#layers.get(layerId)
        if (state && state.revision === entry.revision) {
          state.failures = Math.min(state.failures + 1, 30)
          state.cooldownUntil = now + Math.min(this.#budget.maxBackoffMs, this.#budget.minRefreshIntervalMs * 2 ** Math.min(state.failures - 1, 10))
        }
        expired += 1
      }
    }
    return expired
  }

  snapshot(): Readonly<ArcGisLayerRefreshSnapshot> {
    this.#assertActive()
    const watermark = Object.fromEntries([...this.#layers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, state]) => [id, state.revision]))
    const facts = [
      `q=${this.#queue.size}`,
      `r=${this.#running.size}`,
      `b=${this.#bytesInFlight()}`,
      ...[...this.#queue.values()].sort((a, b) => a.layerId.localeCompare(b.layerId)).map(entry => `q:${entry.layerId}:${entry.revision}:${entry.priority}`),
      ...[...this.#running.values()].sort((a, b) => a.layerId.localeCompare(b.layerId)).map(entry => `r:${entry.layerId}:${entry.revision}:${entry.priority}`),
    ].join('|')
    return Object.freeze({
      state: this.#running.size ? 'running' : this.#queue.size ? 'queued' : 'idle',
      queued: this.#queue.size,
      running: this.#running.size,
      estimatedBytesInFlight: this.#bytesInFlight(),
      trackedLayers: this.#layers.size,
      revisionWatermark: Object.freeze(watermark),
      fingerprint: stableHash(facts),
    })
  }

  dispose(): void {
    this.#queue.clear()
    this.#running.clear()
    this.#layers.clear()
    this.#disposed = true
  }

  #eligible(entry: QueueEntry, now: number): boolean {
    const state = this.#layers.get(entry.layerId)
    if (!state || state.revision !== entry.revision) return false
    if (now < (entry.notBefore ?? entry.requestedAt) || now < state.cooldownUntil) return false
    if (state.lastCompletedAt !== null && now - state.lastCompletedAt < this.#budget.minRefreshIntervalMs) return false
    return true
  }

  #groupRunning(groupId: string): number {
    let count = 0
    for (const entry of this.#running.values()) if (entry.groupId === groupId) count += 1
    return count
  }

  #bytesInFlight(): number {
    let bytes = 0
    for (const entry of this.#running.values()) bytes += entry.estimatedBytes
    return bytes
  }

  #findLease(token: string): RunningEntry | null {
    for (const entry of this.#running.values()) if (entry.token === token) return entry
    return null
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('ArcGisLayerRefreshPolicy is disposed')
  }
}
