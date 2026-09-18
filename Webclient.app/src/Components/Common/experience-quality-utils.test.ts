import { describe, expect, it } from 'vitest';
import {
  clamp,
  isTouchViewport,
  normalizeCommandQuery,
} from './experience-quality-utils';

describe('normalizeCommandQuery', () => {
  it.each([
    ['  KADIN   DANIŞMA ', 'kadin danisma'],
    ['İSTASYONLARI', 'istasyonlari'],
    ['Ölçüm Aracı', 'olcum araci'],
    ['Şehir Çözümleri', 'sehir cozumleri'],
    ['Wi-Fi', 'wi-fi'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeCommandQuery(input)).toBe(expected);
  });

  it('normalizes combining marks deterministically', () => {
    expect(normalizeCommandQuery('İSTANBUL')).toBe('istanbul');
  });

  it('collapses mixed whitespace', () => {
    expect(normalizeCommandQuery('a\n\t  b')).toBe('a b');
  });

  it('stringifies numeric query values without throwing', () => {
    expect(normalizeCommandQuery(123)).toBe('123');
  });
});

describe('isTouchViewport', () => {
  it('returns true for a coarse pointer', () => {
    expect(isTouchViewport({
      width: 1_920,
      matchesCoarsePointer: true,
    })).toBe(true);
  });

  it('returns true below the compact width threshold', () => {
    expect(isTouchViewport({
      width: 767,
      matchesCoarsePointer: false,
    })).toBe(true);
  });

  it('returns false at the compact width boundary', () => {
    expect(isTouchViewport({
      width: 768,
      matchesCoarsePointer: false,
    })).toBe(false);
  });

  it('returns false for wide fine-pointer layouts', () => {
    expect(isTouchViewport({
      width: 1_440,
      matchesCoarsePointer: false,
    })).toBe(false);
  });

  it('does not treat non-finite width as touch by itself', () => {
    expect(isTouchViewport({
      width: Number.NaN,
      matchesCoarsePointer: false,
    })).toBe(false);
  });
});

describe('clamp', () => {
  it.each([
    [5, 0, 10, 5],
    [-1, 0, 10, 0],
    [11, 0, 10, 10],
    ['7.5', 0, 10, 7.5],
    [Number.NaN, 2, 10, 2],
    [Number.POSITIVE_INFINITY, 2, 10, 2],
  ])('clamps %s between %s and %s', (value, minimum, maximum, expected) => {
    expect(clamp(value, minimum, maximum)).toBe(expected);
  });

  it('supports negative ranges', () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
  });

  it('supports equal bounds', () => {
    expect(clamp(100, 4, 4)).toBe(4);
  });

  it('rejects non-finite minimum bounds', () => {
    expect(() => clamp(1, Number.NaN, 10)).toThrow(/finite/i);
  });

  it('rejects non-finite maximum bounds', () => {
    expect(() => clamp(1, 0, Number.POSITIVE_INFINITY)).toThrow(/finite/i);
  });

  it('rejects inverted bounds', () => {
    expect(() => clamp(1, 10, 0)).toThrow(/lower than minimum/i);
  });
});
