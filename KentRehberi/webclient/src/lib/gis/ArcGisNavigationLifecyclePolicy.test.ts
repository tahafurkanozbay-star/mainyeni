import { describe, expect, it } from 'vitest'
import { ArcGisNavigationLifecyclePolicy, type ArcGisNavigationBudget, type ArcGisNavigationRequest } from './ArcGisNavigationLifecyclePolicy'

const budget: ArcGisNavigationBudget = {
  maxViews: 2,
  maxRequests: 4,
  maxRequestsPerView: 2,
  maxRunningRequests: 1,
  maxEstimatedBytes: 1000,
  maxEstimatedBytesPerRequest: 600,
  queueTtlMs: 100,
  runLeaseMs: 50,
}
const request = (overrides: Partial<ArcGisNavigationRequest> = {}): ArcGisNavigationRequest => ({
  viewId: 'map', requestId: 'one', revision: 1, intent: 'user', estimatedBytes: 100, requestedAt: 10, targetScale: 5000, ...overrides,
})

describe('ArcGisNavigationLifecyclePolicy', () => {
  it('admits bounded navigation metadata without retaining SDK objects', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    expect(policy.admit(request())).toBe(true)
    expect(policy.snapshot()).toMatchObject({ views: 1, requests: 1, running: 0, estimatedBytes: 100, revisionWatermark: { map: 1 } })
  })

  it('rejects per-request and aggregate byte overflow', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    expect(policy.admit(request({ estimatedBytes: 601 }))).toBe(false)
    expect(policy.admit(request({ estimatedBytes: 500 }))).toBe(true)
    expect(policy.admit(request({ requestId: 'two', estimatedBytes: 500 }))).toBe(true)
    expect(policy.admit(request({ viewId: 'scene', requestId: 'three', estimatedBytes: 1 }))).toBe(false)
  })

  it('enforces per-view and aggregate request cardinality', () => {
    const policy = new ArcGisNavigationLifecyclePolicy({ ...budget, maxEstimatedBytes: 5000, maxEstimatedBytesPerRequest: 1000 })
    expect(policy.admit(request())).toBe(true)
    expect(policy.admit(request({ requestId: 'two' }))).toBe(true)
    expect(policy.admit(request({ requestId: 'three' }))).toBe(false)
    expect(policy.admit(request({ viewId: 'scene', requestId: 'three' }))).toBe(true)
    expect(policy.admit(request({ viewId: 'scene', requestId: 'four' }))).toBe(true)
    expect(policy.admit(request({ viewId: 'third', requestId: 'five' }))).toBe(false)
  })

  it('invalidates stale view work on revision advance', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    policy.admit(request())
    policy.admit(request({ requestId: 'two' }))
    expect(policy.admit(request({ requestId: 'new', revision: 2 }))).toBe(true)
    expect(policy.entriesForView('map').map(entry => entry.requestId)).toEqual(['new'])
    expect(policy.admit(request({ requestId: 'stale', revision: 1 }))).toBe(false)
  })

  it('prioritizes selection then search then user then restore deterministically', () => {
    const policy = new ArcGisNavigationLifecyclePolicy({ ...budget, maxRequestsPerView: 4 })
    policy.admit(request({ requestId: 'restore', intent: 'restore', requestedAt: 1 }))
    policy.admit(request({ requestId: 'user', intent: 'user', requestedAt: 2 }))
    policy.admit(request({ requestId: 'search', intent: 'search', requestedAt: 3 }))
    policy.admit(request({ requestId: 'selection', intent: 'selection', requestedAt: 4 }))
    expect(policy.nextQueued()?.requestId).toBe('selection')
  })

  it('prevents lower-priority replacement of the same request identity', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'selection' }))).toBe(true)
    expect(policy.admit(request({ intent: 'restore' }))).toBe(false)
    expect(policy.entriesForView('map')[0]?.intent).toBe('selection')
  })

  it('permits priority promotion while preserving cardinality', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    expect(policy.admit(request({ intent: 'restore', estimatedBytes: 500 }))).toBe(true)
    expect(policy.admit(request({ intent: 'search', estimatedBytes: 300 }))).toBe(true)
    expect(policy.snapshot()).toMatchObject({ requests: 1, estimatedBytes: 300 })
  })

  it('bounds concurrent running navigation requests', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    policy.admit(request())
    policy.admit(request({ requestId: 'two' }))
    expect(policy.begin('map', 'one', 1, 20)).toBe(true)
    expect(policy.begin('map', 'two', 1, 20)).toBe(false)
    expect(policy.complete('map', 'one', 1)).toBe(true)
    expect(policy.begin('map', 'two', 1, 21)).toBe(true)
  })

  it('rejects stale completion and requires running state', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    policy.admit(request())
    expect(policy.complete('map', 'one', 1)).toBe(false)
    expect(policy.begin('map', 'one', 1, 20)).toBe(true)
    expect(policy.complete('map', 'one', 2)).toBe(false)
    expect(policy.complete('map', 'one', 1)).toBe(true)
  })

  it('expires queued work by ttl', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    policy.admit(request({ requestedAt: 10 }))
    expect(policy.expire(110)).toBe(0)
    expect(policy.expire(111)).toBe(1)
  })

  it('expires running work by lease independently of queue ttl', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    policy.admit(request({ requestedAt: 10 }))
    policy.begin('map', 'one', 1, 20)
    expect(policy.expire(70)).toBe(0)
    expect(policy.expire(71)).toBe(1)
  })

  it('cancels explicitly and releases byte budget', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    policy.admit(request({ estimatedBytes: 500 }))
    expect(policy.cancel('map', 'one')).toBe(true)
    expect(policy.snapshot()).toMatchObject({ requests: 0, estimatedBytes: 0 })
  })

  it('produces stable fingerprints independent of admission order', () => {
    const left = new ArcGisNavigationLifecyclePolicy(budget)
    const right = new ArcGisNavigationLifecyclePolicy(budget)
    left.admit(request({ requestId: 'a' })); left.admit(request({ requestId: 'b' }))
    right.admit(request({ requestId: 'b' })); right.admit(request({ requestId: 'a' }))
    expect(left.snapshot().fingerprint).toBe(right.snapshot().fingerprint)
  })

  it('normalizes identifiers and rejects unsafe delimiters', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    expect(policy.admit(request({ viewId: ' map ', requestId: ' one ' }))).toBe(true)
    expect(policy.entriesForView('map')[0]).toMatchObject({ viewId: 'map', requestId: 'one' })
    expect(() => policy.admit(request({ requestId: 'bad\u0000key' }))).toThrow(/invalid/)
  })

  it('validates target scale without requiring it', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    expect(policy.admit(request({ targetScale: null }))).toBe(true)
    expect(() => policy.admit(request({ requestId: 'bad', targetScale: 0 }))).toThrow(/targetScale/)
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisNavigationLifecyclePolicy(budget)
    policy.admit(request())
    policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/)
    expect(() => policy.admit(request())).toThrow(/disposed/)
  })

  it('validates contradictory budgets eagerly', () => {
    expect(() => new ArcGisNavigationLifecyclePolicy({ ...budget, maxRequestsPerView: 5 })).toThrow(/per-view/)
    expect(() => new ArcGisNavigationLifecyclePolicy({ ...budget, maxRunningRequests: 5 })).toThrow(/running/)
    expect(() => new ArcGisNavigationLifecyclePolicy({ ...budget, maxEstimatedBytesPerRequest: 1001 })).toThrow(/byte budget/)
  })
})
