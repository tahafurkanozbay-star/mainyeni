import {
  createViewState,
  switchViewMode,
  updateCamera,
} from './viewState';

const DEFAULT_CENTER = Object.freeze([34, 39]);
const DEFAULT_MIN_ZOOM = 1;
const DEFAULT_MAX_ZOOM = 22;
const ABSOLUTE_MAX_ZOOM = 24;
const DEFAULT_SIDEBAR_WIDTH = 400;
const DEFAULT_MOBILE_BOTTOM = 200;
const DEFAULT_MOBILE_BREAKPOINT = 576;

const finite = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const finitePair = (value) => (
  Array.isArray(value) &&
  value.length >= 2 &&
  Number.isFinite(Number(value[0])) &&
  Number.isFinite(Number(value[1]))
    ? [Number(value[0]), Number(value[1])]
    : null
);

const centerFromView = (view) => {
  const center = view?.center;
  if (!center) return null;
  const longitude = finite(center.longitude);
  const latitude = finite(center.latitude);
  if (longitude !== null && latitude !== null) return [longitude, latitude];
  const x = finite(center.x);
  const y = finite(center.y);
  return x !== null && y !== null ? [x, y] : null;
};

const extentFromView = (view) => {
  const extent = view?.extent;
  if (!extent) return null;
  const xmin = finite(extent.xmin);
  const ymin = finite(extent.ymin);
  const xmax = finite(extent.xmax);
  const ymax = finite(extent.ymax);
  if ([xmin, ymin, xmax, ymax].some((value) => value === null)) return null;
  return {
    xmin,
    ymin,
    xmax,
    ymax,
    wkid: finite(extent.spatialReference?.wkid),
  };
};

const basemapIdFromView = (view) => (
  view?.map?.basemap?.id
  ?? view?.map?.basemap?.portalItem?.id
  ?? view?.map?.basemap?.title
  ?? null
);

const defaultFrameScheduler = (callback) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(callback, 16);
  return () => clearTimeout(id);
};

const safeRemove = (handle) => {
  try {
    handle?.remove?.();
  } catch (_) {
    // Runtime cleanup must be idempotent even if an SDK handle was already removed.
  }
};

export const normalizeViewConstraints = (config = {}) => {
  const configuredMin = finite(config.MinZoom ?? config.minZoom, DEFAULT_MIN_ZOOM);
  const minZoom = clamp(Math.floor(configuredMin), 0, ABSOLUTE_MAX_ZOOM - 1);
  const configuredMax = finite(config.MaxZoom ?? config.maxZoom, DEFAULT_MAX_ZOOM);
  const maxZoom = clamp(Math.floor(configuredMax), minZoom + 1, ABSOLUTE_MAX_ZOOM);

  return {
    minZoom,
    maxZoom,
    rotationEnabled: config.RotationEnabled === true || config.rotationEnabled === true,
    snapToZoom: config.SnapToZoom === true || config.snapToZoom === true,
  };
};

export const normalizeInitialCenter = (config = {}) => {
  const explicit = finitePair(config.center);
  if (explicit) return explicit;
  const x = finite(config.Centerx ?? config.centerX);
  const y = finite(config.Centery ?? config.centerY);
  if (x !== null && y !== null) return [x, y];
  return [...DEFAULT_CENTER];
};

export const createResponsivePadding = (viewportWidth, options = {}) => {
  const width = finite(viewportWidth, 1024);
  const breakpoint = finite(options.mobileBreakpoint, DEFAULT_MOBILE_BREAKPOINT);
  const sidebarWidth = Math.max(0, finite(options.sidebarWidth, DEFAULT_SIDEBAR_WIDTH));
  const mobileBottom = Math.max(0, finite(options.mobileBottom, DEFAULT_MOBILE_BOTTOM));
  const mobile = width <= breakpoint;

  return {
    top: 0,
    bottom: mobile ? mobileBottom : 0,
    left: mobile ? 0 : sidebarWidth,
    right: 0,
  };
};

export const createMapViewOptions = ({
  map,
  container,
  configuration = {},
  viewportWidth,
  padding,
} = {}) => ({
  container,
  ui: { components: [] },
  map,
  zoom: clamp(Math.floor(finite(configuration.Zoom ?? configuration.zoom, 11)), 0, ABSOLUTE_MAX_ZOOM),
  center: normalizeInitialCenter(configuration),
  padding: padding || createResponsivePadding(viewportWidth, configuration),
  constraints: normalizeViewConstraints(configuration),
});

export const snapshotMapViewState = (view, previous = {}) => createViewState({
  ...previous,
  mode: '2d',
  center: centerFromView(view) ?? previous.center,
  zoom: finite(view?.zoom, previous.zoom),
  scale: finite(view?.scale, previous.scale),
  heading: finite(view?.rotation, previous.heading ?? 0),
  tilt: 0,
  extent: extentFromView(view) ?? previous.extent,
  basemapId: basemapIdFromView(view) ?? previous.basemapId,
});

export const viewStateApproximatelyEqual = (left, right, tolerance = {}) => {
  const a = createViewState(left);
  const b = createViewState(right);
  const coordinateTolerance = finite(tolerance.coordinate, 1e-6);
  const zoomTolerance = finite(tolerance.zoom, 0.001);
  const scaleTolerance = finite(tolerance.scale, 1);
  const angleTolerance = finite(tolerance.angle, 0.01);

  const centerEqual = (!a.center && !b.center) || (
    a.center && b.center &&
    Math.abs(a.center[0] - b.center[0]) <= coordinateTolerance &&
    Math.abs(a.center[1] - b.center[1]) <= coordinateTolerance
  );

  const numericEqual = (x, y, allowed) => (
    (x === null && y === null) ||
    (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= allowed)
  );

  return (
    a.mode === b.mode &&
    centerEqual &&
    numericEqual(a.zoom, b.zoom, zoomTolerance) &&
    numericEqual(a.scale, b.scale, scaleTolerance) &&
    numericEqual(a.heading, b.heading, angleTolerance) &&
    a.basemapId === b.basemapId &&
    a.selectedLayerId === b.selectedLayerId &&
    a.selectedObjectId === b.selectedObjectId &&
    a.time === b.time
  );
};

export const applyViewStateToMapView = async (view, inputState, options = {}) => {
  if (!view?.goTo) return false;
  const state = createViewState(inputState);
  if (state.mode !== '2d' && options.allowCrossMode !== true) return false;

  const target = {};
  if (state.center) target.center = [...state.center];
  if (Number.isFinite(state.zoom)) target.zoom = state.zoom;
  else if (Number.isFinite(state.scale)) target.scale = state.scale;
  if (Number.isFinite(state.heading)) target.rotation = state.heading;

  if (!Object.keys(target).length && state.extent) {
    target.extent = {
      xmin: state.extent.xmin,
      ymin: state.extent.ymin,
      xmax: state.extent.xmax,
      ymax: state.extent.ymax,
      ...(state.extent.wkid ? { spatialReference: { wkid: state.extent.wkid } } : {}),
    };
  }

  if (!Object.keys(target).length) return false;

  await view.goTo(target, {
    duration: Math.max(0, finite(options.duration, 0)),
    animate: options.animate === true,
  });
  return true;
};

export const bindMapViewState = (view, bridge, options = {}) => {
  if (!view || !bridge?.getState || !bridge?.setState) return () => {};

  const handles = [];
  let disposed = false;
  let cancelScheduled = null;
  let applyingBridgeState = false;
  let lastPublished = createViewState(bridge.getState());
  const scheduleFrame = options.scheduleFrame || defaultFrameScheduler;

  const publish = () => {
    cancelScheduled = null;
    if (disposed || applyingBridgeState) return;
    const next = snapshotMapViewState(view, bridge.getState());
    if (viewStateApproximatelyEqual(next, lastPublished, options.tolerance)) return;
    lastPublished = next;
    bridge.setState(next);
    options.onState?.(next);
  };

  const schedulePublish = () => {
    if (disposed || cancelScheduled) return;
    cancelScheduled = scheduleFrame(publish);
  };

  ['center', 'zoom', 'scale', 'rotation', 'extent'].forEach((property) => {
    if (typeof view.watch === 'function') {
      handles.push(view.watch(property, schedulePublish));
    }
  });

  if (view?.map?.basemap && typeof view.map.watch === 'function') {
    handles.push(view.map.watch('basemap', schedulePublish));
  }

  let unsubscribe = () => {};
  if (options.applyIncoming === true && typeof bridge.subscribe === 'function') {
    unsubscribe = bridge.subscribe(async (nextState) => {
      if (disposed || nextState.mode !== '2d') return;
      const current = snapshotMapViewState(view, nextState);
      if (viewStateApproximatelyEqual(current, nextState, options.tolerance)) {
        lastPublished = current;
        return;
      }
      applyingBridgeState = true;
      try {
        await applyViewStateToMapView(view, nextState, options.goToOptions || {});
        lastPublished = snapshotMapViewState(view, nextState);
      } catch (error) {
        options.onApplyError?.(error);
      } finally {
        applyingBridgeState = false;
      }
    });
  }

  if (options.publishInitial !== false) schedulePublish();

  return () => {
    if (disposed) return;
    disposed = true;
    if (cancelScheduled) cancelScheduled();
    cancelScheduled = null;
    unsubscribe();
    handles.forEach(safeRemove);
  };
};

export const createViewPerformanceMonitor = (view, options = {}) => {
  const slowThresholdMs = Math.max(1, finite(options.slowThresholdMs, 250));
  const clock = typeof options.now === 'function' ? options.now : now;
  const state = {
    updateCycles: 0,
    completedCycles: 0,
    slowCycles: 0,
    totalUpdatingMs: 0,
    longestUpdatingMs: 0,
    activeSince: null,
    lastScale: finite(view?.scale),
    lastZoom: finite(view?.zoom),
    disposed: false,
  };
  const handles = [];

  const onUpdating = (updating) => {
    if (state.disposed) return;
    const current = clock();
    if (updating && state.activeSince === null) {
      state.updateCycles += 1;
      state.activeSince = current;
      return;
    }
    if (!updating && state.activeSince !== null) {
      const duration = Math.max(0, current - state.activeSince);
      state.completedCycles += 1;
      state.totalUpdatingMs += duration;
      state.longestUpdatingMs = Math.max(state.longestUpdatingMs, duration);
      if (duration >= slowThresholdMs) state.slowCycles += 1;
      state.activeSince = null;
    }
  };

  if (typeof view?.watch === 'function') {
    handles.push(view.watch('updating', onUpdating));
    handles.push(view.watch('scale', (value) => { state.lastScale = finite(value); }));
    handles.push(view.watch('zoom', (value) => { state.lastZoom = finite(value); }));
  }

  return {
    snapshot: () => ({
      updateCycles: state.updateCycles,
      completedCycles: state.completedCycles,
      slowCycles: state.slowCycles,
      totalUpdatingMs: state.totalUpdatingMs,
      longestUpdatingMs: state.longestUpdatingMs,
      averageUpdatingMs: state.completedCycles
        ? state.totalUpdatingMs / state.completedCycles
        : 0,
      active: state.activeSince !== null,
      lastScale: state.lastScale,
      lastZoom: state.lastZoom,
    }),
    dispose: () => {
      if (state.disposed) return;
      state.disposed = true;
      handles.forEach(safeRemove);
      handles.length = 0;
    },
  };
};

export const createViewCoordinator = (bridge, options = {}) => {
  if (!bridge?.getState || !bridge?.setState) {
    throw new Error('A view-state bridge is required.');
  }

  const registrations = new Map();
  let destroyed = false;
  let activeMode = createViewState(bridge.getState()).mode;

  const register = (mode, registration = {}) => {
    if (destroyed) throw new Error('View coordinator has been destroyed.');
    const normalizedMode = mode === '3d' ? '3d' : '2d';
    const existing = registrations.get(normalizedMode);
    existing?.unbind?.();
    registrations.set(normalizedMode, {
      view: registration.view || null,
      applyState: registration.applyState,
      unbind: registration.unbind || (() => {}),
    });
    return () => {
      const current = registrations.get(normalizedMode);
      if (current !== registrations.get(normalizedMode)) return;
      current?.unbind?.();
      registrations.delete(normalizedMode);
    };
  };

  const switchTo = async (mode, switchOptions = {}) => {
    if (destroyed) return false;
    const normalizedMode = mode === '3d' ? '3d' : '2d';
    activeMode = normalizedMode;
    const next = switchViewMode(bridge.getState(), normalizedMode);
    bridge.setState(next);
    const registration = registrations.get(normalizedMode);
    if (!registration?.view || typeof registration.applyState !== 'function') return true;
    try {
      await registration.applyState(registration.view, next, switchOptions);
      return true;
    } catch (error) {
      options.onError?.(error, normalizedMode);
      return false;
    }
  };

  const publishCamera = (mode, camera) => {
    if (destroyed) return bridge.getState();
    const normalizedMode = mode === '3d' ? '3d' : '2d';
    const next = updateCamera(bridge.getState(), camera);
    const withMode = switchViewMode(next, normalizedMode);
    activeMode = normalizedMode;
    return bridge.setState(withMode);
  };

  return {
    register,
    switchTo,
    publishCamera,
    getActiveMode: () => activeMode,
    getView: (mode) => registrations.get(mode === '3d' ? '3d' : '2d')?.view || null,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      registrations.forEach((registration) => registration.unbind?.());
      registrations.clear();
    },
  };
};
