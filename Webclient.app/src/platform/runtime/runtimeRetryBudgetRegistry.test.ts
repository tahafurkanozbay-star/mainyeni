import { describe, expect, it } from 'vitest'
import { RuntimeRetryBudgetRegistry } from './runtimeRetryBudgetRegistry'

const policy = {
  maxScopes: 4,
  maxTokensPerScope: 6,
  initialTokens: 4,
  successRefill: 1,
  refillIntervalMs: 100,
  refillTokens: 1,
  failurePenalty: 1,
  timeoutPenalty: 2,
  maxConsecutiveFailures: 2,
  cooldownMs: 50,
  leaseMs: 20,
} as const

describe('RuntimeRetryBudgetRegistry', () => {
  it('spends bounded tokens when a retry lease is acquired', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    const lease = registry.acquire({ scope: 'search', priority: 'normal', now: 0, cost: 2 })
    expect(lease).toMatchObject({ scope: 'search', generation: 1, cost: 2, acquiredAt: 0, expiresAt: 20 })
    expect(registry.getScope('search')).toMatchObject({ tokens: 2, activeLeases: 1 })
  })

  it('rejects work that exceeds the available token budget', () => {
    const registry = new RuntimeRetryBudgetRegistry({ ...policy, initialTokens: 2 })
    expect(registry.acquire({ scope: 'map', priority: 'normal', now: 0, cost: 3 })).toBeNull()
    expect(registry.getScope('map')).toMatchObject({ tokens: 2, activeLeases: 0 })
  })

  it('rejects a single cost larger than the configured scope capacity', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    expect(registry.acquire({ scope: 'map', priority: 'normal', now: 0, cost: 7 })).toBeNull()
    expect(registry.snapshot().scopeCount).toBe(0)
  })

  it('returns cancellation cost without treating cancellation as failure', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    const lease = registry.acquire({ scope: 'query', priority: 'normal', now: 0, cost: 2 })!
    expect(registry.settle(lease, 'cancelled', 5)).toBe(true)
    expect(registry.getScope('query')).toMatchObject({ tokens: 4, activeLeases: 0, consecutiveFailures: 0 })
  })

  it('refills successful work but never exceeds max tokens', () => {
    const registry = new RuntimeRetryBudgetRegistry({ ...policy, initialTokens: 6 })
    const lease = registry.acquire({ scope: 'query', priority: 'normal', now: 0 })!
    expect(registry.settle(lease, 'success', 1)).toBe(true)
    expect(registry.getScope('query')?.tokens).toBe(6)
  })

  it('penalizes failures independently from acquisition cost', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    const lease = registry.acquire({ scope: 'map', priority: 'normal', now: 0 })!
    expect(registry.settle(lease, 'failure', 1)).toBe(true)
    expect(registry.getScope('map')).toMatchObject({ tokens: 2, consecutiveFailures: 1 })
  })

  it('applies a stronger timeout penalty', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    const lease = registry.acquire({ scope: 'map', priority: 'normal', now: 0 })!
    expect(registry.settle(lease, 'timeout', 1)).toBe(true)
    expect(registry.getScope('map')).toMatchObject({ tokens: 1, consecutiveFailures: 1 })
  })

  it('opens a cooldown after the configured consecutive failure threshold', () => {
    const registry = new RuntimeRetryBudgetRegistry({ ...policy, initialTokens: 6 })
    const first = registry.acquire({ scope: 'map', priority: 'normal', now: 0 })!
    registry.settle(first, 'failure', 1)
    const second = registry.acquire({ scope: 'map', priority: 'normal', now: 2 })!
    registry.settle(second, 'failure', 3)
    expect(registry.getScope('map')).toMatchObject({ consecutiveFailures: 2, cooldownUntil: 53 })
    expect(registry.acquire({ scope: 'map', priority: 'normal', now: 4 })).toBeNull()
  })

  it('allows critical recovery probes through cooldown when budget remains', () => {
    const registry = new RuntimeRetryBudgetRegistry({ ...policy, initialTokens: 6, failurePenalty: 0 })
    const first = registry.acquire({ scope: 'map', priority: 'normal', now: 0 })!
    registry.settle(first, 'failure', 1)
    const second = registry.acquire({ scope: 'map', priority: 'normal', now: 2 })!
    registry.settle(second, 'failure', 3)
    expect(registry.acquire({ scope: 'map', priority: 'background', now: 4 })).toBeNull()
    expect(registry.acquire({ scope: 'map', priority: 'critical', now: 4 })).not.toBeNull()
  })

  it('clears cooldown and failure streak after cooldown elapses', () => {
    const registry = new RuntimeRetryBudgetRegistry({ ...policy, initialTokens: 6, failurePenalty: 0 })
    const first = registry.acquire({ scope: 'map', priority: 'normal', now: 0 })!
    registry.settle(first, 'failure', 1)
    const second = registry.acquire({ scope: 'map', priority: 'normal', now: 2 })!
    registry.settle(second, 'failure', 3)
    registry.sweep(53)
    expect(registry.getScope('map')).toMatchObject({ cooldownUntil: null, consecutiveFailures: 0 })
  })

  it('refills tokens only at complete refill intervals', () => {
    const registry = new RuntimeRetryBudgetRegistry({ ...policy, initialTokens: 2 })
    const lease = registry.acquire({ scope: 'map', priority: 'normal', now: 0, cost: 2 })!
    registry.settle(lease, 'cancelled', 1)
    const spent = registry.acquire({ scope: 'map', priority: 'normal', now: 2, cost: 2 })!
    registry.settle(spent, 'failure', 3)
    expect(registry.getScope('map', 99)?.tokens).toBe(0)
    expect(registry.getScope('map', 100)?.tokens).toBe(1)
    expect(registry.getScope('map', 300)?.tokens).toBe(3)
  })

  it('expires abandoned leases and treats expiry as timeout pressure', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    registry.acquire({ scope: 'map', priority: 'normal', now: 0 })
    expect(registry.sweep(19)).toBe(0)
    expect(registry.sweep(20)).toBe(1)
    expect(registry.getScope('map')).toMatchObject({ activeLeases: 0, consecutiveFailures: 1, tokens: 1 })
  })

  it('does not expire a lease before its exact deadline', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    registry.acquire({ scope: 'map', priority: 'normal', now: 10 })
    expect(registry.sweep(29)).toBe(0)
    expect(registry.getScope('map')?.activeLeases).toBe(1)
  })

  it('rejects duplicate settlement', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    const lease = registry.acquire({ scope: 'map', priority: 'normal', now: 0 })!
    expect(registry.settle(lease, 'success', 1)).toBe(true)
    expect(registry.settle(lease, 'failure', 2)).toBe(false)
  })

  it('rejects settlement after lease expiry', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    const lease = registry.acquire({ scope: 'map', priority: 'normal', now: 0 })!
    registry.sweep(20)
    expect(registry.settle(lease, 'success', 21)).toBe(false)
  })

  it('invalidates stale leases across explicit scope reset', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    const stale = registry.acquire({ scope: 'map', priority: 'normal', now: 0 })!
    expect(registry.resetScope('map', 1)).toBe(true)
    expect(registry.getScope('map')).toMatchObject({ generation: 2, tokens: 4, activeLeases: 0 })
    expect(registry.settle(stale, 'success', 2)).toBe(false)
  })

  it('removes all active leases with explicit scope teardown', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    registry.acquire({ scope: 'map', priority: 'normal', now: 0 })
    registry.acquire({ scope: 'map', priority: 'normal', now: 1 })
    expect(registry.removeScope(' map ')).toBe(true)
    expect(registry.snapshot()).toMatchObject({ scopeCount: 0, activeLeaseCount: 0 })
  })

  it('normalizes surrounding scope whitespace', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    expect(registry.acquire({ scope: '  search  ', priority: 'normal', now: 0 })).not.toBeNull()
    expect(registry.getScope('search')?.scope).toBe('search')
  })

  it('rejects malformed scopes and timestamps without retaining state', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    expect(registry.acquire({ scope: ' ', priority: 'normal', now: 0 })).toBeNull()
    expect(registry.acquire({ scope: 'x'.repeat(129), priority: 'normal', now: 0 })).toBeNull()
    expect(registry.acquire({ scope: 'map', priority: 'normal', now: -1 })).toBeNull()
    expect(registry.acquire({ scope: 'map', priority: 'normal', now: Number.NaN })).toBeNull()
    expect(registry.snapshot()).toMatchObject({ scopeCount: 0, activeLeaseCount: 0 })
  })

  it('rejects invalid retry costs', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    expect(registry.acquire({ scope: 'map', priority: 'normal', now: 0, cost: 0 })).toBeNull()
    expect(registry.acquire({ scope: 'map', priority: 'normal', now: 0, cost: -1 })).toBeNull()
    expect(registry.acquire({ scope: 'map', priority: 'normal', now: 0, cost: 1.5 })).toBeNull()
  })

  it('evicts the least recently touched idle scope at capacity', () => {
    const registry = new RuntimeRetryBudgetRegistry({ ...policy, maxScopes: 2 })
    const a = registry.acquire({ scope: 'a', priority: 'normal', now: 0 })!
    registry.settle(a, 'success', 1)
    const b = registry.acquire({ scope: 'b', priority: 'normal', now: 2 })!
    registry.settle(b, 'success', 3)
    registry.acquire({ scope: 'c', priority: 'normal', now: 4 })
    expect(registry.getScope('a')).toBeNull()
    expect(registry.snapshot().scopes.map((scope) => scope.scope)).toEqual(['b', 'c'])
  })

  it('prefers evicting an idle scope over one with active normal work', () => {
    const registry = new RuntimeRetryBudgetRegistry({ ...policy, maxScopes: 2 })
    registry.acquire({ scope: 'protected', priority: 'normal', now: 0 })
    const idle = registry.acquire({ scope: 'idle', priority: 'normal', now: 1 })!
    registry.settle(idle, 'success', 2)
    registry.acquire({ scope: 'new', priority: 'normal', now: 3 })
    expect(registry.getScope('protected')).not.toBeNull()
    expect(registry.getScope('idle')).toBeNull()
  })

  it('protects critical active work over normal active work during eviction', () => {
    const registry = new RuntimeRetryBudgetRegistry({ ...policy, maxScopes: 2 })
    registry.acquire({ scope: 'normal', priority: 'normal', now: 0 })
    registry.acquire({ scope: 'critical', priority: 'critical', now: 0 })
    registry.acquire({ scope: 'new', priority: 'normal', now: 1 })
    expect(registry.getScope('normal')).toBeNull()
    expect(registry.getScope('critical')).not.toBeNull()
  })

  it('uses lexical ordering to break equal eviction ties', () => {
    const registry = new RuntimeRetryBudgetRegistry({ ...policy, maxScopes: 2 })
    const b = registry.acquire({ scope: 'b', priority: 'normal', now: 0 })!
    registry.settle(b, 'success', 1)
    const a = registry.acquire({ scope: 'a', priority: 'normal', now: 0 })!
    registry.settle(a, 'success', 1)
    registry.acquire({ scope: 'c', priority: 'normal', now: 2 })
    expect(registry.getScope('a')).toBeNull()
    expect(registry.getScope('b')).not.toBeNull()
  })

  it('orders snapshots lexically and freezes all public structures', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    registry.acquire({ scope: 'z', priority: 'normal', now: 0 })
    registry.acquire({ scope: 'a', priority: 'normal', now: 0 })
    const snapshot = registry.snapshot()
    expect(snapshot.scopes.map((scope) => scope.scope)).toEqual(['a', 'z'])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.scopes)).toBe(true)
    expect(snapshot.scopes.every(Object.isFrozen)).toBe(true)
  })

  it('keeps returned snapshots detached from later mutation', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    registry.acquire({ scope: 'map', priority: 'normal', now: 0 })
    const snapshot = registry.snapshot()
    registry.acquire({ scope: 'map', priority: 'normal', now: 1 })
    expect(snapshot.activeLeaseCount).toBe(1)
    expect(snapshot.scopes[0]?.activeLeases).toBe(1)
  })

  it('disposes terminally and idempotently', () => {
    const registry = new RuntimeRetryBudgetRegistry(policy)
    const lease = registry.acquire({ scope: 'map', priority: 'normal', now: 0 })!
    registry.dispose()
    registry.dispose()
    expect(registry.acquire({ scope: 'map', priority: 'normal', now: 1 })).toBeNull()
    expect(registry.settle(lease, 'success', 1)).toBe(false)
    expect(registry.resetScope('map', 1)).toBe(false)
    expect(registry.removeScope('map')).toBe(false)
    expect(registry.sweep(1)).toBe(0)
    expect(registry.snapshot()).toEqual({ disposed: true, scopeCount: 0, activeLeaseCount: 0, scopes: [] })
  })
})
