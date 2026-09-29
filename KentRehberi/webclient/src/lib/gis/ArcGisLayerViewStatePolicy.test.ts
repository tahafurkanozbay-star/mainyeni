import { describe, expect, it } from 'vitest'
import { ArcGisLayerViewStatePolicy } from './ArcGisLayerViewStatePolicy'

const budget = { maxLayers: 2, maxPendingRequestsPerLayer: 4, maxVisibleFeaturesPerLayer: 100 }
const signal = (overrides = {}) => ({ layerId: 'roads', revision: 'r1', generation: 1, status: 'updating' as const, pendingRequests: 1, visibleFeatures: 10, timestampMs: 10, ...overrides })

describe('ArcGisLayerViewStatePolicy', () => {
  it('stores immutable scalar signals', () => {
    const policy = new ArcGisLayerViewStatePolicy('r1', budget)
    expect(Object.isFrozen(policy.update(signal()))).toBe(true)
    expect(policy.snapshot().updating).toBe(1)
  })

  it('rejects stale revisions', () => {
    const policy = new ArcGisLayerViewStatePolicy('r1', budget)
    expect(() => policy.update(signal({ revision: 'r0' }))).toThrow('stale-layer-view-revision')
  })

  it('rejects stale generations and timestamps', () => {
    const policy = new ArcGisLayerViewStatePolicy('r1', budget)
    policy.update(signal({ generation: 2, timestampMs: 20 }))
    expect(() => policy.update(signal({ generation: 1, timestampMs: 30 }))).toThrow('stale-layer-view-generation')
    expect(() => policy.update(signal({ generation: 2, timestampMs: 19 }))).toThrow('stale-layer-view-signal')
  })

  it('requires ready state to have no pending requests', () => {
    const policy = new ArcGisLayerViewStatePolicy('r1', budget)
    expect(() => policy.update(signal({ status: 'ready', pendingRequests: 1 }))).toThrow('ready-layer-view-has-pending-requests')
  })

  it('enforces per-layer request and feature budgets', () => {
    const policy = new ArcGisLayerViewStatePolicy('r1', budget)
    expect(() => policy.update(signal({ pendingRequests: 5 }))).toThrow('pendingRequests-out-of-range')
    expect(() => policy.update(signal({ visibleFeatures: 101 }))).toThrow('visibleFeatures-out-of-range')
  })

  it('enforces layer cardinality', () => {
    const policy = new ArcGisLayerViewStatePolicy('r1', budget)
    policy.update(signal({ layerId: 'a' }))
    policy.update(signal({ layerId: 'b' }))
    expect(() => policy.update(signal({ layerId: 'c' }))).toThrow('layer-view-cardinality-exceeded')
  })

  it('aggregates deterministic snapshots', () => {
    const policy = new ArcGisLayerViewStatePolicy('r1', budget)
    policy.update(signal({ layerId: 'b', pendingRequests: 2, visibleFeatures: 20 }))
    policy.update(signal({ layerId: 'a', pendingRequests: 1, visibleFeatures: 30 }))
    const snapshot = policy.snapshot()
    expect(snapshot.signals.map((item) => item.layerId)).toEqual(['a', 'b'])
    expect(snapshot.pendingRequests).toBe(3)
    expect(snapshot.visibleFeatures).toBe(50)
    expect(Object.isFrozen(snapshot.signals)).toBe(true)
  })

  it('removes only the expected generation', () => {
    const policy = new ArcGisLayerViewStatePolicy('r1', budget)
    policy.update(signal({ generation: 3 }))
    expect(() => policy.remove('roads', 2)).toThrow('stale-layer-view-removal')
    expect(policy.remove('roads', 3)).toBe(true)
    expect(policy.remove('roads', 3)).toBe(false)
  })

  it('clears retained state deterministically', () => {
    const policy = new ArcGisLayerViewStatePolicy('r1', budget)
    policy.update(signal())
    policy.clear()
    expect(policy.snapshot().signals).toEqual([])
  })
})
