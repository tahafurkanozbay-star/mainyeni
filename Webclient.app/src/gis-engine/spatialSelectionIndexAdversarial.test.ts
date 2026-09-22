import { describe, expect, it } from 'vitest';

import {
  SpatialSelectionIndexRuntime,
  type SelectionPriority,
  type SpatialSelectionRecord,
} from './spatialSelectionIndexRuntime';

type Payload = Readonly<{ ordinal: number; tag: string }>;

const PRIORITIES: readonly SelectionPriority[] = [
  'background',
  'normal',
  'high',
  'critical',
];

const record = (
  ordinal: number,
  layerId = `layer-${ordinal % 7}`,
  priority: SelectionPriority = PRIORITIES[ordinal % PRIORITIES.length] ?? 'normal',
  estimatedBytes = 64 + (ordinal % 5) * 16,
): Omit<SpatialSelectionRecord<Payload>, 'revision'> => ({
  id: `feature-${ordinal}`,
  layerId,
  bounds: {
    xmin: ordinal * 3,
    ymin: ordinal * 2,
    xmax: ordinal * 3 + 2,
    ymax: ordinal * 2 + 2,
  },
  priority,
  payload: { ordinal, tag: `payload-${ordinal}` },
  estimatedBytes,
});

const expectSnapshotWithinPolicy = (
  runtime: SpatialSelectionIndexRuntime<Payload>,
): void => {
  const snapshot = runtime.snapshot();
  expect(snapshot.entries).toBeLessThanOrEqual(snapshot.maxEntries);
  expect(snapshot.estimatedBytes).toBeLessThanOrEqual(snapshot.maxBytes);
  expect(snapshot.layers).toBeLessThanOrEqual(snapshot.maxLayers);
  expect(snapshot.grid.featureCount).toBe(snapshot.entries);
  expect(snapshot.grid.cellCount).toBeLessThanOrEqual(snapshot.grid.maximumCells);
  expect(snapshot.grid.referenceCount).toBeLessThanOrEqual(snapshot.grid.maximumReferences);
  expect(snapshot.utilization).toBeGreaterThanOrEqual(0);
  expect(snapshot.utilization).toBeLessThanOrEqual(1);
};

const deterministicSequence = (count: number): readonly number[] => {
  const values: number[] = [];
  let state = 0x5f3759df;
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    values.push(state % 10_000);
  }
  return values;
};

describe('SpatialSelectionIndexRuntime adversarial regression', () => {
  it('never exceeds global or per-layer budgets under a long deterministic admission sequence', () => {
    const runtime = new SpatialSelectionIndexRuntime<Payload>({
      maxEntries: 37,
      maxBytes: 4_096,
      maxEntriesPerLayer: 11,
      maxBytesPerLayer: 1_024,
      maxLayers: 7,
      gridCellSize: 16,
      maxGridCells: 2_048,
      maxGridReferences: 8_192,
      maxCellsPerRecord: 64,
      maxGridBucketSize: 128,
    });

    for (let ordinal = 0; ordinal < 500; ordinal += 1) {
      runtime.upsert(record(ordinal));
      expectSnapshotWithinPolicy(runtime);
      for (const layer of runtime.layerSnapshots()) {
        expect(layer.entries).toBeLessThanOrEqual(layer.maxEntries);
        expect(layer.estimatedBytes).toBeLessThanOrEqual(layer.maxBytes);
        expect(layer.utilization).toBeGreaterThanOrEqual(0);
        expect(layer.utilization).toBeLessThanOrEqual(1);
      }
    }

    expect(runtime.snapshot().evictions).toBeGreaterThan(0);
    expect(runtime.snapshot().mutations).toBeGreaterThanOrEqual(500);
  });

  it('preserves deterministic survivors for identical pressure sequences', () => {
    const options = {
      maxEntries: 23,
      maxBytes: 3_072,
      maxEntriesPerLayer: 9,
      maxBytesPerLayer: 1_024,
      maxLayers: 5,
      gridCellSize: 32,
    } as const;
    const left = new SpatialSelectionIndexRuntime<Payload>(options);
    const right = new SpatialSelectionIndexRuntime<Payload>(options);
    const sequence = deterministicSequence(300);

    sequence.forEach((value, ordinal) => {
      const candidate = record(
        ordinal,
        `layer-${value % 5}`,
        PRIORITIES[value % PRIORITIES.length] ?? 'normal',
        64 + (value % 4) * 32,
      );
      left.upsert(candidate);
      right.upsert(candidate);
    });

    expect(left.snapshot()).toEqual(right.snapshot());
    expect(left.layerSnapshots()).toEqual(right.layerSnapshots());
    expect(left.history()).toEqual(right.history());

    for (let ordinal = 0; ordinal < 300; ordinal += 1) {
      expect(left.has(`feature-${ordinal}`)).toBe(right.has(`feature-${ordinal}`));
    }
  });

  it('keeps query results bounded when a broad extent covers every admitted record', () => {
    const runtime = new SpatialSelectionIndexRuntime<Payload>({
      maxEntries: 250,
      maxBytes: 128_000,
      maxEntriesPerLayer: 250,
      maxBytesPerLayer: 128_000,
      maxLayers: 4,
      maxQueryResults: 17,
      maxQueryCandidates: 31,
      gridCellSize: 8,
      maxGridCells: 20_000,
      maxGridReferences: 50_000,
      maxCellsPerRecord: 32,
      maxGridBucketSize: 512,
    });

    for (let ordinal = 0; ordinal < 200; ordinal += 1) {
      runtime.upsert(record(ordinal, 'dense-layer', 'normal', 64));
    }

    const result = runtime.query({
      bounds: { xmin: -1, ymin: -1, xmax: 10_000, ymax: 10_000 },
      limit: 1_000,
    });

    expect(result.records).toHaveLength(17);
    expect(result.diagnostics.candidates).toBeLessThanOrEqual(31);
    expect(result.diagnostics.returned).toBeLessThanOrEqual(17);
    expect(result.diagnostics.truncated).toBe(true);
    expectSnapshotWithinPolicy(runtime);
  });

  it('bounds nearest expansion and candidate work for a sparse far-away dataset', () => {
    const runtime = new SpatialSelectionIndexRuntime<Payload>({
      maxEntries: 64,
      maxBytes: 64_000,
      maxEntriesPerLayer: 64,
      maxBytesPerLayer: 64_000,
      maxQueryResults: 4,
      maxQueryCandidates: 12,
      gridCellSize: 100,
      nearestInitialRadius: 10,
      nearestMaxRadius: 10_000,
      nearestExpansionSteps: 5,
      maxCellsPerRecord: 64,
    });

    for (let ordinal = 0; ordinal < 50; ordinal += 1) {
      const candidate = record(ordinal, 'sparse', 'normal', 64);
      runtime.upsert({
        ...candidate,
        bounds: {
          xmin: 5_000 + ordinal * 50,
          ymin: 5_000 + ordinal * 50,
          xmax: 5_010 + ordinal * 50,
          ymax: 5_010 + ordinal * 50,
        },
      });
    }

    const result = runtime.nearest({
      point: { x: 0, y: 0 },
      limit: 4,
      initialRadius: 10,
      maxRadius: 10_000,
      expansionSteps: 5,
    });

    expect(result.records.length).toBeLessThanOrEqual(4);
    expect(result.diagnostics.candidates).toBeLessThanOrEqual(12);
    expect(result.diagnostics.gridQueries).toBeLessThanOrEqual(5);
    expectSnapshotWithinPolicy(runtime);
  });

  it('keeps accounting stable across replacement, removal, layer removal, and clear cycles', () => {
    const runtime = new SpatialSelectionIndexRuntime<Payload>({
      maxEntries: 40,
      maxBytes: 16_000,
      maxEntriesPerLayer: 20,
      maxBytesPerLayer: 8_000,
      maxLayers: 4,
      gridCellSize: 32,
    });

    for (let ordinal = 0; ordinal < 30; ordinal += 1) {
      runtime.upsert(record(ordinal, ordinal < 15 ? 'alpha' : 'beta'));
    }
    expectSnapshotWithinPolicy(runtime);

    for (let ordinal = 0; ordinal < 15; ordinal += 1) {
      runtime.upsert(record(ordinal, 'alpha', 'critical', 96));
    }
    expectSnapshotWithinPolicy(runtime);

    for (let ordinal = 0; ordinal < 10; ordinal += 1) {
      runtime.remove(`feature-${ordinal}`);
    }
    expectSnapshotWithinPolicy(runtime);

    const removed = runtime.removeLayer('beta');
    expect(removed).toBeGreaterThan(0);
    expect(runtime.layerSnapshots().some((layer) => layer.layerId === 'beta')).toBe(false);
    expectSnapshotWithinPolicy(runtime);

    runtime.clear();
    expect(runtime.snapshot()).toMatchObject({
      entries: 0,
      estimatedBytes: 0,
      layers: 0,
    });
    expect(runtime.snapshot().grid.featureCount).toBe(0);
    expect(runtime.snapshot().grid.referenceCount).toBe(0);
  });

  it('remains terminal and mutation-free after deterministic disposal', () => {
    const runtime = new SpatialSelectionIndexRuntime<Payload>({
      maxEntries: 8,
      maxBytes: 8_192,
    });
    for (let ordinal = 0; ordinal < 8; ordinal += 1) {
      runtime.upsert(record(ordinal));
    }

    runtime.dispose();
    const first = runtime.snapshot();
    const history = runtime.history();
    runtime.dispose();

    expect(runtime.snapshot()).toEqual(first);
    expect(runtime.history()).toEqual(history);
    expect(first).toMatchObject({
      disposed: true,
      entries: 0,
      estimatedBytes: 0,
      layers: 0,
    });
    expect(first.grid.featureCount).toBe(0);
    expect(first.grid.referenceCount).toBe(0);
  });
});
