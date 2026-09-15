import { loadModules } from 'esri-loader';
import {
  GIS_SERVICE_TYPES,
  inferServiceType,
  sanitizeService,
} from './serviceCatalog';

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

const applyCommon = (layer, service) => {
  layer.id = service.id;
  layer.title = service.title;
  layer.visible = service.visible;
  layer.opacity = service.opacity;
  if (service.minScale > 0) layer.minScale = service.minScale;
  if (service.maxScale > 0) layer.maxScale = service.maxScale;
  return layer;
};

const featureLayerUrl = (service) => {
  const url = service.url;
  if (!Number.isInteger(service.sublayerId)) return url;
  if (/\/FeatureServer\/\d+$/i.test(url)) return url;
  if (/\/FeatureServer$/i.test(url)) return `${url}/${service.sublayerId}`;

  // Do not manufacture a REST hierarchy for an endpoint whose shape has not
  // been observed. Explicitly typed services may point at a server-owned alias.
  return url;
};

const createFeatureLayer = async (service) => {
  const FeatureLayer = await load('esri/layers/FeatureLayer');
  return applyCommon(new FeatureLayer({ url: featureLayerUrl(service) }), service);
};

const createMapImageLayer = async (service) => {
  const MapImageLayer = await load('esri/layers/MapImageLayer');
  return applyCommon(new MapImageLayer({ url: service.url }), service);
};

const createVectorTileLayer = async (service) => {
  const VectorTileLayer = await load('esri/layers/VectorTileLayer');
  return applyCommon(new VectorTileLayer({ url: service.url }), service);
};

const createImageryLayer = async (service) => {
  const ImageryLayer = await load('esri/layers/ImageryLayer');
  return applyCommon(new ImageryLayer({ url: service.url }), service);
};

const createSceneLayer = async (service) => {
  const SceneLayer = await load('esri/layers/SceneLayer');
  return applyCommon(new SceneLayer({ url: service.url }), service);
};

export const create2DLayer = async (input) => {
  const service = sanitizeService(input);

  switch (inferServiceType(service)) {
    case GIS_SERVICE_TYPES.MAP_SERVER:
      return createMapImageLayer(service);
    case GIS_SERVICE_TYPES.FEATURE_SERVER:
      return createFeatureLayer(service);
    case GIS_SERVICE_TYPES.VECTOR_TILE:
      return createVectorTileLayer(service);
    case GIS_SERVICE_TYPES.IMAGE_SERVER:
      return createImageryLayer(service);
    case GIS_SERVICE_TYPES.SCENE_SERVER:
      return createSceneLayer(service);
    default:
      throw new Error(`Unsupported 2D GIS layer service: ${service.type}`);
  }
};

export const create3DLayer = async (input) => {
  const service = sanitizeService(input);

  switch (inferServiceType(service)) {
    case GIS_SERVICE_TYPES.SCENE_SERVER:
      return createSceneLayer(service);
    case GIS_SERVICE_TYPES.FEATURE_SERVER:
      return createFeatureLayer(service);
    case GIS_SERVICE_TYPES.MAP_SERVER:
      return createMapImageLayer(service);
    case GIS_SERVICE_TYPES.VECTOR_TILE:
      return createVectorTileLayer(service);
    case GIS_SERVICE_TYPES.IMAGE_SERVER:
      return createImageryLayer(service);
    default:
      throw new Error(`Unsupported 3D GIS layer service: ${service.type}`);
  }
};

export const applyFeatureReduction = (layer, options = {}) => {
  if (!layer || layer.type !== 'feature' || options.enabled === false) return layer;
  if (layer.geometryType && layer.geometryType !== 'point') return layer;

  const maxScale = Number.isFinite(options.maxScale) ? options.maxScale : 10000;
  const clusterRadius = Number.isFinite(options.clusterRadius) ? options.clusterRadius : 60;

  try {
    layer.featureReduction = {
      type: 'cluster',
      clusterRadius,
      maxScale,
      popupTemplate: options.popupTemplate || layer.popupTemplate,
      labelsVisible: false,
    };
  } catch (_) {
    // Feature reduction is optional; unsupported SDK/layer combinations must
    // never make the operational layer itself fail to load.
  }
  return layer;
};

export const attachLayerLifecycle = (layer, callbacks = {}) => {
  if (!layer) return () => {};
  const handles = [];
  let settled = false;

  const onReady = () => {
    if (settled) return;
    settled = true;
    callbacks.onReady?.(layer);
  };
  const onError = (error) => {
    if (settled) return;
    settled = true;
    callbacks.onError?.(layer, error || layer.loadError);
  };
  const notify = (status) => {
    const nextStatus = typeof status === 'string' ? status : layer.loadStatus || status?.status;
    if (nextStatus === 'loading') callbacks.onLoading?.(layer);
    if (nextStatus === 'loaded') onReady();
    if (nextStatus === 'failed') onError(layer.loadError || status);
  };

  if (typeof layer.watch === 'function') handles.push(layer.watch('loadStatus', notify));
  if (typeof layer.when === 'function') layer.when(onReady, onError);

  return () => handles.forEach((handle) => handle?.remove?.());
};
