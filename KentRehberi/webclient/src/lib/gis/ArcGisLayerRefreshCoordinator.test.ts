import { describe, expect, it } from 'vitest'
import { ArcGisLayerRefreshCoordinator, type ArcGisLayerRefreshBudget } from './ArcGisLayerRefreshCoordinator'

const budget: ArcGisLayerRefreshBudget = {
  maxJobs: 4, maxJobsPerLayer: 3, maxConcurrent: 2, maxConcurrentPerLayer: 1,
  maxReadyBytes: 1_000, maxReadyBytesPerLayer: 700, maxBytesPerJob: 500,
  queueLeaseMs: 100, loadingLeaseMs: 50, readyTtlMs: 200,
}
const request = (layerId: string, refreshKey: string, revision = 1, requestedAt = 0, intent: 'interactive' | 'visible' | 'background' = 'visible') => ({ layerId, refreshKey, revision, requestedAt, intent, estimatedBytes: 100 })

describe('ArcGisLayerRefreshCoordinator', () => {
  it('schedules interactive work before visible and background work', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget)
    expect(policy.enqueue(request('a', 'background', 1, 1, 'background'))).toBe(true)
    expect(policy.enqueue(request('b', 'visible', 1, 2, 'visible'))).toBe(true)
    expect(policy.enqueue(request('c', 'interactive', 1, 3, 'interactive'))).toBe(true)
    expect(policy.takeNext(4)?.refreshKey).toBe('interactive'); expect(policy.takeNext(4)?.refreshKey).toBe('visible')
  })

  it('enforces per-layer loading concurrency while allowing another layer', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget)
    policy.enqueue(request('a', 'one', 1, 1, 'interactive')); policy.enqueue(request('a', 'two', 1, 2, 'interactive')); policy.enqueue(request('b', 'three', 1, 3, 'visible'))
    expect(policy.takeNext(4)?.refreshKey).toBe('one'); expect(policy.takeNext(4)?.refreshKey).toBe('three'); expect(policy.takeNext(4)).toBeUndefined()
  })

  it('invalidates stale generations when a layer revision advances', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget)
    policy.enqueue(request('a', 'old-one', 1, 1)); policy.enqueue(request('a', 'old-two', 1, 2))
    expect(policy.enqueue(request('a', 'new', 2, 3))).toBe(true); expect(policy.snapshot().map(job => job.refreshKey)).toEqual(['new']); expect(policy.enqueue(request('a', 'stale', 1, 4))).toBe(false)
  })

  it('rejects late completion after loading lease and releases ownership', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget); policy.enqueue(request('a', 'page', 1, 0)); policy.takeNext(10)
    expect(policy.complete('a', 'page', 1, 10, 60)).toBe(false); expect(policy.snapshot()).toEqual([])
  })

  it('rejects completion for a superseded revision', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget); policy.enqueue(request('a', 'page', 1, 0)); policy.takeNext(1); policy.invalidateLayer('a', 2)
    expect(policy.complete('a', 'page', 1, 10, 2)).toBe(false)
  })

  it('reconciles actual ready bytes and enforces per-layer residency', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget); policy.enqueue(request('a', 'one', 1, 0)); policy.takeNext(1)
    expect(policy.complete('a', 'one', 1, 400, 2)).toBe(true); policy.enqueue(request('a', 'two', 1, 3)); policy.takeNext(4)
    expect(policy.complete('a', 'two', 1, 400, 5)).toBe(false); expect(policy.snapshot().map(job => job.refreshKey)).toEqual(['one'])
  })

  it('enforces aggregate ready residency across layers', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget)
    for (const [layer, key, at] of [['a', 'one', 0], ['b', 'two', 3]] as const) { policy.enqueue(request(layer, key, 1, at)); policy.takeNext(at + 1); expect(policy.complete(layer, key, 1, 500, at + 2)).toBe(true) }
    policy.enqueue(request('c', 'three', 1, 6)); policy.takeNext(7); expect(policy.complete('c', 'three', 1, 1, 8)).toBe(false)
  })

  it('expires stale ready residency before aggregate completion admission', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget)
    policy.enqueue(request('a', 'old', 1, 0)); policy.takeNext(1); expect(policy.complete('a', 'old', 1, 500, 2)).toBe(true)
    policy.enqueue(request('b', 'fresh', 1, 150)); policy.takeNext(151)
    expect(policy.complete('b', 'fresh', 1, 500, 202)).toBe(true)
    expect(policy.snapshot().map(job => job.refreshKey)).toEqual(['fresh'])
  })

  it('expires stale same-layer residency before per-layer completion admission', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget)
    policy.enqueue(request('a', 'old', 1, 0)); policy.takeNext(1); expect(policy.complete('a', 'old', 1, 500, 2)).toBe(true)
    policy.enqueue(request('a', 'fresh', 1, 150)); policy.takeNext(151)
    expect(policy.complete('a', 'fresh', 1, 500, 202)).toBe(true)
    expect(policy.snapshot().map(job => job.refreshKey)).toEqual(['fresh'])
  })

  it('consumes ready work exactly once', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget); policy.enqueue(request('a', 'page', 1, 0)); policy.takeNext(1); policy.complete('a', 'page', 1, 10, 2)
    expect(policy.consume('a', 'page', 1, 3)?.actualBytes).toBe(10); expect(policy.consume('a', 'page', 1, 3)).toBeUndefined()
  })

  it('expires queued, loading, and ready work at their distinct leases', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget); policy.enqueue(request('a', 'queued', 1, 0)); expect(policy.expire(100)).toBe(1)
    policy.enqueue(request('b', 'loading', 1, 101)); policy.takeNext(102); expect(policy.expire(152)).toBe(1)
    policy.enqueue(request('c', 'ready', 1, 153)); policy.takeNext(154); policy.complete('c', 'ready', 1, 10, 155); expect(policy.expire(355)).toBe(1)
  })

  it('keeps same-key replacement atomic when admission would fail', () => {
    const tight = new ArcGisLayerRefreshCoordinator({ ...budget, maxJobs: 2, maxJobsPerLayer: 1 }); expect(tight.enqueue(request('a', 'page', 1, 0))).toBe(true); expect(tight.enqueue(request('a', 'other', 1, 1))).toBe(false); expect(tight.snapshot().map(job => job.refreshKey)).toEqual(['page'])
  })

  it('bounds global and per-layer cardinality', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget); expect(policy.enqueue(request('a', '1', 1, 0))).toBe(true); expect(policy.enqueue(request('a', '2', 1, 1))).toBe(true); expect(policy.enqueue(request('a', '3', 1, 2))).toBe(true); expect(policy.enqueue(request('a', '4', 1, 3))).toBe(false); expect(policy.enqueue(request('b', '1', 1, 4))).toBe(true); expect(policy.enqueue(request('c', '1', 1, 5))).toBe(false)
  })

  it('returns detached snapshots that cannot mutate authority state', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget); policy.enqueue(request('a', 'page', 1, 0)); const external = policy.snapshot()[0]!; external.layerId = 'tampered'; external.actualBytes = 999; expect(policy.snapshot()[0]).toMatchObject({ layerId: 'a', actualBytes: 0 })
  })

  it('releases a layer without disturbing other layers', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget); policy.enqueue(request('a', 'one', 1, 0)); policy.enqueue(request('b', 'two', 1, 1)); expect(policy.releaseLayer('a')).toBe(1); expect(policy.snapshot().map(job => job.layerId)).toEqual(['b'])
  })

  it('fails closed on invalid identifiers, numbers, and oversized estimates', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget); expect(() => policy.enqueue({ ...request('', 'x'), layerId: ' ' })).toThrow(); expect(() => policy.enqueue({ ...request('a', 'x'), revision: 0 })).toThrow(); expect(() => policy.enqueue({ ...request('a', 'x'), estimatedBytes: 501 })).toThrow(); expect(() => policy.enqueue({ ...request('a', 'x'), requestedAt: Number.NaN })).toThrow()
  })

  it('validates internally coherent budgets', () => {
    expect(() => new ArcGisLayerRefreshCoordinator({ ...budget, maxJobsPerLayer: 5 })).toThrow(); expect(() => new ArcGisLayerRefreshCoordinator({ ...budget, maxConcurrentPerLayer: 3 })).toThrow(); expect(() => new ArcGisLayerRefreshCoordinator({ ...budget, maxReadyBytesPerLayer: 1_001 })).toThrow(); expect(() => new ArcGisLayerRefreshCoordinator({ ...budget, maxBytesPerJob: 701 })).toThrow()
  })

  it('disposal clears state and prevents reuse', () => {
    const policy = new ArcGisLayerRefreshCoordinator(budget); policy.enqueue(request('a', 'page', 1, 0)); policy.dispose(); policy.dispose(); expect(() => policy.snapshot()).toThrow('disposed'); expect(() => policy.enqueue(request('a', 'again', 1, 1))).toThrow('disposed')
  })
})
