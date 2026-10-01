import { describe, expect, it } from 'vitest'
import { ArcGisProjectionCacheLifecyclePolicy, type ArcGisProjectionCacheBudget, type ArcGisProjectionRequest } from './ArcGisProjectionCacheLifecyclePolicy'

const budget: ArcGisProjectionCacheBudget = {
  maxEntries: 4,
  maxEntriesPerView: 3,
  maxRunning: 1,
  maxReady: 2,
  maxVerticesPerEntry: 100,
  maxBytesPerEntry: 600,
  maxAggregateVertices: 250,
  maxAggregateBytes: 1_200,
  queueTtlMs: 100,
  runLeaseMs: 50,
  readyTtlMs: 200,
}

function request(overrides: Partial<ArcGisProjectionRequest> = {}): ArcGisProjectionRequest {
  return { viewId: 'map', projectionKey: 'selection', revision: 1, intent: 'visible', requestedAt: 10, vertices: 50, estimatedBytes: 200, inputWkid: 4326, outputWkid: 3857, ...overrides }
}

describe('ArcGisProjectionCacheLifecyclePolicy', () => {
  it('rejects invalid and inconsistent budgets', () => {
    expect(() => new ArcGisProjectionCacheLifecyclePolicy({ ...budget, maxEntries: 0 })).toThrow(/maxEntries/)
    expect(() => new ArcGisProjectionCacheLifecyclePolicy({ ...budget, maxEntriesPerView: 5 })).toThrow(/maxEntriesPerView/)
    expect(() => new ArcGisProjectionCacheLifecyclePolicy({ ...budget, maxRunning: 5 })).toThrow(/phase limits/)
    expect(() => new ArcGisProjectionCacheLifecyclePolicy({ ...budget, maxVerticesPerEntry: 251 })).toThrow(/vertex budget/)
    expect(() => new ArcGisProjectionCacheLifecyclePolicy({ ...budget, maxBytesPerEntry: 1201 })).toThrow(/byte budget/)
  })

  it('validates request identity, revision, accounting and spatial references', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    expect(() => policy.admit(request({ viewId: ' ' }))).toThrow(/viewId/)
    expect(() => policy.admit(request({ projectionKey: ' ' }))).toThrow(/projectionKey/)
    expect(() => policy.admit(request({ revision: -1 }))).toThrow(/revision/)
    expect(() => policy.admit(request({ requestedAt: Number.NaN }))).toThrow(/requestedAt/)
    expect(() => policy.admit(request({ vertices: 1.5 }))).toThrow(/vertices/)
    expect(() => policy.admit(request({ estimatedBytes: -1 }))).toThrow(/estimatedBytes/)
    expect(() => policy.admit(request({ inputWkid: 0 }))).toThrow(/inputWkid/)
    expect(() => policy.admit(request({ outputWkid: 0 }))).toThrow(/outputWkid/)
  })

  it('rejects identity projections and oversized entries without retention', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    expect(policy.admit(request({ outputWkid: 4326 }))).toBe(false)
    expect(policy.admit(request({ vertices: 101 }))).toBe(false)
    expect(policy.admit(request({ estimatedBytes: 601 }))).toBe(false)
    expect(policy.snapshot().entries).toBe(0)
  })

  it('bounds aggregate vertex and byte residency', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    expect(policy.admit(request({ projectionKey: 'a', vertices: 100, estimatedBytes: 600 }))).toBe(true)
    expect(policy.admit(request({ projectionKey: 'b', vertices: 100, estimatedBytes: 600 }))).toBe(true)
    expect(policy.admit(request({ projectionKey: 'c', vertices: 1, estimatedBytes: 1 }))).toBe(false)
  })

  it('bounds global and per-view cardinality', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    expect(policy.admit(request({ projectionKey: 'a' }))).toBe(true)
    expect(policy.admit(request({ projectionKey: 'b' }))).toBe(true)
    expect(policy.admit(request({ projectionKey: 'c' }))).toBe(true)
    expect(policy.admit(request({ projectionKey: 'd' }))).toBe(false)
    expect(policy.admit(request({ viewId: 'scene', projectionKey: 'd' }))).toBe(true)
    expect(policy.admit(request({ viewId: 'third', projectionKey: 'e' }))).toBe(false)
  })

  it('schedules interactive before visible and background work', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy({ ...budget, maxEntriesPerView: 4 })
    policy.admit(request({ projectionKey: 'a', intent: 'background' }))
    policy.admit(request({ projectionKey: 'b', intent: 'visible' }))
    policy.admit(request({ projectionKey: 'c', intent: 'interactive' }))
    expect(policy.next(20)?.projectionKey).toBe('c')
  })

  it('preserves FIFO ordering inside one intent class', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy({ ...budget, maxRunning: 2 })
    policy.admit(request({ projectionKey: 'a', requestedAt: 10 }))
    policy.admit(request({ projectionKey: 'b', requestedAt: 11 }))
    expect(policy.next(20)?.projectionKey).toBe('a')
    expect(policy.next(21)?.projectionKey).toBe('b')
  })

  it('does not exceed running cardinality', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request({ projectionKey: 'a' })); policy.admit(request({ projectionKey: 'b' }))
    expect(policy.next(20)?.projectionKey).toBe('a')
    expect(policy.next(21)).toBeNull()
  })

  it('expires queued work before scheduling', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.next(111)).toBeNull()
    expect(policy.snapshot().entries).toBe(0)
  })

  it('rejects stale completion after run lease expiry', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20)
    expect(policy.complete('map', 'selection', 1, 71, 200)).toBe(false)
  })

  it('requires exact revision and running phase for completion', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.complete('map', 'selection', 1, 20, 200)).toBe(false)
    policy.next(20)
    expect(policy.complete('map', 'selection', 2, 21, 200)).toBe(false)
    expect(policy.complete('map', 'selection', 1, 21, 200)).toBe(true)
  })

  it('reconciles actual byte accounting', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request({ projectionKey: 'a', estimatedBytes: 200 }))
    policy.admit(request({ projectionKey: 'b', estimatedBytes: 600 }))
    policy.next(20)
    expect(policy.complete('map', 'a', 1, 21, 500)).toBe(true)
    expect(policy.snapshot().bytes).toBe(1100)
  })

  it('rejects actual byte residency above per-entry or aggregate budget', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request({ projectionKey: 'a', estimatedBytes: 100 })); policy.next(20)
    expect(policy.complete('map', 'a', 1, 21, 601)).toBe(false)
    const constrained = new ArcGisProjectionCacheLifecyclePolicy({ ...budget, maxAggregateBytes: 700 })
    constrained.admit(request({ projectionKey: 'a', estimatedBytes: 100 })); constrained.admit(request({ projectionKey: 'b', estimatedBytes: 200 })); constrained.next(20)
    expect(constrained.complete('map', 'a', 1, 21, 600)).toBe(false)
  })

  it('bounds ready residency', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy({ ...budget, maxRunning: 3, maxReady: 1 })
    policy.admit(request({ projectionKey: 'a' })); policy.admit(request({ projectionKey: 'b' })); policy.next(20); policy.next(20)
    expect(policy.complete('map', 'a', 1, 21, 200)).toBe(true)
    expect(policy.complete('map', 'b', 1, 21, 200)).toBe(false)
  })

  it('consumes only exact ready revisions', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20); policy.complete('map', 'selection', 1, 21, 200)
    expect(policy.consume('map', 'selection', 2)).toBe(false)
    expect(policy.consume('map', 'selection', 1)).toBe(true)
    expect(policy.snapshot().entries).toBe(0)
  })

  it('invalidates older work when view revision advances', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request({ projectionKey: 'a', revision: 1 })); policy.admit(request({ projectionKey: 'b', revision: 1 }))
    expect(policy.invalidateView('map', 2)).toBe(2)
    expect(policy.admit(request({ revision: 1 }))).toBe(false)
    expect(policy.admit(request({ revision: 2 }))).toBe(true)
  })

  it('automatically invalidates sibling work on a newer revision', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request({ projectionKey: 'a', revision: 1 })); policy.admit(request({ projectionKey: 'b', revision: 1 }))
    expect(policy.admit(request({ projectionKey: 'c', revision: 2 }))).toBe(true)
    expect(policy.entriesForView('map').map(entry => entry.projectionKey)).toEqual(['c'])
  })

  it('prevents priority downgrade and permits duplicate escalation', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'interactive' }))).toBe(true)
    expect(policy.admit(request({ intent: 'background' }))).toBe(false)
    expect(policy.admit(request({ intent: 'interactive', requestedAt: 12 }))).toBe(true)
    expect(policy.entriesForView('map')).toHaveLength(1)
  })

  it('cancels one entry without disturbing siblings', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request({ projectionKey: 'a' })); policy.admit(request({ projectionKey: 'b' }))
    expect(policy.cancel('map', 'a')).toBe(true)
    expect(policy.entriesForView('map').map(entry => entry.projectionKey)).toEqual(['b'])
  })

  it('releases a view and its revision watermark', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request({ projectionKey: 'a' })); policy.admit(request({ projectionKey: 'b' }))
    expect(policy.releaseView('map')).toBe(2)
    expect(policy.snapshot().revisionWatermark).toEqual({})
  })

  it('expires ready residency independently of queue TTL', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20); policy.complete('map', 'selection', 1, 21, 200)
    expect(policy.expire(221)).toBe(0)
    expect(policy.expire(222)).toBe(1)
  })

  it('returns immutable ordered views and deterministic fingerprints', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request({ projectionKey: 'b' })); policy.admit(request({ projectionKey: 'a' }))
    const entries = policy.entriesForView('map')
    expect(entries.map(entry => entry.projectionKey)).toEqual(['b', 'a'])
    expect(Object.isFrozen(entries)).toBe(true)
    expect(policy.fingerprint()).toContain('map:a:1')
    expect(policy.fingerprint()).toContain('map:b:1')
  })

  it('disposes fail-closed and clears all accounting', () => {
    const policy = new ArcGisProjectionCacheLifecyclePolicy(budget)
    policy.admit(request())
    policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.admit(request())).toThrow(/disposed/)
  })
})
