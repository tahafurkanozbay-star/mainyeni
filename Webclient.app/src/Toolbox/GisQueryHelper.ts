import { loadArcgisModules as loadModules } from '../gis-engine/arcgisModuleRuntime';
import { Constants_ServiceResultType } from '../Core/Constants';
import { stableQueryKey } from '../gis-engine/spatialEngine';
import {
  createArcGisQueryCachePolicy,
  createQueryRuntime,
  createQueryRuntimeKey,
  type QueryRuntimeConfiguration,
} from '../gis-engine/queryRuntime';
import {
  type ArcGisFeatureSet,
  type ArcGisField,
  type ArcGisQueryOptions,
  type UnknownRecord,
  isRecord,
} from '../Business/contracts';
import {
  type LegacyGisCountSuccess,
  type LegacyGisFailure,
  type LegacyGisResult,
  type LegacyGisSuccess,
  type LegacyQueryDataItem,
  type LegacyQueryPage,
} from '../Business/legacyServiceContracts';

const DEFAULT_PAGE_SIZE = 1_000;
const MAX_PAGE_SIZE = 2_000;
const DEFAULT_MAX_RECORDS = 10_000;
const MAX_ALL_RECORDS = 100_000;
const QUERY_MODULE_IDS = Object.freeze([
  'esri/tasks/QueryTask',
  'esri/tasks/support/Query',
]);

export interface GisQueryOptions extends ArcGisQueryOptions {
  readonly signal?: AbortSignal;
  readonly cache?: boolean;
  readonly live?: boolean;
  readonly ttlMs?: number;
  readonly cacheTags?: readonly unknown[];
  readonly pageSize?: number;
  readonly maxRecords?: number;
  readonly returnDistinctValues?: boolean;
}

interface QueryTaskLike {
  execute(
    query: unknown,
    requestOptions?: Readonly<{ signal: AbortSignal }>,
  ): Promise<ArcGisFeatureSet>;
  executeForCount?(
    query: unknown,
    requestOptions?: Readonly<{ signal: AbortSignal }>,
  ): Promise<number>;
  executeForIds?(
    query: unknown,
    requestOptions?: Readonly<{ signal: AbortSignal }>,
  ): Promise<readonly unknown[] | null>;
}

type QueryTaskConstructor = new (
  options: Readonly<{ url: string }>,
) => QueryTaskLike;

type QueryConstructor = new (
  options: Readonly<Record<string, unknown>>,
) => unknown;

type QueryModules = readonly [QueryTaskConstructor, QueryConstructor];

interface AggregateMetadata {
  readonly fields: readonly ArcGisField[];
  readonly geometryType: unknown;
  readonly spatialReference: unknown;
}

let queryModulesPromise: Promise<QueryModules> | null = null;
const queryRuntime = createQueryRuntime({
  ttlMs: 30_000,
  maxEntries: 128,
  maxBytes: 8 * 1024 * 1024,
});

const normalizeUrl = (value: unknown): string => String(value ?? '').trim();

const loadQueryModules = (): Promise<QueryModules> => {
  if (!queryModulesPromise) {
    queryModulesPromise = loadModules<QueryModules>(QUERY_MODULE_IDS).catch((error: unknown) => {
      queryModulesPromise = null;
      throw error;
    });
  }
  return queryModulesPromise;
};

const cancelledError = (): Error => Object.assign(
  new Error('GIS query cancelled.'),
  { code: 'CANCELLED' },
);

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw cancelledError();
};

const toNonNegativeInteger = (
  value: unknown,
  fallback: number | null = null,
): number | null => {
  if (value === null || value === undefined || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
};

const toBoundedPositiveInteger = (
  value: unknown,
  fallback: number,
  maximum: number,
): number => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(number)));
};

const toArray = <TValue>(value: unknown): readonly TValue[] =>
  Array.isArray(value) ? value as readonly TValue[] : Object.freeze([]);

const attributes = (value: unknown): UnknownRecord | null =>
  isRecord(value) ? value : null;

const toServiceResult = (
  response: ArcGisFeatureSet | null | undefined,
  options: GisQueryOptions = { url: '' },
): LegacyGisSuccess => {
  const resultOffset = toNonNegativeInteger(options.resultOffset, 0) ?? 0;
  const features = toArray(response?.features);
  const data: LegacyQueryDataItem[] = features.map((feature) => Object.freeze({
    attr: attributes(feature?.attributes),
    geometry: feature?.geometry ?? null,
  }));
  const exceededTransferLimit = response?.exceededTransferLimit === true;
  const hasMore = exceededTransferLimit && data.length > 0;

  const page: LegacyQueryPage = Object.freeze({
    offset: resultOffset,
    count: data.length,
    hasMore,
    nextOffset: hasMore ? resultOffset + data.length : null,
  });

  return Object.freeze({
    type: Constants_ServiceResultType.Success as 10,
    data: Object.freeze(data),
    fields: Object.freeze([...toArray<ArcGisField>(response?.fields)]),
    exceededTransferLimit,
    geometryType: isRecord(response) ? response.geometryType ?? null : null,
    spatialReference: response?.spatialReference ?? null,
    page,
  });
};

const toCountResult = (count: unknown): LegacyGisCountSuccess => {
  const normalized = typeof count === 'number' && Number.isFinite(count)
    ? Math.max(0, Math.trunc(count))
    : 0;
  return Object.freeze({
    type: Constants_ServiceResultType.Success as 10,
    data: normalized,
    count: normalized,
    fields: Object.freeze([]),
    exceededTransferLimit: false,
    page: null,
  });
};

const toErrorResult = (error: unknown): LegacyGisFailure => Object.freeze({
  error,
  type: Constants_ServiceResultType.Error as 20,
  data: null,
  fields: null,
});

const createQueryOptions = (
  options: GisQueryOptions,
  spatial = false,
): Readonly<Record<string, unknown>> => {
  const resultOffset = toNonNegativeInteger(options.resultOffset);
  const resultRecordCount = toNonNegativeInteger(options.resultRecordCount);

  if (spatial) {
    const queryOptions: Record<string, unknown> = { ...options };
    delete queryOptions.url;
    delete queryOptions.signal;
    delete queryOptions.cache;
    delete queryOptions.live;
    delete queryOptions.ttlMs;
    delete queryOptions.cacheTags;
    delete queryOptions.pageSize;
    delete queryOptions.maxRecords;
    if (resultOffset === null) delete queryOptions.resultOffset;
    else queryOptions.resultOffset = resultOffset;
    if (resultRecordCount === null) delete queryOptions.resultRecordCount;
    else queryOptions.resultRecordCount = resultRecordCount;
    return queryOptions;
  }

  return Object.freeze({
    returnDistinctValues: options.returnDistinctValues === true,
    orderByFields: options.orderByFields ?? null,
    returnGeometry: options.returnGeometry === true,
    outFields: options.outFields ?? Object.freeze(['*']),
    where: options.where ?? '1=1',
    ...(resultOffset === null ? {} : { resultOffset }),
    ...(resultRecordCount === null ? {} : { resultRecordCount }),
  });
};

const createRuntimeKey = (
  options: GisQueryOptions,
  spatial: boolean,
  operation = 'features',
): string => createQueryRuntimeKey({
  serviceUrl: normalizeUrl(options.url),
  operation,
  queryKey: stableQueryKey({
    spatial,
    query: createQueryOptions(options, spatial),
  }),
});

const createRuntimeOptions = (
  options: GisQueryOptions,
  tags: readonly string[] = [],
) => ({
  ...(options.signal ? { signal: options.signal } : {}),
  ...createArcGisQueryCachePolicy({
    cache: options.cache === true && options.live !== true,
    ttlMs: options.ttlMs,
    tags: [...tags, ...toArray(options.cacheTags).map(String)],
  }),
});

const createQueryTask = async (
  options: GisQueryOptions,
  spatial: boolean,
  signal?: AbortSignal,
): Promise<Readonly<{ queryTask: QueryTaskLike; query: unknown }>> => {
  const url = normalizeUrl(options.url);
  if (!url) {
    throw Object.assign(
      new Error('A GIS query URL is required.'),
      { code: 'INVALID_GIS_URL' },
    );
  }

  throwIfAborted(signal);
  const [QueryTask, Query] = await loadQueryModules();
  throwIfAborted(signal);

  return Object.freeze({
    queryTask: new QueryTask({ url }),
    query: new Query(createQueryOptions(options, spatial)),
  });
};

const executeTask = async (
  options: GisQueryOptions,
  spatial = false,
  signal?: AbortSignal,
): Promise<ArcGisFeatureSet> => {
  const { queryTask, query } = await createQueryTask(options, spatial, signal);
  const requestOptions = signal ? Object.freeze({ signal }) : undefined;
  return queryTask.execute(query, requestOptions);
};

const executeQuery = async (
  options: GisQueryOptions,
  spatial = false,
): Promise<LegacyGisResult> => {
  try {
    const key = createRuntimeKey(options, spatial, 'features');
    return await queryRuntime.execute(
      key,
      async ({ signal }) => toServiceResult(
        await executeTask(options, spatial, signal),
        options,
      ),
      createRuntimeOptions(options, ['features', normalizeUrl(options.url)]),
    );
  } catch (error) {
    return toErrorResult(error);
  }
};

const executeCountTask = async (
  options: GisQueryOptions,
  spatial = false,
  signal?: AbortSignal,
): Promise<number> => {
  const { queryTask, query } = await createQueryTask(options, spatial, signal);
  const requestOptions = signal ? Object.freeze({ signal }) : undefined;

  if (typeof queryTask.executeForCount === 'function') {
    return queryTask.executeForCount(query, requestOptions);
  }

  if (typeof queryTask.executeForIds === 'function') {
    const ids = await queryTask.executeForIds(query, requestOptions);
    return Array.isArray(ids) ? ids.length : 0;
  }

  throw Object.assign(
    new Error('This ArcGIS runtime does not expose executeForCount or executeForIds.'),
    { code: 'COUNT_UNSUPPORTED' },
  );
};

const executeCount = async (
  options: GisQueryOptions,
  spatial = false,
): Promise<LegacyGisResult> => {
  try {
    const key = createRuntimeKey(options, spatial, 'count');
    return await queryRuntime.execute(
      key,
      async ({ signal }) => toCountResult(
        await executeCountTask(options, spatial, signal),
      ),
      createRuntimeOptions(options, ['count', normalizeUrl(options.url)]),
    );
  } catch (error) {
    return toErrorResult(error);
  }
};

const mergePageMetadata = (
  aggregate: AggregateMetadata,
  pageResult: LegacyGisSuccess,
): AggregateMetadata => Object.freeze({
  fields: aggregate.fields.length > 0
    ? aggregate.fields
    : Object.freeze([...pageResult.fields]),
  geometryType: aggregate.geometryType ?? pageResult.geometryType ?? null,
  spatialReference: aggregate.spatialReference ?? pageResult.spatialReference ?? null,
});

const executeAllPages = async (
  options: GisQueryOptions,
  spatial = false,
): Promise<LegacyGisResult> => {
  const pageSize = toBoundedPositiveInteger(
    options.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const maxRecords = toBoundedPositiveInteger(
    options.maxRecords,
    DEFAULT_MAX_RECORDS,
    MAX_ALL_RECORDS,
  );
  const startOffset = toNonNegativeInteger(options.resultOffset, 0) ?? 0;
  const collected: LegacyQueryDataItem[] = [];
  const seenOffsets = new Set<number>();
  let offset = startOffset;
  let pages = 0;
  let metadata: AggregateMetadata = Object.freeze({
    fields: Object.freeze([]),
    geometryType: null,
    spatialReference: null,
  });
  let serviceHasMore = false;

  try {
    while (collected.length < maxRecords) {
      throwIfAborted(options.signal);
      if (seenOffsets.has(offset)) {
        throw Object.assign(
          new Error('GIS pagination stopped because the service repeated an offset.'),
          { code: 'PAGINATION_STALLED', offset },
        );
      }
      seenOffsets.add(offset);

      const remaining = maxRecords - collected.length;
      const currentPageSize = Math.min(pageSize, remaining);
      const pageResult = await executeQuery({
        ...options,
        cache: false,
        resultOffset: offset,
        resultRecordCount: currentPageSize,
      }, spatial);

      if (pageResult.type !== Constants_ServiceResultType.Success) return pageResult;
      if (!Array.isArray(pageResult.data)) {
        throw Object.assign(
          new Error('GIS pagination expected feature data but received a count response.'),
          { code: 'INVALID_PAGE_RESPONSE' },
        );
      }

      pages += 1;
      metadata = mergePageMetadata(metadata, pageResult as LegacyGisSuccess);
      const pageData = pageResult.data as readonly LegacyQueryDataItem[];
      collected.push(...pageData);
      serviceHasMore = pageResult.page?.hasMore === true;

      if (!serviceHasMore || pageData.length === 0) break;
      const nextOffset = toNonNegativeInteger(pageResult.page?.nextOffset);
      if (nextOffset === null || nextOffset <= offset) {
        throw Object.assign(
          new Error('GIS pagination did not advance.'),
          { code: 'PAGINATION_STALLED', offset, nextOffset },
        );
      }
      offset = nextOffset;
    }

    const truncated = serviceHasMore && collected.length >= maxRecords;
    return Object.freeze({
      type: Constants_ServiceResultType.Success as 10,
      data: Object.freeze(collected),
      fields: metadata.fields,
      geometryType: metadata.geometryType,
      spatialReference: metadata.spatialReference,
      exceededTransferLimit: truncated,
      page: Object.freeze({
        offset: startOffset,
        count: collected.length,
        hasMore: truncated,
        nextOffset: truncated ? offset : null,
        pages,
        pageSize,
        maxRecords,
        truncated,
      }),
    });
  } catch (error) {
    return toErrorResult(error);
  }
};

export const invalidateGisQueryCache = (selector: unknown): number =>
  queryRuntime.invalidate(selector);

export const invalidateGisQueryCacheTag = (tag: unknown): number =>
  queryRuntime.invalidateTag(tag);

export const clearGisQueryRuntime = (): void => {
  queryRuntime.clear({ abortInFlight: true });
  queryModulesPromise = null;
};

export const configureGisQueryRuntime = (
  options: QueryRuntimeConfiguration = {},
) => queryRuntime.configure(options);

export const getGisQueryRuntimeStats = () => Object.freeze({
  ...queryRuntime.getStats(),
  modulesLoaded: Boolean(queryModulesPromise),
});

export const GisQueryHelper = Object.freeze({
  ExecuteQuery: (
    options: GisQueryOptions,
  ): Promise<LegacyGisResult> => executeQuery(options, false),

  ExecuteSpatialQuery: (
    options: GisQueryOptions,
  ): Promise<LegacyGisResult> => executeQuery(options, true),

  ExecuteCount: (
    options: GisQueryOptions,
  ): Promise<LegacyGisResult> => executeCount(options, false),

  ExecuteSpatialCount: (
    options: GisQueryOptions,
  ): Promise<LegacyGisResult> => executeCount(options, true),

  ExecuteAllPages: (
    options: GisQueryOptions,
  ): Promise<LegacyGisResult> => executeAllPages(options, false),

  ExecuteAllSpatialPages: (
    options: GisQueryOptions,
  ): Promise<LegacyGisResult> => executeAllPages(options, true),
});
