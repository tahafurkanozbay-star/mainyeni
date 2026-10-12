import { describe, expect, it } from 'vitest'
import {
  ArcGisGeometryProjectionLifecyclePolicy,
  type ProjectionBudget,
} from '../ArcGisGeometryProjectionLifecyclePolicy'

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

const request = (jobId: string, requestedAt = 0) => ({
  jobId, sourceWkid: 4326, targetWkid: 3857, revision: 1,
  intent: 'visible' as const, vertices: 5, estimatedBytes: 50, requestedAt,
})

const create = () => {
  const policy = new ArcGisGeometryProjectionLifecyclePolicy(budget)
  policy.setRevision(4326, 3857, 1)
  return policy
}

describe('ArcGIS projection lifecycle time and identity integrity', () => {
  it('rejects control characters at identifier boundaries before normalization', () => {
    const policy = create()
    for (const jobId of ['\nvalid', 'valid\r', '\tvalid', 'valid\u007f']) {
      expect(() => policy.admit(request(jobId))).toThrow('invalid')
    }
    expect(policy.snapshot().jobs).toBe(0)
    expect(policy.admit(request(' valid '))).toBe(true)
    expect(policy.admit(request('valid'))).toBe(false)
    expect(policy.snapshot().jobs).toBe(1)
  })

  it('never starts a future-dated job ahead of eligible work', () => {
    const policy = create()
    expect(policy.admit({ ...request('future', 100), intent: 'interactive' })).toBe(true)
    expect(policy.admit({ ...request('ready', 1), intent: 'background' })).toBe(true)
    expect(policy.startNext(2)?.jobId).toBe('ready')
    expect(policy.startNext(3)).toBeNull()
    expect(policy.complete('ready', 1, 50, 4)?.phase).toBe('resident')
    expect(policy.startNext(99)).toBeNull()
    expect(policy.startNext(100)?.jobId).toBe('future')
  })

  it('does not roll back a running lease when renewal time predates start', () => {
    const policy = create()
    policy.admit(request('a', 2))
    const started = policy.startNext(5)
    expect(started?.expiresAt).toBe(35)
    expect(policy.renew('a', 1, 4)).toBe(false)
    expect(policy.snapshot().running).toBe(1)
    expect(policy.renew('a', 1, 8)).toBe(true)
    expect(policy.expire(35)).toBe(0)
    expect(policy.expire(38)).toBe(1)
  })

  it('rejects pre-start completion without converting the running lease', () => {
    const policy = create()
    policy.admit(request('a', 2))
    expect(policy.startNext(5)?.phase).toBe('running')
    expect(policy.complete('a', 1, 50, 4)).toBeNull()
    expect(policy.snapshot()).toMatchObject({ running: 1, resident: 0 })
    expect(policy.complete('a', 1, 50, 6)).toMatchObject({
      phase: 'resident', touchedAt: 6, expiresAt: 46,
    })
    expect(policy.snapshot()).toMatchObject({ running: 0, resident: 1 })
  })

  it('keeps earlier residents safe from invalid completion time rollback', () => {
    const policy = create()
    policy.admit(request('resident', 0))
    policy.startNext(1)
    policy.complete('resident', 1, 50, 2)
    policy.admit(request('running', 3))
    policy.startNext(4)
    expect(policy.complete('running', 1, 50, 1)).toBeNull()
    expect(policy.snapshot()).toMatchObject({
      running: 1, resident: 1, residentBytes: 50,
    })
    expect(policy.consume('resident', 1)?.jobId).toBe('resident')
  })

  it('rejects an unrepresentable queue deadline without admitting partial state', () => {
    const policy = create()
    expect(() => policy.admit(request('overflow', Number.MAX_VALUE))).toThrow('deadline')
    expect(policy.snapshot()).toMatchObject({
      jobs: 0, queued: 0, running: 0, resident: 0,
    })
    expect(policy.admit(request('ordinary', 1))).toBe(true)
    expect(policy.startNext(2)?.jobId).toBe('ordinary')
  })

  it('preserves monotonic lease expiry when a valid renewal follows a rejected rollback', () => {
    const policy = create()
    policy.admit(request('a', 0))
    policy.startNext(2)
    expect(policy.renew('a', 1, 15)).toBe(true)
    expect(policy.renew('a', 1, 12)).toBe(false)
    expect(policy.complete('a', 1, 50, 14)).toBeNull()
    expect(policy.expire(44)).toBe(0)
    expect(policy.complete('a', 1, 50, 45)).toBeNull()
    expect(policy.snapshot().jobs).toBe(0)
  })

  it('does not start expired work and remains reusable after expiry', () => {
    const policy = create()
    policy.admit(request('stale', 0))
    expect(policy.startNext(20)).toBeNull()
    expect(policy.snapshot().jobs).toBe(0)
    policy.admit(request('fresh', 21))
    expect(policy.startNext(22)?.jobId).toBe('fresh')
  })
})
