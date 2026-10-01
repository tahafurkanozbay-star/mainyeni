import { describe, expect, it } from 'vitest'
import { ArcGisQueryCacheLifecyclePolicy, type ArcGisQueryCacheBudget, type ArcGisQueryCacheRequest } from './ArcGisQueryCacheLifecyclePolicy'

const budget: ArcGisQueryCacheBudget = {
  maxServices: 2, maxEntries: 4, maxEntriesPerService: 3, maxRunning: 2, maxReady: 2,
  maxEstimatedBytes: 800, maxEstimatedBytesPerEntry: 400, maxFeaturesPerEntry: 100,
  maxAggregateFeatures: 200, queueTtlMs: 100, runLeaseMs: 50, readyTtlMs: 200,
}
const request = (overrides: Partial<ArcGisQueryCacheRequest> = {}): ArcGisQueryCacheRequest => ({
  serviceId: 'parcels', queryKey: 'extent:1', revision: 1, intent: 'visible', requestedAt: 10,
  estimatedBytes: 100, estimatedFeatures: 20, spatialReferenceWkid: 3857, ...overrides,
})

describe('ArcGisQueryCacheLifecyclePolicy', () => {
  it('tracks bounded metadata only', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); expect(p.admit(request())).toBe(true); expect(p.snapshot()).toMatchObject({ services: 1, entries: 1, queued: 1, estimatedBytes: 100, estimatedFeatures: 20 }) })
  it('rejects malformed identifiers', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); expect(() => p.admit(request({ serviceId: ' ' }))).toThrow(); expect(() => p.admit(request({ queryKey: ' ' }))).toThrow() })
  it('rejects invalid revisions and clocks', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); expect(() => p.admit(request({ revision: -1 }))).toThrow(); expect(() => p.admit(request({ requestedAt: Number.NaN }))).toThrow() })
  it('validates WKID metadata', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); expect(() => p.admit(request({ spatialReferenceWkid: 0 }))).toThrow(); expect(p.admit(request({ spatialReferenceWkid: 4326 }))).toBe(true) })
  it('enforces per-entry byte budget', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); expect(p.admit(request({ estimatedBytes: 401 }))).toBe(false) })
  it('enforces per-entry feature budget', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); expect(p.admit(request({ estimatedFeatures: 101 }))).toBe(false) })
  it('enforces aggregate byte budget', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); expect(p.admit(request({ queryKey: 'a', estimatedBytes: 400 }))).toBe(true); expect(p.admit(request({ queryKey: 'b', estimatedBytes: 400 }))).toBe(true); expect(p.admit(request({ queryKey: 'c', estimatedBytes: 1 }))).toBe(false) })
  it('enforces aggregate feature budget', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); expect(p.admit(request({ queryKey: 'a', estimatedFeatures: 100 }))).toBe(true); expect(p.admit(request({ queryKey: 'b', estimatedFeatures: 100 }))).toBe(true); expect(p.admit(request({ queryKey: 'c', estimatedFeatures: 1 }))).toBe(false) })
  it('enforces service cardinality', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request({ serviceId: 'a' })); p.admit(request({ serviceId: 'b', queryKey: 'b' })); expect(p.admit(request({ serviceId: 'c', queryKey: 'c' }))).toBe(false) })
  it('enforces per-service cardinality', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); for (let i = 0; i < 3; i += 1) expect(p.admit(request({ queryKey: `q${i}` }))).toBe(true); expect(p.admit(request({ queryKey: 'overflow' }))).toBe(false) })
  it('prioritizes interactive work deterministically', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request({ queryKey: 'prefetch', intent: 'prefetch' })); p.admit(request({ queryKey: 'interactive', intent: 'interactive' })); expect(p.next(20)?.queryKey).toBe('interactive') })
  it('bounds running concurrency', () => { const p = new ArcGisQueryCacheLifecyclePolicy({ ...budget, maxRunning: 1 }); p.admit(request({ queryKey: 'a' })); p.admit(request({ queryKey: 'b' })); expect(p.next(20)?.queryKey).toBe('a'); expect(p.next(21)).toBeNull() })
  it('completes running work into ready cache', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); p.next(20); expect(p.complete('parcels', 'extent:1', 1, 30)).toBe(true); expect(p.snapshot()).toMatchObject({ running: 0, ready: 1 }) })
  it('reconciles actual completion accounting', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); p.next(20); expect(p.complete('parcels', 'extent:1', 1, 30, 150, 25)).toBe(true); expect(p.snapshot()).toMatchObject({ estimatedBytes: 150, estimatedFeatures: 25 }) })
  it('rejects oversized actual payload accounting', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); p.next(20); expect(p.complete('parcels', 'extent:1', 1, 30, 401, 20)).toBe(false) })
  it('rejects stale completion revision', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); p.next(20); expect(p.complete('parcels', 'extent:1', 0, 30)).toBe(false) })
  it('rejects completion after run lease', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); p.next(20); expect(p.complete('parcels', 'extent:1', 1, 71)).toBe(false) })
  it('bounds ready cardinality', () => { const p = new ArcGisQueryCacheLifecyclePolicy({ ...budget, maxReady: 1 }); p.admit(request({ queryKey: 'a' })); p.admit(request({ queryKey: 'b' })); p.next(20); p.next(21); expect(p.complete('parcels', 'a', 1, 30)).toBe(true); expect(p.complete('parcels', 'b', 1, 31)).toBe(false) })
  it('touches only live ready entries', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); p.next(20); p.complete('parcels', 'extent:1', 1, 30); expect(p.touch('parcels', 'extent:1', 40)).toBe(true); expect(p.touch('parcels', 'extent:1', 241)).toBe(false) })
  it('invalidates older query revisions', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); expect(p.admit(request({ revision: 2, requestedAt: 20 }))).toBe(true); expect(p.snapshot().entries).toBe(1); expect(p.admit(request({ revision: 1, requestedAt: 30 }))).toBe(false) })
  it('invalidates service entries below revision floor', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request({ queryKey: 'a', revision: 1 })); p.admit(request({ queryKey: 'b', revision: 3 })); expect(p.invalidateService('parcels', 2)).toBe(1); expect(p.entriesForService('parcels').map(e => e.queryKey)).toEqual(['b']) })
  it('does not downgrade same-revision intent', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request({ intent: 'interactive' })); expect(p.admit(request({ intent: 'prefetch' }))).toBe(false) })
  it('allows same-revision promotion', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request({ intent: 'prefetch' })); expect(p.admit(request({ intent: 'interactive' }))).toBe(true); expect(p.entriesForService('parcels')[0]?.intent).toBe('interactive') })
  it('expires queued work', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); expect(p.expire(111)).toBe(1) })
  it('expires running work', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); p.next(20); expect(p.expire(71)).toBe(1) })
  it('expires ready residency', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); p.next(20); p.complete('parcels', 'extent:1', 1, 30); expect(p.expire(231)).toBe(1) })
  it('cancels individual work', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); expect(p.cancel('parcels', 'extent:1')).toBe(true); expect(p.snapshot().entries).toBe(0) })
  it('releases service metadata and watermarks', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request({ queryKey: 'a' })); p.admit(request({ queryKey: 'b' })); expect(p.releaseService('parcels')).toBe(2); expect(p.snapshot()).toMatchObject({ services: 0, entries: 0, revisionWatermark: {} }) })
  it('returns immutable deterministic service ordering', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request({ queryKey: 'a', intent: 'prefetch' })); p.admit(request({ queryKey: 'b', intent: 'interactive' })); const entries = p.entriesForService('parcels'); expect(entries.map(e => e.queryKey)).toEqual(['b', 'a']); expect(Object.isFrozen(entries)).toBe(true) })
  it('produces deterministic fingerprints', () => { const a = new ArcGisQueryCacheLifecyclePolicy(budget); const b = new ArcGisQueryCacheLifecyclePolicy(budget); a.admit(request()); b.admit(request()); expect(a.snapshot().fingerprint).toBe(b.snapshot().fingerprint) })
  it('fails closed after disposal', () => { const p = new ArcGisQueryCacheLifecyclePolicy(budget); p.admit(request()); p.dispose(); expect(() => p.snapshot()).toThrow(/disposed/); expect(() => p.admit(request())).toThrow(/disposed/) })
})
