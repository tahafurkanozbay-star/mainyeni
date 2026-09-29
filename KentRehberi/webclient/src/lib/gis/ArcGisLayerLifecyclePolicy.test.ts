import { describe, expect, it } from 'vitest'
import { ArcGisLayerLifecyclePolicy, type ArcGisLayerDescriptor } from './ArcGisLayerLifecyclePolicy'

const budget = {
  maxLayers: 8,
  maxActiveLayers: 3,
  maxCpuBytes: 1_000,
  maxGpuBytes: 800,
  maxFeatureCount: 10_000,
  maxIdLength: 64,
  maxRevisionLength: 64,
  maxFailuresPerLayer: 2,
} as const

function descriptor(overrides: Partial<ArcGisLayerDescriptor> = {}): ArcGisLayerDescriptor {
  return {
    id: 'roads',
    kind: 'feature',
    revision: 'rev-1',
    visible: true,
    minScale: 0,
    maxScale: 0,
    priority: 10,
    estimatedCpuBytes: 100,
    estimatedGpuBytes: 80,
    estimatedFeatureCount: 500,
    supports2d: true,
    supports3d: true,
    ...overrides,
  }
}

function ready(policy: ArcGisLayerLifecyclePolicy, layer: ArcGisLayerDescriptor, now = 1): void {
  policy.register(layer, now)
  const loading = policy.beginLoad(layer.id, layer.revision, now + 1)
  policy.markReady(layer.id, layer.revision, loading.generation, now + 2)
}

describe('ArcGisLayerLifecyclePolicy', () => {
  it('registers immutable scalar-only lifecycle records', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    const record = policy.register(descriptor(), 10)
    expect(record.phase).toBe('registered')
    expect(record.generation).toBe(0)
    expect(record.failures).toBe(0)
    expect(Object.isFrozen(record)).toBe(true)
    expect(policy.snapshot().registered).toBe(1)
  })

  it('rejects duplicate layer identities', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor(), 1)
    expect(() => policy.register(descriptor(), 2)).toThrow('duplicate-layer-id')
  })

  it('rejects stale descriptor revisions', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    expect(() => policy.register(descriptor({ revision: 'rev-0' }), 1)).toThrow('stale-layer-revision')
  })

  it('rejects descriptors unsupported by both view modes', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    expect(() => policy.register(descriptor({ supports2d: false, supports3d: false }), 1)).toThrow('layer-supports-no-view-mode')
  })

  it('rejects inverted ArcGIS scale ranges', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    expect(() => policy.register(descriptor({ minScale: 1_000, maxScale: 2_000 }), 1)).toThrow('invalid-scale-range')
  })

  it('rejects invalid identifiers and revisions', () => {
    expect(() => new ArcGisLayerLifecyclePolicy(' ', budget)).toThrow('invalid-revision')
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    expect(() => policy.register(descriptor({ id: 'bad\nlayer' }), 1)).toThrow('invalid-layer-id')
  })

  it('rejects unsafe numeric estimates', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    expect(() => policy.register(descriptor({ estimatedCpuBytes: -1 }), 1)).toThrow('estimatedCpuBytes')
    expect(() => policy.register(descriptor({ estimatedGpuBytes: Number.NaN }), 1)).toThrow('estimatedGpuBytes')
    expect(() => policy.register(descriptor({ estimatedFeatureCount: 10_001 }), 1)).toThrow('estimatedFeatureCount')
  })

  it('enforces registry cardinality', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', { ...budget, maxLayers: 2, maxActiveLayers: 2 })
    policy.register(descriptor({ id: 'a' }), 1)
    policy.register(descriptor({ id: 'b' }), 1)
    expect(() => policy.register(descriptor({ id: 'c' }), 1)).toThrow('layer-count-budget-exceeded')
  })

  it('transitions registered through loading to ready', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor(), 1)
    const loading = policy.beginLoad('roads', 'rev-1', 2)
    expect(loading.phase).toBe('loading')
    expect(loading.generation).toBe(1)
    const current = policy.markReady('roads', 'rev-1', 1, 3)
    expect(current.phase).toBe('ready')
    expect(policy.snapshot().ready).toBe(1)
  })

  it('rejects stale asynchronous load completions', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor(), 1)
    policy.beginLoad('roads', 'rev-1', 2)
    expect(() => policy.markReady('roads', 'rev-1', 0, 3)).toThrow('stale-layer-generation')
  })

  it('rejects invalid ready transitions', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor(), 1)
    expect(() => policy.markReady('roads', 'rev-1', 0, 2)).toThrow('invalid-ready-transition')
  })

  it('records bounded failure metadata', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor(), 1)
    const loading = policy.beginLoad('roads', 'rev-1', 2)
    const failed = policy.markFailed('roads', 'rev-1', loading.generation, 'service unavailable', 3)
    expect(failed.phase).toBe('failed')
    expect(failed.failures).toBe(1)
    expect(failed.failureReason).toBe('service unavailable')
  })

  it('allows bounded retry after a failure', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor(), 1)
    let loading = policy.beginLoad('roads', 'rev-1', 2)
    policy.markFailed('roads', 'rev-1', loading.generation, 'one', 3)
    loading = policy.beginLoad('roads', 'rev-1', 4)
    expect(loading.generation).toBe(2)
    policy.markReady('roads', 'rev-1', loading.generation, 5)
    expect(policy.snapshot().ready).toBe(1)
  })

  it('fails closed after retry budget is exhausted', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', { ...budget, maxFailuresPerLayer: 1 })
    policy.register(descriptor(), 1)
    let loading = policy.beginLoad('roads', 'rev-1', 2)
    policy.markFailed('roads', 'rev-1', loading.generation, 'one', 3)
    loading = policy.beginLoad('roads', 'rev-1', 4)
    policy.markFailed('roads', 'rev-1', loading.generation, 'two', 5)
    expect(() => policy.beginLoad('roads', 'rev-1', 6)).toThrow('layer-failure-budget-exceeded')
  })

  it('supports explicit ready suspension and resume', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor())
    expect(policy.suspend('roads', 'rev-1', 10).phase).toBe('suspended')
    expect(policy.resume('roads', 'rev-1', 11).phase).toBe('ready')
  })

  it('rejects invalid suspension transitions', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor(), 1)
    expect(() => policy.suspend('roads', 'rev-1', 2)).toThrow('invalid-suspend-transition')
  })

  it('rejects invalid resume transitions', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor())
    expect(() => policy.resume('roads', 'rev-1', 10)).toThrow('invalid-resume-transition')
  })

  it('disposes idempotently and requires disposal before removal', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor())
    expect(() => policy.removeDisposed('roads')).toThrow('cannot-remove-live-layer')
    const first = policy.disposeLayer('roads', 'rev-1', 10)
    const second = policy.disposeLayer('roads', 'rev-1', 11)
    expect(first.phase).toBe('disposed')
    expect(second).toBe(first)
    expect(policy.removeDisposed('roads')).toBe(true)
    expect(policy.removeDisposed('roads')).toBe(false)
  })

  it('rejects stale lifecycle revision operations', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor(), 1)
    expect(() => policy.beginLoad('roads', 'rev-0', 2)).toThrow('stale-lifecycle-revision')
  })

  it('rejects unknown layer operations', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    expect(() => policy.beginLoad('missing', 'rev-1', 2)).toThrow('unknown-layer-id')
  })

  it('plans ready layers in deterministic priority order', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor({ id: 'low', priority: 1 }))
    ready(policy, descriptor({ id: 'high', priority: 100 }), 10)
    ready(policy, descriptor({ id: 'mid', priority: 10 }), 20)
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 5_000 }).activeLayerIds).toEqual(['high', 'mid', 'low'])
  })

  it('uses layer id as deterministic priority tie breaker', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor({ id: 'z', priority: 5 }))
    ready(policy, descriptor({ id: 'a', priority: 5 }), 10)
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 5_000 }).activeLayerIds).toEqual(['a', 'z'])
  })

  it('honors max active layer cardinality', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', { ...budget, maxActiveLayers: 1 })
    ready(policy, descriptor({ id: 'a', priority: 2 }))
    ready(policy, descriptor({ id: 'b', priority: 1 }), 10)
    const plan = policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 })
    expect(plan.activeLayerIds).toEqual(['a'])
    expect(plan.suspendedLayerIds).toEqual(['b'])
  })

  it('honors aggregate CPU budget without broad admission', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', { ...budget, maxCpuBytes: 150 })
    ready(policy, descriptor({ id: 'a', priority: 2, estimatedCpuBytes: 100 }))
    ready(policy, descriptor({ id: 'b', priority: 1, estimatedCpuBytes: 100 }), 10)
    const plan = policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 })
    expect(plan.activeLayerIds).toEqual(['a'])
    expect(plan.cpuBytes).toBe(100)
  })

  it('honors aggregate GPU budget', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', { ...budget, maxGpuBytes: 100 })
    ready(policy, descriptor({ id: 'a', priority: 2, estimatedGpuBytes: 70 }))
    ready(policy, descriptor({ id: 'b', priority: 1, estimatedGpuBytes: 70 }), 10)
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '3d', scale: 1_000 }).activeLayerIds).toEqual(['a'])
  })

  it('honors aggregate feature budget', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', { ...budget, maxFeatureCount: 700 })
    ready(policy, descriptor({ id: 'a', priority: 2, estimatedFeatureCount: 500 }))
    ready(policy, descriptor({ id: 'b', priority: 1, estimatedFeatureCount: 500 }), 10)
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 }).featureCount).toBe(500)
  })

  it('excludes invisible layers from admission', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor({ visible: false }))
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 }).activeLayerIds).toEqual([])
  })

  it('filters layers by 2d capability', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor({ supports2d: false, supports3d: true }))
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 }).activeLayerIds).toEqual([])
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '3d', scale: 1_000 }).activeLayerIds).toEqual(['roads'])
  })

  it('filters layers by 3d capability', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor({ supports2d: true, supports3d: false }))
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '3d', scale: 1_000 }).activeLayerIds).toEqual([])
  })

  it('honors ArcGIS minimum scale semantics', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor({ minScale: 10_000 }))
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 20_000 }).activeLayerIds).toEqual([])
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 5_000 }).activeLayerIds).toEqual(['roads'])
  })

  it('honors ArcGIS maximum scale semantics', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor({ maxScale: 2_000 }))
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 }).activeLayerIds).toEqual([])
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 5_000 }).activeLayerIds).toEqual(['roads'])
  })

  it('does not plan registered or loading layers', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor({ id: 'registered' }), 1)
    policy.register(descriptor({ id: 'loading' }), 1)
    policy.beginLoad('loading', 'rev-1', 2)
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 }).activeLayerIds).toEqual([])
  })

  it('allows suspended layers to compete for a new admission plan', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor())
    policy.suspend('roads', 'rev-1', 10)
    expect(policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 }).activeLayerIds).toEqual(['roads'])
  })

  it('produces immutable admission arrays and plans', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor())
    const plan = policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.activeLayerIds)).toBe(true)
    expect(Object.isFrozen(plan.suspendedLayerIds)).toBe(true)
  })

  it('produces stable fingerprints for equivalent state', () => {
    const first = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    const second = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(first, descriptor())
    ready(second, descriptor())
    const a = first.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 })
    const b = second.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 })
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('changes fingerprint when view admission changes', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor())
    const twoD = policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 1_000 })
    const threeD = policy.plan({ expectedRevision: 'rev-1', viewMode: '3d', scale: 1_000 })
    expect(twoD.fingerprint).not.toBe(threeD.fingerprint)
  })

  it('rejects stale plan revisions', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    expect(() => policy.plan({ expectedRevision: 'rev-0', viewMode: '2d', scale: 1_000 })).toThrow('stale-plan-revision')
  })

  it('rejects invalid plan scales', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    expect(() => policy.plan({ expectedRevision: 'rev-1', viewMode: '2d', scale: 0 })).toThrow('scale')
  })

  it('rebases idle records and invalidates previous generations', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor())
    policy.rebaseRevision('rev-2')
    const snapshot = policy.snapshot()
    expect(snapshot.revision).toBe('rev-2')
    expect(snapshot.layers[0]?.revision).toBe('rev-2')
    expect(snapshot.layers[0]?.phase).toBe('registered')
    expect(snapshot.layers[0]?.generation).toBe(2)
  })

  it('refuses revision rebase while an asynchronous load is live', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor(), 1)
    policy.beginLoad('roads', 'rev-1', 2)
    expect(() => policy.rebaseRevision('rev-2')).toThrow('cannot-rebase-while-loading')
  })

  it('preserves disposed records across revision rebase', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    ready(policy, descriptor())
    policy.disposeLayer('roads', 'rev-1', 10)
    policy.rebaseRevision('rev-2')
    expect(policy.snapshot().layers[0]?.phase).toBe('disposed')
    expect(policy.snapshot().layers[0]?.revision).toBe('rev-1')
  })

  it('returns deterministic snapshots ordered by id', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor({ id: 'z' }), 1)
    policy.register(descriptor({ id: 'a' }), 1)
    expect(policy.snapshot().layers.map((layer) => layer.id)).toEqual(['a', 'z'])
  })

  it('reports phase counts without exposing mutable state', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor({ id: 'registered' }), 1)
    ready(policy, descriptor({ id: 'ready' }), 10)
    ready(policy, descriptor({ id: 'suspended' }), 20)
    policy.suspend('suspended', 'rev-1', 30)
    const snapshot = policy.snapshot()
    expect(snapshot.registered).toBe(1)
    expect(snapshot.ready).toBe(1)
    expect(snapshot.suspended).toBe(1)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.layers)).toBe(true)
  })

  it('clears retained scalar records on policy disposal', () => {
    const policy = new ArcGisLayerLifecyclePolicy('rev-1', budget)
    policy.register(descriptor(), 1)
    policy.dispose()
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('arcgis-layer-lifecycle-disposed')
    expect(() => policy.register(descriptor({ id: 'new' }), 2)).toThrow('arcgis-layer-lifecycle-disposed')
  })
})
