import { describe, expect, it } from 'vitest'
import { ArcGisIdentifyBatchLifecyclePolicy, type ArcGisIdentifyBatchBudget, type ArcGisIdentifyBatchRequest } from './ArcGisIdentifyBatchLifecyclePolicy'

const budget: ArcGisIdentifyBatchBudget = {
  maxBatches: 6,
  maxBatchesPerView: 4,
  maxRunning: 2,
  maxReady: 3,
  maxLayersPerBatch: 12,
  maxHitsPerBatch: 100,
  maxReadyHits: 200,
  maxBytesPerBatch: 10_000,
  maxReadyBytes: 20_000,
  queueTtlMs: 100,
  runTtlMs: 200,
  readyTtlMs: 300,
}

const request = (overrides: Partial<ArcGisIdentifyBatchRequest> = {}): ArcGisIdentifyBatchRequest => ({
  viewId: 'view-1', batchId: 'batch-1', mapRevision: 1, priority: 'keyboard',
  layerCount: 4, estimatedHits: 20, estimatedBytes: 2_000, requestedAt: 10, ...overrides,
})

describe('ArcGisIdentifyBatchLifecyclePolicy', () => {
  it('schedules click before keyboard and inspection work', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request({ batchId: 'inspection', priority: 'inspection', requestedAt: 1 }))
    policy.enqueue(request({ batchId: 'keyboard', priority: 'keyboard', requestedAt: 2 }))
    policy.enqueue(request({ batchId: 'click', priority: 'click', requestedAt: 3 }))
    expect(policy.takeNext(10)?.batchId).toBe('click')
    expect(policy.takeNext(11)?.batchId).toBe('keyboard')
  })

  it('uses request time then id as deterministic tie breakers', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request({ batchId: 'z', requestedAt: 5 }))
    policy.enqueue(request({ batchId: 'b', requestedAt: 4 }))
    policy.enqueue(request({ batchId: 'a', requestedAt: 4 }))
    expect(policy.takeNext(10)?.batchId).toBe('a')
    expect(policy.takeNext(10)?.batchId).toBe('b')
  })

  it('bounds running concurrency', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request({ batchId: 'a' })); policy.enqueue(request({ batchId: 'b' })); policy.enqueue(request({ batchId: 'c' }))
    expect(policy.takeNext(20)?.batchId).toBe('a')
    expect(policy.takeNext(20)?.batchId).toBe('b')
    expect(policy.takeNext(20)).toBeUndefined()
  })

  it('rejects duplicate authority', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(() => policy.enqueue(request({ requestedAt: 11 }))).toThrow(/duplicate/)
    expect(policy.snapshot()).toHaveLength(1)
  })

  it('bounds global cardinality', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, maxBatches: 2, maxBatchesPerView: 2, maxRunning: 1, maxReady: 1 })
    policy.enqueue(request({ batchId: 'a' })); policy.enqueue(request({ batchId: 'b' }))
    expect(() => policy.enqueue(request({ batchId: 'c' }))).toThrow(/capacity/)
  })

  it('bounds per-view cardinality independently', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, maxBatchesPerView: 2 })
    policy.enqueue(request({ batchId: 'a' })); policy.enqueue(request({ batchId: 'b' }))
    expect(() => policy.enqueue(request({ batchId: 'c' }))).toThrow(/view identify/)
    expect(() => policy.enqueue(request({ viewId: 'view-2', batchId: 'c' }))).not.toThrow()
  })

  it('reconciles estimates to actual ready residency', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20)
    const ready = policy.complete('view-1', 'batch-1', 1, 40, 4_000, 30)
    expect(ready.phase).toBe('ready'); expect(ready.actualHits).toBe(40); expect(ready.actualBytes).toBe(4_000)
  })

  it('rejects oversized actual result and releases failed authority', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20)
    expect(() => policy.complete('view-1', 'batch-1', 1, 101, 1_000, 30)).toThrow(/result budget/)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds aggregate ready hit residency', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, maxReadyHits: 120 })
    policy.enqueue(request({ batchId: 'a' })); policy.takeNext(20); policy.complete('view-1', 'a', 1, 80, 1_000, 30)
    policy.enqueue(request({ batchId: 'b' })); policy.takeNext(40)
    expect(() => policy.complete('view-1', 'b', 1, 50, 1_000, 50)).toThrow(/hit budget/)
    expect(policy.snapshot().some(entry => entry.batchId === 'b')).toBe(false)
  })

  it('bounds aggregate ready byte residency', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, maxReadyBytes: 12_000 })
    policy.enqueue(request({ batchId: 'a' })); policy.takeNext(20); policy.complete('view-1', 'a', 1, 20, 8_000, 30)
    policy.enqueue(request({ batchId: 'b' })); policy.takeNext(40)
    expect(() => policy.complete('view-1', 'b', 1, 20, 5_000, 50)).toThrow(/byte budget/)
  })

  it('bounds ready cardinality', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, maxReady: 1 })
    policy.enqueue(request({ batchId: 'a' })); policy.takeNext(20); policy.complete('view-1', 'a', 1, 10, 100, 30)
    policy.enqueue(request({ batchId: 'b' })); policy.takeNext(40)
    expect(() => policy.complete('view-1', 'b', 1, 10, 100, 50)).toThrow(/ready identify capacity/)
  })

  it('invalidates stale queued and running work on view revision advance', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request({ batchId: 'queued', mapRevision: 1 }))
    policy.enqueue(request({ batchId: 'running', mapRevision: 1, priority: 'click' })); policy.takeNext(20)
    expect(policy.advanceViewRevision('view-1', 2)).toBe(2)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects requests older than the view watermark', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.advanceViewRevision('view-1', 5)
    expect(() => policy.enqueue(request({ mapRevision: 4 }))).toThrow(/stale/)
  })

  it('rejects backwards view revision movement', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.advanceViewRevision('view-1', 5)
    expect(() => policy.advanceViewRevision('view-1', 4)).toThrow(/backwards/)
  })

  it('rejects stale completion and releases authority', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20)
    expect(() => policy.complete('view-1', 'batch-1', 2, 10, 100, 30)).toThrow(/stale/)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('rejects late completion after running lease expiry', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20)
    expect(() => policy.complete('view-1', 'batch-1', 1, 10, 100, 221)).toThrow(/expired/)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('expires queued work deterministically', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request({ requestedAt: 10 }))
    expect(policy.expire(111)).toBe(1); expect(policy.snapshot()).toHaveLength(0)
  })

  it('expires ready work and releases aggregate residency', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20); policy.complete('view-1', 'batch-1', 1, 10, 100, 30)
    expect(policy.expire(331)).toBe(1)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('touch extends only live ready residency', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request()); expect(policy.touch('view-1', 'batch-1', 20)).toBe(false)
    policy.takeNext(20); policy.complete('view-1', 'batch-1', 1, 10, 100, 30)
    expect(policy.touch('view-1', 'batch-1', 40)).toBe(true)
    expect(policy.snapshot()[0].expiresAt).toBe(340)
  })

  it('touch drops expired ready residency', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20); policy.complete('view-1', 'batch-1', 1, 10, 100, 30)
    expect(policy.touch('view-1', 'batch-1', 331)).toBe(false)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('consumes ready result ownership exactly once', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request()); policy.takeNext(20); policy.complete('view-1', 'batch-1', 1, 10, 100, 30)
    expect(policy.consume('view-1', 'batch-1')?.phase).toBe('ready')
    expect(policy.consume('view-1', 'batch-1')).toBeUndefined()
  })

  it('does not consume queued or running authority', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request()); expect(policy.consume('view-1', 'batch-1')).toBeUndefined()
    policy.takeNext(20); expect(policy.consume('view-1', 'batch-1')).toBeUndefined()
  })

  it('cancels any phase and reuses capacity', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, maxBatches: 1, maxBatchesPerView: 1, maxRunning: 1, maxReady: 1 })
    policy.enqueue(request()); expect(policy.cancel('view-1', 'batch-1')).toBe(true)
    expect(() => policy.enqueue(request({ batchId: 'batch-2' }))).not.toThrow()
  })

  it('releases all work and watermark for a view', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request({ batchId: 'a' })); policy.enqueue(request({ batchId: 'b' }))
    expect(policy.releaseView('view-1')).toBe(2)
    expect(policy.snapshot()).toHaveLength(0)
    expect(() => policy.enqueue(request({ batchId: 'c', mapRevision: 0 }))).not.toThrow()
  })

  it('keeps another view intact during teardown', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request({ batchId: 'a' })); policy.enqueue(request({ viewId: 'view-2', batchId: 'b' }))
    expect(policy.releaseView('view-1')).toBe(1)
    expect(policy.snapshot().map(entry => entry.viewId)).toEqual(['view-2'])
  })

  it('rejects invalid identifiers', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ viewId: 'bad id' }))).toThrow(/viewId/)
    expect(() => policy.enqueue(request({ batchId: '' }))).toThrow(/batchId/)
  })

  it('rejects malformed numeric request facts', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ mapRevision: -1 }))).toThrow(/mapRevision/)
    expect(() => policy.enqueue(request({ layerCount: 0 }))).toThrow(/layerCount/)
    expect(() => policy.enqueue(request({ estimatedHits: Number.NaN }))).toThrow(/estimatedHits/)
    expect(() => policy.enqueue(request({ requestedAt: Number.POSITIVE_INFINITY }))).toThrow(/requestedAt/)
  })

  it('rejects invalid priority at runtime', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ priority: 'urgent' as never }))).toThrow(/priority/)
  })

  it('rejects estimated work beyond per-batch budgets', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ layerCount: 13 }))).toThrow(/layer budget/)
    expect(() => policy.enqueue(request({ estimatedHits: 101 }))).toThrow(/estimated identify/)
    expect(() => policy.enqueue(request({ estimatedBytes: 10_001 }))).toThrow(/estimated identify/)
  })

  it('rejects impossible cardinality budgets', () => {
    expect(() => new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, maxBatchesPerView: 7 })).toThrow(/cardinality/)
    expect(() => new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, maxRunning: 7 })).toThrow(/cardinality/)
    expect(() => new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, maxReady: 7 })).toThrow(/cardinality/)
  })

  it('rejects impossible residency budgets', () => {
    expect(() => new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, maxHitsPerBatch: 201 })).toThrow(/residency/)
    expect(() => new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, maxBytesPerBatch: 20_001 })).toThrow(/residency/)
  })

  it('rejects non-positive budget values', () => {
    expect(() => new ArcGisIdentifyBatchLifecyclePolicy({ ...budget, queueTtlMs: 0 })).toThrow(/queueTtlMs/)
  })

  it('returns detached immutable snapshots', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    const snapshot = policy.enqueue(request())
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(policy.snapshot())).toBe(true)
  })

  it('keeps payload graphs outside authority snapshots', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request())
    const serialized = JSON.stringify(policy.snapshot())
    expect(serialized).not.toContain('geometry')
    expect(serialized).not.toContain('graphic')
    expect(serialized).not.toContain('credential')
    expect(serialized).not.toContain('abort')
  })

  it('produces deterministic scalar fingerprints', () => {
    const left = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    const right = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    left.enqueue(request({ batchId: 'b' })); left.enqueue(request({ batchId: 'a' }))
    right.enqueue(request({ batchId: 'a' })); right.enqueue(request({ batchId: 'b' }))
    expect(left.fingerprint()).toBe(right.fingerprint())
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisIdentifyBatchLifecyclePolicy(budget)
    policy.enqueue(request()); policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.enqueue(request({ batchId: 'b' }))).toThrow(/disposed/)
  })
})
