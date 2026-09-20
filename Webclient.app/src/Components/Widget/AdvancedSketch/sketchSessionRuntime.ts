import type {
  JsonObject,
  SketchDiagnosticEvent,
  SketchDiagnosticSink,
  SketchDocument,
  SketchGraphicSnapshot,
  SketchSessionBudget,
  SketchSessionRuntime,
  SketchSessionSnapshot,
  SketchStyleState,
  SketchTool,
  SketchViewAdapter,
} from './sketchContracts';
import { isDrawingTool, isSketchTool } from './sketchContracts';
import { createSketchDocument } from './sketchDocumentRuntime';
import { createSketchHistoryRuntime } from './sketchHistoryRuntime';
import { createSketchMetricsRuntime } from './sketchMetricsRuntime';
import { DEFAULT_SKETCH_STYLE, normalizeSketchStyle } from './sketchStyleRuntime';

const DEFAULT_BUDGET: SketchSessionBudget = Object.freeze({
  maxGraphics: 2_000,
  maxHistoryEntries: 64,
  maxQueuedOperations: 32,
  operationTimeoutMs: 15_000,
});

const normalizeBudget = (input: Partial<SketchSessionBudget> = {}): SketchSessionBudget => Object.freeze({
  maxGraphics: Math.min(20_000, Math.max(1, Math.floor(input.maxGraphics ?? DEFAULT_BUDGET.maxGraphics))),
  maxHistoryEntries: Math.min(512, Math.max(2, Math.floor(input.maxHistoryEntries ?? DEFAULT_BUDGET.maxHistoryEntries))),
  maxQueuedOperations: Math.min(256, Math.max(1, Math.floor(input.maxQueuedOperations ?? DEFAULT_BUDGET.maxQueuedOperations))),
  operationTimeoutMs: Math.min(120_000, Math.max(1_000, Math.floor(input.operationTimeoutMs ?? DEFAULT_BUDGET.operationTimeoutMs))),
});

const noopSink: SketchDiagnosticSink = Object.freeze({ emit: () => undefined });

interface Operation<T> {
  readonly id: string;
  readonly run: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error ?? 'Unknown sketch error'));

const cloneGraphics = (values: readonly SketchGraphicSnapshot[]): readonly SketchGraphicSnapshot[] =>
  Object.freeze([...values]);

export const createSketchSessionRuntime = (
  adapter: SketchViewAdapter,
  options: {
    readonly budget?: Partial<SketchSessionBudget>;
    readonly initialStyle?: SketchStyleState;
    readonly diagnosticSink?: SketchDiagnosticSink;
    readonly now?: () => number;
  } = {},
): SketchSessionRuntime => {
  const budget = normalizeBudget(options.budget);
  const history = createSketchHistoryRuntime([], {
    maxEntries: budget.maxHistoryEntries,
    now: options.now,
  });
  const metrics = createSketchMetricsRuntime();
  const sink = options.diagnosticSink ?? noopSink;
  const now = options.now ?? Date.now;

  let disposed = false;
  let state: SketchSessionSnapshot['state'] = 'ready';
  let selectedTool: SketchTool = 'move';
  let graphics: readonly SketchGraphicSnapshot[] = Object.freeze([]);
  let style = normalizeSketchStyle(options.initialStyle ?? DEFAULT_SKETCH_STYLE);
  let activeOperation: string | null = null;
  let errors = 0;
  let lastError: string | null = null;
  let operationSequence = 0;
  const queue: Operation<unknown>[] = [];
  let draining = false;

  const emit = (
    type: SketchDiagnosticEvent['type'],
    detail: Readonly<Record<string, string | number | boolean | null>> = Object.freeze({}),
  ): void => {
    try {
      sink.emit(Object.freeze({ type, timestamp: now(), detail }));
    } catch (diagnosticError) {
      // Diagnostics are non-authoritative, but observer failures must remain visible.
      globalThis.reportError?.(diagnosticError);
    }
  };

  const snapshot = (): SketchSessionSnapshot => Object.freeze({
    state,
    selectedTool,
    graphicsCount: graphics.length,
    queuedOperations: queue.length,
    activeOperation,
    errors,
    lastError,
    history: history.snapshot(),
  });

  const fail = (error: unknown, operation: string): Error => {
    const normalized = normalizeError(error);
    errors += 1;
    lastError = normalized.message.slice(0, 500);
    state = disposed ? 'disposed' : 'error';
    metrics.recordFailure();
    emit('operation-failed', { operation, message: lastError });
    return normalized;
  };

  const withTimeout = async <T>(operation: string, task: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = globalThis.setTimeout(() => {
        reject(new Error(`Sketch operation ${operation} exceeded ${budget.operationTimeoutMs}ms.`));
      }, budget.operationTimeoutMs);
    });
    try {
      return await Promise.race([task(), timeout]);
    } finally {
      if (timer !== null) globalThis.clearTimeout(timer);
    }
  };

  const drain = async (): Promise<void> => {
    if (draining || disposed) return;
    draining = true;
    try {
      while (queue.length > 0 && !disposed) {
        const operation = queue.shift();
        if (!operation) continue;
        activeOperation = operation.id;
        state = selectedTool === 'move' ? 'updating' : 'drawing';
        try {
          const value = await withTimeout(operation.id, operation.run);
          state = selectedTool === 'move' ? 'ready' : 'drawing';
          lastError = null;
          operation.resolve(value);
        } catch (error) {
          operation.reject(fail(error, operation.id));
        } finally {
          activeOperation = null;
        }
      }
    } finally {
      draining = false;
      if (!disposed && state === 'updating') state = 'ready';
    }
  };

  const enqueue = <T>(name: string, run: () => Promise<T>): Promise<T> => {
    if (disposed) return Promise.reject(new Error('Sketch session is disposed.'));
    if (queue.length >= budget.maxQueuedOperations) {
      emit('operation-rejected', { operation: name, reason: 'queue-budget' });
      return Promise.reject(new RangeError('Sketch operation queue capacity exceeded.'));
    }
    return new Promise<T>((resolve, reject) => {
      operationSequence += 1;
      queue.push({
        id: `${name}-${operationSequence}`,
        run,
        resolve: (value) => resolve(value as T),
        reject,
      } as Operation<unknown>);
      void drain();
    });
  };

  const persistHistory = (label: string): void => {
    history.record(label, graphics);
  };

  const replaceGraphics = async (
    next: readonly SketchGraphicSnapshot[],
    label: string,
  ): Promise<void> => {
    if (next.length > budget.maxGraphics) {
      throw new RangeError(`Sketch graphic budget ${budget.maxGraphics} exceeded.`);
    }
    await adapter.replaceGraphics(next);
    graphics = cloneGraphics(next);
    persistHistory(label);
  };

  const selectTool = async (toolInput: SketchTool): Promise<SketchSessionSnapshot> => {
    if (!isSketchTool(toolInput)) throw new TypeError('Unknown sketch tool.');
    if (disposed) throw new Error('Sketch session is disposed.');

    if (toolInput === 'clear') {
      await enqueue('clear', async () => {
        await adapter.cancelCreate();
        await adapter.clearGraphics();
        graphics = Object.freeze([]);
        persistHistory('Clear drawings');
        metrics.recordClear();
        emit('graphics-cleared');
      });
      selectedTool = 'move';
      state = 'ready';
      return snapshot();
    }

    selectedTool = toolInput;
    metrics.recordToolSelection(toolInput);
    if (isDrawingTool(toolInput)) {
      await enqueue('begin-create', async () => {
        await adapter.beginCreate(toolInput, style);
      });
      state = 'drawing';
    } else {
      await enqueue('cancel-create', async () => {
        await adapter.cancelCreate();
      });
      state = 'ready';
    }
    emit('tool-selected', { tool: toolInput });
    return snapshot();
  };

  const ingestGraphic = async (
    graphic: SketchGraphicSnapshot,
    label = 'Add drawing',
  ): Promise<SketchSessionSnapshot> => {
    await enqueue('ingest-graphic', async () => {
      const existingIndex = graphics.findIndex((item) => item.id === graphic.id);
      const next = existingIndex >= 0
        ? graphics.map((item, index) => index === existingIndex ? graphic : item)
        : [...graphics, graphic];
      if (next.length > budget.maxGraphics) {
        throw new RangeError(`Sketch graphic budget ${budget.maxGraphics} exceeded.`);
      }
      if (existingIndex >= 0) await adapter.replaceGraphics(next);
      else await adapter.addGraphic(graphic);
      graphics = cloneGraphics(next);
      persistHistory(label);
      emit('graphic-added', { id: graphic.id });
    });
    return snapshot();
  };

  const observeGraphic = (
    graphic: SketchGraphicSnapshot,
    label = 'Observe drawing',
  ): SketchSessionSnapshot => {
    if (disposed) throw new Error('Sketch session is disposed.');
    const existingIndex = graphics.findIndex((item) => item.id === graphic.id);
    const next = existingIndex >= 0
      ? graphics.map((item, index) => index === existingIndex ? graphic : item)
      : [...graphics, graphic];
    if (next.length > budget.maxGraphics) {
      throw new RangeError(`Sketch graphic budget ${budget.maxGraphics} exceeded.`);
    }
    graphics = cloneGraphics(next);
    persistHistory(label);
    emit('graphic-added', { id: graphic.id });
    return snapshot();
  };

  const observeGraphics = (
    observed: readonly SketchGraphicSnapshot[],
    label = 'Observe drawing update',
  ): SketchSessionSnapshot => {
    if (disposed) throw new Error('Sketch session is disposed.');
    if (observed.length > budget.maxGraphics) {
      throw new RangeError(`Sketch graphic budget ${budget.maxGraphics} exceeded.`);
    }
    graphics = cloneGraphics(observed);
    persistHistory(label);
    return snapshot();
  };

  const removeGraphic = async (
    idInput: string,
    label = 'Remove drawing',
  ): Promise<SketchSessionSnapshot> => {
    const id = String(idInput ?? '').trim();
    if (!id) throw new TypeError('Graphic id is required.');
    await enqueue('remove-graphic', async () => {
      const next = graphics.filter((graphic) => graphic.id !== id);
      if (next.length === graphics.length) return;
      await adapter.removeGraphic(id);
      graphics = cloneGraphics(next);
      persistHistory(label);
      emit('graphic-removed', { id });
    });
    return snapshot();
  };

  const clear = async (label = 'Clear drawings'): Promise<SketchSessionSnapshot> => {
    await enqueue('clear', async () => {
      await adapter.cancelCreate();
      await adapter.clearGraphics();
      graphics = Object.freeze([]);
      persistHistory(label);
      metrics.recordClear();
      emit('graphics-cleared');
    });
    selectedTool = 'move';
    state = 'ready';
    return snapshot();
  };

  const undo = async (): Promise<SketchSessionSnapshot> => {
    const previous = history.undo();
    if (!previous) return snapshot();
    await enqueue('undo', async () => {
      await adapter.cancelCreate();
      await adapter.replaceGraphics(previous);
      graphics = cloneGraphics(previous);
      metrics.recordUndo();
      emit('history-undo');
    });
    selectedTool = 'move';
    state = 'ready';
    return snapshot();
  };

  const redo = async (): Promise<SketchSessionSnapshot> => {
    const next = history.redo();
    if (!next) return snapshot();
    await enqueue('redo', async () => {
      await adapter.cancelCreate();
      await adapter.replaceGraphics(next);
      graphics = cloneGraphics(next);
      metrics.recordRedo();
      emit('history-redo');
    });
    selectedTool = 'move';
    state = 'ready';
    return snapshot();
  };

  const importDocument = async (document: SketchDocument): Promise<SketchSessionSnapshot> => {
    await enqueue('import-document', async () => {
      await adapter.cancelCreate();
      style = normalizeSketchStyle(document.style);
      await replaceGraphics(document.graphics, 'Import sketch document');
      metrics.recordImport();
      emit('document-imported', { graphics: document.graphics.length });
    });
    selectedTool = 'move';
    state = 'ready';
    return snapshot();
  };

  const exportDocument = (title = 'Çizim'): SketchDocument => {
    if (disposed) throw new Error('Sketch session is disposed.');
    metrics.recordExport();
    emit('document-exported', { graphics: graphics.length });
    const metadata: JsonObject = Object.freeze({
      metrics: JSON.stringify(metrics.calculate(graphics)),
    });
    return createSketchDocument(graphics, style, title, metadata, new Date(now()));
  };

  const setStyle = (nextStyle: SketchStyleState): SketchSessionSnapshot => {
    if (disposed) throw new Error('Sketch session is disposed.');
    style = normalizeSketchStyle(nextStyle, style);
    return snapshot();
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    state = 'disposed';
    const pending = queue.splice(0, queue.length);
    for (const operation of pending) operation.reject(new Error('Sketch session disposed.'));
    try {
      await adapter.cancelCreate();
    } finally {
      await adapter.destroy();
      emit('disposed');
    }
  };

  return Object.freeze({
    selectTool,
    ingestGraphic,
    observeGraphic,
    observeGraphics,
    removeGraphic,
    clear,
    undo,
    redo,
    importDocument,
    exportDocument,
    setStyle,
    snapshot,
    dispose,
  });
};
