import { describe, expect, it } from 'vitest'
import { ArcGisQueryHealthRegistry } from './ArcGisQueryHealthRegistry'

describe('ArcGisQueryHealthRegistry', () => {
  it('starts unknown services healthy without retaining state', () => {
    const registry = new ArcGisQueryHealthRegistry()
    expect(registry.state('parcels')).toBe('healthy')
    expect(registry.canIssueRequest('parcels')).toBe(true)
    expect(registry.size).toBe(0)
  })

  it('degrades after the configured rolling failure ratio', () => {
    const registry = new ArcGisQueryHealthRegistry({ minimumSamples: 4, degradedFailureRatio: 0.25, unavailableFailureRatio: 0.75 })
    registry.observe({ serviceKey: 'parcels', outcome: 'success', latencyMs: 10 })
    registry.observe({ serviceKey: 'parcels', outcome: 'success', latencyMs: 10 })
    registry.observe({ serviceKey: 'parcels', outcome: 'success', latencyMs: 10 })
    const snapshot = registry.observe({ serviceKey: 'parcels', outcome: 'failure', latencyMs: 10 })
    expect(snapshot.state).toBe('degraded')
    expect(snapshot.failureRatio).toBe(0.25)
  })

  it('marks a service unavailable under sustained failure pressure', () => {
    const registry = new ArcGisQueryHealthRegistry({ minimumSamples: 4, degradedFailureRatio: 0.25, unavailableFailureRatio: 0.5 })
    registry.observe({ serviceKey: 'roads', outcome: 'success', latencyMs: 10 })
    registry.observe({ serviceKey: 'roads', outcome: 'failure', latencyMs: 10 })
    registry.observe({ serviceKey: 'roads', outcome: 'timeout', latencyMs: 1000 })
    const snapshot = registry.observe({ serviceKey: 'roads', outcome: 'failure', latencyMs: 10 })
    expect(snapshot.state).toBe('unavailable')
    expect(registry.canIssueRequest('roads')).toBe(false)
    expect(snapshot.timeouts).toBe(1)
  })

  it('requires consecutive successes before recovering unavailable state', () => {
    const registry = new ArcGisQueryHealthRegistry({ sampleWindow: 4, minimumSamples: 2, degradedFailureRatio: 0.25, unavailableFailureRatio: 0.5, recoverySuccesses: 2 })
    registry.observe({ serviceKey: 'buildings', outcome: 'failure', latencyMs: 10 })
    registry.observe({ serviceKey: 'buildings', outcome: 'failure', latencyMs: 10 })
    expect(registry.state('buildings')).toBe('unavailable')
    registry.observe({ serviceKey: 'buildings', outcome: 'success', latencyMs: 10 })
    expect(registry.state('buildings')).toBe('unavailable')
    registry.observe({ serviceKey: 'buildings', outcome: 'success', latencyMs: 10 })
    expect(registry.state('buildings')).toBe('unavailable')
    registry.observe({ serviceKey: 'buildings', outcome: 'success', latencyMs: 10 })
    expect(registry.state('buildings')).toBe('degraded')
    registry.observe({ serviceKey: 'buildings', outcome: 'success', latencyMs: 10 })
    expect(registry.state('buildings')).toBe('healthy')
  })

  it('does not count caller cancellation as service failure', () => {
    const registry = new ArcGisQueryHealthRegistry({ minimumSamples: 2 })
    registry.observe({ serviceKey: 'poi', outcome: 'cancelled', latencyMs: 0 })
    const snapshot = registry.observe({ serviceKey: 'poi', outcome: 'success', latencyMs: 20 })
    expect(snapshot.cancellations).toBe(1)
    expect(snapshot.failures).toBe(0)
    expect(snapshot.samples).toBe(1)
    expect(snapshot.state).toBe('healthy')
  })

  it('degrades a consistently slow service without inventing a failure', () => {
    const registry = new ArcGisQueryHealthRegistry({ minimumSamples: 2, slowLatencyMs: 100 })
    registry.observe({ serviceKey: 'imagery', outcome: 'success', latencyMs: 200 })
    const snapshot = registry.observe({ serviceKey: 'imagery', outcome: 'success', latencyMs: 200 })
    expect(snapshot.state).toBe('degraded')
    expect(snapshot.failureRatio).toBe(0)
    expect(snapshot.smoothedLatencyMs).toBe(200)
  })

  it('uses EWMA latency and does not overreact to one fast sample', () => {
    const registry = new ArcGisQueryHealthRegistry({ minimumSamples: 2, slowLatencyMs: 500, latencyAlpha: 0.25 })
    registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1000 })
    const snapshot = registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 100 })
    expect(snapshot.smoothedLatencyMs).toBe(775)
    expect(snapshot.state).toBe('degraded')
  })

  it('uses a bounded rolling window for failure ratio', () => {
    const registry = new ArcGisQueryHealthRegistry({ sampleWindow: 4, minimumSamples: 2, degradedFailureRatio: 0.25, unavailableFailureRatio: 0.75, recoverySuccesses: 1 })
    registry.observe({ serviceKey: 'a', outcome: 'failure', latencyMs: 1 })
    registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1 })
    registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1 })
    registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1 })
    expect(registry.snapshot('a')?.failureRatio).toBe(0.25)
    registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1 })
    expect(registry.snapshot('a')?.failureRatio).toBe(0)
    expect(registry.snapshot('a')?.samples).toBe(4)
  })

  it('prunes idle service state deterministically', () => {
    let now = 0
    const registry = new ArcGisQueryHealthRegistry({ idleTtlMs: 10 }, () => now)
    registry.observe({ serviceKey: 'old', outcome: 'success', latencyMs: 1 })
    now = 9
    expect(registry.snapshot('old')).toBeDefined()
    now = 10
    expect(registry.snapshot('old')).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it('evicts the least recently observed service at hard capacity', () => {
    let now = 0
    const registry = new ArcGisQueryHealthRegistry({ maxServices: 2, idleTtlMs: 1000 }, () => now)
    registry.observe({ serviceKey: 'old', outcome: 'success', latencyMs: 1 })
    now = 1
    registry.observe({ serviceKey: 'new', outcome: 'success', latencyMs: 1 })
    now = 2
    registry.observe({ serviceKey: 'third', outcome: 'success', latencyMs: 1 })
    expect(registry.snapshot('old')).toBeUndefined()
    expect(registry.snapshot('new')).toBeDefined()
    expect(registry.snapshot('third')).toBeDefined()
  })

  it('sorts snapshots by stable service identity', () => {
    const registry = new ArcGisQueryHealthRegistry()
    registry.observe({ serviceKey: 'z', outcome: 'success', latencyMs: 1 })
    registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1 })
    expect(registry.snapshots().map(item => item.serviceKey)).toEqual(['a', 'z'])
  })

  it('rejects out-of-order observations for one service', () => {
    const registry = new ArcGisQueryHealthRegistry()
    registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1, at: 10 })
    expect(() => registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1, at: 9 })).toThrow(/monotonic/)
  })

  it('supports explicit reset and clear', () => {
    const registry = new ArcGisQueryHealthRegistry()
    registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1 })
    expect(registry.reset('a')).toBe(true)
    expect(registry.reset('a')).toBe(false)
    registry.observe({ serviceKey: 'b', outcome: 'success', latencyMs: 1 })
    registry.clear()
    expect(registry.size).toBe(0)
  })

  it('disposes idempotently and fails closed afterwards', () => {
    const registry = new ArcGisQueryHealthRegistry()
    registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1 })
    registry.dispose()
    registry.dispose()
    expect(() => registry.snapshot('a')).toThrow(/disposed/)
    expect(() => registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1 })).toThrow(/disposed/)
  })

  it('validates configuration fail closed', () => {
    expect(() => new ArcGisQueryHealthRegistry({ maxServices: 0 })).toThrow(/maxServices/)
    expect(() => new ArcGisQueryHealthRegistry({ sampleWindow: 2, minimumSamples: 3 })).toThrow(/minimumSamples/)
    expect(() => new ArcGisQueryHealthRegistry({ degradedFailureRatio: 0.8, unavailableFailureRatio: 0.5 })).toThrow(/degradedFailureRatio/)
    expect(() => new ArcGisQueryHealthRegistry({ latencyAlpha: 1 })).toThrow(/latencyAlpha/)
  })

  it('validates observations fail closed', () => {
    const registry = new ArcGisQueryHealthRegistry()
    expect(() => registry.observe({ serviceKey: ' ', outcome: 'success', latencyMs: 1 })).toThrow(/service key/)
    expect(() => registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: Number.NaN })).toThrow(/latency/)
    expect(() => registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: -1 })).toThrow(/latency/)
    expect(() => registry.observe({ serviceKey: 'a', outcome: 'success', latencyMs: 1, at: -1 })).toThrow(/observation time/)
  })
})
