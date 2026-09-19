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
    expect(() => estimateCacheValueBytes(value)).toMatchObject({
      code: 'invalid-byte-size',
    });
  });

  it('rejects functions and symbols', () => {
    expect(() => estimateCacheValueBytes({ value: () => 1 })).toMatchObject({
      code: 'invalid-byte-size',
    });
    expect(() => estimateCacheValueBytes({ value: Symbol('x') })).toMatchObject({
      code: 'invalid-byte-size',
    });
  });

  it('enforces traversal depth and item limits', () => {
    expect(() => estimateCacheValueBytes({ nested: { value: 1 } }, { maxDepth: 1 }))
      .toMatchObject({ code: 'invalid-byte-size' });
    expect(() => estimateCacheValueBytes([1, 2, 3], { maxVisited: 2 }))
      .toMatchObject({ code: 'invalid-byte-size' });
  });

  it('validates sizing options', () => {
    expect(() => estimateCacheValueBytes({}, { maxDepth: 0 })).toThrow(RangeError);
    expect(() => estimateCacheValueBytes({}, { maxDepth: 33 })).toThrow(RangeError);
    expect(() => estimateCacheValueBytes({}, { maxVisited: 0 })).toThrow(RangeError);
  });
});
