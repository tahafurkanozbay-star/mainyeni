import { describe, expect, it } from 'vitest'
import { ArcGisSelectionPolicy, type ArcGisSelectionCandidate } from './ArcGisSelectionPolicy'

const budget = {
  maxCandidates: 8,
  maxSelectedFeatures: 4,
  maxSelectedLayers: 2,
  maxEstimatedBytes: 1_000,
  maxRevisionLength: 32,
  maxPriority: 100,
} as const

const candidate = (objectId: number, overrides: Partial<ArcGisSelectionCandidate> = {}): ArcGisSelectionCandidate => ({
  layerId: 1,
  objectId,
  revision: 'r1',
  estimatedBytes: 100,
  priority: 10,
  dimension: '2d',
  ...overrides,
})

describe('ArcGisSelectionPolicy', () => {
  it('replaces selection deterministically and freezes snapshots', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    const snapshot = policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(2), candidate(1)] })
    expect(snapshot.items.map((item) => item.objectId)).toEqual([1, 2])
    expect(snapshot.estimatedBytes).toBe(200)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.items)).toBe(true)
  })

  it('orders higher priority first with stable layer and object tie breaks', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    const snapshot = policy.apply({ mode: 'replace', dimension: '2d', candidates: [
      candidate(8, { priority: 1 }),
      candidate(4, { priority: 9, layerId: 2 }),
      candidate(3, { priority: 9 }),
    ] })
    expect(snapshot.items.map((item) => `${item.layerId}:${item.objectId}`)).toEqual(['1:3', '2:4', '1:8'])
  })

  it('supports additive selection', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1)] })
    const snapshot = policy.apply({ mode: 'add', dimension: '2d', candidates: [candidate(2)] })
    expect(snapshot.items).toHaveLength(2)
  })

  it('supports removal selection', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1), candidate(2)] })
    const snapshot = policy.apply({ mode: 'remove', dimension: '2d', candidates: [candidate(1)] })
    expect(snapshot.items.map((item) => item.objectId)).toEqual([2])
  })

  it('supports toggle selection', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1)] })
    const removed = policy.apply({ mode: 'toggle', dimension: '2d', candidates: [candidate(1)] })
    expect(removed.items).toHaveLength(0)
    const added = policy.apply({ mode: 'toggle', dimension: '2d', candidates: [candidate(2)] })
    expect(added.items.map((item) => item.objectId)).toEqual([2])
  })

  it('rejects duplicate candidates', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    expect(() => policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1), candidate(1)] })).toThrow('duplicate-selection-candidate')
  })

  it('rejects dimension mismatch', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    expect(() => policy.apply({ mode: 'replace', dimension: '3d', candidates: [candidate(1)] })).toThrow('selection-dimension-mismatch')
  })

  it('rejects feature cardinality overflow', () => {
    const policy = new ArcGisSelectionPolicy({ ...budget, maxSelectedFeatures: 1 })
    expect(() => policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1), candidate(2)] })).toThrow('selected-feature-budget-exceeded')
  })

  it('rejects selected layer cardinality overflow', () => {
    const policy = new ArcGisSelectionPolicy({ ...budget, maxSelectedLayers: 1 })
    expect(() => policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1), candidate(2, { layerId: 2 })] })).toThrow('selected-layer-budget-exceeded')
  })

  it('rejects aggregate byte overflow', () => {
    const policy = new ArcGisSelectionPolicy({ ...budget, maxEstimatedBytes: 150 })
    expect(() => policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1, { estimatedBytes: 100 }), candidate(2, { estimatedBytes: 100 })] })).toThrow('selected-byte-budget-exceeded')
  })

  it('rejects candidate cardinality overflow before processing', () => {
    const policy = new ArcGisSelectionPolicy({ ...budget, maxCandidates: 1 })
    expect(() => policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1), candidate(2)] })).toThrow('selection-candidate-budget-exceeded')
  })

  it('invalidates stale revisions for a layer', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1, { revision: 'old' }), candidate(2, { layerId: 2, revision: 'r2' })] })
    const snapshot = policy.invalidateLayer(1, 'new')
    expect(snapshot.items.map((item) => item.layerId)).toEqual([2])
  })

  it('keeps matching revision during revision invalidation', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1, { revision: 'r1' })] })
    const before = policy.snapshot()
    const after = policy.invalidateLayer(1, 'r1')
    expect(after.items).toHaveLength(1)
    expect(after.generation).toBe(before.generation)
  })

  it('invalidates all selected features for a layer when revision is omitted', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1), candidate(2, { layerId: 2 })] })
    expect(policy.invalidateLayer(1).items.map((item) => item.layerId)).toEqual([2])
  })

  it('clears selection and advances generation', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    const selected = policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1)] })
    const cleared = policy.clear()
    expect(cleared.items).toHaveLength(0)
    expect(cleared.generation).toBe(selected.generation + 1)
  })

  it('uses deterministic fingerprints for equivalent fresh policies', () => {
    const left = new ArcGisSelectionPolicy(budget).apply({ mode: 'replace', dimension: '2d', candidates: [candidate(2), candidate(1)] })
    const right = new ArcGisSelectionPolicy(budget).apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1), candidate(2)] })
    expect(left.fingerprint).toBe(right.fingerprint)
  })

  it('rejects malformed revisions', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    expect(() => policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(1, { revision: 'bad\nrevision' })] })).toThrow('invalid-revision')
  })

  it('rejects unsafe object identifiers', () => {
    const policy = new ArcGisSelectionPolicy(budget)
    expect(() => policy.apply({ mode: 'replace', dimension: '2d', candidates: [candidate(Number.MAX_SAFE_INTEGER + 1)] })).toThrow('objectId-out-of-range')
  })
})
