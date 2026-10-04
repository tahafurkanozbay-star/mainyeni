import { describe, expect, it } from 'vitest'
import { ArcGisEditBatchCommitLifecyclePolicy, type EditBatchCommitBudget, type EditBatchCommitRequest } from './ArcGisEditBatchCommitLifecyclePolicy'

const budget: EditBatchCommitBudget = {
  maxLayers: 3,
  maxBatches: 6,
  maxBatchesPerLayer: 4,
  maxCommitting: 2,
  maxCommittingPerLayer: 1,
  maxResident: 3,
  maxResidentPerLayer: 2,
  maxOperationsPerBatch: 20,
  maxBytesPerBatch: 2000,
  maxResidentOperations: 40,
  maxResidentBytes: 4000,
  queueTtlMs: 100,
  commitLeaseMs: 50,
  residentTtlMs: 200,
}

function request(batchId: string, layerId = 'parcels', revision = 1, intent: EditBatchCommitRequest['intent'] = 'visible', requestedAt = 0): EditBatchCommitRequest {
  return { batchId, layerId, revision, intent, operationCount: 5, estimatedBytes: 500, requestedAt }
}

function policy(custom: Partial<EditBatchCommitBudget> = {}): ArcGisEditBatchCommitLifecyclePolicy {
  return new ArcGisEditBatchCommitLifecyclePolicy({ ...budget, ...custom })
}

describe('ArcGisEditBatchCommitLifecyclePolicy', () => {
  it('requires valid bounded budgets', () => {
    expect(() => policy({ maxLayers: 0 })).toThrow()
    expect(() => policy({ maxBatchesPerLayer: 7 })).toThrow()
    expect(() => policy({ maxCommittingPerLayer: 3 })).toThrow()
    expect(() => policy({ maxResidentPerLayer: 4 })).toThrow()
    expect(() => policy({ maxBytesPerBatch: 5000 })).toThrow()
    expect(() => policy({ maxOperationsPerBatch: 50 })).toThrow()
    expect(() => policy({ queueTtlMs: Number.NaN })).toThrow()
  })

  it('requires a known current layer revision before admission', () => {
    const subject = policy()
    expect(subject.admit(request('a'))).toBe(false)
    expect(subject.setRevision('parcels', 1)).toBe(0)
    expect(subject.admit(request('a'))).toBe(true)
  })

  it('rejects unsafe identifiers and malformed scalar input', () => {
    const subject = policy(); subject.setRevision('parcels', 1)
    expect(() => subject.admit(request(''))).toThrow()
    expect(() => subject.admit(request('bad\nvalue'))).toThrow()
    expect(() => subject.admit({ ...request('a'), operationCount: 0 })).toThrow()
    expect(() => subject.admit({ ...request('a'), estimatedBytes: Number.NaN })).toThrow()
    expect(() => subject.admit({ ...request('a'), requestedAt: -1 })).toThrow()
    expect(() => subject.admit({ ...request('a'), intent: 'other' as never })).toThrow()
  })

  it('enforces per-batch operation and byte admission limits', () => {
    const subject = policy(); subject.setRevision('parcels', 1)
    expect(subject.admit({ ...request('ops'), operationCount: 21 })).toBe(false)
    expect(subject.admit({ ...request('bytes'), estimatedBytes: 2001 })).toBe(false)
    expect(subject.snapshot().batches).toBe(0)
  })

  it('enforces global and per-layer queue cardinality', () => {
    const subject = policy({ maxBatches: 3, maxBatchesPerLayer: 2 }); subject.setRevision('a', 1); subject.setRevision('b', 1)
    expect(subject.admit(request('a1', 'a'))).toBe(true)
    expect(subject.admit(request('a2', 'a'))).toBe(true)
    expect(subject.admit(request('a3', 'a'))).toBe(false)
    expect(subject.admit(request('b1', 'b'))).toBe(true)
    expect(subject.admit(request('b2', 'b'))).toBe(false)
  })

  it('does not admit duplicate batch identities', () => {
    const subject = policy(); subject.setRevision('parcels', 1)
    expect(subject.admit(request('same'))).toBe(true)
    expect(subject.admit(request('same'))).toBe(false)
  })

  it('schedules interactive before visible before background', () => {
    const subject = policy({ maxCommitting: 3, maxCommittingPerLayer: 3 }); subject.setRevision('parcels', 1)
    subject.admit(request('background', 'parcels', 1, 'background'))
    subject.admit(request('visible', 'parcels', 1, 'visible'))
    subject.admit(request('interactive', 'parcels', 1, 'interactive'))
    expect(subject.startNext(1)?.batchId).toBe('interactive')
    expect(subject.startNext(2)?.batchId).toBe('visible')
    expect(subject.startNext(3)?.batchId).toBe('background')
  })

  it('uses FIFO sequence within equal intent', () => {
    const subject = policy({ maxCommitting: 2, maxCommittingPerLayer: 2 }); subject.setRevision('parcels', 1)
    subject.admit(request('first')); subject.admit(request('second'))
    expect(subject.startNext(1)?.batchId).toBe('first')
    expect(subject.startNext(2)?.batchId).toBe('second')
  })

  it('enforces global committing concurrency', () => {
    const subject = policy({ maxCommitting: 1 }); subject.setRevision('a', 1); subject.setRevision('b', 1)
    subject.admit(request('a1', 'a')); subject.admit(request('b1', 'b'))
    expect(subject.startNext(1)).not.toBeNull()
    expect(subject.startNext(2)).toBeNull()
  })

  it('enforces per-layer committing concurrency while allowing another layer', () => {
    const subject = policy({ maxCommitting: 2, maxCommittingPerLayer: 1 }); subject.setRevision('a', 1); subject.setRevision('b', 1)
    subject.admit(request('a1', 'a', 1, 'interactive')); subject.admit(request('a2', 'a')); subject.admit(request('b1', 'b'))
    expect(subject.startNext(1)?.batchId).toBe('a1')
    expect(subject.startNext(2)?.batchId).toBe('b1')
  })

  it('reconciles estimated accounting to actual completion accounting', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a')); subject.startNext(1)
    expect(subject.complete('a', 1, 9, 900, 2)).toBe(true)
    expect(subject.snapshot()).toMatchObject({ resident: 1, residentOperations: 9, residentBytes: 900 })
    expect(subject.consume('a', 1)).toMatchObject({ operationCount: 9, bytes: 900 })
  })

  it('drops completion exceeding actual per-batch limits', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a')); subject.startNext(1)
    expect(subject.complete('a', 1, 21, 500, 2)).toBe(false)
    expect(subject.snapshot().batches).toBe(0)
  })

  it('rejects stale revision completion', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a')); subject.startNext(1)
    expect(subject.complete('a', 2, 5, 500, 2)).toBe(false)
  })

  it('revision advance invalidates queued, committing, and resident entries', () => {
    const subject = policy({ maxCommitting: 2, maxCommittingPerLayer: 2 }); subject.setRevision('parcels', 1)
    subject.admit(request('resident')); subject.startNext(1); subject.complete('resident', 1, 5, 500, 2)
    subject.admit(request('committing')); subject.startNext(3)
    subject.admit(request('queued'))
    expect(subject.setRevision('parcels', 2)).toBe(3)
    expect(subject.snapshot()).toMatchObject({ batches: 0, layers: 1 })
  })

  it('ignores a decreasing revision', () => {
    const subject = policy(); subject.setRevision('parcels', 3)
    expect(subject.setRevision('parcels', 2)).toBe(-1)
    expect(subject.admit(request('stale', 'parcels', 2))).toBe(false)
    expect(subject.admit(request('current', 'parcels', 3))).toBe(true)
  })

  it('bounds revision registry cardinality', () => {
    const subject = policy({ maxLayers: 1 })
    expect(subject.setRevision('a', 1)).toBe(0)
    expect(subject.setRevision('b', 1)).toBe(-1)
  })

  it('expires queued work before selecting a candidate', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('old', 'parcels', 1, 'interactive', 0))
    expect(subject.startNext(100)).toBeNull()
    expect(subject.snapshot().batches).toBe(0)
  })

  it('expires abandoned commit leases', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a')); subject.startNext(10)
    expect(subject.expire(60)).toBe(1)
    expect(subject.complete('a', 1, 5, 500, 61)).toBe(false)
  })

  it('expires resident results deterministically', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a')); subject.startNext(1); subject.complete('a', 1, 5, 500, 2)
    expect(subject.expire(201)).toBe(0)
    expect(subject.expire(202)).toBe(1)
  })

  it('touch extends resident TTL without changing payload accounting', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a')); subject.startNext(1); subject.complete('a', 1, 5, 500, 2)
    expect(subject.touch('a', 100)).toBe(true)
    expect(subject.expire(250)).toBe(0)
    expect(subject.snapshot()).toMatchObject({ residentOperations: 5, residentBytes: 500 })
  })

  it('touch rejects non-resident work', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a'))
    expect(subject.touch('a', 1)).toBe(false)
  })

  it('evicts lower-priority resident work for higher-priority completion', () => {
    const subject = policy({ maxResident: 1, maxResidentPerLayer: 1 }); subject.setRevision('parcels', 1)
    subject.admit(request('background', 'parcels', 1, 'background')); subject.startNext(1); subject.complete('background', 1, 5, 500, 2)
    subject.admit(request('interactive', 'parcels', 1, 'interactive')); subject.startNext(3)
    expect(subject.complete('interactive', 1, 5, 500, 4)).toBe(true)
    expect(subject.consume('background', 1)).toBeNull()
    expect(subject.consume('interactive', 1)?.batchId).toBe('interactive')
  })

  it('does not evict higher-priority resident work for lower-priority completion', () => {
    const subject = policy({ maxResident: 1, maxResidentPerLayer: 1 }); subject.setRevision('parcels', 1)
    subject.admit(request('interactive', 'parcels', 1, 'interactive')); subject.startNext(1); subject.complete('interactive', 1, 5, 500, 2)
    subject.admit(request('background', 'parcels', 1, 'background')); subject.startNext(3)
    expect(subject.complete('background', 1, 5, 500, 4)).toBe(false)
    expect(subject.consume('interactive', 1)?.batchId).toBe('interactive')
  })

  it('uses LRU then sequence as deterministic equal-priority eviction tie-breaks', () => {
    const subject = policy({ maxResident: 2, maxResidentPerLayer: 2 }); subject.setRevision('parcels', 1)
    subject.admit(request('old')); subject.startNext(1); subject.complete('old', 1, 5, 500, 2)
    subject.admit(request('new')); subject.startNext(3); subject.complete('new', 1, 5, 500, 4)
    subject.touch('new', 10)
    subject.admit(request('incoming')); subject.startNext(11); expect(subject.complete('incoming', 1, 5, 500, 12)).toBe(true)
    expect(subject.consume('old', 1)).toBeNull()
    expect(subject.consume('new', 1)).not.toBeNull()
  })

  it('enforces aggregate resident operation pressure', () => {
    const subject = policy({ maxResidentOperations: 10 }); subject.setRevision('parcels', 1)
    subject.admit(request('one')); subject.startNext(1); subject.complete('one', 1, 8, 500, 2)
    subject.admit(request('two')); subject.startNext(3); expect(subject.complete('two', 1, 8, 500, 4)).toBe(true)
    expect(subject.snapshot()).toMatchObject({ resident: 1, residentOperations: 8 })
  })

  it('enforces aggregate resident byte pressure', () => {
    const subject = policy({ maxResidentBytes: 2000, maxBytesPerBatch: 2000 }); subject.setRevision('parcels', 1)
    subject.admit(request('one')); subject.startNext(1); subject.complete('one', 1, 5, 1500, 2)
    subject.admit(request('two')); subject.startNext(3); expect(subject.complete('two', 1, 5, 1500, 4)).toBe(true)
    expect(subject.snapshot()).toMatchObject({ resident: 1, residentBytes: 1500 })
  })

  it('consume is revision guarded and removes residency', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a')); subject.startNext(1); subject.complete('a', 1, 5, 500, 2)
    expect(subject.consume('a', 2)).toBeNull()
    expect(subject.consume('a', 1)?.phase).toBe('resident')
    expect(subject.snapshot().resident).toBe(0)
  })

  it('cancel removes any lifecycle phase', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a'))
    expect(subject.cancel('a')).toBe(true)
    expect(subject.cancel('a')).toBe(false)
  })

  it('releaseLayer clears jobs and revision authority', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a'))
    expect(subject.releaseLayer('parcels')).toBe(1)
    expect(subject.snapshot()).toMatchObject({ layers: 0, batches: 0 })
    expect(subject.admit(request('b'))).toBe(false)
  })

  it('returns detached immutable scalar views', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a'))
    const view = subject.startNext(1)
    expect(Object.isFrozen(view)).toBe(true)
    expect(view).toEqual(expect.objectContaining({ batchId: 'a', layerId: 'parcels', phase: 'committing' }))
  })

  it('keeps deterministic fingerprints independent of insertion ordering across layers', () => {
    const a = policy(); const b = policy()
    for (const subject of [a,b]) { subject.setRevision('a', 1); subject.setRevision('b', 1) }
    a.admit(request('b1', 'b')); a.admit(request('a1', 'a'))
    b.admit(request('a1', 'a')); b.admit(request('b1', 'b'))
    expect(a.fingerprint()).toBe(b.fingerprint())
  })

  it('fingerprint exposes only bounded scalar metadata', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('batch'))
    expect(subject.fingerprint()).toBe('parcels:batch:1:visible:queued:5:500')
  })

  it('snapshot accurately separates phases and aggregate residency', () => {
    const subject = policy({ maxCommitting: 2, maxCommittingPerLayer: 2 }); subject.setRevision('parcels', 1)
    subject.admit(request('resident')); subject.startNext(1); subject.complete('resident', 1, 7, 700, 2)
    subject.admit(request('committing')); subject.startNext(3)
    subject.admit(request('queued'))
    expect(subject.snapshot()).toEqual({ layers: 1, batches: 3, queued: 1, committing: 1, resident: 1, residentOperations: 7, residentBytes: 700 })
  })

  it('does not retain caller-owned object payloads because request contract is scalar-only', () => {
    const subject = policy(); subject.setRevision('parcels', 1)
    const callerPayload = { geometry: { x: 1, y: 2 }, attributes: { secret: 'caller-owned' }, credential: 'never-store' }
    expect(subject.admit({ ...request('a'), ...({ callerPayload } as object) } as EditBatchCommitRequest)).toBe(true)
    callerPayload.attributes.secret = 'mutated'
    expect(subject.fingerprint()).not.toContain('secret')
    expect(subject.fingerprint()).not.toContain('credential')
  })

  it('dispose is idempotent and rejects subsequent authority use', () => {
    const subject = policy(); subject.setRevision('parcels', 1); subject.admit(request('a')); subject.dispose(); subject.dispose()
    expect(() => subject.snapshot()).toThrow('disposed')
    expect(() => subject.admit(request('b'))).toThrow('disposed')
  })
})
