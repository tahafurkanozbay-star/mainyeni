import { loadModules } from 'esri-loader';

const modulePromises = new Map();

const load = (name) => {
  if (!modulePromises.has(name)) {
    const promise = loadModules([name])
      .then((modules) => modules[0])
      .catch((error) => {
        modulePromises.delete(name);
        throw error;
      });
    modulePromises.set(name, promise);
  }
  return modulePromises.get(name);
};

export const MEASUREMENT_TOOLS = Object.freeze({
  NONE: '',
  DISTANCE: 'distance',
  AREA: 'area',
});

const TOOL_ALIASES = new Map([
  ['', MEASUREMENT_TOOLS.NONE],
  ['none', MEASUREMENT_TOOLS.NONE],
  ['clear', MEASUREMENT_TOOLS.NONE],
  ['distance', MEASUREMENT_TOOLS.DISTANCE],
  ['length', MEASUREMENT_TOOLS.DISTANCE],
  ['line', MEASUREMENT_TOOLS.DISTANCE],
  ['area', MEASUREMENT_TOOLS.AREA],
  ['polygon', MEASUREMENT_TOOLS.AREA],
]);

export const normalizeMeasurementTool = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return TOOL_ALIASES.get(normalized) ?? null;
};

export const isMeasurementToolSupported = (value) => normalizeMeasurementTool(value) !== null;

export const createMeasurementState = (input = {}) => ({
  status: input.status || 'idle',
  activeTool: normalizeMeasurementTool(input.activeTool) ?? MEASUREMENT_TOOLS.NONE,
  error: input.error || null,
  createdAt: input.createdAt || null,
  clearedAt: input.clearedAt || null,
  destroyedAt: input.destroyedAt || null,
});

const notify = (listeners, state) => {
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (_) {}
  });
};

export const createMeasurementController = (options = {}) => {
  let view = options.view || null;
  let container = options.container || null;
  let widget = null;
  let creationPromise = null;
  let destroyed = false;
  let state = createMeasurementState();
  const listeners = new Set();

  const setState = (patch) => {
    state = { ...state, ...patch };
    notify(listeners, state);
    return state;
  };

  const ensureActive = () => {
    if (destroyed) throw Object.assign(new Error('Measurement controller is destroyed.'), { code: 'DESTROYED' });
    if (!view) throw Object.assign(new Error('A map view is required for measurement.'), { code: 'MAP_VIEW_REQUIRED' });
    if (!container) throw Object.assign(new Error('A measurement container is required.'), { code: 'CONTAINER_REQUIRED' });
  };

  const ensureWidget = async () => {
    ensureActive();
    if (widget) return widget;
    if (creationPromise) return creationPromise;

    setState({ status: 'loading', error: null });
    creationPromise = load('esri/widgets/Measurement')
      .then((Measurement) => {
        if (destroyed) return null;
        widget = new Measurement({
          view,
          container,
          activeTool: state.activeTool,
        });
        setState({
          status: 'ready',
          createdAt: new Date().toISOString(),
          error: null,
        });
        return widget;
      })
      .catch((error) => {
        creationPromise = null;
        setState({
          status: 'error',
          error: {
            code: error?.code || 'MEASUREMENT_LOAD_ERROR',
            message: error?.message || 'Measurement widget could not be loaded.',
          },
        });
        throw error;
      });

    try {
      return await creationPromise;
    } finally {
      creationPromise = null;
    }
  };

  const setTool = async (tool) => {
    const normalized = normalizeMeasurementTool(tool);
    if (normalized === null) {
      throw Object.assign(new Error(`Unsupported measurement tool: ${tool}`), { code: 'UNSUPPORTED_MEASUREMENT_TOOL' });
    }
    const currentWidget = await ensureWidget();
    if (!currentWidget || destroyed) return null;
    currentWidget.activeTool = normalized;
    setState({ activeTool: normalized, status: 'ready', error: null });
    return currentWidget;
  };

  const clear = () => {
    if (destroyed) return false;
    try {
      widget?.clear?.();
      if (widget) widget.activeTool = MEASUREMENT_TOOLS.NONE;
    } catch (_) {}
    setState({
      activeTool: MEASUREMENT_TOOLS.NONE,
      clearedAt: new Date().toISOString(),
    });
    return true;
  };

  const setView = (nextView) => {
    if (destroyed) return false;
    view = nextView || null;
    if (widget) widget.view = view;
    return true;
  };

  const setContainer = (nextContainer) => {
    if (destroyed) return false;
    container = nextContainer || null;
    if (widget) widget.container = container;
    return true;
  };

  const subscribe = (listener) => {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    listener(state);
    return () => listeners.delete(listener);
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      widget?.clear?.();
      widget?.destroy?.();
    } catch (_) {}
    widget = null;
    creationPromise = null;
    listeners.clear();
    state = {
      ...state,
      status: 'destroyed',
      activeTool: MEASUREMENT_TOOLS.NONE,
      destroyedAt: new Date().toISOString(),
    };
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
    getState: () => ({ ...state }),
    get destroyed() { return destroyed; },
  };
};

export const createMeasurementCapability = (kind) => {
  const normalized = normalizeMeasurementTool(kind);
  return Object.freeze({
    requested: kind,
    tool: normalized,
    supported: normalized !== null && normalized !== MEASUREMENT_TOOLS.NONE,
    sdkWidget: 'esri/widgets/Measurement',
    requiresMapView: true,
  });
};
