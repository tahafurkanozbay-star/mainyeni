import { loadModules } from "esri-loader";
import { Constants_ServiceResultType } from "../Core/Constants";
import { stableQueryKey } from "../gis-engine/spatialEngine";
import {
    createArcGisQueryCachePolicy,
    createQueryRuntime,
    createQueryRuntimeKey
} from "../gis-engine/queryRuntime";

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 2000;
const DEFAULT_MAX_RECORDS = 10000;
const MAX_ALL_RECORDS = 100000;

let queryModulesPromise = null;
const queryRuntime = createQueryRuntime({
    ttlMs: 30000,
    maxEntries: 128,
    maxBytes: 8 * 1024 * 1024
});

const loadQueryModules = () => {
    if (!queryModulesPromise) {
        queryModulesPromise = loadModules([
            "esri/tasks/QueryTask",
            "esri/tasks/support/Query"
        ]).catch((error) => {
            queryModulesPromise = null;
            throw error;
        });
    }
    return queryModulesPromise;
};

const cancelledError = () => Object.assign(new Error("GIS query cancelled."), { code: "CANCELLED" });

const throwIfAborted = (signal) => {
    if (signal?.aborted) throw cancelledError();
};

const toNonNegativeInteger = (value, fallback = null) => {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    return Math.floor(number);
};

const toBoundedPositiveInteger = (value, fallback, max) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.min(max, Math.max(1, Math.floor(number)));
};

const toArray = (value) => Array.isArray(value) ? value : [];

const toServiceResult = (response, options = {}) => {
    const resultOffset = toNonNegativeInteger(options.resultOffset, 0);
    const features = toArray(response?.features);
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

const toCountResult = (count) => ({
    type: Constants_ServiceResultType.Success,
    data: Number.isFinite(Number(count)) ? Number(count) : 0,
    count: Number.isFinite(Number(count)) ? Number(count) : 0,
    fields: [],
    exceededTransferLimit: false,
    page: null
});

const toErrorResult = (error) => ({
    error,
    type: Constants_ServiceResultType.Error,
    data: null,
    fields: null
});

const normalizeUrl = (value) => String(value ?? "").trim();

const createQueryOptions = (options = {}, spatial = false) => {
    const resultOffset = toNonNegativeInteger(options.resultOffset);
    const resultRecordCount = toNonNegativeInteger(options.resultRecordCount);

    if (spatial) {
        const {
            url,
            signal,
            cache,
            live,
            ttlMs,
            cacheTags,
            pageSize,
            maxRecords,
            ...queryOptions
        } = options;
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

const createRuntimeKey = (options, spatial, operation = "features") => createQueryRuntimeKey({
    serviceUrl: normalizeUrl(options?.url),
    operation,
    queryKey: stableQueryKey({
        spatial,
        query: createQueryOptions(options, spatial)
    })
});

const createRuntimeOptions = (options = {}, tags = []) => ({
    signal: options.signal,
    ...createArcGisQueryCachePolicy({
        cache: options.cache === true && options.live !== true,
        ttlMs: options.ttlMs,
        tags: [...tags, ...toArray(options.cacheTags)]
    })
});

const createQueryTask = async (options, spatial, signal) => {
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

const executeTask = async (options = {}, spatial = false, signal) => {
    const { queryTask, query } = await createQueryTask(options, spatial, signal);
    const requestOptions = signal ? { signal } : undefined;
    return queryTask.execute(query, requestOptions);
};

const executeQuery = async (options = {}, spatial = false) => {
    try {
        const key = createRuntimeKey(options, spatial, "features");
        const result = await queryRuntime.execute(
            key,
            async ({ signal }) => toServiceResult(
                await executeTask(options, spatial, signal),
                options
            ),
            createRuntimeOptions(options, ["features", normalizeUrl(options.url)])
        );
        return result;
    } catch (error) {
        return toErrorResult(error);
    }
};

const executeCountTask = async (options = {}, spatial = false, signal) => {
    const { queryTask, query } = await createQueryTask(options, spatial, signal);
    const requestOptions = signal ? { signal } : undefined;

    if (typeof queryTask.executeForCount === "function") {
        return queryTask.executeForCount(query, requestOptions);
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

const executeCount = async (options = {}, spatial = false) => {
    try {
        const key = createRuntimeKey(options, spatial, "count");
        return await queryRuntime.execute(
            key,
            async ({ signal }) => toCountResult(
                await executeCountTask(options, spatial, signal)
            ),
            createRuntimeOptions(options, ["count", normalizeUrl(options.url)])
        );
    } catch (error) {
        return toErrorResult(error);
    }
};

const mergePageMetadata = (aggregate, pageResult) => ({
    ...aggregate,
    fields: aggregate.fields.length ? aggregate.fields : toArray(pageResult.fields),
    geometryType: aggregate.geometryType ?? pageResult.geometryType ?? null,
    spatialReference: aggregate.spatialReference ?? pageResult.spatialReference ?? null
});

const executeAllPages = async (options = {}, spatial = false) => {
    const pageSize = toBoundedPositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const maxRecords = toBoundedPositiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS, MAX_ALL_RECORDS);
    const startOffset = toNonNegativeInteger(options.resultOffset, 0);
    const collected = [];
    const seenOffsets = new Set();
    let offset = startOffset;
    let pages = 0;
    let metadata = {
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

            if (pageResult?.type !== Constants_ServiceResultType.Success) {
                return pageResult;
            }

            pages += 1;
            metadata = mergePageMetadata(metadata, pageResult);
            const pageData = toArray(pageResult.data);
            collected.push(...pageData);
            serviceHasMore = Boolean(pageResult.page?.hasMore);

            if (!serviceHasMore || pageData.length === 0) break;
            const nextOffset = toNonNegativeInteger(pageResult.page?.nextOffset);
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

export const invalidateGisQueryCache = (selector) => queryRuntime.invalidate(selector);

export const invalidateGisQueryCacheTag = (tag) => queryRuntime.invalidateTag(tag);

export const clearGisQueryRuntime = () => {
    queryRuntime.clear({ abortInFlight: true });
    queryModulesPromise = null;
};

export const configureGisQueryRuntime = (options = {}) => queryRuntime.configure(options);

export const getGisQueryRuntimeStats = () => ({
    ...queryRuntime.getStats(),
    modulesLoaded: Boolean(queryModulesPromise)
});

export const GisQueryHelper = {
    ExecuteQuery: async (options = {}) => executeQuery(options, false),
    ExecuteSpatialQuery: async (options = {}) => executeQuery(options, true),
    ExecuteCount: async (options = {}) => executeCount(options, false),
    ExecuteSpatialCount: async (options = {}) => executeCount(options, true),
    ExecuteAllPages: async (options = {}) => executeAllPages(options, false),
    ExecuteAllSpatialPages: async (options = {}) => executeAllPages(options, true)
};
