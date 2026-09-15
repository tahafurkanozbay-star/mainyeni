export const GIS_SERVICE_TYPES = Object.freeze({
  MAP_SERVER: 'MapServer',
  FEATURE_SERVER: 'FeatureServer',
  VECTOR_TILE: 'VectorTileServer',
  IMAGE_SERVER: 'ImageServer',
  SCENE_SERVER: 'SceneServer',
  TILES_3D: '3DTiles',
  GLTF: 'GLTF',
  ELEVATION: 'Elevation',
  GENERIC_ARCGIS_REST: 'ArcGISREST',
});

const DISALLOWED_TYPES = new Set(['WMS', 'WFS', 'WMTS', 'OGC-WMS', 'OGC-WFS']);
const TYPE_ALIASES = new Map([
  ['MAPSERVER', GIS_SERVICE_TYPES.MAP_SERVER],
  ['FEATURESERVER', GIS_SERVICE_TYPES.FEATURE_SERVER],
  ['VECTORTILESERVER', GIS_SERVICE_TYPES.VECTOR_TILE],
  ['IMAGESERVER', GIS_SERVICE_TYPES.IMAGE_SERVER],
  ['SCENESERVER', GIS_SERVICE_TYPES.SCENE_SERVER],
  ['3DTILES', GIS_SERVICE_TYPES.TILES_3D],
  ['GLTF', GIS_SERVICE_TYPES.GLTF],
  ['GLB', GIS_SERVICE_TYPES.GLTF],
  ['ELEVATION', GIS_SERVICE_TYPES.ELEVATION],
  ['ARCGISREST', GIS_SERVICE_TYPES.GENERIC_ARCGIS_REST],
]);

const browserOrigin = () => (
  typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://localhost'
);

export const normalizeServiceUrl = (url) => {
  if (!url) return '';
  const raw = String(url).trim();
  try {
    const parsed = new URL(raw, browserOrigin());
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_) {
    return raw.replace(/\/+$/, '');
  }
};

const canonicalizeType = (type) => {
  const raw = String(type || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (DISALLOWED_TYPES.has(upper)) return upper;
  return TYPE_ALIASES.get(upper) || raw;
};

const inferTypeFromUrl = (url) => {
  const normalized = normalizeServiceUrl(url);
  const match = normalized.match(
    /\/(MapServer|FeatureServer|VectorTileServer|ImageServer|SceneServer)(?:\/\d+)?$/i,
  );
  return match ? canonicalizeType(match[1]) : GIS_SERVICE_TYPES.GENERIC_ARCGIS_REST;
};

export const inferServiceType = (service = {}) => {
  const explicitType = canonicalizeType(service?.type);
  return explicitType || inferTypeFromUrl(service?.url);
};

export const isDisallowedServiceType = (serviceOrType) => {
  const type = typeof serviceOrType === 'string'
    ? canonicalizeType(serviceOrType)
    : inferServiceType(serviceOrType);
  return DISALLOWED_TYPES.has(String(type).trim().toUpperCase());
};

export const isArcGISRestService = (service) => [
  GIS_SERVICE_TYPES.MAP_SERVER,
  GIS_SERVICE_TYPES.FEATURE_SERVER,
  GIS_SERVICE_TYPES.VECTOR_TILE,
  GIS_SERVICE_TYPES.IMAGE_SERVER,
  GIS_SERVICE_TYPES.SCENE_SERVER,
  GIS_SERVICE_TYPES.GENERIC_ARCGIS_REST,
].includes(inferServiceType(service));

export const getServiceKindLabel = (service) => ({
  MapServer: 'ArcGIS MapServer',
  FeatureServer: 'ArcGIS FeatureServer',
  VectorTileServer: 'ArcGIS VectorTileServer',
  ImageServer: 'ArcGIS ImageServer',
  SceneServer: 'ArcGIS SceneServer',
  '3DTiles': '3D Tiles',
  GLTF: 'glTF / GLB',
  Elevation: 'Elevation',
})[inferServiceType(service)] || 'ArcGIS REST';

const normalizeOpacity = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 1;
};

const normalizeScale = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
};

export const sanitizeService = (service = {}) => {
  const type = inferServiceType(service);
  if (isDisallowedServiceType(type)) {
    throw new Error(`Service type ${type} is not supported by the GIS engine.`);
  }

  const safe = {
    id: String(service.id ?? '').trim(),
    title: String(service.title ?? service.name ?? service.id ?? 'GIS Layer').trim(),
    type,
    url: normalizeServiceUrl(service.url),
    enabled: service.enabled !== false,
    opacity: normalizeOpacity(service.opacity),
    minScale: normalizeScale(service.minScale),
    maxScale: normalizeScale(service.maxScale),
    visible: service.visible !== false,
    sublayerId: Number.isInteger(service.sublayerId) ? service.sublayerId : null,
    proxy: service.proxy === true,
    metadata: { ...(service.metadata || {}) },
  };

  if (!safe.id) throw new Error('GIS service id is required.');
  if (!safe.url) throw new Error(`GIS service ${safe.id} has no URL.`);
  return safe;
};

export const sanitizeCatalog = (services = []) => {
  const seen = new Set();
  const result = [];

  (Array.isArray(services) ? services : []).forEach((service) => {
    try {
      const safe = sanitizeService(service);
      if (!seen.has(safe.id)) {
        seen.add(safe.id);
        result.push(safe);
      }
    } catch (_) {
      // Invalid/unapproved services are deliberately excluded from runtime.
    }
  });
  return result;
};

export const indexCatalog = (services = []) => new Map(
  sanitizeCatalog(services).map((service) => [service.id, service]),
);

export const mergeCatalog = (base = [], incoming = []) => {
  const map = indexCatalog(base);
  sanitizeCatalog(incoming).forEach((service) => {
    const previous = map.get(service.id);
    map.set(service.id, {
      ...(previous || {}),
      ...service,
      metadata: {
        ...(previous?.metadata || {}),
        ...(service.metadata || {}),
      },
    });
  });
  return [...map.values()];
};

export const selectOperationalServices = (services = []) => sanitizeCatalog(services)
  .filter((service) => service.enabled && service.visible);

export const toRuntimeLayerOptions = (service) => {
  const safe = sanitizeService(service);
  return {
    id: safe.id,
    title: safe.title,
    url: safe.url,
    opacity: safe.opacity,
    visible: safe.visible,
    minScale: safe.minScale,
    maxScale: safe.maxScale,
    sublayerId: safe.sublayerId,
    type: safe.type,
    proxy: safe.proxy,
  };
};

export const hasSameOrigin = (url) => {
  if (!url) return false;
  try {
    return new URL(url, browserOrigin()).origin === browserOrigin();
  } catch (_) {
    return false;
  }
};

export const enforceNetworkPolicy = (
  service,
  { allowSameOrigin = true, allowConfiguredRemote = false, allowProxy = true } = {},
) => {
  const safe = sanitizeService(service);
  if (hasSameOrigin(safe.url)) return true;
  if (safe.proxy && allowProxy) return true;
  if (allowConfiguredRemote) return true;
  if (allowSameOrigin) {
    throw new Error(`Remote GIS endpoint is blocked until server/proxy policy allows ${safe.id}.`);
  }
  return false;
};
