import { describe, expect, it, vi } from 'vitest'
import { ArcGisQueryCoordinator, type ArcGisQueryBudget, type ArcGisQueryKey } from './ArcGisQueryCoordinator'

const budget: ArcGisQueryBudget = {
  maxEntries: 8, maxInflight: 4, maxWaitersPerQuery: 4,
  maxCacheAgeMs: 60_000, maxCachedBytes: 4096, maxResponseBytes: 4096,
  maxWhereLength: 256, maxOutFields: 4,
}

function key(where: string): ArcGisQueryKey {
  return { serviceId: 'parcels', layerId: 1, where, outFields: ['OBJECTID'], returnGeometry: false }
}

describe('ArcGIS query identity integrity', () => {
  it('never deduplicates distinct SQL literal whitespace', async () => {
    const executor = vi.fn(async ({ key: request }: { key: ArcGisQueryKey }) =>
      ({ value: request.where, estimatedBytes: 16 }))
    const coordinator = new ArcGisQueryCoordinator(executor, budget)
    expect((await coordinator.query(key("NAME = 'A  B'"))).value).toBe("NAME = 'A  B'")
    expect((await coordinator.query(key("NAME = 'A B'"))).value).toBe("NAME = 'A B'")
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it('caches repeated equivalent requests without extra transport', async () => {
    const executor = vi.fn(async () => ({ value: 'cached', estimatedBytes: 16 }))
    const coordinator = new ArcGisQueryCoordinator(executor, budget)
    await coordinator.query(key('OBJECTID > 1'))
    expect((await coordinator.query(key('OBJECTID > 1')).value).toBe('cached')
    expect(executor).toHaveBeenCalledTimes(1)
    expect(coordinator.diagnostics().cacheHits).toBe(1)
  })

  it('rejects malformed runtime keys before calling transport', async () => {
    const executor = vi.fn(async () => ({ value: 1, estimatedBytes: 8 }))
    const coordinator = new ArcGisQueryCoordinator(executor, budget)
    await expect(coordinator.query({ ...key('1=1'), returnGeometry: 'yes' } as unknown as ArcGisQueryKey)).rejects.toThrow()
    await expect(coordinator.query({ ...key('1=1'), outFields: 'OBJECTID' } as unknown as ArcGisQueryKey)).rejects.toThrow()
    expect(executor).not.toHaveBeenCalled()
  })
})
