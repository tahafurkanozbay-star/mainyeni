import { describe, expect, it } from 'vitest'
import { ArcGisFeaturePageCachePolicy, type ArcGisFeaturePageCacheBudget } from './ArcGisFeaturePageCachePolicy'

const budget: ArcGisFeaturePageCacheBudget = {
  maxEntries: 3,
  maxEntriesPerLayer: 2,
  maxObjectIdsPerPage: 100,
  maxBytesPerPage: 1_000,
  maxAggregateBytes: 2_000,
  ttlMs: 100,
}

const page = (overrides: Partial<Parameters<ArcGisFeaturePageCachePolicy['put']>[0]> = {}) => ({
  layerId: 'parcels', pageKey: 'page-1', revision: 1, intent: 'visible' as const,
  objectIdCount: 25, byteSize: 400, storedAt: 10, fingerprint: 'fp-1', ...overrides,
})

describe('ArcGisFeaturePageCachePolicy', () => {
  it('admits bounded scalar metadata and returns detached descriptors', () => {
    const cache = new ArcGisFeaturePageCachePolicy(budget)
    expect(cache.put(page())).toBe(true)
    const hit = cache.get('parcels', 'page-1', 1, 20)
    expect(hit?.byteSize).toBe(400)
    if (hit) hit.byteSize = 999
    expect(cache.get('parcels', 'page-1', 1, 21)?.byteSize).toBe(400)
  })

  it('invalidates all stale pages atomically when layer revision advances', () => {
    const cache = new ArcGisFeaturePageCachePolicy(budget)
    expect(cache.put(page())).toBe(true)
    expect(cache.put(page({ pageKey: 'page-2', fingerprint: 'fp-2' }))).toBe(true)
    expect(cache.put(page({ pageKey: 'page-3', revision: 2, fingerprint: 'fp-3' }))).toBe(true)
    expect(cache.snapshot().map(item => item.pageKey)).toEqual(['page-3'])
    expect(cache.get('parcels', 'page-1', 1, 30)).toBeUndefined()
  })

  it('rejects stale revisions without mutating current residency', () => {
    const cache = new ArcGisFeaturePageCachePolicy(budget)
    expect(cache.put(page({ revision: 2 }))).toBe(true)
    const before = cache.fingerprint()
    expect(cache.put(page({ pageKey: 'old', revision: 1 }))).toBe(false)
    expect(cache.fingerprint()).toBe(before)
  })

  it('does not destroy a valid replacement target when rejected by page limits', () => {
    const cache = new ArcGisFeaturePageCachePolicy(budget)
    expect(cache.put(page())).toBe(true)
    const before = cache.fingerprint()
    expect(cache.put(page({ objectIdCount: 101, fingerprint: 'oversize' }))).toBe(false)
    expect(cache.fingerprint()).toBe(before)
  })

  it('expires pages deterministically at the ttl boundary', () => {
    const cache = new ArcGisFeaturePageCachePolicy(budget)
    cache.put(page({ storedAt: 50 }))
    expect(cache.get('parcels', 'page-1', 1, 149)).toBeDefined()
    expect(cache.get('parcels', 'page-1', 1, 150)).toBeUndefined()
    expect(cache.snapshot()).toHaveLength(0)
  })

  it('purges expired residency before admission so dead pages cannot block capacity', () => {
    const cache = new ArcGisFeaturePageCachePolicy({ ...budget, maxEntries: 2, maxEntriesPerLayer: 2 })
    expect(cache.put(page({ pageKey: 'old-a', storedAt: 10, fingerprint: 'old-a' }))).toBe(true)
    expect(cache.put(page({ pageKey: 'old-b', storedAt: 11, fingerprint: 'old-b' }))).toBe(true)
    expect(cache.put(page({ pageKey: 'fresh', storedAt: 111, fingerprint: 'fresh' }))).toBe(true)
    expect(cache.snapshot().map(item => item.pageKey)).toEqual(['fresh'])
  })

  it('purges expired bytes before aggregate-byte admission', () => {
    const cache = new ArcGisFeaturePageCachePolicy({ ...budget, maxEntriesPerLayer: 3, maxAggregateBytes: 1_000 })
    expect(cache.put(page({ pageKey: 'old', byteSize: 1_000, storedAt: 10, fingerprint: 'old' }))).toBe(true)
    expect(cache.put(page({ pageKey: 'fresh', byteSize: 1_000, storedAt: 110, fingerprint: 'fresh' }))).toBe(true)
    expect(cache.snapshot()).toEqual([expect.objectContaining({ pageKey: 'fresh', byteSize: 1_000 })])
  })

  it('does not purge live residency one millisecond before the ttl boundary', () => {
    const cache = new ArcGisFeaturePageCachePolicy({ ...budget, maxEntries: 1, maxEntriesPerLayer: 1 })
    expect(cache.put(page({ pageKey: 'live', storedAt: 10, fingerprint: 'live' }))).toBe(true)
    expect(cache.put(page({ pageKey: 'candidate', storedAt: 109, fingerprint: 'candidate' }))).toBe(false)
    expect(cache.snapshot().map(item => item.pageKey)).toEqual(['live'])
  })

  it('evicts background residency before visible residency for an interactive page', () => {
    const cache = new ArcGisFeaturePageCachePolicy({ ...budget, maxEntriesPerLayer: 3 })
    cache.put(page({ pageKey: 'visible', intent: 'visible', byteSize: 700, fingerprint: 'v' }))
    cache.put(page({ pageKey: 'background', intent: 'background', byteSize: 700, fingerprint: 'b' }))
    expect(cache.put(page({ pageKey: 'interactive', intent: 'interactive', byteSize: 900, fingerprint: 'i' }))).toBe(true)
    expect(cache.snapshot().map(item => item.pageKey)).toEqual(['visible', 'interactive'])
  })

  it('does not evict higher-priority residency for lower-priority pressure', () => {
    const cache = new ArcGisFeaturePageCachePolicy({ ...budget, maxEntriesPerLayer: 3 })
    cache.put(page({ pageKey: 'interactive', intent: 'interactive', byteSize: 1_000, fingerprint: 'i' }))
    cache.put(page({ pageKey: 'visible', intent: 'visible', byteSize: 1_000, fingerprint: 'v' }))
    const before = cache.fingerprint()
    expect(cache.put(page({ pageKey: 'background', intent: 'background', byteSize: 100, fingerprint: 'b' }))).toBe(false)
    expect(cache.fingerprint()).toBe(before)
  })

  it('uses access recency as a deterministic tie breaker', () => {
    const cache = new ArcGisFeaturePageCachePolicy({ ...budget, maxEntriesPerLayer: 3 })
    cache.put(page({ pageKey: 'old', intent: 'background', byteSize: 700, fingerprint: 'old' }))
    cache.put(page({ pageKey: 'recent', intent: 'background', byteSize: 700, storedAt: 11, fingerprint: 'recent' }))
    cache.get('parcels', 'recent', 1, 40)
    expect(cache.put(page({ pageKey: 'new', intent: 'visible', byteSize: 900, storedAt: 50, fingerprint: 'new' }))).toBe(true)
    expect(cache.snapshot().map(item => item.pageKey)).toEqual(['recent', 'new'])
  })

  it('enforces per-layer cardinality without evicting unrelated ownership', () => {
    const cache = new ArcGisFeaturePageCachePolicy(budget)
    cache.put(page({ pageKey: 'a' }))
    cache.put(page({ pageKey: 'b' }))
    expect(cache.put(page({ pageKey: 'c' }))).toBe(false)
    expect(cache.snapshot().map(item => item.pageKey)).toEqual(['a', 'b'])
  })

  it('releases one layer without disturbing another', () => {
    const cache = new ArcGisFeaturePageCachePolicy(budget)
    cache.put(page())
    cache.put(page({ layerId: 'roads', pageKey: 'r1', fingerprint: 'r' }))
    expect(cache.releaseLayer('parcels')).toBe(1)
    expect(cache.snapshot().map(item => item.layerId)).toEqual(['roads'])
  })

  it('fails closed for malformed identifiers and impossible budgets', () => {
    expect(() => new ArcGisFeaturePageCachePolicy({ ...budget, maxEntriesPerLayer: 4 })).toThrow()
    const cache = new ArcGisFeaturePageCachePolicy(budget)
    expect(() => cache.put(page({ layerId: 'bad:id' }))).toThrow()
    expect(() => cache.put(page({ byteSize: -1 }))).toThrow()
  })

  it('rejects oversized pages before any cache mutation', () => {
    const cache = new ArcGisFeaturePageCachePolicy(budget)
    expect(cache.put(page({ byteSize: 1_001 }))).toBe(false)
    expect(cache.snapshot()).toEqual([])
  })

  it('becomes unusable after disposal and drops residency', () => {
    const cache = new ArcGisFeaturePageCachePolicy(budget)
    cache.put(page())
    cache.dispose()
    expect(() => cache.snapshot()).toThrow(/disposed/)
    expect(() => cache.put(page())).toThrow(/disposed/)
  })
})
