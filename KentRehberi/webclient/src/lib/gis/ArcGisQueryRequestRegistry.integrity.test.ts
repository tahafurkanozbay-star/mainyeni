import { describe, expect, it, vi } from 'vitest'
import { ArcGisQueryRequestRegistry } from './ArcGisQueryRequestRegistry'
import type { ArcGisQueryExecutionResult } from './ArcGisQueryExecutionCoordinator'

function complete(key: string, ids: number[] = [1]): ArcGisQueryExecutionResult {
  return {
    kind: 'completed',
    key,
    pagesCompleted: 1,
    objectIds: ids,
    features: ids.map(id => ({ attributes: { OBJECTID: id } })),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('ArcGIS query request registry physical transport and cache integrity', () => {
  it('retains a physical lease after the last subscriber aborts a non-cooperative transport', async () => {
    const old = deferred<ArcGisQueryExecutionResult>()
    const executor = vi.fn(() => old.promise)
    const registry = new ArcGisQueryRequestRegistry(executor, { maxPhysicalInFlight: 1 })
    const abort = new AbortController()
    const pending = registry.request('parcel:1', abort.signal)
    expect(registry.snapshot()).toMatchObject({ inFlight: 1, physical: 1, subscribers: 1 })
    abort.abort()
    await expect(pending).resolves.toMatchObject({ kind: 'failed', code: 'aborted' })
    expect(registry.snapshot()).toMatchObject({ inFlight: 0, physical: 1, subscribers: 0 })
    await expect(registry.request('parcel:1')).resolves.toMatchObject({ kind: 'failed', code: 'transport-capacity' })
    expect(executor).toHaveBeenCalledTimes(1)
    old.resolve(complete('parcel:1'))
    await vi.waitFor(() => expect(registry.physicalInFlightCount).toBe(0))
    expect(registry.cachedCount).toBe(0)
    await expect(registry.request('parcel:1')).resolves.toMatchObject({ kind: 'completed' })
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it('does not reattach later callers to an aborted shared transport', async () => {
    const former = deferred<ArcGisQueryExecutionResult>()
    const newer = deferred<ArcGisQueryExecutionResult>()
    const executor = vi.fn()
      .mockImplementationOnce(() => former.promise)
      .mockImplementationOnce(() => newer.promise)
    const registry = new ArcGisQueryRequestRegistry(executor, { maxPhysicalInFlight: 2 })
    const abort = new AbortController()
    const first = registry.request('same-plan', abort.signal)
    abort.abort()
    await expect(first).resolves.toMatchObject({ kind: 'failed', code: 'aborted' })
    const next = registry.request('same-plan')
    expect(executor).toHaveBeenCalledTimes(2)
    former.resolve(complete('same-plan', [11]))
    await vi.waitFor(() => expect(registry.physicalInFlightCount).toBe(1))
    newer.resolve(complete('same-plan', [22]))
    await expect(next).resolves.toMatchObject({ kind: 'completed', objectIds: [22] })
    await expect(registry.request('same-plan')).resolves.toMatchObject({ objectIds: [22] })
  })

  it('enforces a bounded subscriber budget without aborting the admitted subscribers', async () => {
    const gate = deferred<ArcGisQueryExecutionResult>()
    const executor = vi.fn(() => gate.promise)
    const registry = new ArcGisQueryRequestRegistry(executor, { maxSubscribersPerQuery: 2 })
    const a = registry.request('shared')
    const b = registry.request('shared')
    await expect(registry.request('shared')).resolves.toMatchObject({ code: 'transport-capacity' })
    expect(registry.snapshot().subscribers).toBe(2)
    gate.resolve(complete('shared'))
    await expect(a).resolves.toMatchObject({ kind: 'completed' })
    await expect(b).resolves.toMatchObject({ kind: 'completed' })
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('invalidates in-flight results, resolves subscribers and cannot cache a stale response', async () => {
    const gate = deferred<ArcGisQueryExecutionResult>()
    const executor = vi.fn(() => gate.promise)
    const registry = new ArcGisQueryRequestRegistry(executor)
    const pending = registry.request('layer-v1')
    expect(registry.invalidate('layer-v1')).toBe(true)
    await expect(pending).resolves.toMatchObject({ kind: 'failed', code: 'aborted' })
    expect(registry.snapshot()).toMatchObject({ inFlight: 0, cached: 0, physical: 1 })
    gate.resolve(complete('layer-v1'))
    await vi.waitFor(() => expect(registry.physicalInFlightCount).toBe(0))
    expect(registry.cachedCount).toBe(0)
  })

  it('invalidates all active work while retaining physical capacity until settlement', async () => {
    const gate = deferred<ArcGisQueryExecutionResult>()
    const registry = new ArcGisQueryRequestRegistry(() => gate.promise, { maxPhysicalInFlight: 1 })
    const pending = registry.request('parcel-page')
    registry.invalidateAll()
    await expect(pending).resolves.toMatchObject({ code: 'aborted' })
    expect(registry.snapshot()).toMatchObject({ physical: 1, inFlight: 0, cached: 0 })
    await expect(registry.request('fresh')).resolves.toMatchObject({ code: 'transport-capacity' })
    gate.resolve(complete('parcel-page'))
    await vi.waitFor(() => expect(registry.physicalInFlightCount).toBe(0))
  })

  it('disposes terminally and does not restart transport after teardown', async () => {
    const gate = deferred<ArcGisQueryExecutionResult>()
    const executor = vi.fn(() => gate.promise)
    const registry = new ArcGisQueryRequestRegistry(executor)
    const pending = registry.request('first')
    registry.dispose()
    registry.dispose()
    await expect(pending).resolves.toMatchObject({ code: 'aborted' })
    await expect(registry.request('new')).resolves.toMatchObject({ code: 'aborted' })
    gate.resolve(complete('first'))
    await vi.waitFor(() => expect(registry.physicalInFlightCount).toBe(0))
    expect(registry.snapshot()).toMatchObject({ disposed: true, cached: 0, subscribers: 0 })
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('rejects uncontrolled and oversized query identity without invoking the executor', async () => {
    const executor = vi.fn(async ({ key }: { key: string }) => complete(key))
    const registry = new ArcGisQueryRequestRegistry(executor, { maxKeyLength: 8 })
    for (const key of ['', '    ', '\nkey', 'key\r', 'key\u007f', 'very-long-key']) {
      await expect(registry.request(key)).resolves.toMatchObject({ code: 'invalid-plan' })
    }
    expect(executor).not.toHaveBeenCalled()
    await expect(registry.request('valid')).resolves.toMatchObject({ kind: 'completed' })
  })

  it('rejects invalid and oversized physical, subscriber and feature budgets', () => {
    const executor = async () => complete('x')
    expect(() => new ArcGisQueryRequestRegistry(executor, { maxPhysicalInFlight: 0 })).toThrow()
    expect(() => new ArcGisQueryRequestRegistry(executor, { maxSubscribersPerQuery: 0 })).toThrow()
    expect(() => new ArcGisQueryRequestRegistry(executor, { maxCachedFeatures: 10, maxFeaturesPerEntry: 20 })).toThrow()
    expect(() => new ArcGisQueryRequestRegistry(executor, { maxKeyLength: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => new ArcGisQueryRequestRegistry(executor, { successTtlMs: Number.MAX_SAFE_INTEGER })).toThrow()
  })

  it('evicts cached results under aggregate feature pressure with deterministic LRU', async () => {
    const executor = vi.fn(async ({ key }: { key: string }) => complete(key, [1, 2]))
    const registry = new ArcGisQueryRequestRegistry(executor, {
      maxFeaturesPerEntry: 2, maxCachedFeatures: 4, maxEntries: 10,
    })
    await registry.request('a')
    await registry.request('b')
    await registry.request('a')
    await registry.request('c')
    expect(registry.snapshot()).toMatchObject({ cached: 2, cachedFeatures: 4 })
    await registry.request('b')
    expect(executor).toHaveBeenCalledTimes(4)
    registry.invalidate('b')
    expect(registry.cachedFeatureCount).toBe(2)
    registry.clear()
    expect(registry.cachedFeatureCount).toBe(0)
  })

  it('never caches a malformed or oversized success response', async () => {
    const executor = vi.fn()
      .mockResolvedValueOnce(complete('too-many', [1, 2, 3]))
      .mockResolvedValueOnce({ kind: 'completed', key: 'malformed', pagesCompleted: 1, objectIds: [1], features: [] })
    const registry = new ArcGisQueryRequestRegistry(executor, { maxFeaturesPerEntry: 2, maxCachedFeatures: 4 })
    await expect(registry.request('too-many')).resolves.toMatchObject({ kind: 'completed' })
    await expect(registry.request('malformed')).resolves.toMatchObject({ kind: 'completed' })
    expect(registry.cachedCount).toBe(0)
    expect(registry.cachedFeatureCount).toBe(0)
  })

  it('does not allow mutations of cached result container or feature/id arrays', async () => {
    const mutable = complete('parcel:2', [2, 3])
    const registry = new ArcGisQueryRequestRegistry(async () => mutable)
    await registry.request('parcel:2')
    const cached = await registry.request('parcel:2')
    expect(cached.kind).toBe('completed')
    if (cached.kind !== 'completed') return
    expect(Object.isFrozen(cached)).toBe(true)
    expect(Object.isFrozen(cached.features)).toBe(true)
    expect(Object.isFrozen(cached.objectIds)).toBe(true)
    expect(cached.objectIds).toEqual([2, 3])
  })

  it('keeps cached records expired when the system clock moves backwards', async () => {
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(1_000)
      const executor = vi.fn(async () => complete('clock'))
      const registry = new ArcGisQueryRequestRegistry(executor, { successTtlMs: 10 })
      await registry.request('clock')
      now.mockReturnValue(1_011)
      await registry.request('clock')
      now.mockReturnValue(1_002)
      await registry.request('clock')
      expect(executor).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })
})
