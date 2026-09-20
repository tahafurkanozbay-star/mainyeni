import { describe, expect, it } from 'vitest';
import type { SketchGraphicSnapshot } from './sketchContracts';
import { createSketchMetricsRuntime } from './sketchMetricsRuntime';

const graphic = (
  id: string,
  type: SketchGraphicSnapshot['geometry']['type'],
  payload: Readonly<Record<string, unknown>>,
): SketchGraphicSnapshot => Object.freeze({
  id,
  geometry: Object.freeze({
    type,
    spatialReferenceWkid: 4326,
    payload,
  }),
  attributes: Object.freeze({}),
  symbol: null,
  createdAt: 1,
  updatedAt: 1,
});

describe('sketchMetricsRuntime', () => {
  it('counts geometry categories and coordinates', () => {
    const metrics = createSketchMetricsRuntime();
    const snapshot = metrics.calculate([
      graphic('p', 'point', { x: 1, y: 2 }),
      graphic('l', 'polyline', { paths: [[[0, 0], [1, 1]]] }),
      graphic('a', 'polygon', { rings: [[[0, 0], [1, 0], [0, 0]]] }),
      graphic('e', 'extent', { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }),
      graphic('u', 'unknown', { coordinates: [[1, 2]] }),
    ]);
    expect(snapshot).toEqual(expect.objectContaining({
      graphics: 5,
      points: 1,
      polylines: 1,
      polygons: 1,
      extents: 1,
      unknown: 1,
      coordinates: 9,
      invalidCoordinates: 0,
    }));
    expect(snapshot.estimatedBytes).toBeGreaterThan(0);
  });

  it('tracks tool selections', () => {
    const metrics = createSketchMetricsRuntime();
    metrics.recordToolSelection('point');
    metrics.recordToolSelection('point');
    metrics.recordToolSelection('polygon');
    const snapshot = metrics.calculate([]);
    expect(snapshot.toolSelections.point).toBe(2);
    expect(snapshot.toolSelections.polygon).toBe(1);
  });

  it('tracks lifecycle counters', () => {
    const metrics = createSketchMetricsRuntime();
    metrics.recordImport();
    metrics.recordExport();
    metrics.recordUndo();
    metrics.recordRedo();
    metrics.recordClear();
    metrics.recordFailure();
    expect(metrics.calculate([])).toEqual(expect.objectContaining({
      imports: 1,
      exports: 1,
      undos: 1,
      redos: 1,
      clears: 1,
      failures: 1,
    }));
  });

  it('resets counters but remains usable', () => {
    const metrics = createSketchMetricsRuntime();
    metrics.recordToolSelection('point');
    metrics.recordFailure();
    metrics.reset();
    const snapshot = metrics.calculate([]);
    expect(snapshot.toolSelections.point).toBe(0);
    expect(snapshot.failures).toBe(0);
  });

  it('reports invalid coordinates', () => {
    const metrics = createSketchMetricsRuntime();
    const snapshot = metrics.calculate([
      graphic('bad', 'point', { x: Number.NaN, y: 2 }),
    ]);
    expect(snapshot.invalidCoordinates).toBe(1);
  });
});
