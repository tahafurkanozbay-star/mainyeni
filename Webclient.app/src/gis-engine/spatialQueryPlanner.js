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
});

export const ARCGIS_SPATIAL_RELATIONSHIP = Object.freeze({
  INTERSECTS: 'esriSpatialRelIntersects',
  CONTAINS: 'esriSpatialRelContains',
  CROSSES: 'esriSpatialRelCrosses',
  ENVELOPE_INTERSECTS: 'esriSpatialRelEnvelopeIntersects',
  INDEX_INTERSECTS: 'esriSpatialRelIndexIntersects',
  OVERLAPS: 'esriSpatialRelOverlaps',
  TOUCHES: 'esriSpatialRelTouches',
  WITHIN: 'esriSpatialRelWithin',
});

export class SpatialQueryPlannerError extends Error {
  constructor(message, details = {}) {
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

const finite = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (value, fallback = null, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = finite(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const uniqueStrings = (values = []) => [...new Set(
  values
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map((value) => String(value).trim()),
)];

const knownFieldMap = (contract = {}) => new Map(
  (contract.fields || [])
    .filter((field) => field?.name)
    .map((field) => [String(field.name).toLocaleLowerCase('en-US'), String(field.name)]),
);

const resolveField = (field, contract, options = {}) => {
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

const normalizeWhere = (value) => {
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

const inferGeometryType = (geometry = {}) => {
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

const normalizeSpatialReference = (value) => {
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

const normalizeGeometry = (input = {}) => {
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
    spatialReference,
  });
};

const normalizeSpatialRelationship = (value) => {
  if (!value) return ARCGIS_SPATIAL_RELATIONSHIP.INTERSECTS;
  const normalized = String(value).trim();
  const direct = Object.values(ARCGIS_SPATIAL_RELATIONSHIP).find((candidate) => candidate === normalized);
  if (direct) return direct;
  const byName = ARCGIS_SPATIAL_RELATIONSHIP[String(value).trim().toUpperCase()];
  if (byName) return byName;
  throw new SpatialQueryPlannerError(`Unsupported ArcGIS spatial relationship: ${value}`, {
    code: 'INVALID_SPATIAL_RELATIONSHIP',
  });
};

const normalizeOrderBy = (items = [], contract = {}) => {
  if (!items || (Array.isArray(items) && !items.length)) return [];
  if (!contract.supportsOrderBy) {
    throw new SpatialQueryPlannerError('ArcGIS service metadata does not advertise order-by support.', {
      code: 'ORDER_BY_NOT_SUPPORTED',
      capability: ARCGIS_QUERY_CAPABILITY.ORDER_BY,
    });
  }
  if (!Array.isArray(items)) {
    throw new SpatialQueryPlannerError('orderBy must use structured field/direction objects.', {
      code: 'INVALID_ORDER_BY',
    });
  }
  return items.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new SpatialQueryPlannerError('orderBy entries must be structured objects.', {
        code: 'INVALID_ORDER_BY',
      });
    }
    const field = resolveField(item.field, contract);
    const direction = String(item.direction || 'ASC').trim().toUpperCase();
    if (direction !== 'ASC' && direction !== 'DESC') {
      throw new SpatialQueryPlannerError(`Invalid sort direction for ${field}.`, {
        code: 'INVALID_ORDER_DIRECTION',
        field,
      });
    }
    return Object.freeze({ field, direction });
  });
};

const normalizeStatistics = (items = [], contract = {}) => {
  if (!items || (Array.isArray(items) && !items.length)) return [];
  if (!contract.supportsStatistics) {
    throw new SpatialQueryPlannerError('ArcGIS service metadata does not advertise statistics support.', {
      code: 'STATISTICS_NOT_SUPPORTED',
      capability: ARCGIS_QUERY_CAPABILITY.STATISTICS,
    });
  }
  if (!Array.isArray(items)) {
    throw new SpatialQueryPlannerError('Statistics must use structured definitions.', {
      code: 'INVALID_STATISTICS',
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
      : resolveField(item.field, contract);
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

const normalizeGroupBy = (fields = [], contract = {}) => {
  if (!fields || (Array.isArray(fields) && !fields.length)) return [];
  if (!contract.supportsStatistics) {
    throw new SpatialQueryPlannerError('Group-by requires service statistics capability.', {
      code: 'GROUP_BY_NOT_SUPPORTED',
      capability: ARCGIS_QUERY_CAPABILITY.STATISTICS,
    });
  }
  if (!Array.isArray(fields)) {
    throw new SpatialQueryPlannerError('groupBy must be an array of known field names.', {
      code: 'INVALID_GROUP_BY',
    });
  }
  return uniqueStrings(fields.map((field) => resolveField(field, contract)));
};

const normalizeTimeValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const numeric = value.getTime();
    return Number.isFinite(numeric) ? numeric : null;
  }
  return finite(value);
};

const normalizeTime = (input, contract) => {
  if (!input) return null;
  if (!contract.time?.hasTime) {
    throw new SpatialQueryPlannerError('ArcGIS service metadata does not advertise time support.', {
      code: 'TIME_NOT_SUPPORTED',
    });
  }
  const values = Array.isArray(input) ? input : [input.start, input.end];
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

const normalizeOutFields = (input = {}, contract = {}) => {
  const requested = uniqueStrings(input.outFields || input.fields || []);
  const selected = selectCapabilityFields(contract, requested);
  const mandatory = uniqueStrings([
    contract.objectIdField,
    input.includeDisplayField === false ? null : contract.displayField,
    ...(input.requiredFields || []),
  ]);
  const mandatoryKnown = selectCapabilityFields(contract, mandatory);
  const fields = uniqueStrings([...mandatoryKnown, ...selected]);
  if (!fields.length && contract.objectIdField) fields.push(contract.objectIdField);
  if (!fields.length) {
    throw new SpatialQueryPlannerError('No verified output fields are available for this query.', {
      code: 'NO_OUTPUT_FIELDS',
    });
  }
  return fields;
};

const normalizeGeneralization = (input = {}, contract = {}) => {
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

const chooseStrategy = (contract, statistics) => {
  if (statistics.length) return ARCGIS_QUERY_STRATEGY.STATISTICS;
  if (contract.supportsPagination) return ARCGIS_QUERY_STRATEGY.OFFSET;
  if (contract.objectIdField) return ARCGIS_QUERY_STRATEGY.OBJECT_IDS;
  return ARCGIS_QUERY_STRATEGY.SINGLE;
};

const choosePageSize = (input, contract, strategy) => {
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

const canonicalize = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value)
    .sort()
    .reduce((accumulator, key) => {
      const item = value[key];
      if (item !== undefined) accumulator[key] = canonicalize(item);
      return accumulator;
    }, {});
};

const fnv1a = (text) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const createArcGisQueryIdentity = (value) => {
  const canonical = JSON.stringify(canonicalize(value));
  return `arcgis-query:${fnv1a(canonical)}:${canonical.length}`;
};

const freezeRequest = (request) => Object.freeze({
  ...request,
  outFields: request.outFields ? Object.freeze([...request.outFields]) : request.outFields,
  outStatistics: request.outStatistics
    ? Object.freeze(request.outStatistics.map((item) => Object.freeze({ ...item })))
    : request.outStatistics,
  groupByFieldsForStatistics: request.groupByFieldsForStatistics
    ? Object.freeze([...request.groupByFieldsForStatistics])
    : request.groupByFieldsForStatistics,
});

export const compileArcGisQueryPlan = (contract = {}, input = {}) => {
  if (!contract || typeof contract !== 'object') {
    throw new SpatialQueryPlannerError('A verified ArcGIS capability contract is required.', {
      code: 'INVALID_CAPABILITY_CONTRACT',
    });
  }
  if (!contract.supportsQuery) {
    throw new SpatialQueryPlannerError('ArcGIS capability contract does not advertise query support.', {
      code: 'QUERY_NOT_SUPPORTED',
      capability: ARCGIS_QUERY_CAPABILITY.QUERY,
    });
  }

  const capabilityAssessment = assessCapabilityContract(contract);
  const geometry = normalizeGeometry(input);
  const orderBy = normalizeOrderBy(input.orderBy, contract);
  const statistics = normalizeStatistics(input.statistics, contract);
  const groupBy = normalizeGroupBy(input.groupBy, contract);
  const time = normalizeTime(input.time, contract);
  const generalization = normalizeGeneralization(input.generalization || {}, contract);
  const strategy = chooseStrategy(contract, statistics);
  const pageSize = choosePageSize(input, contract, strategy);
  const outFields = normalizeOutFields(input, contract);
  const warnings = [];

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
  const request = {
    where: normalizeWhere(input.where),
    outFields,
    returnGeometry: input.returnGeometry !== false,
    returnZ: contract.supportsZ === true && input.returnZ === true,
    returnM: contract.supportsM === true && input.returnM === true,
  };

  if (geometry) {
    request.geometry = geometry.geometry;
    request.geometryType = geometry.geometryType;
    request.inSR = geometry.spatialReference.wkid || geometry.spatialReference.wkt;
    request.spatialRel = normalizeSpatialRelationship(input.spatialRelationship || input.spatialRel);
  }
  if (outSpatialReference) {
    request.outSR = outSpatialReference.wkid || outSpatialReference.wkt;
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
    if (!(contract.queryCapabilities || []).includes(ARCGIS_QUERY_CAPABILITY.DISTINCT)) {
      throw new SpatialQueryPlannerError('Distinct values are not advertised by service metadata.', {
        code: 'DISTINCT_NOT_SUPPORTED',
        capability: ARCGIS_QUERY_CAPABILITY.DISTINCT,
      });
    }
    request.returnDistinctValues = true;
  }
  if (input.returnCentroid === true) {
    if (!(contract.queryCapabilities || []).includes(ARCGIS_QUERY_CAPABILITY.CENTROID)) {
      throw new SpatialQueryPlannerError('Centroid return is not advertised by service metadata.', {
        code: 'CENTROID_NOT_SUPPORTED',
        capability: ARCGIS_QUERY_CAPABILITY.CENTROID,
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
      queryReady: capabilityAssessment.queryReady,
      stableIdentity: capabilityAssessment.stableIdentity,
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

export const createArcGisPageRequest = (plan, page = {}) => {
  if (!plan?.baseRequest || !plan?.strategy) {
    throw new SpatialQueryPlannerError('A compiled ArcGIS query plan is required.', {
      code: 'INVALID_QUERY_PLAN',
    });
  }
  const request = {
    ...plan.baseRequest,
    outFields: [...(plan.baseRequest.outFields || [])],
  };

  if (plan.strategy === ARCGIS_QUERY_STRATEGY.OFFSET) {
    const offset = Math.max(0, Math.floor(finite(page.offset, 0)));
    const count = positiveInteger(page.count, plan.pageSize);
    if (!count) {
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

  throw new SpatialQueryPlannerError(`Unknown ArcGIS query strategy: ${plan.strategy}`, {
    code: 'UNKNOWN_QUERY_STRATEGY',
  });
};

export const createArcGisObjectIdDiscoveryRequest = (plan) => {
  if (!plan?.baseRequest || plan.strategy !== ARCGIS_QUERY_STRATEGY.OBJECT_IDS) {
    throw new SpatialQueryPlannerError('Object-id discovery is only valid for object-id pagination plans.', {
      code: 'OBJECT_ID_DISCOVERY_NOT_APPLICABLE',
    });
  }
  const {
    outFields,
    returnGeometry,
    orderByFields,
    outStatistics,
    groupByFieldsForStatistics,
    resultOffset,
    resultRecordCount,
    ...filters
  } = plan.baseRequest;
  return Object.freeze({
    ...filters,
    returnIdsOnly: true,
    returnGeometry: false,
  });
};
