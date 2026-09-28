import { describe, expect, it } from 'vitest';
import type { NormalizedRecord, SpatialHit } from './contracts';
import { normalizeRecordCollection } from './normalization';
import { RevisionedSearchCache } from './revisionedSearchCache';
import { SchemaRegistryRuntime } from './schemaRegistryRuntime';
import {
  createSpatialCursorPage,
  createSpatialQueryFingerprint,
  decodeSpatialCursor,
  encodeSpatialCursor,
  spatialHitTuple,
  SpatialCursorError,
} from './spatialCursorRuntime';
import { DataSearchGovernanceRuntime } from './dataSearchGovernanceRuntime';

const baseRows = Object.freeze([
  {
    id: 1,
    name: 'Atatürk Parkı',
    category: 'Park',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    latitude: 39.9208,
    longitude: 32.8541,
  },
  {
    id: 2,
    name: 'Kültür Merkezi',
    category: 'Kültür',
    type: 'Kültür Merkezi',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    latitude: 39.9412,
    longitude: 32.8548,
  },
  {
    id: 3,
    name: 'Şehir Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Keçiören',
    neighborhood: 'Etlik',
    latitude: 39.988,
    longitude: 32.833,
  },
]);

const normalizedRows = (): readonly NormalizedRecord[] => normalizeRecordCollection(baseRows).records;

const spatialHits = (): readonly SpatialHit<NormalizedRecord>[] => {
  const rows = normalizedRows();
  return Object.freeze([
    Object.freeze({ record: rows[0]!, distanceMeters: 100 }),
    Object.freeze({ record: rows[1]!, distanceMeters: 100 }),
    Object.freeze({ record: rows[2]!, distanceMeters: 250 }),
  ]);
};

describe('SchemaRegistryRuntime production governance', () => {
  it('accepts an initial schema contract and assigns revision one', () => {
    const runtime = new SchemaRegistryRuntime({ mode: 'strict' });
    const result = runtime.register({
      datasetKey: 'places',
      version: '1.0.0',
      records: baseRows,
    });

    expect(result.decision).toBe('accepted');
    expect(result.previousRevision).toBe(0);
    expect(result.nextRevision).toBe(1);
    expect(runtime.contract('places')).toMatchObject({
      datasetKey: 'places',
      version: '1.0.0',
      revision: 1,
    });
  });

  it('returns unchanged for the same profile without incrementing revision', () => {
    const runtime = new SchemaRegistryRuntime({ mode: 'strict' });
    runtime.register({ datasetKey: 'places', version: '1', records: baseRows });
    const second = runtime.register({ datasetKey: 'places', version: '1', records: baseRows });

    expect(second.decision).toBe('unchanged');
    expect(second.previousRevision).toBe(1);
    expect(second.nextRevision).toBe(1);
    expect(runtime.contract('places')?.revision).toBe(1);
  });

  it('rejects removed required fields under strict compatibility', () => {
    const runtime = new SchemaRegistryRuntime({ mode: 'strict' });
    runtime.register({
      datasetKey: 'places',
      version: '1',
      records: [
        { id: 1, name: 'A', category: 'Park' },
        { id: 2, name: 'B', category: 'Sağlık' },
      ],
    });
    const result = runtime.register({
      datasetKey: 'places',
      version: '2',
      records: [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
      ],
      expectedRevision: 1,
    });

    expect(result.decision).toBe('rejected');
    expect(result.compatibility).toBe('breaking');
    expect(result.violations).toEqual(expect.arrayContaining([
      'breaking-schema-drift',
      expect.stringMatching(/^breaking-change-budget:/),
    ]));
    expect(runtime.contract('places')?.revision).toBe(1);
  });

  it('can observe breaking drift without mutating validation thresholds', () => {
    const runtime = new SchemaRegistryRuntime({ mode: 'observe' });
    runtime.register({
      datasetKey: 'places',
      version: '1',
      records: [{ id: 1, requiredField: 'x' }],
    });
    const result = runtime.register({
      datasetKey: 'places',
      version: '2',
      records: [{ id: 1 }],
    });

    expect(result.compatibility).toBe('breaking');
    expect(result.decision).toBe('accepted');
    expect(result.violations.length).toBeGreaterThan(0);
    expect(runtime.contract('places')?.revision).toBe(2);
  });

  it('enforces optimistic revision checks', () => {
    const runtime = new SchemaRegistryRuntime();
    runtime.register({ datasetKey: 'places', version: '1', records: baseRows });
    const conflict = runtime.register({
      datasetKey: 'places',
      version: '2',
      records: baseRows,
      expectedRevision: 99,
    });

    expect(conflict.decision).toBe('rejected');
    expect(conflict.violations).toContain('revision-conflict:expected=99:actual=1');
  });

  it('enforces required semantic alias coverage', () => {
    const runtime = new SchemaRegistryRuntime({
      requireAliasCoverage: ['id', 'title'],
    });
    const result = runtime.register({
      datasetKey: 'places',
      version: '1',
      records: [{ OBJECTID: 1, ADI: 'Park' }],
      aliases: {
        id: ['OBJECTID'],
        title: ['UNKNOWN_TITLE'],
      },
    });

    expect(result.decision).toBe('rejected');
    expect(result.violations).toContain('alias-coverage-missing:title');
  });

  it('bounds history per dataset', () => {
    const runtime = new SchemaRegistryRuntime({
      mode: 'observe',
      maxHistoryPerDataset: 2,
    });
    runtime.register({ datasetKey: 'places', version: '1', records: [{ a: 1 }] });
    runtime.register({ datasetKey: 'places', version: '2', records: [{ a: 1, b: 2 }] });
    runtime.register({ datasetKey: 'places', version: '3', records: [{ a: 1, b: 2, c: 3 }] });

    expect(runtime.history('places')).toHaveLength(2);
    expect(runtime.snapshot().historyCount).toBe(2);
  });
});

describe('RevisionedSearchCache production governance', () => {
  it('keys cache entries by dataset revision and fingerprint', () => {
    let now = 1_000;
    const cache = new RevisionedSearchCache<string>({
      ttlMs: 1_000,
      clock: () => now,
    });
    const base = {
      requestFingerprint: 'request-a',
      dataset: { datasetKey: 'places', revision: 1, fingerprint: 'dataset-a' },
    } as const;

    expect(cache.set(base, 'value').stored).toBe(true);
    expect(cache.get(base).value).toBe('value');
    expect(cache.get({
      ...base,
      dataset: { ...base.dataset, revision: 2 },
    }).hit).toBe(false);
    expect(cache.get({
      ...base,
      dataset: { ...base.dataset, fingerprint: 'dataset-b' },
    }).hit).toBe(false);

    now += 1_001;
    const expired = cache.get(base);
    expect(expired.hit).toBe(false);
    expect(expired.stale).toBe(true);
  });

  it('enforces LRU entry budgets', () => {
    let now = 100;
    const cache = new RevisionedSearchCache<number>({
      maxEntries: 2,
      ttlMs: 0,
      clock: () => now,
    });
    const dataset = { datasetKey: 'places', revision: 1, fingerprint: 'fp' } as const;

    cache.set({ dataset, requestFingerprint: 'a' }, 1);
    now += 1;
    cache.set({ dataset, requestFingerprint: 'b' }, 2);
    now += 1;
    expect(cache.get({ dataset, requestFingerprint: 'a' }).value).toBe(1);
    now += 1;
    cache.set({ dataset, requestFingerprint: 'c' }, 3);

    expect(cache.get({ dataset, requestFingerprint: 'a' }).hit).toBe(true);
    expect(cache.get({ dataset, requestFingerprint: 'b' }).hit).toBe(false);
    expect(cache.get({ dataset, requestFingerprint: 'c' }).hit).toBe(true);
  });

  it('rejects oversized entries without poisoning the cache', () => {
    const cache = new RevisionedSearchCache<string>({
      maxBytes: 1_024,
      maxEntryBytes: 64,
      ttlMs: 0,
    });
    const result = cache.set({
      dataset: { datasetKey: 'places', revision: 1, fingerprint: 'fp' },
      requestFingerprint: 'huge',
    }, 'x'.repeat(1_000));

    expect(result).toMatchObject({ stored: false, reason: 'entry-too-large' });
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().rejectedWrites).toBe(1);
  });

  it('invalidates every stale revision for one dataset', () => {
    const cache = new RevisionedSearchCache<number>({ ttlMs: 0 });
    const dataset1 = { datasetKey: 'places', revision: 1, fingerprint: 'one' } as const;
    const dataset2 = { datasetKey: 'places', revision: 2, fingerprint: 'two' } as const;

    cache.set({ dataset: dataset1, requestFingerprint: 'a' }, 1);
    cache.set({ dataset: dataset2, requestFingerprint: 'b' }, 2);

    expect(cache.invalidateRevision('places', 2, 'two')).toBe(1);
    expect(cache.get({ dataset: dataset1, requestFingerprint: 'a' }).hit).toBe(false);
    expect(cache.get({ dataset: dataset2, requestFingerprint: 'b' }).hit).toBe(true);
  });
});

describe('Spatial cursor production governance', () => {
  const context = Object.freeze({
    dataset: {
      datasetKey: 'places',
      revision: 7,
      fingerprint: 'dataset-fingerprint',
    },
    queryFingerprint: 'query-fingerprint',
    now: 5_000,
  });

  it('encodes and decodes deterministic cursor payloads', () => {
    const token = encodeSpatialCursor({
      version: 1,
      datasetKey: 'places',
      datasetRevision: 7,
      datasetFingerprint: 'dataset-fingerprint',
      queryFingerprint: 'query-fingerprint',
      limit: 20,
      issuedAt: 5_000,
      after: {
        distanceMicrometers: 100_000_000,
        sourceIndex: 1,
        recordFingerprint: 'record-b',
      },
    });

    expect(token).toMatch(/^dss1\./);
    expect(decodeSpatialCursor(token)).toMatchObject({
      datasetKey: 'places',
      datasetRevision: 7,
      limit: 20,
      after: { sourceIndex: 1, recordFingerprint: 'record-b' },
    });
  });

  it('pages equal-distance hits using source index and fingerprint as keyset tiebreakers', () => {
    const hits = spatialHits();
    const first = createSpatialCursorPage(hits, context, { limit: 1 });
    const second = createSpatialCursorPage(hits, context, {
      cursor: first.nextCursor,
    });
    const third = createSpatialCursorPage(hits, context, {
      cursor: second.nextCursor,
    });

    expect(first.items[0]?.record.id).toBe('1');
    expect(second.items[0]?.record.id).toBe('2');
    expect(third.items[0]?.record.id).toBe('3');
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
  });

  it('rejects stale revision cursors', () => {
    const first = createSpatialCursorPage(spatialHits(), context, { limit: 1 });
    expect(() => createSpatialCursorPage(spatialHits(), {
      ...context,
      dataset: { ...context.dataset, revision: 8 },
    }, { cursor: first.nextCursor })).toThrowError(SpatialCursorError);
  });

  it('rejects query mismatches instead of silently reusing windows', () => {
    const first = createSpatialCursorPage(spatialHits(), context, { limit: 1 });
    expect(() => createSpatialCursorPage(spatialHits(), {
      ...context,
      queryFingerprint: 'different-query',
    }, { cursor: first.nextCursor })).toThrowError(/different spatial query/);
  });

  it('produces stable spatial query fingerprints', () => {
    const first = createSpatialQueryFingerprint({
      center: [32.85, 39.92],
      radiusMeters: 5_000,
      filters: [{ field: 'category', operator: 'eq', values: ['Park'] }],
    });
    const second = createSpatialQueryFingerprint({
      center: [32.85, 39.92],
      radiusMeters: 5_000,
      filters: [{ field: 'category', operator: 'eq', values: ['Park'] }],
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^fnv1a-/);
  });

  it('converts hit ordering into stable cursor tuples', () => {
    const tuple = spatialHitTuple(spatialHits()[0]!);
    expect(tuple.distanceMicrometers).toBe(100_000_000);
    expect(tuple.sourceIndex).toBe(0);
    expect(tuple.recordFingerprint).toMatch(/^fnv1a-/);
  });
});

describe('DataSearchGovernanceRuntime integration', () => {
  it('registers a dataset through schema, normalization, category and filter boundaries', () => {
    const runtime = new DataSearchGovernanceRuntime({
      categoryEntries: [
        { key: 'green-space', label: 'Yeşil Alan', aliases: ['Park'], typeAliases: ['Kent Parkı'] },
        { key: 'culture', label: 'Kültür', aliases: ['Kültür'] },
        { key: 'health', label: 'Sağlık', aliases: ['Sağlık'], typeAliases: ['Hastane'] },
      ],
      schema: { mode: 'observe' },
    });

    const registration = runtime.registerDataset({
      key: 'places',
      version: '2026.09',
      records: baseRows,
    });

    expect(registration.accepted).toBe(true);
    expect(registration.snapshot?.recordCount).toBe(3);
    expect(registration.snapshot?.revision).toBe(1);
    expect(registration.snapshot?.categoryCoverage.coverageRatio).toBe(1);
    expect(registration.snapshot?.filterIndexFingerprint).toMatch(/^fnv1a-/);
  });

  it('uses the filter index to narrow candidate records', () => {
    const runtime = new DataSearchGovernanceRuntime({ schema: { mode: 'observe' } });
    runtime.registerDataset({ key: 'places', version: '1', records: baseRows });

    const plan = runtime.planFilters('places', [
      { field: 'district', operator: 'eq', values: ['Çankaya'] },
    ]);
    const candidates = runtime.candidateRecords('places', [
      { field: 'district', operator: 'eq', values: ['Çankaya'] },
    ]);

    expect(plan.positions).toEqual([0]);
    expect(candidates.map(record => record.id)).toEqual(['1']);
  });

  it('invalidates revision-bound cached values after a dataset change', () => {
    const runtime = new DataSearchGovernanceRuntime({
      schema: { mode: 'observe' },
      cache: { ttlMs: 0 },
    });
    runtime.registerDataset({ key: 'places', version: '1', records: baseRows });
    expect(runtime.cacheSet('places', 'request', { ok: true }).stored).toBe(true);
    expect(runtime.cacheGet<{ ok: boolean }>('places', 'request').hit).toBe(true);

    const changedRows = [...baseRows, {
      id: 4,
      name: 'Yeni Nokta',
      category: 'Park',
      type: 'Kent Parkı',
      district: 'Mamak',
    }];
    const registration = runtime.registerDataset({
      key: 'places',
      version: '2',
      records: changedRows,
    });

    expect(registration.snapshot?.revision).toBe(2);
    expect(registration.invalidatedCacheEntries).toBeGreaterThanOrEqual(1);
    expect(runtime.cacheGet('places', 'request').hit).toBe(false);
  });

  it('creates revision-safe spatial windows through the composed runtime', () => {
    const runtime = new DataSearchGovernanceRuntime({ schema: { mode: 'observe' } });
    runtime.registerDataset({ key: 'places', version: '1', records: baseRows });
    const hits = spatialHits();

    const first = runtime.spatialPage('places', hits, 'nearby', { limit: 2, now: 100 });
    const second = runtime.spatialPage('places', hits, 'nearby', {
      cursor: first.nextCursor,
      now: 100,
    });

    expect(first.items.map(item => item.record.id)).toEqual(['1', '2']);
    expect(second.items.map(item => item.record.id)).toEqual(['3']);
    expect(second.hasMore).toBe(false);
  });

  it('reports a deterministic composed governance snapshot', () => {
    const runtime = new DataSearchGovernanceRuntime({ schema: { mode: 'observe' } });
    runtime.registerDataset({ key: 'places', version: '1', records: baseRows });
    const first = runtime.snapshot();
    const second = runtime.snapshot();

    expect(first.datasetCount).toBe(1);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.schemaFingerprint).toMatch(/^fnv1a-/);
    expect(first.cacheFingerprint).toMatch(/^fnv1a-/);
  });
});
