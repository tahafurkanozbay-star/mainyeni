import { loadArcgisModule } from './arcgisModuleRuntime';
import { GIS_SERVICE_TYPES, inferServiceType, sanitizeService } from './serviceCatalog';
import type { ArcGisLayerLike, GisServiceInput, SanitizedGisService } from './contracts';

const applyCommon = <T extends ArcGisLayerLike>(layer: T, service: SanitizedGisService): T => {
  layer.id = service.id; layer.title = service.title; layer.visible = service.visible; layer.opacity = service.opacity;
  if (service.minScale > 0) layer.minScale = service.minScale;
  if (service.maxScale > 0) layer.maxScale = service.maxScale;
  return layer;
};

const featureLayerUrl = (service: SanitizedGisService): string => {
  const url = service.url;
  if (!Number.isInteger(service.sublayerId)) return url;
  if (/\/FeatureServer\/\d+$/i.test(url)) return url;
  if (/\/FeatureServer$/i.test(url)) return `${url}/${service.sublayerId}`;
  return url;
};

type LayerConstructor = new (options: Record<string, unknown>) => ArcGisLayerLike;
const createLayer = async (moduleName: string, service: SanitizedGisService, url = service.url): Promise<ArcGisLayerLike> => {
  const Layer = await loadArcgisModule<LayerConstructor>(moduleName);
  return applyCommon(new Layer({ url }), service);
};
const createFeatureLayer = (service: SanitizedGisService) => createLayer('esri/layers/FeatureLayer', service, featureLayerUrl(service));
const createMapImageLayer = (service: SanitizedGisService) => createLayer('esri/layers/MapImageLayer', service);
const createVectorTileLayer = (service: SanitizedGisService) => createLayer('esri/layers/VectorTileLayer', service);
const createImageryLayer = (service: SanitizedGisService) => createLayer('esri/layers/ImageryLayer', service);
const createSceneLayer = (service: SanitizedGisService) => createLayer('esri/layers/SceneLayer', service);

const createSupportedLayer = async (input: GisServiceInput, dimension: '2D' | '3D'): Promise<ArcGisLayerLike> => {
  const service = sanitizeService(input);
  switch (inferServiceType(service)) {
    case GIS_SERVICE_TYPES.SCENE_SERVER: return createSceneLayer(service);
    case GIS_SERVICE_TYPES.FEATURE_SERVER: return createFeatureLayer(service);
    case GIS_SERVICE_TYPES.MAP_SERVER: return createMapImageLayer(service);
    case GIS_SERVICE_TYPES.VECTOR_TILE: return createVectorTileLayer(service);
    case GIS_SERVICE_TYPES.IMAGE_SERVER: return createImageryLayer(service);
    default: throw new Error(`Unsupported ${dimension} GIS layer service: ${service.type}`);
  }
};
export const create2DLayer = (input: GisServiceInput): Promise<ArcGisLayerLike> => createSupportedLayer(input, '2D');
export const create3DLayer = (input: GisServiceInput): Promise<ArcGisLayerLike> => createSupportedLayer(input, '3D');

export interface FeatureReductionOptions { enabled?: boolean; maxScale?: number; clusterRadius?: number; popupTemplate?: unknown; }
export const applyFeatureReduction = <T extends ArcGisLayerLike>(layer: T, options: FeatureReductionOptions = {}): T => {
  if (!layer || layer.type !== 'feature' || options.enabled === false) return layer;
  if (layer.geometryType && layer.geometryType !== 'point') return layer;
  const maxScale = Number.isFinite(options.maxScale) ? Number(options.maxScale) : 10000;
  const clusterRadius = Number.isFinite(options.clusterRadius) ? Number(options.clusterRadius) : 60;
  try {
    layer.featureReduction = { type: 'cluster', clusterRadius, maxScale, popupTemplate: options.popupTemplate || layer.popupTemplate, labelsVisible: false };
  } catch (_) { /* Optional capability: unsupported combinations do not fail the layer. */ }
  return layer;
};

export interface LayerLifecycleCallbacks<T extends ArcGisLayerLike = ArcGisLayerLike> {
  onLoading?: (layer: T) => void; onReady?: (layer: T) => void; onError?: (layer: T, error: unknown) => void;
}
export const attachLayerLifecycle = <T extends ArcGisLayerLike>(layer: T, callbacks: LayerLifecycleCallbacks<T> = {}): (() => void) => {
  if (!layer) return () => {};
  const handles: Array<{ remove?: () => void } | undefined> = [];
  let settled = false;
  const onReady = (): void => { if (settled) return; settled = true; callbacks.onReady?.(layer); };
  const onError = (error: unknown): void => { if (settled) return; settled = true; callbacks.onError?.(layer, error || layer.loadError); };
  const notify = (status: unknown): void => {
    const candidate = status as { status?: string } | null;
    const nextStatus = typeof status === 'string' ? status : layer.loadStatus || candidate?.status;
    if (nextStatus === 'loading') callbacks.onLoading?.(layer);
    if (nextStatus === 'loaded') onReady();
    if (nextStatus === 'failed') onError(layer.loadError || status);
  };
  if (typeof layer.watch === 'function') handles.push(layer.watch('loadStatus', notify));
  if (typeof layer.when === 'function') layer.when(onReady, onError);
  return () => handles.forEach((handle) => handle?.remove?.());
};
