import { describe, expect, it, vi } from 'vitest'
import { ArcGisQueryRequestRegistry } from './ArcGisQueryRequestRegistry'
import { snapshotArcGisQueryResult } from './ArcGisQueryResultSnapshot'
import type { ArcGisQueryExecutionResult } from './ArcGisQueryExecutionCoordinator'

function completed(key: string, ids: number[] = [1]): ArcGisQueryExecutionResult {
  return {
    kind: 'completed', key, pagesCompleted: 1, objectIds: ids,
    features: ids.map(id => ({
      attributes: { OBJECTID: id, label: 'parcel' },
      geometry: { x: id, y: id * 2, spatialReference: { wkid: 4326 } },
    })),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const limits = { maxFeaturesPerEntry: 100, maxBytesPerEntry: 1_000_000, maxNodesPerEntry: 10_000 }

describe('ArcGIS query result immutable retention boundary', () => {
  it('rejects malformed completed envelopes instead of forwarding them', async () => {
    const executor = vi.fn(async () => ({
      kind: 'completed', key: 'parcel', pagesCompleted: 1,
      features: [], objectIds: [1],
    } as ArcGisQueryExecutionResult))
    const registry = new ArcGisQueryRequestRegistry(executor)
    await expect(registry.request('parcel')).resolves.toEqual({
      kind: 'failed', code: 'integrity-error',
    })
    expect(registry.snapshot()).toMatchObject({ cached: 0, cachedBytes: 0, physical: 0 })
  })

  it('captures independent nested geometry/attributes for the first and cached subscribers', async () => {
    const source = completed('parcel', [3])
    const registry = new ArcGisQueryRequestRegistry(async () => source)
    const first = await registry.request('parcel')
    expect(first.kind).toBe('completed')
    if (first.kind !== 'completed' || source.kind !== 'completed') return
    const feature = first.features[0] as { attributes: { label: string }; geometry: { spatialReference: { wkid: number } } }
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(feature.attributes)).toBe(true)
    expect(Object.isFrozen(feature.geometry.spatialReference)).toBe(true)
    ;(source.features[0] as { attributes: { label: string }; geometry: { spatialReference: { wkid: number } } }).attributes.label = 'mutated'
    ;(source.features[0] as { attributes: { label: string }; geometry: { spatialReference: { wkid: number } } }).geometry.spatialReference.wkid = 3857
    const cached = await registry.request('parcel')
    expect(cached).toBe(first)
    expect(feature.attributes.label).toBe('parcel')
    expect(feature.geometry.spatialReference.wkid).toBe(4326)
    expect(registry.cachedByteCount).toBeGreaterThan(0)
  })

  it('shares a single frozen snapshot between concurrent subscribers', async () => {
    const gate = deferred<ArcGisQueryExecutionResult>()
    const registry = new ArcGisQueryRequestRegistry(() => gate.promise)
    const first = registry.request('same')
    const second = registry.request('same')
    gate.resolve(completed('same', [1, 2]))
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(a.kind).toBe('completed')
    expect(registry.snapshot()).toMatchObject({ inFlight: 0, subscribers: 0, cached: 1 })
  })

  it('rejects sparse arrays, duplicate IDs and mismatched executor keys', async () => {
    const sparse: unknown[] = []
    sparse.length = 1
    const bad = [
      { kind: 'completed', key: 'x', pagesCompleted: 1, features: sparse, objectIds: [1] },
      completed('x', [1, 1]),
      completed('other'),
    ] as ArcGisQueryExecutionResult[]
    for (const result of bad) {
      const registry = new ArcGisQueryRequestRegistry(async () => result)
      await expect(registry.request('x')).resolves.toMatchObject({ code: 'integrity-error' })
      expect(registry.cachedCount).toBe(0)
    }
  })

  it('does not invoke nested accessors and never exposes a getter-backed feature', async () => {
    let invoked = 0
    const feature = { attributes: { OBJECTID: 1 } } as { attributes: { OBJECTID: number }; geometry?: unknown }
    Object.defineProperty(feature, 'geometry', { enumerable: true, get() {
      invoked += 1
      throw new Error('must not execute')
    } })
    const registry = new ArcGisQueryRequestRegistry(async () => ({
      kind: 'completed', key: 'accessor', pagesCompleted: 1,
      features: [feature], objectIds: [1],
    }))
    await expect(registry.request('accessor')).resolves.toMatchObject({ code: 'integrity-error' })
    expect(invoked).toBe(0)
  })

  it('rejects cycles, non-finite coordinates, class instances and excessive nesting', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const invalid = [
      { attributes: { OBJECTID: 1 }, geometry: cycle },
      { attributes: { OBJECTID: 1 }, geometry: { x: Number.POSITIVE_INFINITY } },
      { attributes: { OBJECTID: 1 }, geometry: new Date() },
      { attributes: { OBJECTID: 1 }, geometry: { nested: Array.from({ length: 14 }, () => 1) } },
    ]
    for (const feature of invalid.slice(0, 3)) {
      expect(snapshotArcGisQueryResult({
        kind: 'completed', key: 'x', pagesCompleted: 1, features: [feature], objectIds: [1],
      }, 'x', limits)).toBeNull()
    }
    let deep: unknown = 1
    for (let index = 0; index < 15; index += 1) deep = { nested: deep }
    expect(snapshotArcGisQueryResult({
      kind: 'completed', key: 'x', pagesCompleted: 1,
      features: [{ attributes: { OBJECTID: 1 }, geometry: deep }], objectIds: [1],
    }, 'x', limits)).toBeNull()
  })

  it('accepts repeated source geometry across features without retaining an alias', () => {
    const geometry = { x: 1, y: 2 }
    const result = snapshotArcGisQueryResult({
      kind: 'completed', key: 'shared', pagesCompleted: 1,
      features: [
        { attributes: { OBJECTID: 1 }, geometry },
        { attributes: { OBJECTID: 2 }, geometry },
      ],
      objectIds: [1, 2],
    }, 'shared', limits)
    expect(result?.result.kind).toBe('completed')
    if (result?.result.kind !== 'completed') return
    const first = result.result.features[0] as { geometry: object }
    const second = result.result.features[1] as { geometry: object }
    expect(first.geometry).not.toBe(second.geometry)
    expect(first.geometry).toEqual(second.geometry)
  })

  it('preserves own special JSON fields without changing object prototypes', () => {
    const attrs: Record<string, unknown> = { OBJECTID: 1 }
    Object.defineProperty(attrs, '__proto__', {
      enumerable: true, value: { safe: true }, configurable: true,
    })
    const result = snapshotArcGisQueryResult({
      kind: 'completed', key: 'own', pagesCompleted: 1,
      objectIds: [1], features: [{ attributes: attrs }],
    }, 'own', limits)
    expect(result?.result.kind).toBe('completed')
    if (result?.result.kind !== 'completed') return
    const feature = result.result.features[0] as { attributes: Record<string, unknown> }
    expect(Object.prototype.hasOwnProperty.call(feature.attributes, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(feature.attributes)).toBe(Object.prototype)
    expect(({} as { safe?: boolean }).safe).toBeUndefined()
  })

  it('enforces per-entry bytes and node caps before caching or delivery', async () => {
    const large = {
      kind: 'completed' as const, key: 'large', pagesCompleted: 1,
      objectIds: [1],
      features: [{ attributes: { OBJECTID: 1, description: 'x'.repeat(1_000) } }],
    }
    const registry = new ArcGisQueryRequestRegistry(async () => large, {
      maxBytesPerEntry: 500, maxCachedBytes: 1_000,
    })
    await expect(registry.request('large')).resolves.toMatchObject({ code: 'integrity-error' })
    expect(registry.cachedByteCount).toBe(0)
    const nodeRegistry = new ArcGisQueryRequestRegistry(async () => completed('nodes'), {
      maxNodesPerEntry: 2,
    })
    await expect(nodeRegistry.request('nodes')).resolves.toMatchObject({ code: 'integrity-error' })
    expect(nodeRegistry.cachedCount).toBe(0)
  })

  it('evicts least recently used entries under aggregate retained byte pressure', async () => {
    const executor = vi.fn(async ({ key }: { key: string }) => ({
      kind: 'completed' as const, key, pagesCompleted: 1, objectIds: [1],
      features: [{ attributes: { OBJECTID: 1, text: 'x'.repeat(180) } }],
    }))
    const registry = new ArcGisQueryRequestRegistry(executor, {
      maxCachedBytes: 1_000, maxBytesPerEntry: 900,
    })
    await registry.request('a')
    const singleBytes = registry.cachedByteCount
    expect(singleBytes).toBeGreaterThan(0)
    await registry.request('b')
    await registry.request('c')
    expect(registry.cachedByteCount).toBeLessThanOrEqual(1_000)
    expect(registry.cachedCount).toBeLessThan(3)
    await registry.request('a')
    expect(executor).toHaveBeenCalledTimes(4)
    registry.clear()
    expect(registry.cachedByteCount).toBe(0)
  })

  it('releases byte accounting on explicit invalidation, expiry and disposal', async () => {
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(1_000)
      const registry = new ArcGisQueryRequestRegistry(async ({ key }) => completed(key), {
        successTtlMs: 10,
      })
      await registry.request('a')
      expect(registry.cachedByteCount).toBeGreaterThan(0)
      registry.invalidate('a')
      expect(registry.cachedByteCount).toBe(0)
      await registry.request('a')
      now.mockReturnValue(1_011)
      await registry.request('b')
      expect(registry.cachedCount).toBe(1)
      registry.dispose()
      expect(registry.snapshot()).toMatchObject({ cached: 0, cachedBytes: 0, disposed: true })
    } finally {
      now.mockRestore()
    }
  })

  it('sanitizes failure envelopes and rejects invalid status codes', async () => {
    const registry = new ArcGisQueryRequestRegistry(async () => ({
      kind: 'failed', code: 'integrity-error', page: 2,
      integrity: { kind: 'rejected', issue: { code: 'invalid-object-id', featureIndex: 4, field: 'OBJECTID' } },
      privateTransportPayload: { token: 'not-for-subscribers' },
    } as ArcGisQueryExecutionResult))
    const result = await registry.request('x')
    expect(result).toEqual({
      kind: 'failed', code: 'integrity-error', page: 2,
      integrity: { kind: 'rejected', issue: { code: 'invalid-object-id', featureIndex: 4, field: 'OBJECTID' } },
    })
    expect(Object.isFrozen(result)).toBe(true)
    const unknown = new ArcGisQueryRequestRegistry(async () => ({
      kind: 'failed', code: 'custom-unsafe-code',
    } as unknown as ArcGisQueryExecutionResult))
    await expect(unknown.request('x')).resolves.toMatchObject({ code: 'integrity-error' })
  })

  it('rejects malformed configuration budgets before allocating cache state', () => {
    const executor = async () => completed('x')
    expect(() => new ArcGisQueryRequestRegistry(executor, { maxBytesPerEntry: 0 })).toThrow()
    expect(() => new ArcGisQueryRequestRegistry(executor, {
      maxCachedBytes: 100, maxBytesPerEntry: 101,
    })).toThrow()
    expect(() => new ArcGisQueryRequestRegistry(executor, { maxNodesPerEntry: Number.POSITIVE_INFINITY })).toThrow()
  })
})
