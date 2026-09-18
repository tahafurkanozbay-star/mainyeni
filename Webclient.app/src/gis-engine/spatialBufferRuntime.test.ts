import { describe, expect, it } from 'vitest';
import { bufferPoint, bufferPolyline, expandExtent, extentOfPoints, normalizeBufferOptions, pointWithinBufferExtent } from './spatialBufferRuntime';

const options = { distance: 10, segmentsPerQuarter: 4, maxInputVertices: 100, maxOutputVertices: 100, join: 'round' as const };

describe('spatialBufferRuntime', () => {
  it('normalizes finite bounded options', () => {
    expect(normalizeBufferOptions(options)).toEqual(options);
    expect(() => normalizeBufferOptions({ ...options, distance: -1 })).toThrow(RangeError);
    expect(() => normalizeBufferOptions({ ...options, segmentsPerQuarter: 0 })).toThrow(RangeError);
  });

  it('computes point extents without trusting invalid coordinates', () => {
    expect(extentOfPoints([{ x: -2, y: 3 }, { x: 8, y: -4 }])).toEqual({ xmin: -2, ymin: -4, xmax: 8, ymax: 3 });
    expect(() => extentOfPoints([])).toThrow(RangeError);
    expect(() => extentOfPoints([{ x: Number.NaN, y: 0 }])).toThrow(TypeError);
  });

  it('expands validated extents', () => {
    expect(expandExtent({ xmin: 1, ymin: 2, xmax: 3, ymax: 4 }, 5)).toEqual({ xmin: -4, ymin: -3, xmax: 8, ymax: 9 });
    expect(() => expandExtent({ xmin: 5, ymin: 0, xmax: 1, ymax: 2 }, 1)).toThrow(RangeError);
  });

  it('builds a deterministic closed point buffer', () => {
    const result = bufferPoint({ x: 5, y: 7 }, options);
    expect(result.ring).toHaveLength(17);
    expect(result.ring[0]).toEqual(result.ring.at(-1));
    expect(result.extent).toEqual({ xmin: -5, ymin: -3, xmax: 15, ymax: 17 });
    expect(result.diagnostic.truncated).toBe(false);
  });

  it('fails closed when the point output budget truncates tessellation', () => {
    const result = bufferPoint({ x: 0, y: 0 }, { ...options, maxOutputVertices: 6 });
    expect(result.ring.length).toBeLessThanOrEqual(6);
    expect(result.diagnostic.truncated).toBe(true);
  });

  it('buffers a polyline with bounded input and output work', () => {
    const result = bufferPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], options);
    expect(result.ring[0]).toEqual(result.ring.at(-1));
    expect(result.extent).toEqual({ xmin: -10, ymin: -10, xmax: 20, ymax: 20 });
    expect(result.diagnostic.inspectedVertices).toBe(3);
  });

  it('reports truncation when input vertices exceed the budget', () => {
    const result = bufferPolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], { ...options, maxInputVertices: 2 });
    expect(result.diagnostic.inspectedVertices).toBe(2);
    expect(result.diagnostic.truncated).toBe(true);
  });

  it('rejects degenerate lines', () => {
    expect(() => bufferPolyline([{ x: 0, y: 0 }], options)).toThrow(RangeError);
    expect(() => bufferPolyline([{ x: 0, y: 0 }, { x: 0, y: 0 }], options)).toThrow(RangeError);
  });

  it('supports cancellation', () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    expect(() => bufferPoint({ x: 0, y: 0 }, options, controller.signal)).toThrow('cancelled');
    expect(() => bufferPolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }], options, controller.signal)).toThrow('cancelled');
  });

  it('provides a cheap broad-phase buffer extent predicate', () => {
    const buffer = bufferPoint({ x: 0, y: 0 }, options);
    expect(pointWithinBufferExtent({ x: 9, y: 0 }, buffer)).toBe(true);
    expect(pointWithinBufferExtent({ x: 11, y: 0 }, buffer)).toBe(false);
  });
});
