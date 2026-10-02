import { describe, expect, it } from 'vitest'
import { ArcGisProximityAnalysisLifecyclePolicy, type ArcGisProximityBudget, type ArcGisProximityRequest } from './ArcGisProximityAnalysisLifecyclePolicy'

const budget: ArcGisProximityBudget = {
  maxAnalyses: 6, maxAnalysesPerView: 4, maxRunning: 2, maxReady: 3,
  maxCandidatesPerAnalysis: 100, maxReadyCandidates: 200,
  maxVerticesPerAnalysis: 1_000, maxReadyVertices: 2_000,
  maxBytesPerAnalysis: 10_000, maxReadyBytes: 20_000,
  queueTtlMs: 100, runTtlMs: 200, readyTtlMs: 300,
}
const request = (overrides: Partial<ArcGisProximityRequest> = {}): ArcGisProximityRequest => ({
  viewId: 'view-1', layerId: 'layer-1', analysisId: 'analysis-1', revision: 1,
  intent: 'selection', estimatedCandidates: 20, estimatedVertices: 100, estimatedBytes: 2_000, requestedAt: 10, ...overrides,
})
const complete = (policy: ArcGisProximityAnalysisLifecyclePolicy, id = 'analysis-1', candidates = 20, vertices = 100, bytes = 2_000, now = 30) =>
  policy.complete({ viewId: 'view-1', layerId: 'layer-1', analysisId: id, revision: 1 }, candidates, vertices, bytes, now)

describe('ArcGisProximityAnalysisLifecyclePolicy', () => {
  it('schedules interactive before selection and background work', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget)
    policy.enqueue(request({ analysisId: 'background', intent: 'background', requestedAt: 1 }))
    policy.enqueue(request({ analysisId: 'selection', intent: 'selection', requestedAt: 2 }))
    policy.enqueue(request({ analysisId: 'interactive', intent: 'interactive', requestedAt: 3 }))
    expect(policy.takeNext(10)?.analysisId).toBe('interactive')
    expect(policy.takeNext(11)?.analysisId).toBe('selection')
  })

  it('uses request time then id as deterministic tie breakers', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget)
    policy.enqueue(request({ analysisId: 'z', requestedAt: 5 })); policy.enqueue(request({ analysisId: 'b', requestedAt: 4 })); policy.enqueue(request({ analysisId: 'a', requestedAt: 4 }))
    expect(policy.takeNext(10)?.analysisId).toBe('a'); expect(policy.takeNext(10)?.analysisId).toBe('b')
  })

  it('bounds running concurrency', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget)
    for (const analysisId of ['a', 'b', 'c']) policy.enqueue(request({ analysisId }))
    expect(policy.takeNext(20)?.analysisId).toBe('a'); expect(policy.takeNext(20)?.analysisId).toBe('b'); expect(policy.takeNext(20)).toBeUndefined()
  })

  it('rejects duplicate authority and bounds global cardinality', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy({ ...budget, maxAnalyses: 2, maxAnalysesPerView: 2, maxRunning: 1, maxReady: 1 })
    policy.enqueue(request({ analysisId: 'a' })); expect(() => policy.enqueue(request({ analysisId: 'a' }))).toThrow(/duplicate/)
    policy.enqueue(request({ analysisId: 'b' })); expect(() => policy.enqueue(request({ analysisId: 'c' }))).toThrow(/capacity/)
  })

  it('bounds per-view cardinality independently', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy({ ...budget, maxAnalysesPerView: 2 })
    policy.enqueue(request({ analysisId: 'a' })); policy.enqueue(request({ analysisId: 'b' }))
    expect(() => policy.enqueue(request({ analysisId: 'c' }))).toThrow(/view proximity/)
    expect(() => policy.enqueue(request({ viewId: 'view-2', analysisId: 'c' }))).not.toThrow()
  })

  it('reconciles estimates to actual residency', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget); policy.enqueue(request()); policy.takeNext(20)
    const ready = complete(policy, 'analysis-1', 40, 400, 4_000)
    expect(ready.phase).toBe('ready'); expect(ready.actualCandidates).toBe(40); expect(ready.actualVertices).toBe(400); expect(ready.actualBytes).toBe(4_000)
  })

  it.each([[101, 100, 1_000], [20, 1_001, 1_000], [20, 100, 10_001]])('rejects oversized actual result and releases authority', (candidates, vertices, bytes) => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget); policy.enqueue(request()); policy.takeNext(20)
    expect(() => complete(policy, 'analysis-1', candidates, vertices, bytes)).toThrow(/result budget/); expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds aggregate ready candidate residency', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy({ ...budget, maxReadyCandidates: 120 })
    policy.enqueue(request({ analysisId: 'a' })); policy.takeNext(20); complete(policy, 'a', 80, 100, 1_000)
    policy.enqueue(request({ analysisId: 'b' })); policy.takeNext(40)
    expect(() => complete(policy, 'b', 50, 100, 1_000, 50)).toThrow(/candidate budget/); expect(policy.snapshot().some(x => x.analysisId === 'b')).toBe(false)
  })

  it('bounds aggregate ready vertex residency', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy({ ...budget, maxReadyVertices: 1_200 })
    policy.enqueue(request({ analysisId: 'a' })); policy.takeNext(20); complete(policy, 'a', 20, 800, 1_000)
    policy.enqueue(request({ analysisId: 'b' })); policy.takeNext(40)
    expect(() => complete(policy, 'b', 20, 500, 1_000, 50)).toThrow(/vertex budget/)
  })

  it('bounds aggregate ready byte residency', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy({ ...budget, maxReadyBytes: 12_000 })
    policy.enqueue(request({ analysisId: 'a' })); policy.takeNext(20); complete(policy, 'a', 20, 100, 8_000)
    policy.enqueue(request({ analysisId: 'b' })); policy.takeNext(40)
    expect(() => complete(policy, 'b', 20, 100, 5_000, 50)).toThrow(/byte budget/)
  })

  it('rejects stale completion after revision advance', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget); policy.enqueue(request()); policy.takeNext(20)
    expect(policy.advanceLayerRevision('layer-1', 2)).toBe(1)
    expect(() => complete(policy)).toThrow(/not running/)
  })

  it('rejects stale enqueue and backwards revision movement', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget); policy.advanceLayerRevision('layer-1', 3)
    expect(() => policy.enqueue(request({ revision: 2 }))).toThrow(/stale/); expect(() => policy.advanceLayerRevision('layer-1', 2)).toThrow(/backwards/)
  })

  it('expires queued, running and ready leases', () => {
    const queued = new ArcGisProximityAnalysisLifecyclePolicy(budget); queued.enqueue(request({ requestedAt: 0 })); expect(queued.expire(101)).toBe(1)
    const running = new ArcGisProximityAnalysisLifecyclePolicy(budget); running.enqueue(request({ requestedAt: 0 })); running.takeNext(10); expect(running.expire(211)).toBe(1)
    const ready = new ArcGisProximityAnalysisLifecyclePolicy(budget); ready.enqueue(request({ requestedAt: 0 })); ready.takeNext(10); complete(ready, 'analysis-1', 20, 100, 2_000, 20); expect(ready.expire(321)).toBe(1)
  })

  it('touch extends only live ready residency', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget); policy.enqueue(request()); policy.takeNext(20); complete(policy)
    expect(policy.touch('view-1', 'layer-1', 'analysis-1', 40)).toBe(true); expect(policy.snapshot()[0].expiresAt).toBe(340)
    expect(policy.touch('view-1', 'layer-1', 'missing', 40)).toBe(false)
  })

  it('consume transfers ready authority exactly once', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget); policy.enqueue(request()); policy.takeNext(20); complete(policy)
    expect(policy.consume('view-1', 'layer-1', 'analysis-1')?.phase).toBe('ready'); expect(policy.consume('view-1', 'layer-1', 'analysis-1')).toBeUndefined()
  })

  it('supports cancel, view teardown and layer teardown', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget)
    policy.enqueue(request({ analysisId: 'a' })); policy.enqueue(request({ analysisId: 'b' })); expect(policy.cancel('view-1', 'layer-1', 'a')).toBe(true)
    expect(policy.releaseView('view-1')).toBe(1)
    policy.enqueue(request({ viewId: 'view-2', analysisId: 'c' })); expect(policy.releaseLayer('layer-1')).toBe(1)
  })

  it('returns detached frozen snapshots without payload graphs', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget); const snapshot = policy.enqueue(request())
    expect(Object.isFrozen(snapshot)).toBe(true); expect(snapshot).not.toHaveProperty('geometry'); expect(snapshot).not.toHaveProperty('graphic'); expect(snapshot).not.toHaveProperty('features'); expect(snapshot).not.toHaveProperty('abortController')
  })

  it('fingerprint is deterministic and scalar-only', () => {
    const first = new ArcGisProximityAnalysisLifecyclePolicy(budget); const second = new ArcGisProximityAnalysisLifecyclePolicy(budget)
    first.enqueue(request({ analysisId: 'b' })); first.enqueue(request({ analysisId: 'a' })); second.enqueue(request({ analysisId: 'a' })); second.enqueue(request({ analysisId: 'b' }))
    expect(first.fingerprint()).toBe(second.fingerprint()); expect(first.fingerprint()).not.toContain('[object Object]')
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite request time %s', requestedAt => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget); expect(() => policy.enqueue(request({ requestedAt }))).toThrow(/finite/)
  })

  it.each(['', 'bad id', 'x'.repeat(161)])('rejects malformed identifiers', analysisId => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget); expect(() => policy.enqueue(request({ analysisId }))).toThrow(/invalid/)
  })

  it('rejects impossible and non-positive budgets', () => {
    expect(() => new ArcGisProximityAnalysisLifecyclePolicy({ ...budget, maxRunning: 7 })).toThrow(/impossible/)
    expect(() => new ArcGisProximityAnalysisLifecyclePolicy({ ...budget, maxReadyVertices: 999 })).toThrow(/impossible/)
    expect(() => new ArcGisProximityAnalysisLifecyclePolicy({ ...budget, queueTtlMs: 0 })).toThrow(/positive/)
  })

  it('dispose clears authority and fails closed afterwards', () => {
    const policy = new ArcGisProximityAnalysisLifecyclePolicy(budget); policy.enqueue(request()); policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/); expect(() => policy.enqueue(request())).toThrow(/disposed/)
  })
})
