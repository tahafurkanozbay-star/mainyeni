import { it, expect } from 'vitest'
import { ArcGisQueryCoordinator } from './ArcGisQueryCoordinator'

it('does not admit an overlapping replacement when the global inflight budget is full', async () => {
  let finish!: (value: { value: number; estimatedBytes: number }) => void
  const pending = new Promise<{ value: number; estimatedBytes: number }>(resolve => { finish = resolve })
  const query = new ArcGisQueryCoordinator(() => pending, {
    maxEntries: 1, maxInflight: 1, maxWaitersPerQuery: 2, maxCacheAgeMs: 100,
    maxCachedBytes: 100, maxResponseBytes: 100, maxWhereLength: 100, maxOutFields: 1,
  })
  const key = { serviceId: 'a', layerId: 0, where: '1=1', outFields: ['OBJECTID'], returnGeometry: false }
  const first = query.query(key)
  query.invalidateAll()
  await expect(query.query(key)).rejects.toThrow('inflight budget')
  finish({ value: 1, estimatedBytes: 1 })
  await first
  expect(query.diagnostics().inflight).toBe(0)
})
