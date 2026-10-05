import { describe, expect, it } from 'vitest'
import { ArcGisGeometryProjectionLifecyclePolicy, type ProjectionBudget } from '../ArcGisGeometryProjectionLifecyclePolicy'

const budget: ProjectionBudget = {
  maxSpatialReferences: 3,
  maxJobs: 6,
  maxJobsPerSpatialReference: 4,
  maxRunning: 2,
  maxRunningPerSpatialReference: 1,
  maxResident: 2,
  maxResidentVertices: 20,
  maxResidentBytes: 200,
  maxVerticesPerJob: 10,
  maxBytesPerJob: 100,
  queueTtlMs: 20,
  leaseMs: 30,
  residentTtlMs: 40,
}
const request = (jobId:string, intent:'interactive'|'visible'|'background'='visible', requestedAt=0, sourceWkid=4326, targetWkid=3857) => ({ jobId, sourceWkid, targetWkid, revision:1, intent, vertices:5, estimatedBytes:50, requestedAt })

describe('ArcGisGeometryProjectionLifecyclePolicy', () => {
  it('prioritizes interactive work while preserving FIFO within an intent', () => {
    const p=new ArcGisGeometryProjectionLifecyclePolicy(budget); p.setRevision(4326,3857,1)
    expect(p.admit(request('visible-a','visible',1))).toBe(true)
    expect(p.admit(request('interactive-a','interactive',2))).toBe(true)
    expect(p.admit(request('interactive-b','interactive',3))).toBe(true)
    expect(p.startNext(4)?.jobId).toBe('interactive-a')
    expect(p.startNext(4)).toBeNull()
    expect(p.complete('interactive-a',1,45,5)?.phase).toBe('resident')
    expect(p.startNext(6)?.jobId).toBe('interactive-b')
  })

  it('enforces global and pair concurrency independently', () => {
    const p=new ArcGisGeometryProjectionLifecyclePolicy(budget); p.setRevision(4326,3857,1); p.setRevision(25830,3857,1)
    p.admit(request('a')); p.admit(request('b')); p.admit(request('c','visible',0,25830,3857))
    expect(p.startNext(1)?.jobId).toBe('a')
    expect(p.startNext(1)?.jobId).toBe('c')
    expect(p.startNext(1)).toBeNull()
  })

  it('invalidates stale revision work without accepting rollback', () => {
    const p=new ArcGisGeometryProjectionLifecyclePolicy(budget); expect(p.setRevision(4326,3857,1)).toBe(0); p.admit(request('a'))
    expect(p.setRevision(4326,3857,2)).toBe(1)
    expect(p.snapshot().jobs).toBe(0)
    expect(p.setRevision(4326,3857,1)).toBe(-1)
    expect(p.admit(request('stale'))).toBe(false)
  })

  it('expires queued, running and resident jobs using phase-specific deadlines', () => {
    const p=new ArcGisGeometryProjectionLifecyclePolicy(budget); p.setRevision(4326,3857,1); p.admit(request('queued'))
    expect(p.expire(20)).toBe(1)
    p.admit(request('running','visible',21)); p.startNext(22)
    expect(p.expire(51)).toBe(0); expect(p.expire(52)).toBe(1)
    p.admit(request('resident','visible',53)); p.startNext(54); p.complete('resident',1,50,55)
    expect(p.expire(94)).toBe(0); expect(p.expire(95)).toBe(1)
  })

  it('reconciles actual resident bytes and rejects oversized completion', () => {
    const p=new ArcGisGeometryProjectionLifecyclePolicy(budget); p.setRevision(4326,3857,1); p.admit(request('a')); p.startNext(1)
    expect(p.complete('a',1,101,2)).toBeNull(); expect(p.snapshot().jobs).toBe(0)
    p.admit(request('b')); p.startNext(3); expect(p.complete('b',1,90,4)?.residentBytes).toBe(90)
    expect(p.snapshot().residentBytes).toBe(90)
  })

  it('evicts lower intent residents deterministically under pressure', () => {
    const tight={...budget,maxResident:1,maxResidentVertices:10,maxResidentBytes:100}
    const p=new ArcGisGeometryProjectionLifecyclePolicy(tight); p.setRevision(4326,3857,1)
    p.admit(request('background','background')); p.startNext(1); p.complete('background',1,50,2)
    p.admit(request('interactive','interactive',3)); p.startNext(4); expect(p.complete('interactive',1,50,5)?.jobId).toBe('interactive')
    expect(p.consume('background',1)).toBeNull(); expect(p.consume('interactive',1)?.jobId).toBe('interactive')
  })

  it('does not evict higher intent resident for lower intent incoming work', () => {
    const tight={...budget,maxResident:1,maxResidentVertices:10,maxResidentBytes:100}
    const p=new ArcGisGeometryProjectionLifecyclePolicy(tight); p.setRevision(4326,3857,1)
    p.admit(request('interactive','interactive')); p.startNext(1); p.complete('interactive',1,50,2)
    p.admit(request('background','background',3)); p.startNext(4); expect(p.complete('background',1,50,5)).toBeNull()
    expect(p.consume('interactive',1)?.jobId).toBe('interactive')
  })

  it('caps jobs and per-pair admission before allocating payload authority', () => {
    const p=new ArcGisGeometryProjectionLifecyclePolicy({...budget,maxJobs:4,maxJobsPerSpatialReference:2}); p.setRevision(4326,3857,1); p.setRevision(25830,3857,1)
    expect(p.admit(request('a'))).toBe(true); expect(p.admit(request('b'))).toBe(true); expect(p.admit(request('pair-overflow'))).toBe(false)
    expect(p.admit(request('c','visible',0,25830,3857))).toBe(true); expect(p.admit(request('d','visible',0,25830,3857))).toBe(true)
    expect(p.snapshot().jobs).toBe(4)
  })

  it('rejects invalid identifiers, wkids and scalar budgets', () => {
    expect(()=>new ArcGisGeometryProjectionLifecyclePolicy({...budget,maxJobs:0})).toThrow()
    const p=new ArcGisGeometryProjectionLifecyclePolicy(budget); expect(()=>p.setRevision(0,3857,1)).toThrow(); p.setRevision(4326,3857,1)
    expect(()=>p.admit({...request('x'),jobId:'\u0000bad'})).toThrow()
    expect(()=>p.admit({...request('x'),vertices:Number.NaN})).toThrow()
  })

  it('renews running leases and consumes resident entries exactly once', () => {
    const p=new ArcGisGeometryProjectionLifecyclePolicy(budget); p.setRevision(4326,3857,1); p.admit(request('a')); p.startNext(1)
    expect(p.renew('a',1,10)).toBe(true); expect(p.expire(39)).toBe(0); expect(p.complete('a',1,50,40)).not.toBeNull()
    expect(p.consume('a',1)?.jobId).toBe('a'); expect(p.consume('a',1)).toBeNull()
  })

  it('releases pair authority and provides deterministic payload-free snapshots', () => {
    const p=new ArcGisGeometryProjectionLifecyclePolicy(budget); p.setRevision(4326,3857,1); p.admit(request('a','visible',1)); p.admit(request('b','background',2))
    expect(p.fingerprint()).toContain('4326>3857:a:1:visible:queued')
    const snapshot=p.snapshot(); expect(Object.isFrozen(snapshot)).toBe(true); expect(snapshot).toEqual({spatialReferences:1,jobs:2,queued:2,running:0,resident:0,residentVertices:0,residentBytes:0})
    expect(p.release(4326,3857)).toBe(2); expect(p.snapshot().spatialReferences).toBe(0)
  })

  it('disposes idempotently and rejects post-disposal mutation', () => {
    const p=new ArcGisGeometryProjectionLifecyclePolicy(budget); p.setRevision(4326,3857,1); p.dispose(); p.dispose()
    expect(()=>p.snapshot()).toThrow('disposed'); expect(()=>p.admit(request('a'))).toThrow('disposed')
  })
})
