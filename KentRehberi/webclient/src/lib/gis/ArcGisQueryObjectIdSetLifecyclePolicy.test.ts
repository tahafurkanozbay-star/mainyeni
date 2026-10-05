import { describe, expect, it } from 'vitest'
import { ArcGisQueryObjectIdSetLifecyclePolicy, type QueryObjectIdSetBudget, type QueryObjectIdSetRequest } from './ArcGisQueryObjectIdSetLifecyclePolicy'

const budget: QueryObjectIdSetBudget = {
  maxLayers: 3,
  maxSets: 4,
  maxSetsPerLayer: 3,
  maxIdsPerSet: 5,
  maxResidentIds: 8,
  ttlMs: 100,
}

const request = (overrides: Partial<QueryObjectIdSetRequest> = {}): QueryObjectIdSetRequest => ({
  setKey: 'roads-visible',
  layerId: 'roads',
  revision: 1,
  intent: 'visible',
  objectIdField: 'OBJECTID',
  objectIds: [9, 3, 7],
  capturedAt: 10,
  signature: 'where=1=1|extent=a',
  ...overrides,
})

const ready = (custom: Partial<QueryObjectIdSetBudget> = {}) => {
  const policy = new ArcGisQueryObjectIdSetLifecyclePolicy({ ...budget, ...custom })
  policy.setRevision('roads', 1)
  return policy
}

describe('ArcGisQueryObjectIdSetLifecyclePolicy', () => {
  it('canonicalizes object ids without mutating caller input', () => {
    const policy = ready()
    const ids = [9, 3, 7]
    const admitted = policy.admit(request({ objectIds: ids }))
    expect(ids).toEqual([9, 3, 7])
    expect(admitted?.objectIds).toEqual([3, 7, 9])
    expect(Object.isFrozen(admitted?.objectIds)).toBe(true)
  })

  it('rejects stale revisions and invalidates resident sets on revision advance', () => {
    const policy = ready()
    expect(policy.admit(request())).not.toBeNull()
    expect(policy.setRevision('roads', 2)).toBe(1)
    expect(policy.get('roads-visible', 1, 20)).toBeNull()
    expect(policy.admit(request())).toBeNull()
    expect(policy.admit(request({ revision: 2, capturedAt: 21 }))).not.toBeNull()
    expect(policy.setRevision('roads', 1)).toBe(-1)
  })

  it('deduplicates logically equivalent sets independent of server id order', () => {
    const policy = ready()
    const first = policy.admit(request())
    const second = policy.admit(request({ setKey: 'alias', objectIds: [7, 9, 3], capturedAt: 30 }))
    expect(second?.setKey).toBe(first?.setKey)
    expect(second?.sequence).toBe(first?.sequence)
    expect(second?.touchedAt).toBe(30)
    expect(policy.snapshot().sets).toBe(1)
  })

  it('rejects key collisions whose logical identity differs', () => {
    const policy = ready()
    expect(policy.admit(request())).not.toBeNull()
    expect(policy.admit(request({ signature: 'where=OBJECTID>5', capturedAt: 20 }))).toBeNull()
    expect(policy.admit(request({ objectIds: [1], capturedAt: 20 }))).toBeNull()
    expect(policy.snapshot().sets).toBe(1)
  })

  it('fails closed for duplicate, unsafe, fractional, negative and zero object ids', () => {
    const policy = ready()
    expect(() => policy.admit(request({ objectIds: [1, 1] }))).toThrow('unique')
    expect(() => policy.admit(request({ objectIds: [1.5] }))).toThrow('positive safe integer')
    expect(() => policy.admit(request({ objectIds: [-1] }))).toThrow('positive safe integer')
    expect(() => policy.admit(request({ objectIds: [0] }))).toThrow('positive safe integer')
    expect(() => policy.admit(request({ objectIds: [Number.MAX_SAFE_INTEGER + 1] }))).toThrow('positive safe integer')
  })

  it('rejects unsafe field names while allowing ArcGIS-style identifiers', () => {
    const policy = ready()
    expect(policy.admit(request({ objectIdField: 'PARCEL_ID_2' }))).not.toBeNull()
    expect(() => policy.admit(request({ setKey: 'x', objectIdField: 'OBJECTID;DROP', signature: 'x' }))).toThrow('objectIdField is invalid')
    expect(() => policy.admit(request({ setKey: 'x', objectIdField: '1OBJECTID', signature: 'x' }))).toThrow('objectIdField is invalid')
  })

  it('rejects oversized sets before they consume residency', () => {
    const policy = ready({ maxIdsPerSet: 3 })
    expect(policy.admit(request({ objectIds: [1, 2, 3, 4] }))).toBeNull()
    expect(policy.snapshot()).toEqual({ layers: 1, sets: 0, residentIds: 0 })
  })

  it('evicts lower-intent least-recent sets under aggregate id pressure', () => {
    const policy = ready({ maxResidentIds: 6 })
    expect(policy.admit(request({ setKey: 'background', intent: 'background', objectIds: [1, 2, 3], signature: 'a' }))).not.toBeNull()
    expect(policy.admit(request({ setKey: 'visible', objectIds: [4, 5], signature: 'b', capturedAt: 20 }))).not.toBeNull()
    expect(policy.admit(request({ setKey: 'interactive', intent: 'interactive', objectIds: [6, 7], signature: 'c', capturedAt: 30 }))).not.toBeNull()
    expect(policy.get('background', 1, 31)).toBeNull()
    expect(policy.get('visible', 1, 31)).not.toBeNull()
    expect(policy.get('interactive', 1, 31)).not.toBeNull()
    expect(policy.snapshot().residentIds).toBe(4)
  })

  it('does not evict higher-intent work to admit lower-intent pressure', () => {
    const policy = ready({ maxResidentIds: 5 })
    expect(policy.admit(request({ setKey: 'interactive', intent: 'interactive', objectIds: [1, 2, 3, 4], signature: 'a' }))).not.toBeNull()
    expect(policy.admit(request({ setKey: 'background', intent: 'background', objectIds: [5, 6], signature: 'b', capturedAt: 20 }))).toBeNull()
    expect(policy.get('interactive', 1, 21)).not.toBeNull()
    expect(policy.snapshot().residentIds).toBe(4)
  })

  it('enforces per-layer cardinality with intent-aware eviction', () => {
    const policy = ready({ maxSetsPerLayer: 2 })
    policy.admit(request({ setKey: 'a', intent: 'background', objectIds: [1], signature: 'a' }))
    policy.admit(request({ setKey: 'b', objectIds: [2], signature: 'b', capturedAt: 20 }))
    expect(policy.admit(request({ setKey: 'c', intent: 'interactive', objectIds: [3], signature: 'c', capturedAt: 30 }))).not.toBeNull()
    expect(policy.get('a', 1, 31)).toBeNull()
    expect(policy.snapshot().sets).toBe(2)
  })

  it('enforces global set cardinality across layers', () => {
    const policy = ready({ maxSets: 2, maxSetsPerLayer: 2 })
    policy.setRevision('parcels', 1)
    policy.admit(request({ setKey: 'a', intent: 'background', objectIds: [1], signature: 'a' }))
    policy.admit(request({ setKey: 'b', objectIds: [2], signature: 'b' }))
    expect(policy.admit(request({ setKey: 'c', layerId: 'parcels', intent: 'interactive', objectIds: [3], signature: 'c' }))).not.toBeNull()
    expect(policy.get('a', 1, 20)).toBeNull()
    expect(policy.snapshot().sets).toBe(2)
  })

  it('expires at the exact TTL boundary', () => {
    const policy = ready()
    policy.admit(request({ capturedAt: 10 }))
    expect(policy.get('roads-visible', 1, 109)).not.toBeNull()
    expect(policy.get('roads-visible', 1, 110)).toBeNull()
  })

  it('touch extends TTL but cannot resurrect expired work', () => {
    const policy = ready()
    policy.admit(request({ capturedAt: 10 }))
    expect(policy.touch('roads-visible', 1, 50)).toBe(true)
    expect(policy.get('roads-visible', 1, 149)).not.toBeNull()
    expect(policy.touch('roads-visible', 1, 150)).toBe(false)
  })

  it('expire removes all stale sets deterministically', () => {
    const policy = ready()
    policy.admit(request({ setKey: 'a', objectIds: [1], signature: 'a', capturedAt: 10 }))
    policy.admit(request({ setKey: 'b', objectIds: [2], signature: 'b', capturedAt: 40 }))
    expect(policy.expire(110)).toBe(1)
    expect(policy.snapshot().sets).toBe(1)
    expect(policy.expire(140)).toBe(1)
  })

  it('consume transfers a detached frozen view and releases residency', () => {
    const policy = ready()
    policy.admit(request())
    const consumed = policy.consume('roads-visible', 1, 20)
    expect(consumed?.objectIds).toEqual([3, 7, 9])
    expect(Object.isFrozen(consumed)).toBe(true)
    expect(policy.snapshot().residentIds).toBe(0)
    expect(policy.consume('roads-visible', 1, 21)).toBeNull()
  })

  it('releaseLayer removes revision authority and resident id sets', () => {
    const policy = ready()
    policy.admit(request())
    expect(policy.releaseLayer('roads')).toBe(1)
    expect(policy.snapshot()).toEqual({ layers: 0, sets: 0, residentIds: 0 })
    expect(policy.admit(request({ capturedAt: 20 }))).toBeNull()
  })

  it('returns immutable scalar snapshots and deterministic fingerprints', () => {
    const policy = ready()
    policy.admit(request({ setKey: 'z', objectIds: [9, 1], signature: 'z' }))
    policy.admit(request({ setKey: 'a', objectIds: [8], signature: 'a' }))
    const snapshot = policy.snapshot()
    expect(snapshot).toEqual({ layers: 1, sets: 2, residentIds: 3 })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(policy.fingerprint()).toBe('roads:a:1:visible:OBJECTID:a:8|roads:z:1:visible:OBJECTID:z:1,9')
  })

  it('bounds layer revision authority', () => {
    const policy = ready({ maxLayers: 2 })
    policy.setRevision('parcels', 1)
    expect(() => policy.setRevision('buildings', 1)).toThrow('maxLayers exceeded')
  })

  it('validates budgets and temporal/scalar request inputs', () => {
    expect(() => new ArcGisQueryObjectIdSetLifecyclePolicy({ ...budget, ttlMs: 0 })).toThrow('ttlMs must be positive')
    expect(() => new ArcGisQueryObjectIdSetLifecyclePolicy({ ...budget, maxSetsPerLayer: 5 })).toThrow('maxSetsPerLayer cannot exceed maxSets')
    expect(() => new ArcGisQueryObjectIdSetLifecyclePolicy({ ...budget, maxResidentIds: 4 })).toThrow('maxResidentIds cannot be smaller than maxIdsPerSet')
    const policy = ready()
    expect(() => policy.admit(request({ capturedAt: Number.NaN }))).toThrow('capturedAt')
    expect(() => policy.admit(request({ revision: -1 }))).toThrow('revision')
    expect(() => policy.admit(request({ layerId: ' ' }))).toThrow('layerId')
  })

  it('disposes idempotently and rejects all later authority operations', () => {
    const policy = ready()
    policy.admit(request())
    policy.dispose()
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.setRevision('roads', 2)).toThrow('disposed')
    expect(() => policy.admit(request())).toThrow('disposed')
  })
})
