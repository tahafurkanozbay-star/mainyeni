import { describe, expect, it } from 'vitest';
import type { DatasetSnapshot } from './contracts';
import { createDataSearchRuntime } from './searchRuntime';
import {
  SearchRecoveryRuntimeV8,
  createSearchRecoveryRuntimeV8,
} from './searchRecoveryRuntimeV8';

const rows = (suffix = '') => [
  {
    id: `health-${suffix || 'a'}`,
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

const dataset = (key = 'ankara', suffix = ''): DatasetSnapshot =>
  createDataSearchRuntime().register(key, rows(suffix));

const replacements = (): readonly [DatasetSnapshot, DatasetSnapshot] => {
  const source = createDataSearchRuntime();
  const first = source.register('ankara', rows(''));
  const second = source.register('ankara', [
    ...rows('-v2'),
    {
      id: 'terminal-v2',
      name: 'AŞTİ Otobüs Terminali',
      category: 'Ulaşım',
      type: 'Terminal',
      district: 'Yenimahalle',
      neighborhood: 'Emek',
      street: 'Mevlana Bulvarı',
      address: 'Mevlana Bulvarı Yenimahalle Ankara',
      lat: 39.9183,
      lon: 32.8146,
    },
  ]);
  return [first, second] as const;
};

const recovery = () => createSearchRecoveryRuntimeV8({
  correction: {
    minimumAutoApplyScore: 100,
    minimumAutoApplyMargin: 5,
    maximumAutoEditDistance: 2,
  },
  synonymGroups: [{
    id: 'garden-park',
    canonical: 'park',
    aliases: ['bahce'],
    scopes: ['any', 'category'],
  }],
});

describe('SearchRecoveryRuntimeV8 registration lifecycle', () => {
  it('registers dataset into v7 registry and builds recovery lexicon', () => {
    const runtime = recovery();
    const result = runtime.register(dataset());
    expect(result.datasetKey).toBe('ankara');
    expect(result.lexiconTerms).toBeGreaterThan(0);
    expect(result.lexiconFingerprint).toBeTruthy();
    expect(result.correctionFingerprint).toBeTruthy();
  });

  it('reuses companion runtimes for identical dataset identity', () => {
    const runtime = recovery();
    const source = dataset();
    runtime.register(source);
    const firstLexicon = runtime.lexicon('ankara');
    const second = runtime.register(source);
    expect(second.runtimeRebuilt).toBe(false);
    expect(runtime.lexicon('ankara')).toBe(firstLexicon);
  });

  it('rebuilds lexicon on dataset revision replacement', () => {
    const runtime = recovery();
    const [first, second] = replacements();
    runtime.register(first);
    const fingerprint = runtime.lexicon('ankara').snapshot().fingerprint;
    runtime.register(second);
    expect(runtime.lexicon('ankara').snapshot().fingerprint).not.toBe(fingerprint);
    expect(runtime.lexicon('ankara').has('terminal')).toBe(true);
    expect(runtime.snapshot().registry.datasetsState[0]?.revision).toBe(2);
  });

  it('evicts companion state with v7 registry LRU capacity', () => {
    const runtime = createSearchRecoveryRuntimeV8({ maximumDatasets: 2 });
    runtime.register(dataset('a'));
    runtime.register(dataset('b'));
    runtime.search('a', { query: 'park' });
    const registration = runtime.register(dataset('c'));
    expect(registration.evictedDatasetKey).toBe('b');
    expect(runtime.datasetKeys()).toContain('a');
    expect(runtime.datasetKeys()).toContain('c');
    expect(() => runtime.lexicon('b')).toThrow(/Unknown v8 recovery dataset/);
  });

  it('removes companion and underlying registry state together', () => {
    const runtime = recovery();
    runtime.register(dataset());
    expect(runtime.remove('ankara')).toBe(true);
    expect(runtime.datasetKeys()).not.toContain('ankara');
    expect(() => runtime.correction('ankara')).toThrow(/Unknown v8 recovery dataset/);
  });

  it('rejects unknown dataset searches', () => {
    const runtime = recovery();
    expect(() => runtime.search('missing', { query: 'park' }))
      .toThrow(/Unknown v8 recovery dataset/);
  });
});

describe('SearchRecoveryRuntimeV8 typo recovery', () => {
  it('runs original query first and recovers a confident typo', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: 'hastne' });
    expect(result.diagnostics.attempts[0]?.mode).toBe('none');
    expect(result.diagnostics.primaryResultCount).toBe(0);
    expect(result.correction?.correctedQuery).toBe('hastane');
    expect(result.diagnostics.mode).toBe('corrected');
    expect(result.response.results[0]?.record.title).toContain('Hastanesi');
    expect(result.diagnostics.recovered).toBe(true);
  });

  it('does not run recovery when primary already has enough results', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: 'park' });
    expect(result.diagnostics.mode).toBe('none');
    expect(result.diagnostics.attempts).toHaveLength(1);
    expect(result.diagnostics.skipReason).toBe('not-needed');
    expect(result.correction).toBeNull();
  });

  it('supports a configurable primary-result threshold', () => {
    const runtime = createSearchRecoveryRuntimeV8({ minimumPrimaryResults: 2 });
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: 'park' });
    expect(result.diagnostics.attemptedRecovery).toBe(true);
  });

  it('preserves filters across corrected recovery attempts', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const result = runtime.search('ankara', {
      query: 'hastne',
      filters: [{ field: 'district', operator: 'eq', values: ['Altındağ'] }],
    });
    expect(result.response.results).toHaveLength(0);
    expect(result.diagnostics.attemptedRecovery).toBe(true);
  });

  it('preserves pagination limit across recovery attempts', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: 'hastne', limit: 1 });
    expect(result.response.results.length).toBeLessThanOrEqual(1);
    expect(result.response.page.limit).toBe(1);
  });

  it('does not cache or ignore a pre-aborted request', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const controller = new AbortController();
    controller.abort();
    expect(() => runtime.search('ankara', { query: 'hastne', signal: controller.signal }))
      .toThrow(/abort/i);
  });

  it('can disable typo correction', () => {
    const runtime = createSearchRecoveryRuntimeV8({ enableCorrection: false });
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: 'hastne' });
    expect(result.diagnostics.mode).toBe('none');
    expect(result.response.results).toHaveLength(0);
  });

  it('respects total attempt budget', () => {
    const runtime = createSearchRecoveryRuntimeV8({
      maximumAttempts: 1,
      correction: { minimumAutoApplyScore: 100, minimumAutoApplyMargin: 5 },
    });
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: 'hastne' });
    expect(result.diagnostics.attempts).toHaveLength(1);
    expect(result.diagnostics.mode).toBe('none');
  });
});

describe('SearchRecoveryRuntimeV8 synonym recovery', () => {
  it('uses a bounded synonym variant for a simple unknown query', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: 'bahce' });
    expect(result.diagnostics.attemptedRecovery).toBe(true);
    expect(result.diagnostics.attempts.some(attempt => attempt.mode.includes('synonym'))).toBe(true);
    expect(result.response.results.some(hit => hit.record.category === 'Park')).toBe(true);
  });

  it('does not apply synonym expansion to grammar-protected required query', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: '+bahce' });
    expect(result.diagnostics.attempts.some(attempt => attempt.mode.includes('synonym'))).toBe(false);
  });

  it('does not apply synonym expansion to excluded clauses', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: '-bahce zzzzzz' });
    expect(result.diagnostics.attempts.some(attempt => attempt.mode.includes('synonym'))).toBe(false);
  });

  it('does not apply synonym expansion to quoted phrase grammar', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: '"bahce"' });
    expect(result.diagnostics.attempts.some(attempt => attempt.mode.includes('synonym'))).toBe(false);
  });

  it('can disable synonym recovery independently', () => {
    const runtime = createSearchRecoveryRuntimeV8({
      enableSynonyms: false,
      synonymGroups: [{ id: 'garden-park', canonical: 'park', aliases: ['bahce'] }],
    });
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: 'bahce' });
    expect(result.diagnostics.attempts.some(attempt => attempt.mode.includes('synonym'))).toBe(false);
  });
});

describe('SearchRecoveryRuntimeV8 spatial safety', () => {
  it('never rewrites coordinate intent', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const result = runtime.search('ankara', { query: '39.9208, 32.8541' });
    expect(result.primary.result.intent.kind).toBe('coordinate');
    expect(result.diagnostics.mode).toBe('none');
    expect(result.diagnostics.skipReason).toBe('coordinate-intent');
    expect(result.diagnostics.attempts).toHaveLength(1);
  });

  it('never rewrites an explicit spatial center request', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const result = runtime.search('ankara', {
      query: 'hastne',
      center: { latitude: 39.9208, longitude: 32.8541 },
      radiusMeters: 1000,
    });
    expect(result.diagnostics.mode).toBe('none');
    expect(result.diagnostics.skipReason).toBe('explicit-center');
    expect(result.diagnostics.attempts).toHaveLength(1);
  });

  it('does not bypass a fail-closed primary result', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const result = runtime.search('ankara', {
      query: 'hastne',
      center: [999, 999],
    });
    expect(result.primary.result.diagnostics.blocked).toBe(true);
    expect(result.diagnostics.skipReason).toBe('blocked-primary');
    expect(result.diagnostics.attempts).toHaveLength(1);
  });
});

describe('SearchRecoveryRuntimeV8 sessions and diagnostics', () => {
  it('creates a session backed by the same recovery authority', async () => {
    const runtime = recovery();
    runtime.register(dataset());
    const session = runtime.createSession({ debounceMs: 0 });
    const envelope = await session.searchNow('ankara', { query: 'hastne' });
    expect(envelope.result?.results[0]?.record.title).toContain('Hastanesi');
    session.dispose();
  });

  it('tracks search and recovery counters', () => {
    const runtime = recovery();
    runtime.register(dataset());
    runtime.search('ankara', { query: 'park' });
    runtime.search('ankara', { query: 'hastne' });
    const snapshot = runtime.snapshot();
    expect(snapshot.searches).toBe(2);
    expect(snapshot.recoveryAttempts).toBeGreaterThanOrEqual(1);
    expect(snapshot.recoveredSearches).toBeGreaterThanOrEqual(1);
  });

  it('exposes dataset revision and lexicon fingerprints in snapshot', () => {
    const runtime = recovery();
    const source = dataset();
    runtime.register(source);
    const state = runtime.snapshot().datasetsState[0];
    expect(state?.revision).toBe(source.revision);
    expect(state?.fingerprint).toBe(source.fingerprint);
    expect(state?.lexiconFingerprint).toBeTruthy();
    expect(state?.correctionFingerprint).toBeTruthy();
  });

  it('produces stable request fingerprint for cached identical primary request', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const first = runtime.search('ankara', { query: 'park' });
    const second = runtime.search('ankara', { query: 'park' });
    expect(first.diagnostics.requestFingerprint).toBe(second.diagnostics.requestFingerprint);
    expect(second.primary.cacheHit).toBe(true);
  });

  it('disposes sessions and rejects later operations', () => {
    const runtime = recovery();
    runtime.register(dataset());
    runtime.createSession({ debounceMs: 0 });
    runtime.dispose();
    expect(() => runtime.search('ankara', { query: 'park' })).toThrow(/disposed/);
  });

  it('provides a deterministic snapshot fingerprint for unchanged state', () => {
    const runtime = recovery();
    runtime.register(dataset());
    const first = runtime.snapshot().fingerprint;
    const second = runtime.snapshot().fingerprint;
    expect(first).toBe(second);
  });
});
