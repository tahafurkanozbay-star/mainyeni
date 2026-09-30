export type ArcGisRequestClass = 'query' | 'identify' | 'legend' | 'metadata'
export type ArcGisConsumerPriority = 'interactive' | 'foreground' | 'background'

export interface ArcGisRequestCoalescingBudget {
  readonly maxEntries: number
  readonly maxConsumersPerEntry: number
  readonly maxKeyLength: number
  readonly maxConsumerIdLength: number
  readonly maxLayerIdLength: number
  readonly maxEstimatedBytesPerEntry: number
  readonly maxAggregateEstimatedBytes: number
  readonly maxLeaseMs: number
  readonly maxReuseAgeMs: number
}

export interface ArcGisRequestIdentity {
  readonly key: string
  readonly layerId: string
  readonly revision: number
  readonly requestClass: ArcGisRequestClass
  readonly estimatedBytes: number
}

export interface ArcGisRequestConsumer {
  readonly consumerId: string
  readonly priority: ArcGisConsumerPriority
  readonly joinedAtMs: number
}

export interface ArcGisCoalescedEntry extends ArcGisRequestIdentity {
  readonly createdAtMs: number
  readonly expiresAtMs: number
  readonly consumers: readonly ArcGisRequestConsumer[]
  readonly settled: boolean
  readonly settledAtMs?: number
}

export interface ArcGisRequestCoalescingSnapshot {
  readonly entries: readonly ArcGisCoalescedEntry[]
  readonly aggregateEstimatedBytes: number
  readonly consumerCount: number
}

const PRIORITY: Readonly<Record<ArcGisConsumerPriority, number>> = Object.freeze({ interactive: 0, foreground: 1, background: 2 })

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}-out-of-range`)
  return value
}

function text(value: string, name: string, max: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`invalid-${name}`)
  return normalized
}

function requestClass(value: ArcGisRequestClass): ArcGisRequestClass {
  if (value !== 'query' && value !== 'identify' && value !== 'legend' && value !== 'metadata') throw new Error('invalid-request-class')
  return value
}

function priority(value: ArcGisConsumerPriority): ArcGisConsumerPriority {
  if (value !== 'interactive' && value !== 'foreground' && value !== 'background') throw new Error('invalid-consumer-priority')
  return value
}

/** Metadata-only authority for deterministic ArcGIS request dedupe and fan-out. */
export class ArcGisRequestCoalescingPolicy {
  private readonly budget: Readonly<ArcGisRequestCoalescingBudget>
  private readonly entries = new Map<string, ArcGisCoalescedEntry>()
  private aggregateEstimatedBytes = 0
  private disposed = false

  constructor(input: ArcGisRequestCoalescingBudget) {
    this.budget = Object.freeze({
      maxEntries: integer(input.maxEntries, 'maxEntries', 1, 100_000),
      maxConsumersPerEntry: integer(input.maxConsumersPerEntry, 'maxConsumersPerEntry', 1, 10_000),
      maxKeyLength: integer(input.maxKeyLength, 'maxKeyLength', 1, 2048),
      maxConsumerIdLength: integer(input.maxConsumerIdLength, 'maxConsumerIdLength', 1, 512),
      maxLayerIdLength: integer(input.maxLayerIdLength, 'maxLayerIdLength', 1, 512),
      maxEstimatedBytesPerEntry: integer(input.maxEstimatedBytesPerEntry, 'maxEstimatedBytesPerEntry', 0, 1024 * 1024 * 1024),
      maxAggregateEstimatedBytes: integer(input.maxAggregateEstimatedBytes, 'maxAggregateEstimatedBytes', 1, Number.MAX_SAFE_INTEGER),
      maxLeaseMs: integer(input.maxLeaseMs, 'maxLeaseMs', 1, 60 * 60 * 1000),
      maxReuseAgeMs: integer(input.maxReuseAgeMs, 'maxReuseAgeMs', 0, 60 * 60 * 1000),
    })
    if (this.budget.maxEstimatedBytesPerEntry > this.budget.maxAggregateEstimatedBytes) throw new Error('entry-byte-budget-exceeds-aggregate')
  }

  acquire(identity: ArcGisRequestIdentity, consumer: { readonly consumerId: string; readonly priority: ArcGisConsumerPriority; readonly nowMs: number }): { readonly entry: ArcGisCoalescedEntry; readonly leader: boolean } {
    this.assertLive()
    const normalized = this.normalizeIdentity(identity)
    const consumerId = text(consumer.consumerId, 'consumer-id', this.budget.maxConsumerIdLength)
    const nowMs = integer(consumer.nowMs, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    this.prune(nowMs)
    const existing = this.entries.get(normalized.key)
    if (existing) {
      this.assertSameIdentity(existing, normalized)
      if (existing.settled && (existing.settledAtMs === undefined || nowMs - existing.settledAtMs > this.budget.maxReuseAgeMs)) {
        this.removeEntry(existing.key)
      } else {
        return Object.freeze({ entry: this.join(existing, consumerId, priority(consumer.priority), nowMs), leader: false })
      }
    }
    if (this.entries.size >= this.budget.maxEntries) throw new Error('coalescing-entry-budget-exceeded')
    if (this.aggregateEstimatedBytes + normalized.estimatedBytes > this.budget.maxAggregateEstimatedBytes) throw new Error('coalescing-byte-budget-exceeded')
    if (nowMs > Number.MAX_SAFE_INTEGER - this.budget.maxLeaseMs) throw new Error('coalescing-lease-overflow')
    const firstConsumer = Object.freeze({ consumerId, priority: priority(consumer.priority), joinedAtMs: nowMs })
    const entry = Object.freeze({ ...normalized, createdAtMs: nowMs, expiresAtMs: nowMs + this.budget.maxLeaseMs, consumers: Object.freeze([firstConsumer]), settled: false })
    this.entries.set(entry.key, entry)
    this.aggregateEstimatedBytes += entry.estimatedBytes
    return Object.freeze({ entry, leader: true })
  }

  release(keyInput: string, consumerIdInput: string): boolean {
    this.assertLive()
    const key = text(keyInput, 'key', this.budget.maxKeyLength)
    const consumerId = text(consumerIdInput, 'consumer-id', this.budget.maxConsumerIdLength)
    const entry = this.entries.get(key)
    if (!entry) return false
    const consumers = entry.consumers.filter(item => item.consumerId !== consumerId)
    if (consumers.length === entry.consumers.length) return false
    if (consumers.length === 0 && !entry.settled) {
      this.removeEntry(key)
      return true
    }
    this.entries.set(key, Object.freeze({ ...entry, consumers: Object.freeze(consumers) }))
    return true
  }

  settle(keyInput: string, revisionInput: number, nowMsInput: number): ArcGisCoalescedEntry | undefined {
    this.assertLive()
    const key = text(keyInput, 'key', this.budget.maxKeyLength)
    const revision = integer(revisionInput, 'revision', 0, Number.MAX_SAFE_INTEGER)
    const nowMs = integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.revision !== revision) throw new Error('stale-coalesced-settlement')
    if (entry.settled) return entry
    const next = Object.freeze({ ...entry, settled: true, settledAtMs: nowMs })
    this.entries.set(key, next)
    return next
  }

  fail(keyInput: string, revisionInput: number): readonly string[] {
    this.assertLive()
    const key = text(keyInput, 'key', this.budget.maxKeyLength)
    const revision = integer(revisionInput, 'revision', 0, Number.MAX_SAFE_INTEGER)
    const entry = this.entries.get(key)
    if (!entry) return Object.freeze([])
    if (entry.revision !== revision) throw new Error('stale-coalesced-failure')
    const consumers = entry.consumers.map(item => item.consumerId).sort()
    this.removeEntry(key)
    return Object.freeze(consumers)
  }

  invalidateLayer(layerIdInput: string, minimumRevisionInput: number): number {
    this.assertLive()
    const layerId = text(layerIdInput, 'layer-id', this.budget.maxLayerIdLength)
    const minimumRevision = integer(minimumRevisionInput, 'minimumRevision', 0, Number.MAX_SAFE_INTEGER)
    let removed = 0
    for (const entry of [...this.entries.values()]) {
      if (entry.layerId === layerId && entry.revision < minimumRevision) {
        this.removeEntry(entry.key)
        removed += 1
      }
    }
    return removed
  }

  tick(nowMsInput: number): readonly string[] {
    this.assertLive()
    return this.prune(integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER))
  }

  snapshot(): ArcGisRequestCoalescingSnapshot {
    this.assertLive()
    const entries = [...this.entries.values()].sort((a, b) => a.layerId.localeCompare(b.layerId) || a.key.localeCompare(b.key))
    let consumerCount = 0
    for (const entry of entries) consumerCount += entry.consumers.length
    return Object.freeze({ entries: Object.freeze(entries), aggregateEstimatedBytes: this.aggregateEstimatedBytes, consumerCount })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.entries.clear()
    this.aggregateEstimatedBytes = 0
  }

  private normalizeIdentity(input: ArcGisRequestIdentity): ArcGisRequestIdentity {
    return Object.freeze({
      key: text(input.key, 'key', this.budget.maxKeyLength),
      layerId: text(input.layerId, 'layer-id', this.budget.maxLayerIdLength),
      revision: integer(input.revision, 'revision', 0, Number.MAX_SAFE_INTEGER),
      requestClass: requestClass(input.requestClass),
      estimatedBytes: integer(input.estimatedBytes, 'estimatedBytes', 0, this.budget.maxEstimatedBytesPerEntry),
    })
  }

  private assertSameIdentity(existing: ArcGisCoalescedEntry, next: ArcGisRequestIdentity): void {
    if (existing.layerId !== next.layerId || existing.revision !== next.revision || existing.requestClass !== next.requestClass || existing.estimatedBytes !== next.estimatedBytes) throw new Error('coalescing-key-collision')
  }

  private join(entry: ArcGisCoalescedEntry, consumerId: string, consumerPriority: ArcGisConsumerPriority, nowMs: number): ArcGisCoalescedEntry {
    if (entry.consumers.some(item => item.consumerId === consumerId)) throw new Error('duplicate-coalescing-consumer')
    if (entry.consumers.length >= this.budget.maxConsumersPerEntry) throw new Error('coalescing-consumer-budget-exceeded')
    const consumers = [...entry.consumers, Object.freeze({ consumerId, priority: consumerPriority, joinedAtMs: nowMs })]
      .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.joinedAtMs - b.joinedAtMs || a.consumerId.localeCompare(b.consumerId))
    const next = Object.freeze({ ...entry, consumers: Object.freeze(consumers) })
    this.entries.set(entry.key, next)
    return next
  }

  private prune(nowMs: number): readonly string[] {
    const removed: string[] = []
    for (const entry of [...this.entries.values()]) {
      const reuseExpired = entry.settled && entry.settledAtMs !== undefined && nowMs - entry.settledAtMs > this.budget.maxReuseAgeMs
      if (entry.expiresAtMs <= nowMs || reuseExpired) {
        this.removeEntry(entry.key)
        removed.push(entry.key)
      }
    }
    return Object.freeze(removed.sort())
  }

  private removeEntry(key: string): void {
    const entry = this.entries.get(key)
    if (!entry || !this.entries.delete(key)) return
    this.aggregateEstimatedBytes -= entry.estimatedBytes
    if (this.aggregateEstimatedBytes < 0) throw new Error('coalescing-byte-accounting-invalid')
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('arcgis-request-coalescing-disposed')
  }
}
