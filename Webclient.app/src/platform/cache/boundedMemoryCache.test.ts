import { describe, expect, it } from 'vitest';
import { BoundedMemoryCache } from './boundedMemoryCache';

const manualClock = (initial = 0) => {
  let now = initial;
  return {
    clock: { now: () => now },
    set: (value: number) => { now = value; },
    advance: (delta: number) => { now += delta; },
  };
};

describe('BoundedMemoryCache', () => {
  it('stores and returns a fresh immutable entry', () => {
    const time = manualClock(100);
    const cache = new BoundedMemoryCache({ clock: time.clock });

    const written = cache.put({
      key: 'catalog|GET|/places',
      namespace: 'catalog',
      value: { count: 3 },
      ttlMs: 1000,
      byteSize: 128,
      tags: ['places'],
    });
    const result = cache.get<{ count: number }>('catalog|GET|/places');

    expect(written).toMatchObject({
      createdAt: 100,
      refreshedAt: 100,
      freshUntil: 1100,
      staleUntil: 1100,
      byteSize: 128,
      version: 1,
    });
    expect(result).toMatchObject({
      hit: true,
      state: 'fresh',
      source: 'memory',
      value: { count: 3 },
    });
    expect(Object.isFrozen(written)).toBe(true);
    expect(Object.isFrozen(written.tags)).toBe(true);
    cache.assertConsistent();
  });

  it('serves stale values only while the stale window is open', () => {
    const time = manualClock();
    const cache = new BoundedMemoryCache({ clock: time.clock });
    cache.put({
      key: 'catalog|GET|/places',
      namespace: 'catalog',
      value: 'v1',
      ttlMs: 100,
      staleWhileRevalidateMs: 200,
      byteSize: 32,
    });

    time.set(150);
    expect(cache.get('catalog|GET|/places')).toMatchObject({
      hit: true,
      state: 'stale',
      source: 'stale-memory',
      value: 'v1',
    });
    expect(cache.get('catalog|GET|/places', false)).toMatchObject({
      hit: false,
      state: 'miss',
    });

    time.set(301);
    expect(cache.get('catalog|GET|/places')).toMatchObject({
      hit: false,
      state: 'miss',
    });
    expect(cache.snapshot().entries).toBe(0);
  });

  it('replaces values without leaking byte or namespace accounting', () => {
    const time = manualClock(10);
    const cache = new BoundedMemoryCache({ clock: time.clock });
    const first = cache.put({
      key: 'catalog|GET|/places',
      namespace: 'catalog',
      value: 'first',
      ttlMs: 1000,
      byteSize: 100,
    });
    time.advance(10);
    const second = cache.put({
      key: 'catalog|GET|/places',
      namespace: 'catalog',
      value: 'second',
      ttlMs: 1000,
      byteSize: 180,
    });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.refreshedAt).toBe(20);
    expect(second.version).toBe(2);
    expect(cache.snapshot()).toMatchObject({
      entries: 1,
      bytes: 180,
      namespaces: 1,
      writes: 2,
    });
    cache.assertConsistent();
  });

  it('evicts the least recently used entry at global entry capacity', () => {
    const cache = new BoundedMemoryCache({
      maxEntries: 2,
      maxEntriesPerNamespace: 2,
      maxBytes: 4096,
      maxBytesPerNamespace: 4096,
      maxEntryBytes: 1024,
    });
    cache.put({ key: 'a', namespace: 'catalog', value: 1, ttlMs: 1000, byteSize: 32 });
    cache.put({ key: 'b', namespace: 'catalog', value: 2, ttlMs: 1000, byteSize: 32 });
    expect(cache.get('a').hit).toBe(true);

    cache.put({ key: 'c', namespace: 'catalog', value: 3, ttlMs: 1000, byteSize: 32 });

    expect(cache.get('a').hit).toBe(true);
    expect(cache.get('b').hit).toBe(false);
    expect(cache.get('c').hit).toBe(true);
    expect(cache.snapshot().evictions).toBe(1);
    cache.assertConsistent();
  });

  it('evicts within the constrained namespace before touching another namespace', () => {
    const cache = new BoundedMemoryCache({
      maxEntries: 4,
      maxEntriesPerNamespace: 1,
      maxBytes: 4096,
      maxBytesPerNamespace: 2048,
      maxEntryBytes: 1024,
    });
    cache.put({ key: 'catalog-a', namespace: 'catalog', value: 1, ttlMs: 1000, byteSize: 32 });
    cache.put({ key: 'search-a', namespace: 'search', value: 2, ttlMs: 1000, byteSize: 32 });
    cache.put({ key: 'catalog-b', namespace: 'catalog', value: 3, ttlMs: 1000, byteSize: 32 });

    expect(cache.get('catalog-a').hit).toBe(false);
    expect(cache.get('catalog-b').hit).toBe(true);
    expect(cache.get('search-a').hit).toBe(true);
    cache.assertConsistent();
  });

  it('evicts until the byte budget can admit a value', () => {
    const cache = new BoundedMemoryCache({
      maxEntries: 8,
      maxEntriesPerNamespace: 8,
      maxBytes: 1024,
      maxBytesPerNamespace: 1024,
      maxEntryBytes: 800,
    });
    cache.put({ key: 'a', namespace: 'catalog', value: 1, ttlMs: 1000, byteSize: 400 });
    cache.put({ key: 'b', namespace: 'catalog', value: 2, ttlMs: 1000, byteSize: 400 });
    cache.put({ key: 'c', namespace: 'catalog', value: 3, ttlMs: 1000, byteSize: 600 });

    expect(cache.snapshot()).toMatchObject({
      entries: 2,
      bytes: 1000,
      evictions: 1,
    });
    expect(cache.get('a').hit).toBe(false);
  });

  it('rejects a single entry larger than the configured bound', () => {
    const cache = new BoundedMemoryCache({
      maxBytes: 4096,
      maxBytesPerNamespace: 4096,
      maxEntryBytes: 128,
    });
    expect(() => cache.put({
      key: 'oversized',
      namespace: 'catalog',
      value: 'value',
      ttlMs: 1000,
      byteSize: 129,
    })).toMatchObject({ code: 'entry-too-large' });
    expect(cache.snapshot()).toMatchObject({ entries: 0, rejectedWrites: 1 });
  });

  it('invalidates entries by tag without scanning unrelated keys externally', () => {
    const cache = new BoundedMemoryCache();
    cache.put({
      key: 'place-1',
      namespace: 'catalog',
      value: 1,
      ttlMs: 1000,
      byteSize: 32,
      tags: ['places', 'district:1'],
    });
    cache.put({
      key: 'place-2',
      namespace: 'catalog',
      value: 2,
      ttlMs: 1000,
      byteSize: 32,
      tags: ['places', 'district:2'],
    });
    cache.put({
      key: 'road-1',
      namespace: 'catalog',
      value: 3,
      ttlMs: 1000,
      byteSize: 32,
      tags: ['roads'],
    });

    expect(cache.invalidateTags(['district:1'])).toBe(1);
    expect(cache.get('place-1').hit).toBe(false);
    expect(cache.get('place-2').hit).toBe(true);
    expect(cache.get('road-1').hit).toBe(true);
    cache.assertConsistent();
  });

  it('invalidates a complete namespace while preserving another namespace', () => {
    const cache = new BoundedMemoryCache();
    cache.put({ key: 'catalog-a', namespace: 'catalog', value: 1, ttlMs: 1000, byteSize: 32 });
    cache.put({ key: 'catalog-b', namespace: 'catalog', value: 2, ttlMs: 1000, byteSize: 32 });
    cache.put({ key: 'search-a', namespace: 'search', value: 3, ttlMs: 1000, byteSize: 32 });

    expect(cache.invalidateNamespace('catalog')).toBe(2);
    expect(cache.snapshot()).toMatchObject({ entries: 1, namespaces: 1 });
    expect(cache.get('search-a').hit).toBe(true);
    cache.assertConsistent();
  });

  it('prunes only expired entries up to the requested bounded limit', () => {
    const time = manualClock();
    const cache = new BoundedMemoryCache({ clock: time.clock, maxEntries: 4 });
    cache.put({ key: 'a', namespace: 'catalog', value: 1, ttlMs: 10, byteSize: 32 });
    cache.put({ key: 'b', namespace: 'catalog', value: 2, ttlMs: 10, byteSize: 32 });
    cache.put({ key: 'c', namespace: 'catalog', value: 3, ttlMs: 1000, byteSize: 32 });

    time.set(20);
    expect(cache.pruneExpired(1)).toBe(1);
    expect(cache.snapshot().entries).toBe(2);
    expect(cache.pruneExpired()).toBe(1);
    expect(cache.get('c').hit).toBe(true);
  });

  it('uses bounded value estimation when byteSize is omitted', () => {
    const cache = new BoundedMemoryCache();
    const entry = cache.put({
      key: 'object',
      namespace: 'catalog',
      value: { id: 1, name: 'park' },
      ttlMs: 1000,
    });
    expect(entry.byteSize).toBeGreaterThan(0);
    expect(cache.snapshot().bytes).toBe(entry.byteSize);
  });

  it('rejects zero TTL and unsafe byte sizes', () => {
    const cache = new BoundedMemoryCache();
    expect(() => cache.put({
      key: 'zero',
      namespace: 'catalog',
      value: 1,
      ttlMs: 0,
      byteSize: 8,
    })).toMatchObject({ code: 'invalid-duration' });
    expect(() => cache.put({
      key: 'bytes',
      namespace: 'catalog',
      value: 1,
      ttlMs: 100,
      byteSize: 0,
    })).toMatchObject({ code: 'invalid-byte-size' });
  });

  it('rejects a regressing clock', () => {
    const time = manualClock(10);
    const cache = new BoundedMemoryCache({ clock: time.clock });
    cache.put({ key: 'a', namespace: 'catalog', value: 1, ttlMs: 100, byteSize: 8 });
    time.set(9);
    expect(() => cache.get('a')).toMatchObject({ code: 'clock-regression' });
  });

  it('clears ownership and rejects future access after dispose', () => {
    const cache = new BoundedMemoryCache();
    cache.put({ key: 'a', namespace: 'catalog', value: 1, ttlMs: 100, byteSize: 8 });
    cache.dispose();
    cache.dispose();

    expect(cache.snapshot()).toMatchObject({
      disposed: true,
      entries: 0,
      bytes: 0,
      namespaces: 0,
    });
    expect(() => cache.get('a')).toMatchObject({ code: 'disposed' });
    expect(() => cache.put({
      key: 'b',
      namespace: 'catalog',
      value: 2,
      ttlMs: 100,
      byteSize: 8,
    })).toMatchObject({ code: 'disposed' });
  });
});
