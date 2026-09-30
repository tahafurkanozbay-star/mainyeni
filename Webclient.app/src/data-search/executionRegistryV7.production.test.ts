import { describe, expect, it } from 'vitest';
import type { DatasetSnapshot } from './contracts';
import { createDataSearchRuntime } from './searchRuntime';
import {
  DataSearchExecutionRegistryV7,
  createDataSearchExecutionRegistryV7,
} from './dataSearchExecutionRegistryV7';

const rows = (suffix = '') => [
  {
    id: `park-${suffix || 'a'}`,
    name: `Çankaya Atatürk Parkı${suffix}`,
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    address: 'Atatürk Bulvarı No 10 Çankaya Ankara',
    lat: 39.9208,
    lon: 32.8541,
  },
  {
    id: `health-${suffix || 'a'}`,
    name: `Kızılay Sağlık Merkezi${suffix}`,
    category: 'Sağlık',
    type: 'Sağlık Merkezi',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Ziya Gökalp Caddesi',
    address: 'Ziya Gökalp Caddesi No 5 Çankaya Ankara',
    lat: 39.9214,
    lon: 32.8532,
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

const snapshot = (key = 'ankara', suffix = ''): DatasetSnapshot =>
  createDataSearchRuntime().register(key, rows(suffix));

const replacementSnapshots = (): readonly [DatasetSnapshot, DatasetSnapshot] => {
  const source = createDataSearchRuntime();
  const first = source.register('ankara', rows(''));
  const second = source.register('ankara', rows('-v2'));
  return [first, second] as const;
};

describe('DataSearchExecutionRegistryV7 registration lifecycle', () => {
  it('registers an existing normalized DatasetSnapshot', () => {
    const registry = createDataSearchExecutionRegistryV7();
    const dataset = snapshot();
    const result = registry.register(dataset);
    expect(result.datasetKey).toBe('ankara');
    expect(result.datasetRevision).toBe(1);
    expect(result.datasetFingerprint).toBe(dataset.fingerprint);
    expect(result.runtimeRebuilt).toBe(true);
    expect(result.replaced).toBe(false);
  });

  it('reuses runtime for the exact same dataset identity', () => {
    const registry = createDataSearchExecutionRegistryV7();
    const dataset = snapshot();
    registry.register(dataset);
    const runtime = registry.get('ankara')?.runtime;
    const second = registry.register(dataset);
    expect(second.runtimeRebuilt).toBe(false);
    expect(registry.get('ankara')?.runtime).toBe(runtime);
    expect(registry.snapshot().runtimeRebuilds).toBe(1);
  });

  it('rebuilds runtime when dataset revision changes', () => {
    const registry = createDataSearchExecutionRegistryV7();
    const [first, second] = replacementSnapshots();
    registry.register(first);
    const firstRuntime = registry.get('ankara')?.runtime;
    const registration = registry.register(second);
    expect(registration.replaced).toBe(true);
    expect(registration.runtimeRebuilt).toBe(true);
    expect(registry.get('ankara')?.runtime).not.toBe(firstRuntime);
    expect(registry.get('ankara')?.datasetRevision).toBe(2);
  });

  it('rebuilds runtime when fingerprint changes even at an externally supplied identity boundary', () => {
    const registry = createDataSearchExecutionRegistryV7();
    const original = snapshot();
    const changed = Object.freeze({
      ...snapshot('ankara', '-changed'),
      revision: original.revision,
    });
    registry.register(original);
    const firstRuntime = registry.get('ankara')?.runtime;
    registry.register(changed);
    expect(registry.get('ankara')?.runtime).not.toBe(firstRuntime);
  });

  it('evicts the least recently used dataset at capacity', () => {
    const registry = createDataSearchExecutionRegistryV7({ maximumDatasets: 2 });
    registry.register(snapshot('a'));
    registry.register(snapshot('b'));
    registry.get('a');
    const registration = registry.register(snapshot('c'));
    expect(registration.evictedDatasetKey).toBe('b');
    expect(registry.has('a')).toBe(true);
    expect(registry.has('b')).toBe(false);
    expect(registry.has('c')).toBe(true);
  });

  it('normalizes dataset keys for lookup', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot('ANKARA MERKEZ'));
    expect(registry.has('ankara-merkez')).toBe(true);
    expect(registry.get('ANKARA MERKEZ')?.datasetKey).toBe('ankara-merkez');
  });

  it('removes datasets and their cache state', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    registry.search('ankara', { query: 'park' });
    expect(registry.cache().stats().entries).toBeGreaterThan(0);
    expect(registry.remove('ankara')).toBe(true);
    expect(registry.has('ankara')).toBe(false);
    expect(registry.cache().entries('ankara')).toHaveLength(0);
  });

  it('returns false when removing an unknown dataset', () => {
    const registry = createDataSearchExecutionRegistryV7();
    expect(registry.remove('missing')).toBe(false);
  });

  it('rejects searching an unknown dataset', () => {
    const registry = createDataSearchExecutionRegistryV7();
    expect(() => registry.search('missing', { query: 'park' }))
      .toThrow(/Unknown v7 data-search dataset/);
  });
});

describe('DataSearchExecutionRegistryV7 revision-safe cache', () => {
  it('stores a successful signal-free result', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    const result = registry.search('ankara', { query: 'park' });
    expect(result.cacheHit).toBe(false);
    expect(result.cacheStored).toBe(true);
    expect(result.cacheRejected).toBe(false);
    expect(registry.cache().stats().entries).toBe(1);
  });

  it('returns repeated requests from revision-safe cache', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    const first = registry.search('ankara', { query: 'park' });
    const second = registry.search('ankara', { query: 'park' });
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.result.response.diagnostics.cacheHit).toBe(true);
    expect(second.result.response.diagnostics.elapsedMs).toBe(0);
    expect(second.result.response.results.map(hit => hit.record.fingerprint))
      .toEqual(first.result.response.results.map(hit => hit.record.fingerprint));
  });

  it('does not cache requests carrying AbortSignal', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    const controller = new AbortController();
    const first = registry.search('ankara', {
      query: 'park',
      signal: controller.signal,
    });
    expect(first.cacheStored).toBe(false);
    expect(registry.cache().stats().entries).toBe(0);
    const second = registry.search('ankara', { query: 'park' });
    expect(second.cacheHit).toBe(false);
  });

  it('does not cache fail-closed results', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    const result = registry.search('ankara', {
      query: 'park',
      center: [999, 999],
    });
    expect(result.result.diagnostics.blocked).toBe(true);
    expect(result.cacheStored).toBe(false);
    expect(registry.cache().stats().entries).toBe(0);
  });

  it('separates cache keys by request filters', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    registry.search('ankara', { query: 'merkezi' });
    registry.search('ankara', {
      query: 'merkezi',
      filters: [{ field: 'categoryKey', operator: 'eq', values: ['saglik'] }],
    });
    expect(registry.cache().stats().entries).toBe(2);
  });

  it('separates cache keys by spatial center', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    registry.search('ankara', {
      center: { latitude: 39.92, longitude: 32.85 },
    });
    registry.search('ankara', {
      center: { latitude: 39.94, longitude: 32.85 },
    });
    expect(registry.cache().stats().entries).toBe(2);
  });

  it('invalidates old cache entries on dataset replacement', () => {
    const registry = createDataSearchExecutionRegistryV7();
    const [first, second] = replacementSnapshots();
    registry.register(first);
    registry.search('ankara', { query: 'park' });
    expect(registry.cache().stats().entries).toBe(1);
    const registration = registry.register(second);
    expect(registration.invalidatedCacheEntries).toBe(1);
    expect(registry.cache().stats().entries).toBe(0);
    const newResult = registry.search('ankara', { query: 'park' });
    expect(newResult.cacheHit).toBe(false);
    expect(newResult.result.response.diagnostics.revision).toBe(2);
  });

  it('allows explicit dataset cache invalidation', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    registry.search('ankara', { query: 'park' });
    expect(registry.invalidate('ankara')).toBe(1);
    expect(registry.cache().stats().entries).toBe(0);
  });

  it('rejects oversized cache values through existing byte budget', () => {
    const registry = createDataSearchExecutionRegistryV7({
      cache: {
        maxBytes: 2_048,
        maxEntryBytes: 256,
      },
    });
    registry.register(snapshot());
    const result = registry.search('ankara', { query: 'park' });
    expect(result.cacheHit).toBe(false);
    expect(result.cacheStored).toBe(false);
    expect(result.cacheRejected).toBe(true);
    expect(registry.snapshot().cacheRejectedWrites).toBe(1);
  });

  it('exposes cache namespace and dataset identity through cache entries', () => {
    const registry = createDataSearchExecutionRegistryV7();
    const dataset = snapshot();
    registry.register(dataset);
    registry.search('ankara', { query: 'park' });
    const entry = registry.cache().entries('ankara')[0];
    expect(entry?.namespace).toBe('data-search-v7');
    expect(entry?.dataset.revision).toBe(dataset.revision);
    expect(entry?.dataset.fingerprint).toBe(dataset.fingerprint);
  });
});

describe('DataSearchExecutionRegistryV7 SearchSession compatibility', () => {
  it('delegates immediate searches through existing SearchSession', async () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    const session = registry.createSession({ debounceMs: 0 });
    const envelope = await session.searchNow('ankara', { query: 'park' });
    expect(envelope.stale).toBe(false);
    expect(envelope.result?.results[0]?.record.categoryKey).toBe('park');
    session.dispose();
  });

  it('uses existing debounce cancellation when a scheduled request is superseded', async () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    const session = registry.createSession({ debounceMs: 20 });
    const first = session.schedule('ankara', { query: 'park' });
    const second = session.schedule('ankara', { query: 'hastane' });
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const envelope = await second;
    expect(envelope.result?.results[0]?.record.title).toContain('Sağlık');
    session.dispose();
  });

  it('propagates already-aborted external session signals', async () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    const session = registry.createSession({ debounceMs: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(session.searchNow('ankara', { query: 'park' }, {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    session.dispose();
  });

  it('tracks active registry sessions without creating a new session authority', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    const first = registry.createSession();
    const second = registry.createSession();
    expect(registry.snapshot().sessions).toBe(2);
    first.dispose();
    expect(registry.snapshot().sessions).toBe(1);
    second.dispose();
    expect(registry.snapshot().sessions).toBe(0);
  });

  it('disposes all sessions with registry disposal', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    const session = registry.createSession();
    registry.dispose();
    expect(() => session.searchNow('ankara', { query: 'park' }))
      .toThrow(/disposed/);
  });
});

describe('DataSearchExecutionRegistryV7 diagnostics', () => {
  it('reports registrations, searches, hits and misses', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    registry.search('ankara', { query: 'park' });
    registry.search('ankara', { query: 'park' });
    const state = registry.snapshot();
    expect(state.version).toBe(7);
    expect(state.datasets).toBe(1);
    expect(state.registrations).toBe(1);
    expect(state.searches).toBe(2);
    expect(state.cacheMisses).toBe(1);
    expect(state.cacheHits).toBe(1);
  });

  it('reports runtime state per registered dataset', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.register(snapshot());
    registry.search('ankara', { query: 'park' });
    const state = registry.snapshot();
    expect(state.datasetsState[0]?.key).toBe('ankara');
    expect(state.datasetsState[0]?.runtime.version).toBe(7);
    expect(state.datasetsState[0]?.runtime.textSearches).toBe(1);
  });

  it('returns dataset keys in current LRU order', () => {
    const registry = new DataSearchExecutionRegistryV7({ maximumDatasets: 3 });
    registry.register(snapshot('a'));
    registry.register(snapshot('b'));
    registry.register(snapshot('c'));
    registry.get('a');
    expect(registry.datasetKeys()).toEqual(['b', 'c', 'a']);
  });

  it('prevents use after disposal', () => {
    const registry = createDataSearchExecutionRegistryV7();
    registry.dispose();
    expect(() => registry.register(snapshot())).toThrow(/disposed/);
    expect(() => registry.datasetKeys()).toThrow(/disposed/);
  });
});
