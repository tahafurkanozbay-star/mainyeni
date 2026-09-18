import { describe, expect, it } from 'vitest';
import { normalizeDistanceResult } from './GisCommonHelper';

describe('normalizeDistanceResult', () => {
  it('formats numeric distance without mutating ArcGIS output', () => {
    const input = Object.freeze({ distance: 12.3456, unit: 'meters' });
    expect(normalizeDistanceResult(input)).toEqual({ distance: '12.35', unit: 'meters' });
    expect(input.distance).toBe(12.3456);
  });
  it('accepts numeric strings', () => {
    expect(normalizeDistanceResult({ distance: '8.5' }).distance).toBe('8.50');
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 'not-a-number'])('rejects invalid %s', (distance) => {
    expect(() => normalizeDistanceResult({ distance })).toThrow(/finite/i);
  });
});
