import { loadModules } from 'esri-loader';
import { inferServiceType, sanitizeService } from './serviceCatalog';

const moduleCache = new Map();
const load = (name) => {
  if (!moduleCache.has(name)) moduleCache.set(name, loadModules([name]).then((modules) => modules[0]));
  return moduleCache.get(name);
};

const applyCommon = (layer, service) => {
  const safe = sanitizeService(service);
  layer.id = safe.id;
  layer.title = safe.title;
  layer.visible = safe.visible;
  layer.opacity = safe.opacity;
  if (safe.minScale > 0) layer.minScale = safe.minScale;
  if (safe.maxScale > 0) layer.maxScale = safe.maxScale;
  return layer;
};

const withFeatureServerSublayer = (url, sublayerId) => {
  if (!Number.isInteger(sublayerId)) return url;
  if (/\/FeatureServer\/\d+$/i.test(url)) return url;
  return `${url}/FeatureServer/${sublayerId}`;
};

export const create2DLayer = async (service) => {
  const safe = sanitizeService(service);
  switch (inferServiceType(safe)) {
    case 'MapServer': {
      const MapImageLayer = await load('esri/layers/MapImageLayer');
      return applyCommon(new MapImageLayer({ url: safe.url }), safe);
    }
    case 'FeatureServer': {
      const FeatureLayer = await load('esri/layers/FeatureLayer');
      const url = /\/FeatureServer\/\d+$/i.test(safe.url)
        ? safe.url
        : withFeatureServerSublayer(safe.url, safe.sublayerId);
      return applyCommon(new FeatureLayer({ url }), safe);
    }
    case 'VectorTileServer': {
      const VectorTileLayer = await load('esri/layers/VectorTileLayer');
      return applyCommon(new VectorTileLayer({ url: safe.url }), safe);
    }
    case 'ImageServer': {
      const ImageryLayer = await load('esri/layers/ImageryLayer');
      return applyCommon(new ImageryLayer({ url: safe.url }), safe);
    }
    case 'SceneServer': {
      const SceneLayer = await load('esri/layers/SceneLayer');
      return applyCommon(new SceneLayer({ url: safe.url }), safe);
    }
    default:
      throw new Error(`Unsupported 2D GIS layer service: ${safe.type}`);
  }
};

export const create3DLayer = async (service) => {
  const safe = sanitizeService(service);
  switch (inferServiceType(safe)) {
    case 'SceneServer': {
      const SceneLayer = await load('esri/layers/SceneLayer');
      return applyCommon(new SceneLayer({ url: safe.url }), safe);
    }
    case 'FeatureServer': {
      const FeatureLayer = await load('esri/layers/FeatureLayer');
      const url = /\/FeatureServer\/\d+$/i.test(safe.url)
        ? safe.url
        : withFeatureServerSublayer(safe.url, safe.sublayerId);
      return applyCommon(new FeatureLayer({ url }), safe);
    }
    case 'MapServer': {
      const MapImageLayer = await load('esri/layers/MapImageLayer');
      return applyCommon(new MapImageLayer({ url: safe.url }), safe);
    }
    case 'VectorTileServer': {
      const VectorTileLayer = await load('esri/layers/VectorTileLayer');
      return applyCommon(new VectorTileLayer({ url: safe.url }), safe);
    }
    default:
      throw new Error(`Unsupported 3D GIS layer service: ${safe.type}`);
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
    // Feature reduction is an optimization, never a reason to fail layer loading.
  }
  return layer;
};

export const attachLayerLifecycle = (layer, callbacks = {}) => {
  if (!layer) return () => {};
  const handles = [];
  const notify = (event) => {
    const status = layer.loadStatus || event?.status || 'unknown';
    if (status === 'loading') callbacks.onLoading?.(layer);
    if (status === 'loaded') callbacks.onReady?.(layer);
    if (status === 'failed') callbacks.onError?.(layer, layer.loadError || event);
  };
  if (typeof layer.watch === 'function') handles.push(layer.watch('loadStatus', notify));
  if (typeof layer.when === 'function') layer.when(() => callbacks.onReady?.(layer), (error) => callbacks.onError?.(layer, error));
  return () => handles.forEach((handle) => handle?.remove?.());
};
