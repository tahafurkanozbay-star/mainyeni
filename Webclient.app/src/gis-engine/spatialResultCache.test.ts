import { describe, expect, it } from 'vitest';
import { createSpatialCacheKey, normalizeSpatialCachePolicy, SpatialResultCache } from './spatialResultCache';

describe('createSpatialCacheKey', () => {
  it('normalizes fields, whitespace and stable extra values', () => {
    const a = createSpatialCacheKey({
      serviceId: ' service-a ', layerId: 2, operation: ' Query ',
      where: 'STATUS = 1', outFields: ['name', 'OBJECTID', 'NAME'],
      extra: { z: true, a: 4 },
    });
    const b = createSpatialCacheKey({
      serviceId: 'service-a', layerId: 2, operation: 'query',
      where: 'STATUS   =   1', outFields: ['OBJECTID', 'NAME'],
      extra: { a: 4, z: true },
    });
    expect(a).toBe(b);
  });

  it('rounds envelope coordinates deterministically', () => {
    const a = createSpatialCacheKey({ serviceId: 's', layerId: 0, operation: 'query', envelope: {
      xmin: 1.12345641, ymin: 2.12345641, xmax: 3.12345641, ymax: 4.12345641, spatialReferenceWkid: 4326,
    } });
    const b = createSpatialCacheKey({ serviceId: 's', layerId: 0, operation: 'query', envelope: {
      xmin: 1.12345644, ymin: 2.12345644, xmax: 3.12345644, ymax: 4.12345644, spatialReferenceWkid: 4326,
    } });
    expect(a).toBe(b);
  });

  it('separates materially different query contracts', () => {
    const base = { serviceId: 's', layerId: 1, operation: 'query' } as const;
    expect(createSpatialCacheKey({ ...base, returnGeometry: true })).not.toBe(createSpatialCacheKey({ ...base, returnGeometry: false }));
    expect(createSpatialCacheKey({ ...base, resultOffset: 0 })).not.toBe(createSpatialCacheKey({ ...base, resultOffset: 1 }));
    expect(createSpatialCacheKey({ ...base, where: 'A=1' })).not.toBe(createSpatialCacheKey({ ...base, where: 'A=2' }));
  });

  it('rejects malformed identity and envelopes', () => {
    expect(() => createSpatialCacheKey({ serviceId: '', layerId: 1, operation: 'query' })).toThrow();
    expect(() => createSpatialCacheKey({ serviceId: 's', layerId: -1, operation: 'query' })).toThrow();
    expect(() => createSpatialCacheKey({ serviceId: 's', layerId: 1, operation: '' })).toThrow();
    expect(() => createSpatialCacheKey({ serviceId: 's', layerId: 1, operation: 'query', envelope: {
      xmin: 10, ymin: 0, xmax: 1, ymax: 2,
    } })).toThrow(/inverted/);
  });
});

describe('normalizeSpatialCachePolicy', () => {
  it('returns a frozen bounded policy', () => {
    const policy = normalizeSpatialCachePolicy({ maxEntries: 4, maxEstimatedBytes: 1000 });
    expect(policy.maxEntries).toBe(4);
    expect(policy.maxEstimatedBytes).toBe(1000);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('rejects invalid budget combinations', () => {
    expect(() => normalizeSpatialCachePolicy({ maxEntries: 0 })).toThrow();
    expect(() => normalizeSpatialCachePolicy({ maxEstimatedBytes: -1 })).toThrow();
    expect(() => normalizeSpatialCachePolicy({ defaultTtlMs: 100, maxTtlMs: 99 })).toThrow();
    expect(() => normalizeSpatialCachePolicy({ coordinatePrecision: 11 })).toThrow();
  });
});

describe('SpatialResultCache', () => {
  it('stores and retrieves a fresh result with diagnostics', () => {
    const cache = new SpatialResultCache<{ id: number }>({ defaultTtlMs: 1000 });
    expect(cache.put('a', { id: 1 }, { now: 100, estimatedBytes: 20 })).toBe(true);
    expect(cache.get('a', { now: 150 })).toEqual({
      status: 'hit', value: { id: 1 }, ageMs: 50, expiresInMs: 950, estimatedBytes: 20,
    });
    expect(cache.snapshot()).toMatchObject({ entries: 1, estimatedBytes: 20, hits: 1, misses: 0 });
  });

  it('expires stale entries by default', () => {
    const cache = new SpatialResultCache<number>({ defaultTtlMs: 10 });
    cache.put('a', 1, { now: 0, estimatedBytes: 1 });
    expect(cache.get('a', { now: 10 })).toEqual({ status: 'miss' });
    expect(cache.snapshot()).toMatchObject({ entries: 0, expirations: 1, misses: 1 });
  });

  it('can surface stale data explicitly without pretending it is fresh', () => {
    const cache = new SpatialResultCache<number>({ defaultTtlMs: 10 });
    cache.put('a', 7, { now: 0, estimatedBytes: 1 });
    expect(cache.get('a', { now: 20, allowStale: true })).toMatchObject({ status: 'stale', value: 7, ageMs: 20, expiresInMs: -10 });
    expect(cache.snapshot()).toMatchObject({ staleHits: 1, entries: 1 });
  });

  it('evicts least recently used entries when count budget is exceeded', () => {
    const cache = new SpatialResultCache<number>({ maxEntries: 2, maxEstimatedBytes: 100 });
    cache.put('a', 1, { now: 0, estimatedBytes: 10 });
    cache.put('b', 2, { now: 1, estimatedBytes: 10 });
    cache.get('a', { now: 2 });
    cache.put('c', 3, { now: 3, estimatedBytes: 10 });
    expect(cache.get('b', { now: 4 }).status).toBe('miss');
    expect(cache.get('a', { now: 4 }).status).toBe('hit');
    expect(cache.get('c', { now: 4 }).status).toBe('hit');
    expect(cache.snapshot().evictions).toBe(1);
  });

  it('evicts to byte budget and rejects individually oversized values', () => {
    const cache = new SpatialResultCache<number>({ maxEntries: 10, maxEstimatedBytes: 20 });
    cache.put('a', 1, { now: 0, estimatedBytes: 12 });
    cache.put('b', 2, { now: 1, estimatedBytes: 12 });
    expect(cache.snapshot()).toMatchObject({ entries: 1, estimatedBytes: 12, evictions: 1 });
    expect(cache.put('huge', 3, { now: 2, estimatedBytes: 21 })).toBe(false);
    expect(cache.snapshot()).toMatchObject({ entries: 1, rejectedOversize: 1 });
  });

  it('replaces entries without leaking byte accounting', () => {
    const cache = new SpatialResultCache<number>({ maxEstimatedBytes: 100 });
    cache.put('a', 1, { now: 0, estimatedBytes: 30 });
    cache.put('a', 2, { now: 1, estimatedBytes: 7 });
    expect(cache.snapshot()).toMatchObject({ entries: 1, estimatedBytes: 7 });
    expect(cache.get('a', { now: 2 }).value).toBe(2);
  });

  it('invalidates by normalized tag', () => {
    const cache = new SpatialResultCache<number>();
    cache.put('a', 1, { tags: [' layer:4 ', 'service:x'], estimatedBytes: 1 });
    cache.put('b', 2, { tags: ['layer:5'], estimatedBytes: 1 });
    expect(cache.invalidateTag('layer:4')).toBe(1);
    expect(cache.snapshot().entries).toBe(1);
    expect(cache.get('b').status).toBe('hit');
  });

  it('supports predicate invalidation for service or generation boundaries', () => {
    const cache = new SpatialResultCache<number>();
    cache.put('service:a|0', 1, { tags: ['g:1'], estimatedBytes: 1 });
    cache.put('service:b|0', 2, { tags: ['g:1'], estimatedBytes: 1 });
    expect(cache.invalidateWhere((key) => key.startsWith('service:a'))).toBe(1);
    expect(cache.snapshot().entries).toBe(1);
  });

  it('sweeps all expired entries deterministically', () => {
    const cache = new SpatialResultCache<number>({ defaultTtlMs: 100 });
    cache.put('a', 1, { now: 0, ttlMs: 10, estimatedBytes: 2 });
    cache.put('b', 2, { now: 0, ttlMs: 20, estimatedBytes: 3 });
    cache.put('c', 3, { now: 0, ttlMs: 30, estimatedBytes: 4 });
    expect(cache.sweepExpired(20)).toBe(2);
    expect(cache.snapshot()).toMatchObject({ entries: 1, estimatedBytes: 4, expirations: 2 });
  });

  it('caps requested TTL to the policy maximum', () => {
    const cache = new SpatialResultCache<number>({ defaultTtlMs: 10, maxTtlMs: 50 });
    cache.put('a', 1, { now: 0, ttlMs: 500, estimatedBytes: 1 });
    expect(cache.get('a', { now: 49 }).status).toBe('hit');
    expect(cache.get('a', { now: 50 }).status).toBe('miss');
  });

  it('clears entries and preserves cumulative observability counters', () => {
    const cache = new SpatialResultCache<number>();
    cache.put('a', 1, { estimatedBytes: 5 });
    cache.get('a');
    const generation = cache.snapshot().generation;
    cache.clear();
    expect(cache.snapshot()).toMatchObject({ entries: 0, estimatedBytes: 0, hits: 1, generation: generation + 1 });
  });

  it('estimates JSON payload size when explicit size is omitted', () => {
    const cache = new SpatialResultCache<{ features: number[] }>({ maxEstimatedBytes: 1000 });
    expect(cache.put('a', { features: [1, 2, 3] })).toBe(true);
    expect(cache.snapshot().estimatedBytes).toBeGreaterThan(1);
  });

  it('rejects invalid time and size inputs fail closed', () => {
    const cache = new SpatialResultCache<number>();
    expect(() => cache.put('a', 1, { now: -1 })).toThrow();
    expect(() => cache.put('a', 1, { ttlMs: 0 })).toThrow();
    expect(() => cache.put('a', 1, { estimatedBytes: 0 })).toThrow();
    expect(() => cache.get('a', { now: Number.NaN })).toThrow();
  });
});
