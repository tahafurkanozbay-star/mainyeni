import { describe, expect, it } from 'vitest';
import type { DatasetSnapshot, SearchFilter } from './contracts';
import { createDataSearchRuntime } from './searchRuntime';
import {
  DataSearchExecutionRuntimeV7,
  createDataSearchExecutionRuntimeV7,
} from './dataSearchExecutionRuntimeV7';

const sourceRecords = () => [
  {
    id: 1,
    name: 'Çankaya Atatürk Parkı',
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    address: 'Kızılay Mahallesi Atatürk Bulvarı No 10 Çankaya Ankara',
    postalCode: '06420',
    lat: 39.9208,
    lon: 32.8541,
  },
  {
    id: 2,
    name: 'Bahçelievler Çocuk Parkı',
    category: 'Park',
    type: 'Çocuk Parkı',
    district: 'Çankaya',
    neighborhood: 'Bahçelievler',
    street: 'Aşkabat Caddesi',
    address: 'Bahçelievler Mahallesi Aşkabat Caddesi No 20 Çankaya Ankara',
    postalCode: '06490',
    lat: 39.914,
    lon: 32.824,
  },
  {
    id: 3,
    name: 'Ulus Kültür Merkezi',
    category: 'Kültür',
    type: 'Kültür Merkezi',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    address: 'Ulus Anafartalar Caddesi No 15 Altındağ Ankara',
    postalCode: '06050',
    lat: 39.941,
    lon: 32.855,
  },
  {
    id: 4,
    name: 'Çankaya Kültür Merkezi',
    category: 'Kültür',
    type: 'Kültür Merkezi',
    district: 'Çankaya',
    neighborhood: 'Yıldız',
    street: 'Turan Güneş Bulvarı',
    address: 'Yıldız Turan Güneş Bulvarı No 45 Çankaya Ankara',
    postalCode: '06550',
    lat: 39.882,
    lon: 32.863,
  },
  {
    id: 5,
    name: 'Etlik Şehir Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Keçiören',
    neighborhood: 'Etlik',
    street: 'Halil Sezai Erkut Caddesi',
    address: 'Etlik Halil Sezai Erkut Caddesi Keçiören Ankara',
    postalCode: '06010',
    lat: 39.982,
    lon: 32.832,
  },
  {
    id: 6,
    name: 'Kızılay Sağlık Merkezi',
    category: 'Sağlık',
    type: 'Sağlık Merkezi',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Ziya Gökalp Caddesi',
    address: 'Kızılay Ziya Gökalp Caddesi No 5 Çankaya Ankara',
    postalCode: '06420',
    lat: 39.9214,
    lon: 32.8532,
  },
  {
    id: 7,
    name: 'Mamak Kültür Merkezi',
    category: 'Kültür',
    type: 'Kültür Merkezi',
    district: 'Mamak',
    neighborhood: 'Akdere',
    street: 'Mehmet Ali Altun Caddesi',
    address: 'Akdere Mehmet Ali Altun Caddesi Mamak Ankara',
    postalCode: '06630',
    lat: 39.918,
    lon: 32.91,
  },
  {
    id: 8,
    name: 'Keçiören Kalaba Parkı',
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Keçiören',
    neighborhood: 'Kalaba',
    street: 'Fatih Caddesi',
    address: 'Kalaba Fatih Caddesi Keçiören Ankara',
    postalCode: '06120',
    lat: 39.974,
    lon: 32.867,
  },
  {
    id: 9,
    name: 'Altındağ Gençlik Merkezi',
    category: 'Sosyal',
    type: 'Gençlik Merkezi',
    district: 'Altındağ',
    neighborhood: 'Örnek',
    street: 'Babür Caddesi',
    address: 'Örnek Babür Caddesi Altındağ Ankara',
    postalCode: '06080',
    lat: 39.946,
    lon: 32.884,
  },
  {
    id: 10,
    name: 'Çankaya Belediye Hizmet Noktası',
    category: 'Belediye',
    type: 'Hizmet Noktası',
    district: 'Çankaya',
    neighborhood: 'Ayrancı',
    street: 'Hoşdere Caddesi',
    address: 'Ayrancı Hoşdere Caddesi No 30 Çankaya Ankara',
    postalCode: '06540',
    lat: 39.901,
    lon: 32.844,
  },
] as const;

const dataset = (): DatasetSnapshot => {
  const runtime = createDataSearchRuntime();
  return runtime.register('ankara', sourceRecords(), { now: 1000 });
};

const categoryFilter = (value: string): SearchFilter => Object.freeze({
  field: 'categoryKey',
  operator: 'eq',
  values: Object.freeze([value]),
});

const createRuntime = () => createDataSearchExecutionRuntimeV7(dataset(), {
  defaultLimit: 10,
  maximumLimit: 50,
  maximumCandidates: 100,
  maximumResultWindow: 100,
  defaultRadiusMeters: 5_000,
  maximumRadiusMeters: 100_000,
});

describe('DataSearchExecutionRuntimeV7 text execution', () => {
  it('uses v6 relevance for plain text queries', () => {
    const result = createRuntime().search({ query: 'Çankaya Atatürk Parkı' });
    expect(result.intent.kind).toBe('text');
    expect(result.response.results[0]?.record.title).toBe('Çankaya Atatürk Parkı');
    expect(result.response.results[0]?.reasons).toContain('text-relevance-v6');
    expect(result.diagnostics.textUsed).toBe(true);
    expect(result.diagnostics.addressUsed).toBe(false);
  });

  it('keeps Turkish canonical equivalence deterministic', () => {
    const runtime = createRuntime();
    const upper = runtime.search({ query: 'ÇANKAYA PARK' });
    const lower = runtime.search({ query: 'çankaya park' });
    expect(upper.response.results.map(hit => hit.record.fingerprint))
      .toEqual(lower.response.results.map(hit => hit.record.fingerprint));
  });

  it('supports canonical filters on the text path', () => {
    const result = createRuntime().search({
      query: 'merkezi',
      filters: [categoryFilter('kultur')],
    });
    expect(result.response.results.length).toBeGreaterThan(0);
    expect(result.response.results.every(hit => hit.record.categoryKey === 'kultur')).toBe(true);
  });

  it('uses v7 normalized 0..1000 score scale', () => {
    const result = createRuntime().search({ query: 'park' });
    for (const hit of result.response.results) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1000);
      expect(hit.evidence.textScore).toBeGreaterThanOrEqual(0);
    }
  });

  it('applies minScore to the normalized v7 score', () => {
    const permissive = createRuntime().search({ query: 'park', minScore: 0 });
    const strict = createRuntime().search({ query: 'park', minScore: 999.999 });
    expect(strict.response.results.length).toBeLessThanOrEqual(permissive.response.results.length);
  });

  it('preserves canonical SearchResponse pagination shape', () => {
    const result = createRuntime().search({ query: 'merkezi', limit: 2 });
    expect(result.response.page.limit).toBe(2);
    expect(result.response.page.count).toBeLessThanOrEqual(2);
    expect(result.response.diagnostics.datasetKey).toBe('ankara');
    expect(result.response.diagnostics.revision).toBe(1);
  });

  it('produces stable request fingerprints', () => {
    const runtime = createRuntime();
    const left = runtime.fingerprint({ query: 'ÇANKAYA park' });
    const right = runtime.fingerprint({ query: 'çankaya PARK' });
    expect(left).toBe(right);
  });

  it('changes request fingerprint when filters change', () => {
    const runtime = createRuntime();
    const left = runtime.fingerprint({ query: 'park' });
    const right = runtime.fingerprint({ query: 'park', filters: [categoryFilter('park')] });
    expect(left).not.toBe(right);
  });

  it('changes request fingerprint when page window changes', () => {
    const runtime = createRuntime();
    const first = runtime.fingerprint({ query: 'park', offset: 0, limit: 2 });
    const second = runtime.fingerprint({ query: 'park', offset: 2, limit: 2 });
    expect(first).not.toBe(second);
  });

  it('tracks text lifecycle counters', () => {
    const runtime = createRuntime();
    runtime.search({ query: 'park' });
    runtime.search({ query: 'hastane' });
    const snapshot = runtime.snapshot();
    expect(snapshot.searches).toBe(2);
    expect(snapshot.textSearches).toBe(2);
    expect(snapshot.datasetKey).toBe('ankara');
    expect(snapshot.recordCount).toBe(10);
  });
});

describe('DataSearchExecutionRuntimeV7 address execution', () => {
  it('routes structured address queries through v4 address semantics', () => {
    const result = createRuntime().search({
      query: 'Atatürk Bulvarı No 10 Çankaya',
    });
    expect(result.intent.kind).toBe('address');
    expect(result.response.results[0]?.record.title).toBe('Çankaya Atatürk Parkı');
    expect(result.response.results[0]?.reasons).toContain('address-semantics-v4');
    expect(result.diagnostics.addressUsed).toBe(true);
  });

  it('preserves hierarchy filtering', () => {
    const result = createRuntime().search({
      query: 'merkezi',
      district: 'Çankaya',
    });
    expect(result.intent.kind).toBe('address');
    expect(result.response.results.length).toBeGreaterThan(0);
    expect(result.response.results.every(hit => hit.record.district === 'Çankaya')).toBe(true);
    expect(result.response.results.every(hit => hit.reasons.includes('address-hierarchy'))).toBe(true);
  });

  it('supports hierarchy-only requests', () => {
    const result = createRuntime().search({ district: 'Çankaya' });
    expect(result.intent.kind).toBe('address');
    expect(result.response.results.length).toBe(5);
    expect(result.response.results.every(hit => hit.record.district === 'Çankaya')).toBe(true);
  });

  it('intersects hierarchy and ordinary filters', () => {
    const result = createRuntime().search({
      district: 'Çankaya',
      filters: [categoryFilter('park')],
    });
    expect(result.response.results.map(hit => hit.record.title)).toEqual([
      'Çankaya Atatürk Parkı',
      'Bahçelievler Çocuk Parkı',
    ]);
  });

  it('reports the existing candidate planner strategy', () => {
    const result = createRuntime().search({ query: 'Atatürk Bulvarı Çankaya' });
    expect(result.diagnostics.addressPlanStrategy).not.toBeNull();
    expect(['intersection', 'union', 'fallback-scan', 'all'])
      .toContain(result.diagnostics.addressPlanStrategy);
  });

  it('does not mutate the registered dataset records', () => {
    const snapshot = dataset();
    const fingerprints = snapshot.records.map(record => record.fingerprint);
    const runtime = new DataSearchExecutionRuntimeV7(snapshot);
    runtime.search({ query: 'Atatürk Bulvarı No 10 Çankaya' });
    expect(snapshot.records.map(record => record.fingerprint)).toEqual(fingerprints);
  });
});

describe('DataSearchExecutionRuntimeV7 coordinate execution', () => {
  it('searches around an explicit request center', () => {
    const result = createRuntime().search({
      center: { latitude: 39.9208, longitude: 32.8541 },
      radiusMeters: 2_000,
      sort: 'distance',
    });
    expect(result.intent.kind).toBe('coordinate');
    expect(result.diagnostics.spatialUsed).toBe(true);
    expect(result.response.results[0]?.record.title).toBe('Çankaya Atatürk Parkı');
    expect(result.response.results[0]?.distanceMeters).toBe(0);
  });

  it('searches around a coordinate typed into the query', () => {
    const result = createRuntime().search({
      query: '39.9208, 32.8541',
      radiusMeters: 2_000,
      sort: 'distance',
    });
    expect(result.intent.kind).toBe('coordinate');
    expect(result.intent.centerSource).toBe('query');
    expect(result.response.results[0]?.record.title).toBe('Çankaya Atatürk Parkı');
  });

  it('orders coordinate results by exact distance', () => {
    const result = createRuntime().search({
      center: { latitude: 39.9208, longitude: 32.8541 },
      radiusMeters: 10_000,
      sort: 'distance',
    });
    const distances = result.response.results
      .map(hit => hit.distanceMeters)
      .filter((value): value is number => value !== null);
    expect(distances).toEqual([...distances].sort((left, right) => left - right));
  });

  it('uses the default radius when center exists and radius is omitted', () => {
    const result = createRuntime().search({
      center: { latitude: 39.9208, longitude: 32.8541 },
    });
    expect(result.diagnostics.radiusMeters).toBe(5_000);
  });

  it('caps requested radius at policy maximum', () => {
    const result = createRuntime().search({
      center: { latitude: 39.9208, longitude: 32.8541 },
      radiusMeters: 999_999,
    });
    expect(result.diagnostics.radiusMeters).toBe(100_000);
  });

  it('blocks invalid explicitly supplied coordinates', () => {
    const result = createRuntime().search({
      query: 'park',
      center: [999, 999],
    });
    expect(result.diagnostics.blocked).toBe(true);
    expect(result.diagnostics.blockReason).toBe('invalid-explicit-center');
    expect(result.response.results).toHaveLength(0);
  });

  it('never returns non-geocoded records for coordinate intent', () => {
    const runtime = createDataSearchRuntime();
    const snapshot = runtime.register('mixed', [
      ...sourceRecords(),
      { id: 99, name: 'Koordinatsız Park', category: 'Park' },
    ]);
    const result = new DataSearchExecutionRuntimeV7(snapshot).search({
      center: { latitude: 39.9208, longitude: 32.8541 },
      radiusMeters: 50_000,
    });
    expect(result.response.results.some(hit => hit.record.title === 'Koordinatsız Park')).toBe(false);
  });
});

describe('DataSearchExecutionRuntimeV7 hybrid execution', () => {
  it('combines coordinate narrowing with v6 text evidence', () => {
    const result = createRuntime().search({
      query: '39.9208,32.8541 park',
      radiusMeters: 5_000,
      sort: 'relevance',
    });
    expect(result.intent.kind).toBe('hybrid');
    expect(result.diagnostics.textUsed).toBe(true);
    expect(result.diagnostics.spatialUsed).toBe(true);
    expect(result.response.results.length).toBeGreaterThan(0);
    expect(result.response.results.every(hit => hit.record.categoryKey === 'park')).toBe(true);
  });

  it('keeps spatial and text evidence separately inspectable', () => {
    const result = createRuntime().search({
      query: '39.9208,32.8541 park',
      radiusMeters: 5_000,
    });
    const hit = result.hits[0];
    expect(hit?.evidence.textScore).toBeGreaterThan(0);
    expect(hit?.evidence.distanceMeters).not.toBeNull();
    expect(hit?.reasons).toContain('text-relevance-v6');
    expect(hit?.reasons).toContain('spatial-index');
  });

  it('respects explicit center precedence during hybrid execution', () => {
    const result = createRuntime().search({
      query: '39.9208,32.8541 hastane',
      center: { latitude: 39.982, longitude: 32.832 },
      radiusMeters: 2_000,
    });
    expect(result.intent.centerSource).toBe('request');
    expect(result.response.results[0]?.record.title).toBe('Etlik Şehir Hastanesi');
  });

  it('combines address hierarchy and spatial center', () => {
    const result = createRuntime().search({
      query: 'merkezi',
      district: 'Çankaya',
      center: { latitude: 39.9208, longitude: 32.8541 },
      radiusMeters: 10_000,
    });
    expect(result.intent.kind).toBe('hybrid');
    expect(result.response.results.every(hit => hit.record.district === 'Çankaya')).toBe(true);
  });
});

describe('DataSearchExecutionRuntimeV7 facets and sorting', () => {
  it('aggregates bounded facets from the result window', () => {
    const result = createRuntime().search({
      district: 'Çankaya',
      facetFields: ['category', 'district'],
    });
    expect(result.response.facets.district?.[0]).toEqual({ value: 'Çankaya', count: 5 });
    expect(result.response.facets.category?.length).toBeGreaterThan(0);
  });

  it('deduplicates requested facet fields', () => {
    const result = createRuntime().search({
      district: 'Çankaya',
      facetFields: ['category', 'category', 'category'],
    });
    expect(Object.keys(result.response.facets)).toEqual(['category']);
  });

  it('bounds the number of facet fields', () => {
    const runtime = new DataSearchExecutionRuntimeV7(dataset(), {
      maximumFacetFields: 1,
    });
    const result = runtime.search({
      district: 'Çankaya',
      facetFields: ['category', 'district'],
    });
    expect(Object.keys(result.response.facets)).toHaveLength(1);
  });

  it('bounds the number of buckets per facet', () => {
    const runtime = new DataSearchExecutionRuntimeV7(dataset(), {
      maximumFacetBuckets: 2,
    });
    const result = runtime.search({
      facetFields: ['category'],
    });
    expect(result.response.facets.category?.length).toBeLessThanOrEqual(2);
  });

  it('supports title sorting', () => {
    const result = createRuntime().search({
      district: 'Çankaya',
      sort: 'title',
    });
    const titles = result.response.results.map(hit => hit.record.title);
    const sorted = [...titles].sort((left, right) => left.localeCompare(right, 'tr-TR', {
      sensitivity: 'base',
      numeric: true,
    }));
    expect(titles).toEqual(sorted);
  });

  it('supports stable source-order sorting', () => {
    const result = createRuntime().search({
      district: 'Çankaya',
      sort: 'source-order',
    });
    const indexes = result.response.results.map(hit => hit.record.sourceIndex);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
  });
});

describe('DataSearchExecutionRuntimeV7 fail-closed budgets', () => {
  it('blocks offsets beyond the configured result window', () => {
    const runtime = new DataSearchExecutionRuntimeV7(dataset(), {
      maximumResultWindow: 100,
    });
    const result = runtime.search({ query: 'park', offset: 100 });
    expect(result.diagnostics.blocked).toBe(true);
    expect(result.diagnostics.blockReason).toBe('result-window-offset-exceeded');
  });

  it('clamps page limits to the configured maximum', () => {
    const runtime = new DataSearchExecutionRuntimeV7(dataset(), {
      maximumLimit: 2,
      defaultLimit: 2,
    });
    const result = runtime.search({ query: 'merkezi', limit: 999 });
    expect(result.response.page.limit).toBe(2);
    expect(result.response.results.length).toBeLessThanOrEqual(2);
  });

  it('fails closed for empty enumeration above candidate budget', () => {
    const many = Array.from({ length: 120 }, (_value, index) => ({
      id: index + 1,
      name: `Yer ${index + 1}`,
      category: 'Test',
    }));
    const snapshot = createDataSearchRuntime().register('many', many);
    const runtime = new DataSearchExecutionRuntimeV7(snapshot, {
      maximumCandidates: 100,
    });
    const result = runtime.search({});
    expect(result.diagnostics.blocked).toBe(true);
    expect(result.response.results).toHaveLength(0);
  });

  it('fails closed when spatial candidate budget truncates', () => {
    const many = Array.from({ length: 120 }, (_value, index) => ({
      id: index + 1,
      name: `Nokta ${index + 1}`,
      category: 'Test',
      lat: 39.92 + (index % 5) * 0.00001,
      lon: 32.85 + (index % 5) * 0.00001,
    }));
    const snapshot = createDataSearchRuntime().register('dense', many);
    const runtime = new DataSearchExecutionRuntimeV7(snapshot, {
      maximumCandidates: 100,
      spatial: { maxCandidates: 100 },
    });
    const result = runtime.search({
      center: { latitude: 39.92, longitude: 32.85 },
      radiusMeters: 5_000,
    });
    expect(result.diagnostics.blocked).toBe(true);
    expect(result.diagnostics.blockReason).toBe('spatial-candidate-budget-exceeded');
  });

  it('fails immediately for an already aborted request', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => createRuntime().search({
      query: 'park',
      signal: controller.signal,
    })).toThrow(/aborted/i);
  });

  it('does not add a cache or network dependency inside one execution runtime', () => {
    const runtime = createRuntime();
    const first = runtime.search({ query: 'park' });
    const second = runtime.search({ query: 'park' });
    expect(first.response.diagnostics.cacheHit).toBe(false);
    expect(second.response.diagnostics.cacheHit).toBe(false);
    expect(first.response.results.map(hit => hit.record.fingerprint))
      .toEqual(second.response.results.map(hit => hit.record.fingerprint));
  });
});
