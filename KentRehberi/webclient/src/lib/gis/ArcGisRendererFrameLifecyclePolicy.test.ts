import { describe, expect, it } from 'vitest'
import { ArcGisRendererFrameLifecyclePolicy, type ArcGisRendererFrameBudget, type ArcGisRendererFrameRequest } from './ArcGisRendererFrameLifecyclePolicy'

const budget: ArcGisRendererFrameBudget = {
  maxFrames: 6, maxFramesPerView: 4, maxRendering: 2, maxResident: 3,
  maxCommandsPerFrame: 100, maxVerticesPerFrame: 10000, maxBytesPerFrame: 20000,
  maxAggregateResidentBytes: 40000, maxAggregateResidentVertices: 20000,
  queueTtlMs: 100, renderLeaseMs: 200, residentTtlMs: 300,
}

function request(overrides: Partial<ArcGisRendererFrameRequest> = {}): ArcGisRendererFrameRequest {
  return { viewId: 'view-1', layerId: 'layer-1', frameId: 'frame-1', revision: 1, intent: 'navigation', requestedAt: 10, lod: 12, commandCount: 10, estimatedVertices: 1000, estimatedBytes: 2000, ...overrides }
}

function resident(policy: ArcGisRendererFrameLifecyclePolicy, frameId = 'frame-1', vertices = 1000, bytes = 2000): boolean {
  policy.takeNext(20)
  return policy.complete('view-1', 'layer-1', frameId, 1, vertices, bytes, 30)
}

describe('ArcGisRendererFrameLifecyclePolicy', () => {
  it('prioritizes interaction, navigation, then background', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request({ frameId: 'bg', intent: 'background' }))
    policy.enqueue(request({ frameId: 'nav', intent: 'navigation' }))
    policy.enqueue(request({ frameId: 'hot', intent: 'interaction' }))
    expect(policy.takeNext(20)?.frameId).toBe('hot')
    expect(policy.takeNext(21)?.frameId).toBe('nav')
  })

  it('prefers finer LOD within equal intent', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request({ frameId: 'coarse', lod: 5 }))
    policy.enqueue(request({ frameId: 'fine', lod: 15 }))
    expect(policy.takeNext(20)?.frameId).toBe('fine')
  })

  it('uses request time and sequence as stable tie breaks', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request({ frameId: 'late', requestedAt: 6 }))
    policy.enqueue(request({ frameId: 'first', requestedAt: 5 }))
    policy.enqueue(request({ frameId: 'second', requestedAt: 5 }))
    expect(policy.takeNext(20)?.frameId).toBe('first')
    expect(policy.takeNext(20)?.frameId).toBe('second')
  })

  it('bounds global and per-view frame cardinality', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy({ ...budget, maxFrames: 2, maxFramesPerView: 1, maxRendering: 1, maxResident: 1 })
    expect(policy.enqueue(request({ frameId: 'a' }))).toBe(true)
    expect(policy.enqueue(request({ frameId: 'b' }))).toBe(false)
    expect(policy.enqueue(request({ viewId: 'view-2', frameId: 'c' }))).toBe(true)
    expect(policy.enqueue(request({ viewId: 'view-3', frameId: 'd' }))).toBe(false)
  })

  it('rejects oversized command, vertex and byte estimates', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    expect(policy.enqueue(request({ commandCount: 101 }))).toBe(false)
    expect(policy.enqueue(request({ estimatedVertices: 10001 }))).toBe(false)
    expect(policy.enqueue(request({ estimatedBytes: 20001 }))).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds concurrent renderer work', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy({ ...budget, maxRendering: 1 })
    policy.enqueue(request({ frameId: 'a' }))
    policy.enqueue(request({ frameId: 'b' }))
    expect(policy.takeNext(20)?.frameId).toBe('a')
    expect(policy.takeNext(21)).toBeUndefined()
  })

  it('records actual resident GPU pressure', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(resident(policy, 'frame-1', 1234, 3456)).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({ phase: 'resident', actualVertices: 1234, actualBytes: 3456, expiresAt: 330 })
  })

  it('rejects completion beyond per-frame budgets', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    expect(policy.complete('view-1', 'layer-1', 'frame-1', 1, 10001, 100, 30)).toBe(false)
    policy.enqueue(request({ frameId: 'bytes' }))
    policy.takeNext(31)
    expect(policy.complete('view-1', 'layer-1', 'bytes', 1, 10, 20001, 32)).toBe(false)
  })

  it('rejects late completion at render lease boundary', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    expect(policy.complete('view-1', 'layer-1', 'frame-1', 1, 100, 100, 220)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds aggregate resident bytes', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy({ ...budget, maxAggregateResidentBytes: 10000 })
    policy.enqueue(request({ frameId: 'a' })); policy.enqueue(request({ frameId: 'b' }))
    policy.takeNext(20); policy.takeNext(20)
    expect(policy.complete('view-1', 'layer-1', 'a', 1, 100, 7000, 30)).toBe(true)
    expect(policy.complete('view-1', 'layer-1', 'b', 1, 100, 4000, 30)).toBe(false)
  })

  it('bounds aggregate resident vertices', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy({ ...budget, maxAggregateResidentVertices: 10000 })
    policy.enqueue(request({ frameId: 'a' })); policy.enqueue(request({ frameId: 'b' }))
    policy.takeNext(20); policy.takeNext(20)
    expect(policy.complete('view-1', 'layer-1', 'a', 1, 7000, 100, 30)).toBe(true)
    expect(policy.complete('view-1', 'layer-1', 'b', 1, 4000, 100, 30)).toBe(false)
  })

  it('bounds resident cardinality', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy({ ...budget, maxResident: 1 })
    policy.enqueue(request({ frameId: 'a' })); policy.enqueue(request({ frameId: 'b' }))
    policy.takeNext(20); policy.takeNext(20)
    expect(policy.complete('view-1', 'layer-1', 'a', 1, 100, 100, 30)).toBe(true)
    expect(policy.complete('view-1', 'layer-1', 'b', 1, 100, 100, 30)).toBe(false)
  })

  it('touch extends only live matching resident ownership', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request()); resident(policy)
    expect(policy.touch('view-1', 'layer-1', 'frame-1', 2, 40)).toBe(false)
    expect(policy.touch('view-1', 'layer-1', 'frame-1', 1, 40)).toBe(true)
    expect(policy.snapshot()[0]?.expiresAt).toBe(340)
  })

  it('consume releases resident capacity', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request()); resident(policy)
    expect(policy.consume('view-1', 'layer-1', 'frame-1', 2)).toBe(false)
    expect(policy.consume('view-1', 'layer-1', 'frame-1', 1)).toBe(true)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('cancel requires matching revision', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(policy.cancel('view-1', 'layer-1', 'frame-1', 2)).toBe(false)
    expect(policy.cancel('view-1', 'layer-1', 'frame-1', 1)).toBe(true)
  })

  it('rejects stale revision and replaces older duplicate', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    expect(policy.enqueue(request({ revision: 2 }))).toBe(true)
    expect(policy.enqueue(request({ revision: 1 }))).toBe(false)
    expect(policy.enqueue(request({ revision: 3 }))).toBe(true)
    expect(policy.snapshot()).toHaveLength(1)
    expect(policy.snapshot()[0]?.revision).toBe(3)
  })

  it('invalidates stale renderer work on view revision advance', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request({ frameId: 'a' })); policy.enqueue(request({ frameId: 'b' }))
    expect(policy.invalidateView('view-1', 2)).toBe(2)
    expect(policy.enqueue(request({ frameId: 'stale', revision: 1 }))).toBe(false)
    expect(policy.enqueue(request({ frameId: 'fresh', revision: 2 }))).toBe(true)
  })

  it('does not regress revision watermark', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request({ revision: 3 }))
    expect(policy.invalidateView('view-1', 2)).toBe(0)
    expect(policy.enqueue(request({ frameId: 'old', revision: 2 }))).toBe(false)
  })

  it('expires queued work exactly at TTL boundary', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request({ requestedAt: 10 }))
    expect(policy.expire(109)).toBe(0)
    expect(policy.expire(110)).toBe(1)
  })

  it('expires resident work and releases pressure accounting', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request()); resident(policy)
    expect(policy.expire(329)).toBe(0)
    expect(policy.expire(330)).toBe(1)
  })

  it('releases one layer without disturbing siblings', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request({ frameId: 'a' })); policy.enqueue(request({ layerId: 'layer-2', frameId: 'b' }))
    expect(policy.releaseLayer('view-1', 'layer-1')).toBe(1)
    expect(policy.snapshot().map(item => item.frameId)).toEqual(['b'])
  })

  it('releases destroyed view and its watermark', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request({ revision: 3 }))
    expect(policy.releaseView('view-1')).toBe(1)
    expect(policy.enqueue(request({ frameId: 'fresh', revision: 1 }))).toBe(true)
  })

  it('normalizes identifiers and rejects separator collisions', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    expect(policy.enqueue(request({ viewId: ' view ', layerId: ' layer ', frameId: ' frame ' }))).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({ viewId: 'view', layerId: 'layer', frameId: 'frame' })
    expect(policy.enqueue(request({ frameId: 'bad|frame' }))).toBe(false)
  })

  it('rejects invalid numeric and intent input fail closed', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    expect(policy.enqueue(request({ revision: 0 }))).toBe(false)
    expect(policy.enqueue(request({ requestedAt: Number.NaN }))).toBe(false)
    expect(policy.enqueue(request({ lod: -1 }))).toBe(false)
    expect(policy.enqueue(request({ intent: 'invalid' as never }))).toBe(false)
  })

  it('returns detached snapshots', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request())
    const snapshot = policy.snapshot()
    snapshot[0]!.frameId = 'mutated'
    expect(policy.snapshot()[0]?.frameId).toBe('frame-1')
  })

  it('produces deterministic scalar fingerprint without payload graphs', () => {
    const policy = new ArcGisRendererFrameLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(policy.fingerprint()).toContain('view-1:layer-1:frame-1:1:queued:navigation:12:10:1000:2000:0:0')
    expect(policy.fingerprint()).not.toContain('Graphic')
    expect(policy.fingerprint()).not.toContain('AbortController')
  })

  it('validates impossible budgets at construction', () => {
    expect(() => new ArcGisRendererFrameLifecyclePolicy({ ...budget, maxFrames: 0 })).toThrow(RangeError)
    expect(() => new ArcGisRendererFrameLifecyclePolicy({ ...budget, maxFrames: 2, maxFramesPerView: 3 })).toThrow(RangeError)
    expect(() => new ArcGisRendererFrameLifecyclePolicy({ ...budget, maxFrames: 2, maxRendering: 3 })).toThrow(RangeError)
  })
})
