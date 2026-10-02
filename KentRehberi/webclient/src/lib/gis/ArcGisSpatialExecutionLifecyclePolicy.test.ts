import { describe, expect, it } from 'vitest'
import { ArcGisSpatialExecutionLifecyclePolicy, type ArcGisSpatialExecutionBudget, type ArcGisSpatialExecutionRequest } from './ArcGisSpatialExecutionLifecyclePolicy'

const budget: ArcGisSpatialExecutionBudget = {
  maxExecutions: 8, maxExecutionsPerView: 5, maxExecutionsPerLayer: 6,
  maxRunning: 2, maxRunningPerView: 1, maxReady: 4,
  maxEstimatedVerticesPerExecution: 500, maxActualVerticesPerExecution: 1_000, maxReadyVertices: 2_000,
  maxEstimatedBytesPerExecution: 5_000, maxActualBytesPerExecution: 10_000, maxReadyBytes: 20_000,
  queueTtlMs: 100, runTtlMs: 200, readyTtlMs: 300,
}

const request = (overrides: Partial<ArcGisSpatialExecutionRequest> = {}): ArcGisSpatialExecutionRequest => ({
  executionId: 'exec-1', viewId: 'view-1', layerId: 'layer-1', revision: 1,
  kind: 'query', intent: 'visible', requestedAt: 10, estimatedVertices: 100, estimatedBytes: 1_000, ...overrides,
})

const running = (policy: ArcGisSpatialExecutionLifecyclePolicy, overrides: Partial<ArcGisSpatialExecutionRequest> = {}) => {
  const value = request(overrides); policy.enqueue(value); policy.takeNext(20); return value
}

const complete = (policy: ArcGisSpatialExecutionLifecyclePolicy, executionId = 'exec-1', overrides: Partial<{ viewId: string; layerId: string; revision: number; actualVertices: number; actualBytes: number; completedAt: number }> = {}) => policy.complete({
  executionId, viewId: 'view-1', layerId: 'layer-1', revision: 1, actualVertices: 120, actualBytes: 1_200, completedAt: 30, ...overrides,
})

describe('ArcGisSpatialExecutionLifecyclePolicy', () => {
  it('schedules interactive before visible before background', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy({ ...budget, maxRunningPerView: 2 })
    policy.enqueue(request({ executionId: 'background', intent: 'background', requestedAt: 1 }))
    policy.enqueue(request({ executionId: 'visible', intent: 'visible', requestedAt: 2 }))
    policy.enqueue(request({ executionId: 'interactive', intent: 'interactive', requestedAt: 3 }))
    expect(policy.takeNext(10)?.executionId).toBe('interactive')
    expect(policy.takeNext(11)?.executionId).toBe('visible')
  })

  it('uses requested time then id as deterministic tie breakers', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy({ ...budget, maxRunningPerView: 2 })
    policy.enqueue(request({ executionId: 'z', requestedAt: 5 })); policy.enqueue(request({ executionId: 'b', requestedAt: 4 })); policy.enqueue(request({ executionId: 'a', requestedAt: 4 }))
    expect(policy.takeNext(10)?.executionId).toBe('a'); expect(policy.takeNext(10)?.executionId).toBe('b')
  })

  it('enforces global and per-view running concurrency', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget)
    policy.enqueue(request({ executionId: 'a', viewId: 'v1' })); policy.enqueue(request({ executionId: 'b', viewId: 'v1' })); policy.enqueue(request({ executionId: 'c', viewId: 'v2' }))
    expect(policy.takeNext(20)?.executionId).toBe('a'); expect(policy.takeNext(20)?.executionId).toBe('c'); expect(policy.takeNext(20)).toBeUndefined()
  })

  it('bounds global, per-view and per-layer authority', () => {
    const global = new ArcGisSpatialExecutionLifecyclePolicy({ ...budget, maxExecutions: 2, maxExecutionsPerView: 2, maxExecutionsPerLayer: 2, maxRunning: 1, maxReady: 1 })
    global.enqueue(request({ executionId: 'a' })); global.enqueue(request({ executionId: 'b' })); expect(() => global.enqueue(request({ executionId: 'c' }))).toThrow(/capacity/)
    const view = new ArcGisSpatialExecutionLifecyclePolicy({ ...budget, maxExecutionsPerView: 1 })
    view.enqueue(request({ executionId: 'a' })); expect(() => view.enqueue(request({ executionId: 'b' }))).toThrow(/view/)
    const layer = new ArcGisSpatialExecutionLifecyclePolicy({ ...budget, maxExecutionsPerLayer: 1 })
    layer.enqueue(request({ executionId: 'a' })); expect(() => layer.enqueue(request({ executionId: 'b', viewId: 'view-2' }))).toThrow(/layer/)
  })

  it('rejects duplicate execution authority', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); policy.enqueue(request()); expect(() => policy.enqueue(request())).toThrow(/duplicate/)
  })

  it('rejects oversized estimates before retaining authority', () => {
    const vertices = new ArcGisSpatialExecutionLifecyclePolicy(budget); expect(() => vertices.enqueue(request({ estimatedVertices: 501 }))).toThrow(/vertex/); expect(vertices.snapshot()).toHaveLength(0)
    const bytes = new ArcGisSpatialExecutionLifecyclePolicy(budget); expect(() => bytes.enqueue(request({ estimatedBytes: 5_001 }))).toThrow(/byte/); expect(bytes.snapshot()).toHaveLength(0)
  })

  it('reconciles estimates to actual ready residency', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); running(policy)
    const ready = complete(policy); expect(ready.phase).toBe('ready'); expect(ready.actualVertices).toBe(120); expect(ready.actualBytes).toBe(1_200)
  })

  it('rejects oversized actual results and releases authority', () => {
    const vertices = new ArcGisSpatialExecutionLifecyclePolicy(budget); running(vertices); expect(() => complete(vertices, 'exec-1', { actualVertices: 1_001 })).toThrow(/vertex/); expect(vertices.snapshot()).toHaveLength(0)
    const bytes = new ArcGisSpatialExecutionLifecyclePolicy(budget); running(bytes); expect(() => complete(bytes, 'exec-1', { actualBytes: 10_001 })).toThrow(/byte/); expect(bytes.snapshot()).toHaveLength(0)
  })

  it('bounds aggregate ready vertex residency', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy({ ...budget, maxReadyVertices: 1_100 })
    running(policy, { executionId: 'a', viewId: 'v1' }); complete(policy, 'a', { viewId: 'v1', actualVertices: 800 })
    running(policy, { executionId: 'b', viewId: 'v2' }); expect(() => complete(policy, 'b', { viewId: 'v2', actualVertices: 400 })).toThrow(/vertex residency/)
  })

  it('bounds aggregate ready byte residency', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy({ ...budget, maxReadyBytes: 11_000 })
    running(policy, { executionId: 'a', viewId: 'v1' }); complete(policy, 'a', { viewId: 'v1', actualBytes: 8_000 })
    running(policy, { executionId: 'b', viewId: 'v2' }); expect(() => complete(policy, 'b', { viewId: 'v2', actualBytes: 4_000 })).toThrow(/byte residency/)
  })

  it('bounds ready cardinality', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy({ ...budget, maxReady: 1 })
    running(policy, { executionId: 'a', viewId: 'v1' }); complete(policy, 'a', { viewId: 'v1' })
    running(policy, { executionId: 'b', viewId: 'v2' }); expect(() => complete(policy, 'b', { viewId: 'v2' })).toThrow(/ready capacity/)
  })

  it('advances layer revision and invalidates stale work', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); policy.enqueue(request()); expect(policy.advanceLayerRevision('layer-1', 2)).toBe(1); expect(policy.snapshot()).toHaveLength(0)
    expect(() => policy.enqueue(request({ executionId: 'stale', revision: 1 }))).toThrow(/stale/)
  })

  it('rejects backwards layer revision movement', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); policy.advanceLayerRevision('layer-1', 3); expect(() => policy.advanceLayerRevision('layer-1', 2)).toThrow(/backwards/)
  })

  it('rejects stale completion after revision advance', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); running(policy); policy.advanceLayerRevision('layer-1', 2); expect(() => complete(policy)).toThrow(/not running/)
  })

  it('rejects completion identity mismatch without transferring authority', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); running(policy); expect(() => complete(policy, 'exec-1', { viewId: 'wrong' })).toThrow(/identity/); expect(policy.snapshot()[0].phase).toBe('running')
  })

  it('expires queued running and ready leases', () => {
    const queued = new ArcGisSpatialExecutionLifecyclePolicy(budget); queued.enqueue(request({ requestedAt: 0 })); expect(queued.expire(101)).toBe(1)
    const run = new ArcGisSpatialExecutionLifecyclePolicy(budget); run.enqueue(request({ requestedAt: 0 })); run.takeNext(10); expect(run.expire(211)).toBe(1)
    const ready = new ArcGisSpatialExecutionLifecyclePolicy(budget); running(ready); complete(ready); expect(ready.expire(331)).toBe(1)
  })

  it('rejects late completion and releases running authority', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); running(policy); expect(() => complete(policy, 'exec-1', { completedAt: 221 })).toThrow(/expired/); expect(policy.snapshot()).toHaveLength(0)
  })

  it('touch extends only live ready residency', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); running(policy); complete(policy); expect(policy.touch('exec-1', 40)).toBe(true); expect(policy.snapshot()[0].expiresAt).toBe(340); expect(policy.touch('missing', 40)).toBe(false)
  })

  it('consume transfers ready authority exactly once', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); running(policy); complete(policy); expect(policy.consume('exec-1')?.phase).toBe('ready'); expect(policy.consume('exec-1')).toBeUndefined()
  })

  it('cancel refuses ready authority', () => {
    const queued = new ArcGisSpatialExecutionLifecyclePolicy(budget); queued.enqueue(request()); expect(queued.cancel('exec-1')).toBe(true)
    const ready = new ArcGisSpatialExecutionLifecyclePolicy(budget); running(ready); complete(ready); expect(ready.cancel('exec-1')).toBe(false)
  })

  it('releases view and layer authority deterministically', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); policy.enqueue(request({ executionId: 'a' })); policy.enqueue(request({ executionId: 'b', viewId: 'view-2' })); expect(policy.releaseView('view-1')).toBe(1); expect(policy.releaseLayer('layer-1')).toBe(1); expect(policy.snapshot()).toHaveLength(0)
  })

  it('supports all governed execution kinds without retaining payloads', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget)
    const kinds = ['query', 'identify', 'buffer', 'nearest', 'projection', 'measurement'] as const
    kinds.forEach((kind, index) => policy.enqueue(request({ executionId: `e-${index}`, viewId: `v-${index}`, kind })))
    const snapshot = policy.snapshot(); expect(snapshot.map(entry => entry.kind)).toEqual(kinds); expect(snapshot[0]).not.toHaveProperty('geometry'); expect(snapshot[0]).not.toHaveProperty('features'); expect(snapshot[0]).not.toHaveProperty('credential'); expect(snapshot[0]).not.toHaveProperty('abortController')
  })

  it('returns frozen detached views', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); const view = policy.enqueue(request()); expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(policy.snapshot())).toBe(true)
  })

  it('fingerprint is deterministic and scalar-only', () => {
    const first = new ArcGisSpatialExecutionLifecyclePolicy(budget); const second = new ArcGisSpatialExecutionLifecyclePolicy(budget)
    first.enqueue(request({ executionId: 'b' })); first.enqueue(request({ executionId: 'a' })); second.enqueue(request({ executionId: 'a' })); second.enqueue(request({ executionId: 'b' }))
    expect(first.fingerprint()).toBe(second.fingerprint()); expect(first.fingerprint()).not.toContain('[object Object]')
  })

  it.each(['', 'bad id', 'x'.repeat(161)])('rejects malformed execution identifiers', executionId => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); expect(() => policy.enqueue(request({ executionId }))).toThrow(/invalid/)
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite request time %s', requestedAt => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); expect(() => policy.enqueue(request({ requestedAt }))).toThrow(/finite/)
  })

  it('rejects impossible budgets', () => {
    expect(() => new ArcGisSpatialExecutionLifecyclePolicy({ ...budget, maxRunningPerView: 3, maxRunning: 2 })).toThrow(/impossible/)
    expect(() => new ArcGisSpatialExecutionLifecyclePolicy({ ...budget, maxActualBytesPerExecution: 4_000 })).toThrow(/impossible/)
    expect(() => new ArcGisSpatialExecutionLifecyclePolicy({ ...budget, maxActualVerticesPerExecution: 400 })).toThrow(/impossible/)
  })

  it('dispose clears authority and fails closed afterwards', () => {
    const policy = new ArcGisSpatialExecutionLifecyclePolicy(budget); policy.enqueue(request()); policy.dispose(); expect(() => policy.snapshot()).toThrow(/disposed/); expect(() => policy.enqueue(request())).toThrow(/disposed/)
  })
})
