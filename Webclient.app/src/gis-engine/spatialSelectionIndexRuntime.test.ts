import { describe, expect, it } from 'vitest';
import {
  SpatialSelectionIndexError,
  SpatialSelectionIndexRuntime,
  createSpatialSelectionIndexRuntime,
  normalizeSpatialSelectionIndexPolicy,
  type SelectionBounds,
  type SelectionPriority,
  type SpatialSelectionRecord,
} from './spatialSelectionIndexRuntime';

type Payload = Readonly<{
  label: string;
  ordinal: number;
}>;

const bounds = (
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
): SelectionBounds => ({ xmin, ymin, xmax, ymax });

const selection = (
  id: string,
  overrides: Partial<Omit<SpatialSelectionRecord<Payload>, 'revision'>> = {},
): Omit<SpatialSelectionRecord<Payload>, 'revision'> => ({
  id,
  layerId: overrides.layerId ?? 'places',
  bounds: overrides.bounds ?? bounds(0, 0, 10, 10),
  priority: overrides.priority ?? 'normal',
  payload: overrides.payload ?? { label: id, ordinal: Number(id.replace(/\D/gu, '')) || 0 },
  estimatedBytes: overrides.estimatedBytes ?? 100,
});

const ids = (
  records: readonly SpatialSelectionRecord<unknown>[],
): readonly string[] => records.map((record) => record.id);

const expectCode = (
  action: () => unknown,
  code: string,
): void => {
  try {
    action();
    throw new Error('expected action to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(SpatialSelectionIndexError);
    expect((error as SpatialSelectionIndexError).code).toBe(code);
  }
};

describe('normalizeSpatialSelectionIndexPolicy', () => {
  it('publishes production-safe bounded defaults', () => {
    expect(normalizeSpatialSelectionIndexPolicy()).toEqual({
      maxEntries: 25_000,
      maxBytes: 64 * 1024 * 1024,
      maxEntriesPerLayer: 5_000,
      maxBytesPerLayer: 16 * 1024 * 1024,
      maxLayers: 256,
      maxQueryResults: 1_000,
      maxQueryCandidates: 10_000,
      maxHistory: 512,
      maxIdLength: 512,
      maxLayerIdLength: 256,
      gridCellSize: 1_000,
      maxGridCells: 100_000,
      maxGridReferences: 500_000,
      maxCellsPerRecord: 4_096,
      maxGridBucketSize: 10_000,
      nearestInitialRadius: 250,
      nearestMaxRadius: 30_000,
      nearestExpansionSteps: 10,
      degradedBudgetRatio: 0.72,
      blockedBudgetRatio: 0.92,
    });
  });

  it('shrinks dependent defaults when global entry capacity is small', () => {
    const policy = normalizeSpatialSelectionIndexPolicy({ maxEntries: 3 });
    expect(policy.maxEntries).toBe(3);
    expect(policy.maxEntriesPerLayer).toBe(3);
    expect(policy.maxQueryResults).toBe(3);
    expect(policy.maxQueryCandidates).toBe(3);
  });

  it('shrinks the per-layer byte default when global memory capacity is small', () => {
    const policy = normalizeSpatialSelectionIndexPolicy({ maxBytes: 1_024 });
    expect(policy.maxBytes).toBe(1_024);
    expect(policy.maxBytesPerLayer).toBe(1_024);
  });

  it('accepts explicit safe sub-budgets', () => {
    const policy = normalizeSpatialSelectionIndexPolicy({
      maxEntries: 100,
      maxEntriesPerLayer: 20,
      maxQueryResults: 10,
      maxQueryCandidates: 40,
      maxBytes: 10_000,
      maxBytesPerLayer: 2_000,
      maxLayers: 8,
      maxHistory: 32,
    });
    expect(policy).toMatchObject({
      maxEntries: 100,
      maxEntriesPerLayer: 20,
      maxQueryResults: 10,
      maxQueryCandidates: 40,
      maxBytes: 10_000,
      maxBytesPerLayer: 2_000,
      maxLayers: 8,
      maxHistory: 32,
    });
  });

  it('rejects per-layer entry capacity larger than global capacity', () => {
    expect(() => normalizeSpatialSelectionIndexPolicy({
      maxEntries: 10,
      maxEntriesPerLayer: 11,
    })).toThrow(/maxEntriesPerLayer/u);
  });

  it('rejects per-layer byte capacity larger than global capacity', () => {
    expect(() => normalizeSpatialSelectionIndexPolicy({
      maxBytes: 1_000,
      maxBytesPerLayer: 1_001,
    })).toThrow(/maxBytesPerLayer/u);
  });

  it('rejects initial nearest radius larger than maximum radius', () => {
    expect(() => normalizeSpatialSelectionIndexPolicy({
      nearestInitialRadius: 100,
      nearestMaxRadius: 50,
    })).toThrow(/nearestInitialRadius/u);
  });

  it('rejects inverted health thresholds', () => {
    expect(() => normalizeSpatialSelectionIndexPolicy({
      degradedBudgetRatio: 0.9,
      blockedBudgetRatio: 0.8,
    })).toThrow(/degradedBudgetRatio/u);
  });

  it('rejects equal health thresholds to preserve a degraded band', () => {
    expect(() => normalizeSpatialSelectionIndexPolicy({
      degradedBudgetRatio: 0.8,
      blockedBudgetRatio: 0.8,
    })).toThrow(/degradedBudgetRatio/u);
  });

  it('rejects non-positive and unsafe numeric budgets', () => {
    expect(() => normalizeSpatialSelectionIndexPolicy({ maxEntries: 0 })).toThrow(/maxEntries/u);
    expect(() => normalizeSpatialSelectionIndexPolicy({ maxBytes: -1 })).toThrow(/maxBytes/u);
    expect(() => normalizeSpatialSelectionIndexPolicy({
      maxHistory: Number.MAX_SAFE_INTEGER,
    })).toThrow(/maxHistory/u);
  });
});

describe('SpatialSelectionIndexRuntime record integrity', () => {
  it('indexes and retrieves a normalized record', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    const inserted = runtime.upsert(selection('a'));

    expect(inserted).toMatchObject({
      id: 'a',
      layerId: 'places',
      priority: 'normal',
      estimatedBytes: 100,
      revision: 1,
    });
    expect(runtime.has('a')).toBe(true);
    expect(runtime.get('a')?.payload.label).toBe('a');
    expect(runtime.size).toBe(1);
  });

  it('normalizes surrounding identifier whitespace without changing stable identity', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('  feature-a  ', { layerId: '  parks  ' }));

    expect(runtime.has('feature-a')).toBe(true);
    expect(runtime.get('feature-a')).toMatchObject({
      id: 'feature-a',
      layerId: 'parks',
    });
  });

  it('normalizes negative-zero bounds', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    const inserted = runtime.upsert(selection('zero', {
      bounds: bounds(-0, -0, 1, 1),
    }));

    expect(Object.is(inserted?.bounds.xmin, -0)).toBe(false);
    expect(Object.is(inserted?.bounds.ymin, -0)).toBe(false);
  });

  it('rejects an empty record identity', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    expectCode(() => runtime.upsert(selection('   ')), 'INVALID_ID');
  });

  it('rejects an overlong record identity', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxIdLength: 4 });
    expectCode(() => runtime.upsert(selection('abcde')), 'INVALID_ID');
  });

  it('rejects an empty layer identity', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    expectCode(() => runtime.upsert(selection('a', { layerId: '   ' })), 'INVALID_LAYER_ID');
  });

  it('rejects an overlong layer identity', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxLayerIdLength: 4 });
    expectCode(() => runtime.upsert(selection('a', { layerId: 'abcde' })), 'INVALID_LAYER_ID');
  });

  it('rejects inverted bounds', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    expectCode(() => runtime.upsert(selection('a', {
      bounds: bounds(2, 0, 1, 1),
    })), 'INVALID_BOUNDS');
  });

  it('rejects non-finite bounds', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    expectCode(() => runtime.upsert(selection('a', {
      bounds: bounds(0, 0, Number.POSITIVE_INFINITY, 1),
    })), 'INVALID_BOUNDS');
  });

  it('rejects a non-positive byte estimate', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    expectCode(() => runtime.upsert(selection('a', {
      estimatedBytes: 0,
    })), 'INVALID_ESTIMATED_BYTES');
  });

  it('rejects a non-safe-integer byte estimate', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    expectCode(() => runtime.upsert(selection('a', {
      estimatedBytes: 1.5,
    })), 'INVALID_ESTIMATED_BYTES');
  });

  it('rejects an invalid priority at the runtime boundary', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    expectCode(() => runtime.upsert(selection('a', {
      priority: 'urgent' as SelectionPriority,
    })), 'INVALID_PRIORITY');
  });

  it('returns null for a record larger than the global byte budget', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxBytes: 100,
      maxBytesPerLayer: 100,
    });
    expect(runtime.upsert(selection('huge', { estimatedBytes: 101 }))).toBeNull();
    expect(runtime.snapshot()).toMatchObject({
      entries: 0,
      rejected: 1,
    });
  });

  it('returns null for a record larger than the per-layer byte budget', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxBytes: 1_000,
      maxBytesPerLayer: 100,
    });
    expect(runtime.upsert(selection('huge', { estimatedBytes: 101 }))).toBeNull();
    expect(runtime.snapshot()).toMatchObject({
      entries: 0,
      rejected: 1,
    });
  });

  it('maps underlying grid cell-budget failures to a stable runtime error', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      gridCellSize: 1,
      maxCellsPerRecord: 4,
    });
    expectCode(() => runtime.upsert(selection('wide', {
      bounds: bounds(0, 0, 10, 10),
    })), 'GRID_BUDGET_EXCEEDED');
    expect(runtime.snapshot().rejected).toBe(1);
  });
});

describe('SpatialSelectionIndexRuntime replacement accounting', () => {
  it('replaces the same identity without leaking global bytes', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxBytes: 10_000,
    });
    runtime.upsert(selection('same', { estimatedBytes: 400 }));
    runtime.upsert(selection('same', { estimatedBytes: 125, priority: 'high' }));

    expect(runtime.snapshot()).toMatchObject({
      entries: 1,
      estimatedBytes: 125,
    });
    expect(runtime.get('same')).toMatchObject({
      estimatedBytes: 125,
      priority: 'high',
      revision: 2,
    });
  });

  it('moves the same identity across layers without leaving stale layer accounting', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('same', { layerId: 'old', estimatedBytes: 300 }));
    runtime.upsert(selection('same', { layerId: 'new', estimatedBytes: 120 }));

    expect(runtime.layerSnapshots()).toEqual([
      expect.objectContaining({
        layerId: 'new',
        entries: 1,
        estimatedBytes: 120,
      }),
    ]);
    expect(runtime.recordsForLayer('old')).toEqual([]);
    expect(ids(runtime.recordsForLayer('new'))).toEqual(['same']);
  });

  it('updates grid cells when replacement bounds move', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      gridCellSize: 10,
    });
    runtime.upsert(selection('move', { bounds: bounds(0, 0, 1, 1) }));
    runtime.upsert(selection('move', { bounds: bounds(100, 100, 101, 101) }));

    expect(ids(runtime.query({ bounds: bounds(0, 0, 2, 2) }).records)).toEqual([]);
    expect(ids(runtime.query({ bounds: bounds(99, 99, 102, 102) }).records)).toEqual(['move']);
  });

  it('increments revision once for each successful upsert before budget evictions', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
    });
    const first = runtime.upsert(selection('a'));
    const second = runtime.upsert(selection('b'));

    expect(first?.revision).toBe(1);
    expect(second?.revision).toBe(2);
    expect(runtime.snapshot().revision).toBe(2);
  });
});

describe('SpatialSelectionIndexRuntime deterministic eviction', () => {
  it('evicts lower priority before higher priority at the global entry limit', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 2 });
    runtime.upsert(selection('critical', { priority: 'critical' }));
    runtime.upsert(selection('background', { priority: 'background' }));
    runtime.upsert(selection('high', { priority: 'high' }));

    expect(runtime.has('critical')).toBe(true);
    expect(runtime.has('high')).toBe(true);
    expect(runtime.has('background')).toBe(false);
    expect(runtime.snapshot().evictions).toBe(1);
  });

  it('evicts least-recently-used among records with equal priority', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 2 });
    runtime.upsert(selection('a'));
    runtime.upsert(selection('b'));
    expect(runtime.get('a')?.id).toBe('a');

    runtime.upsert(selection('c'));

    expect(runtime.has('a')).toBe(true);
    expect(runtime.has('b')).toBe(false);
    expect(runtime.has('c')).toBe(true);
  });

  it('uses stable insertion order when equal-priority records have not been touched', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 2 });
    runtime.upsert(selection('a'));
    runtime.upsert(selection('b'));
    runtime.upsert(selection('c'));

    expect(runtime.has('a')).toBe(false);
    expect(runtime.has('b')).toBe(true);
    expect(runtime.has('c')).toBe(true);
  });

  it('enforces the global byte budget with deterministic eviction', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxBytes: 200,
      maxBytesPerLayer: 200,
    });
    runtime.upsert(selection('low', { priority: 'background', estimatedBytes: 100 }));
    runtime.upsert(selection('high', { priority: 'high', estimatedBytes: 100 }));
    runtime.upsert(selection('new', { priority: 'normal', estimatedBytes: 100 }));

    expect(runtime.snapshot().estimatedBytes).toBeLessThanOrEqual(200);
    expect(runtime.has('low')).toBe(false);
    expect(runtime.has('high')).toBe(true);
    expect(runtime.has('new')).toBe(true);
    expect(runtime.history().some((event) => event.reason === 'global-byte-budget')).toBe(true);
  });

  it('enforces per-layer cardinality without evicting unrelated layers', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxEntriesPerLayer: 2,
    });
    runtime.upsert(selection('a1', { layerId: 'a', priority: 'background' }));
    runtime.upsert(selection('a2', { layerId: 'a', priority: 'high' }));
    runtime.upsert(selection('b1', { layerId: 'b', priority: 'normal' }));
    runtime.upsert(selection('a3', { layerId: 'a', priority: 'normal' }));

    expect(ids(runtime.recordsForLayer('a'))).toEqual(['a2', 'a3']);
    expect(ids(runtime.recordsForLayer('b'))).toEqual(['b1']);
    expect(runtime.history().some((event) => event.reason === 'layer-entry-budget')).toBe(true);
  });

  it('enforces per-layer bytes without affecting a separate layer', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxBytes: 1_000,
      maxBytesPerLayer: 200,
    });
    runtime.upsert(selection('a1', {
      layerId: 'a',
      priority: 'background',
      estimatedBytes: 120,
    }));
    runtime.upsert(selection('b1', {
      layerId: 'b',
      estimatedBytes: 120,
    }));
    runtime.upsert(selection('a2', {
      layerId: 'a',
      priority: 'critical',
      estimatedBytes: 120,
    }));

    expect(runtime.has('a1')).toBe(false);
    expect(runtime.has('a2')).toBe(true);
    expect(runtime.has('b1')).toBe(true);
    expect(runtime.history().some((event) => event.reason === 'layer-byte-budget')).toBe(true);
  });

  it('evicts the weakest layer when the layer-count budget is exceeded', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxLayers: 2,
    });
    runtime.upsert(selection('critical', {
      layerId: 'critical-layer',
      priority: 'critical',
    }));
    runtime.upsert(selection('background', {
      layerId: 'background-layer',
      priority: 'background',
    }));
    runtime.upsert(selection('normal', {
      layerId: 'normal-layer',
      priority: 'normal',
    }));

    expect(runtime.layerSnapshots().map((layer) => layer.layerId).sort()).toEqual([
      'critical-layer',
      'normal-layer',
    ]);
    expect(runtime.has('background')).toBe(false);
    expect(runtime.history().some((event) => event.reason === 'layer-count-budget')).toBe(true);
  });

  it('can reject a newly inserted low-value record by evicting it immediately', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 1 });
    expect(runtime.upsert(selection('critical', { priority: 'critical' }))).not.toBeNull();

    const inserted = runtime.upsert(selection('background', { priority: 'background' }));

    expect(inserted).toBeNull();
    expect(runtime.has('critical')).toBe(true);
    expect(runtime.has('background')).toBe(false);
    expect(runtime.snapshot()).toMatchObject({
      entries: 1,
      rejected: 1,
      evictions: 1,
    });
  });

  it('retains a new critical record by evicting an older background record', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 1 });
    runtime.upsert(selection('background', { priority: 'background' }));

    const inserted = runtime.upsert(selection('critical', { priority: 'critical' }));

    expect(inserted?.id).toBe('critical');
    expect(runtime.has('background')).toBe(false);
    expect(runtime.has('critical')).toBe(true);
  });
});

describe('SpatialSelectionIndexRuntime extent queries', () => {
  it('returns only records intersecting the requested bounds', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ gridCellSize: 10 });
    runtime.upsert(selection('inside', { bounds: bounds(0, 0, 5, 5) }));
    runtime.upsert(selection('edge', { bounds: bounds(10, 10, 20, 20) }));
    runtime.upsert(selection('outside', { bounds: bounds(100, 100, 110, 110) }));

    const result = runtime.query({ bounds: bounds(4, 4, 12, 12) });

    expect(ids(result.records)).toEqual(['edge', 'inside']);
    expect(result.diagnostics).toMatchObject({
      kind: 'extent',
      matched: 2,
      returned: 2,
      gridQueries: 1,
    });
  });

  it('orders query matches by priority before recency', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('normal', { priority: 'normal' }));
    runtime.upsert(selection('critical', { priority: 'critical' }));
    runtime.upsert(selection('high', { priority: 'high' }));

    expect(ids(runtime.query({ bounds: bounds(0, 0, 10, 10) }).records)).toEqual([
      'critical',
      'high',
      'normal',
    ]);
  });

  it('uses recency within equal query priority', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('a'));
    runtime.upsert(selection('b'));
    runtime.get('a');

    expect(ids(runtime.query({ bounds: bounds(0, 0, 10, 10) }).records)).toEqual([
      'a',
      'b',
    ]);
  });

  it('filters by a bounded layer set', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('park', { layerId: 'parks' }));
    runtime.upsert(selection('road', { layerId: 'roads' }));

    const result = runtime.query({
      bounds: bounds(0, 0, 10, 10),
      layerIds: new Set(['parks']),
    });

    expect(ids(result.records)).toEqual(['park']);
    expect(result.diagnostics.filteredByLayer).toBe(1);
  });

  it('normalizes layer filters before matching', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('park', { layerId: 'parks' }));

    expect(ids(runtime.query({
      bounds: bounds(0, 0, 10, 10),
      layerIds: new Set(['  parks  ']),
    }).records)).toEqual(['park']);
  });

  it('filters by minimum priority', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('background', { priority: 'background' }));
    runtime.upsert(selection('normal', { priority: 'normal' }));
    runtime.upsert(selection('high', { priority: 'high' }));
    runtime.upsert(selection('critical', { priority: 'critical' }));

    const result = runtime.query({
      bounds: bounds(0, 0, 10, 10),
      minimumPriority: 'high',
    });

    expect(ids(result.records)).toEqual(['critical', 'high']);
    expect(result.diagnostics.filteredByPriority).toBe(2);
  });

  it('caps caller result limits to the configured maximum', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxQueryResults: 2,
      maxQueryCandidates: 10,
    });
    runtime.upsert(selection('a'));
    runtime.upsert(selection('b'));
    runtime.upsert(selection('c'));

    const result = runtime.query({
      bounds: bounds(0, 0, 10, 10),
      limit: 99,
    });

    expect(result.records).toHaveLength(2);
    expect(result.diagnostics.truncated).toBe(true);
  });

  it('bounds candidate work independently from returned result count', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxQueryResults: 2,
      maxQueryCandidates: 3,
    });
    ['a', 'b', 'c', 'd', 'e'].map((id) => runtime.upsert(selection(id)));

    const result = runtime.query({
      bounds: bounds(0, 0, 10, 10),
      limit: 2,
    });

    expect(result.diagnostics.candidates).toBeLessThanOrEqual(3);
    expect(result.records).toHaveLength(2);
    expect(result.diagnostics.truncated).toBe(true);
  });

  it('rejects a pre-aborted extent query', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    const controller = new AbortController();
    controller.abort('stale-view');

    expectCode(() => runtime.query({
      bounds: bounds(0, 0, 10, 10),
      signal: controller.signal,
    }), 'ABORTED');
  });

  it('maps an oversized grid query window to a stable grid-budget error', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      gridCellSize: 1,
      maxCellsPerRecord: 4,
    });
    runtime.upsert(selection('small', { bounds: bounds(0, 0, 1, 1) }));

    expectCode(() => runtime.query({
      bounds: bounds(0, 0, 100, 100),
    }), 'GRID_BUDGET_EXCEEDED');
  });

  it('updates extent-query and touch diagnostics', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('a'));

    runtime.query({ bounds: bounds(0, 0, 10, 10) });

    expect(runtime.snapshot()).toMatchObject({
      queries: 1,
      extentQueries: 1,
      nearestQueries: 0,
      cacheTouches: 1,
    });
  });
});

describe('SpatialSelectionIndexRuntime nearest queries', () => {
  it('returns the geometrically nearest bounds', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      gridCellSize: 10,
      nearestInitialRadius: 10,
      nearestMaxRadius: 1_000,
    });
    runtime.upsert(selection('near', { bounds: bounds(10, 10, 20, 20) }));
    runtime.upsert(selection('far', { bounds: bounds(100, 100, 110, 110) }));

    expect(ids(runtime.nearest({
      point: { x: 0, y: 0 },
      limit: 1,
    }).records)).toEqual(['near']);
  });

  it('treats a point inside bounds as zero distance', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('contains', { bounds: bounds(-5, -5, 5, 5) }));
    runtime.upsert(selection('nearby', { bounds: bounds(10, 10, 20, 20) }));

    expect(ids(runtime.nearest({
      point: { x: 0, y: 0 },
      limit: 1,
    }).records)).toEqual(['contains']);
  });

  it('breaks equal-distance ties by priority', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('normal', {
      bounds: bounds(10, 0, 20, 10),
      priority: 'normal',
    }));
    runtime.upsert(selection('critical', {
      bounds: bounds(-20, 0, -10, 10),
      priority: 'critical',
    }));

    expect(ids(runtime.nearest({
      point: { x: 0, y: 5 },
      limit: 2,
    }).records)).toEqual(['critical', 'normal']);
  });

  it('filters nearest candidates by layer', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('park', {
      layerId: 'parks',
      bounds: bounds(10, 0, 20, 10),
    }));
    runtime.upsert(selection('road', {
      layerId: 'roads',
      bounds: bounds(1, 0, 2, 1),
    }));

    const result = runtime.nearest({
      point: { x: 0, y: 0 },
      layerIds: new Set(['parks']),
      limit: 1,
    });

    expect(ids(result.records)).toEqual(['park']);
    expect(result.diagnostics.filteredByLayer).toBeGreaterThanOrEqual(1);
  });

  it('filters nearest candidates by minimum priority', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('background', {
      priority: 'background',
      bounds: bounds(1, 0, 2, 1),
    }));
    runtime.upsert(selection('high', {
      priority: 'high',
      bounds: bounds(10, 0, 20, 10),
    }));

    const result = runtime.nearest({
      point: { x: 0, y: 0 },
      minimumPriority: 'high',
      limit: 1,
    });

    expect(ids(result.records)).toEqual(['high']);
    expect(result.diagnostics.filteredByPriority).toBeGreaterThanOrEqual(1);
  });

  it('expands the search radius a bounded number of times', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      gridCellSize: 100,
      nearestInitialRadius: 10,
      nearestMaxRadius: 1_000,
      nearestExpansionSteps: 4,
      maxCellsPerRecord: 1_000,
    });
    runtime.upsert(selection('far', { bounds: bounds(500, 0, 510, 10) }));

    const result = runtime.nearest({
      point: { x: 0, y: 0 },
      limit: 1,
    });

    expect(ids(result.records)).toEqual(['far']);
    expect(result.diagnostics.gridQueries).toBeLessThanOrEqual(4);
    expect(result.diagnostics.gridQueries).toBeGreaterThan(0);
  });

  it('returns no result when the configured maximum radius cannot reach a record', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      gridCellSize: 10,
      nearestInitialRadius: 5,
      nearestMaxRadius: 20,
      nearestExpansionSteps: 3,
    });
    runtime.upsert(selection('far', { bounds: bounds(100, 100, 110, 110) }));

    expect(runtime.nearest({
      point: { x: 0, y: 0 },
    }).records).toEqual([]);
  });

  it('rejects a caller initial radius larger than caller maximum radius', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();

    expect(() => runtime.nearest({
      point: { x: 0, y: 0 },
      initialRadius: 100,
      maxRadius: 50,
    })).toThrow(/initialRadius/u);
  });

  it('caps caller expansion steps to the configured maximum', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      nearestExpansionSteps: 2,
      nearestInitialRadius: 1,
      nearestMaxRadius: 10,
      gridCellSize: 10,
    });
    runtime.upsert(selection('a', { bounds: bounds(5, 0, 6, 1) }));

    const result = runtime.nearest({
      point: { x: 0, y: 0 },
      expansionSteps: 100,
    });

    expect(result.diagnostics.gridQueries).toBeLessThanOrEqual(2);
  });

  it('rejects a pre-aborted nearest query', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    const controller = new AbortController();
    controller.abort('superseded');

    expectCode(() => runtime.nearest({
      point: { x: 0, y: 0 },
      signal: controller.signal,
    }), 'ABORTED');
  });

  it('normalizes negative-zero nearest coordinates', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('a', { bounds: bounds(0, 0, 1, 1) }));

    expect(ids(runtime.nearest({
      point: { x: -0, y: -0 },
      limit: 1,
    }).records)).toEqual(['a']);
  });

  it('rejects non-finite nearest coordinates', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    expectCode(() => runtime.nearest({
      point: { x: Number.NaN, y: 0 },
    }), 'INVALID_BOUNDS');
  });

  it('updates nearest-query and touch diagnostics', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('a'));

    runtime.nearest({ point: { x: 0, y: 0 } });

    expect(runtime.snapshot()).toMatchObject({
      queries: 1,
      extentQueries: 0,
      nearestQueries: 1,
      cacheTouches: 1,
    });
  });
});

describe('SpatialSelectionIndexRuntime layer and mutation lifecycle', () => {
  it('returns layer records in query priority order', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('background', {
      layerId: 'a',
      priority: 'background',
    }));
    runtime.upsert(selection('critical', {
      layerId: 'a',
      priority: 'critical',
    }));

    expect(ids(runtime.recordsForLayer('a'))).toEqual(['critical', 'background']);
  });

  it('caps layer record listing to query result policy', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxQueryResults: 1,
    });
    runtime.upsert(selection('a', { layerId: 'layer' }));
    runtime.upsert(selection('b', { layerId: 'layer' }));

    expect(runtime.recordsForLayer('layer', 10)).toHaveLength(1);
  });

  it('removes one record and updates byte/layer accounting', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('a', { estimatedBytes: 250 }));

    expect(runtime.remove('a')).toBe(true);
    expect(runtime.remove('a')).toBe(false);
    expect(runtime.snapshot()).toMatchObject({
      entries: 0,
      estimatedBytes: 0,
      layers: 0,
    });
  });

  it('removes a complete layer without touching another layer', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('a1', { layerId: 'a' }));
    runtime.upsert(selection('a2', { layerId: 'a' }));
    runtime.upsert(selection('b1', { layerId: 'b' }));

    expect(runtime.removeLayer('a')).toBe(2);
    expect(runtime.has('b1')).toBe(true);
    expect(runtime.snapshot()).toMatchObject({
      entries: 1,
      layers: 1,
    });
  });

  it('returns zero when removing an unknown layer', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    expect(runtime.removeLayer('missing')).toBe(0);
  });

  it('clears every record and grid reference', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('a'));
    runtime.upsert(selection('b', { layerId: 'b' }));

    runtime.clear();

    expect(runtime.snapshot()).toMatchObject({
      entries: 0,
      estimatedBytes: 0,
      layers: 0,
      grid: {
        featureCount: 0,
        cellCount: 0,
        referenceCount: 0,
      },
    });
  });

  it('does not mutate revision when clear is already empty', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    const before = runtime.snapshot().revision;
    runtime.clear();
    expect(runtime.snapshot().revision).toBe(before);
  });

  it('bounds mutation history to the configured capacity', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxHistory: 2,
    });
    runtime.upsert(selection('a'));
    runtime.upsert(selection('b'));
    runtime.remove('a');

    expect(runtime.history()).toHaveLength(2);
    expect(runtime.history().map((event) => event.kind)).toEqual(['upsert', 'remove']);
  });

  it('returns only the newest requested history slice', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxHistory: 10,
    });
    runtime.upsert(selection('a'));
    runtime.upsert(selection('b'));
    runtime.remove('a');

    expect(runtime.history(1)).toHaveLength(1);
    expect(runtime.history(1)[0]?.kind).toBe('remove');
  });

  it('records eviction reasons for release diagnostics', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 1 });
    runtime.upsert(selection('a', { priority: 'background' }));
    runtime.upsert(selection('b', { priority: 'critical' }));

    expect(runtime.history().some((event) => (
      event.kind === 'evict'
      && event.reason === 'global-entry-budget'
      && event.id === 'a'
    ))).toBe(true);
  });

  it('keeps revision monotonic across upsert, eviction and explicit removal', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 1 });
    runtime.upsert(selection('a'));
    runtime.upsert(selection('b', { priority: 'critical' }));
    const afterEviction = runtime.snapshot().revision;
    runtime.remove('b');

    expect(afterEviction).toBeGreaterThanOrEqual(3);
    expect(runtime.snapshot().revision).toBeGreaterThan(afterEviction);
  });
});

describe('SpatialSelectionIndexRuntime health and diagnostics', () => {
  it('reports healthy below the degraded utilization threshold', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxEntriesPerLayer: 10,
      degradedBudgetRatio: 0.6,
      blockedBudgetRatio: 0.9,
    });
    runtime.upsert(selection('a'));

    expect(runtime.snapshot().health).toBe('healthy');
  });

  it('reports degraded when a global entry budget crosses its threshold', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxEntriesPerLayer: 10,
      degradedBudgetRatio: 0.5,
      blockedBudgetRatio: 0.9,
    });
    ['a', 'b', 'c', 'd', 'e'].map((id) => runtime.upsert(selection(id)));

    expect(runtime.snapshot().health).toBe('degraded');
  });

  it('reports blocked when a global entry budget crosses its blocked threshold', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 10,
      maxEntriesPerLayer: 10,
      degradedBudgetRatio: 0.5,
      blockedBudgetRatio: 0.8,
    });
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => runtime.upsert(selection(id)));

    expect(runtime.snapshot().health).toBe('blocked');
  });

  it('uses per-layer utilization for health even when global capacity is large', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 100,
      maxEntriesPerLayer: 4,
      degradedBudgetRatio: 0.5,
      blockedBudgetRatio: 0.9,
    });
    runtime.upsert(selection('a', { layerId: 'hot' }));
    runtime.upsert(selection('b', { layerId: 'hot' }));

    expect(runtime.snapshot().health).toBe('degraded');
  });

  it('uses layer-count utilization for health', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 100,
      maxLayers: 4,
      degradedBudgetRatio: 0.5,
      blockedBudgetRatio: 0.9,
    });
    runtime.upsert(selection('a', { layerId: 'a' }));
    runtime.upsert(selection('b', { layerId: 'b' }));

    expect(runtime.snapshot().health).toBe('degraded');
  });

  it('reports sorted layer snapshots by pressure then identity', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 20,
      maxEntriesPerLayer: 10,
      maxBytes: 10_000,
      maxBytesPerLayer: 1_000,
    });
    runtime.upsert(selection('a1', { layerId: 'a', estimatedBytes: 100 }));
    runtime.upsert(selection('b1', { layerId: 'b', estimatedBytes: 400 }));

    expect(runtime.layerSnapshots().map((layer) => layer.layerId)).toEqual(['b', 'a']);
  });

  it('exposes bounded grid occupancy diagnostics', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      gridCellSize: 10,
      maxGridCells: 100,
      maxGridReferences: 200,
      maxCellsPerRecord: 16,
      maxGridBucketSize: 20,
    });
    runtime.upsert(selection('a', { bounds: bounds(0, 0, 5, 5) }));

    expect(runtime.snapshot().grid).toMatchObject({
      featureCount: 1,
      cellCount: 1,
      referenceCount: 1,
      cellSize: 10,
      maximumCells: 100,
      maximumReferences: 200,
      maximumCellsPerFeature: 16,
      maximumBucketSize: 20,
    });
  });

  it('exposes immutable normalized policy to callers', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({
      maxEntries: 7,
    });

    expect(runtime.policy.maxEntries).toBe(7);
    expect(Object.isFrozen(runtime.policy)).toBe(true);
  });
});

describe('SpatialSelectionIndexRuntime disposal', () => {
  it('clears owned state and reports a terminal blocked snapshot', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('a'));

    runtime.dispose();

    expect(runtime.disposed).toBe(true);
    expect(runtime.snapshot()).toMatchObject({
      disposed: true,
      health: 'blocked',
      entries: 0,
      estimatedBytes: 0,
      layers: 0,
      grid: {
        featureCount: 0,
        cellCount: 0,
        referenceCount: 0,
      },
    });
  });

  it('records only the terminal disposal event after disposal', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('a'));

    runtime.dispose();

    expect(runtime.history()).toEqual([
      expect.objectContaining({
        kind: 'dispose',
        reason: 'dispose',
        id: null,
        layerId: null,
      }),
    ]);
  });

  it('makes disposal idempotent', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.upsert(selection('a'));
    runtime.dispose();
    const afterFirst = runtime.snapshot();

    runtime.dispose();

    expect(runtime.snapshot()).toEqual(afterFirst);
  });

  it('rejects read operations after disposal', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.dispose();

    expectCode(() => runtime.get('a'), 'DISPOSED');
    expectCode(() => runtime.has('a'), 'DISPOSED');
    expectCode(() => runtime.recordsForLayer('a'), 'DISPOSED');
  });

  it('rejects mutations after disposal', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.dispose();

    expectCode(() => runtime.upsert(selection('a')), 'DISPOSED');
    expectCode(() => runtime.remove('a'), 'DISPOSED');
    expectCode(() => runtime.removeLayer('a'), 'DISPOSED');
    expectCode(() => runtime.clear(), 'DISPOSED');
  });

  it('rejects spatial queries after disposal', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>();
    runtime.dispose();

    expectCode(() => runtime.query({
      bounds: bounds(0, 0, 1, 1),
    }), 'DISPOSED');
    expectCode(() => runtime.nearest({
      point: { x: 0, y: 0 },
    }), 'DISPOSED');
  });

  it('exposes a stable typed error surface', () => {
    const cause = new Error('grid');
    const error = new SpatialSelectionIndexError(
      'GRID_BUDGET_EXCEEDED',
      'grid rejected',
      cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SpatialSelectionIndexError');
    expect(error.code).toBe('GRID_BUDGET_EXCEEDED');
    expect(error.causeValue).toBe(cause);
  });

  it('supports direct class construction for dependency-owned runtimes', () => {
    const runtime = new SpatialSelectionIndexRuntime<Payload>({ maxEntries: 2 });
    runtime.upsert(selection('a'));
    expect(runtime.snapshot().entries).toBe(1);
  });
});
