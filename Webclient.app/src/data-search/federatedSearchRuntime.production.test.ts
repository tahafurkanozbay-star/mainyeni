import { describe, expect, it } from 'vitest';
import type { SearchHit, SearchResponse } from './contracts';
import { normalizeRecord } from './normalization';
import {
  FederatedSearchRuntime,
  type FederatedSearchSource,
} from './federatedSearchRuntime';

const quality = Object.freeze({
  inputCount: 0,
  outputCount: 0,
  duplicateCount: 0,
  invalidCount: 0,
  missingIdCount: 0,
  invalidCoordinateCount: 0,
  issues: Object.freeze([]),
});

const hit = (
  id: string,
  score: number,
  overrides: Record<string, unknown> = {},
): SearchHit => {
  const normalized = normalizeRecord({
    id,
    title: `Place ${id}`,
    category: 'service',
    type: 'municipal',
    address: `Address ${id}`,
    district: 'Çankaya',
    latitude: 39.92,
    longitude: 32.85,
    ...overrides,
  });
  if (!normalized) throw new Error('test record failed to normalize');
  return Object.freeze({
    record: normalized,
    score,
    distanceMeters: null,
    reasons: Object.freeze(['test']),
  });
};

const response = (
  hits: readonly SearchHit[],
  options: {
    readonly total?: number;
    readonly cacheHit?: boolean;
    readonly facets?: SearchResponse['facets'];
  } = {},
): SearchResponse => Object.freeze({
  results: Object.freeze([...hits]),
  page: Object.freeze({
    offset: 0,
    limit: Math.max(1, hits.length),
    count: hits.length,
    total: options.total ?? hits.length,
    hasMore: false,
    nextOffset: null,
  }),
  facets: options.facets ?? Object.freeze({}),
  diagnostics: Object.freeze({
    datasetKey: 'test',
    revision: 1,
    totalRecords: options.total ?? hits.length,
    candidateCount: hits.length,
    scoredCount: hits.length,
    filteredCount: hits.length,
    cacheHit: options.cacheHit ?? false,
    elapsedMs: 1,
    querySignature: 'test',
    quality,
  }),
});

const source = (
  key: string,
  result: SearchResponse | (() => Promise<SearchResponse> | SearchResponse),
  overrides: Partial<FederatedSearchSource> = {},
): FederatedSearchSource => ({
  key,
  ...overrides,
  search: async () => typeof result === 'function' ? result() : result,
});

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('FederatedSearchRuntime production contract', () => {
  it('merges multiple sources into one deterministic ranking', async () => {
    const runtime = new FederatedSearchRuntime([
      source('primary', response([hit('1', 10), hit('2', 5)]), { priority: 10 }),
      source('secondary', response([hit('3', 12), hit('4', 3)]), { priority: 20 }),
    ]);
    const result = await runtime.search({ request: { query: 'place', limit: 10 } });

    expect(result.results.map(item => item.record.id)).toEqual(['3', '1', '2', '4']);
    expect(result.diagnostics.completedSourceCount).toBe(2);
    expect(result.diagnostics.rawHitCount).toBe(4);
    expect(result.page.total).toBe(4);
  });

  it('deduplicates stable record IDs across sources and keeps the better weighted hit', async () => {
    const runtime = new FederatedSearchRuntime([
      source('authoritative', response([hit('1', 10)]), { priority: 5, weight: 2 }),
      source('fallback', response([hit('1', 30)]), { priority: 50, weight: 0.5 }),
    ]);
    const result = await runtime.search({ request: { limit: 10 } });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.sourceKey).toBe('authoritative');
    expect(result.results[0]?.weightedScore).toBe(20);
    expect(result.diagnostics.duplicateHitCount).toBe(1);
  });

  it('uses source priority as a deterministic tie breaker', async () => {
    const runtime = new FederatedSearchRuntime([
      source('low', response([hit('a', 10)]), { priority: 100 }),
      source('high', response([hit('b', 10)]), { priority: 1 }),
    ]);
    const result = await runtime.search({ request: { limit: 10 } });
    expect(result.results.map(item => item.sourceKey)).toEqual(['high', 'low']);
  });

  it('honors explicit source selection without invoking other registered sources', async () => {
    let aCalls = 0;
    let bCalls = 0;
    const runtime = new FederatedSearchRuntime([
      { key: 'a', search: async () => { aCalls += 1; return response([hit('a', 1)]); } },
      { key: 'b', search: async () => { bCalls += 1; return response([hit('b', 1)]); } },
    ]);
    const result = await runtime.search({ sourceKeys: ['b'], request: { query: 'x' } });
    expect(aCalls).toBe(0);
    expect(bCalls).toBe(1);
    expect(result.results.map(item => item.record.id)).toEqual(['b']);
  });

  it('returns partial results when one source fails', async () => {
    const runtime = new FederatedSearchRuntime([
      source('healthy', response([hit('1', 10)])),
      source('broken', async () => { throw new Error('backend unavailable'); }),
    ], { partialResults: true });
    const result = await runtime.search({ request: { query: 'place' } });

    expect(result.results.map(item => item.record.id)).toEqual(['1']);
    expect(result.diagnostics.completedSourceCount).toBe(1);
    expect(result.diagnostics.failedSourceCount).toBe(1);
    expect(result.diagnostics.sources.find(item => item.sourceKey === 'broken')?.errorName).toBe('Error');
  });

  it('fails the whole request when all sources are required', async () => {
    const runtime = new FederatedSearchRuntime([
      source('healthy', response([hit('1', 10)])),
      source('broken', async () => { throw new Error('backend unavailable'); }),
    ]);
    await expect(runtime.search({
      request: { query: 'place' },
      requireAllSources: true,
    })).rejects.toMatchObject({ name: 'FederatedSearchPartialFailureError' });
  });

  it('classifies a bounded source timeout and preserves healthy partial results', async () => {
    const runtime = new FederatedSearchRuntime([
      source('fast', response([hit('1', 10)]), { timeoutMs: 500 }),
      {
        key: 'slow',
        timeoutMs: 100,
        search: (_request, context) => new Promise<SearchResponse>((resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
          void resolve;
        }),
      },
    ], { sourceTimeoutMs: 100, defaultDeadlineMs: 1_000 });
    const result = await runtime.search({ request: { query: 'place' }, deadlineMs: 800 });

    expect(result.results.map(item => item.record.id)).toEqual(['1']);
    expect(result.diagnostics.timedOutSourceCount).toBe(1);
    expect(result.diagnostics.sources.find(item => item.sourceKey === 'slow')?.status).toBe('timed-out');
  });

  it('propagates caller cancellation into source execution', async () => {
    const controller = new AbortController();
    let observed = false;
    const runtime = new FederatedSearchRuntime([{
      key: 'blocking',
      search: (_request, context) => new Promise<SearchResponse>((resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          observed = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
        void resolve;
      }),
    }], { sourceTimeoutMs: 2_000 });
    const pending = runtime.search({ request: { query: 'x' }, signal: controller.signal });
    await delay(5);
    controller.abort();
    const result = await pending;
    expect(observed).toBe(true);
    expect(result.diagnostics.abortedSourceCount).toBe(1);
    expect(result.results).toEqual([]);
  });

  it('enforces the merged result cardinality budget', async () => {
    const runtime = new FederatedSearchRuntime([
      source('a', response(Array.from({ length: 5 }, (_, index) => hit(`a${index}`, 10 - index)))),
      source('b', response(Array.from({ length: 5 }, (_, index) => hit(`b${index}`, 10 - index)))),
    ], { maxMergedResults: 3, maxResultsPerSource: 10 });
    const result = await runtime.search({ request: { limit: 10 } });

    expect(result.diagnostics.deduplicatedHitCount).toBe(3);
    expect(result.diagnostics.truncatedByResultBudget).toBe(true);
    expect(result.results).toHaveLength(3);
  });

  it('enforces estimated memory budget before adding new unique hits', async () => {
    const huge = 'x'.repeat(10_000);
    const runtime = new FederatedSearchRuntime([
      source('a', response([
        hit('1', 10, { title: huge, address: huge }),
        hit('2', 9, { title: huge, address: huge }),
      ])),
    ], { maxEstimatedBytes: 16_384, maxMergedResults: 100 });
    const result = await runtime.search({ request: { limit: 100 } });

    expect(result.diagnostics.truncatedByByteBudget).toBe(true);
    expect(result.results.length).toBeLessThan(2);
  });

  it('globally paginates only after deterministic merge and dedupe', async () => {
    const runtime = new FederatedSearchRuntime([
      source('a', response([hit('1', 100), hit('3', 80), hit('5', 60)])),
      source('b', response([hit('2', 90), hit('4', 70), hit('6', 50)])),
    ]);
    const result = await runtime.search({ request: { offset: 2, limit: 2 } });
    expect(result.results.map(item => item.record.id)).toEqual(['3', '4']);
    expect(result.page).toMatchObject({ offset: 2, limit: 2, count: 2, total: 6, hasMore: true, nextOffset: 4 });
  });

  it('merges facet counts across successful sources', async () => {
    const runtime = new FederatedSearchRuntime([
      source('a', response([hit('1', 1)], { facets: { category: [{ value: 'Park', count: 2 }] } })),
      source('b', response([hit('2', 1)], { facets: { category: [{ value: 'Park', count: 3 }, { value: 'School', count: 1 }] } })),
    ]);
    const result = await runtime.search({ request: { facetFields: ['category'] } });
    expect(result.facets.category).toEqual([
      { value: 'Park', count: 5 },
      { value: 'School', count: 1 },
    ]);
  });

  it('does not expose raw exception messages in diagnostics', async () => {
    const runtime = new FederatedSearchRuntime([
      source('broken', async () => { throw Object.assign(new Error('secret endpoint token=abc'), { code: 'E_UPSTREAM' }); }),
    ]);
    const result = await runtime.search({ request: { query: 'x' } });
    const serialized = JSON.stringify(result.diagnostics);
    expect(serialized).not.toContain('secret endpoint');
    expect(serialized).not.toContain('token=abc');
    expect(serialized).toContain('E_UPSTREAM');
  });

  it('marks an older overlapping response stale once a newer sequence starts', async () => {
    let releaseFirst!: () => void;
    let call = 0;
    const runtime = new FederatedSearchRuntime([{
      key: 'source',
      search: async () => {
        call += 1;
        if (call === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
        return response([hit(String(call), call)]);
      },
    }], { workload: { maxConcurrent: 2 }, sourceTimeoutMs: 2_000 });

    const first = runtime.search({ request: { query: 'first' } });
    await delay(0);
    const second = await runtime.search({ request: { query: 'second' } });
    releaseFirst();
    const older = await first;
    expect(second.diagnostics.stale).toBe(false);
    expect(older.diagnostics.stale).toBe(true);
  });

  it('deduplicates identical concurrent source work through the workload governor', async () => {
    let calls = 0;
    let release!: () => void;
    const runtime = new FederatedSearchRuntime([{
      key: 'source',
      search: async () => {
        calls += 1;
        await new Promise<void>(resolve => { release = resolve; });
        return response([hit('1', 1)]);
      },
    }]);
    const first = runtime.search({ request: { query: 'same' } });
    const second = runtime.search({ request: { query: 'same' } });
    await delay(0);
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(runtime.getSnapshot().workload.dedupeHits).toBeGreaterThanOrEqual(1);
  });

  it('rejects a request that violates source fan-out policy before calling adapters', async () => {
    let calls = 0;
    const runtime = new FederatedSearchRuntime([
      source('a', () => { calls += 1; return response([]); }),
      source('b', () => { calls += 1; return response([]); }),
    ], { requestPolicy: { maxSourceKeys: 1 } });
    await expect(runtime.search({ sourceKeys: ['a', 'b'] })).rejects.toMatchObject({ name: 'SearchRequestPolicyError' });
    expect(calls).toBe(0);
  });

  it('supports registration, replacement and removal of sources', async () => {
    const runtime = new FederatedSearchRuntime();
    runtime.registerSource(source('a', response([hit('1', 1)])));
    expect(runtime.listSourceKeys()).toEqual(['a']);
    runtime.registerSource(source('a', response([hit('2', 2)])));
    const replaced = await runtime.search({ sourceKeys: ['a'] });
    expect(replaced.results[0]?.record.id).toBe('2');
    expect(runtime.unregisterSource('A')).toBe(true);
    expect(runtime.listSourceKeys()).toEqual([]);
  });

  it('enforces source registry capacity', () => {
    const runtime = new FederatedSearchRuntime([], { maxSources: 1 });
    runtime.registerSource(source('a', response([])));
    expect(() => runtime.registerSource(source('b', response([])))).toThrowError(/capacity/);
  });

  it('rejects invalid source identities', () => {
    expect(() => new FederatedSearchRuntime([
      source('../remote', response([])),
    ])).toThrow(TypeError);
  });

  it('disposes owned workload resources and rejects later searches', async () => {
    const runtime = new FederatedSearchRuntime([source('a', response([]))]);
    runtime.dispose();
    expect(runtime.getSnapshot().disposed).toBe(true);
    await expect(runtime.search()).rejects.toThrow(/disposed/);
  });
});
