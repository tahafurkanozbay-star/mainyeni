import { describe, expect, it } from 'vitest';
import { SpatialTileCacheRuntime, type SpatialTileCacheKey } from './spatialTileCacheRuntime';

const key = (column: number, layerId = 'roads'): SpatialTileCacheKey => ({ layerId, level: 12, row: 42, column });

describe('SpatialTileCacheRuntime', () => {
  it('stores and retrieves a tile while accounting hits and bytes', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxBytes: 4096, maxEntryBytes: 1024 });
    expect(cache.put(key(1), 'a', { byteSize: 128, now: 100 })).toBe(true);
    expect(cache.get(key(1), 101)).toBe('a');
    expect(cache.snapshot(101)).toMatchObject({ entries: 1, bytes: 128, hits: 1, misses: 0 });
  });

  it('does not mutate LRU order when peeking', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 2, maxBytes: 4096, maxEntryBytes: 1024 });
    cache.put(key(1), 'a', { byteSize: 100, now: 1 });
    cache.put(key(2), 'b', { byteSize: 100, now: 2 });
    expect(cache.peek(key(1), 3)).toBe('a');
    cache.put(key(3), 'c', { byteSize: 100, now: 4 });
    expect(cache.peek(key(1), 4)).toBeUndefined();
    expect(cache.peek(key(2), 4)).toBe('b');
  });

  it('updates recency on get and evicts the least recently used entry', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 2, maxBytes: 4096, maxEntryBytes: 1024 });
    cache.put(key(1), 'a', { byteSize: 100, now: 1 });
    cache.put(key(2), 'b', { byteSize: 100, now: 2 });
    expect(cache.get(key(1), 3)).toBe('a');
    cache.put(key(3), 'c', { byteSize: 100, now: 4 });
    expect(cache.peek(key(1), 4)).toBe('a');
    expect(cache.peek(key(2), 4)).toBeUndefined();
    expect(cache.snapshot(4).evictions).toBe(1);
  });

  it('evicts enough entries to satisfy the byte budget', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 10, maxBytes: 1024, maxEntryBytes: 700 });
    cache.put(key(1), 'a', { byteSize: 400, now: 1 });
    cache.put(key(2), 'b', { byteSize: 400, now: 2 });
    expect(cache.put(key(3), 'c', { byteSize: 500, now: 3 })).toBe(true);
    expect(cache.byteSize).toBe(900);
    expect(cache.peek(key(1), 3)).toBeUndefined();
  });

  it('rejects a payload larger than the per-entry budget', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxBytes: 4096, maxEntryBytes: 256 });
    expect(cache.put(key(1), 'large', { byteSize: 257, now: 1 })).toBe(false);
    expect(cache.snapshot(1)).toMatchObject({ entries: 0, rejected: 1 });
  });

  it('expires entries deterministically at their deadline', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxBytes: 4096, maxEntryBytes: 1024, defaultTtlMs: 100, maxTtlMs: 1000 });
    cache.put(key(1), 'a', { byteSize: 100, ttlMs: 50, now: 100 });
    expect(cache.get(key(1), 149)).toBe('a');
    expect(cache.get(key(1), 150)).toBeUndefined();
    expect(cache.snapshot(150)).toMatchObject({ entries: 0, expirations: 1, misses: 1 });
  });

  it('clamps requested TTL to the configured maximum', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxBytes: 4096, maxEntryBytes: 1024, defaultTtlMs: 100, maxTtlMs: 500 });
    cache.put(key(1), 'a', { byteSize: 100, ttlMs: 10_000, now: 0 });
    expect(cache.has(key(1), 499)).toBe(true);
    expect(cache.has(key(1), 500)).toBe(false);
  });

  it('protects pinned entries from ordinary LRU eviction', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 2, maxBytes: 4096, maxEntryBytes: 1024, maxPinnedEntries: 1 });
    cache.put(key(1), 'pinned', { byteSize: 100, pinned: true, now: 1 });
    cache.put(key(2), 'ordinary', { byteSize: 100, now: 2 });
    cache.put(key(3), 'new', { byteSize: 100, now: 3 });
    expect(cache.peek(key(1), 3)).toBe('pinned');
    expect(cache.peek(key(2), 3)).toBeUndefined();
  });

  it('rejects pin admission beyond the pinned-entry budget', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 4, maxBytes: 4096, maxEntryBytes: 1024, maxPinnedEntries: 1 });
    expect(cache.put(key(1), 'a', { byteSize: 100, pinned: true, now: 1 })).toBe(true);
    expect(cache.put(key(2), 'b', { byteSize: 100, pinned: true, now: 2 })).toBe(false);
    expect(cache.snapshot(2)).toMatchObject({ entries: 1, pinnedEntries: 1, rejected: 1 });
  });

  it('can promote and demote existing entries without changing payload accounting', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 4, maxBytes: 4096, maxEntryBytes: 1024, maxPinnedEntries: 1 });
    cache.put(key(1), 'a', { byteSize: 100, now: 1 });
    expect(cache.setPinned(key(1), true, 2)).toBe(true);
    expect(cache.snapshot(2).pinnedEntries).toBe(1);
    expect(cache.setPinned(key(1), false, 3)).toBe(true);
    expect(cache.snapshot(3)).toMatchObject({ bytes: 100, pinnedEntries: 0 });
  });

  it('cannot promote another entry when all pin slots are occupied', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 4, maxBytes: 4096, maxEntryBytes: 1024, maxPinnedEntries: 1 });
    cache.put(key(1), 'a', { byteSize: 100, pinned: true, now: 1 });
    cache.put(key(2), 'b', { byteSize: 100, now: 1 });
    expect(cache.setPinned(key(2), true, 2)).toBe(false);
    expect(cache.snapshot(2).pinnedEntries).toBe(1);
  });

  it('clear preserves pinned entries unless explicitly requested', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 4, maxBytes: 4096, maxEntryBytes: 1024, maxPinnedEntries: 1 });
    cache.put(key(1), 'a', { byteSize: 100, pinned: true, now: 1 });
    cache.put(key(2), 'b', { byteSize: 100, now: 1 });
    expect(cache.clear()).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.clear({ includePinned: true })).toBe(1);
    expect(cache.size).toBe(0);
  });

  it('replacement updates byte and pinned accounting atomically', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 4, maxBytes: 4096, maxEntryBytes: 2048, maxPinnedEntries: 2 });
    cache.put(key(1), 'old', { byteSize: 100, pinned: true, now: 1 });
    cache.put(key(1), 'new', { byteSize: 700, pinned: false, now: 2 });
    expect(cache.get(key(1), 3)).toBe('new');
    expect(cache.snapshot(3)).toMatchObject({ entries: 1, bytes: 700, pinnedEntries: 0 });
  });

  it('rejects replacement that would violate pin budget without losing old value', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 4, maxBytes: 4096, maxEntryBytes: 1024, maxPinnedEntries: 1 });
    cache.put(key(1), 'pinned', { byteSize: 100, pinned: true, now: 1 });
    cache.put(key(2), 'old', { byteSize: 100, now: 1 });
    expect(cache.put(key(2), 'new', { byteSize: 100, pinned: true, now: 2 })).toBe(false);
    expect(cache.peek(key(2), 2)).toBe('old');
  });

  it('rejects a protected insertion if pinned residents leave no evictable capacity', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 2, maxBytes: 1024, maxEntryBytes: 800, maxPinnedEntries: 2 });
    cache.put(key(1), 'a', { byteSize: 500, pinned: true, now: 1 });
    cache.put(key(2), 'b', { byteSize: 500, pinned: true, now: 1 });
    expect(cache.put(key(3), 'c', { byteSize: 500, now: 2 })).toBe(false);
    expect(cache.snapshot(2)).toMatchObject({ entries: 2, bytes: 1000, rejected: 1 });
  });

  it('prunes all expired entries and preserves live entries', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 5, maxBytes: 4096, maxEntryBytes: 1024, defaultTtlMs: 100, maxTtlMs: 1000 });
    cache.put(key(1), 'a', { byteSize: 100, ttlMs: 10, now: 0 });
    cache.put(key(2), 'b', { byteSize: 100, ttlMs: 20, now: 0 });
    cache.put(key(3), 'c', { byteSize: 100, ttlMs: 30, now: 0 });
    expect(cache.pruneExpired(20)).toBe(2);
    expect(cache.peek(key(3), 20)).toBe('c');
    expect(cache.snapshot(20).expirations).toBe(2);
  });

  it('reports elevated and critical pressure from entry occupancy', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 10, maxBytes: 100_000, maxEntryBytes: 1000 });
    for (let i = 0; i < 7; i += 1) cache.put(key(i), String(i), { byteSize: 10, now: i });
    expect(cache.snapshot(10).pressure).toBe('elevated');
    cache.put(key(7), '7', { byteSize: 10, now: 8 });
    cache.put(key(8), '8', { byteSize: 10, now: 9 });
    expect(cache.snapshot(10).pressure).toBe('critical');
  });

  it('reports pressure from bytes even when entry count is low', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 100, maxBytes: 1000, maxEntryBytes: 1000 });
    cache.put(key(1), 'a', { byteSize: 750, now: 1 });
    expect(cache.snapshot(1).pressure).toBe('elevated');
  });

  it('returns deterministic entry order by LRU facts', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxEntries: 5, maxBytes: 4096, maxEntryBytes: 1024 });
    cache.put(key(2), 'b', { byteSize: 10, now: 1 });
    cache.put(key(1), 'a', { byteSize: 10, now: 1 });
    cache.get(key(2), 3);
    expect(cache.entries(3).map((entry) => entry.key.column)).toEqual([1, 2]);
  });

  it('isolates otherwise equal coordinates by layer and variant', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxBytes: 4096, maxEntryBytes: 1024 });
    cache.put({ ...key(1), layerId: 'roads', variant: 'day' }, 'day', { byteSize: 10, now: 1 });
    cache.put({ ...key(1), layerId: 'roads', variant: 'night' }, 'night', { byteSize: 10, now: 1 });
    cache.put({ ...key(1), layerId: 'buildings', variant: 'day' }, 'buildings', { byteSize: 10, now: 1 });
    expect(cache.get({ ...key(1), layerId: 'roads', variant: 'day' }, 2)).toBe('day');
    expect(cache.get({ ...key(1), layerId: 'roads', variant: 'night' }, 2)).toBe('night');
    expect(cache.get({ ...key(1), layerId: 'buildings', variant: 'day' }, 2)).toBe('buildings');
  });

  it.each([
    [{ layerId: '', level: 1, row: 1, column: 1 }, 'layerId'],
    [{ layerId: 'x', level: -1, row: 1, column: 1 }, 'level'],
    [{ layerId: 'x', level: 1.5, row: 1, column: 1 }, 'level'],
    [{ layerId: 'x', level: 1, row: -1, column: 1 }, 'row'],
    [{ layerId: 'x', level: 1, row: 1, column: -1 }, 'column'],
  ] as const)('fails closed for invalid tile key %#', (badKey, message) => {
    const cache = new SpatialTileCacheRuntime<string>({ maxBytes: 4096, maxEntryBytes: 1024 });
    expect(() => cache.put(badKey, 'x', { byteSize: 1 })).toThrow(message);
  });

  it('validates constructor budgets', () => {
    expect(() => new SpatialTileCacheRuntime({ maxEntries: 0 })).toThrow('maxEntries');
    expect(() => new SpatialTileCacheRuntime({ maxBytes: 100 })).toThrow('maxBytes');
    expect(() => new SpatialTileCacheRuntime({ maxBytes: 4096, maxEntryBytes: 5000 })).toThrow('maxEntryBytes');
    expect(() => new SpatialTileCacheRuntime({ defaultTtlMs: 0 })).toThrow('defaultTtlMs');
    expect(() => new SpatialTileCacheRuntime({ maxEntries: 2, maxPinnedEntries: 3 })).toThrow('maxPinnedEntries');
  });

  it('counts misses only for get, not has or peek', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxBytes: 4096, maxEntryBytes: 1024 });
    expect(cache.has(key(1), 1)).toBe(false);
    expect(cache.peek(key(1), 1)).toBeUndefined();
    expect(cache.get(key(1), 1)).toBeUndefined();
    expect(cache.snapshot(1).misses).toBe(1);
  });

  it('delete updates accounting and reports whether a key existed', () => {
    const cache = new SpatialTileCacheRuntime<string>({ maxBytes: 4096, maxEntryBytes: 1024 });
    cache.put(key(1), 'a', { byteSize: 128, now: 1 });
    expect(cache.delete(key(1))).toBe(true);
    expect(cache.delete(key(1))).toBe(false);
    expect(cache.snapshot(2)).toMatchObject({ entries: 0, bytes: 0 });
  });
});
