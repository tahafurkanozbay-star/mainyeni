import {
  ARCGIS_QUERY_CAPABILITY,
  assessCapabilityContract,
  selectCapabilityFields,
} from './serviceCapabilityRuntime';

export const ARCGIS_QUERY_STRATEGY = Object.freeze({
  OFFSET: 'offset-pagination',
  OBJECT_IDS: 'object-id-pagination',
  SINGLE: 'single-request',
  STATISTICS: 'statistics',
} as const);

export const ARCGIS_SPATIAL_RELATIONSHIP = Object.freeze({
  INTERSECTS: 'esriSpatialRelIntersects',
  CONTAINS: 'esriSpatialRelContains',
  CROSSES: 'esriSpatialRelCrosses',
  ENVELOPE_INTERSECTS: 'esriSpatialRelEnvelopeIntersects',
  INDEX_INTERSECTS: 'esriSpatialRelIndexIntersects',
  OVERLAPS: 'esriSpatialRelOverlaps',
  TOUCHES: 'esriSpatialRelTouches',
  WITHIN: 'esriSpatialRelWithin',
} as const);

export type ArcGisQueryStrategy = typeof ARCGIS_QUERY_STRATEGY[keyof typeof ARCGIS_QUERY_STRATEGY];
export type ArcGisSpatialRelationship = typeof ARCGIS_SPATIAL_RELATIONSHIP[keyof typeof ARCGIS_SPATIAL_RELATIONSHIP];

export interface SpatialReferenceLike {
  wkid?: number | string | null;
  latestWkid?: number | string | null;
  wkt?: string | null;
}

export interface ArcGisGeometryLike {
  x?: number;
  y?: number;
  points?: unknown[];
  paths?: unknown[];
  rings?: unknown[];
  xmin?: number;
  ymin?: number;
  xmax?: number;
  ymax?: number;
  spatialReference?: SpatialReferenceLike | null;
  [key: string]: unknown;
}

export interface CapabilityFieldLike {
  name: string;
  alias?: string;
  type?: string;
  nullable?: boolean;
  editable?: boolean;
  length?: number | null;
  domainType?: string | null;
}

export interface CapabilityTimeLike {
  hasTime?: boolean;
  startField?: string | null;
  endField?: string | null;
  trackIdField?: string | null;
}

export interface ArcGisCapabilityContractLike {
  serviceId?: string | null;
  resourceUrl?: string | null;
  supportsQuery?: boolean;
  supportsPagination?: boolean;
  supportsOrderBy?: boolean;
  supportsStatistics?: boolean;
  supportsZ?: boolean;
  supportsM?: boolean;
  objectIdField?: string | null;
  globalIdField?: string | null;
  displayField?: string | null;
  maxRecordCount?: number | null;
  geometryType?: string | null;
  spatialReference?: SpatialReferenceLike | null;
  queryCapabilities?: readonly string[];
  time?: CapabilityTimeLike | null;
  fields?: readonly CapabilityFieldLike[];
  editing?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ArcGisOrderByDefinition {
  field: string;
  direction?: 'ASC' | 'DESC' | 'asc' | 'desc' | string;
}

export interface ArcGisStatisticDefinition {
  type?: string;
  statisticType?: string;
  field?: string | null;
  name?: string;
  outStatisticFieldName?: string;
}

export interface ArcGisGeneralizationOptions {
  maxAllowableOffset?: number | null;
  geometryPrecision?: number | null;
  unitsConfirmed?: boolean;
}

export interface ArcGisTimeRange {
  start?: Date | number | string | null;
  end?: Date | number | string | null;
}

export interface ArcGisQueryPlanInput {
  where?: string | null;
  outFields?: string[];
  fields?: string[];
  requiredFields?: string[];
  includeDisplayField?: boolean;
  pageSize?: number | null;
  resultRecordCount?: number | null;
  returnGeometry?: boolean;
  returnZ?: boolean;
  returnM?: boolean;
  geometry?: ArcGisGeometryLike | null;
  geometryType?: string | null;
  inSpatialReference?: SpatialReferenceLike | number | string | null;
  inSR?: SpatialReferenceLike | number | string | null;
  outSpatialReference?: SpatialReferenceLike | number | string | null;
  outSR?: SpatialReferenceLike | number | string | null;
  spatialRelationship?: string | null;
  spatialRel?: string | null;
  orderBy?: ArcGisOrderByDefinition[];
  statistics?: ArcGisStatisticDefinition[];
  groupBy?: string[];
  time?: ArcGisTimeRange | readonly [Date | number | string | null, Date | number | string | null] | null;
  generalization?: ArcGisGeneralizationOptions;
  returnDistinctValues?: boolean;
  returnCentroid?: boolean;
}

export interface ArcGisOutStatistic {
  statisticType: string;
  onStatisticField: string;
  outStatisticFieldName: string;
}

export interface ArcGisQueryRequest {
  where: string;
  outFields?: readonly string[];
  returnGeometry: boolean;
  returnZ: boolean;
  returnM: boolean;
  geometry?: ArcGisGeometryLike;
  geometryType?: string;
  inSR?: number | string;
  spatialRel?: ArcGisSpatialRelationship;
  outSR?: number | string;
  orderByFields?: string;
  outStatistics?: readonly ArcGisOutStatistic[];
  groupByFieldsForStatistics?: readonly string[];
  time?: string;
  maxAllowableOffset?: number;
  geometryPrecision?: number;
  returnDistinctValues?: boolean;
  returnCentroid?: boolean;
  resultOffset?: number;
  resultRecordCount?: number;
  objectIds?: string;
  returnIdsOnly?: boolean;
}

export interface ArcGisQueryPlan {
  strategy: ArcGisQueryStrategy;
  pageSize: number | null;
  identity: string;
  baseRequest: Readonly<ArcGisQueryRequest>;
  objectIdField: string | null;
  maxRecordCount: number | null;
  warnings: readonly string[];
  diagnostics: Readonly<{
    queryReady: boolean;
    stableIdentity: boolean;
    spatial: boolean;
    statistics: number;
    groupByFields: number;
    ordered: boolean;
    timeFiltered: boolean;
    generalized: boolean;
    fieldCount: number;
  }>;
}

export interface ArcGisPageInput {
  offset?: number | null;
  count?: number | null;
  objectIds?: Array<string | number>;
}

interface NormalizedGeometry {
  geometry: ArcGisGeometryLike;
  geometryType: string;
  spatialReference: Readonly<{ wkid?: number; wkt?: string }>;
}

interface NormalizedOrderBy {
  field: string;
  direction: 'ASC' | 'DESC';
}

interface NormalizedGeneralization {
  maxAllowableOffset: number;
  geometryPrecision: number | null;
}

interface CapabilityAssessmentLike {
  valid?: boolean;
  issues?: readonly string[];
  queryReady: boolean;
  stableIdentity: boolean;
}

export class SpatialQueryPlannerError extends Error {
  readonly code: string;
  readonly field: string | null;
  readonly capability: string | null;

  constructor(
    message: string,
    details: {
      code?: string;
      field?: string | null;
      capability?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'SpatialQueryPlannerError';
    this.code = details.code || 'SPATIAL_QUERY_PLANNER_ERROR';
    this.field = details.field || null;
    this.capability = details.capability || null;
  }
}

const ALLOWED_STATISTICS = new Set([
  'count',
  'sum',
  'min',
  'max',
  'avg',
  'stddev',
  'var',
]);

const ALLOWED_GEOMETRY_TYPES = new Set([
  'esriGeometryPoint',
  'esriGeometryMultipoint',
  'esriGeometryPolyline',
  'esriGeometryPolygon',
  'esriGeometryEnvelope',
]);

const finite = (value: unknown, fallback: number | null = null): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (
  value: unknown,
  fallback: number | null = null,
  max = Number.MAX_SAFE_INTEGER,
): number | null => {
  const numeric = finite(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const uniqueStrings = (values: readonly unknown[] = []): string[] => [...new Set(
  values
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map((value) => String(value).trim()),
)];

const knownFieldMap = (contract: ArcGisCapabilityContractLike = {}): Map<string, string> => new Map(
  (contract.fields || [])
    .filter((field) => field?.name)
    .map((field) => [String(field.name).toLocaleLowerCase('en-US'), String(field.name)]),
);

const resolveField = (
  field: unknown,
  contract: ArcGisCapabilityContractLike,
  options: { optional?: boolean } = {},
): string | null => {
  const requested = String(field ?? '').trim();
  if (!requested) {
    if (options.optional) return null;
    throw new SpatialQueryPlannerError('Query field name is required.', {
      code: 'INVALID_FIELD',
    });
  }
  const known = knownFieldMap(contract);
  const resolved = known.get(requested.toLocaleLowerCase('en-US'));
  if (!resolved) {
    if (options.optional) return null;
    throw new SpatialQueryPlannerError(`Unknown ArcGIS field: ${requested}`, {
      code: 'UNKNOWN_FIELD',
      field: requested,
    });
  }
  return resolved;
};

const requireField = (
  field: unknown,
  contract: ArcGisCapabilityContractLike,
): string => {
  const resolved = resolveField(field, contract);
  if (!resolved) {
    throw new SpatialQueryPlannerError('Query field name is required.', {
      code: 'INVALID_FIELD',
    });
  }
  return resolved;
};

const normalizeWhere = (value: unknown): string => {
  const where = String(value ?? '1=1').trim() || '1=1';
  if (where.length > 8192) {
    throw new SpatialQueryPlannerError('ArcGIS where clause exceeds the bounded planner limit.', {
      code: 'WHERE_TOO_LONG',
    });
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(where)) {
    throw new SpatialQueryPlannerError('ArcGIS where clause contains control characters.', {
      code: 'INVALID_WHERE',
    });
  }
  return where;
};

const inferGeometryType = (geometry: ArcGisGeometryLike = {}): string | null => {
  if (!geometry || typeof geometry !== 'object') return null;
  if (finite(geometry.x) !== null && finite(geometry.y) !== null) return 'esriGeometryPoint';
  if (Array.isArray(geometry.points)) return 'esriGeometryMultipoint';
  if (Array.isArray(geometry.paths)) return 'esriGeometryPolyline';
  if (Array.isArray(geometry.rings)) return 'esriGeometryPolygon';
  if (
    finite(geometry.xmin) !== null
    && finite(geometry.ymin) !== null
    && finite(geometry.xmax) !== null
    && finite(geometry.ymax) !== null
  ) {
    return 'esriGeometryEnvelope';
  }
  return null;
};

const normalizeSpatialReference = (
  value: SpatialReferenceLike | number | string | null | undefined,
): { wkid?: number; wkt?: string } | null => {
  if (!value) return null;
  if (typeof value === 'number' || typeof value === 'string') {
    const wkid = positiveInteger(value);
    return wkid ? { wkid } : null;
  }
  const wkid = positiveInteger(value.latestWkid ?? value.wkid);
  if (wkid) return { wkid };
  if (typeof value.wkt === 'string' && value.wkt.trim()) return { wkt: value.wkt.trim() };
  return null;
};

const normalizeGeometry = (input: ArcGisQueryPlanInput = {}): NormalizedGeometry | null => {
  if (!input.geometry) return null;
  if (typeof input.geometry !== 'object') {
    throw new SpatialQueryPlannerError('Spatial query geometry must be an ArcGIS JSON geometry object.', {
      code: 'INVALID_GEOMETRY',
    });
  }
  const geometryType = String(input.geometryType || inferGeometryType(input.geometry) || '').trim();
  if (!ALLOWED_GEOMETRY_TYPES.has(geometryType)) {
    throw new SpatialQueryPlannerError('Spatial query geometry type could not be verified.', {
      code: 'INVALID_GEOMETRY_TYPE',
    });
  }
  const spatialReference = normalizeSpatialReference(
    input.inSpatialReference
    || input.inSR
    || input.geometry.spatialReference,
  );
  if (!spatialReference) {
    throw new SpatialQueryPlannerError('Spatial query input spatial reference must be explicit.', {
      code: 'MISSING_INPUT_SPATIAL_REFERENCE',
    });
  }
  return Object.freeze({
    geometry: input.geometry,
    geometryType,
    spatialReference: Object.freeze(spatialReference),
  });
};

const normalizeSpatialRelationship = (value: unknown): ArcGisSpatialRelationship => {
  if (!value) return ARCGIS_SPATIAL_RELATIONSHIP.INTERSECTS;
  const normalized = String(value).trim();
  const direct = Object.values(ARCGIS_SPATIAL_RELATIONSHIP)
    .find((candidate) => candidate === normalized);
  if (direct) return direct;
  const key = String(value).trim().toUpperCase() as keyof typeof ARCGIS_SPATIAL_RELATIONSHIP;
  const byName = ARCGIS_SPATIAL_RELATIONSHIP[key];
  if (byName) return byName;
  throw new SpatialQueryPlannerError(`Unsupported ArcGIS spatial relationship: ${String(value)}`, {
    code: 'INVALID_SPATIAL_RELATIONSHIP',
  });
};

const normalizeOrderBy = (
  items: ArcGisOrderByDefinition[] = [],
  contract: ArcGisCapabilityContractLike = {},
): NormalizedOrderBy[] => {
  if (!items.length) return [];
  if (!contract.supportsOrderBy) {
    throw new SpatialQueryPlannerError('ArcGIS service metadata does not advertise order-by support.', {
      code: 'ORDER_BY_NOT_SUPPORTED',
      capability: String(ARCGIS_QUERY_CAPABILITY.ORDER_BY),
    });
  }
  return items.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new SpatialQueryPlannerError('orderBy entries must be structured objects.', {
        code: 'INVALID_ORDER_BY',
      });
    }
    const field = requireField(item.field, contract);
    const direction = String(item.direction || 'ASC').trim().toUpperCase();
    if (direction !== 'ASC' && direction !== 'DESC') {
      throw new SpatialQueryPlannerError(`Invalid sort direction for ${field}.`, {
        code: 'INVALID_ORDER_DIRECTION',
        field,
      });
    }
    return Object.freeze({ field, direction }) as NormalizedOrderBy;
  });
};

const normalizeStatistics = (
  items: ArcGisStatisticDefinition[] = [],
  contract: ArcGisCapabilityContractLike = {},
): ArcGisOutStatistic[] => {
  if (!items.length) return [];
  if (!contract.supportsStatistics) {
    throw new SpatialQueryPlannerError('ArcGIS service metadata does not advertise statistics support.', {
      code: 'STATISTICS_NOT_SUPPORTED',
      capability: String(ARCGIS_QUERY_CAPABILITY.STATISTICS),
    });
  }
  return items.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new SpatialQueryPlannerError('Statistic entries must be structured objects.', {
        code: 'INVALID_STATISTIC',
      });
    }
    const statisticType = String(item.type || item.statisticType || '').trim().toLowerCase();
    if (!ALLOWED_STATISTICS.has(statisticType)) {
      throw new SpatialQueryPlannerError(`Unsupported statistic type: ${statisticType || '<empty>'}`, {
        code: 'INVALID_STATISTIC_TYPE',
      });
    }
    const onStatisticField = statisticType === 'count' && (item.field === '*' || item.field == null)
      ? '*'
      : requireField(item.field, contract);
    const proposedName = String(item.name || item.outStatisticFieldName || `stat_${index + 1}`).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(proposedName)) {
      throw new SpatialQueryPlannerError('Statistic output name must be a safe identifier.', {
        code: 'INVALID_STATISTIC_NAME',
      });
    }
    return Object.freeze({
      statisticType,
      onStatisticField,
      outStatisticFieldName: proposedName,
    });
  });
};

const normalizeGroupBy = (
  fields: string[] = [],
  contract: ArcGisCapabilityContractLike = {},
): string[] => {
  if (!fields.length) return [];
  if (!contract.supportsStatistics) {
    throw new SpatialQueryPlannerError('Group-by requires service statistics capability.', {
      code: 'GROUP_BY_NOT_SUPPORTED',
      capability: String(ARCGIS_QUERY_CAPABILITY.STATISTICS),
    });
  }
  return uniqueStrings(fields.map((field) => requireField(field, contract)));
};

const normalizeTimeValue = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const numeric = value.getTime();
    return Number.isFinite(numeric) ? numeric : null;
  }
  return finite(value);
};

const normalizeTime = (
  input: ArcGisQueryPlanInput['time'],
  contract: ArcGisCapabilityContractLike,
): string | null => {
  if (!input) return null;
  if (!contract.time?.hasTime) {
    throw new SpatialQueryPlannerError('ArcGIS service metadata does not advertise time support.', {
      code: 'TIME_NOT_SUPPORTED',
    });
  }
  const values = Array.isArray(input)
    ? input
    : [(input as ArcGisTimeRange).start, (input as ArcGisTimeRange).end];
  const start = normalizeTimeValue(values[0]);
  const end = normalizeTimeValue(values[1]);
  if (start === null && end === null) {
    throw new SpatialQueryPlannerError('Time filter requires at least one finite timestamp.', {
      code: 'INVALID_TIME_RANGE',
    });
  }
  if (start !== null && end !== null && start > end) {
    throw new SpatialQueryPlannerError('Time range start must not be after end.', {
      code: 'INVALID_TIME_RANGE',
    });
  }
  return `${start ?? 'null'},${end ?? 'null'}`;
};

const normalizeOutFields = (
  input: ArcGisQueryPlanInput = {},
  contract: ArcGisCapabilityContractLike = {},
): string[] => {
  const requested = uniqueStrings(input.outFields || input.fields || []);
  const selected = (selectCapabilityFields(contract, requested) || []) as string[];
  const mandatory = uniqueStrings([
    contract.objectIdField,
    input.includeDisplayField === false ? null : contract.displayField,
    ...(input.requiredFields || []),
  ]);
  const mandatoryKnown = (selectCapabilityFields(contract, mandatory) || []) as string[];
  const fields = uniqueStrings([...mandatoryKnown, ...selected]);
  if (!fields.length && contract.objectIdField) fields.push(contract.objectIdField);
  if (!fields.length) {
    throw new SpatialQueryPlannerError('No verified output fields are available for this query.', {
      code: 'NO_OUTPUT_FIELDS',
    });
  }
  return fields;
};

const normalizeGeneralization = (
  input: ArcGisGeneralizationOptions = {},
  contract: ArcGisCapabilityContractLike = {},
): NormalizedGeneralization | null => {
  const offset = finite(input.maxAllowableOffset);
  if (offset === null) return null;
  if (offset <= 0) {
    throw new SpatialQueryPlannerError('maxAllowableOffset must be a positive finite value.', {
      code: 'INVALID_GENERALIZATION_OFFSET',
    });
  }
  if (input.unitsConfirmed !== true) {
    throw new SpatialQueryPlannerError(
      'maxAllowableOffset requires explicit unitsConfirmed=true; coordinate units are never guessed.',
      {
        code: 'UNCONFIRMED_GENERALIZATION_UNITS',
      },
    );
  }
  if (!contract.spatialReference) {
    throw new SpatialQueryPlannerError(
      'maxAllowableOffset requires verified service spatial reference metadata.',
      {
        code: 'MISSING_SPATIAL_REFERENCE',
      },
    );
  }
  return Object.freeze({
    maxAllowableOffset: offset,
    geometryPrecision: positiveInteger(input.geometryPrecision, null, 15),
  });
};

const chooseStrategy = (
  contract: ArcGisCapabilityContractLike,
  statistics: readonly ArcGisOutStatistic[],
): ArcGisQueryStrategy => {
  if (statistics.length) return ARCGIS_QUERY_STRATEGY.STATISTICS;
  if (contract.supportsPagination) return ARCGIS_QUERY_STRATEGY.OFFSET;
  if (contract.objectIdField) return ARCGIS_QUERY_STRATEGY.OBJECT_IDS;
  return ARCGIS_QUERY_STRATEGY.SINGLE;
};

const choosePageSize = (
  input: ArcGisQueryPlanInput,
  contract: ArcGisCapabilityContractLike,
  strategy: ArcGisQueryStrategy,
): number | null => {
  if (strategy === ARCGIS_QUERY_STRATEGY.STATISTICS) return null;
  const serviceLimit = positiveInteger(contract.maxRecordCount);
  const requested = positiveInteger(input.pageSize || input.resultRecordCount);
  if (requested && serviceLimit) return Math.min(requested, serviceLimit);
  if (serviceLimit) return serviceLimit;
  if (strategy === ARCGIS_QUERY_STRATEGY.SINGLE) return requested;
  throw new SpatialQueryPlannerError(
    'Paged ArcGIS query requires maxRecordCount from verified service metadata.',
    {
      code: 'MISSING_MAX_RECORD_COUNT',
    },
  );
};

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) accumulator[key] = canonicalize(item);
      return accumulator;
    }, {});
};

const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const createArcGisQueryIdentity = (value: unknown): string => {
  const canonical = JSON.stringify(canonicalize(value));
  return `arcgis-query:${fnv1a(canonical)}:${canonical.length}`;
};

const freezeRequest = (request: ArcGisQueryRequest): Readonly<ArcGisQueryRequest> => {
  const { outFields, outStatistics, groupByFieldsForStatistics, ...rest } = request;
  return Object.freeze({
    ...rest,
    ...(outFields ? { outFields: Object.freeze([...outFields]) } : {}),
    ...(outStatistics
      ? { outStatistics: Object.freeze(outStatistics.map((item) => Object.freeze({ ...item }))) }
      : {}),
    ...(groupByFieldsForStatistics
      ? { groupByFieldsForStatistics: Object.freeze([...groupByFieldsForStatistics]) }
      : {}),
  });
};

export const compileArcGisQueryPlan = (
  contract: ArcGisCapabilityContractLike = {},
  input: ArcGisQueryPlanInput = {},
): ArcGisQueryPlan => {
  if (!contract || typeof contract !== 'object') {
    throw new SpatialQueryPlannerError('A verified ArcGIS capability contract is required.', {
      code: 'INVALID_CAPABILITY_CONTRACT',
    });
  }
  if (!contract.supportsQuery) {
    throw new SpatialQueryPlannerError('ArcGIS capability contract does not advertise query support.', {
      code: 'QUERY_NOT_SUPPORTED',
      capability: String(ARCGIS_QUERY_CAPABILITY.QUERY),
    });
  }

  const capabilityAssessment = assessCapabilityContract(contract) as CapabilityAssessmentLike;
  const geometry = normalizeGeometry(input);
  const orderBy = normalizeOrderBy(input.orderBy || [], contract);
  const statistics = normalizeStatistics(input.statistics || [], contract);
  const groupBy = normalizeGroupBy(input.groupBy || [], contract);
  const time = normalizeTime(input.time, contract);
  const generalization = normalizeGeneralization(input.generalization || {}, contract);
  const strategy = chooseStrategy(contract, statistics);
  const pageSize = choosePageSize(input, contract, strategy);
  const outFields = normalizeOutFields(input, contract);
  const warnings: string[] = [];

  if (strategy === ARCGIS_QUERY_STRATEGY.SINGLE && !contract.maxRecordCount) {
    warnings.push('single-request-without-service-record-limit');
  }
  if (!capabilityAssessment.stableIdentity && strategy === ARCGIS_QUERY_STRATEGY.SINGLE) {
    warnings.push('query-without-stable-identity');
  }
  if (input.returnGeometry !== false && contract.geometryType && !contract.spatialReference) {
    warnings.push('geometry-result-without-service-spatial-reference');
  }

  const outSpatialReference = normalizeSpatialReference(
    input.outSpatialReference
    || input.outSR
    || contract.spatialReference,
  );
  const request: ArcGisQueryRequest = {
    where: normalizeWhere(input.where),
    outFields,
    returnGeometry: input.returnGeometry !== false,
    returnZ: contract.supportsZ === true && input.returnZ === true,
    returnM: contract.supportsM === true && input.returnM === true,
  };

  if (geometry) {
    request.geometry = geometry.geometry;
    request.geometryType = geometry.geometryType;
    const inSpatialReference = geometry.spatialReference.wkid || geometry.spatialReference.wkt;
    if (inSpatialReference !== null && inSpatialReference !== undefined) {
      request.inSR = inSpatialReference;
    }
    request.spatialRel = normalizeSpatialRelationship(input.spatialRelationship || input.spatialRel);
  }
  if (outSpatialReference) {
    const outputSpatialReference = outSpatialReference.wkid || outSpatialReference.wkt;
    if (outputSpatialReference !== null && outputSpatialReference !== undefined) {
      request.outSR = outputSpatialReference;
    }
  }
  if (orderBy.length) {
    request.orderByFields = orderBy.map((item) => `${item.field} ${item.direction}`).join(',');
  }
  if (statistics.length) {
    request.outStatistics = statistics;
    request.returnGeometry = input.returnGeometry === true;
  }
  if (groupBy.length) request.groupByFieldsForStatistics = groupBy;
  if (time) request.time = time;
  if (generalization) {
    request.maxAllowableOffset = generalization.maxAllowableOffset;
    if (generalization.geometryPrecision) request.geometryPrecision = generalization.geometryPrecision;
  }
  if (input.returnDistinctValues === true) {
    if (!(contract.queryCapabilities || []).includes(String(ARCGIS_QUERY_CAPABILITY.DISTINCT))) {
      throw new SpatialQueryPlannerError('Distinct values are not advertised by service metadata.', {
        code: 'DISTINCT_NOT_SUPPORTED',
        capability: String(ARCGIS_QUERY_CAPABILITY.DISTINCT),
      });
    }
    request.returnDistinctValues = true;
  }
  if (input.returnCentroid === true) {
    if (!(contract.queryCapabilities || []).includes(String(ARCGIS_QUERY_CAPABILITY.CENTROID))) {
      throw new SpatialQueryPlannerError('Centroid return is not advertised by service metadata.', {
        code: 'CENTROID_NOT_SUPPORTED',
        capability: String(ARCGIS_QUERY_CAPABILITY.CENTROID),
      });
    }
    request.returnCentroid = true;
  }

  const baseRequest = freezeRequest(request);
  const identity = createArcGisQueryIdentity({
    serviceId: contract.serviceId,
    resourceUrl: contract.resourceUrl,
    strategy,
    pageSize,
    request: baseRequest,
  });

  return Object.freeze({
    strategy,
    pageSize,
    identity,
    baseRequest,
    objectIdField: contract.objectIdField || null,
    maxRecordCount: contract.maxRecordCount || null,
    warnings: Object.freeze(warnings),
    diagnostics: Object.freeze({
      queryReady: Boolean(capabilityAssessment.queryReady),
      stableIdentity: Boolean(capabilityAssessment.stableIdentity),
      spatial: Boolean(geometry),
      statistics: statistics.length,
      groupByFields: groupBy.length,
      ordered: orderBy.length > 0,
      timeFiltered: Boolean(time),
      generalized: Boolean(generalization),
      fieldCount: outFields.length,
    }),
  });
};

export const createArcGisPageRequest = (
  plan: ArcGisQueryPlan,
  page: ArcGisPageInput = {},
): Readonly<ArcGisQueryRequest> => {
  if (!plan?.baseRequest || !plan?.strategy) {
    throw new SpatialQueryPlannerError('A compiled ArcGIS query plan is required.', {
      code: 'INVALID_QUERY_PLAN',
    });
  }
  const request: ArcGisQueryRequest = {
    ...plan.baseRequest,
    outFields: [...(plan.baseRequest.outFields || [])],
  };

  if (plan.strategy === ARCGIS_QUERY_STRATEGY.OFFSET) {
    const offset = Math.max(0, Math.floor(finite(page.offset, 0) || 0));
    const count = positiveInteger(page.count, plan.pageSize);
    if (!count || !plan.pageSize) {
      throw new SpatialQueryPlannerError('Offset page request requires a bounded page size.', {
        code: 'INVALID_PAGE_SIZE',
      });
    }
    request.resultOffset = offset;
    request.resultRecordCount = Math.min(count, plan.pageSize);
    return Object.freeze(request);
  }

  if (plan.strategy === ARCGIS_QUERY_STRATEGY.OBJECT_IDS) {
    if (!plan.objectIdField) {
      throw new SpatialQueryPlannerError('Object-id pagination requires a verified object id field.', {
        code: 'MISSING_OBJECT_ID_FIELD',
      });
    }
    const ids = uniqueStrings(page.objectIds || []);
    if (!ids.length) {
      throw new SpatialQueryPlannerError('Object-id page request requires at least one object id.', {
        code: 'EMPTY_OBJECT_ID_PAGE',
      });
    }
    if (plan.pageSize && ids.length > plan.pageSize) {
      throw new SpatialQueryPlannerError('Object-id page exceeds the compiled service page size.', {
        code: 'OBJECT_ID_PAGE_TOO_LARGE',
      });
    }
    request.objectIds = ids.join(',');
    return Object.freeze(request);
  }

  if (plan.strategy === ARCGIS_QUERY_STRATEGY.SINGLE) {
    if (plan.pageSize) request.resultRecordCount = plan.pageSize;
    return Object.freeze(request);
  }

  if (plan.strategy === ARCGIS_QUERY_STRATEGY.STATISTICS) {
    return Object.freeze(request);
  }

  throw new SpatialQueryPlannerError(`Unknown ArcGIS query strategy: ${String(plan.strategy)}`, {
    code: 'UNKNOWN_QUERY_STRATEGY',
  });
};

export const createArcGisObjectIdDiscoveryRequest = (
  plan: ArcGisQueryPlan,
): Readonly<ArcGisQueryRequest> => {
  if (!plan?.baseRequest || plan.strategy !== ARCGIS_QUERY_STRATEGY.OBJECT_IDS) {
    throw new SpatialQueryPlannerError('Object-id discovery is only valid for object-id pagination plans.', {
      code: 'OBJECT_ID_DISCOVERY_NOT_APPLICABLE',
    });
  }
  const {
    outFields: _outFields,
    returnGeometry: _returnGeometry,
    orderByFields: _orderByFields,
    outStatistics: _outStatistics,
    groupByFieldsForStatistics: _groupByFieldsForStatistics,
    resultOffset: _resultOffset,
    resultRecordCount: _resultRecordCount,
    ...filters
  } = plan.baseRequest;
  return Object.freeze({
    ...filters,
    returnIdsOnly: true,
    returnGeometry: false,
  });
};
