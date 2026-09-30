import { describe, expect, it } from 'vitest';
import type { NormalizedRecord, SearchFilter } from './contracts';
import { normalizeRecordCollection } from './normalization';
import { DataSearchQueryEngineV6 } from './dataSearchQueryEngineV6';
import { RelevanceCursorRuntime, createRelevanceCursor, parseRelevanceCursor } from './relevanceCursorRuntime';
import { RelevanceIndexRuntime } from './relevanceIndexRuntime';
import { analyzeTextQuery } from './textQueryAnalysisRuntime';

const records = (): readonly NormalizedRecord[] => normalizeRecordCollection([
  { id: 1, name: 'Çankaya Atatürk Parkı', category: 'Park', type: 'Kent Parkı', district: 'Çankaya', neighborhood: 'Kızılay', street: 'Atatürk Bulvarı', postalCode: '06420' },
  { id: 2, name: 'Bahçelievler Çocuk Parkı', category: 'Park', type: 'Çocuk Parkı', district: 'Çankaya', neighborhood: 'Bahçelievler', street: 'Aşkabat Caddesi', postalCode: '06490' },
  { id: 3, name: 'Ulus Kültür Merkezi', category: 'Kültür', type: 'Kültür Merkezi', district: 'Altındağ', neighborhood: 'Ulus', street: 'Anafartalar Caddesi', postalCode: '06050' },
  { id: 4, name: 'Çankaya Kültür Merkezi', category: 'Kültür', type: 'Kültür Merkezi', district: 'Çankaya', neighborhood: 'Yıldız', street: 'Turan Güneş Bulvarı', postalCode: '06550' },
  { id: 5, name: 'Etlik Şehir Hastanesi', category: 'Sağlık', type: 'Hastane', district: 'Keçiören', neighborhood: 'Etlik', street: 'Halil Sezai Erkut Caddesi', postalCode: '06010' },
  { id: 6, name: 'Kızılay Sağlık Merkezi', category: 'Sağlık', type: 'Sağlık Merkezi', district: 'Çankaya', neighborhood: 'Kızılay', street: 'Ziya Gökalp Caddesi', postalCode: '06420' },
  { id: 7, name: 'Mamak Kültür Merkezi', category: 'Kültür', type: 'Kültür Merkezi', district: 'Mamak', neighborhood: 'Akdere', street: 'Mehmet Ali Altun Caddesi', postalCode: '06630' },
  { id: 8, name: 'Keçiören Kalaba Parkı', category: 'Park', type: 'Kent Parkı', district: 'Keçiören', neighborhood: 'Kalaba', street: 'Fatih Caddesi', postalCode: '06120' },
  { id: 9, name: 'Altındağ Gençlik Merkezi', category: 'Sosyal', type: 'Gençlik Merkezi', district: 'Altındağ', neighborhood: 'Örnek', street: 'Babür Caddesi', postalCode: '06080' },
  { id: 10, name: 'Çankaya Belediye Hizmet Noktası', category: 'Belediye', type: 'Hizmet Noktası', district: 'Çankaya', neighborhood: 'Ayrancı', street: 'Hoşdere Caddesi', postalCode: '06540' },
]).records;

const districtFilter = (district: string): SearchFilter => Object.freeze({
  field: 'district',
  operator: 'eq',
  values: Object.freeze([district]),
});

const categoryFilter = (categoryKey: string): SearchFilter => Object.freeze({
  field: 'categoryKey',
  operator: 'eq',
  values: Object.freeze([categoryKey]),
});

describe('DataSearchQueryEngineV6 production execution', () => {
  it('searches normalized records with deterministic relevance', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const result = engine.search({ query: 'Çankaya park' });
    expect(result.hits[0]?.record.title).toBe('Çankaya Atatürk Parkı');
    expect(result.diagnostics.blocked).toBe(false);
  });

  it('applies indexed district filters before reranking', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const result = engine.search({ query: 'merkezi', filters: [districtFilter('Çankaya')] });
    expect(result.hits.map((hit) => hit.record.title)).toEqual([
      'Çankaya Kültür Merkezi',
      'Kızılay Sağlık Merkezi',
    ]);
    expect(result.diagnostics.filterPlan.indexedFilterCount).toBe(1);
    expect(result.diagnostics.filterCandidates).toBe(5);
  });

  it('supports canonical categoryKey filtering', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const result = engine.search({ query: 'park', filters: [categoryFilter('park')] });
    expect(result.hits.every((hit) => hit.record.categoryKey === 'park')).toBe(true);
  });

  it('applies residual operators after index planning', () => {
    const contains: SearchFilter = Object.freeze({ field: 'title', operator: 'contains', values: Object.freeze(['kültür']) });
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const result = engine.search({ query: 'merkezi', filters: [contains] });
    expect(result.hits.every((hit) => hit.record.title.toLocaleLowerCase('tr-TR').includes('kültür'))).toBe(true);
    expect(result.diagnostics.filterPlan.residualFilterCount).toBe(1);
  });

  it('intersects indexed filters', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const result = engine.search({
      query: 'park',
      filters: [districtFilter('Çankaya'), categoryFilter('park')],
    });
    expect(result.hits.map((hit) => hit.record.title)).toEqual([
      'Çankaya Atatürk Parkı',
      'Bahçelievler Çocuk Parkı',
    ]);
    expect(result.diagnostics.filterPlan.strategy).toBe('indexed-intersection');
  });

  it('fails closed when rerank budget would be exceeded', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1', { maximumRerankDocuments: 2 });
    const result = engine.search({ query: 'merkezi' });
    expect(result.diagnostics.blocked).toBe(false);
    const filtered = engine.search({ query: 'merkezi', filters: [districtFilter('Çankaya')] });
    expect(filtered.diagnostics.blocked).toBe(true);
    expect(filtered.diagnostics.blockReason).toBe('rerank-budget-exceeded');
    expect(filtered.hits).toHaveLength(0);
  });

  it('keeps unfiltered searches on the prebuilt global relevance index', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1', { maximumRerankDocuments: 2 });
    const result = engine.search({ query: 'merkezi' });
    expect(result.hits.length).toBeGreaterThan(2);
    expect(result.diagnostics.rerankDocuments).toBe(10);
  });

  it('returns facet counts over the filtered corpus', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const result = engine.search({ query: 'merkezi', filters: [districtFilter('Çankaya')], includeFacets: true });
    expect(result.facets?.totalDocuments).toBe(5);
    expect(result.facets?.fields.district.buckets[0]?.label).toBe('Çankaya');
    expect(result.facets?.fields.district.buckets[0]?.count).toBe(5);
  });

  it('can disable facet aggregation per request', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const result = engine.search({ query: 'park', includeFacets: false });
    expect(result.facets).toBeNull();
  });

  it('marks explicit facet selection', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const result = engine.search({ query: 'merkezi', facetSelection: { category: ['Kültür'] } });
    expect(result.facets?.fields.category.buckets.find((bucket) => bucket.label === 'Kültür')?.selected).toBe(true);
  });

  it('pages ranked results with stable offsets', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const first = engine.search({ query: 'merkezi', limit: 2 });
    const second = engine.search({ query: 'merkezi', offset: 2, limit: 2 });
    expect(first.hits).toHaveLength(2);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextOffset).toBe(2);
    expect(second.hits[0]?.record.fingerprint).not.toBe(first.hits[0]?.record.fingerprint);
  });

  it('bounds requested page size', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1', { maximumLimit: 2, defaultLimit: 2 });
    const result = engine.search({ query: 'merkezi', limit: 999 });
    expect(result.page.limit).toBe(2);
    expect(result.hits.length).toBeLessThanOrEqual(2);
  });

  it('creates deterministic request fingerprints', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const left = engine.search({ query: 'ÇANKAYA park', filters: [districtFilter('Çankaya')] });
    const right = engine.search({ query: 'çankaya PARK', filters: [districtFilter('Çankaya')] });
    expect(left.diagnostics.fingerprint).toBe(right.diagnostics.fingerprint);
  });

  it('binds request diagnostics to dataset revision', () => {
    const left = new DataSearchQueryEngineV6(records(), 'rev-1').search({ query: 'park' });
    const right = new DataSearchQueryEngineV6(records(), 'rev-2').search({ query: 'park' });
    expect(left.diagnostics.datasetRevision).toBe('rev-1');
    expect(right.diagnostics.datasetRevision).toBe('rev-2');
    expect(left.diagnostics.fingerprint).not.toBe(right.diagnostics.fingerprint);
  });

  it('exposes suggestion runtime through one authority', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const result = engine.suggest('kızı');
    expect(result.suggestions.some((suggestion) => suggestion.value.includes('Kızılay'))).toBe(true);
  });

  it('tracks query lifecycle counters', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1', { maximumRerankDocuments: 2 });
    engine.search({ query: 'park' });
    engine.search({ query: 'park', filters: [districtFilter('Çankaya')] });
    const snapshot = engine.snapshot();
    expect(snapshot.version).toBe(6);
    expect(snapshot.recordCount).toBe(10);
    expect(snapshot.queries).toBe(2);
    expect(snapshot.filteredQueries).toBe(1);
    expect(snapshot.blockedQueries).toBe(1);
    expect(snapshot.relevanceDistinctTerms).toBeGreaterThan(0);
    expect(snapshot.suggestionTerms).toBeGreaterThan(0);
  });

  it('rejects corpus above configured capacity', () => {
    expect(() => new DataSearchQueryEngineV6(records(), 'rev', { maximumRecords: 5 })).toThrow(/maximumRecords/);
  });

  it('does not introduce a network dependency to answer local queries', () => {
    const engine = new DataSearchQueryEngineV6(records(), 'rev-1');
    const result = engine.search({ query: 'hastane' });
    expect(result.hits[0]?.record.title).toBe('Etlik Şehir Hastanesi');
  });
});

describe('RelevanceCursorRuntime v6', () => {
  const rankedHits = () => new RelevanceIndexRuntime(records(), 'rev-1').search(analyzeTextQuery('merkezi'), 50).hits;
  const identity = Object.freeze({ datasetRevision: 'rev-1', querySignature: analyzeTextQuery('merkezi').signature, filterFingerprint: 'filters-none' });

  it('creates and parses a checksummed cursor', () => {
    const hit = rankedHits()[0];
    expect(hit).toBeDefined();
    if (!hit) return;
    const cursor = createRelevanceCursor(hit, identity);
    const parsed = parseRelevanceCursor(cursor);
    expect(parsed?.datasetRevision).toBe('rev-1');
    expect(parsed?.fingerprint).toBe(hit.record.fingerprint);
    expect(parsed?.score).toBe(hit.score);
  });

  it('pages after the exact last hit', () => {
    const hits = rankedHits();
    const runtime = new RelevanceCursorRuntime();
    const first = runtime.page(hits, identity, null, 2);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = runtime.page(hits, identity, first.nextCursor, 2);
    expect(second.items[0]?.record.fingerprint).toBe(hits[2]?.record.fingerprint);
  });

  it('does not duplicate items across adjacent pages', () => {
    const hits = rankedHits();
    const runtime = new RelevanceCursorRuntime();
    const first = runtime.page(hits, identity, null, 2);
    const second = runtime.page(hits, identity, first.nextCursor, 2);
    const firstIds = new Set(first.items.map((hit) => hit.record.fingerprint));
    expect(second.items.some((hit) => firstIds.has(hit.record.fingerprint))).toBe(false);
  });

  it('rejects stale dataset revision cursors', () => {
    const hits = rankedHits();
    const runtime = new RelevanceCursorRuntime();
    const first = runtime.page(hits, identity, null, 2);
    const stale = runtime.page(hits, { ...identity, datasetRevision: 'rev-2' }, first.nextCursor, 2);
    expect(stale.staleCursor).toBe(true);
    expect(stale.items).toHaveLength(0);
  });

  it('rejects stale query-signature cursors', () => {
    const hits = rankedHits();
    const runtime = new RelevanceCursorRuntime();
    const first = runtime.page(hits, identity, null, 2);
    const stale = runtime.page(hits, { ...identity, querySignature: 'different' }, first.nextCursor, 2);
    expect(stale.staleCursor).toBe(true);
  });

  it('rejects stale filter cursors', () => {
    const hits = rankedHits();
    const runtime = new RelevanceCursorRuntime();
    const first = runtime.page(hits, identity, null, 2);
    const stale = runtime.page(hits, { ...identity, filterFingerprint: 'different' }, first.nextCursor, 2);
    expect(stale.staleCursor).toBe(true);
  });

  it('rejects tampered cursor payloads', () => {
    const hits = rankedHits();
    const runtime = new RelevanceCursorRuntime();
    const first = runtime.page(hits, identity, null, 2);
    expect(first.nextCursor).not.toBeNull();
    const tampered = `${first.nextCursor ?? ''}tamper`;
    const page = runtime.page(hits, identity, tampered, 2);
    expect(page.invalidCursor).toBe(true);
    expect(page.items).toHaveLength(0);
  });

  it('rejects unknown cursor versions', () => {
    const runtime = new RelevanceCursorRuntime();
    const page = runtime.page(rankedHits(), identity, 'rk2.abc', 2);
    expect(page.invalidCursor).toBe(true);
  });

  it('rejects cursors over configured length', () => {
    const runtime = new RelevanceCursorRuntime({ maximumCursorLength: 128 });
    const page = runtime.page(rankedHits(), identity, `rk1.${'x'.repeat(500)}`, 2);
    expect(page.invalidCursor).toBe(true);
  });

  it('bounds page size', () => {
    const runtime = new RelevanceCursorRuntime({ maximumPageSize: 2 });
    const page = runtime.page(rankedHits(), identity, null, 999);
    expect(page.pageSize).toBe(2);
    expect(page.items.length).toBeLessThanOrEqual(2);
  });

  it('returns no next cursor at the end', () => {
    const hits = rankedHits();
    const runtime = new RelevanceCursorRuntime();
    const page = runtime.page(hits, identity, null, 100);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('keeps cursor parsing fail-closed for malformed JSON', () => {
    expect(parseRelevanceCursor('rk1.%7Bbroken')).toBeNull();
  });

  it('keeps cursor parsing fail-closed for blank input', () => {
    expect(parseRelevanceCursor('')).toBeNull();
  });

  it('binds cursors to stable tie-break fields', () => {
    const hit = rankedHits()[0];
    expect(hit).toBeDefined();
    if (!hit) return;
    const parsed = parseRelevanceCursor(createRelevanceCursor(hit, identity));
    expect(parsed?.title).toBe(hit.record.title);
    expect(parsed?.sourceIndex).toBe(hit.record.sourceIndex);
    expect(parsed?.fingerprint).toBe(hit.record.fingerprint);
  });
});
