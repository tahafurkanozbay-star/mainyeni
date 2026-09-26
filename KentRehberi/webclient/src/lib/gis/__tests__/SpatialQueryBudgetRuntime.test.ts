import { describe, expect, it } from 'vitest'
import { SpatialQueryBudgetRuntime, type SpatialQueryRequest } from '../SpatialQueryBudgetRuntime'

const request = (layerId: string, spatialKey: string, overrides: Partial<SpatialQueryRequest> = {}): SpatialQueryRequest => ({
  layerId,
  operation: 'queryFeatures',
  spatialKey,
  estimatedBytes: 100,
  estimatedFeatures: 10,
  priority: 'interactive',
  ...overrides,
})

const activeLease = (runtime: SpatialQueryBudgetRuntime, value: SpatialQueryRequest) => {
  const result = runtime.admit(value)
  expect(result.kind).toBe('active')
  if (result.kind !== 'active') throw new Error('expected active lease')
  return result.lease
}

describe('SpatialQueryBudgetRuntime', () => {
  it('admits work while global capacity remains', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 2, maxActivePerLayer: 2 })
    expect(runtime.admit(request('a', '1')).kind).toBe('active')
    expect(runtime.admit(request('a', '2')).kind).toBe('active')
    expect(runtime.snapshot()).toMatchObject({ active: 2, queued: 0, activeBytes: 200 })
  })

  it('queues work after global concurrency is exhausted', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    activeLease(runtime, request('a', '1'))
    const result = runtime.admit(request('b', '2'))
    expect(result.kind).toBe('queued')
    expect(runtime.snapshot()).toMatchObject({ active: 1, queued: 1, queuedBytes: 100 })
  })

  it('enforces per-layer active concurrency without blocking other layers', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 3, maxActivePerLayer: 1 })
    activeLease(runtime, request('a', '1'))
    expect(runtime.admit(request('a', '2')).kind).toBe('queued')
    expect(runtime.admit(request('b', '3')).kind).toBe('active')
  })

  it('promotes critical work before interactive and background work', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    const lease = activeLease(runtime, request('root', '0'))
    runtime.admit(request('b', 'background', { priority: 'background' }))
    runtime.admit(request('c', 'interactive', { priority: 'interactive' }))
    runtime.admit(request('d', 'critical', { priority: 'critical' }))
    const promoted = runtime.release(lease)
    expect(promoted).toHaveLength(1)
    expect(promoted[0]?.lease.layerId).toBe('d')
  })

  it('preserves FIFO ordering for equal priorities', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    const lease = activeLease(runtime, request('root', '0'))
    runtime.admit(request('a', '1'))
    runtime.admit(request('b', '2'))
    runtime.admit(request('c', '3'))
    expect(runtime.release(lease)[0]?.lease.layerId).toBe('a')
  })

  it('deduplicates identical active identities', () => {
    const runtime = new SpatialQueryBudgetRuntime()
    const first = runtime.admit(request('a', 'same'))
    const duplicate = runtime.admit(request('a', 'same'))
    expect(first.kind).toBe('active')
    expect(duplicate.kind).toBe('duplicate')
  })

  it('deduplicates identical queued identities', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    activeLease(runtime, request('root', '0'))
    const first = runtime.admit(request('a', 'same'))
    const duplicate = runtime.admit(request('a', 'same'))
    expect(first.kind).toBe('queued')
    expect(duplicate.kind).toBe('duplicate')
  })

  it('distinguishes operation in deterministic identity', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 3, maxActivePerLayer: 3 })
    expect(runtime.admit(request('a', 'same', { operation: 'queryFeatures' })).kind).toBe('active')
    expect(runtime.admit(request('a', 'same', { operation: 'queryCount' })).kind).toBe('active')
  })

  it('rejects blank layer identity', () => {
    const runtime = new SpatialQueryBudgetRuntime()
    expect(runtime.admit(request('  ', 'x'))).toEqual({ kind: 'rejected', reason: 'invalid-identity' })
  })

  it('rejects control characters in identity', () => {
    const runtime = new SpatialQueryBudgetRuntime()
    expect(runtime.admit(request('a\u0000b', 'x'))).toEqual({ kind: 'rejected', reason: 'invalid-identity' })
  })

  it('rejects unsafe byte estimates', () => {
    const runtime = new SpatialQueryBudgetRuntime()
    expect(runtime.admit(request('a', 'x', { estimatedBytes: Number.MAX_SAFE_INTEGER + 1 }))).toEqual({ kind: 'rejected', reason: 'invalid-estimate' })
  })

  it('rejects zero feature estimates', () => {
    const runtime = new SpatialQueryBudgetRuntime()
    expect(runtime.admit(request('a', 'x', { estimatedFeatures: 0 }))).toEqual({ kind: 'rejected', reason: 'invalid-estimate' })
  })

  it('enforces per-query feature budget', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxFeaturesPerQuery: 20 })
    expect(runtime.admit(request('a', 'x', { estimatedFeatures: 21 }))).toEqual({ kind: 'rejected', reason: 'feature-budget' })
  })

  it('enforces active byte feasibility before queueing', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActiveBytes: 50 })
    expect(runtime.admit(request('a', 'x', { estimatedBytes: 51 }))).toEqual({ kind: 'rejected', reason: 'active-byte-budget' })
  })

  it('enforces bounded queue count', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1, maxQueued: 1, maxQueuedPerLayer: 1 })
    activeLease(runtime, request('root', '0'))
    expect(runtime.admit(request('a', '1')).kind).toBe('queued')
    expect(runtime.admit(request('b', '2'))).toEqual({ kind: 'rejected', reason: 'queue-budget' })
  })

  it('enforces bounded queued bytes', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1, maxQueuedBytes: 150 })
    activeLease(runtime, request('root', '0'))
    expect(runtime.admit(request('a', '1', { estimatedBytes: 100 })).kind).toBe('queued')
    expect(runtime.admit(request('b', '2', { estimatedBytes: 100 }))).toEqual({ kind: 'rejected', reason: 'queue-byte-budget' })
  })

  it('enforces per-layer queue count', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1, maxQueuedPerLayer: 1 })
    activeLease(runtime, request('root', '0'))
    expect(runtime.admit(request('a', '1')).kind).toBe('queued')
    expect(runtime.admit(request('a', '2'))).toEqual({ kind: 'rejected', reason: 'layer-queue-budget' })
  })

  it('accounts active and queued features independently', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    activeLease(runtime, request('a', '1', { estimatedFeatures: 11 }))
    runtime.admit(request('b', '2', { estimatedFeatures: 22 }))
    expect(runtime.snapshot()).toMatchObject({ activeFeatures: 11, queuedFeatures: 22 })
  })

  it('releases accounting before promotion', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    const lease = activeLease(runtime, request('a', '1', { estimatedBytes: 80 }))
    runtime.admit(request('b', '2', { estimatedBytes: 70 }))
    runtime.release(lease)
    expect(runtime.snapshot()).toMatchObject({ active: 1, queued: 0, activeBytes: 70, queuedBytes: 0 })
  })

  it('ignores stale generation releases', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    const first = activeLease(runtime, request('a', '1'))
    runtime.release(first)
    const second = activeLease(runtime, request('a', '1'))
    expect(second.generation).toBeGreaterThan(first.generation)
    expect(runtime.release(first)).toEqual([])
    expect(runtime.snapshot().active).toBe(1)
  })

  it('cancels queued identity without disturbing active work', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    activeLease(runtime, request('a', '1'))
    runtime.admit(request('b', '2'))
    runtime.cancel(request('b', '2'))
    expect(runtime.snapshot()).toMatchObject({ active: 1, queued: 0 })
  })

  it('cancels active identity and promotes eligible work', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    activeLease(runtime, request('a', '1'))
    runtime.admit(request('b', '2'))
    const promoted = runtime.cancel(request('a', '1'))
    expect(promoted[0]?.lease.layerId).toBe('b')
  })

  it('cancels all work for one normalized layer', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 2, maxActivePerLayer: 1 })
    activeLease(runtime, request(' a ', '1'))
    activeLease(runtime, request('b', '2'))
    runtime.admit(request('a', '3'))
    runtime.cancelLayer('a')
    expect(runtime.snapshot().layers.some(layer => layer.layerId === 'a')).toBe(false)
  })

  it('promotes other layers after layer cancellation', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    activeLease(runtime, request('a', '1'))
    runtime.admit(request('b', '2'))
    expect(runtime.cancelLayer('a')[0]?.lease.layerId).toBe('b')
  })

  it('clear resets all bounded accounting', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    activeLease(runtime, request('a', '1'))
    runtime.admit(request('b', '2'))
    runtime.clear()
    expect(runtime.snapshot()).toEqual({ active: 0, queued: 0, activeBytes: 0, queuedBytes: 0, activeFeatures: 0, queuedFeatures: 0, layers: [] })
  })

  it('allows identities to be reused after clear with new generation', () => {
    const runtime = new SpatialQueryBudgetRuntime()
    const first = activeLease(runtime, request('a', '1'))
    runtime.clear()
    const second = activeLease(runtime, request('a', '1'))
    expect(second.generation).toBe(first.generation + 1)
  })

  it('clamps oversized timeout to maximum', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxTimeoutMs: 5000, defaultTimeoutMs: 1000 })
    const lease = activeLease(runtime, request('a', '1', { timeoutMs: 9999 }))
    expect(lease.timeoutMs).toBe(5000)
  })

  it('uses default timeout for invalid timeout', () => {
    const runtime = new SpatialQueryBudgetRuntime({ defaultTimeoutMs: 1234, maxTimeoutMs: 5000 })
    const lease = activeLease(runtime, request('a', '1', { timeoutMs: -1 }))
    expect(lease.timeoutMs).toBe(1234)
  })

  it('rejects invalid constructor budgets', () => {
    expect(() => new SpatialQueryBudgetRuntime({ maxActive: 0 })).toThrow('Invalid spatial query budget')
  })

  it('rejects per-layer active budget larger than global budget', () => {
    expect(() => new SpatialQueryBudgetRuntime({ maxActive: 2, maxActivePerLayer: 3 })).toThrow('maxActivePerLayer exceeds maxActive')
  })

  it('rejects per-layer queue budget larger than global budget', () => {
    expect(() => new SpatialQueryBudgetRuntime({ maxQueued: 2, maxQueuedPerLayer: 3 })).toThrow('maxQueuedPerLayer exceeds maxQueued')
  })

  it('rejects default timeout larger than maximum timeout', () => {
    expect(() => new SpatialQueryBudgetRuntime({ defaultTimeoutMs: 6000, maxTimeoutMs: 5000 })).toThrow('defaultTimeoutMs exceeds maxTimeoutMs')
  })

  it('reports layers in deterministic lexical order', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 3, maxActivePerLayer: 1 })
    activeLease(runtime, request('z', '1'))
    activeLease(runtime, request('a', '2'))
    activeLease(runtime, request('m', '3'))
    expect(runtime.snapshot().layers.map(layer => layer.layerId)).toEqual(['a', 'm', 'z'])
  })

  it('reports per-layer active byte accounting', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 2, maxActivePerLayer: 2 })
    activeLease(runtime, request('a', '1', { estimatedBytes: 25 }))
    activeLease(runtime, request('a', '2', { estimatedBytes: 35 }))
    expect(runtime.snapshot().layers[0]).toMatchObject({ active: 2, activeBytes: 60 })
  })

  it('reports per-layer queued byte accounting', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    activeLease(runtime, request('root', '0'))
    runtime.admit(request('a', '1', { estimatedBytes: 25 }))
    runtime.admit(request('a', '2', { estimatedBytes: 35 }))
    expect(runtime.snapshot().layers.find(layer => layer.layerId === 'a')).toMatchObject({ queued: 2, queuedBytes: 60 })
  })

  it('returns queue keys in scheduling order', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    activeLease(runtime, request('root', '0'))
    runtime.admit(request('a', 'bg', { priority: 'background' }))
    runtime.admit(request('b', 'critical', { priority: 'critical' }))
    runtime.admit(request('c', 'interactive', { priority: 'interactive' }))
    const keys = runtime.queuedKeys()
    expect(keys[0]).toContain('critical')
    expect(keys[2]).toContain('bg')
  })

  it('returns immutable queue key snapshots', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    activeLease(runtime, request('root', '0'))
    runtime.admit(request('a', '1'))
    expect(Object.isFrozen(runtime.queuedKeys())).toBe(true)
  })

  it('returns immutable promotion arrays and leases', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    const lease = activeLease(runtime, request('root', '0'))
    runtime.admit(request('a', '1'))
    const promoted = runtime.release(lease)
    expect(Object.isFrozen(promoted)).toBe(true)
    expect(Object.isFrozen(promoted[0]?.lease)).toBe(true)
  })

  it('reports waited turns monotonically for promoted work', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    const lease = activeLease(runtime, request('root', '0'))
    runtime.admit(request('a', '1'))
    runtime.admit(request('b', '2'))
    const promoted = runtime.release(lease)
    expect(promoted[0]?.waitedTurns).toBeGreaterThan(0)
  })

  it('does not promote a layer beyond its active cap', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 2, maxActivePerLayer: 1 })
    const a = activeLease(runtime, request('a', '1'))
    const b = activeLease(runtime, request('b', '1'))
    runtime.admit(request('b', '2', { priority: 'critical' }))
    runtime.admit(request('c', '1', { priority: 'interactive' }))
    expect(runtime.release(a)[0]?.lease.layerId).toBe('c')
    expect(runtime.snapshot().layers.find(layer => layer.layerId === 'b')?.active).toBe(1)
    expect(b.layerId).toBe('b')
  })

  it('skips byte-ineligible queued work and promotes eligible work', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 2, maxActivePerLayer: 2, maxActiveBytes: 150 })
    const lease = activeLease(runtime, request('root', '0', { estimatedBytes: 100 }))
    runtime.admit(request('large', '1', { estimatedBytes: 100, priority: 'critical' }))
    runtime.admit(request('small', '2', { estimatedBytes: 40, priority: 'interactive' }))
    expect(runtime.snapshot().active).toBe(2)
    const promoted = runtime.release(lease)
    expect(promoted.some(item => item.lease.layerId === 'large')).toBe(true)
  })

  it('keeps accounting non-negative after repeated stale releases', () => {
    const runtime = new SpatialQueryBudgetRuntime()
    const lease = activeLease(runtime, request('a', '1'))
    runtime.release(lease)
    runtime.release(lease)
    runtime.release(lease)
    expect(runtime.snapshot()).toMatchObject({ active: 0, activeBytes: 0, activeFeatures: 0 })
  })

  it('normalizes whitespace for duplicate identity detection', () => {
    const runtime = new SpatialQueryBudgetRuntime()
    activeLease(runtime, request(' a ', ' tile '))
    expect(runtime.admit(request('a', 'tile')).kind).toBe('duplicate')
  })

  it('keeps distinct Unicode identities distinct', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 2, maxActivePerLayer: 2 })
    expect(runtime.admit(request('ulaşım', 'çankaya')).kind).toBe('active')
    expect(runtime.admit(request('ulaşım', 'Çankaya')).kind).toBe('active')
  })

  it('bounds identity segment length', () => {
    const runtime = new SpatialQueryBudgetRuntime()
    expect(runtime.admit(request('a'.repeat(257), 'x'))).toEqual({ kind: 'rejected', reason: 'invalid-identity' })
  })

  it('does not mutate caller requests', () => {
    const runtime = new SpatialQueryBudgetRuntime()
    const value = request(' a ', 'x')
    runtime.admit(value)
    expect(value.layerId).toBe(' a ')
  })

  it('produces frozen snapshots and layer entries', () => {
    const runtime = new SpatialQueryBudgetRuntime()
    activeLease(runtime, request('a', '1'))
    const snapshot = runtime.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.layers)).toBe(true)
    expect(Object.isFrozen(snapshot.layers[0])).toBe(true)
  })

  it('has reflects active, queued, cancelled, and cleared state', () => {
    const runtime = new SpatialQueryBudgetRuntime({ maxActive: 1, maxActivePerLayer: 1 })
    const a = request('a', '1')
    const b = request('b', '2')
    activeLease(runtime, a)
    runtime.admit(b)
    expect(runtime.has(a)).toBe(true)
    expect(runtime.has(b)).toBe(true)
    runtime.cancel(b)
    expect(runtime.has(b)).toBe(false)
    runtime.clear()
    expect(runtime.has(a)).toBe(false)
  })
})
