import { describe, expect, it } from 'vitest'
import { ArcGisFeatureAttachmentLifecyclePolicy, type AttachmentLifecycleBudget } from './ArcGisFeatureAttachmentLifecyclePolicy'

const budget: AttachmentLifecycleBudget = {
  maxLayers: 3,
  maxJobs: 8,
  maxJobsPerLayer: 4,
  maxUploading: 2,
  maxUploadingPerLayer: 1,
  maxResident: 3,
  maxResidentPerLayer: 2,
  maxBytesPerAttachment: 100,
  maxResidentBytes: 180,
  queueTtlMs: 20,
  uploadLeaseMs: 10,
  residentTtlMs: 30,
}

const request = (jobId: string, layerId = 'roads', intent: 'interactive' | 'visible' | 'background' = 'visible', bytes = 40, requestedAt = 0) => ({
  jobId, layerId, featureId: `feature-${jobId}`, revision: 1, intent, estimatedBytes: bytes, requestedAt,
})

function policy(): ArcGisFeatureAttachmentLifecyclePolicy {
  const value = new ArcGisFeatureAttachmentLifecyclePolicy(budget)
  value.setRevision('roads', 1)
  value.setRevision('parks', 1)
  return value
}

describe('ArcGisFeatureAttachmentLifecyclePolicy', () => {
  it('prioritizes interactive attachment work deterministically', () => {
    const value = policy()
    expect(value.admit(request('background', 'roads', 'background'))).toBe(true)
    expect(value.admit(request('visible', 'parks', 'visible'))).toBe(true)
    expect(value.admit(request('interactive', 'roads', 'interactive'))).toBe(true)
    expect(value.startNext(1)?.jobId).toBe('interactive')
    expect(value.startNext(1)?.jobId).toBe('visible')
  })

  it('enforces per-layer upload concurrency', () => {
    const value = policy()
    value.admit(request('a'))
    value.admit(request('b'))
    value.admit(request('c', 'parks'))
    expect(value.startNext(1)?.jobId).toBe('a')
    expect(value.startNext(1)?.jobId).toBe('c')
    expect(value.startNext(1)).toBeNull()
  })

  it('rejects stale revision admission and invalidates old work', () => {
    const value = policy()
    value.admit(request('old'))
    expect(value.setRevision('roads', 2)).toBe(1)
    expect(value.admit(request('stale'))).toBe(false)
    expect(value.snapshot().jobs).toBe(0)
  })

  it('rejects stale completion after revision advance', () => {
    const value = policy()
    value.admit(request('upload'))
    value.startNext(1)
    value.setRevision('roads', 2)
    expect(value.complete('upload', 1, 40, 2)).toBe(false)
  })

  it('reconciles actual bytes and rejects oversized completion', () => {
    const value = policy()
    value.admit(request('upload', 'roads', 'visible', 20))
    value.startNext(1)
    expect(value.complete('upload', 1, 101, 2)).toBe(false)
    expect(value.snapshot().jobs).toBe(0)
  })

  it('reconciles actual bytes into resident accounting', () => {
    const value = policy()
    value.admit(request('upload', 'roads', 'visible', 20))
    value.startNext(1)
    expect(value.complete('upload', 1, 70, 2)).toBe(true)
    expect(value.snapshot().residentBytes).toBe(70)
  })

  it('expires queue leases before scheduling', () => {
    const value = policy()
    value.admit(request('expired'))
    expect(value.startNext(20)).toBeNull()
    expect(value.snapshot().jobs).toBe(0)
  })

  it('expires upload leases before completion', () => {
    const value = policy()
    value.admit(request('expired'))
    value.startNext(1)
    expect(value.complete('expired', 1, 40, 11)).toBe(false)
    expect(value.snapshot().jobs).toBe(0)
  })

  it('expires resident entries at the TTL boundary', () => {
    const value = policy()
    value.admit(request('resident'))
    value.startNext(1)
    value.complete('resident', 1, 40, 2)
    expect(value.expire(31)).toBe(0)
    expect(value.expire(32)).toBe(1)
  })

  it('touch extends resident lifetime', () => {
    const value = policy()
    value.admit(request('resident'))
    value.startNext(1)
    value.complete('resident', 1, 40, 2)
    expect(value.touch('resident', 20)).toBe(true)
    expect(value.expire(32)).toBe(0)
    expect(value.expire(50)).toBe(1)
  })

  it('consumes only matching live revisions', () => {
    const value = policy()
    value.admit(request('resident'))
    value.startNext(1)
    value.complete('resident', 1, 40, 2)
    expect(value.consume('resident', 2)).toBeNull()
    expect(value.consume('resident', 1)?.featureId).toBe('feature-resident')
    expect(value.snapshot().jobs).toBe(0)
  })

  it('evicts lower intent residency under byte pressure', () => {
    const value = policy()
    value.admit(request('background', 'roads', 'background', 90))
    value.startNext(1)
    value.complete('background', 1, 90, 2)
    value.admit(request('interactive', 'parks', 'interactive', 100, 3))
    value.startNext(4)
    expect(value.complete('interactive', 1, 100, 5)).toBe(true)
    expect(value.consume('background', 1)).toBeNull()
    expect(value.snapshot().residentBytes).toBe(100)
  })

  it('does not evict higher intent residency for background work', () => {
    const value = policy()
    value.admit(request('interactive', 'roads', 'interactive', 100))
    value.startNext(1)
    value.complete('interactive', 1, 100, 2)
    value.admit(request('background', 'parks', 'background', 90, 3))
    value.startNext(4)
    expect(value.complete('background', 1, 90, 5)).toBe(false)
    expect(value.snapshot().residentBytes).toBe(100)
  })

  it('uses least-recently-touched residency as equal-priority victim', () => {
    const value = policy()
    value.admit(request('old', 'roads', 'visible', 80))
    value.startNext(1); value.complete('old', 1, 80, 2)
    value.admit(request('new', 'parks', 'visible', 80, 3))
    value.startNext(4); value.complete('new', 1, 80, 5)
    value.touch('new', 6)
    value.admit(request('incoming', 'roads', 'visible', 80, 7))
    value.startNext(8); expect(value.complete('incoming', 1, 80, 9)).toBe(true)
    expect(value.consume('old', 1)).toBeNull()
    expect(value.snapshot().resident).toBe(2)
  })

  it('bounds per-layer job cardinality', () => {
    const value = new ArcGisFeatureAttachmentLifecyclePolicy({ ...budget, maxJobsPerLayer: 1 })
    value.setRevision('roads', 1)
    expect(value.admit(request('a'))).toBe(true)
    expect(value.admit(request('b'))).toBe(false)
  })

  it('bounds layer revision cardinality', () => {
    const value = new ArcGisFeatureAttachmentLifecyclePolicy({ ...budget, maxLayers: 1 })
    expect(value.setRevision('roads', 1)).toBe(0)
    expect(value.setRevision('parks', 1)).toBe(-1)
  })

  it('rejects oversized estimated attachment bytes before admission', () => {
    const value = policy()
    expect(value.admit(request('large', 'roads', 'visible', 101))).toBe(false)
  })

  it('rejects duplicate job identifiers', () => {
    const value = policy()
    expect(value.admit(request('same'))).toBe(true)
    expect(value.admit(request('same'))).toBe(false)
  })

  it('releases all layer jobs and its revision watermark', () => {
    const value = policy()
    value.admit(request('a')); value.admit(request('b'))
    expect(value.releaseLayer('roads')).toBe(2)
    expect(value.snapshot().layers).toBe(1)
    expect(value.admit(request('c'))).toBe(false)
  })

  it('returns detached frozen scalar views', () => {
    const value = policy()
    value.admit(request('a'))
    const view = value.startNext(1)!
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.keys(view).sort()).toEqual(['bytes','expiresAt','featureId','intent','jobId','layerId','phase','revision','sequence','touchedAt'].sort())
  })

  it('keeps snapshots scalar and frozen', () => {
    const value = policy(); value.admit(request('a'))
    const snapshot = value.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot).toEqual({ layers: 2, jobs: 1, queued: 1, uploading: 0, resident: 0, residentBytes: 0 })
  })

  it('builds deterministic fingerprints without payload data', () => {
    const value = policy(); value.admit(request('b', 'parks')); value.admit(request('a', 'roads'))
    expect(value.fingerprint()).toBe('parks:feature-b:b:1:visible:queued:40|roads:feature-a:a:1:visible:queued:40')
  })

  it('validates identifiers and numeric inputs fail closed', () => {
    const value = policy()
    expect(() => value.setRevision('', 1)).toThrow()
    expect(() => value.admit({ ...request('a'), featureId: '\u0000bad' })).toThrow()
    expect(() => value.admit({ ...request('a'), estimatedBytes: Number.NaN })).toThrow()
  })

  it('validates inconsistent budgets', () => {
    expect(() => new ArcGisFeatureAttachmentLifecyclePolicy({ ...budget, maxJobsPerLayer: 9 })).toThrow()
    expect(() => new ArcGisFeatureAttachmentLifecyclePolicy({ ...budget, maxBytesPerAttachment: 181 })).toThrow()
  })

  it('cancels queued and uploading jobs', () => {
    const value = policy(); value.admit(request('queued')); value.admit(request('uploading', 'parks')); value.startNext(1)
    expect(value.cancel('queued') || value.cancel('uploading')).toBe(true)
  })

  it('dispose is idempotent and prevents later mutation', () => {
    const value = policy(); value.admit(request('a')); value.dispose(); value.dispose()
    expect(() => value.snapshot()).toThrow('feature attachment lifecycle policy is disposed')
    expect(() => value.admit(request('b'))).toThrow()
  })
})
