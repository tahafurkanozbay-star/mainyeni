import { describe, expect, it } from 'vitest'
import { RuntimeRecoveryCoordinator } from './runtimeRecoveryCoordinator'

describe('RuntimeRecoveryCoordinator', () => {
  const policy = { retry: { baseDelayMs: 1, jitterPermille: 0 }, circuit: { failureThreshold: 2, openMs: 5 }, health: { minimumSamples: 2, unhealthyPermille: 500 } } as const

  it('coordinates retry delay and successful completion', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const attempt = recovery.acquire('map', 'interactive', 0)!
    expect(recovery.canRun(attempt, 0)).toBe(false)
    expect(recovery.canRun(attempt, 1)).toBe(true)
    expect(recovery.succeed(attempt, 1)).toBe(true)
    expect(recovery.snapshot(1).activeRetries).toBe(0)
  })

  it('opens the circuit after coordinated failures', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const first = recovery.acquire('map', 'interactive', 0)!; recovery.fail(first, first.retry.notBefore)
    const second = recovery.acquire('map', 'interactive', 2)!; recovery.fail(second, second.retry.notBefore)
    expect(recovery.snapshot(second.retry.notBefore).openCircuits).toBe(1)
    expect(recovery.acquire('map', 'critical', second.retry.notBefore)).toBeNull()
  })

  it('records timeout health without retaining payloads', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const first = recovery.acquire('map', 'critical', 0)!; recovery.fail(first, 1, 'timeout')
    const second = recovery.acquire('map', 'critical', 2)!; recovery.fail(second, 4, 'timeout')
    expect(recovery.snapshot(4).unhealthyScopes).toBe(1)
  })

  it('cancels both circuit and retry reservations', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const attempt = recovery.acquire('map', 'critical', 0)!
    expect(recovery.cancel(attempt, 0)).toBe(true)
    expect(recovery.cancel(attempt, 0)).toBe(false)
    expect(recovery.snapshot(0).activeRetries).toBe(0)
  })

  it('rejects forged aggregate attempts', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const attempt = recovery.acquire('map', 'critical', 0)!
    expect(recovery.succeed({ ...attempt, circuitId: 'forged' }, 1)).toBe(false)
    expect(recovery.snapshot(1).activeRetries).toBe(1)
  })

  it('invalidates outstanding attempts on scope reset', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const attempt = recovery.acquire('map', 'critical', 0)!
    expect(recovery.resetScope('map', 1)).toBe(true)
    expect(recovery.succeed(attempt, 1)).toBe(false)
  })

  it('prevents removal while coordinated work is active', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const attempt = recovery.acquire('map', 'critical', 0)!
    expect(recovery.removeScope('map')).toBe(false)
    recovery.cancel(attempt, 1)
    expect(recovery.removeScope('map')).toBe(true)
  })

  it('normalizes scopes consistently across authorities', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const attempt = recovery.acquire(' map ', 'critical', 0)!
    expect(attempt.scope).toBe('map')
    recovery.succeed(attempt, 1)
    expect(recovery.snapshot(1)).toMatchObject({ circuitScopes: 1, retryScopes: 1, healthScopes: 1 })
  })

  it('returns frozen aggregate snapshots', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    recovery.acquire('map', 'critical', 0)
    expect(Object.isFrozen(recovery.snapshot(0))).toBe(true)
  })

  it('does not expose payload-bearing fields', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    const attempt = recovery.acquire('private-map', 'critical', 0)!
    expect(Object.keys(attempt).sort()).toEqual(['circuitId', 'generation', 'issuedAt', 'retry', 'scope'])
    expect(JSON.stringify(recovery.snapshot(0))).not.toContain('private-map')
  })

  it('becomes terminal after disposal', () => {
    const recovery = new RuntimeRecoveryCoordinator(policy)
    recovery.dispose(); recovery.dispose()
    expect(() => recovery.snapshot(0)).toThrow('disposed')
    expect(() => recovery.acquire('map', 'critical', 0)).toThrow('disposed')
  })
})
