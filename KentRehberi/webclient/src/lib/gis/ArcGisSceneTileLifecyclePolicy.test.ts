import { describe, expect, it } from 'vitest'
import { ArcGisSceneTileLifecyclePolicy, type ArcGisSceneTileBudget, type ArcGisSceneTileRequest } from './ArcGisSceneTileLifecyclePolicy'

const budget: ArcGisSceneTileBudget = {
  maxTiles: 6,
  maxTilesPerView: 4,
  maxLoading: 2,
  maxResident: 3,
  maxBytesPerTile: 1_000,
  maxTrianglesPerTile: 10_000,
  maxAggregateBytes: 4_000,
  maxAggregateTriangles: 30_000,
  queueTtlMs: 100,
  loadLeaseMs: 200,
  residentTtlMs: 300,
}

function request(overrides: Partial<ArcGisSceneTileRequest> = {}): ArcGisSceneTileRequest {
  return { viewId: 'view-a', layerId: 'buildings', tileKey: '0/0/0', revision: 1, intent: 'visible', requestedAt: 10, estimatedBytes: 500, estimatedTriangles: 4_000, level: 0, ...overrides }
}

describe('ArcGisSceneTileLifecyclePolicy', () => {
  it('admits bounded metadata without retaining SDK payloads', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    expect(policy.admit(request())).toBe(true)
    expect(policy.snapshot()).toEqual({ tiles: 1, queued: 1, loading: 0, resident: 0, bytes: 500, triangles: 4_000 })
    expect(policy.entriesForView('view-a')[0]).toEqual(expect.objectContaining({ tileKey: '0/0/0', phase: 'queued' }))
  })

  it('rejects per-tile byte and triangle overflow', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    expect(policy.admit(request({ estimatedBytes: 1_001 }))).toBe(false)
    expect(policy.admit(request({ estimatedTriangles: 10_001 }))).toBe(false)
    expect(policy.snapshot().tiles).toBe(0)
  })

  it('rejects aggregate residency overflow', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy({ ...budget, maxAggregateBytes: 1_000 })
    expect(policy.admit(request({ tileKey: 'a', estimatedBytes: 600 }))).toBe(true)
    expect(policy.admit(request({ tileKey: 'b', estimatedBytes: 500 }))).toBe(false)
  })

  it('enforces per-view cardinality', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy({ ...budget, maxTilesPerView: 1 })
    expect(policy.admit(request({ tileKey: 'a' }))).toBe(true)
    expect(policy.admit(request({ tileKey: 'b' }))).toBe(false)
    expect(policy.admit(request({ viewId: 'view-b', tileKey: 'b' }))).toBe(true)
  })

  it('schedules interactive before visible before prefetch', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request({ tileKey: 'prefetch', intent: 'prefetch' }))
    policy.admit(request({ tileKey: 'visible', intent: 'visible' }))
    policy.admit(request({ tileKey: 'interactive', intent: 'interactive' }))
    expect(policy.next(20)?.tileKey).toBe('interactive')
    expect(policy.next(20)?.tileKey).toBe('visible')
  })

  it('uses coarser level as deterministic tie breaker', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request({ tileKey: 'fine', level: 8 }))
    policy.admit(request({ tileKey: 'coarse', level: 3 }))
    expect(policy.next(20)?.tileKey).toBe('coarse')
  })

  it('bounds concurrent loading', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy({ ...budget, maxLoading: 1 })
    policy.admit(request({ tileKey: 'a' })); policy.admit(request({ tileKey: 'b' }))
    expect(policy.next(20)?.tileKey).toBe('a')
    expect(policy.next(21)).toBeNull()
  })

  it('reconciles actual completion accounting', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20)
    expect(policy.complete('view-a', 'buildings', '0/0/0', 1, 30, 700, 5_000)).toBe(true)
    expect(policy.snapshot()).toEqual({ tiles: 1, queued: 0, loading: 0, resident: 1, bytes: 700, triangles: 5_000 })
  })

  it('rejects stale revision completion', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20)
    expect(policy.complete('view-a', 'buildings', '0/0/0', 2, 30, 500, 4_000)).toBe(false)
  })

  it('rejects completion after loading lease expires', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20)
    expect(policy.complete('view-a', 'buildings', '0/0/0', 1, 221, 500, 4_000)).toBe(false)
  })

  it('bounds resident cardinality', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy({ ...budget, maxResident: 1 })
    policy.admit(request({ tileKey: 'a' })); policy.admit(request({ tileKey: 'b' }))
    policy.next(20); policy.next(20)
    expect(policy.complete('view-a', 'buildings', 'a', 1, 30, 500, 4_000)).toBe(true)
    expect(policy.complete('view-a', 'buildings', 'b', 1, 30, 500, 4_000)).toBe(false)
  })

  it('rejects actual resource overflow at completion', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20)
    expect(policy.complete('view-a', 'buildings', '0/0/0', 1, 30, 1_001, 4_000)).toBe(false)
    expect(policy.complete('view-a', 'buildings', '0/0/0', 1, 30, 500, 10_001)).toBe(false)
  })

  it('touch extends only a live resident lease', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20); policy.complete('view-a', 'buildings', '0/0/0', 1, 30, 500, 4_000)
    expect(policy.touch('view-a', 'buildings', '0/0/0', 1, 100)).toBe(true)
    expect(policy.entriesForView('view-a')[0].expiresAt).toBe(400)
    expect(policy.touch('view-a', 'buildings', '0/0/0', 2, 110)).toBe(false)
  })

  it('expires queued work deterministically', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request({ requestedAt: 0 }))
    expect(policy.expire(100)).toBe(0)
    expect(policy.expire(101)).toBe(1)
  })

  it('invalidates older layer revisions', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request({ tileKey: 'a', revision: 1 }))
    expect(policy.admit(request({ tileKey: 'b', revision: 2 }))).toBe(true)
    expect(policy.entriesForView('view-a').map(item => item.tileKey)).toEqual(['b'])
    expect(policy.admit(request({ tileKey: 'c', revision: 1 }))).toBe(false)
  })

  it('does not let a lower-priority duplicate downgrade work', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'interactive' }))).toBe(true)
    expect(policy.admit(request({ intent: 'prefetch' }))).toBe(false)
    expect(policy.entriesForView('view-a')[0].intent).toBe('interactive')
  })

  it('allows a higher-priority duplicate to upgrade queued work', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'prefetch' }))).toBe(true)
    expect(policy.admit(request({ intent: 'interactive' }))).toBe(true)
    expect(policy.entriesForView('view-a')[0].intent).toBe('interactive')
  })

  it('releases a layer without disturbing sibling layers', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request({ layerId: 'a', tileKey: '1' })); policy.admit(request({ layerId: 'b', tileKey: '2' }))
    expect(policy.releaseLayer('view-a', 'a')).toBe(1)
    expect(policy.entriesForView('view-a').map(item => item.layerId)).toEqual(['b'])
  })

  it('releases all resources for a destroyed view', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request({ tileKey: '1' })); policy.admit(request({ tileKey: '2' })); policy.admit(request({ viewId: 'view-b', tileKey: '3' }))
    expect(policy.releaseView('view-a')).toBe(2)
    expect(policy.snapshot().tiles).toBe(1)
  })

  it('evicts an exact tile', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.evict('view-a', 'buildings', '0/0/0')).toBe(true)
    expect(policy.evict('view-a', 'buildings', '0/0/0')).toBe(false)
  })

  it('produces deterministic fingerprints independent of admission order', () => {
    const a = new ArcGisSceneTileLifecyclePolicy(budget); const b = new ArcGisSceneTileLifecyclePolicy(budget)
    a.admit(request({ tileKey: 'b' })); a.admit(request({ tileKey: 'a' }))
    b.admit(request({ tileKey: 'a' })); b.admit(request({ tileKey: 'b' }))
    expect(a.fingerprint()).toBe(b.fingerprint())
  })

  it('returns immutable public views', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request())
    expect(Object.isFrozen(policy.entriesForView('view-a'))).toBe(true)
    expect(Object.isFrozen(policy.entriesForView('view-a')[0])).toBe(true)
    expect(Object.isFrozen(policy.snapshot())).toBe(true)
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    policy.admit(request()); policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.admit(request())).toThrow('disposed')
  })

  it('validates inconsistent budgets', () => {
    expect(() => new ArcGisSceneTileLifecyclePolicy({ ...budget, maxTilesPerView: 7 })).toThrow()
    expect(() => new ArcGisSceneTileLifecyclePolicy({ ...budget, maxBytesPerTile: 5_000 })).toThrow()
    expect(() => new ArcGisSceneTileLifecyclePolicy({ ...budget, maxTrianglesPerTile: 40_000 })).toThrow()
  })

  it('validates request identifiers and numeric metadata', () => {
    const policy = new ArcGisSceneTileLifecyclePolicy(budget)
    expect(() => policy.admit(request({ viewId: ' ' }))).toThrow()
    expect(() => policy.admit(request({ level: -1 }))).toThrow()
    expect(() => policy.admit(request({ requestedAt: Number.NaN }))).toThrow()
  })
})
