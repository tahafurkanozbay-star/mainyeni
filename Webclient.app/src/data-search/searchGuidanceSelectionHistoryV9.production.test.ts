import { describe, expect, it } from 'vitest';
import type { DatasetSnapshot, SearchRequest } from './contracts';
import { createDataSearchRuntime } from './searchRuntime';
import { createSearchRecoveryRuntimeV8 } from './searchRecoveryRuntimeV8';
import { SearchResultPresentationRuntimeV9 } from './searchResultPresentationRuntimeV9';
import { SearchGroupingRuntimeV9 } from './searchGroupingRuntimeV9';
import {
  SearchGuidanceRuntimeV9,
  applySearchGuidanceActionV9,
} from './searchGuidanceRuntimeV9';
import { SearchSelectionRuntimeV9 } from './searchSelectionRuntimeV9';
import { SearchHistoryRuntimeV9 } from './searchHistoryRuntimeV9';

const rows = (suffix = '') => [
  {
    id: `hospital-${suffix || 'a'}`,
    name: `Çankaya Devlet Hastanesi${suffix}`,
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
    id: `park-${suffix || 'a'}`,
    name: `Atatürk Parkı${suffix}`,
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
    id: `municipality-${suffix || 'a'}`,
    name: `Çankaya Belediyesi${suffix}`,
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
    id: `culture-${suffix || 'a'}`,
    name: `Ulus Kültür Merkezi${suffix}`,
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

const dataset = (suffix = ''): DatasetSnapshot =>
  createDataSearchRuntime().register('ankara', rows(suffix));

const runtime = (blockedWindow = false) => {
  const recovery = createSearchRecoveryRuntimeV8({
    correction: {
      minimumAutoApplyScore: 100,
      minimumAutoApplyMargin: 5,
      maximumAutoEditDistance: 2,
    },
    registry: blockedWindow
      ? { execution: { maximumResultWindow: 100 } }
      : {},
  });
  recovery.register(dataset());
  return recovery;
};

const view = (request: SearchRequest, blockedWindow = false) => {
  const recovery = runtime(blockedWindow);
  const result = recovery.search('ankara', request);
  const cards = new SearchResultPresentationRuntimeV9().cards(request, result);
  const grouping = new SearchGroupingRuntimeV9({ mode: 'category' }).group(cards);
  return { recovery, result, cards, grouping } as const;
};

describe('SearchGuidanceRuntimeV9 usable states', () => {
  it('produces success copy and result announcement', () => {
    const request = { query: 'park' } satisfies SearchRequest;
    const { result, cards, grouping } = view(request);
    const guidance = new SearchGuidanceRuntimeV9({ lowResultThreshold: 0 })
      .evaluate(request, result, cards, grouping);
    expect(guidance.status).toBe('success');
    expect(guidance.severity).toBe('success');
    expect(guidance.resultCountText).toMatch(/sonuç/u);
    expect(guidance.announcement).toContain('Arama tamamlandı');
  });

  it('labels typo recovery and offers the executed query explicitly', () => {
    const request = { query: 'hastne' } satisfies SearchRequest;
    const { result, cards, grouping } = view(request);
    const guidance = new SearchGuidanceRuntimeV9().evaluate(request, result, cards, grouping);
    expect(guidance.status).toBe('recovered');
    expect(guidance.recovered).toBe(true);
    expect(guidance.actions.some(action => action.kind === 'use-executed-query')).toBe(true);
    expect(guidance.executedQuery).toContain('hastane');
  });

  it('produces an empty state with explicit broadening actions', () => {
    const request = {
      query: 'mevcutolmayanbenzersizsorgu',
      filters: [{ field: 'category', operator: 'eq', values: ['Olmayan'] }],
      district: 'Olmayan İlçe',
    } satisfies SearchRequest;
    const { result, cards, grouping } = view(request);
    const guidance = new SearchGuidanceRuntimeV9().evaluate(request, result, cards, grouping);
    expect(guidance.status).toBe('empty');
    expect(guidance.severity).toBe('warning');
    expect(guidance.actions.some(action => action.kind === 'clear-filters')).toBe(true);
    expect(guidance.actions.some(action => action.kind === 'clear-address-scope')).toBe(true);
    expect(guidance.actions.some(action => action.kind === 'show-all-results')).toBe(true);
  });

  it('preserves a blocked result as blocked instead of fabricating success', () => {
    const request = { query: 'park', offset: 100 } satisfies SearchRequest;
    const { result, cards, grouping } = view(request, true);
    expect(result.final.result.diagnostics.blocked).toBe(true);
    const guidance = new SearchGuidanceRuntimeV9().evaluate(request, result, cards, grouping);
    expect(guidance.status).toBe('blocked');
    expect(guidance.severity).toBe('error');
    expect(guidance.blockedReason).toBeTruthy();
  });

  it('offers spatial clearing only when a spatial constraint exists', () => {
    const constrained = {
      query: 'olmayan',
      center: [32.8541, 39.9208],
      radiusMeters: 250,
    } satisfies SearchRequest;
    const constrainedView = view(constrained);
    const constrainedGuidance = new SearchGuidanceRuntimeV9().evaluate(
      constrained,
      constrainedView.result,
      constrainedView.cards,
      constrainedView.grouping,
    );
    expect(constrainedGuidance.actions.some(action => action.kind === 'clear-spatial')).toBe(true);

    const plain = { query: 'olmayan' } satisfies SearchRequest;
    const plainView = view(plain);
    const plainGuidance = new SearchGuidanceRuntimeV9().evaluate(
      plain,
      plainView.result,
      plainView.cards,
      plainView.grouping,
    );
    expect(plainGuidance.actions.some(action => action.kind === 'clear-spatial')).toBe(false);
  });

  it('applies guidance request patches without mutating the original request', () => {
    const request = {
      query: 'park',
      filters: [{ field: 'category', operator: 'eq', values: ['Park'] }],
      center: [32.8541, 39.9208],
      radiusMeters: 500,
      district: 'Çankaya',
      offset: 25,
    } satisfies SearchRequest;
    const action = {
      id: 'clear-all',
      kind: 'show-all-results',
      label: 'Tüm sonuçları göster',
      description: 'test',
      query: '',
      clearFilters: true,
      clearSpatial: true,
      clearAddressScope: true,
      resetOffset: true,
      fingerprint: 'test',
    } as const;
    const next = applySearchGuidanceActionV9(request, action);
    expect(next.query).toBe('');
    expect(next.filters).toEqual([]);
    expect(next.center).toBeNull();
    expect(next.radiusMeters).toBe(0);
    expect(next.district).toBeNull();
    expect(next.offset).toBe(0);
    expect(request.query).toBe('park');
    expect(request.offset).toBe(25);
  });

  it('bounds guidance action count', () => {
    const request = {
      query: 'olmayan iki kelime',
      filters: [{ field: 'category', operator: 'eq', values: ['Olmayan'] }],
      center: [32.8541, 39.9208],
      radiusMeters: 100,
      district: 'Olmayan',
    } satisfies SearchRequest;
    const { result, cards, grouping } = view(request);
    const guidance = new SearchGuidanceRuntimeV9({ maxActions: 2 })
      .evaluate(request, result, cards, grouping);
    expect(guidance.actions.length).toBeLessThanOrEqual(2);
  });

  it('tracks state counters without retaining raw records', () => {
    const request = { query: 'park' } satisfies SearchRequest;
    const { result, cards, grouping } = view(request);
    const runtime = new SearchGuidanceRuntimeV9({ lowResultThreshold: 0 });
    runtime.evaluate(request, result, cards, grouping);
    const snapshot = runtime.snapshot();
    expect(snapshot.evaluations).toBe(1);
    expect(snapshot.success).toBe(1);
    expect(snapshot.actionsBuilt).toBeGreaterThanOrEqual(0);
    expect('records' in snapshot).toBe(false);
  });
});

describe('SearchSelectionRuntimeV9 keyboard-neutral state', () => {
  const cards = () => view({ query: '' }).cards;
  const identity = (revision = 1, fingerprint = 'dataset-a') => ({
    key: 'ankara',
    revision,
    fingerprint,
  });

  it('activates the first result by default', () => {
    const source = cards();
    const selection = new SearchSelectionRuntimeV9();
    const snapshot = selection.setResults(identity(), source);
    expect(snapshot.resultCount).toBe(source.length);
    expect(snapshot.activeKey).toBe(source[0]?.key);
    expect(snapshot.activePosition?.position).toBe(1);
    expect(snapshot.activePosition?.setSize).toBe(source.length);
  });

  it('moves next and previous deterministically without wrapping by default', () => {
    const source = cards();
    const selection = new SearchSelectionRuntimeV9();
    selection.setResults(identity(), source);
    selection.next();
    expect(selection.snapshot().activeIndex).toBe(Math.min(1, source.length - 1));
    selection.previous();
    expect(selection.snapshot().activeIndex).toBe(0);
    selection.previous();
    expect(selection.snapshot().activeIndex).toBe(0);
  });

  it('supports opt-in wrap navigation', () => {
    const source = cards();
    const selection = new SearchSelectionRuntimeV9({ wrapNavigation: true });
    selection.setResults(identity(), source);
    selection.first();
    selection.previous();
    expect(selection.snapshot().activeIndex).toBe(source.length - 1);
  });

  it('supports Home End and page movement semantics', () => {
    const source = cards();
    const selection = new SearchSelectionRuntimeV9({ pageStep: 2 });
    selection.setResults(identity(), source);
    selection.last();
    expect(selection.snapshot().activeIndex).toBe(source.length - 1);
    selection.first();
    selection.pageNext();
    expect(selection.snapshot().activeIndex).toBe(Math.min(2, source.length - 1));
    selection.pagePrevious();
    expect(selection.snapshot().activeIndex).toBe(0);
  });

  it('keeps single selection by default', () => {
    const source = cards();
    const selection = new SearchSelectionRuntimeV9();
    selection.setResults(identity(), source);
    selection.select(source[0]?.key);
    selection.select(source[1]?.key);
    expect(selection.snapshot().selectedCount).toBe(1);
    expect(selection.snapshot().selectedKeys[0]).toBe(source[1]?.key);
  });

  it('supports bounded multi-selection when enabled', () => {
    const source = cards();
    const selection = new SearchSelectionRuntimeV9({ multiSelect: true, maxSelected: 2 });
    selection.setResults(identity(), source);
    for (const card of source.slice(0, 3)) selection.select(card.key);
    expect(selection.snapshot().selectedCount).toBeLessThanOrEqual(2);
  });

  it('resets active and selected identity when dataset revision changes', () => {
    const source = cards();
    const selection = new SearchSelectionRuntimeV9();
    selection.setResults(identity(1, 'one'), source);
    selection.select(source[1]?.key);
    const next = selection.setResults(identity(2, 'two'), source);
    expect(next.selectedCount).toBe(0);
    expect(next.activeKey).toBe(source[0]?.key);
    expect(next.revisionResets).toBe(1);
  });

  it('drops selection keys that disappear from the current result set', () => {
    const source = cards();
    const selection = new SearchSelectionRuntimeV9({ multiSelect: true });
    selection.setResults(identity(), source);
    selection.select(source[0]?.key);
    selection.select(source[1]?.key);
    const reduced = source.slice(1);
    const next = selection.setResults(identity(), reduced);
    expect(next.selectedKeys).not.toContain(source[0]?.key);
  });

  it('rejects unknown active keys instead of inventing a result', () => {
    const source = cards();
    const selection = new SearchSelectionRuntimeV9();
    selection.setResults(identity(), source);
    const before = selection.snapshot().activeKey;
    selection.setActive('missing-key');
    expect(selection.snapshot().activeKey).toBe(before);
  });

  it('bounds retained result keys', () => {
    const source = cards();
    const selection = new SearchSelectionRuntimeV9({ maxResults: 2 });
    const snapshot = selection.setResults(identity(), source);
    expect(snapshot.resultCount).toBeLessThanOrEqual(2);
  });
});

describe('SearchHistoryRuntimeV9 privacy-safe session memory', () => {
  const search = (request: SearchRequest) => {
    const recovery = runtime();
    return recovery.search('ankara', request);
  };

  it('records sanitized query facts without full record payloads', () => {
    let now = 1_000;
    const history = new SearchHistoryRuntimeV9({ clock: () => now });
    const request = { query: 'park' } satisfies SearchRequest;
    const entry = history.record(request, search(request));
    expect(entry?.query).toBe('park');
    expect(entry?.resultCount).toBeGreaterThan(0);
    expect(entry?.datasetKey).toBe('ankara');
    expect('records' in (entry ?? {})).toBe(false);
    expect('coordinates' in (entry ?? {})).toBe(false);
    now += 1;
  });

  it('deduplicates repeated logical queries and increments usage', () => {
    let now = 1_000;
    const history = new SearchHistoryRuntimeV9({ clock: () => now });
    const request = { query: 'park' } satisfies SearchRequest;
    history.record(request, search(request));
    now = 2_000;
    const second = history.record(request, search(request));
    expect(history.entries()).toHaveLength(1);
    expect(second?.uses).toBe(2);
    expect(second?.lastUsedAt).toBe(2_000);
    expect(history.snapshot().deduplicated).toBe(1);
  });

  it('excludes blocked searches by default', () => {
    const blocked = runtime(true);
    const request = { query: 'park', offset: 100 } satisfies SearchRequest;
    const result = blocked.search('ankara', request);
    const history = new SearchHistoryRuntimeV9();
    expect(history.record(request, result)).toBeNull();
    expect(history.entries()).toHaveLength(0);
  });

  it('can exclude empty searches by policy', () => {
    const request = { query: 'olmayanbenzersizsorgu' } satisfies SearchRequest;
    const history = new SearchHistoryRuntimeV9({ excludeEmpty: true });
    expect(history.record(request, search(request))).toBeNull();
  });

  it('bounds history entries with LRU-style oldest eviction', () => {
    let now = 0;
    const history = new SearchHistoryRuntimeV9({ maxEntries: 2, clock: () => ++now });
    for (const query of ['park', 'hastane', 'belediye']) {
      const request = { query } satisfies SearchRequest;
      history.record(request, search(request));
    }
    expect(history.entries()).toHaveLength(2);
    expect(history.snapshot().evictions).toBe(1);
  });

  it('ranks suggestions by prefix, recency and repeat usage', () => {
    let now = 1_000;
    const history = new SearchHistoryRuntimeV9({ clock: () => now });
    const park = { query: 'park' } satisfies SearchRequest;
    const hospital = { query: 'hastane' } satisfies SearchRequest;
    history.record(park, search(park));
    now += 100;
    history.record(hospital, search(hospital));
    now += 100;
    history.record(park, search(park));
    const suggestions = history.suggestions('ankara', 'pa');
    expect(suggestions[0]?.query).toBe('park');
    expect(suggestions[0]?.uses).toBe(2);
  });

  it('never persists memory to a browser storage surface', () => {
    const history = new SearchHistoryRuntimeV9();
    const request = { query: 'park' } satisfies SearchRequest;
    history.record(request, search(request));
    const snapshot = history.snapshot();
    expect(snapshot.entries).toBe(1);
    expect('storage' in snapshot).toBe(false);
    expect('localStorage' in snapshot).toBe(false);
  });

  it('clears one dataset or all datasets deterministically', () => {
    const history = new SearchHistoryRuntimeV9();
    const request = { query: 'park' } satisfies SearchRequest;
    history.record(request, search(request));
    expect(history.clear('ankara')).toBe(1);
    expect(history.entries()).toHaveLength(0);
    history.record(request, search(request));
    expect(history.clear()).toBe(1);
    expect(history.entries()).toHaveLength(0);
  });
});
