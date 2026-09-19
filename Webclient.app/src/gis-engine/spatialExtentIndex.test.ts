import { describe, expect, it } from 'vitest';
import {
  normalizeSpatialBounds,
  spatialBoundsArea,
  spatialBoundsCenter,
  spatialBoundsContain,
  spatialBoundsIntersect,
  SpatialExtentIndex,
} from './spatialExtentIndex';

describe('spatial extent primitives', () => {
  it('normalizes negative zero and freezes bounds', () => {
    const bounds = normalizeSpatialBounds({ xmin: -0, ymin: -0, xmax: 1, ymax: 2 });
    expect(bounds).toEqual({ xmin: 0, ymin: 0, xmax: 1, ymax: 2 });
    expect(Object.isFrozen(bounds)).toBe(true);
  });

  it('rejects malformed and inverted bounds', () => {
    expect(() => normalizeSpatialBounds({ xmin: Number.NaN, ymin: 0, xmax: 1, ymax: 1 })).toThrow(RangeError);
    expect(() => normalizeSpatialBounds({ xmin: 2, ymin: 0, xmax: 1, ymax: 1 })).toThrow(RangeError);
    expect(() => normalizeSpatialBounds({ xmin: 0, ymin: 2, xmax: 1, ymax: 1 })).toThrow(RangeError);
  });

  it('uses inclusive intersection semantics', () => {
    const a = { xmin: 0, ymin: 0, xmax: 10, ymax: 10 };
    expect(spatialBoundsIntersect(a, { xmin: 10, ymin: 10, xmax: 20, ymax: 20 })).toBe(true);
    expect(spatialBoundsIntersect(a, { xmin: 11, ymin: 11, xmax: 20, ymax: 20 })).toBe(false);
  });

  it('detects full containment', () => {
    const outer = { xmin: 0, ymin: 0, xmax: 10, ymax: 10 };
    expect(spatialBoundsContain(outer, { xmin: 1, ymin: 1, xmax: 9, ymax: 9 })).toBe(true);
    expect(spatialBoundsContain(outer, { xmin: -1, ymin: 1, xmax: 9, ymax: 9 })).toBe(false);
  });

  it('computes center and area without mutating bounds', () => {
    const bounds = { xmin: -10, ymin: 2, xmax: 30, ymax: 12 };
    expect(spatialBoundsCenter(bounds)).toEqual({ x: 10, y: 7 });
    expect(spatialBoundsArea(bounds)).toBe(400);
  });
});

describe('SpatialExtentIndex', () => {
  it('stores and retrieves deterministic entries', () => {
    const index = new SpatialExtentIndex<string>();
    index.upsert({ id: 'a', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 'alpha' });
    expect(index.size).toBe(1);
    expect(index.has('a')).toBe(true);
    expect(index.get('a')).toMatchObject({ id: 'a', value: 'alpha' });
  });

  it('trims ids and rejects empty ids', () => {
    const index = new SpatialExtentIndex<string>();
    index.upsert({ id: ' a ', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 'alpha' });
    expect(index.has('a')).toBe(true);
    expect(() => index.upsert({ id: '  ', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 'x' })).toThrow(TypeError);
  });

  it('enforces id length budget', () => {
    const index = new SpatialExtentIndex<string>({ maxIdLength: 3 });
    expect(() => index.upsert({ id: 'abcd', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 'x' })).toThrow(RangeError);
  });

  it('evicts oldest entries when count budget is exceeded', () => {
    const index = new SpatialExtentIndex<number>({ maxEntries: 2 });
    index.upsert({ id: 'a', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 1 });
    index.upsert({ id: 'b', bounds: { xmin: 2, ymin: 2, xmax: 3, ymax: 3 }, value: 2 });
    const result = index.upsert({ id: 'c', bounds: { xmin: 4, ymin: 4, xmax: 5, ymax: 5 }, value: 3 });
    expect(result.evictedIds).toEqual(['a']);
    expect(index.snapshot().map((entry) => entry.id)).toEqual(['b', 'c']);
    expect(index.stats().evictions).toBe(1);
  });

  it('evicts oldest entries when byte budget is exceeded', () => {
    const index = new SpatialExtentIndex<number>({ maxEstimatedBytes: 20 });
    index.upsert({ id: 'a', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 1, estimatedBytes: 10 });
    const result = index.upsert({ id: 'b', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 2, estimatedBytes: 15 });
    expect(result.evictedIds).toEqual(['a']);
    expect(index.stats().estimatedBytes).toBe(15);
  });

  it('rejects an individual entry larger than the byte budget', () => {
    const index = new SpatialExtentIndex<number>({ maxEstimatedBytes: 10 });
    expect(() => index.upsert({
      id: 'a', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 1, estimatedBytes: 11,
    })).toThrow(RangeError);
  });

  it('replacement refreshes insertion order and accounting', () => {
    const index = new SpatialExtentIndex<number>({ maxEntries: 2, maxEstimatedBytes: 100 });
    index.upsert({ id: 'a', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 1, estimatedBytes: 10 });
    index.upsert({ id: 'b', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 2, estimatedBytes: 20 });
    index.upsert({ id: 'a', bounds: { xmin: 0, ymin: 0, xmax: 2, ymax: 2 }, value: 3, estimatedBytes: 30 });
    expect(index.snapshot().map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(index.stats().estimatedBytes).toBe(50);
  });

  it('queries intersections in stable insertion order', () => {
    const index = new SpatialExtentIndex<number>();
    index.upsert({ id: 'a', bounds: { xmin: 0, ymin: 0, xmax: 2, ymax: 2 }, value: 1 });
    index.upsert({ id: 'b', bounds: { xmin: 10, ymin: 10, xmax: 12, ymax: 12 }, value: 2 });
    index.upsert({ id: 'c', bounds: { xmin: 1, ymin: 1, xmax: 3, ymax: 3 }, value: 3 });
    const result = index.queryIntersects({ xmin: 1, ymin: 1, xmax: 4, ymax: 4 });
    expect(result.entries.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(result.truncated).toBe(false);
    expect(result.visited).toBe(3);
  });

  it('reports truncation when more intersection matches exist', () => {
    const index = new SpatialExtentIndex<number>();
    for (let i = 0; i < 4; i += 1) {
      index.upsert({ id: String(i), bounds: { xmin: i, ymin: i, xmax: i + 1, ymax: i + 1 }, value: i });
    }
    const result = index.queryIntersects({ xmin: -1, ymin: -1, xmax: 10, ymax: 10 }, 2);
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.visited).toBe(3);
  });

  it('queries entries fully contained by a window', () => {
    const index = new SpatialExtentIndex<number>();
    index.upsert({ id: 'inside', bounds: { xmin: 1, ymin: 1, xmax: 2, ymax: 2 }, value: 1 });
    index.upsert({ id: 'crossing', bounds: { xmin: -1, ymin: 1, xmax: 2, ymax: 2 }, value: 2 });
    const result = index.queryContained({ xmin: 0, ymin: 0, xmax: 10, ymax: 10 });
    expect(result.entries.map((entry) => entry.id)).toEqual(['inside']);
  });

  it('ranks nearest centers deterministically', () => {
    const index = new SpatialExtentIndex<number>();
    index.upsert({ id: 'first', bounds: { xmin: 0, ymin: 0, xmax: 0, ymax: 0 }, value: 1 });
    index.upsert({ id: 'second', bounds: { xmin: 0, ymin: 0, xmax: 0, ymax: 0 }, value: 2 });
    index.upsert({ id: 'far', bounds: { xmin: 100, ymin: 100, xmax: 100, ymax: 100 }, value: 3 });
    expect(index.nearestByCenter({ x: 1, y: 1 }, 2).map((entry) => entry.id)).toEqual(['first', 'second']);
  });

  it('rejects invalid nearest coordinates and query limits', () => {
    const index = new SpatialExtentIndex<number>();
    expect(() => index.nearestByCenter({ x: Number.NaN, y: 0 })).toThrow(RangeError);
    expect(() => index.queryIntersects({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, 0)).toThrow(RangeError);
  });

  it('caps caller query limit to configured maximum', () => {
    const index = new SpatialExtentIndex<number>({ maxQueryResults: 1 });
    index.upsert({ id: 'a', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 1 });
    index.upsert({ id: 'b', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 2 });
    const result = index.queryIntersects({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, 100);
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('removes entries and updates byte accounting', () => {
    const index = new SpatialExtentIndex<number>();
    index.upsert({ id: 'a', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 1, estimatedBytes: 20 });
    expect(index.remove('a')).toBe(true);
    expect(index.remove('a')).toBe(false);
    expect(index.stats().estimatedBytes).toBe(0);
  });

  it('clears all entries deterministically', () => {
    const index = new SpatialExtentIndex<number>();
    index.upsert({ id: 'a', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 1 });
    index.clear();
    expect(index.size).toBe(0);
    expect(index.snapshot()).toEqual([]);
  });

  it('tracks query and mutation counters', () => {
    const index = new SpatialExtentIndex<number>();
    index.upsert({ id: 'a', bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, value: 1 });
    index.queryIntersects({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
    index.queryContained({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
    index.nearestByCenter({ x: 0, y: 0 });
    expect(index.stats()).toMatchObject({ entries: 1, mutations: 1, queries: 3, evictions: 0 });
  });

  it('rejects unsafe constructor budgets', () => {
    expect(() => new SpatialExtentIndex({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new SpatialExtentIndex({ maxEstimatedBytes: -1 })).toThrow(RangeError);
    expect(() => new SpatialExtentIndex({ maxQueryResults: 0 })).toThrow(RangeError);
    expect(() => new SpatialExtentIndex({ maxIdLength: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});
