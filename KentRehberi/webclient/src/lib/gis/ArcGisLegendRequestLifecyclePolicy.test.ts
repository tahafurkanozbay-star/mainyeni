import { describe, expect, it } from 'vitest'
import { ArcGisLegendRequestLifecyclePolicy, type ArcGisLegendBudget, type ArcGisLegendRequest } from './ArcGisLegendRequestLifecyclePolicy'

const budget: ArcGisLegendBudget = {
  maxServices: 2,
  maxRequests: 6,
  maxRequestsPerService: 4,
  maxLoading: 2,
  maxLoadingPerService: 1,
  maxReady: 3,
  maxReadyPerService: 2,
  maxItemsPerResponse: 40,
  maxBytesPerResponse: 120,
  maxAggregateReadyBytes: 240,
  queueTtlMs: 20,
  loadLeaseMs: 30,
  readyTtlMs: 40,
}

const request = (overrides: Partial<ArcGisLegendRequest> = {}): ArcGisLegendRequest => ({
  serviceId: 'planning-mapserver',
  requestId: 'legend-1',
  revision: 1,
  intent: 'visible',
  requestedAt: 10,
  estimatedItems: 10,
  estimatedBytes: 60,
  ...overrides,
})

describe('ArcGisLegendRequestLifecyclePolicy', () => {
  it('validates cardinality and byte budget relationships', () => {
    expect(() => new ArcGisLegendRequestLifecyclePolicy({ ...budget, maxRequestsPerService: 7 })).toThrow(RangeError)
    expect(() => new ArcGisLegendRequestLifecyclePolicy({ ...budget, maxLoading: 7 })).toThrow(RangeError)
    expect(() => new ArcGisLegendRequestLifecyclePolicy({ ...budget, maxLoadingPerService: 3 })).toThrow(RangeError)
    expect(() => new ArcGisLegendRequestLifecyclePolicy({ ...budget, maxReady: 7 })).toThrow(RangeError)
    expect(() => new ArcGisLegendRequestLifecyclePolicy({ ...budget, maxReadyPerService: 4 })).toThrow(RangeError)
    expect(() => new ArcGisLegendRequestLifecyclePolicy({ ...budget, maxBytesPerResponse: 241 })).toThrow(RangeError)
  })

  it('rejects unsafe identifiers and invalid scalars', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ serviceId: '<bad>' }))).toThrow()
    expect(() => policy.enqueue(request({ requestId: ' ' }))).toThrow()
    expect(() => policy.enqueue(request({ revision: -1 }))).toThrow(RangeError)
    expect(() => policy.enqueue(request({ requestedAt: Number.POSITIVE_INFINITY }))).toThrow(RangeError)
    expect(() => policy.enqueue(request({ estimatedItems: -1 }))).toThrow(RangeError)
    expect(() => policy.enqueue(request({ estimatedBytes: -1 }))).toThrow(RangeError)
  })

  it('rejects estimates beyond response budgets', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request({ estimatedItems: 41 }))).toBe(false)
    expect(policy.enqueue(request({ estimatedBytes: 121 }))).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('schedules interactive before visible before background', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request({ requestId: 'background', intent: 'background', requestedAt: 1 }))).toBe(true)
    expect(policy.enqueue(request({ requestId: 'visible', intent: 'visible', requestedAt: 2 }))).toBe(true)
    expect(policy.enqueue(request({ requestId: 'interactive', intent: 'interactive', requestedAt: 3 }))).toBe(true)
    expect(policy.takeNext(4)?.requestId).toBe('interactive')
  })

  it('limits loading concurrency per service', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request({ requestId: 'a' }))).toBe(true)
    expect(policy.enqueue(request({ requestId: 'b' }))).toBe(true)
    expect(policy.enqueue(request({ serviceId: 'transport-mapserver', requestId: 'c' }))).toBe(true)
    expect(policy.takeNext(11)?.requestId).toBe('a')
    expect(policy.takeNext(12)?.requestId).toBe('c')
  })

  it('invalidates stale service revisions', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request({ requestId: 'old', revision: 1 }))).toBe(true)
    expect(policy.enqueue(request({ requestId: 'new', revision: 2 }))).toBe(true)
    expect(policy.snapshot().map(entry => entry.requestId)).toEqual(['new'])
    expect(policy.enqueue(request({ requestId: 'stale', revision: 1 }))).toBe(false)
  })

  it('allows priority promotion for the same revision', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request({ intent: 'background' }))).toBe(true)
    expect(policy.enqueue(request({ intent: 'visible' }))).toBe(true)
    expect(policy.enqueue(request({ intent: 'visible' }))).toBe(false)
    expect(policy.enqueue(request({ intent: 'interactive' }))).toBe(true)
    expect(policy.snapshot()[0]?.intent).toBe('interactive')
  })

  it('expires queued requests before they consume loading slots', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request({ requestedAt: 1 }))).toBe(true)
    expect(policy.takeNext(21)).toBeUndefined()
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects late completion after loading lease expiry', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('planning-mapserver', 'legend-1', 1, 10, 50, 41)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects mismatched revision completion without consuming live work', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('planning-mapserver', 'legend-1', 2, 10, 50, 12)).toBe(false)
    expect(policy.snapshot()[0]?.phase).toBe('loading')
  })

  it('reconciles actual item and byte counts', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request({ estimatedItems: 5, estimatedBytes: 20 }))).toBe(true)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('planning-mapserver', 'legend-1', 1, 15, 80, 12)).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({ actualItems: 15, actualBytes: 80, phase: 'ready' })
  })

  it('rejects oversized actual responses and releases their accounting', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('planning-mapserver', 'legend-1', 1, 41, 50, 12)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('cleans expired ready metadata before new completion admission', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy({ ...budget, maxReady: 1, maxReadyPerService: 1 })
    expect(policy.enqueue(request({ requestId: 'old', requestedAt: 1 }))).toBe(true)
    expect(policy.takeNext(2)).toBeDefined()
    expect(policy.complete('planning-mapserver', 'old', 1, 10, 100, 3)).toBe(true)
    expect(policy.enqueue(request({ requestId: 'fresh', requestedAt: 42 }))).toBe(true)
    expect(policy.takeNext(43)).toBeDefined()
    expect(policy.complete('planning-mapserver', 'fresh', 1, 10, 100, 44)).toBe(true)
    expect(policy.snapshot().map(entry => entry.requestId)).toEqual(['fresh'])
  })

  it('evicts background ready metadata before interactive metadata', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy({ ...budget, maxReady: 2, maxReadyPerService: 2, maxAggregateReadyBytes: 180 })
    for (const [requestId, intent] of [['interactive', 'interactive'], ['background', 'background']] as const) {
      expect(policy.enqueue(request({ requestId, intent }))).toBe(true)
      expect(policy.takeNext(11)).toBeDefined()
      expect(policy.complete('planning-mapserver', requestId, 1, 10, 60, 12)).toBe(true)
    }
    expect(policy.enqueue(request({ serviceId: 'transport-mapserver', requestId: 'new', intent: 'visible', requestedAt: 13 }))).toBe(true)
    expect(policy.takeNext(14)).toBeDefined()
    expect(policy.complete('transport-mapserver', 'new', 1, 10, 100, 15)).toBe(true)
    expect(policy.snapshot().map(entry => entry.requestId)).toEqual(['interactive', 'new'])
  })

  it('touch updates recency for deterministic LRU eviction', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy({ ...budget, maxReady: 2, maxReadyPerService: 2 })
    for (const requestId of ['a', 'b']) {
      expect(policy.enqueue(request({ requestId, requestedAt: 1 }))).toBe(true)
      expect(policy.takeNext(2)).toBeDefined()
      expect(policy.complete('planning-mapserver', requestId, 1, 10, 40, 3)).toBe(true)
    }
    expect(policy.touch('planning-mapserver', 'a', 1, 4)).toBe(true)
    expect(policy.enqueue(request({ serviceId: 'transport-mapserver', requestId: 'c', requestedAt: 5 }))).toBe(true)
    expect(policy.takeNext(6)).toBeDefined()
    expect(policy.complete('transport-mapserver', 'c', 1, 10, 40, 7)).toBe(true)
    expect(policy.snapshot().map(entry => entry.requestId)).toEqual(['a', 'c'])
  })

  it('consume only removes matching ready metadata', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.consume('planning-mapserver', 'legend-1', 1)).toBe(false)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('planning-mapserver', 'legend-1', 1, 10, 50, 12)).toBe(true)
    expect(policy.consume('planning-mapserver', 'legend-1', 2)).toBe(false)
    expect(policy.consume('planning-mapserver', 'legend-1', 1)).toBe(true)
  })

  it('cancel removes matching queued work', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.cancel('planning-mapserver', 'legend-1', 2)).toBe(false)
    expect(policy.cancel('planning-mapserver', 'legend-1', 1)).toBe(true)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('releaseService clears jobs and revision watermark', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request({ revision: 4 }))).toBe(true)
    expect(policy.releaseService('planning-mapserver')).toBe(1)
    expect(policy.enqueue(request({ requestId: 'fresh', revision: 1 }))).toBe(true)
  })

  it('returns frozen detached scalar snapshots', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    const snapshot = policy.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[0])).toBe(true)
    expect(snapshot[0]).toMatchObject({ serviceId: 'planning-mapserver', requestId: 'legend-1' })
  })

  it('creates deterministic payload-free fingerprints', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.fingerprint()).toBe('planning-mapserver:legend-1:1:visible:queued:0:0')
  })

  it('fails closed after idempotent disposal', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    policy.dispose()
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.enqueue(request())).toThrow('disposed')
  })
})
