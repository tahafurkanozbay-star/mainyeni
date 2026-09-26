import { describe, expect, it } from 'vitest';
import {
  SpatialTileCacheRuntime,
  type SpatialTileCacheKey,
} from '../src/gis-engine/spatialTileCacheRuntime';

const key = (
  column: number,
  overrides: Partial<SpatialTileCacheKey> = {},
): SpatialTileCacheKey => ({
  layerId: 'transport-neutral-layer',
  level: 12,
  row: 42,
  column,
  ...overrides,
});

describe('SpatialTileCacheRuntime', () => {
  it('stores verified payloads and tracks hit/miss accounting', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 4,
      maxBytes: 4096,
      maxEntryBytes: 1024,
      defaultTtlMs: 1000,
      maxTtlMs: 5000,
    });

    expect(cache.put(key(1), 'tile-a', { byteSize: 256, now: 100 })).toBe(true);
    expect(cache.get(key(1), 101)).toBe('tile-a');
    expect(cache.get(key(2), 101)).toBeUndefined();

    expect(cache.snapshot(101)).toMatchObject({
      entries: 1,
      bytes: 256,
      hits: 1,
      misses: 1,
      rejected: 0,
      pressure: 'normal',
    });
  });

  it('expires entries deterministically without returning stale values', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 4,
      maxBytes: 4096,
      maxEntryBytes: 1024,
      defaultTtlMs: 10,
      maxTtlMs: 100,
    });

    cache.put(key(1), 'short-lived', { byteSize: 128, ttlMs: 10, now: 100 });
    expect(cache.peek(key(1), 109)).toBe('short-lived');
    expect(cache.peek(key(1), 110)).toBeUndefined();
    expect(cache.snapshot(110)).toMatchObject({ entries: 0, bytes: 0, expirations: 1 });
  });

  it('clamps requested TTL to the configured maximum', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 4,
      maxBytes: 4096,
      maxEntryBytes: 1024,
      defaultTtlMs: 10,
      maxTtlMs: 50,
    });

    cache.put(key(1), 'bounded', { byteSize: 64, ttlMs: 10_000, now: 100 });
    expect(cache.has(key(1), 149)).toBe(true);
    expect(cache.has(key(1), 150)).toBe(false);
  });

  it('evicts the least-recently-used unpinned entry under entry pressure', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 2,
      maxBytes: 4096,
      maxEntryBytes: 1024,
      defaultTtlMs: 1000,
      maxTtlMs: 5000,
    });

    cache.put(key(1), 'a', { byteSize: 100, now: 100 });
    cache.put(key(2), 'b', { byteSize: 100, now: 101 });
    expect(cache.get(key(1), 102)).toBe('a');
    cache.put(key(3), 'c', { byteSize: 100, now: 103 });

    expect(cache.peek(key(1), 104)).toBe('a');
    expect(cache.peek(key(2), 104)).toBeUndefined();
    expect(cache.peek(key(3), 104)).toBe('c');
    expect(cache.snapshot(104).evictions).toBe(1);
  });

  it('evicts by byte budget even when the entry budget has capacity', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 8,
      maxBytes: 1024,
      maxEntryBytes: 800,
      defaultTtlMs: 1000,
      maxTtlMs: 5000,
    });

    cache.put(key(1), 'a', { byteSize: 600, now: 100 });
    cache.put(key(2), 'b', { byteSize: 600, now: 101 });

    expect(cache.peek(key(1), 102)).toBeUndefined();
    expect(cache.peek(key(2), 102)).toBe('b');
    expect(cache.snapshot(102)).toMatchObject({ entries: 1, bytes: 600, evictions: 1 });
  });

  it('protects pinned entries from LRU eviction', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 2,
      maxBytes: 4096,
      maxEntryBytes: 1024,
      defaultTtlMs: 1000,
      maxTtlMs: 5000,
      maxPinnedEntries: 1,
    });

    cache.put(key(1), 'pinned', { byteSize: 100, pinned: true, now: 100 });
    cache.put(key(2), 'evictable', { byteSize: 100, now: 101 });
    cache.put(key(3), 'new', { byteSize: 100, now: 102 });

    expect(cache.peek(key(1), 103)).toBe('pinned');
    expect(cache.peek(key(2), 103)).toBeUndefined();
    expect(cache.peek(key(3), 103)).toBe('new');
  });

  it('rejects pin admission beyond the configured pin budget', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 4,
      maxBytes: 4096,
      maxEntryBytes: 1024,
      defaultTtlMs: 1000,
      maxTtlMs: 5000,
      maxPinnedEntries: 1,
    });

    expect(cache.put(key(1), 'first', { byteSize: 100, pinned: true, now: 100 })).toBe(true);
    expect(cache.put(key(2), 'second', { byteSize: 100, pinned: true, now: 101 })).toBe(false);
    expect(cache.snapshot(101)).toMatchObject({ pinnedEntries: 1, rejected: 1 });
  });

  it('preserves an existing entry atomically when replacement cannot fit', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 2,
      maxBytes: 1024,
      maxEntryBytes: 1024,
      defaultTtlMs: 1000,
      maxTtlMs: 5000,
      maxPinnedEntries: 2,
    });

    cache.put(key(1), 'stable', { byteSize: 200, now: 100 });
    cache.put(key(2), 'pinned-neighbor', { byteSize: 700, pinned: true, now: 101 });

    expect(cache.put(key(1), 'too-large', { byteSize: 500, now: 102 })).toBe(false);
    expect(cache.peek(key(1), 103)).toBe('stable');
    expect(cache.peek(key(2), 103)).toBe('pinned-neighbor');
    expect(cache.snapshot(103)).toMatchObject({ entries: 2, bytes: 900, rejected: 1 });
  });

  it('does not restore an already-expired replaced entry after failed admission', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 2,
      maxBytes: 1024,
      maxEntryBytes: 1024,
      defaultTtlMs: 10,
      maxTtlMs: 1000,
      maxPinnedEntries: 2,
    });

    cache.put(key(1), 'expired', { byteSize: 200, ttlMs: 10, now: 100 });
    cache.put(key(2), 'pinned', { byteSize: 800, ttlMs: 1000, pinned: true, now: 100 });

    expect(cache.put(key(1), 'replacement', { byteSize: 500, now: 111 })).toBe(false);
    expect(cache.peek(key(1), 111)).toBeUndefined();
    expect(cache.snapshot(111)).toMatchObject({ entries: 1, bytes: 800, rejected: 1 });
  });

  it('supports explicit pin transitions while respecting the pin budget', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 3,
      maxBytes: 4096,
      maxEntryBytes: 1024,
      defaultTtlMs: 1000,
      maxTtlMs: 5000,
      maxPinnedEntries: 1,
    });

    cache.put(key(1), 'a', { byteSize: 100, now: 100 });
    cache.put(key(2), 'b', { byteSize: 100, now: 100 });

    expect(cache.setPinned(key(1), true, 101)).toBe(true);
    expect(cache.setPinned(key(2), true, 101)).toBe(false);
    expect(cache.setPinned(key(1), false, 101)).toBe(true);
    expect(cache.setPinned(key(2), true, 101)).toBe(true);
    expect(cache.snapshot(101).pinnedEntries).toBe(1);
  });

  it('clears only evictable entries by default and can explicitly clear pins', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 4,
      maxBytes: 4096,
      maxEntryBytes: 1024,
      defaultTtlMs: 1000,
      maxTtlMs: 5000,
      maxPinnedEntries: 2,
    });

    cache.put(key(1), 'pinned', { byteSize: 100, pinned: true, now: 100 });
    cache.put(key(2), 'normal', { byteSize: 100, now: 100 });

    expect(cache.clear()).toBe(1);
    expect(cache.peek(key(1), 101)).toBe('pinned');
    expect(cache.peek(key(2), 101)).toBeUndefined();
    expect(cache.clear({ includePinned: true })).toBe(1);
    expect(cache.size).toBe(0);
  });

  it('returns deterministic entry order for equal access times', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 4,
      maxBytes: 4096,
      maxEntryBytes: 1024,
      defaultTtlMs: 1000,
      maxTtlMs: 5000,
    });

    cache.put(key(2), 'b', { byteSize: 100, now: 100 });
    cache.put(key(1), 'a', { byteSize: 100, now: 100 });

    expect(cache.entries(101).map((entry) => entry.value)).toEqual(['a', 'b']);
  });

  it('normalizes safe key whitespace without conflating tile coordinates', () => {
    const cache = new SpatialTileCacheRuntime<string>();
    cache.put(key(1, { layerId: '  layer-a  ', variant: '  retina  ' }), 'a', {
      byteSize: 10,
      now: 100,
    });

    expect(cache.peek(key(1, { layerId: 'layer-a', variant: 'retina' }), 101)).toBe('a');
    expect(cache.peek(key(2, { layerId: 'layer-a', variant: 'retina' }), 101)).toBeUndefined();
  });

  it('fails closed for malformed spatial cache keys', () => {
    const cache = new SpatialTileCacheRuntime<string>();

    expect(() => cache.has(key(1, { layerId: '   ' }), 100)).toThrow(RangeError);
    expect(() => cache.has(key(1, { level: -1 }), 100)).toThrow(RangeError);
    expect(() => cache.has(key(1, { row: Number.NaN }), 100)).toThrow(RangeError);
    expect(() => cache.has(key(1, { column: -1 }), 100)).toThrow(RangeError);
    expect(() => cache.has(key(1, { variant: '<script>' }), 100)).toThrow(TypeError);
  });

  it('rejects oversized payloads without mutating resident cache state', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 4,
      maxBytes: 4096,
      maxEntryBytes: 512,
      defaultTtlMs: 1000,
      maxTtlMs: 5000,
    });

    cache.put(key(1), 'resident', { byteSize: 100, now: 100 });
    expect(cache.put(key(2), 'oversized', { byteSize: 513, now: 101 })).toBe(false);
    expect(cache.peek(key(1), 102)).toBe('resident');
    expect(cache.peek(key(2), 102)).toBeUndefined();
    expect(cache.snapshot(102)).toMatchObject({ entries: 1, bytes: 100, rejected: 1 });
  });

  it('reports elevated and critical pressure from the tighter active budget', () => {
    const cache = new SpatialTileCacheRuntime<string>({
      maxEntries: 10,
      maxBytes: 1000,
      maxEntryBytes: 1000,
      defaultTtlMs: 1000,
      maxTtlMs: 5000,
    });

    cache.put(key(1), 'elevated', { byteSize: 700, now: 100 });
    expect(cache.snapshot(101).pressure).toBe('elevated');
    cache.put(key(2), 'critical', { byteSize: 200, now: 102 });
    expect(cache.snapshot(103).pressure).toBe('critical');
  });

  it('validates runtime limits and temporal inputs fail-closed', () => {
    expect(() => new SpatialTileCacheRuntime({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new SpatialTileCacheRuntime({ maxBytes: 100 })).toThrow(RangeError);
    expect(() => new SpatialTileCacheRuntime({ maxPinnedEntries: -1 })).toThrow(RangeError);

    const cache = new SpatialTileCacheRuntime<string>();
    expect(() => cache.put(key(1), 'a', { byteSize: -1, now: 100 })).toThrow(RangeError);
    expect(() => cache.put(key(1), 'a', { byteSize: 1, now: Number.NaN })).toThrow(RangeError);
    expect(() => cache.pruneExpired(-1)).toThrow(RangeError);
  });
});
