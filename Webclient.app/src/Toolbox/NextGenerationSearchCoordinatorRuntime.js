import {
    normalizeText
} from "./DataIntegrityHelper";
import {
    ADDRESS_RECORD_SCHEMA,
    createSchemaFingerprint,
    createSchemaQualityReport
} from "./RecordSchemaRuntime";
import {
    SEARCH_COORDINATOR_MODES,
    createCoordinatorCacheKey,
    createSearchCoordinator as createBaseSearchCoordinator,
    mergeCoordinatorResponses,
    normalizeCoordinatorRequest
} from "./SearchCoordinatorRuntime";
import {
    createDataQualitySnapshot,
    evaluateDataReleaseGate
} from "./DataReleaseGuardRuntime";
import {
    createAddressSearchV2Diagnostics,
    createAddressSearchV2Index,
    createAddressSearchV2QualityReport,
    findNearestAddressesV2,
    searchAddressV2Index,
    throwIfAddressSearchAborted
} from "./AddressSearchV2Runtime";
import {
    throwIfDatasetAborted
} from "./SearchDatasetRegistry";

export const NEXT_GENERATION_SEARCH_VERSION = "2.0.0";
export const ADDRESS_V2_DERIVED_KEY = "address-index:v2";

const asArray = value => Array.isArray(value) ? value : [];
const unique = values => Array.from(new Set(values));

export const isAddressV2Mode = mode => mode === SEARCH_COORDINATOR_MODES.Address
    || mode === SEARCH_COORDINATOR_MODES.Nearest;

export const createAddressV2CacheKey = (dataset, request) => `v2:${createCoordinatorCacheKey(
    dataset.name,
    dataset.revision,
    request
)}`;

export const buildAddressV2IndexForDataset = (registry, dataset, options = {}) => registry.getOrBuildDerived(
    dataset.name,
    `${ADDRESS_V2_DERIVED_KEY}:${options.indexVersion || "default"}`,
    snapshot => createAddressSearchV2Index(snapshot.records, options.indexOptions)
);

export const createAddressV2Response = (index, request, searchOptions = {}) => {
    throwIfDatasetAborted(searchOptions.signal);
    throwIfAddressSearchAborted(searchOptions.signal);
    if (request.mode === SEARCH_COORDINATOR_MODES.Nearest) {
        const nearest = findNearestAddressesV2(index, request.center || request.query, {
            offset: request.offset,
            limit: request.limit,
            district: request.district,
            neighborhood: request.neighborhood,
            street: request.street,
            level: request.level,
            radiusMeters: request.radiusMeters,
            maxSpatialCells: request.maxSpatialCells,
            signal: searchOptions.signal
        });
        return {
            mode: SEARCH_COORDINATOR_MODES.Nearest,
            results: nearest.results,
            records: nearest.results.map(hit => hit.document),
            page: nearest.page || {
                offset: request.offset,
                limit: request.limit,
                count: 0,
                total: 0,
                hasMore: false,
                nextOffset: null
            },
            facets: {},
            diagnostics: {
                engine: "address-v2",
                ...nearest.diagnostics,
                index: createAddressSearchV2Diagnostics(index)
            },
            rawSearchResponse: nearest
        };
    }

    const response = searchAddressV2Index(index, request.query, {
        ...request.addressOptions,
        offset: request.offset,
        limit: request.limit,
        district: request.district,
        neighborhood: request.neighborhood,
        street: request.street,
        level: request.level,
        center: request.center,
        radiusMeters: request.radiusMeters,
        minScore: request.minScore,
        maxCandidates: request.maxCandidates,
        maxSpatialCells: request.maxSpatialCells,
        allowWeakFullScan: request.allowWeakFullScan,
        includeEvidence: request.includeEvidence,
        signal: searchOptions.signal
    });
    return {
        mode: SEARCH_COORDINATOR_MODES.Address,
        results: response.results,
        records: response.results.map(hit => hit.document),
        page: response.page,
        facets: {},
        diagnostics: {
            engine: "address-v2",
            ...response.diagnostics,
            index: createAddressSearchV2Diagnostics(index)
        },
        rawSearchResponse: response
    };
};

export const createAddressV2QualityEnvelope = (dataset, index, response, request, options = {}) => {
    if (!request.includeQuality && !request.includeSchemaReport) {
        return {
            schemaReport: null,
            addressReport: null,
            quality: null,
            qualityGate: null
        };
    }
    const schemaReport = options.registry.getOrBuildDerived(
        dataset.name,
        `schema-report:${createSchemaFingerprint(ADDRESS_RECORD_SCHEMA)}`,
        snapshot => createSchemaQualityReport(snapshot.records, ADDRESS_RECORD_SCHEMA)
    );
    const addressReport = createAddressSearchV2QualityReport(index);
    const quality = request.includeQuality
        ? createDataQualitySnapshot({
            schemaReport,
            addressReport,
            searchResponse: response.rawSearchResponse,
            label: dataset.name
        })
        : null;
    const qualityGate = quality
        ? evaluateDataReleaseGate(quality, options.releasePolicy)
        : null;
    return {
        schemaReport: request.includeSchemaReport ? schemaReport : null,
        addressReport,
        quality,
        qualityGate
    };
};

export const createNextGenerationSearchCoordinator = (options = {}) => {
    const base = options.baseCoordinator || createBaseSearchCoordinator(options);
    const registry = base.registry;
    const resultCache = base.resultCache;
    const stats = {
        addressV2Searches: 0,
        nearestV2Searches: 0,
        localV2Searches: 0,
        multiDatasetV2Searches: 0,
        v2CacheHits: 0,
        v2CacheMisses: 0,
        v2Failures: 0,
        v2Aborts: 0
    };

    const runAddressV2AgainstDataset = (dataset, rawRequest, searchOptions = {}) => {
        const request = normalizeCoordinatorRequest(rawRequest);
        if (!isAddressV2Mode(request.mode)) {
            throw new Error(`Address V2 cannot execute coordinator mode: ${request.mode}`);
        }
        throwIfDatasetAborted(searchOptions.signal);
        const cacheKey = createAddressV2CacheKey(dataset, request);
        if (request.useCache) {
            const cached = resultCache.get(cacheKey, searchOptions.now);
            if (cached !== undefined) {
                stats.v2CacheHits += 1;
                return cached;
            }
            stats.v2CacheMisses += 1;
        }

        if (request.mode === SEARCH_COORDINATOR_MODES.Address) stats.addressV2Searches += 1;
        else stats.nearestV2Searches += 1;

        const index = buildAddressV2IndexForDataset(registry, dataset, {
            indexVersion: options.addressIndexVersion,
            indexOptions: options.addressIndexOptions
        });
        const response = createAddressV2Response(index, request, searchOptions);
        throwIfDatasetAborted(searchOptions.signal);
        const qualityEnvelope = createAddressV2QualityEnvelope(dataset, index, response, request, {
            registry,
            releasePolicy: searchOptions.releasePolicy || options.releasePolicy
        });
        const result = {
            ...response,
            dataset: dataset.name,
            datasetRevision: dataset.revision,
            datasetFingerprint: dataset.fingerprint,
            schemaId: ADDRESS_RECORD_SCHEMA.id,
            schemaReport: qualityEnvelope.schemaReport,
            quality: qualityEnvelope.quality,
            qualityGate: qualityEnvelope.qualityGate,
            addressQuality: qualityEnvelope.addressReport,
            request,
            runtimeVersion: NEXT_GENERATION_SEARCH_VERSION
        };
        if (request.useCache) resultCache.set(cacheKey, result, searchOptions.now);
        return result;
    };

    const executeAddressV2 = async (datasetName, request, searchOptions) => {
        try {
            throwIfDatasetAborted(searchOptions.signal);
            const dataset = await registry.ensure(datasetName, {
                ...searchOptions,
                force: request.forceDatasetRefresh === true || searchOptions.force === true,
                signal: searchOptions.signal
            });
            throwIfDatasetAborted(searchOptions.signal);
            return runAddressV2AgainstDataset(dataset, request, searchOptions);
        } catch (error) {
            stats.v2Failures += 1;
            if (error?.name === "AbortError" || searchOptions.signal?.aborted) stats.v2Aborts += 1;
            throw error;
        }
    };

    const facade = {
        registry,
        resultCache,
        baseCoordinator: base,

        ingest(datasetName, payload, ingestOptions = {}) {
            return base.ingest(datasetName, payload, ingestOptions);
        },

        register(datasetName, records, metadata = {}, registerOptions = {}) {
            return base.register(datasetName, records, metadata, registerOptions);
        },

        registerLoader(datasetName, loader) {
            return base.registerLoader(datasetName, loader);
        },

        async search(datasetName, rawRequest = {}, searchOptions = {}) {
            const request = normalizeCoordinatorRequest(rawRequest);
            if (!isAddressV2Mode(request.mode)) return base.search(datasetName, request, searchOptions);
            return executeAddressV2(datasetName, request, searchOptions);
        },

        searchLocal(datasetName, rawRequest = {}, searchOptions = {}) {
            const request = normalizeCoordinatorRequest(rawRequest);
            if (!isAddressV2Mode(request.mode)) return base.searchLocal(datasetName, request, searchOptions);
            const dataset = registry.get(datasetName, {
                allowStale: searchOptions.allowStale !== false,
                now: searchOptions.now
            });
            if (!dataset) {
                const error = new Error(`Dataset is not available locally: ${normalizeText(datasetName)}`);
                error.code = "DATASET_NOT_AVAILABLE";
                stats.v2Failures += 1;
                throw error;
            }
            stats.localV2Searches += 1;
            return runAddressV2AgainstDataset(dataset, request, searchOptions);
        },

        async searchMany(datasetNames, rawRequest = {}, searchOptions = {}) {
            const request = normalizeCoordinatorRequest(rawRequest);
            if (!isAddressV2Mode(request.mode)) return base.searchMany(datasetNames, request, searchOptions);
            const names = unique(asArray(datasetNames).map(normalizeText).filter(Boolean)).slice(0, 16);
            stats.multiDatasetV2Searches += 1;
            const settled = await Promise.all(names.map(async datasetName => {
                try {
                    return await facade.search(datasetName, request, searchOptions);
                } catch (error) {
                    return { dataset: datasetName, error, results: [], records: [] };
                }
            }));
            return mergeCoordinatorResponses(settled);
        },

        invalidate(datasetName) {
            return base.invalidate(datasetName);
        },

        remove(datasetName) {
            return base.remove(datasetName);
        },

        clear() {
            return base.clear();
        },

        diagnostics(readOptions = {}) {
            return {
                version: NEXT_GENERATION_SEARCH_VERSION,
                ...stats,
                base: base.diagnostics(readOptions)
            };
        },

        resetStatistics() {
            Object.keys(stats).forEach(key => {
                stats[key] = 0;
            });
            return base.resetStatistics();
        }
    };

    return facade;
};

export const NextGenerationSearchCoordinatorRuntime = {
    NEXT_GENERATION_SEARCH_VERSION,
    ADDRESS_V2_DERIVED_KEY,
    isAddressV2Mode,
    createAddressV2CacheKey,
    buildAddressV2IndexForDataset,
    createAddressV2Response,
    createAddressV2QualityEnvelope,
    createNextGenerationSearchCoordinator
};

export const createSearchCoordinator = createNextGenerationSearchCoordinator;