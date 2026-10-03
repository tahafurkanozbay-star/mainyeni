import { describe, expect, it } from 'vitest'
import { RuntimePolicyCoordinator } from './runtimePolicyCoordinator'

describe('RuntimePolicyCoordinator', () => {
  it('reserves global capacity for critical work', () => {
    const coordinator = new RuntimePolicyCoordinator({ maxActiveGlobal: 3, criticalReserve: 1 })
    expect(coordinator.acquire({ scope: 'a', lane: 'interactive', now: 0 })).not.toBeNull()
    expect(coordinator.acquire({ scope: 'b', lane: 'interactive', now: 0 })).not.toBeNull()
    expect(coordinator.decide({ scope: 'c', lane: 'interactive', now: 0 })).toBe('defer')
    expect(coordinator.acquire({ scope: 'c', lane: 'critical', now: 0 })).not.toBeNull()
    expect(coordinator.snapshot(0).active).toBe(3)
  })

  it('bounds active work per scope', () => {
    const coordinator = new RuntimePolicyCoordinator({ maxActivePerScope: 1, maxQueuedPerScope: 0 })
    const lease = coordinator.acquire({ scope: 'map', lane: 'interactive', now: 0 })
    expect(lease).not.toBeNull()
    expect(coordinator.decide({ scope: 'map', lane: 'interactive', now: 1 })).toBe('reject')
  })

  it('bounds explicit queue accounting', () => {
    const coordinator = new RuntimePolicyCoordinator({ maxQueuedPerScope: 2 })
    expect(coordinator.enqueue('map', 0)).toBe(true)
    expect(coordinator.enqueue('map', 1)).toBe(true)
    expect(coordinator.enqueue('map', 2)).toBe(false)
    expect(coordinator.dequeue('map', 3)).toBe(true)
    expect(coordinator.snapshot(3).queued).toBe(1)
  })

  it('expires leases and releases capacity deterministically', () => {
    const coordinator = new RuntimePolicyCoordinator({ maxActiveGlobal: 1, criticalReserve: 0, leaseTtlMs: 10 })
    expect(coordinator.acquire({ scope: 'a', lane: 'interactive', now: 0 })).not.toBeNull()
    expect(coordinator.acquire({ scope: 'b', lane: 'interactive', now: 5 })).toBeNull()
    coordinator.sweep(10)
    expect(coordinator.acquire({ scope: 'b', lane: 'interactive', now: 10 })).not.toBeNull()
  })

  it('renews a live lease without retaining caller payloads', () => {
    const coordinator = new RuntimePolicyCoordinator({ leaseTtlMs: 10 })
    const lease = coordinator.acquire({ scope: 'search', lane: 'interactive', units: 2, now: 0 })!
    const renewed = coordinator.renew(lease, 5)
    expect(renewed?.expiresAt).toBe(15)
    expect(renewed?.units).toBe(2)
  })

  it('rejects forged lease settlement', () => {
    const coordinator = new RuntimePolicyCoordinator()
    const lease = coordinator.acquire({ scope: 'search', lane: 'interactive', now: 0 })!
    expect(coordinator.succeed({ ...lease, units: 9 }, 1)).toBe(false)
    expect(coordinator.snapshot(1).active).toBe(1)
    expect(coordinator.succeed(lease, 2)).toBe(true)
  })

  it('rejects duplicate settlement', () => {
    const coordinator = new RuntimePolicyCoordinator()
    const lease = coordinator.acquire({ scope: 'search', lane: 'interactive', now: 0 })!
    expect(coordinator.succeed(lease, 1)).toBe(true)
    expect(coordinator.succeed(lease, 2)).toBe(false)
  })

  it('opens cooldown after bounded rolling failures', () => {
    const coordinator = new RuntimePolicyCoordinator({ maxFailuresBeforeCooldown: 2, cooldownMs: 20, failureWindowMs: 100 })
    const first = coordinator.acquire({ scope: 'search', lane: 'interactive', now: 0 })!
    expect(coordinator.fail(first, 1)).toBe(true)
    const second = coordinator.acquire({ scope: 'search', lane: 'interactive', now: 2 })!
    expect(coordinator.fail(second, 3)).toBe(true)
    expect(coordinator.decide({ scope: 'search', lane: 'interactive', now: 4 })).toBe('reject')
    expect(coordinator.decide({ scope: 'search', lane: 'critical', now: 4 })).toBe('allow')
  })

  it('recovers automatically after cooldown', () => {
    const coordinator = new RuntimePolicyCoordinator({ maxFailuresBeforeCooldown: 1, cooldownMs: 10 })
    const lease = coordinator.acquire({ scope: 'search', lane: 'interactive', now: 0 })!
    coordinator.fail(lease, 1)
    expect(coordinator.decide({ scope: 'search', lane: 'interactive', now: 10 })).toBe('reject')
    expect(coordinator.decide({ scope: 'search', lane: 'interactive', now: 11 })).toBe('allow')
  })

  it('ages failures out of the rolling window', () => {
    const coordinator = new RuntimePolicyCoordinator({ maxFailuresBeforeCooldown: 3, failureWindowMs: 10 })
    const lease = coordinator.acquire({ scope: 'search', lane: 'interactive', now: 0 })!
    coordinator.fail(lease, 1)
    expect(coordinator.snapshot(12).failures).toBe(0)
  })

  it('invalidates old leases on scope reset', () => {
    const coordinator = new RuntimePolicyCoordinator()
    const lease = coordinator.acquire({ scope: 'map', lane: 'interactive', now: 0 })!
    expect(coordinator.resetScope('map', 1)).toBe(true)
    expect(coordinator.succeed(lease, 2)).toBe(false)
    expect(coordinator.snapshot(2).active).toBe(0)
  })

  it('removes scope and its leases', () => {
    const coordinator = new RuntimePolicyCoordinator()
    const lease = coordinator.acquire({ scope: 'map', lane: 'interactive', now: 0 })!
    expect(coordinator.removeScope('map')).toBe(true)
    expect(coordinator.succeed(lease, 1)).toBe(false)
    expect(coordinator.snapshot(1).scopes).toBe(0)
  })

  it('evicts the oldest inactive scope at cardinality', () => {
    const coordinator = new RuntimePolicyCoordinator({ maxScopes: 2 })
    expect(coordinator.decide({ scope: 'z', lane: 'interactive', now: 0 })).toBe('allow')
    expect(coordinator.decide({ scope: 'b', lane: 'interactive', now: 1 })).toBe('allow')
    expect(coordinator.decide({ scope: 'a', lane: 'interactive', now: 2 })).toBe('allow')
    expect(coordinator.snapshot(2).scopes).toBe(2)
  })

  it('uses lexical tie breaking for inactive scope eviction', () => {
    const coordinator = new RuntimePolicyCoordinator({ maxScopes: 2 })
    coordinator.decide({ scope: 'b', lane: 'interactive', now: 0 })
    coordinator.decide({ scope: 'a', lane: 'interactive', now: 0 })
    coordinator.decide({ scope: 'c', lane: 'interactive', now: 1 })
    expect(coordinator.removeScope('a')).toBe(false)
    expect(coordinator.removeScope('b')).toBe(true)
  })

  it('does not evict active scopes', () => {
    const coordinator = new RuntimePolicyCoordinator({ maxScopes: 1 })
    expect(coordinator.acquire({ scope: 'active', lane: 'interactive', now: 0 })).not.toBeNull()
    expect(() => coordinator.decide({ scope: 'other', lane: 'interactive', now: 1 })).toThrow('scope capacity exhausted')
  })

  it('removes idle scopes only after retention expires', () => {
    const coordinator = new RuntimePolicyCoordinator({ idleScopeTtlMs: 10 })
    coordinator.decide({ scope: 'idle', lane: 'interactive', now: 0 })
    expect(coordinator.snapshot(9).scopes).toBe(1)
    expect(coordinator.snapshot(10).scopes).toBe(0)
  })

  it('normalizes surrounding whitespace in scope identifiers', () => {
    const coordinator = new RuntimePolicyCoordinator()
    coordinator.decide({ scope: ' map ', lane: 'interactive', now: 0 })
    expect(coordinator.removeScope('map')).toBe(true)
  })

  it('rejects empty and oversized scope identifiers', () => {
    const coordinator = new RuntimePolicyCoordinator()
    expect(() => coordinator.decide({ scope: '   ', lane: 'interactive', now: 0 })).toThrow()
    expect(() => coordinator.decide({ scope: 'x'.repeat(129), lane: 'interactive', now: 0 })).toThrow()
  })

  it('rejects invalid timestamps and units', () => {
    const coordinator = new RuntimePolicyCoordinator()
    expect(() => coordinator.decide({ scope: 'map', lane: 'interactive', now: Number.NaN })).toThrow()
    expect(() => coordinator.acquire({ scope: 'map', lane: 'interactive', units: 0, now: 0 })).toThrow()
  })

  it('returns frozen aggregate-only snapshots', () => {
    const coordinator = new RuntimePolicyCoordinator()
    coordinator.decide({ scope: 'secret-free', lane: 'interactive', now: 0 })
    const snapshot = coordinator.snapshot(0)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.keys(snapshot).sort()).toEqual(['active', 'coolingScopes', 'disposed', 'failures', 'generation', 'queued', 'scopes'].sort())
  })

  it('becomes terminal after disposal', () => {
    const coordinator = new RuntimePolicyCoordinator()
    coordinator.dispose()
    coordinator.dispose()
    expect(() => coordinator.snapshot(0)).toThrow('disposed')
    expect(() => coordinator.acquire({ scope: 'map', lane: 'critical', now: 0 })).toThrow('disposed')
  })
})
