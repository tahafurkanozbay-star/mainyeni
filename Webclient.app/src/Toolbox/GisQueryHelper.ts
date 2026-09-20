import { loadArcgisModules } from '../gis-engine/arcgisModuleRuntime';
import { Constants_ServiceResultType } from '../Core/Constants';
import { stableQueryKey } from '../gis-engine/spatialEngine';
import {
  createQueryRuntime,
  createQueryRuntimeKey,
  type QueryExecuteOptions,
  type QueryRuntimeConfiguration,
  type QueryRuntimeStats,
} from '../gis-engine/queryRuntime';

const DEFAULT_PAGE_SIZE = 1_000;
const MAX_PAGE_SIZE = 2_000;
const DEFAULT_MAX_RECORDS = 10_000;
const MAX_ALL_RECORDS = 100_000;
const QUERY_MODULE_IDS = Object.freeze([
  'esri/tasks/QueryTask',
  'esri/tasks/support/Query',
] as const);

type UnknownRecord = Record<string, unknown>;

interface QueryFeatureLike {
  readonly attributes?: UnknownRecord;
  readonly geometry?: unknown;
}

interface QueryResponseLike {
  readonly features?: readonly QueryFeatureLike[];
  readonly fields?: readonly unknown[];
  readonly exceededTransferLimit?: boolean;
  readonly geometryType?: unknown;
  readonly spatialReference?: unknown;
}

interface QueryTaskLike {
  execute: (query: unknown, requestOptions?: { signal: AbortSignal }) => Promise<QueryResponseLike>;
  executeForCount?: (query: unknown, requestOptions?: { signal: AbortSignal }) => Promise<number>;
  executeForIds?: (query: unknown, requestOptions?: { signal: AbortSignal }) => Promise<readonly unknown[]>;
}

type QueryTaskConstructor = new (properties: { url: string }) => QueryTaskLike;
type QueryConstructor = new (properties: Readonly<Record<string, unknown>>) => unknown;

export interface GisQueryOptions extends Record<string, unknown> {
  readonly url?: string;
  readonly signal?: AbortSignal;
  readonly cache?: boolean;
  readonly live?: boolean;
  readonly ttlMs?: number;
  readonly cacheTags?: readonly unknown[];
  readonly resultOffset?: number | string | null;
  readonly resultRecordCount?: number | string | null;
  readonly pageSize?: number | string | null;
  readonly maxRecords?: number | string | null;
  readonly returnDistinctValues?: boolean;
  readonly orderByFields?: readonly string[] | null;
  readonly returnGeometry?: boolean;
  readonly outFields?: readonly string[];
  readonly where?: string;
}

export interface GisServiceItem {
  readonly attr: UnknownRecord | null;
  readonly geometry: unknown;
}

export interface GisQueryPage {
  readonly offset: number;
  readonly count: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
  readonly pages?: number;
  readonly pageSize?: number;
  readonly maxRecords?: number;
  readonly truncated?: boolean;
}

export interface GisQuerySuccess {
  readonly type: typeof Constants_ServiceResultType.Success;
  readonly data: readonly GisServiceItem[] | number;
  readonly count?: number;
  readonly fields: readonly unknown[];
  readonly exceededTransferLimit: boolean;
  readonly geometryType?: unknown;
  readonly spatialReference?: unknown;
  readonly page: GisQueryPage | null;
}

export interface GisQueryFailure {
  readonly type: typeof Constants_ServiceResultType.Error;
  readonly error: unknown;
  readonly data: null;
  readonly fields: null;
}

export type GisQueryResult = GisQuerySuccess | GisQueryFailure;

let queryModulesPromise: Promise<readonly [QueryTaskConstructor, QueryConstructor]> | null = null;

const queryRuntime = createQueryRuntime({
  ttlMs: 30_000,
  maxEntries: 128,
  maxBytes: 8 * 1024 * 1024,
});

const loadQueryModules = (): Promise<readonly [QueryTaskConstructor, QueryConstructor]> => {
  if (!queryModulesPromise) {
    queryModulesPromise = loadArcgisModules<
      readonly [QueryTaskConstructor, QueryConstructor]
    >(QUERY_MODULE_IDS).catch((error: unknown) => {
      queryModulesPromise = null;
      throw error;
    });
  }
  return queryModulesPromise;
};

const cancelledError = (): Error & { readonly code: 'CANCELLED' } =>
  Object.assign(new Error('GIS query cancelled.'), { code: 'CANCELLED' as const });

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw cancelledError();
};

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const toNonNegativeInteger = (value: unknown, fallback: number | null = null): number | null => {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
};

const toBoundedPositiveInteger = (value: unknown, fallback: number, max: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const toReadonlyArray = <TValue = unknown>(value: unknown): readonly TValue[] =>
  Array.isArray(value) ? Object.freeze([...value]) as readonly TValue[] : Object.freeze([]) as readonly TValue[];

const asQueryResponse = (value: unknown): QueryResponseLike =>
  isRecord(value) ? value as QueryResponseLike : Object.freeze({});

const toServiceResult = (
  responseInput: unknown,
  options: GisQueryOptions = {},
): GisQuerySuccess => {
  const response = asQueryResponse(responseInput);
  const resultOffset = toNonNegativeInteger(options.resultOffset, 0) ?? 0;
  const features = toReadonlyArray<QueryFeatureLike>(response.features);
  const data = Object.freeze(features.map((feature) => Object.freeze({
    attr: isRecord(feature.attributes) ? Object.freeze({ ...feature.attributes }) : null,
    geometry: feature.geometry ?? null,
  })));
  const exceededTransferLimit = response.exceededTransferLimit === true;
  const hasMore = exceededTransferLimit && data.length > 0;

  return Object.freeze({
    type: Constants_ServiceResultType.Success,
    data,
    fields: toReadonlyArray(response.fields),
    exceededTransferLimit,
    ...(response.geometryType === undefined ? {} : { geometryType: response.geometryType }),
    ...(response.spatialReference === undefined ? {} : { spatialReference: response.spatialReference }),
    page: Object.freeze({
      offset: resultOffset,
      count: data.length,
      hasMore,
      nextOffset: hasMore ? resultOffset + data.length : null,
    }),
  });
};

const toCountResult = (countInput: unknown): GisQuerySuccess => {
  const count = Number.isFinite(Number(countInput)) ? Number(countInput) : 0;
  return Object.freeze({
    type: Constants_ServiceResultType.Success,
    data: count,
    count,
    fields: Object.freeze([]),
    exceededTransferLimit: false,
    page: null,
  });
};

const toErrorResult = (error: unknown): GisQueryFailure => Object.freeze({
  error,
  type: Constants_ServiceResultType.Error,
  data: null,
  fields: null,
});

const normalizeUrl = (value: unknown): string => String(value ?? '').trim();

const createQueryOptions = (
  options: GisQueryOptions = {},
  spatial = false,
): Readonly<Record<string, unknown>> => {
  const resultOffset = toNonNegativeInteger(options.resultOffset);
  const resultRecordCount = toNonNegativeInteger(options.resultRecordCount);

  if (spatial) {
    const queryOptions: Record<string, unknown> = { ...options };
    for (const key of [
      'url',
      'signal',
      'cache',
      'live',
      'ttlMs',
      'cacheTags',
      'pageSize',
      'maxRecords',
    ]) {
      delete queryOptions[key];
    }
    if (resultOffset === null) delete queryOptions.resultOffset;
    else queryOptions.resultOffset = resultOffset;
    if (resultRecordCount === null) delete queryOptions.resultRecordCount;
    else queryOptions.resultRecordCount = resultRecordCount;
    return Object.freeze(queryOptions);
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
  options: GisQueryOptions = {},
  tags: readonly unknown[] = Object.freeze([]),
): QueryExecuteOptions<GisQueryResult> => ({
  ...(options.signal ? { signal: options.signal } : {}),
  cache: options.cache === true && options.live !== true,
  ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  tags: Object.freeze([...tags, ...toReadonlyArray(options.cacheTags)]),
  isCacheable: (result) =>
    result.type === Constants_ServiceResultType.Success
    && result.exceededTransferLimit !== true
    && result.page?.hasMore !== true,
});

const createQueryTask = async (
  options: GisQueryOptions,
  spatial: boolean,
  signal?: AbortSignal,
): Promise<{ readonly queryTask: QueryTaskLike; readonly query: unknown }> => {
  const url = normalizeUrl(options.url);
  if (!url) {
    throw Object.assign(new Error('A GIS query URL is required.'), {
      code: 'INVALID_GIS_URL' as const,
    });
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
  options: GisQueryOptions = {},
  spatial = false,
  signal?: AbortSignal,
): Promise<QueryResponseLike> => {
  const { queryTask, query } = await createQueryTask(options, spatial, signal);
  return queryTask.execute(query, signal ? { signal } : undefined);
};

const executeQuery = async (
  options: GisQueryOptions = {},
  spatial = false,
): Promise<GisQueryResult> => {
  try {
    const key = createRuntimeKey(options, spatial, 'features');
    return await queryRuntime.execute<GisQueryResult>(
      key,
      async ({ signal }) => toServiceResult(
        await executeTask(options, spatial, signal),
        options,
      ),
      createRuntimeOptions(options, ['features', normalizeUrl(options.url)]),
    );
  } catch (error: unknown) {
    return toErrorResult(error);
  }
};

const executeCountTask = async (
  options: GisQueryOptions = {},
  spatial = false,
  signal?: AbortSignal,
): Promise<number> => {
  const { queryTask, query } = await createQueryTask(options, spatial, signal);
  const requestOptions = signal ? { signal } : undefined;

  if (typeof queryTask.executeForCount === 'function') {
    return queryTask.executeForCount(query, requestOptions);
  }

  if (typeof queryTask.executeForIds === 'function') {
    const ids = await queryTask.executeForIds(query, requestOptions);
    return Array.isArray(ids) ? ids.length : 0;
  }

  throw Object.assign(
    new Error('This ArcGIS runtime does not expose executeForCount or executeForIds.'),
    { code: 'COUNT_UNSUPPORTED' as const },
  );
};

const executeCount = async (
  options: GisQueryOptions = {},
  spatial = false,
): Promise<GisQueryResult> => {
  try {
    const key = createRuntimeKey(options, spatial, 'count');
    return await queryRuntime.execute<GisQueryResult>(
      key,
      async ({ signal }) => toCountResult(
        await executeCountTask(options, spatial, signal),
      ),
      createRuntimeOptions(options, ['count', normalizeUrl(options.url)]),
    );
  } catch (error: unknown) {
    return toErrorResult(error);
  }
};

interface AggregateMetadata {
  readonly fields: readonly unknown[];
  readonly geometryType: unknown;
  readonly spatialReference: unknown;
}

const mergePageMetadata = (
  aggregate: AggregateMetadata,
  pageResult: GisQuerySuccess,
): AggregateMetadata => Object.freeze({
  fields: aggregate.fields.length > 0 ? aggregate.fields : pageResult.fields,
  geometryType: aggregate.geometryType ?? pageResult.geometryType ?? null,
  spatialReference: aggregate.spatialReference ?? pageResult.spatialReference ?? null,
});

const executeAllPages = async (
  options: GisQueryOptions = {},
  spatial = false,
): Promise<GisQueryResult> => {
  const pageSize = toBoundedPositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const maxRecords = toBoundedPositiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS, MAX_ALL_RECORDS);
  const startOffset = toNonNegativeInteger(options.resultOffset, 0) ?? 0;
  const collected: GisServiceItem[] = [];
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
          { code: 'PAGINATION_STALLED' as const, offset },
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
        throw new TypeError('Feature pagination received a non-feature payload.');
      }

      pages += 1;
      metadata = mergePageMetadata(metadata, pageResult);
      const pageData = pageResult.data;
      collected.push(...pageData);
      serviceHasMore = pageResult.page?.hasMore === true;

      if (!serviceHasMore || pageData.length === 0) break;
      const nextOffset = toNonNegativeInteger(pageResult.page?.nextOffset);
      if (nextOffset === null || nextOffset <= offset) {
        throw Object.assign(
          new Error('GIS pagination did not advance.'),
          { code: 'PAGINATION_STALLED' as const, offset, nextOffset },
        );
      }
      offset = nextOffset;
    }

    const truncated = serviceHasMore && collected.length >= maxRecords;
    return Object.freeze({
      type: Constants_ServiceResultType.Success,
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
  } catch (error: unknown) {
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
): ReturnType<typeof queryRuntime.configure> => queryRuntime.configure(options);

export const getGisQueryRuntimeStats = (): QueryRuntimeStats & { readonly modulesLoaded: boolean } => ({
  ...queryRuntime.getStats(),
  modulesLoaded: queryModulesPromise !== null,
});

export const GisQueryHelper = Object.freeze({
  ExecuteQuery: (options: GisQueryOptions = {}): Promise<GisQueryResult> =>
    executeQuery(options, false),
  ExecuteSpatialQuery: (options: GisQueryOptions = {}): Promise<GisQueryResult> =>
    executeQuery(options, true),
  ExecuteCount: (options: GisQueryOptions = {}): Promise<GisQueryResult> =>
    executeCount(options, false),
  ExecuteSpatialCount: (options: GisQueryOptions = {}): Promise<GisQueryResult> =>
    executeCount(options, true),
  ExecuteAllPages: (options: GisQueryOptions = {}): Promise<GisQueryResult> =>
    executeAllPages(options, false),
  ExecuteAllSpatialPages: (options: GisQueryOptions = {}): Promise<GisQueryResult> =>
    executeAllPages(options, true),
});
