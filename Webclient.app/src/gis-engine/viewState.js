const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const cleanNumber = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const cleanExtent = (extent) => {
  if (!extent) return null;
  const keys = ['xmin', 'ymin', 'xmax', 'ymax'];
  if (!keys.every((key) => Number.isFinite(Number(extent[key])))) return null;
  return {
    xmin: Number(extent.xmin),
    ymin: Number(extent.ymin),
    xmax: Number(extent.xmax),
    ymax: Number(extent.ymax),
    wkid: cleanNumber(extent.wkid ?? extent.spatialReference?.wkid, null),
  };
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
  center: Array.isArray(input.center) ? [Number(input.center[0]), Number(input.center[1])] : null,
  zoom: cleanNumber(input.zoom),
  scale: cleanNumber(input.scale),
  heading: clamp(cleanNumber(input.heading, 0), -360, 360),
  tilt: clamp(cleanNumber(input.tilt, 0), 0, 180),
  extent: cleanExtent(input.extent),
  basemapId: input.basemapId ?? null,
  selectedLayerId: input.selectedLayerId ?? null,
  selectedObjectId: input.selectedObjectId ?? null,
  time: input.time ?? null,
});

export const switchViewMode = (state, mode) => createViewState({ ...state, mode });

export const updateSelection = (state, selection = {}) => createViewState({
  ...state,
  selectedLayerId: selection.layerId ?? state?.selectedLayerId ?? null,
  selectedObjectId: selection.objectId ?? state?.selectedObjectId ?? null,
});

export const updateExtent = (state, extent) => createViewState({ ...state, extent });

export const updateCamera = (state, camera = {}) => createViewState({
  ...state,
  center: camera.center ?? state?.center,
  zoom: camera.zoom ?? state?.zoom,
  scale: camera.scale ?? state?.scale,
  heading: camera.heading ?? state?.heading,
  tilt: camera.tilt ?? state?.tilt,
  extent: camera.extent ?? state?.extent,
});

export const serializeViewState = (state) => JSON.stringify(createViewState(state));

export const parseViewState = (value) => {
  if (!value) return createViewState();
  try {
    return createViewState(JSON.parse(value));
  } catch (error) {
    return createViewState();
  }
};

export const toShareableQuery = (state) => {
  const normalized = createViewState(state);
  const params = new URLSearchParams();
  params.set('v', normalized.mode);
  if (normalized.center) params.set('c', normalized.center.map((value) => Number(value).toFixed(6)).join(','));
  if (Number.isFinite(normalized.zoom)) params.set('z', String(Number(normalized.zoom.toFixed(2))));
  if (Number.isFinite(normalized.heading) && normalized.heading !== 0) params.set('h', String(Number(normalized.heading.toFixed(1))));
  if (Number.isFinite(normalized.tilt) && normalized.tilt !== 0) params.set('t', String(Number(normalized.tilt.toFixed(1))));
  if (normalized.basemapId) params.set('b', normalized.basemapId);
  if (normalized.selectedLayerId) params.set('l', normalized.selectedLayerId);
  if (normalized.selectedObjectId) params.set('o', normalized.selectedObjectId);
  if (normalized.time) params.set('time', normalized.time);
  return params.toString();
};

export const fromShareableQuery = (search) => {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const center = params.get('c')?.split(',').map(Number);
  return createViewState({
    mode: params.get('v') === '3d' ? '3d' : '2d',
    center: center?.length === 2 && center.every(Number.isFinite) ? center : null,
    zoom: cleanNumber(params.get('z')),
    heading: cleanNumber(params.get('h'), 0),
    tilt: cleanNumber(params.get('t'), 0),
    basemapId: params.get('b'),
    selectedLayerId: params.get('l'),
    selectedObjectId: params.get('o'),
    time: params.get('time'),
  });
};

export const createViewStateBridge = (initialState = {}) => {
  let state = createViewState(initialState);
  const listeners = new Set();
  return {
    getState: () => state,
    setState: (next) => {
      state = createViewState(typeof next === 'function' ? next(state) : next);
      listeners.forEach((listener) => listener(state));
      return state;
    },
    subscribe: (listener) => {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: () => listeners.clear(),
  };
};

export const syncLayerSelection = (state, layerId, objectId) => updateSelection(state, { layerId, objectId });
