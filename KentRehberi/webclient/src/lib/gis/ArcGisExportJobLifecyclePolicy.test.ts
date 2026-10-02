import { describe, expect, it } from 'vitest'
import { ArcGisExportJobLifecyclePolicy, type ArcGisExportJobBudget, type ArcGisExportJobRequest } from './ArcGisExportJobLifecyclePolicy'

const budget: ArcGisExportJobBudget = {
  maxJobs: 6, maxJobsPerView: 4, maxRunning: 2, maxReady: 2,
  maxEstimatedBytesPerJob: 1000, maxAggregateReadyBytes: 1500, maxPixelCount: 4_000_000,
  queueTtlMs: 100, runLeaseMs: 50, readyTtlMs: 200,
}
const request = (overrides: Partial<ArcGisExportJobRequest> = {}): ArcGisExportJobRequest => ({
  viewId: 'map', jobId: 'job-1', revision: 1, intent: 'interactive', format: 'pdf', requestedAt: 10,
  width: 1000, height: 800, dpi: 96, estimatedBytes: 500, ...overrides,
})

describe('ArcGisExportJobLifecyclePolicy', () => {
  it('admits valid bounded jobs and returns detached snapshots', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    const snapshot = policy.snapshot()
    expect(snapshot).toHaveLength(1)
    snapshot[0].jobId = 'mutated'
    expect(policy.snapshot()[0].jobId).toBe('job-1')
  })

  it('rejects malformed identifiers and invalid numeric input', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    expect(policy.enqueue(request({ viewId: ' ' }))).toBe(false)
    expect(policy.enqueue(request({ jobId: 'bad|id' }))).toBe(false)
    expect(policy.enqueue(request({ revision: 0 }))).toBe(false)
    expect(policy.enqueue(request({ requestedAt: Number.NaN }))).toBe(false)
    expect(policy.enqueue(request({ width: 0 }))).toBe(false)
    expect(policy.enqueue(request({ height: 0 }))).toBe(false)
    expect(policy.enqueue(request({ dpi: 0 }))).toBe(false)
    expect(policy.enqueue(request({ estimatedBytes: -1 }))).toBe(false)
  })

  it('rejects oversized raster dimensions without unsafe multiplication', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    expect(policy.enqueue(request({ width: 4000, height: 2000 }))).toBe(false)
    expect(policy.enqueue(request({ width: Number.MAX_SAFE_INTEGER, height: 2 }))).toBe(false)
  })

  it('enforces per-job estimated byte budget', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    expect(policy.enqueue(request({ estimatedBytes: 1001 }))).toBe(false)
  })

  it('enforces global and per-view cardinality', () => {
    const policy = new ArcGisExportJobLifecyclePolicy({ ...budget, maxJobs: 2, maxJobsPerView: 1 })
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.enqueue(request({ jobId: 'job-2' }))).toBe(false)
    expect(policy.enqueue(request({ viewId: 'scene', jobId: 'job-2' }))).toBe(true)
    expect(policy.enqueue(request({ viewId: 'other', jobId: 'job-3' }))).toBe(false)
  })

  it('schedules interactive before share before background deterministically', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'bg', intent: 'background', requestedAt: 1 }))
    policy.enqueue(request({ jobId: 'share', intent: 'share', requestedAt: 2 }))
    policy.enqueue(request({ jobId: 'ui', intent: 'interactive', requestedAt: 3 }))
    expect(policy.takeNext(10)?.jobId).toBe('ui')
    expect(policy.takeNext(11)?.jobId).toBe('share')
  })

  it('uses request time and sequence as deterministic tie breakers', () => {
    const policy = new ArcGisExportJobLifecyclePolicy({ ...budget, maxRunning: 4 })
    policy.enqueue(request({ jobId: 'later', requestedAt: 20 }))
    policy.enqueue(request({ jobId: 'first', requestedAt: 10 }))
    policy.enqueue(request({ jobId: 'second', requestedAt: 10 }))
    expect(policy.takeNext(30)?.jobId).toBe('first')
    expect(policy.takeNext(31)?.jobId).toBe('second')
    expect(policy.takeNext(32)?.jobId).toBe('later')
  })

  it('bounds running concurrency', () => {
    const policy = new ArcGisExportJobLifecyclePolicy({ ...budget, maxRunning: 1 })
    policy.enqueue(request())
    policy.enqueue(request({ jobId: 'job-2' }))
    expect(policy.takeNext(20)?.jobId).toBe('job-1')
    expect(policy.takeNext(21)).toBeUndefined()
  })

  it('expires queued work before scheduling', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request({ requestedAt: 0 }))
    expect(policy.takeNext(100)).toBeUndefined()
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects late completion and releases its slot', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    expect(policy.complete('map', 'job-1', 1, 300, 70)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('reconciles actual bytes and transitions to ready', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    expect(policy.complete('map', 'job-1', 1, 700, 30)).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({ phase: 'ready', actualBytes: 700 })
  })

  it('rejects oversized actual payload and disposes the entry', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    expect(policy.complete('map', 'job-1', 1, 1001, 30)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('enforces ready cardinality', () => {
    const policy = new ArcGisExportJobLifecyclePolicy({ ...budget, maxReady: 1 })
    policy.enqueue(request())
    policy.enqueue(request({ jobId: 'job-2' }))
    policy.takeNext(20); policy.takeNext(21)
    expect(policy.complete('map', 'job-1', 1, 300, 30)).toBe(true)
    expect(policy.complete('map', 'job-2', 1, 300, 31)).toBe(false)
  })

  it('enforces aggregate ready bytes', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.enqueue(request({ jobId: 'job-2' }))
    policy.takeNext(20); policy.takeNext(21)
    expect(policy.complete('map', 'job-1', 1, 900, 30)).toBe(true)
    expect(policy.complete('map', 'job-2', 1, 700, 31)).toBe(false)
  })

  it('touch extends only a live matching ready entry', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20); policy.complete('map', 'job-1', 1, 300, 30)
    expect(policy.touch('map', 'job-1', 2, 40)).toBe(false)
    expect(policy.touch('map', 'job-1', 1, 40)).toBe(true)
    expect(policy.snapshot()[0].expiresAt).toBe(240)
  })

  it('consume releases ready ownership', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20); policy.complete('map', 'job-1', 1, 300, 30)
    expect(policy.consume('map', 'job-1', 1)).toBe(true)
    expect(policy.consume('map', 'job-1', 1)).toBe(false)
  })

  it('cancel releases queued or running work with revision match', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(policy.cancel('map', 'job-1', 2)).toBe(false)
    expect(policy.cancel('map', 'job-1', 1)).toBe(true)
  })

  it('advancing view revision invalidates stale work', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request({ revision: 1 }))
    expect(policy.enqueue(request({ jobId: 'fresh', revision: 2 }))).toBe(true)
    expect(policy.snapshot().map(item => item.jobId)).toEqual(['fresh'])
    expect(policy.enqueue(request({ jobId: 'stale', revision: 1 }))).toBe(false)
  })

  it('rejects completion after revision invalidation', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20)
    policy.invalidateView('map', 2)
    expect(policy.complete('map', 'job-1', 1, 100, 30)).toBe(false)
  })

  it('releaseView clears jobs and revision watermark', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.enqueue(request({ viewId: 'scene', jobId: 'scene-job' }))
    expect(policy.releaseView('map')).toBe(1)
    expect(policy.snapshot().map(item => item.viewId)).toEqual(['scene'])
    expect(policy.enqueue(request({ revision: 1 }))).toBe(true)
  })

  it('expires ready residency', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20); policy.complete('map', 'job-1', 1, 100, 30)
    expect(policy.expire(230)).toBe(1)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('produces deterministic scalar-only fingerprints', () => {
    const policy = new ArcGisExportJobLifecyclePolicy(budget)
    policy.enqueue(request())
    const first = policy.fingerprint()
    const second = policy.fingerprint()
    expect(first).toBe(second)
    expect(first).toContain('map:job-1:1:interactive:pdf:queued')
    expect(first).not.toContain('AbortController')
  })

  it('validates impossible budgets fail closed', () => {
    expect(() => new ArcGisExportJobLifecyclePolicy({ ...budget, maxJobsPerView: 7 })).toThrow(RangeError)
    expect(() => new ArcGisExportJobLifecyclePolicy({ ...budget, maxRunning: 7 })).toThrow(RangeError)
    expect(() => new ArcGisExportJobLifecyclePolicy({ ...budget, queueTtlMs: 0 })).toThrow(RangeError)
  })
})
