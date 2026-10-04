import { describe, expect, it } from 'vitest'
import { ArcGisOfflineEditSyncLifecyclePolicy, type OfflineEditSyncBudget, type OfflineEditSyncRequest } from './ArcGisOfflineEditSyncLifecyclePolicy'

const budget: OfflineEditSyncBudget = {
  maxLayers: 3,
  maxJobs: 8,
  maxJobsPerLayer: 5,
  maxSyncing: 2,
  maxSyncingPerLayer: 1,
  maxResident: 3,
  maxResidentPerLayer: 2,
  maxEditsPerJob: 100,
  maxBytesPerJob: 1_000,
  maxResidentBytes: 1_500,
  queueTtlMs: 100,
  syncLeaseMs: 50,
  residentTtlMs: 200,
}

function request(overrides: Partial<OfflineEditSyncRequest> = {}): OfflineEditSyncRequest {
  return {
    jobId: 'job-a',
    layerId: 'layer-a',
    replicaId: 'replica-a',
    revision: 1,
    intent: 'visible',
    operation: 'update',
    editCount: 5,
    estimatedBytes: 100,
    requestedAt: 0,
    ...overrides,
  }
}

function policy(custom: Partial<OfflineEditSyncBudget> = {}) {
  return new ArcGisOfflineEditSyncLifecyclePolicy({ ...budget, ...custom })
}

describe('ArcGisOfflineEditSyncLifecyclePolicy', () => {
  it('requires a registered exact layer revision before admission', () => {
    const sut = policy()
    expect(sut.admit(request())).toBe(false)
    expect(sut.setRevision('layer-a', 1)).toBe(0)
    expect(sut.admit(request())).toBe(true)
    expect(sut.snapshot()).toMatchObject({ layers: 1, jobs: 1, queued: 1 })
  })

  it('invalidates stale jobs when revision advances', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    sut.admit(request())
    expect(sut.setRevision('layer-a', 2)).toBe(1)
    expect(sut.snapshot().jobs).toBe(0)
    expect(sut.admit(request({ jobId: 'old' }))).toBe(false)
    expect(sut.admit(request({ jobId: 'new', revision: 2 }))).toBe(true)
  })

  it('rejects revision rollback without disturbing current work', () => {
    const sut = policy()
    sut.setRevision('layer-a', 3)
    sut.admit(request({ revision: 3 }))
    expect(sut.setRevision('layer-a', 2)).toBe(-1)
    expect(sut.snapshot().jobs).toBe(1)
  })

  it('bounds layer revision cardinality', () => {
    const sut = policy({ maxLayers: 2 })
    expect(sut.setRevision('a', 1)).toBe(0)
    expect(sut.setRevision('b', 1)).toBe(0)
    expect(sut.setRevision('c', 1)).toBe(-1)
  })

  it('schedules interactive before visible before background', () => {
    const sut = policy({ maxSyncing: 3, maxSyncingPerLayer: 3 })
    sut.setRevision('layer-a', 1)
    sut.admit(request({ jobId: 'bg', intent: 'background' }))
    sut.admit(request({ jobId: 'vis', intent: 'visible' }))
    sut.admit(request({ jobId: 'int', intent: 'interactive' }))
    expect(sut.startNext(1)?.jobId).toBe('int')
    expect(sut.startNext(2)?.jobId).toBe('vis')
    expect(sut.startNext(3)?.jobId).toBe('bg')
  })

  it('preserves FIFO sequence within equal intent', () => {
    const sut = policy({ maxSyncing: 2, maxSyncingPerLayer: 2 })
    sut.setRevision('layer-a', 1)
    sut.admit(request({ jobId: 'first', intent: 'visible' }))
    sut.admit(request({ jobId: 'second', intent: 'visible' }))
    expect(sut.startNext(1)?.jobId).toBe('first')
    expect(sut.startNext(2)?.jobId).toBe('second')
  })

  it('enforces global syncing concurrency', () => {
    const sut = policy({ maxSyncing: 1, maxSyncingPerLayer: 1 })
    sut.setRevision('layer-a', 1)
    sut.admit(request({ jobId: 'one' }))
    sut.admit(request({ jobId: 'two' }))
    expect(sut.startNext(1)?.jobId).toBe('one')
    expect(sut.startNext(2)).toBeNull()
  })

  it('enforces per-layer syncing concurrency while allowing another layer', () => {
    const sut = policy({ maxSyncing: 2, maxSyncingPerLayer: 1 })
    sut.setRevision('layer-a', 1)
    sut.setRevision('layer-b', 1)
    sut.admit(request({ jobId: 'a1' }))
    sut.admit(request({ jobId: 'a2' }))
    sut.admit(request({ jobId: 'b1', layerId: 'layer-b', replicaId: 'replica-b' }))
    expect(sut.startNext(1)?.jobId).toBe('a1')
    expect(sut.startNext(2)?.jobId).toBe('b1')
  })

  it('reconciles actual edit count and bytes on completion', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    sut.admit(request({ editCount: 10, estimatedBytes: 500 }))
    sut.startNext(1)
    expect(sut.complete('job-a', 1, 7, 240, 2)).toBe(true)
    expect(sut.snapshot()).toMatchObject({ resident: 1, residentEdits: 7, residentBytes: 240 })
    expect(sut.consume('job-a', 1)).toMatchObject({ editCount: 7, bytes: 240, phase: 'resident' })
  })

  it('rejects oversized actual edit count and removes failed work', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    sut.admit(request())
    sut.startNext(1)
    expect(sut.complete('job-a', 1, 101, 100, 2)).toBe(false)
    expect(sut.snapshot().jobs).toBe(0)
  })

  it('rejects oversized actual bytes and removes failed work', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    sut.admit(request())
    sut.startNext(1)
    expect(sut.complete('job-a', 1, 5, 1_001, 2)).toBe(false)
    expect(sut.snapshot().jobs).toBe(0)
  })

  it('rejects stale completion after revision change', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    sut.admit(request())
    sut.startNext(1)
    sut.setRevision('layer-a', 2)
    expect(sut.complete('job-a', 1, 5, 100, 2)).toBe(false)
  })

  it('expires queued work before scheduling', () => {
    const sut = policy({ queueTtlMs: 5 })
    sut.setRevision('layer-a', 1)
    sut.admit(request())
    expect(sut.startNext(5)).toBeNull()
    expect(sut.snapshot().jobs).toBe(0)
  })

  it('expires abandoned syncing work by lease', () => {
    const sut = policy({ syncLeaseMs: 5 })
    sut.setRevision('layer-a', 1)
    sut.admit(request())
    sut.startNext(1)
    expect(sut.expire(6)).toBe(1)
    expect(sut.snapshot().syncing).toBe(0)
  })

  it('expires resident work by ttl', () => {
    const sut = policy({ residentTtlMs: 5 })
    sut.setRevision('layer-a', 1)
    sut.admit(request())
    sut.startNext(1)
    sut.complete('job-a', 1, 5, 100, 2)
    expect(sut.expire(7)).toBe(1)
    expect(sut.snapshot().resident).toBe(0)
  })

  it('touch extends only resident ttl', () => {
    const sut = policy({ residentTtlMs: 5 })
    sut.setRevision('layer-a', 1)
    sut.admit(request())
    expect(sut.touch('job-a', 2)).toBe(false)
    sut.startNext(1)
    sut.complete('job-a', 1, 5, 100, 2)
    expect(sut.touch('job-a', 5)).toBe(true)
    expect(sut.expire(7)).toBe(0)
    expect(sut.expire(10)).toBe(1)
  })

  it('evicts lower intent resident work under byte pressure', () => {
    const sut = policy({ maxResidentBytes: 1_000, maxBytesPerJob: 1_000, maxResident: 3, maxResidentPerLayer: 3, maxSyncing: 2, maxSyncingPerLayer: 2 })
    sut.setRevision('layer-a', 1)
    sut.admit(request({ jobId: 'bg', intent: 'background', estimatedBytes: 600 }))
    sut.startNext(1)
    sut.complete('bg', 1, 5, 600, 2)
    sut.admit(request({ jobId: 'interactive', intent: 'interactive', estimatedBytes: 600 }))
    sut.startNext(3)
    expect(sut.complete('interactive', 1, 5, 600, 4)).toBe(true)
    expect(sut.consume('bg', 1)).toBeNull()
    expect(sut.snapshot().residentBytes).toBe(600)
  })

  it('does not evict higher intent residency for lower intent incoming work', () => {
    const sut = policy({ maxResidentBytes: 1_000, maxBytesPerJob: 1_000, maxResident: 3, maxResidentPerLayer: 3, maxSyncing: 2, maxSyncingPerLayer: 2 })
    sut.setRevision('layer-a', 1)
    sut.admit(request({ jobId: 'interactive', intent: 'interactive', estimatedBytes: 600 }))
    sut.startNext(1)
    sut.complete('interactive', 1, 5, 600, 2)
    sut.admit(request({ jobId: 'bg', intent: 'background', estimatedBytes: 600 }))
    sut.startNext(3)
    expect(sut.complete('bg', 1, 5, 600, 4)).toBe(false)
    expect(sut.consume('interactive', 1)?.jobId).toBe('interactive')
  })

  it('uses recency as deterministic eviction tie-break', () => {
    const sut = policy({ maxResident: 2, maxResidentPerLayer: 2, maxResidentBytes: 1_500, maxSyncing: 2, maxSyncingPerLayer: 2 })
    sut.setRevision('layer-a', 1)
    sut.admit(request({ jobId: 'old', estimatedBytes: 400 }))
    sut.startNext(1)
    sut.complete('old', 1, 5, 400, 2)
    sut.admit(request({ jobId: 'newer', estimatedBytes: 400 }))
    sut.startNext(3)
    sut.complete('newer', 1, 5, 400, 4)
    sut.touch('newer', 5)
    sut.admit(request({ jobId: 'incoming', intent: 'visible', estimatedBytes: 400 }))
    sut.startNext(6)
    expect(sut.complete('incoming', 1, 5, 400, 7)).toBe(true)
    expect(sut.consume('old', 1)).toBeNull()
    expect(sut.consume('newer', 1)?.jobId).toBe('newer')
  })

  it('cleans expired residency before completion admission', () => {
    const sut = policy({ maxResident: 1, maxResidentPerLayer: 1, residentTtlMs: 5, maxSyncing: 2, maxSyncingPerLayer: 2 })
    sut.setRevision('layer-a', 1)
    sut.admit(request({ jobId: 'expired' }))
    sut.startNext(1)
    sut.complete('expired', 1, 5, 100, 2)
    sut.admit(request({ jobId: 'fresh', requestedAt: 3 }))
    sut.startNext(3)
    expect(sut.complete('fresh', 1, 5, 100, 7)).toBe(true)
    expect(sut.snapshot().resident).toBe(1)
  })

  it('bounds job and per-layer cardinality', () => {
    const sut = policy({ maxJobs: 2, maxJobsPerLayer: 1 })
    sut.setRevision('layer-a', 1)
    sut.setRevision('layer-b', 1)
    expect(sut.admit(request({ jobId: 'a1' }))).toBe(true)
    expect(sut.admit(request({ jobId: 'a2' }))).toBe(false)
    expect(sut.admit(request({ jobId: 'b1', layerId: 'layer-b', replicaId: 'replica-b' }))).toBe(true)
    expect(sut.snapshot().jobs).toBe(2)
  })

  it('rejects estimated resource abuse before queueing', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    expect(sut.admit(request({ jobId: 'too-many', editCount: 101 }))).toBe(false)
    expect(sut.admit(request({ jobId: 'too-big', estimatedBytes: 1_001 }))).toBe(false)
    expect(sut.snapshot().jobs).toBe(0)
  })

  it('returns detached frozen views', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    sut.admit(request())
    const view = sut.startNext(1)
    expect(view).not.toBeNull()
    expect(Object.isFrozen(view)).toBe(true)
    expect(view).toMatchObject({ jobId: 'job-a', phase: 'syncing', operation: 'update' })
  })

  it('keeps caller payload fields outside authority state', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    const hostile = { ...request(), geometry: { secret: 'geometry' }, attributes: { token: 'credential' }, signal: new AbortController().signal }
    expect(sut.admit(hostile)).toBe(true)
    const started = sut.startNext(1) as unknown as Record<string, unknown>
    expect(started.geometry).toBeUndefined()
    expect(started.attributes).toBeUndefined()
    expect(started.signal).toBeUndefined()
    expect(sut.fingerprint()).not.toContain('credential')
    expect(sut.fingerprint()).not.toContain('geometry')
  })

  it('normalizes identifiers without mutating caller request', () => {
    const sut = policy()
    sut.setRevision(' layer-a ', 1)
    const input = request({ jobId: ' job-a ', layerId: ' layer-a ', replicaId: ' replica-a ' })
    expect(sut.admit(input)).toBe(true)
    expect(input.jobId).toBe(' job-a ')
    expect(sut.startNext(1)).toMatchObject({ jobId: 'job-a', layerId: 'layer-a', replicaId: 'replica-a' })
  })

  it('rejects unsafe identifiers', () => {
    const sut = policy()
    expect(() => sut.setRevision('', 1)).toThrow()
    expect(() => sut.setRevision('bad\u0000id', 1)).toThrow()
    expect(() => sut.setRevision('x'.repeat(193), 1)).toThrow()
  })

  it('rejects invalid numeric inputs', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    expect(() => sut.admit(request({ editCount: Number.NaN }))).toThrow()
    expect(() => sut.admit(request({ estimatedBytes: Number.POSITIVE_INFINITY }))).toThrow()
    expect(() => sut.admit(request({ revision: -1 }))).toThrow()
    expect(() => sut.startNext(-1)).toThrow()
  })

  it('rejects invalid intent and operation values at runtime', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    expect(() => sut.admit(request({ intent: 'urgent' as OfflineEditSyncRequest['intent'] }))).toThrow('intent is invalid')
    expect(() => sut.admit(request({ operation: 'truncate' as OfflineEditSyncRequest['operation'] }))).toThrow('operation is invalid')
  })

  it('cancel removes work from any lifecycle phase', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    sut.admit(request())
    expect(sut.cancel('job-a')).toBe(true)
    expect(sut.cancel('job-a')).toBe(false)
    expect(sut.snapshot().jobs).toBe(0)
  })

  it('releaseLayer removes jobs and revision authority', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    sut.admit(request({ jobId: 'one' }))
    sut.admit(request({ jobId: 'two' }))
    expect(sut.releaseLayer('layer-a')).toBe(2)
    expect(sut.snapshot()).toMatchObject({ layers: 0, jobs: 0 })
    expect(sut.admit(request({ jobId: 'three' }))).toBe(false)
  })

  it('fingerprint is deterministic across admission order when scalar state matches', () => {
    const a = policy({ maxSyncing: 2, maxSyncingPerLayer: 2 })
    const b = policy({ maxSyncing: 2, maxSyncingPerLayer: 2 })
    for (const sut of [a, b]) sut.setRevision('layer-a', 1)
    a.admit(request({ jobId: 'b', replicaId: 'replica-b' }))
    a.admit(request({ jobId: 'a', replicaId: 'replica-a' }))
    b.admit(request({ jobId: 'a', replicaId: 'replica-a' }))
    b.admit(request({ jobId: 'b', replicaId: 'replica-b' }))
    expect(a.fingerprint()).toBe(b.fingerprint())
  })

  it('dispose clears state and becomes terminal', () => {
    const sut = policy()
    sut.setRevision('layer-a', 1)
    sut.admit(request())
    sut.dispose()
    sut.dispose()
    expect(() => sut.snapshot()).toThrow('disposed')
    expect(() => sut.admit(request())).toThrow('disposed')
    expect(() => sut.setRevision('layer-a', 2)).toThrow('disposed')
  })

  it('validates contradictory budget relationships', () => {
    expect(() => policy({ maxJobs: 2, maxJobsPerLayer: 3 })).toThrow()
    expect(() => policy({ maxSyncing: 1, maxSyncingPerLayer: 2 })).toThrow()
    expect(() => policy({ maxResident: 1, maxResidentPerLayer: 2 })).toThrow()
    expect(() => policy({ maxBytesPerJob: 2_000, maxResidentBytes: 1_500 })).toThrow()
  })
})
