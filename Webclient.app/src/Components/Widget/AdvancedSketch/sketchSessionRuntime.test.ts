import { describe, expect, it, vi } from 'vitest';
import type {
  SketchDocument,
  SketchGraphicSnapshot,
  SketchViewAdapter,
} from './sketchContracts';
import { createSketchDocument } from './sketchDocumentRuntime';
import { createSketchSessionRuntime } from './sketchSessionRuntime';
import { DEFAULT_SKETCH_STYLE, withLineColor } from './sketchStyleRuntime';

const graphic = (id: string): SketchGraphicSnapshot => Object.freeze({
  id,
  geometry: Object.freeze({
    type: 'point',
    spatialReferenceWkid: 4326,
    payload: Object.freeze({ type: 'point', x: 32.85, y: 39.92 }),
  }),
  attributes: Object.freeze({ name: id }),
  symbol: null,
  createdAt: 1,
  updatedAt: 1,
});

const createAdapter = () => {
  const state: { graphics: SketchGraphicSnapshot[]; destroyed: boolean } = {
    graphics: [],
    destroyed: false,
  };
  const adapter: SketchViewAdapter = {
    addGraphic: vi.fn((item: SketchGraphicSnapshot) => {
      state.graphics.push(item);
    }),
    replaceGraphics: vi.fn((items: readonly SketchGraphicSnapshot[]) => {
      state.graphics = [...items];
    }),
    removeGraphic: vi.fn((id: string) => {
      state.graphics = state.graphics.filter((item) => item.id !== id);
    }),
    clearGraphics: vi.fn(() => {
      state.graphics = [];
    }),
    beginCreate: vi.fn(),
    cancelCreate: vi.fn(),
    destroy: vi.fn(() => {
      state.destroyed = true;
    }),
  };
  return { adapter, state };
};

describe('sketchSessionRuntime', () => {
  it('starts ready with move selected', () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    expect(runtime.snapshot()).toEqual(expect.objectContaining({
      state: 'ready',
      selectedTool: 'move',
      graphicsCount: 0,
    }));
  });

  it('begins drawing with the selected tool and current style', async () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    const result = await runtime.selectTool('polygon');
    expect(result.selectedTool).toBe('polygon');
    expect(result.state).toBe('drawing');
    expect(adapter.beginCreate).toHaveBeenCalledWith('polygon', DEFAULT_SKETCH_STYLE);
  });

  it('moving to selection mode cancels active creation', async () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    await runtime.selectTool('point');
    const result = await runtime.selectTool('move');
    expect(result.selectedTool).toBe('move');
    expect(result.state).toBe('ready');
    expect(adapter.cancelCreate).toHaveBeenCalled();
  });

  it('clear tool clears graphics and returns to move', async () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    await runtime.ingestGraphic(graphic('a'));
    const result = await runtime.selectTool('clear');
    expect(result.selectedTool).toBe('move');
    expect(result.graphicsCount).toBe(0);
    expect(adapter.clearGraphics).toHaveBeenCalled();
  });

  it('ingests new graphics through the adapter', async () => {
    const { adapter, state } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    const result = await runtime.ingestGraphic(graphic('a'));
    expect(result.graphicsCount).toBe(1);
    expect(state.graphics.map((item) => item.id)).toEqual(['a']);
    expect(adapter.addGraphic).toHaveBeenCalledTimes(1);
  });

  it('replaces a duplicate id instead of adding another graphic', async () => {
    const { adapter, state } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    await runtime.ingestGraphic(graphic('a'));
    await runtime.ingestGraphic(Object.freeze({
      ...graphic('a'),
      updatedAt: 2,
    }));
    expect(runtime.snapshot().graphicsCount).toBe(1);
    expect(state.graphics).toHaveLength(1);
    expect(adapter.replaceGraphics).toHaveBeenCalled();
  });

  it('observes already-rendered graphics without adding duplicates', () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    const result = runtime.observeGraphic(graphic('view-owned'));
    expect(result.graphicsCount).toBe(1);
    expect(adapter.addGraphic).not.toHaveBeenCalled();
    expect(adapter.replaceGraphics).not.toHaveBeenCalled();
  });

  it('observes complete view collections after edit events', () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    const result = runtime.observeGraphics([graphic('a'), graphic('b')]);
    expect(result.graphicsCount).toBe(2);
    expect(adapter.replaceGraphics).not.toHaveBeenCalled();
  });

  it('enforces the graphic budget for ingest and observe', async () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter, {
      budget: { maxGraphics: 1 },
    });
    await runtime.ingestGraphic(graphic('a'));
    await expect(runtime.ingestGraphic(graphic('b'))).rejects.toThrow('budget');
    expect(() => runtime.observeGraphic(graphic('c'))).toThrow('budget');
  });

  it('removes graphics by id', async () => {
    const { adapter, state } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    await runtime.ingestGraphic(graphic('a'));
    await runtime.ingestGraphic(graphic('b'));
    const result = await runtime.removeGraphic('a');
    expect(result.graphicsCount).toBe(1);
    expect(state.graphics.map((item) => item.id)).toEqual(['b']);
    expect(adapter.removeGraphic).toHaveBeenCalledWith('a');
  });

  it('ignores removal of unknown ids', async () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    await runtime.ingestGraphic(graphic('a'));
    const before = runtime.snapshot().history.size;
    const result = await runtime.removeGraphic('missing');
    expect(result.graphicsCount).toBe(1);
    expect(runtime.snapshot().history.size).toBe(before);
  });

  it('rejects blank ids on removal', async () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    await expect(runtime.removeGraphic('   ')).rejects.toThrow('id is required');
  });

  it('undo and redo replace adapter graphics', async () => {
    const { adapter, state } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    await runtime.ingestGraphic(graphic('a'));
    await runtime.ingestGraphic(graphic('b'));

    const undone = await runtime.undo();
    expect(undone.graphicsCount).toBe(1);
    expect(state.graphics.map((item) => item.id)).toEqual(['a']);

    const redone = await runtime.redo();
    expect(redone.graphicsCount).toBe(2);
    expect(state.graphics.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('imports validated documents and style', async () => {
    const { adapter, state } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    const style = withLineColor(DEFAULT_SKETCH_STYLE, '#123456');
    const document: SketchDocument = createSketchDocument(
      [graphic('imported')],
      style,
      'Import',
    );
    const result = await runtime.importDocument(document);
    expect(result.graphicsCount).toBe(1);
    expect(result.selectedTool).toBe('move');
    expect(state.graphics.map((item) => item.id)).toEqual(['imported']);
  });

  it('exports current graphics and style', () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    runtime.observeGraphic(graphic('a'));
    runtime.setStyle(withLineColor(DEFAULT_SKETCH_STYLE, '#654321'));
    const document = runtime.exportDocument('Export');
    expect(document.title).toBe('Export');
    expect(document.graphics.map((item) => item.id)).toEqual(['a']);
    expect(document.style.line.color).toBe('#654321');
  });

  it('updates style immutably', () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    const nextStyle = withLineColor(DEFAULT_SKETCH_STYLE, '#abcdef');
    runtime.setStyle(nextStyle);
    expect(DEFAULT_SKETCH_STYLE.line.color).toBe('#828282');
    expect(runtime.exportDocument().style.line.color).toBe('#abcdef');
  });

  it('enforces operation queue capacity', async () => {
    let release!: () => void;
    const { adapter } = createAdapter();
    adapter.beginCreate = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const runtime = createSketchSessionRuntime(adapter, {
      budget: { maxQueuedOperations: 1 },
    });

    const first = runtime.selectTool('point');
    const second = runtime.selectTool('polygon');
    await expect(runtime.selectTool('circle')).rejects.toThrow('queue capacity');
    release();
    await first;
    await second;
  });

  it('times out stalled adapter operations', async () => {
    vi.useFakeTimers();
    try {
      const { adapter } = createAdapter();
      adapter.beginCreate = vi.fn(() => new Promise<void>(() => undefined));
      const runtime = createSketchSessionRuntime(adapter, {
        budget: { operationTimeoutMs: 1_000 },
      });
      const pending = runtime.selectTool('point');
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).rejects.toThrow('exceeded 1000ms');
      expect(runtime.snapshot().errors).toBe(1);
      expect(runtime.snapshot().state).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits diagnostics without allowing sink failures to break operations', async () => {
    const { adapter } = createAdapter();
    const emit = vi.fn(() => {
      throw new Error('sink failed');
    });
    const runtime = createSketchSessionRuntime(adapter, {
      diagnosticSink: { emit },
    });
    await expect(runtime.selectTool('point')).resolves.toEqual(
      expect.objectContaining({ selectedTool: 'point' }),
    );
    expect(emit).toHaveBeenCalled();
  });

  it('disposes adapter resources and rejects new work', async () => {
    const { adapter, state } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    await runtime.dispose();
    expect(state.destroyed).toBe(true);
    expect(runtime.snapshot().state).toBe('disposed');
    await expect(runtime.selectTool('point')).rejects.toThrow('disposed');
  });

  it('dispose is idempotent', async () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    await runtime.dispose();
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(adapter.destroy).toHaveBeenCalledTimes(1);
  });

  it('clear is explicit and records history', async () => {
    const { adapter } = createAdapter();
    const runtime = createSketchSessionRuntime(adapter);
    await runtime.ingestGraphic(graphic('a'));
    const before = runtime.snapshot().history.size;
    const result = await runtime.clear('User clear');
    expect(result.graphicsCount).toBe(0);
    expect(result.history.size).toBe(before + 1);
  });
});
