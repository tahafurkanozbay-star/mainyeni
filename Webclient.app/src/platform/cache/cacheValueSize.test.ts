import { describe, expect, it } from 'vitest';
import { estimateCacheValueBytes } from './cacheValueSize';

describe('estimateCacheValueBytes', () => {
  it('measures primitive and structured values', () => {
    expect(estimateCacheValueBytes('abc')).toBeGreaterThan(0);
    expect(estimateCacheValueBytes({ id: 1, name: 'park' })).toBeGreaterThan(16);
    expect(estimateCacheValueBytes([1, 2, 3])).toBeGreaterThan(16);
  });

  it('accounts for map and set contents', () => {
    const mapBytes = estimateCacheValueBytes(new Map([
      ['a', 'value'],
      ['b', 'another'],
    ]));
    const emptyMapBytes = estimateCacheValueBytes(new Map());
    const setBytes = estimateCacheValueBytes(new Set(['a', 'b', 'c']));
    const emptySetBytes = estimateCacheValueBytes(new Set());

    expect(mapBytes).toBeGreaterThan(emptyMapBytes);
    expect(setBytes).toBeGreaterThan(emptySetBytes);
  });

  it('uses native byte lengths for binary views', () => {
    expect(estimateCacheValueBytes(new ArrayBuffer(64))).toBe(64);
    expect(estimateCacheValueBytes(new Uint8Array(32))).toBe(32);
  });

  it('rejects circular values', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => estimateCacheValueBytes(value)).toThrow('cache value contains a cycle');
  });

  it('rejects functions and symbols', () => {
    expect(() => estimateCacheValueBytes({ value: () => 1 }))
      .toThrow('cache value contains unsupported data');
    expect(() => estimateCacheValueBytes({ value: Symbol('x') }))
      .toThrow('cache value contains unsupported data');
  });

  it('enforces traversal depth and item limits', () => {
    expect(() => estimateCacheValueBytes({ nested: { value: 1 } }, { maxDepth: 1 }))
      .toThrow('cache value exceeded depth limit');
    expect(() => estimateCacheValueBytes([1, 2, 3], { maxVisited: 2 }))
      .toThrow('cache value exceeded item limit');
  });

  it('validates sizing options', () => {
    expect(() => estimateCacheValueBytes({}, { maxDepth: 0 })).toThrow(RangeError);
    expect(() => estimateCacheValueBytes({}, { maxDepth: 33 })).toThrow(RangeError);
    expect(() => estimateCacheValueBytes({}, { maxVisited: 0 })).toThrow(RangeError);
  });
});
