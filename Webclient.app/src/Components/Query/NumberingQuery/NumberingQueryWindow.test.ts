import { describe, expect, it } from 'vitest';
import {
  createInitialNumberingQuery,
  normalizeNumberingOptions,
  readNumberingOption,
} from './NumberingQueryWindow';

describe('NumberingQueryWindow helpers', () => {
  it('creates independent empty query state', () => {
    const first = createInitialNumberingQuery();
    const second = createInitialNumberingQuery();
    expect(first).toEqual({
      district: '',
      districtName: '',
      nbhood: '',
      nbhoodName: '',
      street: '',
      streetName: '',
      door: '',
    });
    expect(first).not.toBe(second);
  });

  it('normalizes ArcGIS attribute-backed select options', () => {
    expect(readNumberingOption(
      { attr: { id: 7, ad: 'Çankaya' } },
      'id',
      'ad',
    )).toEqual({ value: '7', label: 'Çankaya' });
  });

  it('rejects options without an identity', () => {
    expect(readNumberingOption(
      { attr: { id: '', ad: 'Eksik' } },
      'id',
      'ad',
    )).toBeNull();
  });

  it('deduplicates service options while preserving source order', () => {
    expect(normalizeNumberingOptions([
      { attr: { id: 2, ad: 'Çankaya' } },
      { attr: { id: 2, ad: 'Duplicate' } },
      { attr: { id: 3, ad: 'Keçiören' } },
    ], 'id', 'ad')).toEqual([
      { value: '2', label: 'Çankaya' },
      { value: '3', label: 'Keçiören' },
    ]);
  });

  it('uses the identity as a readable fallback label', () => {
    expect(readNumberingOption(
      { attr: { id: 42 } },
      'id',
      'ad',
    )).toEqual({ value: '42', label: '42' });
  });
});
