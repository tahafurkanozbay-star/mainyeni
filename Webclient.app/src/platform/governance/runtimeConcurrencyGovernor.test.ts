import { describe, expect, it } from 'vitest'
import { RuntimeConcurrencyGovernor } from './runtimeConcurrencyGovernor'

describe('RuntimeConcurrencyGovernor', () => {
  it('acquires and releases bounded work', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxActiveGlobal: 2, criticalActiveReserve: 0 })
    const lease = governor.acquire({ scope: 'map', kind: 'render', priority: 'interactive', now: 0 })!
    expect(governor.snapshot(0).active).toBe(1)
    expect(governor.release(lease, 1)).toBe(true)
    expect(governor.snapshot(1).active).toBe(0)
  })

  it('reserves global active capacity for critical work', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxActiveGlobal: 3, maxActivePerScope: 3, criticalActiveReserve: 1 })
    expect(governor.acquire({ scope: 'a', kind: 'compute', priority: 'interactive', now: 0 })).not.toBeNull()
    expect(governor.acquire({ scope: 'b', kind: 'compute', priority: 'interactive', now: 0 })).not.toBeNull()
    expect(governor.acquire({ scope: 'c', kind: 'compute', priority: 'interactive', now: 0 })).toBeNull()
    expect(governor.acquire({ scope: 'c', kind: 'compute', priority: 'critical', now: 0 })).not.toBeNull()
  })

  it('bounds active work per scope', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxActiveGlobal: 4, maxActivePerScope: 1, criticalActiveReserve: 0 })
    expect(governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: 0 })).not.toBeNull()
    expect(governor.acquire({ scope: 'map', kind: 'network', priority: 'critical', now: 0 })).toBeNull()
  })

  it('queues work with global and per-scope bounds', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxQueuedGlobal: 2, maxQueuedPerScope: 1 })
    expect(governor.enqueue({ scope: 'a', kind: 'compute', priority: 'background', now: 0 })).not.toBeNull()
    expect(governor.enqueue({ scope: 'a', kind: 'render', priority: 'background', now: 0 })).toBeNull()
    expect(governor.enqueue({ scope: 'b', kind: 'network', priority: 'background', now: 0 })).not.toBeNull()
    expect(governor.enqueue({ scope: 'c', kind: 'storage', priority: 'background', now: 0 })).toBeNull()
  })

  it('promotes critical work before lower priorities', () => {
    const governor = new RuntimeConcurrencyGovernor({ criticalActiveReserve: 0 })
    governor.enqueue({ scope: 'background', kind: 'compute', priority: 'background', now: 0 })
    governor.enqueue({ scope: 'interactive', kind: 'render', priority: 'interactive', now: 1 })
    governor.enqueue({ scope: 'critical', kind: 'network', priority: 'critical', now: 2 })
    const lease = governor.promoteNext(3)!
    expect(lease.scope).toBe('critical')
    expect(lease.priority).toBe('critical')
  })

  it('uses queue time then scope as deterministic tie breakers', () => {
    const governor = new RuntimeConcurrencyGovernor({ criticalActiveReserve: 0 })
    governor.enqueue({ scope: 'z', kind: 'compute', priority: 'interactive', now: 0 })
    governor.enqueue({ scope: 'b', kind: 'compute', priority: 'interactive', now: 1 })
    governor.enqueue({ scope: 'a', kind: 'compute', priority: 'interactive', now: 1 })
    expect(governor.promoteNext(2)!.scope).toBe('z')
    expect(governor.promoteNext(2)!.scope).toBe('a')
  })

  it('does not promote work when active capacity is exhausted', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxActiveGlobal: 1, maxActivePerScope: 1, criticalActiveReserve: 0 })
    governor.acquire({ scope: 'active', kind: 'compute', priority: 'critical', now: 0 })
    governor.enqueue({ scope: 'queued', kind: 'render', priority: 'critical', now: 0 })
    expect(governor.promoteNext(1)).toBeNull()
    expect(governor.snapshot(1).queued).toBe(1)
  })

  it('expires active leases deterministically', () => {
    const governor = new RuntimeConcurrencyGovernor({ leaseTtlMs: 10 })
    governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: 0 })
    expect(governor.snapshot(9).active).toBe(1)
    expect(governor.snapshot(10).active).toBe(0)
  })

  it('expires queue tickets deterministically', () => {
    const governor = new RuntimeConcurrencyGovernor({ queueTtlMs: 10 })
    governor.enqueue({ scope: 'map', kind: 'network', priority: 'interactive', now: 0 })
    expect(governor.snapshot(9).queued).toBe(1)
    expect(governor.snapshot(10).queued).toBe(0)
  })

  it('renews a live lease', () => {
    const governor = new RuntimeConcurrencyGovernor({ leaseTtlMs: 10 })
    const lease = governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: 0 })!
    const renewed = governor.renew(lease, 5)!
    expect(renewed.expiresAt).toBe(15)
    expect(governor.snapshot(12).active).toBe(1)
  })

  it('rejects a stale pre-renewal lease', () => {
    const governor = new RuntimeConcurrencyGovernor({ leaseTtlMs: 10 })
    const lease = governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: 0 })!
    const renewed = governor.renew(lease, 5)!
    expect(governor.release(lease, 6)).toBe(false)
    expect(governor.release(renewed, 6)).toBe(true)
  })

  it('rejects forged lease metadata', () => {
    const governor = new RuntimeConcurrencyGovernor()
    const lease = governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: 0 })!
    expect(governor.release({ ...lease, scope: 'other' }, 1)).toBe(false)
    expect(governor.release({ ...lease, kind: 'compute' }, 1)).toBe(false)
    expect(governor.snapshot(1).active).toBe(1)
  })

  it('rejects duplicate lease release', () => {
    const governor = new RuntimeConcurrencyGovernor()
    const lease = governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: 0 })!
    expect(governor.release(lease, 1)).toBe(true)
    expect(governor.release(lease, 2)).toBe(false)
  })

  it('cancels queue tickets once', () => {
    const governor = new RuntimeConcurrencyGovernor()
    const ticket = governor.enqueue({ scope: 'map', kind: 'network', priority: 'interactive', now: 0 })!
    expect(governor.cancel(ticket, 1)).toBe(true)
    expect(governor.cancel(ticket, 2)).toBe(false)
  })

  it('rejects forged queue ticket metadata', () => {
    const governor = new RuntimeConcurrencyGovernor()
    const ticket = governor.enqueue({ scope: 'map', kind: 'network', priority: 'interactive', now: 0 })!
    expect(governor.cancel({ ...ticket, priority: 'critical' }, 1)).toBe(false)
    expect(governor.snapshot(1).queued).toBe(1)
  })

  it('reset invalidates active and queued handles', () => {
    const governor = new RuntimeConcurrencyGovernor()
    const lease = governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: 0 })!
    const ticket = governor.enqueue({ scope: 'map', kind: 'network', priority: 'interactive', now: 0 })!
    expect(governor.resetScope('map', 1)).toBe(true)
    expect(governor.release(lease, 2)).toBe(false)
    expect(governor.cancel(ticket, 2)).toBe(false)
    expect(governor.snapshot(2)).toMatchObject({ active: 0, queued: 0 })
  })

  it('does not remove scopes with active work', () => {
    const governor = new RuntimeConcurrencyGovernor()
    governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: 0 })
    expect(governor.removeScope('map')).toBe(false)
  })

  it('does not remove scopes with queued work', () => {
    const governor = new RuntimeConcurrencyGovernor()
    governor.enqueue({ scope: 'map', kind: 'network', priority: 'interactive', now: 0 })
    expect(governor.removeScope('map')).toBe(false)
  })

  it('removes inactive scopes explicitly', () => {
    const governor = new RuntimeConcurrencyGovernor()
    const lease = governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: 0 })!
    governor.release(lease, 1)
    expect(governor.removeScope('map')).toBe(true)
  })

  it('evicts the oldest inactive scope at scope capacity', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxScopes: 2 })
    const a = governor.acquire({ scope: 'a', kind: 'compute', priority: 'critical', now: 0 })!
    governor.release(a, 0)
    const b = governor.acquire({ scope: 'b', kind: 'compute', priority: 'critical', now: 1 })!
    governor.release(b, 1)
    expect(governor.acquire({ scope: 'c', kind: 'compute', priority: 'critical', now: 2 })).not.toBeNull()
    expect(governor.removeScope('a')).toBe(false)
    expect(governor.removeScope('b')).toBe(true)
  })

  it('uses lexical tie breaking for inactive scope eviction', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxScopes: 2 })
    const b = governor.acquire({ scope: 'b', kind: 'compute', priority: 'critical', now: 0 })!
    governor.release(b, 0)
    const a = governor.acquire({ scope: 'a', kind: 'compute', priority: 'critical', now: 0 })!
    governor.release(a, 0)
    governor.acquire({ scope: 'c', kind: 'compute', priority: 'critical', now: 1 })
    expect(governor.removeScope('a')).toBe(false)
    expect(governor.removeScope('b')).toBe(true)
  })

  it('never evicts active scopes to admit a new scope', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxScopes: 1 })
    governor.acquire({ scope: 'active', kind: 'compute', priority: 'critical', now: 0 })
    expect(() => governor.enqueue({ scope: 'other', kind: 'network', priority: 'critical', now: 1 })).toThrow('scope capacity exhausted')
  })

  it('never evicts queued scopes to admit a new scope', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxScopes: 1 })
    governor.enqueue({ scope: 'queued', kind: 'network', priority: 'interactive', now: 0 })
    expect(() => governor.acquire({ scope: 'other', kind: 'compute', priority: 'critical', now: 1 })).toThrow('scope capacity exhausted')
  })

  it('removes inactive scopes after idle retention', () => {
    const governor = new RuntimeConcurrencyGovernor({ idleScopeTtlMs: 10 })
    const lease = governor.acquire({ scope: 'idle', kind: 'compute', priority: 'critical', now: 0 })!
    governor.release(lease, 0)
    expect(governor.snapshot(9).scopes).toBe(1)
    expect(governor.snapshot(10).scopes).toBe(0)
  })

  it('normalizes scope whitespace', () => {
    const governor = new RuntimeConcurrencyGovernor()
    const lease = governor.acquire({ scope: ' map ', kind: 'render', priority: 'critical', now: 0 })!
    expect(lease.scope).toBe('map')
  })

  it('rejects invalid scopes', () => {
    const governor = new RuntimeConcurrencyGovernor()
    expect(() => governor.acquire({ scope: ' ', kind: 'render', priority: 'critical', now: 0 })).toThrow()
    expect(() => governor.enqueue({ scope: 'x'.repeat(129), kind: 'network', priority: 'interactive', now: 0 })).toThrow()
  })

  it('rejects invalid timestamps', () => {
    const governor = new RuntimeConcurrencyGovernor()
    expect(() => governor.snapshot(-1)).toThrow()
    expect(() => governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: Number.NaN })).toThrow()
  })

  it('clamps per-scope active capacity to global capacity', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxActiveGlobal: 2, maxActivePerScope: 99 })
    expect(governor.policy.maxActivePerScope).toBe(2)
  })

  it('clamps per-scope queue capacity to global queue capacity', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxQueuedGlobal: 3, maxQueuedPerScope: 99 })
    expect(governor.policy.maxQueuedPerScope).toBe(3)
  })

  it('clamps critical reserve to global active capacity', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxActiveGlobal: 2, criticalActiveReserve: 99 })
    expect(governor.policy.criticalActiveReserve).toBe(2)
    expect(governor.canAcquire({ scope: 'map', kind: 'compute', priority: 'interactive', now: 0 })).toBe(false)
    expect(governor.canAcquire({ scope: 'map', kind: 'compute', priority: 'critical', now: 0 })).toBe(true)
  })

  it('falls back from invalid policy numbers', () => {
    const governor = new RuntimeConcurrencyGovernor({ maxScopes: 0, maxActiveGlobal: -1, criticalActiveReserve: -1 })
    expect(governor.policy.maxScopes).toBe(128)
    expect(governor.policy.maxActiveGlobal).toBe(24)
    expect(governor.policy.criticalActiveReserve).toBe(4)
  })

  it('reports aggregate kind and priority counts without scope identifiers', () => {
    const governor = new RuntimeConcurrencyGovernor({ criticalActiveReserve: 0 })
    governor.acquire({ scope: 'private-a', kind: 'compute', priority: 'critical', now: 0 })
    governor.acquire({ scope: 'private-b', kind: 'render', priority: 'critical', now: 0 })
    governor.acquire({ scope: 'private-c', kind: 'network', priority: 'critical', now: 0 })
    governor.acquire({ scope: 'private-d', kind: 'storage', priority: 'critical', now: 0 })
    governor.enqueue({ scope: 'private-e', kind: 'compute', priority: 'background', now: 0 })
    governor.enqueue({ scope: 'private-f', kind: 'compute', priority: 'interactive', now: 0 })
    governor.enqueue({ scope: 'private-g', kind: 'compute', priority: 'critical', now: 0 })
    const snapshot = governor.snapshot(0)
    expect(snapshot).toMatchObject({ activeCompute: 1, activeRender: 1, activeNetwork: 1, activeStorage: 1, queuedBackground: 1, queuedInteractive: 1, queuedCritical: 1 })
    expect(JSON.stringify(snapshot)).not.toContain('private')
  })

  it('returns frozen public handles and snapshots', () => {
    const governor = new RuntimeConcurrencyGovernor()
    const lease = governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: 0 })!
    const ticket = governor.enqueue({ scope: 'map', kind: 'network', priority: 'interactive', now: 0 })!
    expect(Object.isFrozen(lease)).toBe(true)
    expect(Object.isFrozen(ticket)).toBe(true)
    expect(Object.isFrozen(governor.snapshot(0))).toBe(true)
  })

  it('becomes terminal after disposal', () => {
    const governor = new RuntimeConcurrencyGovernor()
    governor.dispose()
    governor.dispose()
    expect(() => governor.snapshot(0)).toThrow('disposed')
    expect(() => governor.acquire({ scope: 'map', kind: 'render', priority: 'critical', now: 0 })).toThrow('disposed')
    expect(() => governor.enqueue({ scope: 'map', kind: 'network', priority: 'interactive', now: 0 })).toThrow('disposed')
  })
})
