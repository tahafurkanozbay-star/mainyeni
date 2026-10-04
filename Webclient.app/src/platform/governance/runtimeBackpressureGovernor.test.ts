import { describe, expect, it } from 'vitest'
import { RuntimeBackpressureGovernor, type RuntimeBackpressureLease } from './runtimeBackpressureGovernor'

const policy = {
  maxScopes: 3,
  maxInflightGlobal: 3,
  maxInflightPerScope: 2,
  maxQueuedGlobal: 3,
  maxQueuedPerScope: 2,
  highWatermarkRatio: 0.66,
  criticalReserve: 1,
  leaseTtlMs: 100,
  idleScopeTtlMs: 200,
  maxClockRollbackMs: 5,
} as const

describe('RuntimeBackpressureGovernor', () => {
  it('reserves global capacity for critical work', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    expect(governor.acquire({ scope: 'a', lane: 'interactive', now: 1 })).not.toBeNull()
    expect(governor.acquire({ scope: 'b', lane: 'interactive', now: 2 })).not.toBeNull()
    expect(governor.decide({ scope: 'c', lane: 'interactive', now: 3 })).toBe('defer')
    expect(governor.acquire({ scope: 'c', lane: 'critical', now: 3 })).not.toBeNull()
    expect(governor.snapshot().inflight).toBe(3)
  })

  it('defers background work at the configured high watermark', () => {
    const governor = new RuntimeBackpressureGovernor({ ...policy, criticalReserve: 0 })
    expect(governor.acquire({ scope: 'a', lane: 'interactive', now: 1 })).not.toBeNull()
    expect(governor.acquire({ scope: 'b', lane: 'interactive', now: 2 })).not.toBeNull()
    expect(governor.decide({ scope: 'c', lane: 'background', now: 3 })).toBe('defer')
  })

  it('bounds per-scope and global queue cardinality', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    expect(governor.enqueue('a', 1)).toBe(true)
    expect(governor.enqueue('a', 2)).toBe(true)
    expect(governor.enqueue('a', 3)).toBe(false)
    expect(governor.enqueue('b', 4)).toBe(true)
    expect(governor.enqueue('c', 5)).toBe(false)
    expect(governor.snapshot()).toMatchObject({ queued: 3, scopes: 3 })
  })

  it('dequeues without underflow', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    expect(governor.enqueue('a', 1)).toBe(true)
    expect(governor.dequeue('a', 2)).toBe(true)
    expect(governor.dequeue('a', 3)).toBe(false)
    expect(governor.snapshot().queued).toBe(0)
  })

  it('expires leases and releases inflight capacity', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    expect(governor.acquire({ scope: 'a', lane: 'interactive', now: 1 })).not.toBeNull()
    expect(governor.snapshot().inflight).toBe(1)
    governor.sweep(101)
    expect(governor.snapshot().inflight).toBe(0)
  })

  it('renews live leases without retaining caller payloads', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    const lease = governor.acquire({ scope: 'a', lane: 'interactive', now: 1 })!
    const renewed = governor.renew(lease, 50)
    expect(renewed?.expiresAt).toBe(150)
    expect(Object.isFrozen(renewed)).toBe(true)
    expect(governor.release(renewed!, 60)).toBe(true)
  })

  it('rejects forged lease metadata', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    const lease = governor.acquire({ scope: 'a', lane: 'interactive', now: 1 })!
    const forged = { ...lease, scope: 'other' }
    expect(governor.release(forged, 2)).toBe(false)
    expect(governor.snapshot().inflight).toBe(1)
  })

  it('rejects stale lease metadata after renewal', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    const lease = governor.acquire({ scope: 'a', lane: 'interactive', now: 1 })!
    const renewed = governor.renew(lease, 20)!
    expect(governor.release(lease, 21)).toBe(false)
    expect(governor.release(renewed, 22)).toBe(true)
  })

  it('invalidates leases across scope generations', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    const lease = governor.acquire({ scope: 'a', lane: 'interactive', now: 1 })!
    expect(governor.resetScope('a', 2)).toBe(true)
    expect(governor.release(lease, 3)).toBe(false)
    expect(governor.snapshot().inflight).toBe(0)
  })

  it('evicts deterministic idle scopes when scope capacity is reached', () => {
    const governor = new RuntimeBackpressureGovernor({ ...policy, maxScopes: 2 })
    expect(governor.decide({ scope: 'b', lane: 'interactive', now: 1 })).toBe('admit')
    expect(governor.decide({ scope: 'a', lane: 'interactive', now: 1 })).toBe('admit')
    expect(governor.decide({ scope: 'c', lane: 'interactive', now: 2 })).toBe('admit')
    expect(governor.snapshot().scopes).toBe(2)
  })

  it('does not evict scopes with inflight or queued work', () => {
    const governor = new RuntimeBackpressureGovernor({ ...policy, maxScopes: 2 })
    expect(governor.acquire({ scope: 'a', lane: 'interactive', now: 1 })).not.toBeNull()
    expect(governor.enqueue('b', 2)).toBe(true)
    expect(() => governor.decide({ scope: 'c', lane: 'critical', now: 3 })).toThrow('scope capacity exhausted')
  })

  it('evicts idle scopes after ttl', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    expect(governor.decide({ scope: 'a', lane: 'interactive', now: 1 })).toBe('admit')
    governor.sweep(201)
    expect(governor.snapshot().scopes).toBe(0)
  })

  it('clamps small clock rollback to a monotonic watermark', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    governor.sweep(100)
    expect(() => governor.sweep(96)).not.toThrow()
    expect(governor.decide({ scope: 'a', lane: 'interactive', now: 97 })).toBe('admit')
  })

  it('fails closed on excessive clock rollback', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    governor.sweep(100)
    expect(() => governor.sweep(94)).toThrow('clock rollback exceeds maxClockRollbackMs')
  })

  it('keeps snapshot passive with respect to clock state', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    governor.sweep(10)
    expect(governor.snapshot()).toMatchObject({ inflight: 0, queued: 0, disposed: false })
    expect(governor.snapshot()).toEqual(governor.snapshot())
  })

  it('reports bounded aggregate pressure only', () => {
    const governor = new RuntimeBackpressureGovernor({ ...policy, criticalReserve: 0 })
    governor.acquire({ scope: 'secret-scope', lane: 'interactive', now: 1 })
    const snapshot = governor.snapshot()
    expect(snapshot.pressure).toBeCloseTo(1 / 3)
    expect(JSON.stringify(snapshot)).not.toContain('secret-scope')
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('validates policy invariants', () => {
    expect(() => new RuntimeBackpressureGovernor({ maxInflightGlobal: 2, maxInflightPerScope: 3 })).toThrow()
    expect(() => new RuntimeBackpressureGovernor({ maxQueuedGlobal: 2, maxQueuedPerScope: 3 })).toThrow()
    expect(() => new RuntimeBackpressureGovernor({ maxInflightGlobal: 2, criticalReserve: 2 })).toThrow()
    expect(() => new RuntimeBackpressureGovernor({ highWatermarkRatio: 0 })).toThrow()
  })

  it('validates identifiers and clocks', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    expect(() => governor.decide({ scope: '', lane: 'interactive', now: 1 })).toThrow()
    expect(() => governor.decide({ scope: 'a', lane: 'interactive', now: Number.NaN })).toThrow()
    expect(() => governor.enqueue('x'.repeat(129), 1)).toThrow()
  })

  it('disposes terminally and idempotently', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    governor.acquire({ scope: 'a', lane: 'interactive', now: 1 })
    governor.dispose()
    governor.dispose()
    expect(() => governor.snapshot()).toThrow('RuntimeBackpressureGovernor is disposed')
    expect(() => governor.decide({ scope: 'a', lane: 'critical', now: 2 })).toThrow('RuntimeBackpressureGovernor is disposed')
  })

  it('does not accept a structurally forged unknown lease', () => {
    const governor = new RuntimeBackpressureGovernor(policy)
    const forged: RuntimeBackpressureLease = Object.freeze({ id: 'rbg-1-999', scope: 'a', lane: 'critical', generation: 1, acquiredAt: 1, expiresAt: 101 })
    expect(governor.release(forged, 2)).toBe(false)
  })
})
