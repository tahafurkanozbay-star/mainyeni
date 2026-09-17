export const ARCGIS_RESOURCE_KIND = Object.freeze({
  FEATURE_LAYER: 'feature-layer',
  MAP_LAYER: 'map-layer',
  MAP_SERVICE: 'map-service',
  FEATURE_SERVICE: 'feature-service',
  IMAGE_SERVICE: 'image-service',
  SCENE_SERVICE: 'scene-service',
  VECTOR_TILE_SERVICE: 'vector-tile-service',
  UNKNOWN: 'unknown',
} as const);

export type ArcGisResourceKind = typeof ARCGIS_RESOURCE_KIND[keyof typeof ARCGIS_RESOURCE_KIND];

export const ARCGIS_QUERY_CAPABILITY = Object.freeze({
  QUERY: 'query',
  PAGINATION: 'pagination',
  ORDER_BY: 'order-by',
  STATISTICS: 'statistics',
  DISTINCT: 'distinct',
  EXTENT: 'extent',
  CENTROID: 'centroid',
  QUANTIZATION: 'quantization',
} as const);

export type ArcGisQueryCapability = typeof ARCGIS_QUERY_CAPABILITY[keyof typeof ARCGIS_QUERY_CAPABILITY];

type JsonRecord = Record<string, unknown>;

export interface ArcGisCapabilityErrorDetails {
  readonly code?: string;
  readonly resourceUrl?: string | null;
}

export class ArcGisCapabilityError extends Error {
  readonly code: string;
  readonly resourceUrl: string | null;

  constructor(message: string, details: ArcGisCapabilityErrorDetails = {}) {
    super(message);
    this.name = 'ArcGisCapabilityError';
    this.code = details.code || 'ARCGIS_CAPABILITY_ERROR';
    this.resourceUrl = details.resourceUrl ?? null;
  }
}

export interface ArcGisSpatialReferenceContract {
  readonly wkid?: number;
  readonly wkt?: string;
}

export interface ArcGisTimeContract {
  readonly startField: string | null;
  readonly endField: string | null;
  readonly trackIdField: string | null;
  readonly defaultTimeInterval: number | null;
  readonly defaultTimeIntervalUnits: string | null;
  readonly hasTime: boolean;
}

export interface ArcGisEditingContract {
  readonly create: boolean;
  readonly update: boolean;
  readonly delete: boolean;
  readonly editing: boolean;
  readonly sync: boolean;
}

export interface ArcGisDrawingContract {
  readonly hasRenderer: boolean;
  readonly rendererType: string | null;
  readonly hasLabeling: boolean;
  readonly transparency: number | null;
}

export interface ArcGisFieldContract {
  readonly name: string;
  readonly alias: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly editable: boolean;
  readonly length: number | null;
  readonly domainType: string | null;
}

export interface ArcGisCapabilityContract {
  readonly serviceId: string | null;
  readonly resourceUrl: string | null;
  readonly resourceKind: ArcGisResourceKind;
  readonly name: string | null;
  readonly displayField: string | null;
  readonly geometryType: 'point' | 'multipoint' | 'polyline' | 'polygon' | 'extent' | null;
  readonly spatialReference: ArcGisSpatialReferenceContract | null;
  readonly objectIdField: string | null;
  readonly globalIdField: string | null;
  readonly maxRecordCount: number | null;
  readonly maxRecordCountFactor: number | null;
  readonly minScale: number;
  readonly maxScale: number;
  readonly queryCapabilities: readonly ArcGisQueryCapability[];
  readonly supportsQuery: boolean;
  readonly supportsPagination: boolean;
  readonly supportsStatistics: boolean;
  readonly supportsOrderBy: boolean;
  readonly supportsAttachments: boolean;
  readonly supportsM: boolean;
  readonly supportsZ: boolean;
  readonly time: ArcGisTimeContract | null;
  readonly editing: ArcGisEditingContract;
  readonly drawing: ArcGisDrawingContract | null;
  readonly sublayerIds: readonly string[];
  readonly fields: readonly ArcGisFieldContract[];
}

export interface BuildArcGisCapabilityContractInput {
  readonly url?: unknown;
  readonly metadata?: JsonRecord;
  readonly serviceId?: unknown;
  readonly allowUnknownUrl?: boolean;
}

export interface ArcGisCapabilityAssessment {
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly queryReady: boolean;
  readonly stableIdentity: boolean;
}

export interface ArcGisPaginationMetadata {
  readonly maxRecordCount: number | null;
  readonly objectIdField: string | null;
  readonly advancedQueryCapabilities: Readonly<{
    supportsPagination: boolean;
    supportsOrderBy: boolean;
    supportsStatistics: boolean;
    supportsReturningQueryExtent: boolean;
  }>;
  readonly fields: readonly ArcGisFieldContract[];
}

const FORBIDDEN_PROTOCOL_PATTERN = /(?:\/|\b)(?:wms|wfs)(?:\/|\b|\?)/i;
const OGC_SERVICE_PATTERN = /[?&]service=(?:wms|wfs)(?:&|$)/i;
const MAX_SERVICE_URL_LENGTH = 8192;
const MAX_FIELD_COUNT = 10000;
const MAX_SUBLAYER_COUNT = 10000;

const asRecord = (value: unknown): JsonRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
);

const asArray = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];

const stringValue = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const finite = (value: unknown, fallback: number | null = null): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (value: unknown, fallback: number | null = null): number | null => {
  const numeric = finite(value);
  return numeric !== null && numeric > 0 ? Math.floor(numeric) : fallback;
};

const uniqueStrings = (values: readonly unknown[] = []): string[] => [...new Set(
  values
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map((value) => String(value).trim()),
)];

const normalizeUrl = (url: unknown): string => String(url ?? '').trim().replace(/\/+$/, '');

const fieldRecords = (metadata: JsonRecord): JsonRecord[] => asArray(metadata.fields)
  .slice(0, MAX_FIELD_COUNT)
  .map(asRecord)
  .filter((field) => Object.keys(field).length > 0);

export const assertAllowedArcGisResourceUrl = (url: unknown): string | null => {
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  if (normalized.length > MAX_SERVICE_URL_LENGTH) {
    throw new ArcGisCapabilityError('ArcGIS resource URL exceeds the bounded length.', {
      code: 'RESOURCE_URL_TOO_LONG',
      resourceUrl: normalized.slice(0, 512),
    });
  }
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

const resourceKindFromUrl = (url: unknown): ArcGisResourceKind => {
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

const resourceKindFromMetadata = (metadata: JsonRecord): ArcGisResourceKind => {
  const type = String(metadata.type ?? metadata.layerType ?? metadata.serviceType ?? '').toLowerCase();
  if (type.includes('feature layer')) return ARCGIS_RESOURCE_KIND.FEATURE_LAYER;
  if (type.includes('group layer') || type.includes('raster layer') || type.includes('map layer')) {
    return ARCGIS_RESOURCE_KIND.MAP_LAYER;
  }
  if (type.includes('feature service')) return ARCGIS_RESOURCE_KIND.FEATURE_SERVICE;
  if (type.includes('map service')) return ARCGIS_RESOURCE_KIND.MAP_SERVICE;
  if (type.includes('image service') || metadata.pixelType !== undefined) return ARCGIS_RESOURCE_KIND.IMAGE_SERVICE;
  if (type.includes('scene') || metadata.store !== undefined || metadata.nodePages !== undefined) {
    return ARCGIS_RESOURCE_KIND.SCENE_SERVICE;
  }
  const tileInfo = asRecord(metadata.tileInfo);
  if (type.includes('vector tile') || String(tileInfo.format ?? '').toLowerCase() === 'pbf') {
    return ARCGIS_RESOURCE_KIND.VECTOR_TILE_SERVICE;
  }
  if (metadata.geometryType !== undefined && Array.isArray(metadata.fields)) {
    return ARCGIS_RESOURCE_KIND.FEATURE_LAYER;
  }
  return ARCGIS_RESOURCE_KIND.UNKNOWN;
};

export const classifyArcGisResource = ({
  url,
  metadata = {},
}: {
  readonly url?: unknown;
  readonly metadata?: JsonRecord;
} = {}): ArcGisResourceKind => {
  const byUrl = resourceKindFromUrl(url);
  const byMetadata = resourceKindFromMetadata(metadata);
  if (byMetadata !== ARCGIS_RESOURCE_KIND.UNKNOWN) return byMetadata;
  return byUrl;
};

const normalizeSpatialReference = (metadata: JsonRecord): ArcGisSpatialReferenceContract | null => {
  const extent = asRecord(metadata.extent);
  const fullExtent = asRecord(metadata.fullExtent);
  const spatialReference = asRecord(
    extent.spatialReference ?? fullExtent.spatialReference ?? metadata.spatialReference,
  );
  const wkid = positiveInteger(spatialReference.latestWkid ?? spatialReference.wkid);
  if (wkid) return Object.freeze({ wkid });
  const wkt = stringValue(spatialReference.wkt);
  return wkt ? Object.freeze({ wkt }) : null;
};

const normalizeGeometryType = (
  value: unknown,
): ArcGisCapabilityContract['geometryType'] => {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized.includes('multipoint')) return 'multipoint';
  if (normalized.includes('point')) return 'point';
  if (normalized.includes('polyline')) return 'polyline';
  if (normalized.includes('polygon')) return 'polygon';
  if (normalized.includes('envelope') || normalized.includes('extent')) return 'extent';
  return null;
};

const parseCapabilityTokens = (value: unknown): string[] => uniqueStrings(
  String(value ?? '').split(',').map((item) => item.trim().toLowerCase()),
);

const hasCapabilityToken = (metadata: JsonRecord, token: string): boolean => (
  parseCapabilityTokens(metadata.capabilities).includes(token.toLowerCase())
);

const advancedQuery = (metadata: JsonRecord): JsonRecord => asRecord(
  metadata.advancedQueryCapabilities ?? metadata.advancedQueryCapabilitiesV2,
);

const queryCapabilitySet = (metadata: JsonRecord): ArcGisQueryCapability[] => {
  const advanced = advancedQuery(metadata);
  const values = new Set<ArcGisQueryCapability>();
  if (hasCapabilityToken(metadata, 'query') || metadata.geometryType !== undefined || Array.isArray(metadata.fields)) {
    values.add(ARCGIS_QUERY_CAPABILITY.QUERY);
  }
  if (advanced.supportsPagination === true || metadata.supportsPagination === true) {
    values.add(ARCGIS_QUERY_CAPABILITY.PAGINATION);
  }
  if (advanced.supportsOrderBy === true || metadata.supportsOrderBy === true) {
    values.add(ARCGIS_QUERY_CAPABILITY.ORDER_BY);
  }
  if (advanced.supportsStatistics === true || metadata.supportsStatistics === true) {
    values.add(ARCGIS_QUERY_CAPABILITY.STATISTICS);
  }
  if (advanced.supportsDistinct === true || advanced.supportsDistinctValues === true) {
    values.add(ARCGIS_QUERY_CAPABILITY.DISTINCT);
  }
  if (advanced.supportsReturningQueryExtent === true || metadata.supportsReturningQueryExtent === true) {
    values.add(ARCGIS_QUERY_CAPABILITY.EXTENT);
  }
  if (advanced.supportsReturningGeometryCentroid === true) {
    values.add(ARCGIS_QUERY_CAPABILITY.CENTROID);
  }
  if (advanced.supportsQuantization === true) values.add(ARCGIS_QUERY_CAPABILITY.QUANTIZATION);
  return [...values];
};

const objectIdField = (metadata: JsonRecord): string | null => {
  const direct = stringValue(metadata.objectIdField ?? metadata.objectIdFieldName);
  if (direct) return direct;
  const field = fieldRecords(metadata).find((candidate) => (
    candidate.type === 'esriFieldTypeOID' || candidate.type === 'oid'
  ));
  return field ? stringValue(field.name) : null;
};

const globalIdField = (metadata: JsonRecord): string | null => {
  const direct = stringValue(metadata.globalIdField ?? metadata.globalIdFieldName);
  if (direct) return direct;
  const field = fieldRecords(metadata).find((candidate) => candidate.type === 'esriFieldTypeGlobalID');
  return field ? stringValue(field.name) : null;
};

const timeInfo = (metadata: JsonRecord): ArcGisTimeContract | null => {
  if (metadata.timeInfo === null || typeof metadata.timeInfo !== 'object') return null;
  const info = asRecord(metadata.timeInfo);
  const startField = stringValue(info.startTimeField);
  const endField = stringValue(info.endTimeField);
  const trackIdField = stringValue(info.trackIdField);
  const defaultTimeInterval = finite(info.defaultTimeInterval);
  const defaultTimeIntervalUnits = stringValue(info.defaultTimeIntervalUnits);
  return Object.freeze({
    startField,
    endField,
    trackIdField,
    defaultTimeInterval,
    defaultTimeIntervalUnits,
    hasTime: Boolean(startField || endField),
  });
};

const editingCapabilities = (metadata: JsonRecord): ArcGisEditingContract => {
  const capabilities = parseCapabilityTokens(metadata.capabilities);
  return Object.freeze({
    create: capabilities.includes('create'),
    update: capabilities.includes('update'),
    delete: capabilities.includes('delete'),
    editing: capabilities.some((value) => ['create', 'update', 'delete', 'editing'].includes(value)),
    sync: capabilities.includes('sync'),
  });
};

const drawingInfo = (metadata: JsonRecord): ArcGisDrawingContract | null => {
  if (metadata.drawingInfo === null || typeof metadata.drawingInfo !== 'object') return null;
  const info = asRecord(metadata.drawingInfo);
  const renderer = asRecord(info.renderer);
  return Object.freeze({
    hasRenderer: Object.keys(renderer).length > 0,
    rendererType: stringValue(renderer.type),
    hasLabeling: Array.isArray(info.labelingInfo) && info.labelingInfo.length > 0,
    transparency: finite(info.transparency),
  });
};

const normalizeScale = (value: unknown): number => {
  const numeric = finite(value, 0);
  return numeric !== null && numeric >= 0 ? numeric : 0;
};

const sublayerSummary = (metadata: JsonRecord): string[] => {
  const layerIds = asArray(metadata.layers)
    .slice(0, MAX_SUBLAYER_COUNT)
    .map((layer) => asRecord(layer).id);
  const remaining = Math.max(0, MAX_SUBLAYER_COUNT - layerIds.length);
  const tableIds = asArray(metadata.tables)
    .slice(0, remaining)
    .map((table) => asRecord(table).id);
  return uniqueStrings([...layerIds, ...tableIds]);
};

const normalizeFields = (metadata: JsonRecord): readonly ArcGisFieldContract[] => Object.freeze(
  fieldRecords(metadata).map((field) => Object.freeze({
    name: String(field.name ?? ''),
    alias: String(field.alias ?? field.name ?? ''),
    type: String(field.type ?? ''),
    nullable: field.nullable !== false,
    editable: field.editable !== false,
    length: positiveInteger(field.length),
    domainType: stringValue(asRecord(field.domain).type),
  })),
);

export const buildArcGisCapabilityContract = ({
  url = null,
  metadata = {},
  serviceId = null,
  allowUnknownUrl = false,
}: BuildArcGisCapabilityContractInput = {}): ArcGisCapabilityContract => {
  let resourceUrl: string | null = null;
  if (url) {
    try {
      resourceUrl = assertAllowedArcGisResourceUrl(url);
    } catch (error: unknown) {
      if (!(error instanceof ArcGisCapabilityError)) throw error;
      if (!allowUnknownUrl || error.code === 'FORBIDDEN_OGC_RESOURCE') throw error;
      resourceUrl = normalizeUrl(url);
    }
  }

  const resourceKind = classifyArcGisResource({ url: resourceUrl, metadata });
  const queryCapabilities = Object.freeze(queryCapabilitySet(metadata));
  const maxRecordCount = positiveInteger(metadata.maxRecordCount);
  const maxRecordCountFactor = positiveInteger(metadata.maxRecordCountFactor);
  const oidField = objectIdField(metadata);
  const spatialReference = normalizeSpatialReference(metadata);
  const editing = editingCapabilities(metadata);
  const name = stringValue(metadata.name ?? metadata.mapName ?? metadata.serviceDescription);
  const displayField = stringValue(metadata.displayField);

  return Object.freeze({
    serviceId: serviceId == null ? null : String(serviceId),
    resourceUrl,
    resourceKind,
    name,
    displayField,
    geometryType: normalizeGeometryType(metadata.geometryType),
    spatialReference,
    objectIdField: oidField,
    globalIdField: globalIdField(metadata),
    maxRecordCount,
    maxRecordCountFactor,
    minScale: normalizeScale(metadata.minScale),
    maxScale: normalizeScale(metadata.maxScale),
    queryCapabilities,
    supportsQuery: queryCapabilities.includes(ARCGIS_QUERY_CAPABILITY.QUERY),
    supportsPagination: queryCapabilities.includes(ARCGIS_QUERY_CAPABILITY.PAGINATION),
    supportsStatistics: queryCapabilities.includes(ARCGIS_QUERY_CAPABILITY.STATISTICS),
    supportsOrderBy: queryCapabilities.includes(ARCGIS_QUERY_CAPABILITY.ORDER_BY),
    supportsAttachments: metadata.hasAttachments === true,
    supportsM: metadata.hasM === true,
    supportsZ: metadata.hasZ === true,
    time: timeInfo(metadata),
    editing,
    drawing: drawingInfo(metadata),
    sublayerIds: Object.freeze(sublayerSummary(metadata)),
    fields: normalizeFields(metadata),
  });
};

export const capabilityContractToPaginationMetadata = (
  contract: Partial<ArcGisCapabilityContract> = {},
): ArcGisPaginationMetadata => {
  const queryCapabilities = contract.queryCapabilities ?? [];
  return Object.freeze({
    maxRecordCount: contract.maxRecordCount ?? null,
    objectIdField: contract.objectIdField ?? null,
    advancedQueryCapabilities: Object.freeze({
      supportsPagination: contract.supportsPagination === true,
      supportsOrderBy: contract.supportsOrderBy === true,
      supportsStatistics: contract.supportsStatistics === true,
      supportsReturningQueryExtent: queryCapabilities.includes(ARCGIS_QUERY_CAPABILITY.EXTENT),
    }),
    fields: contract.fields ?? Object.freeze([]),
  });
};

export const assessCapabilityContract = (
  contract: Partial<ArcGisCapabilityContract> = {},
): ArcGisCapabilityAssessment => {
  const issues: string[] = [];
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

export const selectCapabilityFields = (
  contract: Partial<ArcGisCapabilityContract> = {},
  requested: readonly unknown[] = [],
): string[] => {
  const known = new Set((contract.fields ?? []).map((field) => field.name));
  return uniqueStrings(requested).filter((field) => known.has(field));
};
