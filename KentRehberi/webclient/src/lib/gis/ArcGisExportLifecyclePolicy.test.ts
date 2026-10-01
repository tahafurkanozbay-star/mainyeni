import { describe, expect, it } from 'vitest'
import { ArcGisExportLifecyclePolicy, type ArcGisExportBudget, type ArcGisExportRequest } from './ArcGisExportLifecyclePolicy'

const budget: ArcGisExportBudget = {
  maxViews: 2,
  maxJobs: 4,
  maxJobsPerView: 3,
  maxRunningJobs: 2,
  maxReadyJobs: 2,
  maxEstimatedBytes: 10_000,
  maxEstimatedBytesPerJob: 4_000,
  maxPixelsPerJob: 4_000_000,
  queueTtlMs: 100,
  runLeaseMs: 200,
  readyTtlMs: 300,
}

function request(overrides: Partial<ArcGisExportRequest> = {}): ArcGisExportRequest {
  return { viewId: 'map', jobId: 'job-1', revision: 1, intent: 'download', requestedAt: 10, estimatedBytes: 1000, width: 800, height: 600, dpi: 96, ...overrides }
}

describe('ArcGisExportLifecyclePolicy', () => {
  it('validates impossible budgets', () => {
    expect(() => new ArcGisExportLifecyclePolicy({ ...budget, maxJobsPerView: 5 })).toThrow()
    expect(() => new ArcGisExportLifecyclePolicy({ ...budget, maxRunningJobs: 5 })).toThrow()
    expect(() => new ArcGisExportLifecyclePolicy({ ...budget, maxReadyJobs: 5 })).toThrow()
    expect(() => new ArcGisExportLifecyclePolicy({ ...budget, maxEstimatedBytesPerJob: 20_000 })).toThrow()
  })

  it('rejects oversized pixel and byte work before retention', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    expect(policy.admit(request({ width: 3000, height: 3000 }))).toBe(false)
    expect(policy.admit(request({ estimatedBytes: 5000 }))).toBe(false)
    expect(policy.snapshot().jobs).toBe(0)
  })

  it('bounds aggregate and per-view job cardinality', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    expect(policy.admit(request({ jobId: 'a' }))).toBe(true)
    expect(policy.admit(request({ jobId: 'b' }))).toBe(true)
    expect(policy.admit(request({ jobId: 'c' }))).toBe(true)
    expect(policy.admit(request({ jobId: 'd' }))).toBe(false)
    expect(policy.admit(request({ viewId: 'scene', jobId: 'd' }))).toBe(true)
    expect(policy.admit(request({ viewId: 'scene', jobId: 'e' }))).toBe(false)
  })

  it('bounds aggregate estimated bytes', () => {
    const policy = new ArcGisExportLifecyclePolicy({ ...budget, maxEstimatedBytes: 5000 })
    expect(policy.admit(request({ jobId: 'a', estimatedBytes: 3000 }))).toBe(true)
    expect(policy.admit(request({ jobId: 'b', estimatedBytes: 2500 }))).toBe(false)
  })

  it('invalidates stale jobs when view revision advances', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    policy.admit(request({ jobId: 'old' }))
    expect(policy.admit(request({ jobId: 'new', revision: 2 }))).toBe(true)
    expect(policy.entriesForView('map').map(entry => entry.jobId)).toEqual(['new'])
    expect(policy.admit(request({ jobId: 'stale', revision: 1 }))).toBe(false)
  })

  it('rejects revision collision replacement and running replacement', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.admit(request({ revision: 2 }))).toBe(true)
    expect(policy.begin('map', 'job-1', 2, 20)).toBe(true)
    expect(policy.admit(request({ revision: 2, intent: 'print' }))).toBe(false)
  })

  it('allows queued priority promotion but rejects demotion', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'preview' }))).toBe(true)
    expect(policy.admit(request({ intent: 'print' }))).toBe(true)
    expect(policy.admit(request({ intent: 'download' }))).toBe(false)
    expect(policy.nextQueued()?.intent).toBe('print')
  })

  it('orders print before download before preview deterministically', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    policy.admit(request({ jobId: 'preview', intent: 'preview', requestedAt: 1 }))
    policy.admit(request({ jobId: 'download', intent: 'download', requestedAt: 2 }))
    policy.admit(request({ jobId: 'print', intent: 'print', requestedAt: 3 }))
    expect(policy.nextQueued()?.jobId).toBe('print')
  })

  it('bounds running jobs and honors queue expiry', () => {
    const policy = new ArcGisExportLifecyclePolicy({ ...budget, maxRunningJobs: 1 })
    policy.admit(request({ jobId: 'a' }))
    policy.admit(request({ jobId: 'b' }))
    expect(policy.begin('map', 'a', 1, 20)).toBe(true)
    expect(policy.begin('map', 'b', 1, 20)).toBe(false)
    expect(policy.cancel('map', 'a')).toBe(true)
    expect(policy.begin('map', 'b', 1, 111)).toBe(false)
  })

  it('rejects stale or expired completion', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    policy.admit(request())
    policy.begin('map', 'job-1', 1, 20)
    expect(policy.markReady('map', 'job-1', 2, 30, 100)).toBe(false)
    expect(policy.markReady('map', 'job-1', 1, 221, 100)).toBe(false)
  })

  it('bounds ready cardinality and ready bytes without retaining payloads', () => {
    const policy = new ArcGisExportLifecyclePolicy({ ...budget, maxReadyJobs: 1, maxEstimatedBytes: 5000 })
    policy.admit(request({ jobId: 'a' }))
    policy.admit(request({ jobId: 'b' }))
    policy.begin('map', 'a', 1, 20)
    policy.begin('map', 'b', 1, 20)
    expect(policy.markReady('map', 'a', 1, 30, 3000)).toBe(true)
    expect(policy.markReady('map', 'b', 1, 30, 100)).toBe(false)
    expect(policy.snapshot().readyBytes).toBe(3000)
  })

  it('consumes only ready jobs with matching revision', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.consume('map', 'job-1', 1)).toBe(false)
    policy.begin('map', 'job-1', 1, 20)
    policy.markReady('map', 'job-1', 1, 30, 500)
    expect(policy.consume('map', 'job-1', 2)).toBe(false)
    expect(policy.consume('map', 'job-1', 1)).toBe(true)
    expect(policy.snapshot().jobs).toBe(0)
  })

  it('expires queued, running, and ready jobs using state-specific leases', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    policy.admit(request({ jobId: 'queued', requestedAt: 0 }))
    policy.admit(request({ jobId: 'running', requestedAt: 0 }))
    policy.admit(request({ jobId: 'ready', requestedAt: 0 }))
    policy.begin('map', 'running', 1, 10)
    policy.begin('map', 'ready', 1, 10)
    policy.markReady('map', 'ready', 1, 20, 100)
    expect(policy.expire(101)).toBe(1)
    expect(policy.expire(211)).toBe(1)
    expect(policy.expire(321)).toBe(1)
  })

  it('tracks view revision watermarks without exceeding view budget', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    expect(policy.invalidateView('map', 1)).toBe(0)
    expect(policy.invalidateView('scene', 1)).toBe(0)
    expect(policy.invalidateView('third', 1)).toBe(0)
    expect(policy.snapshot().views).toBe(2)
  })

  it('produces immutable deterministic snapshots', () => {
    const first = new ArcGisExportLifecyclePolicy(budget)
    const second = new ArcGisExportLifecyclePolicy(budget)
    for (const policy of [first, second]) {
      policy.admit(request({ jobId: 'b', requestedAt: 2 }))
      policy.admit(request({ jobId: 'a', requestedAt: 1 }))
    }
    expect(first.snapshot().fingerprint).toBe(second.snapshot().fingerprint)
    expect(Object.isFrozen(first.snapshot())).toBe(true)
    expect(Object.isFrozen(first.snapshot().revisionWatermark)).toBe(true)
  })

  it('normalizes identifiers and rejects unsafe identifiers', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    expect(policy.admit(request({ viewId: ' map ', jobId: ' job ' }))).toBe(true)
    expect(policy.entriesForView('map')[0]?.jobId).toBe('job')
    expect(() => policy.admit(request({ jobId: 'bad\u0000id' }))).toThrow()
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisExportLifecyclePolicy(budget)
    policy.admit(request())
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.admit(request())).toThrow('disposed')
  })
})
