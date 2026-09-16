const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const cleanNumber = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const cleanText = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const cleanCenter = (center) => {
  if (!Array.isArray(center) || center.length < 2) return null;
  const x = cleanNumber(center[0]);
  const y = cleanNumber(center[1]);
  return x === null || y === null ? null : [x, y];
};

const cleanExtent = (extent) => {
  if (!extent) return null;
  const xmin = cleanNumber(extent.xmin);
  const ymin = cleanNumber(extent.ymin);
  const xmax = cleanNumber(extent.xmax);
  const ymax = cleanNumber(extent.ymax);
  if ([xmin, ymin, xmax, ymax].some((value) => value === null)) return null;
  if (xmin > xmax || ymin > ymax) return null;
  return {
    xmin,
    ymin,
    xmax,
    ymax,
    wkid: cleanNumber(extent.wkid ?? extent.spatialReference?.wkid, null),
  };
};

const cleanTime = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  return String(value);
};

const normalizeObjectId = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return String(value);
};

export const DEFAULT_VIEW_STATE = Object.freeze({
  mode: '2d',
  center: null,
  zoom: null,
  scale: null,
  heading: 0,
  tilt: 0,
  extent: null,
  basemapId: null,
  selectedLayerId: null,
  selectedObjectId: null,
  time: null,
});

export const createViewState = (input = {}) => ({
  ...DEFAULT_VIEW_STATE,
  mode: input.mode === '3d' ? '3d' : '2d',
  center: cleanCenter(input.center),
  zoom: cleanNumber(input.zoom),
  scale: cleanNumber(input.scale),
  heading: clamp(cleanNumber(input.heading, 0), -360, 360),
  tilt: clamp(cleanNumber(input.tilt, 0), 0, 180),
  extent: cleanExtent(input.extent),
  basemapId: cleanText(input.basemapId),
  selectedLayerId: cleanText(input.selectedLayerId),
  selectedObjectId: normalizeObjectId(input.selectedObjectId),
  time: cleanTime(input.time),
});

export const viewStateEquals = (left, right) => {
  const a = createViewState(left);
  const b = createViewState(right);
  const sameCenter = (!a.center && !b.center) || (
    a.center && b.center && a.center[0] === b.center[0] && a.center[1] === b.center[1]
  );
  const sameExtent = (!a.extent && !b.extent) || (
    a.extent && b.extent &&
    a.extent.xmin === b.extent.xmin &&
    a.extent.ymin === b.extent.ymin &&
    a.extent.xmax === b.extent.xmax &&
    a.extent.ymax === b.extent.ymax &&
    a.extent.wkid === b.extent.wkid
  );
  return (
    a.mode === b.mode &&
    sameCenter &&
    a.zoom === b.zoom &&
    a.scale === b.scale &&
    a.heading === b.heading &&
    a.tilt === b.tilt &&
    sameExtent &&
    a.basemapId === b.basemapId &&
    a.selectedLayerId === b.selectedLayerId &&
    a.selectedObjectId === b.selectedObjectId &&
    a.time === b.time
  );
};

export const switchViewMode = (state, mode) => createViewState({ ...state, mode });

export const updateSelection = (state, selection = {}) => createViewState({
  ...state,
  selectedLayerId: Object.prototype.hasOwnProperty.call(selection, 'layerId')
    ? selection.layerId
    : state?.selectedLayerId,
  selectedObjectId: Object.prototype.hasOwnProperty.call(selection, 'objectId')
    ? selection.objectId
    : state?.selectedObjectId,
});

export const clearSelection = (state) => updateSelection(state, {
  layerId: null,
  objectId: null,
});

export const updateExtent = (state, extent) => createViewState({ ...state, extent });

export const updateCamera = (state, camera = {}) => createViewState({
  ...state,
  center: Object.prototype.hasOwnProperty.call(camera, 'center') ? camera.center : state?.center,
  zoom: Object.prototype.hasOwnProperty.call(camera, 'zoom') ? camera.zoom : state?.zoom,
  scale: Object.prototype.hasOwnProperty.call(camera, 'scale') ? camera.scale : state?.scale,
  heading: Object.prototype.hasOwnProperty.call(camera, 'heading') ? camera.heading : state?.heading,
  tilt: Object.prototype.hasOwnProperty.call(camera, 'tilt') ? camera.tilt : state?.tilt,
  extent: Object.prototype.hasOwnProperty.call(camera, 'extent') ? camera.extent : state?.extent,
});

export const serializeViewState = (state) => JSON.stringify(createViewState(state));

export const parseViewState = (value) => {
  if (!value) return createViewState();
  try {
    return createViewState(JSON.parse(value));
  } catch (_) {
    return createViewState();
  }
};

export const toShareableQuery = (state) => {
  const normalized = createViewState(state);
  const params = new URLSearchParams();
  params.set('v', normalized.mode);
  if (normalized.center) {
    params.set('c', normalized.center.map((value) => Number(value).toFixed(6)).join(','));
  }
  if (Number.isFinite(normalized.zoom)) {
    params.set('z', String(Number(normalized.zoom.toFixed(2))));
  } else if (Number.isFinite(normalized.scale)) {
    params.set('s', String(Math.round(normalized.scale)));
  }
  if (Number.isFinite(normalized.heading) && normalized.heading !== 0) {
    params.set('h', String(Number(normalized.heading.toFixed(1))));
  }
  if (Number.isFinite(normalized.tilt) && normalized.tilt !== 0) {
    params.set('t', String(Number(normalized.tilt.toFixed(1))));
  }
  if (normalized.basemapId !== null) params.set('b', normalized.basemapId);
  if (normalized.selectedLayerId !== null) params.set('l', normalized.selectedLayerId);
  if (normalized.selectedObjectId !== null) params.set('o', String(normalized.selectedObjectId));
  if (normalized.time !== null) params.set('time', normalized.time);
  return params.toString();
};

export const fromShareableQuery = (search) => {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const center = params.get('c')?.split(',').map(Number);
  const rawObjectId = params.get('o');
  return createViewState({
    mode: params.get('v') === '3d' ? '3d' : '2d',
    center: center?.length === 2 && center.every(Number.isFinite) ? center : null,
    zoom: cleanNumber(params.get('z')),
    scale: cleanNumber(params.get('s')),
    heading: cleanNumber(params.get('h'), 0),
    tilt: cleanNumber(params.get('t'), 0),
    basemapId: params.get('b'),
    selectedLayerId: params.get('l'),
    selectedObjectId: rawObjectId,
    time: params.get('time'),
  });
};

export const createViewStateBridge = (initialState = {}, options = {}) => {
  let state = createViewState(initialState);
  let destroyed = false;
  const listeners = new Set();

  const notify = () => {
    listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (error) {
        options.onListenerError?.(error);
      }
    });
  };

  return {
    getState: () => state,
    setState: (next) => {
      const candidate = createViewState(typeof next === 'function' ? next(state) : next);
      if (viewStateEquals(candidate, state)) return state;
      state = candidate;
      if (!destroyed) notify();
      return state;
    },
    subscribe: (listener) => {
      if (destroyed || typeof listener !== 'function') return () => {};
      listeners.add(listener);
      if (options.emitCurrent === true) {
        try {
          listener(state);
        } catch (error) {
          options.onListenerError?.(error);
        }
      }
      return () => listeners.delete(listener);
    },
    destroy: () => {
      destroyed = true;
      listeners.clear();
    },
    isDestroyed: () => destroyed,
    listenerCount: () => listeners.size,
  };
};

export const syncLayerSelection = (state, layerId, objectId) => updateSelection(state, {
  layerId,
  objectId,
});
