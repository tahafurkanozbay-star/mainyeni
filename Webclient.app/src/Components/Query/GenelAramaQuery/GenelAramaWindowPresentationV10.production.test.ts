import { describe, expect, it } from 'vitest';
import { normalizeSearchCollection } from '../_Common/QuerySearchRuntime';
import {
  createGeneralSearchAnnouncementV10,
  createGeneralSearchFacetModelV10,
  createGeneralSearchFacetsV10,
  createGeneralSearchGuidanceV10,
  createGeneralSearchPresentedRecordsV10,
  createGeneralSearchRenderWindowV10,
  filterGeneralSearchRecordsV10,
  highlightGeneralSearchTextV10,
  keyboardDecisionForGeneralSearchV10,
  moveGeneralSearchIndexV10,
  normalizeGeneralSearchFacetValueV10,
  normalizeGeneralSearchRefinementV10,
  normalizeGeneralSearchSortModeV10,
  normalizeGeneralSearchWindowPolicyV10,
  prepareGeneralSearchRecordsV10,
  scoreGeneralSearchRecordV10,
  sortGeneralSearchRecordsV10,
} from './GenelAramaWindowPresentationV10';

const rawRecords = [
  {
    ObjectId: 1,
    Title: 'Anıtkabir',
    Address: 'Mebusevleri Mahallesi, Akdeniz Caddesi, Çankaya',
    Phone: '0312 231 18 61',
    Category: 'Müze',
    Type: 'Kültür',
  },
  {
    ObjectId: 2,
    Title: 'Ankara Kalesi',
    Address: 'Kale Mahallesi, Altındağ',
    Phone: '0312 324 31 60',
    Category: 'Tarihi Yer',
    Type: 'Kültür',
  },
  {
    ObjectId: 3,
    Title: 'Kuğulu Park',
    Address: 'Tunalı Hilmi Caddesi, Çankaya',
    Category: 'Park',
    Type: 'Yeşil Alan',
  },
  {
    ObjectId: 4,
    Title: 'Seğmenler Parkı',
    Address: 'Çankaya Caddesi, Çankaya',
    Category: 'Park',
    Type: 'Yeşil Alan',
  },
  {
    ObjectId: 5,
    Title: 'CerModern',
    Address: 'Altınsoy Caddesi, Sıhhiye',
    Category: 'Sanat Merkezi',
    Type: 'Kültür',
  },
  {
    ObjectId: 6,
    Title: 'Gençlik Parkı',
    Address: 'Doğanbey Mahallesi, Altındağ',
    Category: 'Park',
    Type: 'Yeşil Alan',
  },
] as const;

const records = normalizeSearchCollection(rawRecords);
const policy = normalizeGeneralSearchWindowPolicyV10({
  maxRecords: 100,
  maxFacetBuckets: 4,
  maxSelectedFacets: 4,
  renderWindowSize: 8,
  renderOverscan: 2,
  keyboardPageSize: 3,
});
const prepared = prepareGeneralSearchRecordsV10(records, policy);

const selected = (...values: string[]): ReadonlySet<string> => new Set(values);

describe('GenelAramaWindowPresentationV10 policy normalization', () => {
  it('normalizes bounded defaults', () => {
    const normalized = normalizeGeneralSearchWindowPolicyV10();
    expect(normalized.maxRecords).toBeGreaterThan(0);
    expect(normalized.renderWindowSize).toBeGreaterThanOrEqual(8);
    expect(normalized.renderOverscan).toBeLessThanOrEqual(normalized.renderWindowSize);
    expect(normalized.keyboardPageSize).toBeLessThanOrEqual(normalized.renderWindowSize);
  });

  it('clamps extreme record limits', () => {
    expect(normalizeGeneralSearchWindowPolicyV10({ maxRecords: 0 }).maxRecords).toBe(1);
    expect(normalizeGeneralSearchWindowPolicyV10({ maxRecords: Number.MAX_SAFE_INTEGER }).maxRecords)
      .toBe(250_000);
  });

  it('clamps render window and overscan together', () => {
    const normalized = normalizeGeneralSearchWindowPolicyV10({
      renderWindowSize: 12,
      renderOverscan: 999,
      keyboardPageSize: 999,
    });
    expect(normalized.renderWindowSize).toBe(12);
    expect(normalized.renderOverscan).toBe(12);
    expect(normalized.keyboardPageSize).toBe(12);
  });

  it('limits refinement length deterministically', () => {
    const limited = normalizeGeneralSearchWindowPolicyV10({ maxRefinementLength: 16 });
    expect(normalizeGeneralSearchRefinementV10('a'.repeat(100), limited)).toHaveLength(16);
  });

  it('uses relevance for unsupported sort modes', () => {
    expect(normalizeGeneralSearchSortModeV10('unknown')).toBe('relevance');
    expect(normalizeGeneralSearchSortModeV10(null)).toBe('relevance');
  });

  it.each([
    'relevance',
    'source-order',
    'title',
    'category',
    'address',
  ])('keeps supported sort mode %s', (mode) => {
    expect(normalizeGeneralSearchSortModeV10(mode)).toBe(mode);
  });

  it('canonicalizes facet values with search normalization', () => {
    expect(normalizeGeneralSearchFacetValueV10('  MÜZE  ')).toBe('muze');
    expect(normalizeGeneralSearchFacetValueV10('Çankaya')).toBe('cankaya');
  });
});

describe('GenelAramaWindowPresentationV10 record preparation', () => {
  it('prepares normalized records without losing source order', () => {
    expect(prepared.records).toHaveLength(records.length);
    expect(prepared.records.map(item => item.sourceIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps display values and canonical values separately', () => {
    const first = prepared.records[0];
    expect(first?.title).toBe('Anıtkabir');
    expect(first?.normalizedTitle).toBe('anitkabir');
    expect(first?.category).toBe('Müze');
    expect(first?.normalizedCategory).toBe('muze');
  });

  it('builds searchable text from title address phone category and type', () => {
    const first = prepared.records[0];
    expect(first?.normalizedSearchableText).toContain('anitkabir');
    expect(first?.normalizedSearchableText).toContain('cankaya');
    expect(first?.normalizedSearchableText).toContain('muze');
    expect(first?.normalizedSearchableText).toContain('0312');
  });

  it('makes duplicate record keys unique for UI identity', () => {
    const duplicate = normalizeSearchCollection([
      { ObjectId: 1, Title: 'Bir' },
      { ObjectId: 1, Title: 'İki' },
      { ObjectId: 1, Title: 'Üç' },
    ]);
    const value = prepareGeneralSearchRecordsV10(duplicate, policy);
    expect(value.records.map(item => item.identity)).toEqual(['id:1', 'id:1#2', 'id:1#3']);
    expect(value.duplicateIdentities).toBe(2);
  });

  it('bounds retained records and reports truncation', () => {
    const many = normalizeSearchCollection(Array.from({ length: 20 }, (_, index) => ({
      ObjectId: index + 1,
      Title: `Kayıt ${index + 1}`,
    })));
    const tinyPolicy = normalizeGeneralSearchWindowPolicyV10({ maxRecords: 5 });
    const value = prepareGeneralSearchRecordsV10(many, tinyPolicy);
    expect(value.sourceCount).toBe(20);
    expect(value.records).toHaveLength(5);
    expect(value.resultLimitReached).toBe(true);
  });

  it('creates stable preparation fingerprints', () => {
    const first = prepareGeneralSearchRecordsV10(records, policy);
    const second = prepareGeneralSearchRecordsV10(records, policy);
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('changes fingerprint when relevant result facts change', () => {
    const changed = normalizeSearchCollection([
      ...rawRecords.slice(0, 5),
      { ...rawRecords[5], Title: 'Gençlik Parkı Yenilendi' },
    ]);
    expect(prepareGeneralSearchRecordsV10(changed, policy).fingerprint).not.toBe(prepared.fingerprint);
  });
});

describe('GenelAramaWindowPresentationV10 Turkish refinement', () => {
  it('matches Turkish dotted and dotless I canonically', () => {
    const value = filterGeneralSearchRecordsV10(prepared.records, 'ANITKABİR', selected(), selected());
    expect(value.map(item => item.title)).toEqual(['Anıtkabir']);
  });

  it('matches diacritic-free refinement against Turkish records', () => {
    const value = filterGeneralSearchRecordsV10(prepared.records, 'kugulu', selected(), selected());
    expect(value.map(item => item.title)).toEqual(['Kuğulu Park']);
  });

  it('matches address text', () => {
    const value = filterGeneralSearchRecordsV10(prepared.records, 'altindag', selected(), selected());
    expect(value.map(item => item.title)).toEqual(['Ankara Kalesi', 'Gençlik Parkı']);
  });

  it('matches category text', () => {
    const value = filterGeneralSearchRecordsV10(prepared.records, 'yesil alan', selected(), selected());
    expect(value.map(item => item.category)).toEqual(['Park', 'Park', 'Park']);
  });

  it('matches phone text', () => {
    const value = filterGeneralSearchRecordsV10(prepared.records, '231 18', selected(), selected());
    expect(value.map(item => item.title)).toEqual(['Anıtkabir']);
  });

  it('requires every refinement term', () => {
    const value = filterGeneralSearchRecordsV10(prepared.records, 'park cankaya', selected(), selected());
    expect(value.map(item => item.title)).toEqual(['Kuğulu Park', 'Seğmenler Parkı']);
  });

  it('returns all records for blank refinement', () => {
    expect(filterGeneralSearchRecordsV10(prepared.records, '   ', selected(), selected()))
      .toHaveLength(prepared.records.length);
  });

  it('combines refinement and category facets', () => {
    const value = filterGeneralSearchRecordsV10(
      prepared.records,
      'cankaya',
      selected('park'),
      selected(),
    );
    expect(value.map(item => item.title)).toEqual(['Kuğulu Park', 'Seğmenler Parkı']);
  });

  it('combines category and type facets conjunctively', () => {
    const value = filterGeneralSearchRecordsV10(
      prepared.records,
      '',
      selected('park'),
      selected('yesil alan'),
    );
    expect(value).toHaveLength(3);
  });

  it('does not match a type selected from an unrelated category', () => {
    const value = filterGeneralSearchRecordsV10(
      prepared.records,
      '',
      selected('muze'),
      selected('yesil alan'),
    );
    expect(value).toHaveLength(0);
  });
});

describe('GenelAramaWindowPresentationV10 relevance', () => {
  it('prefers exact title matches', () => {
    const anitkabir = prepared.records.find(item => item.title === 'Anıtkabir');
    const castle = prepared.records.find(item => item.title === 'Ankara Kalesi');
    expect(anitkabir).toBeDefined();
    expect(castle).toBeDefined();
    expect(scoreGeneralSearchRecordV10(anitkabir!, 'Anıtkabir'))
      .toBeGreaterThan(scoreGeneralSearchRecordV10(castle!, 'Anıtkabir'));
  });

  it('uses address evidence when titles do not match', () => {
    const castle = prepared.records.find(item => item.title === 'Ankara Kalesi');
    const cermodern = prepared.records.find(item => item.title === 'CerModern');
    expect(scoreGeneralSearchRecordV10(castle!, 'Altındağ'))
      .toBeGreaterThan(scoreGeneralSearchRecordV10(cermodern!, 'Altındağ'));
  });

  it('keeps source order for ties in relevance mode', () => {
    const filtered = filterGeneralSearchRecordsV10(prepared.records, 'park', selected(), selected());
    const sorted = sortGeneralSearchRecordsV10(filtered, 'park', 'relevance');
    expect(sorted.map(item => item.sourceIndex)).toEqual([2, 3, 5]);
  });

  it('sorts Turkish titles deterministically', () => {
    const sorted = sortGeneralSearchRecordsV10(prepared.records, '', 'title');
    expect(sorted.map(item => item.title)).toEqual([
      'Anıtkabir',
      'Ankara Kalesi',
      'CerModern',
      'Gençlik Parkı',
      'Kuğulu Park',
      'Seğmenler Parkı',
    ]);
  });

  it('sorts categories then titles', () => {
    const sorted = sortGeneralSearchRecordsV10(prepared.records, '', 'category');
    const categories = sorted.map(item => item.category);
    expect(categories).toEqual([...categories].sort((left, right) =>
      left.localeCompare(right, 'tr-TR', { sensitivity: 'base', numeric: true })));
  });

  it('sorts addresses with empty addresses last', () => {
    const value = normalizeSearchCollection([
      { ObjectId: 1, Title: 'Boş' },
      { ObjectId: 2, Title: 'A', Address: 'Atatürk Bulvarı' },
      { ObjectId: 3, Title: 'B', Address: 'Ziya Gökalp Caddesi' },
    ]);
    const preparedValue = prepareGeneralSearchRecordsV10(value, policy);
    const sorted = sortGeneralSearchRecordsV10(preparedValue.records, '', 'address');
    expect(sorted.map(item => item.title)).toEqual(['A', 'B', 'Boş']);
  });

  it('preserves source order explicitly', () => {
    const sorted = sortGeneralSearchRecordsV10(prepared.records, 'park', 'source-order');
    expect(sorted.map(item => item.sourceIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('GenelAramaWindowPresentationV10 facets', () => {
  it('counts category buckets', () => {
    const facet = createGeneralSearchFacetModelV10(
      prepared.records,
      '',
      'category',
      selected(),
      selected(),
      policy,
    );
    expect(facet.buckets[0]).toMatchObject({ value: 'Park', count: 3 });
    expect(facet.totalBuckets).toBe(4);
  });

  it('counts type buckets', () => {
    const facet = createGeneralSearchFacetModelV10(
      prepared.records,
      '',
      'type',
      selected(),
      selected(),
      policy,
    );
    expect(facet.buckets.map(bucket => [bucket.value, bucket.count]))
      .toEqual([['Kültür', 3], ['Yeşil Alan', 3]]);
  });

  it('marks selected buckets first', () => {
    const facet = createGeneralSearchFacetModelV10(
      prepared.records,
      '',
      'category',
      selected('muze'),
      selected(),
      policy,
    );
    expect(facet.buckets[0]).toMatchObject({ value: 'Müze', selected: true });
  });

  it('recomputes type counts under category selection', () => {
    const facets = createGeneralSearchFacetsV10(
      prepared.records,
      '',
      selected('park'),
      selected(),
      policy,
    );
    const type = facets.find(facet => facet.kind === 'type');
    expect(type?.buckets).toEqual([
      expect.objectContaining({ value: 'Yeşil Alan', count: 3 }),
    ]);
  });

  it('recomputes category counts under type selection', () => {
    const facets = createGeneralSearchFacetsV10(
      prepared.records,
      '',
      selected(),
      selected('kultur'),
      policy,
    );
    const category = facets.find(facet => facet.kind === 'category');
    expect(category?.buckets.map(bucket => bucket.value)).toEqual([
      'Müze',
      'Sanat Merkezi',
      'Tarihi Yer',
    ]);
  });

  it('uses refinement before counting facet candidates', () => {
    const facet = createGeneralSearchFacetModelV10(
      prepared.records,
      'cankaya',
      'category',
      selected(),
      selected(),
      policy,
    );
    expect(facet.buckets.map(bucket => [bucket.value, bucket.count]))
      .toEqual([['Park', 2], ['Müze', 1]]);
  });

  it('truncates very wide facet vocabularies', () => {
    const many = normalizeSearchCollection(Array.from({ length: 12 }, (_, index) => ({
      ObjectId: index,
      Title: `Kayıt ${index}`,
      Category: `Kategori ${index}`,
    })));
    const p = prepareGeneralSearchRecordsV10(many, policy);
    const facet = createGeneralSearchFacetModelV10(
      p.records,
      '',
      'category',
      selected(),
      selected(),
      policy,
    );
    expect(facet.buckets).toHaveLength(policy.maxFacetBuckets);
    expect(facet.totalBuckets).toBe(12);
    expect(facet.truncated).toBe(true);
  });
});

describe('GenelAramaWindowPresentationV10 highlights', () => {
  it('highlights a direct title term', () => {
    const segments = highlightGeneralSearchTextV10('Ankara Kalesi', 'Ankara');
    expect(segments.some(segment => segment.matched && segment.text === 'Ankara')).toBe(true);
  });

  it('highlights multiple refinement terms', () => {
    const segments = highlightGeneralSearchTextV10('Kale Mahallesi Altındağ', 'kale altindag');
    const matched = segments.filter(segment => segment.matched).map(segment => segment.text);
    expect(matched).toEqual(expect.arrayContaining(['Kale', 'Altındağ']));
  });

  it('returns one plain segment when refinement is blank', () => {
    expect(highlightGeneralSearchTextV10('Anıtkabir', '')).toEqual([
      { text: 'Anıtkabir', matched: false },
    ]);
  });

  it('returns empty segments for empty values', () => {
    expect(highlightGeneralSearchTextV10('', 'ankara')).toEqual([]);
  });

  it('bounds generated highlight segments', () => {
    const segments = highlightGeneralSearchTextV10(
      'a a a a a a a a a a a a a a a a a a a a',
      'a',
      6,
    );
    expect(segments.length).toBeLessThanOrEqual(6);
  });

  it('adds score and active facts to presented records', () => {
    const sorted = sortGeneralSearchRecordsV10(prepared.records, 'park', 'relevance');
    const presented = createGeneralSearchPresentedRecordsV10(
      sorted,
      'park',
      sorted[0]?.identity ?? null,
      policy,
    );
    expect(presented[0]?.active).toBe(true);
    expect(presented[0]?.score).toBeGreaterThan(0);
    expect(presented[1]?.active).toBe(false);
  });
});

describe('GenelAramaWindowPresentationV10 render window', () => {
  it('returns an empty render window for zero results', () => {
    expect(createGeneralSearchRenderWindowV10(0, -1, null, policy)).toEqual({
      startIndex: 0,
      endIndexExclusive: 0,
      count: 0,
      totalMatched: 0,
      hasBefore: false,
      hasAfter: false,
    });
  });

  it('shows all results smaller than the render window', () => {
    const window = createGeneralSearchRenderWindowV10(6, 0, null, policy);
    expect(window.startIndex).toBe(0);
    expect(window.endIndexExclusive).toBe(6);
    expect(window.hasAfter).toBe(false);
  });

  it('keeps active result within the bounded window', () => {
    const p = normalizeGeneralSearchWindowPolicyV10({
      renderWindowSize: 10,
      renderOverscan: 2,
    });
    const window = createGeneralSearchRenderWindowV10(100, 50, null, p);
    expect(window.count).toBe(10);
    expect(50).toBeGreaterThanOrEqual(window.startIndex);
    expect(50).toBeLessThan(window.endIndexExclusive);
  });

  it('honors a safe preferred window start', () => {
    const p = normalizeGeneralSearchWindowPolicyV10({ renderWindowSize: 10, renderOverscan: 1 });
    const window = createGeneralSearchRenderWindowV10(100, 23, 20, p);
    expect(window.startIndex).toBe(20);
    expect(window.endIndexExclusive).toBe(30);
  });

  it('clamps preferred window start at the final page', () => {
    const p = normalizeGeneralSearchWindowPolicyV10({ renderWindowSize: 10 });
    const window = createGeneralSearchRenderWindowV10(25, 24, 1000, p);
    expect(window.startIndex).toBe(15);
    expect(window.endIndexExclusive).toBe(25);
    expect(window.hasAfter).toBe(false);
  });
});

describe('GenelAramaWindowPresentationV10 keyboard decisions', () => {
  it.each([
    ['ArrowUp', 'previous'],
    ['ArrowDown', 'next'],
    ['Home', 'first'],
    ['End', 'last'],
    ['PageUp', 'page-previous'],
    ['PageDown', 'page-next'],
    ['Enter', 'activate'],
    [' ', 'activate'],
    ['Escape', 'clear'],
  ] as const)('maps %s to %s', (key, command) => {
    expect(keyboardDecisionForGeneralSearchV10(key)).toMatchObject({ handled: true, command });
  });

  it('does not capture unrelated typing keys', () => {
    expect(keyboardDecisionForGeneralSearchV10('a')).toEqual({
      handled: false,
      command: null,
      preventDefault: false,
    });
  });

  it('moves one result at a time', () => {
    expect(moveGeneralSearchIndexV10(2, 10, 'next', policy)).toBe(3);
    expect(moveGeneralSearchIndexV10(2, 10, 'previous', policy)).toBe(1);
  });

  it('does not move beyond boundaries', () => {
    expect(moveGeneralSearchIndexV10(0, 10, 'previous', policy)).toBe(0);
    expect(moveGeneralSearchIndexV10(9, 10, 'next', policy)).toBe(9);
  });

  it('moves by configured keyboard page size', () => {
    expect(moveGeneralSearchIndexV10(5, 20, 'page-next', policy)).toBe(8);
    expect(moveGeneralSearchIndexV10(5, 20, 'page-previous', policy)).toBe(2);
  });

  it('moves to first and last directly', () => {
    expect(moveGeneralSearchIndexV10(5, 20, 'first', policy)).toBe(0);
    expect(moveGeneralSearchIndexV10(5, 20, 'last', policy)).toBe(19);
  });

  it('returns -1 for empty collections', () => {
    expect(moveGeneralSearchIndexV10(0, 0, 'next', policy)).toBe(-1);
  });
});

describe('GenelAramaWindowPresentationV10 guidance and announcements', () => {
  it('guides server-empty states', () => {
    expect(createGeneralSearchGuidanceV10(0, 0, '', 0, false)).toMatchObject({
      tone: 'neutral',
      title: 'Sonuç bulunamadı',
      actionLabel: null,
    });
  });

  it('offers clearing local filters for local-empty states', () => {
    expect(createGeneralSearchGuidanceV10(10, 0, 'park', 0, false)).toMatchObject({
      tone: 'info',
      actionLabel: 'Filtreleri temizle',
    });
  });

  it('reports narrowed result sets', () => {
    expect(createGeneralSearchGuidanceV10(10, 3, 'park', 1, false)).toMatchObject({
      tone: 'success',
      actionLabel: 'Filtreleri temizle',
    });
  });

  it('warns when the result safety limit was reached', () => {
    expect(createGeneralSearchGuidanceV10(50_000, 50_000, '', 0, true)).toMatchObject({
      tone: 'warning',
      title: 'Sonuç kümesi güvenli sınırda tutuldu',
    });
  });

  it('announces total and active result', () => {
    const window = createGeneralSearchRenderWindowV10(6, 2, null, policy);
    const announcement = createGeneralSearchAnnouncementV10(
      6,
      6,
      2,
      records[2] ?? null,
      window,
      policy,
    );
    expect(announcement).toContain('6 sonuç kullanılabilir');
    expect(announcement).toContain('3. sonuç seçili');
    expect(announcement).toContain('Kuğulu Park');
  });

  it('announces local filtering', () => {
    const window = createGeneralSearchRenderWindowV10(2, 0, null, policy);
    const announcement = createGeneralSearchAnnouncementV10(
      6,
      2,
      0,
      records[2] ?? null,
      window,
      policy,
    );
    expect(announcement).toContain('6 sonuçtan 2 tanesi');
  });

  it('bounds announcement length', () => {
    const shortPolicy = normalizeGeneralSearchWindowPolicyV10({ maxAnnouncementLength: 80 });
    const longRecord = normalizeSearchCollection([{
      ObjectId: 1,
      Title: 'Çok uzun '.repeat(50),
    }])[0] ?? null;
    const window = createGeneralSearchRenderWindowV10(1, 0, null, shortPolicy);
    expect(createGeneralSearchAnnouncementV10(1, 1, 0, longRecord, window, shortPolicy).length)
      .toBeLessThanOrEqual(80);
  });
});
