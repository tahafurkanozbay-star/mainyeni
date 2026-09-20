import { describe, expect, it, vi } from 'vitest';
import type { SketchGraphicSnapshot, SketchViewAdapter } from './sketchContracts';
import { analyzeGeometry, createGraphicSnapshot, snapshotGeometry } from './sketchGeometryRuntime';
import { createSketchSessionRuntime } from './sketchSessionRuntime';

const graphic = (id: string): SketchGraphicSnapshot => Object.freeze({
  id,
  geometry: Object.freeze({
    type: 'point',
    spatialReferenceWkid: 4326,
    payload: Object.freeze({ type: 'point', x: 32.85, y: 39.92 }),
  }),
  attributes: Object.freeze({ id }),
  symbol: null,
  createdAt: 1,
  updatedAt: 1,
});

const adapter = (): SketchViewAdapter => ({
  addGraphic: vi.fn(),
  replaceGraphics: vi.fn(),
  removeGraphic: vi.fn(),
  clearGraphics: vi.fn(),
  beginCreate: vi.fn(),
  cancelCreate: vi.fn(),
  destroy: vi.fn(),
});

describe('sketch hardening regression', () => {
  it.each([
    ['NaN x', Number.NaN, 1],
    ['NaN y', 1, Number.NaN],
    ['positive infinity x', Number.POSITIVE_INFINITY, 1],
    ['negative infinity x', Number.NEGATIVE_INFINITY, 1],
    ['positive infinity y', 1, Number.POSITIVE_INFINITY],
    ['negative infinity y', 1, Number.NEGATIVE_INFINITY],
    ['string x', '1', 1],
    ['string y', 1, '2'],
    ['null x', null, 1],
    ['undefined y', 1, undefined],
  ])('rejects %s before sanitization can erase invalid coordinate evidence', (_name, x, y) => {
    expect(() => snapshotGeometry({ type: 'point', x, y })).toThrow(
      'invalid or non-finite coordinates',
    );
  });

  it('rejects out-of-policy coordinate magnitudes before persistence', () => {
    expect(() => snapshotGeometry(
      { type: 'point', x: 101, y: 1 },
      { maxAbsoluteCoordinate: 100 },
    )).toThrow('invalid or non-finite coordinates');
  });

  it('preserves valid zero coordinates', () => {
    const snapshot = snapshotGeometry({ type: 'point', x: 0, y: 0 });
    expect(snapshot.payload).toEqual(expect.objectContaining({ x: 0, y: 0 }));
  });

  it('preserves valid negative coordinates', () => {
    const snapshot = snapshotGeometry({ type: 'point', x: -32.85, y: -39.92 });
    expect(snapshot.payload).toEqual(expect.objectContaining({ x: -32.85, y: -39.92 }));
  });

  it('does not mutate caller geometry while validating it', () => {
    const source = { type: 'point', x: 1, y: 2 };
    snapshotGeometry(source);
    expect(source).toEqual({ type: 'point', x: 1, y: 2 });
  });

  it('drops prototype-sensitive keys from parsed attribute records', () => {
    const attributes = JSON.parse(
      '{"safe":1,"__proto__":{"polluted":true},"prototype":{"polluted":true},"constructor":{"polluted":true}}',
    );
    const snapshot = createGraphicSnapshot({
      id: 'secure',
      geometry: { type: 'point', x: 1, y: 2 },
      attributes,
    });
    expect(Object.keys(snapshot.attributes)).toEqual(['safe']);
    expect(snapshot.attributes.safe).toBe(1);
  });

  it('uses a null prototype for sanitized attribute dictionaries', () => {
    const snapshot = createGraphicSnapshot({
      id: 'secure',
      geometry: { type: 'point', x: 1, y: 2 },
      attributes: { safe: true },
    });
    expect(Object.getPrototypeOf(snapshot.attributes)).toBeNull();
  });

  it('uses null prototypes recursively for nested dictionaries', () => {
    const snapshot = createGraphicSnapshot({
      id: 'secure',
      geometry: { type: 'point', x: 1, y: 2 },
      attributes: { nested: { safe: true } },
    });
    expect(Object.getPrototypeOf(snapshot.attributes.nested)).toBeNull();
  });

  it('drops blocked keys recursively', () => {
    const attributes = JSON.parse(
      '{"nested":{"safe":true,"__proto__":{"polluted":true},"constructor":"blocked"}}',
    );
    const snapshot = createGraphicSnapshot({
      id: 'secure',
      geometry: { type: 'point', x: 1, y: 2 },
      attributes,
    });
    expect(snapshot.attributes.nested).toEqual({ safe: true });
  });

  it('sanitizes symbol dictionaries with the same prototype policy', () => {
    const symbol = JSON.parse('{"type":"simple-marker","__proto__":{"polluted":true}}');
    const snapshot = createGraphicSnapshot({
      id: 'secure',
      geometry: { type: 'point', x: 1, y: 2 },
      symbol,
    });
    expect(snapshot.symbol).not.toBeNull();
    expect(Object.getPrototypeOf(snapshot.symbol)).toBeNull();
    expect(Object.keys(snapshot.symbol ?? {})).toEqual(['type']);
  });

  it('converts non-finite non-coordinate metadata numbers to null', () => {
    const snapshot = createGraphicSnapshot({
      id: 'secure',
      geometry: { type: 'point', x: 1, y: 2 },
      attributes: { score: Number.POSITIVE_INFINITY },
    });
    expect(snapshot.attributes.score).toBeNull();
  });

  it('bounds recursive JSON sanitization depth', () => {
    let value: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 20; index += 1) value = { nested: value };
    const snapshot = createGraphicSnapshot({
      id: 'bounded',
      geometry: { type: 'point', x: 1, y: 2 },
      attributes: value,
    });
    expect(JSON.stringify(snapshot.attributes).length).toBeLessThan(500);
  });

  it('truncates excessively long attribute keys deterministically', () => {
    const longKey = 'a'.repeat(500);
    const snapshot = createGraphicSnapshot({
      id: 'bounded',
      geometry: { type: 'point', x: 1, y: 2 },
      attributes: { [longKey]: 'value' },
    });
    expect(Object.keys(snapshot.attributes)[0]).toHaveLength(256);
  });

  it('reports invalid coordinate counts without manufacturing bounds', () => {
    const result = analyzeGeometry({
      type: 'point',
      payload: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
    });
    expect(result.invalidCoordinateCount).toBe(1);
    expect(result.finiteCoordinateCount).toBe(0);
    expect(result.bounds).toBeNull();
  });

  it('counts a mixed-validity path deterministically', () => {
    const result = analyzeGeometry({
      type: 'polyline',
      payload: { paths: [[[0, 0], [1, 1], [Number.NaN, 2], [3, 3]]] },
    });
    expect(result.coordinateCount).toBe(4);
    expect(result.finiteCoordinateCount).toBe(3);
    expect(result.invalidCoordinateCount).toBe(1);
    expect(result.bounds).toEqual([0, 0, 3, 3]);
  });

  it('rejects a second operation when capacity one is occupied by active work', async () => {
    let release!: () => void;
    const view = adapter();
    view.beginCreate = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const runtime = createSketchSessionRuntime(view, { budget: { maxQueuedOperations: 1 } });
    const first = runtime.selectTool('point');
    await expect(runtime.selectTool('polygon')).rejects.toThrow('queue capacity');
    release();
    await first;
  });

  it('admits exactly the configured number of active plus queued operations', async () => {
    let release!: () => void;
    const view = adapter();
    view.beginCreate = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const runtime = createSketchSessionRuntime(view, { budget: { maxQueuedOperations: 2 } });
    const first = runtime.selectTool('point');
    const second = runtime.selectTool('polygon');
    await expect(runtime.selectTool('circle')).rejects.toThrow('queue capacity');
    release();
    await first;
    await second;
  });

  it('reports queued work separately from the active operation', async () => {
    let release!: () => void;
    const view = adapter();
    view.beginCreate = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const runtime = createSketchSessionRuntime(view, { budget: { maxQueuedOperations: 2 } });
    const first = runtime.selectTool('point');
    const second = runtime.selectTool('polygon');
    expect(runtime.snapshot().activeOperation).toContain('begin-create');
    expect(runtime.snapshot().queuedOperations).toBe(1);
    release();
    await first;
    await second;
  });

  it('emits an admission diagnostic when operation capacity is exhausted', async () => {
    let release!: () => void;
    const view = adapter();
    const emit = vi.fn();
    view.beginCreate = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const runtime = createSketchSessionRuntime(view, {
      budget: { maxQueuedOperations: 1 },
      diagnosticSink: { emit },
    });
    const first = runtime.selectTool('point');
    await expect(runtime.selectTool('polygon')).rejects.toThrow('queue capacity');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'operation-rejected',
      detail: expect.objectContaining({ reason: 'queue-budget' }),
    }));
    release();
    await first;
  });

  it('releases operation admission capacity after successful completion', async () => {
    const view = adapter();
    const runtime = createSketchSessionRuntime(view, { budget: { maxQueuedOperations: 1 } });
    await runtime.selectTool('point');
    await expect(runtime.selectTool('polygon')).resolves.toEqual(
      expect.objectContaining({ selectedTool: 'polygon' }),
    );
  });

  it('releases operation admission capacity after a failed operation', async () => {
    const view = adapter();
    view.beginCreate = vi.fn()
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValue(undefined);
    const runtime = createSketchSessionRuntime(view, { budget: { maxQueuedOperations: 1 } });
    await expect(runtime.selectTool('point')).rejects.toThrow('first failed');
    await expect(runtime.selectTool('polygon')).resolves.toEqual(
      expect.objectContaining({ selectedTool: 'polygon' }),
    );
  });

  it('rejects new work after deterministic disposal', async () => {
    const view = adapter();
    const runtime = createSketchSessionRuntime(view);
    await runtime.dispose();
    await expect(runtime.ingestGraphic(graphic('after-dispose'))).rejects.toThrow('disposed');
  });
});
