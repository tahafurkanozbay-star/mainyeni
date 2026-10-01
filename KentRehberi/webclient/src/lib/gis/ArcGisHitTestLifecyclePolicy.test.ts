import { describe, expect, it } from 'vitest'
import { ArcGisHitTestLifecyclePolicy, type ArcGisHitTestBudget } from './ArcGisHitTestLifecyclePolicy'

const budget = (overrides: Partial<ArcGisHitTestBudget> = {}): ArcGisHitTestBudget => ({
  maxViews: 2,
  maxRequests: 4,
  maxRequestsPerView: 3,
  maxRunningRequests: 2,
  maxCandidateLayersPerRequest: 3,
  maxEstimatedResultBytes: 400,
  maxEstimatedResultBytesPerRequest: 200,
  hoverTtlMs: 20,
  clickTtlMs: 100,
  contextTtlMs: 200,
  runLeaseMs: 50,
  ...overrides,
})

const request = (pointerKey: string, overrides: Partial<Parameters<ArcGisHitTestLifecyclePolicy['admit']>[0]> = {}) => ({
  viewId: 'map-2d',
  pointerKey,
  revision: 1,
  intent: 'hover' as const,
  candidateLayerIds: ['parcels', 'roads'],
  estimatedResultBytes: 80,
  requestedAt: 10,
  ...overrides,
})

describe('ArcGisHitTestLifecyclePolicy', () => {
  it('rejects inconsistent budgets', () => {
    expect(() => new ArcGisHitTestLifecyclePolicy(budget({ maxRequestsPerView: 5 }))).toThrow(/maxRequestsPerView/)
    expect(() => new ArcGisHitTestLifecyclePolicy(budget({ maxRunningRequests: 5 }))).toThrow(/maxRunningRequests/)
    expect(() => new ArcGisHitTestLifecyclePolicy(budget({ maxEstimatedResultBytesPerRequest: 401 }))).toThrow(/byte budget/)
  })

  it('canonicalizes candidate layers without retaining mutable input', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget())
    const layers = ['roads', 'parcels', 'roads']
    expect(policy.admit(request('p1', { candidateLayerIds: layers }))).toBe(true)
    layers.push('buildings')
    expect(policy.entriesForView('map-2d')[0]?.candidateLayerIds).toEqual(['parcels', 'roads'])
    expect(Object.isFrozen(policy.entriesForView('map-2d')[0]?.candidateLayerIds)).toBe(true)
  })

  it('bounds candidate cardinality before admission', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget({ maxCandidateLayersPerRequest: 2 }))
    expect(() => policy.admit(request('p1', { candidateLayerIds: ['a', 'b', 'c'] }))).toThrow(/candidateLayerIds/)
  })

  it('enforces request and per-view cardinality', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget({ maxRequests: 3, maxRequestsPerView: 2 }))
    expect(policy.admit(request('p1'))).toBe(true)
    expect(policy.admit(request('p2'))).toBe(true)
    expect(policy.admit(request('p3'))).toBe(false)
    expect(policy.admit(request('p3', { viewId: 'scene-3d' }))).toBe(true)
    expect(policy.admit(request('p4', { viewId: 'scene-3d' }))).toBe(false)
  })

  it('enforces per-request and aggregate result byte budgets', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget({ maxEstimatedResultBytes: 250, maxEstimatedResultBytesPerRequest: 150 }))
    expect(policy.admit(request('large', { estimatedResultBytes: 151 }))).toBe(false)
    expect(policy.admit(request('p1', { estimatedResultBytes: 140 }))).toBe(true)
    expect(policy.admit(request('p2', { estimatedResultBytes: 111 }))).toBe(false)
    expect(policy.snapshot().estimatedResultBytes).toBe(140)
  })

  it('replaces a pointer request without double-counting bytes or sequence', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget())
    expect(policy.admit(request('p1', { estimatedResultBytes: 100 }))).toBe(true)
    const sequence = policy.entriesForView('map-2d')[0]?.sequence
    expect(policy.admit(request('p1', { intent: 'click', estimatedResultBytes: 120, requestedAt: 12 }))).toBe(true)
    expect(policy.snapshot().requests).toBe(1)
    expect(policy.snapshot().estimatedResultBytes).toBe(120)
    expect(policy.entriesForView('map-2d')[0]?.sequence).toBe(sequence)
  })

  it('does not downgrade a stronger same-revision intent', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget())
    expect(policy.admit(request('p1', { intent: 'context' }))).toBe(true)
    expect(policy.admit(request('p1', { intent: 'hover' }))).toBe(false)
    expect(policy.entriesForView('map-2d')[0]?.intent).toBe('context')
  })

  it('invalidates stale work when a view revision advances', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget())
    expect(policy.admit(request('p1'))).toBe(true)
    expect(policy.admit(request('p2', { revision: 2 }))).toBe(true)
    expect(policy.snapshot().requests).toBe(1)
    expect(policy.snapshot().revisionWatermark).toEqual({ 'map-2d': 2 })
    expect(policy.admit(request('stale', { revision: 1 }))).toBe(false)
  })

  it('bounds tracked views and preserves the existing watermark', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget({ maxViews: 1 }))
    expect(policy.admit(request('p1'))).toBe(true)
    expect(policy.admit(request('p2', { viewId: 'scene-3d' }))).toBe(false)
    expect(policy.snapshot().views).toBe(1)
  })

  it('bounds running work and requires exact revision ownership', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget({ maxRunningRequests: 1 }))
    policy.admit(request('p1', { intent: 'click' }))
    policy.admit(request('p2', { intent: 'click' }))
    expect(policy.begin('map-2d', 'p1', 0, 11)).toBe(false)
    expect(policy.begin('map-2d', 'p1', 1, 11)).toBe(true)
    expect(policy.begin('map-2d', 'p2', 1, 11)).toBe(false)
    expect(policy.complete('map-2d', 'p1', 0)).toBe(false)
    expect(policy.complete('map-2d', 'p1', 1)).toBe(true)
    expect(policy.begin('map-2d', 'p2', 1, 12)).toBe(true)
  })

  it('prioritizes context then click then hover deterministically', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget())
    policy.admit(request('hover', { requestedAt: 1 }))
    policy.admit(request('click', { intent: 'click', requestedAt: 3 }))
    policy.admit(request('context', { intent: 'context', requestedAt: 4 }))
    expect(policy.nextQueued()?.pointerKey).toBe('context')
    policy.begin('map-2d', 'context', 1, 5)
    expect(policy.nextQueued()?.pointerKey).toBe('click')
  })

  it('uses request age as the tie-breaker before sequence', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget())
    policy.admit(request('newer', { intent: 'click', requestedAt: 20 }))
    policy.admit(request('older', { intent: 'click', requestedAt: 10 }))
    expect(policy.nextQueued()?.pointerKey).toBe('older')
  })

  it('expires queued requests by intent TTL', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget())
    policy.admit(request('hover', { requestedAt: 10 }))
    policy.admit(request('click', { intent: 'click', requestedAt: 10 }))
    expect(policy.expire(31)).toBe(1)
    expect(policy.entriesForView('map-2d').map(entry => entry.pointerKey)).toEqual(['click'])
  })

  it('expires running requests when their execution lease is abandoned', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget({ clickTtlMs: 500, runLeaseMs: 20 }))
    policy.admit(request('click', { intent: 'click' }))
    policy.begin('map-2d', 'click', 1, 20)
    expect(policy.expire(40)).toBe(0)
    expect(policy.expire(41)).toBe(1)
    expect(policy.snapshot().running).toBe(0)
  })

  it('cancels superseded pointer work explicitly', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget())
    policy.admit(request('p1'))
    expect(policy.cancel('map-2d', 'p1')).toBe(true)
    expect(policy.cancel('map-2d', 'p1')).toBe(false)
    expect(policy.snapshot().requests).toBe(0)
  })

  it('returns deterministic immutable snapshots', () => {
    const first = new ArcGisHitTestLifecyclePolicy(budget())
    const second = new ArcGisHitTestLifecyclePolicy(budget())
    first.admit(request('b', { candidateLayerIds: ['roads', 'parcels'] }))
    first.admit(request('a', { intent: 'click' }))
    second.admit(request('a', { intent: 'click' }))
    second.admit(request('b', { candidateLayerIds: ['parcels', 'roads'] }))
    expect(first.snapshot().fingerprint).toBe(second.snapshot().fingerprint)
    expect(Object.isFrozen(first.snapshot())).toBe(true)
    expect(Object.isFrozen(first.snapshot().revisionWatermark)).toBe(true)
  })

  it('invalidates an entire view explicitly', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget())
    policy.admit(request('p1'))
    policy.admit(request('p2'))
    expect(policy.invalidateView('map-2d', 2)).toBe(2)
    expect(policy.invalidateView('map-2d', 2)).toBe(0)
    expect(policy.snapshot().revisionWatermark).toEqual({ 'map-2d': 2 })
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisHitTestLifecyclePolicy(budget())
    policy.admit(request('p1'))
    policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.admit(request('p2'))).toThrow(/disposed/)
  })
})
