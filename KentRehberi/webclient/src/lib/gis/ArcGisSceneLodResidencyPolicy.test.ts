import { describe, expect, it } from 'vitest'
import { ArcGisSceneLodResidencyPolicy, type ArcGisSceneLodBudget } from './ArcGisSceneLodResidencyPolicy'

const budget: ArcGisSceneLodBudget = {
  maxTiles: 8, maxTilesPerView: 5, maxTilesPerLayer: 5,
  maxLoading: 2, maxLoadingPerView: 1, maxResident: 3,
  maxEstimatedTrianglesPerTile: 100, maxActualTrianglesPerTile: 200, maxResidentTriangles: 400,
  maxEstimatedBytesPerTile: 1000, maxActualBytesPerTile: 2000, maxResidentBytes: 4000,
  minLevel: 0, maxLevel: 12, queueTtlMs: 50, loadTtlMs: 50, residentTtlMs: 100,
}

const request = (tileId: string, overrides = {}) => ({
  tileId, viewId: 'view-1', layerId: 'scene-1', revision: 1, level: 4,
  intent: 'visible' as const, requestedAt: 10, estimatedTriangles: 50, estimatedBytes: 500, ...overrides,
})

const completion = (tileId: string, overrides = {}) => ({
  tileId, viewId: 'view-1', layerId: 'scene-1', revision: 1, level: 4,
  actualTriangles: 80, actualBytes: 800, completedAt: 20, ...overrides,
})

describe('ArcGisSceneLodResidencyPolicy', () => {
  it('schedules interactive and finer LOD work deterministically', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('background', { viewId: 'v1', intent: 'background', level: 8 }))
    policy.enqueue(request('visible', { viewId: 'v2', intent: 'visible', level: 4 }))
    policy.enqueue(request('interactive-coarse', { viewId: 'v3', intent: 'interactive', level: 3 }))
    policy.enqueue(request('interactive-fine', { viewId: 'v4', intent: 'interactive', level: 9 }))
    expect(policy.takeNext(11)?.tileId).toBe('interactive-fine')
    expect(policy.takeNext(11)?.tileId).toBe('interactive-coarse')
  })

  it('enforces per-view loading concurrency without starving other views', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('a', { viewId: 'same', intent: 'interactive' }))
    policy.enqueue(request('b', { viewId: 'same', intent: 'interactive' }))
    policy.enqueue(request('c', { viewId: 'other', intent: 'visible' }))
    expect(policy.takeNext(11)?.tileId).toBe('a')
    expect(policy.takeNext(11)?.tileId).toBe('c')
    expect(policy.takeNext(11)).toBeUndefined()
  })

  it('reconciles estimates to actual residency budgets', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('a'))
    policy.takeNext(11)
    expect(policy.complete(completion('a')).phase).toBe('resident')
    expect(policy.snapshot()[0]).toMatchObject({ actualTriangles: 80, actualBytes: 800 })
  })

  it('rejects actual work exceeding per-tile budgets and releases authority', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('a')); policy.takeNext(11)
    expect(() => policy.complete(completion('a', { actualTriangles: 201 }))).toThrow('actual triangle budget exceeded')
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects malformed identifiers and impossible LOD levels', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    expect(() => policy.enqueue(request('bad id'))).toThrow('tileId is invalid')
    expect(() => policy.enqueue(request('a', { level: 13 }))).toThrow('LOD level outside budget')
  })

  it('invalidates stale work when layer revision advances', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('old')); policy.takeNext(11)
    expect(policy.advanceLayerRevision('scene-1', 2)).toBe(1)
    expect(policy.snapshot()).toHaveLength(0)
    expect(() => policy.enqueue(request('stale'))).toThrow('stale layer revision')
  })

  it('rejects late completions and removes expired loading authority', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('a')); policy.takeNext(11)
    expect(() => policy.complete(completion('a', { completedAt: 62 }))).toThrow('LOD load lease expired')
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('expires queued and resident leases deterministically', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('queued'))
    expect(policy.expire(61)).toBe(1)
    policy.enqueue(request('resident', { requestedAt: 70 })); policy.takeNext(71)
    policy.complete(completion('resident', { completedAt: 72 }))
    expect(policy.expire(173)).toBe(1)
  })

  it('touch extends only live resident leases', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('a')); policy.takeNext(11); policy.complete(completion('a'))
    expect(policy.touch('a', 30)).toBe(true)
    expect(policy.snapshot()[0].expiresAt).toBe(130)
    expect(policy.touch('a', 131)).toBe(false)
  })

  it('consume returns a detached immutable scalar view', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('a')); policy.takeNext(11); policy.complete(completion('a'))
    const consumed = policy.consume('a')
    expect(consumed?.tileId).toBe('a')
    expect(Object.isFrozen(consumed)).toBe(true)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('cancel refuses resident authority but removes queued/loading work', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('queued'))
    expect(policy.cancel('queued')).toBe(true)
    policy.enqueue(request('resident')); policy.takeNext(11); policy.complete(completion('resident'))
    expect(policy.cancel('resident')).toBe(false)
  })

  it('tears down view and layer authority without retaining payload graphs', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('a', { viewId: 'v1' }))
    policy.enqueue(request('b', { viewId: 'v2' }))
    expect(policy.releaseView('v1')).toBe(1)
    expect(policy.releaseLayer('scene-1')).toBe(1)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('evicts lower-intent coarse residents under GPU pressure', () => {
    const constrained = new ArcGisSceneLodResidencyPolicy({ ...budget, maxResident: 2, maxResidentTriangles: 200, maxResidentBytes: 2000 })
    constrained.enqueue(request('background', { viewId: 'v1', intent: 'background', level: 2 })); constrained.takeNext(11); constrained.complete(completion('background'))
    constrained.enqueue(request('visible', { viewId: 'v2', intent: 'visible', level: 5 })); constrained.takeNext(21); constrained.complete(completion('visible', { viewId: 'v2', completedAt: 22 }))
    constrained.enqueue(request('interactive', { viewId: 'v3', intent: 'interactive', level: 9 })); constrained.takeNext(31); constrained.complete(completion('interactive', { viewId: 'v3', completedAt: 32 }))
    expect(policyIds(constrained)).toEqual(['interactive', 'visible'])
  })

  it('does not evict equal or higher intent residency for lower priority work', () => {
    const constrained = new ArcGisSceneLodResidencyPolicy({ ...budget, maxResident: 1, maxResidentTriangles: 100, maxResidentBytes: 1000 })
    constrained.enqueue(request('interactive', { viewId: 'v1', intent: 'interactive' })); constrained.takeNext(11); constrained.complete(completion('interactive'))
    constrained.enqueue(request('background', { viewId: 'v2', intent: 'background', requestedAt: 30 })); constrained.takeNext(31)
    expect(() => constrained.complete(completion('background', { viewId: 'v2', completedAt: 32 }))).toThrow('resident LOD capacity exceeded')
    expect(policyIds(constrained)).toEqual(['interactive'])
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('a'))
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.enqueue(request('b'))).toThrow('disposed')
  })

  it('keeps fingerprints scalar and deterministic', () => {
    const policy = new ArcGisSceneLodResidencyPolicy(budget)
    policy.enqueue(request('b', { viewId: 'v2' }))
    policy.enqueue(request('a', { viewId: 'v1' }))
    expect(policy.fingerprint()).toContain('a:v1:scene-1:1:4:visible:queued:0:0')
    expect(policy.fingerprint().indexOf('a:')).toBeLessThan(policy.fingerprint().indexOf('b:'))
  })
})

function policyIds(policy: ArcGisSceneLodResidencyPolicy): string[] {
  return policy.snapshot().filter(item => item.phase === 'resident').map(item => item.tileId).sort()
}
