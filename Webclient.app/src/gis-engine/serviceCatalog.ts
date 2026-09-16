import { GIS_SERVICE_TYPE } from './contracts';
import type {
  GisServiceInput,
  GisServiceType,
  SanitizedGisService,
} from './contracts';

export const GIS_SERVICE_TYPES = GIS_SERVICE_TYPE;

const DISALLOWED_TYPES = new Set(['WMS', 'WFS', 'WMTS', 'OGC-WMS', 'OGC-WFS']);
const TYPE_ALIASES = new Map<string, GisServiceType>([
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

const browserOrigin = (): string => (
  typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://localhost'
);

export const normalizeServiceUrl = (url: unknown): string => {
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

const canonicalizeType = (type: unknown): string => {
  const raw = String(type || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (DISALLOWED_TYPES.has(upper)) return upper;
  return TYPE_ALIASES.get(upper) || raw;
};

const inferTypeFromUrl = (url: unknown): GisServiceType => {
  const normalized = normalizeServiceUrl(url);
  const match = normalized.match(
    /\/(MapServer|FeatureServer|VectorTileServer|ImageServer|SceneServer)(?:\/\d+)?$/i,
  );
  return (match ? canonicalizeType(match[1]) : GIS_SERVICE_TYPES.GENERIC_ARCGIS_REST) as GisServiceType;
};

export const inferServiceType = (service: GisServiceInput = {}): GisServiceType | string => {
  const explicitType = canonicalizeType(service?.type);
  return explicitType || inferTypeFromUrl(service?.url);
};

export const isDisallowedServiceType = (serviceOrType: GisServiceInput | string): boolean => {
  const type = typeof serviceOrType === 'string'
    ? canonicalizeType(serviceOrType)
    : inferServiceType(serviceOrType);
  return DISALLOWED_TYPES.has(String(type).trim().toUpperCase());
};

export const isArcGISRestService = (service: GisServiceInput): boolean => ([
  GIS_SERVICE_TYPES.MAP_SERVER,
  GIS_SERVICE_TYPES.FEATURE_SERVER,
  GIS_SERVICE_TYPES.VECTOR_TILE,
  GIS_SERVICE_TYPES.IMAGE_SERVER,
  GIS_SERVICE_TYPES.SCENE_SERVER,
  GIS_SERVICE_TYPES.GENERIC_ARCGIS_REST,
] as string[]).includes(String(inferServiceType(service)));

export const getServiceKindLabel = (service: GisServiceInput): string => ({
  MapServer: 'ArcGIS MapServer',
  FeatureServer: 'ArcGIS FeatureServer',
  VectorTileServer: 'ArcGIS VectorTileServer',
  ImageServer: 'ArcGIS ImageServer',
  SceneServer: 'ArcGIS SceneServer',
  '3DTiles': '3D Tiles',
  GLTF: 'glTF / GLB',
  Elevation: 'Elevation',
} as Record<string, string>)[String(inferServiceType(service))] || 'ArcGIS REST';

const normalizeOpacity = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 1;
};

const normalizeScale = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
};

export const sanitizeService = (service: GisServiceInput = {}): SanitizedGisService => {
  const inferredType = inferServiceType(service);
  if (isDisallowedServiceType(String(inferredType))) {
    throw new Error(`Service type ${inferredType} is not supported by the GIS engine.`);
  }

  const type = inferredType as GisServiceType;
  const safe: SanitizedGisService = {
    id: String(service.id ?? '').trim(),
    title: String(service.title ?? service.name ?? service.id ?? 'GIS Layer').trim(),
    type,
    url: normalizeServiceUrl(service.url),
    enabled: service.enabled !== false,
    opacity: normalizeOpacity(service.opacity),
    minScale: normalizeScale(service.minScale),
    maxScale: normalizeScale(service.maxScale),
    visible: service.visible !== false,
    sublayerId: Number.isInteger(service.sublayerId) ? Number(service.sublayerId) : null,
    proxy: service.proxy === true,
    metadata: { ...(service.metadata || {}) },
  };

  if (!safe.id) throw new Error('GIS service id is required.');
  if (!safe.url) throw new Error(`GIS service ${safe.id} has no URL.`);
  return safe;
};

export const sanitizeCatalog = (services: readonly GisServiceInput[] = []): SanitizedGisService[] => {
  const seen = new Set<string>();
  const result: SanitizedGisService[] = [];

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

export const indexCatalog = (services: readonly GisServiceInput[] = []): Map<string, SanitizedGisService> => new Map(
  sanitizeCatalog(services).map((service) => [service.id, service]),
);

export const mergeCatalog = (
  base: readonly GisServiceInput[] = [],
  incoming: readonly GisServiceInput[] = [],
): SanitizedGisService[] => {
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

export const selectOperationalServices = (
  services: readonly GisServiceInput[] = [],
): SanitizedGisService[] => sanitizeCatalog(services)
  .filter((service) => service.enabled && service.visible);

export const toRuntimeLayerOptions = (service: GisServiceInput): SanitizedGisService => sanitizeService(service);

export const hasSameOrigin = (url: unknown): boolean => {
  if (!url) return false;
  try {
    return new URL(String(url), browserOrigin()).origin === browserOrigin();
  } catch (_) {
    return false;
  }
};

export interface NetworkPolicyOptions {
  allowSameOrigin?: boolean;
  allowConfiguredRemote?: boolean;
  allowProxy?: boolean;
}

export const enforceNetworkPolicy = (
  service: GisServiceInput,
  {
    allowSameOrigin = true,
    allowConfiguredRemote = false,
    allowProxy = true,
  }: NetworkPolicyOptions = {},
): boolean => {
  const safe = sanitizeService(service);
  if (hasSameOrigin(safe.url)) return true;
  if (safe.proxy && allowProxy) return true;
  if (allowConfiguredRemote) return true;
  if (allowSameOrigin) {
    throw new Error(`Remote GIS endpoint is blocked until server/proxy policy allows ${safe.id}.`);
  }
  return false;
};
