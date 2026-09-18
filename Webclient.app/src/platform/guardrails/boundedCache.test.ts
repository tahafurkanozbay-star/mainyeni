import { describe, expect, it } from 'vitest';
import { createBoundedCache, normalizeBoundedCachePolicy } from './boundedCache';

describe('boundedCache', () => {
  it('stores and retrieves entries', () => {
    const cache = createBoundedCache<string, number>();
    expect(cache.set('a', 1, {}, 0)).toBe(true);
    expect(cache.get('a', 1)).toBe(1);
    expect(cache.snapshot()).toMatchObject({ size: 1, hits: 1, misses: 0 });
  });

  it('counts cache misses', () => {
    const cache = createBoundedCache<string, number>();
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.snapshot().misses).toBe(1);
  });

  it('expires entries at TTL boundary', () => {
    const cache = createBoundedCache<string, number>({ ttlMs: 10 });
    cache.set('a', 1, {}, 0);
    expect(cache.peek('a', 9)).toBe(1);
    expect(cache.peek('a', 10)).toBeUndefined();
    expect(cache.snapshot().expirations).toBe(1);
  });

  it('evicts least recently touched entries by capacity', () => {
    const cache = createBoundedCache<string, number>({ capacity: 2 });
    cache.set('a', 1, {}, 0);
    cache.set('b', 2, {}, 1);
    expect(cache.get('a', 2)).toBe(1);
    cache.set('c', 3, {}, 3);
    expect(cache.peek('a', 4)).toBe(1);
    expect(cache.peek('b', 4)).toBeUndefined();
    expect(cache.peek('c', 4)).toBe(3);
    expect(cache.snapshot().evictions).toBe(1);
  });

  it('evicts by total estimated weight', () => {
    const cache = createBoundedCache<string, number>({
      capacity: 10,
      maxEstimatedWeight: 10,
      maxEntryWeight: 10,
    });
    cache.set('a', 1, { estimatedWeight: 6 }, 0);
    cache.set('b', 2, { estimatedWeight: 6 }, 1);
    expect(cache.peek('a', 2)).toBeUndefined();
    expect(cache.peek('b', 2)).toBe(2);
    expect(cache.snapshot().estimatedWeight).toBe(6);
  });

  it('rejects an entry larger than entry weight budget', () => {
    const cache = createBoundedCache<string, number>({
      maxEstimatedWeight: 100,
      maxEntryWeight: 5,
    });
    expect(cache.set('large', 1, { estimatedWeight: 6 })).toBe(false);
    expect(cache.snapshot().size).toBe(0);
  });

  it('replaces an entry without growing size', () => {
    const cache = createBoundedCache<string, number>();
    cache.set('a', 1, { estimatedWeight: 2 }, 0);
    cache.set('a', 2, { estimatedWeight: 3 }, 1);
    expect(cache.peek('a', 2)).toBe(2);
    expect(cache.snapshot()).toMatchObject({ size: 1, estimatedWeight: 3 });
  });

  it('tracks hits across replacements', () => {
    const cache = createBoundedCache<string, number>();
    cache.set('a', 1, {}, 0);
    cache.get('a', 1);
    cache.set('a', 2, {}, 2);
    expect(cache.snapshot().entries[0]?.hits).toBe(1);
  });

  it('supports per-entry TTL overrides', () => {
    const cache = createBoundedCache<string, number>({ ttlMs: 100 });
    cache.set('short', 1, { ttlMs: 5 }, 0);
    expect(cache.has('short', 4)).toBe(true);
    expect(cache.has('short', 5)).toBe(false);
  });

  it('sweeps all expired entries', () => {
    const cache = createBoundedCache<string, number>({ ttlMs: 5 });
    cache.set('a', 1, {}, 0);
    cache.set('b', 2, {}, 1);
    expect(cache.sweep(6)).toBe(2);
    expect(cache.snapshot().size).toBe(0);
  });

  it('deletes entries explicitly', () => {
    const cache = createBoundedCache<string, number>();
    cache.set('a', 1);
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
  });

  it('bounds and normalizes keys', () => {
    const cache = createBoundedCache<string, number>({ maxKeyLength: 3 });
    cache.set('  abcdef  ', 1);
    expect(cache.snapshot().entries[0]?.key).toBe('abc');
  });

  it('rejects empty normalized keys', () => {
    const cache = createBoundedCache<string, number>();
    expect(cache.set('   ', 1)).toBe(false);
  });

  it('normalizes invalid policy values', () => {
    const policy = normalizeBoundedCachePolicy({ capacity: 0, ttlMs: Number.NaN });
    expect(policy.capacity).toBeGreaterThan(0);
    expect(policy.ttlMs).toBeGreaterThan(0);
  });

  it('clears metrics and contents', () => {
    const cache = createBoundedCache<string, number>();
    cache.set('a', 1);
    cache.get('a');
    cache.clear();
    expect(cache.snapshot()).toMatchObject({ size: 0, hits: 0, misses: 0, evictions: 0 });
  });

  it('rejects operations after disposal', () => {
    const cache = createBoundedCache<string, number>();
    cache.dispose();
    expect(() => cache.snapshot()).toThrow('disposed');
  });
});
