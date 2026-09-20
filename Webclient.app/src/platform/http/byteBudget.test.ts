import { describe, expect, test } from 'vitest';
import {
  assertWithinByteBudget,
  byteBudgetSnapshot,
  estimateScalarByteLength,
  normalizeByteBudget,
  utf8ByteLength,
} from './byteBudget';

describe('normalizeByteBudget', () => {
  const bounds = Object.freeze({
    fallback: 4096,
    minimum: 1024,
    maximum: 8192,
  });

  test('returns fallback for missing input', () => {
    expect(normalizeByteBudget(undefined, bounds)).toBe(4096);
    expect(normalizeByteBudget(null, bounds)).toBe(1024);
  });

  test('returns fallback for non-finite input', () => {
    expect(normalizeByteBudget(Number.NaN, bounds)).toBe(4096);
    expect(normalizeByteBudget(Number.POSITIVE_INFINITY, bounds)).toBe(4096);
  });

  test('clamps to lower and upper bounds', () => {
    expect(normalizeByteBudget(1, bounds)).toBe(1024);
    expect(normalizeByteBudget(999_999, bounds)).toBe(8192);
  });

  test('floors fractional budgets deterministically', () => {
    expect(normalizeByteBudget(2048.9, bounds)).toBe(2048);
  });

  test('accepts numeric strings without losing bounds', () => {
    expect(normalizeByteBudget('2048', bounds)).toBe(2048);
  });

  test.each([
    [{ fallback: 0, minimum: 1, maximum: 2 }, 'fallback'],
    [{ fallback: 2, minimum: 3, maximum: 4 }, 'fallback'],
    [{ fallback: 3, minimum: 3, maximum: 2 }, 'maximum'],
    [{ fallback: 3.5, minimum: 1, maximum: 4 }, 'fallback'],
    [{ fallback: 3, minimum: -1, maximum: 4 }, 'minimum'],
  ] as const)('rejects invalid bounds %#', (invalid, expected) => {
    expect(() => normalizeByteBudget(1, invalid)).toThrow(expected);
  });
});

describe('utf8ByteLength', () => {
  test.each([
    ['', 0],
    ['a', 1],
    ['abc', 3],
    ['é', 2],
    ['ü', 2],
    ['Çankaya', 8],
    ['東京', 6],
    ['🗺', 4],
    ['🗺️', 7],
  ])('counts %p as %d UTF-8 bytes', (value, expected) => {
    expect(utf8ByteLength(value)).toBe(expected);
  });

  test('matches TextEncoder across mixed Unicode text when available', () => {
    const value = 'Ankara • Çankaya 🗺️ / 東京';
    expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength);
  });

  test('counts surrogate-pair code points once', () => {
    expect(utf8ByteLength('😀😀')).toBe(8);
  });

  test('does not allocate output proportional to source through its API', () => {
    const input = 'a'.repeat(10_000);
    expect(utf8ByteLength(input)).toBe(10_000);
  });
});

describe('byteBudgetSnapshot', () => {
  test('reports remaining bytes below the budget', () => {
    expect(byteBudgetSnapshot(250, 1000)).toEqual({
      actualBytes: 250,
      limitBytes: 1000,
      exceeded: false,
      remainingBytes: 750,
      utilization: 0.25,
    });
  });

  test('marks exact-boundary use as allowed', () => {
    expect(byteBudgetSnapshot(1000, 1000)).toMatchObject({
      exceeded: false,
      remainingBytes: 0,
      utilization: 1,
    });
  });

  test('marks excess use while bounding utilization to one', () => {
    expect(byteBudgetSnapshot(1200, 1000)).toMatchObject({
      exceeded: true,
      remainingBytes: 0,
      utilization: 1,
    });
  });

  test('returns immutable snapshots', () => {
    expect(Object.isFrozen(byteBudgetSnapshot(1, 2))).toBe(true);
  });

  test.each([
    [-1, 10, 'actualBytes'],
    [1.5, 10, 'actualBytes'],
    [1, 0, 'limitBytes'],
    [1, 1.5, 'limitBytes'],
  ] as const)('rejects invalid byte counts %#', (actual, limit, expected) => {
    expect(() => byteBudgetSnapshot(actual, limit)).toThrow(expected);
  });
});

describe('assertWithinByteBudget', () => {
  test('returns the snapshot when within budget', () => {
    expect(assertWithinByteBudget(5, 10, () => new Error('too-large')))
      .toMatchObject({
        actualBytes: 5,
        limitBytes: 10,
        exceeded: false,
      });
  });

  test('throws caller-defined error when budget is exceeded', () => {
    const error = Object.assign(new Error('too-large'), { code: 'TOO_LARGE' });
    expect(() => assertWithinByteBudget(11, 10, () => error)).toThrow(error);
  });

  test('passes immutable byte metadata to the error factory', () => {
    let observed: unknown;
    expect(() => assertWithinByteBudget(11, 10, (snapshot) => {
      observed = snapshot;
      return new Error('too-large');
    })).toThrow('too-large');
    expect(observed).toEqual({
      actualBytes: 11,
      limitBytes: 10,
      exceeded: true,
      remainingBytes: 0,
      utilization: 1,
    });
    expect(Object.isFrozen(observed as object)).toBe(true);
  });

  test('rejects a missing error factory', () => {
    expect(() => assertWithinByteBudget(
      1,
      1,
      null as unknown as Parameters<typeof assertWithinByteBudget>[2],
    )).toThrow(TypeError);
  });
});

describe('estimateScalarByteLength', () => {
  test('estimates string values as UTF-8 bytes', () => {
    expect(estimateScalarByteLength('Ç')).toBe(2);
  });

  test('estimates finite and non-finite numbers deterministically', () => {
    expect(estimateScalarByteLength(123.5)).toBe(5);
    expect(estimateScalarByteLength(Number.NaN)).toBe(3);
    expect(estimateScalarByteLength(Number.POSITIVE_INFINITY)).toBe(8);
  });

  test('estimates booleans, bigint and nullish values', () => {
    expect(estimateScalarByteLength(true)).toBe(4);
    expect(estimateScalarByteLength(false)).toBe(5);
    expect(estimateScalarByteLength(BigInt(42))).toBe(2);
    expect(estimateScalarByteLength(null)).toBe(0);
    expect(estimateScalarByteLength(undefined)).toBe(0);
  });

  test('returns null for structured values', () => {
    expect(estimateScalarByteLength({ value: 1 })).toBeNull();
    expect(estimateScalarByteLength([1, 2, 3])).toBeNull();
  });
});
