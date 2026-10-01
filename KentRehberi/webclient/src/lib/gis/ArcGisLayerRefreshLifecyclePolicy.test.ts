import { describe, expect, it } from 'vitest'
import { ArcGisLayerRefreshLifecyclePolicy, type ArcGisLayerRefreshBudget, type ArcGisLayerRefreshRequest } from './ArcGisLayerRefreshLifecyclePolicy'

const budget: ArcGisLayerRefreshBudget = {
  maxLayers: 2,
  maxRequests: 4,
  maxRequestsPerLayer: 2,
  maxRunning: 1,
  maxReady: 2,
  maxEstimatedBytes: 1_000,
  maxEstimatedBytesPerRequest: 600,
  maxFeaturesPerRequest: 100,
  maxAggregateFeatures: 150,
  queueTtlMs: 100,
  runLeaseMs: 50,
  readyTtlMs: 200,
}

function request(overrides: Partial<ArcGisLayerRefreshRequest> = {}): ArcGisLayerRefreshRequest {
  return {
    layerId: 'parcels',
    refreshKey: 'extent-a',
    revision: 1,
    intent: 'visible',
    requestedAt: 10,
    estimatedBytes: 100,
    estimatedFeatures: 20,
    spatialReferenceWkid: 3857,
    minScale: 10_000,
    maxScale: 0,
    ...overrides,
  }
}

describe('ArcGisLayerRefreshLifecyclePolicy', () => {
  it('rejects invalid and internally inconsistent budgets', () => {
    expect(() => new ArcGisLayerRefreshLifecyclePolicy({ ...budget, maxLayers: 0 })).toThrow(/maxLayers/)
    expect(() => new ArcGisLayerRefreshLifecyclePolicy({ ...budget, maxRequestsPerLayer: 5 })).toThrow(/maxRequestsPerLayer/)
    expect(() => new ArcGisLayerRefreshLifecyclePolicy({ ...budget, maxRunning: 5 })).toThrow(/maxRunning/)
    expect(() => new ArcGisLayerRefreshLifecyclePolicy({ ...budget, maxReady: 5 })).toThrow(/maxReady/)
    expect(() => new ArcGisLayerRefreshLifecyclePolicy({ ...budget, maxEstimatedBytesPerRequest: 1_001 })).toThrow(/byte budget/)
    expect(() => new ArcGisLayerRefreshLifecyclePolicy({ ...budget, maxFeaturesPerRequest: 151 })).toThrow(/feature budget/)
  })

  it('validates identifiers, revisions, accounting and ArcGIS scale metadata', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    expect(() => policy.admit(request({ layerId: ' ' }))).toThrow(/layerId/)
    expect(() => policy.admit(request({ refreshKey: ' ' }))).toThrow(/refreshKey/)
    expect(() => policy.admit(request({ revision: -1 }))).toThrow(/revision/)
    expect(() => policy.admit(request({ requestedAt: Number.NaN }))).toThrow(/requestedAt/)
    expect(() => policy.admit(request({ estimatedBytes: -1 }))).toThrow(/estimatedBytes/)
    expect(() => policy.admit(request({ estimatedFeatures: 1.5 }))).toThrow(/estimatedFeatures/)
    expect(() => policy.admit(request({ spatialReferenceWkid: 0 }))).toThrow(/spatialReferenceWkid/)
    expect(() => policy.admit(request({ minScale: 100, maxScale: 1_000 }))).toThrow(/minScale/)
  })

  it('enforces per-request byte and feature budgets without retaining rejected work', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    expect(policy.admit(request({ estimatedBytes: 601 }))).toBe(false)
    expect(policy.admit(request({ estimatedFeatures: 101 }))).toBe(false)
    expect(policy.snapshot().requests).toBe(0)
  })

  it('bounds layer and per-layer cardinality', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    expect(policy.admit(request({ refreshKey: 'a' }))).toBe(true)
    expect(policy.admit(request({ refreshKey: 'b' }))).toBe(true)
    expect(policy.admit(request({ refreshKey: 'c' }))).toBe(false)
    expect(policy.admit(request({ layerId: 'roads', refreshKey: 'a' }))).toBe(true)
    expect(policy.admit(request({ layerId: 'buildings', refreshKey: 'a' }))).toBe(false)
  })

  it('enforces aggregate byte and feature budgets', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    expect(policy.admit(request({ refreshKey: 'a', estimatedBytes: 500, estimatedFeatures: 75 }))).toBe(true)
    expect(policy.admit(request({ refreshKey: 'b', estimatedBytes: 500, estimatedFeatures: 75 }))).toBe(true)
    expect(policy.admit(request({ layerId: 'roads', refreshKey: 'a', estimatedBytes: 1, estimatedFeatures: 1 }))).toBe(false)
  })

  it('schedules interactive work before visible, background and prefetch work', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy({ ...budget, maxRequestsPerLayer: 4, maxLayers: 4 })
    expect(policy.admit(request({ layerId: 'a', refreshKey: 'a', intent: 'prefetch' }))).toBe(true)
    expect(policy.admit(request({ layerId: 'b', refreshKey: 'b', intent: 'background' }))).toBe(true)
    expect(policy.admit(request({ layerId: 'c', refreshKey: 'c', intent: 'visible' }))).toBe(true)
    expect(policy.admit(request({ layerId: 'd', refreshKey: 'd', intent: 'interactive' }))).toBe(true)
    expect(policy.next(20)?.intent).toBe('interactive')
  })

  it('preserves FIFO sequence inside an intent class', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy({ ...budget, maxRunning: 2 })
    expect(policy.admit(request({ refreshKey: 'first', requestedAt: 10 }))).toBe(true)
    expect(policy.admit(request({ refreshKey: 'second', requestedAt: 11 }))).toBe(true)
    expect(policy.next(20)?.refreshKey).toBe('first')
    expect(policy.next(21)?.refreshKey).toBe('second')
  })

  it('does not exceed running cardinality', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request({ refreshKey: 'a' }))
    policy.admit(request({ refreshKey: 'b' }))
    expect(policy.next(20)?.refreshKey).toBe('a')
    expect(policy.next(21)).toBeNull()
  })

  it('expires queued work before scheduling it', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request({ requestedAt: 10 }))
    expect(policy.next(111)).toBeNull()
    expect(policy.snapshot().requests).toBe(0)
  })

  it('rejects stale completion after run lease expiry', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    expect(policy.complete('parcels', 'extent-a', 1, 71)).toBe(false)
  })

  it('requires exact revision and running phase for completion', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.complete('parcels', 'extent-a', 1, 20)).toBe(false)
    policy.next(20)
    expect(policy.complete('parcels', 'extent-a', 2, 21)).toBe(false)
    expect(policy.complete('parcels', 'extent-a', 1, 21)).toBe(true)
  })

  it('reconciles actual completion accounting against aggregate budgets', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request({ refreshKey: 'a', estimatedBytes: 100, estimatedFeatures: 20 }))
    policy.admit(request({ refreshKey: 'b', estimatedBytes: 500, estimatedFeatures: 75 }))
    policy.next(20)
    expect(policy.complete('parcels', 'a', 1, 21, 600, 80)).toBe(false)
    expect(policy.complete('parcels', 'a', 1, 21, 400, 70)).toBe(true)
    expect(policy.snapshot().estimatedBytes).toBe(900)
    expect(policy.snapshot().estimatedFeatures).toBe(145)
  })

  it('rejects actual completion values over per-request budgets', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    expect(policy.complete('parcels', 'extent-a', 1, 21, 601, 20)).toBe(false)
    expect(policy.complete('parcels', 'extent-a', 1, 21, 100, 101)).toBe(false)
  })

  it('bounds ready residency', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy({ ...budget, maxRunning: 3, maxReady: 1 })
    policy.admit(request({ refreshKey: 'a' }))
    policy.admit(request({ refreshKey: 'b' }))
    policy.next(20)
    policy.next(20)
    expect(policy.complete('parcels', 'a', 1, 21)).toBe(true)
    expect(policy.complete('parcels', 'b', 1, 21)).toBe(false)
  })

  it('consumes only exact ready revisions', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request())
    policy.next(20)
    policy.complete('parcels', 'extent-a', 1, 21)
    expect(policy.consume('parcels', 'extent-a', 2)).toBe(false)
    expect(policy.consume('parcels', 'extent-a', 1)).toBe(true)
    expect(policy.snapshot().requests).toBe(0)
  })

  it('invalidates older revisions and rejects stale re-admission', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request({ revision: 1 }))
    expect(policy.invalidate('parcels', 'extent-a', 2)).toBe(1)
    expect(policy.admit(request({ revision: 1 }))).toBe(false)
    expect(policy.admit(request({ revision: 2 }))).toBe(true)
  })

  it('automatically invalidates an existing entry when a newer revision is admitted', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    expect(policy.admit(request({ revision: 1, estimatedBytes: 500 }))).toBe(true)
    expect(policy.admit(request({ revision: 2, estimatedBytes: 100 }))).toBe(true)
    const snapshot = policy.snapshot()
    expect(snapshot.requests).toBe(1)
    expect(snapshot.estimatedBytes).toBe(100)
    expect(snapshot.revisionWatermark['parcels\u0000extent-a']).toBe(2)
  })

  it('prevents lower-priority duplicate work from replacing higher-priority work', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'interactive' }))).toBe(true)
    expect(policy.admit(request({ intent: 'prefetch' }))).toBe(false)
    expect(policy.entriesForLayer('parcels')[0]?.intent).toBe('interactive')
  })

  it('allows priority escalation for the same revision while preserving sequence', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'background' }))).toBe(true)
    const before = policy.entriesForLayer('parcels')[0]
    expect(policy.admit(request({ intent: 'interactive', requestedAt: 12 }))).toBe(true)
    const after = policy.entriesForLayer('parcels')[0]
    expect(after?.intent).toBe('interactive')
    expect(after?.sequence).toBe(before?.sequence)
  })

  it('invalidates only older entries for a layer watermark', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request({ refreshKey: 'old', revision: 1 }))
    policy.admit(request({ refreshKey: 'new', revision: 3 }))
    expect(policy.invalidateLayer('parcels', 2)).toBe(1)
    expect(policy.entriesForLayer('parcels').map(entry => entry.refreshKey)).toEqual(['new'])
  })

  it('cancels one request without disturbing sibling work', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request({ refreshKey: 'a' }))
    policy.admit(request({ refreshKey: 'b' }))
    expect(policy.cancel('parcels', 'a')).toBe(true)
    expect(policy.entriesForLayer('parcels').map(entry => entry.refreshKey)).toEqual(['b'])
  })

  it('releases layer entries and revision watermarks together', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request({ refreshKey: 'a' }))
    policy.admit(request({ refreshKey: 'b' }))
    expect(policy.releaseLayer('parcels')).toBe(2)
    expect(policy.snapshot().layers).toBe(0)
    expect(policy.snapshot().revisionWatermark).toEqual({})
  })

  it('expires running and ready residency using phase-specific leases', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request({ refreshKey: 'running' }))
    policy.admit(request({ refreshKey: 'ready' }))
    policy.next(20)
    expect(policy.expire(71)).toBe(1)
    expect(policy.next(72)?.refreshKey).toBe('ready')
    expect(policy.complete('parcels', 'ready', 1, 73)).toBe(true)
    expect(policy.expire(274)).toBe(1)
  })

  it('produces immutable snapshots with deterministic fingerprints', () => {
    const first = new ArcGisLayerRefreshLifecyclePolicy(budget)
    const second = new ArcGisLayerRefreshLifecyclePolicy(budget)
    first.admit(request({ refreshKey: 'a' }))
    first.admit(request({ refreshKey: 'b' }))
    second.admit(request({ refreshKey: 'a' }))
    second.admit(request({ refreshKey: 'b' }))
    expect(first.snapshot().fingerprint).toBe(second.snapshot().fingerprint)
    expect(Object.isFrozen(first.snapshot())).toBe(true)
    expect(Object.isFrozen(first.snapshot().revisionWatermark)).toBe(true)
  })

  it('changes fingerprints when material lifecycle metadata changes', () => {
    const first = new ArcGisLayerRefreshLifecyclePolicy(budget)
    const second = new ArcGisLayerRefreshLifecyclePolicy(budget)
    first.admit(request({ estimatedFeatures: 20 }))
    second.admit(request({ estimatedFeatures: 21 }))
    expect(first.snapshot().fingerprint).not.toBe(second.snapshot().fingerprint)
  })

  it('returns immutable layer entry collections', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request())
    const entries = policy.entriesForLayer('parcels')
    expect(Object.isFrozen(entries)).toBe(true)
    expect(Object.isFrozen(entries[0])).toBe(true)
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisLayerRefreshLifecyclePolicy(budget)
    policy.admit(request())
    policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.admit(request())).toThrow(/disposed/)
    expect(() => policy.next(20)).toThrow(/disposed/)
  })
})
