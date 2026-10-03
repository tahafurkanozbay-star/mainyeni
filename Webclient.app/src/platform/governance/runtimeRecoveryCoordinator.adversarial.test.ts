import { describe, expect, it } from 'vitest'
import { RuntimeRecoveryCoordinator } from './runtimeRecoveryCoordinator'

const policy = {
  retry: { baseDelayMs: 1, jitterPermille: 0, maxAttemptsPerWindow: 8, maxAttemptsPerScope: 4 },
  circuit: { failureThreshold: 2, openMs: 5, successThreshold: 1 },
  health: { minimumSamples: 2, degradedPermille: 250, unhealthyPermille: 500 },
} as const

describe('RuntimeRecoveryCoordinator adversarial contracts', () => {
  it('fails closed for blank scope identifiers', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    expect(() => recovery.acquire(' ', 'critical', 0)).toThrow()
  })

  it('fails closed for oversized scope identifiers', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    expect(() => recovery.acquire('x'.repeat(129), 'critical', 0)).toThrow()
  })

  it('fails closed for non-finite clocks', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    expect(() => recovery.acquire('map', 'critical', Number.NaN)).toThrow()
    expect(() => recovery.snapshot(Number.POSITIVE_INFINITY)).toThrow()
  })

  it('does not admit work while a circuit is open', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const a = recovery.acquire('map', 'critical', 0)!; recovery.fail(a, 1)
    const b = recovery.acquire('map', 'critical', 2)!; recovery.fail(b, 4)
    expect(recovery.acquire('map', 'critical', 4)).toBeNull()
    expect(recovery.snapshot(4).openCircuits).toBe(1)
  })

  it('admits a bounded half-open recovery probe after cooldown', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const a = recovery.acquire('map', 'critical', 0)!; recovery.fail(a, 1)
    const b = recovery.acquire('map', 'critical', 2)!; recovery.fail(b, 4)
    const probe = recovery.acquire('map', 'critical', 9)
    expect(probe).not.toBeNull()
    expect(recovery.acquire('map', 'critical', 9)).toBeNull()
  })

  it('closes a half-open circuit after successful recovery', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const a = recovery.acquire('map', 'critical', 0)!; recovery.fail(a, 1)
    const b = recovery.acquire('map', 'critical', 2)!; recovery.fail(b, 4)
    const probe = recovery.acquire('map', 'critical', 9)!
    recovery.succeed(probe, probe.retry.notBefore)
    expect(recovery.snapshot(probe.retry.notBefore).openCircuits).toBe(0)
    expect(recovery.snapshot(probe.retry.notBefore).halfOpenCircuits).toBe(0)
  })

  it('reopens a half-open circuit after failed recovery', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const a = recovery.acquire('map', 'critical', 0)!; recovery.fail(a, 1)
    const b = recovery.acquire('map', 'critical', 2)!; recovery.fail(b, 4)
    const probe = recovery.acquire('map', 'critical', 9)!
    recovery.fail(probe, probe.retry.notBefore)
    expect(recovery.snapshot(probe.retry.notBefore).openCircuits).toBe(1)
  })

  it('rejects stale completion after reset and reacquisition', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const stale = recovery.acquire('map', 'critical', 0)!
    recovery.resetScope('map', 1)
    const current = recovery.acquire('map', 'critical', 1)!
    expect(recovery.succeed(stale, 2)).toBe(false)
    expect(recovery.succeed(current, current.retry.notBefore)).toBe(true)
  })

  it('rejects forged nested retry identity', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const attempt = recovery.acquire('map', 'critical', 0)!
    const forged = { ...attempt, retry: { ...attempt.retry, id: 'forged' } }
    expect(recovery.succeed(forged, 1)).toBe(false)
    expect(recovery.snapshot(1).activeRetries).toBe(1)
  })

  it('keeps health classification scoped', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const a1 = recovery.acquire('a', 'critical', 0)!; recovery.fail(a1, 1, 'timeout')
    const a2 = recovery.acquire('a', 'critical', 2)!; recovery.fail(a2, 4, 'timeout')
    const b1 = recovery.acquire('b', 'critical', 0)!; recovery.succeed(b1, 1)
    const b2 = recovery.acquire('b', 'critical', 2)!; recovery.succeed(b2, 3)
    expect(recovery.snapshot(4)).toMatchObject({ healthScopes: 2, unhealthyScopes: 1 })
  })

  it('does not count cancellation as health failure', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const attempt = recovery.acquire('map', 'critical', 0)!
    recovery.cancel(attempt, 1)
    expect(recovery.snapshot(1).healthScopes).toBe(0)
  })

  it('keeps diagnostics aggregate-only across private scope names', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    recovery.acquire('tenant-secret-scope', 'critical', 0)
    expect(JSON.stringify(recovery.snapshot(0))).not.toContain('tenant-secret-scope')
  })

  it('does not expose callbacks, promises, controllers or payloads in attempts', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const attempt = recovery.acquire('map', 'critical', 0)!
    const serialized = JSON.stringify(attempt)
    expect(serialized).not.toContain('callback')
    expect(serialized).not.toContain('controller')
    expect(serialized).not.toContain('payload')
    expect(serialized).not.toContain('url')
  })

  it('makes reset idempotently false for unknown scopes', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    expect(recovery.resetScope('missing', 0)).toBe(false)
  })

  it('makes removal idempotently false for unknown scopes', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    expect(recovery.removeScope('missing')).toBe(false)
  })

  it('rejects operations after terminal disposal', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    recovery.dispose()
    expect(() => recovery.resetScope('map', 0)).toThrow('disposed')
    expect(() => recovery.removeScope('map')).toThrow('disposed')
    expect(() => recovery.snapshot(0)).toThrow('disposed')
  })
})
