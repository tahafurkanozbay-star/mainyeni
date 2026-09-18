import { describe, expect, it } from 'vitest';
import { normalizeDebounceDelay } from './useDebounce';

describe('normalizeDebounceDelay', () => {
  it.each([
    [250, 250], [250.9, 250], [-1, 0], [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0], ['100', 100], [100_000, 60_000],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeDebounceDelay(input)).toBe(expected);
  });
});
