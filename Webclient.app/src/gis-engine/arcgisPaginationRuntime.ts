export const ARCGIS_PAGINATION_STRATEGY = Object.freeze({
  OFFSET: 'offset',
  OBJECT_IDS: 'object-ids',
  SINGLE_PAGE: 'single-page',
} as const);

export type ArcGisPaginationStrategy = typeof ARCGIS_PAGINATION_STRATEGY[keyof typeof ARCGIS_PAGINATION_STRATEGY];

type JsonRecord = Record<string, unknown>;

export interface ArcGisFeatureRecord extends JsonRecord {
  readonly attributes?: JsonRecord;
  readonly properties?: JsonRecord;
  readonly geometry?: unknown;
}

export interface ArcGisPageResult extends JsonRecord {
  readonly features?: readonly ArcGisFeatureRecord[];
  readonly objectIds?: readonly unknown[];
  readonly exceededTransferLimit?: boolean;
}

export interface ArcGisPaginationErrorDetails {
  readonly code?: string;
  readonly pageIndex?: number | null;
  readonly cause?: unknown;
}

export class ArcGisPaginationError extends Error {
  readonly code: string;
  readonly pageIndex: number | null;
  override readonly cause: unknown;

  constructor(message: string, details: ArcGisPaginationErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ArcGisPaginationError';
    this.code = details.code || 'ARCGIS_PAGINATION_ERROR';
    this.pageIndex = details.pageIndex ?? null;
    this.cause = details.cause;
  }
}

export interface ArcGisLayerPaginationMetadata {
  readonly objectIdField: string | null;
  readonly maxRecordCount: number;
  readonly supportsPagination: boolean;
  readonly supportsOrderBy: boolean;
  readonly supportsStatistics: boolean;
  readonly supportsReturningQueryExtent: boolean;
}

export interface ArcGisPaginationOptions {
  readonly strategy?: ArcGisPaginationStrategy;
  readonly pageSize?: number;
  readonly maxPageSize?: number;
  readonly maxPages?: number;
  readonly maxFeatures?: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ArcGisPaginationPlan {
  readonly strategy: ArcGisPaginationStrategy;
  readonly pageSize: number;
  readonly maxPages: number;
  readonly maxFeatures: number;
  readonly objectIdField: string | null;
  readonly orderByFields: readonly string[];
  readonly capabilities: ArcGisLayerPaginationMetadata;
}

export interface ArcGisPaginationRequest {
  readonly pageIndex: number;
  readonly resultOffset?: number;
  readonly resultRecordCount: number;
  readonly orderByFields?: readonly string[];
  readonly objectIds?: readonly string[];
  readonly signal?: AbortSignal | undefined;
}

export interface ArcGisObjectIdRequest {
  readonly signal?: AbortSignal | undefined;
}

export type ArcGisPageFetcher = (
  request: ArcGisPaginationRequest,
) => Promise<ArcGisPageResult | null | undefined>;

export type ArcGisObjectIdFetcher = (
  request: ArcGisObjectIdRequest,
) => Promise<ArcGisPageResult | null | undefined>;

export interface ArcGisPaginationMetrics {
  strategy: ArcGisPaginationStrategy;
  pagesRequested: number;
  pagesCompleted: number;
  featuresReceived: number;
  uniqueFeatures: number;
  duplicateFeatures: number;
  transferLimitPages: number;
  stoppedByLimit: boolean;
  stoppedByNoProgress: boolean;
}

export interface ArcGisMergedPages {
  readonly features: ArcGisFeatureRecord[];
  readonly duplicates: number;
  readonly truncated: boolean;
  readonly exceededTransferLimit: boolean;
}

export interface ArcGisPaginationResult {
  readonly features: ArcGisFeatureRecord[];
  readonly exceededTransferLimit: boolean;
  readonly truncated: boolean;
  readonly pages: ArcGisPageResult[];
  readonly pageCount: number;
  readonly plan: ArcGisPaginationPlan;
  readonly metrics: ArcGisPaginationMetrics;
  readonly incomplete: boolean;
  readonly objectIdCount?: number;
}

export interface ExecuteArcGisPaginationInput {
  readonly metadata?: JsonRecord;
  readonly fetchPage?: ArcGisPageFetcher;
  readonly fetchObjectIds?: ArcGisObjectIdFetcher;
  readonly options?: ArcGisPaginationOptions;
}

const DEFAULTS = Object.freeze({
  pageSize: 1000,
  maxPageSize: 5000,
  maxPages: 100,
  maxFeatures: 50000,
});

const asRecord = (value: unknown): JsonRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
);

const finite = (value: unknown, fallback: number | null = null): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const numeric = finite(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const normalizeObjectIdField = (metadata: JsonRecord = {}): string | null => {
  const candidates = [
    metadata.objectIdField,
    metadata.objectIdFieldName,
    metadata.objectIdFieldNameFromService,
  ];
  const direct = candidates.find((value) => typeof value === 'string' && value.trim());
  if (typeof direct === 'string') return direct.trim();

  const fields = Array.isArray(metadata.fields) ? metadata.fields : [];
  const field = fields
    .map(asRecord)
    .find((candidate) => candidate.type === 'esriFieldTypeOID' || candidate.type === 'oid');
  return typeof field?.name === 'string' ? field.name.trim() : null;
};

const normalizeAdvancedCapabilities = (metadata: JsonRecord = {}): JsonRecord => asRecord(
  metadata.advancedQueryCapabilities ?? metadata.advancedQueryCapabilitiesV2,
);

const supportsPagination = (metadata: JsonRecord = {}): boolean => {
  const advanced = normalizeAdvancedCapabilities(metadata);
  if (advanced.supportsPagination === true) return true;
  if (advanced.supportsPagination === false) return false;
  return metadata.supportsPagination === true;
};

const supportsOrderBy = (metadata: JsonRecord = {}): boolean => {
  const advanced = normalizeAdvancedCapabilities(metadata);
  if (advanced.supportsOrderBy === true) return true;
  return metadata.supportsOrderBy === true;
};

const cancelledError = (pageIndex: number | null = null): ArcGisPaginationError => (
  new ArcGisPaginationError('ArcGIS pagination cancelled.', {
    code: 'CANCELLED',
    pageIndex,
  })
);

const throwIfAborted = (signal: AbortSignal | undefined, pageIndex: number | null = null): void => {
  if (signal?.aborted) throw cancelledError(pageIndex);
};

const stablePrimitive = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const serialized = JSON.stringify(value);
  return serialized === undefined ? JSON.stringify(String(value)) : serialized;
};

const stableSerialize = (value: unknown, seen = new WeakSet<object>()): string => {
  if (value === null || typeof value !== 'object') return stablePrimitive(value);
  const objectValue = value as object;
  const record = asRecord(value);
  const toJSON = record.toJSON;
  if (typeof toJSON === 'function') {
    return stableSerialize((toJSON as () => unknown).call(value), seen);
  }
  if (seen.has(objectValue)) return '"[Circular]"';
  seen.add(objectValue);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`
    : `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`)
      .join(',')}}`;
  seen.delete(objectValue);
  return result;
};

const featureObjectId = (
  feature: ArcGisFeatureRecord | null | undefined,
  objectIdField: string | null,
): string | null => {
  if (!feature || !objectIdField) return null;
  const attributes = asRecord(feature.attributes ?? feature.properties);
  const raw = attributes[objectIdField];
  if (raw === null || raw === undefined || raw === '') return null;
  return String(raw);
};

const featureKey = (feature: ArcGisFeatureRecord, objectIdField: string | null): string => {
  const objectId = featureObjectId(feature, objectIdField);
  if (objectId !== null) return `oid:${objectId}`;
  return `feature:${stableSerialize({
    attributes: feature.attributes ?? feature.properties ?? null,
    geometry: feature.geometry ?? null,
  })}`;
};

const normalizeFeatures = (result: ArcGisPageResult | null | undefined): ArcGisFeatureRecord[] => {
  if (!Array.isArray(result?.features)) return [];
  return result.features.filter((feature): feature is ArcGisFeatureRecord => Boolean(feature));
};

const normalizeObjectIds = (result: ArcGisPageResult | null | undefined): unknown[] => {
  const values = Array.isArray(result?.objectIds) ? result.objectIds : [];
  return values.filter((value) => value !== null && value !== undefined && value !== '');
};

export const normalizeArcGisLayerPaginationMetadata = (
  metadata: JsonRecord = {},
): ArcGisLayerPaginationMetadata => {
  const serviceMaxRecordCount = positiveInteger(
    metadata.maxRecordCount,
    DEFAULTS.pageSize,
    DEFAULTS.maxPageSize,
  );
  const objectIdField = normalizeObjectIdField(metadata);
  const advanced = normalizeAdvancedCapabilities(metadata);
  return Object.freeze({
    objectIdField,
    maxRecordCount: serviceMaxRecordCount,
    supportsPagination: supportsPagination(metadata),
    supportsOrderBy: supportsOrderBy(metadata),
    supportsStatistics: Boolean(advanced.supportsStatistics ?? metadata.supportsStatistics),
    supportsReturningQueryExtent: Boolean(
      advanced.supportsReturningQueryExtent ?? metadata.supportsReturningQueryExtent,
    ),
  });
};

export const createArcGisPaginationPlan = (
  metadata: JsonRecord = {},
  options: ArcGisPaginationOptions = {},
): ArcGisPaginationPlan => {
  const capabilities = normalizeArcGisLayerPaginationMetadata(metadata);
  const maxPageSize = positiveInteger(options.maxPageSize, DEFAULTS.maxPageSize, 10000);
  const requestedPageSize = positiveInteger(options.pageSize, capabilities.maxRecordCount, maxPageSize);
  const pageSize = Math.max(1, Math.min(requestedPageSize, capabilities.maxRecordCount, maxPageSize));
  const maxPages = positiveInteger(options.maxPages, DEFAULTS.maxPages, 1000);
  const maxFeatures = positiveInteger(options.maxFeatures, DEFAULTS.maxFeatures, 500000);

  let strategy: ArcGisPaginationStrategy = ARCGIS_PAGINATION_STRATEGY.SINGLE_PAGE;
  if (options.strategy === ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS && capabilities.objectIdField) {
    strategy = ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS;
  } else if (options.strategy === ARCGIS_PAGINATION_STRATEGY.OFFSET && capabilities.supportsPagination) {
    strategy = ARCGIS_PAGINATION_STRATEGY.OFFSET;
  } else if (capabilities.supportsPagination) {
    strategy = ARCGIS_PAGINATION_STRATEGY.OFFSET;
  } else if (capabilities.objectIdField) {
    strategy = ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS;
  }

  const orderByFields = strategy === ARCGIS_PAGINATION_STRATEGY.OFFSET
    && capabilities.supportsOrderBy
    && capabilities.objectIdField
    ? Object.freeze([`${capabilities.objectIdField} ASC`])
    : Object.freeze([] as string[]);

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

export const mergeArcGisFeaturePages = (
  pages: readonly (ArcGisPageResult | null | undefined)[] = [],
  options: { readonly objectIdField?: string | null; readonly maxFeatures?: number } = {},
): ArcGisMergedPages => {
  const objectIdField = options.objectIdField ?? null;
  const maxFeatures = positiveInteger(options.maxFeatures, DEFAULTS.maxFeatures, 500000);
  const seen = new Set<string>();
  const features: ArcGisFeatureRecord[] = [];
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

const pageProgressSignature = (
  result: ArcGisPageResult | null | undefined,
  objectIdField: string | null,
): string => {
  const features = normalizeFeatures(result);
  if (!features.length) return 'empty';
  const firstFeature = features[0];
  const lastFeature = features[features.length - 1];
  if (!firstFeature || !lastFeature) return 'empty';
  return `${features.length}:${featureKey(firstFeature, objectIdField)}:${featureKey(lastFeature, objectIdField)}`;
};

const createMetrics = (plan: ArcGisPaginationPlan): ArcGisPaginationMetrics => ({
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

const resultEnvelope = (
  pages: ArcGisPageResult[],
  plan: ArcGisPaginationPlan,
  metrics: ArcGisPaginationMetrics,
  extra: { readonly incomplete?: boolean; readonly objectIdCount?: number } = {},
): ArcGisPaginationResult => {
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
    incomplete: extra.incomplete === true,
    ...(extra.objectIdCount === undefined ? {} : { objectIdCount: extra.objectIdCount }),
  };
};

const executeSinglePage = async (
  fetchPage: ArcGisPageFetcher,
  plan: ArcGisPaginationPlan,
  options: ArcGisPaginationOptions,
  metrics: ArcGisPaginationMetrics,
): Promise<ArcGisPaginationResult> => {
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
  const page = result ?? {};
  metrics.pagesCompleted += 1;
  metrics.featuresReceived += normalizeFeatures(page).length;
  if (page.exceededTransferLimit === true) metrics.transferLimitPages += 1;
  return resultEnvelope([page], plan, metrics, {
    incomplete: page.exceededTransferLimit === true,
  });
};

const executeOffsetPages = async (
  fetchPage: ArcGisPageFetcher,
  plan: ArcGisPaginationPlan,
  options: ArcGisPaginationOptions,
  metrics: ArcGisPaginationMetrics,
): Promise<ArcGisPaginationResult> => {
  const pages: ArcGisPageResult[] = [];
  const signatures = new Set<string>();
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
    const page = result ?? {};
    metrics.pagesCompleted += 1;

    const features = normalizeFeatures(page);
    metrics.featuresReceived += features.length;
    if (page.exceededTransferLimit === true) metrics.transferLimitPages += 1;
    pages.push(page);

    const merged = mergeArcGisFeaturePages(pages, {
      objectIdField: plan.objectIdField,
      maxFeatures: plan.maxFeatures,
    });
    if (merged.truncated || merged.features.length >= plan.maxFeatures) {
      metrics.stoppedByLimit = true;
      break;
    }

    if (!features.length) break;
    const signature = pageProgressSignature(page, plan.objectIdField);
    if (signatures.has(signature)) {
      metrics.stoppedByNoProgress = true;
      break;
    }
    signatures.add(signature);

    const likelyHasMore = page.exceededTransferLimit === true || features.length >= plan.pageSize;
    if (!likelyHasMore) break;
    offset += features.length;
  }

  if (pages.length >= plan.maxPages) metrics.stoppedByLimit = true;
  return resultEnvelope(pages, plan, metrics, {
    incomplete: metrics.stoppedByLimit || metrics.stoppedByNoProgress,
  });
};

const chunk = <T>(values: readonly T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
};

const executeObjectIdPages = async (
  fetchPage: ArcGisPageFetcher,
  fetchObjectIds: ArcGisObjectIdFetcher,
  plan: ArcGisPaginationPlan,
  options: ArcGisPaginationOptions,
  metrics: ArcGisPaginationMetrics,
): Promise<ArcGisPaginationResult> => {
  throwIfAborted(options.signal, 0);
  const objectIdResult = await fetchObjectIds({ signal: options.signal });
  throwIfAborted(options.signal, 0);
  const objectIds = normalizeObjectIds(objectIdResult);
  const uniqueObjectIds = [...new Set(objectIds.map(String))];
  const limitedObjectIds = uniqueObjectIds.slice(0, plan.maxFeatures);
  const allGroups = chunk(limitedObjectIds, plan.pageSize);
  const groups = allGroups.slice(0, plan.maxPages);
  const pages: ArcGisPageResult[] = [];

  if (uniqueObjectIds.length > limitedObjectIds.length || allGroups.length > plan.maxPages) {
    metrics.stoppedByLimit = true;
  }

  for (let pageIndex = 0; pageIndex < groups.length; pageIndex += 1) {
    throwIfAborted(options.signal, pageIndex);
    const objectIdsForPage = groups[pageIndex] ?? [];
    metrics.pagesRequested += 1;
    const result = await fetchPage({
      pageIndex,
      objectIds: objectIdsForPage,
      resultRecordCount: objectIdsForPage.length,
      signal: options.signal,
    });
    throwIfAborted(options.signal, pageIndex);
    const page = result ?? {};
    metrics.pagesCompleted += 1;
    metrics.featuresReceived += normalizeFeatures(page).length;
    if (page.exceededTransferLimit === true) metrics.transferLimitPages += 1;
    pages.push(page);
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
}: ExecuteArcGisPaginationInput = {}): Promise<ArcGisPaginationResult> => {
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
        const fallbackPlan = Object.freeze({
          ...plan,
          strategy: ARCGIS_PAGINATION_STRATEGY.OFFSET,
        });
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
