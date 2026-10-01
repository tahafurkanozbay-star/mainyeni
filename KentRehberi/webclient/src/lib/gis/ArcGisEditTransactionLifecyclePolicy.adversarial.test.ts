import { describe, expect, it } from 'vitest'
import {
  ArcGisEditTransactionLifecyclePolicy,
  type ArcGisEditTransactionBudget,
  type ArcGisEditTransactionRequest,
} from './ArcGisEditTransactionLifecyclePolicy'

const baseBudget: ArcGisEditTransactionBudget = {
  maxTransactions: 8,
  maxTransactionsPerLayer: 6,
  maxRunning: 3,
  maxCommitted: 4,
  maxOperationsPerTransaction: 100,
  maxAggregateOperations: 300,
  maxEstimatedBytesPerTransaction: 4_000,
  maxAggregateEstimatedBytes: 12_000,
  queueTtlMs: 100,
  runLeaseMs: 200,
  committedTtlMs: 300,
}

function edit(id: string, overrides: Partial<ArcGisEditTransactionRequest> = {}): ArcGisEditTransactionRequest {
  return {
    transactionId: id,
    layerId: 'assets',
    revision: 4,
    intent: 'user',
    requestedAt: 1_000,
    operationCount: 1,
    estimatedBytes: 128,
    operation: 'update',
    ...overrides,
  }
}

describe('ArcGisEditTransactionLifecyclePolicy adversarial boundaries', () => {
  it('never starts expired queued work', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('expired'))
    expect(policy.next(1_101)).toBeNull()
    expect(policy.snapshot().transactions).toBe(0)
  })

  it('frees running capacity when an abandoned lease expires', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy({ ...baseBudget, maxRunning: 1 })
    policy.admit(edit('abandoned'))
    policy.admit(edit('next'))
    expect(policy.next(1_010)?.transactionId).toBe('abandoned')
    expect(policy.next(1_211)?.transactionId).toBe('next')
  })

  it('does not allow a late completion to resurrect expired work', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('late'))
    policy.next(1_010)
    policy.expire(1_211)
    expect(policy.commit('late', 4, 1_212)).toBe(false)
    expect(policy.snapshot().transactions).toBe(0)
  })

  it('does not allow old completion after authoritative revision advance', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('old'))
    policy.next(1_010)
    expect(policy.invalidateLayer('assets', 5)).toBe(1)
    expect(policy.commit('old', 4, 1_020)).toBe(false)
  })

  it('isolates revision invalidation between layers', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('asset'))
    policy.admit(edit('road', { layerId: 'roads', revision: 2 }))
    expect(policy.invalidateLayer('assets', 5)).toBe(1)
    expect(policy.entriesForLayer('roads').map(item => item.transactionId)).toEqual(['road'])
  })

  it('keeps aggregate accounting exact after cancellation', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('a', { operationCount: 20, estimatedBytes: 900 }))
    policy.admit(edit('b', { operationCount: 30, estimatedBytes: 1_100 }))
    expect(policy.cancel('a')).toBe(true)
    expect(policy.snapshot()).toEqual({ transactions: 1, queued: 1, running: 0, committed: 0, operations: 30, estimatedBytes: 1_100 })
  })

  it('keeps aggregate accounting exact after layer release', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('a', { operationCount: 20, estimatedBytes: 900 }))
    policy.admit(edit('b', { layerId: 'roads', revision: 1, operationCount: 30, estimatedBytes: 1_100 }))
    expect(policy.releaseLayer('assets')).toBe(1)
    expect(policy.snapshot()).toEqual({ transactions: 1, queued: 1, running: 0, committed: 0, operations: 30, estimatedBytes: 1_100 })
  })

  it('keeps aggregate accounting exact after committed consumption', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('a', { operationCount: 20, estimatedBytes: 900 }))
    policy.next(1_010)
    policy.commit('a', 4, 1_020)
    policy.consume('a', 4)
    expect(policy.snapshot()).toEqual({ transactions: 0, queued: 0, running: 0, committed: 0, operations: 0, estimatedBytes: 0 })
  })

  it('allows released capacity to be reused', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy({ ...baseBudget, maxTransactions: 1, maxTransactionsPerLayer: 1 })
    expect(policy.admit(edit('first'))).toBe(true)
    expect(policy.admit(edit('blocked', { layerId: 'roads' }))).toBe(false)
    expect(policy.cancel('first')).toBe(true)
    expect(policy.admit(edit('replacement', { layerId: 'roads', revision: 1 }))).toBe(true)
  })

  it('priority promotion does not inflate aggregate operations', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy({ ...baseBudget, maxAggregateOperations: 10 })
    expect(policy.admit(edit('same', { intent: 'background', operationCount: 10 }))).toBe(true)
    expect(policy.admit(edit('same', { intent: 'critical', operationCount: 10 }))).toBe(true)
    expect(policy.snapshot().operations).toBe(10)
  })

  it('priority promotion can lower reserved bytes', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('same', { intent: 'background', estimatedBytes: 2_000 }))
    policy.admit(edit('same', { intent: 'critical', estimatedBytes: 500 }))
    expect(policy.snapshot().estimatedBytes).toBe(500)
  })

  it('priority promotion cannot bypass aggregate byte budget', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy({ ...baseBudget, maxAggregateEstimatedBytes: 4_000 })
    policy.admit(edit('same', { intent: 'background', estimatedBytes: 1_000 }))
    policy.admit(edit('other', { estimatedBytes: 2_500 }))
    expect(policy.admit(edit('same', { intent: 'critical', estimatedBytes: 2_000 }))).toBe(false)
    expect(policy.snapshot().estimatedBytes).toBe(3_500)
  })

  it('running work cannot be replaced by duplicate admission', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('same', { intent: 'background' }))
    policy.next(1_010)
    expect(policy.admit(edit('same', { intent: 'critical' }))).toBe(false)
    expect(policy.snapshot().running).toBe(1)
  })

  it('committed work cannot be replaced by duplicate admission', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('same'))
    policy.next(1_010)
    policy.commit('same', 4, 1_020)
    expect(policy.admit(edit('same', { intent: 'critical' }))).toBe(false)
    expect(policy.snapshot().committed).toBe(1)
  })

  it('different operation kinds remain visible in deterministic fingerprint', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('add', { operation: 'add' }))
    policy.admit(edit('delete', { operation: 'delete' }))
    expect(policy.fingerprint()).toContain(':add:')
    expect(policy.fingerprint()).toContain(':delete:')
  })

  it('fingerprint reflects lifecycle phase without payload content', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('phase'))
    const queued = policy.fingerprint()
    policy.next(1_010)
    const running = policy.fingerprint()
    policy.commit('phase', 4, 1_020)
    const committed = policy.fingerprint()
    expect(queued).not.toBe(running)
    expect(running).not.toBe(committed)
    expect(committed).toContain(':committed:')
  })

  it('snapshot and views expose no caller payload field', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('safe'))
    const serialized = JSON.stringify({ snapshot: policy.snapshot(), entries: policy.entriesForLayer('assets') })
    expect(serialized).not.toContain('geometry')
    expect(serialized).not.toContain('attributes')
    expect(serialized).not.toContain('credential')
    expect(serialized).not.toContain('abort')
  })

  it('rejects infinite timestamps at every public time boundary', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    expect(() => policy.admit(edit('bad', { requestedAt: Number.POSITIVE_INFINITY }))).toThrow(/requestedAt/)
    expect(() => policy.next(Number.POSITIVE_INFINITY)).toThrow(/now/)
    expect(() => policy.expire(Number.POSITIVE_INFINITY)).toThrow(/now/)
  })

  it('rejects fractional count metadata', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    expect(() => policy.admit(edit('fractional-op', { operationCount: 1.5 }))).toThrow(/operationCount/)
    expect(() => policy.admit(edit('fractional-bytes', { estimatedBytes: 1.5 }))).toThrow(/estimatedBytes/)
  })

  it('rejects oversized identifiers before allocating entries', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    expect(() => policy.admit(edit('x'.repeat(257)))).toThrow(/transactionId/)
    expect(policy.snapshot().transactions).toBe(0)
  })

  it('dispose clears state before making the authority inert', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(baseBudget)
    policy.admit(edit('a'))
    policy.admit(edit('b', { layerId: 'roads', revision: 1 }))
    policy.dispose()
    expect(() => policy.entriesForLayer('assets')).toThrow(/disposed/)
    expect(() => policy.fingerprint()).toThrow(/disposed/)
  })
})
