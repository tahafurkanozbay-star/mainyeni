import { describe, expect, it } from 'vitest'
import { ArcGisLayerViewLifecyclePolicy, type ArcGisLayerViewBudget, type ArcGisLayerViewRequest } from './ArcGisLayerViewLifecyclePolicy'

const budget: ArcGisLayerViewBudget = {
  maxViews: 2, maxEntries: 4, maxEntriesPerView: 3, maxLoading: 2, maxReady: 2,
  maxEstimatedCpuBytes: 800, maxEstimatedGpuBytes: 600, maxEstimatedCpuBytesPerEntry: 400,
  maxEstimatedGpuBytesPerEntry: 300, queueTtlMs: 100, loadLeaseMs: 50, readyTtlMs: 200,
}
const request = (overrides: Partial<ArcGisLayerViewRequest> = {}): ArcGisLayerViewRequest => ({
  viewId: 'map', layerId: 'roads', revision: 1, intent: 'visible', requestedAt: 10,
  estimatedCpuBytes: 100, estimatedGpuBytes: 80, ...overrides,
})

describe('ArcGisLayerViewLifecyclePolicy', () => {
  it('admits bounded metadata without retaining SDK layer views', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); expect(p.admit(request())).toBe(true); expect(p.snapshot()).toMatchObject({ views: 1, entries: 1, queued: 1, estimatedCpuBytes: 100, estimatedGpuBytes: 80 }) })
  it('rejects malformed identifiers', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); expect(() => p.admit(request({ viewId: ' ' }))).toThrow(); expect(() => p.admit(request({ layerId: ' ' }))).toThrow() })
  it('rejects invalid revision and clock metadata', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); expect(() => p.admit(request({ revision: -1 }))).toThrow(); expect(() => p.admit(request({ requestedAt: Number.NaN }))).toThrow() })
  it('validates ArcGIS scale semantics', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); expect(() => p.admit(request({ minScale: 1000, maxScale: 5000 }))).toThrow(); expect(p.admit(request({ minScale: 5000, maxScale: 1000 }))).toBe(true) })
  it('enforces per-entry CPU and GPU budgets', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); expect(p.admit(request({ estimatedCpuBytes: 401 }))).toBe(false); expect(p.admit(request({ estimatedGpuBytes: 301 }))).toBe(false) })
  it('enforces aggregate CPU budget', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); expect(p.admit(request({ layerId: 'a', estimatedCpuBytes: 400 }))).toBe(true); expect(p.admit(request({ layerId: 'b', estimatedCpuBytes: 400 }))).toBe(true); expect(p.admit(request({ layerId: 'c', estimatedCpuBytes: 1 }))).toBe(false) })
  it('enforces aggregate GPU budget', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); expect(p.admit(request({ layerId: 'a', estimatedGpuBytes: 300 }))).toBe(true); expect(p.admit(request({ layerId: 'b', estimatedGpuBytes: 300 }))).toBe(true); expect(p.admit(request({ layerId: 'c', estimatedGpuBytes: 1 }))).toBe(false) })
  it('enforces view cardinality', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); expect(p.admit(request({ viewId: 'a' }))).toBe(true); expect(p.admit(request({ viewId: 'b', layerId: 'b' }))).toBe(true); expect(p.admit(request({ viewId: 'c', layerId: 'c' }))).toBe(false) })
  it('enforces per-view cardinality', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); for (let i = 0; i < 3; i += 1) expect(p.admit(request({ layerId: `l${i}` }))).toBe(true); expect(p.admit(request({ layerId: 'overflow' }))).toBe(false) })
  it('prefers interactive work deterministically', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request({ layerId: 'prefetch', intent: 'prefetch' })); p.admit(request({ layerId: 'interactive', intent: 'interactive' })); expect(p.next(20)?.layerId).toBe('interactive') })
  it('respects loading concurrency', () => { const p = new ArcGisLayerViewLifecyclePolicy({ ...budget, maxLoading: 1 }); p.admit(request({ layerId: 'a' })); p.admit(request({ layerId: 'b' })); expect(p.next(20)?.layerId).toBe('a'); expect(p.next(21)).toBeNull() })
  it('transitions loading work to ready', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request()); p.next(20); expect(p.complete('map', 'roads', 1, 30)).toBe(true); expect(p.snapshot()).toMatchObject({ loading: 0, ready: 1 }) })
  it('rejects stale completion revisions', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request()); p.next(20); expect(p.complete('map', 'roads', 0, 30)).toBe(false) })
  it('rejects completion after load lease', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request()); p.next(20); expect(p.complete('map', 'roads', 1, 71)).toBe(false) })
  it('bounds ready cardinality', () => { const p = new ArcGisLayerViewLifecyclePolicy({ ...budget, maxReady: 1 }); p.admit(request({ layerId: 'a' })); p.admit(request({ layerId: 'b' })); p.next(20); p.next(21); expect(p.complete('map', 'a', 1, 30)).toBe(true); expect(p.complete('map', 'b', 1, 31)).toBe(false) })
  it('touches only live ready entries', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request()); p.next(20); p.complete('map', 'roads', 1, 30); expect(p.touch('map', 'roads', 40)).toBe(true); expect(p.touch('map', 'roads', 241)).toBe(false) })
  it('invalidates old layer revisions', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request()); expect(p.admit(request({ revision: 2, requestedAt: 20 }))).toBe(true); expect(p.snapshot().entries).toBe(1); expect(p.admit(request({ revision: 1, requestedAt: 30 }))).toBe(false) })
  it('does not downgrade a stronger same-revision intent', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); expect(p.admit(request({ intent: 'interactive' }))).toBe(true); expect(p.admit(request({ intent: 'prefetch' }))).toBe(false) })
  it('allows same-revision promotion', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request({ intent: 'prefetch' })); expect(p.admit(request({ intent: 'interactive' }))).toBe(true); expect(p.entriesForView('map')[0]?.intent).toBe('interactive') })
  it('expires queued work', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request()); expect(p.expire(111)).toBe(1); expect(p.snapshot().entries).toBe(0) })
  it('expires loading leases', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request()); p.next(20); expect(p.expire(71)).toBe(1) })
  it('expires ready residency', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request()); p.next(20); p.complete('map', 'roads', 1, 30); expect(p.expire(231)).toBe(1) })
  it('cancels an individual layer view', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request()); expect(p.cancel('map', 'roads')).toBe(true); expect(p.snapshot().entries).toBe(0) })
  it('releases all resources for a destroyed view', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request({ layerId: 'a' })); p.admit(request({ layerId: 'b' })); expect(p.releaseView('map')).toBe(2); expect(p.snapshot()).toMatchObject({ views: 0, entries: 0 }) })
  it('returns immutable deterministic view ordering', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request({ layerId: 'a', intent: 'prefetch' })); p.admit(request({ layerId: 'b', intent: 'interactive' })); const entries = p.entriesForView('map'); expect(entries.map(e => e.layerId)).toEqual(['b', 'a']); expect(Object.isFrozen(entries)).toBe(true) })
  it('produces deterministic fingerprints', () => { const a = new ArcGisLayerViewLifecyclePolicy(budget); const b = new ArcGisLayerViewLifecyclePolicy(budget); a.admit(request()); b.admit(request()); expect(a.snapshot().fingerprint).toBe(b.snapshot().fingerprint) })
  it('fails closed after disposal', () => { const p = new ArcGisLayerViewLifecyclePolicy(budget); p.admit(request()); p.dispose(); expect(() => p.snapshot()).toThrow(/disposed/); expect(() => p.admit(request())).toThrow(/disposed/) })
})
