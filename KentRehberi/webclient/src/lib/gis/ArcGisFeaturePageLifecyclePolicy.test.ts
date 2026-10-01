import { describe, expect, it } from 'vitest'
import { ArcGisFeaturePageLifecyclePolicy, type ArcGisFeaturePageBudget, type ArcGisFeaturePageRequest } from './ArcGisFeaturePageLifecyclePolicy'

const budget: ArcGisFeaturePageBudget = {
  maxLayers: 2,
  maxPages: 4,
  maxPagesPerLayer: 3,
  maxRunning: 1,
  maxReady: 2,
  maxFeaturesPerPage: 100,
  maxAggregateFeatures: 250,
  maxBytesPerPage: 600,
  maxAggregateBytes: 1_200,
  queueTtlMs: 100,
  runLeaseMs: 50,
  readyTtlMs: 200,
}

function request(overrides: Partial<ArcGisFeaturePageRequest> = {}): ArcGisFeaturePageRequest {
  return { layerId: 'parcels', queryKey: 'extent-a', offset: 0, revision: 1, intent: 'visible', requestedAt: 10, estimatedFeatures: 50, estimatedBytes: 200, spatialReferenceWkid: 3857, ...overrides }
}

describe('ArcGisFeaturePageLifecyclePolicy', () => {
  it('rejects invalid and internally inconsistent budgets', () => {
    expect(() => new ArcGisFeaturePageLifecyclePolicy({ ...budget, maxLayers: 0 })).toThrow(/maxLayers/)
    expect(() => new ArcGisFeaturePageLifecyclePolicy({ ...budget, maxPagesPerLayer: 5 })).toThrow(/maxPagesPerLayer/)
    expect(() => new ArcGisFeaturePageLifecyclePolicy({ ...budget, maxRunning: 5 })).toThrow(/maxRunning/)
    expect(() => new ArcGisFeaturePageLifecyclePolicy({ ...budget, maxReady: 5 })).toThrow(/maxReady/)
    expect(() => new ArcGisFeaturePageLifecyclePolicy({ ...budget, maxFeaturesPerPage: 251 })).toThrow(/feature budget/)
    expect(() => new ArcGisFeaturePageLifecyclePolicy({ ...budget, maxBytesPerPage: 1_201 })).toThrow(/byte budget/)
  })

  it('validates identifiers, paging, revisions, accounting and WKID', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    expect(() => policy.admit(request({ layerId: ' ' }))).toThrow(/layerId/)
    expect(() => policy.admit(request({ queryKey: ' ' }))).toThrow(/queryKey/)
    expect(() => policy.admit(request({ offset: -1 }))).toThrow(/offset/)
    expect(() => policy.admit(request({ revision: -1 }))).toThrow(/revision/)
    expect(() => policy.admit(request({ requestedAt: Number.NaN }))).toThrow(/requestedAt/)
    expect(() => policy.admit(request({ estimatedFeatures: 1.5 }))).toThrow(/estimatedFeatures/)
    expect(() => policy.admit(request({ estimatedBytes: -1 }))).toThrow(/estimatedBytes/)
    expect(() => policy.admit(request({ spatialReferenceWkid: 0 }))).toThrow(/spatialReferenceWkid/)
  })

  it('rejects pages above per-page feature or byte budgets without retention', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    expect(policy.admit(request({ estimatedFeatures: 101 }))).toBe(false)
    expect(policy.admit(request({ estimatedBytes: 601 }))).toBe(false)
    expect(policy.snapshot().pages).toBe(0)
  })

  it('bounds aggregate feature and byte residency', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    expect(policy.admit(request({ offset: 0, estimatedFeatures: 100, estimatedBytes: 600 }))).toBe(true)
    expect(policy.admit(request({ offset: 100, estimatedFeatures: 100, estimatedBytes: 600 }))).toBe(true)
    expect(policy.admit(request({ offset: 200, estimatedFeatures: 1, estimatedBytes: 1 }))).toBe(false)
  })

  it('bounds layer and per-layer cardinality', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    expect(policy.admit(request({ offset: 0 }))).toBe(true)
    expect(policy.admit(request({ offset: 100 }))).toBe(true)
    expect(policy.admit(request({ offset: 200 }))).toBe(true)
    expect(policy.admit(request({ offset: 300 }))).toBe(false)
    expect(policy.admit(request({ layerId: 'roads', queryKey: 'all', offset: 0 }))).toBe(true)
    expect(policy.admit(request({ layerId: 'buildings', queryKey: 'all', offset: 0 }))).toBe(false)
  })

  it('schedules interactive before visible and prefetch work', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy({ ...budget, maxPagesPerLayer: 4, maxLayers: 4 })
    policy.admit(request({ layerId: 'a', intent: 'prefetch' }))
    policy.admit(request({ layerId: 'b', intent: 'visible' }))
    policy.admit(request({ layerId: 'c', intent: 'interactive' }))
    expect(policy.next(20)?.layerId).toBe('c')
  })

  it('preserves FIFO sequence inside an intent class', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy({ ...budget, maxRunning: 2 })
    policy.admit(request({ offset: 0, requestedAt: 10 }))
    policy.admit(request({ offset: 100, requestedAt: 11 }))
    expect(policy.next(20)?.offset).toBe(0)
    expect(policy.next(21)?.offset).toBe(100)
  })

  it('does not exceed running cardinality', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request({ offset: 0 })); policy.admit(request({ offset: 100 }))
    expect(policy.next(20)?.offset).toBe(0)
    expect(policy.next(21)).toBeNull()
  })

  it('expires queued pages before scheduling', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.next(111)).toBeNull()
    expect(policy.snapshot().pages).toBe(0)
  })

  it('rejects stale completion after the run lease', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20)
    expect(policy.complete('parcels', 'extent-a', 0, 1, 71)).toBe(false)
  })

  it('requires exact page revision and running phase for completion', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.complete('parcels', 'extent-a', 0, 1, 20)).toBe(false)
    policy.next(20)
    expect(policy.complete('parcels', 'extent-a', 0, 2, 21)).toBe(false)
    expect(policy.complete('parcels', 'extent-a', 0, 1, 21)).toBe(true)
  })

  it('reconciles actual result accounting against aggregate budgets', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request({ offset: 0, estimatedFeatures: 50, estimatedBytes: 200 }))
    policy.admit(request({ offset: 100, estimatedFeatures: 100, estimatedBytes: 600 }))
    policy.next(20)
    expect(policy.complete('parcels', 'extent-a', 0, 1, 21, 100, 600)).toBe(true)
    expect(policy.snapshot().estimatedFeatures).toBe(200)
    expect(policy.snapshot().estimatedBytes).toBe(1_200)
  })

  it('rejects actual values above per-page budgets', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20)
    expect(policy.complete('parcels', 'extent-a', 0, 1, 21, 101, 200)).toBe(false)
    expect(policy.complete('parcels', 'extent-a', 0, 1, 21, 50, 601)).toBe(false)
  })

  it('bounds ready residency', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy({ ...budget, maxRunning: 3, maxReady: 1 })
    policy.admit(request({ offset: 0 })); policy.admit(request({ offset: 100 })); policy.next(20); policy.next(20)
    expect(policy.complete('parcels', 'extent-a', 0, 1, 21)).toBe(true)
    expect(policy.complete('parcels', 'extent-a', 100, 1, 21)).toBe(false)
  })

  it('consumes only exact ready revisions', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20); policy.complete('parcels', 'extent-a', 0, 1, 21)
    expect(policy.consume('parcels', 'extent-a', 0, 2)).toBe(false)
    expect(policy.consume('parcels', 'extent-a', 0, 1)).toBe(true)
    expect(policy.snapshot().pages).toBe(0)
  })

  it('invalidates all older pages in a query family', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request({ offset: 0, revision: 1 })); policy.admit(request({ offset: 100, revision: 1 }))
    expect(policy.invalidateQuery('parcels', 'extent-a', 2)).toBe(2)
    expect(policy.admit(request({ offset: 0, revision: 1 }))).toBe(false)
    expect(policy.admit(request({ offset: 0, revision: 2 }))).toBe(true)
  })

  it('newer page revision automatically invalidates sibling pages from older query revision', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request({ offset: 0, revision: 1 })); policy.admit(request({ offset: 100, revision: 1 }))
    expect(policy.admit(request({ offset: 200, revision: 2 }))).toBe(true)
    expect(policy.entriesForQuery('parcels', 'extent-a').map(entry => entry.offset)).toEqual([200])
  })

  it('prevents lower-priority duplicate replacement and permits escalation', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'interactive' }))).toBe(true)
    expect(policy.admit(request({ intent: 'prefetch' }))).toBe(false)
    expect(policy.admit(request({ intent: 'interactive', requestedAt: 12 }))).toBe(true)
    expect(policy.entriesForQuery('parcels', 'extent-a')).toHaveLength(1)
  })

  it('cancels one page without disturbing sibling pages', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request({ offset: 0 })); policy.admit(request({ offset: 100 }))
    expect(policy.cancel('parcels', 'extent-a', 0)).toBe(true)
    expect(policy.entriesForQuery('parcels', 'extent-a').map(entry => entry.offset)).toEqual([100])
  })

  it('releases a layer and its revision watermarks', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request({ offset: 0 })); policy.admit(request({ offset: 100 }))
    expect(policy.releaseLayer('parcels')).toBe(2)
    expect(policy.snapshot().layers).toBe(0)
    expect(policy.snapshot().revisionWatermark).toEqual({})
  })

  it('expires ready residency independently of queue TTL', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20); policy.complete('parcels', 'extent-a', 0, 1, 21)
    expect(policy.expire(221)).toBe(0)
    expect(policy.expire(222)).toBe(1)
  })

  it('returns immutable query views ordered by offset', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request({ offset: 100 })); policy.admit(request({ offset: 0 }))
    const entries = policy.entriesForQuery('parcels', 'extent-a')
    expect(entries.map(entry => entry.offset)).toEqual([0, 100])
    expect(Object.isFrozen(entries)).toBe(true)
    expect(Object.isFrozen(entries[0])).toBe(true)
  })

  it('produces deterministic payload-free snapshots', () => {
    const left = new ArcGisFeaturePageLifecyclePolicy(budget)
    const right = new ArcGisFeaturePageLifecyclePolicy(budget)
    left.admit(request({ offset: 100 })); left.admit(request({ offset: 0 }))
    right.admit(request({ offset: 100 })); right.admit(request({ offset: 0 }))
    expect(left.snapshot().fingerprint).toBe(right.snapshot().fingerprint)
    expect(left.snapshot()).toEqual(right.snapshot())
  })

  it('accounts queued, running and ready phases exactly', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy({ ...budget, maxRunning: 2 })
    policy.admit(request({ offset: 0 })); policy.admit(request({ offset: 100 })); policy.admit(request({ offset: 200 }))
    policy.next(20); policy.next(20); policy.complete('parcels', 'extent-a', 0, 1, 21)
    expect(policy.snapshot()).toMatchObject({ pages: 3, queued: 1, running: 1, ready: 1 })
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisFeaturePageLifecyclePolicy(budget)
    policy.admit(request()); policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.admit(request())).toThrow(/disposed/)
    expect(() => policy.next(20)).toThrow(/disposed/)
  })
})
