import { describe, expect, it } from 'vitest'
import { ArcGisQueryCircuitBreaker } from './ArcGisQueryCircuitBreaker'

function admitted(breaker: ArcGisQueryCircuitBreaker, key = 'parcels') {
  const result = breaker.acquire(key)
  expect(result.kind).toBe('admitted')
  if (result.kind !== 'admitted') throw new Error('expected admitted circuit permit')
  return result.permit
}

describe('ArcGisQueryCircuitBreaker', () => {
  it('opens after the configured consecutive failure threshold', () => {
    let now = 100
    const breaker = new ArcGisQueryCircuitBreaker({ failureThreshold: 2 }, () => now)
    admitted(breaker).complete('failure')
    expect(breaker.snapshot('parcels')?.state).toBe('closed')
    now += 1
    admitted(breaker).complete('failure')
    expect(breaker.snapshot('parcels')?.state).toBe('open')
    expect(breaker.acquire('parcels')).toEqual({ kind: 'rejected', code: 'open' })
  })

  it('resets consecutive failures after a successful closed request', () => {
    const breaker = new ArcGisQueryCircuitBreaker({ failureThreshold: 2 })
    admitted(breaker).complete('failure')
    admitted(breaker).complete('success')
    admitted(breaker).complete('failure')
    expect(breaker.snapshot('parcels')).toMatchObject({ state: 'closed', consecutiveFailures: 1 })
  })

  it('moves to half-open after the cooldown and closes after probe successes', () => {
    let now = 1_000
    const breaker = new ArcGisQueryCircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      openDurationMs: 50,
      halfOpenMaxConcurrent: 2,
    }, () => now)
    admitted(breaker).complete('failure')
    now += 50
    const first = admitted(breaker)
    const second = admitted(breaker)
    expect(first.state).toBe('half-open')
    expect(second.state).toBe('half-open')
    first.complete('success')
    expect(breaker.snapshot('parcels')?.state).toBe('half-open')
    second.complete('success')
    expect(breaker.snapshot('parcels')).toMatchObject({ state: 'closed', consecutiveFailures: 0 })
  })

  it('bounds concurrent half-open probes', () => {
    let now = 0
    const breaker = new ArcGisQueryCircuitBreaker({ failureThreshold: 1, openDurationMs: 10 }, () => now)
    admitted(breaker).complete('failure')
    now = 10
    const probe = admitted(breaker)
    expect(breaker.acquire('parcels')).toEqual({ kind: 'rejected', code: 'half-open-capacity' })
    probe.complete('success')
  })

  it('reopens immediately when a half-open probe fails', () => {
    let now = 0
    const breaker = new ArcGisQueryCircuitBreaker({ failureThreshold: 1, openDurationMs: 10 }, () => now)
    admitted(breaker).complete('failure')
    now = 10
    admitted(breaker).complete('failure')
    expect(breaker.snapshot('parcels')?.state).toBe('open')
    expect(breaker.acquire('parcels')).toEqual({ kind: 'rejected', code: 'open' })
  })

  it('does not count caller cancellation as a service failure', () => {
    const breaker = new ArcGisQueryCircuitBreaker({ failureThreshold: 1 })
    admitted(breaker).complete('cancelled')
    expect(breaker.snapshot('parcels')).toMatchObject({ state: 'closed', consecutiveFailures: 0 })
  })

  it('makes permit completion idempotent', () => {
    const breaker = new ArcGisQueryCircuitBreaker({ failureThreshold: 2 })
    const permit = admitted(breaker)
    permit.complete('failure')
    permit.complete('failure')
    expect(breaker.snapshot('parcels')).toMatchObject({ state: 'closed', consecutiveFailures: 1 })
  })

  it('isolates circuit state by verified service identity', () => {
    const breaker = new ArcGisQueryCircuitBreaker({ failureThreshold: 1 })
    admitted(breaker, 'parcels').complete('failure')
    expect(breaker.acquire('parcels')).toEqual({ kind: 'rejected', code: 'open' })
    expect(admitted(breaker, 'roads').serviceKey).toBe('roads')
  })

  it('evicts idle closed records to keep the registry bounded', () => {
    let now = 0
    const breaker = new ArcGisQueryCircuitBreaker({ maxTrackedServices: 2, idleTtlMs: 10 }, () => now)
    admitted(breaker, 'a').complete('success')
    now = 1
    admitted(breaker, 'b').complete('success')
    now = 11
    admitted(breaker, 'c').complete('success')
    expect(breaker.size).toBe(1)
    expect(breaker.snapshot('a')).toBeUndefined()
    expect(breaker.snapshot('b')).toBeUndefined()
    expect(breaker.snapshot('c')).toBeDefined()
  })

  it('evicts the least recently touched closed circuit at capacity', () => {
    let now = 0
    const breaker = new ArcGisQueryCircuitBreaker({ maxTrackedServices: 2, idleTtlMs: 1_000 }, () => now)
    admitted(breaker, 'old').complete('success')
    now = 5
    admitted(breaker, 'new').complete('success')
    now = 6
    admitted(breaker, 'third').complete('success')
    expect(breaker.snapshot('old')).toBeUndefined()
    expect(breaker.snapshot('new')).toBeDefined()
    expect(breaker.snapshot('third')).toBeDefined()
  })

  it('does not evict protective open circuits when registry capacity is exhausted', () => {
    const breaker = new ArcGisQueryCircuitBreaker({ maxTrackedServices: 1, failureThreshold: 1 })
    admitted(breaker, 'protected').complete('failure')
    expect(() => breaker.acquire('other')).toThrow(/capacity exhausted/)
    expect(breaker.snapshot('protected')?.state).toBe('open')
  })

  it('ignores stale permit completions after a circuit generation changes', () => {
    let now = 0
    const breaker = new ArcGisQueryCircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 10,
      halfOpenMaxConcurrent: 2,
      successThreshold: 1,
    }, () => now)
    const stale = admitted(breaker)
    stale.complete('failure')
    now = 10
    const probe = admitted(breaker)
    probe.complete('success')
    stale.complete('failure')
    expect(breaker.snapshot('parcels')?.state).toBe('closed')
  })

  it('supports explicit reset and clear without retaining service state', () => {
    const breaker = new ArcGisQueryCircuitBreaker()
    admitted(breaker, 'a').complete('success')
    admitted(breaker, 'b').complete('success')
    expect(breaker.reset('a')).toBe(true)
    expect(breaker.reset('a')).toBe(false)
    breaker.clear()
    expect(breaker.size).toBe(0)
  })

  it('rejects acquisitions after disposal', () => {
    const breaker = new ArcGisQueryCircuitBreaker()
    admitted(breaker).complete('success')
    breaker.dispose()
    expect(breaker.size).toBe(0)
    expect(breaker.acquire('parcels')).toEqual({ kind: 'rejected', code: 'disposed' })
    breaker.dispose()
  })

  it('fails closed for malformed keys and invalid limits', () => {
    const breaker = new ArcGisQueryCircuitBreaker()
    expect(() => breaker.acquire('   ')).toThrow(/service key/)
    expect(() => breaker.acquire('x'.repeat(513))).toThrow(/service key/)
    expect(() => new ArcGisQueryCircuitBreaker({ failureThreshold: 0 })).toThrow(/failureThreshold/)
    expect(() => new ArcGisQueryCircuitBreaker({ openDurationMs: Number.NaN })).toThrow(/openDurationMs/)
  })
})
