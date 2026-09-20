import { describe, expect, it, vi } from 'vitest';
import type { SketchDiagnosticEvent, SketchGraphicSnapshot, SketchViewAdapter } from './sketchContracts';
import { createSketchSessionRuntime } from './sketchSessionRuntime';

const point = (id: string): SketchGraphicSnapshot => Object.freeze({
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

const createAdapter = (): SketchViewAdapter => ({
  addGraphic: vi.fn(),
  replaceGraphics: vi.fn(),
  removeGraphic: vi.fn(),
  clearGraphics: vi.fn(),
  beginCreate: vi.fn(),
  cancelCreate: vi.fn(),
  destroy: vi.fn(),
});

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('sketchSessionRuntime concurrency contract', () => {
  it('counts a synchronously started drain as occupied admission capacity', async () => {
    const gate = deferred();
    const adapter = createAdapter();
    adapter.beginCreate = vi.fn(() => gate.promise);
    const runtime = createSketchSessionRuntime(adapter, { budget: { maxQueuedOperations: 1 } });

    const active = runtime.selectTool('point');
    expect(runtime.snapshot().activeOperation).toContain('begin-create');
    await expect(runtime.selectTool('polygon')).rejects.toThrow('queue capacity');

    gate.resolve();
    await active;
  });

  it('admits one active and one queued operation when capacity is two', async () => {
    const gate = deferred();
    const adapter = createAdapter();
    adapter.beginCreate = vi.fn(() => gate.promise);
    const runtime = createSketchSessionRuntime(adapter, { budget: { maxQueuedOperations: 2 } });

    const active = runtime.selectTool('point');
    const queued = runtime.selectTool('polygon');

    expect(runtime.snapshot()).toEqual(expect.objectContaining({
      queuedOperations: 1,
      activeOperation: expect.stringContaining('begin-create'),
    }));
    gate.resolve();
    await Promise.all([active, queued]);
  });

  it('rejects the third operation while active plus queued capacity is exhausted', async () => {
    const gate = deferred();
    const adapter = createAdapter();
    adapter.beginCreate = vi.fn(() => gate.promise);
    const runtime = createSketchSessionRuntime(adapter, { budget: { maxQueuedOperations: 2 } });

    const active = runtime.selectTool('point');
    const queued = runtime.selectTool('polygon');
    await expect(runtime.selectTool('circle')).rejects.toThrow('queue capacity');

    gate.resolve();
    await Promise.all([active, queued]);
  });

  it('does not leak admission capacity after successful work', async () => {
    const adapter = createAdapter();
    const runtime = createSketchSessionRuntime(adapter, { budget: { maxQueuedOperations: 1 } });

    await runtime.selectTool('point');
    expect(runtime.snapshot().activeOperation).toBeNull();
    expect(runtime.snapshot().queuedOperations).toBe(0);
    await expect(runtime.selectTool('polygon')).resolves.toEqual(
      expect.objectContaining({ selectedTool: 'polygon' }),
    );
  });

  it('does not leak admission capacity after rejected adapter work', async () => {
    const adapter = createAdapter();
    adapter.beginCreate = vi.fn()
      .mockRejectedValueOnce(new Error('adapter failed'))
      .mockResolvedValue(undefined);
    const runtime = createSketchSessionRuntime(adapter, { budget: { maxQueuedOperations: 1 } });

    await expect(runtime.selectTool('point')).rejects.toThrow('adapter failed');
    expect(runtime.snapshot().activeOperation).toBeNull();
    expect(runtime.snapshot().queuedOperations).toBe(0);
    await expect(runtime.selectTool('polygon')).resolves.toEqual(
      expect.objectContaining({ selectedTool: 'polygon' }),
    );
  });

  it('records an admission diagnostic without executing rejected work', async () => {
    const gate = deferred();
    const adapter = createAdapter();
    const events: SketchDiagnosticEvent[] = [];
    adapter.beginCreate = vi.fn(() => gate.promise);
    const runtime = createSketchSessionRuntime(adapter, {
      budget: { maxQueuedOperations: 1 },
      diagnosticSink: { emit: (event) => events.push(event) },
    });

    const active = runtime.selectTool('point');
    await expect(runtime.selectTool('polygon')).rejects.toThrow('queue capacity');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'operation-rejected',
      detail: expect.objectContaining({ operation: 'begin-create', reason: 'queue-budget' }),
    }));
    expect(adapter.beginCreate).toHaveBeenCalledTimes(1);

    gate.resolve();
    await active;
  });

  it('keeps queuedOperations limited to waiting work rather than the active operation', async () => {
    const gate = deferred();
    const adapter = createAdapter();
    adapter.beginCreate = vi.fn(() => gate.promise);
    const runtime = createSketchSessionRuntime(adapter, { budget: { maxQueuedOperations: 2 } });

    const active = runtime.selectTool('point');
    expect(runtime.snapshot().queuedOperations).toBe(0);
    const queued = runtime.selectTool('polygon');
    expect(runtime.snapshot().queuedOperations).toBe(1);

    gate.resolve();
    await Promise.all([active, queued]);
    expect(runtime.snapshot().queuedOperations).toBe(0);
  });

  it('rejects queued work on dispose while allowing deterministic adapter teardown', async () => {
    const gate = deferred();
    const adapter = createAdapter();
    adapter.beginCreate = vi.fn(() => gate.promise);
    const runtime = createSketchSessionRuntime(adapter, { budget: { maxQueuedOperations: 2 } });

    const active = runtime.selectTool('point');
    const queued = runtime.selectTool('polygon');
    const disposal = runtime.dispose();

    await expect(queued).rejects.toThrow('disposed');
    expect(runtime.snapshot().state).toBe('disposed');
    expect(runtime.snapshot().queuedOperations).toBe(0);

    gate.resolve();
    await active;
    await disposal;
    expect(adapter.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects new ingest work after disposal without invoking the adapter', async () => {
    const adapter = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    await runtime.dispose();

    await expect(runtime.ingestGraphic(point('late'))).rejects.toThrow('disposed');
    expect(adapter.addGraphic).not.toHaveBeenCalled();
  });

  it('preserves FIFO execution order across admitted operations', async () => {
    const gate = deferred();
    const calls: string[] = [];
    const adapter = createAdapter();
    adapter.beginCreate = vi.fn(async (tool) => {
      calls.push(`start:${tool}`);
      if (tool === 'point') await gate.promise;
      calls.push(`end:${tool}`);
    });
    const runtime = createSketchSessionRuntime(adapter, { budget: { maxQueuedOperations: 3 } });

    const first = runtime.selectTool('point');
    const second = runtime.selectTool('polygon');
    const third = runtime.selectTool('circle');
    expect(calls).toEqual(['start:point']);

    gate.resolve();
    await Promise.all([first, second, third]);
    expect(calls).toEqual([
      'start:point',
      'end:point',
      'start:polygon',
      'end:polygon',
      'start:circle',
      'end:circle',
    ]);
  });

  it('keeps the session usable after an admission rejection', async () => {
    const gate = deferred();
    const adapter = createAdapter();
    adapter.beginCreate = vi.fn(() => gate.promise);
    const runtime = createSketchSessionRuntime(adapter, { budget: { maxQueuedOperations: 1 } });

    const active = runtime.selectTool('point');
    await expect(runtime.selectTool('polygon')).rejects.toThrow('queue capacity');
    gate.resolve();
    await active;

    adapter.beginCreate = vi.fn();
    await expect(runtime.selectTool('circle')).resolves.toEqual(
      expect.objectContaining({ selectedTool: 'circle' }),
    );
    expect(runtime.snapshot().errors).toBe(0);
  });

  it('reports adapter failure separately from admission rejection', async () => {
    const adapter = createAdapter();
    const events: SketchDiagnosticEvent[] = [];
    adapter.beginCreate = vi.fn().mockRejectedValue(new Error('adapter failed'));
    const runtime = createSketchSessionRuntime(adapter, {
      diagnosticSink: { emit: (event) => events.push(event) },
    });

    await expect(runtime.selectTool('point')).rejects.toThrow('adapter failed');
    expect(events).toContainEqual(expect.objectContaining({ type: 'operation-failed' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'operation-rejected' }));
  });
});
