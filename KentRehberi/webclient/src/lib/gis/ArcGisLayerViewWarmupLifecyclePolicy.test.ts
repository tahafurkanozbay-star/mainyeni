import { describe, expect, it } from 'vitest'
import { ArcGisLayerViewWarmupLifecyclePolicy, type ArcGisLayerViewWarmupBudget, type ArcGisLayerViewWarmupRequest } from './ArcGisLayerViewWarmupLifecyclePolicy'

const budget: ArcGisLayerViewWarmupBudget = {
  maxViews: 2,
  maxJobs: 6,
  maxJobsPerView: 4,
  maxWarming: 2,
  maxWarmingPerView: 1,
  maxReady: 3,
  maxReadyPerView: 2,
  maxEstimatedBytesPerJob: 100,
  maxActualBytesPerJob: 120,
  maxAggregateReadyBytes: 240,
  queueTtlMs: 20,
  warmLeaseMs: 30,
  readyTtlMs: 40,
}

const request = (overrides: Partial<ArcGisLayerViewWarmupRequest> = {}): ArcGisLayerViewWarmupRequest => ({
  viewId: 'map-2d',
  layerId: 'parcels',
  jobId: 'warm-1',
  revision: 1,
  intent: 'visible',
  requestedAt: 10,
  estimatedBytes: 60,
  scaleBucket: 12,
  is3d: false,
  ...overrides,
})

describe('ArcGisLayerViewWarmupLifecyclePolicy', () => {
  it('validates mutually consistent budgets', () => {
    expect(() => new ArcGisLayerViewWarmupLifecyclePolicy({ ...budget, maxJobsPerView: 7 })).toThrow(RangeError)
    expect(() => new ArcGisLayerViewWarmupLifecyclePolicy({ ...budget, maxWarming: 7 })).toThrow(RangeError)
    expect(() => new ArcGisLayerViewWarmupLifecyclePolicy({ ...budget, maxWarmingPerView: 3 })).toThrow(RangeError)
    expect(() => new ArcGisLayerViewWarmupLifecyclePolicy({ ...budget, maxReady: 7 })).toThrow(RangeError)
    expect(() => new ArcGisLayerViewWarmupLifecyclePolicy({ ...budget, maxReadyPerView: 4 })).toThrow(RangeError)
    expect(() => new ArcGisLayerViewWarmupLifecyclePolicy({ ...budget, maxActualBytesPerJob: 241 })).toThrow(RangeError)
  })

  it('rejects malformed identifiers and scalar fields', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ viewId: ' ' }))).toThrow()
    expect(() => policy.enqueue(request({ layerId: '<script>' }))).toThrow()
    expect(() => policy.enqueue(request({ jobId: 'a'.repeat(161) }))).toThrow()
    expect(() => policy.enqueue(request({ revision: -1 }))).toThrow(RangeError)
    expect(() => policy.enqueue(request({ requestedAt: Number.NaN }))).toThrow(RangeError)
    expect(() => policy.enqueue(request({ estimatedBytes: -1 }))).toThrow(RangeError)
    expect(() => policy.enqueue(request({ scaleBucket: -1 }))).toThrow(RangeError)
  })

  it('rejects estimates above the warmup admission budget', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request({ estimatedBytes: 101 }))).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('orders queued work by intent before age', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request({ jobId: 'background', intent: 'background', requestedAt: 1 }))).toBe(true)
    expect(policy.enqueue(request({ jobId: 'interactive', intent: 'interactive', requestedAt: 3 }))).toBe(true)
    expect(policy.takeNext(4)?.jobId).toBe('interactive')
  })

  it('uses request age and sequence as deterministic tie breakers', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request({ jobId: 'later', requestedAt: 3 }))).toBe(true)
    expect(policy.enqueue(request({ jobId: 'earlier', requestedAt: 2 }))).toBe(true)
    expect(policy.takeNext(4)?.jobId).toBe('earlier')
  })

  it('limits concurrent warming globally', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy({ ...budget, maxWarming: 1 })
    expect(policy.enqueue(request({ jobId: 'a' }))).toBe(true)
    expect(policy.enqueue(request({ viewId: 'scene-3d', layerId: 'buildings', jobId: 'b', is3d: true }))).toBe(true)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.takeNext(12)).toBeUndefined()
  })

  it('limits concurrent warming per view while allowing another view', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request({ jobId: 'a', intent: 'interactive' }))).toBe(true)
    expect(policy.enqueue(request({ layerId: 'roads', jobId: 'b', intent: 'visible' }))).toBe(true)
    expect(policy.enqueue(request({ viewId: 'scene-3d', layerId: 'buildings', jobId: 'c', intent: 'background', is3d: true }))).toBe(true)
    expect(policy.takeNext(11)?.jobId).toBe('a')
    expect(policy.takeNext(12)?.jobId).toBe('c')
  })

  it('invalidates older work when a layer-view revision advances', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request({ jobId: 'old', revision: 1 }))).toBe(true)
    expect(policy.enqueue(request({ jobId: 'new', revision: 2 }))).toBe(true)
    expect(policy.snapshot().map(entry => entry.jobId)).toEqual(['new'])
    expect(policy.enqueue(request({ jobId: 'stale', revision: 1 }))).toBe(false)
  })

  it('keeps revisions independent across views and layers', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request({ revision: 4 }))).toBe(true)
    expect(policy.enqueue(request({ viewId: 'scene-3d', jobId: 'scene', revision: 1, is3d: true }))).toBe(true)
    expect(policy.enqueue(request({ layerId: 'roads', jobId: 'roads', revision: 1 }))).toBe(true)
    expect(policy.snapshot()).toHaveLength(3)
  })

  it('allows same-revision promotion but rejects equal or weaker duplicates', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request({ intent: 'background' }))).toBe(true)
    expect(policy.enqueue(request({ intent: 'visible' }))).toBe(true)
    expect(policy.enqueue(request({ intent: 'visible' }))).toBe(false)
    expect(policy.enqueue(request({ intent: 'background' }))).toBe(false)
    expect(policy.enqueue(request({ intent: 'interactive' }))).toBe(true)
    expect(policy.snapshot()[0]?.intent).toBe('interactive')
  })

  it('expires queued work before scheduling', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request({ requestedAt: 1 }))).toBe(true)
    expect(policy.takeNext(21)).toBeUndefined()
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects late completion after build lease expiry', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('map-2d', 'parcels', 'warm-1', 1, 60, 41)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects completion with mismatched revision', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('map-2d', 'parcels', 'warm-1', 2, 60, 12)).toBe(false)
    expect(policy.snapshot()[0]?.phase).toBe('warming')
  })

  it('reconciles actual bytes and rejects oversized output', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('map-2d', 'parcels', 'warm-1', 1, 121, 12)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('records actual bytes rather than estimates', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request({ estimatedBytes: 90 }))).toBe(true)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('map-2d', 'parcels', 'warm-1', 1, 30, 12)).toBe(true)
    expect(policy.snapshot()[0]?.actualBytes).toBe(30)
  })

  it('cleans expired ready residency before completion admission', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy({ ...budget, maxReady: 1, maxReadyPerView: 1 })
    expect(policy.enqueue(request({ jobId: 'old', requestedAt: 1 }))).toBe(true)
    expect(policy.takeNext(2)).toBeDefined()
    expect(policy.complete('map-2d', 'parcels', 'old', 1, 100, 3)).toBe(true)
    expect(policy.enqueue(request({ jobId: 'fresh', requestedAt: 42 }))).toBe(true)
    expect(policy.takeNext(43)).toBeDefined()
    expect(policy.complete('map-2d', 'parcels', 'fresh', 1, 100, 44)).toBe(true)
    expect(policy.snapshot().map(entry => entry.jobId)).toEqual(['fresh'])
  })

  it('evicts background residency before visible and interactive residency', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy({ ...budget, maxReady: 2, maxReadyPerView: 2, maxAggregateReadyBytes: 180 })
    for (const [jobId, intent] of [['interactive', 'interactive'], ['background', 'background']] as const) {
      expect(policy.enqueue(request({ jobId, intent, estimatedBytes: 60 }))).toBe(true)
      expect(policy.takeNext(11)).toBeDefined()
      expect(policy.complete('map-2d', 'parcels', jobId, 1, 60, 12)).toBe(true)
    }
    expect(policy.enqueue(request({ viewId: 'scene-3d', layerId: 'buildings', jobId: 'new', intent: 'visible', requestedAt: 13, is3d: true }))).toBe(true)
    expect(policy.takeNext(14)).toBeDefined()
    expect(policy.complete('scene-3d', 'buildings', 'new', 1, 100, 15)).toBe(true)
    expect(policy.snapshot().map(entry => entry.jobId)).toEqual(['interactive', 'new'])
  })

  it('uses last-access time as an eviction tie breaker', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy({ ...budget, maxReady: 2, maxReadyPerView: 2 })
    for (const jobId of ['a', 'b']) {
      expect(policy.enqueue(request({ jobId, requestedAt: 1 }))).toBe(true)
      expect(policy.takeNext(2)).toBeDefined()
      expect(policy.complete('map-2d', 'parcels', jobId, 1, 40, 3)).toBe(true)
    }
    expect(policy.touch('map-2d', 'parcels', 'a', 1, 4)).toBe(true)
    expect(policy.enqueue(request({ viewId: 'scene-3d', layerId: 'buildings', jobId: 'c', requestedAt: 5, is3d: true }))).toBe(true)
    expect(policy.takeNext(6)).toBeDefined()
    expect(policy.complete('scene-3d', 'buildings', 'c', 1, 40, 7)).toBe(true)
    expect(policy.snapshot().map(entry => entry.jobId)).toEqual(['a', 'c'])
  })

  it('enforces aggregate ready byte budget', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy({ ...budget, maxAggregateReadyBytes: 120 })
    expect(policy.enqueue(request({ jobId: 'a' }))).toBe(true)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('map-2d', 'parcels', 'a', 1, 100, 12)).toBe(true)
    expect(policy.enqueue(request({ viewId: 'scene-3d', layerId: 'buildings', jobId: 'b', is3d: true }))).toBe(true)
    expect(policy.takeNext(13)).toBeDefined()
    expect(policy.complete('scene-3d', 'buildings', 'b', 1, 100, 14)).toBe(true)
    expect(policy.snapshot().map(entry => entry.jobId)).toEqual(['b'])
  })

  it('touch refuses expired ready work without extending it', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('map-2d', 'parcels', 'warm-1', 1, 50, 12)).toBe(true)
    expect(policy.touch('map-2d', 'parcels', 'warm-1', 1, 52)).toBe(false)
  })

  it('consume only removes matching ready work', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.consume('map-2d', 'parcels', 'warm-1', 1)).toBe(false)
    expect(policy.takeNext(11)).toBeDefined()
    expect(policy.complete('map-2d', 'parcels', 'warm-1', 1, 50, 12)).toBe(true)
    expect(policy.consume('map-2d', 'parcels', 'warm-1', 2)).toBe(false)
    expect(policy.consume('map-2d', 'parcels', 'warm-1', 1)).toBe(true)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('cancel removes matching work in any phase', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.cancel('map-2d', 'parcels', 'warm-1', 2)).toBe(false)
    expect(policy.cancel('map-2d', 'parcels', 'warm-1', 1)).toBe(true)
  })

  it('releaseView tears down jobs and revision watermarks for that view', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request({ revision: 4 }))).toBe(true)
    expect(policy.enqueue(request({ viewId: 'scene-3d', jobId: 'scene', is3d: true }))).toBe(true)
    expect(policy.releaseView('map-2d')).toBe(1)
    expect(policy.enqueue(request({ jobId: 'fresh', revision: 1 }))).toBe(true)
    expect(policy.snapshot().map(entry => entry.jobId)).toEqual(['scene', 'fresh'])
  })

  it('produces detached frozen snapshots', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    const snapshot = policy.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[0])).toBe(true)
    expect(snapshot[0]).not.toBe(request())
  })

  it('produces a deterministic scalar fingerprint', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.fingerprint()).toContain('map-2d:parcels:warm-1:1:visible:queued:12:0:0')
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisLayerViewWarmupLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    policy.dispose()
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.enqueue(request())).toThrow('disposed')
  })
})
