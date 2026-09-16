import {
    normalizeCoordinates,
    normalizeInteger,
    normalizeSearchText,
    normalizeText
} from "./DataIntegrityHelper";
import {
    ADDRESS_RECORD_SCHEMA,
    GENERIC_RECORD_SCHEMA,
    createSchemaFingerprint,
    createSchemaQualityReport
} from "./RecordSchemaRuntime";
import {
    createSearchExecutionIndex,
    executeSearch,
    normalizeSearchRequest
} from "./SearchExecutionRuntime";
import {
    createAddressIndex,
    createAddressQualityReport,
    findNearestAddresses,
    parseCoordinatePair,
    searchAddressIndex
} from "./AddressSearchRuntime";
import {
    createDataQualitySnapshot,
    evaluateDataReleaseGate
} from "./DataReleaseGuardRuntime";
import {
    adaptSearchResult
} from "./SearchResultAdapterRuntime";
import {
    createSearchDatasetRegistry,
    throwIfDatasetAborted
} from "./SearchDatasetRegistry";

export const SEARCH_COORDINATOR_MODES = Object.freeze({
    Auto: "auto",
    Text: "text",
    Address: "address",
    Nearest: "nearest"
});

export const DEFAULT_COORDINATOR_RESULT_CACHE_SIZE = 100;
export const DEFAULT_COORDINATOR_RESULT_TTL_MS = 30000;
export const MAX_COORDINATOR_RESULT_CACHE_SIZE = 1000;
export const MAX_COORDINATOR_DATASETS_PER_QUERY = 16;

const asArray = value => Array.isArray(value) ? value : [];
const unique = values => Array.from(new Set(values));
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

export const normalizeCoordinatorMode = value => {
    const normalized = normalizeText(value).toLocaleLowerCase("tr-TR");
    return Object.values(SEARCH_COORDINATOR_MODES).includes(normalized)
        ? normalized
        : SEARCH_COORDINATOR_MODES.Auto;
};

export const looksLikeCoordinateQuery = value => {
    if (Array.isArray(value)) return value.length >= 2 && Boolean(parseCoordinatePair(value));
    if (value && typeof value === "object") return Boolean(parseCoordinatePair(value));
    const text = normalizeText(value);
    if (!text) return false;
    const numericTokens = text
        .replace(/[;,]+/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .filter(token => Number.isFinite(Number(token.replace(",", "."))));
    return numericTokens.length === 2 && Boolean(parseCoordinatePair(text));
};

export const inferCoordinatorMode = request => {
    const explicit = normalizeCoordinatorMode(request?.mode);
    if (explicit !== SEARCH_COORDINATOR_MODES.Auto) return explicit;
    if (request?.center || request?.coordinates || looksLikeCoordinateQuery(request?.query)) {
        return SEARCH_COORDINATOR_MODES.Nearest;
    }
    if (request?.address === true || request?.addressOptions || request?.district || request?.neighborhood || request?.street) {
        return SEARCH_COORDINATOR_MODES.Address;
    }
    return SEARCH_COORDINATOR_MODES.Text;
};

export const normalizeCoordinatorRequest = request => {
    const input = isObject(request) ? request : { query: request };
    const query = normalizeText(input.query);
    const datasets = unique([
        ...asArray(input.datasets),
        ...(input.dataset ? [input.dataset] : [])
    ].map(normalizeText).filter(Boolean)).slice(0, MAX_COORDINATOR_DATASETS_PER_QUERY);
    const center = parseCoordinatePair(input.center || input.coordinates)
        || (looksLikeCoordinateQuery(query) ? parseCoordinatePair(query) : null);
    return {
        ...input,
        query,
        normalizedQuery: normalizeSearchText(query),
        mode: inferCoordinatorMode(input),
        datasets,
        center,
        radiusMeters: Math.max(0, Number.isFinite(Number(input.radiusMeters)) ? Number(input.radiusMeters) : 5000),
        offset: normalizeInteger(input.offset, { min: 0, fallback: 0 }),
        limit: normalizeInteger(input.limit, { min: 1, max: 500, fallback: 50 }),
        includeQuality: input.includeQuality !== false,
        includeSchemaReport: input.includeSchemaReport === true,
        useCache: input.useCache !== false,
        forceDatasetRefresh: input.forceDatasetRefresh === true
    };
};

export const createCoordinatorCacheKey = (datasetName, datasetRevision, request) => {
    const normalized = normalizeCoordinatorRequest(request);
    const filters = asArray(normalized.filters)
        .map(filter => JSON.stringify(filter))
        .sort();
    return JSON.stringify({
        dataset: normalizeText(datasetName),
        revision: datasetRevision,
        mode: normalized.mode,
        query: normalized.normalizedQuery,
        center: normalized.center,
        radiusMeters: normalized.radiusMeters,
        offset: normalized.offset,
        limit: normalized.limit,
        district: normalizeSearchText(normalized.district),
        neighborhood: normalizeSearchText(normalized.neighborhood),
        street: normalizeSearchText(normalized.street),
        level: normalizeSearchText(normalized.level),
        filters,
        facets: asArray(normalized.facetFields).map(normalizeText).sort(),
        sort: normalized.sort || "",
        minScore: normalized.minScore ?? null
    });
};

export const createCoordinatorResultCache = (options = {}) => {
    const maxEntries = normalizeInteger(options.maxEntries, {
        min: 1,
        max: MAX_COORDINATOR_RESULT_CACHE_SIZE,
        fallback: DEFAULT_COORDINATOR_RESULT_CACHE_SIZE
    });
    const ttlMs = normalizeInteger(options.ttlMs, {
        min: 1,
        max: 60 * 60 * 1000,
        fallback: DEFAULT_COORDINATOR_RESULT_TTL_MS
    });
    const entries = new Map();
    const stats = { hits: 0, misses: 0, sets: 0, evictions: 0, expirations: 0 };

    const removeExpired = now => {
        Array.from(entries.entries()).forEach(([key, entry]) => {
            if (entry.expiresAt <= now) {
                entries.delete(key);
                stats.expirations += 1;
            }
        });
    };

    return {
        get(key, now = Date.now()) {
            removeExpired(now);
            const entry = entries.get(key);
            if (!entry) {
                stats.misses += 1;
                return undefined;
            }
            entries.delete(key);
            entries.set(key, entry);
            stats.hits += 1;
            return entry.value;
        },
        set(key, value, now = Date.now()) {
            removeExpired(now);
            entries.delete(key);
            entries.set(key, { value, expiresAt: now + ttlMs });
            stats.sets += 1;
            while (entries.size > maxEntries) {
                entries.delete(entries.keys().next().value);
                stats.evictions += 1;
            }
            return value;
        },
        delete(key) {
            return entries.delete(key);
        },
        clear() {
            const count = entries.size;
            entries.clear();
            return count;
        },
        invalidateDataset(datasetName) {
            const marker = `"dataset":"${normalizeText(datasetName)}"`;
            let removed = 0;
            Array.from(entries.keys()).forEach(key => {
                if (key.includes(marker)) {
                    entries.delete(key);
                    removed += 1;
                }
            });
            return removed;
        },
        diagnostics(now = Date.now()) {
            removeExpired(now);
            return { ...stats, size: entries.size, maxEntries, ttlMs };
        }
    };
};

export const normalizeCoordinatorPayload = (payload, options = {}) => {
    if (Array.isArray(payload)) return { records: payload, adapted: null };
    if (payload && Array.isArray(payload.records) && payload.page && payload.diagnostics) {
        return { records: payload.records, adapted: payload };
    }
    const adapted = adaptSearchResult(payload, {
        ...options,
        presentation: options.presentation !== false
    });
    return { records: adapted.records, adapted };
};

export const createTextSearchResponse = (index, request, options = {}) => {
    const searchRequest = normalizeSearchRequest({
        ...request,
        query: request.query,
        offset: request.offset,
        limit: request.limit
    });
    const response = executeSearch(index, searchRequest, {
        signal: options.signal,
        weights: options.weights
    });
    return {
        mode: SEARCH_COORDINATOR_MODES.Text,
        results: response.results,
        records: response.results.map(hit => hit.document),
        page: response.page,
        facets: response.facets,
        diagnostics: response.diagnostics,
        request: searchRequest,
        rawSearchResponse: response
    };
};

export const createAddressSearchResponse = (index, request) => {
    const response = searchAddressIndex(index, request.query, {
        ...request.addressOptions,
        offset: request.offset,
        limit: request.limit,
        district: request.district,
        neighborhood: request.neighborhood,
        street: request.street,
        level: request.level,
        center: request.center,
        radiusMeters: request.radiusMeters,
        minScore: request.minScore
    });
    return {
        mode: SEARCH_COORDINATOR_MODES.Address,
        results: response.results,
        records: response.results.map(hit => hit.document),
        page: response.page,
        facets: {},
        diagnostics: {
            indexedCount: index?.documents?.length || 0,
            matchedCount: response.page.total
        },
        rawSearchResponse: response
    };
};

export const createNearestSearchResponse = (index, request) => {
    const center = request.center || parseCoordinatePair(request.query);
    const nearest = findNearestAddresses(index, center, {
        radiusMeters: request.radiusMeters,
        limit: request.limit
    });
    const offset = request.offset;
    const pageItems = nearest.slice(offset, offset + request.limit);
    const nextOffset = offset + pageItems.length;
    return {
        mode: SEARCH_COORDINATOR_MODES.Nearest,
        results: pageItems,
        records: pageItems.map(hit => hit.document),
        page: {
            offset,
            limit: request.limit,
            count: pageItems.length,
            total: nearest.length,
            hasMore: nextOffset < nearest.length,
            nextOffset: nextOffset < nearest.length ? nextOffset : null
        },
        facets: {},
        diagnostics: {
            indexedCount: index?.documents?.length || 0,
            matchedCount: nearest.length,
            center,
            radiusMeters: request.radiusMeters
        },
        rawSearchResponse: { results: nearest }
    };
};

export const mergeCoordinatorResponses = responses => {
    const input = asArray(responses).filter(Boolean);
    const results = input.flatMap(response => response.results || []);
    const records = input.flatMap(response => response.records || []);
    const seen = new Set();
    const dedupedResults = [];
    results.forEach(result => {
        const document = result?.document || result;
        const key = document?.key || document?.id || `${document?.title || ""}|${document?.address || ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        dedupedResults.push(result);
    });
    return {
        results: dedupedResults,
        records,
        datasets: input.map(response => response.dataset).filter(Boolean),
        errors: input.filter(response => response.error).map(response => ({
            dataset: response.dataset,
            error: response.error
        })),
        diagnostics: {
            datasetCount: input.length,
            resultCount: dedupedResults.length,
            rawResultCount: results.length,
            duplicateCount: results.length - dedupedResults.length
        }
    };
};

export const createSearchCoordinator = (options = {}) => {
    const registry = options.registry || createSearchDatasetRegistry(options.registryOptions);
    const resultCache = options.resultCache || createCoordinatorResultCache(options.cacheOptions);
    const stats = {
        searches: 0,
        textSearches: 0,
        addressSearches: 0,
        nearestSearches: 0,
        multiDatasetSearches: 0,
        cacheHits: 0,
        cacheMisses: 0,
        failures: 0,
        ingestions: 0
    };

    const schemaForMode = (mode, request) => request.schema
        || (mode === SEARCH_COORDINATOR_MODES.Text ? GENERIC_RECORD_SCHEMA : ADDRESS_RECORD_SCHEMA);

    const buildTextIndex = (dataset, schema) => registry.getOrBuildDerived(
        dataset.name,
        `execution:${createSchemaFingerprint(schema)}`,
        snapshot => createSearchExecutionIndex(snapshot.records, schema, {
            dedupe: true,
            keepInvalid: false
        })
    );

    const buildAddress = dataset => registry.getOrBuildDerived(
        dataset.name,
        "address-index:v1",
        snapshot => createAddressIndex(snapshot.records)
    );

    const getSchemaReport = (dataset, schema) => registry.getOrBuildDerived(
        dataset.name,
        `schema-report:${createSchemaFingerprint(schema)}`,
        snapshot => createSchemaQualityReport(snapshot.records, schema)
    );

    const runAgainstSnapshot = (dataset, rawRequest, searchOptions = {}) => {
        const request = normalizeCoordinatorRequest(rawRequest);
        throwIfDatasetAborted(searchOptions.signal);
        const cacheKey = createCoordinatorCacheKey(dataset.name, dataset.revision, request);
        if (request.useCache) {
            const cached = resultCache.get(cacheKey, searchOptions.now);
            if (cached !== undefined) {
                stats.cacheHits += 1;
                return cached;
            }
            stats.cacheMisses += 1;
        }

        stats.searches += 1;
        let response;
        let schema;
        let addressReport = null;
        if (request.mode === SEARCH_COORDINATOR_MODES.Address) {
            stats.addressSearches += 1;
            const index = buildAddress(dataset);
            response = createAddressSearchResponse(index, request);
            addressReport = createAddressQualityReport(index);
            schema = ADDRESS_RECORD_SCHEMA;
        } else if (request.mode === SEARCH_COORDINATOR_MODES.Nearest) {
            stats.nearestSearches += 1;
            const index = buildAddress(dataset);
            response = createNearestSearchResponse(index, request);
            addressReport = createAddressQualityReport(index);
            schema = ADDRESS_RECORD_SCHEMA;
        } else {
            stats.textSearches += 1;
            schema = schemaForMode(request.mode, request);
            const index = buildTextIndex(dataset, schema);
            response = createTextSearchResponse(index, request, searchOptions);
        }
        throwIfDatasetAborted(searchOptions.signal);

        const schemaReport = request.includeQuality || request.includeSchemaReport
            ? getSchemaReport(dataset, schema)
            : null;
        const qualitySnapshot = request.includeQuality
            ? createDataQualitySnapshot({
                schemaReport,
                addressReport,
                searchResponse: response.rawSearchResponse,
                label: dataset.name
            })
            : null;
        const qualityGate = qualitySnapshot
            ? evaluateDataReleaseGate(qualitySnapshot, searchOptions.releasePolicy || options.releasePolicy)
            : null;
        const result = {
            ...response,
            dataset: dataset.name,
            datasetRevision: dataset.revision,
            datasetFingerprint: dataset.fingerprint,
            schemaId: schema?.id || null,
            schemaReport: request.includeSchemaReport ? schemaReport : null,
            quality: qualitySnapshot,
            qualityGate,
            request
        };
        if (request.useCache) resultCache.set(cacheKey, result, searchOptions.now);
        return result;
    };

    return {
        registry,
        resultCache,

        ingest(datasetName, payload, ingestOptions = {}) {
            const normalized = normalizeCoordinatorPayload(payload, ingestOptions.adapterOptions);
            const metadata = {
                ...(ingestOptions.metadata || {}),
                adapterContract: normalized.adapted?.diagnostics?.contract || (Array.isArray(payload) ? "array" : "records"),
                adapterDiagnostics: normalized.adapted?.diagnostics || null,
                fields: normalized.adapted?.fields || []
            };
            stats.ingestions += 1;
            resultCache.invalidateDataset(datasetName);
            return ingestOptions.append === true
                ? registry.append(datasetName, normalized.records, metadata, { now: ingestOptions.now })
                : registry.replace(datasetName, normalized.records, metadata, { now: ingestOptions.now });
        },

        register(datasetName, records, metadata = {}, registerOptions = {}) {
            stats.ingestions += 1;
            resultCache.invalidateDataset(datasetName);
            return registry.register(datasetName, records, metadata, registerOptions);
        },

        registerLoader(datasetName, loader) {
            return registry.registerLoader(datasetName, loader);
        },

        async search(datasetName, request = {}, searchOptions = {}) {
            try {
                throwIfDatasetAborted(searchOptions.signal);
                const dataset = await registry.ensure(datasetName, {
                    ...searchOptions,
                    force: request.forceDatasetRefresh === true || searchOptions.force === true,
                    signal: searchOptions.signal
                });
                throwIfDatasetAborted(searchOptions.signal);
                return runAgainstSnapshot(dataset, request, searchOptions);
            } catch (error) {
                stats.failures += 1;
                throw error;
            }
        },

        searchLocal(datasetName, request = {}, searchOptions = {}) {
            const dataset = registry.get(datasetName, {
                allowStale: searchOptions.allowStale !== false,
                now: searchOptions.now
            });
            if (!dataset) {
                const error = new Error(`Dataset is not available locally: ${normalizeText(datasetName)}`);
                error.code = "DATASET_NOT_AVAILABLE";
                stats.failures += 1;
                throw error;
            }
            return runAgainstSnapshot(dataset, request, searchOptions);
        },

        async searchMany(datasetNames, request = {}, searchOptions = {}) {
            const names = unique(asArray(datasetNames).map(normalizeText).filter(Boolean))
                .slice(0, MAX_COORDINATOR_DATASETS_PER_QUERY);
            stats.multiDatasetSearches += 1;
            const settled = await Promise.all(names.map(async datasetName => {
                try {
                    return await this.search(datasetName, request, searchOptions);
                } catch (error) {
                    return { dataset: datasetName, error, results: [], records: [] };
                }
            }));
            return mergeCoordinatorResponses(settled);
        },

        invalidate(datasetName) {
            resultCache.invalidateDataset(datasetName);
            registry.invalidateDerived(datasetName);
            return registry.markStale(datasetName);
        },

        remove(datasetName) {
            resultCache.invalidateDataset(datasetName);
            return registry.remove(datasetName);
        },

        clear() {
            resultCache.clear();
            return registry.clear();
        },

        diagnostics(readOptions = {}) {
            return {
                ...stats,
                registry: registry.diagnostics(readOptions),
                resultCache: resultCache.diagnostics(readOptions.now)
            };
        },

        resetStatistics() {
            Object.keys(stats).forEach(key => {
                stats[key] = 0;
            });
            registry.resetStatistics();
        }
    };
};

export const SearchCoordinatorRuntime = {
    SEARCH_COORDINATOR_MODES,
    DEFAULT_COORDINATOR_RESULT_CACHE_SIZE,
    DEFAULT_COORDINATOR_RESULT_TTL_MS,
    MAX_COORDINATOR_RESULT_CACHE_SIZE,
    MAX_COORDINATOR_DATASETS_PER_QUERY,
    normalizeCoordinatorMode,
    looksLikeCoordinateQuery,
    inferCoordinatorMode,
    normalizeCoordinatorRequest,
    createCoordinatorCacheKey,
    createCoordinatorResultCache,
    normalizeCoordinatorPayload,
    createTextSearchResponse,
    createAddressSearchResponse,
    createNearestSearchResponse,
    mergeCoordinatorResponses,
    createSearchCoordinator
};