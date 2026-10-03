import { describe, expect, it } from 'vitest'
import { RuntimeCircuitBreaker } from './runtimeCircuitBreaker'

describe('RuntimeCircuitBreaker', () => {
  it('starts closed and admits ordinary work', () => {
    const breaker = new RuntimeCircuitBreaker()
    const permit = breaker.acquire('map', 'interactive', 0)
    expect(permit).not.toBeNull()
    expect(permit?.probe).toBe(false)
    expect(breaker.stateOf('map', 0)).toBe('closed')
  })

  it('opens after the bounded rolling failure threshold', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 3 })
    for (let now = 0; now < 3; now += 1) breaker.fail(breaker.acquire('map', 'interactive', now)!, now)
    expect(breaker.stateOf('map', 2)).toBe('open')
    expect(breaker.acquire('map', 'critical', 3)).toBeNull()
  })

  it('drops failures outside the rolling window', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 2, windowMs: 10 })
    breaker.fail(breaker.acquire('map', 'interactive', 0)!, 0)
    breaker.fail(breaker.acquire('map', 'interactive', 11)!, 11)
    expect(breaker.stateOf('map', 11)).toBe('closed')
    expect(breaker.snapshot(11).failures).toBe(1)
  })

  it('moves from open to half-open after cooldown', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, openMs: 10 })
    breaker.fail(breaker.acquire('map', 'interactive', 0)!, 0)
    expect(breaker.stateOf('map', 9)).toBe('open')
    expect(breaker.stateOf('map', 10)).toBe('half-open')
  })

  it('bounds concurrent half-open probes', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, openMs: 10, halfOpenMaxProbes: 1 })
    breaker.fail(breaker.acquire('map', 'interactive', 0)!, 0)
    const probe = breaker.acquire('map', 'critical', 10)
    expect(probe?.probe).toBe(true)
    expect(breaker.acquire('map', 'critical', 10)).toBeNull()
  })

  it('closes after enough successful probes', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, openMs: 10, successThreshold: 2, halfOpenMaxProbes: 1 })
    breaker.fail(breaker.acquire('map', 'interactive', 0)!, 0)
    const first = breaker.acquire('map', 'critical', 10)!
    expect(breaker.succeed(first, 10)).toBe(true)
    expect(breaker.stateOf('map', 10)).toBe('half-open')
    const second = breaker.acquire('map', 'critical', 11)!
    expect(breaker.succeed(second, 11)).toBe(true)
    expect(breaker.stateOf('map', 11)).toBe('closed')
  })

  it('reopens immediately when a probe fails', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, openMs: 10 })
    breaker.fail(breaker.acquire('map', 'interactive', 0)!, 0)
    const probe = breaker.acquire('map', 'critical', 10)!
    expect(breaker.fail(probe, 10)).toBe(true)
    expect(breaker.stateOf('map', 10)).toBe('open')
  })

  it('allows a cancelled probe slot to be reused', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, openMs: 10 })
    breaker.fail(breaker.acquire('map', 'interactive', 0)!, 0)
    const probe = breaker.acquire('map', 'critical', 10)!
    expect(breaker.cancel(probe, 10)).toBe(true)
    expect(breaker.acquire('map', 'critical', 10)).not.toBeNull()
  })

  it('rejects duplicate probe completion', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, openMs: 10 })
    breaker.fail(breaker.acquire('map', 'interactive', 0)!, 0)
    const probe = breaker.acquire('map', 'critical', 10)!
    expect(breaker.succeed(probe, 10)).toBe(true)
    expect(breaker.succeed(probe, 11)).toBe(false)
  })

  it('rejects forged probe identity', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, openMs: 10 })
    breaker.fail(breaker.acquire('map', 'interactive', 0)!, 0)
    const probe = breaker.acquire('map', 'critical', 10)!
    expect(breaker.succeed({ ...probe, priority: 'background' }, 10)).toBe(false)
    expect(breaker.snapshot(10).probes).toBe(1)
  })

  it('invalidates probes when a scope resets', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, openMs: 10 })
    breaker.fail(breaker.acquire('map', 'interactive', 0)!, 0)
    const probe = breaker.acquire('map', 'critical', 10)!
    expect(breaker.resetScope('map', 11)).toBe(true)
    expect(breaker.succeed(probe, 11)).toBe(false)
    expect(breaker.stateOf('map', 11)).toBe('closed')
  })

  it('reset clears accumulated failures', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 2 })
    breaker.fail(breaker.acquire('map', 'interactive', 0)!, 0)
    breaker.resetScope('map', 1)
    expect(breaker.snapshot(1).failures).toBe(0)
  })

  it('does not remove a scope with an active probe', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, openMs: 1 })
    breaker.fail(breaker.acquire('map', 'interactive', 0)!, 0)
    breaker.acquire('map', 'critical', 1)
    expect(breaker.removeScope('map')).toBe(false)
  })

  it('removes an inactive closed scope explicitly', () => {
    const breaker = new RuntimeCircuitBreaker()
    breaker.acquire('map', 'interactive', 0)
    expect(breaker.removeScope('map')).toBe(true)
    expect(breaker.stateOf('map', 0)).toBeNull()
  })

  it('evicts the oldest inactive scope at cardinality', () => {
    const breaker = new RuntimeCircuitBreaker({ maxScopes: 2 })
    breaker.acquire('old', 'interactive', 0)
    breaker.acquire('new', 'interactive', 1)
    expect(breaker.acquire('third', 'interactive', 2)).not.toBeNull()
    expect(breaker.stateOf('old', 2)).toBeNull()
    expect(breaker.stateOf('new', 2)).toBe('closed')
  })

  it('uses lexical tie breaking for inactive eviction', () => {
    const breaker = new RuntimeCircuitBreaker({ maxScopes: 2 })
    breaker.acquire('b', 'interactive', 0)
    breaker.acquire('a', 'interactive', 0)
    breaker.acquire('c', 'interactive', 1)
    expect(breaker.stateOf('a', 1)).toBeNull()
    expect(breaker.stateOf('b', 1)).toBe('closed')
  })

  it('never evicts an open circuit to make cardinality room', () => {
    const breaker = new RuntimeCircuitBreaker({ maxScopes: 1, failureThreshold: 1 })
    breaker.fail(breaker.acquire('open', 'interactive', 0)!, 0)
    expect(() => breaker.acquire('other', 'interactive', 1)).toThrow('scope capacity exhausted')
  })

  it('removes idle closed scopes after retention', () => {
    const breaker = new RuntimeCircuitBreaker({ idleScopeTtlMs: 10 })
    breaker.acquire('idle', 'interactive', 0)
    expect(breaker.snapshot(9).scopes).toBe(1)
    expect(breaker.snapshot(10).scopes).toBe(0)
  })

  it('keeps aggregate diagnostics free of scope identifiers', () => {
    const breaker = new RuntimeCircuitBreaker()
    breaker.acquire('private-map-id', 'interactive', 0)
    const snapshot = breaker.snapshot(0)
    expect(snapshot).toMatchObject({ scopes: 1, closed: 1, open: 0, halfOpen: 0 })
    expect(JSON.stringify(snapshot)).not.toContain('private-map-id')
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('freezes permits', () => {
    const breaker = new RuntimeCircuitBreaker()
    expect(Object.isFrozen(breaker.acquire('map', 'critical', 0))).toBe(true)
  })

  it('normalizes scope whitespace', () => {
    const breaker = new RuntimeCircuitBreaker()
    expect(breaker.acquire(' map ', 'critical', 0)?.scope).toBe('map')
  })

  it('rejects blank and oversized scopes', () => {
    const breaker = new RuntimeCircuitBreaker()
    expect(() => breaker.acquire(' ', 'critical', 0)).toThrow()
    expect(() => breaker.acquire('x'.repeat(129), 'critical', 0)).toThrow()
  })

  it('rejects invalid timestamps', () => {
    const breaker = new RuntimeCircuitBreaker()
    expect(() => breaker.acquire('map', 'critical', Number.NaN)).toThrow()
    expect(() => breaker.snapshot(-1)).toThrow()
  })

  it('falls back from invalid policy numbers', () => {
    const breaker = new RuntimeCircuitBreaker({ maxScopes: 0, failureThreshold: -1, openMs: 0 })
    expect(breaker.policy.maxScopes).toBe(128)
    expect(breaker.policy.failureThreshold).toBe(5)
    expect(breaker.policy.openMs).toBe(15_000)
  })

  it('tracks multiple independent scopes', () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1 })
    breaker.fail(breaker.acquire('a', 'interactive', 0)!, 0)
    expect(breaker.stateOf('a', 0)).toBe('open')
    expect(breaker.acquire('b', 'interactive', 0)).not.toBeNull()
    expect(breaker.stateOf('b', 0)).toBe('closed')
  })

  it('does not retain request payloads because acquisition accepts only scalars', () => {
    const breaker = new RuntimeCircuitBreaker()
    const permit = breaker.acquire('map', 'background', 0)!
    expect(Object.keys(permit).sort()).toEqual(['generation', 'id', 'issuedAt', 'priority', 'probe', 'scope'])
  })

  it('becomes terminal after disposal', () => {
    const breaker = new RuntimeCircuitBreaker()
    breaker.dispose()
    breaker.dispose()
    expect(() => breaker.snapshot(0)).toThrow('disposed')
    expect(() => breaker.acquire('map', 'critical', 0)).toThrow('disposed')
  })
})
