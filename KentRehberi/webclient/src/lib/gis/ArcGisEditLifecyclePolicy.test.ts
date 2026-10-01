import { describe, expect, it } from 'vitest'
import { ArcGisEditLifecyclePolicy, type ArcGisEditBudget, type ArcGisEditRequest } from './ArcGisEditLifecyclePolicy'

const budget: ArcGisEditBudget = {
  maxLayers: 4, maxSessions: 8, maxRunning: 2,
  maxVerticesPerSession: 1000, maxBytesPerSession: 100_000,
  maxTotalVertices: 4000, maxTotalBytes: 400_000,
  queueTtlMs: 100, runLeaseMs: 200, readyTtlMs: 300,
}
const request = (overrides: Partial<ArcGisEditRequest> = {}): ArcGisEditRequest => ({
  id: 'edit-1', layerId: 'parcels', revision: 7, intent: 'update', objectId: 42,
  vertexCount: 20, estimatedBytes: 1000, wkid: 3857, ...overrides,
})
const policy = (b: Partial<ArcGisEditBudget> = {}) => {
  const p = new ArcGisEditLifecyclePolicy({ ...budget, ...b }); p.setLayerRevision('parcels', 7); return p
}

describe('ArcGisEditLifecyclePolicy', () => {
  it('runs an admitted edit through queued, running, ready and consumed states', () => {
    const p = policy(); p.enqueue(request(), 0); const running = p.next(1)!
    expect(running.state).toBe('running')
    const ready = p.complete(running.id, running.token, 2)
    expect(ready.state).toBe('ready'); p.consume(ready.id, ready.token); expect(p.snapshot()).toHaveLength(0)
  })

  it('prioritizes commit then delete then update then create deterministically', () => {
    const p = policy({ maxRunning: 8 })
    p.enqueue(request({ id: 'c', intent: 'create' }), 0)
    p.enqueue(request({ id: 'u', intent: 'update' }), 0)
    p.enqueue(request({ id: 'd', intent: 'delete' }), 0)
    p.enqueue(request({ id: 'm', intent: 'commit' }), 0)
    expect([p.next(1)?.id, p.next(1)?.id, p.next(1)?.id, p.next(1)?.id]).toEqual(['m', 'd', 'u', 'c'])
  })

  it('uses stable identity ordering for equal priority and timestamp', () => {
    const p = policy(); p.enqueue(request({ id: 'z' }), 0); p.enqueue(request({ id: 'a' }), 0)
    expect(p.next(1)?.id).toBe('a')
  })

  it('rejects stale layer revisions', () => {
    const p = policy(); expect(() => p.enqueue(request({ revision: 6 }), 0)).toThrow(/stale edit request/)
  })

  it('invalidates sessions when a layer revision changes', () => {
    const p = policy(); p.enqueue(request(), 0); p.setLayerRevision('parcels', 8); expect(p.snapshot()).toHaveLength(0)
  })

  it('rejects stale completion tokens', () => {
    const p = policy(); p.enqueue(request(), 0); const running = p.next(1)!
    expect(() => p.complete(running.id, running.token + 1, 2)).toThrow(/stale edit completion/)
  })

  it('enforces running cardinality', () => {
    const p = policy({ maxRunning: 1 }); p.enqueue(request({ id: 'a' }), 0); p.enqueue(request({ id: 'b' }), 0)
    expect(p.next(1)).toBeDefined(); expect(p.next(1)).toBeUndefined()
  })

  it('enforces session cardinality', () => {
    const p = policy({ maxSessions: 1 }); p.enqueue(request(), 0)
    expect(() => p.enqueue(request({ id: 'other' }), 0)).toThrow(/session budget/)
  })

  it('enforces per-session vertex and byte budgets', () => {
    expect(() => policy({ maxVerticesPerSession: 2 }).enqueue(request({ vertexCount: 3 }), 0)).toThrow(/vertex budget/)
    expect(() => policy({ maxBytesPerSession: 2 }).enqueue(request({ estimatedBytes: 3 }), 0)).toThrow(/byte budget/)
  })

  it('enforces aggregate vertex and byte budgets', () => {
    const vertices = policy({ maxTotalVertices: 30 }); vertices.enqueue(request({ id: 'a', vertexCount: 20 }), 0)
    expect(() => vertices.enqueue(request({ id: 'b', vertexCount: 20 }), 0)).toThrow(/aggregate edit vertex/)
    const bytes = policy({ maxTotalBytes: 1500 }); bytes.enqueue(request({ id: 'a', estimatedBytes: 1000 }), 0)
    expect(() => bytes.enqueue(request({ id: 'b', estimatedBytes: 1000 }), 0)).toThrow(/aggregate edit byte/)
  })

  it('expires queued sessions', () => {
    const p = policy(); p.enqueue(request(), 0); expect(p.expire(100)).toBe(1); expect(p.snapshot()).toHaveLength(0)
  })

  it('expires running leases', () => {
    const p = policy(); p.enqueue(request(), 0); p.next(1); expect(p.expire(201)).toBe(1)
  })

  it('expires ready results', () => {
    const p = policy(); p.enqueue(request(), 0); const r = p.next(1)!; p.complete(r.id, r.token, 2)
    expect(p.expire(302)).toBe(1)
  })

  it('supports explicit cancellation', () => {
    const p = policy(); p.enqueue(request(), 0); expect(p.cancel('edit-1')).toBe(true); expect(p.cancel('edit-1')).toBe(false)
  })

  it('returns immutable detached snapshots', () => {
    const p = policy(); const admitted = p.enqueue(request(), 0)
    expect(Object.isFrozen(admitted)).toBe(true); expect(Object.isFrozen(p.snapshot()[0])).toBe(true)
  })

  it('builds deterministic payload-free fingerprints', () => {
    const a = policy(), b = policy(); a.enqueue(request({ id: 'b' }), 0); a.enqueue(request({ id: 'a' }), 0)
    b.enqueue(request({ id: 'a' }), 0); b.enqueue(request({ id: 'b' }), 0); expect(a.fingerprint()).toBe(b.fingerprint())
  })

  it('rejects malformed numeric and identity metadata', () => {
    expect(() => policy().enqueue(request({ id: ' ' }), 0)).toThrow(/invalid id/)
    expect(() => policy().enqueue(request({ wkid: 0 }), 0)).toThrow(/invalid wkid/)
    expect(() => policy().enqueue(request({ vertexCount: -1 }), 0)).toThrow(/invalid vertexCount/)
    expect(() => policy().enqueue(request({ estimatedBytes: Number.NaN }), 0)).toThrow(/invalid estimatedBytes/)
  })

  it('enforces layer cardinality without retaining the rejected layer', () => {
    const p = policy({ maxLayers: 1 }); expect(() => p.setLayerRevision('buildings', 1)).toThrow(/layer budget/)
    p.enqueue(request(), 0); expect(p.snapshot()).toHaveLength(1)
  })

  it('fails closed after disposal', () => {
    const p = policy(); p.enqueue(request(), 0); p.dispose()
    expect(() => p.snapshot()).toThrow(/disposed/); expect(() => p.enqueue(request(), 1)).toThrow(/disposed/)
  })
})
