import { evictArcgisModule, loadArcgisModules } from './arcgisModuleRuntime';
import type { ArcGisGeometryLike, ArcGisGraphicLike } from './contracts';

const IDENTIFY_MODULE_IDS = [
  'esri/rest/identify',
  'esri/rest/support/IdentifyParameters',
] as const;

export const clearIdentifyRuntimeCache = (): void => {
  IDENTIFY_MODULE_IDS.forEach((moduleId) => evictArcgisModule(moduleId));
};

export interface IdentifyRuntimeError extends Error { code?: string; }
const cancelledError = (): IdentifyRuntimeError => Object.assign(new Error('Identify cancelled.'), { code: 'CANCELLED' });
const throwIfAborted = (signal?: AbortSignal): void => { if (signal?.aborted) throw cancelledError(); };

const raceCancellation = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { signal.removeEventListener?.('abort', onAbort); reject(cancelledError()); };
    signal.addEventListener?.('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener?.('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener?.('abort', onAbort); reject(error); },
    );
  });
};

export interface IdentifyLayerLike {
  id?: string;
  uid?: string;
  title?: string;
  name?: string;
  type?: string;
  url?: string;
  visible?: boolean;
  listMode?: string;
  displayField?: string;
  [key: string]: any;
}
export interface IdentifyMapLike {
  allLayers?: { items?: IdentifyLayerLike[]; toArray?: () => IdentifyLayerLike[] };
  layers?: { items?: IdentifyLayerLike[] } | IdentifyLayerLike[];
}
export interface HitTestResultLike { graphic?: ArcGisGraphicLike & { layer?: IdentifyLayerLike }; layer?: IdentifyLayerLike; mapPoint?: ArcGisGeometryLike; }
export interface IdentifyViewLike {
  map?: IdentifyMapLike;
  extent?: unknown;
  width?: number;
  height?: number;
  resolution?: number;
  hitTest?: (event: unknown, options?: { include?: IdentifyLayerLike[] }) => Promise<{ results?: HitTestResultLike[] }>;
  [key: string]: any;
}

const normalizeLayerUrl = (value: unknown): string => String(value || '').trim().replace(/\/+$/, '');
const isMapServiceUrl = (url: string): boolean => /\/MapServer(?:\/\d+)?$/i.test(normalizeLayerUrl(url));
const isFeatureServiceUrl = (url: string): boolean => /\/FeatureServer(?:\/\d+)?$/i.test(normalizeLayerUrl(url));
const getLayerItems = (view: IdentifyViewLike): IdentifyLayerLike[] => {
  const items = view?.map?.allLayers?.items;
  if (Array.isArray(items)) return items;
  if (typeof view?.map?.allLayers?.toArray === 'function') return view.map.allLayers.toArray();
  const layers = view?.map?.layers;
  if (Array.isArray((layers as { items?: IdentifyLayerLike[] } | undefined)?.items)) return (layers as { items: IdentifyLayerLike[] }).items;
  if (Array.isArray(layers)) return layers;
  return [];
};
const isVisible = (layer: IdentifyLayerLike): boolean => layer?.visible !== false && layer?.listMode !== 'hide';
const normalizeLayerIdentity = (layer: IdentifyLayerLike | undefined, fallbackIndex = 0) => ({
  id: String(layer?.id || layer?.uid || layer?.title || `layer-${fallbackIndex}`),
  title: String(layer?.title || layer?.name || layer?.id || `Katman ${fallbackIndex + 1}`),
});

export type IdentifyTargetKind = 'map-service' | 'feature-layer' | 'skip';
export interface IdentifyTarget {
  id: string;
  title: string;
  kind: IdentifyTargetKind;
  url?: string;
  layer: IdentifyLayerLike;
  reason?: 'hidden' | 'group' | 'unsupported';
}
export const classifyIdentifyLayer = (layer: IdentifyLayerLike, index = 0): IdentifyTarget => {
  const url = normalizeLayerUrl(layer?.url);
  const type = String(layer?.type || '').toLowerCase();
  const identity = normalizeLayerIdentity(layer, index);
  if (!isVisible(layer)) return { ...identity, kind: 'skip', reason: 'hidden', layer };
  if (type === 'group') return { ...identity, kind: 'skip', reason: 'group', layer };
  if (type === 'map-image' || type === 'mapimage' || isMapServiceUrl(url)) return { ...identity, kind: 'map-service', url, layer };
  if (type === 'feature' || type === 'feature-layer' || isFeatureServiceUrl(url)) return { ...identity, kind: 'feature-layer', url, layer };
  return { ...identity, kind: 'skip', reason: 'unsupported', url, layer };
};

export interface IdentifyTargets { mapServices: IdentifyTarget[]; featureLayers: IdentifyTarget[]; skipped: IdentifyTarget[]; }
export const collectIdentifyTargets = (view: IdentifyViewLike): IdentifyTargets => {
  const targets = getLayerItems(view).map(classifyIdentifyLayer);
  return {
    mapServices: targets.filter((target) => target.kind === 'map-service'),
    featureLayers: targets.filter((target) => target.kind === 'feature-layer'),
    skipped: targets.filter((target) => target.kind === 'skip'),
  };
};

type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
const settleWithConcurrency = async <TItem, TResult>(items: TItem[], worker: (item: TItem, index: number) => Promise<TResult>, concurrency = 4, signal?: AbortSignal): Promise<Array<Settled<TResult>>> => {
  const source = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(8, Number(concurrency) || 4));
  const results = new Array<Settled<TResult>>(source.length);
  let cursor = 0;
  const run = async (): Promise<void> => {
    while (cursor < source.length) {
      throwIfAborted(signal);
      const index = cursor; cursor += 1;
      try { results[index] = { status: 'fulfilled', value: await worker(source[index]!, index) }; }
      catch (error) { if ((error as IdentifyRuntimeError)?.code === 'CANCELLED') throw error; results[index] = { status: 'rejected', reason: error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, source.length) }, run));
  return results;
};

interface IdentifyParametersLike { width?: number; height?: number; resolution?: number; dpi?: number; layerOption?: string; layerIds?: number[]; [key: string]: any; }
type IdentifyParametersCtor = new (options: Record<string, unknown>) => IdentifyParametersLike;
export interface IdentifyOptions { signal?: AbortSignal; returnGeometry?: boolean; tolerance?: number; dpi?: number; layerOption?: string; layerIds?: number[]; concurrency?: number; }
const createIdentifyParameters = (IdentifyParameters: IdentifyParametersCtor, view: IdentifyViewLike, mapPoint: ArcGisGeometryLike, options: IdentifyOptions = {}): IdentifyParametersLike => {
  const params = new IdentifyParameters({ returnGeometry: options.returnGeometry !== false, geometry: mapPoint, tolerance: Number.isFinite(options.tolerance) ? Math.max(0, Number(options.tolerance)) : 3, mapExtent: view?.extent });
  if (view?.width) params.width = view.width;
  if (view?.height) params.height = view.height;
  if (Number.isFinite(view?.resolution)) params.resolution = Number(view.resolution);
  if (Number.isFinite(options.dpi)) params.dpi = Number(options.dpi);
  if (options.layerOption) params.layerOption = options.layerOption;
  if (Array.isArray(options.layerIds) && options.layerIds.length) params.layerIds = options.layerIds;
  return params;
};

export interface IdentifyResult {
  source: 'identify' | 'hit-test';
  targetId: string;
  targetTitle: string;
  targetUrl: string;
  layerId: string | number;
  layerName: string;
  displayFieldName: string | null;
  value: unknown;
  feature: any;
  attributes: Record<string, any>;
  geometry: any;
  resultIndex: number;
}
const normalizeMapServiceResult = (target: IdentifyTarget, response: any): IdentifyResult[] => {
  const results = Array.isArray(response?.results) ? response.results : [];
  return results.map((result: any, index: number) => ({ source: 'identify', targetId: target.id, targetTitle: target.title, targetUrl: target.url || '', layerId: result?.layerId ?? target.id, layerName: result?.layerName || target.title, displayFieldName: result?.displayFieldName || null, value: result?.value ?? null, feature: result?.feature || null, attributes: result?.feature?.attributes || {}, geometry: result?.feature?.geometry || null, resultIndex: index }));
};

export interface IdentifyFailure { target: IdentifyTarget; error: unknown; }
export const identifyMapServices = async (view: IdentifyViewLike, mapPoint: ArcGisGeometryLike, targets?: IdentifyTarget[], options: IdentifyOptions = {}): Promise<{ results: IdentifyResult[]; failures: IdentifyFailure[] }> => {
  throwIfAborted(options.signal);
  const source = Array.isArray(targets) ? targets : collectIdentifyTargets(view).mapServices;
  if (!source.length) return { results: [], failures: [] };
  const [identify, IdentifyParameters] = await raceCancellation(
    loadArcgisModules<[any, IdentifyParametersCtor]>(IDENTIFY_MODULE_IDS),
    options.signal,
  );
  throwIfAborted(options.signal);
  const settled = await settleWithConcurrency(source, async (target) => {
    throwIfAborted(options.signal);
    const params = createIdentifyParameters(IdentifyParameters, view, mapPoint, options);
    const requestOptions = options.signal ? { signal: options.signal } : undefined;
    const response = await raceCancellation(Promise.resolve(identify.identify(target.url, params, requestOptions)), options.signal);
    throwIfAborted(options.signal);
    return normalizeMapServiceResult(target, response);
  }, options.concurrency, options.signal);
  const results: IdentifyResult[] = [];
  const failures: IdentifyFailure[] = [];
  settled.forEach((entry, index) => { if (entry.status === 'fulfilled') results.push(...entry.value); else failures.push({ target: source[index]!, error: entry.reason }); });
  return { results, failures };
};

const normalizeHitTestResult = (result: HitTestResultLike, index = 0): IdentifyResult => {
  const graphic = result?.graphic;
  const layer = graphic?.layer || result?.layer;
  const identity = normalizeLayerIdentity(layer, index);
  return { source: 'hit-test', targetId: identity.id, targetTitle: identity.title, targetUrl: normalizeLayerUrl(layer?.url), layerId: identity.id, layerName: identity.title, displayFieldName: layer?.displayField || null, value: null, feature: graphic || null, attributes: graphic?.attributes || {}, geometry: graphic?.geometry || result?.mapPoint || null, resultIndex: index };
};

export const identifyFeatureLayers = async (view: IdentifyViewLike, screenEvent: unknown, targets?: IdentifyTarget[], options: IdentifyOptions = {}): Promise<IdentifyResult[]> => {
  throwIfAborted(options.signal);
  if (!view?.hitTest || !screenEvent) return [];
  const source = Array.isArray(targets) ? targets : collectIdentifyTargets(view).featureLayers;
  if (!source.length) return [];
  const include = source.map((target) => target.layer).filter(Boolean);
  const response = await raceCancellation(Promise.resolve(view.hitTest(screenEvent, include.length ? { include } : undefined)), options.signal);
  throwIfAborted(options.signal);
  const allowedLayers = new Set(include);
  return (Array.isArray(response?.results) ? response.results : []).filter((result) => {
    const layer = result?.graphic?.layer || result?.layer;
    return !include.length || allowedLayers.has(layer as IdentifyLayerLike);
  }).map(normalizeHitTestResult);
};

const resultObjectId = (result: IdentifyResult): unknown => {
  const attributes = result?.attributes || result?.feature?.attributes || {};
  return attributes.OBJECTID ?? attributes.ObjectID ?? attributes.objectid ?? attributes.FID ?? attributes.fid ?? result?.feature?.uid ?? result?.feature?.id ?? null;
};
const resultNamespace = (result: IdentifyResult): string => {
  const targetUrl = normalizeLayerUrl(result?.targetUrl);
  if (targetUrl) return targetUrl.toLowerCase();
  if (result?.targetId !== null && result?.targetId !== undefined) return String(result.targetId);
  return String(result?.targetTitle || result?.source || 'unknown');
};
const resultKey = (result: IdentifyResult, fallbackIndex: number): string => {
  const namespace = resultNamespace(result);
  const layerId = String(result?.layerId ?? result?.layerName ?? 'unknown');
  const objectId = resultObjectId(result);
  if (objectId !== null && objectId !== undefined) return `${namespace}:${layerId}:${String(objectId)}`;
  const geometry = result?.geometry;
  const point = geometry && Number.isFinite(geometry.x) && Number.isFinite(geometry.y) ? `${geometry.x}:${geometry.y}` : '';
  return `${namespace}:${layerId}:${point}:${fallbackIndex}`;
};
export const dedupeIdentifyResults = (results: IdentifyResult[] = []): IdentifyResult[] => {
  const seen = new Set<string>();
  return (Array.isArray(results) ? results : []).filter((result, index) => { const key = resultKey(result, index); if (seen.has(key)) return false; seen.add(key); return true; });
};
export interface IdentifyGroup { targetId: string | null; targetTitle: string | null; targetUrl: string | null; layerId: string | number | null; layerName: string; features: IdentifyResult[]; }
export const groupIdentifyResults = (results: IdentifyResult[] = []): IdentifyGroup[] => {
  const groups = new Map<string, IdentifyGroup>();
  dedupeIdentifyResults(results).forEach((result) => {
    const namespace = resultNamespace(result); const layerId = result.layerId ?? result.targetId ?? result.layerName ?? 'unknown'; const key = `${namespace}:${String(layerId)}`;
    if (!groups.has(key)) groups.set(key, { targetId: result.targetId ?? null, targetTitle: result.targetTitle || null, targetUrl: result.targetUrl || null, layerId: result.layerId ?? result.targetId ?? null, layerName: result.layerName || result.targetTitle || 'Katman', features: [] });
    groups.get(key)?.features.push(result);
  });
  return Array.from(groups.values());
};

export interface IdentifyEventLike { mapPoint?: ArcGisGeometryLike; [key: string]: any; }
export interface GlobalIdentifyResult { groups: IdentifyGroup[]; results: IdentifyResult[]; failures: IdentifyFailure[]; skipped: IdentifyTarget[]; targetCount: number; }
export const executeGlobalIdentify = async (view: IdentifyViewLike, event: IdentifyEventLike, options: IdentifyOptions = {}): Promise<GlobalIdentifyResult> => {
  if (!view || !event?.mapPoint) return { groups: [], results: [], failures: [], skipped: [], targetCount: 0 };
  throwIfAborted(options.signal);
  const targets = collectIdentifyTargets(view);
  const [mapServiceResponse, featureResults] = await raceCancellation(Promise.all([
    identifyMapServices(view, event.mapPoint, targets.mapServices, options),
    identifyFeatureLayers(view, event, targets.featureLayers, options),
  ]), options.signal);
  throwIfAborted(options.signal);
  const results = dedupeIdentifyResults([...mapServiceResponse.results, ...featureResults]);
  return { groups: groupIdentifyResults(results), results, failures: mapServiceResponse.failures, skipped: targets.skipped, targetCount: targets.mapServices.length + targets.featureLayers.length };
};

export interface IdentifySession { run: (view: IdentifyViewLike, event: IdentifyEventLike, options?: IdentifyOptions) => Promise<GlobalIdentifyResult>; cancel: () => void; readonly generation: number; readonly active: boolean; }
export const createIdentifySession = (): IdentifySession => {
  let generation = 0;
  let controller: AbortController | null = null;
  const cancel = (): void => { generation += 1; controller?.abort?.(); controller = null; };
  const run = async (view: IdentifyViewLike, event: IdentifyEventLike, options: IdentifyOptions = {}): Promise<GlobalIdentifyResult> => {
    cancel(); const localGeneration = generation; const localController = typeof AbortController !== 'undefined' ? new AbortController() : null; controller = localController;
    try { const result = await executeGlobalIdentify(view, event, { ...options, ...(localController ? { signal: localController.signal } : {}) }); if (generation !== localGeneration) throw cancelledError(); return result; }
    finally { if (controller === localController) controller = null; }
  };
  return { run, cancel, get generation() { return generation; }, get active() { return Boolean(controller); } };
};