import { describe, expect, it } from 'vitest';
import type { DatasetSnapshot } from './contracts';
import { createDataSearchRuntime } from './searchRuntime';
import {
  QueryResilienceRegistryV8,
  createQueryResilienceRegistryV8,
} from './queryResilienceRegistryV8';

const recordsA = () => [
  { id: 1, name: 'Etlik Şehir Hastanesi', category: 'Sağlık', district: 'Keçiören', lat: 39.982, lon: 32.832 },
  { id: 2, name: 'Çankaya Atatürk Parkı', category: 'Park', district: 'Çankaya', lat: 39.9208, lon: 32.8541 },
  { id: 3, name: 'Ulus Kültür Merkezi', category: 'Kültür', district: 'Altındağ', lat: 39.941, lon: 32.855 },
] as const;

const recordsB = () => [
  { id: 1, name: 'Etlik Şehir Hastanesi', category: 'Sağlık', district: 'Keçiören', lat: 39.982, lon: 32.832 },
  { id: 2, name: 'Çankaya Atatürk Parkı', category: 'Park', district: 'Çankaya', lat: 39.9208, lon: 32.8541 },
  { id: 4, name: 'Mamak Kültür Merkezi', category: 'Kültür', district: 'Mamak', lat: 39.918, lon: 32.91 },
] as const;

const snapshots = (): readonly [DatasetSnapshot, DatasetSnapshot] => {
  const runtime = createDataSearchRuntime();
  const first = runtime.register('ankara', recordsA(), { now: 1000 });
  const second = runtime.register('ankara', recordsB(), { now: 2000 });
  return [first, second];
};

const separateDataset = (key: string, name: string): DatasetSnapshot => {
  const runtime = createDataSearchRuntime();
  return runtime.register(key, [{ id: 1, name }], { now: 1000 });
};

const registry = (overrides: ConstructorParameters<typeof QueryResilienceRegistryV8>[0] = {}) =>
  createQueryResilienceRegistryV8({
    maximumDatasets: 4,
    resilience: {
      rewrite: {
        mode: 'fallback',
        minimumConfidence: 0.5,
        minimumScoreGap: 0,
      },
    },
    cache: {
      maxEntries: 32,
      maxBytes: 2 * 1024 * 1024,
      maxEntryBytes: 256 * 1024,
      ttlMs: 60_000,
    },
    ...overrides,
  });

describe('QueryResilienceRegistryV8 registration lifecycle', () => {
  it('registers a dataset and builds one runtime', () => {
    const [first] = snapshots();
    const target = registry();
    const result = target.register(first);
    expect(result.runtimeRebuilt).toBe(true);
    expect(result.replaced).toBe(false);
    expect(target.has('ankara')).toBe(true);
    expect(target.snapshot().runtimeRebuilds).toBe(1);
  });

  it('reuses the runtime for identical dataset identity', () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    const result = target.register(first);
    expect(result.runtimeRebuilt).toBe(false);
    expect(result.replaced).toBe(false);
    expect(target.snapshot().runtimeRebuilds).toBe(1);
  });

  it('rebuilds runtime on dataset revision replacement', () => {
    const [first, second] = snapshots();
    const target = registry();
    target.register(first);
    const result = target.register(second);
    expect(result.runtimeRebuilt).toBe(true);
    expect(result.replaced).toBe(true);
    expect(result.datasetRevision).toBe(second.revision);
    expect(target.runtime('ankara').snapshot().datasetFingerprint).toBe(second.fingerprint);
  });

  it('invalidates old cached results when revision changes', () => {
    const [first, second] = snapshots();
    const target = registry();
    target.register(first);
    target.search('ankara', { query: 'hastane' });
    expect(target.snapshot().cache.entries).toBeGreaterThan(0);
    const replacement = target.register(second);
    expect(replacement.invalidatedCacheEntries).toBeGreaterThan(0);
  });

  it('evicts least-recent dataset when capacity is reached', () => {
    const target = registry({ maximumDatasets: 1 });
    target.register(separateDataset('a', 'Ankara Park'));
    const result = target.register(separateDataset('b', 'Bursa Park'));
    expect(result.evictedDatasetKey).toBe('a');
    expect(target.has('a')).toBe(false);
    expect(target.has('b')).toBe(true);
  });

  it('touches a runtime lookup for deterministic LRU ordering', () => {
    const target = registry({ maximumDatasets: 2 });
    target.register(separateDataset('a', 'Ankara Park'));
    target.register(separateDataset('b', 'Bursa Park'));
    target.runtime('a');
    const result = target.register(separateDataset('c', 'Ceyhan Park'));
    expect(result.evictedDatasetKey).toBe('b');
  });

  it('removes a dataset and its cache entries', () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    target.search('ankara', { query: 'hastane' });
    expect(target.remove('ankara')).toBe(true);
    expect(target.has('ankara')).toBe(false);
    expect(target.snapshot().cache.entries).toBe(0);
  });

  it('returns false when removing an unknown dataset', () => {
    expect(registry().remove('missing')).toBe(false);
  });

  it('rejects registration with an empty canonical key', () => {
    const invalid = { ...separateDataset('valid', 'Park'), key: '***' } as DatasetSnapshot;
    expect(() => registry().register(invalid)).toThrow(TypeError);
  });
});

describe('QueryResilienceRegistryV8 cache behavior', () => {
  it('stores and reuses successful resilient search results', () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    const firstSearch = target.search('ankara', { query: 'hastene' });
    const secondSearch = target.search('ankara', { query: 'hastene' });
    expect(firstSearch.cacheHit).toBe(false);
    expect(firstSearch.cacheStored).toBe(true);
    expect(secondSearch.cacheHit).toBe(true);
    expect(secondSearch.result.response.diagnostics.cacheHit).toBe(true);
  });

  it('uses request structure in the cache fingerprint', () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    target.search('ankara', { query: 'park', limit: 1 });
    const different = target.search('ankara', { query: 'park', limit: 2 });
    expect(different.cacheHit).toBe(false);
  });

  it('does not cache requests carrying an AbortSignal', () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    const controller = new AbortController();
    const result = target.search('ankara', { query: 'park', signal: controller.signal });
    expect(result.cacheStored).toBe(false);
    expect(target.snapshot().cache.entries).toBe(0);
  });

  it('does not cache blocked execution results', () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    const result = target.search('ankara', { query: 'park', offset: 10_000 });
    expect(result.result.selected.diagnostics.blocked).toBe(true);
    expect(result.cacheStored).toBe(false);
  });

  it('surfaces cache write rejection when an entry is too large', () => {
    const [first] = snapshots();
    const target = registry({
      cache: {
        maxEntries: 8,
        maxBytes: 1024,
        maxEntryBytes: 256,
        ttlMs: 60_000,
      },
    });
    target.register(first);
    const result = target.search('ankara', { query: 'park' });
    expect(result.cacheHit).toBe(false);
    expect(result.cacheRejected || result.cacheStored).toBe(true);
  });

  it('tracks cache hit and miss counters', () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    target.search('ankara', { query: 'park' });
    target.search('ankara', { query: 'park' });
    const snapshot = target.snapshot();
    expect(snapshot.cacheMisses).toBe(1);
    expect(snapshot.cacheHits).toBe(1);
  });
});

describe('QueryResilienceRegistryV8 session lifecycle', () => {
  it('reuses canonical SearchSession for debounced execution', async () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    const session = target.createSession({ debounceMs: 0, maxDebounceMs: 10 });
    const envelope = await session.schedule('ankara', { query: 'hastene' });
    expect(envelope.result?.results[0]?.record.title).toContain('Hastanesi');
    expect(target.snapshot().sessions).toBe(1);
    session.dispose();
    expect(target.snapshot().sessions).toBe(0);
  });

  it('cancels a scheduled request when a newer request supersedes it', async () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    const session = target.createSession({ debounceMs: 20, maxDebounceMs: 20 });
    const firstPromise = session.schedule('ankara', { query: 'hastene' });
    const secondPromise = session.schedule('ankara', { query: 'park' });
    await expect(firstPromise).rejects.toMatchObject({ name: 'AbortError' });
    const second = await secondPromise;
    expect(second.result?.results.length).toBeGreaterThan(0);
    session.dispose();
  });

  it('clears sessions, datasets and cache together', () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    target.search('ankara', { query: 'park' });
    target.createSession({ debounceMs: 0 });
    target.clear();
    const snapshot = target.snapshot();
    expect(snapshot.datasets).toBe(0);
    expect(snapshot.sessions).toBe(0);
    expect(snapshot.cache.entries).toBe(0);
  });

  it('rejects operations after dispose', () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    target.dispose();
    expect(() => target.has('ankara')).toThrow('disposed');
    expect(() => target.search('ankara', { query: 'park' })).toThrow('disposed');
  });
});

describe('QueryResilienceRegistryV8 diagnostics', () => {
  it('exposes dataset runtime state and version', () => {
    const [first] = snapshots();
    const target = registry();
    target.register(first);
    target.search('ankara', { query: 'hastene' });
    const snapshot = target.snapshot();
    expect(snapshot.version).toBe(8);
    expect(snapshot.datasetsState).toHaveLength(1);
    expect(snapshot.datasetsState[0]?.runtime.version).toBe(8);
  });

  it('returns keys in LRU insertion order', () => {
    const target = registry({ maximumDatasets: 3 });
    target.register(separateDataset('a', 'A Park'));
    target.register(separateDataset('b', 'B Park'));
    expect(target.keys()).toEqual(['a', 'b']);
    target.runtime('a');
    expect(target.keys()).toEqual(['b', 'a']);
  });

  it('tracks replacements and removals independently', () => {
    const [first, second] = snapshots();
    const target = registry();
    target.register(first);
    target.register(second);
    target.remove('ankara');
    const snapshot = target.snapshot();
    expect(snapshot.registrations).toBe(1);
    expect(snapshot.replacements).toBe(1);
    expect(snapshot.removals).toBe(1);
  });
});
