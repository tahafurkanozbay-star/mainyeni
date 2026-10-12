import { describe, expect, it, vi } from 'vitest'
import {
  ArcGisQueryCoordinator,
  type ArcGisQueryBudget,
  type ArcGisQueryKey,
  type ArcGisQueryResponse,
} from './ArcGisQueryCoordinator'

const budget: ArcGisQueryBudget = {
  maxEntries: 4, maxInflight: 2, maxWaitersPerQuery: 4,
  maxCacheAgeMs: 1000, maxCachedBytes: 1000, maxResponseBytes: 1000,
  maxWhereLength: 256, maxOutFields: 4,
}

const key: ArcGisQueryKey = {
  serviceId: 'parcels', layerId: 1, where: '1=1',
  outFields: ['OBJECTID'], returnGeometry: false,
}

function deferred() {
  let resolve!: (value: ArcGisQueryResponse<string>) => void
  const promise = new Promise<ArcGisQueryResponse<string>>(done => { resolve = done })
  return { promise, resolve }
}

describe('ArcGIS query physical single-flight cancellation', () => {
  it('keeps a noncooperative transport occupying capacity after its last caller leaves', async () => {
    const unfinished = deferred()
    const executor = vi.fn(() => unfinished.promise)
    const query = new ArcGisQueryCoordinator(executor, { ...budget, maxInflight: 1 }, () => 100)
    const abort = new AbortController()
    const first = query.query(key, abort.signal)
    expect(query.diagnostics().inflight).toBe(1)
    abort.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(query.diagnostics().inflight).toBe(1)
    await expect(query.query(key)).rejects.toThrow('inflight budget')
    expect(executor).toHaveBeenCalledTimes(1)
    unfinished.resolve({ value: 'stale', estimatedBytes: 5 })
    await vi.waitFor(() => expect(query.diagnostics().inflight).toBe(0))
    expect(query.diagnostics().cacheEntries).toBe(0)
    const second = await query.query(key)
    expect(second.value).toBe('stale')
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it('restarts same query with a fresh signal when capacity allows it', async () => {
    const stale = deferred()
    const current = deferred()
    const executor = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise)
    const query = new ArcGisQueryCoordinator(executor, budget, () => 100)
    const abort = new AbortController()
    const first = query.query(key, abort.signal)
    abort.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = query.query(key)
    expect(executor).toHaveBeenCalledTimes(2)
    stale.resolve({ value: 'stale', estimatedBytes: 5 })
    await vi.waitFor(() => expect(query.diagnostics().inflight).toBe(1))
    expect(query.diagnostics().cacheEntries).toBe(0)
    current.resolve({ value: 'current', estimatedBytes: 7 })
    await expect(second).resolves.toMatchObject({ value: 'current' })
    expect((await query.query(key)).value).toBe('current')
    expect(query.diagnostics().cacheEntries).toBe(1)
  })

  it('one cancelled subscriber cannot abort shared transport needed by another', async () => {
    const gate = deferred()
    const executor = vi.fn(() => gate.promise)
    const query = new ArcGisQueryCoordinator(executor, budget, () => 100)
    const controller = new AbortController()
    const first = query.query(key, controller.signal)
    const second = query.query(key)
    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(query.diagnostics().inflight).toBe(1)
    gate.resolve({ value: 'shared', estimatedBytes: 4 })
    await expect(second).resolves.toMatchObject({ value: 'shared' })
    expect(executor).toHaveBeenCalledTimes(1)
  })
})
