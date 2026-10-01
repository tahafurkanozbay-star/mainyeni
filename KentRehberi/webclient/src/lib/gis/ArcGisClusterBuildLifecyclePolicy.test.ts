import { describe, expect, it } from 'vitest'
import { ArcGisClusterBuildLifecyclePolicy, type ArcGisClusterBuildBudget, type ArcGisClusterBuildRequest } from './ArcGisClusterBuildLifecyclePolicy'

const budget: ArcGisClusterBuildBudget = {
  maxJobs: 6,
  maxJobsPerView: 4,
  maxBuilding: 2,
  maxReady: 3,
  maxFeaturesPerJob: 1000,
  maxClustersPerJob: 500,
  maxBytesPerJob: 10000,
  maxAggregateReadyClusters: 1000,
  maxAggregateReadyBytes: 20000,
  queueTtlMs: 100,
  buildLeaseMs: 200,
  readyTtlMs: 300,
}

function request(overrides: Partial<ArcGisClusterBuildRequest> = {}): ArcGisClusterBuildRequest {
  return {
    viewId: 'view-1', layerId: 'layer-1', jobId: 'job-1', revision: 1, intent: 'visible', requestedAt: 10,
    wkid: 3857, zoomBucket: 12, featureCount: 100, estimatedBytes: 1000, ...overrides,
  }
}

function ready(policy: ArcGisClusterBuildLifecyclePolicy, jobId = 'job-1', clusters = 20, bytes = 1000): boolean {
  policy.takeNext(20)
  return policy.complete('view-1', 'layer-1', jobId, 1, clusters, bytes, 30)
}

describe('ArcGisClusterBuildLifecyclePolicy', () => {
  it('prioritizes interactive, visible, then background cluster builds', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'background', intent: 'background', requestedAt: 1 }))
    policy.enqueue(request({ jobId: 'visible', intent: 'visible', requestedAt: 2 }))
    policy.enqueue(request({ jobId: 'interactive', intent: 'interactive', requestedAt: 3 }))
    expect(policy.takeNext(20)?.jobId).toBe('interactive')
    expect(policy.takeNext(21)?.jobId).toBe('visible')
  })

  it('prefers the finer zoom bucket within equal intent', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'coarse', zoomBucket: 8 }))
    policy.enqueue(request({ jobId: 'fine', zoomBucket: 14 }))
    expect(policy.takeNext(20)?.jobId).toBe('fine')
  })

  it('uses request time and sequence as deterministic final tie breaks', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'later', requestedAt: 6 }))
    policy.enqueue(request({ jobId: 'first', requestedAt: 5 }))
    policy.enqueue(request({ jobId: 'second', requestedAt: 5 }))
    expect(policy.takeNext(20)?.jobId).toBe('first')
    expect(policy.takeNext(20)?.jobId).toBe('second')
  })

  it('bounds global and per-view cardinality', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy({ ...budget, maxJobs: 2, maxJobsPerView: 1, maxBuilding: 1, maxReady: 1 })
    expect(policy.enqueue(request({ jobId: 'a' }))).toBe(true)
    expect(policy.enqueue(request({ jobId: 'b' }))).toBe(false)
    expect(policy.enqueue(request({ viewId: 'view-2', jobId: 'c' }))).toBe(true)
    expect(policy.enqueue(request({ viewId: 'view-3', jobId: 'd' }))).toBe(false)
  })

  it('bounds feature and estimated byte work admission', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    expect(policy.enqueue(request({ featureCount: 1001 }))).toBe(false)
    expect(policy.enqueue(request({ estimatedBytes: 10001 }))).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds concurrent building work', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy({ ...budget, maxBuilding: 1 })
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ jobId: 'b' }))
    expect(policy.takeNext(20)?.jobId).toBe('a')
    expect(policy.takeNext(20)).toBeUndefined()
  })

  it('accepts matching completion and records actual residency', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(ready(policy, 'job-1', 25, 1234)).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({ phase: 'ready', clusterCount: 25, bytes: 1234, expiresAt: 330 })
  })

  it('rejects cluster counts larger than source feature count', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request({ featureCount: 10 }))
    policy.takeNext(20)
    expect(policy.complete('view-1', 'layer-1', 'job-1', 1, 11, 100, 30)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects completion beyond per-job cluster and byte budgets', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request({ featureCount: 600 }))
    policy.takeNext(20)
    expect(policy.complete('view-1', 'layer-1', 'job-1', 1, 501, 100, 30)).toBe(false)
    policy.enqueue(request({ jobId: 'bytes' }))
    policy.takeNext(31)
    expect(policy.complete('view-1', 'layer-1', 'bytes', 1, 10, 10001, 32)).toBe(false)
  })

  it('rejects late completion after the build lease', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.takeNext(20)
    expect(policy.complete('view-1', 'layer-1', 'job-1', 1, 20, 100, 220)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds aggregate ready cluster residency', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy({ ...budget, maxAggregateReadyClusters: 500 })
    policy.enqueue(request({ jobId: 'a', featureCount: 300 }))
    policy.enqueue(request({ jobId: 'b', featureCount: 300 }))
    policy.takeNext(20)
    policy.takeNext(20)
    expect(policy.complete('view-1', 'layer-1', 'a', 1, 300, 100, 30)).toBe(true)
    expect(policy.complete('view-1', 'layer-1', 'b', 1, 300, 100, 30)).toBe(false)
  })

  it('bounds aggregate ready byte residency using actual bytes', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy({ ...budget, maxAggregateReadyBytes: 10000 })
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ jobId: 'b' }))
    policy.takeNext(20)
    policy.takeNext(20)
    expect(policy.complete('view-1', 'layer-1', 'a', 1, 20, 7000, 30)).toBe(true)
    expect(policy.complete('view-1', 'layer-1', 'b', 1, 20, 4000, 30)).toBe(false)
  })

  it('bounds ready cardinality', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy({ ...budget, maxReady: 1 })
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ jobId: 'b' }))
    policy.takeNext(20)
    policy.takeNext(20)
    expect(policy.complete('view-1', 'layer-1', 'a', 1, 20, 100, 30)).toBe(true)
    expect(policy.complete('view-1', 'layer-1', 'b', 1, 20, 100, 30)).toBe(false)
  })

  it('consumes ready ownership and releases residency capacity', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request())
    ready(policy)
    expect(policy.consume('view-1', 'layer-1', 'job-1', 2)).toBe(false)
    expect(policy.consume('view-1', 'layer-1', 'job-1', 1)).toBe(true)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('cancels only matching revision ownership', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(policy.cancel('view-1', 'layer-1', 'job-1', 2)).toBe(false)
    expect(policy.cancel('view-1', 'layer-1', 'job-1', 1)).toBe(true)
  })

  it('rejects stale revisions and replaces an older duplicate', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    expect(policy.enqueue(request({ revision: 2 }))).toBe(true)
    expect(policy.enqueue(request({ revision: 1 }))).toBe(false)
    expect(policy.enqueue(request({ revision: 3 }))).toBe(true)
    expect(policy.snapshot()).toHaveLength(1)
    expect(policy.snapshot()[0]?.revision).toBe(3)
  })

  it('invalidates stale work when a view revision advances', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ jobId: 'b' }))
    policy.takeNext(20)
    expect(policy.invalidateView('view-1', 2)).toBe(2)
    expect(policy.enqueue(request({ jobId: 'stale', revision: 1 }))).toBe(false)
    expect(policy.enqueue(request({ jobId: 'fresh', revision: 2 }))).toBe(true)
  })

  it('does not regress a view revision watermark', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request({ revision: 3 }))
    expect(policy.invalidateView('view-1', 2)).toBe(0)
    expect(policy.enqueue(request({ jobId: 'old', revision: 2 }))).toBe(false)
  })

  it('expires queued work exactly at its TTL boundary', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request({ requestedAt: 10 }))
    expect(policy.expire(109)).toBe(0)
    expect(policy.expire(110)).toBe(1)
  })

  it('expires ready work and releases aggregate residency', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request())
    ready(policy)
    expect(policy.expire(329)).toBe(0)
    expect(policy.expire(330)).toBe(1)
  })

  it('releases one layer without disturbing another layer', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ layerId: 'layer-2', jobId: 'b' }))
    expect(policy.releaseLayer('view-1', 'layer-1')).toBe(1)
    expect(policy.snapshot().map(job => job.jobId)).toEqual(['b'])
  })

  it('releases a destroyed view and its revision watermark', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request({ revision: 3 }))
    expect(policy.releaseView('view-1')).toBe(1)
    expect(policy.enqueue(request({ jobId: 'fresh', revision: 1 }))).toBe(true)
  })

  it('normalizes identifiers without retaining caller whitespace', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    expect(policy.enqueue(request({ viewId: ' view ', layerId: ' layer ', jobId: ' job ' }))).toBe(true)
    expect(policy.snapshot()[0]).toMatchObject({ viewId: 'view', layerId: 'layer', jobId: 'job' })
  })

  it('rejects identifiers that can collide with fingerprint or key separators', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ jobId: 'bad\u0000id' }))).toThrow(/safe characters/)
    expect(() => policy.enqueue(request({ layerId: 'bad:id' }))).toThrow(/safe characters/)
  })

  it('validates WKID, zoom bucket, revision, counts, and timestamps', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ wkid: 0 }))).toThrow(/wkid/)
    expect(() => policy.enqueue(request({ zoomBucket: -1 }))).toThrow(/zoomBucket/)
    expect(() => policy.enqueue(request({ revision: 0 }))).toThrow(/revision/)
    expect(() => policy.enqueue(request({ featureCount: 0 }))).toThrow(/featureCount/)
    expect(() => policy.enqueue(request({ requestedAt: Number.NaN }))).toThrow(/requestedAt/)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('produces a deterministic payload-free fingerprint', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request({ jobId: 'a' }))
    policy.enqueue(request({ jobId: 'b' }))
    expect(policy.fingerprint()).toBe('view-1:layer-1:a:1:queued:12:0:0|view-1:layer-1:b:1:queued:12:0:0')
    const serialized = JSON.stringify(policy.snapshot())
    expect(serialized).not.toContain('geometry')
    expect(serialized).not.toContain('attributes')
    expect(serialized).not.toContain('graphic')
  })

  it('rejects invalid budget relationships', () => {
    expect(() => new ArcGisClusterBuildLifecyclePolicy({ ...budget, maxJobsPerView: 7 })).toThrow(/cannot exceed/)
    expect(() => new ArcGisClusterBuildLifecyclePolicy({ ...budget, maxBuilding: 7 })).toThrow(/cannot exceed/)
    expect(() => new ArcGisClusterBuildLifecyclePolicy({ ...budget, maxClustersPerJob: 1001 })).toThrow(/cannot exceed/)
    expect(() => new ArcGisClusterBuildLifecyclePolicy({ ...budget, maxAggregateReadyClusters: 499 })).toThrow(/admit one maximum job/)
    expect(() => new ArcGisClusterBuildLifecyclePolicy({ ...budget, maxAggregateReadyBytes: 9999 })).toThrow(/admit one maximum job/)
  })

  it('fails closed after disposal and disposal is idempotent', () => {
    const policy = new ArcGisClusterBuildLifecyclePolicy(budget)
    policy.enqueue(request())
    policy.dispose()
    policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.enqueue(request())).toThrow(/disposed/)
    expect(() => policy.takeNext(20)).toThrow(/disposed/)
  })
})
