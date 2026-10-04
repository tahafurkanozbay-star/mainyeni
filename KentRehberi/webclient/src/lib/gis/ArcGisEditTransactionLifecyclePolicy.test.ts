import { describe, expect, it } from 'vitest'
import {
  ArcGisEditTransactionLifecyclePolicy,
  type ArcGisEditTransactionBudget,
  type ArcGisEditTransactionRequest,
} from './ArcGisEditTransactionLifecyclePolicy'

const budget: ArcGisEditTransactionBudget = {
  maxTransactions: 6,
  maxTransactionsPerLayer: 4,
  maxRunning: 2,
  maxCommitted: 3,
  maxOperationsPerTransaction: 50,
  maxAggregateOperations: 120,
  maxEstimatedBytesPerTransaction: 2_000,
  maxAggregateEstimatedBytes: 6_000,
  queueTtlMs: 100,
  runLeaseMs: 200,
  committedTtlMs: 300,
}

function request(overrides: Partial<ArcGisEditTransactionRequest> = {}): ArcGisEditTransactionRequest {
  return {
    transactionId: 'tx-a',
    layerId: 'parcels',
    revision: 1,
    intent: 'user',
    requestedAt: 10,
    operationCount: 10,
    estimatedBytes: 500,
    operation: 'update',
    ...overrides,
  }
}

describe('ArcGisEditTransactionLifecyclePolicy', () => {
  it('admits payload-free bounded transaction metadata', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    expect(policy.admit(request())).toBe(true)
    expect(policy.snapshot()).toEqual({ transactions: 1, queued: 1, running: 0, committed: 0, operations: 10, estimatedBytes: 500 })
    expect(policy.entriesForLayer('parcels')).toEqual([
      expect.objectContaining({ transactionId: 'tx-a', phase: 'queued', operation: 'update' }),
    ])
  })

  it('rejects per-transaction operation overflow', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    expect(policy.admit(request({ operationCount: 51 }))).toBe(false)
    expect(policy.snapshot().transactions).toBe(0)
  })

  it('rejects per-transaction estimated byte overflow', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    expect(policy.admit(request({ estimatedBytes: 2_001 }))).toBe(false)
    expect(policy.snapshot().transactions).toBe(0)
  })

  it('enforces global transaction cardinality', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy({ ...budget, maxTransactions: 2, maxTransactionsPerLayer: 2 })
    expect(policy.admit(request({ transactionId: 'a' }))).toBe(true)
    expect(policy.admit(request({ transactionId: 'b' }))).toBe(true)
    expect(policy.admit(request({ transactionId: 'c', layerId: 'roads' }))).toBe(false)
  })

  it('enforces per-layer transaction cardinality', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy({ ...budget, maxTransactionsPerLayer: 1 })
    expect(policy.admit(request({ transactionId: 'a' }))).toBe(true)
    expect(policy.admit(request({ transactionId: 'b' }))).toBe(false)
    expect(policy.admit(request({ transactionId: 'c', layerId: 'roads' }))).toBe(true)
  })

  it('enforces aggregate operation budget', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy({ ...budget, maxAggregateOperations: 50 })
    expect(policy.admit(request({ transactionId: 'a', operationCount: 30 }))).toBe(true)
    expect(policy.admit(request({ transactionId: 'b', operationCount: 21 }))).toBe(false)
  })

  it('enforces aggregate estimated byte budget', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy({ ...budget, maxAggregateEstimatedBytes: 2_500 })
    expect(policy.admit(request({ transactionId: 'a', estimatedBytes: 1_500 }))).toBe(true)
    expect(policy.admit(request({ transactionId: 'b', estimatedBytes: 1_001 }))).toBe(false)
  })

  it('schedules critical before user before background', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request({ transactionId: 'background', intent: 'background' }))
    policy.admit(request({ transactionId: 'user', intent: 'user' }))
    policy.admit(request({ transactionId: 'critical', intent: 'critical' }))
    expect(policy.next(20)?.transactionId).toBe('critical')
    expect(policy.next(20)?.transactionId).toBe('user')
  })

  it('preserves FIFO order within equal priority', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request({ transactionId: 'first' }))
    policy.admit(request({ transactionId: 'second' }))
    expect(policy.next(20)?.transactionId).toBe('first')
    expect(policy.next(20)?.transactionId).toBe('second')
  })

  it('bounds concurrent running transactions', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy({ ...budget, maxRunning: 1 })
    policy.admit(request({ transactionId: 'a' }))
    policy.admit(request({ transactionId: 'b' }))
    expect(policy.next(20)?.transactionId).toBe('a')
    expect(policy.next(21)).toBeNull()
  })

  it('commits a live running transaction', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    expect(policy.commit('tx-a', 1, 30)).toBe(true)
    expect(policy.snapshot()).toEqual({ transactions: 1, queued: 0, running: 0, committed: 1, operations: 10, estimatedBytes: 500 })
  })

  it('rejects commit for queued transaction', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.commit('tx-a', 1, 30)).toBe(false)
  })

  it('rejects stale revision commit', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    expect(policy.commit('tx-a', 2, 30)).toBe(false)
  })

  it('rejects completion after run lease expiry', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    expect(policy.commit('tx-a', 1, 221)).toBe(false)
  })

  it('bounds committed transaction residency', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy({ ...budget, maxCommitted: 1, maxRunning: 2 })
    policy.admit(request({ transactionId: 'a' }))
    policy.admit(request({ transactionId: 'b' }))
    policy.next(20)
    policy.next(20)
    expect(policy.commit('a', 1, 30)).toBe(true)
    expect(policy.commit('b', 1, 30)).toBe(false)
  })

  it('consumes committed metadata exactly once', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    policy.commit('tx-a', 1, 30)
    expect(policy.consume('tx-a', 1)).toBe(true)
    expect(policy.consume('tx-a', 1)).toBe(false)
    expect(policy.snapshot().transactions).toBe(0)
  })

  it('does not consume committed metadata using wrong revision', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    policy.commit('tx-a', 1, 30)
    expect(policy.consume('tx-a', 2)).toBe(false)
    expect(policy.snapshot().committed).toBe(1)
  })

  it('cancels queued transactions', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.cancel('tx-a')).toBe(true)
    expect(policy.snapshot().transactions).toBe(0)
  })

  it('cancels running transactions', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    expect(policy.cancel('tx-a')).toBe(true)
  })

  it('does not cancel committed transactions', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    policy.commit('tx-a', 1, 30)
    expect(policy.cancel('tx-a')).toBe(false)
  })

  it('advancing layer revision invalidates older metadata', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request({ transactionId: 'old-a' }))
    policy.admit(request({ transactionId: 'old-b' }))
    expect(policy.invalidateLayer('parcels', 2)).toBe(2)
    expect(policy.snapshot().transactions).toBe(0)
  })

  it('admitting newer revision invalidates older layer work', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request({ transactionId: 'old' }))
    expect(policy.admit(request({ transactionId: 'new', revision: 2 }))).toBe(true)
    expect(policy.entriesForLayer('parcels').map(entry => entry.transactionId)).toEqual(['new'])
  })

  it('rejects requests older than layer revision watermark', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request({ transactionId: 'new', revision: 3 }))
    expect(policy.admit(request({ transactionId: 'old', revision: 2 }))).toBe(false)
  })

  it('does not roll back a layer watermark', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request({ revision: 3 }))
    expect(policy.invalidateLayer('parcels', 2)).toBe(0)
    expect(policy.admit(request({ transactionId: 'old', revision: 2 }))).toBe(false)
  })

  it('releaseLayer removes only target layer metadata and watermark', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request({ transactionId: 'parcel' }))
    policy.admit(request({ transactionId: 'road', layerId: 'roads' }))
    expect(policy.releaseLayer('parcels')).toBe(1)
    expect(policy.snapshot().transactions).toBe(1)
    expect(policy.admit(request({ transactionId: 'parcel-old', revision: 0 }))).toBe(true)
  })

  it('expires queued metadata after queue ttl', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.expire(111)).toBe(1)
    expect(policy.snapshot().transactions).toBe(0)
  })

  it('keeps metadata at exact ttl boundary', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.expire(110)).toBe(0)
  })

  it('expires running metadata after lease', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    expect(policy.expire(221)).toBe(1)
  })

  it('expires committed metadata after residency ttl', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    policy.commit('tx-a', 1, 30)
    expect(policy.expire(331)).toBe(1)
  })

  it('dedupes identical queued transaction while allowing priority promotion', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'background' }))).toBe(true)
    expect(policy.admit(request({ intent: 'critical', estimatedBytes: 700 }))).toBe(true)
    expect(policy.snapshot()).toEqual({ transactions: 1, queued: 1, running: 0, committed: 0, operations: 10, estimatedBytes: 700 })
    expect(policy.next(20)?.intent).toBe('critical')
  })

  it('rejects priority downgrade for duplicate queued transaction', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'critical' }))).toBe(true)
    expect(policy.admit(request({ intent: 'background' }))).toBe(false)
  })

  it('rejects transaction id collision across layers', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    expect(policy.admit(request())).toBe(true)
    expect(policy.admit(request({ layerId: 'roads' }))).toBe(false)
  })

  it('rejects transaction id collision across operation kinds', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    expect(policy.admit(request({ operation: 'update' }))).toBe(true)
    expect(policy.admit(request({ operation: 'delete' }))).toBe(false)
  })

  it('produces deterministic fingerprint independent of insertion order', () => {
    const first = new ArcGisEditTransactionLifecyclePolicy(budget)
    const second = new ArcGisEditTransactionLifecyclePolicy(budget)
    first.admit(request({ transactionId: 'b', layerId: 'roads' }))
    first.admit(request({ transactionId: 'a', layerId: 'parcels' }))
    second.admit(request({ transactionId: 'a', layerId: 'parcels' }))
    second.admit(request({ transactionId: 'b', layerId: 'roads' }))
    expect(first.fingerprint()).toBe(second.fingerprint())
  })

  it('returns immutable layer views', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    const entries = policy.entriesForLayer('parcels')
    expect(Object.isFrozen(entries)).toBe(true)
    expect(Object.isFrozen(entries[0])).toBe(true)
  })

  it('trims identifiers and uses normalized keys', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    expect(policy.admit(request({ transactionId: ' tx-a ', layerId: ' parcels ' }))).toBe(true)
    expect(policy.entriesForLayer('parcels')[0]?.transactionId).toBe('tx-a')
  })

  it('rejects empty identifiers', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    expect(() => policy.admit(request({ transactionId: '   ' }))).toThrow(/transactionId/)
    expect(() => policy.admit(request({ layerId: '   ' }))).toThrow(/layerId/)
  })

  it('rejects delimiter-bearing identifiers', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    expect(() => policy.admit(request({ transactionId: 'bad\u0000id' }))).toThrow(/transactionId/)
  })

  it('rejects invalid numeric request metadata', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    expect(() => policy.admit(request({ revision: -1 }))).toThrow(/revision/)
    expect(() => policy.admit(request({ requestedAt: Number.NaN }))).toThrow(/requestedAt/)
    expect(() => policy.admit(request({ operationCount: 0 }))).toThrow(/operationCount/)
    expect(() => policy.admit(request({ estimatedBytes: -1 }))).toThrow(/estimatedBytes/)
  })

  it('rejects inconsistent constructor budgets', () => {
    expect(() => new ArcGisEditTransactionLifecyclePolicy({ ...budget, maxTransactionsPerLayer: 7 })).toThrow(/maxTransactionsPerLayer/)
    expect(() => new ArcGisEditTransactionLifecyclePolicy({ ...budget, maxRunning: 7 })).toThrow(/phase limits/)
    expect(() => new ArcGisEditTransactionLifecyclePolicy({ ...budget, maxOperationsPerTransaction: 121 })).toThrow(/operation budget/)
    expect(() => new ArcGisEditTransactionLifecyclePolicy({ ...budget, maxEstimatedBytesPerTransaction: 6_001 })).toThrow(/byte budget/)
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisEditTransactionLifecyclePolicy(budget)
    policy.admit(request())
    policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.admit(request())).toThrow(/disposed/)
    expect(() => policy.next(20)).toThrow(/disposed/)
  })
})
