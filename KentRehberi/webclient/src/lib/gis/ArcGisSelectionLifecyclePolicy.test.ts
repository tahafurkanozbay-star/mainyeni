import { describe, expect, it } from 'vitest'
import { ArcGisSelectionLifecyclePolicy, type ArcGisSelectionBudget } from './ArcGisSelectionLifecyclePolicy'

const budget: ArcGisSelectionBudget = {
  maxLayers: 3,
  maxEntries: 5,
  maxEntriesPerLayer: 3,
  maxPinnedEntries: 2,
  maxEstimatedHighlightBytes: 1_000,
  maxObjectIdsPerEntry: 4,
  hoverTtlMs: 50,
  focusTtlMs: 100,
  selectionTtlMs: 500,
}

const request = (overrides: Partial<Parameters<ArcGisSelectionLifecyclePolicy['admit']>[0]> = {}) => ({
  layerId: 'parcels', featureKey: '42', revision: 1, intent: 'select' as const, geometryKind: 'polygon' as const,
  objectIds: [42], estimatedHighlightBytes: 100, requestedAt: 10, ...overrides,
})

describe('ArcGisSelectionLifecyclePolicy', () => {
  it('canonicalizes object ids and exposes immutable deterministic snapshots', () => {
    const policy = new ArcGisSelectionLifecyclePolicy(budget)
    expect(policy.admit(request({ objectIds: [3, 1, 3, 2] }))).toBe(true)
    expect(policy.entriesForLayer('parcels')[0].objectIds).toEqual([1, 2, 3])
    const first = policy.snapshot()
    expect(first.entries).toBe(1)
    expect(first.estimatedHighlightBytes).toBe(100)
    expect(first.revisionWatermark).toEqual({ parcels: 1 })
    expect(policy.snapshot().fingerprint).toBe(first.fingerprint)
  })

  it('rejects stale revisions and invalidates old selections on a newer revision', () => {
    const policy = new ArcGisSelectionLifecyclePolicy(budget)
    expect(policy.admit(request())).toBe(true)
    expect(policy.admit(request({ revision: 0, featureKey: 'stale' }))).toBe(false)
    expect(policy.admit(request({ revision: 2, featureKey: 'new' }))).toBe(true)
    expect(policy.entriesForLayer('parcels').map(entry => entry.featureKey)).toEqual(['new'])
    expect(policy.snapshot().revisionWatermark).toEqual({ parcels: 2 })
  })

  it('enforces aggregate and per-layer cardinality bounds', () => {
    const policy = new ArcGisSelectionLifecyclePolicy({ ...budget, maxEntries: 3, maxEntriesPerLayer: 2 })
    expect(policy.admit(request({ featureKey: 'a' }))).toBe(true)
    expect(policy.admit(request({ featureKey: 'b' }))).toBe(true)
    expect(policy.admit(request({ featureKey: 'c' }))).toBe(false)
    expect(policy.admit(request({ layerId: 'roads', featureKey: 'r1', geometryKind: 'polyline' }))).toBe(true)
    expect(policy.admit(request({ layerId: 'roads', featureKey: 'r2', geometryKind: 'polyline' }))).toBe(false)
  })

  it('enforces highlight memory budget including replacement accounting', () => {
    const policy = new ArcGisSelectionLifecyclePolicy({ ...budget, maxEstimatedHighlightBytes: 150 })
    expect(policy.admit(request({ estimatedHighlightBytes: 100 }))).toBe(true)
    expect(policy.admit(request({ layerId: 'roads', featureKey: '7', estimatedHighlightBytes: 60 }))).toBe(false)
    expect(policy.admit(request({ estimatedHighlightBytes: 140 }))).toBe(true)
    expect(policy.snapshot().estimatedHighlightBytes).toBe(140)
  })

  it('enforces pinned-entry budget and allows promotion after capacity is released', () => {
    const policy = new ArcGisSelectionLifecyclePolicy({ ...budget, maxPinnedEntries: 1 })
    expect(policy.admit(request({ intent: 'pin', featureKey: 'a' }))).toBe(true)
    expect(policy.admit(request({ intent: 'pin', featureKey: 'b' }))).toBe(false)
    expect(policy.admit(request({ intent: 'select', featureKey: 'b' }))).toBe(true)
    expect(policy.release('parcels', 'a')).toBe(true)
    expect(policy.promote('parcels', 'b', 'pin', 20)).toBe(true)
    expect(policy.snapshot().pinned).toBe(1)
  })

  it('does not allow a weaker same-revision admission to replace a stronger intent', () => {
    const policy = new ArcGisSelectionLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'pin' }))).toBe(true)
    expect(policy.admit(request({ intent: 'hover', requestedAt: 20 }))).toBe(false)
    expect(policy.entriesForLayer('parcels')[0].intent).toBe('pin')
  })

  it('expires hover focus and selection while retaining pins', () => {
    const policy = new ArcGisSelectionLifecyclePolicy(budget)
    expect(policy.admit(request({ featureKey: 'h', intent: 'hover', requestedAt: 0 }))).toBe(true)
    expect(policy.admit(request({ featureKey: 'f', intent: 'focus', requestedAt: 0 }))).toBe(true)
    expect(policy.admit(request({ featureKey: 's', intent: 'select', requestedAt: 0 }))).toBe(true)
    expect(policy.admit(request({ layerId: 'roads', featureKey: 'p', intent: 'pin', requestedAt: 0 }))).toBe(true)
    expect(policy.expire(51)).toBe(1)
    expect(policy.expire(101)).toBe(1)
    expect(policy.expire(501)).toBe(1)
    expect(policy.snapshot().entries).toBe(1)
    expect(policy.snapshot().pinned).toBe(1)
  })

  it('supports explicit layer invalidation and release', () => {
    const policy = new ArcGisSelectionLifecyclePolicy(budget)
    policy.admit(request({ featureKey: 'a' }))
    policy.admit(request({ featureKey: 'b' }))
    expect(policy.invalidateLayer('parcels', 2)).toBe(2)
    expect(policy.snapshot().revisionWatermark).toEqual({ parcels: 2 })
    expect(policy.releaseLayer('parcels')).toBe(0)
    expect(policy.snapshot().layers).toBe(0)
  })

  it('orders entries by strongest intent then stable admission sequence', () => {
    const policy = new ArcGisSelectionLifecyclePolicy(budget)
    policy.admit(request({ featureKey: 'hover', intent: 'hover' }))
    policy.admit(request({ featureKey: 'select', intent: 'select' }))
    policy.admit(request({ featureKey: 'focus', intent: 'focus' }))
    expect(policy.entriesForLayer('parcels').map(entry => entry.intent)).toEqual(['select', 'focus', 'hover'])
  })

  it('validates object ids and per-entry object-id bounds', () => {
    const policy = new ArcGisSelectionLifecyclePolicy({ ...budget, maxObjectIdsPerEntry: 2 })
    expect(() => policy.admit(request({ objectIds: [1, 2, 3] }))).toThrow(/maxObjectIdsPerEntry/)
    expect(() => policy.admit(request({ objectIds: [-1] }))).toThrow(/non-negative safe integers/)
    expect(() => policy.admit(request({ objectIds: [Number.MAX_SAFE_INTEGER + 1] }))).toThrow(/non-negative safe integers/)
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisSelectionLifecyclePolicy(budget)
    policy.admit(request())
    policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.admit(request())).toThrow(/disposed/)
  })
})
