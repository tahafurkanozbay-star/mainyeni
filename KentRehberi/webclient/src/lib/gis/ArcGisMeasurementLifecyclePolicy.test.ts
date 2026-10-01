import { describe, expect, it } from 'vitest'
import { ArcGisMeasurementLifecyclePolicy, type ArcGisMeasurementBudget, type ArcGisMeasurementRequest } from './ArcGisMeasurementLifecyclePolicy'

const budget: ArcGisMeasurementBudget = {
  maxViews: 2, maxSessions: 4, maxSessionsPerView: 3, maxComputingSessions: 2, maxReadySessions: 2,
  maxVerticesPerSession: 20, maxVertices: 40, maxEstimatedBytes: 10_000, maxEstimatedBytesPerSession: 4_000,
  draftTtlMs: 100, computeLeaseMs: 200, readyTtlMs: 300,
}

function request(overrides: Partial<ArcGisMeasurementRequest> = {}): ArcGisMeasurementRequest {
  return { viewId: 'map', sessionId: 'measure-1', revision: 1, intent: 'distance', requestedAt: 10, vertexCount: 2, estimatedBytes: 500, spatialReferenceWkid: 3857, ...overrides }
}

describe('ArcGisMeasurementLifecyclePolicy', () => {
  it('rejects impossible budgets', () => {
    expect(() => new ArcGisMeasurementLifecyclePolicy({ ...budget, maxSessionsPerView: 5 })).toThrow()
    expect(() => new ArcGisMeasurementLifecyclePolicy({ ...budget, maxComputingSessions: 5 })).toThrow()
    expect(() => new ArcGisMeasurementLifecyclePolicy({ ...budget, maxVerticesPerSession: 50 })).toThrow()
    expect(() => new ArcGisMeasurementLifecyclePolicy({ ...budget, maxEstimatedBytesPerSession: 20_000 })).toThrow()
  })

  it('rejects oversized work before retention', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    expect(policy.admit(request({ vertexCount: 21 }))).toBe(false)
    expect(policy.admit(request({ estimatedBytes: 5000 }))).toBe(false)
    expect(policy.snapshot().sessions).toBe(0)
  })

  it('bounds aggregate and per-view session cardinality', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    expect(policy.admit(request({ sessionId: 'a' }))).toBe(true)
    expect(policy.admit(request({ sessionId: 'b' }))).toBe(true)
    expect(policy.admit(request({ sessionId: 'c' }))).toBe(true)
    expect(policy.admit(request({ sessionId: 'd' }))).toBe(false)
    expect(policy.admit(request({ viewId: 'scene', sessionId: 'd' }))).toBe(true)
    expect(policy.admit(request({ viewId: 'scene', sessionId: 'e' }))).toBe(false)
  })

  it('bounds aggregate vertices and estimated bytes', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy({ ...budget, maxVertices: 5, maxEstimatedBytes: 1500 })
    expect(policy.admit(request({ sessionId: 'a', vertexCount: 3, estimatedBytes: 1000 }))).toBe(true)
    expect(policy.admit(request({ sessionId: 'b', vertexCount: 3, estimatedBytes: 100 }))).toBe(false)
    expect(policy.admit(request({ sessionId: 'b', vertexCount: 2, estimatedBytes: 600 }))).toBe(false)
  })

  it('invalidates stale sessions when view revision advances', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    policy.admit(request({ sessionId: 'old' }))
    expect(policy.admit(request({ sessionId: 'new', revision: 2 }))).toBe(true)
    expect(policy.entriesForView('map').map(entry => entry.sessionId)).toEqual(['new'])
    expect(policy.admit(request({ sessionId: 'stale', revision: 1 }))).toBe(false)
  })

  it('allows draft intent promotion but rejects demotion', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'inspect' }))).toBe(true)
    expect(policy.admit(request({ intent: 'height' }))).toBe(true)
    expect(policy.admit(request({ intent: 'distance' }))).toBe(false)
    expect(policy.nextDraft()?.intent).toBe('height')
  })

  it('orders height area distance inspect deterministically', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    policy.admit(request({ sessionId: 'inspect', intent: 'inspect', requestedAt: 1 }))
    policy.admit(request({ sessionId: 'distance', intent: 'distance', requestedAt: 2 }))
    policy.admit(request({ sessionId: 'height', intent: 'height', requestedAt: 3 }))
    expect(policy.nextDraft()?.sessionId).toBe('height')
  })

  it('bounds computing sessions and honors draft expiry', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy({ ...budget, maxComputingSessions: 1 })
    policy.admit(request({ sessionId: 'a' }))
    policy.admit(request({ sessionId: 'b' }))
    expect(policy.begin('map', 'a', 1, 20)).toBe(true)
    expect(policy.begin('map', 'b', 1, 20)).toBe(false)
    expect(policy.cancel('map', 'a')).toBe(true)
    expect(policy.begin('map', 'b', 1, 111)).toBe(false)
  })

  it('rejects stale and expired computation completion', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    policy.admit(request())
    policy.begin('map', 'measure-1', 1, 20)
    expect(policy.markReady('map', 'measure-1', 2, 30, 100)).toBe(false)
    expect(policy.markReady('map', 'measure-1', 1, 221, 100)).toBe(false)
  })

  it('bounds ready cardinality and result byte accounting without payload retention', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy({ ...budget, maxReadySessions: 1, maxEstimatedBytes: 5000 })
    policy.admit(request({ sessionId: 'a' }))
    policy.admit(request({ sessionId: 'b' }))
    policy.begin('map', 'a', 1, 20)
    policy.begin('map', 'b', 1, 20)
    expect(policy.markReady('map', 'a', 1, 30, 3000)).toBe(true)
    expect(policy.markReady('map', 'b', 1, 30, 100)).toBe(false)
    expect(policy.snapshot().resultBytes).toBe(3000)
  })

  it('consumes only ready sessions with matching revision', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.consume('map', 'measure-1', 1)).toBe(false)
    policy.begin('map', 'measure-1', 1, 20)
    policy.markReady('map', 'measure-1', 1, 30, 100)
    expect(policy.consume('map', 'measure-1', 2)).toBe(false)
    expect(policy.consume('map', 'measure-1', 1)).toBe(true)
  })

  it('expires each lifecycle state by its own lease', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    policy.admit(request({ sessionId: 'draft', requestedAt: 0 }))
    policy.admit(request({ sessionId: 'computing', requestedAt: 0 }))
    policy.admit(request({ sessionId: 'ready', requestedAt: 0 }))
    policy.begin('map', 'computing', 1, 10)
    policy.begin('map', 'ready', 1, 10)
    policy.markReady('map', 'ready', 1, 20, 100)
    expect(policy.expire(101)).toBe(1)
    expect(policy.expire(211)).toBe(1)
    expect(policy.expire(321)).toBe(1)
  })

  it('tracks bounded view revision watermarks', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    expect(policy.invalidateView('map', 1)).toBe(0)
    expect(policy.invalidateView('scene', 1)).toBe(0)
    expect(policy.invalidateView('third', 1)).toBe(0)
    expect(policy.snapshot().views).toBe(2)
  })

  it('produces immutable deterministic snapshots', () => {
    const first = new ArcGisMeasurementLifecyclePolicy(budget)
    const second = new ArcGisMeasurementLifecyclePolicy(budget)
    for (const policy of [first, second]) {
      policy.admit(request({ sessionId: 'b', requestedAt: 2 }))
      policy.admit(request({ sessionId: 'a', requestedAt: 1 }))
    }
    expect(first.snapshot().fingerprint).toBe(second.snapshot().fingerprint)
    expect(Object.isFrozen(first.snapshot())).toBe(true)
    expect(Object.isFrozen(first.snapshot().revisionWatermark)).toBe(true)
  })

  it('normalizes identifiers and rejects unsafe identifiers', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    expect(policy.admit(request({ viewId: ' map ', sessionId: ' measure ' }))).toBe(true)
    expect(policy.entriesForView('map')[0]?.sessionId).toBe('measure')
    expect(() => policy.admit(request({ sessionId: 'bad\u0000id' }))).toThrow()
  })

  it('validates spatial reference and geometry metadata', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    expect(() => policy.admit(request({ spatialReferenceWkid: 0 }))).toThrow()
    expect(() => policy.admit(request({ vertexCount: 1 }))).toThrow()
    expect(() => policy.admit(request({ estimatedBytes: Number.NaN }))).toThrow()
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisMeasurementLifecyclePolicy(budget)
    policy.admit(request())
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.admit(request())).toThrow('disposed')
  })
})
