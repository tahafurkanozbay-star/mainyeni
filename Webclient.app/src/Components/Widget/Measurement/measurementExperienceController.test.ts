import { describe, expect, it, vi } from 'vitest';
import {
  MEASUREMENT_TOOLS,
  type MeasurementController,
  type MeasurementDiagnostic,
  type MeasurementListener,
  type MeasurementState,
  type MeasurementTool,
  type MeasurementWidgetLike,
} from '../../../gis-engine/measurementRuntime';
import {
  createMeasurementExperienceController,
  type MeasurementRuntimeFactory,
} from './measurementExperienceController';

const createState = (overrides: Partial<MeasurementState> = {}): MeasurementState => ({
  status: 'idle',
  activeTool: MEASUREMENT_TOOLS.NONE,
  error: null,
  createdAt: null,
  clearedAt: null,
  destroyedAt: null,
  ...overrides,
});

interface FakeRuntimeHarness {
  readonly runtime: MeasurementController;
  readonly ensureWidget: ReturnType<typeof vi.fn<() => Promise<MeasurementWidgetLike | null>>>;
  readonly setTool: ReturnType<typeof vi.fn<(tool: unknown) => Promise<MeasurementWidgetLike | null>>>;
  readonly clear: ReturnType<typeof vi.fn<() => boolean>>;
  readonly destroy: ReturnType<typeof vi.fn<() => void>>;
  readonly setView: ReturnType<typeof vi.fn<(view: unknown) => boolean>>;
  readonly setContainer: ReturnType<typeof vi.fn<(container: unknown) => boolean>>;
  readonly emit: (state: MeasurementState) => void;
  readonly diagnose: (diagnostic: MeasurementDiagnostic) => void;
  readonly setState: (state: MeasurementState) => void;
}

const createFakeRuntime = (
  onDiagnostic?: (diagnostic: MeasurementDiagnostic) => void,
): FakeRuntimeHarness => {
  let state = createState();
  let destroyed = false;
  const listeners = new Set<MeasurementListener>();
  const widget: MeasurementWidgetLike = { activeTool: MEASUREMENT_TOOLS.NONE };

  const emit = (nextState: MeasurementState): void => {
    state = nextState;
    for (const listener of listeners) listener(nextState);
  };

  const ensureWidget = vi.fn(async () => {
    emit(createState({ status: 'ready', activeTool: state.activeTool, createdAt: '2026-10-01T12:00:00.000Z' }));
    return widget;
  });
  const setTool = vi.fn(async (tool: unknown) => {
    const normalized = tool as MeasurementTool;
    widget.activeTool = normalized;
    emit(createState({ status: 'ready', activeTool: normalized, createdAt: state.createdAt }));
    return widget;
  });
  const clear = vi.fn(() => {
    widget.activeTool = MEASUREMENT_TOOLS.NONE;
    emit(createState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.NONE, clearedAt: '2026-10-01T12:01:00.000Z' }));
    return true;
  });
  const setView = vi.fn(() => !destroyed);
  const setContainer = vi.fn(() => !destroyed);
  const destroy = vi.fn(() => {
    destroyed = true;
    listeners.clear();
    state = createState({ status: 'destroyed', destroyedAt: '2026-10-01T12:02:00.000Z' });
  });
  const runtime: MeasurementController = {
    ensureWidget,
    setTool,
    clear,
    setView,
    setContainer,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    destroy,
    getWidget: () => widget,
    getState: () => ({ ...state, error: state.error ? { ...state.error } : null }),
    get destroyed() {
      return destroyed;
    },
  };

  return {
    runtime,
    ensureWidget,
    setTool,
    clear,
    destroy,
    setView,
    setContainer,
    emit,
    diagnose(diagnostic) {
      onDiagnostic?.(diagnostic);
    },
    setState(nextState) {
      state = nextState;
    },
  };
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('measurementExperienceController', () => {
  it('opens into waiting-map without constructing an ArcGIS runtime when no view exists', async () => {
    const runtimeFactory = vi.fn<MeasurementRuntimeFactory>();
    const controller = createMeasurementExperienceController({
      getView: () => null,
      container: 'measurementDiv',
      runtimeFactory,
    });

    await expect(controller.open()).resolves.toBe(false);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual(expect.objectContaining({
      visible: true,
      viewReady: false,
      phase: 'waiting-map',
    }));
  });

  it('creates one runtime and initializes it when the view is ready', async () => {
    const view = { id: 'map-view' };
    const fake = createFakeRuntime();
    const runtimeFactory = vi.fn<MeasurementRuntimeFactory>(() => fake.runtime);
    const controller = createMeasurementExperienceController({
      getView: () => view,
      container: 'measurementDiv',
      runtimeFactory,
    });

    await expect(controller.open()).resolves.toBe(true);
    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(runtimeFactory).toHaveBeenCalledWith(expect.objectContaining({
      view,
      container: 'measurementDiv',
    }));
    expect(fake.ensureWidget).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toEqual(expect.objectContaining({
      visible: true,
      viewReady: true,
      phase: 'ready',
    }));
    expect(controller.getDiagnostics().runtimeCreationCount).toBe(1);
  });

  it('reuses the same runtime for subsequent tool activations', async () => {
    const view = { id: 'view' };
    const fake = createFakeRuntime();
    const runtimeFactory = vi.fn<MeasurementRuntimeFactory>(() => fake.runtime);
    const controller = createMeasurementExperienceController({
      getView: () => view,
      container: 'measurementDiv',
      runtimeFactory,
    });

    await controller.open();
    await expect(controller.selectTool(MEASUREMENT_TOOLS.AREA)).resolves.toBe(true);
    await expect(controller.selectTool(MEASUREMENT_TOOLS.DISTANCE)).resolves.toBe(true);

    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(fake.setTool).toHaveBeenNthCalledWith(1, MEASUREMENT_TOOLS.AREA);
    expect(fake.setTool).toHaveBeenNthCalledWith(2, MEASUREMENT_TOOLS.DISTANCE);
    expect(controller.getSnapshot().activeTool).toBe(MEASUREMENT_TOOLS.DISTANCE);
  });

  it('toggles an already-active tool by clearing instead of reactivating it', async () => {
    const fake = createFakeRuntime();
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
    });

    await controller.open();
    await controller.selectTool(MEASUREMENT_TOOLS.AREA);
    expect(controller.getSnapshot().activeTool).toBe(MEASUREMENT_TOOLS.AREA);

    await expect(controller.selectTool(MEASUREMENT_TOOLS.AREA)).resolves.toBe(true);
    expect(fake.setTool).toHaveBeenCalledTimes(1);
    expect(fake.clear).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().activeTool).toBe(MEASUREMENT_TOOLS.NONE);
  });

  it('clears a measurement and synchronizes the runtime state', async () => {
    const fake = createFakeRuntime();
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
    });
    await controller.open();
    await controller.selectTool(MEASUREMENT_TOOLS.DISTANCE);

    expect(controller.clear()).toBe(true);
    expect(fake.clear).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toEqual(expect.objectContaining({
      activeTool: MEASUREMENT_TOOLS.NONE,
      canClear: false,
      errorMessage: null,
    }));
  });

  it('converts a failed clear into a safe visible error state', async () => {
    const fake = createFakeRuntime();
    fake.clear.mockReturnValue(false);
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
    });
    await controller.open();

    expect(controller.clear()).toBe(false);
    expect(controller.getSnapshot()).toEqual(expect.objectContaining({
      phase: 'error',
      errorCode: 'MEASUREMENT_CLEAR_ERROR',
      canRetry: true,
    }));
  });

  it('refreshes view readiness without creating a runtime eagerly', () => {
    let view: unknown = null;
    const runtimeFactory = vi.fn<MeasurementRuntimeFactory>();
    const controller = createMeasurementExperienceController({
      getView: () => view,
      container: 'measurementDiv',
      runtimeFactory,
    });

    expect(controller.refreshView()).toBe(false);
    expect(controller.getSnapshot().viewReady).toBe(false);
    view = { id: 'ready' };
    expect(controller.refreshView()).toBe(true);
    expect(controller.getSnapshot().viewReady).toBe(true);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it('updates the runtime view and container when the current runtime remains usable', async () => {
    let view: unknown = { id: 'first' };
    const fake = createFakeRuntime();
    const controller = createMeasurementExperienceController({
      getView: () => view,
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
    });
    await controller.open();

    view = { id: 'second' };
    expect(controller.refreshView()).toBe(true);
    expect(fake.setView).toHaveBeenLastCalledWith(view);
    expect(fake.setContainer).toHaveBeenLastCalledWith('measurementDiv');
  });

  it('destroys and replaces a runtime when a different view reaches an operation', async () => {
    let view: unknown = { id: 'first' };
    const first = createFakeRuntime();
    const second = createFakeRuntime();
    const runtimeFactory = vi.fn<MeasurementRuntimeFactory>()
      .mockReturnValueOnce(first.runtime)
      .mockReturnValueOnce(second.runtime);
    const controller = createMeasurementExperienceController({
      getView: () => view,
      container: 'measurementDiv',
      runtimeFactory,
    });
    await controller.open();

    view = { id: 'second' };
    await controller.selectTool(MEASUREMENT_TOOLS.AREA);

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(runtimeFactory).toHaveBeenCalledTimes(2);
    expect(controller.getDiagnostics()).toEqual(expect.objectContaining({
      runtimeCreationCount: 2,
      runtimeReplacementCount: 1,
    }));
  });

  it('ignores a stale tool completion after a newer tool operation wins', async () => {
    const firstOperation = deferred<MeasurementWidgetLike | null>();
    const secondOperation = deferred<MeasurementWidgetLike | null>();
    const fake = createFakeRuntime();
    fake.setTool
      .mockImplementationOnce(() => firstOperation.promise)
      .mockImplementationOnce(() => secondOperation.promise);
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
    });
    await controller.open();

    const first = controller.selectTool(MEASUREMENT_TOOLS.AREA);
    const second = controller.selectTool(MEASUREMENT_TOOLS.DISTANCE);
    fake.setState(createState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.DISTANCE }));
    secondOperation.resolve({ activeTool: MEASUREMENT_TOOLS.DISTANCE });
    await expect(second).resolves.toBe(true);

    fake.setState(createState({ status: 'ready', activeTool: MEASUREMENT_TOOLS.AREA }));
    firstOperation.resolve({ activeTool: MEASUREMENT_TOOLS.AREA });
    await expect(first).resolves.toBe(false);
    expect(controller.getDiagnostics().staleCompletionCount).toBeGreaterThanOrEqual(1);
  });

  it('invalidates an in-flight operation when the window closes', async () => {
    const operation = deferred<MeasurementWidgetLike | null>();
    const fake = createFakeRuntime();
    fake.setTool.mockImplementationOnce(() => operation.promise);
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
    });
    await controller.open();

    const pending = controller.selectTool(MEASUREMENT_TOOLS.AREA);
    controller.close();
    operation.resolve({ activeTool: MEASUREMENT_TOOLS.AREA });

    await expect(pending).resolves.toBe(false);
    expect(controller.getSnapshot().visible).toBe(false);
    expect(controller.getDiagnostics().staleCompletionCount).toBeGreaterThanOrEqual(1);
  });

  it('contains initialization failures and exposes bounded retry', async () => {
    const fake = createFakeRuntime();
    fake.ensureWidget.mockRejectedValueOnce(Object.assign(new Error('sdk failed'), { code: 'SDK_LOAD_FAILED' }));
    const diagnostics = vi.fn();
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
      onDiagnostic: diagnostics,
    });

    await expect(controller.open()).resolves.toBe(false);
    expect(controller.getSnapshot()).toEqual(expect.objectContaining({
      phase: 'error',
      errorMessage: 'sdk failed',
      errorCode: 'SDK_LOAD_FAILED',
      canRetry: true,
    }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'initialize',
      code: 'SDK_LOAD_FAILED',
    }));
  });

  it('retries failed initialization only within the configured budget', async () => {
    const fake = createFakeRuntime();
    fake.ensureWidget
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockImplementationOnce(async () => {
        fake.setState(createState({
          status: 'ready',
          activeTool: MEASUREMENT_TOOLS.NONE,
          createdAt: '2026-10-01T12:03:00.000Z',
        }));
        return { activeTool: MEASUREMENT_TOOLS.NONE };
      });
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
      modelOptions: { maxRetries: 2 },
    });

    expect(await controller.open()).toBe(false);
    expect(await controller.retry()).toBe(false);
    expect(controller.getSnapshot().retryCount).toBe(1);
    expect(controller.getSnapshot().canRetry).toBe(true);
    expect(await controller.retry()).toBe(true);
    expect(controller.getSnapshot().retryCount).toBe(0);
    expect(controller.getSnapshot().phase).toBe('ready');
  });

  it('does not retry when the model has exhausted its budget', async () => {
    const fake = createFakeRuntime();
    fake.ensureWidget.mockRejectedValue(new Error('always fails'));
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
      modelOptions: { maxRetries: 1 },
    });

    expect(await controller.open()).toBe(false);
    expect(await controller.retry()).toBe(false);
    expect(controller.getSnapshot().retryCount).toBe(1);
    expect(controller.getSnapshot().canRetry).toBe(false);
    expect(await controller.retry()).toBe(false);
  });

  it('records runtime diagnostics without leaking raw error objects into the snapshot', async () => {
    let runtimeDiagnostic: ((diagnostic: MeasurementDiagnostic) => void) | undefined;
    const fake = createFakeRuntime();
    const runtimeFactory: MeasurementRuntimeFactory = (options) => {
      runtimeDiagnostic = options.onDiagnostic;
      return fake.runtime;
    };
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory,
    });
    await controller.open();

    runtimeDiagnostic?.({
      phase: 'tool',
      code: 'TOOL_FAIL',
      message: '  araç\n başarısız  ',
      error: { secret: 'not retained' },
    });

    expect(controller.getSnapshot()).toEqual(expect.objectContaining({
      phase: 'error',
      errorMessage: 'araç başarısız',
      errorCode: 'TOOL_FAIL',
    }));
  });

  it('contains a failing diagnostic reporter', async () => {
    const fake = createFakeRuntime();
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
      onDiagnostic() {
        throw new TypeError('reporter failure');
      },
    });
    fake.ensureWidget.mockRejectedValueOnce(new Error('load failure'));

    await expect(controller.open()).resolves.toBe(false);
    expect(controller.getDiagnostics()).toEqual(expect.objectContaining({
      controllerFailureCount: 1,
      reporterFailureCount: 1,
      lastFailureKind: 'reporter:TypeError',
    }));
  });

  it('contains view lookup failures and keeps the UI in waiting-map state', async () => {
    const diagnostic = vi.fn();
    const controller = createMeasurementExperienceController({
      getView() {
        throw new RangeError('view lookup failed');
      },
      container: 'measurementDiv',
      onDiagnostic: diagnostic,
    });

    await expect(controller.open()).resolves.toBe(false);
    expect(controller.getSnapshot().phase).toBe('waiting-map');
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'view',
      code: 'MEASUREMENT_VIEW_LOOKUP_ERROR',
      failureKind: 'RangeError',
    }));
  });

  it('forwards keyboard and pointer modality to the session model', () => {
    const controller = createMeasurementExperienceController({
      getView: () => null,
      container: 'measurementDiv',
    });

    controller.recordInputModality('keyboard');
    expect(controller.getSnapshot().modality).toBe('keyboard');
    controller.recordInputModality('pointer');
    expect(controller.getSnapshot().modality).toBe('pointer');
  });

  it('notifies external-store subscribers through model transitions', async () => {
    const fake = createFakeRuntime();
    const observer = vi.fn();
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
    });
    const unsubscribe = controller.subscribe(observer);

    await controller.open();
    await controller.selectTool(MEASUREMENT_TOOLS.AREA);
    controller.clear();
    unsubscribe();
    const count = observer.mock.calls.length;
    controller.recordInputModality('keyboard');

    expect(count).toBeGreaterThan(2);
    expect(observer).toHaveBeenCalledTimes(count);
  });

  it('disposes runtime, observers and future operations deterministically', async () => {
    const fake = createFakeRuntime();
    const controller = createMeasurementExperienceController({
      getView: () => ({ id: 'view' }),
      container: 'measurementDiv',
      runtimeFactory: () => fake.runtime,
    });
    await controller.open();
    const revision = controller.getSnapshot().revision;

    controller.dispose();

    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(controller.destroyed).toBe(true);
    expect(controller.getDiagnostics().disposed).toBe(true);
    expect(controller.getModelDiagnostics().disposed).toBe(true);
    await expect(controller.selectTool(MEASUREMENT_TOOLS.AREA)).resolves.toBe(false);
    await expect(controller.open()).resolves.toBe(false);
    expect(controller.clear()).toBe(false);
    expect(controller.getSnapshot().revision).toBe(revision);
  });
});
