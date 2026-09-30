import { describe, expect, it } from 'vitest';
import type { DatasetSnapshot, SearchFilter, SearchRequest } from './contracts';
import { createDataSearchRuntime } from './searchRuntime';
import {
  createDataSearchExecutionRuntimeV7,
  type DataSearchExecutionRuntimeV7,
} from './dataSearchExecutionRuntimeV7';
import {
  createDataSearchExecutionRegistryV7,
  type DataSearchExecutionRegistryV7,
} from './dataSearchExecutionRegistryV7';
import {
  analyzeSearchIntentV7,
  searchIntentFingerprintV7,
} from './searchIntentRuntimeV7';

const records = () => [
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

const parkFilter = (): SearchFilter => Object.freeze({
  field: 'categoryKey',
  operator: 'eq',
  values: Object.freeze(['park']),
});

const createDataset = (key = 'ankara', now = 1_000): DatasetSnapshot => {
  const runtime = createDataSearchRuntime();
  return runtime.register(key, records(), { now });
};

const createRevisionPair = (): readonly [DatasetSnapshot, DatasetSnapshot] => {
  const runtime = createDataSearchRuntime();
  const first = runtime.register('ankara', records(), { now: 1_000 });
  const second = runtime.register('ankara', [
    ...records(),
    {
      id: 11,
      name: 'Sıhhiye Kent Kütüphanesi',
      category: 'Kültür',
      type: 'Kütüphane',
      district: 'Çankaya',
      neighborhood: 'Sıhhiye',
      street: 'Atatürk Bulvarı',
      address: 'Sıhhiye Atatürk Bulvarı Çankaya Ankara',
      postalCode: '06430',
      lat: 39.928,
      lon: 32.854,
    },
  ], { now: 2_000 });
  return [first, second] as const;
};

const createRuntime = (
  dataset: DatasetSnapshot = createDataset(),
): DataSearchExecutionRuntimeV7 => createDataSearchExecutionRuntimeV7(dataset, {
  defaultLimit: 10,
  maximumLimit: 50,
  maximumCandidates: 100,
  maximumResultWindow: 100,
  defaultRadiusMeters: 5_000,
  maximumRadiusMeters: 100_000,
});

const createRegistry = (): DataSearchExecutionRegistryV7 => createDataSearchExecutionRegistryV7({
  maximumDatasets: 3,
  execution: {
    defaultLimit: 10,
    maximumLimit: 50,
    maximumCandidates: 100,
    maximumResultWindow: 100,
    defaultRadiusMeters: 5_000,
    maximumRadiusMeters: 100_000,
  },
  cache: {
    maxEntries: 32,
    maxBytes: 2 * 1024 * 1024,
    maxEntryBytes: 256 * 1024,
    ttlMs: 30_000,
  },
});

const fingerprints = (request: SearchRequest): readonly string[] =>
  createRuntime().search(request).response.results.map(hit => hit.record.fingerprint);

const ids = (request: SearchRequest): readonly (string | null)[] =>
  createRuntime().search(request).response.results.map(hit => hit.record.id);

const largeRecords = (count: number): readonly Record<string, unknown>[] => Array.from(
  { length: count },
  (_value, index) => ({
    id: index + 1,
    name: `Kayıt ${index + 1}`,
    category: index % 2 === 0 ? 'Park' : 'Kültür',
    type: 'Yer',
    district: 'Çankaya',
    neighborhood: `Mahalle ${index % 8}`,
    street: `Cadde ${index % 12}`,
    address: `Çankaya Mahalle ${index % 8} Cadde ${index % 12} No ${index + 1}`,
    lat: 39.8 + (index % 10) * 0.001,
    lon: 32.8 + (index % 10) * 0.001,
  }),
);

describe('v7 intent and execution consistency', () => {
  it('keeps canonical Turkish text signatures stable through execution', () => {
    const runtime = createRuntime();
    expect(runtime.fingerprint({ query: 'ÇANKAYA PARK' }))
      .toBe(runtime.fingerprint({ query: 'çankaya park' }));
    expect(searchIntentFingerprintV7({ query: 'ÇANKAYA PARK' }))
      .toBe(searchIntentFingerprintV7({ query: 'çankaya park' }));
  });

  it('keeps canonically equivalent text result ordering stable', () => {
    expect(fingerprints({ query: 'ÇANKAYA PARK' }))
      .toEqual(fingerprints({ query: 'çankaya park' }));
  });

  it('preserves deterministic source ordering for repeated identical requests', () => {
    const runtime = createRuntime();
    const first = runtime.search({ query: 'merkezi' });
    const second = runtime.search({ query: 'merkezi' });
    expect(second.response.results.map(hit => hit.record.fingerprint))
      .toEqual(first.response.results.map(hit => hit.record.fingerprint));
  });

  it('uses coordinate intent for a coordinate-only request', () => {
    const runtime = createRuntime();
    const result = runtime.search({ query: '39.9208, 32.8541', radiusMeters: 5_000 });
    expect(result.intent.kind).toBe('coordinate');
    expect(result.diagnostics.spatialUsed).toBe(true);
    expect(result.response.results.length).toBeGreaterThan(0);
  });

  it('orders coordinate-only hits by deterministic distance evidence', () => {
    const result = createRuntime().search({
      query: '39.9208, 32.8541',
      radiusMeters: 10_000,
      sort: 'distance',
    });
    const distances = result.response.results.map(hit => hit.distanceMeters ?? Number.POSITIVE_INFINITY);
    expect(distances).toEqual([...distances].sort((left, right) => left - right));
    expect(result.response.results[0]?.record.id).toBe('1');
  });

  it('uses hybrid intent without scoring coordinate literals as free text', () => {
    const result = createRuntime().search({
      query: '39.9208, 32.8541 park',
      radiusMeters: 10_000,
    });
    expect(result.intent.kind).toBe('hybrid');
    expect(result.intent.residualQuery).toBe('park');
    expect(result.diagnostics.textUsed).toBe(true);
    expect(result.diagnostics.spatialUsed).toBe(true);
  });

  it('gives an explicit request center precedence over a query coordinate', () => {
    const result = createRuntime().search({
      query: '39.9208, 32.8541 park',
      center: { latitude: 39.974, longitude: 32.867 },
      radiusMeters: 3_000,
      sort: 'distance',
    });
    expect(result.intent.centerSource).toBe('request');
    expect(result.intent.center).toEqual({ latitude: 39.974, longitude: 32.867 });
    expect(result.response.results[0]?.record.id).toBe('8');
  });

  it('blocks invalid explicit centers rather than silently ignoring them', () => {
    const result = createRuntime().search({
      query: 'park',
      center: [999, 999],
    });
    expect(result.diagnostics.blocked).toBe(true);
    expect(result.diagnostics.blockReason).toBe('invalid-explicit-center');
    expect(result.response.results).toEqual([]);
  });

  it('preserves address hierarchy constraints on local execution', () => {
    const result = createRuntime().search({
      query: 'merkezi',
      district: 'Çankaya',
    });
    expect(result.response.results.length).toBeGreaterThan(0);
    expect(result.response.results.every(hit => hit.record.district === 'Çankaya')).toBe(true);
  });

  it('preserves category filters across text execution', () => {
    const result = createRuntime().search({
      query: 'park',
      filters: [parkFilter()],
    });
    expect(result.response.results.length).toBeGreaterThan(0);
    expect(result.response.results.every(hit => hit.record.categoryKey === 'park')).toBe(true);
  });

  it('preserves category filters across coordinate execution', () => {
    const result = createRuntime().search({
      query: '39.9208,32.8541',
      radiusMeters: 10_000,
      filters: [parkFilter()],
    });
    expect(result.response.results.length).toBeGreaterThan(0);
    expect(result.response.results.every(hit => hit.record.categoryKey === 'park')).toBe(true);
  });

  it('keeps normalized scores inside the public 0..1000 range', () => {
    const result = createRuntime().search({ query: 'kültür merkezi' });
    for (const hit of result.hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1000);
      expect(hit.evidence.textSignal).toBeGreaterThanOrEqual(0);
      expect(hit.evidence.textSignal).toBeLessThanOrEqual(1);
      expect(hit.evidence.addressSignal).toBeGreaterThanOrEqual(0);
      expect(hit.evidence.addressSignal).toBeLessThanOrEqual(1);
    }
  });

  it('blocks offsets outside the materialized result window', () => {
    const result = createRuntime().search({ query: 'park', offset: 100 });
    expect(result.diagnostics.blocked).toBe(true);
    expect(result.diagnostics.blockReason).toBe('result-window-offset-exceeded');
  });

  it('keeps result pages within the configured page budget', () => {
    const result = createRuntime().search({ query: 'merkezi', limit: 50 });
    expect(result.response.results.length).toBeLessThanOrEqual(50);
    expect(result.response.page.limit).toBe(50);
  });

  it('does not mutate the registered dataset while executing searches', () => {
    const dataset = createDataset();
    const before = dataset.records.map(record => record.fingerprint);
    const runtime = createRuntime(dataset);
    runtime.search({ query: 'park' });
    runtime.search({ query: '39.92,32.85 hastane', radiusMeters: 20_000 });
    expect(dataset.records.map(record => record.fingerprint)).toEqual(before);
    expect(dataset.revision).toBe(1);
  });

  it('reports intent-specific counters without changing dataset identity', () => {
    const runtime = createRuntime();
    runtime.search({ query: 'park' });
    runtime.search({ query: 'Atatürk Bulvarı No 10' });
    runtime.search({ query: '39.92,32.85' });
    runtime.search({ query: '39.92,32.85 park' });
    const snapshot = runtime.snapshot();
    expect(snapshot.searches).toBe(4);
    expect(snapshot.textSearches).toBeGreaterThanOrEqual(1);
    expect(snapshot.addressSearches).toBeGreaterThanOrEqual(1);
    expect(snapshot.coordinateSearches).toBe(1);
    expect(snapshot.hybridSearches).toBe(1);
    expect(snapshot.datasetRevision).toBe(1);
  });
});

describe('v7 registry cache and revision consistency', () => {
  it('reuses one runtime for an identical dataset identity', () => {
    const registry = createRegistry();
    const dataset = createDataset();
    const first = registry.register(dataset);
    const lookup = registry.get('ankara');
    const second = registry.register(dataset);
    expect(first.runtimeRebuilt).toBe(true);
    expect(second.runtimeRebuilt).toBe(false);
    expect(second.replaced).toBe(false);
    expect(registry.get('ankara')?.runtime).toBe(lookup?.runtime);
  });

  it('rebuilds runtime when dataset revision and fingerprint advance', () => {
    const registry = createRegistry();
    const [first, second] = createRevisionPair();
    registry.register(first);
    const firstRuntime = registry.get('ankara')?.runtime;
    const registration = registry.register(second);
    expect(registration.replaced).toBe(true);
    expect(registration.runtimeRebuilt).toBe(true);
    expect(registry.get('ankara')?.runtime).not.toBe(firstRuntime);
    expect(registry.get('ankara')?.datasetRevision).toBe(2);
  });

  it('serves a cache hit for repeated signal-free requests', () => {
    const registry = createRegistry();
    registry.register(createDataset());
    const first = registry.search('ankara', { query: 'park' });
    const second = registry.search('ankara', { query: 'park' });
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.result.response.diagnostics.cacheHit).toBe(true);
    expect(second.result.response.results.map(hit => hit.record.fingerprint))
      .toEqual(first.result.response.results.map(hit => hit.record.fingerprint));
  });

  it('does not cache requests carrying an AbortSignal', () => {
    const registry = createRegistry();
    registry.register(createDataset());
    const controller = new AbortController();
    const first = registry.search('ankara', { query: 'park', signal: controller.signal });
    const second = registry.search('ankara', { query: 'park', signal: controller.signal });
    expect(first.cacheStored).toBe(false);
    expect(second.cacheHit).toBe(false);
  });

  it('does not cache fail-closed results', () => {
    const registry = createRegistry();
    registry.register(createDataset());
    const first = registry.search('ankara', { query: 'park', center: [999, 999] });
    const second = registry.search('ankara', { query: 'park', center: [999, 999] });
    expect(first.result.diagnostics.blocked).toBe(true);
    expect(first.cacheStored).toBe(false);
    expect(second.cacheHit).toBe(false);
    expect(registry.snapshot().cache.entries).toBe(0);
  });

  it('invalidates stale cached results when a revision replaces a dataset', () => {
    const registry = createRegistry();
    const [first, second] = createRevisionPair();
    registry.register(first);
    registry.search('ankara', { query: 'park' });
    expect(registry.snapshot().cache.entries).toBeGreaterThan(0);
    const replacement = registry.register(second);
    expect(replacement.invalidatedCacheEntries).toBeGreaterThan(0);
    expect(registry.snapshot().cache.entries).toBe(0);
  });

  it('returns fresh revision diagnostics after dataset replacement', () => {
    const registry = createRegistry();
    const [first, second] = createRevisionPair();
    registry.register(first);
    const before = registry.search('ankara', { query: 'kütüphane' });
    registry.register(second);
    const after = registry.search('ankara', { query: 'kütüphane' });
    expect(before.result.response.diagnostics.revision).toBe(1);
    expect(after.result.response.diagnostics.revision).toBe(2);
    expect(after.result.response.results.some(hit => hit.record.title.includes('Kütüphanesi'))).toBe(true);
  });

  it('keeps cache identities distinct across request filters', () => {
    const registry = createRegistry();
    registry.register(createDataset());
    registry.search('ankara', { query: 'park' });
    const filtered = registry.search('ankara', { query: 'park', filters: [parkFilter()] });
    expect(filtered.cacheHit).toBe(false);
    expect(registry.snapshot().cache.entries).toBe(2);
  });

  it('evicts the oldest dataset when registry capacity is reached', () => {
    const registry = createDataSearchExecutionRegistryV7({ maximumDatasets: 2 });
    registry.register(createDataset('one'));
    registry.register(createDataset('two'));
    const third = registry.register(createDataset('three'));
    expect(third.evictedDatasetKey).toBe('one');
    expect(registry.has('one')).toBe(false);
    expect(registry.datasetKeys()).toEqual(['two', 'three']);
  });

  it('touches a dataset so a later capacity eviction removes the true oldest entry', () => {
    const registry = createDataSearchExecutionRegistryV7({ maximumDatasets: 2 });
    registry.register(createDataset('one'));
    registry.register(createDataset('two'));
    expect(registry.get('one')).not.toBeNull();
    const third = registry.register(createDataset('three'));
    expect(third.evictedDatasetKey).toBe('two');
    expect(registry.datasetKeys()).toEqual(['one', 'three']);
  });

  it('removes datasets and their cache entries atomically from the registry view', () => {
    const registry = createRegistry();
    registry.register(createDataset());
    registry.search('ankara', { query: 'park' });
    expect(registry.remove('ankara')).toBe(true);
    expect(registry.has('ankara')).toBe(false);
    expect(registry.snapshot().cache.entries).toBe(0);
    expect(() => registry.search('ankara', { query: 'park' })).toThrow(/Unknown v7 data-search dataset/);
  });

  it('supports explicit cache invalidation without removing the dataset', () => {
    const registry = createRegistry();
    registry.register(createDataset());
    registry.search('ankara', { query: 'park' });
    expect(registry.invalidate('ankara')).toBeGreaterThan(0);
    expect(registry.has('ankara')).toBe(true);
    expect(registry.snapshot().cache.entries).toBe(0);
  });

  it('exposes bounded registry diagnostics after repeated searches', () => {
    const registry = createRegistry();
    registry.register(createDataset());
    registry.search('ankara', { query: 'park' });
    registry.search('ankara', { query: 'park' });
    registry.search('ankara', { query: 'merkezi' });
    const snapshot = registry.snapshot();
    expect(snapshot.datasets).toBe(1);
    expect(snapshot.searches).toBe(3);
    expect(snapshot.cacheHits).toBe(1);
    expect(snapshot.cacheMisses).toBe(2);
    expect(snapshot.datasetsState[0]?.runtime.searches).toBe(2);
  });

  it('disposes sessions, cache and datasets together', () => {
    const registry = createRegistry();
    registry.register(createDataset());
    registry.search('ankara', { query: 'park' });
    const session = registry.createSession({ debounceMs: 0 });
    expect(registry.snapshot().sessions).toBe(1);
    session.dispose();
    expect(registry.snapshot().sessions).toBe(0);
    registry.dispose();
    expect(() => registry.snapshot()).toThrow(/disposed/);
  });
});

describe('v7 fail-closed scale boundaries', () => {
  it('blocks empty enumeration when the candidate budget would be exceeded', () => {
    const source = createDataSearchRuntime();
    const dataset = source.register('large', largeRecords(120));
    const runtime = createDataSearchExecutionRuntimeV7(dataset, {
      maximumCandidates: 100,
      maximumResultWindow: 100,
    });
    const result = runtime.search({});
    expect(result.diagnostics.blocked).toBe(true);
    expect(result.diagnostics.blockReason).toBe('address-candidate-budget-exceeded');
    expect(result.response.results).toEqual([]);
  });

  it('never broad-scans beyond policy after an empty-request budget rejection', () => {
    const source = createDataSearchRuntime();
    const dataset = source.register('large', largeRecords(150));
    const runtime = createDataSearchExecutionRuntimeV7(dataset, {
      maximumCandidates: 100,
      maximumResultWindow: 100,
    });
    const result = runtime.search({});
    expect(result.diagnostics.evaluatedCount).toBe(0);
    expect(result.diagnostics.matchedCount).toBe(0);
    expect(runtime.snapshot().maximumObservedCandidates).toBe(0);
  });

  it('keeps large text queries inside the v6 bounded execution path', () => {
    const source = createDataSearchRuntime();
    const dataset = source.register('large', largeRecords(150));
    const runtime = createDataSearchExecutionRuntimeV7(dataset, {
      maximumCandidates: 100,
      maximumResultWindow: 100,
      text: { maximumRerankCandidates: 100 },
    });
    const result = runtime.search({ query: 'kayıt' });
    expect(result.diagnostics.textUsed).toBe(true);
    expect(result.response.results.length).toBeLessThanOrEqual(100);
  });

  it('keeps result windows deterministic under repeated bounded execution', () => {
    const source = createDataSearchRuntime();
    const dataset = source.register('large', largeRecords(150));
    const runtime = createDataSearchExecutionRuntimeV7(dataset, {
      maximumCandidates: 100,
      maximumResultWindow: 100,
      text: { maximumRerankCandidates: 100 },
    });
    const first = runtime.search({ query: 'kayıt', limit: 50 });
    const second = runtime.search({ query: 'kayıt', limit: 50 });
    expect(second.response.results.map(hit => hit.record.fingerprint))
      .toEqual(first.response.results.map(hit => hit.record.fingerprint));
  });

  it('keeps public intent analysis free from dataset mutation or hidden network state', () => {
    const request: SearchRequest = Object.freeze({
      query: '39.9208, 32.8541 park',
      district: 'Çankaya',
    });
    const first = analyzeSearchIntentV7(request);
    const second = analyzeSearchIntentV7(request);
    expect(second.signature).toBe(first.signature);
    expect(second.center).toEqual(first.center);
    expect(request.query).toBe('39.9208, 32.8541 park');
  });

  it('keeps coordinate results stable when unrelated query casing changes', () => {
    const lower = ids({ query: '39.9208,32.8541 park', radiusMeters: 10_000 });
    const upper = ids({ query: '39.9208,32.8541 PARK', radiusMeters: 10_000 });
    expect(upper).toEqual(lower);
  });

  it('keeps distance ordering stable for a fixed center across repeated executions', () => {
    const request: SearchRequest = {
      center: { latitude: 39.9208, longitude: 32.8541 },
      radiusMeters: 20_000,
      sort: 'distance',
    };
    expect(ids(request)).toEqual(ids(request));
  });

  it('preserves dataset quality diagnostics on v7 SearchResponse', () => {
    const dataset = createDataset();
    const result = createRuntime(dataset).search({ query: 'park' });
    expect(result.response.diagnostics.quality).toBe(dataset.quality);
    expect(result.response.diagnostics.totalRecords).toBe(dataset.records.length);
  });
});
