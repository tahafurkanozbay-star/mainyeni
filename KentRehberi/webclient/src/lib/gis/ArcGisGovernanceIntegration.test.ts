import { describe, expect, it } from 'vitest'
import { ArcGisLayerRefreshPolicy } from './ArcGisLayerRefreshPolicy'
import { ArcGisRequestCoalescingPolicy } from './ArcGisRequestCoalescingPolicy'

const refreshBudget = {
  maxLayers: 8,
  maxQueued: 8,
  maxRunning: 2,
  maxRunningPerGroup: 1,
  maxEstimatedBytesInFlight: 1000,
  minRefreshIntervalMs: 50,
  maxQueueAgeMs: 500,
  maxRunLeaseMs: 200,
  maxBackoffMs: 400,
}

const coalescingBudget = {
  maxEntries: 8,
  maxConsumersPerEntry: 4,
  maxKeyLength: 96,
  maxConsumerIdLength: 48,
  maxLayerIdLength: 48,
  maxEstimatedBytesPerEntry: 500,
  maxAggregateEstimatedBytes: 1000,
  maxLeaseMs: 200,
  maxReuseAgeMs: 50,
}

describe('ArcGIS governance composition', () => {
  it('keeps refresh admission and request fan-out on one revision', () => {
    const refresh = new ArcGisLayerRefreshPolicy(refreshBudget)
    const coalescing = new ArcGisRequestCoalescingPolicy(coalescingBudget)
    expect(refresh.enqueue({ layerId: 'roads', groupId: 'transport', revision: 7, priority: 'interactive', estimatedBytes: 200, requestedAt: 1000 })).toBe(true)
    const lease = refresh.startNext(1000)!
    const first = coalescing.acquire({ key: 'roads:7:query', layerId: 'roads', revision: lease.revision, requestClass: 'query', estimatedBytes: 200 }, { consumerId: 'map', priority: 'interactive', nowMs: 1000 })
    const second = coalescing.acquire({ key: 'roads:7:query', layerId: 'roads', revision: lease.revision, requestClass: 'query', estimatedBytes: 200 }, { consumerId: 'table', priority: 'foreground', nowMs: 1001 })
    expect(first.leader).toBe(true)
    expect(second.leader).toBe(false)
    expect(coalescing.snapshot()).toMatchObject({ consumerCount: 2, aggregateEstimatedBytes: 200 })
    expect(refresh.complete(lease.token, 1020)).toBe(true)
  })

  it('invalidates stale coalesced work when a layer revision advances', () => {
    const refresh = new ArcGisLayerRefreshPolicy(refreshBudget)
    const coalescing = new ArcGisRequestCoalescingPolicy(coalescingBudget)
    refresh.invalidate('buildings', 3)
    coalescing.acquire({ key: 'buildings:3', layerId: 'buildings', revision: 3, requestClass: 'identify', estimatedBytes: 150 }, { consumerId: 'popup', priority: 'interactive', nowMs: 1000 })
    expect(refresh.invalidate('buildings', 4)).toBe(true)
    expect(coalescing.invalidateLayer('buildings', 4)).toBe(1)
    expect(coalescing.snapshot().entries).toHaveLength(0)
    expect(refresh.snapshot().revisionWatermark).toEqual({ buildings: 4 })
  })

  it('releases both authorities after cancellation without retained bytes', () => {
    const refresh = new ArcGisLayerRefreshPolicy(refreshBudget)
    const coalescing = new ArcGisRequestCoalescingPolicy(coalescingBudget)
    refresh.enqueue({ layerId: 'parks', groupId: 'poi', revision: 1, priority: 'foreground', estimatedBytes: 300, requestedAt: 1000 })
    refresh.startNext(1000)
    coalescing.acquire({ key: 'parks:1', layerId: 'parks', revision: 1, requestClass: 'query', estimatedBytes: 300 }, { consumerId: 'map', priority: 'foreground', nowMs: 1000 })
    expect(refresh.cancel('parks')).toBe(true)
    expect(coalescing.release('parks:1', 'map')).toBe(true)
    expect(refresh.snapshot().estimatedBytesInFlight).toBe(0)
    expect(coalescing.snapshot().aggregateEstimatedBytes).toBe(0)
  })

  it('keeps deterministic snapshots independent of insertion order', () => {
    const first = new ArcGisRequestCoalescingPolicy(coalescingBudget)
    const second = new ArcGisRequestCoalescingPolicy(coalescingBudget)
    const add = (policy: ArcGisRequestCoalescingPolicy, key: string, layerId: string) => policy.acquire({ key, layerId, revision: 1, requestClass: 'metadata', estimatedBytes: 10 }, { consumerId: key, priority: 'background', nowMs: 1000 })
    add(first, 'z', 'z-layer')
    add(first, 'a', 'a-layer')
    add(second, 'a', 'a-layer')
    add(second, 'z', 'z-layer')
    expect(first.snapshot().entries.map(entry => entry.key)).toEqual(second.snapshot().entries.map(entry => entry.key))
  })

  it('fails closed after both authorities are disposed', () => {
    const refresh = new ArcGisLayerRefreshPolicy(refreshBudget)
    const coalescing = new ArcGisRequestCoalescingPolicy(coalescingBudget)
    refresh.dispose()
    coalescing.dispose()
    expect(() => refresh.snapshot()).toThrow('disposed')
    expect(() => coalescing.snapshot()).toThrow('disposed')
  })
})
