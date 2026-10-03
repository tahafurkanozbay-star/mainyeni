import { describe, expect, it } from 'vitest'
import { RuntimeRetryGovernor } from './runtimeRetryGovernor'

describe('RuntimeRetryGovernor', () => {
  it('issues a frozen delayed ticket', () => {
    const governor = new RuntimeRetryGovernor({ baseDelayMs: 100, jitterPermille: 0 })
    const ticket = governor.acquire('map', 'interactive', 0)!
    expect(ticket).toMatchObject({ scope: 'map', attempt: 1, notBefore: 100 })
    expect(Object.isFrozen(ticket)).toBe(true)
    expect(governor.canRun(ticket, 99)).toBe(false)
    expect(governor.canRun(ticket, 100)).toBe(true)
  })

  it('backs off exponentially after failures', () => {
    const governor = new RuntimeRetryGovernor({ baseDelayMs: 100, maxDelayMs: 10_000, jitterPermille: 0 })
    const first = governor.acquire('map', 'interactive', 0)!
    governor.complete(first, 'failure', 100)
    const second = governor.acquire('map', 'interactive', 100)!
    expect(second.attempt).toBe(2)
    expect(second.notBefore).toBe(300)
    governor.complete(second, 'failure', 300)
    const third = governor.acquire('map', 'interactive', 300)!
    expect(third.notBefore).toBe(700)
  })

  it('caps exponential delay', () => {
    const governor = new RuntimeRetryGovernor({ baseDelayMs: 100, maxDelayMs: 150, jitterPermille: 0 })
    const first = governor.acquire('map', 'critical', 0)!
    governor.complete(first, 'failure', 100)
    const second = governor.acquire('map', 'critical', 100)!
    expect(second.notBefore).toBe(250)
  })

  it('resets backoff after success', () => {
    const governor = new RuntimeRetryGovernor({ baseDelayMs: 100, jitterPermille: 0 })
    const first = governor.acquire('map', 'interactive', 0)!
    governor.complete(first, 'failure', 100)
    const second = governor.acquire('map', 'interactive', 100)!
    governor.complete(second, 'success', 300)
    const third = governor.acquire('map', 'interactive', 300)!
    expect(third.attempt).toBe(1)
    expect(third.notBefore).toBe(400)
  })

  it('does not reset failure streak on cancellation', () => {
    const governor = new RuntimeRetryGovernor({ baseDelayMs: 10, jitterPermille: 0 })
    const first = governor.acquire('map', 'interactive', 0)!
    governor.complete(first, 'failure', 10)
    const second = governor.acquire('map', 'interactive', 10)!
    governor.complete(second, 'cancelled', 30)
    expect(governor.acquire('map', 'interactive', 30)?.attempt).toBe(2)
  })

  it('bounds attempts per scope', () => {
    const governor = new RuntimeRetryGovernor({ maxAttemptsPerScope: 2, criticalReserveAttempts: 0 })
    expect(governor.acquire('map', 'interactive', 0)).not.toBeNull()
    expect(governor.acquire('map', 'interactive', 1)).not.toBeNull()
    expect(governor.acquire('map', 'interactive', 2)).toBeNull()
  })

  it('releases rolling attempt budget after the window', () => {
    const governor = new RuntimeRetryGovernor({ maxAttemptsPerScope: 1, windowMs: 10, criticalReserveAttempts: 0 })
    const ticket = governor.acquire('map', 'interactive', 0)!
    governor.complete(ticket, 'cancelled', 0)
    expect(governor.acquire('map', 'interactive', 9)).toBeNull()
    expect(governor.acquire('map', 'interactive', 10)).not.toBeNull()
  })

  it('reserves global attempts for critical recovery', () => {
    const governor = new RuntimeRetryGovernor({ maxAttemptsPerWindow: 3, criticalReserveAttempts: 1, maxAttemptsPerScope: 3 })
    expect(governor.acquire('a', 'interactive', 0)).not.toBeNull()
    expect(governor.acquire('b', 'interactive', 0)).not.toBeNull()
    expect(governor.acquire('c', 'interactive', 0)).toBeNull()
    expect(governor.acquire('c', 'critical', 0)).not.toBeNull()
  })

  it('bounds global attempts across scopes', () => {
    const governor = new RuntimeRetryGovernor({ maxAttemptsPerWindow: 2, criticalReserveAttempts: 0 })
    expect(governor.acquire('a', 'critical', 0)).not.toBeNull()
    expect(governor.acquire('b', 'critical', 0)).not.toBeNull()
    expect(governor.acquire('c', 'critical', 0)).toBeNull()
  })

  it('rejects duplicate completion', () => {
    const governor = new RuntimeRetryGovernor()
    const ticket = governor.acquire('map', 'critical', 0)!
    expect(governor.complete(ticket, 'success', ticket.notBefore)).toBe(true)
    expect(governor.complete(ticket, 'success', ticket.notBefore)).toBe(false)
  })

  it('rejects forged ticket fields', () => {
    const governor = new RuntimeRetryGovernor()
    const ticket = governor.acquire('map', 'critical', 0)!
    expect(governor.complete({ ...ticket, attempt: 99 }, 'failure', 1)).toBe(false)
    expect(governor.snapshot(1).activeTickets).toBe(1)
  })

  it('invalidates tickets on scope reset', () => {
    const governor = new RuntimeRetryGovernor()
    const ticket = governor.acquire('map', 'critical', 0)!
    expect(governor.resetScope('map', 1)).toBe(true)
    expect(governor.complete(ticket, 'success', 1)).toBe(false)
    expect(governor.snapshot(1).activeTickets).toBe(0)
  })

  it('reset restores scope attempt budget', () => {
    const governor = new RuntimeRetryGovernor({ maxAttemptsPerScope: 1, criticalReserveAttempts: 0 })
    governor.acquire('map', 'interactive', 0)
    expect(governor.acquire('map', 'interactive', 1)).toBeNull()
    governor.resetScope('map', 1)
    expect(governor.acquire('map', 'interactive', 1)).not.toBeNull()
  })

  it('does not remove a scope with active tickets', () => {
    const governor = new RuntimeRetryGovernor()
    governor.acquire('map', 'critical', 0)
    expect(governor.removeScope('map')).toBe(false)
  })

  it('removes an inactive scope explicitly', () => {
    const governor = new RuntimeRetryGovernor()
    const ticket = governor.acquire('map', 'critical', 0)!
    governor.complete(ticket, 'cancelled', 1)
    expect(governor.removeScope('map')).toBe(true)
  })

  it('evicts oldest inactive scope at cardinality', () => {
    const governor = new RuntimeRetryGovernor({ maxScopes: 2 })
    const old = governor.acquire('old', 'critical', 0)!
    governor.complete(old, 'cancelled', 0)
    const newer = governor.acquire('new', 'critical', 1)!
    governor.complete(newer, 'cancelled', 1)
    expect(governor.acquire('third', 'critical', 2)).not.toBeNull()
    expect(governor.removeScope('old')).toBe(false)
    expect(governor.removeScope('new')).toBe(true)
  })

  it('uses lexical tie breaking for inactive eviction', () => {
    const governor = new RuntimeRetryGovernor({ maxScopes: 2 })
    const b = governor.acquire('b', 'critical', 0)!
    governor.complete(b, 'cancelled', 0)
    const a = governor.acquire('a', 'critical', 0)!
    governor.complete(a, 'cancelled', 0)
    governor.acquire('c', 'critical', 1)
    expect(governor.removeScope('a')).toBe(false)
    expect(governor.removeScope('b')).toBe(true)
  })

  it('does not evict scopes with active tickets', () => {
    const governor = new RuntimeRetryGovernor({ maxScopes: 1 })
    governor.acquire('active', 'critical', 0)
    expect(() => governor.acquire('other', 'critical', 1)).toThrow('scope capacity exhausted')
  })

  it('removes idle inactive scopes after retention', () => {
    const governor = new RuntimeRetryGovernor({ idleScopeTtlMs: 10 })
    const ticket = governor.acquire('idle', 'critical', 0)!
    governor.complete(ticket, 'cancelled', 0)
    expect(governor.snapshot(9).scopes).toBe(1)
    expect(governor.snapshot(10).scopes).toBe(0)
  })

  it('produces deterministic bounded jitter', () => {
    const a = new RuntimeRetryGovernor({ baseDelayMs: 1000, jitterPermille: 100 })
    const b = new RuntimeRetryGovernor({ baseDelayMs: 1000, jitterPermille: 100 })
    const first = a.acquire('map', 'critical', 0)!
    const second = b.acquire('map', 'critical', 0)!
    expect(first.notBefore).toBe(second.notBefore)
    expect(first.notBefore).toBeGreaterThanOrEqual(900)
    expect(first.notBefore).toBeLessThanOrEqual(1100)
  })

  it('clamps jitter policy to one thousand permille', () => {
    const governor = new RuntimeRetryGovernor({ jitterPermille: 5000 })
    expect(governor.policy.jitterPermille).toBe(1000)
  })

  it('clamps critical reserve to global capacity', () => {
    const governor = new RuntimeRetryGovernor({ maxAttemptsPerWindow: 2, criticalReserveAttempts: 99 })
    expect(governor.policy.criticalReserveAttempts).toBe(2)
    expect(governor.acquire('map', 'interactive', 0)).toBeNull()
    expect(governor.acquire('map', 'critical', 0)).not.toBeNull()
  })

  it('normalizes scope whitespace', () => {
    const governor = new RuntimeRetryGovernor()
    expect(governor.acquire(' map ', 'critical', 0)?.scope).toBe('map')
  })

  it('rejects invalid scope identifiers', () => {
    const governor = new RuntimeRetryGovernor()
    expect(() => governor.acquire(' ', 'critical', 0)).toThrow()
    expect(() => governor.acquire('x'.repeat(129), 'critical', 0)).toThrow()
  })

  it('rejects invalid timestamps and outcomes', () => {
    const governor = new RuntimeRetryGovernor()
    expect(() => governor.acquire('map', 'critical', Number.NaN)).toThrow()
    const ticket = governor.acquire('map', 'critical', 0)!
    expect(() => governor.complete(ticket, 'invalid' as never, 1)).toThrow()
  })

  it('falls back from invalid policy numbers', () => {
    const governor = new RuntimeRetryGovernor({ maxScopes: 0, windowMs: -1, baseDelayMs: 0 })
    expect(governor.policy.maxScopes).toBe(128)
    expect(governor.policy.windowMs).toBe(30_000)
    expect(governor.policy.baseDelayMs).toBe(250)
  })

  it('reports aggregate diagnostics without scope identifiers', () => {
    const governor = new RuntimeRetryGovernor({ jitterPermille: 0 })
    const failed = governor.acquire('private-a', 'critical', 0)!
    governor.complete(failed, 'failure', failed.notBefore)
    const succeeded = governor.acquire('private-b', 'critical', 0)!
    governor.complete(succeeded, 'success', succeeded.notBefore)
    const snapshot = governor.snapshot(succeeded.notBefore)
    expect(snapshot.failuresInWindow).toBe(1)
    expect(snapshot.successesInWindow).toBe(1)
    expect(JSON.stringify(snapshot)).not.toContain('private')
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('stores only scalar retry metadata in public tickets', () => {
    const governor = new RuntimeRetryGovernor()
    const ticket = governor.acquire('map', 'critical', 0)!
    expect(Object.keys(ticket).sort()).toEqual(['attempt', 'generation', 'id', 'issuedAt', 'notBefore', 'priority', 'scope'])
  })

  it('becomes terminal after disposal', () => {
    const governor = new RuntimeRetryGovernor()
    governor.dispose()
    governor.dispose()
    expect(() => governor.snapshot(0)).toThrow('disposed')
    expect(() => governor.acquire('map', 'critical', 0)).toThrow('disposed')
  })
})
