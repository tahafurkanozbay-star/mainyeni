import { describe, expect, it } from 'vitest';
import { normalizeSearchCollection } from '../_Common/QuerySearchRuntime';
import {
  createGeneralSearchFacetModelV10,
  createGeneralSearchRenderWindowV10,
  highlightGeneralSearchTextV10,
  normalizeGeneralSearchWindowPolicyV10,
  prepareGeneralSearchRecordsV10,
  sortGeneralSearchRecordsV10,
} from './GenelAramaWindowPresentationV10';
import { createGenelAramaWindowRuntimeV10 } from './GenelAramaWindowRuntimeV10';

const noSelection = (): ReadonlySet<string> => new Set<string>();

const buildRecords = (count: number) => normalizeSearchCollection(
  Array.from({ length: count }, (_, index) => ({
    ObjectId: index + 1,
    Title: `Kayıt ${String(index + 1).padStart(5, '0')}`,
    Address: `${index % 2 === 0 ? 'Çankaya' : 'Altındağ'} Ankara`,
    Category: `Kategori ${index % 25}`,
    Type: `Tür ${index % 9}`,
    Phone: `0312${String(index).padStart(7, '0')}`,
  })),
);

describe('GenelAramaWindowV10 adversarial input normalization', () => {
  it('accepts records with missing optional fields', () => {
    const records = normalizeSearchCollection([
      { ObjectId: 1, Title: 'Yalın kayıt' },
      { ObjectId: 2, Category: 'Kategori' },
      { ObjectId: 3, Address: 'Ankara' },
    ]);
    const runtime = createGenelAramaWindowRuntimeV10(records);
    expect(runtime.snapshot().totalCount).toBe(3);
    expect(runtime.snapshot().items.every(item => item.record.title.length > 0)).toBe(true);
  });

  it('normalizes control characters out of local refinement through canonical search text', () => {
    const records = normalizeSearchCollection([{ ObjectId: 1, Title: 'Ankara Müzesi' }]);
    const runtime = createGenelAramaWindowRuntimeV10(records);
    expect(runtime.setRefinement('Ankara\u0000 Müzesi').matchedCount).toBe(1);
  });

  it('bounds extremely long refinement text', () => {
    const runtime = createGenelAramaWindowRuntimeV10(buildRecords(10), { maxRefinementLength: 32 });
    expect(runtime.setRefinement('x'.repeat(10_000)).refinement).toHaveLength(32);
  });

  it('keeps emoji and punctuation safe in display text', () => {
    const records = normalizeSearchCollection([{
      ObjectId: 1,
      Title: 'Park 🌳 / Çocuk-Alanı',
      Address: '100. Yıl',
    }]);
    const runtime = createGenelAramaWindowRuntimeV10(records);
    expect(runtime.snapshot().activeRecord?.title).toBe('Park 🌳 / Çocuk-Alanı');
    expect(runtime.setRefinement('cocuk alani').matchedCount).toBe(1);
  });

  it('handles non-Latin display text without throwing', () => {
    const records = normalizeSearchCollection([
      { ObjectId: 1, Title: 'Анкара' },
      { ObjectId: 2, Title: 'Ankara' },
    ]);
    const runtime = createGenelAramaWindowRuntimeV10(records);
    expect(runtime.snapshot().totalCount).toBe(2);
  });

  it('does not create facet buckets for empty type values', () => {
    const records = normalizeSearchCollection([
      { ObjectId: 1, Title: 'A', Category: 'X' },
      { ObjectId: 2, Title: 'B', Category: 'Y' },
    ]);
    const policy = normalizeGeneralSearchWindowPolicyV10();
    const prepared = prepareGeneralSearchRecordsV10(records, policy);
    const facet = createGeneralSearchFacetModelV10(
      prepared.records,
      '',
      'type',
      noSelection(),
      noSelection(),
      policy,
    );
    expect(facet.buckets).toEqual([]);
  });

  it('preserves a user-visible fallback category from normalization', () => {
    const records = normalizeSearchCollection([{ ObjectId: 1, Title: 'A' }]);
    expect(records[0]?.category).toBe('Diğer');
    expect(createGenelAramaWindowRuntimeV10(records).snapshot().facets[0]?.buckets[0]?.value).toBe('Diğer');
  });
});

describe('GenelAramaWindowV10 duplicate and identity integrity', () => {
  it('makes hundreds of duplicate IDs unique in presentation identity', () => {
    const records = normalizeSearchCollection(Array.from({ length: 500 }, (_, index) => ({
      ObjectId: 7,
      Title: `Tekrarlı ${index}`,
    })));
    const runtime = createGenelAramaWindowRuntimeV10(records, { renderWindowSize: 20 });
    const identities = runtime.snapshot().items.map(item => item.identity);
    expect(new Set(identities).size).toBe(500);
    expect(runtime.diagnostics().duplicateIdentities).toBe(499);
  });

  it('preserves stable duplicate identities across equivalent replacement', () => {
    const records = normalizeSearchCollection([
      { ObjectId: 1, Title: 'A' },
      { ObjectId: 1, Title: 'B' },
      { ObjectId: 1, Title: 'C' },
    ]);
    const runtime = createGenelAramaWindowRuntimeV10(records);
    const first = runtime.snapshot().items.map(item => item.identity);
    const second = runtime.replaceRecords(records).items.map(item => item.identity);
    expect(second).toEqual(first);
  });

  it('preserves active duplicate identity when replacement ordering is unchanged', () => {
    const records = normalizeSearchCollection([
      { ObjectId: 1, Title: 'A' },
      { ObjectId: 1, Title: 'B' },
      { ObjectId: 1, Title: 'C' },
    ]);
    const runtime = createGenelAramaWindowRuntimeV10(records);
    runtime.setActiveIndex(1);
    const identity = runtime.activeIdentity();
    runtime.replaceRecords(records);
    expect(runtime.activeIdentity()).toBe(identity);
  });
});

describe('GenelAramaWindowV10 facet explosion boundaries', () => {
  it('bounds a 1,000-category vocabulary to configured visible buckets', () => {
    const records = normalizeSearchCollection(Array.from({ length: 1_000 }, (_, index) => ({
      ObjectId: index,
      Title: `Kayıt ${index}`,
      Category: `Kategori ${index}`,
    })));
    const runtime = createGenelAramaWindowRuntimeV10(records, { maxFacetBuckets: 15 });
    const category = runtime.snapshot().facets.find(facet => facet.kind === 'category');
    expect(category?.buckets).toHaveLength(15);
    expect(category?.totalBuckets).toBe(1_000);
    expect(category?.truncated).toBe(true);
  });

  it('keeps selected facet visible ahead of more frequent buckets', () => {
    const records = normalizeSearchCollection([
      ...Array.from({ length: 100 }, (_, index) => ({ ObjectId: index, Title: `A ${index}`, Category: 'A' })),
      { ObjectId: 1000, Title: 'Nadir', Category: 'Nadir' },
    ]);
    const runtime = createGenelAramaWindowRuntimeV10(records, { maxFacetBuckets: 1 });
    runtime.toggleFacet('category', 'Nadir');
    const category = runtime.snapshot().facets.find(facet => facet.kind === 'category');
    expect(category?.buckets[0]).toMatchObject({ value: 'Nadir', selected: true });
  });

  it('does not exceed selected-facet policy under repeated categories and types', () => {
    const records = buildRecords(1_000);
    const runtime = createGenelAramaWindowRuntimeV10(records, { maxSelectedFacets: 5 });
    for (let index = 0; index < 20; index += 1) runtime.toggleFacet('category', `Kategori ${index}`);
    for (let index = 0; index < 9; index += 1) runtime.toggleFacet('type', `Tür ${index}`);
    expect(runtime.snapshot().selectedCategories.length + runtime.snapshot().selectedTypes.length)
      .toBeLessThanOrEqual(5);
  });
});

describe('GenelAramaWindowV10 render-window scale', () => {
  it('keeps a 50K result collection at the configured DOM-sized window', () => {
    const records = buildRecords(50_000);
    const runtime = createGenelAramaWindowRuntimeV10(records, {
      maxRecords: 50_000,
      renderWindowSize: 48,
      renderOverscan: 8,
    });
    expect(runtime.snapshot().matchedCount).toBe(50_000);
    expect(runtime.snapshot().visibleItems).toHaveLength(48);
  });

  it('moves directly near the end without expanding visible item count', () => {
    const records = buildRecords(5_000);
    const runtime = createGenelAramaWindowRuntimeV10(records, { renderWindowSize: 32 });
    const snapshot = runtime.setActiveIndex(4_900);
    expect(snapshot.activeIndex).toBe(4_900);
    expect(snapshot.visibleItems).toHaveLength(32);
    expect(snapshot.renderWindow.endIndexExclusive).toBeGreaterThan(4_900);
  });

  it('keeps first result visible after Home-equivalent move', () => {
    const runtime = createGenelAramaWindowRuntimeV10(buildRecords(1_000), { renderWindowSize: 24 });
    runtime.setActiveIndex(900);
    const snapshot = runtime.moveActive('first');
    expect(snapshot.activeIndex).toBe(0);
    expect(snapshot.renderWindow.startIndex).toBe(0);
  });

  it('keeps last result visible after End-equivalent move', () => {
    const runtime = createGenelAramaWindowRuntimeV10(buildRecords(1_000), { renderWindowSize: 24 });
    const snapshot = runtime.moveActive('last');
    expect(snapshot.activeIndex).toBe(999);
    expect(snapshot.renderWindow.endIndexExclusive).toBe(1_000);
  });

  it('supports many page moves without leaving collection bounds', () => {
    const runtime = createGenelAramaWindowRuntimeV10(buildRecords(1_000), {
      renderWindowSize: 24,
      keyboardPageSize: 10,
    });
    for (let index = 0; index < 200; index += 1) runtime.moveActive('page-next');
    expect(runtime.snapshot().activeIndex).toBe(999);
    for (let index = 0; index < 200; index += 1) runtime.moveActive('page-previous');
    expect(runtime.snapshot().activeIndex).toBe(0);
  });

  it('bounds render-window helper for massive abstract totals', () => {
    const policy = normalizeGeneralSearchWindowPolicyV10({ renderWindowSize: 40, renderOverscan: 5 });
    const window = createGeneralSearchRenderWindowV10(1_000_000, 999_999, null, policy);
    expect(window.count).toBe(40);
    expect(window.endIndexExclusive).toBe(1_000_000);
    expect(window.startIndex).toBe(999_960);
  });
});

describe('GenelAramaWindowV10 deterministic ordering', () => {
  it('uses source order as deterministic relevance tie-break', () => {
    const records = normalizeSearchCollection(Array.from({ length: 100 }, (_, index) => ({
      ObjectId: index,
      Title: 'Aynı Başlık',
      Address: 'Aynı Adres',
      Category: 'Aynı Kategori',
    })));
    const policy = normalizeGeneralSearchWindowPolicyV10();
    const prepared = prepareGeneralSearchRecordsV10(records, policy);
    expect(sortGeneralSearchRecordsV10(prepared.records, 'aynı', 'relevance').map(item => item.sourceIndex))
      .toEqual(Array.from({ length: 100 }, (_, index) => index));
  });

  it('produces the same snapshot fingerprint for independent equivalent runtimes', () => {
    const records = buildRecords(500);
    const first = createGenelAramaWindowRuntimeV10(records, { renderWindowSize: 30 });
    const second = createGenelAramaWindowRuntimeV10(records, { renderWindowSize: 30 });
    first.setRefinement('ankara');
    second.setRefinement('ankara');
    first.toggleFacet('category', 'Kategori 1');
    second.toggleFacet('category', 'Kategori 1');
    first.setSortMode('title');
    second.setSortMode('title');
    expect(first.snapshot().fingerprint).toBe(second.snapshot().fingerprint);
  });

  it('changes fingerprint when source facts change', () => {
    const firstRecords = normalizeSearchCollection([{ ObjectId: 1, Title: 'A' }]);
    const secondRecords = normalizeSearchCollection([{ ObjectId: 1, Title: 'B' }]);
    expect(createGenelAramaWindowRuntimeV10(firstRecords).snapshot().fingerprint)
      .not.toBe(createGenelAramaWindowRuntimeV10(secondRecords).snapshot().fingerprint);
  });
});

describe('GenelAramaWindowV10 highlighting adversarial cases', () => {
  it('handles overlapping terms without duplicate text loss', () => {
    const source = 'Ankara Ankara';
    const segments = highlightGeneralSearchTextV10(source, 'ank ankara', 20);
    expect(segments.map(segment => segment.text).join('')).toBe(source);
  });

  it('does not exceed segment budget under repeated matches', () => {
    const segments = highlightGeneralSearchTextV10('a'.repeat(1_000), 'a', 12);
    expect(segments.length).toBeLessThanOrEqual(12);
  });

  it('preserves source text exactly after segmentation', () => {
    const source = 'Çankaya / Kültür – Ankara';
    const segments = highlightGeneralSearchTextV10(source, 'cankaya kultur', 32);
    expect(segments.map(segment => segment.text).join('')).toBe(source);
  });
});

describe('GenelAramaWindowV10 state recovery', () => {
  it('clearFilters is idempotent when nothing is selected', () => {
    const runtime = createGenelAramaWindowRuntimeV10(buildRecords(20));
    const first = runtime.snapshot().fingerprint;
    expect(runtime.clearFilters().fingerprint).toBe(first);
  });

  it('resetView returns to first result and relevance mode', () => {
    const runtime = createGenelAramaWindowRuntimeV10(buildRecords(100));
    runtime.setRefinement('ankara');
    runtime.toggleFacet('category', 'Kategori 3');
    runtime.setSortMode('title');
    runtime.setActiveIndex(2);
    const snapshot = runtime.resetView();
    expect(snapshot.refinement).toBe('');
    expect(snapshot.selectedCategories).toEqual([]);
    expect(snapshot.selectedTypes).toEqual([]);
    expect(snapshot.sortMode).toBe('relevance');
    expect(snapshot.activeIndex).toBe(0);
  });

  it('replacement after local-empty state recovers an active record', () => {
    const runtime = createGenelAramaWindowRuntimeV10(buildRecords(20));
    runtime.setRefinement('eşleşmez');
    expect(runtime.snapshot().activeRecord).toBeNull();
    runtime.clearFilters();
    expect(runtime.snapshot().activeRecord).not.toBeNull();
  });

  it('replacement with empty records remains safe under navigation calls', () => {
    const runtime = createGenelAramaWindowRuntimeV10(buildRecords(20));
    runtime.replaceRecords([]);
    runtime.moveActive('next');
    runtime.moveWindow('next');
    runtime.setActiveIndex(10);
    expect(runtime.snapshot().activeIndex).toBe(-1);
    expect(runtime.snapshot().visibleItems).toEqual([]);
  });
});
