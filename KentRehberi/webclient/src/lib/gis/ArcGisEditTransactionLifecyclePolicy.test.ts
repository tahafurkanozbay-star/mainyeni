import { describe, expect, it } from 'vitest'
import { ArcGisEditTransactionLifecyclePolicy, type EditTransactionBudget, type EditTransactionIntent } from './ArcGisEditTransactionLifecyclePolicy'

const budget: EditTransactionBudget = {
  maxLayers: 4,
  maxTransactions: 8,
  maxTransactionsPerLayer: 4,
  maxPreparing: 2,
  maxPreparingPerLayer: 1,
  maxCommitting: 2,
  maxCommittingPerLayer: 1,
  maxResident: 3,
  maxResidentPerLayer: 2,
  maxOperationsPerTransaction: 20,
  maxBytesPerTransaction: 2_000,
  maxResidentOperations: 30,
  maxResidentBytes: 3_000,
  queueTtlMs: 100,
  prepareLeaseMs: 20,
  preparedTtlMs: 80,
  commitLeaseMs: 20,
  residentTtlMs: 200,
}

function policy(overrides: Partial<EditTransactionBudget> = {}) {
  return new ArcGisEditTransactionLifecyclePolicy({ ...budget, ...overrides })
}
function admit(p: ArcGisEditTransactionLifecyclePolicy, transactionId: string, layerId = 'roads', revision = 1, intent: EditTransactionIntent = 'visible', operationCount = 2, estimatedBytes = 100, requestedAt = 0) {
  return p.admit({ transactionId, layerId, revision, intent, operationCount, estimatedBytes, requestedAt })
}
function resident(p: ArcGisEditTransactionLifecyclePolicy, id: string, now = 1, operations = 2, bytes = 100) {
  expect(p.startPrepare(now)?.transactionId).toBe(id)
  expect(p.finishPrepare(id, 1, operations, bytes, now + 1)).toBe(true)
  expect(p.startCommit(now + 2)?.transactionId).toBe(id)
  expect(p.finishCommit(id, 1, now + 3)).toBe(true)
}

describe('ArcGisEditTransactionLifecyclePolicy', () => {
  it('rejects incoherent cardinality budgets', () => {
    expect(() => policy({ maxTransactionsPerLayer: 9 })).toThrow(/maxTransactionsPerLayer/)
    expect(() => policy({ maxPreparingPerLayer: 3 })).toThrow(/maxPreparingPerLayer/)
    expect(() => policy({ maxCommittingPerLayer: 3 })).toThrow(/maxCommittingPerLayer/)
    expect(() => policy({ maxResidentPerLayer: 4 })).toThrow(/maxResidentPerLayer/)
    expect(() => policy({ maxOperationsPerTransaction: 31 })).toThrow(/maxOperationsPerTransaction/)
    expect(() => policy({ maxBytesPerTransaction: 3_001 })).toThrow(/maxBytesPerTransaction/)
  })

  it.each([
    ['maxLayers', 0], ['maxTransactions', 0], ['maxTransactionsPerLayer', 0], ['maxPreparing', 0],
    ['maxPreparingPerLayer', 0], ['maxCommitting', 0], ['maxCommittingPerLayer', 0], ['maxResident', 0],
    ['maxResidentPerLayer', 0], ['maxOperationsPerTransaction', 0], ['maxBytesPerTransaction', 0],
    ['maxResidentOperations', 0], ['maxResidentBytes', 0],
  ] as const)('rejects invalid positive integer budget %s', (key, value) => {
    expect(() => policy({ [key]: value })).toThrow()
  })

  it.each(['queueTtlMs','prepareLeaseMs','preparedTtlMs','commitLeaseMs','residentTtlMs'] as const)('rejects invalid finite duration %s', key => {
    expect(() => policy({ [key]: Number.NaN })).toThrow()
    expect(() => policy({ [key]: -1 })).toThrow()
  })

  it('requires a revision authority before admission', () => {
    const p = policy()
    expect(admit(p, 'tx')).toBe(false)
    expect(p.snapshot()).toEqual({ layers: 0, transactions: 0, queued: 0, preparing: 0, prepared: 0, committing: 0, resident: 0, residentOperations: 0, residentBytes: 0 })
  })

  it('bounds revision cardinality and rejects rollback', () => {
    const p = policy({ maxLayers: 2 })
    expect(p.setRevision('a', 2)).toBe(0)
    expect(p.setRevision('b', 1)).toBe(0)
    expect(p.setRevision('c', 1)).toBe(-1)
    expect(p.setRevision('a', 1)).toBe(-1)
    expect(p.snapshot().layers).toBe(2)
  })

  it('invalidates all stale phases on monotonic revision advance', () => {
    const p = policy(); p.setRevision('roads', 1)
    admit(p, 'queued'); admit(p, 'preparing'); admit(p, 'prepared'); admit(p, 'committing')
    p.startPrepare(1)
    expect(p.finishPrepare('preparing', 1, 2, 100, 2)).toBe(true)
    p.startPrepare(3)
    expect(p.finishPrepare('prepared', 1, 2, 100, 4)).toBe(true)
    expect(p.startCommit(5)?.transactionId).toBe('preparing')
    expect(p.setRevision('roads', 2)).toBe(4)
    expect(p.snapshot().transactions).toBe(0)
  })

  it('normalizes identifiers and rejects unsafe identifiers', () => {
    const p = policy(); p.setRevision(' roads ', 1)
    expect(admit(p, ' tx ', ' roads ')).toBe(true)
    expect(p.fingerprint()).toContain('roads:tx:1')
    expect(() => admit(p, '\u0000bad')).toThrow(/safe characters/)
    expect(() => p.setRevision('x'.repeat(193), 1)).toThrow(/safe characters/)
  })

  it('rejects invalid request scalar values', () => {
    const p = policy(); p.setRevision('roads', 1)
    expect(() => admit(p, 'a', 'roads', 1, 'visible', 0)).toThrow(/operationCount/)
    expect(() => admit(p, 'b', 'roads', 1, 'visible', 1, 0)).toThrow(/estimatedBytes/)
    expect(() => admit(p, 'c', 'roads', 1, 'visible', 1, 1, Number.NaN)).toThrow(/requestedAt/)
    expect(() => p.admit({ transactionId: 'd', layerId: 'roads', revision: 1, intent: 'other' as EditTransactionIntent, operationCount: 1, estimatedBytes: 1, requestedAt: 0 })).toThrow(/intent/)
  })

  it('rejects oversized requests without mutating authority', () => {
    const p = policy(); p.setRevision('roads', 1)
    expect(admit(p, 'ops', 'roads', 1, 'visible', 21, 1)).toBe(false)
    expect(admit(p, 'bytes', 'roads', 1, 'visible', 1, 2_001)).toBe(false)
    expect(p.snapshot().transactions).toBe(0)
  })

  it('bounds global and per-layer transaction cardinality', () => {
    const p = policy({ maxTransactions: 3, maxTransactionsPerLayer: 2 }); p.setRevision('a', 1); p.setRevision('b', 1)
    expect(admit(p, 'a1', 'a')).toBe(true); expect(admit(p, 'a2', 'a')).toBe(true)
    expect(admit(p, 'a3', 'a')).toBe(false); expect(admit(p, 'b1', 'b')).toBe(true); expect(admit(p, 'b2', 'b')).toBe(false)
  })

  it('rejects duplicate transaction ids across layers', () => {
    const p = policy(); p.setRevision('a', 1); p.setRevision('b', 1)
    expect(admit(p, 'same', 'a')).toBe(true)
    expect(admit(p, 'same', 'b')).toBe(false)
  })

  it('schedules prepare by intent then FIFO sequence', () => {
    const p = policy(); p.setRevision('a', 1); p.setRevision('b', 1); p.setRevision('c', 1)
    admit(p, 'bg', 'a', 1, 'background'); admit(p, 'v1', 'b', 1, 'visible'); admit(p, 'i1', 'c', 1, 'interactive'); admit(p, 'i2', 'a', 1, 'interactive')
    expect(p.startPrepare(1)?.transactionId).toBe('i1')
    expect(p.startPrepare(2)?.transactionId).toBe('i2')
  })

  it('enforces global prepare concurrency', () => {
    const p = policy({ maxPreparing: 1 }); p.setRevision('a', 1); p.setRevision('b', 1); admit(p, 'a', 'a'); admit(p, 'b', 'b')
    expect(p.startPrepare(1)?.transactionId).toBe('a')
    expect(p.startPrepare(2)).toBeNull()
  })

  it('enforces per-layer prepare concurrency while allowing another layer', () => {
    const p = policy({ maxPreparing: 2, maxPreparingPerLayer: 1 }); p.setRevision('a', 1); p.setRevision('b', 1)
    admit(p, 'a1', 'a'); admit(p, 'a2', 'a'); admit(p, 'b1', 'b')
    expect(p.startPrepare(1)?.transactionId).toBe('a1')
    expect(p.startPrepare(2)?.transactionId).toBe('b1')
  })

  it('reconciles estimate to actual at prepare completion', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx', 'roads', 1, 'visible', 2, 100)
    p.startPrepare(1)
    expect(p.finishPrepare('tx', 1, 9, 900, 2)).toBe(true)
    expect(p.fingerprint()).toContain(':9:900:')
  })

  it('rejects oversized actual prepare results and drops transaction', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); p.startPrepare(1)
    expect(p.finishPrepare('tx', 1, 21, 100, 2)).toBe(false)
    expect(p.snapshot().transactions).toBe(0)
  })

  it('rejects stale prepare completion after revision advance', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); p.startPrepare(1); p.setRevision('roads', 2)
    expect(p.finishPrepare('tx', 1, 2, 100, 2)).toBe(false)
  })

  it('schedules prepared commits by intent and sequence', () => {
    const p = policy(); p.setRevision('a', 1); p.setRevision('b', 1)
    admit(p, 'bg', 'a', 1, 'background'); admit(p, 'interactive', 'b', 1, 'interactive')
    p.startPrepare(1); p.finishPrepare('interactive', 1, 2, 100, 2)
    p.startPrepare(3); p.finishPrepare('bg', 1, 2, 100, 4)
    expect(p.startCommit(5)?.transactionId).toBe('interactive')
  })

  it('enforces commit concurrency independently from prepare concurrency', () => {
    const p = policy({ maxCommitting: 1 }); p.setRevision('a', 1); p.setRevision('b', 1)
    admit(p, 'a', 'a'); admit(p, 'b', 'b'); p.startPrepare(1); p.finishPrepare('a', 1, 2, 100, 2); p.startPrepare(3); p.finishPrepare('b', 1, 2, 100, 4)
    expect(p.startCommit(5)?.transactionId).toBe('a'); expect(p.startCommit(6)).toBeNull()
  })

  it('moves a committed transaction into resident authority', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); resident(p, 'tx')
    expect(p.snapshot()).toMatchObject({ transactions: 1, resident: 1, residentOperations: 2, residentBytes: 100 })
  })

  it('rejects stale commit completion', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); p.startPrepare(1); p.finishPrepare('tx', 1, 2, 100, 2); p.startCommit(3); p.setRevision('roads', 2)
    expect(p.finishCommit('tx', 1, 4)).toBe(false)
  })

  it('retries prepare failure without changing revision or payload authority', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); expect(p.startPrepare(1)?.attempt).toBe(1)
    expect(p.retry('tx', 2)).toBe(true); expect(p.startPrepare(3)?.attempt).toBe(2)
  })

  it('retries prepared and committing transactions', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); p.startPrepare(1); p.finishPrepare('tx', 1, 2, 100, 2)
    expect(p.retry('tx', 3)).toBe(true); p.startPrepare(4); p.finishPrepare('tx', 1, 2, 100, 5); p.startCommit(6)
    expect(p.retry('tx', 7)).toBe(true); expect(p.snapshot().queued).toBe(1)
  })

  it('does not retry resident transactions', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); resident(p, 'tx')
    expect(p.retry('tx', 10)).toBe(false)
  })

  it('expires queued work at queue ttl boundary', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx', 'roads', 1, 'visible', 2, 100, 5)
    expect(p.expire(104)).toBe(0); expect(p.expire(105)).toBe(1)
  })

  it('expires abandoned prepare leases', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); p.startPrepare(10)
    expect(p.expire(29)).toBe(0); expect(p.expire(30)).toBe(1)
  })

  it('expires prepared work independently', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); p.startPrepare(1); p.finishPrepare('tx', 1, 2, 100, 2)
    expect(p.expire(81)).toBe(0); expect(p.expire(82)).toBe(1)
  })

  it('expires abandoned commit leases', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); p.startPrepare(1); p.finishPrepare('tx', 1, 2, 100, 2); p.startCommit(3)
    expect(p.expire(22)).toBe(0); expect(p.expire(23)).toBe(1)
  })

  it('touch extends only resident ttl', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); resident(p, 'tx', 1)
    expect(p.touch('tx', 100)).toBe(true); expect(p.expire(299)).toBe(0); expect(p.expire(300)).toBe(1)
  })

  it('touch rejects queued and unknown transactions', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx')
    expect(p.touch('tx', 1)).toBe(false); expect(p.touch('missing', 1)).toBe(false)
  })

  it('evicts lower intent resident work for higher intent commit', () => {
    const p = policy({ maxResident: 1, maxResidentPerLayer: 1 }); p.setRevision('roads', 1)
    admit(p, 'background', 'roads', 1, 'background'); resident(p, 'background')
    admit(p, 'interactive', 'roads', 1, 'interactive'); resident(p, 'interactive', 10)
    expect(p.fingerprint()).toContain('interactive'); expect(p.fingerprint()).not.toContain('background')
  })

  it('does not evict higher intent resident work for background commit', () => {
    const p = policy({ maxResident: 1, maxResidentPerLayer: 1 }); p.setRevision('roads', 1)
    admit(p, 'interactive', 'roads', 1, 'interactive'); resident(p, 'interactive')
    admit(p, 'background', 'roads', 1, 'background'); p.startPrepare(10); p.finishPrepare('background', 1, 2, 100, 11); p.startCommit(12)
    expect(p.finishCommit('background', 1, 13)).toBe(false); expect(p.fingerprint()).toContain('interactive')
  })

  it('evicts least recently touched same-intent resident work', () => {
    const p = policy({ maxResident: 2, maxResidentPerLayer: 2 }); p.setRevision('a', 1); p.setRevision('b', 1)
    admit(p, 'old', 'a'); resident(p, 'old', 1); admit(p, 'recent', 'b'); resident(p, 'recent', 10); p.touch('recent', 50)
    admit(p, 'incoming', 'a'); resident(p, 'incoming', 60)
    expect(p.fingerprint()).not.toContain(':old:'); expect(p.fingerprint()).toContain(':recent:'); expect(p.fingerprint()).toContain(':incoming:')
  })

  it('enforces aggregate resident operation pressure', () => {
    const p = policy({ maxResidentOperations: 5, maxOperationsPerTransaction: 5 }); p.setRevision('a', 1); p.setRevision('b', 1)
    admit(p, 'a', 'a', 1, 'background'); resident(p, 'a', 1, 4, 100)
    admit(p, 'b', 'b', 1, 'interactive'); resident(p, 'b', 10, 4, 100)
    expect(p.snapshot().residentOperations).toBe(4); expect(p.fingerprint()).not.toContain('a:a:')
  })

  it('enforces aggregate resident byte pressure', () => {
    const p = policy({ maxResidentBytes: 500, maxBytesPerTransaction: 500 }); p.setRevision('a', 1); p.setRevision('b', 1)
    admit(p, 'a', 'a', 1, 'background'); resident(p, 'a', 1, 2, 400)
    admit(p, 'b', 'b', 1, 'interactive'); resident(p, 'b', 10, 2, 400)
    expect(p.snapshot().residentBytes).toBe(400); expect(p.fingerprint()).not.toContain('a:a:')
  })

  it('consume is revision-scoped and removes resident authority', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); resident(p, 'tx')
    expect(p.consume('tx', 2)).toBeNull(); expect(p.consume('tx', 1)?.transactionId).toBe('tx'); expect(p.snapshot().transactions).toBe(0)
  })

  it('cancel removes any active transaction', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); expect(p.cancel('tx')).toBe(true); expect(p.cancel('tx')).toBe(false)
  })

  it('releaseLayer clears revision and every phase for that layer only', () => {
    const p = policy(); p.setRevision('a', 1); p.setRevision('b', 1); admit(p, 'a1', 'a'); admit(p, 'b1', 'b')
    expect(p.releaseLayer('a')).toBe(1); expect(p.snapshot()).toMatchObject({ layers: 1, transactions: 1 })
    expect(admit(p, 'a2', 'a')).toBe(false)
  })

  it('snapshot is frozen and contains only scalar aggregate authority', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx')
    const snapshot = p.snapshot(); expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.keys(snapshot).sort()).toEqual(['committing','layers','prepared','preparing','queued','resident','residentBytes','residentOperations','transactions'].sort())
  })

  it('views are frozen scalar records', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); const view = p.startPrepare(1)!
    expect(Object.isFrozen(view)).toBe(true); expect(Object.keys(view).sort()).toEqual(['attempt','bytes','expiresAt','intent','layerId','operationCount','phase','revision','sequence','touchedAt','transactionId'].sort())
  })

  it('fingerprint is deterministic independent of admission order across layers', () => {
    const a = policy(); const b = policy(); for (const p of [a,b]) { p.setRevision('a', 1); p.setRevision('b', 1) }
    admit(a, 'z', 'b'); admit(a, 'x', 'a'); admit(b, 'x', 'a'); admit(b, 'z', 'b')
    expect(a.fingerprint()).toBe(b.fingerprint())
  })

  it('fingerprint never serializes caller payload graphs because admission accepts metadata only', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx')
    const fingerprint = p.fingerprint(); expect(fingerprint).not.toContain('geometry'); expect(fingerprint).not.toContain('attributes'); expect(fingerprint).not.toContain('token')
  })

  it('dispose is idempotent and terminal', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx'); p.dispose(); p.dispose()
    expect(() => p.snapshot()).toThrow(/disposed/); expect(() => p.setRevision('roads', 2)).toThrow(/disposed/)
  })

  it('finite validation protects lifecycle clock operations', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx')
    expect(() => p.startPrepare(Number.NaN)).toThrow(/now/); expect(() => p.expire(-1)).toThrow(/now/); expect(() => p.touch('tx', Number.POSITIVE_INFINITY)).toThrow(/now/)
  })

  it('full transaction preserves reconciled scalar metadata through consume', () => {
    const p = policy(); p.setRevision('roads', 1); admit(p, 'tx', 'roads', 1, 'interactive', 3, 200, 10)
    expect(p.startPrepare(11)).toMatchObject({ phase: 'preparing', attempt: 1 })
    expect(p.finishPrepare('tx', 1, 7, 700, 12)).toBe(true)
    expect(p.startCommit(13)).toMatchObject({ phase: 'committing', operationCount: 7, bytes: 700, attempt: 2 })
    expect(p.finishCommit('tx', 1, 14)).toBe(true)
    expect(p.consume('tx', 1)).toMatchObject({ phase: 'resident', operationCount: 7, bytes: 700, attempt: 2 })
  })
})
