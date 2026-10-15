import { describe, expect, it } from 'vitest';
import {
  NUMBERING_LEVELS_V11,
  NUMBERING_QUERY_VERSION_V11,
  cloneNumberingPathV11,
  descendantsOfNumberingLevelV11,
  emptyNumberingPathV11,
  errorMessageV11,
  errorNameV11,
  filterNumberingOptionsV11,
  findNumberingOptionV11,
  geometriesFromFeaturesV11,
  levelAndDescendantsV11,
  normalizeNumberingFilterV11,
  normalizeNumberingIdentityV11,
  normalizeNumberingLabelV11,
  normalizeNumberingOptionsV11,
  normalizeNumberingRuntimePolicyV11,
  numberingLevelLabelV11,
  numberingPathLabelV11,
  numberingSelectionFromOptionV11,
  readNumberingOptionV11,
  searchNumberingLabelV11,
  selectionEqualsV11,
  selectionPathCompleteV11,
  serviceMessageV11,
  type NumberingFeatureV11,
} from './NumberingQueryContractsV11';

const district = (id: unknown, ad: unknown): NumberingFeatureV11 => ({
  attr: { id, ad },
});

describe('NumberingQueryContractsV11 constants', () => {
  it('uses a versioned runtime contract', () => {
    expect(NUMBERING_QUERY_VERSION_V11).toBe('2026-10-12.v11');
  });

  it('keeps hierarchy order deterministic', () => {
    expect(NUMBERING_LEVELS_V11).toEqual([
      'district',
      'neighborhood',
      'street',
      'door',
    ]);
  });

  it('returns deterministic Turkish labels', () => {
    expect(NUMBERING_LEVELS_V11.map(numberingLevelLabelV11)).toEqual([
      'İlçe',
      'Mahalle',
      'Cadde / Sokak',
      'Bina No',
    ]);
  });
});

describe('NumberingQueryContractsV11 identity normalization', () => {
  it('accepts finite numeric identities', () => {
    expect(normalizeNumberingIdentityV11(42)).toBe('42');
  });

  it('accepts string identities', () => {
    expect(normalizeNumberingIdentityV11('  door-17  ')).toBe('door-17');
  });

  it('rejects non-finite numeric identities', () => {
    expect(normalizeNumberingIdentityV11(Number.NaN)).toBe('');
    expect(normalizeNumberingIdentityV11(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('bounds identity length', () => {
    expect(normalizeNumberingIdentityV11('x'.repeat(500))).toHaveLength(180);
  });

  it('bounds labels independently', () => {
    expect(normalizeNumberingLabelV11('y'.repeat(800))).toHaveLength(300);
  });

  it('normalizes Turkish search labels', () => {
    expect(searchNumberingLabelV11('Çankaya İLKBAHAR')).toBe('cankaya ilkbahar');
  });

  it('bounds filter length', () => {
    expect(normalizeNumberingFilterV11('a'.repeat(300), 40)).toHaveLength(40);
  });
});

describe('NumberingQueryContractsV11 option normalization', () => {
  it('reads a valid option', () => {
    expect(readNumberingOptionV11(
      district(6, 'Çankaya'),
      'id',
      'ad',
      3,
    )).toEqual({
      value: '6',
      label: 'Çankaya',
      searchLabel: 'cankaya',
      sourceIndex: 3,
    });
  });

  it('uses identity as fallback label', () => {
    expect(readNumberingOptionV11(
      { attr: { id: 9 } },
      'id',
      'ad',
      0,
    )).toMatchObject({
      value: '9',
      label: '9',
    });
  });

  it('rejects feature without identity', () => {
    expect(readNumberingOptionV11(
      { attr: { id: '', ad: 'Eksik' } },
      'id',
      'ad',
      0,
    )).toBeNull();
  });

  it('supports a null attribute payload', () => {
    expect(readNumberingOptionV11(
      { attr: null },
      'id',
      'ad',
      0,
    )).toBeNull();
  });

  it('deduplicates by canonical identity preserving first item', () => {
    const normalized = normalizeNumberingOptionsV11([
      district(1, 'Birinci'),
      district(1, 'İkinci'),
      district(2, 'Üçüncü'),
    ], {
      valueKey: 'id',
      labelKey: 'ad',
      maxOptions: 100,
    });
    expect(normalized.options.map(option => option.label)).toEqual([
      'Birinci',
      'Üçüncü',
    ]);
    expect(normalized.duplicateCount).toBe(1);
  });

  it('tracks invalid rows', () => {
    const normalized = normalizeNumberingOptionsV11([
      district('', 'Boş'),
      { attr: null },
      district(2, 'Geçerli'),
    ], {
      valueKey: 'id',
      labelKey: 'ad',
      maxOptions: 100,
    });
    expect(normalized.invalidCount).toBe(2);
    expect(normalized.outputCount).toBe(1);
  });

  it('hard bounds retained options', () => {
    const source = Array.from({ length: 40 }, (_, index) =>
      district(index + 1, `İlçe ${index + 1}`));
    const normalized = normalizeNumberingOptionsV11(source, {
      valueKey: 'id',
      labelKey: 'ad',
      maxOptions: 12,
    });
    expect(normalized.outputCount).toBe(12);
    expect(normalized.truncatedCount).toBe(28);
    expect(normalized.inputCount).toBe(40);
  });

  it('freezes option output', () => {
    const normalized = normalizeNumberingOptionsV11([
      district(1, 'Çankaya'),
    ], {
      valueKey: 'id',
      labelKey: 'ad',
      maxOptions: 100,
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.options)).toBe(true);
    expect(Object.isFrozen(normalized.options[0])).toBe(true);
  });
});

describe('NumberingQueryContractsV11 option filtering', () => {
  const options = normalizeNumberingOptionsV11([
    district(1, 'Çankaya'),
    district(2, 'Keçiören'),
    district(3, 'Yenimahalle'),
    district(4, 'Gölbaşı'),
    district(5, 'Şereflikoçhisar'),
  ], {
    valueKey: 'id',
    labelKey: 'ad',
    maxOptions: 100,
  }).options;

  it('matches Turkish text without diacritics', () => {
    expect(filterNumberingOptionsV11(options, 'cank', 20).options.map(option => option.label))
      .toEqual(['Çankaya']);
  });

  it('matches Ş with ascii input', () => {
    expect(filterNumberingOptionsV11(options, 'serefli', 20).options.map(option => option.label))
      .toEqual(['Şereflikoçhisar']);
  });

  it('returns all options for empty filter', () => {
    expect(filterNumberingOptionsV11(options, '', 20).totalMatches).toBe(5);
  });

  it('limits visible options without losing total match count', () => {
    const result = filterNumberingOptionsV11(options, '', 2);
    expect(result.options).toHaveLength(2);
    expect(result.totalMatches).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('reports no truncation when all matches fit', () => {
    const result = filterNumberingOptionsV11(options, 'golbasi', 2);
    expect(result.totalMatches).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('finds options by identity', () => {
    expect(findNumberingOptionV11(options, 3)?.label).toBe('Yenimahalle');
  });

  it('returns null for unknown option', () => {
    expect(findNumberingOptionV11(options, '404')).toBeNull();
  });

  it('converts an option into an immutable selection', () => {
    const selection = numberingSelectionFromOptionV11(options[0] ?? null);
    expect(selection).toEqual({ value: '1', label: 'Çankaya' });
    expect(Object.isFrozen(selection)).toBe(true);
  });
});

describe('NumberingQueryContractsV11 path helpers', () => {
  it('creates an empty immutable path', () => {
    const path = emptyNumberingPathV11();
    expect(path).toEqual({
      district: null,
      neighborhood: null,
      street: null,
      door: null,
    });
    expect(Object.isFrozen(path)).toBe(true);
  });

  it('clones and freezes selected path', () => {
    const path = cloneNumberingPathV11({
      district: { value: '1', label: 'Çankaya' },
      neighborhood: { value: '2', label: 'Kızılay' },
      street: null,
      door: null,
    });
    expect(path.district).toEqual({ value: '1', label: 'Çankaya' });
    expect(Object.isFrozen(path)).toBe(true);
    expect(Object.isFrozen(path.district)).toBe(true);
  });

  it('creates readable path label', () => {
    expect(numberingPathLabelV11({
      district: { value: '1', label: 'Çankaya' },
      neighborhood: { value: '2', label: 'Kızılay' },
      street: { value: '3', label: 'Atatürk Bulvarı' },
      door: { value: '4', label: '25' },
    })).toBe('Çankaya / Kızılay / Atatürk Bulvarı / 25');
  });

  it('requires all four levels for completion', () => {
    expect(selectionPathCompleteV11({
      district: { value: '1', label: 'Çankaya' },
      neighborhood: { value: '2', label: 'Kızılay' },
      street: { value: '3', label: 'Atatürk Bulvarı' },
      door: null,
    })).toBe(false);
    expect(selectionPathCompleteV11({
      district: { value: '1', label: 'Çankaya' },
      neighborhood: { value: '2', label: 'Kızılay' },
      street: { value: '3', label: 'Atatürk Bulvarı' },
      door: { value: '4', label: '25' },
    })).toBe(true);
  });

  it('returns descendants in hierarchy order', () => {
    expect(descendantsOfNumberingLevelV11('district')).toEqual([
      'neighborhood',
      'street',
      'door',
    ]);
    expect(descendantsOfNumberingLevelV11('street')).toEqual(['door']);
    expect(descendantsOfNumberingLevelV11('door')).toEqual([]);
  });

  it('returns level and descendants', () => {
    expect(levelAndDescendantsV11('neighborhood')).toEqual([
      'neighborhood',
      'street',
      'door',
    ]);
  });

  it('compares nullable selections', () => {
    expect(selectionEqualsV11(
      { value: '1', label: 'A' },
      { value: '1', label: 'A' },
    )).toBe(true);
    expect(selectionEqualsV11(
      { value: '1', label: 'A' },
      { value: '2', label: 'A' },
    )).toBe(false);
    expect(selectionEqualsV11(null, null)).toBe(true);
  });
});

describe('NumberingQueryContractsV11 policy normalization', () => {
  it('applies safe defaults', () => {
    const policy = normalizeNumberingRuntimePolicyV11();
    expect(policy.maxOptionsPerLevel).toBe(20_000);
    expect(policy.maxVisibleOptions).toBe(240);
    expect(policy.maxFilterLength).toBe(120);
    expect(policy.maxHistory).toBe(80);
    expect(policy.maxObservers).toBe(32);
  });

  it('bounds maximum options', () => {
    expect(normalizeNumberingRuntimePolicyV11({
      maxOptionsPerLevel: 1_000_000,
    }).maxOptionsPerLevel).toBe(100_000);
  });

  it('keeps visible option budget within retained budget', () => {
    const policy = normalizeNumberingRuntimePolicyV11({
      maxOptionsPerLevel: 150,
      maxVisibleOptions: 2_000,
    });
    expect(policy.maxVisibleOptions).toBeLessThanOrEqual(policy.maxOptionsPerLevel);
  });

  it('accepts zero history only through bounded normalizer floor behavior', () => {
    const policy = normalizeNumberingRuntimePolicyV11({ maxHistory: 0 });
    expect(policy.maxHistory).toBeGreaterThanOrEqual(0);
  });

  it('preserves supplied clock', () => {
    const clock = () => 123;
    expect(normalizeNumberingRuntimePolicyV11({ clock }).clock).toBe(clock);
  });
});

describe('NumberingQueryContractsV11 geometry and errors', () => {
  it('extracts geometries without retaining invalid entries', () => {
    const geometry = { x: 1, y: 2 };
    expect(geometriesFromFeaturesV11([
      { geometry },
      { geometry: null },
      {},
    ])).toEqual([geometry]);
  });

  it('bounds geometry extraction', () => {
    const input = Array.from({ length: 20 }, (_, index) => ({
      geometry: { index },
    }));
    expect(geometriesFromFeaturesV11(input, 5)).toHaveLength(5);
  });

  it('reads error names safely', () => {
    expect(errorNameV11(new TypeError('x'))).toBe('TypeError');
    expect(errorNameV11('x')).toBe('Error');
  });

  it('prefers Error message over fallback', () => {
    expect(errorMessageV11(new Error('Gerçek hata'), 'Fallback')).toBe('Gerçek hata');
  });

  it('uses fallback for empty error payload', () => {
    expect(errorMessageV11(null, 'Fallback')).toBe('Fallback');
  });

  it('prefers service message', () => {
    expect(serviceMessageV11({ message: 'Servis mesajı', errorMessage: 'İkinci' }, 'Fallback'))
      .toBe('Servis mesajı');
  });

  it('uses service error message second', () => {
    expect(serviceMessageV11({ errorMessage: 'Servis hatası' }, 'Fallback'))
      .toBe('Servis hatası');
  });

  it('uses service fallback last', () => {
    expect(serviceMessageV11({}, 'Fallback')).toBe('Fallback');
  });
});
