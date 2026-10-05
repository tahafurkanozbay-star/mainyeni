import { describe, expect, it } from 'vitest';
import { normalizeSearchCollection } from '../_Common/QuerySearchRuntime';
import {
  GENERAL_SEARCH_WINDOW_VERSION_V10,
  type GeneralSearchSortModeV10,
} from './GenelAramaWindowContractsV10';
import {
  createGenelAramaWindowRuntimeV10,
  GenelAramaWindowRuntimeV10,
} from './GenelAramaWindowRuntimeV10';

const raw = [
  { ObjectId: 1, Title: 'Anıtkabir', Address: 'Çankaya Ankara', Category: 'Müze', Type: 'Kültür' },
  { ObjectId: 2, Title: 'Ankara Kalesi', Address: 'Altındağ Ankara', Category: 'Tarihi Yer', Type: 'Kültür' },
  { ObjectId: 3, Title: 'Kuğulu Park', Address: 'Tunalı Hilmi Çankaya', Category: 'Park', Type: 'Yeşil Alan' },
  { ObjectId: 4, Title: 'Seğmenler Parkı', Address: 'Çankaya Ankara', Category: 'Park', Type: 'Yeşil Alan' },
  { ObjectId: 5, Title: 'CerModern', Address: 'Sıhhiye Ankara', Category: 'Sanat Merkezi', Type: 'Kültür' },
  { ObjectId: 6, Title: 'Gençlik Parkı', Address: 'Altındağ Ankara', Category: 'Park', Type: 'Yeşil Alan' },
  { ObjectId: 7, Title: 'Etnografya Müzesi', Address: 'Namazgah Altındağ', Category: 'Müze', Type: 'Kültür' },
  { ObjectId: 8, Title: 'Botanik Parkı', Address: 'Çankaya Ankara', Category: 'Park', Type: 'Yeşil Alan' },
  { ObjectId: 9, Title: 'Roma Hamamı', Address: 'Ulus Altındağ', Category: 'Tarihi Yer', Type: 'Kültür' },
  { ObjectId: 10, Title: 'Kurtuluş Parkı', Address: 'Kolej Çankaya', Category: 'Park', Type: 'Yeşil Alan' },
] as const;

const records = normalizeSearchCollection(raw);

const createRuntime = (): GenelAramaWindowRuntimeV10 => createGenelAramaWindowRuntimeV10(records, {
  maxRecords: 1_000,
  maxFacetBuckets: 20,
  maxSelectedFacets: 8,
  renderWindowSize: 8,
  renderOverscan: 2,
  keyboardPageSize: 3,
  maxRefinementLength: 80,
});

describe('GenelAramaWindowRuntimeV10 construction', () => {
  it('constructs through class and factory', () => {
    expect(new GenelAramaWindowRuntimeV10(records)).toBeInstanceOf(GenelAramaWindowRuntimeV10);
    expect(createRuntime()).toBeInstanceOf(GenelAramaWindowRuntimeV10);
  });

  it('exposes versioned immutable snapshot', () => {
    const snapshot = createRuntime().snapshot();
    expect(snapshot.version).toBe(GENERAL_SEARCH_WINDOW_VERSION_V10);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(Object.isFrozen(snapshot.visibleItems)).toBe(true);
  });

  it('loads all records initially', () => {
    const snapshot = createRuntime().snapshot();
    expect(snapshot.totalCount).toBe(records.length);
    expect(snapshot.matchedCount).toBe(records.length);
    expect(snapshot.hasFilters).toBe(false);
  });

  it('chooses the first result as initial active result', () => {
    const snapshot = createRuntime().snapshot();
    expect(snapshot.activeIndex).toBe(0);
    expect(snapshot.activeRecord?.title).toBe('Anıtkabir');
  });

  it('exposes bounded policy', () => {
    const runtime = createRuntime();
    expect(runtime.policy()).toMatchObject({
      maxRecords: 1_000,
      maxFacetBuckets: 20,
      maxSelectedFacets: 8,
      renderWindowSize: 8,
      keyboardPageSize: 3,
    });
  });

  it('reports initial diagnostics', () => {
    const diagnostics = createRuntime().diagnostics();
    expect(diagnostics.version).toBe(GENERAL_SEARCH_WINDOW_VERSION_V10);
    expect(diagnostics.sourceRecords).toBe(records.length);
    expect(diagnostics.retainedRecords).toBe(records.length);
    expect(diagnostics.recomputations).toBeGreaterThanOrEqual(1);
    expect(diagnostics.fingerprint).toMatch(/^[a-f0-9]+$/i);
  });
});

describe('GenelAramaWindowRuntimeV10 record replacement', () => {
  it('replaces records atomically', () => {
    const runtime = createRuntime();
    const next = normalizeSearchCollection([
      { ObjectId: 101, Title: 'Yeni Kayıt A', Category: 'Yeni' },
      { ObjectId: 102, Title: 'Yeni Kayıt B', Category: 'Yeni' },
    ]);
    const snapshot = runtime.replaceRecords(next);
    expect(snapshot.totalCount).toBe(2);
    expect(snapshot.items.map(item => item.record.title)).toEqual(['Yeni Kayıt A', 'Yeni Kayıt B']);
  });

  it('increments revision on record replacement', () => {
    const runtime = createRuntime();
    const before = runtime.snapshot().revision;
    runtime.replaceRecords(records);
    expect(runtime.snapshot().revision).toBe(before + 1);
  });

  it('preserves active identity when the same record remains', () => {
    const runtime = createRuntime();
    runtime.setActiveIndex(4);
    const active = runtime.snapshot().activeIdentity;
    const snapshot = runtime.replaceRecords([...records]);
    expect(snapshot.activeIdentity).toBe(active);
  });

  it('falls back to first result when active record disappears', () => {
    const runtime = createRuntime();
    runtime.setActiveIndex(4);
    const next = normalizeSearchCollection([
      { ObjectId: 201, Title: 'Başka A' },
      { ObjectId: 202, Title: 'Başka B' },
    ]);
    const snapshot = runtime.replaceRecords(next);
    expect(snapshot.activeIndex).toBe(0);
    expect(snapshot.activeRecord?.title).toBe('Başka A');
  });

  it('clears active result for an empty replacement', () => {
    const runtime = createRuntime();
    const snapshot = runtime.replaceRecords([]);
    expect(snapshot.activeIndex).toBe(-1);
    expect(snapshot.activeIdentity).toBeNull();
    expect(snapshot.activeRecord).toBeNull();
  });

  it('updates record diagnostics on replacement', () => {
    const runtime = createRuntime();
    const next = normalizeSearchCollection(Array.from({ length: 20 }, (_, index) => ({
      ObjectId: index,
      Title: `Kayıt ${index}`,
    })));
    runtime.replaceRecords(next);
    expect(runtime.diagnostics().sourceRecords).toBe(20);
    expect(runtime.diagnostics().retainedRecords).toBe(20);
  });

  it('enforces configured maximum record count', () => {
    const many = normalizeSearchCollection(Array.from({ length: 100 }, (_, index) => ({
      ObjectId: index,
      Title: `Kayıt ${index}`,
    })));
    const runtime = createGenelAramaWindowRuntimeV10(many, { maxRecords: 25 });
    expect(runtime.snapshot().totalCount).toBe(25);
    expect(runtime.snapshot().resultLimitReached).toBe(true);
    expect(runtime.diagnostics().sourceRecords).toBe(100);
    expect(runtime.diagnostics().retainedRecords).toBe(25);
  });
});

describe('GenelAramaWindowRuntimeV10 refinement', () => {
  it('filters result list locally', () => {
    const runtime = createRuntime();
    const snapshot = runtime.setRefinement('park');
    expect(snapshot.matchedCount).toBe(5);
    expect(snapshot.items.every(item => item.record.title.includes('Park'))).toBe(true);
  });

  it('matches diacritic-free Turkish input', () => {
    const runtime = createRuntime();
    expect(runtime.setRefinement('kugulu').items.map(item => item.record.title)).toEqual(['Kuğulu Park']);
  });

  it('matches address evidence', () => {
    const runtime = createRuntime();
    const snapshot = runtime.setRefinement('altindag');
    expect(snapshot.items.map(item => item.record.title)).toEqual([
      'Ankara Kalesi',
      'Gençlik Parkı',
      'Etnografya Müzesi',
      'Roma Hamamı',
    ]);
  });

  it('sets hasFilters when refinement exists', () => {
    const runtime = createRuntime();
    expect(runtime.setRefinement('ankara').hasFilters).toBe(true);
  });

  it('restores all results after clearing refinement', () => {
    const runtime = createRuntime();
    runtime.setRefinement('park');
    expect(runtime.setRefinement('').matchedCount).toBe(records.length);
  });

  it('does not increment refinement diagnostics for identical text', () => {
    const runtime = createRuntime();
    runtime.setRefinement('park');
    const before = runtime.diagnostics().refinementChanges;
    runtime.setRefinement('park');
    expect(runtime.diagnostics().refinementChanges).toBe(before);
  });

  it('increments refinement diagnostics for changed text', () => {
    const runtime = createRuntime();
    const before = runtime.diagnostics().refinementChanges;
    runtime.setRefinement('park');
    expect(runtime.diagnostics().refinementChanges).toBe(before + 1);
  });

  it('resets active result when active record does not match refinement', () => {
    const runtime = createRuntime();
    runtime.setActiveIndex(0);
    const snapshot = runtime.setRefinement('park');
    expect(snapshot.activeRecord?.title).toContain('Park');
    expect(snapshot.activeIndex).toBe(0);
  });

  it('preserves active result when it still matches refinement', () => {
    const runtime = createRuntime();
    runtime.setActiveIndex(3);
    const identity = runtime.snapshot().activeIdentity;
    const snapshot = runtime.setRefinement('park');
    expect(snapshot.activeIdentity).toBe(identity);
    expect(snapshot.activeRecord?.title).toBe('Seğmenler Parkı');
  });
});

describe('GenelAramaWindowRuntimeV10 facets', () => {
  it('toggles a category facet', () => {
    const runtime = createRuntime();
    const snapshot = runtime.toggleFacet('category', 'Park');
    expect(snapshot.selectedCategories).toEqual(['park']);
    expect(snapshot.matchedCount).toBe(5);
  });

  it('toggles the same category off', () => {
    const runtime = createRuntime();
    runtime.toggleFacet('category', 'Park');
    const snapshot = runtime.toggleFacet('category', 'Park');
    expect(snapshot.selectedCategories).toEqual([]);
    expect(snapshot.matchedCount).toBe(records.length);
  });

  it('toggles a type facet', () => {
    const runtime = createRuntime();
    const snapshot = runtime.toggleFacet('type', 'Kültür');
    expect(snapshot.selectedTypes).toEqual(['kultur']);
    expect(snapshot.matchedCount).toBe(5);
  });

  it('combines category and type facets', () => {
    const runtime = createRuntime();
    runtime.toggleFacet('category', 'Park');
    const snapshot = runtime.toggleFacet('type', 'Yeşil Alan');
    expect(snapshot.matchedCount).toBe(5);
  });

  it('can produce local-empty state from conflicting facets', () => {
    const runtime = createRuntime();
    runtime.toggleFacet('category', 'Park');
    const snapshot = runtime.toggleFacet('type', 'Kültür');
    expect(snapshot.matchedCount).toBe(0);
    expect(snapshot.guidance.actionLabel).toBe('Filtreleri temizle');
  });

  it('clears refinement and facet selections together', () => {
    const runtime = createRuntime();
    runtime.setRefinement('ankara');
    runtime.toggleFacet('category', 'Park');
    runtime.toggleFacet('type', 'Yeşil Alan');
    const snapshot = runtime.clearFilters();
    expect(snapshot.refinement).toBe('');
    expect(snapshot.selectedCategories).toEqual([]);
    expect(snapshot.selectedTypes).toEqual([]);
    expect(snapshot.hasFilters).toBe(false);
  });

  it('supports replacing a category facet selection set', () => {
    const runtime = createRuntime();
    const snapshot = runtime.setFacetSelection('category', ['Park', 'Müze']);
    expect(snapshot.selectedCategories).toEqual(['muze', 'park']);
    expect(snapshot.matchedCount).toBe(7);
  });

  it('supports replacing a type facet selection set', () => {
    const runtime = createRuntime();
    const snapshot = runtime.setFacetSelection('type', ['Kültür']);
    expect(snapshot.selectedTypes).toEqual(['kultur']);
    expect(snapshot.matchedCount).toBe(5);
  });

  it('ignores empty facet values', () => {
    const runtime = createRuntime();
    const before = runtime.snapshot().fingerprint;
    runtime.toggleFacet('category', '');
    expect(runtime.snapshot().fingerprint).toBe(before);
  });

  it('bounds selected facet values', () => {
    const manyCategories = normalizeSearchCollection(Array.from({ length: 20 }, (_, index) => ({
      ObjectId: index,
      Title: `Kayıt ${index}`,
      Category: `Kategori ${index}`,
    })));
    const runtime = createGenelAramaWindowRuntimeV10(manyCategories, { maxSelectedFacets: 3 });
    runtime.setFacetSelection('category', Array.from({ length: 10 }, (_, index) => `Kategori ${index}`));
    expect(runtime.snapshot().selectedCategories).toHaveLength(3);
  });
});

describe('GenelAramaWindowRuntimeV10 sorting', () => {
  it.each([
    'relevance',
    'source-order',
    'title',
    'category',
    'address',
  ] as const)('accepts %s sort mode', (mode: GeneralSearchSortModeV10) => {
    const runtime = createRuntime();
    expect(runtime.setSortMode(mode).sortMode).toBe(mode);
  });

  it('falls back to relevance for unknown sort values', () => {
    const runtime = createRuntime();
    expect(runtime.setSortMode('unsupported').sortMode).toBe('relevance');
  });

  it('sorts by source order', () => {
    const runtime = createRuntime();
    runtime.setRefinement('park');
    const snapshot = runtime.setSortMode('source-order');
    expect(snapshot.items.map(item => item.sourceIndex)).toEqual([2, 3, 5, 7, 9]);
  });

  it('sorts titles deterministically', () => {
    const runtime = createRuntime();
    const snapshot = runtime.setSortMode('title');
    const titles = snapshot.items.map(item => item.record.title);
    expect(titles).toEqual([...titles].sort((left, right) =>
      left.localeCompare(right, 'tr-TR', { sensitivity: 'base', numeric: true })));
  });

  it('preserves active identity across sort changes', () => {
    const runtime = createRuntime();
    runtime.setActiveIndex(5);
    const identity = runtime.snapshot().activeIdentity;
    const snapshot = runtime.setSortMode('title');
    expect(snapshot.activeIdentity).toBe(identity);
    expect(snapshot.activeRecord?.title).toBe('Gençlik Parkı');
  });

  it('tracks sort-change diagnostics only on changes', () => {
    const runtime = createRuntime();
    const before = runtime.diagnostics().sortChanges;
    runtime.setSortMode('title');
    runtime.setSortMode('title');
    expect(runtime.diagnostics().sortChanges).toBe(before + 1);
  });
});

describe('GenelAramaWindowRuntimeV10 active result navigation', () => {
  it('moves to next active result', () => {
    const runtime = createRuntime();
    expect(runtime.moveActive('next').activeIndex).toBe(1);
  });

  it('moves to previous active result', () => {
    const runtime = createRuntime();
    runtime.setActiveIndex(4);
    expect(runtime.moveActive('previous').activeIndex).toBe(3);
  });

  it('moves to first result', () => {
    const runtime = createRuntime();
    runtime.setActiveIndex(8);
    expect(runtime.moveActive('first').activeIndex).toBe(0);
  });

  it('moves to last result', () => {
    const runtime = createRuntime();
    expect(runtime.moveActive('last').activeIndex).toBe(records.length - 1);
  });

  it('moves by keyboard page size', () => {
    const runtime = createRuntime();
    runtime.setActiveIndex(1);
    expect(runtime.moveActive('page-next').activeIndex).toBe(4);
    expect(runtime.moveActive('page-previous').activeIndex).toBe(1);
  });

  it('does not move before the first result', () => {
    const runtime = createRuntime();
    expect(runtime.moveActive('previous').activeIndex).toBe(0);
  });

  it('does not move after the final result', () => {
    const runtime = createRuntime();
    runtime.moveActive('last');
    expect(runtime.moveActive('next').activeIndex).toBe(records.length - 1);
  });

  it('sets active identity directly', () => {
    const runtime = createRuntime();
    const target = runtime.snapshot().items[4];
    expect(target).toBeDefined();
    const snapshot = runtime.setActiveIdentity(target!.identity);
    expect(snapshot.activeIdentity).toBe(target!.identity);
    expect(snapshot.activeIndex).toBe(4);
  });

  it('ignores unknown active identities', () => {
    const runtime = createRuntime();
    const before = runtime.snapshot().fingerprint;
    runtime.setActiveIdentity('missing');
    expect(runtime.snapshot().fingerprint).toBe(before);
  });

  it('sets active index safely', () => {
    const runtime = createRuntime();
    expect(runtime.setActiveIndex(999).activeIndex).toBe(records.length - 1);
    expect(runtime.setActiveIndex(-100).activeIndex).toBe(0);
  });

  it('returns active record helper', () => {
    const runtime = createRuntime();
    runtime.setActiveIndex(2);
    expect(runtime.activeRecord()?.title).toBe('Kuğulu Park');
    expect(runtime.activeIdentity()).toBe(runtime.snapshot().activeIdentity);
  });

  it('tracks active move diagnostics', () => {
    const runtime = createRuntime();
    const before = runtime.diagnostics().activeMoves;
    runtime.moveActive('next');
    runtime.moveActive('next');
    expect(runtime.diagnostics().activeMoves).toBe(before + 2);
  });
});

describe('GenelAramaWindowRuntimeV10 bounded rendering', () => {
  const manyRecords = normalizeSearchCollection(Array.from({ length: 250 }, (_, index) => ({
    ObjectId: index + 1,
    Title: `Sonuç ${String(index + 1).padStart(3, '0')}`,
    Address: `Adres ${index + 1}`,
    Category: index % 2 === 0 ? 'A' : 'B',
    Type: 'Test',
  })));

  it('never renders the entire large collection', () => {
    const runtime = createGenelAramaWindowRuntimeV10(manyRecords, { renderWindowSize: 24 });
    expect(runtime.snapshot().matchedCount).toBe(250);
    expect(runtime.snapshot().visibleItems).toHaveLength(24);
  });

  it('keeps the active result in the visible window', () => {
    const runtime = createGenelAramaWindowRuntimeV10(manyRecords, {
      renderWindowSize: 24,
      renderOverscan: 4,
    });
    const snapshot = runtime.setActiveIndex(150);
    expect(snapshot.activeIndex).toBe(150);
    expect(snapshot.visibleItems.some(item => item.active)).toBe(true);
    expect(snapshot.renderWindow.startIndex).toBeLessThanOrEqual(150);
    expect(snapshot.renderWindow.endIndexExclusive).toBeGreaterThan(150);
  });

  it('moves render window forward', () => {
    const runtime = createGenelAramaWindowRuntimeV10(manyRecords, { renderWindowSize: 24 });
    const before = runtime.snapshot().renderWindow.startIndex;
    const snapshot = runtime.moveWindow('next');
    expect(snapshot.renderWindow.startIndex).toBeGreaterThan(before);
    expect(snapshot.renderWindow.count).toBe(24);
  });

  it('moves render window backward after forward movement', () => {
    const runtime = createGenelAramaWindowRuntimeV10(manyRecords, { renderWindowSize: 24 });
    runtime.moveWindow('next');
    runtime.moveWindow('next');
    const before = runtime.snapshot().renderWindow.startIndex;
    const snapshot = runtime.moveWindow('previous');
    expect(snapshot.renderWindow.startIndex).toBeLessThan(before);
  });

  it('does not move before the beginning', () => {
    const runtime = createGenelAramaWindowRuntimeV10(manyRecords, { renderWindowSize: 24 });
    expect(runtime.moveWindow('previous').renderWindow.startIndex).toBe(0);
  });

  it('does not move past the final window', () => {
    const runtime = createGenelAramaWindowRuntimeV10(manyRecords, { renderWindowSize: 24 });
    for (let index = 0; index < 30; index += 1) runtime.moveWindow('next');
    const window = runtime.snapshot().renderWindow;
    expect(window.endIndexExclusive).toBe(250);
    expect(window.hasAfter).toBe(false);
  });

  it('tracks window movement diagnostics', () => {
    const runtime = createGenelAramaWindowRuntimeV10(manyRecords, { renderWindowSize: 24 });
    const before = runtime.diagnostics().windowMoves;
    runtime.moveWindow('next');
    runtime.moveWindow('next');
    expect(runtime.diagnostics().windowMoves).toBe(before + 2);
  });
});

describe('GenelAramaWindowRuntimeV10 snapshot semantics', () => {
  it('builds facets into every snapshot', () => {
    const snapshot = createRuntime().snapshot();
    expect(snapshot.facets.map(facet => facet.kind)).toEqual(['category', 'type']);
  });

  it('builds highlight segments into visible items', () => {
    const runtime = createRuntime();
    const snapshot = runtime.setRefinement('park');
    expect(snapshot.visibleItems[0]?.titleSegments.some(segment => segment.matched)).toBe(true);
  });

  it('updates announcement after active movement', () => {
    const runtime = createRuntime();
    const first = runtime.snapshot().announcement;
    const second = runtime.moveActive('next').announcement;
    expect(second).not.toBe(first);
    expect(second).toContain('2. sonuç seçili');
  });

  it('updates guidance after narrowing results', () => {
    const runtime = createRuntime();
    expect(runtime.setRefinement('park').guidance.title).toBe('Sonuçlar daraltıldı');
  });

  it('updates guidance for conflicting local filters', () => {
    const runtime = createRuntime();
    runtime.toggleFacet('category', 'Park');
    const snapshot = runtime.toggleFacet('type', 'Kültür');
    expect(snapshot.guidance.title).toBe('Yerel filtrelerle eşleşen sonuç yok');
  });

  it('changes snapshot fingerprint after meaningful state changes', () => {
    const runtime = createRuntime();
    const first = runtime.snapshot().fingerprint;
    const second = runtime.setRefinement('park').fingerprint;
    expect(second).not.toBe(first);
  });

  it('keeps fingerprint stable for no-op state changes', () => {
    const runtime = createRuntime();
    runtime.setRefinement('park');
    const first = runtime.snapshot().fingerprint;
    const second = runtime.setRefinement('park').fingerprint;
    expect(second).toBe(first);
  });

  it('resets the entire local view while preserving records', () => {
    const runtime = createRuntime();
    runtime.setRefinement('park');
    runtime.toggleFacet('category', 'Park');
    runtime.setSortMode('title');
    runtime.setActiveIndex(2);
    const snapshot = runtime.resetView();
    expect(snapshot.refinement).toBe('');
    expect(snapshot.selectedCategories).toEqual([]);
    expect(snapshot.selectedTypes).toEqual([]);
    expect(snapshot.sortMode).toBe('relevance');
    expect(snapshot.totalCount).toBe(records.length);
    expect(snapshot.activeIndex).toBe(0);
  });
});

describe('GenelAramaWindowRuntimeV10 scale and integrity', () => {
  it('handles 10,000 records with a bounded visible window', () => {
    const large = normalizeSearchCollection(Array.from({ length: 10_000 }, (_, index) => ({
      ObjectId: index + 1,
      Title: `Ankara Kayıt ${index + 1}`,
      Address: index % 2 === 0 ? 'Çankaya' : 'Altındağ',
      Category: `Kategori ${index % 20}`,
      Type: `Tür ${index % 7}`,
    })));
    const runtime = createGenelAramaWindowRuntimeV10(large, {
      maxRecords: 20_000,
      renderWindowSize: 40,
      maxFacetBuckets: 12,
    });
    expect(runtime.snapshot().totalCount).toBe(10_000);
    expect(runtime.snapshot().visibleItems).toHaveLength(40);
    expect(runtime.snapshot().facets[0]?.buckets.length).toBeLessThanOrEqual(12);
  });

  it('filters a large collection without expanding the render window', () => {
    const large = normalizeSearchCollection(Array.from({ length: 5_000 }, (_, index) => ({
      ObjectId: index + 1,
      Title: index % 10 === 0 ? `Özel Park ${index}` : `Kayıt ${index}`,
      Category: index % 2 === 0 ? 'Park' : 'Diğer',
    })));
    const runtime = createGenelAramaWindowRuntimeV10(large, { renderWindowSize: 30 });
    const snapshot = runtime.setRefinement('özel park');
    expect(snapshot.matchedCount).toBe(500);
    expect(snapshot.visibleItems).toHaveLength(30);
  });

  it('keeps facet counts deterministic over large datasets', () => {
    const large = normalizeSearchCollection(Array.from({ length: 3_000 }, (_, index) => ({
      ObjectId: index + 1,
      Title: `Kayıt ${index}`,
      Category: index % 3 === 0 ? 'A' : index % 3 === 1 ? 'B' : 'C',
    })));
    const runtime = createGenelAramaWindowRuntimeV10(large, { maxFacetBuckets: 10 });
    const category = runtime.snapshot().facets.find(facet => facet.kind === 'category');
    expect(category?.buckets.map(bucket => [bucket.value, bucket.count])).toEqual([
      ['A', 1000],
      ['B', 1000],
      ['C', 1000],
    ]);
  });

  it('does not expose duplicate React identities for duplicate IDs', () => {
    const duplicate = normalizeSearchCollection(Array.from({ length: 20 }, (_, index) => ({
      ObjectId: 1,
      Title: `Aynı kimlik ${index}`,
    })));
    const runtime = createGenelAramaWindowRuntimeV10(duplicate);
    const identities = runtime.snapshot().items.map(item => item.identity);
    expect(new Set(identities).size).toBe(identities.length);
    expect(runtime.diagnostics().duplicateIdentities).toBe(19);
  });

  it('keeps selected facet count bounded under repeated toggles', () => {
    const categories = normalizeSearchCollection(Array.from({ length: 20 }, (_, index) => ({
      ObjectId: index,
      Title: `Kayıt ${index}`,
      Category: `Kategori ${index}`,
    })));
    const runtime = createGenelAramaWindowRuntimeV10(categories, { maxSelectedFacets: 4 });
    for (let index = 0; index < 20; index += 1) {
      runtime.toggleFacet('category', `Kategori ${index}`);
    }
    expect(runtime.snapshot().selectedCategories.length).toBeLessThanOrEqual(4);
  });

  it('produces deterministic diagnostics fingerprint for equivalent final state', () => {
    const first = createRuntime();
    const second = createRuntime();
    first.setRefinement('park');
    second.setRefinement('park');
    expect(first.snapshot().fingerprint).toBe(second.snapshot().fingerprint);
  });
});
