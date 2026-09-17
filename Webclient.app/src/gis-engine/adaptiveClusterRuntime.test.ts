import { describe, expect, test } from 'vitest';
import { createAdaptiveClusterRuntime } from './adaptiveClusterRuntime';

const view = {
  width: 1200,
  height: 800,
  zoom: 11,
  averageFrameMs: 16,
  deviceMemoryGb: 8,
  spatialReference: { wkid: 3857 },
} as const;

describe('adaptiveClusterRuntime', () => {
  test('emits deterministic cluster ids for the same membership regardless of input order', () => {
    const runtime = createAdaptiveClusterRuntime({ namespace: 'places' });
    const features = [
      { id: 3, x: 10, y: 10, spatialReference: { wkid: 3857 } },
      { id: 1, x: 11, y: 11, spatialReference: { wkid: 3857 } },
      { id: 2, x: 12, y: 12, spatialReference: { wkid: 3857 } },
    ];
    const first = runtime.cluster(features, view);
    runtime.reset();
    const second = runtime.cluster([...features].reverse(), view);
    expect(first.clusters.map((cluster) => cluster.id)).toEqual(second.clusters.map((cluster) => cluster.id));
    expect(first.clusters.map((cluster) => cluster.memberIds)).toEqual(second.clusters.map((cluster) => cluster.memberIds));
  });

  test('preserves selected features as standalone nodes while clustering neighbors', () => {
    const runtime = createAdaptiveClusterRuntime();
    const result = runtime.cluster([
      { id: 'selected', x: 20, y: 20, selected: true, spatialReference: { wkid: 3857 } },
      { id: 'a', x: 20, y: 20, spatialReference: { wkid: 3857 } },
      { id: 'b', x: 21, y: 21, spatialReference: { wkid: 3857 } },
    ], { ...view, averageFrameMs: 45, deviceMemoryGb: 1 });
    expect(result.clusters.some((cluster) => cluster.cellKey === 'selected:selected')).toBe(true);
    expect(result.metrics.selectedFeatures).toBe(1);
  });

  test('rejects cross-spatial-reference features rather than silently reprojecting', () => {
    const runtime = createAdaptiveClusterRuntime();
    const result = runtime.cluster([
      { id: 'ok', x: 1, y: 1, spatialReference: { wkid: 3857 } },
      { id: 'bad', x: 1, y: 1, spatialReference: { wkid: 4326 } },
    ], view);
    expect(result.metrics.rejectedSpatialReference).toBe(1);
    expect(result.metrics.acceptedFeatures).toBe(1);
    expect(result.clusters.flatMap((cluster) => cluster.memberIds)).not.toContain('bad');
  });

  test('rejects invalid coordinates and blank identities', () => {
    const runtime = createAdaptiveClusterRuntime();
    const result = runtime.cluster([
      { id: '', x: 1, y: 1 },
      { id: 'nan', x: Number.NaN, y: 1 },
      { id: 'ok', x: 1, y: 1 },
    ], { ...view, spatialReference: null });
    expect(result.metrics.rejectedFeatures).toBe(2);
    expect(result.metrics.invalidCoordinates).toBe(2);
    expect(result.metrics.acceptedFeatures).toBe(1);
  });

  test('honors bounded input and cluster limits', () => {
    const runtime = createAdaptiveClusterRuntime({ maxInputFeatures: 5, maxClusters: 2 });
    const features = Array.from({ length: 20 }, (_, index) => ({
      id: index,
      x: index * 1000,
      y: index * 1000,
      spatialReference: { wkid: 3857 },
    }));
    const result = runtime.cluster(features, { ...view, zoom: 20 });
    expect(result.metrics.truncatedInput).toBe(15);
    expect(result.clusters.length).toBeLessThanOrEqual(2);
    expect(result.metrics.truncatedClusters).toBeGreaterThanOrEqual(0);
  });

  test('bounds member identity retention without losing aggregate count', () => {
    const runtime = createAdaptiveClusterRuntime({ maxMembersPerCluster: 2 });
    const features = Array.from({ length: 10 }, (_, index) => ({
      id: `f-${index}`,
      x: 10,
      y: 10,
      spatialReference: { wkid: 3857 },
    }));
    const result = runtime.cluster(features, { ...view, averageFrameMs: 60, deviceMemoryGb: 1 });
    const cluster = result.clusters.find((item) => item.count > 1);
    expect(cluster).toBeDefined();
    expect(cluster?.count).toBe(10);
    expect(cluster?.memberIds).toHaveLength(2);
    expect(cluster?.truncatedMembers).toBe(true);
  });

  test('produces incremental renderer diff snapshots', () => {
    const runtime = createAdaptiveClusterRuntime({ namespace: 'diff' });
    const first = runtime.cluster([
      { id: 'a', x: 0, y: 0, spatialReference: { wkid: 3857 } },
      { id: 'b', x: 1, y: 1, spatialReference: { wkid: 3857 } },
    ], view);
    expect(first.diff.added.length).toBe(first.clusters.length);

    const second = runtime.cluster([
      { id: 'a', x: 0, y: 0, spatialReference: { wkid: 3857 } },
      { id: 'b', x: 1, y: 1, spatialReference: { wkid: 3857 } },
    ], view);
    expect(second.diff.added).toHaveLength(0);
    expect(second.diff.updated).toHaveLength(0);
    expect(second.diff.unchanged.length).toBe(second.clusters.length);
  });

  test('reports renderer updates when aggregate coordinates change without membership changes', () => {
    const runtime = createAdaptiveClusterRuntime({ namespace: 'updates' });
    runtime.cluster([
      { id: 'a', x: 0, y: 0, spatialReference: { wkid: 3857 } },
      { id: 'b', x: 1, y: 1, spatialReference: { wkid: 3857 } },
    ], view);
    const next = runtime.cluster([
      { id: 'a', x: 0.25, y: 0.25, spatialReference: { wkid: 3857 } },
      { id: 'b', x: 1, y: 1, spatialReference: { wkid: 3857 } },
    ], view);
    expect(next.diff.updated.length).toBeGreaterThanOrEqual(1);
  });

  test('supports AbortSignal cancellation before work begins', () => {
    const runtime = createAdaptiveClusterRuntime();
    const controller = new AbortController();
    controller.abort('navigation superseded');
    expect(() => runtime.cluster([{ id: 1, x: 0, y: 0 }], view, controller.signal))
      .toThrow(expect.objectContaining({ code: 'ABORTED' }));
  });

  test('supports AbortSignal checks through large scans', () => {
    const runtime = createAdaptiveClusterRuntime({ maxInputFeatures: 10_000 });
    const controller = new AbortController();
    const source = Array.from({ length: 1024 }, (_, index) => ({ id: index, x: index, y: index }));
    controller.abort();
    expect(() => runtime.cluster(source, { ...view, spatialReference: null }, controller.signal)).toThrow();
  });

  test('can explicitly allow mixed spatial references without inventing reprojection', () => {
    const runtime = createAdaptiveClusterRuntime({ rejectSpatialReferenceMismatch: false });
    const result = runtime.cluster([
      { id: 'mercator', x: 100, y: 100, spatialReference: { wkid: 3857 } },
      { id: 'geographic', x: 30, y: 40, spatialReference: { wkid: 4326 } },
    ], view);
    expect(result.metrics.rejectedSpatialReference).toBe(0);
    expect(result.metrics.acceptedFeatures).toBe(2);
  });

  test('does not animate when reduced motion is requested', () => {
    const runtime = createAdaptiveClusterRuntime();
    const result = runtime.cluster([{ id: 'a', x: 0, y: 0 }], { ...view, reducedMotion: true, spatialReference: null });
    expect(result.decision.animationEnabled).toBe(false);
  });

  test('uses total feature count to derive adaptive pressure decision', () => {
    const runtime = createAdaptiveClusterRuntime({ maxInputFeatures: 100 });
    const features = Array.from({ length: 20_000 }, (_, index) => ({ id: index, x: index % 10, y: index % 10 }));
    const result = runtime.cluster(features, { ...view, spatialReference: null, deviceMemoryGb: 1, averageFrameMs: 50 });
    expect(result.decision.mode).toBe('aggressive');
    expect(result.metrics.inputFeatures).toBe(20_000);
    expect(result.metrics.truncatedInput).toBe(19_900);
  });

  test('reset clears generation and prior diff history', () => {
    const runtime = createAdaptiveClusterRuntime();
    runtime.cluster([{ id: 'a', x: 0, y: 0 }], { ...view, spatialReference: null });
    runtime.reset();
    expect(runtime.snapshot().generation).toBe(0);
    expect(runtime.snapshot().clusterCount).toBe(0);
  });

  test('destroy releases state and rejects later work', () => {
    const runtime = createAdaptiveClusterRuntime();
    runtime.cluster([{ id: 'a', x: 0, y: 0 }], { ...view, spatialReference: null });
    runtime.destroy();
    expect(runtime.snapshot().destroyed).toBe(true);
    expect(() => runtime.cluster([], view)).toThrow(expect.objectContaining({ code: 'RUNTIME_DESTROYED' }));
  });
});
