import { describe, expect, it } from 'vitest';
import type { NormalizedRecord } from './contracts';
import { normalizeRecordCollection } from './normalization';
import { FacetAggregationRuntime, facetSelectionFingerprint } from './facetAggregationRuntime';
import { RelevanceIndexRuntime } from './relevanceIndexRuntime';
import { SearchSuggestionRuntime, createSuggestionKey } from './searchSuggestionRuntime';
import { analyzeTextQuery } from './textQueryAnalysisRuntime';

const records = (): readonly NormalizedRecord[] => normalizeRecordCollection([
  {
    id: 'park-1',
    name: 'Çankaya Atatürk Parkı',
    category: 'Park ve Yeşil Alan',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    postalCode: '06420',
  },
  {
    id: 'park-2',
    name: 'Bahçelievler Çocuk Parkı',
    category: 'Park ve Yeşil Alan',
    type: 'Çocuk Parkı',
    district: 'Çankaya',
    neighborhood: 'Bahçelievler',
    street: 'Aşkabat Caddesi',
    postalCode: '06490',
  },
  {
    id: 'culture-1',
    name: 'Ulus Kültür Merkezi',
    category: 'Kültür Sanat',
    type: 'Kültür Merkezi',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    postalCode: '06050',
  },
  {
    id: 'culture-2',
    name: 'Çankaya Kültür Merkezi',
    category: 'Kültür Sanat',
    type: 'Kültür Merkezi',
    district: 'Çankaya',
    neighborhood: 'Yıldız',
    street: 'Turan Güneş Bulvarı',
    postalCode: '06550',
  },
  {
    id: 'health-1',
    name: 'Etlik Şehir Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Keçiören',
    neighborhood: 'Etlik',
    street: 'Halil Sezai Erkut Caddesi',
    postalCode: '06010',
  },
  {
    id: 'health-2',
    name: 'Kızılay Sağlık Merkezi',
    category: 'Sağlık',
    type: 'Sağlık Merkezi',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Ziya Gökalp Caddesi',
    postalCode: '06420',
  },
  {
    id: 'missing-1',
    name: 'İsimsiz Hizmet Noktası',
    category: '',
    type: '',
    district: 'Mamak',
    neighborhood: '',
    street: '',
    postalCode: '',
  },
]).records;

describe('FacetAggregationRuntime v6', () => {
  it('aggregates deterministic category buckets', () => {
    const runtime = new FacetAggregationRuntime();
    const result = runtime.aggregateRecords(records());
    expect(result.fields.category.buckets.map((bucket) => [bucket.label, bucket.count])).toEqual([
      ['Kültür Sanat', 2],
      ['Park ve Yeşil Alan', 2],
      ['Sağlık', 2],
    ]);
  });

  it('aggregates district buckets by count then Turkish label order', () => {
    const runtime = new FacetAggregationRuntime();
    const buckets = runtime.aggregateRecords(records()).fields.district.buckets;
    expect(buckets[0]?.label).toBe('Çankaya');
    expect(buckets[0]?.count).toBe(4);
  });

  it('tracks missing category values separately', () => {
    const runtime = new FacetAggregationRuntime();
    expect(runtime.aggregateRecords(records()).fields.category.missingCount).toBe(1);
  });

  it('can expose a missing bucket', () => {
    const runtime = new FacetAggregationRuntime({ includeMissingBucket: true });
    const buckets = runtime.aggregateRecords(records()).fields.category.buckets;
    expect(buckets.some((bucket) => bucket.key === '__missing__' && bucket.count === 1)).toBe(true);
  });

  it('marks selected buckets', () => {
    const runtime = new FacetAggregationRuntime();
    const result = runtime.aggregateRecords(records(), { category: ['sağlık'] });
    const selected = result.fields.category.buckets.find((bucket) => bucket.label === 'Sağlık');
    expect(selected?.selected).toBe(true);
  });

  it('keeps selected values ahead of equally common unselected values', () => {
    const runtime = new FacetAggregationRuntime();
    const result = runtime.aggregateRecords(records(), { category: ['sağlık'] });
    expect(result.fields.category.buckets[0]?.label).toBe('Sağlık');
  });

  it('normalizes selected values Turkish-aware', () => {
    const runtime = new FacetAggregationRuntime();
    const result = runtime.aggregateRecords(records(), { district: ['CANKAYA'] });
    expect(result.fields.district.buckets.find((bucket) => bucket.label === 'Çankaya')?.selected).toBe(true);
  });

  it('bounds buckets per field', () => {
    const runtime = new FacetAggregationRuntime({ maximumBucketsPerField: 1 });
    const result = runtime.aggregateRecords(records());
    expect(result.fields.category.buckets).toHaveLength(1);
    expect(result.fields.category.truncated).toBe(true);
  });

  it('bounds distinct values and records truncation', () => {
    const runtime = new FacetAggregationRuntime({ maximumDistinctValuesPerField: 1 });
    const result = runtime.aggregateRecords(records());
    expect(result.fields.district.distinctCount).toBe(1);
    expect(result.fields.district.truncated).toBe(true);
  });

  it('bounds input documents', () => {
    const runtime = new FacetAggregationRuntime({ maximumDocuments: 3 });
    const result = runtime.aggregateRecords(records());
    expect(result.totalDocuments).toBe(3);
    expect(result.truncatedInput).toBe(true);
  });

  it('enforces minimum bucket count', () => {
    const runtime = new FacetAggregationRuntime({ minimumBucketCount: 2 });
    const result = runtime.aggregateRecords(records());
    expect(result.fields.district.buckets.some((bucket) => bucket.label === 'Mamak')).toBe(false);
  });

  it('computes source-index numeric statistics', () => {
    const runtime = new FacetAggregationRuntime();
    const numeric = runtime.aggregateRecords(records()).numeric;
    expect(numeric.count).toBe(7);
    expect(numeric.minimum).toBe(0);
    expect(numeric.maximum).toBe(6);
    expect(numeric.average).toBe(3);
  });

  it('aggregates relevance hits directly', () => {
    const relevance = new RelevanceIndexRuntime(records(), 'rev');
    const hits = relevance.search(analyzeTextQuery('merkezi'), 20).hits;
    const runtime = new FacetAggregationRuntime();
    const result = runtime.aggregateHits(hits);
    expect(result.totalDocuments).toBe(hits.length);
    expect(result.fields.category.buckets[0]?.label).toBe('Kültür Sanat');
  });

  it('tracks lifecycle counters', () => {
    const runtime = new FacetAggregationRuntime({ maximumDocuments: 2, maximumBucketsPerField: 1 });
    runtime.aggregateRecords(records());
    runtime.aggregateRecords(records());
    const snapshot = runtime.snapshot();
    expect(snapshot.aggregations).toBe(2);
    expect(snapshot.documentsSeen).toBe(4);
    expect(snapshot.truncatedInputs).toBe(2);
    expect(snapshot.truncatedFields).toBeGreaterThan(0);
    runtime.reset();
    expect(runtime.snapshot().aggregations).toBe(0);
  });

  it('creates stable facet selection fingerprints', () => {
    const left = facetSelectionFingerprint({ category: ['Sağlık'], district: ['Çankaya'] });
    const right = facetSelectionFingerprint({ district: ['çankaya'], category: ['SAĞLIK'] });
    expect(left).toBe(right);
  });

  it('changes selection fingerprint when selection changes', () => {
    const left = facetSelectionFingerprint({ category: ['Sağlık'] });
    const right = facetSelectionFingerprint({ category: ['Kültür Sanat'] });
    expect(left).not.toBe(right);
  });
});

describe('SearchSuggestionRuntime v6', () => {
  it('suggests exact Turkish title prefixes', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const result = runtime.suggest('Çank');
    expect(result.suggestions.some((suggestion) => suggestion.value === 'Çankaya Atatürk Parkı')).toBe(true);
  });

  it('normalizes dotted/dotless I in suggestion queries', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const result = runtime.suggest('KIZI');
    expect(result.suggestions.some((suggestion) => suggestion.value.includes('Kızılay'))).toBe(true);
  });

  it('suggests categories', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const result = runtime.suggest('sağ');
    expect(result.suggestions.some((suggestion) => suggestion.kind === 'category' && suggestion.value === 'Sağlık')).toBe(true);
  });

  it('suggests districts', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const result = runtime.suggest('keç');
    expect(result.suggestions.some((suggestion) => suggestion.kind === 'district' && suggestion.value === 'Keçiören')).toBe(true);
  });

  it('suggests neighborhoods', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const result = runtime.suggest('bahç');
    expect(result.suggestions.some((suggestion) => suggestion.kind === 'neighborhood' && suggestion.value === 'Bahçelievler')).toBe(true);
  });

  it('suggests street labels', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const result = runtime.suggest('anaf');
    expect(result.suggestions.some((suggestion) => suggestion.kind === 'street' && suggestion.value === 'Anafartalar Caddesi')).toBe(true);
  });

  it('suggests free terms from search text', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const result = runtime.suggest('bulv');
    expect(result.suggestions.some((suggestion) => suggestion.kind === 'term' && suggestion.value.startsWith('bulv'))).toBe(true);
  });

  it('prefers higher-value label authorities over raw terms on comparable evidence', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const result = runtime.suggest('çankaya', 20);
    const district = result.suggestions.findIndex((suggestion) => suggestion.kind === 'district');
    const rawTerm = result.suggestions.findIndex((suggestion) => suggestion.kind === 'term');
    expect(district).toBeGreaterThanOrEqual(0);
    if (rawTerm >= 0) expect(district).toBeLessThan(rawTerm);
  });

  it('deduplicates visible labels across kinds', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const suggestions = runtime.suggest('kızılay', 20).suggestions;
    const canonical = suggestions.map((suggestion) => suggestion.value.toLocaleLowerCase('tr-TR'));
    expect(new Set(canonical).size).toBe(canonical.length);
  });

  it('bounds suggestion count', () => {
    const runtime = new SearchSuggestionRuntime(records(), { maximumSuggestions: 2 });
    expect(runtime.suggest('k', 2).suggestions.length).toBeLessThanOrEqual(2);
  });

  it('bounds input query length', () => {
    const runtime = new SearchSuggestionRuntime(records(), { maximumPrefixLength: 8 });
    const result = runtime.suggest('çankaya'.repeat(10));
    expect(result.canonicalQuery.length).toBeLessThanOrEqual(8);
  });

  it('honors minimum prefix length', () => {
    const runtime = new SearchSuggestionRuntime(records(), { minimumPrefixLength: 3 });
    expect(runtime.suggest('ça').suggestions).toHaveLength(0);
  });

  it('reports dictionary snapshot', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const snapshot = runtime.snapshot();
    expect(snapshot.recordCount).toBe(7);
    expect(snapshot.termCount).toBeGreaterThan(20);
    expect(snapshot.labelCount).toBeGreaterThan(10);
  });

  it('rejects corpora over configured record capacity', () => {
    expect(() => new SearchSuggestionRuntime(records(), { maximumRecords: 2 })).toThrow(/maximumRecords/);
  });

  it('creates canonical suggestion keys', () => {
    expect(createSuggestionKey('district', 'ÇANKAYA')).toBe('district:cankaya');
  });

  it('keeps output scores finite and positive', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const result = runtime.suggest('park', 20);
    for (const suggestion of result.suggestions) {
      expect(Number.isFinite(suggestion.score)).toBe(true);
      expect(suggestion.score).toBeGreaterThan(0);
    }
  });

  it('keeps query output immutable by construction', () => {
    const runtime = new SearchSuggestionRuntime(records());
    const result = runtime.suggest('çankaya');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.suggestions)).toBe(true);
  });
});
