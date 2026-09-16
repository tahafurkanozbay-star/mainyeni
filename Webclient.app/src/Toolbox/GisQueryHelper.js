import { loadModules } from "esri-loader";
import { Constants_ServiceResultType } from "../Core/Constants";
import { stableQueryKey } from "../gis-engine/spatialEngine";

let queryModulesPromise = null;
const inFlightQueries = new Map();

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

const toServiceResult = (response, options = {}) => {
    const resultOffset = toNonNegativeInteger(options.resultOffset, 0);
    const data = (response?.features ?? []).map((feature) => ({
        attr: feature.attributes,
        geometry: feature.geometry
    }));

    return {
        type: Constants_ServiceResultType.Success,
        data,
        fields: response?.fields ?? [],
        exceededTransferLimit: Boolean(response?.exceededTransferLimit),
        geometryType: response?.geometryType ?? null,
        spatialReference: response?.spatialReference ?? null,
        page: {
            offset: resultOffset,
            count: data.length,
            nextOffset: response?.exceededTransferLimit ? resultOffset + data.length : null
        }
    };
};

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

const createRuntimeKey = (options, spatial) => stableQueryKey({
    url: normalizeUrl(options?.url),
    spatial,
    query: createQueryOptions(options, spatial)
});

const executeTask = async (options = {}, spatial = false) => {
    const url = normalizeUrl(options.url);
    if (!url) {
        throw Object.assign(new Error("A GIS query URL is required."), { code: "INVALID_GIS_URL" });
    }

    throwIfAborted(options.signal);
    const [QueryTask, Query] = await loadQueryModules();
    throwIfAborted(options.signal);

    const queryTask = new QueryTask({ url });
    const queryOptions = createQueryOptions(options, spatial);
    const query = new Query(queryOptions);

    const requestOptions = options.signal ? { signal: options.signal } : undefined;
    return queryTask.execute(query, requestOptions);
};

const executeQuery = async (options = {}, spatial = false) => {
    try {
        if (options.signal) {
            return toServiceResult(await executeTask(options, spatial), options);
        }

        const key = createRuntimeKey(options, spatial);
        if (inFlightQueries.has(key)) {
            return await inFlightQueries.get(key);
        }

        const work = executeTask(options, spatial)
            .then((response) => toServiceResult(response, options))
            .catch(toErrorResult)
            .finally(() => {
                if (inFlightQueries.get(key) === work) {
                    inFlightQueries.delete(key);
                }
            });

        inFlightQueries.set(key, work);
        return await work;
    } catch (error) {
        return toErrorResult(error);
    }
};

export const clearGisQueryRuntime = () => {
    inFlightQueries.clear();
    queryModulesPromise = null;
};

export const getGisQueryRuntimeStats = () => ({
    inFlight: inFlightQueries.size,
    modulesLoaded: Boolean(queryModulesPromise)
});

export const GisQueryHelper = {
    ExecuteQuery: async (options = {}) => executeQuery(options, false),
    ExecuteSpatialQuery: async (options = {}) => executeQuery(options, true)
};
