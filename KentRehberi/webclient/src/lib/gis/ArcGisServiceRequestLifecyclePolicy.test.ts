import { describe, expect, it } from 'vitest'
import { ArcGisServiceRequestLifecyclePolicy, type ArcGisServiceRequest, type ArcGisServiceRequestBudget } from './ArcGisServiceRequestLifecyclePolicy'

const budget: ArcGisServiceRequestBudget = {
  maxRequests: 6,
  maxRequestsPerService: 4,
  maxRunning: 2,
  maxRunningPerService: 1,
  maxReady: 3,
  maxReadyBytes: 20_000,
  maxResponseBytes: 10_000,
  maxRetries: 1,
  queueTtlMs: 100,
  runTtlMs: 200,
  readyTtlMs: 300,
}

const request = (overrides: Partial<ArcGisServiceRequest> = {}): ArcGisServiceRequest => ({
  requestId: 'request-1', serviceId: 'service-1', operation: 'query', intent: 'visible', revision: 1,
  requestedAt: 10, estimatedResponseBytes: 2_000, signature: 'where=1=1&outFields=OBJECTID', ...overrides,
})

const running = (policy: ArcGisServiceRequestLifecyclePolicy, overrides: Partial<ArcGisServiceRequest> = {}) => {
  policy.enqueue(request(overrides)); return policy.takeNext(20)!
}

describe('ArcGisServiceRequestLifecyclePolicy', () => {
  it('prioritizes interactive then visible then background deterministically', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy({ ...budget, maxRunningPerService: 2 })
    policy.enqueue(request({ requestId: 'background', serviceId: 'a', intent: 'background', requestedAt: 1, signature: 'a' }))
    policy.enqueue(request({ requestId: 'visible', serviceId: 'b', intent: 'visible', requestedAt: 2, signature: 'b' }))
    policy.enqueue(request({ requestId: 'interactive', serviceId: 'c', intent: 'interactive', requestedAt: 3, signature: 'c' }))
    expect(policy.takeNext(10)?.requestId).toBe('interactive')
    expect(policy.takeNext(11)?.requestId).toBe('visible')
  })

  it('deduplicates canonical service operation signature and revision', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(() => policy.enqueue(request({ requestId: 'request-2' }))).toThrow(/duplicate request signature/)
    expect(() => policy.enqueue(request({ requestId: 'request-1', signature: 'different' }))).toThrow(/duplicate request authority/)
  })

  it('permits same signature for a different service or operation', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget)
    policy.enqueue(request())
    expect(() => policy.enqueue(request({ requestId: 'other-service', serviceId: 'service-2' }))).not.toThrow()
    expect(() => policy.enqueue(request({ requestId: 'other-op', operation: 'legend' }))).not.toThrow()
  })

  it('bounds global and per-service cardinality', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy({ ...budget, maxRequests: 2, maxRequestsPerService: 1, maxRunning: 1, maxReady: 1 })
    policy.enqueue(request({ requestId: 'a', signature: 'a' }))
    expect(() => policy.enqueue(request({ requestId: 'b', signature: 'b' }))).toThrow(/service request capacity/)
    policy.enqueue(request({ requestId: 'c', serviceId: 'service-2', signature: 'c' }))
    expect(() => policy.enqueue(request({ requestId: 'd', serviceId: 'service-3', signature: 'd' }))).toThrow(/request capacity/)
  })

  it('bounds global and per-service running concurrency', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget)
    policy.enqueue(request({ requestId: 'a', signature: 'a' })); policy.enqueue(request({ requestId: 'b', signature: 'b' }))
    policy.enqueue(request({ requestId: 'c', serviceId: 'service-2', signature: 'c' }))
    expect(policy.takeNext(20)?.requestId).toBe('a')
    expect(policy.takeNext(20)?.requestId).toBe('c')
    expect(policy.takeNext(20)).toBeUndefined()
  })

  it('reconciles estimated bytes to actual ready residency', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget); running(policy)
    const ready = policy.complete({ requestId: 'request-1', serviceId: 'service-1', revision: 1, responseBytes: 4_000, completedAt: 30 })
    expect(ready.phase).toBe('ready'); expect(ready.actualResponseBytes).toBe(4_000)
  })

  it('rejects oversized estimated and actual responses', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ estimatedResponseBytes: 10_001 }))).toThrow(/estimated response/)
    running(policy)
    expect(() => policy.complete({ requestId: 'request-1', serviceId: 'service-1', revision: 1, responseBytes: 10_001, completedAt: 30 })).toThrow(/response exceeds/)
    expect(policy.snapshot()).toHaveLength(0)
  })

  it('bounds aggregate ready response bytes and ready cardinality', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy({ ...budget, maxReadyBytes: 12_000, maxReady: 1 })
    running(policy, { requestId: 'a', signature: 'a' }); policy.complete({ requestId: 'a', serviceId: 'service-1', revision: 1, responseBytes: 8_000, completedAt: 30 })
    running(policy, { requestId: 'b', serviceId: 'service-2', signature: 'b' })
    expect(() => policy.complete({ requestId: 'b', serviceId: 'service-2', revision: 1, responseBytes: 1_000, completedAt: 40 })).toThrow(/ready capacity/)
  })

  it('invalidates stale work on service revision advance', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget); running(policy)
    expect(policy.advanceServiceRevision('service-1', 2)).toBe(1)
    expect(() => policy.complete({ requestId: 'request-1', serviceId: 'service-1', revision: 1, responseBytes: 100, completedAt: 30 })).toThrow(/not running/)
    expect(() => policy.enqueue(request({ requestId: 'old', revision: 1, signature: 'old' }))).toThrow(/stale/)
  })

  it('rejects completion identity mismatch', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget); running(policy)
    expect(() => policy.complete({ requestId: 'request-1', serviceId: 'wrong', revision: 1, responseBytes: 100, completedAt: 30 })).toThrow(/identity/)
  })

  it('expires queued, running and ready leases', () => {
    const queued = new ArcGisServiceRequestLifecyclePolicy(budget); queued.enqueue(request({ requestedAt: 0 })); expect(queued.expire(101)).toBe(1)
    const run = new ArcGisServiceRequestLifecyclePolicy(budget); run.enqueue(request({ requestedAt: 0 })); run.takeNext(10); expect(run.expire(211)).toBe(1)
    const ready = new ArcGisServiceRequestLifecyclePolicy(budget); ready.enqueue(request({ requestedAt: 0 })); ready.takeNext(10); ready.complete({ requestId: 'request-1', serviceId: 'service-1', revision: 1, responseBytes: 100, completedAt: 20 }); expect(ready.expire(321)).toBe(1)
  })

  it('supports bounded retry and preserves dedupe authority', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget); running(policy)
    expect(policy.retry('request-1', 30)).toBe(true); expect(policy.takeNext(31)?.attempts).toBe(2)
    expect(policy.retry('request-1', 40)).toBe(false); expect(policy.snapshot()).toHaveLength(0)
  })

  it('touch extends only live ready residency', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget); running(policy); policy.complete({ requestId: 'request-1', serviceId: 'service-1', revision: 1, responseBytes: 100, completedAt: 30 })
    expect(policy.touch('request-1', 40)).toBe(true); expect(policy.snapshot()[0].expiresAt).toBe(340)
    expect(policy.touch('missing', 40)).toBe(false)
  })

  it('consume and cancel release signature authority for reuse', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget); running(policy); policy.complete({ requestId: 'request-1', serviceId: 'service-1', revision: 1, responseBytes: 100, completedAt: 30 })
    expect(policy.consume('request-1')?.phase).toBe('ready')
    expect(() => policy.enqueue(request({ requestId: 'request-2' }))).not.toThrow()
    expect(policy.cancel('request-2')).toBe(true)
    expect(() => policy.enqueue(request({ requestId: 'request-3' }))).not.toThrow()
  })

  it('releases all service authority on teardown', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget)
    policy.enqueue(request({ requestId: 'a', signature: 'a' })); policy.enqueue(request({ requestId: 'b', signature: 'b' }))
    expect(policy.releaseService('service-1')).toBe(2); expect(policy.snapshot()).toHaveLength(0)
  })

  it('returns frozen scalar-only snapshots without transport graphs', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget); const view = policy.enqueue(request())
    expect(Object.isFrozen(view)).toBe(true)
    for (const forbidden of ['url', 'body', 'headers', 'credential', 'response', 'abortController', 'signal']) expect(view).not.toHaveProperty(forbidden)
  })

  it('fingerprint is deterministic and excludes signatures and payloads', () => {
    const first = new ArcGisServiceRequestLifecyclePolicy(budget); const second = new ArcGisServiceRequestLifecyclePolicy(budget)
    first.enqueue(request({ requestId: 'b', serviceId: 'service-2', signature: 'secret-query-b' })); first.enqueue(request({ requestId: 'a', signature: 'secret-query-a' }))
    second.enqueue(request({ requestId: 'a', signature: 'secret-query-a' })); second.enqueue(request({ requestId: 'b', serviceId: 'service-2', signature: 'secret-query-b' }))
    expect(first.fingerprint()).toBe(second.fingerprint()); expect(first.fingerprint()).not.toContain('secret-query')
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite request time %s', requestedAt => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget); expect(() => policy.enqueue(request({ requestedAt }))).toThrow(/finite/)
  })

  it.each(['', 'bad id', 'x'.repeat(161)])('rejects malformed request identifiers', requestId => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget); expect(() => policy.enqueue(request({ requestId }))).toThrow(/invalid/)
  })

  it('rejects control characters and oversized signatures', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget)
    expect(() => policy.enqueue(request({ signature: 'bad\nquery' }))).toThrow(/signature/)
    expect(() => policy.enqueue(request({ signature: 'x'.repeat(513) }))).toThrow(/signature/)
  })

  it('rejects impossible budgets', () => {
    expect(() => new ArcGisServiceRequestLifecyclePolicy({ ...budget, maxRunning: 7 })).toThrow(/impossible/)
    expect(() => new ArcGisServiceRequestLifecyclePolicy({ ...budget, maxRunningPerService: 3 })).toThrow(/impossible/)
    expect(() => new ArcGisServiceRequestLifecyclePolicy({ ...budget, maxResponseBytes: 20_001 })).toThrow(/impossible/)
  })

  it('dispose clears authority and fails closed afterwards', () => {
    const policy = new ArcGisServiceRequestLifecyclePolicy(budget); policy.enqueue(request()); policy.dispose()
    expect(() => policy.snapshot()).toThrow(/disposed/); expect(() => policy.enqueue(request())).toThrow(/disposed/)
  })
})
