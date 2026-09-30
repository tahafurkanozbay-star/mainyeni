import { describe, expect, it } from 'vitest'
import { ArcGisLayerRefreshPolicy, type ArcGisLayerRefreshBudget } from './ArcGisLayerRefreshPolicy'

const budget: ArcGisLayerRefreshBudget = {
  maxLayers: 4,
  maxQueued: 4,
  maxRunning: 2,
  maxRunningPerGroup: 1,
  maxEstimatedBytesInFlight: 1000,
  minRefreshIntervalMs: 100,
  maxQueueAgeMs: 500,
  maxRunLeaseMs: 200,
  maxBackoffMs: 800,
}

const request = (layerId: string, overrides: Partial<Parameters<ArcGisLayerRefreshPolicy['enqueue']>[0]> = {}) => ({
  layerId,
  groupId: 'operational',
  revision: 1,
  priority: 'foreground' as const,
  estimatedBytes: 100,
  requestedAt: 1000,
  ...overrides,
})

describe('ArcGisLayerRefreshPolicy', () => {
  it('validates bounded budgets', () => {
    expect(() => new ArcGisLayerRefreshPolicy({ ...budget, maxLayers: 0 })).toThrow()
    expect(() => new ArcGisLayerRefreshPolicy({ ...budget, maxRunningPerGroup: 3 })).toThrow()
    expect(() => new ArcGisLayerRefreshPolicy({ ...budget, maxEstimatedBytesInFlight: 0 })).toThrow()
  })

  it('admits a bounded refresh and exposes deterministic accounting', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    expect(policy.enqueue(request('roads'))).toBe(true)
    expect(policy.snapshot()).toMatchObject({ queued: 1, running: 0, trackedLayers: 1, state: 'queued' })
    const lease = policy.startNext(1000)
    expect(lease).toMatchObject({ layerId: 'roads', revision: 1, estimatedBytes: 100 })
    expect(policy.snapshot()).toMatchObject({ queued: 0, running: 1, estimatedBytesInFlight: 100, state: 'running' })
  })

  it('orders interactive work ahead of older background work', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('background', { priority: 'background', requestedAt: 900 }))
    policy.enqueue(request('interactive', { priority: 'interactive', requestedAt: 1000 }))
    expect(policy.startNext(1000)?.layerId).toBe('interactive')
  })

  it('uses request age and sequence as deterministic tie breakers', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('newer', { requestedAt: 950 }))
    policy.enqueue(request('older', { requestedAt: 900 }))
    expect(policy.startNext(1000)?.layerId).toBe('older')
  })

  it('enforces global and group concurrency independently', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('a', { groupId: 'same' }))
    policy.enqueue(request('b', { groupId: 'same' }))
    policy.enqueue(request('c', { groupId: 'other' }))
    expect(policy.startNext(1000)?.layerId).toBe('a')
    expect(policy.startNext(1000)?.layerId).toBe('c')
    expect(policy.startNext(1000)).toBeNull()
  })

  it('enforces aggregate estimated response bytes', () => {
    const policy = new ArcGisLayerRefreshPolicy({ ...budget, maxRunningPerGroup: 2, maxEstimatedBytesInFlight: 150 })
    policy.enqueue(request('a', { groupId: 'a', estimatedBytes: 100 }))
    policy.enqueue(request('b', { groupId: 'b', estimatedBytes: 100 }))
    expect(policy.startNext(1000)?.layerId).toBe('a')
    expect(policy.startNext(1000)).toBeNull()
  })

  it('rejects a single request larger than the byte budget', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    expect(policy.enqueue(request('huge', { estimatedBytes: 1001 }))).toBe(false)
  })

  it('rejects stale revisions', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    expect(policy.invalidate('roads', 5)).toBe(true)
    expect(policy.enqueue(request('roads', { revision: 4 }))).toBe(false)
  })

  it('supersedes queued work when a newer revision arrives', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads', { revision: 1, priority: 'background' }))
    expect(policy.enqueue(request('roads', { revision: 2, priority: 'interactive' }))).toBe(true)
    expect(policy.startNext(1000)).toMatchObject({ layerId: 'roads', revision: 2 })
  })

  it('allows priority promotion without duplicating a queued revision', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads', { priority: 'background' }))
    expect(policy.enqueue(request('roads', { priority: 'interactive' }))).toBe(true)
    expect(policy.snapshot().queued).toBe(1)
    expect(policy.startNext(1000)?.priority).toBe('interactive')
  })

  it('rejects same-revision priority demotion', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads', { priority: 'interactive' }))
    expect(policy.enqueue(request('roads', { priority: 'background' }))).toBe(false)
  })

  it('honors not-before admission', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads', { notBefore: 1200 }))
    expect(policy.startNext(1199)).toBeNull()
    expect(policy.startNext(1200)?.layerId).toBe('roads')
  })

  it('applies completion cooldown', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads'))
    const lease = policy.startNext(1000)!
    expect(policy.complete(lease.token, 1050)).toBe(true)
    expect(policy.enqueue(request('roads'))).toBe(true)
    expect(policy.startNext(1149)).toBeNull()
    expect(policy.startNext(1150)?.layerId).toBe('roads')
  })

  it('applies bounded exponential failure backoff', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads'))
    const first = policy.startNext(1000)!
    expect(policy.fail(first.token, 1010)).toBe(true)
    policy.enqueue(request('roads'))
    expect(policy.startNext(1109)).toBeNull()
    const second = policy.startNext(1110)!
    expect(policy.fail(second.token, 1120)).toBe(true)
    policy.enqueue(request('roads'))
    expect(policy.startNext(1319)).toBeNull()
    expect(policy.startNext(1320)?.layerId).toBe('roads')
  })

  it('expires stale queue entries', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads', { requestedAt: 1000 }))
    expect(policy.expire(1501)).toBe(1)
    expect(policy.snapshot().queued).toBe(0)
  })

  it('expires run leases and releases byte accounting', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads'))
    policy.startNext(1000)
    expect(policy.expire(1201)).toBe(1)
    expect(policy.snapshot()).toMatchObject({ running: 0, estimatedBytesInFlight: 0 })
  })

  it('rejects completion with an unknown token', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    expect(policy.complete('unknown', 1000)).toBe(false)
  })

  it('cancels queued and running work without dropping revision state', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads'))
    expect(policy.cancel('roads')).toBe(true)
    expect(policy.snapshot()).toMatchObject({ queued: 0, trackedLayers: 1 })
    policy.enqueue(request('roads'))
    policy.startNext(1000)
    expect(policy.cancel('roads')).toBe(true)
    expect(policy.snapshot().running).toBe(0)
  })

  it('invalidates active work when revision advances', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads'))
    policy.startNext(1000)
    expect(policy.invalidate('roads', 2)).toBe(true)
    expect(policy.snapshot()).toMatchObject({ running: 0, revisionWatermark: { roads: 2 } })
  })

  it('bounds tracked layer cardinality', () => {
    const policy = new ArcGisLayerRefreshPolicy({ ...budget, maxLayers: 2 })
    expect(policy.invalidate('a', 1)).toBe(true)
    expect(policy.invalidate('b', 1)).toBe(true)
    expect(policy.invalidate('c', 1)).toBe(false)
  })

  it('releases layer state explicitly', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.invalidate('roads', 1)
    expect(policy.releaseLayer('roads')).toBe(true)
    expect(policy.snapshot().trackedLayers).toBe(0)
  })

  it('returns immutable snapshots with stable fingerprints', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads'))
    const first = policy.snapshot()
    const second = policy.snapshot()
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.revisionWatermark)).toBe(true)
  })

  it('changes fingerprint when scheduling facts change', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    const idle = policy.snapshot().fingerprint
    policy.enqueue(request('roads'))
    expect(policy.snapshot().fingerprint).not.toBe(idle)
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisLayerRefreshPolicy(budget)
    policy.enqueue(request('roads'))
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.enqueue(request('buildings'))).toThrow('disposed')
  })
})
