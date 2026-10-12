import { describe, expect, it, vi } from 'vitest'
import {
  ArcGisQueryCoordinator,
  type ArcGisQueryBudget,
  type ArcGisQueryKey,
  type ArcGisQueryResponse,
} from './ArcGisQueryCoordinator'

const budget: ArcGisQueryBudget = {
  maxEntries: 8,
  maxInflight: 4,
  maxWaitersPerQuery: 4,
  maxCacheAgeMs: 60_000,
  maxCachedBytes: 1_000,
  maxResponseBytes: 1_000,
  maxWhereLength: 128,
  maxOutFields: 4,
}

function key(serviceId: string): ArcGisQueryKey {
  return { serviceId, layerId: 1, where: '1=1', outFields: ['OBJECTID'], returnGeometry: false }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

describe('ArcGisQueryCoordinator invalidation fences', () => {
  it('does not repopulate a cleared cache from a late inflight response', async () => {
    const pending = deferred<ArcGisQueryResponse<string>>()
    const executor = vi.fn(() => pending.promise)
    const coordinator = new ArcGisQueryCoordinator(executor, budget, () => 100)
    const first = coordinator.query(key('service-a'))
    coordinator.invalidateAll()
    pending.resolve({ value: 'stale', estimatedBytes: 8 })
    expect((await first).value).toBe('stale')
    expect(coordinator.diagnostics().cacheEntries).toBe(0)
    const second = await coordinator.query(key('service-a'))
    expect(second.value).toBe('stale')
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it('isolates service invalidation without discarding unrelated inflight cache writes', async () => {
    const a = deferred<ArcGisQueryResponse<string>>()
    const b = deferred<ArcGisQueryResponse<string>>()
    const executor = vi.fn(({ key: request }: { key: ArcGisQueryKey }) =>
      request.serviceId === 'service-a' ? a.promise : b.promise)
    const coordinator = new ArcGisQueryCoordinator(executor, budget, () => 100)
    const first = coordinator.query(key('service-a'))
    const second = coordinator.query(key('service-b'))
    expect(coordinator.invalidateService('service-a')).toBe(0)
    a.resolve({ value: 'stale-a', estimatedBytes: 10 })
    b.resolve({ value: 'fresh-b', estimatedBytes: 20 })
    await Promise.all([first, second])
    expect(coordinator.diagnostics().cacheEntries).toBe(1)
    expect((await coordinator.query(key('service-b'))).value).toBe('fresh-b')
    expect(executor).toHaveBeenCalledTimes(2)
    await coordinator.query(key('service-a'))
    expect(executor).toHaveBeenCalledTimes(3)
  })

  it('continues caching normally when no invalidation occurs', async () => {
    const executor = vi.fn(async () => ({ value: 42, estimatedBytes: 8 }))
    const coordinator = new ArcGisQueryCoordinator(executor, budget, () => 100)
    expect((await coordinator.query(key('service-a'))).value).toBe(42)
    expect((await coordinator.query(key('service-a'))).value).toBe(42)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(coordinator.diagnostics().cacheEntries).toBe(1)
  })
})
