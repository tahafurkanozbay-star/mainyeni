import { describe, expect, it } from 'vitest'
import { ArcGisLayerLoadLifecyclePolicy, type ArcGisLayerLoadBudget, type ArcGisLayerLoadRequest } from './ArcGisLayerLoadLifecyclePolicy'

const budget: ArcGisLayerLoadBudget = {
  maxLoads: 6, maxLoadsPerView: 4, maxLoading: 2, maxReady: 3,
  maxReadyBytesPerLayer: 10_000, maxAggregateReadyBytes: 20_000,
  queueTtlMs: 100, loadTtlMs: 200, readyTtlMs: 300,
}
const request = (overrides: Partial<ArcGisLayerLoadRequest> = {}): ArcGisLayerLoadRequest => ({
  loadId: 'load-1', viewId: 'view-1', serviceId: 'svc-1', layerId: 'layer-1', revision: 1,
  intent: 'visible', requestedAt: 10, estimatedBytes: 2_000, ...overrides,
})
const policy = (custom = budget) => new ArcGisLayerLoadLifecyclePolicy(custom)
const ready = (p: ArcGisLayerLoadLifecyclePolicy, loadId = 'load-1', bytes = 2_000, now = 30) => {
  p.takeNext(20)
  return p.complete({ loadId, viewId: 'view-1', serviceId: 'svc-1', layerId: 'layer-1', revision: 1 }, bytes, now)
}

describe('ArcGisLayerLoadLifecyclePolicy', () => {
  it('schedules interactive before visible before background', () => {
    const p = policy()
    p.enqueue(request({ loadId: 'bg', intent: 'background', requestedAt: 1 }))
    p.enqueue(request({ loadId: 'visible', intent: 'visible', requestedAt: 2 }))
    p.enqueue(request({ loadId: 'interactive', intent: 'interactive', requestedAt: 3 }))
    expect(p.takeNext(10)?.loadId).toBe('interactive')
    expect(p.takeNext(11)?.loadId).toBe('visible')
  })

  it('uses request order deterministically for equal priority', () => {
    const p = policy()
    p.enqueue(request({ loadId: 'a', requestedAt: 4 })); p.enqueue(request({ loadId: 'b', requestedAt: 4 }))
    expect(p.takeNext(10)?.loadId).toBe('a'); expect(p.takeNext(10)?.loadId).toBe('b')
  })

  it('bounds loading concurrency', () => {
    const p = policy()
    for (const loadId of ['a', 'b', 'c']) p.enqueue(request({ loadId }))
    expect(p.takeNext(20)?.loadId).toBe('a'); expect(p.takeNext(20)?.loadId).toBe('b'); expect(p.takeNext(20)).toBeUndefined()
  })

  it('bounds global and per-view cardinality', () => {
    const p = policy({ ...budget, maxLoads: 2, maxLoadsPerView: 1 })
    p.enqueue(request({ loadId: 'a' }))
    expect(() => p.enqueue(request({ loadId: 'b' }))).toThrow(/view/)
    expect(() => p.enqueue(request({ loadId: 'b', viewId: 'view-2' }))).not.toThrow()
    expect(() => p.enqueue(request({ loadId: 'c', viewId: 'view-3' }))).toThrow(/capacity/)
  })

  it('rejects duplicate ownership', () => {
    const p = policy(); p.enqueue(request()); expect(() => p.enqueue(request())).toThrow(/duplicate/)
  })

  it('reconciles estimated to actual ready bytes', () => {
    const p = policy(); p.enqueue(request({ estimatedBytes: 100 })); const result = ready(p, 'load-1', 4_000)
    expect(result.phase).toBe('ready'); expect(result.actualBytes).toBe(4_000)
  })

  it('rejects oversized estimated residency before queueing', () => {
    const p = policy(); expect(() => p.enqueue(request({ estimatedBytes: 10_001 }))).toThrow(/estimated/); expect(p.snapshot()).toHaveLength(0)
  })

  it('rejects oversized actual residency and releases authority', () => {
    const p = policy(); p.enqueue(request()); p.takeNext(20)
    expect(() => p.complete({ loadId: 'load-1', viewId: 'view-1', serviceId: 'svc-1', layerId: 'layer-1', revision: 1 }, 10_001, 30)).toThrow(/byte budget/)
    expect(p.snapshot()).toHaveLength(0)
  })

  it('bounds aggregate ready residency', () => {
    const p = policy({ ...budget, maxAggregateReadyBytes: 12_000 })
    p.enqueue(request({ loadId: 'a' })); ready(p, 'a', 8_000)
    p.enqueue(request({ loadId: 'b' })); p.takeNext(40)
    expect(() => p.complete({ loadId: 'b', viewId: 'view-1', serviceId: 'svc-1', layerId: 'layer-1', revision: 1 }, 5_000, 50)).toThrow(/aggregate/)
    expect(p.snapshot().some(x => x.loadId === 'b')).toBe(false)
  })

  it('bounds ready cardinality', () => {
    const p = policy({ ...budget, maxReady: 1 })
    p.enqueue(request({ loadId: 'a' })); ready(p, 'a', 1_000)
    p.enqueue(request({ loadId: 'b' })); p.takeNext(40)
    expect(() => p.complete({ loadId: 'b', viewId: 'view-1', serviceId: 'svc-1', layerId: 'layer-1', revision: 1 }, 1_000, 50)).toThrow(/ready layer capacity/)
  })

  it('invalidates queued and loading work on revision advance', () => {
    const p = policy(); p.enqueue(request({ loadId: 'queued' })); p.enqueue(request({ loadId: 'running' })); p.takeNext(20)
    expect(p.advanceRevision('svc-1', 'layer-1', 2)).toBe(2); expect(p.snapshot()).toHaveLength(0)
  })

  it('rejects stale enqueue and backwards revision movement', () => {
    const p = policy(); p.advanceRevision('svc-1', 'layer-1', 3)
    expect(() => p.enqueue(request({ revision: 2 }))).toThrow(/stale/)
    expect(() => p.advanceRevision('svc-1', 'layer-1', 2)).toThrow(/backwards/)
  })

  it('rejects late completion after revision invalidation', () => {
    const p = policy(); p.enqueue(request()); p.takeNext(20); p.advanceRevision('svc-1', 'layer-1', 2)
    expect(() => p.complete({ loadId: 'load-1', viewId: 'view-1', serviceId: 'svc-1', layerId: 'layer-1', revision: 1 }, 1_000, 30)).toThrow(/not loading/)
  })

  it('expires queue, load and ready leases', () => {
    const queued = policy(); queued.enqueue(request({ requestedAt: 0 })); expect(queued.expire(101)).toBe(1)
    const loading = policy(); loading.enqueue(request({ requestedAt: 0 })); loading.takeNext(10); expect(loading.expire(211)).toBe(1)
    const resident = policy(); resident.enqueue(request({ requestedAt: 0 })); ready(resident); expect(resident.expire(331)).toBe(1)
  })

  it('touch extends only live ready residency', () => {
    const p = policy(); p.enqueue(request()); ready(p)
    expect(p.touch('view-1', 'svc-1', 'layer-1', 'load-1', 40)).toBe(true)
    expect(p.snapshot()[0].expiresAt).toBe(340)
    expect(p.touch('view-1', 'svc-1', 'layer-1', 'missing', 40)).toBe(false)
  })

  it('consume transfers ready authority exactly once', () => {
    const p = policy(); p.enqueue(request()); ready(p)
    expect(p.consume('view-1', 'svc-1', 'layer-1', 'load-1')?.phase).toBe('ready')
    expect(p.consume('view-1', 'svc-1', 'layer-1', 'load-1')).toBeUndefined()
  })

  it('cancel refuses resident entries but releases active work', () => {
    const p = policy(); p.enqueue(request({ loadId: 'queued' })); expect(p.cancel('view-1', 'svc-1', 'layer-1', 'queued')).toBe(true)
    p.enqueue(request()); ready(p); expect(p.cancel('view-1', 'svc-1', 'layer-1', 'load-1')).toBe(false)
  })

  it('tears down view, layer and service authority', () => {
    const p = policy()
    p.enqueue(request({ loadId: 'a' })); p.enqueue(request({ loadId: 'b', viewId: 'view-2' }))
    expect(p.releaseView('view-1')).toBe(1); expect(p.releaseLayer('svc-1', 'layer-1')).toBe(1)
    p.enqueue(request({ loadId: 'c', viewId: 'view-3', layerId: 'layer-2' })); expect(p.releaseService('svc-1')).toBe(1)
  })

  it('returns detached frozen scalar snapshots', () => {
    const p = policy(); const view = p.enqueue(request())
    expect(Object.isFrozen(view)).toBe(true)
    for (const forbidden of ['layer', 'layerView', 'renderer', 'popupTemplate', 'features', 'credential', 'response', 'abortController']) expect(view).not.toHaveProperty(forbidden)
  })

  it('fingerprint is deterministic and payload-free', () => {
    const a = policy(), b = policy(); a.enqueue(request({ loadId: 'a' })); b.enqueue(request({ loadId: 'a' }))
    expect(a.fingerprint()).toBe(b.fingerprint()); expect(a.fingerprint()).not.toContain('[object Object]')
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite request time %s', requestedAt => {
    expect(() => policy().enqueue(request({ requestedAt }))).toThrow(/finite/)
  })

  it.each(['', 'bad id', 'x'.repeat(161)])('rejects malformed load identifiers', loadId => {
    expect(() => policy().enqueue(request({ loadId }))).toThrow(/invalid/)
  })

  it('rejects impossible budgets', () => {
    expect(() => policy({ ...budget, maxLoadsPerView: 7 })).toThrow(/impossible/)
    expect(() => policy({ ...budget, maxLoading: 7 })).toThrow(/impossible/)
    expect(() => policy({ ...budget, maxAggregateReadyBytes: 9_999 })).toThrow(/inconsistent/)
    expect(() => policy({ ...budget, readyTtlMs: 0 })).toThrow(/positive/)
  })

  it('dispose clears authority and fails closed', () => {
    const p = policy(); p.enqueue(request()); p.dispose(); expect(() => p.snapshot()).toThrow(/disposed/); expect(() => p.enqueue(request())).toThrow(/disposed/)
  })
})
