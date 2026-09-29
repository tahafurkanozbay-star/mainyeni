import { describe, expect, it } from 'vitest'
import { ArcGisLayerResourceRegistry, type ArcGisLayerResourceBudget, type ArcGisLayerResourceDescriptor } from './ArcGisLayerResourceRegistry'

const budget: ArcGisLayerResourceBudget = {
  maxLayers: 3,
  maxResources: 5,
  maxResourcesPerLayer: 3,
  maxCpuBytes: 100,
  maxGpuBytes: 100,
  maxIdleMs: 10,
  maxLeaseMs: 100,
  maxOwnersPerResource: 2,
}
const resource = (overrides: Partial<ArcGisLayerResourceDescriptor> = {}): ArcGisLayerResourceDescriptor => ({
  layerId: 'roads', resourceId: 'renderer', kind: 'renderer', cpuBytes: 10, gpuBytes: 20, generation: 1, ...overrides,
})
const registry = (overrides: Partial<ArcGisLayerResourceBudget> = {}) => new ArcGisLayerResourceRegistry({ ...budget, ...overrides })

function seeded() {
  const r = registry()
  r.register(resource(), 1)
  return r
}

describe('ArcGisLayerResourceRegistry registration', () => {
  it('registers a bounded logical resource', () => {
    const r = seeded()
    expect(r.snapshot()).toMatchObject({ cpuBytes: 10, gpuBytes: 20, layerCount: 1 })
    expect(r.snapshot().resources[0]).toMatchObject({ layerId: 'roads', resourceId: 'renderer', state: 'idle', generation: 1 })
  })

  it('is idempotent for the same generation and shape', () => {
    const r = seeded()
    r.register(resource(), 5)
    expect(r.snapshot().resources).toHaveLength(1)
    expect(r.snapshot().resources[0].lastUsedAtMs).toBe(5)
  })

  it('rejects same-generation shape drift', () => {
    const r = seeded()
    expect(() => r.register(resource({ gpuBytes: 21 }), 2)).toThrow('resource-generation-conflict')
  })

  it('rejects stale generation replacement', () => {
    const r = registry()
    r.register(resource({ generation: 2 }), 1)
    expect(() => r.register(resource({ generation: 1 }), 2)).toThrow('stale-resource-generation')
  })

  it('allows a newer generation when idle', () => {
    const r = seeded()
    r.register(resource({ generation: 2, cpuBytes: 12 }), 3)
    expect(r.snapshot()).toMatchObject({ cpuBytes: 12, gpuBytes: 20 })
    expect(r.snapshot().resources[0].generation).toBe(2)
  })

  it('rejects generation replacement while leased', () => {
    const r = seeded()
    r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 20, nowMs: 2 })
    expect(() => r.register(resource({ generation: 2 }), 3)).toThrow('resource-generation-in-use')
  })

  it('enforces total resource cardinality', () => {
    const r = registry({ maxResources: 2, maxResourcesPerLayer: 2 })
    r.register(resource({ resourceId: 'a' }), 1)
    r.register(resource({ resourceId: 'b' }), 1)
    expect(() => r.register(resource({ resourceId: 'c' }), 1)).toThrow('resource-count-budget-exceeded')
  })

  it('enforces per-layer cardinality', () => {
    const r = registry({ maxResourcesPerLayer: 1 })
    r.register(resource({ resourceId: 'a' }), 1)
    expect(() => r.register(resource({ resourceId: 'b' }), 1)).toThrow('layer-resource-count-budget-exceeded')
  })

  it('enforces distinct layer cardinality', () => {
    const r = registry({ maxLayers: 1 })
    r.register(resource(), 1)
    expect(() => r.register(resource({ layerId: 'buildings', resourceId: 'mesh' }), 1)).toThrow('layer-count-budget-exceeded')
  })

  it('enforces aggregate CPU bytes', () => {
    const r = registry({ maxCpuBytes: 15 })
    r.register(resource({ cpuBytes: 10 }), 1)
    expect(() => r.register(resource({ resourceId: 'labels', cpuBytes: 6, gpuBytes: 0 }), 1)).toThrow('cpu-byte-budget-exceeded')
  })

  it('enforces aggregate GPU bytes', () => {
    const r = registry({ maxGpuBytes: 25 })
    r.register(resource({ gpuBytes: 20 }), 1)
    expect(() => r.register(resource({ resourceId: 'mesh', cpuBytes: 0, gpuBytes: 6 }), 1)).toThrow('gpu-byte-budget-exceeded')
  })

  it('rejects unknown resource kinds', () => {
    const r = registry()
    expect(() => r.register({ ...resource(), kind: 'texture' as never }, 1)).toThrow('invalid-resource-kind')
  })

  it('rejects control characters in identities', () => {
    const r = registry()
    expect(() => r.register(resource({ layerId: 'bad\nlayer' }), 1)).toThrow('invalid-layer-id')
  })
})

describe('ArcGisLayerResourceRegistry leases', () => {
  it('acquires a generation-pinned lease', () => {
    const r = seeded()
    const lease = r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 20, nowMs: 2 })
    expect(lease).toMatchObject({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, acquiredAtMs: 2, expiresAtMs: 22 })
    expect(r.snapshot().resources[0]).toMatchObject({ state: 'active', owners: ['map'] })
  })

  it('deduplicates an owner lease', () => {
    const r = seeded()
    const first = r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 20, nowMs: 2 })
    const second = r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 30, nowMs: 3 })
    expect(second.leaseId).toBe(first.leaseId)
    expect(r.snapshot().leases).toHaveLength(1)
  })

  it('rejects leases for missing resources', () => {
    const r = registry()
    expect(() => r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 20, nowMs: 2 })).toThrow('resource-not-registered')
  })

  it('rejects generation mismatch', () => {
    const r = seeded()
    expect(() => r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 2, ttlMs: 20, nowMs: 2 })).toThrow('resource-generation-mismatch')
  })

  it('enforces owner cardinality', () => {
    const r = registry({ maxOwnersPerResource: 1 })
    r.register(resource(), 1)
    r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 20, nowMs: 2 })
    expect(() => r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'scene', generation: 1, ttlMs: 20, nowMs: 3 })).toThrow('resource-owner-budget-exceeded')
  })

  it('enforces maximum lease TTL', () => {
    const r = seeded()
    expect(() => r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 101, nowMs: 2 })).toThrow('ttlMs')
  })

  it('rejects lease expiry arithmetic overflow', () => {
    const r = seeded()
    expect(() => r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 2, nowMs: Number.MAX_SAFE_INTEGER })).toThrow('lease-expiry-overflow')
  })

  it('touch extends a live lease without changing acquisition time', () => {
    const r = seeded()
    const lease = r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 20, nowMs: 2 })
    const touched = r.touch(lease.leaseId, 5, 30)
    expect(touched).toMatchObject({ acquiredAtMs: 2, expiresAtMs: 35 })
  })

  it('touch rejects expired leases', () => {
    const r = seeded()
    const lease = r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 5, nowMs: 2 })
    expect(() => r.touch(lease.leaseId, 7, 10)).toThrow('lease-not-found')
    expect(r.snapshot().leases).toHaveLength(0)
  })

  it('releases by lease id', () => {
    const r = seeded()
    const lease = r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 20, nowMs: 2 })
    expect(r.release(lease.leaseId, 4)).toBe(true)
    expect(r.release(lease.leaseId, 5)).toBe(false)
    expect(r.snapshot().resources[0].state).toBe('idle')
  })

  it('releases all resources owned by a host', () => {
    const r = registry()
    r.register(resource({ resourceId: 'a' }), 1)
    r.register(resource({ resourceId: 'b' }), 1)
    r.acquire({ layerId: 'roads', resourceId: 'a', ownerId: 'map', generation: 1, ttlMs: 20, nowMs: 2 })
    r.acquire({ layerId: 'roads', resourceId: 'b', ownerId: 'map', generation: 1, ttlMs: 20, nowMs: 2 })
    expect(r.releaseOwner('map', 3)).toBe(2)
    expect(r.snapshot().leases).toHaveLength(0)
  })

  it('expires leases deterministically at boundary', () => {
    const r = seeded()
    r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 5, nowMs: 2 })
    expect(r.expireLeases(6)).toBe(0)
    expect(r.expireLeases(7)).toBe(1)
  })
})

describe('ArcGisLayerResourceRegistry eviction and lifecycle', () => {
  it('evicts idle resources at the configured boundary', () => {
    const r = seeded()
    expect(r.evictIdle(10)).toEqual([])
    expect(r.evictIdle(11)).toEqual(['roads/renderer'])
    expect(r.snapshot()).toMatchObject({ cpuBytes: 0, gpuBytes: 0, layerCount: 0 })
  })

  it('does not evict a leased resource', () => {
    const r = seeded()
    r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 100, nowMs: 2 })
    expect(r.evictIdle(20)).toEqual([])
  })

  it('evicts after an expired lease becomes idle long enough', () => {
    const r = seeded()
    r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 5, nowMs: 2 })
    expect(r.evictIdle(7)).toEqual([])
    expect(r.evictIdle(17)).toEqual(['roads/renderer'])
  })

  it('orders idle eviction by age then identity', () => {
    const r = registry()
    r.register(resource({ layerId: 'z', resourceId: 'r' }), 1)
    r.register(resource({ layerId: 'a', resourceId: 'r' }), 1)
    r.register(resource({ layerId: 'b', resourceId: 'r' }), 2)
    expect(r.evictIdle(12)).toEqual(['a/r', 'z/r', 'b/r'])
  })

  it('unregisters matching idle generation', () => {
    const r = seeded()
    expect(r.unregister('roads', 'renderer', 1)).toBe(true)
    expect(r.unregister('roads', 'renderer', 1)).toBe(false)
  })

  it('rejects unregister generation mismatch', () => {
    const r = seeded()
    expect(() => r.unregister('roads', 'renderer', 2)).toThrow('resource-generation-mismatch')
  })

  it('rejects unregister while resource is in use', () => {
    const r = seeded()
    r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 20, nowMs: 2 })
    expect(() => r.unregister('roads', 'renderer', 1)).toThrow('resource-in-use')
  })

  it('returns immutable deterministic snapshots', () => {
    const r = registry()
    r.register(resource({ layerId: 'z', resourceId: 'b' }), 1)
    r.register(resource({ layerId: 'a', resourceId: 'a' }), 1)
    const snapshot = r.snapshot()
    expect(snapshot.resources.map(item => `${item.layerId}/${item.resourceId}`)).toEqual(['a/a', 'z/b'])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.resources)).toBe(true)
    expect(Object.isFrozen(snapshot.resources[0].owners)).toBe(true)
  })

  it('produces a stable ownership fingerprint', () => {
    const r = seeded()
    const before = r.snapshot().fingerprint
    r.acquire({ layerId: 'roads', resourceId: 'renderer', ownerId: 'map', generation: 1, ttlMs: 20, nowMs: 2 })
    const after = r.snapshot().fingerprint
    expect(before).not.toBe(after)
    expect(after).toContain('roads/renderer:1:active:map')
  })

  it('dispose clears retained accounting and is idempotent', () => {
    const r = seeded()
    r.dispose()
    r.dispose()
    expect(r.snapshot()).toMatchObject({ cpuBytes: 0, gpuBytes: 0, layerCount: 0, resources: [], leases: [] })
  })

  it('rejects mutation after dispose', () => {
    const r = seeded()
    r.dispose()
    expect(() => r.register(resource(), 2)).toThrow('arcgis-layer-resource-registry-disposed')
  })

  it('rejects invalid budget relationships', () => {
    expect(() => registry({ maxResources: 1, maxResourcesPerLayer: 2 })).toThrow('maxResourcesPerLayer must be <= maxResources')
  })
})
