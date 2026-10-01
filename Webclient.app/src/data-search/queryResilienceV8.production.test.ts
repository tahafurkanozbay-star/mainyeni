import { describe, expect, it } from 'vitest';
import type { DatasetSnapshot, SearchFilter } from './contracts';
import { createDataSearchRuntime } from './searchRuntime';
import {
  QueryResilienceRuntimeV8,
  createQueryResilienceRuntimeV8,
} from './queryResilienceRuntimeV8';

const sourceRecords = () => [
  {
    id: 1,
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
    id: 2,
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
    id: 3,
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
    id: 4,
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
    id: 5,
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
] as const;

const dataset = (): DatasetSnapshot => {
  const runtime = createDataSearchRuntime();
  return runtime.register('ankara-v8', sourceRecords(), { now: 1000 });
};

const parkFilter = (): SearchFilter => Object.freeze({
  field: 'categoryKey',
  operator: 'eq',
  values: Object.freeze(['park']),
});

const runtime = (overrides: ConstructorParameters<typeof QueryResilienceRuntimeV8>[1] = {}) =>
  createQueryResilienceRuntimeV8(dataset(), {
    execution: {
      defaultLimit: 10,
      maximumLimit: 50,
      maximumCandidates: 100,
      maximumResultWindow: 100,
    },
    lexicon: {
      maximumDistance: 2,
      maximumCandidateComparisons: 128,
    },
    rewrite: {
      mode: 'fallback',
      minimumConfidence: 0.5,
      minimumScoreGap: 0,
      maximumDistance: 2,
    },
    ...overrides,
  });

describe('QueryResilienceRuntimeV8 canonical-first execution', () => {
  it('keeps correct queries on the original v7 path', () => {
    const result = runtime().search({ query: 'hastane' });
    expect(result.diagnostics.fallbackAttempted).toBe(false);
    expect(result.diagnostics.rewriteUsed).toBe(false);
    expect(result.response.results[0]?.record.title).toContain('Hastanesi');
    expect(result.selected).toBe(result.original);
  });

  it('uses one high-confidence fallback when original results are empty', () => {
    const result = runtime().search({ query: 'hastene' });
    expect(result.rewrite.rewrittenQuery).toBe('hastane');
    expect(result.diagnostics.fallbackAttempted).toBe(true);
    expect(result.diagnostics.fallbackAccepted).toBe(true);
    expect(result.diagnostics.rewriteUsed).toBe(true);
    expect(result.response.results[0]?.record.title).toContain('Hastanesi');
  });

  it('supports adjacent-transposition recovery', () => {
    const result = runtime().search({ query: 'pakri' });
    expect(result.rewrite.rewrittenQuery).toBe('parki');
    expect(result.diagnostics.fallbackAccepted).toBe(true);
    expect(result.response.results.some(hit => hit.record.categoryKey === 'park')).toBe(true);
  });

  it('preserves Turkish canonical equivalence on the original path', () => {
    const left = runtime().search({ query: 'ÇANKAYA' });
    const right = runtime().search({ query: 'çankaya' });
    expect(left.response.results.map(hit => hit.record.fingerprint))
      .toEqual(right.response.results.map(hit => hit.record.fingerprint));
  });

  it('does not fallback when syntax-sensitive rewrite is blocked', () => {
    const result = runtime().search({ query: 'title:hastene' });
    expect(result.rewrite.blockReason).toBe('syntax-sensitive');
    expect(result.diagnostics.fallbackAttempted).toBe(false);
  });

  it('does not fallback when canonical execution is blocked', () => {
    const constrained = runtime({
      execution: {
        maximumResultWindow: 100,
        maximumLimit: 50,
        maximumCandidates: 100,
      },
    });
    const result = constrained.search({ query: 'hastene', offset: 100 });
    expect(result.original.diagnostics.blocked).toBe(true);
    expect(result.diagnostics.fallbackAttempted).toBe(false);
  });

  it('does not replace the original result when fallback cannot improve filtered output', () => {
    const result = runtime().search({
      query: 'hastene',
      filters: [parkFilter()],
    });
    expect(result.diagnostics.fallbackAttempted).toBe(true);
    expect(result.diagnostics.fallbackAccepted).toBe(false);
    expect(result.selected).toBe(result.original);
  });

  it('keeps the canonical SearchResponse shape after accepted fallback', () => {
    const result = runtime().search({ query: 'hastene', limit: 1 });
    expect(result.response.page.limit).toBe(1);
    expect(result.response.page.count).toBeLessThanOrEqual(1);
    expect(result.response.diagnostics.datasetKey).toBe('ankara-v8');
    expect(result.response.diagnostics.revision).toBe(1);
  });

  it('propagates minScore into fallback execution', () => {
    const permissive = runtime().search({ query: 'hastene', minScore: 0 });
    const strict = runtime().search({ query: 'hastene', minScore: 999.999 });
    expect(strict.response.results.length).toBeLessThanOrEqual(permissive.response.results.length);
  });
});

describe('QueryResilienceRuntimeV8 policy behavior', () => {
  it('supports suggestion-only mode without second execution', () => {
    const result = runtime({
      rewrite: {
        mode: 'suggest',
        minimumConfidence: 0.5,
        minimumScoreGap: 0,
      },
    }).search({ query: 'hastene' });
    expect(result.rewrite.changed).toBe(true);
    expect(result.diagnostics.decision).toBe('suggestion-only');
    expect(result.diagnostics.fallbackAttempted).toBe(false);
    expect(result.diagnostics.rewriteUsed).toBe(false);
  });

  it('supports disabled rewrite mode', () => {
    const result = runtime({ rewrite: { mode: 'disabled' } }).search({ query: 'hastene' });
    expect(result.rewrite.blockReason).toBe('disabled');
    expect(result.diagnostics.fallbackAttempted).toBe(false);
  });

  it('can disable fallback attempts while retaining suggestions', () => {
    const result = runtime({ maximumFallbackAttempts: 0 }).search({ query: 'hastene' });
    expect(result.rewrite.changed).toBe(true);
    expect(result.diagnostics.fallbackAttempted).toBe(false);
  });

  it('defaults fallback threshold to zero results', () => {
    const result = runtime().search({ query: 'park' });
    expect(result.original.response.results.length).toBeGreaterThan(0);
    expect(result.diagnostics.fallbackAttempted).toBe(false);
  });

  it('can allow fallback for a small nonzero result set', () => {
    const custom = runtime({ fallbackResultThreshold: 2 });
    const result = custom.search({ query: 'hastene' });
    expect(result.diagnostics.fallbackAttempted).toBe(true);
  });

  it('rejects more than one fallback attempt by policy', () => {
    expect(() => runtime({ maximumFallbackAttempts: 2 })).toThrow(RangeError);
  });
});

describe('QueryResilienceRuntimeV8 cancellation and diagnostics', () => {
  it('honors an already-aborted request before canonical execution', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => runtime().search({ query: 'hastene', signal: controller.signal }))
      .toThrowError(expect.objectContaining({ name: 'AbortError' }));
  });

  it('returns immutable result diagnostics', () => {
    const result = runtime().search({ query: 'hastene' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(Object.isFrozen(result.rewrite)).toBe(true);
  });

  it('tracks fallback attempts and accepted rewrites', () => {
    const resilient = runtime();
    resilient.search({ query: 'hastene' });
    resilient.search({ query: 'hastane' });
    const snapshot = resilient.snapshot();
    expect(snapshot.searches).toBe(2);
    expect(snapshot.fallbackAttempts).toBe(1);
    expect(snapshot.fallbackAccepted).toBe(1);
    expect(snapshot.rewriteEligible).toBe(1);
  });

  it('exposes lexicon and v7 execution diagnostics together', () => {
    const resilient = runtime();
    resilient.search({ query: 'hastene' });
    const snapshot = resilient.snapshot();
    expect(snapshot.version).toBe(8);
    expect(snapshot.lexicon.distinctTerms).toBeGreaterThan(0);
    expect(snapshot.execution.version).toBe(7);
    expect(snapshot.rewrite.plans).toBeGreaterThan(0);
  });

  it('keeps dataset identity fixed for a runtime instance', () => {
    const resilient = runtime();
    const snapshot = resilient.snapshot();
    expect(snapshot.datasetKey).toBe('ankara-v8');
    expect(snapshot.datasetRevision).toBe(1);
    expect(snapshot.datasetFingerprint).toBe(dataset().fingerprint);
  });
});
