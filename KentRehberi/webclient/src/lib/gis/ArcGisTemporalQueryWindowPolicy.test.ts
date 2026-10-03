import { describe, expect, it } from 'vitest'
import { ArcGisTemporalQueryWindowPolicy, type ArcGisTemporalWindowBudget, type ArcGisTemporalWindowRequest } from './ArcGisTemporalQueryWindowPolicy'

const budget: ArcGisTemporalWindowBudget = {
  maxLayers: 3, maxWindows: 6, maxWindowsPerLayer: 4, maxRunning: 2, maxRunningPerLayer: 1,
  maxReady: 3, maxReadyPerLayer: 2, maxFeaturesPerWindow: 100, maxBytesPerWindow: 2_000,
  maxAggregateReadyFeatures: 250, maxAggregateReadyBytes: 4_000, maxWindowSpanMs: 86_400_000,
  queueTtlMs: 100, runLeaseMs: 200, readyTtlMs: 300,
}
const request = (o: Partial<ArcGisTemporalWindowRequest> = {}): ArcGisTemporalWindowRequest => ({
  layerId: 'traffic', windowId: 'w-1', revision: 1, intent: 'visible', startTime: 1_000, endTime: 2_000,
  requestedAt: 10, estimatedFeatures: 20, estimatedBytes: 500, ...o,
})
const ready = (p: ArcGisTemporalQueryWindowPolicy, windowId = 'w-1', features = 20, bytes = 500, now = 30) => {
  p.takeNext(20); return p.complete('traffic', windowId, 1, features, bytes, now)
}

describe('ArcGisTemporalQueryWindowPolicy', () => {
  it('rejects invalid budget relationships', () => {
    expect(() => new ArcGisTemporalQueryWindowPolicy({ ...budget, maxWindows: 0 })).toThrow(/maxWindows/)
    expect(() => new ArcGisTemporalQueryWindowPolicy({ ...budget, maxWindowsPerLayer: 7 })).toThrow(/maxWindowsPerLayer/)
    expect(() => new ArcGisTemporalQueryWindowPolicy({ ...budget, maxRunningPerLayer: 3 })).toThrow(/per-layer/)
    expect(() => new ArcGisTemporalQueryWindowPolicy({ ...budget, maxFeaturesPerWindow: 251 })).toThrow(/feature budget/)
    expect(() => new ArcGisTemporalQueryWindowPolicy({ ...budget, maxBytesPerWindow: 4001 })).toThrow(/byte budget/)
  })

  it('validates identifiers and scalar metadata', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget)
    expect(() => p.enqueue(request({ layerId: 'bad id' }))).toThrow(/layerId/)
    expect(() => p.enqueue(request({ windowId: '' }))).toThrow(/windowId/)
    expect(() => p.enqueue(request({ revision: -1 }))).toThrow(/revision/)
    expect(() => p.enqueue(request({ requestedAt: Number.NaN }))).toThrow(/requestedAt/)
    expect(() => p.enqueue(request({ estimatedFeatures: 1.5 }))).toThrow(/estimatedFeatures/)
  })

  it('requires positive bounded temporal spans', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget)
    expect(() => p.enqueue(request({ startTime: 2_000, endTime: 2_000 }))).toThrow(/positive span/)
    expect(() => p.enqueue(request({ startTime: 0, endTime: 86_400_001 }))).toThrow(/span exceeds/)
  })

  it('rejects per-window feature and byte overflow without retention', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget)
    expect(p.enqueue(request({ estimatedFeatures: 101 }))).toBe(false)
    expect(p.enqueue(request({ estimatedBytes: 2_001 }))).toBe(false)
    expect(p.snapshot()).toHaveLength(0)
  })

  it('bounds global window cardinality', () => {
    const p = new ArcGisTemporalQueryWindowPolicy({ ...budget, maxWindows: 2, maxWindowsPerLayer: 2 })
    expect(p.enqueue(request({ windowId: 'a' }))).toBe(true)
    expect(p.enqueue(request({ windowId: 'b' }))).toBe(true)
    expect(p.enqueue(request({ layerId: 'roads', windowId: 'c' }))).toBe(false)
  })

  it('bounds per-layer cardinality', () => {
    const p = new ArcGisTemporalQueryWindowPolicy({ ...budget, maxWindowsPerLayer: 1 })
    expect(p.enqueue(request({ windowId: 'a' }))).toBe(true)
    expect(p.enqueue(request({ windowId: 'b' }))).toBe(false)
    expect(p.enqueue(request({ layerId: 'roads', windowId: 'c' }))).toBe(true)
  })

  it('bounds layer cardinality', () => {
    const p = new ArcGisTemporalQueryWindowPolicy({ ...budget, maxLayers: 1 })
    expect(p.enqueue(request())).toBe(true)
    expect(p.enqueue(request({ layerId: 'roads', windowId: 'w-2' }))).toBe(false)
  })

  it('prioritizes interactive then visible then background', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget)
    p.enqueue(request({ layerId: 'a', windowId: 'bg', intent: 'background' }))
    p.enqueue(request({ layerId: 'b', windowId: 'v', intent: 'visible' }))
    p.enqueue(request({ layerId: 'c', windowId: 'i', intent: 'interactive' }))
    expect(p.takeNext(20)?.windowId).toBe('i')
    expect(p.takeNext(20)?.windowId).toBe('v')
  })

  it('preserves FIFO order inside equal intent', () => {
    const p = new ArcGisTemporalQueryWindowPolicy({ ...budget, maxRunningPerLayer: 2 })
    p.enqueue(request({ windowId: 'first', requestedAt: 1 }))
    p.enqueue(request({ windowId: 'second', requestedAt: 2 }))
    expect(p.takeNext(20)?.windowId).toBe('first')
    expect(p.takeNext(21)?.windowId).toBe('second')
  })

  it('bounds global running concurrency', () => {
    const p = new ArcGisTemporalQueryWindowPolicy({ ...budget, maxRunning: 1, maxRunningPerLayer: 1 })
    p.enqueue(request({ layerId: 'a', windowId: 'a' })); p.enqueue(request({ layerId: 'b', windowId: 'b' }))
    expect(p.takeNext(20)?.windowId).toBe('a'); expect(p.takeNext(21)).toBeUndefined()
  })

  it('bounds per-layer running concurrency without starving another layer', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget)
    p.enqueue(request({ windowId: 'a' })); p.enqueue(request({ windowId: 'b' })); p.enqueue(request({ layerId: 'roads', windowId: 'c' }))
    expect(p.takeNext(20)?.windowId).toBe('a'); expect(p.takeNext(21)?.windowId).toBe('c')
  })

  it('expires queued work before dispatch', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget); p.enqueue(request())
    expect(p.takeNext(110)).toBeUndefined(); expect(p.snapshot()).toHaveLength(0)
  })

  it('rejects late completion and releases ownership', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget); p.enqueue(request()); p.takeNext(20)
    expect(p.complete('traffic', 'w-1', 1, 1, 100, 220)).toBe(false); expect(p.snapshot()).toHaveLength(0)
  })

  it('reconciles actual feature and byte residency', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget); p.enqueue(request()); expect(ready(p, 'w-1', 42, 900)).toBe(true)
    expect(p.snapshot()[0]).toMatchObject({ phase: 'ready', actualFeatures: 42, actualBytes: 900, expiresAt: 330 })
  })

  it('rejects impossible actual result budgets', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget); p.enqueue(request()); p.takeNext(20)
    expect(p.complete('traffic', 'w-1', 1, 101, 100, 30)).toBe(false)
  })

  it('evicts background ready work before visible and interactive work', () => {
    const p = new ArcGisTemporalQueryWindowPolicy({ ...budget, maxReady: 2, maxReadyPerLayer: 2 })
    p.enqueue(request({ windowId: 'bg', intent: 'background' })); p.takeNext(20); p.complete('traffic', 'bg', 1, 10, 100, 30)
    p.enqueue(request({ windowId: 'v', intent: 'visible', requestedAt: 40 })); p.takeNext(41); p.complete('traffic', 'v', 1, 10, 100, 50)
    p.enqueue(request({ windowId: 'i', intent: 'interactive', requestedAt: 60 })); p.takeNext(61); expect(p.complete('traffic', 'i', 1, 10, 100, 70)).toBe(true)
    expect(p.snapshot().map(x => x.windowId)).toEqual(['v', 'i'])
  })

  it('evicts least-recently-accessed peer within equal intent', () => {
    const p = new ArcGisTemporalQueryWindowPolicy({ ...budget, maxReady: 2, maxReadyPerLayer: 2 })
    p.enqueue(request({ windowId: 'a' })); p.takeNext(20); p.complete('traffic', 'a', 1, 10, 100, 30)
    p.enqueue(request({ windowId: 'b', requestedAt: 31 })); p.takeNext(32); p.complete('traffic', 'b', 1, 10, 100, 40); p.touch('traffic', 'a', 1, 50)
    p.enqueue(request({ windowId: 'c', requestedAt: 60 })); p.takeNext(61); p.complete('traffic', 'c', 1, 10, 100, 70)
    expect(p.snapshot().map(x => x.windowId)).toEqual(['a', 'c'])
  })

  it('evicts for aggregate feature pressure', () => {
    const p = new ArcGisTemporalQueryWindowPolicy({ ...budget, maxAggregateReadyFeatures: 100 })
    p.enqueue(request({ windowId: 'a' })); p.takeNext(20); p.complete('traffic', 'a', 1, 70, 100, 30)
    p.enqueue(request({ windowId: 'b', requestedAt: 40 })); p.takeNext(41); expect(p.complete('traffic', 'b', 1, 70, 100, 50)).toBe(true)
    expect(p.snapshot().map(x => x.windowId)).toEqual(['b'])
  })

  it('evicts for aggregate byte pressure', () => {
    const p = new ArcGisTemporalQueryWindowPolicy({ ...budget, maxAggregateReadyBytes: 2_000 })
    p.enqueue(request({ windowId: 'a' })); p.takeNext(20); p.complete('traffic', 'a', 1, 10, 1_500, 30)
    p.enqueue(request({ windowId: 'b', requestedAt: 40 })); p.takeNext(41); expect(p.complete('traffic', 'b', 1, 10, 1_500, 50)).toBe(true)
    expect(p.snapshot().map(x => x.windowId)).toEqual(['b'])
  })

  it('purges expired ready residency before completion admission', () => {
    const p = new ArcGisTemporalQueryWindowPolicy({ ...budget, maxReady: 1, maxReadyPerLayer: 1, readyTtlMs: 50 })
    p.enqueue(request({ windowId: 'old' })); p.takeNext(20); p.complete('traffic', 'old', 1, 10, 100, 30)
    p.enqueue(request({ windowId: 'fresh', requestedAt: 40 })); p.takeNext(70); expect(p.complete('traffic', 'fresh', 1, 10, 100, 80)).toBe(true)
    expect(p.snapshot().map(x => x.windowId)).toEqual(['fresh'])
  })

  it('supports deterministic priority promotion without duplicate residency', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget)
    expect(p.enqueue(request({ intent: 'background' }))).toBe(true)
    expect(p.enqueue(request({ intent: 'interactive', requestedAt: 11 }))).toBe(true)
    expect(p.snapshot()).toHaveLength(1); expect(p.snapshot()[0]?.intent).toBe('interactive')
  })

  it('rejects priority downgrade for duplicate revision', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget)
    p.enqueue(request({ intent: 'interactive' })); expect(p.enqueue(request({ intent: 'background' }))).toBe(false)
  })

  it('advancing layer revision invalidates stale temporal windows', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget)
    p.enqueue(request({ windowId: 'a' })); p.enqueue(request({ windowId: 'b' })); expect(p.invalidateLayer('traffic', 2)).toBe(2)
    expect(p.enqueue(request({ windowId: 'old', revision: 1 }))).toBe(false); expect(p.enqueue(request({ windowId: 'new', revision: 2 }))).toBe(true)
  })

  it('newer admission atomically advances revision and clears siblings', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget)
    p.enqueue(request({ windowId: 'a' })); p.enqueue(request({ windowId: 'b' })); expect(p.enqueue(request({ windowId: 'new', revision: 2 }))).toBe(true)
    expect(p.snapshot().map(x => x.windowId)).toEqual(['new'])
  })

  it('consumes only exact ready revisions', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget); p.enqueue(request()); ready(p)
    expect(p.consume('traffic', 'w-1', 2)).toBe(false); expect(p.consume('traffic', 'w-1', 1)).toBe(true); expect(p.snapshot()).toHaveLength(0)
  })

  it('cancels only exact revision ownership', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget); p.enqueue(request())
    expect(p.cancel('traffic', 'w-1', 2)).toBe(false); expect(p.cancel('traffic', 'w-1', 1)).toBe(true)
  })

  it('releases one layer and resets its watermark', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget); p.enqueue(request({ revision: 3 })); expect(p.releaseLayer('traffic')).toBe(1)
    expect(p.enqueue(request({ revision: 1 }))).toBe(true)
  })

  it('returns detached frozen snapshots', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget); p.enqueue(request()); const first = p.snapshot(); expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first[0])).toBe(true)
    expect(JSON.stringify(first)).not.toMatch(/geometry|attributes|credential|abort/i)
  })

  it('produces deterministic payload-free fingerprints', () => {
    const a = new ArcGisTemporalQueryWindowPolicy(budget), b = new ArcGisTemporalQueryWindowPolicy(budget)
    a.enqueue(request({ windowId: 'a' })); a.enqueue(request({ windowId: 'b' })); b.enqueue(request({ windowId: 'a' })); b.enqueue(request({ windowId: 'b' }))
    expect(a.fingerprint()).toBe(b.fingerprint()); expect(a.fingerprint()).not.toMatch(/geometry|token|credential/i)
  })

  it('fails closed after idempotent disposal', () => {
    const p = new ArcGisTemporalQueryWindowPolicy(budget); p.enqueue(request()); p.dispose(); p.dispose()
    expect(() => p.snapshot()).toThrow(/disposed/); expect(() => p.enqueue(request())).toThrow(/disposed/)
  })
})
