export const ARCGIS_PAGINATION_STRATEGY = Object.freeze({
  OFFSET: 'offset',
  OBJECT_IDS: 'object-ids',
  SINGLE_PAGE: 'single-page',
} as const);

export type ArcGisPaginationStrategy = typeof ARCGIS_PAGINATION_STRATEGY[keyof typeof ARCGIS_PAGINATION_STRATEGY];

export interface ArcGisPaginationErrorDetails {
  code?: string;
  pageIndex?: number | null;
  cause?: unknown;
}

export class ArcGisPaginationError extends Error {
  readonly code: string;
  readonly pageIndex: number | null;
  override readonly cause: unknown;

  constructor(message: string, details: ArcGisPaginationErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ArcGisPaginationError';
    this.code = details.code ?? 'ARCGIS_PAGINATION_ERROR';
    this.pageIndex = details.pageIndex ?? null;
    this.cause = details.cause;
  }
}

export interface ArcGisPaginationFieldMetadata {
  name?: unknown;
  type?: unknown;
}

export interface ArcGisPaginationMetadata {
  maxRecordCount?: unknown;
  objectIdField?: unknown;
  objectIdFieldName?: unknown;
  objectIdFieldNameFromService?: unknown;
  fields?: readonly ArcGisPaginationFieldMetadata[] | unknown;
  advancedQueryCapabilities?: Record<string, unknown> | unknown;
  advancedQueryCapabilitiesV2?: Record<string, unknown> | unknown;
  supportsPagination?: unknown;
  supportsOrderBy?: unknown;
  supportsStatistics?: unknown;
  supportsReturningQueryExtent?: unknown;
  [key: string]: unknown;
}

export interface ArcGisLayerPaginationCapabilities {
  readonly objectIdField: string | null;
  readonly maxRecordCount: number;
  readonly supportsPagination: boolean;
  readonly supportsOrderBy: boolean;
  readonly supportsStatistics: boolean;
  readonly supportsReturningQueryExtent: boolean;
}

export interface ArcGisPaginationOptions {
  strategy?: ArcGisPaginationStrategy;
  pageSize?: number;
  maxPageSize?: number;
  maxPages?: number;
  maxFeatures?: number;
  signal?: AbortSignal;
}

export interface ArcGisPaginationPlan {
  readonly strategy: ArcGisPaginationStrategy;
  readonly pageSize: number;
  readonly maxPages: number;
  readonly maxFeatures: number;
  readonly objectIdField: string | null;
  readonly orderByFields: readonly string[];
  readonly capabilities: Readonly<ArcGisLayerPaginationCapabilities>;
}

export interface ArcGisFeatureLike {
  attributes?: Record<string, unknown> | null;
  properties?: Record<string, unknown> | null;
  geometry?: unknown;
  [key: string]: unknown;
}

export interface ArcGisPageResult<TFeature extends ArcGisFeatureLike = ArcGisFeatureLike> {
  features?: readonly TFeature[] | null;
  objectIds?: readonly (string | number)[] | null;
  exceededTransferLimit?: boolean;
  [key: string]: unknown;
}

export interface ArcGisPageRequest {
  readonly pageIndex: number;
  readonly resultOffset?: number;
  readonly resultRecordCount: number;
  readonly orderByFields?: readonly string[];
  readonly objectIds?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ArcGisObjectIdRequest {
  readonly signal?: AbortSignal;
}

export type ArcGisPageFetcher<TFeature extends ArcGisFeatureLike = ArcGisFeatureLike> = (
  request: ArcGisPageRequest,
) => Promise<ArcGisPageResult<TFeature>> | ArcGisPageResult<TFeature>;

export type ArcGisObjectIdFetcher = (
  request: ArcGisObjectIdRequest,
) => Promise<ArcGisPageResult> | ArcGisPageResult;

export interface ArcGisMergeOptions {
  objectIdField?: string | null;
  maxFeatures?: number;
}

export interface ArcGisFeatureMergeResult<TFeature extends ArcGisFeatureLike = ArcGisFeatureLike> {
  readonly features: TFeature[];
  readonly duplicates: number;
  readonly truncated: boolean;
  readonly exceededTransferLimit: boolean;
}

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

export interface ArcGisPaginationResult<TFeature extends ArcGisFeatureLike = ArcGisFeatureLike> {
  readonly features: TFeature[];
  readonly exceededTransferLimit: boolean;
  readonly truncated: boolean;
  readonly pages: readonly ArcGisPageResult<TFeature>[];
  readonly pageCount: number;
  readonly plan: Readonly<ArcGisPaginationPlan>;
  readonly metrics: Readonly<ArcGisPaginationMetrics>;
  readonly incomplete: boolean;
  readonly objectIdCount?: number;
}

export interface ExecuteArcGisPaginationInput<TFeature extends ArcGisFeatureLike = ArcGisFeatureLike> {
  metadata?: ArcGisPaginationMetadata;
  fetchPage?: ArcGisPageFetcher<TFeature>;
  fetchObjectIds?: ArcGisObjectIdFetcher;
  options?: ArcGisPaginationOptions;
}

const DEFAULTS = Object.freeze({
  pageSize: 1000,
  maxPageSize: 5000,
  maxPages: 100,
  maxFeatures: 50_000,
});

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

const asRecord = (value: unknown): Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const normalizeObjectIdField = (metadata: ArcGisPaginationMetadata = {}): string | null => {
  const candidates = [
    metadata.objectIdField,
    metadata.objectIdFieldName,
    metadata.objectIdFieldNameFromService,
  ];
  const direct = candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
  if (typeof direct === 'string') return direct.trim();

  const fields = Array.isArray(metadata.fields) ? metadata.fields : [];
  const field = fields.find((candidate) => (
    candidate?.type === 'esriFieldTypeOID' || candidate?.type === 'oid'
  ));
  return typeof field?.name === 'string' && field.name.trim().length > 0 ? field.name.trim() : null;
};

const normalizeAdvancedCapabilities = (metadata: ArcGisPaginationMetadata = {}): Record<string, unknown> => (
  asRecord(metadata.advancedQueryCapabilities ?? metadata.advancedQueryCapabilitiesV2)
);

const supportsPagination = (metadata: ArcGisPaginationMetadata = {}): boolean => {
  const advanced = normalizeAdvancedCapabilities(metadata);
  if (advanced.supportsPagination === true) return true;
  if (advanced.supportsPagination === false) return false;
  return metadata.supportsPagination === true;
};

const supportsOrderBy = (metadata: ArcGisPaginationMetadata = {}): boolean => {
  const advanced = normalizeAdvancedCapabilities(metadata);
  if (advanced.supportsOrderBy === true) return true;
  return metadata.supportsOrderBy === true;
};

const cancelledError = (pageIndex: number | null = null): ArcGisPaginationError => new ArcGisPaginationError(
  'ArcGIS pagination cancelled.',
  { code: 'CANCELLED', pageIndex },
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
  return serialized === undefined ? String(value) : serialized;
};

const stableSerialize = (value: unknown, seen = new WeakSet<object>()): string => {
  if (value === null || typeof value !== 'object') return stablePrimitive(value);
  const record = value as Record<string, unknown>;
  const toJson = record.toJSON;
  if (typeof toJson === 'function') {
    return stableSerialize((toJson as () => unknown).call(value), seen);
  }
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`
    : `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
};

const featureObjectId = (feature: ArcGisFeatureLike | null | undefined, objectIdField: string | null): string | null => {
  if (!feature || !objectIdField) return null;
  const attributes = feature.attributes ?? feature.properties ?? {};
  const raw = attributes[objectIdField];
  if (raw === null || raw === undefined || raw === '') return null;
  return String(raw);
};

const featureKey = (feature: ArcGisFeatureLike, objectIdField: string | null): string => {
  const objectId = featureObjectId(feature, objectIdField);
  if (objectId !== null) return `oid:${objectId}`;
  return `feature:${stableSerialize({
    attributes: feature.attributes ?? feature.properties ?? null,
    geometry: feature.geometry ?? null,
  })}`;
};

const normalizeFeatures = <TFeature extends ArcGisFeatureLike>(
  result: ArcGisPageResult<TFeature> | null | undefined,
): TFeature[] => (
  Array.isArray(result?.features)
    ? result.features.filter((feature): feature is TFeature => Boolean(feature))
    : []
);

const normalizeObjectIds = (result: ArcGisPageResult | null | undefined): Array<string | number> => {
  const values = Array.isArray(result?.objectIds) ? result.objectIds : [];
  return values.filter((value): value is string | number => (
    value !== null && value !== undefined && value !== ''
  ));
};

export const normalizeArcGisLayerPaginationMetadata = (
  metadata: ArcGisPaginationMetadata = {},
): Readonly<ArcGisLayerPaginationCapabilities> => {
  const serviceMaxRecordCount = positiveInteger(
    metadata.maxRecordCount,
    DEFAULTS.pageSize,
    DEFAULTS.maxPageSize,
  );
  const advanced = normalizeAdvancedCapabilities(metadata);
  return Object.freeze({
    objectIdField: normalizeObjectIdField(metadata),
    maxRecordCount: serviceMaxRecordCount,
    supportsPagination: supportsPagination(metadata),
    supportsOrderBy: supportsOrderBy(metadata),
    supportsStatistics: Boolean(advanced.supportsStatistics ?? metadata.supportsStatistics),
    supportsReturningQueryExtent: Boolean(
      advanced.supportsReturningQueryExtent ?? metadata.supportsReturningQueryExtent,
    ),
  });
};

const isStrategy = (value: unknown): value is ArcGisPaginationStrategy => (
  value === ARCGIS_PAGINATION_STRATEGY.OFFSET
  || value === ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS
  || value === ARCGIS_PAGINATION_STRATEGY.SINGLE_PAGE
);

export const createArcGisPaginationPlan = (
  metadata: ArcGisPaginationMetadata = {},
  options: ArcGisPaginationOptions = {},
): Readonly<ArcGisPaginationPlan> => {
  const capabilities = normalizeArcGisLayerPaginationMetadata(metadata);
  const maxPageSize = positiveInteger(options.maxPageSize, DEFAULTS.maxPageSize, 10_000);
  const requestedPageSize = positiveInteger(options.pageSize, capabilities.maxRecordCount, maxPageSize);
  const pageSize = Math.max(1, Math.min(requestedPageSize, capabilities.maxRecordCount, maxPageSize));
  const maxPages = positiveInteger(options.maxPages, DEFAULTS.maxPages, 1_000);
  const maxFeatures = positiveInteger(options.maxFeatures, DEFAULTS.maxFeatures, 500_000);

  let strategy: ArcGisPaginationStrategy = ARCGIS_PAGINATION_STRATEGY.SINGLE_PAGE;
  const requestedStrategy = isStrategy(options.strategy) ? options.strategy : null;
  if (requestedStrategy === ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS && capabilities.objectIdField) {
    strategy = ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS;
  } else if (requestedStrategy === ARCGIS_PAGINATION_STRATEGY.OFFSET && capabilities.supportsPagination) {
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

export const mergeArcGisFeaturePages = <TFeature extends ArcGisFeatureLike>(
  pages: readonly ArcGisPageResult<TFeature>[] = [],
  options: ArcGisMergeOptions = {},
): ArcGisFeatureMergeResult<TFeature> => {
  const objectIdField = options.objectIdField ?? null;
  const maxFeatures = positiveInteger(options.maxFeatures, DEFAULTS.maxFeatures, 500_000);
  const seen = new Set<string>();
  const features: TFeature[] = [];
  let duplicates = 0;
  let exceededTransferLimit = false;

  for (const page of pages) {
    exceededTransferLimit = exceededTransferLimit || page.exceededTransferLimit === true;
    for (const feature of normalizeFeatures(page)) {
      const key = featureKey(feature, objectIdField);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      features.push(feature);
      if (features.length >= maxFeatures) {
        return { features, duplicates, truncated: true, exceededTransferLimit };
      }
    }
  }

  return { features, duplicates, truncated: false, exceededTransferLimit };
};

const pageProgressSignature = <TFeature extends ArcGisFeatureLike>(
  result: ArcGisPageResult<TFeature>,
  objectIdField: string | null,
): string => {
  const features = normalizeFeatures(result);
  const first = features[0];
  const last = features.at(-1);
  if (!first || !last) return 'empty';
  return `${features.length}:${featureKey(first, objectIdField)}:${featureKey(last, objectIdField)}`;
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

const resultEnvelope = <TFeature extends ArcGisFeatureLike>(
  pages: readonly ArcGisPageResult<TFeature>[],
  plan: Readonly<ArcGisPaginationPlan>,
  metrics: ArcGisPaginationMetrics,
  extra: Pick<ArcGisPaginationResult<TFeature>, 'incomplete'> & Partial<Pick<ArcGisPaginationResult<TFeature>, 'objectIdCount'>>,
): ArcGisPaginationResult<TFeature> => {
  const merged = mergeArcGisFeaturePages(pages, {
    objectIdField: plan.objectIdField,
    maxFeatures: plan.maxFeatures,
  });
  metrics.uniqueFeatures = merged.features.length;
  metrics.duplicateFeatures = merged.duplicates;
  const base = {
    features: merged.features,
    exceededTransferLimit: merged.exceededTransferLimit,
    truncated: merged.truncated || metrics.stoppedByLimit,
    pages,
    pageCount: pages.length,
    plan,
    metrics: Object.freeze({ ...metrics }),
    incomplete: extra.incomplete,
  } satisfies Omit<ArcGisPaginationResult<TFeature>, 'objectIdCount'>;
  return extra.objectIdCount === undefined
    ? base
    : { ...base, objectIdCount: extra.objectIdCount };
};

const pageRequest = (
  pageIndex: number,
  resultRecordCount: number,
  options: ArcGisPaginationOptions,
  extra: {
    resultOffset?: number;
    orderByFields?: readonly string[];
    objectIds?: readonly string[];
  } = {},
): ArcGisPageRequest => ({
  pageIndex,
  resultRecordCount,
  ...(extra.resultOffset === undefined ? {} : { resultOffset: extra.resultOffset }),
  ...(extra.orderByFields === undefined ? {} : { orderByFields: extra.orderByFields }),
  ...(extra.objectIds === undefined ? {} : { objectIds: extra.objectIds }),
  ...(options.signal === undefined ? {} : { signal: options.signal }),
});

const executeSinglePage = async <TFeature extends ArcGisFeatureLike>(
  fetchPage: ArcGisPageFetcher<TFeature>,
  plan: Readonly<ArcGisPaginationPlan>,
  options: ArcGisPaginationOptions,
  metrics: ArcGisPaginationMetrics,
): Promise<ArcGisPaginationResult<TFeature>> => {
  throwIfAborted(options.signal, 0);
  metrics.pagesRequested += 1;
  const result = await fetchPage(pageRequest(0, plan.pageSize, options, {
    resultOffset: 0,
    orderByFields: plan.orderByFields,
  }));
  throwIfAborted(options.signal, 0);
  metrics.pagesCompleted += 1;
  metrics.featuresReceived += normalizeFeatures(result).length;
  if (result.exceededTransferLimit === true) metrics.transferLimitPages += 1;
  return resultEnvelope([result], plan, metrics, {
    incomplete: result.exceededTransferLimit === true,
  });
};

const executeOffsetPages = async <TFeature extends ArcGisFeatureLike>(
  fetchPage: ArcGisPageFetcher<TFeature>,
  plan: Readonly<ArcGisPaginationPlan>,
  options: ArcGisPaginationOptions,
  metrics: ArcGisPaginationMetrics,
): Promise<ArcGisPaginationResult<TFeature>> => {
  const pages: ArcGisPageResult<TFeature>[] = [];
  const signatures = new Set<string>();
  let offset = 0;

  for (let pageIndex = 0; pageIndex < plan.maxPages; pageIndex += 1) {
    throwIfAborted(options.signal, pageIndex);
    metrics.pagesRequested += 1;
    const result = await fetchPage(pageRequest(pageIndex, plan.pageSize, options, {
      resultOffset: offset,
      orderByFields: plan.orderByFields,
    }));
    throwIfAborted(options.signal, pageIndex);
    metrics.pagesCompleted += 1;

    const features = normalizeFeatures(result);
    metrics.featuresReceived += features.length;
    if (result.exceededTransferLimit === true) metrics.transferLimitPages += 1;
    pages.push(result);

    const merged = mergeArcGisFeaturePages(pages, {
      objectIdField: plan.objectIdField,
      maxFeatures: plan.maxFeatures,
    });
    if (merged.truncated || merged.features.length >= plan.maxFeatures) {
      metrics.stoppedByLimit = true;
      break;
    }

    if (features.length === 0) break;
    const signature = pageProgressSignature(result, plan.objectIdField);
    if (signatures.has(signature)) {
      metrics.stoppedByNoProgress = true;
      break;
    }
    signatures.add(signature);

    const likelyHasMore = result.exceededTransferLimit === true || features.length >= plan.pageSize;
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

const executeObjectIdPages = async <TFeature extends ArcGisFeatureLike>(
  fetchPage: ArcGisPageFetcher<TFeature>,
  fetchObjectIds: ArcGisObjectIdFetcher,
  plan: Readonly<ArcGisPaginationPlan>,
  options: ArcGisPaginationOptions,
  metrics: ArcGisPaginationMetrics,
): Promise<ArcGisPaginationResult<TFeature>> => {
  throwIfAborted(options.signal, 0);
  const objectIdResult = await fetchObjectIds(
    options.signal === undefined ? {} : { signal: options.signal },
  );
  throwIfAborted(options.signal, 0);
  const objectIds = normalizeObjectIds(objectIdResult);
  const uniqueObjectIds = [...new Set(objectIds.map(String))];
  const limitedObjectIds = uniqueObjectIds.slice(0, plan.maxFeatures);
  const allGroups = chunk(limitedObjectIds, plan.pageSize);
  const groups = allGroups.slice(0, plan.maxPages);
  const pages: ArcGisPageResult<TFeature>[] = [];

  if (uniqueObjectIds.length > limitedObjectIds.length || allGroups.length > plan.maxPages) {
    metrics.stoppedByLimit = true;
  }

  for (let pageIndex = 0; pageIndex < groups.length; pageIndex += 1) {
    throwIfAborted(options.signal, pageIndex);
    const objectIdsForPage = groups[pageIndex];
    if (!objectIdsForPage) break;
    metrics.pagesRequested += 1;
    const result = await fetchPage(pageRequest(pageIndex, objectIdsForPage.length, options, {
      objectIds: objectIdsForPage,
    }));
    throwIfAborted(options.signal, pageIndex);
    metrics.pagesCompleted += 1;
    metrics.featuresReceived += normalizeFeatures(result).length;
    if (result.exceededTransferLimit === true) metrics.transferLimitPages += 1;
    pages.push(result);
  }

  return resultEnvelope(pages, plan, metrics, {
    objectIdCount: uniqueObjectIds.length,
    incomplete: metrics.stoppedByLimit,
  });
};

export const executeArcGisPagination = async <TFeature extends ArcGisFeatureLike = ArcGisFeatureLike>({
  metadata = {},
  fetchPage,
  fetchObjectIds,
  options = {},
}: ExecuteArcGisPaginationInput<TFeature> = {}): Promise<ArcGisPaginationResult<TFeature>> => {
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
