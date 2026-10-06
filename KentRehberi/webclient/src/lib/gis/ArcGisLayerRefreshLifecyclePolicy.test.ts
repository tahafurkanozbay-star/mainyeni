import { describe, expect, it } from 'vitest'
import { ArcGisLayerRefreshLifecyclePolicy, type LayerRefreshBudget } from './ArcGisLayerRefreshLifecyclePolicy'

const budget: LayerRefreshBudget = {
  maxLayers: 3,
  maxJobs: 5,
  maxJobsPerLayer: 3,
  maxRunning: 2,
  maxRunningPerLayer: 1,
  maxResident: 2,
  maxResidentBytes: 100,
  maxBytesPerJob: 60,
  queueTtlMs: 100,
  leaseMs: 50,
  residentTtlMs: 200,
}

function ready(): ArcGisLayerRefreshLifecyclePolicy {
  const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
  expect(policy.setRevision('roads', 1)).toBe(0)
  expect(policy.setRevision('buildings', 1)).toBe(0)
  return policy
}

function request(jobId: string, layerId: string, intent: 'interactive'|'visible'|'background', requestedAt: number, estimatedBytes = 40) {
  return { jobId, layerId, revision: 1, intent, estimatedBytes, requestedAt }
}

describe('ArcGisLayerRefreshLifecyclePolicy', () => {
  it('uses deterministic intent priority and per-layer concurrency', () => {
    const policy = ready()
    expect(policy.admit(request('roads-bg','roads','background',10))).toBe(true)
    expect(policy.admit(request('roads-ui','roads','interactive',20))).toBe(true)
    expect(policy.admit(request('buildings-visible','buildings','visible',30))).toBe(true)
    expect(policy.startNext(31)?.jobId).toBe('roads-ui')
    expect(policy.startNext(32)?.jobId).toBe('buildings-visible')
    expect(policy.startNext(33)).toBeNull()
    expect(policy.snapshot()).toEqual({ layers:2,jobs:3,queued:1,running:2,resident:0,residentBytes:0 })
  })

  it('invalidates stale revisions across every lifecycle phase', () => {
    const policy = ready()
    expect(policy.admit(request('roads-a','roads','interactive',10))).toBe(true)
    expect(policy.startNext(11)?.jobId).toBe('roads-a')
    expect(policy.setRevision('roads',2)).toBe(1)
    expect(policy.renew('roads-a',1,12)).toBe(false)
    expect(policy.complete('roads-a',1,20,13)).toBeNull()
    expect(policy.admit(request('roads-stale','roads','visible',14))).toBe(false)
    expect(policy.snapshot().jobs).toBe(0)
  })

  it('expires queue and running leases at the exact boundary', () => {
    const policy = ready()
    expect(policy.admit(request('queued','roads','visible',10))).toBe(true)
    expect(policy.expire(109)).toBe(0)
    expect(policy.expire(110)).toBe(1)
    expect(policy.admit(request('running','roads','interactive',200))).toBe(true)
    expect(policy.startNext(201)?.jobId).toBe('running')
    expect(policy.renew('running',1,250)).toBe(false)
    expect(policy.snapshot().jobs).toBe(0)
  })

  it('renews live leases without changing scheduling identity', () => {
    const policy = ready()
    expect(policy.admit(request('roads-a','roads','interactive',10))).toBe(true)
    const running=policy.startNext(11)
    expect(running?.sequence).toBe(1)
    expect(policy.renew('roads-a',1,40)).toBe(true)
    expect(policy.snapshot().running).toBe(1)
    expect(policy.complete('roads-a',1,30,89)?.sequence).toBe(1)
  })

  it('reconciles actual bytes and evicts lower intent residents first', () => {
    const policy = ready()
    expect(policy.admit(request('roads-bg','roads','background',10,50))).toBe(true)
    expect(policy.startNext(11)?.jobId).toBe('roads-bg')
    expect(policy.complete('roads-bg',1,50,12)?.residentBytes).toBe(50)
    expect(policy.admit(request('buildings-ui','buildings','interactive',20,60))).toBe(true)
    expect(policy.startNext(21)?.jobId).toBe('buildings-ui')
    expect(policy.complete('buildings-ui',1,60,22)?.residentBytes).toBe(60)
    expect(policy.get('roads-bg',1,23)).toBeNull()
    expect(policy.get('buildings-ui',1,23)?.residentBytes).toBe(60)
    expect(policy.snapshot().residentBytes).toBe(60)
  })

  it('does not evict higher intent residency for lower intent work', () => {
    const policy = ready()
    expect(policy.admit(request('roads-ui','roads','interactive',10,60))).toBe(true)
    expect(policy.startNext(11)?.jobId).toBe('roads-ui')
    expect(policy.complete('roads-ui',1,60,12)).not.toBeNull()
    expect(policy.admit(request('buildings-bg','buildings','background',20,60))).toBe(true)
    expect(policy.startNext(21)?.jobId).toBe('buildings-bg')
    expect(policy.complete('buildings-bg',1,60,22)).toBeNull()
    expect(policy.get('roads-ui',1,23)).not.toBeNull()
  })

  it('rejects oversized estimates and drops oversized actual responses', () => {
    const policy = ready()
    expect(policy.admit(request('too-large','roads','interactive',10,61))).toBe(false)
    expect(policy.admit(request('estimated-ok','roads','interactive',11,50))).toBe(true)
    expect(policy.startNext(12)?.jobId).toBe('estimated-ok')
    expect(policy.complete('estimated-ok',1,61,13)).toBeNull()
    expect(policy.snapshot().jobs).toBe(0)
  })

  it('touches resident ttl and consumes atomically', () => {
    const policy = ready()
    expect(policy.admit(request('roads-a','roads','visible',10))).toBe(true)
    expect(policy.startNext(11)?.jobId).toBe('roads-a')
    expect(policy.complete('roads-a',1,30,12)).not.toBeNull()
    expect(policy.touch('roads-a',1,100)).toBe(true)
    expect(policy.get('roads-a',1,299)).not.toBeNull()
    expect(policy.consume('roads-a',1,299)?.jobId).toBe('roads-a')
    expect(policy.get('roads-a',1,299)).toBeNull()
  })

  it('releases one layer without disturbing another layer authority', () => {
    const policy = ready()
    expect(policy.admit(request('roads-a','roads','visible',10))).toBe(true)
    expect(policy.admit(request('buildings-a','buildings','visible',11))).toBe(true)
    expect(policy.releaseLayer('roads')).toBe(1)
    expect(policy.snapshot()).toEqual({ layers:1,jobs:1,queued:1,running:0,resident:0,residentBytes:0 })
    expect(policy.admit(request('roads-stale','roads','visible',12))).toBe(false)
  })

  it('bounds layer and job cardinality without retaining payload objects', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy({ ...budget,maxLayers:1,maxJobs:2,maxJobsPerLayer:2 })
    expect(policy.setRevision('roads',1)).toBe(0)
    expect(policy.setRevision('buildings',1)).toBe(-1)
    expect(policy.admit(request('a','roads','visible',10))).toBe(true)
    expect(policy.admit(request('b','roads','visible',11))).toBe(true)
    expect(policy.admit(request('c','roads','interactive',12))).toBe(false)
    expect(Object.keys(policy.snapshot()).sort()).toEqual(['jobs','layers','queued','resident','residentBytes','running'])
  })

  it('returns frozen scalar views and deterministic fingerprints', () => {
    const policy = ready()
    expect(policy.admit(request('b','roads','visible',20))).toBe(true)
    expect(policy.admit(request('a','buildings','interactive',10))).toBe(true)
    const view=policy.startNext(21)
    expect(Object.isFrozen(view)).toBe(true)
    expect(policy.fingerprint()).toContain('buildings:a:1:interactive:running:0')
    expect(policy.fingerprint()).toContain('roads:b:1:visible:queued:0')
  })

  it('fails closed for unsafe identifiers and invalid clocks', () => {
    const policy = ready()
    expect(() => policy.setRevision('bad\nlayer',2)).toThrow('invalid')
    expect(() => policy.admit(request('x','roads','visible',Number.NaN))).toThrow('finite')
    expect(() => policy.admit({ ...request('x','roads','visible',10),estimatedBytes:0 })).toThrow('positive')
  })

  it('validates parent budgets before accepting work', () => {
    expect(() => new ArcGisLayerRefreshLifecyclePolicy({ ...budget,maxJobs:1,maxJobsPerLayer:2 })).toThrow('maxJobsPerLayer')
    expect(() => new ArcGisLayerRefreshLifecyclePolicy({ ...budget,maxRunning:1,maxRunningPerLayer:2 })).toThrow('maxRunningPerLayer')
    expect(() => new ArcGisLayerRefreshLifecyclePolicy({ ...budget,maxResidentBytes:10 })).toThrow('fit one')
  })

  it('disposes idempotently and makes observation terminal', () => {
    const policy = ready()
    expect(policy.admit(request('roads-a','roads','visible',10))).toBe(true)
    policy.dispose()
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.fingerprint()).toThrow('disposed')
    expect(() => policy.cancel('roads-a')).toThrow('disposed')
  })
})
