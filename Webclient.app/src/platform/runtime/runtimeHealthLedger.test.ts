import { describe, expect, it } from 'vitest'
import { RuntimeHealthLedger } from './runtimeHealthLedger'

describe('RuntimeHealthLedger', () => {
  it('classifies a sufficiently sampled healthy scope', () => {
    const ledger = new RuntimeHealthLedger({ minimumSamples: 3 })
    ledger.record({ scope: 'search', kind: 'success', at: 1, latencyMs: 10 })
    ledger.record({ scope: 'search', kind: 'success', at: 2, latencyMs: 20 })
    ledger.record({ scope: 'search', kind: 'success', at: 3, latencyMs: 30 })
    expect(ledger.getScope('search')).toMatchObject({
      level: 'healthy', sampleCount: 3, successCount: 3, failureRatio: 0, averageLatencyMs: 20,
    })
  })

  it('classifies degraded and unhealthy failure ratios deterministically', () => {
    const degraded = new RuntimeHealthLedger({ minimumSamples: 4, degradedFailureRatio: 0.25, unhealthyFailureRatio: 0.75 })
    degraded.record({ scope: 'map', kind: 'success', at: 1 })
    degraded.record({ scope: 'map', kind: 'success', at: 2 })
    degraded.record({ scope: 'map', kind: 'success', at: 3 })
    degraded.record({ scope: 'map', kind: 'failure', at: 4 })
    expect(degraded.getScope('map')?.level).toBe('degraded')

    const unhealthy = new RuntimeHealthLedger({ minimumSamples: 4, degradedFailureRatio: 0.25, unhealthyFailureRatio: 0.5 })
    unhealthy.record({ scope: 'map', kind: 'success', at: 1 })
    unhealthy.record({ scope: 'map', kind: 'success', at: 2 })
    unhealthy.record({ scope: 'map', kind: 'failure', at: 3 })
    unhealthy.record({ scope: 'map', kind: 'timeout', at: 4 })
    expect(unhealthy.getScope('map')?.level).toBe('unhealthy')
  })

  it('does not count cancellation as a health failure', () => {
    const ledger = new RuntimeHealthLedger({ minimumSamples: 2 })
    ledger.record({ scope: 'query', kind: 'cancelled', at: 1 })
    ledger.record({ scope: 'query', kind: 'failure', at: 2 })
    const snapshot = ledger.getScope('query')
    expect(snapshot).toMatchObject({ cancelledCount: 1, failureCount: 1, failureRatio: 1 })
    expect(snapshot?.level).toBe('healthy')
  })

  it('bounds retained samples per scope', () => {
    const ledger = new RuntimeHealthLedger({ maxSignalsPerScope: 3 })
    for (let at = 1; at <= 5; at += 1) ledger.record({ scope: 'map', kind: 'success', at })
    expect(ledger.getScope('map')).toMatchObject({ sampleCount: 3, lastSignalAt: 5 })
  })

  it('expires retained samples by time window', () => {
    const ledger = new RuntimeHealthLedger({ retentionMs: 10 })
    ledger.record({ scope: 'map', kind: 'failure', at: 1 })
    ledger.record({ scope: 'map', kind: 'success', at: 8 })
    expect(ledger.sweep(12)).toBe(1)
    expect(ledger.getScope('map')).toMatchObject({ sampleCount: 1, successCount: 1 })
  })

  it('evicts least recently touched scope at capacity', () => {
    const ledger = new RuntimeHealthLedger({ maxScopes: 2, retentionMs: 1000 })
    ledger.record({ scope: 'a', kind: 'success', at: 1 })
    ledger.record({ scope: 'b', kind: 'success', at: 2 })
    ledger.record({ scope: 'c', kind: 'success', at: 3 })
    expect(ledger.getScope('a')).toBeNull()
    expect(ledger.snapshot().scopes.map((scope) => scope.scope)).toEqual(['b', 'c'])
  })

  it('uses lexical scope ordering to break equal-touch eviction ties', () => {
    const ledger = new RuntimeHealthLedger({ maxScopes: 2 })
    ledger.record({ scope: 'b', kind: 'success', at: 1 })
    ledger.record({ scope: 'a', kind: 'success', at: 1 })
    ledger.record({ scope: 'c', kind: 'success', at: 2 })
    expect(ledger.getScope('a')).toBeNull()
    expect(ledger.getScope('b')).not.toBeNull()
  })

  it('rejects malformed scopes, timestamps, and latencies', () => {
    const ledger = new RuntimeHealthLedger()
    expect(ledger.record({ scope: ' ', kind: 'success', at: 1 })).toBe(false)
    expect(ledger.record({ scope: 'x'.repeat(129), kind: 'success', at: 1 })).toBe(false)
    expect(ledger.record({ scope: 'x', kind: 'success', at: -1 })).toBe(false)
    expect(ledger.record({ scope: 'x', kind: 'success', at: Number.NaN })).toBe(false)
    expect(ledger.record({ scope: 'x', kind: 'success', at: 1, latencyMs: -1 })).toBe(false)
    expect(ledger.snapshot()).toMatchObject({ scopeCount: 0, signalCount: 0 })
  })

  it('normalizes surrounding scope whitespace', () => {
    const ledger = new RuntimeHealthLedger()
    expect(ledger.record({ scope: '  map  ', kind: 'success', at: 1 })).toBe(true)
    expect(ledger.getScope('map')?.scope).toBe('map')
  })

  it('sorts out-of-order signals before deriving last signal time', () => {
    const ledger = new RuntimeHealthLedger()
    ledger.record({ scope: 'map', kind: 'success', at: 10 })
    ledger.record({ scope: 'map', kind: 'failure', at: 5 })
    expect(ledger.getScope('map')?.lastSignalAt).toBe(10)
  })

  it('computes latency only from signals that provide latency', () => {
    const ledger = new RuntimeHealthLedger()
    ledger.record({ scope: 'map', kind: 'success', at: 1, latencyMs: 10 })
    ledger.record({ scope: 'map', kind: 'success', at: 2 })
    ledger.record({ scope: 'map', kind: 'failure', at: 3, latencyMs: 30 })
    expect(ledger.getScope('map')?.averageLatencyMs).toBe(20)
  })

  it('keeps snapshots detached and frozen', () => {
    const ledger = new RuntimeHealthLedger()
    ledger.record({ scope: 'map', kind: 'success', at: 1 })
    const snapshot = ledger.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.scopes)).toBe(true)
    expect(Object.isFrozen(snapshot.scopes[0])).toBe(true)
    ledger.record({ scope: 'map', kind: 'failure', at: 2 })
    expect(snapshot.signalCount).toBe(1)
  })

  it('removes a normalized scope explicitly', () => {
    const ledger = new RuntimeHealthLedger()
    ledger.record({ scope: 'map', kind: 'success', at: 1 })
    expect(ledger.removeScope(' map ')).toBe(true)
    expect(ledger.removeScope('map')).toBe(false)
    expect(ledger.snapshot().scopeCount).toBe(0)
  })

  it('disposes terminally and idempotently', () => {
    const ledger = new RuntimeHealthLedger()
    ledger.record({ scope: 'map', kind: 'success', at: 1 })
    ledger.dispose()
    ledger.dispose()
    expect(ledger.record({ scope: 'map', kind: 'success', at: 2 })).toBe(false)
    expect(ledger.getScope('map')).toBeNull()
    expect(ledger.removeScope('map')).toBe(false)
    expect(ledger.sweep(3)).toBe(0)
    expect(ledger.snapshot()).toEqual({ disposed: true, scopeCount: 0, signalCount: 0, scopes: [] })
  })

  it('keeps insufficient evidence healthy', () => {
    const ledger = new RuntimeHealthLedger({ minimumSamples: 5, degradedFailureRatio: 0, unhealthyFailureRatio: 0 })
    ledger.record({ scope: 'map', kind: 'failure', at: 1 })
    expect(ledger.getScope('map')?.level).toBe('healthy')
  })

  it('treats timeouts as adverse observations', () => {
    const ledger = new RuntimeHealthLedger({ minimumSamples: 2, degradedFailureRatio: 0.5, unhealthyFailureRatio: 1 })
    ledger.record({ scope: 'map', kind: 'success', at: 1 })
    ledger.record({ scope: 'map', kind: 'timeout', at: 2 })
    expect(ledger.getScope('map')).toMatchObject({ timeoutCount: 1, failureRatio: 0.5, level: 'degraded' })
  })

  it('orders snapshot scopes deterministically', () => {
    const ledger = new RuntimeHealthLedger()
    ledger.record({ scope: 'z', kind: 'success', at: 1 })
    ledger.record({ scope: 'a', kind: 'success', at: 1 })
    ledger.record({ scope: 'm', kind: 'success', at: 1 })
    expect(ledger.snapshot().scopes.map((scope) => scope.scope)).toEqual(['a', 'm', 'z'])
  })
})
