import { describe, expect, it } from 'vitest';
import {
  createModernSpatialAnalysisKernel,
  type ModernSpatialAnalysisKernelConfiguration,
} from './modernSpatialAnalysisKernel';
import { SpatialSelectionIndexError } from './spatialSelectionIndexRuntime';

const configuration = (
  selectionIndex: ModernSpatialAnalysisKernelConfiguration['selectionIndex'] = {},
): ModernSpatialAnalysisKernelConfiguration => ({
  geometry: { maxVertices: 10_000, maxSegments: 10_000, maxRings: 32 },
  selection: { maxCandidates: 10_000, maxSelected: 1_000, maxPolygonVertices: 1_000 },
  selectionIndex,
  aggregation: { maxPoints: 10_000, maxCells: 1_000, maxCategoriesPerCell: 16 },
  join: {
    maxFeatures: 10_000,
    maxPolygons: 1_000,
    maxRingVertices: 10_000,
    maxCandidatePairs: 100_000,
    maxMatches: 10_000,
  },
  topology: {
    maxRings: 32,
    maxVertices: 10_000,
    maxSegments: 10_000,
    maxSegmentPairs: 100_000,
    maxIntersections: 256,
    maxIssues: 512,
  },
  statistics: {
    maxObservations: 10_000,
    maxCategories: 64,
    maxHistogramBins: 64,
    maxBreaks: 16,
    maxPercentiles: 16,
  },
  jobs: {
    maxConcurrent: 2,
    maxQueued: 8,
    maxHistory: 16,
    defaultTimeoutMs: 0,
  },
});

const indexedRecord = (
  id: string,
  layerId = 'places',
  priority: 'background' | 'normal' | 'high' | 'critical' = 'normal',
  xmin = 0,
) => ({
  id,
  layerId,
  bounds: { xmin, ymin: 0, xmax: xmin + 5, ymax: 5 },
  priority,
  payload: { id, layerId },
  estimatedBytes: 128,
});

describe('ModernSpatialAnalysisKernel selection-index integration', () => {
  it('owns one bounded selection index in its diagnostics snapshot', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration({
      maxEntries: 8,
      maxBytes: 8_192,
    }));

    expect(kernel.snapshot().selectionIndex).toMatchObject({
      disposed: false,
      health: 'healthy',
      entries: 0,
      maxEntries: 8,
      maxBytes: 8_192,
    });
  });

  it('indexes a selection record through the unified analysis kernel', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());

    const inserted = kernel.indexSelection(indexedRecord('park-1'));

    expect(inserted).toMatchObject({
      id: 'park-1',
      layerId: 'places',
      revision: 1,
    });
    expect(kernel.hasIndexedSelection('park-1')).toBe(true);
    expect(kernel.indexedSelection<{ id: string }>('park-1')?.payload.id).toBe('park-1');
  });

  it('queries indexed selections through the grid-backed extent path', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration({
      gridCellSize: 10,
    }));
    kernel.indexSelection(indexedRecord('near', 'places', 'normal', 0));
    kernel.indexSelection(indexedRecord('far', 'places', 'normal', 100));

    const result = kernel.querySelectionIndex<{ id: string }>({
      bounds: { xmin: -1, ymin: -1, xmax: 10, ymax: 10 },
    });

    expect(result.records.map((record) => record.id)).toEqual(['near']);
    expect(result.diagnostics).toMatchObject({
      kind: 'extent',
      gridQueries: 1,
      returned: 1,
    });
  });

  it('queries nearest indexed selections without changing stateless selection semantics', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration({
      gridCellSize: 10,
      nearestInitialRadius: 10,
      nearestMaxRadius: 1_000,
      maxCellsPerRecord: 16_384,
    }));
    kernel.indexSelection(indexedRecord('indexed-near', 'places', 'normal', 10));
    kernel.indexSelection(indexedRecord('indexed-far', 'places', 'normal', 100));

    const nearest = kernel.nearestIndexedSelection<{ id: string }>({
      point: { x: 0, y: 0 },
      limit: 1,
    });
    const stateless = kernel.selectExtent([
      { id: 1, point: { x: 1, y: 1 }, data: 'inside' },
      { id: 2, point: { x: 50, y: 50 }, data: 'outside' },
    ], {
      xmin: 0,
      ymin: 0,
      xmax: 5,
      ymax: 5,
    });

    expect(nearest.records[0]?.id).toBe('indexed-near');
    expect(stateless.features.map((feature) => feature.id)).toEqual([1]);
  });

  it('exposes deterministic priority eviction through the kernel', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration({
      maxEntries: 2,
    }));
    kernel.indexSelection(indexedRecord('background', 'places', 'background'));
    kernel.indexSelection(indexedRecord('critical', 'places', 'critical'));
    kernel.indexSelection(indexedRecord('high', 'places', 'high'));

    expect(kernel.hasIndexedSelection('background')).toBe(false);
    expect(kernel.hasIndexedSelection('critical')).toBe(true);
    expect(kernel.hasIndexedSelection('high')).toBe(true);
    expect(kernel.snapshot().selectionIndex.evictions).toBe(1);
  });

  it('exposes per-layer snapshots without leaking payload data', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());
    kernel.indexSelection(indexedRecord('park', 'parks'));
    kernel.indexSelection(indexedRecord('road', 'roads'));

    const serialized = JSON.stringify(kernel.selectionIndexLayers());

    expect(kernel.selectionIndexLayers()).toHaveLength(2);
    expect(serialized).not.toContain('"payload"');
    expect(serialized).toContain('"layerId":"parks"');
    expect(serialized).toContain('"layerId":"roads"');
  });

  it('lists bounded indexed records for one layer', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration({
      maxEntries: 10,
      maxQueryResults: 1,
    }));
    kernel.indexSelection(indexedRecord('a', 'parks', 'normal'));
    kernel.indexSelection(indexedRecord('b', 'parks', 'critical'));
    kernel.indexSelection(indexedRecord('c', 'roads', 'high'));

    expect(kernel.indexedSelectionsForLayer('parks', 99).map((record) => record.id)).toEqual([
      'b',
    ]);
  });

  it('removes one indexed record through kernel ownership', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());
    kernel.indexSelection(indexedRecord('park'));

    expect(kernel.removeIndexedSelection('park')).toBe(true);
    expect(kernel.removeIndexedSelection('park')).toBe(false);
    expect(kernel.snapshot().selectionIndex.entries).toBe(0);
  });

  it('removes a complete layer through kernel ownership', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());
    kernel.indexSelection(indexedRecord('p1', 'parks'));
    kernel.indexSelection(indexedRecord('p2', 'parks'));
    kernel.indexSelection(indexedRecord('r1', 'roads'));

    expect(kernel.removeIndexedSelectionLayer('parks')).toBe(2);
    expect(kernel.hasIndexedSelection('r1')).toBe(true);
    expect(kernel.snapshot().selectionIndex.layers).toBe(1);
  });

  it('clears the selection index without clearing analysis job diagnostics', async () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());
    kernel.indexSelection(indexedRecord('park'));
    await kernel.submit('noop-job', async () => 1);

    kernel.clearSelectionIndex();

    expect(kernel.snapshot().selectionIndex.entries).toBe(0);
    expect(kernel.snapshot().jobs.completed).toBe(1);
  });

  it('exposes bounded mutation history through the kernel', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration({
      maxEntries: 1,
      maxHistory: 4,
    }));
    kernel.indexSelection(indexedRecord('background', 'places', 'background'));
    kernel.indexSelection(indexedRecord('critical', 'places', 'critical'));

    expect(kernel.selectionIndexHistory()).toEqual([
      expect.objectContaining({ kind: 'upsert', id: 'background' }),
      expect.objectContaining({ kind: 'upsert', id: 'critical' }),
      expect.objectContaining({
        kind: 'evict',
        id: 'background',
        reason: 'global-entry-budget',
      }),
    ]);
  });

  it('propagates a pre-aborted extent query through the kernel boundary', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());
    const controller = new AbortController();
    controller.abort('view-superseded');

    expect(() => kernel.querySelectionIndex({
      bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      signal: controller.signal,
    })).toThrow(SpatialSelectionIndexError);
  });

  it('propagates a pre-aborted nearest query through the kernel boundary', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());
    const controller = new AbortController();
    controller.abort('view-superseded');

    expect(() => kernel.nearestIndexedSelection({
      point: { x: 0, y: 0 },
      signal: controller.signal,
    })).toThrow(SpatialSelectionIndexError);
  });

  it('can index inside a governed analysis job with the shared abort signal available', async () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());

    const result = await kernel.submit('index-job', async (ownedKernel, signal) => {
      expect(signal.aborted).toBe(false);
      ownedKernel.indexSelection(indexedRecord('job-record'));
      return ownedKernel.querySelectionIndex({
        bounds: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
        signal,
      }).records.length;
    });

    expect(result).toBe(1);
    expect(kernel.snapshot()).toMatchObject({
      jobs: {
        completed: 1,
      },
      selectionIndex: {
        entries: 1,
        queries: 1,
      },
    });
  });

  it('keeps selection index and job queue resource budgets independent', async () => {
    const kernel = createModernSpatialAnalysisKernel(configuration({
      maxEntries: 1,
    }));
    kernel.indexSelection(indexedRecord('a'));
    kernel.indexSelection(indexedRecord('b', 'places', 'critical'));

    await kernel.submit('stats', async () => 42);

    expect(kernel.snapshot().selectionIndex.entries).toBe(1);
    expect(kernel.snapshot().selectionIndex.evictions).toBe(1);
    expect(kernel.snapshot().jobs.completed).toBe(1);
  });

  it('supports heterogeneous payloads behind an unknown-owned kernel index', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());
    kernel.indexSelection({
      ...indexedRecord('string'),
      payload: 'text-payload',
    });
    kernel.indexSelection({
      ...indexedRecord('number', 'places', 'normal', 20),
      payload: 42,
    });

    expect(kernel.indexedSelection<string>('string')?.payload).toBe('text-payload');
    expect(kernel.indexedSelection<number>('number')?.payload).toBe(42);
  });

  it('reports pressure from the selection index in the unified snapshot', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration({
      maxEntries: 4,
      maxEntriesPerLayer: 4,
      degradedBudgetRatio: 0.5,
      blockedBudgetRatio: 0.9,
    }));
    kernel.indexSelection(indexedRecord('a'));
    kernel.indexSelection(indexedRecord('b'));

    expect(kernel.snapshot().selectionIndex.health).toBe('degraded');
  });

  it('disposes the selection index together with the analysis scheduler', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());
    kernel.indexSelection(indexedRecord('a'));

    kernel.dispose();

    expect(kernel.snapshot()).toMatchObject({
      disposed: true,
      selectionIndex: {
        disposed: true,
        health: 'blocked',
        entries: 0,
      },
      jobs: {
        disposed: true,
      },
    });
  });

  it('rejects indexed selection access after kernel disposal', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());
    kernel.dispose();

    expect(() => kernel.indexSelection(indexedRecord('late'))).toThrow(/disposed/u);
    expect(() => kernel.indexedSelection('late')).toThrow(/disposed/u);
    expect(() => kernel.querySelectionIndex({
      bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
    })).toThrow(/disposed/u);
  });

  it('keeps kernel disposal idempotent with owned selection resources', () => {
    const kernel = createModernSpatialAnalysisKernel(configuration());
    kernel.indexSelection(indexedRecord('a'));

    kernel.dispose();
    const first = kernel.snapshot();
    kernel.dispose();

    expect(kernel.snapshot()).toEqual(first);
  });
});
