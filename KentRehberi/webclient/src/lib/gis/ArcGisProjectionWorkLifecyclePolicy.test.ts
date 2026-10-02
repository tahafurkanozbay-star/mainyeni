import { describe, expect, it } from 'vitest'
import { ArcGisProjectionWorkLifecyclePolicy, type ArcGisProjectionBudget, type ArcGisProjectionRequest } from './ArcGisProjectionWorkLifecyclePolicy'

const budget: ArcGisProjectionBudget = {
  maxJobs: 6,
  maxJobsPerView: 4,
  maxRunning: 2,
  maxReady: 3,
  maxPointsPerJob: 100,
  maxReadyPoints: 200,
  maxBytesPerJob: 10_000,
  maxReadyBytes: 20_000,
  queueTtlMs: 100,
  runTtlMs: 200,
  readyTtlMs: 300,
}

const request = (overrides: Partial<ArcGisProjectionRequest> = {}): ArcGisProjectionRequest => ({
  viewId: 'view-1',
  jobId: 'job-1',
  sourceWkid: 4326,
  targetWkid: 3857,
  revision: 1,
  intent: 'navigation',
  pointCount: 20,
  estimatedBytes: 2_000,
  requestedAt: 10,
  ...overrides,
})

const running = (policy: ArcGisProjectionWorkLifecyclePolicy, overrides: Partial<ArcGisProjectionRequest> = {}) => {
  policy.enqueue(request(overrides))
  return policy.takeNext(20)
}

describe('ArcGisProjectionWorkLifecyclePolicy', () => {
  it('schedules interactive before navigation before background', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'background', intent: 'background', requestedAt: 1 }))
    policy.enqueue(request({ jobId: 'navigation', intent: 'navigation', requestedAt: 2 }))
    policy.enqueue(request({ jobId: 'interactive', intent: 'interactive', requestedAt: 3 }))
    expect(policy.takeNext(10)?.jobId).toBe('interactive')
    expect(policy.takeNext(11)?.jobId).toBe('navigation')
  })

  it('uses request time then id as deterministic tie breakers', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'z', requestedAt: 5 }))
    policy.enqueue(request({ jobId: 'b', requestedAt: 4 }))
    policy.enqueue(request({ jobId: 'a', requestedAt: 4 }))
    expect(policy.takeNext(10)?.jobId).toBe('a')
    expect(policy.takeNext(10)?.jobId).toBe('b')
  })

  it('bounds running concurrency', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    for (const jobId of ['a', 'b', 'c']) policy.enqueue(request({ jobId }))
    expect(policy.takeNext(20)?.jobId).toBe('a')
    expect(policy.takeNext(20)?.jobId).toBe('b')
    expect(policy.takeNext(20)).toBeUndefined()
  })

  it('bounds global job cardinality', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy({ ...budget, maxJobs: 2, maxJobsPerView: 2, maxRunning: 1, maxReady: 1 })
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ jobId: 'b' }))
    expect(() => policy.enqueue(request({ jobId: 'c' }))).toThrow(/capacity/)
  })

  it('bounds per-view cardinality independently', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy({ ...budget, maxJobsPerView: 2 })
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ jobId: 'b' }))
    expect(() => policy.enqueue(request({ jobId: 'c' }))).toThrow(/view projection/)
    expect(() => policy.enqueue(request({ viewId: 'view-2', jobId: 'c' }))).not.toThrow()
  })

  it('rejects duplicate authority', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(() => policy.enqueue(request())).toThrow(/duplicate/)
  })

  it('canonicalizes the Web Mercator 102100 alias', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    const view = policy.enqueue(request({ targetWkid: 102100 }))
    expect(view.targetWkid).toBe(3857)
  })

  it('rejects no-op projections after WKID canonicalization', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ sourceWkid: 3857, targetWkid: 102100 }))).toThrow(/must differ/)
  })

  it('rejects oversized point estimates', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ pointCount: 101 }))).toThrow(/budget/)
  })

  it('rejects oversized byte estimates', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ estimatedBytes: 10_001 }))).toThrow(/budget/)
  })

  it('reconciles estimated work to actual ready residency', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    running(policy)
    const ready = policy.complete('job-1', 1, 40, 4_000, 30)
    expect(ready.phase).toBe('ready')
    expect(ready.actualPoints).toBe(40)
    expect(ready.actualBytes).toBe(4_000)
  })

  it('rejects oversized actual points and releases authority', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    running(policy)
    expect(() => policy.complete('job-1', 1, 101, 1_000, 30)).toThrow(/result budget/)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects oversized actual bytes and releases authority', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    running(policy)
    expect(() => policy.complete('job-1', 1, 20, 10_001, 30)).toThrow(/result budget/)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds aggregate ready point residency', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy({ ...budget, maxReadyPoints: 120 })
    running(policy, { jobId: 'a' })
    policy.complete('a', 1, 80, 1_000, 30)
    running(policy, { jobId: 'b' })
    expect(() => policy.complete('b', 1, 50, 1_000, 40)).toThrow(/residency/)
  })

  it('bounds aggregate ready byte residency', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy({ ...budget, maxReadyBytes: 12_000 })
    running(policy, { jobId: 'a' })
    policy.complete('a', 1, 20, 8_000, 30)
    running(policy, { jobId: 'b' })
    expect(() => policy.complete('b', 1, 20, 5_000, 40)).toThrow(/residency/)
  })

  it('rejects stale completion after revision advance', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    running(policy)
    expect(policy.advanceViewRevision('view-1', 2)).toBe(1)
    expect(() => policy.complete('job-1', 1, 20, 2_000, 30)).toThrow(/not running/)
  })

  it('rejects stale enqueue after revision advance', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    policy.advanceViewRevision('view-1', 3)
    expect(() => policy.enqueue(request({ revision: 2 }))).toThrow(/stale/)
  })

  it('rejects backwards revision movement', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    policy.advanceViewRevision('view-1', 3)
    expect(() => policy.advanceViewRevision('view-1', 2)).toThrow(/backwards/)
  })

  it('expires queued work', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    policy.enqueue(request({ requestedAt: 0 }))
    expect(policy.expire(101)).toBe(1)
  })

  it('expires running work', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    policy.enqueue(request({ requestedAt: 0 }))
    policy.takeNext(10)
    expect(policy.expire(211)).toBe(1)
  })

  it('expires ready residency', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    policy.enqueue(request({ requestedAt: 0 }))
    policy.takeNext(10)
    policy.complete('job-1', 1, 20, 2_000, 20)
    expect(policy.expire(321)).toBe(1)
  })

  it('touch extends only live ready residency', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    running(policy)
    policy.complete('job-1', 1, 20, 2_000, 30)
    expect(policy.touch('job-1', 40)).toBe(true)
    expect(policy.snapshot()[0].expiresAt).toBe(340)
    expect(policy.touch('missing', 40)).toBe(false)
  })

  it('consume transfers ready authority exactly once', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    running(policy)
    policy.complete('job-1', 1, 20, 2_000, 30)
    expect(policy.consume('job-1')?.phase).toBe('ready')
    expect(policy.consume('job-1')).toBeUndefined()
  })

  it('cancel releases queued and running but not ready work', () => {
    const queued = new ArcGisProjectionWorkLifecyclePolicy(budget)
    queued.enqueue(request())
    expect(queued.cancel('job-1')).toBe(true)
    const ready = new ArcGisProjectionWorkLifecyclePolicy(budget)
    running(ready)
    ready.complete('job-1', 1, 20, 2_000, 30)
    expect(ready.cancel('job-1')).toBe(false)
  })

  it('view teardown releases work and revision authority', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ jobId: 'b' }))
    expect(policy.releaseView('view-1')).toBe(2)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('returns frozen scalar snapshots without geometry graphs', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    const view = policy.enqueue(request())
    expect(Object.isFrozen(view)).toBe(true)
    expect(view).not.toHaveProperty('geometry')
    expect(view).not.toHaveProperty('points')
    expect(view).not.toHaveProperty('worker')
    expect(view).not.toHaveProperty('abortController')
  })

  it('fingerprint is deterministic and scalar-only', () => {
    const a = new ArcGisProjectionWorkLifecyclePolicy(budget)
    const b = new ArcGisProjectionWorkLifecyclePolicy(budget)
    a.enqueue(request({ jobId: 'b' })); a.enqueue(request({ jobId: 'a' }))
    b.enqueue(request({ jobId: 'a' })); b.enqueue(request({ jobId: 'b' }))
    expect(a.fingerprint()).toBe(b.fingerprint())
    expect(a.fingerprint()).not.toContain('[object Object]')
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite request time %s', requestedAt => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ requestedAt }))).toThrow(/finite/)
  })

  it.each(['', 'bad id', 'x'.repeat(161)])('rejects malformed job ids', jobId => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ jobId }))).toThrow(/invalid/)
  })

  it.each([0, -1, 1.5, 1_000_000])('rejects invalid WKID %s', targetWkid => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ targetWkid }))).toThrow(/invalid/)
  })

  it('rejects impossible cardinality budgets', () => {
    expect(() => new ArcGisProjectionWorkLifecyclePolicy({ ...budget, maxRunning: 7 })).toThrow(/impossible/)
  })

  it('rejects impossible residency budgets', () => {
    expect(() => new ArcGisProjectionWorkLifecyclePolicy({ ...budget, maxReadyPoints: 99 })).toThrow(/impossible/)
  })

  it('dispose clears authority and fails closed afterwards', () => {
    const policy = new ArcGisProjectionWorkLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.enqueue(request())).toThrow(/disposed/)
  })
})
