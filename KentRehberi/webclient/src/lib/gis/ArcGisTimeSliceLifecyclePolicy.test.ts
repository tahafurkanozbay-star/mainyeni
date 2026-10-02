import { describe, expect, it } from 'vitest'
import { ArcGisTimeSliceLifecyclePolicy, type ArcGisTimeSliceBudget, type ArcGisTimeSliceRequest } from './ArcGisTimeSliceLifecyclePolicy'

const budget: ArcGisTimeSliceBudget = { maxSlices: 6, maxSlicesPerView: 3, maxLoading: 2, maxResident: 3, maxFeaturesPerSlice: 100, maxBytesPerSlice: 1000, maxAggregateResidentBytes: 1500, queueTtlMs: 10, loadLeaseMs: 20, residentTtlMs: 30 }
const request = (overrides: Partial<ArcGisTimeSliceRequest> = {}): ArcGisTimeSliceRequest => ({ viewId: 'v', layerId: 'l', sliceId: 's', revision: 1, intent: 'visible', requestedAt: 100, estimatedFeatures: 10, estimatedBytes: 100, timeStart: 0, timeEnd: 10, ...overrides })

describe('ArcGisTimeSliceLifecyclePolicy', () => {
  it('schedules interactive work before visible and prefetch work', () => {
    const policy = new ArcGisTimeSliceLifecyclePolicy(budget)
    expect(policy.enqueue(request({ sliceId: 'p', intent: 'prefetch' }))).toBe(true)
    expect(policy.enqueue(request({ sliceId: 'v', intent: 'visible' }))).toBe(true)
    expect(policy.enqueue(request({ sliceId: 'i', intent: 'interactive' }))).toBe(true)
    expect(policy.takeNext(101)?.sliceId).toBe('i')
    expect(policy.takeNext(101)?.sliceId).toBe('v')
  })

  it('rejects invalid temporal and per-slice budgets', () => {
    const policy = new ArcGisTimeSliceLifecyclePolicy(budget)
    expect(policy.enqueue(request({ timeStart: 20, timeEnd: 10 }))).toBe(false)
    expect(policy.enqueue(request({ estimatedFeatures: 101 }))).toBe(false)
    expect(policy.enqueue(request({ estimatedBytes: 1001 }))).toBe(false)
  })

  it('bounds per-view cardinality', () => {
    const policy = new ArcGisTimeSliceLifecyclePolicy(budget)
    expect(policy.enqueue(request({ sliceId: '1' }))).toBe(true)
    expect(policy.enqueue(request({ sliceId: '2' }))).toBe(true)
    expect(policy.enqueue(request({ sliceId: '3' }))).toBe(true)
    expect(policy.enqueue(request({ sliceId: '4' }))).toBe(false)
  })

  it('rejects stale revisions and invalidates older work', () => {
    const policy = new ArcGisTimeSliceLifecyclePolicy(budget)
    expect(policy.enqueue(request())).toBe(true)
    expect(policy.invalidateView('v', 2)).toBe(1)
    expect(policy.enqueue(request({ sliceId: 'old', revision: 1 }))).toBe(false)
    expect(policy.enqueue(request({ sliceId: 'new', revision: 2 }))).toBe(true)
  })

  it('reconciles actual resident resources', () => {
    const policy = new ArcGisTimeSliceLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(policy.takeNext(101)?.phase).toBe('loading')
    expect(policy.complete('v', 'l', 's', 1, 20, 500, 102)).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({ phase: 'resident', features: 20, bytes: 500 })
  })

  it('rejects oversized completion and releases the failed entry', () => {
    const policy = new ArcGisTimeSliceLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(101)
    expect(policy.complete('v', 'l', 's', 1, 101, 500, 102)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('enforces aggregate resident bytes', () => {
    const policy = new ArcGisTimeSliceLifecyclePolicy(budget)
    policy.enqueue(request({ sliceId: 'a' })); policy.enqueue(request({ sliceId: 'b' }))
    policy.takeNext(101); policy.takeNext(101)
    expect(policy.complete('v', 'l', 'a', 1, 10, 900, 102)).toBe(true)
    expect(policy.complete('v', 'l', 'b', 1, 10, 700, 102)).toBe(false)
  })

  it('expires queue, load and resident leases', () => {
    const queued = new ArcGisTimeSliceLifecyclePolicy(budget); queued.enqueue(request()); expect(queued.expire(110)).toBe(1)
    const loading = new ArcGisTimeSliceLifecyclePolicy(budget); loading.enqueue(request()); loading.takeNext(101); expect(loading.expire(121)).toBe(1)
    const resident = new ArcGisTimeSliceLifecyclePolicy(budget); resident.enqueue(request()); resident.takeNext(101); resident.complete('v','l','s',1,10,100,102); expect(resident.expire(132)).toBe(1)
  })

  it('touch extends only matching resident slices', () => {
    const policy = new ArcGisTimeSliceLifecyclePolicy(budget); policy.enqueue(request()); policy.takeNext(101); policy.complete('v','l','s',1,10,100,102)
    expect(policy.touch('v','l','s',1,120)).toBe(true); expect(policy.expire(149)).toBe(0); expect(policy.expire(150)).toBe(1)
  })

  it('releaseView deterministically clears view ownership', () => {
    const policy = new ArcGisTimeSliceLifecyclePolicy(budget); policy.enqueue(request({ sliceId: 'a' })); policy.enqueue(request({ sliceId: 'b' }))
    expect(policy.releaseView('v')).toBe(2); expect(policy.snapshot()).toEqual([])
  })

  it('has a deterministic payload-free fingerprint', () => {
    const policy = new ArcGisTimeSliceLifecyclePolicy(budget); policy.enqueue(request())
    expect(policy.fingerprint()).toBe('v:l:s:1:queued:0:0')
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisTimeSliceLifecyclePolicy(budget); policy.enqueue(request()); policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/); expect(() => policy.enqueue(request())).toThrow(/disposed/)
  })
})
