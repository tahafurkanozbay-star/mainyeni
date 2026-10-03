import { describe, expect, it } from 'vitest'
import { ArcGisLegendRequestLifecyclePolicy, type ArcGisLegendBudget } from './ArcGisLegendRequestLifecyclePolicy'

const budget: ArcGisLegendBudget = {
  maxServices: 1,
  maxRequests: 2,
  maxRequestsPerService: 2,
  maxLoading: 1,
  maxLoadingPerService: 1,
  maxReady: 1,
  maxReadyPerService: 1,
  maxItemsPerResponse: 20,
  maxBytesPerResponse: 100,
  maxAggregateReadyBytes: 100,
  queueTtlMs: 10,
  loadLeaseMs: 10,
  readyTtlMs: 10,
}

describe('ArcGisLegendRequestLifecyclePolicy security boundaries', () => {
  it('retains only admitted scalar metadata and never caller object identity', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    const source = { serviceId: 'svc', requestId: 'req', revision: 1, intent: 'interactive' as const, requestedAt: 1, estimatedItems: 4, estimatedBytes: 20 }
    expect(policy.enqueue(source)).toBe(true)
    const admitted = policy.snapshot()[0]
    expect(admitted).not.toBe(source)
    expect(Object.keys(admitted ?? {}).sort()).toEqual(['actualBytes', 'actualItems', 'estimatedBytes', 'estimatedItems', 'expiresAt', 'intent', 'lastAccessedAt', 'phase', 'requestId', 'requestedAt', 'revision', 'sequence', 'serviceId'].sort())
  })

  it('does not admit a second service beyond bounded service cardinality', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue({ serviceId: 'svc-a', requestId: 'a', revision: 1, intent: 'visible', requestedAt: 1, estimatedItems: 1, estimatedBytes: 1 })).toBe(true)
    expect(policy.enqueue({ serviceId: 'svc-b', requestId: 'b', revision: 1, intent: 'visible', requestedAt: 1, estimatedItems: 1, estimatedBytes: 1 })).toBe(false)
  })

  it('keeps ready expiry monotonic when touch refreshes recency only', () => {
    const policy = new ArcGisLegendRequestLifecyclePolicy(budget)
    expect(policy.enqueue({ serviceId: 'svc', requestId: 'req', revision: 1, intent: 'visible', requestedAt: 1, estimatedItems: 1, estimatedBytes: 1 })).toBe(true)
    expect(policy.takeNext(2)).toBeDefined()
    expect(policy.complete('svc', 'req', 1, 1, 1, 3)).toBe(true)
    const expiry = policy.snapshot()[0]?.expiresAt
    expect(policy.touch('svc', 'req', 1, 4)).toBe(true)
    expect(policy.snapshot()[0]?.expiresAt).toBe(expiry)
    expect(policy.touch('svc', 'req', 1, 13)).toBe(false)
  })
})
