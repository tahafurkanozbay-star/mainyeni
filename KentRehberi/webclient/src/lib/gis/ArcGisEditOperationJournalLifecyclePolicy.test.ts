import { describe, expect, it } from 'vitest'
import { ArcGisEditOperationJournalLifecyclePolicy } from './ArcGisEditOperationJournalLifecyclePolicy'

const budget = { maxLayers: 3, maxEntries: 5, maxEntriesPerLayer: 3, maxOperations: 20, maxBytes: 1_000, stagedTtlMs: 50, committedTtlMs: 100 }
const make = () => new ArcGisEditOperationJournalLifecyclePolicy(budget)
const request = (entryId: string, layerId = 'roads', revision = 1, intent: 'interactive' | 'visible' | 'background' = 'visible', createdAt = 10, operationCount = 2, estimatedBytes = 100) => ({ entryId, layerId, revision, intent, createdAt, operationCount, estimatedBytes })

describe('ArcGisEditOperationJournalLifecyclePolicy', () => {
  it('requires a current layer revision before staging', () => {
    const policy = make()
    expect(policy.stage(request('a'))).toBe(false)
    expect(policy.setRevision('roads', 1)).toBe(0)
    expect(policy.stage(request('a'))).toBe(true)
  })

  it('invalidates stale entries on monotonic revision advance', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a')); policy.stage(request('b'))
    expect(policy.setRevision('roads', 2)).toBe(2)
    expect(policy.snapshot().entries).toBe(0)
    expect(policy.setRevision('roads', 1)).toBe(-1)
  })

  it('enforces global and per-layer cardinality', () => {
    const policy = new ArcGisEditOperationJournalLifecyclePolicy({ ...budget, maxEntries: 2, maxEntriesPerLayer: 1 })
    policy.setRevision('roads', 1); policy.setRevision('parks', 1)
    expect(policy.stage(request('a'))).toBe(true)
    expect(policy.stage(request('b'))).toBe(false)
    expect(policy.stage(request('c', 'parks'))).toBe(true)
    policy.setRevision('water', 1)
    expect(policy.stage(request('d', 'water'))).toBe(false)
  })

  it('enforces aggregate operation and byte budgets', () => {
    const policy = new ArcGisEditOperationJournalLifecyclePolicy({ ...budget, maxOperations: 3, maxBytes: 150 })
    policy.setRevision('roads', 1)
    expect(policy.stage(request('a', 'roads', 1, 'visible', 1, 2, 100))).toBe(true)
    expect(policy.stage(request('b', 'roads', 1, 'visible', 2, 2, 10))).toBe(false)
    expect(policy.stage(request('c', 'roads', 1, 'visible', 2, 1, 60))).toBe(false)
  })

  it('reconciles estimate to actual bytes on commit', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a'))
    expect(policy.commit('a', 1, 250, 20)).toBe(true)
    expect(policy.snapshot().bytes).toBe(250)
    expect(policy.snapshot().committed).toBe(1)
  })

  it('rejects reconciliation that would exceed the byte budget', () => {
    const policy = new ArcGisEditOperationJournalLifecyclePolicy({ ...budget, maxBytes: 200 })
    policy.setRevision('roads', 1); policy.stage(request('a', 'roads', 1, 'visible', 1, 1, 100))
    expect(policy.commit('a', 1, 201, 2)).toBe(false)
    expect(policy.snapshot().staged).toBe(1)
  })

  it('requires staged then committed then acknowledged transitions', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a'))
    expect(policy.acknowledge('a', 1, 20)).toBe(false)
    expect(policy.commit('a', 1, 90, 20)).toBe(true)
    expect(policy.commit('a', 1, 90, 21)).toBe(false)
    expect(policy.acknowledge('a', 1, 30)).toBe(true)
    expect(policy.snapshot().acknowledged).toBe(1)
  })

  it('consumes only acknowledged current-revision entries', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a'))
    expect(policy.consume('a', 1)).toBeNull()
    policy.commit('a', 1, 80, 20); policy.acknowledge('a', 1, 30)
    expect(policy.consume('a', 2)).toBeNull()
    expect(policy.consume('a', 1)?.entryId).toBe('a')
    expect(policy.snapshot().entries).toBe(0)
  })

  it('schedules deterministically by intent then creation then sequence', () => {
    const policy = make(); policy.setRevision('roads', 1)
    policy.stage(request('bg', 'roads', 1, 'background', 1)); policy.stage(request('v', 'roads', 1, 'visible', 1)); policy.stage(request('i', 'roads', 1, 'interactive', 5))
    expect(policy.next('staged', 6)?.entryId).toBe('i')
    policy.cancel('i')
    expect(policy.next('staged', 6)?.entryId).toBe('v')
  })

  it('uses sequence as deterministic final tie breaker', () => {
    const policy = make(); policy.setRevision('roads', 1)
    policy.stage(request('first', 'roads', 1, 'visible', 1)); policy.stage(request('second', 'roads', 1, 'visible', 1))
    expect(policy.next('staged', 2)?.entryId).toBe('first')
  })

  it('expires staged entries using staged TTL', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a', 'roads', 1, 'visible', 10))
    expect(policy.expire(59)).toBe(0)
    expect(policy.expire(60)).toBe(1)
  })

  it('uses committed TTL after commit and acknowledgement', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a', 'roads', 1, 'visible', 1)); policy.commit('a', 1, 80, 10)
    expect(policy.expire(109)).toBe(0); expect(policy.acknowledge('a', 1, 20)).toBe(true); expect(policy.expire(119)).toBe(0); expect(policy.expire(120)).toBe(1)
  })

  it('touch renews phase-specific expiry', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a', 'roads', 1, 'visible', 1))
    expect(policy.touch('a', 1, 20)).toBe(true); expect(policy.expire(69)).toBe(0); expect(policy.expire(70)).toBe(1)
  })

  it('rejects stale commit after revision changes', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a')); policy.setRevision('roads', 2)
    expect(policy.commit('a', 1, 80, 20)).toBe(false)
  })

  it('releases a layer and its revision authority', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a')); policy.stage(request('b'))
    expect(policy.releaseLayer('roads')).toBe(2); expect(policy.stage(request('c'))).toBe(false); expect(policy.snapshot().layers).toBe(0)
  })

  it('cancel is idempotent for absent entries', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a'))
    expect(policy.cancel('a')).toBe(true); expect(policy.cancel('a')).toBe(false)
  })

  it('bounds revision layer cardinality', () => {
    const policy = new ArcGisEditOperationJournalLifecyclePolicy({ ...budget, maxLayers: 1 })
    expect(policy.setRevision('roads', 1)).toBe(0); expect(policy.setRevision('parks', 1)).toBe(-1); expect(policy.snapshot().layers).toBe(1)
  })

  it('does not regress revision watermarks', () => {
    const policy = make(); policy.setRevision('roads', 3); expect(policy.setRevision('roads', 2)).toBe(-1); expect(policy.stage(request('a', 'roads', 2))).toBe(false)
  })

  it('produces deterministic scalar fingerprints', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('b')); policy.stage(request('a', 'roads', 1, 'interactive', 11, 1, 20))
    const fingerprint = policy.fingerprint()
    expect(fingerprint).toContain('roads:b:1:visible:staged:2:100'); expect(fingerprint).toContain('roads:a:1:interactive:staged:1:20')
    expect(fingerprint).not.toContain('geometry'); expect(fingerprint).not.toContain('attributes')
  })

  it('reports aggregate scalar accounting', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a', 'roads', 1, 'visible', 1, 2, 100)); policy.stage(request('b', 'roads', 1, 'visible', 2, 3, 200)); policy.commit('a', 1, 150, 3)
    expect(policy.snapshot()).toEqual({ layers: 1, entries: 2, staged: 1, committed: 1, acknowledged: 0, operations: 5, bytes: 350 })
  })

  it('normalizes identifiers without retaining caller payloads', () => {
    const policy = make(); policy.setRevision(' roads ', 1)
    const payload = { geometry: { x: 1 }, attributes: { secret: 'x' } }
    expect(policy.stage({ ...request(' a ', ' roads '), ...({ payload } as object) })).toBe(true)
    expect(policy.fingerprint()).toContain('roads:a:'); expect(policy.fingerprint()).not.toContain('secret')
  })

  it('validates unsafe identifiers and numeric inputs', () => {
    const policy = make()
    expect(() => policy.setRevision('', 1)).toThrow(); expect(() => policy.setRevision('roads', -1)).toThrow(); policy.setRevision('roads', 1)
    expect(() => policy.stage(request('a', 'roads', 1, 'visible', -1))).toThrow(); expect(() => policy.stage(request('a', 'roads', 1, 'visible', 1, 0))).toThrow()
  })

  it('validates parent budgets', () => {
    expect(() => new ArcGisEditOperationJournalLifecyclePolicy({ ...budget, maxEntries: 1, maxEntriesPerLayer: 2 })).toThrow()
    expect(() => new ArcGisEditOperationJournalLifecyclePolicy({ ...budget, maxBytes: 0 })).toThrow()
  })

  it('dispose is idempotent and permanently closes authority', () => {
    const policy = make(); policy.setRevision('roads', 1); policy.stage(request('a')); policy.dispose(); policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed'); expect(() => policy.stage(request('b'))).toThrow('disposed')
  })
})
