import { describe, expect, it } from 'vitest'
import { ArcGisQueryObjectIdSetLifecyclePolicy, type QueryObjectIdSetBudget } from './ArcGisQueryObjectIdSetLifecyclePolicy'

const budget: QueryObjectIdSetBudget = { maxLayers: 2, maxSets: 3, maxSetsPerLayer: 2, maxIdsPerSet: 4, maxResidentIds: 6, ttlMs: 100 }
const ready = () => { const policy = new ArcGisQueryObjectIdSetLifecyclePolicy(budget); policy.setRevision('roads', 1); return policy }

describe('ArcGisQueryObjectIdSetLifecyclePolicy', () => {
  it('canonicalizes detached ids and rejects stale revisions', () => {
    const policy = ready(); const ids = [9, 3, 7]
    const view = policy.admit({ setKey: 'roads', layerId: 'roads', revision: 1, intent: 'visible', objectIdField: 'OBJECTID', objectIds: ids, capturedAt: 10, signature: 'all' })
    expect(ids).toEqual([9, 3, 7]); expect(view?.objectIds).toEqual([3, 7, 9]); expect(Object.isFrozen(view?.objectIds)).toBe(true)
    expect(policy.setRevision('roads', 2)).toBe(1); expect(policy.get('roads', 1, 20)).toBeNull()
  })

  it('deduplicates equivalent unordered sets and rejects key collisions', () => {
    const policy = ready()
    const first = policy.admit({ setKey: 'a', layerId: 'roads', revision: 1, intent: 'visible', objectIdField: 'OBJECTID', objectIds: [3, 1], capturedAt: 10, signature: 'all' })
    const alias = policy.admit({ setKey: 'b', layerId: 'roads', revision: 1, intent: 'visible', objectIdField: 'OBJECTID', objectIds: [1, 3], capturedAt: 20, signature: 'all' })
    expect(alias?.setKey).toBe(first?.setKey); expect(policy.snapshot().sets).toBe(1)
    expect(policy.admit({ setKey: 'a', layerId: 'roads', revision: 1, intent: 'visible', objectIdField: 'OBJECTID', objectIds: [2], capturedAt: 30, signature: 'different' })).toBeNull()
  })

  it('bounds aggregate residency and protects higher-intent work', () => {
    const policy = ready()
    expect(policy.admit({ setKey: 'interactive', layerId: 'roads', revision: 1, intent: 'interactive', objectIdField: 'OBJECTID', objectIds: [1,2,3,4], capturedAt: 10, signature: 'i' })).not.toBeNull()
    expect(policy.admit({ setKey: 'background', layerId: 'roads', revision: 1, intent: 'background', objectIdField: 'OBJECTID', objectIds: [5,6,7], capturedAt: 20, signature: 'b' })).toBeNull()
    expect(policy.snapshot().residentIds).toBe(4)
  })

  it('fails closed for unsafe ids and disposes authority state', () => {
    const policy = ready()
    expect(() => policy.admit({ setKey: 'x', layerId: 'roads', revision: 1, intent: 'visible', objectIdField: 'OBJECTID', objectIds: [1,1], capturedAt: 10, signature: 'x' })).toThrow('unique')
    policy.dispose(); policy.dispose(); expect(() => policy.snapshot()).toThrow('disposed')
  })
})
