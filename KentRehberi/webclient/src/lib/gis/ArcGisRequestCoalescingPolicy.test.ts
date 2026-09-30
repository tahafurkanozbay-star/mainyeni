import { describe, expect, it } from 'vitest'
import { ArcGisRequestCoalescingPolicy, type ArcGisRequestCoalescingBudget } from './ArcGisRequestCoalescingPolicy'

const budget: ArcGisRequestCoalescingBudget = {
  maxEntries: 3,
  maxConsumersPerEntry: 3,
  maxKeyLength: 64,
  maxConsumerIdLength: 32,
  maxLayerIdLength: 32,
  maxEstimatedBytesPerEntry: 500,
  maxAggregateEstimatedBytes: 800,
  maxLeaseMs: 1000,
  maxReuseAgeMs: 100,
}

const identity = (key: string, overrides = {}) => ({
  key,
  layerId: 'roads',
  revision: 1,
  requestClass: 'query' as const,
  estimatedBytes: 200,
  ...overrides,
})

const consumer = (consumerId: string, priority: 'interactive' | 'foreground' | 'background' = 'foreground', nowMs = 1000) => ({ consumerId, priority, nowMs })

describe('ArcGisRequestCoalescingPolicy', () => {
  it('elects one leader and joins equivalent consumers', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    expect(policy.acquire(identity('roads:q'), consumer('map')).leader).toBe(true)
    expect(policy.acquire(identity('roads:q'), consumer('table')).leader).toBe(false)
    expect(policy.snapshot()).toMatchObject({ consumerCount: 2, aggregateEstimatedBytes: 200 })
  })

  it('orders consumers by priority then join time', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('roads:q'), consumer('background', 'background', 900))
    policy.acquire(identity('roads:q'), consumer('interactive', 'interactive', 1000))
    policy.acquire(identity('roads:q'), consumer('foreground', 'foreground', 950))
    expect(policy.snapshot().entries[0]?.consumers.map(item => item.consumerId)).toEqual(['interactive', 'foreground', 'background'])
  })

  it('rejects semantic key collisions', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('shared'), consumer('a'))
    expect(() => policy.acquire(identity('shared', { revision: 2 }), consumer('b'))).toThrow('coalescing-key-collision')
    expect(() => policy.acquire(identity('shared', { layerId: 'buildings' }), consumer('b'))).toThrow('coalescing-key-collision')
  })

  it('rejects duplicate consumers', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('roads:q'), consumer('map'))
    expect(() => policy.acquire(identity('roads:q'), consumer('map'))).toThrow('duplicate-coalescing-consumer')
  })

  it('enforces per-entry consumer bounds', () => {
    const policy = new ArcGisRequestCoalescingPolicy({ ...budget, maxConsumersPerEntry: 1 })
    policy.acquire(identity('roads:q'), consumer('a'))
    expect(() => policy.acquire(identity('roads:q'), consumer('b'))).toThrow('coalescing-consumer-budget-exceeded')
  })

  it('enforces entry cardinality bounds', () => {
    const policy = new ArcGisRequestCoalescingPolicy({ ...budget, maxEntries: 1 })
    policy.acquire(identity('a'), consumer('a'))
    expect(() => policy.acquire(identity('b', { layerId: 'b' }), consumer('b'))).toThrow('coalescing-entry-budget-exceeded')
  })

  it('enforces aggregate byte bounds', () => {
    const policy = new ArcGisRequestCoalescingPolicy({ ...budget, maxAggregateEstimatedBytes: 500 })
    policy.acquire(identity('a', { estimatedBytes: 300 }), consumer('a'))
    expect(() => policy.acquire(identity('b', { layerId: 'b', estimatedBytes: 300 }), consumer('b'))).toThrow('coalescing-byte-budget-exceeded')
  })

  it('releases an unsettled entry after its last consumer leaves', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('roads:q'), consumer('map'))
    expect(policy.release('roads:q', 'map')).toBe(true)
    expect(policy.snapshot()).toMatchObject({ consumerCount: 0, aggregateEstimatedBytes: 0 })
  })

  it('keeps settled reusable metadata after the last consumer leaves', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('roads:q'), consumer('map'))
    policy.settle('roads:q', 1, 1010)
    expect(policy.release('roads:q', 'map')).toBe(true)
    expect(policy.snapshot().entries).toHaveLength(1)
  })

  it('rejects stale settlement and failure revisions', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('roads:q'), consumer('map'))
    expect(() => policy.settle('roads:q', 2, 1010)).toThrow('stale-coalesced-settlement')
    expect(() => policy.fail('roads:q', 2)).toThrow('stale-coalesced-failure')
  })

  it('returns deterministic affected consumers on failure', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('roads:q'), consumer('z'))
    policy.acquire(identity('roads:q'), consumer('a'))
    expect(policy.fail('roads:q', 1)).toEqual(['a', 'z'])
    expect(policy.snapshot().aggregateEstimatedBytes).toBe(0)
  })

  it('invalidates stale layer revisions only', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('old', { revision: 1 }), consumer('a'))
    policy.acquire(identity('current', { revision: 3 }), consumer('b'))
    expect(policy.invalidateLayer('roads', 3)).toBe(1)
    expect(policy.snapshot().entries.map(item => item.key)).toEqual(['current'])
  })

  it('expires leases and releases byte accounting', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('roads:q'), consumer('map', 'foreground', 1000))
    expect(policy.tick(1999)).toEqual([])
    expect(policy.tick(2000)).toEqual(['roads:q'])
    expect(policy.snapshot().aggregateEstimatedBytes).toBe(0)
  })

  it('reuses a settled entry only inside the reuse window', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('roads:q'), consumer('map'))
    policy.settle('roads:q', 1, 1010)
    expect(policy.acquire(identity('roads:q'), consumer('table', 'foreground', 1110)).leader).toBe(false)
    policy.release('roads:q', 'table')
    expect(policy.acquire(identity('roads:q'), consumer('popup', 'foreground', 1111)).leader).toBe(true)
  })

  it('returns immutable deterministic snapshots', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('z', { layerId: 'z' }), consumer('z'))
    policy.acquire(identity('a', { layerId: 'a' }), consumer('a'))
    const snapshot = policy.snapshot()
    expect(snapshot.entries.map(item => item.layerId)).toEqual(['a', 'z'])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.entries)).toBe(true)
  })

  it('validates identifiers and entry byte limits', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    expect(() => policy.acquire(identity(''), consumer('a'))).toThrow('invalid-key')
    expect(() => policy.acquire(identity('large', { estimatedBytes: 501 }), consumer('a'))).toThrow('estimatedBytes-out-of-range')
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisRequestCoalescingPolicy(budget)
    policy.acquire(identity('roads:q'), consumer('map'))
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('arcgis-request-coalescing-disposed')
    expect(() => policy.acquire(identity('roads:q'), consumer('map'))).toThrow('arcgis-request-coalescing-disposed')
  })
})
