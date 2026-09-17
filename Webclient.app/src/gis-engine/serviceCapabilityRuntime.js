export const ARCGIS_RESOURCE_KIND = Object.freeze({
  FEATURE_LAYER: 'feature-layer',
  MAP_LAYER: 'map-layer',
  MAP_SERVICE: 'map-service',
  FEATURE_SERVICE: 'feature-service',
  IMAGE_SERVICE: 'image-service',
  SCENE_SERVICE: 'scene-service',
  VECTOR_TILE_SERVICE: 'vector-tile-service',
  UNKNOWN: 'unknown',
});

export const ARCGIS_QUERY_CAPABILITY = Object.freeze({
  QUERY: 'query',
  PAGINATION: 'pagination',
  ORDER_BY: 'order-by',
  STATISTICS: 'statistics',
  DISTINCT: 'distinct',
  EXTENT: 'extent',
  CENTROID: 'centroid',
  QUANTIZATION: 'quantization',
});

export class ArcGisCapabilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ArcGisCapabilityError';
    this.code = details.code || 'ARCGIS_CAPABILITY_ERROR';
    this.resourceUrl = details.resourceUrl || null;
  }
}

const FORBIDDEN_PROTOCOL_PATTERN = /(?:\/|\b)(?:wms|wfs)(?:\/|\b|\?)/i;
const OGC_SERVICE_PATTERN = /[?&]service=(?:wms|wfs)(?:&|$)/i;

const finite = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (value, fallback = null) => {
  const numeric = finite(value);
  return numeric !== null && numeric > 0 ? Math.floor(numeric) : fallback;
};

const uniqueStrings = (values = []) => [...new Set(
  values
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map((value) => String(value).trim()),
)];

const normalizeUrl = (url) => String(url || '').trim().replace(/\/+$/, '');

export const assertAllowedArcGisResourceUrl = (url) => {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  if (FORBIDDEN_PROTOCOL_PATTERN.test(normalized) || OGC_SERVICE_PATTERN.test(normalized)) {
    throw new ArcGisCapabilityError('WMS/WFS resources are not allowed by the Kent Rehberi GIS contract.', {
      code: 'FORBIDDEN_OGC_RESOURCE',
      resourceUrl: normalized,
    });
  }
  const lower = normalized.toLowerCase();
  const arcGisMarkers = [
    '/mapserver',
    '/featureserver',
    '/imageserver',
    '/sceneserver',
    '/vectortileserver',
  ];
  if (!arcGisMarkers.some((marker) => lower.includes(marker))) {
    throw new ArcGisCapabilityError('Resource URL is not a recognized ArcGIS REST service path.', {
      code: 'UNSUPPORTED_RESOURCE_URL',
      resourceUrl: normalized,
    });
  }
  return normalized;
};

const resourceKindFromUrl = (url) => {
  const normalized = normalizeUrl(url).toLowerCase();
  if (!normalized) return ARCGIS_RESOURCE_KIND.UNKNOWN;
  if (/\/featureserver\/\d+$/.test(normalized)) return ARCGIS_RESOURCE_KIND.FEATURE_LAYER;
  if (/\/mapserver\/\d+$/.test(normalized)) return ARCGIS_RESOURCE_KIND.MAP_LAYER;
  if (normalized.endsWith('/featureserver')) return ARCGIS_RESOURCE_KIND.FEATURE_SERVICE;
  if (normalized.endsWith('/mapserver')) return ARCGIS_RESOURCE_KIND.MAP_SERVICE;
  if (normalized.endsWith('/imageserver')) return ARCGIS_RESOURCE_KIND.IMAGE_SERVICE;
  if (normalized.endsWith('/sceneserver')) return ARCGIS_RESOURCE_KIND.SCENE_SERVICE;
  if (normalized.endsWith('/vectortileserver')) return ARCGIS_RESOURCE_KIND.VECTOR_TILE_SERVICE;
  return ARCGIS_RESOURCE_KIND.UNKNOWN;
};

const resourceKindFromMetadata = (metadata = {}) => {
  const type = String(metadata.type || metadata.layerType || metadata.serviceType || '').toLowerCase();
  if (type.includes('feature layer')) return ARCGIS_RESOURCE_KIND.FEATURE_LAYER;
  if (type.includes('group layer') || type.includes('raster layer') || type.includes('map layer')) {
    return ARCGIS_RESOURCE_KIND.MAP_LAYER;
  }
  if (type.includes('feature service')) return ARCGIS_RESOURCE_KIND.FEATURE_SERVICE;
  if (type.includes('map service')) return ARCGIS_RESOURCE_KIND.MAP_SERVICE;
  if (type.includes('image service') || metadata.pixelType) return ARCGIS_RESOURCE_KIND.IMAGE_SERVICE;
  if (type.includes('scene') || metadata.store || metadata.nodePages) return ARCGIS_RESOURCE_KIND.SCENE_SERVICE;
  if (type.includes('vector tile') || metadata.tileInfo?.format === 'pbf') return ARCGIS_RESOURCE_KIND.VECTOR_TILE_SERVICE;
  if (metadata.geometryType && metadata.fields) return ARCGIS_RESOURCE_KIND.FEATURE_LAYER;
  return ARCGIS_RESOURCE_KIND.UNKNOWN;
};

export const classifyArcGisResource = ({ url, metadata = {} } = {}) => {
  const byUrl = resourceKindFromUrl(url);
  const byMetadata = resourceKindFromMetadata(metadata);
  if (byMetadata !== ARCGIS_RESOURCE_KIND.UNKNOWN) return byMetadata;
  return byUrl;
};

const normalizeSpatialReference = (metadata = {}) => {
  const spatialReference = metadata.extent?.spatialReference || metadata.fullExtent?.spatialReference || metadata.spatialReference;
  const wkid = positiveInteger(spatialReference?.latestWkid ?? spatialReference?.wkid);
  if (wkid) return { wkid };
  if (typeof spatialReference?.wkt === 'string' && spatialReference.wkt.trim()) {
    return { wkt: spatialReference.wkt.trim() };
  }
  return null;
};

const normalizeGeometryType = (value) => {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('multipoint')) return 'multipoint';
  if (normalized.includes('point')) return 'point';
  if (normalized.includes('polyline')) return 'polyline';
  if (normalized.includes('polygon')) return 'polygon';
  if (normalized.includes('envelope') || normalized.includes('extent')) return 'extent';
  return null;
};

const parseCapabilityTokens = (value) => uniqueStrings(String(value || '').split(',').map((item) => item.trim().toLowerCase()));

const hasCapabilityToken = (metadata, token) => parseCapabilityTokens(metadata.capabilities).includes(String(token).toLowerCase());

const advancedQuery = (metadata = {}) => metadata.advancedQueryCapabilities || metadata.advancedQueryCapabilitiesV2 || {};

const queryCapabilitySet = (metadata = {}) => {
  const advanced = advancedQuery(metadata);
  const values = new Set();
  if (hasCapabilityToken(metadata, 'query') || metadata.geometryType || metadata.fields) values.add(ARCGIS_QUERY_CAPABILITY.QUERY);
  if (advanced.supportsPagination === true || metadata.supportsPagination === true) values.add(ARCGIS_QUERY_CAPABILITY.PAGINATION);
  if (advanced.supportsOrderBy === true || metadata.supportsOrderBy === true) values.add(ARCGIS_QUERY_CAPABILITY.ORDER_BY);
  if (advanced.supportsStatistics === true || metadata.supportsStatistics === true) values.add(ARCGIS_QUERY_CAPABILITY.STATISTICS);
  if (advanced.supportsDistinct === true || advanced.supportsDistinctValues === true) values.add(ARCGIS_QUERY_CAPABILITY.DISTINCT);
  if (advanced.supportsReturningQueryExtent === true || metadata.supportsReturningQueryExtent === true) values.add(ARCGIS_QUERY_CAPABILITY.EXTENT);
  if (advanced.supportsReturningGeometryCentroid === true) values.add(ARCGIS_QUERY_CAPABILITY.CENTROID);
  if (advanced.supportsQuantization === true) values.add(ARCGIS_QUERY_CAPABILITY.QUANTIZATION);
  return [...values];
};

const objectIdField = (metadata = {}) => {
  const direct = metadata.objectIdField || metadata.objectIdFieldName;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const field = (metadata.fields || []).find((candidate) => (
    candidate?.type === 'esriFieldTypeOID' || candidate?.type === 'oid'
  ));
  return typeof field?.name === 'string' ? field.name.trim() : null;
};

const globalIdField = (metadata = {}) => {
  const direct = metadata.globalIdField || metadata.globalIdFieldName;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const field = (metadata.fields || []).find((candidate) => candidate?.type === 'esriFieldTypeGlobalID');
  return typeof field?.name === 'string' ? field.name.trim() : null;
};

const timeInfo = (metadata = {}) => {
  const info = metadata.timeInfo;
  if (!info || typeof info !== 'object') return null;
  const startField = typeof info.startTimeField === 'string' ? info.startTimeField : null;
  const endField = typeof info.endTimeField === 'string' ? info.endTimeField : null;
  const trackIdField = typeof info.trackIdField === 'string' ? info.trackIdField : null;
  const defaultTimeInterval = finite(info.defaultTimeInterval);
  const defaultTimeIntervalUnits = typeof info.defaultTimeIntervalUnits === 'string'
    ? info.defaultTimeIntervalUnits
    : null;
  return {
    startField,
    endField,
    trackIdField,
    defaultTimeInterval,
    defaultTimeIntervalUnits,
    hasTime: Boolean(startField || endField),
  };
};

const editingCapabilities = (metadata = {}) => {
  const capabilities = parseCapabilityTokens(metadata.capabilities);
  return {
    create: capabilities.includes('create'),
    update: capabilities.includes('update'),
    delete: capabilities.includes('delete'),
    editing: capabilities.some((value) => ['create', 'update', 'delete', 'editing'].includes(value)),
    sync: capabilities.includes('sync'),
  };
};

const drawingInfo = (metadata = {}) => {
  const info = metadata.drawingInfo;
  if (!info || typeof info !== 'object') return null;
  return {
    hasRenderer: Boolean(info.renderer),
    rendererType: info.renderer?.type || null,
    hasLabeling: Array.isArray(info.labelingInfo) && info.labelingInfo.length > 0,
    transparency: finite(info.transparency, null),
  };
};

const normalizeScale = (value) => {
  const numeric = finite(value, 0);
  return numeric !== null && numeric >= 0 ? numeric : 0;
};

const sublayerSummary = (metadata = {}) => uniqueStrings([
  ...(metadata.layers || []).map((layer) => layer?.id),
  ...(metadata.tables || []).map((table) => table?.id),
]);

/**
 * @param {{
 *   url?: string | null,
 *   metadata?: Record<string, any>,
 *   serviceId?: string | null,
 *   allowUnknownUrl?: boolean
 * }} [options]
 */
export const buildArcGisCapabilityContract = ({
  url = null,
  metadata = {},
  serviceId = null,
  allowUnknownUrl = false,
} = {}) => {
  let resourceUrl = null;
  if (url) {
    try {
      resourceUrl = assertAllowedArcGisResourceUrl(url);
    } catch (error) {
      if (!allowUnknownUrl || error.code === 'FORBIDDEN_OGC_RESOURCE') throw error;
      resourceUrl = normalizeUrl(url);
    }
  }

  const resourceKind = classifyArcGisResource({ url: resourceUrl, metadata });
  const queryCapabilities = queryCapabilitySet(metadata);
  const maxRecordCount = positiveInteger(metadata.maxRecordCount, null);
  const maxRecordCountFactor = positiveInteger(metadata.maxRecordCountFactor, null);
  const oidField = objectIdField(metadata);
  const spatialReference = normalizeSpatialReference(metadata);
  const editing = editingCapabilities(metadata);

  return Object.freeze({
    serviceId: serviceId == null ? null : String(serviceId),
    resourceUrl,
    resourceKind,
    name: String(metadata.name || metadata.mapName || metadata.serviceDescription || '').trim() || null,
    displayField: typeof metadata.displayField === 'string' ? metadata.displayField : null,
    geometryType: normalizeGeometryType(metadata.geometryType),
    spatialReference,
    objectIdField: oidField,
    globalIdField: globalIdField(metadata),
    maxRecordCount,
    maxRecordCountFactor,
    minScale: normalizeScale(metadata.minScale),
    maxScale: normalizeScale(metadata.maxScale),
    queryCapabilities: Object.freeze(queryCapabilities),
    supportsQuery: queryCapabilities.includes(ARCGIS_QUERY_CAPABILITY.QUERY),
    supportsPagination: queryCapabilities.includes(ARCGIS_QUERY_CAPABILITY.PAGINATION),
    supportsStatistics: queryCapabilities.includes(ARCGIS_QUERY_CAPABILITY.STATISTICS),
    supportsOrderBy: queryCapabilities.includes(ARCGIS_QUERY_CAPABILITY.ORDER_BY),
    supportsAttachments: metadata.hasAttachments === true,
    supportsM: metadata.hasM === true,
    supportsZ: metadata.hasZ === true,
    time: timeInfo(metadata),
    editing: Object.freeze(editing),
    drawing: drawingInfo(metadata),
    sublayerIds: Object.freeze(sublayerSummary(metadata)),
    fields: Object.freeze((metadata.fields || []).filter(Boolean).map((field) => Object.freeze({
      name: String(field.name || ''),
      alias: String(field.alias || field.name || ''),
      type: String(field.type || ''),
      nullable: field.nullable !== false,
      editable: field.editable !== false,
      length: positiveInteger(field.length, null),
      domainType: field.domain?.type || null,
    }))),
  });
};

export const capabilityContractToPaginationMetadata = (contract = {}) => ({
  maxRecordCount: contract.maxRecordCount,
  objectIdField: contract.objectIdField,
  advancedQueryCapabilities: {
    supportsPagination: contract.supportsPagination === true,
    supportsOrderBy: contract.supportsOrderBy === true,
    supportsStatistics: contract.supportsStatistics === true,
    supportsReturningQueryExtent: (contract.queryCapabilities || []).includes(ARCGIS_QUERY_CAPABILITY.EXTENT),
  },
  fields: contract.fields,
});

export const assessCapabilityContract = (contract = {}) => {
  const issues = [];
  if (contract.resourceKind === ARCGIS_RESOURCE_KIND.UNKNOWN) issues.push('unknown-resource-kind');
  if (contract.supportsQuery && !contract.maxRecordCount) issues.push('missing-max-record-count');
  if (contract.supportsPagination && !contract.objectIdField && !contract.supportsOrderBy) {
    issues.push('pagination-without-stable-identity');
  }
  if (contract.geometryType && !contract.spatialReference) issues.push('missing-spatial-reference');
  if (contract.editing?.editing && !contract.objectIdField && !contract.globalIdField) {
    issues.push('editing-without-stable-identity');
  }
  return Object.freeze({
    valid: issues.length === 0,
    issues: Object.freeze(issues),
    queryReady: Boolean(contract.supportsQuery && contract.maxRecordCount),
    stableIdentity: Boolean(contract.objectIdField || contract.globalIdField),
  });
};

export const selectCapabilityFields = (contract = {}, requested = []) => {
  const known = new Set((contract.fields || []).map((field) => field.name));
  return uniqueStrings(requested).filter((field) => known.has(field));
};
