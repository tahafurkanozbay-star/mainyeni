import { createViewState, switchViewMode, updateCamera } from './viewState';
import type { ViewCameraInput, ViewMode, ViewState, ViewStateBridge, ViewStateInput } from './contracts';

const DEFAULT_CENTER: [number, number] = [34, 39];
const DEFAULT_MIN_ZOOM = 1;
const DEFAULT_MAX_ZOOM = 22;
const ABSOLUTE_MAX_ZOOM = 24;
const DEFAULT_SIDEBAR_WIDTH = 400;
const DEFAULT_MOBILE_BOTTOM = 200;
const DEFAULT_MOBILE_BREAKPOINT = 576;
const now = (): number => Date.now();
const finite = (value: unknown, fallback: number | null = null): number | null => { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : fallback; };
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const finitePair = (value: unknown): [number, number] | null => Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1])) ? [Number(value[0]), Number(value[1])] : null;

export interface WatchHandle { remove?: () => void; }
export interface MapViewCenterLike { longitude?: number; latitude?: number; x?: number; y?: number; }
export interface MapViewExtentLike { xmin?: number; ymin?: number; xmax?: number; ymax?: number; spatialReference?: { wkid?: number }; }
export interface MapViewLike {
  center?: MapViewCenterLike;
  extent?: MapViewExtentLike;
  zoom?: number;
  scale?: number;
  rotation?: number;
  updating?: boolean;
  map?: { basemap?: { id?: string; title?: string; portalItem?: { id?: string } }; watch?: (property: string, callback: (value: any) => void) => WatchHandle };
  watch?: (property: string, callback: (value: any) => void) => WatchHandle;
  goTo?: (target: Record<string, unknown>, options?: { duration?: number; animate?: boolean }) => Promise<unknown>;
  [key: string]: any;
}
export interface ViewConfiguration { MinZoom?: unknown; minZoom?: unknown; MaxZoom?: unknown; maxZoom?: unknown; RotationEnabled?: boolean; rotationEnabled?: boolean; SnapToZoom?: boolean; snapToZoom?: boolean; center?: unknown; Centerx?: unknown; centerX?: unknown; Centery?: unknown; centerY?: unknown; Zoom?: unknown; zoom?: unknown; mobileBreakpoint?: unknown; sidebarWidth?: unknown; mobileBottom?: unknown; [key: string]: unknown; }

const centerFromView = (view: MapViewLike): [number, number] | null => {
  const center = view?.center; if (!center) return null;
  const longitude = finite(center.longitude); const latitude = finite(center.latitude);
  if (longitude !== null && latitude !== null) return [longitude, latitude];
  const x = finite(center.x); const y = finite(center.y); return x !== null && y !== null ? [x, y] : null;
};
const extentFromView = (view: MapViewLike) => {
  const extent = view?.extent; if (!extent) return null;
  const xmin = finite(extent.xmin); const ymin = finite(extent.ymin); const xmax = finite(extent.xmax); const ymax = finite(extent.ymax);
  if ([xmin, ymin, xmax, ymax].some((value) => value === null) || xmin === null || ymin === null || xmax === null || ymax === null) return null;
  return { xmin, ymin, xmax, ymax, wkid: finite(extent.spatialReference?.wkid) };
};
const basemapIdFromView = (view: MapViewLike): string | null => view?.map?.basemap?.id ?? view?.map?.basemap?.portalItem?.id ?? view?.map?.basemap?.title ?? null;
export type FrameScheduler = (callback: () => void) => () => void;
const defaultFrameScheduler: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame === 'function') { const id = requestAnimationFrame(callback); return () => cancelAnimationFrame(id); }
  const id = setTimeout(callback, 16); return () => clearTimeout(id);
};
const safeRemove = (handle?: WatchHandle): void => { try { handle?.remove?.(); } catch (_) { /* idempotent SDK cleanup */ } };

export interface ViewConstraints { minZoom: number; maxZoom: number; rotationEnabled: boolean; snapToZoom: boolean; }
export const normalizeViewConstraints = (config: ViewConfiguration = {}): ViewConstraints => {
  const configuredMin = finite(config.MinZoom ?? config.minZoom, DEFAULT_MIN_ZOOM) as number;
  const minZoom = clamp(Math.floor(configuredMin), 0, ABSOLUTE_MAX_ZOOM - 1);
  const configuredMax = finite(config.MaxZoom ?? config.maxZoom, DEFAULT_MAX_ZOOM) as number;
  const maxZoom = clamp(Math.floor(configuredMax), minZoom + 1, ABSOLUTE_MAX_ZOOM);
  return { minZoom, maxZoom, rotationEnabled: config.RotationEnabled === true || config.rotationEnabled === true, snapToZoom: config.SnapToZoom === true || config.snapToZoom === true };
};
export const normalizeInitialCenter = (config: ViewConfiguration = {}): [number, number] => {
  const explicit = finitePair(config.center); if (explicit) return explicit;
  const x = finite(config.Centerx ?? config.centerX); const y = finite(config.Centery ?? config.centerY);
  return x !== null && y !== null ? [x, y] : [...DEFAULT_CENTER];
};
export interface ResponsivePadding { top: number; bottom: number; left: number; right: number; }
export interface ResponsivePaddingOptions { mobileBreakpoint?: unknown; sidebarWidth?: unknown; mobileBottom?: unknown; }
export const createResponsivePadding = (viewportWidth: unknown, options: ResponsivePaddingOptions = {}): ResponsivePadding => {
  const width = finite(viewportWidth, 1024) as number;
  const breakpoint = finite(options.mobileBreakpoint, DEFAULT_MOBILE_BREAKPOINT) as number;
  const sidebarWidth = Math.max(0, finite(options.sidebarWidth, DEFAULT_SIDEBAR_WIDTH) as number);
  const mobileBottom = Math.max(0, finite(options.mobileBottom, DEFAULT_MOBILE_BOTTOM) as number);
  const mobile = width <= breakpoint;
  return { top: 0, bottom: mobile ? mobileBottom : 0, left: mobile ? 0 : sidebarWidth, right: 0 };
};
export interface MapViewOptionsInput { map?: unknown; container?: unknown; configuration?: ViewConfiguration; viewportWidth?: unknown; padding?: ResponsivePadding; }
export const createMapViewOptions = ({ map, container, configuration = {}, viewportWidth, padding }: MapViewOptionsInput = {}) => {
  const constraints = normalizeViewConstraints(configuration);
  const configuredZoom = Math.floor(finite(configuration.Zoom ?? configuration.zoom, 11) as number);
  return { container, ui: { components: [] as unknown[] }, map, zoom: clamp(configuredZoom, constraints.minZoom, constraints.maxZoom), center: normalizeInitialCenter(configuration), padding: padding || createResponsivePadding(viewportWidth, configuration), constraints };
};

export const snapshotMapViewState = (view: MapViewLike, previous: ViewStateInput | ViewState = {}): ViewState => createViewState({
  ...previous, mode: '2d', center: centerFromView(view) ?? previous.center, zoom: finite(view?.zoom, finite(previous.zoom)), scale: finite(view?.scale, finite(previous.scale)), heading: finite(view?.rotation, finite(previous.heading, 0)), tilt: 0, extent: extentFromView(view) ?? previous.extent, basemapId: basemapIdFromView(view) ?? previous.basemapId,
});
export interface ApproximateTolerance { coordinate?: unknown; zoom?: unknown; scale?: unknown; angle?: unknown; }
export const viewStateApproximatelyEqual = (left: ViewStateInput | ViewState, right: ViewStateInput | ViewState, tolerance: ApproximateTolerance = {}): boolean => {
  const a = createViewState(left); const b = createViewState(right);
  const coordinateTolerance = finite(tolerance.coordinate, 1e-6) as number; const zoomTolerance = finite(tolerance.zoom, 0.001) as number; const scaleTolerance = finite(tolerance.scale, 1) as number; const angleTolerance = finite(tolerance.angle, 0.01) as number;
  const centerEqual = (!a.center && !b.center) || Boolean(a.center && b.center && Math.abs(a.center[0] - b.center[0]) <= coordinateTolerance && Math.abs(a.center[1] - b.center[1]) <= coordinateTolerance);
  const numericEqual = (x: number | null, y: number | null, allowed: number): boolean => (x === null && y === null) || (Number.isFinite(x) && Number.isFinite(y) && Math.abs(Number(x) - Number(y)) <= allowed);
  return a.mode === b.mode && centerEqual && numericEqual(a.zoom, b.zoom, zoomTolerance) && numericEqual(a.scale, b.scale, scaleTolerance) && numericEqual(a.heading, b.heading, angleTolerance) && a.basemapId === b.basemapId && a.selectedLayerId === b.selectedLayerId && a.selectedObjectId === b.selectedObjectId && a.time === b.time;
};

export interface ApplyViewOptions { allowCrossMode?: boolean; duration?: unknown; animate?: boolean; }
export const applyViewStateToMapView = async (view: MapViewLike, inputState: ViewStateInput | ViewState = {}, options: ApplyViewOptions = {}): Promise<boolean> => {
  if (!view?.goTo) return false;
  const state = createViewState(inputState);
  if (state.mode !== '2d' && options.allowCrossMode !== true) return false;
  const target: Record<string, unknown> = {};
  const rawCenter = finitePair(inputState.center);
  const hasZoom = inputState.zoom !== null && inputState.zoom !== undefined && Number.isFinite(Number(inputState.zoom));
  const hasScale = inputState.scale !== null && inputState.scale !== undefined && Number.isFinite(Number(inputState.scale));
  const hasHeading = inputState.heading !== null && inputState.heading !== undefined && Number.isFinite(Number(inputState.heading));
  if (rawCenter && state.center) target.center = [...state.center];
  if (hasZoom && Number.isFinite(state.zoom)) target.zoom = state.zoom;
  else if (hasScale && Number.isFinite(state.scale)) target.scale = state.scale;
  if (hasHeading && Number.isFinite(state.heading)) target.rotation = state.heading;
  if (!Object.keys(target).length && state.extent) target.extent = { xmin: state.extent.xmin, ymin: state.extent.ymin, xmax: state.extent.xmax, ymax: state.extent.ymax, ...(state.extent.wkid ? { spatialReference: { wkid: state.extent.wkid } } : {}) };
  if (!Object.keys(target).length) return false;
  await view.goTo(target, { duration: Math.max(0, finite(options.duration, 0) as number), animate: options.animate === true });
  return true;
};

export interface BindMapViewOptions {
  scheduleFrame?: FrameScheduler;
  tolerance?: ApproximateTolerance;
  onState?: (state: ViewState) => void;
  applyIncoming?: boolean;
  goToOptions?: ApplyViewOptions;
  onApplyError?: (error: unknown) => void;
  publishInitial?: boolean;
}
export const bindMapViewState = (view: MapViewLike, bridge: ViewStateBridge, options: BindMapViewOptions = {}): (() => void) => {
  if (!view || !bridge?.getState || !bridge?.setState) return () => {};
  const handles: WatchHandle[] = [];
  let disposed = false; let cancelScheduled: (() => void) | null = null; let applyingBridgeState = false; let lastPublished = createViewState(bridge.getState());
  const scheduleFrame = options.scheduleFrame || defaultFrameScheduler;
  const publish = (): void => { cancelScheduled = null; if (disposed || applyingBridgeState) return; const next = snapshotMapViewState(view, bridge.getState()); if (viewStateApproximatelyEqual(next, lastPublished, options.tolerance)) return; lastPublished = next; bridge.setState(next); options.onState?.(next); };
  const schedulePublish = (): void => { if (disposed || cancelScheduled) return; cancelScheduled = scheduleFrame(publish); };
  ['center', 'zoom', 'scale', 'rotation', 'extent'].forEach((property) => { if (typeof view.watch === 'function') handles.push(view.watch(property, schedulePublish)); });
  if (view?.map?.basemap && typeof view.map.watch === 'function') handles.push(view.map.watch('basemap', schedulePublish));
  let unsubscribe: () => boolean | void = () => {};
  if (options.applyIncoming === true && typeof bridge.subscribe === 'function') {
    unsubscribe = bridge.subscribe(async (nextState) => {
      if (disposed || nextState.mode !== '2d') return;
      const current = snapshotMapViewState(view, nextState);
      if (viewStateApproximatelyEqual(current, nextState, options.tolerance)) { lastPublished = current; return; }
      applyingBridgeState = true;
      try { await applyViewStateToMapView(view, nextState, options.goToOptions || {}); lastPublished = snapshotMapViewState(view, nextState); }
      catch (error) { options.onApplyError?.(error); }
      finally { applyingBridgeState = false; }
    });
  }
  if (options.publishInitial !== false) schedulePublish();
  return () => { if (disposed) return; disposed = true; if (cancelScheduled) cancelScheduled(); cancelScheduled = null; unsubscribe(); handles.forEach(safeRemove); };
};

export interface ViewPerformanceOptions { slowThresholdMs?: unknown; now?: () => number; }
export interface ViewPerformanceSnapshot { updateCycles: number; completedCycles: number; slowCycles: number; totalUpdatingMs: number; longestUpdatingMs: number; averageUpdatingMs: number; active: boolean; lastScale: number | null; lastZoom: number | null; }
export const createViewPerformanceMonitor = (view: MapViewLike, options: ViewPerformanceOptions = {}) => {
  const slowThresholdMs = Math.max(1, finite(options.slowThresholdMs, 250) as number); const clock = typeof options.now === 'function' ? options.now : now;
  const state = { updateCycles: 0, completedCycles: 0, slowCycles: 0, totalUpdatingMs: 0, longestUpdatingMs: 0, activeSince: null as number | null, lastScale: finite(view?.scale), lastZoom: finite(view?.zoom), disposed: false };
  const handles: WatchHandle[] = [];
  const onUpdating = (updating: boolean): void => { if (state.disposed) return; const current = clock(); if (updating && state.activeSince === null) { state.updateCycles += 1; state.activeSince = current; return; } if (!updating && state.activeSince !== null) { const duration = Math.max(0, current - state.activeSince); state.completedCycles += 1; state.totalUpdatingMs += duration; state.longestUpdatingMs = Math.max(state.longestUpdatingMs, duration); if (duration >= slowThresholdMs) state.slowCycles += 1; state.activeSince = null; } };
  if (typeof view?.watch === 'function') { handles.push(view.watch('updating', onUpdating)); handles.push(view.watch('scale', (value) => { state.lastScale = finite(value); })); handles.push(view.watch('zoom', (value) => { state.lastZoom = finite(value); })); }
  return {
    snapshot: (): ViewPerformanceSnapshot => ({ updateCycles: state.updateCycles, completedCycles: state.completedCycles, slowCycles: state.slowCycles, totalUpdatingMs: state.totalUpdatingMs, longestUpdatingMs: state.longestUpdatingMs, averageUpdatingMs: state.completedCycles ? state.totalUpdatingMs / state.completedCycles : 0, active: state.activeSince !== null, lastScale: state.lastScale, lastZoom: state.lastZoom }),
    dispose: (): void => { if (state.disposed) return; state.disposed = true; handles.forEach(safeRemove); handles.length = 0; },
  };
};

export interface ViewRegistration { view?: any; applyState?: (view: any, state: ViewState, options?: any) => Promise<unknown> | unknown; unbind?: () => void; }
export interface ViewCoordinatorOptions { onError?: (error: unknown, mode: ViewMode) => void; }
export interface ViewCoordinator {
  register: (mode: ViewMode, registration?: ViewRegistration) => () => void;
  switchTo: (mode: ViewMode, switchOptions?: any) => Promise<boolean>;
  publishCamera: (mode: ViewMode, camera: ViewCameraInput) => ViewState;
  getActiveMode: () => ViewMode;
  getView: (mode: ViewMode) => any;
  destroy: () => void;
}
export const createViewCoordinator = (bridge: ViewStateBridge, options: ViewCoordinatorOptions = {}): ViewCoordinator => {
  if (!bridge?.getState || !bridge?.setState) throw new Error('A view-state bridge is required.');
  const registrations = new Map<ViewMode, ViewRegistration>(); let destroyed = false; let activeMode: ViewMode = createViewState(bridge.getState()).mode;
  const register = (mode: ViewMode, registration: ViewRegistration = {}): (() => void) => {
    if (destroyed) throw new Error('View coordinator has been destroyed.');
    const normalizedMode: ViewMode = mode === '3d' ? '3d' : '2d'; const existing = registrations.get(normalizedMode); existing?.unbind?.();
    const entry: ViewRegistration = { view: registration.view || null, applyState: registration.applyState, unbind: registration.unbind || (() => {}) };
    registrations.set(normalizedMode, entry);
    return () => { if (registrations.get(normalizedMode) !== entry) return; entry.unbind?.(); registrations.delete(normalizedMode); };
  };
  const switchTo = async (mode: ViewMode, switchOptions: any = {}): Promise<boolean> => {
    if (destroyed) return false;
    const normalizedMode: ViewMode = mode === '3d' ? '3d' : '2d'; activeMode = normalizedMode; const next = switchViewMode(bridge.getState(), normalizedMode); bridge.setState(next);
    const registration = registrations.get(normalizedMode); if (!registration?.view || typeof registration.applyState !== 'function') return true;
    try { await registration.applyState(registration.view, next, switchOptions); return true; } catch (error) { options.onError?.(error, normalizedMode); return false; }
  };
  const publishCamera = (mode: ViewMode, camera: ViewCameraInput): ViewState => { if (destroyed) return bridge.getState(); const normalizedMode: ViewMode = mode === '3d' ? '3d' : '2d'; const next = updateCamera(bridge.getState(), camera); const withMode = switchViewMode(next, normalizedMode); activeMode = normalizedMode; return bridge.setState(withMode); };
  return { register, switchTo, publishCamera, getActiveMode: () => activeMode, getView: (mode) => registrations.get(mode === '3d' ? '3d' : '2d')?.view || null, destroy: () => { if (destroyed) return; destroyed = true; registrations.forEach((registration) => registration.unbind?.()); registrations.clear(); } };
};
