import { loadArcgisModules as loadModules } from "../gis-engine/arcgisModuleRuntime";
import { Constants_ServiceResultType } from "../Core/Constants";
import { stableQueryKey } from "../gis-engine/spatialEngine";
import {
    createArcGisQueryCachePolicy,
    createQueryRuntime,
    createQueryRuntimeKey,
    type ArcGisQueryResultLike,
    type QueryExecuteOptions,
    type QueryRuntimeConfiguration
} from "../gis-engine/queryRuntime";

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 2000;
const DEFAULT_MAX_RECORDS = 10000;
const MAX_ALL_RECORDS = 100000;
const QUERY_MODULE_IDS = Object.freeze([
    "esri/tasks/QueryTask",
    "esri/tasks/support/Query"
] as const);

type UnknownRecord = Record<string, unknown>;

export interface GisQueryOptions extends UnknownRecord {
    url?: unknown;
    signal?: AbortSignal;
    cache?: boolean;
    live?: boolean;
    ttlMs?: number;
    cacheTags?: unknown[];
    pageSize?: unknown;
    maxRecords?: unknown;
    resultOffset?: unknown;
    resultRecordCount?: unknown;
    returnDistinctValues?: unknown;
    orderByFields?: unknown;
    returnGeometry?: unknown;
    outFields?: unknown;
    where?: unknown;
}

export interface GisFeatureRecord {
    attr: unknown;
    geometry: unknown;
}

export interface GisQueryPage {
    offset: number;
    count: number;
    hasMore: boolean;
    nextOffset: number | null;
    pages?: number;
    pageSize?: number;
    maxRecords?: number;
    truncated?: boolean;
}

export interface GisFeatureQuerySuccess extends ArcGisQueryResultLike {
    type: typeof Constants_ServiceResultType.Success;
    data: GisFeatureRecord[];
    fields: unknown[];
    exceededTransferLimit: boolean;
    geometryType: unknown;
    spatialReference: unknown;
    page: GisQueryPage;
}

export interface GisCountQuerySuccess extends ArcGisQueryResultLike {
    type: typeof Constants_ServiceResultType.Success;
    data: number;
    count: number;
    fields: unknown[];
    exceededTransferLimit: false;
    page: null;
}

export interface GisQueryErrorResult {
    error: unknown;
    type: typeof Constants_ServiceResultType.Error;
    data: null;
    fields: null;
}

export type GisFeatureQueryResult = GisFeatureQuerySuccess | GisQueryErrorResult;
export type GisCountQueryResult = GisCountQuerySuccess | GisQueryErrorResult;

interface ArcGisFeatureLike {
    attributes?: unknown;
    geometry?: unknown;
}

interface ArcGisQueryResponseLike {
    features?: unknown;
    fields?: unknown;
    exceededTransferLimit?: unknown;
    geometryType?: unknown;
    spatialReference?: unknown;
}

interface ArcGisQueryTaskLike {
    execute: (query: UnknownRecord, requestOptions?: { signal: AbortSignal }) => Promise<ArcGisQueryResponseLike>;
    executeForCount?: (query: UnknownRecord, requestOptions?: { signal: AbortSignal }) => Promise<unknown>;
    executeForIds?: (query: UnknownRecord, requestOptions?: { signal: AbortSignal }) => Promise<unknown>;
}

type ArcGisQueryTaskCtor = new (options: { url: string }) => ArcGisQueryTaskLike;
type ArcGisQueryCtor = new (initial?: UnknownRecord) => UnknownRecord;
type QueryModules = [ArcGisQueryTaskCtor, ArcGisQueryCtor];

interface GisQueryMetadata {
    fields: unknown[];
    geometryType: unknown;
    spatialReference: unknown;
}

let queryModulesPromise: Promise<QueryModules> | null = null;
const queryRuntime = createQueryRuntime({
    ttlMs: 30000,
    maxEntries: 128,
    maxBytes: 8 * 1024 * 1024
});

const loadQueryModules = (): Promise<QueryModules> => {
    if (!queryModulesPromise) {
        queryModulesPromise = loadModules<QueryModules>(QUERY_MODULE_IDS).catch((error: unknown) => {
            queryModulesPromise = null;
            throw error;
        });
    }
    return queryModulesPromise;
};

const cancelledError = (): Error & { code: string } =>
    Object.assign(new Error("GIS query cancelled."), { code: "CANCELLED" });

const throwIfAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw cancelledError();
};

const toNonNegativeInteger = (value: unknown, fallback: number | null = null): number | null => {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    return Math.floor(number);
};

const toBoundedPositiveInteger = (value: unknown, fallback: number, max: number): number => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(max, Math.max(1, Math.floor(number)));
};

const toArray = <T = unknown>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

const toServiceResult = (
    response: ArcGisQueryResponseLike | null | undefined,
    options: GisQueryOptions = {}
): GisFeatureQuerySuccess => {
    const resultOffset = toNonNegativeInteger(options.resultOffset, 0) ?? 0;
    const features = toArray<ArcGisFeatureLike | null>(response?.features);
    const data = features.map((feature) => ({
        attr: feature?.attributes ?? null,
        geometry: feature?.geometry ?? null
    }));
    const exceededTransferLimit = Boolean(response?.exceededTransferLimit);
    const hasMore = exceededTransferLimit && data.length > 0;

    return {
        type: Constants_ServiceResultType.Success,
        data,
        fields: toArray(response?.fields),
        exceededTransferLimit,
        geometryType: response?.geometryType ?? null,
        spatialReference: response?.spatialReference ?? null,
        page: {
            offset: resultOffset,
            count: data.length,
            hasMore,
            nextOffset: hasMore ? resultOffset + data.length : null
        }
    };
};

const toCountResult = (count: unknown): GisCountQuerySuccess => {
    const numericCount = Number(count);
    const safeCount = Number.isFinite(numericCount) ? numericCount : 0;
    return {
        type: Constants_ServiceResultType.Success,
        data: safeCount,
        count: safeCount,
        fields: [],
        exceededTransferLimit: false,
        page: null
    };
};

const toErrorResult = (error: unknown): GisQueryErrorResult => ({
    error,
    type: Constants_ServiceResultType.Error,
    data: null,
    fields: null
});

const normalizeUrl = (value: unknown): string => String(value ?? "").trim();

const createQueryOptions = (options: GisQueryOptions = {}, spatial = false): UnknownRecord => {
    const resultOffset = toNonNegativeInteger(options.resultOffset);
    const resultRecordCount = toNonNegativeInteger(options.resultRecordCount);

    if (spatial) {
        const queryOptions: UnknownRecord = { ...options };
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

    return {
        returnDistinctValues: Boolean(options.returnDistinctValues),
        orderByFields: options.orderByFields ?? null,
        returnGeometry: Boolean(options.returnGeometry),
        outFields: options.outFields ?? ["*"],
        where: options.where ?? "1=1",
        ...(resultOffset === null ? {} : { resultOffset }),
        ...(resultRecordCount === null ? {} : { resultRecordCount })
    };
};

const createRuntimeKey = (
    options: GisQueryOptions,
    spatial: boolean,
    operation: "features" | "count" = "features"
): string => createQueryRuntimeKey({
    serviceUrl: normalizeUrl(options.url),
    operation,
    queryKey: stableQueryKey({
        spatial,
        query: createQueryOptions(options, spatial)
    })
});

const createRuntimeOptions = <T extends ArcGisQueryResultLike>(
    options: GisQueryOptions = {},
    tags: unknown[] = []
): QueryExecuteOptions<T> => {
    const policy = createArcGisQueryCachePolicy({
        cache: options.cache === true && options.live !== true,
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
        tags: [...tags, ...toArray(options.cacheTags)]
    }) as QueryExecuteOptions<T>;

    return {
        ...policy,
        ...(options.signal ? { signal: options.signal } : {})
    };
};

const createQueryTask = async (
    options: GisQueryOptions,
    spatial: boolean,
    signal?: AbortSignal
): Promise<{ queryTask: ArcGisQueryTaskLike; query: UnknownRecord }> => {
    const url = normalizeUrl(options.url);
    if (!url) {
        throw Object.assign(new Error("A GIS query URL is required."), { code: "INVALID_GIS_URL" });
    }

    throwIfAborted(signal);
    const [QueryTask, Query] = await loadQueryModules();
    throwIfAborted(signal);

    const queryTask = new QueryTask({ url });
    const query = new Query(createQueryOptions(options, spatial));
    return { queryTask, query };
};

const executeTask = async (
    options: GisQueryOptions = {},
    spatial = false,
    signal?: AbortSignal
): Promise<ArcGisQueryResponseLike> => {
    const { queryTask, query } = await createQueryTask(options, spatial, signal);
    const requestOptions = signal ? { signal } : undefined;
    return queryTask.execute(query, requestOptions);
};

const executeQuery = async (
    options: GisQueryOptions = {},
    spatial = false
): Promise<GisFeatureQueryResult> => {
    try {
        const key = createRuntimeKey(options, spatial, "features");
        return await queryRuntime.execute<GisFeatureQuerySuccess>(
            key,
            async ({ signal }) => toServiceResult(
                await executeTask(options, spatial, signal),
                options
            ),
            createRuntimeOptions<GisFeatureQuerySuccess>(
                options,
                ["features", normalizeUrl(options.url)]
            )
        );
    } catch (error) {
        return toErrorResult(error);
    }
};

const executeCountTask = async (
    options: GisQueryOptions = {},
    spatial = false,
    signal?: AbortSignal
): Promise<number> => {
    const { queryTask, query } = await createQueryTask(options, spatial, signal);
    const requestOptions = signal ? { signal } : undefined;

    if (typeof queryTask.executeForCount === "function") {
        const count = await queryTask.executeForCount(query, requestOptions);
        const numericCount = Number(count);
        return Number.isFinite(numericCount) ? numericCount : 0;
    }

    if (typeof queryTask.executeForIds === "function") {
        const ids = await queryTask.executeForIds(query, requestOptions);
        return Array.isArray(ids) ? ids.length : 0;
    }

    throw Object.assign(
        new Error("This ArcGIS runtime does not expose executeForCount or executeForIds."),
        { code: "COUNT_UNSUPPORTED" }
    );
};

const executeCount = async (
    options: GisQueryOptions = {},
    spatial = false
): Promise<GisCountQueryResult> => {
    try {
        const key = createRuntimeKey(options, spatial, "count");
        return await queryRuntime.execute<GisCountQuerySuccess>(
            key,
            async ({ signal }) => toCountResult(
                await executeCountTask(options, spatial, signal)
            ),
            createRuntimeOptions<GisCountQuerySuccess>(
                options,
                ["count", normalizeUrl(options.url)]
            )
        );
    } catch (error) {
        return toErrorResult(error);
    }
};

const mergePageMetadata = (
    aggregate: GisQueryMetadata,
    pageResult: GisFeatureQuerySuccess
): GisQueryMetadata => ({
    ...aggregate,
    fields: aggregate.fields.length ? aggregate.fields : toArray(pageResult.fields),
    geometryType: aggregate.geometryType ?? pageResult.geometryType ?? null,
    spatialReference: aggregate.spatialReference ?? pageResult.spatialReference ?? null
});

const executeAllPages = async (
    options: GisQueryOptions = {},
    spatial = false
): Promise<GisFeatureQueryResult> => {
    const pageSize = toBoundedPositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const maxRecords = toBoundedPositiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS, MAX_ALL_RECORDS);
    const startOffset = toNonNegativeInteger(options.resultOffset, 0) ?? 0;
    const collected: GisFeatureRecord[] = [];
    const seenOffsets = new Set<number>();
    let offset = startOffset;
    let pages = 0;
    let metadata: GisQueryMetadata = {
        fields: [],
        geometryType: null,
        spatialReference: null
    };
    let serviceHasMore = false;

    try {
        while (collected.length < maxRecords) {
            throwIfAborted(options.signal);
            if (seenOffsets.has(offset)) {
                throw Object.assign(new Error("GIS pagination stopped because the service repeated an offset."), {
                    code: "PAGINATION_STALLED",
                    offset
                });
            }
            seenOffsets.add(offset);

            const remaining = maxRecords - collected.length;
            const currentPageSize = Math.min(pageSize, remaining);
            const pageResult = await executeQuery({
                ...options,
                cache: false,
                resultOffset: offset,
                resultRecordCount: currentPageSize
            }, spatial);

            if (pageResult.type !== Constants_ServiceResultType.Success) {
                return pageResult;
            }

            pages += 1;
            metadata = mergePageMetadata(metadata, pageResult);
            const pageData = toArray<GisFeatureRecord>(pageResult.data);
            collected.push(...pageData);
            serviceHasMore = Boolean(pageResult.page.hasMore);

            if (!serviceHasMore || pageData.length === 0) break;
            const nextOffset = toNonNegativeInteger(pageResult.page.nextOffset);
            if (nextOffset === null || nextOffset <= offset) {
                throw Object.assign(new Error("GIS pagination did not advance."), {
                    code: "PAGINATION_STALLED",
                    offset,
                    nextOffset
                });
            }
            offset = nextOffset;
        }

        const truncated = serviceHasMore && collected.length >= maxRecords;
        return {
            type: Constants_ServiceResultType.Success,
            data: collected,
            fields: metadata.fields,
            geometryType: metadata.geometryType,
            spatialReference: metadata.spatialReference,
            exceededTransferLimit: truncated,
            page: {
                offset: startOffset,
                count: collected.length,
                hasMore: truncated,
                nextOffset: truncated ? offset : null,
                pages,
                pageSize,
                maxRecords,
                truncated
            }
        };
    } catch (error) {
        return toErrorResult(error);
    }
};

export const invalidateGisQueryCache = (selector: unknown): number => queryRuntime.invalidate(selector);

export const invalidateGisQueryCacheTag = (tag: unknown): number => queryRuntime.invalidateTag(tag);

export const clearGisQueryRuntime = (): void => {
    queryRuntime.clear({ abortInFlight: true });
    queryModulesPromise = null;
};

export const configureGisQueryRuntime = (
    options: QueryRuntimeConfiguration = {}
) => queryRuntime.configure(options);

export const getGisQueryRuntimeStats = () => ({
    ...queryRuntime.getStats(),
    modulesLoaded: Boolean(queryModulesPromise)
});

export const GisQueryHelper = Object.freeze({
    ExecuteQuery: (options: GisQueryOptions = {}) => executeQuery(options, false),
    ExecuteSpatialQuery: (options: GisQueryOptions = {}) => executeQuery(options, true),
    ExecuteCount: (options: GisQueryOptions = {}) => executeCount(options, false),
    ExecuteSpatialCount: (options: GisQueryOptions = {}) => executeCount(options, true),
    ExecuteAllPages: (options: GisQueryOptions = {}) => executeAllPages(options, false),
    ExecuteAllSpatialPages: (options: GisQueryOptions = {}) => executeAllPages(options, true)
});
