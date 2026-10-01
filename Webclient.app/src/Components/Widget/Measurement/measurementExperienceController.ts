import {
  createMeasurementController,
  MEASUREMENT_TOOLS,
  type MeasurementController,
  type MeasurementControllerOptions,
  type MeasurementDiagnostic,
  type MeasurementState,
  type MeasurementTool,
} from '../../../gis-engine/measurementRuntime';
import {
  createMeasurementExperienceModel,
  type MeasurementExperienceDiagnostics,
  type MeasurementExperienceModelOptions,
  type MeasurementExperienceSnapshot,
  type MeasurementInputModality,
} from './measurementExperienceModel';

export interface MeasurementRuntimeFactoryOptions extends MeasurementControllerOptions {
  readonly view: unknown;
  readonly container: unknown;
}

export type MeasurementRuntimeFactory = (options: MeasurementRuntimeFactoryOptions) => MeasurementController;

export interface MeasurementExperienceControllerOptions {
  readonly getView: () => unknown;
  readonly container: string | HTMLElement;
  readonly runtimeFactory?: MeasurementRuntimeFactory;
  readonly modelOptions?: MeasurementExperienceModelOptions;
  readonly onDiagnostic?: (diagnostic: MeasurementExperienceControllerDiagnostic) => void;
}

export type MeasurementExperienceControllerDiagnosticPhase =
  | 'view'
  | 'runtime'
  | 'initialize'
  | 'tool'
  | 'clear'
  | 'retry'
  | 'observer'
  | 'dispose';

export interface MeasurementExperienceControllerDiagnostic {
  readonly phase: MeasurementExperienceControllerDiagnosticPhase;
  readonly code: string;
  readonly message: string;
  readonly failureKind: string;
}

export interface MeasurementExperienceControllerDiagnostics {
  readonly operationRevision: number;
  readonly staleCompletionCount: number;
  readonly runtimeCreationCount: number;
  readonly runtimeReplacementCount: number;
  readonly controllerFailureCount: number;
  readonly reporterFailureCount: number;
  readonly lastFailurePhase: MeasurementExperienceControllerDiagnosticPhase | null;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

export interface MeasurementExperienceController {
  readonly getSnapshot: () => MeasurementExperienceSnapshot;
  readonly getDiagnostics: () => MeasurementExperienceControllerDiagnostics;
  readonly getModelDiagnostics: () => MeasurementExperienceDiagnostics;
  readonly subscribe: (listener: () => void) => () => void;
  readonly open: () => Promise<boolean>;
  readonly close: () => void;
  readonly refreshView: () => boolean;
  readonly selectTool: (tool: MeasurementTool) => Promise<boolean>;
  readonly clear: () => boolean;
  readonly retry: () => Promise<boolean>;
  readonly recordInputModality: (modality: MeasurementInputModality) => void;
  readonly dispose: () => void;
  readonly destroyed: boolean;
}

const FALLBACK_MESSAGE = 'Ölçüm aracı hazırlanırken beklenmeyen bir sorun oluştu.';
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 180;

const isControlCode = (value: number): boolean => value < 32 || value === 127;

const sanitizeMessage = (value: unknown): string => {
  if (typeof value !== 'string') return FALLBACK_MESSAGE;
  let output = '';
  for (const character of value) {
    const point = character.codePointAt(0);
    output += point !== undefined && isControlCode(point) ? ' ' : character;
  }
  return output.replace(/\s+/gu, ' ').trim().slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH) || FALLBACK_MESSAGE;
};

const failureKind = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const diagnosticCode = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== 'string') return fallback;
  const trimmed = code.trim().toUpperCase();
  let safe = '';
  for (const character of trimmed) {
    const point = character.codePointAt(0) ?? 0;
    if ((point >= 65 && point <= 90) || (point >= 48 && point <= 57) || character === '_' || character === '-') {
      safe += character;
    }
    if (safe.length >= 48) break;
  }
  return safe || fallback;
};

const cloneState = (state: MeasurementState): MeasurementState => ({
  status: state.status,
  activeTool: state.activeTool,
  error: state.error ? { ...state.error } : null,
  createdAt: state.createdAt,
  clearedAt: state.clearedAt,
  destroyedAt: state.destroyedAt,
});

export const createMeasurementExperienceController = (
  options: MeasurementExperienceControllerOptions,
): MeasurementExperienceController => {
  const runtimeFactory = options.runtimeFactory ?? ((runtimeOptions) => createMeasurementController(runtimeOptions));
  const model = createMeasurementExperienceModel({
    ...options.modelOptions,
    onObserverError(error) {
      options.modelOptions?.onObserverError?.(error);
      report('observer', error, 'MEASUREMENT_OBSERVER_ERROR');
    },
  });

  let runtime: MeasurementController | null = null;
  let runtimeUnsubscribe: (() => boolean) | null = null;
  let boundView: unknown = null;
  let operationRevision = 0;
  let disposed = false;
  let diagnostics: MeasurementExperienceControllerDiagnostics = Object.freeze({
    operationRevision: 0,
    staleCompletionCount: 0,
    runtimeCreationCount: 0,
    runtimeReplacementCount: 0,
    controllerFailureCount: 0,
    reporterFailureCount: 0,
    lastFailurePhase: null,
    lastFailureKind: null,
    disposed: false,
  });

  function publishDiagnostics(patch: Partial<MeasurementExperienceControllerDiagnostics>): void {
    diagnostics = Object.freeze({ ...diagnostics, ...patch });
  }

  function report(
    phase: MeasurementExperienceControllerDiagnosticPhase,
    error: unknown,
    fallbackCode: string,
  ): void {
    const nextFailureCount = diagnostics.controllerFailureCount + 1;
    publishDiagnostics({
      controllerFailureCount: nextFailureCount,
      lastFailurePhase: phase,
      lastFailureKind: failureKind(error),
    });
    if (!options.onDiagnostic) return;
    const payload: MeasurementExperienceControllerDiagnostic = Object.freeze({
      phase,
      code: diagnosticCode(error, fallbackCode),
      message: sanitizeMessage(error instanceof Error ? error.message : error),
      failureKind: failureKind(error),
    });
    try {
      options.onDiagnostic(payload);
    } catch (reporterError) {
      publishDiagnostics({
        reporterFailureCount: diagnostics.reporterFailureCount + 1,
        lastFailurePhase: phase,
        lastFailureKind: `reporter:${failureKind(reporterError)}`,
      });
    }
  }

  const nextOperation = (): number => {
    operationRevision += 1;
    publishDiagnostics({ operationRevision });
    return operationRevision;
  };

  const isCurrentOperation = (revision: number): boolean => {
    const current = !disposed && revision === operationRevision;
    if (!current) {
      publishDiagnostics({ staleCompletionCount: diagnostics.staleCompletionCount + 1 });
    }
    return current;
  };

  const detachRuntime = (destroyRuntime: boolean): void => {
    runtimeUnsubscribe?.();
    runtimeUnsubscribe = null;
    if (destroyRuntime) runtime?.destroy();
    runtime = null;
    boundView = null;
  };

  const onRuntimeDiagnostic = (diagnostic: MeasurementDiagnostic): void => {
    if (disposed) return;
    if (diagnostic.phase === 'listener') {
      report('observer', diagnostic.error, diagnostic.code || 'MEASUREMENT_RUNTIME_LISTENER_ERROR');
      return;
    }
    report('runtime', diagnostic.error, diagnostic.code || 'MEASUREMENT_RUNTIME_ERROR');
    if (diagnostic.phase === 'load' || diagnostic.phase === 'tool') {
      model.recordError(diagnostic.message, diagnostic.code);
    }
  };

  const attachRuntime = (view: unknown): MeasurementController => {
    if (runtime && !runtime.destroyed && boundView === view) {
      runtime.setView(view);
      runtime.setContainer(options.container);
      return runtime;
    }

    if (runtime) {
      publishDiagnostics({ runtimeReplacementCount: diagnostics.runtimeReplacementCount + 1 });
      detachRuntime(true);
    }

    const nextRuntime = runtimeFactory({
      view,
      container: options.container,
      onDiagnostic: onRuntimeDiagnostic,
    });
    runtime = nextRuntime;
    boundView = view;
    publishDiagnostics({ runtimeCreationCount: diagnostics.runtimeCreationCount + 1 });
    runtimeUnsubscribe = nextRuntime.subscribe((state) => {
      if (disposed || nextRuntime !== runtime) return;
      model.syncRuntime(cloneState(state));
    });
    return nextRuntime;
  };

  const resolveView = (): unknown => {
    if (disposed) return null;
    try {
      return options.getView() ?? null;
    } catch (error) {
      report('view', error, 'MEASUREMENT_VIEW_LOOKUP_ERROR');
      return null;
    }
  };

  const refreshView = (): boolean => {
    if (disposed) return false;
    const view = resolveView();
    const ready = Boolean(view);
    model.setViewReady(ready);
    if (!ready) {
      if (runtime) detachRuntime(true);
      return false;
    }
    if (runtime && !runtime.destroyed) {
      runtime.setView(view);
      runtime.setContainer(options.container);
      boundView = view;
    }
    return true;
  };

  const initializeRuntime = async (phase: 'initialize' | 'retry'): Promise<boolean> => {
    if (disposed) return false;
    const view = resolveView();
    if (!view) {
      model.setViewReady(false);
      return false;
    }
    model.setViewReady(true);
    const revision = nextOperation();
    const controller = attachRuntime(view);
    const requestedTool = model.getSnapshot().requestedTool;
    model.beginOperation(requestedTool);

    try {
      await controller.ensureWidget();
      if (!isCurrentOperation(revision)) return false;
      model.syncRuntime(cloneState(controller.getState()));
      return true;
    } catch (error) {
      if (!isCurrentOperation(revision)) return false;
      report(phase, error, phase === 'retry' ? 'MEASUREMENT_RETRY_ERROR' : 'MEASUREMENT_INITIALIZE_ERROR');
      model.recordError(error, diagnosticCode(error, 'MEASUREMENT_LOAD_ERROR'));
      return false;
    }
  };

  const open = async (): Promise<boolean> => {
    if (disposed) return false;
    const view = resolveView();
    model.open(Boolean(view));
    if (!view) return false;
    return initializeRuntime('initialize');
  };

  const close = (): void => {
    if (disposed) return;
    nextOperation();
    runtime?.clear();
    model.recordClear();
    model.close();
  };

  const selectTool = async (tool: MeasurementTool): Promise<boolean> => {
    if (disposed) return false;
    const view = resolveView();
    if (!view) {
      model.setViewReady(false);
      return false;
    }
    model.setViewReady(true);

    const snapshot = model.getSnapshot();
    if (snapshot.activeTool === tool && tool !== MEASUREMENT_TOOLS.NONE) {
      return clear();
    }

    const revision = nextOperation();
    const controller = attachRuntime(view);
    model.requestTool(tool);
    model.beginOperation(tool);
    try {
      await controller.setTool(tool);
      if (!isCurrentOperation(revision)) return false;
      model.syncRuntime(cloneState(controller.getState()));
      return true;
    } catch (error) {
      if (!isCurrentOperation(revision)) return false;
      report('tool', error, 'MEASUREMENT_TOOL_ERROR');
      model.recordError(error, diagnosticCode(error, 'MEASUREMENT_TOOL_ERROR'));
      return false;
    }
  };

  const clear = (): boolean => {
    if (disposed) return false;
    nextOperation();
    const cleared = runtime?.clear() ?? true;
    if (!cleared) {
      const error = Object.assign(new Error('Ölçüm temizlenemedi.'), { code: 'MEASUREMENT_CLEAR_ERROR' });
      report('clear', error, 'MEASUREMENT_CLEAR_ERROR');
      model.recordError(error, 'MEASUREMENT_CLEAR_ERROR');
      return false;
    }
    model.recordClear();
    if (runtime) model.syncRuntime(cloneState(runtime.getState()));
    return true;
  };

  const retry = async (): Promise<boolean> => {
    if (disposed || !model.recordRetry()) return false;
    return initializeRuntime('retry');
  };

  const recordInputModality = (modality: MeasurementInputModality): void => {
    model.setInputModality(modality);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    nextOperation();
    try {
      detachRuntime(true);
    } catch (error) {
      report('dispose', error, 'MEASUREMENT_DISPOSE_ERROR');
    }
    model.dispose();
    publishDiagnostics({ disposed: true });
  };

  return {
    getSnapshot: model.getSnapshot,
    getDiagnostics: () => diagnostics,
    getModelDiagnostics: model.getDiagnostics,
    subscribe: model.subscribe,
    open,
    close,
    refreshView,
    selectTool,
    clear,
    retry,
    recordInputModality,
    dispose,
    get destroyed() {
      return disposed;
    },
  };
};
