import { describe, expect, it } from 'vitest';
import type { DatasetSnapshot, SearchRequest } from './contracts';
import { createDataSearchRuntime } from './searchRuntime';
import { createSearchRecoveryRuntimeV8 } from './searchRecoveryRuntimeV8';
import {
  SearchResultPresentationRuntimeV9,
  createSearchHighlightRangesV9,
  type SearchResultCardV9,
} from './searchResultPresentationRuntimeV9';
import {
  SearchGroupingRuntimeV9,
  type SearchGroupingModeV9,
} from './searchGroupingRuntimeV9';

const rows = () => [
  {
    id: 'hospital-cankaya',
    name: 'Çankaya Devlet Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    address: 'Atatürk Bulvarı No 10 Çankaya Ankara',
    lat: 39.9208,
    lon: 32.8541,
  },
  {
    id: 'hospital-altindag',
    name: 'Altındağ Şehir Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    address: 'Anafartalar Caddesi No 28 Altındağ Ankara',
    lat: 39.9421,
    lon: 32.856,
  },
  {
    id: 'park-kizilay',
    name: 'Atatürk Parkı',
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Karanfil Sokak',
    address: 'Karanfil Sokak No 3 Çankaya Ankara',
    lat: 39.9198,
    lon: 32.8529,
  },
  {
    id: 'park-seymenler',
    name: 'Seğmenler Parkı',
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Çankaya',
    street: 'İran Caddesi',
    address: 'İran Caddesi Çankaya Ankara',
    lat: 39.9026,
    lon: 32.8604,
  },
  {
    id: 'municipality',
    name: 'Çankaya Belediyesi',
    category: 'Kamu',
    type: 'Belediye',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Ziya Gökalp Caddesi',
    address: 'Ziya Gökalp Caddesi No 7 Çankaya Ankara',
    lat: 39.9212,
    lon: 32.8537,
  },
  {
    id: 'culture-ulus',
    name: 'Ulus Kültür Merkezi',
    category: 'Kültür',
    type: 'Kültür Merkezi',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    address: 'Anafartalar Caddesi No 15 Altındağ Ankara',
    lat: 39.941,
    lon: 32.855,
  },
] as const;

const dataset = (): DatasetSnapshot => createDataSearchRuntime().register('ankara', rows());

const recovery = () => {
  const runtime = createSearchRecoveryRuntimeV8({
    correction: {
      minimumAutoApplyScore: 100,
      minimumAutoApplyMargin: 5,
      maximumAutoEditDistance: 2,
    },
  });
  runtime.register(dataset());
  return runtime;
};

const cardsFor = (
  request: SearchRequest,
  policy: ConstructorParameters<typeof SearchResultPresentationRuntimeV9>[0] = {},
): readonly SearchResultCardV9[] => {
  const runtime = recovery();
  const result = runtime.search('ankara', request);
  return new SearchResultPresentationRuntimeV9(policy).cards(request, result);
};

describe('SearchResultPresentationRuntimeV9 highlight safety', () => {
  it('creates source offsets for Turkish-aware normalized query terms', () => {
    const source = 'Çankaya Devlet Hastanesi';
    const ranges = createSearchHighlightRangesV9(source, ['hastane'], 8);
    expect(ranges.length).toBeGreaterThan(0);
    expect(source.slice(ranges[0]?.start, ranges[0]?.end).toLocaleLowerCase('tr-TR'))
      .toContain('hastane');
  });

  it('does not return HTML markup or mutate the source string', () => {
    const source = '<b>Park</b> & Belediye';
    const ranges = createSearchHighlightRangesV9(source, ['park', 'belediye'], 8);
    expect(ranges).toHaveLength(2);
    expect(source).toBe('<b>Park</b> & Belediye');
    expect(ranges.every(range => Number.isInteger(range.start) && Number.isInteger(range.end))).toBe(true);
  });

  it('merges overlapping ranges instead of creating overlapping render spans', () => {
    const ranges = createSearchHighlightRangesV9('Ankara Büyükşehir Belediyesi', ['ankara', 'ankar'], 8);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.start).toBe(0);
    expect(ranges[0]?.end).toBeGreaterThan(4);
  });

  it('bounds highlight count even for repeated text', () => {
    const ranges = createSearchHighlightRangesV9('park park park park park park', ['park'], 3);
    expect(ranges).toHaveLength(3);
  });

  it('returns no ranges for empty terms or empty text', () => {
    expect(createSearchHighlightRangesV9('', ['park'], 8)).toEqual([]);
    expect(createSearchHighlightRangesV9('Park', [], 8)).toEqual([]);
    expect(createSearchHighlightRangesV9('Park', ['park'], 0)).toEqual([]);
  });
});

describe('SearchResultPresentationRuntimeV9 cards', () => {
  it('builds immutable stable cards from canonical search hits', () => {
    const runtime = recovery();
    const request = { query: 'hastane' } satisfies SearchRequest;
    const result = runtime.search('ankara', request);
    const presentation = new SearchResultPresentationRuntimeV9();
    const first = presentation.cards(request, result);
    const second = new SearchResultPresentationRuntimeV9().cards(request, result);
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]?.key).toBe(second[0]?.key);
    expect(first[0]?.fingerprint).toBe(second[0]?.fingerprint);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
  });

  it('adds category, type and district badges without a second icon authority', () => {
    const cards = cardsFor({ query: 'hastane' });
    const kinds = cards[0]?.badges.map(badge => badge.kind) ?? [];
    expect(kinds).toContain('category');
    expect(kinds).toContain('type');
    expect(kinds).toContain('district');
  });

  it('marks address evidence when the canonical search engine exposes it', () => {
    const cards = cardsFor({ query: 'Atatürk Bulvarı 10 Çankaya' });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some(card => card.explanation.details.some(value => value.includes('Adres')))).toBe(true);
  });

  it('exposes spatial distance facts without adding navigation behavior', () => {
    const cards = cardsFor({
      query: '',
      center: [32.8541, 39.9208],
      radiusMeters: 5_000,
      sort: 'distance',
    });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0]?.distanceMeters).not.toBeNull();
    expect(cards[0]?.badges.some(badge => badge.kind === 'distance')).toBe(true);
  });

  it('explains typo recovery using executed query facts', () => {
    const runtime = recovery();
    const request = { query: 'hastne' } satisfies SearchRequest;
    const result = runtime.search('ankara', request);
    const cards = new SearchResultPresentationRuntimeV9().cards(request, result);
    expect(result.diagnostics.recovered).toBe(true);
    expect(cards[0]?.explanation.recovered).toBe(true);
    expect(cards[0]?.badges.some(badge => badge.kind === 'recovery')).toBe(true);
    expect(cards[0]?.explanation.executedQuery).toContain('hastane');
  });

  it('bounds title, subtitle and snippet lengths', () => {
    const cards = cardsFor({ query: 'çankaya' }, {
      maxTitleLength: 20,
      maxSubtitleLength: 24,
      maxSnippetLength: 32,
    });
    expect(cards.every(card => card.title.value.length <= 20)).toBe(true);
    expect(cards.every(card => (card.subtitle?.value.length ?? 0) <= 24)).toBe(true);
    expect(cards.every(card => (card.snippet?.value.length ?? 0) <= 32)).toBe(true);
  });

  it('bounds card output independently from search response cardinality', () => {
    const cards = cardsFor({ query: '', limit: 100 }, { maxCards: 2 });
    expect(cards).toHaveLength(2);
  });

  it('bounds badges and explanation detail collections', () => {
    const cards = cardsFor({
      query: 'çankaya',
      center: [32.8541, 39.9208],
      radiusMeters: 10_000,
    }, {
      maxBadgesPerCard: 2,
      maxExplanationDetails: 1,
    });
    expect(cards.every(card => card.badges.length <= 2)).toBe(true);
    expect(cards.every(card => card.explanation.details.length <= 1)).toBe(true);
  });

  it('keeps raw record identity facts for map/window handoff without owning navigation', () => {
    const cards = cardsFor({ query: 'park' });
    const card = cards[0];
    expect(card?.recordFingerprint).toBeTruthy();
    expect(card?.recordId).toBeTruthy();
    expect(card?.sourceIndex).toBeGreaterThanOrEqual(0);
    expect(card?.hasCoordinates).toBe(true);
    expect(card?.latitude).not.toBeNull();
    expect(card?.longitude).not.toBeNull();
  });

  it('tracks presentation diagnostics without retaining records', () => {
    const runtime = recovery();
    const request = { query: 'park' } satisfies SearchRequest;
    const result = runtime.search('ankara', request);
    const presentation = new SearchResultPresentationRuntimeV9();
    const cards = presentation.cards(request, result);
    const snapshot = presentation.snapshot();
    expect(snapshot.cardsBuilt).toBe(cards.length);
    expect(snapshot.highlightRanges).toBeGreaterThanOrEqual(0);
    expect(snapshot.fingerprint).toBeTruthy();
    expect('records' in snapshot).toBe(false);
  });
});

describe('SearchGroupingRuntimeV9 deterministic grouping', () => {
  const group = (
    mode: SearchGroupingModeV9,
    request: SearchRequest = { query: '' },
  ) => {
    const cards = cardsFor(request);
    return new SearchGroupingRuntimeV9({ mode }).group(cards);
  };

  it('keeps one all-results section when grouping is disabled', () => {
    const result = group('none');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.label).toBe('Tüm sonuçlar');
    expect(result.groups[0]?.cards).toHaveLength(result.totalCards);
  });

  it('groups by category while preserving card order inside each category', () => {
    const cards = cardsFor({ query: '' });
    const result = new SearchGroupingRuntimeV9({ mode: 'category' }).group(cards);
    const health = result.groups.find(item => item.label === 'Sağlık');
    expect(health?.cards).toHaveLength(2);
    expect(health?.cards.map(card => card.sourceIndex))
      .toEqual([...(health?.cards.map(card => card.sourceIndex) ?? [])].sort((a, b) => a - b));
  });

  it('groups by district without changing original result objects', () => {
    const cards = cardsFor({ query: '' });
    const result = new SearchGroupingRuntimeV9({ mode: 'district' }).group(cards);
    expect(result.groups.some(item => item.label === 'Çankaya')).toBe(true);
    const groupedKeys = result.groups.flatMap(item => item.cards.map(card => card.key));
    expect(new Set(groupedKeys).size).toBe(groupedKeys.length);
    expect(groupedKeys.every(key => cards.some(card => card.key === key))).toBe(true);
  });

  it('builds deterministic distance bands for spatial results', () => {
    const result = group('distance', {
      query: '',
      center: [32.8541, 39.9208],
      radiusMeters: 50_000,
      sort: 'distance',
    });
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.groups.every(item => item.mode === 'distance')).toBe(true);
    expect(result.groups.some(item => /m|km/u.test(item.label))).toBe(true);
  });

  it('bounds number of groups and reports omitted cards', () => {
    const cards = cardsFor({ query: '' });
    const result = new SearchGroupingRuntimeV9({
      mode: 'category',
      maxGroups: 2,
      maxCards: 100,
    }).group(cards);
    expect(result.groups.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
    expect(result.omittedCards).toBeGreaterThan(0);
  });

  it('bounds cards per group and retains full group count', () => {
    const cards = cardsFor({ query: '' });
    const result = new SearchGroupingRuntimeV9({
      mode: 'district',
      maxCardsPerGroup: 1,
    }).group(cards);
    const cankaya = result.groups.find(item => item.label === 'Çankaya');
    expect(cankaya?.count).toBeGreaterThan(1);
    expect(cankaya?.cards).toHaveLength(1);
    expect(cankaya?.truncated).toBe(true);
  });

  it('accepts a per-call grouping mode without mutating configured policy', () => {
    const cards = cardsFor({ query: '' });
    const runtime = new SearchGroupingRuntimeV9({ mode: 'category' });
    const district = runtime.group(cards, 'district');
    const category = runtime.group(cards);
    expect(district.mode).toBe('district');
    expect(category.mode).toBe('category');
  });

  it('returns immutable group collections and stable fingerprints', () => {
    const cards = cardsFor({ query: '' });
    const first = new SearchGroupingRuntimeV9({ mode: 'type' }).group(cards);
    const second = new SearchGroupingRuntimeV9({ mode: 'type' }).group(cards);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(Object.isFrozen(first.groups)).toBe(true);
    expect(Object.isFrozen(first.groups[0]?.cards)).toBe(true);
  });

  it('tracks bounded grouping diagnostics', () => {
    const cards = cardsFor({ query: '' });
    const runtime = new SearchGroupingRuntimeV9({ mode: 'category' });
    runtime.group(cards);
    runtime.group(cards, 'district');
    const snapshot = runtime.snapshot();
    expect(snapshot.executions).toBe(2);
    expect(snapshot.groupsBuilt).toBeGreaterThan(0);
    expect(snapshot.cardsGrouped).toBeGreaterThan(0);
    expect(snapshot.fingerprint).toBeTruthy();
  });
});
