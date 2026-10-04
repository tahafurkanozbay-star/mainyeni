import { describe, expect, it } from 'vitest'
import { ArcGisEditRecoveryLifecyclePolicy, type EditRecoveryBudget, type EditRecoveryIntent, type EditRecoveryStrategy } from './ArcGisEditRecoveryLifecyclePolicy'

const budget: EditRecoveryBudget = {
  maxLayers: 3, maxJobs: 8, maxJobsPerLayer: 4, maxRecovering: 2, maxRecoveringPerLayer: 1,
  maxOperationsPerJob: 10, maxBytesPerJob: 1000, maxResidentOperations: 12, maxResidentBytes: 1200,
  queueTtlMs: 50, recoveryLeaseMs: 30, residentTtlMs: 100,
}

function policy(overrides: Partial<EditRecoveryBudget> = {}) { return new ArcGisEditRecoveryLifecyclePolicy({ ...budget, ...overrides }) }
function request(jobId: string, layerId = 'roads', intent: EditRecoveryIntent = 'visible', strategy: EditRecoveryStrategy = 'retry', requestedAt = 0) {
  return { jobId, layerId, revision: 1, intent, strategy, operationCount: 2, estimatedBytes: 100, requestedAt }
}

describe('ArcGisEditRecoveryLifecyclePolicy', () => {
  it('validates coherent budgets', () => {
    expect(() => policy({ maxJobs: 0 })).toThrow()
    expect(() => policy({ maxJobs: 2, maxJobsPerLayer: 3 })).toThrow()
    expect(() => policy({ maxRecovering: 1, maxRecoveringPerLayer: 2 })).toThrow()
    expect(() => policy({ maxResidentOperations: 2, maxOperationsPerJob: 3 })).toThrow()
    expect(() => policy({ maxResidentBytes: 20, maxBytesPerJob: 21 })).toThrow()
    expect(() => policy({ queueTtlMs: Number.NaN })).toThrow()
  })

  it('requires revision authority before admission', () => {
    const p = policy(); expect(p.enqueue(request('a'))).toBe(false); expect(p.setRevision('roads', 1)).toBe(0); expect(p.enqueue(request('a'))).toBe(true)
  })

  it('rejects stale revision movement and invalidates stale jobs on advance', () => {
    const p = policy(); p.setRevision('roads', 1); p.enqueue(request('a')); expect(p.setRevision('roads', 0)).toBe(-1); expect(p.setRevision('roads', 2)).toBe(1); expect(p.snapshot().jobs).toBe(0)
  })

  it('bounds layer revision cardinality', () => {
    const p = policy({ maxLayers: 1 }); expect(p.setRevision('a', 1)).toBe(0); expect(p.setRevision('b', 1)).toBe(-1); expect(p.snapshot().layers).toBe(1)
  })

  it('normalizes safe identifiers and rejects control characters', () => {
    const p = policy(); p.setRevision(' roads ', 1); expect(p.enqueue({ ...request(' a '), layerId: ' roads ' })).toBe(true); expect(p.fingerprint()).toContain('roads:a:')
    expect(() => p.enqueue(request('bad\u0000id'))).toThrow()
  })

  it('rejects invalid intent and strategy values at runtime', () => {
    const p = policy(); p.setRevision('roads', 1)
    expect(() => p.enqueue({ ...request('a'), intent: 'urgent' as EditRecoveryIntent })).toThrow()
    expect(() => p.enqueue({ ...request('b'), strategy: 'overwrite' as EditRecoveryStrategy })).toThrow()
  })

  it('rejects unsafe numeric admission', () => {
    const p = policy(); p.setRevision('roads', 1)
    expect(() => p.enqueue({ ...request('a'), operationCount: 0 })).toThrow()
    expect(() => p.enqueue({ ...request('a'), estimatedBytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(() => p.enqueue({ ...request('a'), requestedAt: -1 })).toThrow()
  })

  it('enforces per-job operation and byte budgets', () => {
    const p = policy({ maxOperationsPerJob: 2, maxBytesPerJob: 100 }); p.setRevision('roads', 1)
    expect(p.enqueue({ ...request('a'), operationCount: 3 })).toBe(false); expect(p.enqueue({ ...request('b'), estimatedBytes: 101 })).toBe(false)
  })

  it('rejects duplicate job ids without mutating existing state', () => {
    const p = policy(); p.setRevision('roads', 1); expect(p.enqueue(request('a'))).toBe(true); expect(p.enqueue({ ...request('a'), intent: 'interactive' })).toBe(false); expect(p.snapshot().jobs).toBe(1)
  })

  it('enforces global and per-layer job cardinality', () => {
    const p = policy({ maxJobs: 2, maxJobsPerLayer: 1 }); p.setRevision('roads', 1); p.setRevision('parks', 1)
    expect(p.enqueue(request('a'))).toBe(true); expect(p.enqueue(request('b'))).toBe(false); expect(p.enqueue(request('c', 'parks'))).toBe(true); expect(p.enqueue(request('d', 'parks'))).toBe(false)
  })

  it('schedules interactive then visible then background deterministically', () => {
    const p = policy({ maxRecovering: 3, maxRecoveringPerLayer: 1 }); p.setRevision('a', 1); p.setRevision('b', 1); p.setRevision('c', 1)
    p.enqueue(request('bg', 'a', 'background', 'retry', 0)); p.enqueue(request('vis', 'b', 'visible', 'retry', 1)); p.enqueue(request('int', 'c', 'interactive', 'retry', 2))
    expect(p.startNext(3)?.jobId).toBe('int'); expect(p.startNext(3)?.jobId).toBe('vis'); expect(p.startNext(3)?.jobId).toBe('bg')
  })

  it('uses requested time then sequence as deterministic same-intent tie break', () => {
    const p = policy({ maxRecovering: 2, maxRecoveringPerLayer: 2 }); p.setRevision('roads', 1); p.enqueue(request('later', 'roads', 'visible', 'retry', 2)); p.enqueue(request('early', 'roads', 'visible', 'retry', 1)); expect(p.startNext(3)?.jobId).toBe('early')
  })

  it('enforces global recovery concurrency', () => {
    const p = policy({ maxRecovering: 1 }); p.setRevision('a', 1); p.setRevision('b', 1); p.enqueue(request('a', 'a')); p.enqueue(request('b', 'b')); expect(p.startNext(1)?.jobId).toBe('a'); expect(p.startNext(1)).toBeNull()
  })

  it('enforces per-layer recovery concurrency without blocking other layers', () => {
    const p = policy({ maxRecovering: 2, maxRecoveringPerLayer: 1 }); p.setRevision('a', 1); p.setRevision('b', 1); p.enqueue(request('a1', 'a')); p.enqueue(request('a2', 'a')); p.enqueue(request('b1', 'b')); expect(p.startNext(1)?.jobId).toBe('a1'); expect(p.startNext(1)?.jobId).toBe('b1')
  })

  it('reconciles estimated values to actual completion values', () => {
    const p = policy(); p.setRevision('roads', 1); p.enqueue(request('a')); p.startNext(1); expect(p.complete('a', 1, 4, 250, 2)).toBe(true); expect(p.snapshot()).toMatchObject({ resident: 1, residentOperations: 4, residentBytes: 250 }); expect(p.fingerprint()).toContain(':resident:4:250')
  })

  it('rejects completion that exceeds per-job actual budgets and removes the job', () => {
    const p = policy({ maxOperationsPerJob: 2 }); p.setRevision('roads', 1); p.enqueue(request('a')); p.startNext(1); expect(p.complete('a', 1, 3, 100, 2)).toBe(false); expect(p.snapshot().jobs).toBe(0)
  })

  it('rejects stale completion after revision advance', () => {
    const p = policy(); p.setRevision('roads', 1); p.enqueue(request('a')); p.startNext(1); p.setRevision('roads', 2); expect(p.complete('a', 1, 2, 100, 2)).toBe(false); expect(p.snapshot().jobs).toBe(0)
  })

  it('expires queued work before scheduling', () => {
    const p = policy({ queueTtlMs: 5 }); p.setRevision('roads', 1); p.enqueue(request('a')); expect(p.startNext(5)).toBeNull(); expect(p.snapshot().jobs).toBe(0)
  })

  it('expires abandoned recovery leases before completion', () => {
    const p = policy({ recoveryLeaseMs: 5 }); p.setRevision('roads', 1); p.enqueue(request('a')); p.startNext(1); expect(p.complete('a', 1, 2, 100, 6)).toBe(false); expect(p.snapshot().jobs).toBe(0)
  })

  it('expires resident results at TTL boundary', () => {
    const p = policy({ residentTtlMs: 5 }); p.setRevision('roads', 1); p.enqueue(request('a')); p.startNext(1); p.complete('a', 1, 2, 100, 2); expect(p.expire(7)).toBe(1); expect(p.snapshot().resident).toBe(0)
  })

  it('requeues recoverable failures with a fresh queue lease', () => {
    const p = policy({ queueTtlMs: 10 }); p.setRevision('roads', 1); p.enqueue(request('a')); p.startNext(1); expect(p.fail('a', 2, true)).toBe(true); expect(p.snapshot()).toMatchObject({ queued: 1, recovering: 0 }); expect(p.startNext(3)?.jobId).toBe('a')
  })

  it('drops terminal failures', () => {
    const p = policy(); p.setRevision('roads', 1); p.enqueue(request('a')); p.startNext(1); expect(p.fail('a', 2, false)).toBe(true); expect(p.snapshot().jobs).toBe(0)
  })

  it('touch extends only resident lifetime', () => {
    const p = policy({ residentTtlMs: 5 }); p.setRevision('roads', 1); p.enqueue(request('a')); expect(p.touch('a', 1)).toBe(false); p.startNext(1); p.complete('a', 1, 2, 100, 2); expect(p.touch('a', 4)).toBe(true); expect(p.expire(8)).toBe(0); expect(p.expire(9)).toBe(1)
  })

  it('consume returns detached frozen scalar view and removes resident state', () => {
    const p = policy(); p.setRevision('roads', 1); p.enqueue(request('a')); p.startNext(1); p.complete('a', 1, 2, 100, 2); const view = p.consume('a'); expect(view).toMatchObject({ jobId: 'a', phase: 'resident' }); expect(Object.isFrozen(view)).toBe(true); expect(p.snapshot().jobs).toBe(0)
  })

  it('evicts lower-intent resident work under aggregate operation pressure', () => {
    const p = policy({ maxResidentOperations: 4, maxOperationsPerJob: 4, maxRecovering: 2, maxRecoveringPerLayer: 2 }); p.setRevision('roads', 1)
    p.enqueue({ ...request('bg', 'roads', 'background'), operationCount: 3 }); p.startNext(1); p.complete('bg', 1, 3, 100, 2)
    p.enqueue({ ...request('int', 'roads', 'interactive'), operationCount: 3, requestedAt: 3 }); p.startNext(4); expect(p.complete('int', 1, 3, 100, 5)).toBe(true); expect(p.fingerprint()).not.toContain(':bg:'); expect(p.fingerprint()).toContain(':int:')
  })

  it('evicts lower-intent resident work under aggregate byte pressure', () => {
    const p = policy({ maxResidentBytes: 200, maxBytesPerJob: 200, maxRecovering: 2, maxRecoveringPerLayer: 2 }); p.setRevision('roads', 1)
    p.enqueue({ ...request('bg', 'roads', 'background'), estimatedBytes: 150 }); p.startNext(1); p.complete('bg', 1, 2, 150, 2)
    p.enqueue({ ...request('vis', 'roads', 'visible'), estimatedBytes: 150, requestedAt: 3 }); p.startNext(4); expect(p.complete('vis', 1, 2, 150, 5)).toBe(true); expect(p.snapshot().residentBytes).toBe(150)
  })

  it('does not evict higher-intent resident work for lower-intent incoming work', () => {
    const p = policy({ maxResidentBytes: 150, maxBytesPerJob: 150, maxRecovering: 2, maxRecoveringPerLayer: 2 }); p.setRevision('roads', 1)
    p.enqueue({ ...request('int', 'roads', 'interactive'), estimatedBytes: 150 }); p.startNext(1); p.complete('int', 1, 2, 150, 2)
    p.enqueue({ ...request('bg', 'roads', 'background'), estimatedBytes: 150, requestedAt: 3 }); p.startNext(4); expect(p.complete('bg', 1, 2, 150, 5)).toBe(false); expect(p.fingerprint()).toContain(':int:'); expect(p.fingerprint()).not.toContain(':bg:')
  })

  it('uses LRU then sequence for same-intent pressure eviction', () => {
    const p = policy({ maxResidentBytes: 200, maxBytesPerJob: 200, maxRecovering: 3, maxRecoveringPerLayer: 3 }); p.setRevision('roads', 1)
    for (const id of ['a','b']) { p.enqueue({ ...request(id), estimatedBytes: 100 }); p.startNext(1); p.complete(id, 1, 2, 100, 2) }
    p.touch('b', 3); p.enqueue({ ...request('c'), estimatedBytes: 100, requestedAt: 4 }); p.startNext(5); p.complete('c', 1, 2, 100, 6); expect(p.fingerprint()).not.toContain(':a:'); expect(p.fingerprint()).toContain(':b:'); expect(p.fingerprint()).toContain(':c:')
  })

  it('cancel removes any phase safely', () => {
    const p = policy(); p.setRevision('roads', 1); p.enqueue(request('a')); expect(p.cancel('a')).toBe(true); expect(p.cancel('a')).toBe(false)
  })

  it('releaseLayer clears jobs and revision authority only for target layer', () => {
    const p = policy(); p.setRevision('roads', 1); p.setRevision('parks', 1); p.enqueue(request('a')); p.enqueue(request('b', 'parks')); expect(p.releaseLayer('roads')).toBe(1); expect(p.snapshot()).toMatchObject({ layers: 1, jobs: 1 }); expect(p.enqueue(request('c'))).toBe(false)
  })

  it('snapshot is frozen and payload-free', () => {
    const p = policy(); p.setRevision('roads', 1); p.enqueue(request('a')); const snapshot = p.snapshot(); expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.keys(snapshot).sort()).toEqual(['jobs','layers','queued','recovering','resident','residentBytes','residentOperations'].sort())
  })

  it('fingerprint is deterministic and contains only scalar governance metadata', () => {
    const a = policy(); const b = policy(); for (const p of [a,b]) { p.setRevision('roads', 1); p.enqueue(request('x')); p.enqueue(request('y', 'roads', 'background', 'manual', 1)) } expect(a.fingerprint()).toBe(b.fingerprint()); expect(a.fingerprint()).not.toContain('geometry'); expect(a.fingerprint()).not.toContain('token')
  })

  it('does not retain caller-owned request objects', () => {
    const p = policy(); p.setRevision('roads', 1); const r = request('a'); p.enqueue(r); r.jobId = 'mutated'; r.layerId = 'mutated'; expect(p.fingerprint()).toContain('roads:a:'); expect(p.fingerprint()).not.toContain('mutated')
  })

  it('dispose is idempotent and blocks subsequent authority use', () => {
    const p = policy(); p.setRevision('roads', 1); p.enqueue(request('a')); p.dispose(); p.dispose(); expect(() => p.snapshot()).toThrow('disposed'); expect(() => p.setRevision('roads', 2)).toThrow('disposed')
  })
})
