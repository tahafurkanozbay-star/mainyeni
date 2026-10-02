import { describe, expect, test } from 'vitest';
import {
  normalizeSearchCollection,
  type NormalizedSearchRecord,
} from '../_Common/QuerySearchRuntime';
import {
  GENERAL_SEARCH_DEFAULT_PAGE_SIZE,
  GENERAL_SEARCH_MAX_QUERY_LENGTH,
  GENERAL_SEARCH_WORKSPACE_VERSION,
  createGeneralSearchFilters,
  generalSearchResultDomId,
  generalSearchSortLabel,
  generalSearchSuggestionDomId,
  moveGeneralSearchActiveIndex,
  normalizeGeneralSearchText,
  normalizeWorkspacePage,
  projectGeneralSearchWorkspace,
  toggleFacetValue,
  tokenizeGeneralSearch,
  type GeneralSearchSortMode,
} from './generalSearchWorkspaceModel';

const records = normalizeSearchCollection([
  {
    ObjectId: 1,
    Title: 'Gençlik Parkı',
    Address: 'Doğanbey Mahallesi, Altındağ',
    Category: 'Park ve Yeşil Alan',
    Type: 'Kent Parkı',
    Phone: '0312 000 00 01',
  },
  {
    ObjectId: 2,
    Title: 'Seğmenler Parkı',
    Address: 'Çankaya Caddesi, Çankaya',
    Category: 'Park ve Yeşil Alan',
    Type: 'Semt Parkı',
    Phone: '0312 000 00 02',
  },
  {
    ObjectId: 3,
    Title: 'Ankara Büyükşehir Belediyesi',
    Address: 'Emniyet Mahallesi, Yenimahalle',
    Category: 'Belediye Hizmeti',
    Type: 'Hizmet Binası',
    Phone: '0312 507 10 00',
  },
  {
    ObjectId: 4,
    Title: 'Zafer Çarşısı',
    Address: 'Kızılay, Çankaya',
    Category: 'Kültür ve Sanat',
    Type: 'Kültür Merkezi',
    Phone: '',
  },
  {
    ObjectId: 5,
    Title: 'Çubuk Aile Yaşam Merkezi',
    Address: 'Cumhuriyet Mahallesi, Çubuk',
    Category: 'Sosyal Hizmet',
    Type: 'Aile Yaşam Merkezi',
    Phone: '0312 000 00 05',
  },
  {
    ObjectId: 6,
    Title: 'Mavi Göl',
    Address: 'Bayındır, Mamak',
    Category: 'Park ve Yeşil Alan',
    Type: 'Rekreasyon Alanı',
    Phone: '',
  },
]);

const project = (
  overrides: Partial<Parameters<typeof projectGeneralSearchWorkspace>[0]> = {},
) => projectGeneralSearchWorkspace({ records, ...overrides });

const keys = (items: readonly { readonly record: NormalizedSearchRecord }[]): readonly string[] =>
  items.map((item) => item.record.key);

describe('generalSearchWorkspaceModel text normalization', () => {
  test('normalizes whitespace and Turkish casing consistently', () => {
    expect(normalizeGeneralSearchText('  GENÇLİK   PARKI ')).toBe('gençlik parkı');
    expect(normalizeGeneralSearchText('İSTANBUL')).toBe('istanbul');
  });

  test('uses NFKC normalization for compatibility characters', () => {
    expect(normalizeGeneralSearchText('ＡＮＫＡＲＡ')).toBe('ankara');
  });

  test('bounds query length', () => {
    const input = 'a'.repeat(GENERAL_SEARCH_MAX_QUERY_LENGTH + 50);
    expect(normalizeGeneralSearchText(input)).toHaveLength(GENERAL_SEARCH_MAX_QUERY_LENGTH);
  });

  test('tokenizes Turkish and numeric terms', () => {
    expect(tokenizeGeneralSearch('Çankaya 0312 park')).toEqual(['çankaya', '0312', 'park']);
  });

  test('deduplicates repeated query tokens', () => {
    expect(tokenizeGeneralSearch('park park PARK')).toEqual(['park']);
  });

  test('returns an immutable empty token list for blank query', () => {
    const tokens = tokenizeGeneralSearch('   ');
    expect(tokens).toEqual([]);
    expect(Object.isFrozen(tokens)).toBe(true);
  });
});

describe('generalSearchWorkspaceModel filters', () => {
  test('creates deterministic default filters', () => {
    expect(createGeneralSearchFilters()).toEqual({
      text: '',
      categories: [],
      types: [],
      sort: 'relevance',
    });
  });

  test('normalizes and deduplicates selected categories', () => {
    const filters = createGeneralSearchFilters({
      categories: ['Park ve Yeşil Alan', 'park ve yeşil alan', '  PARK VE YEŞİL ALAN '],
    });
    expect(filters.categories).toEqual(['park ve yeşil alan']);
  });

  test('normalizes and deduplicates selected types', () => {
    const filters = createGeneralSearchFilters({
      types: ['Kent Parkı', 'kent parkı', 'KENT PARKI'],
    });
    expect(filters.types).toEqual(['kent parkı']);
  });

  test('falls back to relevance for unsupported sort input', () => {
    const filters = createGeneralSearchFilters({ sort: 'x' as GeneralSearchSortMode });
    expect(filters.sort).toBe('relevance');
  });

  test('toggleFacetValue adds normalized value', () => {
    expect(toggleFacetValue([], 'Park ve Yeşil Alan')).toEqual(['park ve yeşil alan']);
  });

  test('toggleFacetValue removes an existing normalized value', () => {
    expect(toggleFacetValue(['park ve yeşil alan'], 'PARK VE YEŞİL ALAN')).toEqual([]);
  });

  test('toggleFacetValue ignores empty values', () => {
    expect(toggleFacetValue(['park'], '   ')).toEqual(['park']);
  });
});

describe('generalSearchWorkspaceModel ranking', () => {
  test('returns every admitted record when query is blank', () => {
    const snapshot = project();
    expect(snapshot.totalCount).toBe(records.length);
    expect(snapshot.matchedCount).toBe(records.length);
  });

  test('ranks exact title evidence before partial address evidence', () => {
    const snapshot = project({ filters: { text: 'Gençlik Parkı' } });
    expect(snapshot.page.items[0]?.record.title).toBe('Gençlik Parkı');
    expect(snapshot.page.items[0]?.matchedFields).toContain('title');
  });

  test('matches address-only query', () => {
    const snapshot = project({ filters: { text: 'Bayındır Mamak' } });
    expect(snapshot.matchedCount).toBe(1);
    expect(snapshot.page.items[0]?.record.title).toBe('Mavi Göl');
    expect(snapshot.page.items[0]?.matchedFields).toContain('address');
  });

  test('matches category-only query', () => {
    const snapshot = project({ filters: { text: 'Sosyal Hizmet' } });
    expect(snapshot.matchedCount).toBe(1);
    expect(snapshot.page.items[0]?.record.title).toBe('Çubuk Aile Yaşam Merkezi');
    expect(snapshot.page.items[0]?.matchedFields).toContain('category');
  });

  test('matches type-only query', () => {
    const snapshot = project({ filters: { text: 'Kültür Merkezi' } });
    expect(snapshot.matchedCount).toBe(1);
    expect(snapshot.page.items[0]?.record.title).toBe('Zafer Çarşısı');
    expect(snapshot.page.items[0]?.matchedFields).toContain('type');
  });

  test('matches phone query without leaking phone into diagnostics', () => {
    const snapshot = project({ filters: { text: '507 10' } });
    expect(snapshot.matchedCount).toBe(1);
    expect(snapshot.page.items[0]?.record.title).toBe('Ankara Büyükşehir Belediyesi');
    expect(snapshot.diagnostics.resultFingerprint).not.toContain('507');
  });

  test('returns zero matched records for unknown query', () => {
    const snapshot = project({ filters: { text: 'bulunmayan-kayıt-xyz' } });
    expect(snapshot.matchedCount).toBe(0);
    expect(snapshot.page.items).toEqual([]);
  });

  test('keeps source order as relevance tie breaker', () => {
    const duplicate = normalizeSearchCollection([
      { ObjectId: 10, Title: 'Park A', Category: 'Park' },
      { ObjectId: 11, Title: 'Park B', Category: 'Park' },
    ]);
    const snapshot = projectGeneralSearchWorkspace({
      records: duplicate,
      filters: { text: 'park', sort: 'relevance' },
    });
    expect(keys(snapshot.page.items)).toEqual(duplicate.map((item) => item.key));
  });
});

describe('generalSearchWorkspaceModel facet projection', () => {
  test('aggregates categories by count', () => {
    const snapshot = project();
    expect(snapshot.categoryFacets[0]).toMatchObject({
      value: 'Park ve Yeşil Alan',
      count: 3,
    });
  });

  test('aggregates distinct types', () => {
    const snapshot = project();
    expect(snapshot.typeFacets.map((facet) => facet.value)).toContain('Kent Parkı');
    expect(snapshot.typeFacets.map((facet) => facet.value)).toContain('Kültür Merkezi');
  });

  test('category filter narrows results', () => {
    const snapshot = project({
      filters: { categories: ['Park ve Yeşil Alan'] },
    });
    expect(snapshot.matchedCount).toBe(3);
    expect(snapshot.page.items.every((item) => item.record.category === 'Park ve Yeşil Alan')).toBe(true);
  });

  test('type filter narrows results', () => {
    const snapshot = project({
      filters: { types: ['Kent Parkı'] },
    });
    expect(snapshot.matchedCount).toBe(1);
    expect(snapshot.page.items[0]?.record.title).toBe('Gençlik Parkı');
  });

  test('category and type filters intersect', () => {
    const snapshot = project({
      filters: {
        categories: ['Park ve Yeşil Alan'],
        types: ['Semt Parkı'],
      },
    });
    expect(snapshot.matchedCount).toBe(1);
    expect(snapshot.page.items[0]?.record.title).toBe('Seğmenler Parkı');
  });

  test('selected facet remains marked', () => {
    const snapshot = project({
      filters: { categories: ['Park ve Yeşil Alan'] },
    });
    expect(snapshot.categoryFacets.find((facet) => facet.value === 'Park ve Yeşil Alan')?.selected).toBe(true);
  });

  test('type facets are calculated after category refinement', () => {
    const snapshot = project({
      filters: { categories: ['Park ve Yeşil Alan'] },
    });
    expect(snapshot.typeFacets.map((facet) => facet.value)).toEqual(expect.arrayContaining([
      'Kent Parkı',
      'Semt Parkı',
      'Rekreasyon Alanı',
    ]));
    expect(snapshot.typeFacets.map((facet) => facet.value)).not.toContain('Hizmet Binası');
  });

  test('category facets are calculated after type refinement', () => {
    const snapshot = project({
      filters: { types: ['Kültür Merkezi'] },
    });
    expect(snapshot.categoryFacets.map((facet) => facet.value)).toEqual(['Kültür ve Sanat']);
  });

  test('bounds facet cardinality', () => {
    const many = normalizeSearchCollection(Array.from({ length: 50 }, (_, index) => ({
      ObjectId: index,
      Title: `Kayıt ${index}`,
      Category: `Kategori ${index}`,
      Type: `Tür ${index}`,
    })));
    const snapshot = projectGeneralSearchWorkspace({
      records: many,
      options: { maximumFacets: 7 },
    });
    expect(snapshot.categoryFacets).toHaveLength(7);
    expect(snapshot.typeFacets).toHaveLength(7);
  });
});

describe('generalSearchWorkspaceModel sorting', () => {
  test('sorts titles with Turkish collator', () => {
    const snapshot = project({ filters: { sort: 'title' } });
    const titles = snapshot.page.items.map((item) => item.record.title);
    expect(titles[0]).toBe('Ankara Büyükşehir Belediyesi');
  });

  test('sorts categories then titles', () => {
    const snapshot = project({ filters: { sort: 'category' } });
    const categories = snapshot.page.items.map((item) => item.record.category);
    const sorted = [...categories].sort((left, right) => left.localeCompare(right, 'tr-TR', { sensitivity: 'base' }));
    expect(categories).toEqual(sorted);
  });

  test('places records with an address before empty addresses', () => {
    const input = normalizeSearchCollection([
      { ObjectId: 1, Title: 'Adres Yok', Category: 'A' },
      { ObjectId: 2, Title: 'Adres Var', Address: 'Ankara', Category: 'A' },
    ]);
    const snapshot = projectGeneralSearchWorkspace({ records: input, filters: { sort: 'address' } });
    expect(snapshot.page.items[0]?.record.title).toBe('Adres Var');
  });

  test('preserves source order explicitly', () => {
    const snapshot = project({ filters: { sort: 'source-order' } });
    expect(keys(snapshot.page.items)).toEqual(records.map((item) => item.key));
  });

  test.each([
    ['relevance', 'En ilgili'],
    ['title', 'Ada göre'],
    ['category', 'Kategoriye göre'],
    ['address', 'Adrese göre'],
    ['source-order', 'Servis sırasına göre'],
  ] as const)('returns localized label for %s', (mode, label) => {
    expect(generalSearchSortLabel(mode)).toBe(label);
  });
});

describe('generalSearchWorkspaceModel pagination', () => {
  const many = normalizeSearchCollection(Array.from({ length: 61 }, (_, index) => ({
    ObjectId: index + 1,
    Title: `Sonuç ${String(index + 1).padStart(2, '0')}`,
    Category: index % 2 === 0 ? 'Çift' : 'Tek',
  })));

  test('uses the default bounded page size', () => {
    const snapshot = projectGeneralSearchWorkspace({ records: many });
    expect(snapshot.page.pageSize).toBe(GENERAL_SEARCH_DEFAULT_PAGE_SIZE);
    expect(snapshot.page.items).toHaveLength(GENERAL_SEARCH_DEFAULT_PAGE_SIZE);
  });

  test('calculates page count', () => {
    const snapshot = projectGeneralSearchWorkspace({ records: many });
    expect(snapshot.page.pageCount).toBe(3);
  });

  test('returns requested second page', () => {
    const snapshot = projectGeneralSearchWorkspace({ records: many, page: 2 });
    expect(snapshot.page.page).toBe(2);
    expect(snapshot.page.startIndex).toBe(24);
    expect(snapshot.page.endIndex).toBe(48);
  });

  test('clamps page above available count', () => {
    const snapshot = projectGeneralSearchWorkspace({ records: many, page: 999 });
    expect(snapshot.page.page).toBe(3);
    expect(snapshot.page.items).toHaveLength(13);
  });

  test('clamps page below one', () => {
    expect(normalizeWorkspacePage(-10, 4)).toBe(1);
  });

  test('clamps page to maximum', () => {
    expect(normalizeWorkspacePage(10, 4)).toBe(4);
  });

  test('uses page one for invalid page input', () => {
    expect(normalizeWorkspacePage(Number.NaN, 4)).toBe(1);
  });

  test('bounds configured page size', () => {
    const snapshot = projectGeneralSearchWorkspace({
      records: many,
      options: { pageSize: 10_000 },
    });
    expect(snapshot.page.pageSize).toBe(60);
  });
});

describe('generalSearchWorkspaceModel admission budgets', () => {
  test('truncates inputs above maximumResults', () => {
    const many = normalizeSearchCollection(Array.from({ length: 20 }, (_, index) => ({
      ObjectId: index,
      Title: `Kayıt ${index}`,
    })));
    const snapshot = projectGeneralSearchWorkspace({
      records: many,
      options: { maximumResults: 7 },
    });
    expect(snapshot.totalCount).toBe(7);
    expect(snapshot.diagnostics.truncatedInputCount).toBe(13);
  });

  test('reports workspace version', () => {
    expect(project().diagnostics.version).toBe(GENERAL_SEARCH_WORKSPACE_VERSION);
  });

  test('does not put result titles into fingerprint', () => {
    const snapshot = project();
    expect(snapshot.diagnostics.resultFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(snapshot.diagnostics.resultFingerprint).not.toContain('Gençlik');
  });

  test('reports active-filter diagnostics', () => {
    expect(project().diagnostics.hasActiveFilters).toBe(false);
    expect(project({ filters: { text: 'park' } }).diagnostics.hasActiveFilters).toBe(true);
  });
});

describe('generalSearchWorkspaceModel suggestions', () => {
  test('does not produce suggestions without a local query', () => {
    expect(project().suggestions).toEqual([]);
  });

  test('suggests top matching records for local query', () => {
    const snapshot = project({ filters: { text: 'park' } });
    expect(snapshot.suggestions.some((item) => item.kind === 'record')).toBe(true);
    expect(snapshot.suggestions[0]?.label).toContain('Park');
  });

  test('includes category suggestions when budget allows', () => {
    const snapshot = project({
      filters: { text: 'park' },
      options: { maximumSuggestions: 12 },
    });
    expect(snapshot.suggestions.some((item) => item.kind === 'category')).toBe(true);
  });

  test('bounds suggestions', () => {
    const snapshot = project({
      filters: { text: 'a' },
      options: { maximumSuggestions: 2 },
    });
    expect(snapshot.suggestions.length).toBeLessThanOrEqual(2);
  });
});

describe('generalSearchWorkspaceModel active navigation', () => {
  test('starts first page with first item active', () => {
    const snapshot = project();
    expect(snapshot.activeIndex).toBe(0);
    expect(snapshot.activeKey).toBe(records[0]?.key);
  });

  test('returns -1 for empty page', () => {
    const snapshot = project({ filters: { text: 'no-match' } });
    expect(snapshot.activeIndex).toBe(-1);
    expect(snapshot.activeKey).toBeNull();
  });

  test('moves down by one', () => {
    expect(moveGeneralSearchActiveIndex(0, 5, 'ArrowDown')).toBe(1);
  });

  test('does not move beyond last item', () => {
    expect(moveGeneralSearchActiveIndex(4, 5, 'ArrowDown')).toBe(4);
  });

  test('moves up by one', () => {
    expect(moveGeneralSearchActiveIndex(3, 5, 'ArrowUp')).toBe(2);
  });

  test('does not move above first item', () => {
    expect(moveGeneralSearchActiveIndex(0, 5, 'ArrowUp')).toBe(0);
  });

  test('moves Home and End', () => {
    expect(moveGeneralSearchActiveIndex(3, 7, 'Home')).toBe(0);
    expect(moveGeneralSearchActiveIndex(3, 7, 'End')).toBe(6);
  });

  test('moves PageDown by bounded step', () => {
    expect(moveGeneralSearchActiveIndex(1, 20, 'PageDown', 8)).toBe(9);
  });

  test('moves PageUp by bounded step', () => {
    expect(moveGeneralSearchActiveIndex(12, 20, 'PageUp', 8)).toBe(4);
  });

  test('returns -1 for no items', () => {
    expect(moveGeneralSearchActiveIndex(0, 0, 'ArrowDown')).toBe(-1);
  });
});

describe('generalSearchWorkspaceModel DOM identity', () => {
  test('creates stable opaque result id', () => {
    expect(generalSearchResultDomId('id:42')).toBe(generalSearchResultDomId('id:42'));
    expect(generalSearchResultDomId('id:42')).toMatch(/^general-search-result-[0-9a-f]{8}$/);
  });

  test('does not expose raw result key in DOM id', () => {
    expect(generalSearchResultDomId('secret-looking-key')).not.toContain('secret-looking-key');
  });

  test('creates stable opaque suggestion id', () => {
    expect(generalSearchSuggestionDomId('record:id:42')).toMatch(/^general-search-suggestion-[0-9a-f]{8}$/);
  });
});
