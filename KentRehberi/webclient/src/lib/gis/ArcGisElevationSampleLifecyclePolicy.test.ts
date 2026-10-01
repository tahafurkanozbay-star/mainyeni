import { describe, expect, it } from 'vitest'
import { ArcGisElevationSampleLifecyclePolicy, type ArcGisElevationSampleBudget, type ArcGisElevationSampleRequest } from './ArcGisElevationSampleLifecyclePolicy'

const budget: ArcGisElevationSampleBudget = {
  maxJobs: 6,
  maxJobsPerView: 4,
  maxSampling: 2,
  maxReady: 3,
  maxPointsPerJob: 100,
  maxBytesPerJob: 1000,
  maxAggregateReadyPoints: 200,
  maxAggregateReadyBytes: 2000,
  queueTtlMs: 100,
  samplingLeaseMs: 200,
  readyTtlMs: 300,
}

function request(overrides: Partial<ArcGisElevationSampleRequest> = {}): ArcGisElevationSampleRequest {
  return {
    viewId: 'view-1', surfaceId: 'ground', jobId: 'job-1', revision: 1, intent: 'visible', requestedAt: 10,
    inputWkid: 3857, outputWkid: 3857, pointCount: 20, estimatedBytes: 200, ...overrides,
  }
}

describe('ArcGisElevationSampleLifecyclePolicy', () => {
  it('schedules interactive work before visible and background work', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    expect(policy.enqueue(request({ jobId: 'background', intent: 'background', requestedAt: 1 }))).toBe(true)
    expect(policy.enqueue(request({ jobId: 'visible', intent: 'visible', requestedAt: 2 }))).toBe(true)
    expect(policy.enqueue(request({ jobId: 'interactive', intent: 'interactive', requestedAt: 3 }))).toBe(true)
    expect(policy.takeNext(20)?.jobId).toBe('interactive')
    expect(policy.takeNext(21)?.jobId).toBe('visible')
    expect(policy.takeNext(22)).toBeUndefined()
  })

  it('uses FIFO sequence as the final deterministic tie break', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'first', requestedAt: 5 }))
    policy.enqueue(request({ jobId: 'second', requestedAt: 5 }))
    expect(policy.takeNext(10)?.jobId).toBe('first')
    expect(policy.takeNext(10)?.jobId).toBe('second')
  })

  it('rejects jobs that exceed point or byte budgets', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    expect(policy.enqueue(request({ pointCount: 101 }))).toBe(false)
    expect(policy.enqueue(request({ estimatedBytes: 1001 }))).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds global and per-view cardinality', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy({ ...budget, maxJobs: 2, maxJobsPerView: 1, maxSampling: 1, maxReady: 1 })
    expect(policy.enqueue(request({ jobId: 'a' }))).toBe(true)
    expect(policy.enqueue(request({ jobId: 'b' }))).toBe(false)
    expect(policy.enqueue(request({ viewId: 'view-2', jobId: 'c' }))).toBe(true)
    expect(policy.enqueue(request({ viewId: 'view-3', jobId: 'd' }))).toBe(false)
  })

  it('rejects stale revisions and replaces an older duplicate with a newer revision', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    expect(policy.enqueue(request({ revision: 2 }))).toBe(true)
    expect(policy.enqueue(request({ revision: 1 }))).toBe(false)
    expect(policy.enqueue(request({ revision: 3 }))).toBe(true)
    expect(policy.snapshot()).toHaveLength(1)
    expect(policy.snapshot()[0]?.revision).toBe(3)
  })

  it('invalidates stale queued and sampling jobs when a view revision advances', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'a', revision: 1 }))
    policy.enqueue(request({ jobId: 'b', revision: 1 }))
    policy.takeNext(20)
    expect(policy.invalidateView('view-1', 2)).toBe(2)
    expect(policy.snapshot()).toHaveLength(0)
    expect(policy.enqueue(request({ jobId: 'old', revision: 1 }))).toBe(false)
    expect(policy.enqueue(request({ jobId: 'new', revision: 2 }))).toBe(true)
  })

  it('accepts a matching completion and records actual byte residency', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    expect(policy.complete('view-1', 'ground', 'job-1', 1, 20, 333, 30)).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({ phase: 'ready', pointCount: 20, bytes: 333, expiresAt: 330 })
  })

  it('rejects completion with a mismatched point count and removes corrupted ownership', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    expect(policy.complete('view-1', 'ground', 'job-1', 1, 19, 200, 30)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects late completion after the sampling lease expires', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    expect(policy.complete('view-1', 'ground', 'job-1', 1, 20, 200, 220)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds aggregate ready point residency', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy({ ...budget, maxAggregateReadyPoints: 100 })
    policy.enqueue(request({ jobId: 'a', pointCount: 60 }))
    policy.enqueue(request({ jobId: 'b', pointCount: 60 }))
    policy.takeNext(20)
    policy.takeNext(20)
    expect(policy.complete('view-1', 'ground', 'a', 1, 60, 200, 30)).toBe(true)
    expect(policy.complete('view-1', 'ground', 'b', 1, 60, 200, 30)).toBe(false)
  })

  it('bounds aggregate ready byte residency using actual completion bytes', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy({ ...budget, maxAggregateReadyBytes: 1000 })
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ jobId: 'b' }))
    policy.takeNext(20)
    policy.takeNext(20)
    expect(policy.complete('view-1', 'ground', 'a', 1, 20, 700, 30)).toBe(true)
    expect(policy.complete('view-1', 'ground', 'b', 1, 20, 400, 30)).toBe(false)
  })

  it('releases capacity after consuming a ready result', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy({ ...budget, maxReady: 1 })
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ jobId: 'b' }))
    policy.takeNext(20)
    policy.takeNext(20)
    expect(policy.complete('view-1', 'ground', 'a', 1, 20, 200, 30)).toBe(true)
    expect(policy.complete('view-1', 'ground', 'b', 1, 20, 200, 30)).toBe(false)
    expect(policy.consume('view-1', 'ground', 'a', 1)).toBe(true)
    expect(policy.complete('view-1', 'ground', 'b', 1, 20, 200, 31)).toBe(true)
  })

  it('cancels queued, sampling, or ready ownership only at the matching revision', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(policy.cancel('view-1', 'ground', 'job-1', 2)).toBe(false)
    expect(policy.cancel('view-1', 'ground', 'job-1', 1)).toBe(true)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('expires queued jobs at their TTL boundary', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    policy.enqueue(request({ requestedAt: 10 }))
    expect(policy.expire(109)).toBe(0)
    expect(policy.expire(110)).toBe(1)
  })

  it('expires ready jobs and frees aggregate residency', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    policy.complete('view-1', 'ground', 'job-1', 1, 20, 200, 30)
    expect(policy.expire(329)).toBe(0)
    expect(policy.expire(330)).toBe(1)
  })

  it('releases all jobs and revision state for a destroyed view', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'a', revision: 3 }))
    policy.enqueue(request({ jobId: 'b', revision: 3 }))
    expect(policy.releaseView('view-1')).toBe(2)
    expect(policy.enqueue(request({ jobId: 'fresh', revision: 1 }))).toBe(true)
  })

  it('normalizes identifiers without retaining caller whitespace', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    expect(policy.enqueue(request({ viewId: ' view ', surfaceId: ' ground ', jobId: ' job ' }))).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({ viewId: 'view', surfaceId: 'ground', jobId: 'job' })
  })

  it('rejects identifiers that could collide with the internal key separator', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ jobId: 'bad\u0000id' }))).toThrow(/safe characters/)
  })

  it('validates spatial references as positive integer WKIDs', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ inputWkid: 0 }))).toThrow(/inputWkid/)
    expect(() => policy.enqueue(request({ outputWkid: 3857.5 }))).toThrow(/outputWkid/)
  })

  it('produces deterministic fingerprints without payload data', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ jobId: 'b' }))
    expect(policy.fingerprint()).toBe('view-1:ground:a:1:queued:20:0|view-1:ground:b:1:queued:20:0')
    expect(JSON.stringify(policy.snapshot())).not.toContain('geometry')
    expect(JSON.stringify(policy.snapshot())).not.toContain('attributes')
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.enqueue(request())).toThrow(/disposed/)
    expect(() => policy.takeNext(20)).toThrow(/disposed/)
  })

  it('rejects invalid budget relationships', () => {
    expect(() => new ArcGisElevationSampleLifecyclePolicy({ ...budget, maxJobsPerView: 7 })).toThrow(/cannot exceed/)
    expect(() => new ArcGisElevationSampleLifecyclePolicy({ ...budget, maxAggregateReadyPoints: 99 })).toThrow(/admit one maximum job/)
    expect(() => new ArcGisElevationSampleLifecyclePolicy({ ...budget, maxAggregateReadyBytes: 999 })).toThrow(/admit one maximum job/)
  })

  it('rejects non-finite timestamps before state mutation', () => {
    const policy = new ArcGisElevationSampleLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ requestedAt: Number.NaN }))).toThrow(/requestedAt/)
    expect(policy.snapshot()).toHaveLength(0)
  })
})
