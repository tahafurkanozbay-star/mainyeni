export type ArcGisServiceKind = 'map-server' | 'feature-server' | 'scene-server' | 'image-server' | 'unknown';
export type ArcGisGeometryType = 'point' | 'multipoint' | 'polyline' | 'polygon' | 'mesh' | 'unknown';

export interface ArcGisSpatialReferenceLike {
  wkid?: number;
  latestWkid?: number;
  wkt?: string;
}

export interface ArcGisFieldLike {
  name?: string;
  alias?: string;
  type?: string;
  nullable?: boolean;
  editable?: boolean;
  domain?: unknown;
}

export interface ArcGisAdvancedQueryCapabilitiesLike {
  supportsPagination?: boolean;
  supportsOrderBy?: boolean;
  supportsDistinct?: boolean;
  supportsStatistics?: boolean;
  supportsHavingClause?: boolean;
  supportsSqlExpression?: boolean;
  supportsReturningQueryExtent?: boolean;
  supportsQueryWithDistance?: boolean;
}

export interface ArcGisCapabilitiesLike {
  query?: boolean;
  data?: boolean;
  editing?: boolean;
  create?: boolean;
  update?: boolean;
  delete?: boolean;
  sync?: boolean;
}

export interface ArcGisLayerMetadataLike {
  id?: number;
  name?: string;
  type?: string;
  serviceItemId?: string;
  currentVersion?: number;
  geometryType?: string;
  objectIdField?: string;
  globalIdField?: string;
  maxRecordCount?: number;
  supportedQueryFormats?: string;
  supportedImageFormatTypes?: string;
  capabilities?: string | ArcGisCapabilitiesLike;
  advancedQueryCapabilities?: ArcGisAdvancedQueryCapabilitiesLike;
  supportsStatistics?: boolean;
  supportsAdvancedQueries?: boolean;
  hasZ?: boolean;
  hasM?: boolean;
  allowGeometryUpdates?: boolean;
  extent?: { spatialReference?: ArcGisSpatialReferenceLike };
  spatialReference?: ArcGisSpatialReferenceLike;
  fields?: ArcGisFieldLike[];
  drawingInfo?: unknown;
  timeInfo?: unknown;
  relationships?: unknown[];
  indexes?: unknown[];
}

export interface ArcGisServiceCapabilities {
  kind: ArcGisServiceKind;
  geometryType: ArcGisGeometryType;
  name: string;
  objectIdField: string | null;
  globalIdField: string | null;
  maxRecordCount: number;
  spatialReferenceWkid: number | null;
  supportsQuery: boolean;
  supportsPagination: boolean;
  supportsOrderBy: boolean;
  supportsDistinct: boolean;
  supportsStatistics: boolean;
  supportsHavingClause: boolean;
  supportsSqlExpression: boolean;
  supportsReturningQueryExtent: boolean;
  supportsDistanceQuery: boolean;
  supportsCreate: boolean;
  supportsUpdate: boolean;
  supportsDelete: boolean;
  supportsSync: boolean;
  allowsGeometryUpdates: boolean;
  hasZ: boolean;
  hasM: boolean;
  hasTime: boolean;
  fieldNames: readonly string[];
  relationshipCount: number;
  indexCount: number;
  warnings: readonly string[];
}

export interface ArcGisQueryPlanInput {
  where?: string;
  outFields?: readonly string[];
  returnGeometry?: boolean;
  resultOffset?: number;
  resultRecordCount?: number;
  orderByFields?: readonly string[];
  returnDistinctValues?: boolean;
  outStatistics?: readonly unknown[];
  having?: string;
  distance?: number;
  units?: string;
}

export interface ArcGisValidatedQueryPlan {
  params: Readonly<Record<string, string | number | boolean>>;
  warnings: readonly string[];
  pageSize: number;
  paginationEnabled: boolean;
}

const asPositiveInteger = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.floor(numeric));
};

const normalizeText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const normalizeServiceKind = (type: unknown): ArcGisServiceKind => {
  const normalized = normalizeText(type).toLowerCase();
  if (normalized.includes('feature')) return 'feature-server';
  if (normalized.includes('scene')) return 'scene-server';
  if (normalized.includes('image')) return 'image-server';
  if (normalized.includes('map')) return 'map-server';
  return 'unknown';
};

const normalizeGeometryType = (value: unknown): ArcGisGeometryType => {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized.includes('multipoint')) return 'multipoint';
  if (normalized.includes('point')) return 'point';
  if (normalized.includes('polyline') || normalized.includes('line')) return 'polyline';
  if (normalized.includes('polygon')) return 'polygon';
  if (normalized.includes('mesh')) return 'mesh';
  return 'unknown';
};

const capabilityTokens = (capabilities: string | ArcGisCapabilitiesLike | undefined): Set<string> => {
  if (typeof capabilities === 'string') {
    return new Set(capabilities.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  }
  if (!capabilities) return new Set<string>();
  return new Set(Object.entries(capabilities).filter(([, enabled]) => enabled === true).map(([key]) => key.toLowerCase()));
};

const resolveWkid = (metadata: ArcGisLayerMetadataLike): number | null => {
  const spatialReference = metadata.spatialReference ?? metadata.extent?.spatialReference;
  const candidate = spatialReference?.latestWkid ?? spatialReference?.wkid;
  return Number.isFinite(candidate) ? Number(candidate) : null;
};

const bool = (value: unknown): boolean => value === true;

export const deriveArcGisServiceCapabilities = (
  metadata: ArcGisLayerMetadataLike,
): ArcGisServiceCapabilities => {
  const warnings: string[] = [];
  const tokens = capabilityTokens(metadata.capabilities);
  const advanced = metadata.advancedQueryCapabilities ?? {};
  const fields = Array.isArray(metadata.fields) ? metadata.fields : [];
  const fieldNames = fields.map((field) => normalizeText(field.name)).filter(Boolean);
  const objectIdField = normalizeText(metadata.objectIdField) || null;
  const globalIdField = normalizeText(metadata.globalIdField) || null;
  const maxRecordCount = asPositiveInteger(metadata.maxRecordCount, 1_000);
  const kind = normalizeServiceKind(metadata.type);
  const geometryType = normalizeGeometryType(metadata.geometryType);
  const supportsQuery = tokens.has('query') || tokens.has('data') || kind === 'feature-server' || kind === 'map-server';

  if (!objectIdField && supportsQuery) warnings.push('object-id-field-missing');
  if (!metadata.advancedQueryCapabilities && supportsQuery) warnings.push('advanced-query-capabilities-missing');
  if (kind === 'unknown') warnings.push('service-kind-unknown');
  if (geometryType === 'unknown' && supportsQuery) warnings.push('geometry-type-unknown');
  if (!resolveWkid(metadata)) warnings.push('spatial-reference-wkid-missing');

  return Object.freeze({
    kind,
    geometryType,
    name: normalizeText(metadata.name),
    objectIdField,
    globalIdField,
    maxRecordCount,
    spatialReferenceWkid: resolveWkid(metadata),
    supportsQuery,
    supportsPagination: bool(advanced.supportsPagination),
    supportsOrderBy: bool(advanced.supportsOrderBy),
    supportsDistinct: bool(advanced.supportsDistinct),
    supportsStatistics: bool(advanced.supportsStatistics) || bool(metadata.supportsStatistics),
    supportsHavingClause: bool(advanced.supportsHavingClause),
    supportsSqlExpression: bool(advanced.supportsSqlExpression),
    supportsReturningQueryExtent: bool(advanced.supportsReturningQueryExtent),
    supportsDistanceQuery: bool(advanced.supportsQueryWithDistance),
    supportsCreate: tokens.has('create') || tokens.has('editing'),
    supportsUpdate: tokens.has('update') || tokens.has('editing'),
    supportsDelete: tokens.has('delete') || tokens.has('editing'),
    supportsSync: tokens.has('sync'),
    allowsGeometryUpdates: bool(metadata.allowGeometryUpdates),
    hasZ: bool(metadata.hasZ),
    hasM: bool(metadata.hasM),
    hasTime: metadata.timeInfo != null,
    fieldNames: Object.freeze(fieldNames),
    relationshipCount: Array.isArray(metadata.relationships) ? metadata.relationships.length : 0,
    indexCount: Array.isArray(metadata.indexes) ? metadata.indexes.length : 0,
    warnings: Object.freeze(warnings),
  });
};

const sanitizeWhere = (value: unknown): string => {
  const where = normalizeText(value);
  return where || '1=1';
};

const sanitizeOutFields = (
  requested: readonly string[] | undefined,
  capabilities: ArcGisServiceCapabilities,
): string => {
  if (!requested?.length) return '*';
  const allowed = new Set(capabilities.fieldNames.map((field) => field.toLowerCase()));
  const selected = requested
    .map((field) => field.trim())
    .filter(Boolean)
    .filter((field) => allowed.size === 0 || allowed.has(field.toLowerCase()));
  return selected.length ? [...new Set(selected)].join(',') : '*';
};

const sanitizeOrderBy = (
  requested: readonly string[] | undefined,
  capabilities: ArcGisServiceCapabilities,
): string | null => {
  if (!requested?.length || !capabilities.supportsOrderBy) return null;
  const allowed = new Set(capabilities.fieldNames.map((field) => field.toLowerCase()));
  const entries = requested
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(/\s+/);
      const field = parts[0] ?? '';
      const direction = (parts[1] ?? 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      return { field, direction };
    })
    .filter((entry) => allowed.size === 0 || allowed.has(entry.field.toLowerCase()))
    .map((entry) => `${entry.field} ${entry.direction}`);
  return entries.length ? entries.join(',') : null;
};

export const createArcGisValidatedQueryPlan = (
  capabilities: ArcGisServiceCapabilities,
  input: ArcGisQueryPlanInput = {},
): ArcGisValidatedQueryPlan => {
  if (!capabilities.supportsQuery) throw new Error('ArcGIS service does not advertise query capability');

  const warnings: string[] = [];
  const params: Record<string, string | number | boolean> = {
    f: 'json',
    where: sanitizeWhere(input.where),
    outFields: sanitizeOutFields(input.outFields, capabilities),
    returnGeometry: input.returnGeometry !== false,
  };

  const pageSize = Math.min(
    capabilities.maxRecordCount,
    asPositiveInteger(input.resultRecordCount, Math.min(1_000, capabilities.maxRecordCount)),
  );
  params.resultRecordCount = pageSize;

  if (capabilities.supportsPagination) {
    params.resultOffset = Math.max(0, Math.floor(Number(input.resultOffset) || 0));
  } else if ((input.resultOffset ?? 0) > 0) {
    warnings.push('pagination-not-supported');
  }

  const orderBy = sanitizeOrderBy(input.orderByFields, capabilities);
  if (orderBy) params.orderByFields = orderBy;
  else if (input.orderByFields?.length) warnings.push('order-by-not-supported-or-invalid');

  if (input.returnDistinctValues) {
    if (capabilities.supportsDistinct) params.returnDistinctValues = true;
    else warnings.push('distinct-not-supported');
  }

  if (input.outStatistics?.length) {
    if (capabilities.supportsStatistics) params.outStatistics = JSON.stringify(input.outStatistics);
    else warnings.push('statistics-not-supported');
  }

  const having = normalizeText(input.having);
  if (having) {
    if (capabilities.supportsHavingClause) params.having = having;
    else warnings.push('having-not-supported');
  }

  if (Number.isFinite(input.distance) && Number(input.distance) > 0) {
    if (capabilities.supportsDistanceQuery) {
      params.distance = Number(input.distance);
      if (normalizeText(input.units)) params.units = normalizeText(input.units);
    } else {
      warnings.push('distance-query-not-supported');
    }
  }

  return Object.freeze({
    params: Object.freeze(params),
    warnings: Object.freeze(warnings),
    pageSize,
    paginationEnabled: capabilities.supportsPagination,
  });
};

export interface ArcGisPagedQueryState<TFeature = unknown> {
  features: readonly TFeature[];
  nextOffset: number;
  pageCount: number;
  complete: boolean;
  exceededTransferLimit: boolean;
}

export const advanceArcGisPagedQueryState = <TFeature>(
  previous: ArcGisPagedQueryState<TFeature> | null,
  pageFeatures: readonly TFeature[],
  options: {
    pageSize: number;
    exceededTransferLimit?: boolean;
    maxRecords?: number;
  },
): ArcGisPagedQueryState<TFeature> => {
  const previousFeatures = previous?.features ?? [];
  const maxRecords = Math.max(1, asPositiveInteger(options.maxRecords, 50_000));
  const remaining = Math.max(0, maxRecords - previousFeatures.length);
  const accepted = pageFeatures.slice(0, remaining);
  const features = Object.freeze([...previousFeatures, ...accepted]);
  const pageSize = Math.max(1, asPositiveInteger(options.pageSize, 1_000));
  const transferLimited = options.exceededTransferLimit === true;
  const pageWasFull = pageFeatures.length >= pageSize;
  const capacityReached = features.length >= maxRecords;
  const complete = capacityReached || (!transferLimited && !pageWasFull) || pageFeatures.length === 0;

  return Object.freeze({
    features,
    nextOffset: (previous?.nextOffset ?? 0) + pageFeatures.length,
    pageCount: (previous?.pageCount ?? 0) + 1,
    complete,
    exceededTransferLimit: transferLimited,
  });
};

export interface ArcGisEditGuardInput {
  creates?: readonly unknown[];
  updates?: readonly unknown[];
  deletes?: readonly unknown[];
}

export interface ArcGisEditGuardResult {
  allowed: boolean;
  reasons: readonly string[];
  requestedOperations: readonly ('create' | 'update' | 'delete')[];
}

export const validateArcGisEditIntent = (
  capabilities: ArcGisServiceCapabilities,
  input: ArcGisEditGuardInput,
): ArcGisEditGuardResult => {
  const reasons: string[] = [];
  const operations: ('create' | 'update' | 'delete')[] = [];

  if (input.creates?.length) {
    operations.push('create');
    if (!capabilities.supportsCreate) reasons.push('create-not-supported');
  }
  if (input.updates?.length) {
    operations.push('update');
    if (!capabilities.supportsUpdate) reasons.push('update-not-supported');
  }
  if (input.deletes?.length) {
    operations.push('delete');
    if (!capabilities.supportsDelete) reasons.push('delete-not-supported');
  }

  return Object.freeze({
    allowed: reasons.length === 0,
    reasons: Object.freeze(reasons),
    requestedOperations: Object.freeze(operations),
  });
};
