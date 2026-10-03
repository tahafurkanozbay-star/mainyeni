import { describe, expect, it } from 'vitest'
import { ArcGisFeatureHydrationLifecyclePolicy, type ArcGisFeatureHydrationBudget, type ArcGisFeatureHydrationRequest } from './ArcGisFeatureHydrationLifecyclePolicy'

const budget: ArcGisFeatureHydrationBudget = { maxJobs: 6, maxJobsPerLayer: 4, maxLoading: 2, maxReady: 3, maxObjectIdsPerJob: 100, maxEstimatedBytesPerJob: 10000, maxAggregateReadyBytes: 20000, queueTtlMs: 100, loadLeaseMs: 200, readyTtlMs: 300 }
const request = (overrides: Partial<ArcGisFeatureHydrationRequest> = {}): ArcGisFeatureHydrationRequest => ({ layerId: 'layer-1', jobId: 'job-1', revision: 1, intent: 'visible', requestedAt: 10, objectIdCount: 20, fieldCount: 5, estimatedBytes: 1000, ...overrides })
const ready = (policy: ArcGisFeatureHydrationLifecyclePolicy, job='job-1', bytes=1000) => { policy.takeNext(20); return policy.complete('layer-1', job, 1, 20, bytes, 30) }

describe('ArcGisFeatureHydrationLifecyclePolicy', () => {
  it('prioritizes interactive, visible and background hydration deterministically', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget)
    p.enqueue(request({jobId:'background', intent:'background', requestedAt:1})); p.enqueue(request({jobId:'visible', intent:'visible', requestedAt:2})); p.enqueue(request({jobId:'interactive', intent:'interactive', requestedAt:3}))
    expect(p.takeNext(20)?.jobId).toBe('interactive'); expect(p.takeNext(21)?.jobId).toBe('visible')
  })
  it('uses request time as deterministic tie break', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); p.enqueue(request({jobId:'later',requestedAt:2})); p.enqueue(request({jobId:'first',requestedAt:1})); expect(p.takeNext(20)?.jobId).toBe('first')
  })
  it('bounds global and per-layer cardinality', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy({...budget,maxJobs:2,maxJobsPerLayer:1,maxLoading:1,maxReady:1})
    expect(p.enqueue(request({jobId:'a'}))).toBe(true); expect(p.enqueue(request({jobId:'b'}))).toBe(false); expect(p.enqueue(request({layerId:'layer-2',jobId:'c'}))).toBe(true); expect(p.enqueue(request({layerId:'layer-3',jobId:'d'}))).toBe(false)
  })
  it('bounds object-id and byte admission', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); expect(p.enqueue(request({objectIdCount:101}))).toBe(false); expect(p.enqueue(request({estimatedBytes:10001}))).toBe(false); expect(p.snapshot()).toHaveLength(0)
  })
  it('bounds concurrent loading', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy({...budget,maxLoading:1}); p.enqueue(request({jobId:'a'})); p.enqueue(request({jobId:'b'})); expect(p.takeNext(20)?.jobId).toBe('a'); expect(p.takeNext(20)).toBeUndefined()
  })
  it('reconciles actual feature and byte residency', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); p.enqueue(request()); expect(ready(p,'job-1',1234)).toBe(true); expect(p.snapshot()[0]).toMatchObject({phase:'ready',featureCount:20,actualBytes:1234,expiresAt:330})
  })
  it('rejects impossible feature counts and oversize responses', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); p.enqueue(request({objectIdCount:5})); p.takeNext(20); expect(p.complete('layer-1','job-1',1,6,100,30)).toBe(false)
    p.enqueue(request({jobId:'bytes'})); p.takeNext(31); expect(p.complete('layer-1','bytes',1,1,10001,32)).toBe(false)
  })
  it('rejects late completion at the lease boundary', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); p.enqueue(request()); p.takeNext(20); expect(p.complete('layer-1','job-1',1,1,100,220)).toBe(false); expect(p.snapshot()).toHaveLength(0)
  })
  it('bounds aggregate ready bytes using actual bytes', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy({...budget,maxAggregateReadyBytes:10000}); p.enqueue(request({jobId:'a'})); p.enqueue(request({jobId:'b'})); p.takeNext(20); p.takeNext(20); expect(p.complete('layer-1','a',1,1,7000,30)).toBe(true); expect(p.complete('layer-1','b',1,1,4000,30)).toBe(false)
  })
  it('bounds ready cardinality', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy({...budget,maxReady:1}); p.enqueue(request({jobId:'a'})); p.enqueue(request({jobId:'b'})); p.takeNext(20); p.takeNext(20); expect(p.complete('layer-1','a',1,1,100,30)).toBe(true); expect(p.complete('layer-1','b',1,1,100,30)).toBe(false)
  })
  it('consumes ready ownership and cancels only matching revisions', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); p.enqueue(request()); ready(p); expect(p.consume('layer-1','job-1',2)).toBe(false); expect(p.consume('layer-1','job-1',1)).toBe(true)
    p.enqueue(request({jobId:'next'})); expect(p.cancel('layer-1','next',2)).toBe(false); expect(p.cancel('layer-1','next',1)).toBe(true)
  })
  it('invalidates stale jobs on monotonic layer revision', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); p.enqueue(request({jobId:'a'})); p.enqueue(request({jobId:'b'})); expect(p.invalidateLayer('layer-1',2)).toBe(2); expect(p.enqueue(request({jobId:'stale',revision:1}))).toBe(false); expect(p.enqueue(request({jobId:'fresh',revision:2}))).toBe(true); expect(p.invalidateLayer('layer-1',1)).toBe(0)
  })
  it('expires queue and ready ownership at exact TTL boundaries', () => {
    const q = new ArcGisFeatureHydrationLifecyclePolicy(budget); q.enqueue(request()); expect(q.expire(109)).toBe(0); expect(q.expire(110)).toBe(1)
    const r = new ArcGisFeatureHydrationLifecyclePolicy(budget); r.enqueue(request()); ready(r); expect(r.expire(329)).toBe(0); expect(r.expire(330)).toBe(1)
  })
  it('releases a layer and its revision watermark', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); p.enqueue(request({revision:3})); expect(p.releaseLayer('layer-1')).toBe(1); expect(p.enqueue(request({jobId:'fresh',revision:1}))).toBe(true)
  })
  it('normalizes identifiers and rejects separator collisions', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); expect(p.enqueue(request({layerId:' layer ',jobId:' job '}))).toBe(true); expect(p.snapshot()[0]).toMatchObject({layerId:'layer',jobId:'job'}); expect(() => p.enqueue(request({jobId:'bad:id'}))).toThrow(/safe characters/)
  })
  it('rejects invalid scalar inputs', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); expect(() => p.enqueue(request({revision:0}))).toThrow(); expect(() => p.enqueue(request({requestedAt:Number.NaN}))).toThrow(); expect(() => p.enqueue(request({fieldCount:0}))).toThrow()
  })
  it('returns detached payload-free snapshots and deterministic fingerprint', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); p.enqueue(request()); const snap=p.snapshot()[0]!; snap.jobId='mutated'; expect(p.snapshot()[0]?.jobId).toBe('job-1'); expect(p.fingerprint()).toContain('layer-1:job-1:1:queued:visible'); const json=JSON.stringify(p.snapshot()); expect(json).not.toContain('geometry'); expect(json).not.toContain('attributes'); expect(json).not.toContain('credential')
  })
  it('validates budget relationships fail closed', () => {
    expect(() => new ArcGisFeatureHydrationLifecyclePolicy({...budget,maxJobsPerLayer:7})).toThrow(RangeError); expect(() => new ArcGisFeatureHydrationLifecyclePolicy({...budget,maxAggregateReadyBytes:9999})).toThrow(RangeError)
  })
  it('fails closed after idempotent disposal', () => {
    const p = new ArcGisFeatureHydrationLifecyclePolicy(budget); p.enqueue(request()); p.dispose(); p.dispose(); expect(() => p.snapshot()).toThrow(/disposed/); expect(() => p.enqueue(request())).toThrow(/disposed/)
  })
})
