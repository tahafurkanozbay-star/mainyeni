import { describe, expect, it } from 'vitest'
import { ArcGisGeometryJobLifecyclePolicy, type ArcGisGeometryJobBudget, type ArcGisGeometryJobRequest } from './ArcGisGeometryJobLifecyclePolicy'

const budget: ArcGisGeometryJobBudget = {
  maxJobs: 4,
  maxJobsPerView: 3,
  maxRunning: 2,
  maxReady: 2,
  maxInputVerticesPerJob: 100,
  maxOutputVerticesPerJob: 120,
  maxAggregateInputVertices: 250,
  maxAggregateOutputVertices: 300,
  maxBytesPerJob: 600,
  maxAggregateBytes: 1_200,
  queueTtlMs: 100,
  runLeaseMs: 50,
  readyTtlMs: 200,
}

function request(overrides: Partial<ArcGisGeometryJobRequest> = {}): ArcGisGeometryJobRequest {
  return { viewId: 'map-2d', jobKey: 'selection-buffer', revision: 1, operation: 'buffer', intent: 'visible', requestedAt: 10, inputVertices: 50, estimatedOutputVertices: 60, estimatedBytes: 200, inputWkid: 3857, outputWkid: 3857, ...overrides }
}

describe('ArcGisGeometryJobLifecyclePolicy', () => {
  it('rejects invalid and inconsistent budgets', () => {
    expect(() => new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxJobs: 0 })).toThrow(/maxJobs/)
    expect(() => new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxJobsPerView: 5 })).toThrow(/maxJobsPerView/)
    expect(() => new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxRunning: 5 })).toThrow(/phase limits/)
    expect(() => new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxReady: 5 })).toThrow(/phase limits/)
    expect(() => new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxInputVerticesPerJob: 251 })).toThrow(/input vertex/)
    expect(() => new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxOutputVerticesPerJob: 301 })).toThrow(/output vertex/)
    expect(() => new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxBytesPerJob: 1_201 })).toThrow(/byte budget/)
  })

  it('validates identifiers, revisions, accounting and WKIDs', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    expect(() => policy.admit(request({ viewId: ' ' }))).toThrow(/viewId/)
    expect(() => policy.admit(request({ jobKey: ' ' }))).toThrow(/jobKey/)
    expect(() => policy.admit(request({ revision: -1 }))).toThrow(/revision/)
    expect(() => policy.admit(request({ requestedAt: Number.NaN }))).toThrow(/requestedAt/)
    expect(() => policy.admit(request({ inputVertices: 1.5 }))).toThrow(/inputVertices/)
    expect(() => policy.admit(request({ estimatedOutputVertices: -1 }))).toThrow(/estimatedOutputVertices/)
    expect(() => policy.admit(request({ estimatedBytes: -1 }))).toThrow(/estimatedBytes/)
    expect(() => policy.admit(request({ inputWkid: 0 }))).toThrow(/inputWkid/)
    expect(() => policy.admit(request({ outputWkid: 0 }))).toThrow(/outputWkid/)
  })

  it('bounds per-job vertex and byte estimates without retention', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    expect(policy.admit(request({ inputVertices: 101 }))).toBe(false)
    expect(policy.admit(request({ estimatedOutputVertices: 121 }))).toBe(false)
    expect(policy.admit(request({ estimatedBytes: 601 }))).toBe(false)
    expect(policy.snapshot().jobs).toBe(0)
  })

  it('bounds aggregate input vertices', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    expect(policy.admit(request({ jobKey: 'a', inputVertices: 100 }))).toBe(true)
    expect(policy.admit(request({ jobKey: 'b', inputVertices: 100 }))).toBe(true)
    expect(policy.admit(request({ jobKey: 'c', inputVertices: 51 }))).toBe(false)
  })

  it('bounds aggregate output vertices', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    expect(policy.admit(request({ jobKey: 'a', estimatedOutputVertices: 120 }))).toBe(true)
    expect(policy.admit(request({ jobKey: 'b', estimatedOutputVertices: 120 }))).toBe(true)
    expect(policy.admit(request({ jobKey: 'c', estimatedOutputVertices: 61 }))).toBe(false)
  })

  it('bounds aggregate byte residency', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    expect(policy.admit(request({ jobKey: 'a', estimatedBytes: 600 }))).toBe(true)
    expect(policy.admit(request({ jobKey: 'b', estimatedBytes: 600 }))).toBe(true)
    expect(policy.admit(request({ jobKey: 'c', estimatedBytes: 1 }))).toBe(false)
  })

  it('bounds total and per-view cardinality', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxAggregateInputVertices: 1_000, maxAggregateOutputVertices: 1_000, maxAggregateBytes: 5_000 })
    expect(policy.admit(request({ jobKey: 'a' }))).toBe(true)
    expect(policy.admit(request({ jobKey: 'b' }))).toBe(true)
    expect(policy.admit(request({ jobKey: 'c' }))).toBe(true)
    expect(policy.admit(request({ jobKey: 'd' }))).toBe(false)
    expect(policy.admit(request({ viewId: 'scene-3d', jobKey: 'd' }))).toBe(true)
    expect(policy.admit(request({ viewId: 'scene-3d', jobKey: 'e' }))).toBe(false)
  })

  it('schedules interactive before visible and background work', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxJobsPerView: 4, maxAggregateInputVertices: 1_000, maxAggregateOutputVertices: 1_000, maxAggregateBytes: 5_000 })
    policy.admit(request({ jobKey: 'background', intent: 'background' }))
    policy.admit(request({ jobKey: 'visible', intent: 'visible' }))
    policy.admit(request({ jobKey: 'interactive', intent: 'interactive' }))
    expect(policy.next(20)?.jobKey).toBe('interactive')
  })

  it('preserves FIFO inside an intent class', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request({ jobKey: 'first', requestedAt: 10 }))
    policy.admit(request({ jobKey: 'second', requestedAt: 11 }))
    expect(policy.next(20)?.jobKey).toBe('first')
    expect(policy.next(21)?.jobKey).toBe('second')
  })

  it('does not exceed running cardinality', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxRunning: 1 })
    policy.admit(request({ jobKey: 'a' })); policy.admit(request({ jobKey: 'b' }))
    expect(policy.next(20)?.jobKey).toBe('a')
    expect(policy.next(21)).toBeNull()
  })

  it('expires queued work before scheduling', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.next(111)).toBeNull()
    expect(policy.snapshot().jobs).toBe(0)
  })

  it('rejects completion after run lease expiry', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20)
    expect(policy.complete('map-2d', 'selection-buffer', 1, 71, 60, 200)).toBe(false)
  })

  it('requires exact running revision for completion', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.complete('map-2d', 'selection-buffer', 1, 20, 60, 200)).toBe(false)
    policy.next(20)
    expect(policy.complete('map-2d', 'selection-buffer', 2, 21, 60, 200)).toBe(false)
    expect(policy.complete('map-2d', 'selection-buffer', 1, 21, 60, 200)).toBe(true)
  })

  it('rejects actual completion above per-job output budgets', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20)
    expect(policy.complete('map-2d', 'selection-buffer', 1, 21, 121, 200)).toBe(false)
    expect(policy.complete('map-2d', 'selection-buffer', 1, 21, 60, 601)).toBe(false)
  })

  it('reconciles actual completion accounting', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request({ estimatedOutputVertices: 100, estimatedBytes: 400 })); policy.next(20)
    expect(policy.complete('map-2d', 'selection-buffer', 1, 21, 20, 100)).toBe(true)
    expect(policy.snapshot().outputVertices).toBe(20)
    expect(policy.snapshot().bytes).toBe(100)
  })

  it('rejects completion that would exceed aggregate output accounting', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxAggregateOutputVertices: 200 })
    policy.admit(request({ jobKey: 'a', estimatedOutputVertices: 80 })); policy.admit(request({ jobKey: 'b', estimatedOutputVertices: 80 }))
    policy.next(20)
    expect(policy.complete('map-2d', 'a', 1, 21, 120, 200)).toBe(true)
    policy.next(22)
    expect(policy.complete('map-2d', 'b', 1, 23, 100, 200)).toBe(false)
  })

  it('bounds ready residency', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy({ ...budget, maxReady: 1 })
    policy.admit(request({ jobKey: 'a' })); policy.admit(request({ jobKey: 'b' })); policy.next(20); policy.next(20)
    expect(policy.complete('map-2d', 'a', 1, 21, 60, 200)).toBe(true)
    expect(policy.complete('map-2d', 'b', 1, 21, 60, 200)).toBe(false)
  })

  it('consumes only exact ready revisions', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20); policy.complete('map-2d', 'selection-buffer', 1, 21, 60, 200)
    expect(policy.consume('map-2d', 'selection-buffer', 2)).toBe(false)
    expect(policy.consume('map-2d', 'selection-buffer', 1)).toBe(true)
    expect(policy.snapshot().jobs).toBe(0)
  })

  it('invalidates stale view work on a newer revision', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request({ jobKey: 'a', revision: 1 })); policy.admit(request({ jobKey: 'b', revision: 1 }))
    expect(policy.invalidateView('map-2d', 2)).toBe(2)
    expect(policy.admit(request({ jobKey: 'a', revision: 1 }))).toBe(false)
    expect(policy.admit(request({ jobKey: 'a', revision: 2 }))).toBe(true)
  })

  it('automatically invalidates older siblings when newer work arrives', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request({ jobKey: 'a', revision: 1 })); policy.admit(request({ jobKey: 'b', revision: 1 }))
    expect(policy.admit(request({ jobKey: 'c', revision: 2 }))).toBe(true)
    expect(policy.entriesForView('map-2d').map(entry => entry.jobKey)).toEqual(['c'])
  })

  it('prevents lower priority duplicate replacement and permits escalation', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'interactive' }))).toBe(true)
    expect(policy.admit(request({ intent: 'background' }))).toBe(false)
    expect(policy.admit(request({ intent: 'interactive', requestedAt: 12 }))).toBe(true)
    expect(policy.snapshot().jobs).toBe(1)
  })

  it('cancels one job without disturbing siblings', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request({ jobKey: 'a' })); policy.admit(request({ jobKey: 'b' }))
    expect(policy.cancel('map-2d', 'a')).toBe(true)
    expect(policy.entriesForView('map-2d').map(entry => entry.jobKey)).toEqual(['b'])
  })

  it('releases a view and its revision watermark', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request({ jobKey: 'a' })); policy.admit(request({ jobKey: 'b' }))
    expect(policy.releaseView('map-2d')).toBe(2)
    expect(policy.snapshot().revisionWatermark).toEqual({})
  })

  it('expires ready work independently of queue TTL', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request()); policy.next(20); policy.complete('map-2d', 'selection-buffer', 1, 21, 60, 200)
    expect(policy.expire(221)).toBe(0)
    expect(policy.expire(222)).toBe(1)
  })

  it('returns immutable payload-free views', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request())
    const entry = policy.entriesForView('map-2d')[0]
    expect(Object.isFrozen(entry)).toBe(true)
    expect(entry).toEqual(expect.objectContaining({ viewId: 'map-2d', operation: 'buffer', inputVertices: 50, outputVertices: 60 }))
    expect(entry).not.toHaveProperty('geometry')
    expect(entry).not.toHaveProperty('abortController')
  })

  it('produces deterministic fingerprints independent of insertion order', () => {
    const a = new ArcGisGeometryJobLifecyclePolicy(budget); const b = new ArcGisGeometryJobLifecyclePolicy(budget)
    a.admit(request({ jobKey: 'a' })); a.admit(request({ jobKey: 'b' }))
    b.admit(request({ jobKey: 'b' })); b.admit(request({ jobKey: 'a' }))
    expect(a.fingerprint()).toBe(b.fingerprint())
  })

  it('supports explicit projection jobs without inventing a service endpoint', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    expect(policy.admit(request({ operation: 'project', inputWkid: 4326, outputWkid: 3857 }))).toBe(true)
    expect(policy.entriesForView('map-2d')[0]).toEqual(expect.objectContaining({ operation: 'project', inputWkid: 4326, outputWkid: 3857 }))
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisGeometryJobLifecyclePolicy(budget)
    policy.admit(request()); policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.admit(request())).toThrow(/disposed/)
  })
})
