import { describe, expect, it } from 'vitest'
import { ArcGisSpatialQueryLifecyclePolicy, type ArcGisSpatialQueryBudget, type ArcGisSpatialQueryRequest } from './ArcGisSpatialQueryLifecyclePolicy'

const budget: ArcGisSpatialQueryBudget = {
  maxQueries: 6, maxQueriesPerView: 4, maxRunning: 2, maxReady: 3,
  maxFeaturesPerQuery: 100, maxReadyFeatures: 200,
  maxBytesPerQuery: 10_000, maxReadyBytes: 20_000,
  queueTtlMs: 100, runTtlMs: 200, readyTtlMs: 300,
}
const request = (overrides: Partial<ArcGisSpatialQueryRequest> = {}): ArcGisSpatialQueryRequest => ({
  viewId: 'view-1', layerId: 'layer-1', queryId: 'query-1', revision: 1,
  intent: 'visible', estimatedFeatures: 25, estimatedBytes: 2_000, requestedAt: 10, ...overrides,
})

describe('ArcGisSpatialQueryLifecyclePolicy', () => {
  it('schedules interactive work before visible and background work', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request({ queryId: 'background', intent: 'background', requestedAt: 1 }))
    policy.enqueue(request({ queryId: 'visible', intent: 'visible', requestedAt: 2 }))
    policy.enqueue(request({ queryId: 'interactive', intent: 'interactive', requestedAt: 3 }))
    expect(policy.takeNext(10)?.queryId).toBe('interactive')
    expect(policy.takeNext(11)?.queryId).toBe('visible')
  })

  it('bounds running concurrency', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request({ queryId: 'a' })); policy.enqueue(request({ queryId: 'b' })); policy.enqueue(request({ queryId: 'c' }))
    expect(policy.takeNext(20)?.queryId).toBe('a')
    expect(policy.takeNext(20)?.queryId).toBe('b')
    expect(policy.takeNext(20)).toBeUndefined()
  })

  it('rejects duplicate authority without mutating existing work', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(() => policy.enqueue(request({ requestedAt: 11 }))).toThrow(/duplicate/)
    expect(policy.snapshot()).toHaveLength(1)
  })

  it('reconciles estimated residency to actual result size', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20)
    const ready = policy.complete(request(), 40, 4_000, 30)
    expect(ready.phase).toBe('ready'); expect(ready.actualFeatures).toBe(40); expect(ready.actualBytes).toBe(4_000)
  })

  it('rejects oversized actual results and releases failed authority', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20)
    expect(() => policy.complete(request(), 101, 4_000, 30)).toThrow(/result budget/)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds aggregate ready feature residency', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy({ ...budget, maxReadyFeatures: 120 })
    policy.enqueue(request({ queryId: 'a' })); policy.takeNext(20); policy.complete(request({ queryId: 'a' }), 80, 2_000, 30)
    policy.enqueue(request({ queryId: 'b' })); policy.takeNext(40)
    expect(() => policy.complete(request({ queryId: 'b' }), 50, 2_000, 50)).toThrow(/feature budget/)
  })

  it('bounds aggregate ready byte residency', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy({ ...budget, maxReadyBytes: 12_000 })
    policy.enqueue(request({ queryId: 'a' })); policy.takeNext(20); policy.complete(request({ queryId: 'a' }), 20, 8_000, 30)
    policy.enqueue(request({ queryId: 'b' })); policy.takeNext(40)
    expect(() => policy.complete(request({ queryId: 'b' }), 20, 5_000, 50)).toThrow(/byte budget/)
  })

  it('invalidates stale queued and running work when layer revision advances', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request({ queryId: 'queued', revision: 1 }))
    policy.enqueue(request({ queryId: 'running', revision: 1, intent: 'interactive' })); policy.takeNext(20)
    expect(policy.advanceLayerRevision('layer-1', 2)).toBe(2)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects a revision older than the layer watermark', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.advanceLayerRevision('layer-1', 5)
    expect(() => policy.enqueue(request({ revision: 4 }))).toThrow(/stale/)
  })

  it('rejects late completion after running lease expiry', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20)
    expect(() => policy.complete(request(), 10, 100, 221)).toThrow(/not running|expired/)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('expires queued work deterministically', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request({ requestedAt: 10 }))
    expect(policy.expire(111)).toBe(1); expect(policy.snapshot()).toHaveLength(0)
  })

  it('touches only ready residency', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request()); expect(policy.touch('view-1', 'layer-1', 'query-1', 20)).toBe(false)
    policy.takeNext(20); policy.complete(request(), 10, 100, 30)
    expect(policy.touch('view-1', 'layer-1', 'query-1', 40)).toBe(true)
    expect(policy.snapshot()[0].expiresAt).toBe(340)
  })

  it('consumes ready result ownership exactly once', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20); policy.complete(request(), 10, 100, 30)
    expect(policy.consume('view-1', 'layer-1', 'query-1')?.phase).toBe('ready')
    expect(policy.consume('view-1', 'layer-1', 'query-1')).toBeUndefined()
  })

  it('releases all work for a view without affecting another view', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request({ queryId: 'a' })); policy.enqueue(request({ viewId: 'view-2', queryId: 'b' }))
    expect(policy.releaseView('view-1')).toBe(1); expect(policy.snapshot().map(x => x.queryId)).toEqual(['b'])
  })

  it('releases layer state and its revision watermark', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.advanceLayerRevision('layer-1', 5); policy.enqueue(request({ revision: 5 }))
    expect(policy.releaseLayer('layer-1')).toBe(1)
    expect(() => policy.enqueue(request({ revision: 1, queryId: 'fresh' }))).not.toThrow()
  })

  it('enforces global and per-view cardinality', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy({ ...budget, maxQueries: 3, maxQueriesPerView: 2, maxRunning: 2, maxReady: 2 })
    policy.enqueue(request({ queryId: 'a' })); policy.enqueue(request({ queryId: 'b' }))
    expect(() => policy.enqueue(request({ queryId: 'c' }))).toThrow(/view spatial query capacity/)
    policy.enqueue(request({ viewId: 'view-2', queryId: 'c' }))
    expect(() => policy.enqueue(request({ viewId: 'view-3', queryId: 'd' }))).toThrow(/capacity exceeded/)
  })

  it('rejects unsafe identifiers before state mutation', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ queryId: 'bad\nquery' }))).toThrow(/queryId/)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects non-finite timestamps before state mutation', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ requestedAt: Number.NaN }))).toThrow(/requestedAt/)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects unsafe feature and byte estimates', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ estimatedFeatures: 0 }))).toThrow(/estimatedFeatures/)
    expect(() => policy.enqueue(request({ estimatedBytes: Number.MAX_SAFE_INTEGER }))).toThrow(/exceeds budget/)
  })

  it('validates impossible budgets fail closed', () => {
    expect(() => new ArcGisSpatialQueryLifecyclePolicy({ ...budget, maxQueriesPerView: 7 })).toThrow(/impossible/)
    expect(() => new ArcGisSpatialQueryLifecyclePolicy({ ...budget, maxRunning: 7 })).toThrow(/impossible/)
    expect(() => new ArcGisSpatialQueryLifecyclePolicy({ ...budget, maxReadyFeatures: 50 })).toThrow(/impossible/)
    expect(() => new ArcGisSpatialQueryLifecyclePolicy({ ...budget, queueTtlMs: 0 })).toThrow(/positive/)
  })

  it('returns detached frozen snapshots rather than mutable authority', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    const snapshot = policy.enqueue(request())
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot).not.toBe(policy.snapshot()[0])
  })

  it('produces deterministic payload-free fingerprints', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request({ queryId: 'b' })); policy.enqueue(request({ queryId: 'a' }))
    const fingerprint = policy.fingerprint()
    expect(fingerprint.indexOf('query-1')).toBe(-1)
    expect(fingerprint).toContain('a'); expect(fingerprint).toContain('b')
    expect(fingerprint).not.toContain('[object Object]')
  })

  it('disposes fail closed and releases all authority', () => {
    const policy = new ArcGisSpatialQueryLifecyclePolicy(budget)
    policy.enqueue(request()); policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.enqueue(request({ queryId: 'later' }))).toThrow(/disposed/)
    expect(() => policy.takeNext(20)).toThrow(/disposed/)
  })
})
