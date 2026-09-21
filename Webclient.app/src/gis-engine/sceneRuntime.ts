import { watchArcgisProperty, type ArcgisAccessorWatch } from './arcgisReactiveRuntime';
import { loadArcgisModule, resetArcgisModuleRuntimeCache } from './arcgisModuleRuntime';
import { createViewState, updateSelection } from './viewState';
import { create3DLayer } from './layerFactory';
import type { ArcGisGraphicLike, ArcGisLayerLike, GisServiceInput, ViewState, ViewStateBridge, ViewStateInput } from './contracts';

const finite = (value: unknown, fallback: number | null = null): number | null => { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : fallback; };
const safeRemove = (
  handle: { remove?: () => void } | null | undefined,
  onError?: (error: unknown) => void,
): void => {
  try {
    handle?.remove?.();
  } catch (error) {
    onError?.(error);
  }
};

export interface SceneViewLike {
  camera?: any; extent?: any; scale?: number; container?: any;
  map?: { add?: (layer: ArcGisLayerLike, index?: number) => unknown; ground?: any; basemap?: any };
  hitTest?: (point: unknown, options?: any) => Promise<any>;
  goTo?: (target: any, options?: any) => Promise<any>;
  watch?: (property: string, callback: (...args: any[]) => void) => { remove?: () => void };
  on?: (event: string, callback: (event: any) => void) => { remove?: () => void };
  resize?: () => void;
  when?: () => Promise<unknown>;
  destroyed?: boolean;
  width?: number;
  height?: number;
  destroy?: () => void;
}
const sceneCenter = (view: SceneViewLike): [number, number] | null => { const position = view?.camera?.position; const longitude = finite(position?.longitude); const latitude = finite(position?.latitude); if (longitude !== null && latitude !== null) return [longitude, latitude]; const x = finite(position?.x); const y = finite(position?.y); return x !== null && y !== null ? [x, y] : null; };
const sceneExtent = (view: SceneViewLike) => { const extent = view?.extent; if (!extent) return null; const xmin = finite(extent.xmin); const ymin = finite(extent.ymin); const xmax = finite(extent.xmax); const ymax = finite(extent.ymax); if ([xmin, ymin, xmax, ymax].some((value) => value === null) || xmin === null || ymin === null || xmax === null || ymax === null) return null; return { xmin, ymin, xmax, ymax, wkid: finite(extent.spatialReference?.wkid) }; };

export interface SceneCreateOptions { map?: any; basemap?: any; ground?: any; camera?: any; qualityProfile?: string; environment?: any; constraints?: any; padding?: any; }

export interface SceneContainerLike {
  clientWidth?: number;
  clientHeight?: number;
  getBoundingClientRect?: () => { width?: number; height?: number };
}

export interface SceneContainerWaitOptions {
  maxFrames?: number;
  nextFrame?: () => Promise<void>;
}

const sceneContainerDimensions = (container: SceneContainerLike | null | undefined): readonly [number, number] => {
  if (!container) return [0, 0] as const;
  const rect = typeof container.getBoundingClientRect === 'function'
    ? container.getBoundingClientRect()
    : null;
  const width = finite(rect?.width, finite(container.clientWidth, 0)) ?? 0;
  const height = finite(rect?.height, finite(container.clientHeight, 0)) ?? 0;
  return [Math.max(0, width), Math.max(0, height)] as const;
};

export const isSceneContainerRenderable = (container: SceneContainerLike | null | undefined): boolean => {
  const [width, height] = sceneContainerDimensions(container);
  return width >= 2 && height >= 2;
};

const nextSceneFrame = (): Promise<void> => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => resolve());
    return;
  }
  queueMicrotask(resolve);
});

export const waitForSceneContainer = async (
  container: SceneContainerLike | null | undefined,
  options: SceneContainerWaitOptions = {},
): Promise<void> => {
  const maxFrames = Math.max(1, Math.min(12, Math.floor(finite(options.maxFrames, 6) ?? 6)));
  const nextFrame = options.nextFrame ?? nextSceneFrame;
  for (let frame = 0; frame < maxFrames; frame += 1) {
    if (isSceneContainerRenderable(container)) return;
    await nextFrame();
  }
  if (!isSceneContainerRenderable(container)) {
    throw new Error('SceneView container has no renderable layout.');
  }
};

export const synchronizeSceneViewSize = (view: SceneViewLike | null | undefined): boolean => {
  if (!view || view.destroyed || typeof view.resize !== 'function') return false;
  view.resize();
  return true;
};
const createOwnedSceneMap = async (options: SceneCreateOptions = {}): Promise<any> => { const MapCtor = await loadArcgisModule<any>('esri/Map'); const mapOptions: Record<string, any> = {}; if (options.basemap !== undefined) mapOptions.basemap = options.basemap; if (options.ground !== undefined) mapOptions.ground = options.ground; return new MapCtor(mapOptions); };
export const resetSceneRuntimeModuleCache = (): void => { resetArcgisModuleRuntimeCache(); };
export const createSceneView = async (container: unknown, options: SceneCreateOptions = {}): Promise<{ map: any; view: SceneViewLike; ownsMap: boolean }> => {
  const SceneViewCtor = await loadArcgisModule<any>('esri/views/SceneView'); const ownsMap = !options.map; const map = options.map || await createOwnedSceneMap(options); const viewOptions: Record<string, any> = { container, map, ui: { components: [] } };
  if (options.camera !== undefined) viewOptions.camera = options.camera; viewOptions.qualityProfile = options.qualityProfile !== undefined ? options.qualityProfile : 'medium'; if (options.environment !== undefined) viewOptions.environment = options.environment; if (options.constraints !== undefined) viewOptions.constraints = options.constraints; if (options.padding !== undefined) viewOptions.padding = options.padding;
  const view = new SceneViewCtor(viewOptions) as SceneViewLike; return { map, view, ownsMap };
};
export const destroySceneView = (
  scene: SceneViewLike | { view?: SceneViewLike } | null | undefined,
  onError?: (error: unknown) => void,
): void => {
  const view = (scene as { view?: SceneViewLike })?.view || scene as SceneViewLike;
  if (!view) return;
  try {
    view.container = null;
    view.destroy?.();
  } catch (error) {
    onError?.(error);
  }
};
export interface GroundOptions { opacity?: unknown; navigationConstraint?: any; surfaceColor?: any; }
export const configureGround = async (view: SceneViewLike, options: GroundOptions = {}): Promise<SceneViewLike> => { if (!view?.map?.ground) return view; if (options.opacity !== undefined) { const numericOpacity = Number(options.opacity); view.map.ground.opacity = Number.isFinite(numericOpacity) ? Math.max(0, Math.min(1, numericOpacity)) : 1; } if (options.navigationConstraint) view.map.ground.navigationConstraint = options.navigationConstraint; if (options.surfaceColor !== undefined) view.map.ground.surfaceColor = options.surfaceColor; return view; };

export interface SceneLayerOptions { featureReduction?: any; elevationInfo?: any; index?: number; }
export const addSceneLayer = async (view: SceneViewLike, service: GisServiceInput, options: SceneLayerOptions = {}): Promise<ArcGisLayerLike> => { if (!view?.map?.add) throw new Error('A SceneView with an attached map is required.'); const layer = await create3DLayer(service); if (options.featureReduction !== undefined) layer.featureReduction = options.featureReduction; if (options.elevationInfo !== undefined) layer.elevationInfo = options.elevationInfo; view.map.add(layer, Number.isInteger(options.index) ? options.index : undefined); return layer; };
export interface AddSceneLayersOptions { concurrency?: number; signal?: AbortSignal; stopOnError?: boolean; layerOptions?: SceneLayerOptions[]; }
export type SceneLayerSettled = { status: 'fulfilled'; value: ArcGisLayerLike } | { status: 'rejected'; reason: unknown };
export const addSceneLayers = async (view: SceneViewLike, services: GisServiceInput[] = [], options: AddSceneLayersOptions = {}): Promise<SceneLayerSettled[]> => {
  const input = Array.isArray(services) ? services : []; const concurrency = Math.max(1, Math.min(8, Math.floor(Number(options.concurrency) || 2))); const results: SceneLayerSettled[] = []; let nextIndex = 0; let stopped = false;
  const worker = async (): Promise<void> => { while (!stopped) { if (options.signal?.aborted) { stopped = true; return; } const index = nextIndex; nextIndex += 1; if (index >= input.length) return; try { const layer = await addSceneLayer(view, input[index]!, options.layerOptions?.[index] || {}); results[index] = { status: 'fulfilled', value: layer }; } catch (error) { results[index] = { status: 'rejected', reason: error }; if (options.stopOnError === true) { stopped = true; return; } } } };
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, worker)); return results.filter(Boolean);
};

const raceHitTestWithAbort = <T>(hitPromise: Promise<T>, signal?: AbortSignal): Promise<T | { results: any[] }> => {
  if (!signal) return hitPromise; if (signal.aborted) return Promise.resolve({ results: [] });
  return new Promise<T | { results: any[] }>((resolve, reject) => { let settled = false; const finish = (callback: (value: any) => void, value: any): void => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); callback(value); }; const onAbort = () => finish(resolve, { results: [] }); signal.addEventListener('abort', onAbort, { once: true }); hitPromise.then((value) => finish(resolve, value), (error) => finish(reject, error)); });
};
export interface ScenePickOptions { signal?: AbortSignal; include?: any[]; exclude?: any[]; }
export interface ScenePick { graphic: ArcGisGraphicLike | null; layer: any; mapPoint: any; }
export const pickScene = async (view: SceneViewLike, screenPoint: unknown, options: ScenePickOptions = {}): Promise<ScenePick[]> => {
  if (!view?.hitTest || !screenPoint || options.signal?.aborted) return []; const hitOptions: any = {}; if (Array.isArray(options.include) && options.include.length) hitOptions.include = options.include; if (Array.isArray(options.exclude) && options.exclude.length) hitOptions.exclude = options.exclude;
  const response: any = await raceHitTestWithAbort(Promise.resolve(view.hitTest(screenPoint, hitOptions)), options.signal); if (options.signal?.aborted) return []; return (response?.results || []).map((result: any) => ({ graphic: result.graphic || null, layer: result.graphic?.layer || null, mapPoint: result.mapPoint || null }));
};
export interface FocusGraphicOptions { signal?: AbortSignal; targetFactory?: (graphic: ArcGisGraphicLike) => any; duration?: number; animate?: boolean; }
export const focusPickedGraphic = async (view: SceneViewLike, graphic: ArcGisGraphicLike, options: FocusGraphicOptions = {}): Promise<boolean> => { if (!graphic?.geometry || !view?.goTo || options.signal?.aborted) return false; const target = options.targetFactory ? options.targetFactory(graphic) : graphic.geometry; try { await view.goTo(target, { duration: Number.isFinite(options.duration) ? options.duration : 500, animate: options.animate !== false }); return !options.signal?.aborted; } catch (error) { if (options.signal?.aborted || (error as any)?.name === 'AbortError') return false; throw error; } };

export const snapshotSceneState = (view: SceneViewLike, previous: ViewStateInput | ViewState = {}): ViewState => createViewState({ ...previous, mode: '3d', center: sceneCenter(view) ?? previous.center, scale: finite(view?.scale, finite(previous.scale)), heading: finite(view?.camera?.heading, finite(previous.heading, 0)), tilt: finite(view?.camera?.tilt, finite(previous.tilt, 0)), extent: sceneExtent(view) ?? previous.extent, basemapId: view?.map?.basemap?.id ?? view?.map?.basemap?.portalItem?.id ?? view?.map?.basemap?.title ?? previous.basemapId ?? null });
export interface SceneApplyOptions { allowCrossMode?: boolean; duration?: unknown; animate?: boolean; signal?: AbortSignal; }
export const applyViewStateToSceneView = async (view: SceneViewLike, inputState: ViewStateInput | ViewState = {}, options: SceneApplyOptions = {}): Promise<boolean> => {
  if (!view?.goTo) return false; const state = createViewState(inputState); if (state.mode !== '3d' && options.allowCrossMode !== true) return false; const rawCenter = Array.isArray(inputState.center) && inputState.center.length >= 2; const target: any = {};
  if (rawCenter && state.center) target.center = [...state.center]; if (inputState.scale !== null && inputState.scale !== undefined && Number.isFinite(state.scale)) target.scale = state.scale; if (inputState.heading !== null && inputState.heading !== undefined && Number.isFinite(state.heading)) target.heading = state.heading; if (inputState.tilt !== null && inputState.tilt !== undefined && Number.isFinite(state.tilt)) target.tilt = state.tilt;
  if (!Object.keys(target).length && state.extent) target.extent = { xmin: state.extent.xmin, ymin: state.extent.ymin, xmax: state.extent.xmax, ymax: state.extent.ymax, ...(state.extent.wkid ? { spatialReference: { wkid: state.extent.wkid } } : {}) }; if (!Object.keys(target).length) return false;
  try { await view.goTo(target, { duration: Math.max(0, finite(options.duration, 0) as number), animate: options.animate === true }); return true; } catch (error) { if (options.signal?.aborted || (error as any)?.name === 'AbortError') return false; throw error; }
};

export interface BindSceneOptions { include?: any[]; exclude?: any[]; onState?: (state: ViewState) => void; applyIncoming?: boolean; goToOptions?: SceneApplyOptions; onApplyError?: (error: unknown) => void; accessorWatch?: ArcgisAccessorWatch | undefined; }
export const bindSceneState = (view: SceneViewLike, bridge: ViewStateBridge, selectionCallback?: (selection: ScenePick | null, hits: ScenePick[]) => void, options: BindSceneOptions = {}): (() => void) => {
  if (!view || !bridge) return () => {}; const handles: Array<{ remove?: () => void }> = []; let disposed = false; let selectionController: AbortController | null = null; let applyingBridgeState = false; let unsubscribe: () => boolean | void = () => {};
  const sync = (): void => { if (disposed || applyingBridgeState) return; const next = snapshotSceneState(view, bridge.getState()); bridge.setState(next); options.onState?.(next); };
  const cameraHandle = watchArcgisProperty(view, 'camera', sync, options.accessorWatch);
  const scaleHandle = watchArcgisProperty(view, 'scale', sync, options.accessorWatch);
  if (cameraHandle) handles.push(cameraHandle);
  if (scaleHandle) handles.push(scaleHandle);
  const clickHandle = view.on?.('click', async (event: any) => { selectionController?.abort?.(); selectionController = typeof AbortController !== 'undefined' ? new AbortController() : null; const signal = selectionController?.signal; const pickOptions: ScenePickOptions = { ...(signal === undefined ? {} : { signal }), ...(options.include === undefined ? {} : { include: options.include }), ...(options.exclude === undefined ? {} : { exclude: options.exclude }) }; const hits = await pickScene(view, event, pickOptions); if (disposed || signal?.aborted) return; const first = hits[0]; if (!first?.graphic) { bridge.setState((state) => updateSelection(state, { layerId: null, objectId: null })); selectionCallback?.(null, hits); return; } const attributes = first.graphic.attributes || {}; const objectId = attributes.OBJECTID ?? attributes.ObjectID ?? first.graphic.uid ?? first.graphic.id ?? null; bridge.setState((state) => updateSelection(state, { layerId: first.layer?.id, objectId })); selectionCallback?.(first, hits); }); if (clickHandle) handles.push(clickHandle);
  if (options.applyIncoming === true && typeof bridge.subscribe === 'function') unsubscribe = bridge.subscribe(async (nextState) => { if (disposed || nextState.mode !== '3d') return; const current = snapshotSceneState(view, nextState); if (current.center?.[0] === nextState.center?.[0] && current.center?.[1] === nextState.center?.[1] && current.scale === nextState.scale && current.heading === nextState.heading && current.tilt === nextState.tilt) return; applyingBridgeState = true; try { await applyViewStateToSceneView(view, nextState, options.goToOptions || {}); } catch (error) { options.onApplyError?.(error); } finally { applyingBridgeState = false; } });
  return () => {
    if (disposed) return;
    disposed = true;
    selectionController?.abort?.();
    unsubscribe();
    handles.forEach((handle) => safeRemove(handle, options.onApplyError));
  };
};

export interface SceneBookmark { id: string; title: string; mode: '3d'; camera: any; scale: number | null; }
export const buildSceneBookmark = (view: SceneViewLike, id: unknown, title?: unknown): SceneBookmark => { const camera = view?.camera; return { id: String(id), title: String(title || id), mode: '3d', camera: camera ? { position: camera.position?.toJSON ? camera.position.toJSON() : camera.position, heading: camera.heading, tilt: camera.tilt } : null, scale: finite(view?.scale) }; };
export const applySceneBookmark = async (view: SceneViewLike, bookmark: SceneBookmark, options: { duration?: number; animate?: boolean; signal?: AbortSignal } = {}): Promise<boolean> => { if (!view?.goTo || !bookmark?.camera) return false; try { await view.goTo({ camera: bookmark.camera, ...(Number.isFinite(bookmark.scale) ? { scale: bookmark.scale } : {}) }, { duration: Number.isFinite(options.duration) ? options.duration : 600, animate: options.animate !== false }); return true; } catch (error) { if (options.signal?.aborted || (error as any)?.name === 'AbortError') return false; throw error; } };
export type SceneMeasureKind = 'distance' | 'area' | 'height' | string;
export const createSceneMeasureContract = (kind: SceneMeasureKind = 'distance') => Object.freeze({ kind, supported: ['distance', 'area', 'height'].includes(kind), useArcGISMeasurement: true, units: kind === 'area' ? ['square-meters', 'square-kilometers'] : ['meters', 'kilometers'] });
export const create2D3DSyncState = (initial: ViewStateInput = {}): ViewState => createViewState({ ...initial, mode: initial.mode === '3d' ? '3d' : '2d' });
