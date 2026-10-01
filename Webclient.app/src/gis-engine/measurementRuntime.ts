import { evictArcgisModule, loadArcgisModule } from './arcgisModuleRuntime';

const MEASUREMENT_MODULE_ID = 'esri/widgets/Measurement';
const DEFAULT_MAX_LISTENERS = 64;
const MAX_LISTENERS_LIMIT = 256;

export const clearMeasurementRuntimeCache = (): void => {
  evictArcgisModule(MEASUREMENT_MODULE_ID);
};

export const MEASUREMENT_TOOLS = Object.freeze({
  NONE: '',
  DISTANCE: 'distance',
  AREA: 'area',
} as const);
export type MeasurementTool = typeof MEASUREMENT_TOOLS[keyof typeof MEASUREMENT_TOOLS];
export type MeasurementStatus = 'idle' | 'loading' | 'ready' | 'error' | 'destroyed';

const TOOL_ALIASES = new Map<string, MeasurementTool>([
  ['', MEASUREMENT_TOOLS.NONE], ['none', MEASUREMENT_TOOLS.NONE], ['clear', MEASUREMENT_TOOLS.NONE],
  ['distance', MEASUREMENT_TOOLS.DISTANCE], ['length', MEASUREMENT_TOOLS.DISTANCE], ['line', MEASUREMENT_TOOLS.DISTANCE],
  ['area', MEASUREMENT_TOOLS.AREA], ['polygon', MEASUREMENT_TOOLS.AREA],
]);

export const normalizeMeasurementTool = (value: unknown): MeasurementTool | null => TOOL_ALIASES.get(String(value ?? '').trim().toLowerCase()) ?? null;
export const isMeasurementToolSupported = (value: unknown): boolean => normalizeMeasurementTool(value) !== null;

export interface MeasurementError { code: string; message: string; }
export interface MeasurementState {
  status: MeasurementStatus;
  activeTool: MeasurementTool;
  error: MeasurementError | null;
  createdAt: string | null;
  clearedAt: string | null;
  destroyedAt: string | null;
}
export interface MeasurementStateInput extends Omit<Partial<MeasurementState>, 'activeTool'> { activeTool?: MeasurementTool | string; }

export const createMeasurementState = (input: MeasurementStateInput = {}): MeasurementState => ({
  status: input.status || 'idle',
  activeTool: normalizeMeasurementTool(input.activeTool) ?? MEASUREMENT_TOOLS.NONE,
  error: input.error || null,
  createdAt: input.createdAt || null,
  clearedAt: input.clearedAt || null,
  destroyedAt: input.destroyedAt || null,
});

export interface MeasurementWidgetLike {
  activeTool: MeasurementTool;
  view?: unknown;
  container?: unknown;
  clear?: () => unknown;
  destroy?: () => unknown;
}
type MeasurementWidgetCtor = new (options: { view: unknown; container: unknown; activeTool: MeasurementTool }) => MeasurementWidgetLike;
export type MeasurementListener = (state: MeasurementState) => void;
export type MeasurementDiagnosticPhase = 'load' | 'tool' | 'clear' | 'destroy' | 'listener';
export interface MeasurementDiagnostic {
  readonly phase: MeasurementDiagnosticPhase;
  readonly code: string;
  readonly message: string;
  readonly error: unknown;
}

export interface MeasurementRuntimeDiagnostics {
  readonly listenerCount: number;
  readonly rejectedListenerCount: number;
  readonly listenerFailureCount: number;
  readonly diagnosticReporterFailureCount: number;
  readonly lastFailurePhase: MeasurementDiagnosticPhase | null;
  readonly lastFailureKind: string | null;
  readonly destroyed: boolean;
}

export interface MeasurementControllerOptions {
  view?: unknown;
  container?: unknown;
  onDiagnostic?: (diagnostic: MeasurementDiagnostic) => void;
  maxListeners?: number;
}

const clampListenerLimit = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_LISTENERS;
  return Math.max(1, Math.min(MAX_LISTENERS_LIMIT, Math.trunc(value ?? DEFAULT_MAX_LISTENERS)));
};

const failureKind = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const errorRecord = (error: unknown): Readonly<{ code: string; message: string }> => {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown };
    return {
      code: typeof withCode.code === 'string' ? withCode.code : 'MEASUREMENT_ERROR',
      message: error.message || 'Measurement operation failed.',
    };
  }
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return {
      code: typeof record.code === 'string' ? record.code : 'MEASUREMENT_ERROR',
      message: typeof record.message === 'string' && record.message.trim()
        ? record.message
        : 'Measurement operation failed.',
    };
  }
  return { code: 'MEASUREMENT_ERROR', message: 'Measurement operation failed.' };
};

const createDiagnostic = (
  phase: MeasurementDiagnosticPhase,
  error: unknown,
): MeasurementDiagnostic => {
  const normalized = errorRecord(error);
  return {
    phase,
    code: normalized.code,
    message: normalized.message,
    error,
  };
};

const cloneMeasurementState = (state: MeasurementState): MeasurementState => ({
  status: state.status,
  activeTool: state.activeTool,
  error: state.error ? { ...state.error } : null,
  createdAt: state.createdAt,
  clearedAt: state.clearedAt,
  destroyedAt: state.destroyedAt,
});

export interface MeasurementController {
  ensureWidget: () => Promise<MeasurementWidgetLike | null>;
  setTool: (tool: unknown) => Promise<MeasurementWidgetLike | null>;
  clear: () => boolean;
  setView: (view: unknown) => boolean;
  setContainer: (container: unknown) => boolean;
  subscribe: (listener: MeasurementListener) => () => boolean;
  destroy: () => void;
  getWidget: () => MeasurementWidgetLike | null;
  getState: () => MeasurementState;
  getDiagnostics?: () => MeasurementRuntimeDiagnostics;
  readonly destroyed: boolean;
}

export const createMeasurementController = (options: MeasurementControllerOptions = {}): MeasurementController => {
  let view: unknown = options.view || null;
  let container: unknown = options.container || null;
  let widget: MeasurementWidgetLike | null = null;
  let creationPromise: Promise<MeasurementWidgetLike | null> | null = null;
  let destroyed = false;
  let state = createMeasurementState();
  const listeners = new Set<MeasurementListener>();
  const maxListeners = clampListenerLimit(options.maxListeners);
  let diagnostics: MeasurementRuntimeDiagnostics = Object.freeze({
    listenerCount: 0,
    rejectedListenerCount: 0,
    listenerFailureCount: 0,
    diagnosticReporterFailureCount: 0,
    lastFailurePhase: null,
    lastFailureKind: null,
    destroyed: false,
  });

  const updateDiagnostics = (patch: Partial<MeasurementRuntimeDiagnostics>): void => {
    diagnostics = Object.freeze({ ...diagnostics, ...patch });
  };

  const recordListenerCount = (): void => {
    updateDiagnostics({ listenerCount: listeners.size });
  };

  const report = (phase: MeasurementDiagnosticPhase, error: unknown): void => {
    updateDiagnostics({
      lastFailurePhase: phase,
      lastFailureKind: failureKind(error),
    });
    if (!options.onDiagnostic) return;
    try {
      options.onDiagnostic(createDiagnostic(phase, error));
    } catch (reporterError) {
      updateDiagnostics({
        diagnosticReporterFailureCount: diagnostics.diagnosticReporterFailureCount + 1,
        lastFailurePhase: phase,
        lastFailureKind: `reporter:${failureKind(reporterError)}`,
      });
    }
  };

  const callListener = (listener: MeasurementListener, nextState: MeasurementState): void => {
    try {
      listener(cloneMeasurementState(nextState));
    } catch (error) {
      updateDiagnostics({
        listenerFailureCount: diagnostics.listenerFailureCount + 1,
        lastFailurePhase: 'listener',
        lastFailureKind: failureKind(error),
      });
      report('listener', error);
    }
  };

  const notify = (nextState: MeasurementState): void => {
    for (const listener of listeners) {
      callListener(listener, nextState);
    }
  };

  const setState = (patch: Partial<MeasurementState>): MeasurementState => {
    state = { ...state, ...patch };
    notify(state);
    return state;
  };

  const ensureActive = (): void => {
    if (destroyed) throw Object.assign(new Error('Measurement controller is destroyed.'), { code: 'DESTROYED' });
    if (!view) throw Object.assign(new Error('A map view is required for measurement.'), { code: 'MAP_VIEW_REQUIRED' });
    if (!container) throw Object.assign(new Error('A measurement container is required.'), { code: 'CONTAINER_REQUIRED' });
  };

  const ensureWidget = async (): Promise<MeasurementWidgetLike | null> => {
    ensureActive();
    if (widget) return widget;
    if (creationPromise) return creationPromise;
    setState({ status: 'loading', error: null });
    creationPromise = loadArcgisModule<MeasurementWidgetCtor>(MEASUREMENT_MODULE_ID)
      .then((Measurement) => {
        if (destroyed) return null;
        widget = new Measurement({ view, container, activeTool: state.activeTool });
        setState({ status: 'ready', createdAt: new Date().toISOString(), error: null });
        return widget;
      })
      .catch((error: unknown) => {
        creationPromise = null;
        const normalized = errorRecord(error);
        report('load', error);
        setState({
          status: 'error',
          error: {
            code: normalized.code === 'MEASUREMENT_ERROR'
              ? 'MEASUREMENT_LOAD_ERROR'
              : normalized.code,
            message: normalized.message || 'Measurement widget could not be loaded.',
          },
        });
        throw error;
      });
    try { return await creationPromise; } finally { creationPromise = null; }
  };

  const setTool = async (tool: unknown): Promise<MeasurementWidgetLike | null> => {
    const normalized = normalizeMeasurementTool(tool);
    if (normalized === null) {
      const error = Object.assign(
        new Error(`Unsupported measurement tool: ${String(tool)}`),
        { code: 'UNSUPPORTED_MEASUREMENT_TOOL' },
      );
      report('tool', error);
      throw error;
    }
    const currentWidget = await ensureWidget();
    if (!currentWidget || destroyed) return null;
    currentWidget.activeTool = normalized;
    setState({ activeTool: normalized, status: 'ready', error: null });
    return currentWidget;
  };

  const clear = (): boolean => {
    if (destroyed) return false;
    try {
      widget?.clear?.();
      if (widget) widget.activeTool = MEASUREMENT_TOOLS.NONE;
    } catch (error) {
      report('clear', error);
    }
    setState({ activeTool: MEASUREMENT_TOOLS.NONE, clearedAt: new Date().toISOString() });
    return true;
  };

  const setView = (nextView: unknown): boolean => {
    if (destroyed) return false;
    view = nextView || null;
    if (widget) widget.view = view;
    return true;
  };

  const setContainer = (nextContainer: unknown): boolean => {
    if (destroyed) return false;
    container = nextContainer || null;
    if (widget) widget.container = container;
    return true;
  };

  const subscribe = (listener: MeasurementListener): (() => boolean) => {
    if (typeof listener !== 'function' || destroyed) {
      updateDiagnostics({ rejectedListenerCount: diagnostics.rejectedListenerCount + 1 });
      return () => false;
    }
    if (!listeners.has(listener) && listeners.size >= maxListeners) {
      updateDiagnostics({ rejectedListenerCount: diagnostics.rejectedListenerCount + 1 });
      return () => false;
    }
    const alreadySubscribed = listeners.has(listener);
    listeners.add(listener);
    recordListenerCount();
    if (!alreadySubscribed) callListener(listener, state);
    return () => {
      const removed = listeners.delete(listener);
      if (removed) recordListenerCount();
      return removed;
    };
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    try {
      widget?.clear?.();
      widget?.destroy?.();
    } catch (error) {
      report('destroy', error);
    }
    widget = null;
    creationPromise = null;
    listeners.clear();
    state = {
      ...state,
      status: 'destroyed',
      activeTool: MEASUREMENT_TOOLS.NONE,
      destroyedAt: new Date().toISOString(),
    };
    updateDiagnostics({
      listenerCount: 0,
      destroyed: true,
    });
  };

  return {
    ensureWidget,
    setTool,
    clear,
    setView,
    setContainer,
    subscribe,
    destroy,
    getWidget: () => widget,
    getState: () => cloneMeasurementState(state),
    getDiagnostics: () => diagnostics,
    get destroyed() {
      return destroyed;
    },
  };
};

export interface MeasurementCapability {
  requested: unknown;
  tool: MeasurementTool | null;
  supported: boolean;
  sdkWidget: 'esri/widgets/Measurement';
  requiresMapView: true;
}
export const createMeasurementCapability = (kind: unknown): Readonly<MeasurementCapability> => {
  const normalized = normalizeMeasurementTool(kind);
  return Object.freeze({ requested: kind, tool: normalized, supported: normalized !== null && normalized !== MEASUREMENT_TOOLS.NONE, sdkWidget: 'esri/widgets/Measurement', requiresMapView: true });
};
