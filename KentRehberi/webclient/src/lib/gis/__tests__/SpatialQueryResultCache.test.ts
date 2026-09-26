import { describe, expect, it } from 'vitest'
import { SpatialQueryResultCache } from '../SpatialQueryResultCache'

const key = (layerId = 'roads', queryKey = 'extent:1', revision = 'r1') => ({ layerId, queryKey, revision })
const value = (name: string, byteSize = 10, featureCount = 1) => ({ value: name, byteSize, featureCount })

describe('SpatialQueryResultCache', () => {
  it('stores and retrieves results', () => {
    const cache = new SpatialQueryResultCache<string>()
    expect(cache.set(key(), value('a'), 100)).toBe(true)
    expect(cache.get(key(), 101)?.value).toBe('a')
  })

  it('expires entries at ttl boundary', () => {
    const cache = new SpatialQueryResultCache<string>({ ttlMs: 10 })
    cache.set(key(), value('a'), 100)
    expect(cache.get(key(), 109)?.value).toBe('a')
    expect(cache.get(key(), 110)).toBeNull()
    expect(cache.snapshot().expirations).toBe(1)
  })

  it('prunes expired entries deterministically', () => {
    const cache = new SpatialQueryResultCache<string>({ ttlMs: 10 })
    cache.set(key('a'), value('a'), 100)
    cache.set(key('b'), value('b'), 105)
    expect(cache.pruneExpired(111)).toBe(1)
    expect(cache.snapshot().entries).toBe(1)
  })

  it('evicts least recently used entry under count pressure', () => {
    const cache = new SpatialQueryResultCache<string>({ maxEntries: 2 })
    cache.set(key('a'), value('a'), 100)
    cache.set(key('b'), value('b'), 100)
    cache.get(key('a'), 101)
    cache.set(key('c'), value('c'), 102)
    expect(cache.has(key('a'), 103)).toBe(true)
    expect(cache.has(key('b'), 103)).toBe(false)
    expect(cache.has(key('c'), 103)).toBe(true)
  })

  it('evicts under global byte pressure', () => {
    const cache = new SpatialQueryResultCache<string>({ maxBytes: 20, maxBytesPerLayer: 20 })
    cache.set(key('a'), value('a', 12), 100)
    cache.set(key('b'), value('b', 12), 101)
    expect(cache.snapshot()).toMatchObject({ entries: 1, bytes: 12, evictions: 1 })
  })

  it('evicts within a layer without penalizing another layer first', () => {
    const cache = new SpatialQueryResultCache<string>({ maxBytes: 100, maxBytesPerLayer: 20 })
    cache.set(key('stable'), value('stable', 15), 100)
    cache.set(key('hot', 'q1'), value('one', 15), 101)
    cache.set(key('hot', 'q2'), value('two', 15), 102)
    expect(cache.has(key('stable'), 103)).toBe(true)
    expect(cache.has(key('hot', 'q1'), 103)).toBe(false)
    expect(cache.has(key('hot', 'q2'), 103)).toBe(true)
  })

  it('rejects values larger than per-layer capacity', () => {
    const cache = new SpatialQueryResultCache<string>({ maxBytes: 100, maxBytesPerLayer: 20 })
    expect(cache.set(key(), value('x', 21), 100)).toBe(false)
    expect(cache.snapshot().rejectedWrites).toBe(1)
  })

  it('rejects malformed identities', () => {
    const cache = new SpatialQueryResultCache<string>()
    expect(cache.set(key(' '), value('x'), 100)).toBe(false)
    expect(cache.set(key('a\u0000b'), value('x'), 100)).toBe(false)
  })

  it('rejects invalid byte and feature estimates', () => {
    const cache = new SpatialQueryResultCache<string>()
    expect(cache.set(key(), value('x', 0), 100)).toBe(false)
    expect(cache.set(key(), value('x', 1, -1), 100)).toBe(false)
  })

  it('keeps revisions isolated', () => {
    const cache = new SpatialQueryResultCache<string>()
    cache.set(key('a', 'q', 'r1'), value('old'), 100)
    cache.set(key('a', 'q', 'r2'), value('new'), 100)
    expect(cache.get(key('a', 'q', 'r1'), 101)?.value).toBe('old')
    expect(cache.get(key('a', 'q', 'r2'), 101)?.value).toBe('new')
  })

  it('invalidates exactly one layer', () => {
    const cache = new SpatialQueryResultCache<string>()
    cache.set(key('a'), value('a'), 100)
    cache.set(key('b'), value('b'), 100)
    expect(cache.invalidateLayer('a')).toBe(1)
    expect(cache.has(key('a'), 101)).toBe(false)
    expect(cache.has(key('b'), 101)).toBe(true)
  })

  it('deletes exact identities', () => {
    const cache = new SpatialQueryResultCache<string>()
    cache.set(key(), value('a'), 100)
    expect(cache.delete(key())).toBe(true)
    expect(cache.delete(key())).toBe(false)
  })

  it('clear releases all byte accounting', () => {
    const cache = new SpatialQueryResultCache<string>()
    cache.set(key('a'), value('a', 20), 100)
    cache.set(key('b'), value('b', 30), 100)
    cache.clear()
    expect(cache.snapshot()).toMatchObject({ entries: 0, bytes: 0 })
  })

  it('tracks hits and misses', () => {
    const cache = new SpatialQueryResultCache<string>()
    cache.set(key(), value('a'), 100)
    cache.get(key(), 101)
    cache.get(key('missing'), 101)
    expect(cache.snapshot()).toMatchObject({ hits: 1, misses: 1 })
  })

  it('reports layers in lexical order', () => {
    const cache = new SpatialQueryResultCache<string>()
    cache.set(key('z'), value('z'), 100)
    cache.set(key('a'), value('a'), 100)
    expect(cache.snapshot().layers.map(layer => layer.layerId)).toEqual(['a', 'z'])
  })

  it('reports per-layer bytes and entry counts', () => {
    const cache = new SpatialQueryResultCache<string>()
    cache.set(key('a', '1'), value('one', 11), 100)
    cache.set(key('a', '2'), value('two', 13), 100)
    expect(cache.snapshot().layers[0]).toMatchObject({ layerId: 'a', entries: 2, bytes: 24 })
  })

  it('normalizes surrounding identity whitespace', () => {
    const cache = new SpatialQueryResultCache<string>()
    cache.set(key(' a ', ' q ', ' r1 '), value('x'), 100)
    expect(cache.get(key('a', 'q', 'r1'), 101)?.value).toBe('x')
  })

  it('returns frozen read values and snapshots', () => {
    const cache = new SpatialQueryResultCache<string>()
    cache.set(key(), value('x'), 100)
    expect(Object.isFrozen(cache.get(key(), 101))).toBe(true)
    const snapshot = cache.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.layers)).toBe(true)
  })

  it('rejects invalid cache budgets', () => {
    expect(() => new SpatialQueryResultCache({ maxEntries: 0 })).toThrow('Invalid spatial query result cache option')
    expect(() => new SpatialQueryResultCache({ maxBytes: 10, maxBytesPerLayer: 11 })).toThrow('maxBytesPerLayer exceeds maxBytes')
  })

  it('does not count has as a cache hit', () => {
    const cache = new SpatialQueryResultCache<string>()
    cache.set(key(), value('x'), 100)
    expect(cache.has(key(), 101)).toBe(true)
    expect(cache.snapshot()).toMatchObject({ hits: 0, misses: 0 })
  })
})
