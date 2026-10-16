import { describe, expect, it, vi } from 'vitest'
import { ArcGisCacheExpiryIndex } from './ArcGisQueryCacheExpiryIndex'
import { ArcGisQueryRequestRegistry } from './ArcGisQueryRequestRegistry'

describe('ArcGIS cache expiry index', () => {
  it('orders deadlines and deterministically breaks ties by key', () => {
    const index = new ArcGisCacheExpiryIndex(8)
    index.set('z', 10)
    index.set('a', 10)
    index.set('b', 3)
    index.set('c', 20)
    expect(index.size).toBe(4)
    expect(index.nextExpiry).toBe(3)
    expect(index.popExpired(2)).toBeUndefined()
    expect(index.popExpired(3)).toBe('b')
    expect(index.popExpired(10)).toBe('a')
    expect(index.popExpired(10)).toBe('z')
    expect(index.popExpired(19)).toBeUndefined()
    expect(index.popExpired(20)).toBe('c')
    expect(index.popExpired(20)).toBeUndefined()
    expect(index.size).toBe(0)
  })

  it('updates existing deadlines in both directions without duplicate tickets', () => {
    const index = new ArcGisCacheExpiryIndex(3)
    index.set('a', 10)
    index.set('b', 20)
    index.set('c', 30)
    index.set('a', 40)
    expect(index.nextExpiry).toBe(20)
    index.set('c', 5)
    expect(index.nextExpiry).toBe(5)
    expect(index.size).toBe(3)
    expect(index.popExpired(5)).toBe('c')
    expect(index.popExpired(20)).toBe('b')
    expect(index.popExpired(40)).toBe('a')
  })

  it('removes root, internal and last nodes while keeping the index aligned', () => {
    const index = new ArcGisCacheExpiryIndex(16)
    for (let i = 0; i < 12; i += 1) index.set('k' + i, i + 1)
    expect(index.delete('k0')).toBe(true)
    expect(index.delete('k7')).toBe(true)
    expect(index.delete('k11')).toBe(true)
    expect(index.delete('k7')).toBe(false)
    expect(index.has('k7')).toBe(false)
    expect(index.size).toBe(9)
    const seen: string[] = []
    while (index.nextExpiry !== undefined) {
      const key = index.popExpired(20)
      if (key !== undefined) seen.push(key)
    }
    expect(seen).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k8', 'k9', 'k10'])
    expect(index.size).toBe(0)
  })

  it('never retains tombstones under repeated invalidation and re-admission', () => {
    const index = new ArcGisCacheExpiryIndex(4)
    for (let i = 0; i < 4_000; i += 1) {
      const key = 'service-' + (i % 4)
      index.set(key, i + 10)
      expect(index.size).toBeLessThanOrEqual(4)
      if (i % 2 === 0) expect(index.delete(key)).toBe(true)
    }
    index.clear()
    expect(index.size).toBe(0)
    expect(index.nextExpiry).toBeUndefined()
  })

  it('matches a reference map under deterministic mixed updates, deletes and expiries', () => {
    const index = new ArcGisCacheExpiryIndex(16)
    const reference = new Map<string, number>()
    let clock = 0
    for (let step = 0; step < 500; step += 1) {
      const key = 'k' + ((step * 37 + 11) % 13)
      const operation = step % 7
      if (operation <= 3) {
        const expiresAt = clock + ((step * 17) % 40)
        index.set(key, expiresAt)
        reference.set(key, expiresAt)
      } else if (operation === 4) {
        expect(index.delete(key)).toBe(reference.delete(key))
      } else {
        clock += 1
        const expected = [...reference].filter(([, expiry]) => expiry <= clock)
          .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]
        expect(index.popExpired(clock)).toBe(expected?.[0])
        if (expected !== undefined) reference.delete(expected[0])
      }
      expect(index.size).toBe(reference.size)
      const minimum = [...reference.values()].reduce<number | undefined>(
        (min, value) => min === undefined ? value : Math.min(min, value), undefined,
      )
      expect(index.nextExpiry).toBe(minimum)
    }
  })

  it('rejects unsafe deadlines and over-capacity writes without mutation', () => {
    expect(() => new ArcGisCacheExpiryIndex(0)).toThrow()
    expect(() => new ArcGisCacheExpiryIndex(100_002)).toThrow()
    const index = new ArcGisCacheExpiryIndex(1)
    expect(() => index.set('', 1)).toThrow()
    expect(() => index.set('x', Number.NaN)).toThrow()
    expect(() => index.set('x', -1)).toThrow()
    expect(() => index.set('x', Number.MAX_SAFE_INTEGER + 1)).toThrow()
    index.set('x', 1)
    expect(() => index.set('y', 2)).toThrow('capacity')
    expect(index.size).toBe(1)
    expect(index.nextExpiry).toBe(1)
    expect(() => index.popExpired(Number.POSITIVE_INFINITY)).toThrow('clock')
    expect(index.popExpired(1)).toBe('x')
  })
})

describe('ArcGIS request registry TTL integration', () => {
  const response = (key: string) => ({
    kind: 'completed' as const,
    key, pagesCompleted: 1, objectIds: [1],
    features: [{ attributes: { OBJECTID: 1, label: key } }],
  })

  it('prunes expired entries despite LRU promotion and refunds byte/feature budgets', async () => {
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(1_000)
      const executor = vi.fn(async ({ key }: { key: string }) => response(key))
      const registry = new ArcGisQueryRequestRegistry(executor, {
        maxEntries: 3, successTtlMs: 10,
      })
      await registry.request('a')
      now.mockReturnValue(1_005)
      await registry.request('b')
      await registry.request('a') // Promoted in LRU but keeps its original expiry.
      expect(executor).toHaveBeenCalledTimes(2)
      now.mockReturnValue(1_010)
      await registry.request('c')
      expect(registry.cachedCount).toBe(2)
      expect(registry.cachedFeatureCount).toBe(2)
      expect(registry.cachedByteCount).toBeGreaterThan(0)
      await registry.request('a')
      expect(executor).toHaveBeenCalledTimes(4)
      now.mockReturnValue(1_016)
      await registry.request('d')
      expect(registry.cachedCount).toBe(3)
      registry.invalidateAll()
      expect(registry.snapshot()).toMatchObject({
        cached: 0, cachedFeatures: 0, cachedBytes: 0,
      })
    } finally {
      now.mockRestore()
    }
  })

  it('maintains TTL index consistency under cache churn and disposal', async () => {
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(5_000)
      const registry = new ArcGisQueryRequestRegistry(async ({ key }) => response(key), {
        maxEntries: 2, successTtlMs: 100,
      })
      for (let i = 0; i < 60; i += 1) {
        await registry.request('k' + i)
        expect(registry.cachedCount).toBeLessThanOrEqual(2)
        expect(registry.cachedFeatureCount).toBe(registry.cachedCount)
      }
      now.mockReturnValue(5_101)
      await registry.request('last')
      expect(registry.cachedCount).toBe(1)
      registry.dispose()
      expect(registry.snapshot()).toMatchObject({
        cached: 0, cachedBytes: 0, cachedFeatures: 0, disposed: true,
      })
    } finally {
      now.mockRestore()
    }
  })
})
