import { describe, expect, it } from 'vitest'
import {
  ArcGisQueryDedupeLifecyclePolicy,
  type QueryDedupeBudget,
  type QueryDedupeRequest,
} from './ArcGisQueryDedupeLifecyclePolicy'

const budget: QueryDedupeBudget = {
  maxLayers: 3,
  maxEntries: 6,
  maxEntriesPerLayer: 4,
  maxInflight: 3,
  maxInflightPerLayer: 2,
  maxCached: 3,
  maxCachedPerLayer: 2,
  maxFeaturesPerEntry: 40,
  maxBytesPerEntry: 400,
  maxCachedFeatures: 80,
  maxCachedBytes: 800,
  pendingTtlMs: 100,
  requestLeaseMs: 50,
  cacheTtlMs: 200,
}

function create(overrides: Partial<QueryDedupeBudget> = {}): ArcGisQueryDedupeLifecyclePolicy {
  return new ArcGisQueryDedupeLifecyclePolicy({ ...budget, ...overrides })
}

function request(
  requestId: string,
  layerId = 'parcels',
  signature = requestId,
  revision = 1,
  intent: QueryDedupeRequest['intent'] = 'visible',
  requestedAt = 0,
): QueryDedupeRequest {
  return {
    requestId, layerId, signature, revision, intent, requestedAt,
    estimatedFeatures: 10, estimatedBytes: 100,
  }
}

function finish(
  policy: ArcGisQueryDedupeLifecyclePolicy,
  id: string,
  at: number,
  features = 10,
  bytes = 100,
): void {
  expect(policy.startNext(at)?.requestId).toBe(id)
  expect(policy.complete(id, 1, features, bytes, at + 1)?.requestId).toBe(id)
}

describe('ArcGIS query dedupe cross-layer integrity and pressure', () => {
  it('keeps identical signatures isolated by layer and revision', () => {
    const policy = create()
    policy.setRevision('parcels', 1)
    policy.setRevision('roads', 1)
    expect(policy.admit(request('p', 'parcels', 'shared'))).toBe('admitted')
    expect(policy.admit(request('r', 'roads', 'shared'))).toBe('admitted')
    finish(policy, 'p', 1)
    finish(policy, 'r', 3)
    expect(policy.lookup('shared', 'parcels', 1, 5)?.requestId).toBe('p')
    expect(policy.lookup('shared', 'roads', 1, 5)?.requestId).toBe('r')
    expect(policy.lookup('shared', 'parcels', 2, 5)).toBeNull()
    expect(policy.snapshot()).toMatchObject({ cached: 2, entries: 2 })
  })

  it('does not conflate request ID collision with signature coalescing', () => {
    const policy = create()
    policy.setRevision('parcels', 1)
    policy.setRevision('roads', 1)
    expect(policy.admit(request('shared-id', 'parcels', 'a'))).toBe('admitted')
    expect(policy.admit(request('shared-id', 'roads', 'b'))).toBe('rejected')
    expect(policy.admit(request('new-id', 'parcels', 'a'))).toBe('duplicate')
    expect(policy.admit(request('new-id', 'roads', 'b'))).toBe('admitted')
    expect(policy.snapshot()).toMatchObject({ pending: 2, entries: 2 })
  })

  it('invalidates stale cache and signatures on a layer revision', () => {
    const policy = create()
    policy.setRevision('parcels', 1)
    expect(policy.admit(request('one', 'parcels', 'same'))).toBe('admitted')
    finish(policy, 'one', 1)
    expect(policy.setRevision('parcels', 2)).toBe(1)
    expect(policy.lookup('same', 'parcels', 1, 3)).toBeNull()
    expect(policy.admit(request('one', 'parcels', 'same', 2))).toBe('admitted')
    expect(policy.snapshot()).toMatchObject({ pending: 1, cached: 0 })
  })

  it('evicts the preferred layer cache before unrelated layers', () => {
    const policy = create({ maxCached: 2, maxCachedPerLayer: 1 })
    policy.setRevision('parcels', 1)
    policy.setRevision('roads', 1)
    policy.admit(request('p1', 'parcels'))
    finish(policy, 'p1', 1)
    policy.admit(request('r1', 'roads'))
    finish(policy, 'r1', 3)
    policy.admit(request('p2', 'parcels'))
    finish(policy, 'p2', 5)
    expect(policy.lookup('p1', 'parcels', 1, 7)).toBeNull()
    expect(policy.lookup('p2', 'parcels', 1, 7)).not.toBeNull()
    expect(policy.lookup('r1', 'roads', 1, 7)).not.toBeNull()
    expect(policy.snapshot().cached).toBe(2)
  })

  it('reconciles actual result size and evicts under aggregate byte pressure', () => {
    const policy = create({ maxCachedBytes: 400, maxCachedFeatures: 80 })
    policy.setRevision('parcels', 1)
    policy.admit(request('background', 'parcels', 'background', 1, 'background'))
    finish(policy, 'background', 1, 10, 250)
    policy.admit(request('interactive', 'parcels', 'interactive', 1, 'interactive'))
    finish(policy, 'interactive', 3, 10, 250)
    expect(policy.lookup('background', 'parcels', 1, 5)).toBeNull()
    expect(policy.lookup('interactive', 'parcels', 1, 5)).not.toBeNull()
    expect(policy.snapshot()).toMatchObject({ cached: 1, cachedBytes: 250 })
  })

  it('removes expired signature aliases before a new admission', () => {
    const policy = create({ pendingTtlMs: 10 })
    policy.setRevision('parcels', 1)
    expect(policy.admit(request('old', 'parcels', 'same'))).toBe('admitted')
    expect(policy.expire(9)).toBe(0)
    expect(policy.expire(10)).toBe(1)
    expect(policy.admit(request('new', 'parcels', 'same', 1, 'visible', 10))).toBe('admitted')
    expect(policy.snapshot()).toMatchObject({ entries: 1, pending: 1 })
  })

  it('reclaims inflight lease and rejects late completion', () => {
    const policy = create({ requestLeaseMs: 10 })
    policy.setRevision('parcels', 1)
    policy.admit(request('lease'))
    expect(policy.startNext(1)?.requestId).toBe('lease')
    expect(policy.renew('lease', 1, 5)).toBe(true)
    expect(policy.expire(14)).toBe(0)
    expect(policy.expire(15)).toBe(1)
    expect(policy.complete('lease', 1, 1, 1, 16)).toBeNull()
    expect(policy.snapshot()).toMatchObject({ inflight: 0, cached: 0 })
  })

  it('returns frozen payload-free views even after lifecycle disposal', () => {
    const policy = create()
    policy.setRevision('parcels', 1)
    policy.admit(request('view'))
    const view = policy.startNext(1)
    expect(view).not.toBeNull()
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.keys(view ?? {}).sort()).toEqual([
      'bytes', 'estimatedBytes', 'estimatedFeatures', 'expiresAt', 'features',
      'intent', 'layerId', 'phase', 'requestId', 'requestedAt',
      'revision', 'sequence', 'signature', 'touchedAt',
    ])
    policy.dispose()
    expect(view?.phase).toBe('inflight')
    expect(() => policy.snapshot()).toThrow()
  })

  it('rejects boundary control characters without corrupting layer state', () => {
    const policy = create()
    policy.setRevision('parcels', 1)
    for (const code of [0, 9, 10, 13, 31, 127]) {
      const bad = String.fromCharCode(code) + 'parcels'
      expect(() => policy.setRevision(bad, 1)).toThrow()
      expect(() => policy.admit(request('id', 'parcels', bad))).toThrow()
      expect(() => policy.cancel(bad)).toThrow()
    }
    expect(policy.snapshot()).toMatchObject({ layers: 1, entries: 0 })
  })
})
