import {
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
    normalizeSearchRequest,
    type SearchExecutionIndex,
    type SearchPage
} from "./SearchExecutionRuntime";
import {
    createAddressIndex,
    createAddressQualityReport,
    findNearestAddresses,
    parseCoordinatePair,
    searchAddressIndex,
    type AddressIndex,
    type Coordinates
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
} as const);


export type SearchCoordinatorMode = (typeof SEARCH_COORDINATOR_MODES)[keyof typeof SEARCH_COORDINATOR_MODES];

type UnknownRecord = Record<string, unknown>;

export interface CoordinatorRequestInput extends UnknownRecord {
    query?: unknown;
    mode?: unknown;
    datasets?: unknown;
    dataset?: unknown;
    center?: unknown;
    coordinates?: unknown;
    radiusMeters?: unknown;
    offset?: unknown;
    limit?: unknown;
    address?: unknown;
    addressOptions?: unknown;
    district?: unknown;
    neighborhood?: unknown;
    street?: unknown;
    level?: unknown;
    filters?: unknown;
    facetFields?: unknown;
    sort?: unknown;
    minScore?: unknown;
    schema?: unknown;
    includeQuality?: unknown;
    includeSchemaReport?: unknown;
    useCache?: unknown;
    forceDatasetRefresh?: unknown;
}

export interface NormalizedCoordinatorRequest extends UnknownRecord {
    query: string;
    normalizedQuery: string;
    mode: SearchCoordinatorMode;
    datasets: string[];
    center: Coordinates | null;
    radiusMeters: number;
    offset: number;
    limit: number;
    includeQuality: boolean;
    includeSchemaReport: boolean;
    useCache: boolean;
    forceDatasetRefresh: boolean;
}

export interface CoordinatorCacheOptions {
    maxEntries?: unknown;
    ttlMs?: unknown;
}

export interface CoordinatorCacheDiagnostics {
    hits: number;
    misses: number;
    sets: number;
    evictions: number;
    expirations: number;
    size: number;
    maxEntries: number;
    ttlMs: number;
}

export interface DatasetSnapshot {
    name: string;
    revision: number;
    fingerprint: string;
    records: unknown[];
    metadata?: Record<string, unknown>;
}

interface SearchDatasetRegistryLike {
    getOrBuildDerived<T>(
        datasetName: string,
        cacheKey: string,
        builder: (snapshot: DatasetSnapshot) => T
    ): T;
    append(datasetName: unknown, records: unknown[], metadata: UnknownRecord, options: UnknownRecord): unknown;
    replace(datasetName: unknown, records: unknown[], metadata: UnknownRecord, options: UnknownRecord): unknown;
    register(datasetName: unknown, records: unknown, metadata: unknown, options: unknown): unknown;
    registerLoader(datasetName: unknown, loader: unknown): unknown;
    ensure(datasetName: unknown, options: UnknownRecord): Promise<DatasetSnapshot>;
    get(datasetName: unknown, options: UnknownRecord): DatasetSnapshot | null | undefined;
    invalidateDerived(datasetName: unknown): unknown;
    markStale(datasetName: unknown): unknown;
    remove(datasetName: unknown): unknown;
    clear(): unknown;
    diagnostics(options?: unknown): unknown;
    resetStatistics(): void;
}

interface AdaptedSearchPayload {
    records: unknown[];
    diagnostics?: UnknownRecord;
    fields?: unknown[];
}

export interface CoordinatorPayload {
    records: unknown[];
    adapted: AdaptedSearchPayload | null;
}

export interface CoordinatorSearchOptions extends UnknownRecord {
    signal?: AbortSignal | null;
    weights?: Readonly<Record<string, number>>;
    now?: number;
    force?: boolean;
    allowStale?: boolean;
    releasePolicy?: unknown;
}

export interface CoordinatorResponse {
    mode?: SearchCoordinatorMode;
    results: unknown[];
    records: unknown[];
    page?: SearchPage;
    facets?: Record<string, unknown>;
    diagnostics?: UnknownRecord;
    rawSearchResponse?: unknown;
    request?: unknown;
    dataset?: string;
    datasetRevision?: number;
    datasetFingerprint?: string;
    schemaId?: unknown;
    schemaReport?: unknown;
    quality?: unknown;
    qualityGate?: unknown;
    error?: unknown;
}

export interface CoordinatorResultCache {
    get(key: string, now?: number): CoordinatorResponse | undefined;
    set(key: string, value: CoordinatorResponse, now?: number): CoordinatorResponse;
    delete(key: string): boolean;
    clear(): number;
    invalidateDataset(datasetName: unknown): number;
    diagnostics(now?: number): CoordinatorCacheDiagnostics;
}

interface CoordinatorOptions {
    registry?: SearchDatasetRegistryLike;
    registryOptions?: unknown;
    resultCache?: CoordinatorResultCache;
    cacheOptions?: CoordinatorCacheOptions;
    releasePolicy?: unknown;
}

interface CoordinatorIngestOptions extends UnknownRecord {
    adapterOptions?: UnknownRecord;
    metadata?: UnknownRecord;
    append?: boolean;
    now?: number;
}

interface CoordinatorStats {
    searches: number;
    textSearches: number;
    addressSearches: number;
    nearestSearches: number;
    multiDatasetSearches: number;
    cacheHits: number;
    cacheMisses: number;
    failures: number;
    ingestions: number;
}

const normalizeIntegerValue = (
    value: unknown,
    options: Readonly<{ min?: number; max?: number; fallback: number }>
): number => normalizeInteger(value as never, options as never) as number;

export const DEFAULT_COORDINATOR_RESULT_CACHE_SIZE = 100;
export const DEFAULT_COORDINATOR_RESULT_TTL_MS = 30000;
export const MAX_COORDINATOR_RESULT_CACHE_SIZE = 1000;
export const MAX_COORDINATOR_DATASETS_PER_QUERY = 16;

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const unique = <T>(values: readonly T[]): T[] => Array.from(new Set(values));
const isObject = (value: unknown): value is UnknownRecord =>
    value !== null && typeof value === "object" && !Array.isArray(value);

export const normalizeCoordinatorMode = (value: unknown): SearchCoordinatorMode => {
    const normalized = normalizeText(value).toLocaleLowerCase("tr-TR");
    const candidate = normalized as SearchCoordinatorMode;
    return (Object.values(SEARCH_COORDINATOR_MODES) as SearchCoordinatorMode[]).includes(candidate)
        ? candidate
        : SEARCH_COORDINATOR_MODES.Auto;
};

export const looksLikeCoordinateQuery = (value: unknown): boolean => {
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

export const inferCoordinatorMode = (request: CoordinatorRequestInput): SearchCoordinatorMode => {
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

export const normalizeCoordinatorRequest = (request: unknown): NormalizedCoordinatorRequest => {
    const input: CoordinatorRequestInput = isObject(request) ? request : { query: request };
    const query = normalizeText(input.query);
    const datasets = unique([
        ...asArray(input.datasets),
        ...(input.dataset ? [input.dataset] : [])
    ].map(value => normalizeText(value)).filter(Boolean)).slice(0, MAX_COORDINATOR_DATASETS_PER_QUERY);
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
        offset: normalizeIntegerValue(input.offset, { min: 0, fallback: 0 }),
        limit: normalizeIntegerValue(input.limit, { min: 1, max: 500, fallback: 50 }),
        includeQuality: input.includeQuality !== false,
        includeSchemaReport: input.includeSchemaReport === true,
        useCache: input.useCache !== false,
        forceDatasetRefresh: input.forceDatasetRefresh === true
    };
};

export const createCoordinatorCacheKey = (
    datasetName: unknown,
    datasetRevision: unknown,
    request: unknown
): string => {
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
        facets: asArray(normalized.facetFields).map(value => normalizeText(value)).sort(),
        sort: normalized.sort || "",
        minScore: normalized.minScore ?? null
    });
};

export const createCoordinatorResultCache = (options: CoordinatorCacheOptions = {}): CoordinatorResultCache => {
    const maxEntries = normalizeIntegerValue(options.maxEntries, {
        min: 1,
        max: MAX_COORDINATOR_RESULT_CACHE_SIZE,
        fallback: DEFAULT_COORDINATOR_RESULT_CACHE_SIZE
    });
    const ttlMs = normalizeIntegerValue(options.ttlMs, {
        min: 1,
        max: 60 * 60 * 1000,
        fallback: DEFAULT_COORDINATOR_RESULT_TTL_MS
    });
    const entries = new Map<string, { value: CoordinatorResponse; expiresAt: number }>();
    const stats: CoordinatorStats = { hits: 0, misses: 0, sets: 0, evictions: 0, expirations: 0 };

    const removeExpired = (now: number): void => {
        Array.from(entries.entries()).forEach(([key, entry]) => {
            if (entry.expiresAt <= now) {
                entries.delete(key);
                stats.expirations += 1;
            }
        });
    };

    return {
        get(key: string, now = Date.now()): CoordinatorResponse | undefined {
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
        set(key: string, value: CoordinatorResponse, now = Date.now()): CoordinatorResponse {
            removeExpired(now);
            entries.delete(key);
            entries.set(key, { value, expiresAt: now + ttlMs });
            stats.sets += 1;
            while (entries.size > maxEntries) {
                const oldestKey = entries.keys().next().value;
                if (oldestKey === undefined) break;
                entries.delete(oldestKey);
                stats.evictions += 1;
            }
            return value;
        },
        delete(key: string): boolean {
            return entries.delete(key);
        },
        clear(): number {
            const count = entries.size;
            entries.clear();
            return count;
        },
        invalidateDataset(datasetName: unknown): number {
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
        diagnostics(now = Date.now()): CoordinatorCacheDiagnostics {
            removeExpired(now);
            return { ...stats, size: entries.size, maxEntries, ttlMs };
        }
    };
};

export const normalizeCoordinatorPayload = (
    payload: unknown,
    options: UnknownRecord = {}
): CoordinatorPayload => {
    if (Array.isArray(payload)) return { records: payload, adapted: null };
    if (isObject(payload) && Array.isArray(payload.records) && payload.page && payload.diagnostics) {
        return { records: payload.records, adapted: payload as unknown as AdaptedSearchPayload };
    }
    const adapted = adaptSearchResult(payload as never, {
        ...options,
        presentation: options.presentation !== false
    } as never) as AdaptedSearchPayload;
    return { records: Array.isArray(adapted.records) ? adapted.records : [], adapted };
};

export const createTextSearchResponse = (
    index: SearchExecutionIndex,
    request: NormalizedCoordinatorRequest,
    options: CoordinatorSearchOptions = {}
): CoordinatorResponse => {
    const searchRequest = normalizeSearchRequest({
        ...request,
        query: request.query,
        offset: request.offset,
        limit: request.limit
    });
    const executionOptions: { signal?: AbortSignal | null; weights?: Readonly<Record<string, number>> } = {};
    if (options.signal !== undefined) executionOptions.signal = options.signal;
    if (options.weights !== undefined) executionOptions.weights = options.weights;
    const response = executeSearch(index, searchRequest, executionOptions);
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

export const createAddressSearchResponse = (
    index: AddressIndex,
    request: NormalizedCoordinatorRequest
): CoordinatorResponse => {
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

export const createNearestSearchResponse = (
    index: AddressIndex,
    request: NormalizedCoordinatorRequest
): CoordinatorResponse => {
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

export const mergeCoordinatorResponses = (responses: unknown): CoordinatorResponse & {
    datasets: string[];
    errors: Array<{ dataset?: string; error: unknown }>;
} => {
    const input = asArray(responses)
        .filter((response): response is CoordinatorResponse => isObject(response) && Array.isArray(response.results));
    const results = input.flatMap(response => response.results || []);
    const records = input.flatMap(response => response.records || []);
    const seen = new Set();
    const dedupedResults: unknown[] = [];
    results.forEach(result => {
        const resultRecord = isObject(result) ? result : {};
        const document = isObject(resultRecord.document) ? resultRecord.document : resultRecord;
        const key = document.key || document.id || `${document.title || ""}|${document.address || ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        dedupedResults.push(result);
    });
    return {
        results: dedupedResults,
        records,
        datasets: input.map(response => response.dataset).filter((value): value is string => Boolean(value)),
        errors: input.filter(response => response.error !== undefined).map(response => {
            const entry: { dataset?: string; error: unknown } = { error: response.error };
            if (response.dataset !== undefined) entry.dataset = response.dataset;
            return entry;
        }),
        diagnostics: {
            datasetCount: input.length,
            resultCount: dedupedResults.length,
            rawResultCount: results.length,
            duplicateCount: results.length - dedupedResults.length
        }
    };
};

export const createSearchCoordinator = (options: CoordinatorOptions = {}) => {
    const registry = options.registry
        || createSearchDatasetRegistry(options.registryOptions as never) as SearchDatasetRegistryLike;
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

    const schemaForMode = (
        mode: SearchCoordinatorMode,
        request: NormalizedCoordinatorRequest
    ): typeof GENERIC_RECORD_SCHEMA => (request.schema as typeof GENERIC_RECORD_SCHEMA | undefined)
        || (mode === SEARCH_COORDINATOR_MODES.Text ? GENERIC_RECORD_SCHEMA : ADDRESS_RECORD_SCHEMA as typeof GENERIC_RECORD_SCHEMA);

    const buildTextIndex = (
        dataset: DatasetSnapshot,
        schema: typeof GENERIC_RECORD_SCHEMA
    ): SearchExecutionIndex => registry.getOrBuildDerived<SearchExecutionIndex>(
        dataset.name,
        `execution:${createSchemaFingerprint(schema)}`,
        snapshot => createSearchExecutionIndex(snapshot.records, schema, {
            dedupe: true,
            keepInvalid: false
        })
    );

    const buildAddress = (dataset: DatasetSnapshot): AddressIndex => registry.getOrBuildDerived<AddressIndex>(
        dataset.name,
        "address-index:v1",
        snapshot => createAddressIndex(snapshot.records)
    );

    const getSchemaReport = (
        dataset: DatasetSnapshot,
        schema: typeof GENERIC_RECORD_SCHEMA
    ): unknown => registry.getOrBuildDerived<unknown>(
        dataset.name,
        `schema-report:${createSchemaFingerprint(schema)}`,
        snapshot => createSchemaQualityReport(snapshot.records, schema)
    );

    const runAgainstSnapshot = (
        dataset: DatasetSnapshot,
        rawRequest: unknown,
        searchOptions: CoordinatorSearchOptions = {}
    ): CoordinatorResponse => {
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
        let response: CoordinatorResponse;
        let schema: typeof GENERIC_RECORD_SCHEMA;
        let addressReport: unknown = null;
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
            } as never)
            : null;
        const qualityGate = qualitySnapshot
            ? evaluateDataReleaseGate(
                qualitySnapshot as never,
                (searchOptions.releasePolicy || options.releasePolicy) as never
            )
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

        ingest(datasetName: unknown, payload: unknown, ingestOptions: CoordinatorIngestOptions = {}) {
            const normalized = normalizeCoordinatorPayload(payload, ingestOptions.adapterOptions);
            const metadata = {
                ...ingestOptions.metadata,
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

        register(datasetName: unknown, records: unknown, metadata: unknown = {}, registerOptions: unknown = {}) {
            stats.ingestions += 1;
            resultCache.invalidateDataset(datasetName);
            return registry.register(datasetName, records, metadata, registerOptions);
        },

        registerLoader(datasetName: unknown, loader: unknown) {
            return registry.registerLoader(datasetName, loader);
        },

        async search(datasetName: unknown, request: CoordinatorRequestInput = {}, searchOptions: CoordinatorSearchOptions = {}) {
            try {
                throwIfDatasetAborted(searchOptions.signal);
                const ensureOptions: UnknownRecord = {
                    ...searchOptions,
                    force: request.forceDatasetRefresh === true || searchOptions.force === true
                };
                if (searchOptions.signal !== undefined) ensureOptions.signal = searchOptions.signal;
                const dataset = await registry.ensure(datasetName, ensureOptions);
                throwIfDatasetAborted(searchOptions.signal);
                return runAgainstSnapshot(dataset, request, searchOptions);
            } catch (error) {
                stats.failures += 1;
                throw error;
            }
        },

        searchLocal(datasetName: unknown, request: CoordinatorRequestInput = {}, searchOptions: CoordinatorSearchOptions = {}) {
            const dataset = registry.get(datasetName, {
                allowStale: searchOptions.allowStale !== false,
                now: searchOptions.now
            });
            if (!dataset) {
                const error = Object.assign(
                    new Error(`Dataset is not available locally: ${normalizeText(datasetName)}`),
                    { code: "DATASET_NOT_AVAILABLE" }
                );
                stats.failures += 1;
                throw error;
            }
            return runAgainstSnapshot(dataset, request, searchOptions);
        },

        async searchMany(datasetNames: unknown, request: CoordinatorRequestInput = {}, searchOptions: CoordinatorSearchOptions = {}) {
            const names = unique(asArray(datasetNames).map(value => normalizeText(value)).filter(Boolean))
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

        invalidate(datasetName: unknown) {
            resultCache.invalidateDataset(datasetName);
            registry.invalidateDerived(datasetName);
            return registry.markStale(datasetName);
        },

        remove(datasetName: unknown) {
            resultCache.invalidateDataset(datasetName);
            return registry.remove(datasetName);
        },

        clear() {
            resultCache.clear();
            return registry.clear();
        },

        diagnostics(readOptions: UnknownRecord = {}) {
            return {
                ...stats,
                registry: registry.diagnostics(readOptions),
                resultCache: resultCache.diagnostics(readOptions.now)
            };
        },

        resetStatistics() {
            (Object.keys(stats) as Array<keyof CoordinatorStats>).forEach(key => {
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
