import { loadModules } from 'esri-loader';

const modulePromises = new Map<string, Promise<any>>();

export const clearMeasurementRuntimeCache = (): void => { modulePromises.clear(); };

const load = <T = any>(name: string): Promise<T> => {
  if (!modulePromises.has(name)) {
    const promise = loadModules([name]).then((modules) => modules[0]).catch((error) => { modulePromises.delete(name); throw error; });
    modulePromises.set(name, promise);
  }
  return modulePromises.get(name) as Promise<T>;
};

export const MEASUREMENT_TOOLS = Object.freeze({ NONE: '', DISTANCE: 'distance', AREA: 'area' });
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
export interface MeasurementControllerOptions { view?: unknown; container?: unknown; }

const notify = (listeners: Set<MeasurementListener>, state: MeasurementState): void => {
  listeners.forEach((listener) => { try { listener(state); } catch (_) { /* observer isolation */ } });
};

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

  const setState = (patch: Partial<MeasurementState>): MeasurementState => {
    state = { ...state, ...patch };
    notify(listeners, state);
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
    creationPromise = load<MeasurementWidgetCtor>('esri/widgets/Measurement')
      .then((Measurement) => {
        if (destroyed) return null;
        widget = new Measurement({ view, container, activeTool: state.activeTool });
        setState({ status: 'ready', createdAt: new Date().toISOString(), error: null });
        return widget;
      })
      .catch((error: any) => {
        creationPromise = null;
        setState({ status: 'error', error: { code: error?.code || 'MEASUREMENT_LOAD_ERROR', message: error?.message || 'Measurement widget could not be loaded.' } });
        throw error;
      });
    try { return await creationPromise; } finally { creationPromise = null; }
  };

  const setTool = async (tool: unknown): Promise<MeasurementWidgetLike | null> => {
    const normalized = normalizeMeasurementTool(tool);
    if (normalized === null) throw Object.assign(new Error(`Unsupported measurement tool: ${String(tool)}`), { code: 'UNSUPPORTED_MEASUREMENT_TOOL' });
    const currentWidget = await ensureWidget();
    if (!currentWidget || destroyed) return null;
    currentWidget.activeTool = normalized;
    setState({ activeTool: normalized, status: 'ready', error: null });
    return currentWidget;
  };

  const clear = (): boolean => {
    if (destroyed) return false;
    try { widget?.clear?.(); if (widget) widget.activeTool = MEASUREMENT_TOOLS.NONE; } catch (_) { /* SDK cleanup */ }
    setState({ activeTool: MEASUREMENT_TOOLS.NONE, clearedAt: new Date().toISOString() });
    return true;
  };
  const setView = (nextView: unknown): boolean => { if (destroyed) return false; view = nextView || null; if (widget) widget.view = view; return true; };
  const setContainer = (nextContainer: unknown): boolean => { if (destroyed) return false; container = nextContainer || null; if (widget) widget.container = container; return true; };
  const subscribe = (listener: MeasurementListener): (() => boolean) => { if (typeof listener !== 'function') return () => false; listeners.add(listener); listener(state); return () => listeners.delete(listener); };
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    try { widget?.clear?.(); widget?.destroy?.(); } catch (_) { /* idempotent teardown */ }
    widget = null; creationPromise = null; listeners.clear();
    state = { ...state, status: 'destroyed', activeTool: MEASUREMENT_TOOLS.NONE, destroyedAt: new Date().toISOString() };
  };

  return { ensureWidget, setTool, clear, setView, setContainer, subscribe, destroy, getWidget: () => widget, getState: () => ({ ...state }), get destroyed() { return destroyed; } };
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
