export const ARCGIS_PAGINATION_STRATEGY = Object.freeze({
  OFFSET: 'offset',
  OBJECT_IDS: 'object-ids',
  SINGLE_PAGE: 'single-page',
});

export class ArcGisPaginationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ArcGisPaginationError';
    this.code = details.code || 'ARCGIS_PAGINATION_ERROR';
    this.pageIndex = details.pageIndex ?? null;
    this.cause = details.cause;
  }
}

const DEFAULTS = Object.freeze({
  pageSize: 1000,
  maxPageSize: 5000,
  maxPages: 100,
  maxFeatures: 50000,
});

const finite = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = finite(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const normalizeObjectIdField = (metadata = {}) => {
  const candidates = [
    metadata.objectIdField,
    metadata.objectIdFieldName,
    metadata.objectIdFieldNameFromService,
  ];
  const direct = candidates.find((value) => typeof value === 'string' && value.trim());
  if (direct) return direct.trim();

  const field = (metadata.fields || []).find((candidate) => (
    candidate?.type === 'esriFieldTypeOID' || candidate?.type === 'oid'
  ));
  return typeof field?.name === 'string' ? field.name.trim() : null;
};

const normalizeAdvancedCapabilities = (metadata = {}) => (
  metadata.advancedQueryCapabilities || metadata.advancedQueryCapabilitiesV2 || {}
);

const supportsPagination = (metadata = {}) => {
  const advanced = normalizeAdvancedCapabilities(metadata);
  if (advanced.supportsPagination === true) return true;
  if (advanced.supportsPagination === false) return false;
  return metadata.supportsPagination === true;
};

const supportsOrderBy = (metadata = {}) => {
  const advanced = normalizeAdvancedCapabilities(metadata);
  if (advanced.supportsOrderBy === true) return true;
  return metadata.supportsOrderBy === true;
};

const cancelledError = (pageIndex = null) => new ArcGisPaginationError('ArcGIS pagination cancelled.', {
  code: 'CANCELLED',
  pageIndex,
});

const throwIfAborted = (signal, pageIndex = null) => {
  if (signal?.aborted) throw cancelledError(pageIndex);
};

const stablePrimitive = (value) => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  return JSON.stringify(value);
};

const stableSerialize = (value, seen = new WeakSet()) => {
  if (value === null || typeof value !== 'object') return stablePrimitive(value);
  if (typeof value.toJSON === 'function') return stableSerialize(value.toJSON(), seen);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
};

const featureObjectId = (feature, objectIdField) => {
  if (!feature || !objectIdField) return null;
  const attributes = feature.attributes || feature.properties || {};
  const raw = attributes[objectIdField];
  if (raw === null || raw === undefined || raw === '') return null;
  return String(raw);
};

const featureKey = (feature, objectIdField) => {
  const objectId = featureObjectId(feature, objectIdField);
  if (objectId !== null) return `oid:${objectId}`;
  return `feature:${stableSerialize({
    attributes: feature?.attributes || feature?.properties || null,
    geometry: feature?.geometry || null,
  })}`;
};

const normalizeFeatures = (result) => {
  if (Array.isArray(result?.features)) return result.features.filter(Boolean);
  return [];
};

const normalizeObjectIds = (result) => {
  const values = Array.isArray(result?.objectIds) ? result.objectIds : [];
  return values.filter((value) => value !== null && value !== undefined && value !== '');
};

export const normalizeArcGisLayerPaginationMetadata = (metadata = {}) => {
  const serviceMaxRecordCount = positiveInteger(
    metadata.maxRecordCount,
    DEFAULTS.pageSize,
    DEFAULTS.maxPageSize,
  );
  const objectIdField = normalizeObjectIdField(metadata);
  return Object.freeze({
    objectIdField,
    maxRecordCount: serviceMaxRecordCount,
    supportsPagination: supportsPagination(metadata),
    supportsOrderBy: supportsOrderBy(metadata),
    supportsStatistics: Boolean(normalizeAdvancedCapabilities(metadata).supportsStatistics ?? metadata.supportsStatistics),
    supportsReturningQueryExtent: Boolean(
      normalizeAdvancedCapabilities(metadata).supportsReturningQueryExtent ?? metadata.supportsReturningQueryExtent,
    ),
  });
};

export const createArcGisPaginationPlan = (metadata = {}, options = {}) => {
  const capabilities = normalizeArcGisLayerPaginationMetadata(metadata);
  const maxPageSize = positiveInteger(options.maxPageSize, DEFAULTS.maxPageSize, 10000);
  const requestedPageSize = positiveInteger(options.pageSize, capabilities.maxRecordCount, maxPageSize);
  const pageSize = Math.max(1, Math.min(requestedPageSize, capabilities.maxRecordCount, maxPageSize));
  const maxPages = positiveInteger(options.maxPages, DEFAULTS.maxPages, 1000);
  const maxFeatures = positiveInteger(options.maxFeatures, DEFAULTS.maxFeatures, 500000);

  let strategy = ARCGIS_PAGINATION_STRATEGY.SINGLE_PAGE;
  if (options.strategy === ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS && capabilities.objectIdField) {
    strategy = ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS;
  } else if (options.strategy === ARCGIS_PAGINATION_STRATEGY.OFFSET && capabilities.supportsPagination) {
    strategy = ARCGIS_PAGINATION_STRATEGY.OFFSET;
  } else if (capabilities.supportsPagination) {
    strategy = ARCGIS_PAGINATION_STRATEGY.OFFSET;
  } else if (capabilities.objectIdField) {
    strategy = ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS;
  }

  const orderByFields = strategy === ARCGIS_PAGINATION_STRATEGY.OFFSET && capabilities.supportsOrderBy && capabilities.objectIdField
    ? [`${capabilities.objectIdField} ASC`]
    : [];

  return Object.freeze({
    strategy,
    pageSize,
    maxPages,
    maxFeatures,
    objectIdField: capabilities.objectIdField,
    orderByFields,
    capabilities,
  });
};

export const mergeArcGisFeaturePages = (pages = [], options = {}) => {
  const objectIdField = options.objectIdField || null;
  const maxFeatures = positiveInteger(options.maxFeatures, DEFAULTS.maxFeatures, 500000);
  const seen = new Set();
  const features = [];
  let duplicates = 0;
  let exceededTransferLimit = false;

  for (const page of pages) {
    exceededTransferLimit = exceededTransferLimit || page?.exceededTransferLimit === true;
    for (const feature of normalizeFeatures(page)) {
      const key = featureKey(feature, objectIdField);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      features.push(feature);
      if (features.length >= maxFeatures) {
        return {
          features,
          duplicates,
          truncated: true,
          exceededTransferLimit,
        };
      }
    }
  }

  return {
    features,
    duplicates,
    truncated: false,
    exceededTransferLimit,
  };
};

const pageProgressSignature = (result, objectIdField) => {
  const features = normalizeFeatures(result);
  if (!features.length) return 'empty';
  const first = featureKey(features[0], objectIdField);
  const last = featureKey(features[features.length - 1], objectIdField);
  return `${features.length}:${first}:${last}`;
};

const createMetrics = (plan) => ({
  strategy: plan.strategy,
  pagesRequested: 0,
  pagesCompleted: 0,
  featuresReceived: 0,
  uniqueFeatures: 0,
  duplicateFeatures: 0,
  transferLimitPages: 0,
  stoppedByLimit: false,
  stoppedByNoProgress: false,
});

const resultEnvelope = (pages, plan, metrics, extra = {}) => {
  const merged = mergeArcGisFeaturePages(pages, {
    objectIdField: plan.objectIdField,
    maxFeatures: plan.maxFeatures,
  });
  metrics.uniqueFeatures = merged.features.length;
  metrics.duplicateFeatures = merged.duplicates;
  return {
    features: merged.features,
    exceededTransferLimit: merged.exceededTransferLimit,
    truncated: merged.truncated || metrics.stoppedByLimit,
    pages,
    pageCount: pages.length,
    plan,
    metrics: { ...metrics },
    ...extra,
  };
};

const executeSinglePage = async (fetchPage, plan, options, metrics) => {
  throwIfAborted(options.signal, 0);
  metrics.pagesRequested += 1;
  const result = await fetchPage({
    pageIndex: 0,
    resultOffset: 0,
    resultRecordCount: plan.pageSize,
    orderByFields: plan.orderByFields,
    signal: options.signal,
  });
  throwIfAborted(options.signal, 0);
  metrics.pagesCompleted += 1;
  metrics.featuresReceived += normalizeFeatures(result).length;
  if (result?.exceededTransferLimit === true) metrics.transferLimitPages += 1;
  return resultEnvelope([result || {}], plan, metrics, {
    incomplete: result?.exceededTransferLimit === true,
  });
};

const executeOffsetPages = async (fetchPage, plan, options, metrics) => {
  const pages = [];
  const signatures = new Set();
  let offset = 0;

  for (let pageIndex = 0; pageIndex < plan.maxPages; pageIndex += 1) {
    throwIfAborted(options.signal, pageIndex);
    metrics.pagesRequested += 1;
    const result = await fetchPage({
      pageIndex,
      resultOffset: offset,
      resultRecordCount: plan.pageSize,
      orderByFields: plan.orderByFields,
      signal: options.signal,
    });
    throwIfAborted(options.signal, pageIndex);
    metrics.pagesCompleted += 1;

    const features = normalizeFeatures(result);
    metrics.featuresReceived += features.length;
    if (result?.exceededTransferLimit === true) metrics.transferLimitPages += 1;
    pages.push(result || {});

    const merged = mergeArcGisFeaturePages(pages, {
      objectIdField: plan.objectIdField,
      maxFeatures: plan.maxFeatures,
    });
    if (merged.truncated || merged.features.length >= plan.maxFeatures) {
      metrics.stoppedByLimit = true;
      break;
    }

    if (!features.length) break;
    const signature = pageProgressSignature(result, plan.objectIdField);
    if (signatures.has(signature)) {
      metrics.stoppedByNoProgress = true;
      break;
    }
    signatures.add(signature);

    const likelyHasMore = result?.exceededTransferLimit === true || features.length >= plan.pageSize;
    if (!likelyHasMore) break;
    offset += features.length;
  }

  if (pages.length >= plan.maxPages) metrics.stoppedByLimit = true;
  return resultEnvelope(pages, plan, metrics, {
    incomplete: metrics.stoppedByLimit || metrics.stoppedByNoProgress,
  });
};

const chunk = (values, size) => {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
};

const executeObjectIdPages = async (fetchPage, fetchObjectIds, plan, options, metrics) => {
  throwIfAborted(options.signal, 0);
  const objectIdResult = await fetchObjectIds({ signal: options.signal });
  throwIfAborted(options.signal, 0);
  const objectIds = normalizeObjectIds(objectIdResult);
  const uniqueObjectIds = [...new Set(objectIds.map(String))];
  const limitedObjectIds = uniqueObjectIds.slice(0, plan.maxFeatures);
  const groups = chunk(limitedObjectIds, plan.pageSize).slice(0, plan.maxPages);
  const pages = [];

  if (uniqueObjectIds.length > limitedObjectIds.length || chunk(limitedObjectIds, plan.pageSize).length > plan.maxPages) {
    metrics.stoppedByLimit = true;
  }

  for (let pageIndex = 0; pageIndex < groups.length; pageIndex += 1) {
    throwIfAborted(options.signal, pageIndex);
    const objectIdsForPage = groups[pageIndex];
    metrics.pagesRequested += 1;
    const result = await fetchPage({
      pageIndex,
      objectIds: objectIdsForPage,
      resultRecordCount: objectIdsForPage.length,
      signal: options.signal,
    });
    throwIfAborted(options.signal, pageIndex);
    metrics.pagesCompleted += 1;
    metrics.featuresReceived += normalizeFeatures(result).length;
    if (result?.exceededTransferLimit === true) metrics.transferLimitPages += 1;
    pages.push(result || {});
  }

  return resultEnvelope(pages, plan, metrics, {
    objectIdCount: uniqueObjectIds.length,
    incomplete: metrics.stoppedByLimit,
  });
};

export const executeArcGisPagination = async ({
  metadata = {},
  fetchPage,
  fetchObjectIds,
  options = {},
} = {}) => {
  if (typeof fetchPage !== 'function') {
    throw new ArcGisPaginationError('A fetchPage adapter is required.', { code: 'INVALID_FETCH_PAGE' });
  }

  const plan = createArcGisPaginationPlan(metadata, options);
  const metrics = createMetrics(plan);

  if (plan.strategy === ARCGIS_PAGINATION_STRATEGY.SINGLE_PAGE) {
    return executeSinglePage(fetchPage, plan, options, metrics);
  }

  if (plan.strategy === ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS) {
    if (typeof fetchObjectIds !== 'function') {
      if (plan.capabilities.supportsPagination) {
        const fallbackPlan = Object.freeze({ ...plan, strategy: ARCGIS_PAGINATION_STRATEGY.OFFSET });
        return executeOffsetPages(fetchPage, fallbackPlan, options, createMetrics(fallbackPlan));
      }
      throw new ArcGisPaginationError('Object-id pagination requires a fetchObjectIds adapter.', {
        code: 'INVALID_FETCH_OBJECT_IDS',
      });
    }
    return executeObjectIdPages(fetchPage, fetchObjectIds, plan, options, metrics);
  }

  return executeOffsetPages(fetchPage, plan, options, metrics);
};
