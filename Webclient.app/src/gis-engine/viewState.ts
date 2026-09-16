import type {
  ObjectId,
  ViewCameraInput,
  ViewCenter,
  ViewExtent,
  ViewMode,
  ViewSelectionInput,
  ViewState,
  ViewStateBridge,
  ViewStateInput,
  ViewStateListener,
  ViewStateUpdater,
} from './contracts';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const cleanNumber = (value: unknown, fallback: number | null = null): number | null => {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const cleanText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const cleanCenter = (center: unknown): ViewCenter | null => {
  if (!Array.isArray(center) || center.length < 2) return null;
  const x = cleanNumber(center[0]);
  const y = cleanNumber(center[1]);
  return x === null || y === null ? null : [x, y];
};

const cleanExtent = (extent: unknown): ViewExtent | null => {
  if (!extent || typeof extent !== 'object') return null;
  const candidate = extent as Record<string, unknown> & { spatialReference?: { wkid?: unknown } };
  const xmin = cleanNumber(candidate.xmin);
  const ymin = cleanNumber(candidate.ymin);
  const xmax = cleanNumber(candidate.xmax);
  const ymax = cleanNumber(candidate.ymax);
  if ([xmin, ymin, xmax, ymax].some((value) => value === null)) return null;
  if (xmin === null || ymin === null || xmax === null || ymax === null) return null;
  if (xmin > xmax || ymin > ymax) return null;
  return {
    xmin,
    ymin,
    xmax,
    ymax,
    wkid: cleanNumber(candidate.wkid ?? candidate.spatialReference?.wkid, null),
  };
};

const cleanTime = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return String(value);
};

const normalizeObjectId = (value: unknown): ObjectId | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return String(value);
};

export const DEFAULT_VIEW_STATE: Readonly<ViewState> = Object.freeze({
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

export const createViewState = (input: ViewStateInput | ViewState = {}): ViewState => ({
  ...DEFAULT_VIEW_STATE,
  mode: input.mode === '3d' ? '3d' : '2d',
  center: cleanCenter(input.center),
  zoom: cleanNumber(input.zoom),
  scale: cleanNumber(input.scale),
  heading: clamp(cleanNumber(input.heading, 0) ?? 0, -360, 360),
  tilt: clamp(cleanNumber(input.tilt, 0) ?? 0, 0, 180),
  extent: cleanExtent(input.extent),
  basemapId: cleanText(input.basemapId),
  selectedLayerId: cleanText(input.selectedLayerId),
  selectedObjectId: normalizeObjectId(input.selectedObjectId),
  time: cleanTime(input.time),
});

export const viewStateEquals = (left: ViewStateInput | ViewState, right: ViewStateInput | ViewState): boolean => {
  const a = createViewState(left);
  const b = createViewState(right);
  const sameCenter = (!a.center && !b.center) || Boolean(
    a.center && b.center && a.center[0] === b.center[0] && a.center[1] === b.center[1],
  );
  const sameExtent = (!a.extent && !b.extent) || Boolean(
    a.extent && b.extent &&
    a.extent.xmin === b.extent.xmin &&
    a.extent.ymin === b.extent.ymin &&
    a.extent.xmax === b.extent.xmax &&
    a.extent.ymax === b.extent.ymax &&
    a.extent.wkid === b.extent.wkid,
  );
  return (
    a.mode === b.mode && sameCenter && a.zoom === b.zoom && a.scale === b.scale &&
    a.heading === b.heading && a.tilt === b.tilt && sameExtent && a.basemapId === b.basemapId &&
    a.selectedLayerId === b.selectedLayerId && a.selectedObjectId === b.selectedObjectId && a.time === b.time
  );
};

export const switchViewMode = (state: ViewStateInput | ViewState, mode: ViewMode): ViewState => createViewState({ ...state, mode });

export const updateSelection = (
  state: ViewStateInput | ViewState,
  selection: ViewSelectionInput = {},
): ViewState => createViewState({
  ...state,
  selectedLayerId: Object.prototype.hasOwnProperty.call(selection, 'layerId') ? selection.layerId : state?.selectedLayerId,
  selectedObjectId: Object.prototype.hasOwnProperty.call(selection, 'objectId') ? selection.objectId : state?.selectedObjectId,
});

export const clearSelection = (state: ViewStateInput | ViewState): ViewState => updateSelection(state, {
  layerId: null,
  objectId: null,
});

export const updateExtent = (state: ViewStateInput | ViewState, extent: unknown): ViewState => createViewState({ ...state, extent });

export const updateCamera = (
  state: ViewStateInput | ViewState,
  camera: ViewCameraInput = {},
): ViewState => createViewState({
  ...state,
  center: Object.prototype.hasOwnProperty.call(camera, 'center') ? camera.center : state?.center,
  zoom: Object.prototype.hasOwnProperty.call(camera, 'zoom') ? camera.zoom : state?.zoom,
  scale: Object.prototype.hasOwnProperty.call(camera, 'scale') ? camera.scale : state?.scale,
  heading: Object.prototype.hasOwnProperty.call(camera, 'heading') ? camera.heading : state?.heading,
  tilt: Object.prototype.hasOwnProperty.call(camera, 'tilt') ? camera.tilt : state?.tilt,
  extent: Object.prototype.hasOwnProperty.call(camera, 'extent') ? camera.extent : state?.extent,
});

export const serializeViewState = (state: ViewStateInput | ViewState): string => JSON.stringify(createViewState(state));

export const parseViewState = (value: unknown): ViewState => {
  if (!value) return createViewState();
  try {
    return createViewState(JSON.parse(String(value)) as ViewStateInput);
  } catch (_) {
    return createViewState();
  }
};

export const toShareableQuery = (state: ViewStateInput | ViewState): string => {
  const normalized = createViewState(state);
  const params = new URLSearchParams();
  params.set('v', normalized.mode);
  if (normalized.center) params.set('c', normalized.center.map((value) => Number(value).toFixed(6)).join(','));
  if (Number.isFinite(normalized.zoom)) params.set('z', String(Number((normalized.zoom as number).toFixed(2))));
  else if (Number.isFinite(normalized.scale)) params.set('s', String(Math.round(normalized.scale as number)));
  if (Number.isFinite(normalized.heading) && normalized.heading !== 0) params.set('h', String(Number(normalized.heading.toFixed(1))));
  if (Number.isFinite(normalized.tilt) && normalized.tilt !== 0) params.set('t', String(Number(normalized.tilt.toFixed(1))));
  if (normalized.basemapId !== null) params.set('b', normalized.basemapId);
  if (normalized.selectedLayerId !== null) params.set('l', normalized.selectedLayerId);
  if (normalized.selectedObjectId !== null) params.set('o', String(normalized.selectedObjectId));
  if (normalized.time !== null) params.set('time', normalized.time);
  return params.toString();
};

export const fromShareableQuery = (search: unknown): ViewState => {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const center = params.get('c')?.split(',').map(Number);
  return createViewState({
    mode: params.get('v') === '3d' ? '3d' : '2d',
    center: center?.length === 2 && center.every(Number.isFinite) ? center : null,
    zoom: cleanNumber(params.get('z')),
    scale: cleanNumber(params.get('s')),
    heading: cleanNumber(params.get('h'), 0),
    tilt: cleanNumber(params.get('t'), 0),
    basemapId: params.get('b'),
    selectedLayerId: params.get('l'),
    selectedObjectId: params.get('o'),
    time: params.get('time'),
  });
};

export interface ViewStateBridgeOptions {
  emitCurrent?: boolean;
  onListenerError?: (error: unknown) => void;
}

export const createViewStateBridge = (
  initialState: ViewStateInput | ViewState = {},
  options: ViewStateBridgeOptions = {},
): ViewStateBridge => {
  let state = createViewState(initialState);
  let destroyed = false;
  const listeners = new Set<ViewStateListener>();
  const notify = (): void => {
    listeners.forEach((listener) => {
      try { listener(state); } catch (error) { options.onListenerError?.(error); }
    });
  };
  return {
    getState: () => state,
    setState: (next: ViewStateUpdater) => {
      const candidate = createViewState(typeof next === 'function' ? next(state) : next);
      if (viewStateEquals(candidate, state)) return state;
      state = candidate;
      if (!destroyed) notify();
      return state;
    },
    subscribe: (listener: ViewStateListener) => {
      if (destroyed || typeof listener !== 'function') return () => {};
      listeners.add(listener);
      if (options.emitCurrent === true) {
        try { listener(state); } catch (error) { options.onListenerError?.(error); }
      }
      return () => listeners.delete(listener);
    },
    destroy: () => { destroyed = true; listeners.clear(); },
    isDestroyed: () => destroyed,
    listenerCount: () => listeners.size,
  };
};

export const syncLayerSelection = (
  state: ViewStateInput | ViewState,
  layerId: unknown,
  objectId: unknown,
): ViewState => updateSelection(state, { layerId, objectId });
