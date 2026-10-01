import { describe, expect, it } from 'vitest'
import { ArcGisTimeLifecyclePolicy, type ArcGisTimeBudget, type ArcGisTimeRequest } from './ArcGisTimeLifecyclePolicy'

const budget: ArcGisTimeBudget = {
  maxViews: 2,
  maxRequests: 4,
  maxRequestsPerView: 3,
  maxRunning: 2,
  maxReady: 2,
  maxLayersPerRequest: 3,
  maxLayers: 6,
  maxEstimatedBytes: 1_000,
  maxEstimatedBytesPerRequest: 500,
  queueTtlMs: 100,
  runLeaseMs: 50,
  readyTtlMs: 200,
}

function request(overrides: Partial<ArcGisTimeRequest> = {}): ArcGisTimeRequest {
  return {
    viewId: 'map', requestId: 'r1', revision: 1, intent: 'playback', requestedAt: 10,
    startEpochMs: 1_700_000_000_000, endEpochMs: 1_700_003_600_000,
    layerCount: 1, estimatedBytes: 100, ...overrides,
  }
}

describe('ArcGisTimeLifecyclePolicy', () => {
  it('runs a bounded payload-free temporal lifecycle', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(policy.admit(request())).toBe(true)
    expect(policy.begin('map', 'r1', 1, 20)).toBe(true)
    expect(policy.markReady('map', 'r1', 1, 30, 80)).toBe(true)
    expect(policy.snapshot()).toMatchObject({ requests: 1, queued: 0, running: 0, ready: 1, layers: 1, estimatedBytes: 100, resultBytes: 80 })
    expect(policy.consume('map', 'r1', 1)).toBe(true)
    expect(policy.snapshot().requests).toBe(0)
  })

  it('rejects invalid temporal windows and unsafe identifiers', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(() => policy.admit(request({ startEpochMs: 20, endEpochMs: 10 }))).toThrow('endEpochMs')
    expect(() => policy.admit(request({ viewId: ' ' }))).toThrow('viewId')
  })

  it('enforces per-request and aggregate layer budgets', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(policy.admit(request({ layerCount: 4 }))).toBe(false)
    expect(policy.admit(request({ requestId: 'a', layerCount: 3 }))).toBe(true)
    expect(policy.admit(request({ requestId: 'b', layerCount: 3 }))).toBe(true)
    expect(policy.admit(request({ requestId: 'c', layerCount: 1 }))).toBe(false)
  })

  it('enforces per-request and aggregate byte budgets', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(policy.admit(request({ estimatedBytes: 501 }))).toBe(false)
    expect(policy.admit(request({ requestId: 'a', estimatedBytes: 500 }))).toBe(true)
    expect(policy.admit(request({ requestId: 'b', estimatedBytes: 500 }))).toBe(true)
    expect(policy.admit(request({ requestId: 'c', estimatedBytes: 1 }))).toBe(false)
  })

  it('bounds view and per-view request cardinality', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    for (const requestId of ['a', 'b', 'c']) expect(policy.admit(request({ requestId }))).toBe(true)
    expect(policy.admit(request({ requestId: 'd' }))).toBe(false)
    expect(policy.admit(request({ viewId: 'scene', requestId: 'e' }))).toBe(true)
    expect(policy.admit(request({ viewId: 'third', requestId: 'f' }))).toBe(false)
  })

  it('invalidates stale revisions and rejects stale completion', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(policy.admit(request())).toBe(true)
    expect(policy.begin('map', 'r1', 1, 20)).toBe(true)
    expect(policy.admit(request({ requestId: 'r2', revision: 2 }))).toBe(true)
    expect(policy.markReady('map', 'r1', 1, 30, 10)).toBe(false)
    expect(policy.admit(request({ requestId: 'old', revision: 1 }))).toBe(false)
    expect(policy.snapshot().revisionWatermark).toEqual({ map: 2 })
  })

  it('prioritizes commit then scrub then playback then prefetch', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(policy.admit(request({ requestId: 'p', intent: 'prefetch', requestedAt: 1 }))).toBe(true)
    expect(policy.admit(request({ requestId: 's', intent: 'scrub', requestedAt: 9 }))).toBe(true)
    expect(policy.admit(request({ requestId: 'c', intent: 'commit', requestedAt: 10 }))).toBe(true)
    expect(policy.nextQueued()?.requestId).toBe('c')
  })

  it('allows queued intent promotion but not demotion', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'playback' }))).toBe(true)
    expect(policy.admit(request({ intent: 'commit', estimatedBytes: 120 }))).toBe(true)
    expect(policy.entriesForView('map')[0].intent).toBe('commit')
    expect(policy.admit(request({ intent: 'prefetch' }))).toBe(false)
  })

  it('bounds concurrent running requests', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    for (const requestId of ['a', 'b', 'c']) expect(policy.admit(request({ requestId }))).toBe(true)
    expect(policy.begin('map', 'a', 1, 20)).toBe(true)
    expect(policy.begin('map', 'b', 1, 20)).toBe(true)
    expect(policy.begin('map', 'c', 1, 20)).toBe(false)
  })

  it('expires queued, running and ready leases', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(policy.admit(request({ requestId: 'queued', requestedAt: 0 }))).toBe(true)
    expect(policy.expire(101)).toBe(1)
    expect(policy.admit(request({ requestId: 'running', requestedAt: 200 }))).toBe(true)
    expect(policy.begin('map', 'running', 1, 210)).toBe(true)
    expect(policy.expire(261)).toBe(1)
    expect(policy.admit(request({ requestId: 'ready', requestedAt: 300 }))).toBe(true)
    expect(policy.begin('map', 'ready', 1, 310)).toBe(true)
    expect(policy.markReady('map', 'ready', 1, 320, 10)).toBe(true)
    expect(policy.expire(521)).toBe(1)
  })

  it('rejects completion after the run lease', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(policy.admit(request())).toBe(true)
    expect(policy.begin('map', 'r1', 1, 20)).toBe(true)
    expect(policy.markReady('map', 'r1', 1, 71, 10)).toBe(false)
  })

  it('bounds ready cardinality and result byte accounting', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    for (const requestId of ['a', 'b', 'c']) expect(policy.admit(request({ requestId, estimatedBytes: 100 }))).toBe(true)
    for (const requestId of ['a', 'b']) {
      expect(policy.begin('map', requestId, 1, 20)).toBe(true)
      expect(policy.markReady('map', requestId, 1, 30, 400)).toBe(true)
    }
    expect(policy.begin('map', 'c', 1, 40)).toBe(true)
    expect(policy.markReady('map', 'c', 1, 50, 10)).toBe(false)
    expect(policy.snapshot().resultBytes).toBe(800)
  })

  it('rejects oversized result accounting', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(policy.admit(request())).toBe(true)
    expect(policy.begin('map', 'r1', 1, 20)).toBe(true)
    expect(policy.markReady('map', 'r1', 1, 30, 501)).toBe(false)
  })

  it('cancels explicitly and does not consume non-ready work', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(policy.admit(request())).toBe(true)
    expect(policy.consume('map', 'r1', 1)).toBe(false)
    expect(policy.cancel('map', 'r1')).toBe(true)
    expect(policy.cancel('map', 'r1')).toBe(false)
  })

  it('returns immutable snapshots and deterministic fingerprints', () => {
    const left = new ArcGisTimeLifecyclePolicy(budget)
    const right = new ArcGisTimeLifecyclePolicy(budget)
    for (const policy of [left, right]) {
      expect(policy.admit(request({ requestId: 'b', requestedAt: 20 }))).toBe(true)
      expect(policy.admit(request({ requestId: 'a', requestedAt: 10 }))).toBe(true)
    }
    expect(left.snapshot().fingerprint).toBe(right.snapshot().fingerprint)
    expect(Object.isFrozen(left.snapshot())).toBe(true)
    expect(Object.isFrozen(left.snapshot().revisionWatermark)).toBe(true)
  })

  it('disposes fail-closed and idempotently', () => {
    const policy = new ArcGisTimeLifecyclePolicy(budget)
    expect(policy.admit(request())).toBe(true)
    policy.dispose()
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.admit(request())).toThrow('disposed')
  })

  it('validates internally contradictory budgets', () => {
    expect(() => new ArcGisTimeLifecyclePolicy({ ...budget, maxRequestsPerView: 5 })).toThrow('maxRequestsPerView')
    expect(() => new ArcGisTimeLifecyclePolicy({ ...budget, maxRunning: 5 })).toThrow('state limit')
    expect(() => new ArcGisTimeLifecyclePolicy({ ...budget, maxLayersPerRequest: 7 })).toThrow('maxLayersPerRequest')
    expect(() => new ArcGisTimeLifecyclePolicy({ ...budget, maxEstimatedBytesPerRequest: 1_001 })).toThrow('maxEstimatedBytesPerRequest')
  })
})
