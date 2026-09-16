import type {
    AddressSearchV2Index,
    AddressSearchV2Options,
    AddressSearchV2QualityReport,
    AddressSearchV2Response,
    NearestAddressV2Response
} from "./AddressSearchV2Runtime";

export type SearchCoordinatorMode = "auto" | "text" | "address" | "nearest";

export interface NextGenerationSearchRequest extends AddressSearchV2Options {
    mode?: SearchCoordinatorMode;
    query?: string;
    dataset?: string;
    datasets?: string[];
    address?: boolean;
    addressOptions?: AddressSearchV2Options;
    coordinates?: AddressSearchV2Options["center"];
    includeQuality?: boolean;
    includeSchemaReport?: boolean;
    useCache?: boolean;
    forceDatasetRefresh?: boolean;
    filters?: unknown[];
    facetFields?: string[];
    sort?: unknown;
    schema?: unknown;
}

export interface SearchDatasetSnapshot {
    name: string;
    revision: number;
    fingerprint: string;
    recordCount: number;
    records?: unknown[];
    metadata?: Record<string, unknown>;
}

export interface NextGenerationSearchResult {
    mode: Exclude<SearchCoordinatorMode, "auto">;
    results: Array<Record<string, unknown>>;
    records: Array<Record<string, unknown>>;
    page: Record<string, unknown>;
    facets: Record<string, unknown>;
    diagnostics: Record<string, unknown>;
    rawSearchResponse: AddressSearchV2Response | NearestAddressV2Response | Record<string, unknown>;
    dataset?: string;
    datasetRevision?: number;
    datasetFingerprint?: string;
    schemaId?: string | null;
    schemaReport?: unknown;
    quality?: unknown;
    qualityGate?: unknown;
    addressQuality?: AddressSearchV2QualityReport | null;
    request?: NextGenerationSearchRequest;
    runtimeVersion?: string;
}

export interface NextGenerationCoordinatorDiagnostics {
    version: string;
    addressV2Searches: number;
    nearestV2Searches: number;
    localV2Searches: number;
    multiDatasetV2Searches: number;
    v2CacheHits: number;
    v2CacheMisses: number;
    v2Failures: number;
    v2Aborts: number;
    base: Record<string, unknown>;
}

export interface SearchExecutionOptions {
    signal?: AbortSignal;
    now?: number;
    force?: boolean;
    allowStale?: boolean;
    releasePolicy?: unknown;
    [key: string]: unknown;
}

export interface NextGenerationSearchCoordinator {
    registry: {
        ensure(name: string, options?: SearchExecutionOptions): Promise<SearchDatasetSnapshot>;
        get(name: string, options?: SearchExecutionOptions): SearchDatasetSnapshot | null;
        getOrBuildDerived<T>(
            name: string,
            key: string,
            factory: (snapshot: SearchDatasetSnapshot) => T
        ): T;
        [key: string]: unknown;
    };
    resultCache: {
        get(key: string, now?: number): unknown;
        set(key: string, value: unknown, now?: number): unknown;
        invalidateDataset(name: string): number;
        diagnostics(now?: number): Record<string, unknown>;
        [key: string]: unknown;
    };
    baseCoordinator: Record<string, unknown>;
    ingest(
        datasetName: string,
        payload: unknown,
        ingestOptions?: Record<string, unknown>
    ): SearchDatasetSnapshot;
    register(
        datasetName: string,
        records: unknown[],
        metadata?: Record<string, unknown>,
        registerOptions?: Record<string, unknown>
    ): SearchDatasetSnapshot;
    registerLoader(
        datasetName: string,
        loader: (options?: SearchExecutionOptions) => Promise<unknown> | unknown
    ): unknown;
    search(
        datasetName: string,
        request?: NextGenerationSearchRequest,
        searchOptions?: SearchExecutionOptions
    ): Promise<NextGenerationSearchResult>;
    searchLocal(
        datasetName: string,
        request?: NextGenerationSearchRequest,
        searchOptions?: SearchExecutionOptions
    ): NextGenerationSearchResult;
    searchMany(
        datasetNames: string[],
        request?: NextGenerationSearchRequest,
        searchOptions?: SearchExecutionOptions
    ): Promise<Record<string, unknown>>;
    invalidate(datasetName: string): unknown;
    remove(datasetName: string): unknown;
    clear(): unknown;
    diagnostics(readOptions?: SearchExecutionOptions): NextGenerationCoordinatorDiagnostics;
    resetStatistics(): unknown;
}

export declare const NEXT_GENERATION_SEARCH_VERSION: string;
export declare const ADDRESS_V2_DERIVED_KEY: string;

export declare function isAddressV2Mode(mode: SearchCoordinatorMode): boolean;
export declare function createAddressV2CacheKey(
    dataset: Pick<SearchDatasetSnapshot, "name" | "revision">,
    request: NextGenerationSearchRequest
): string;
export declare function buildAddressV2IndexForDataset(
    registry: NextGenerationSearchCoordinator["registry"],
    dataset: SearchDatasetSnapshot,
    options?: {
        indexVersion?: string;
        indexOptions?: Record<string, unknown>;
    }
): AddressSearchV2Index;
export declare function createAddressV2Response(
    index: AddressSearchV2Index,
    request: Required<Pick<NextGenerationSearchRequest, "mode">> & NextGenerationSearchRequest,
    searchOptions?: SearchExecutionOptions
): NextGenerationSearchResult;
export declare function createAddressV2QualityEnvelope(
    dataset: SearchDatasetSnapshot,
    index: AddressSearchV2Index,
    response: NextGenerationSearchResult,
    request: NextGenerationSearchRequest,
    options: {
        registry: NextGenerationSearchCoordinator["registry"];
        releasePolicy?: unknown;
    }
): {
    schemaReport: unknown;
    addressReport: AddressSearchV2QualityReport | null;
    quality: unknown;
    qualityGate: unknown;
};
export declare function createNextGenerationSearchCoordinator(
    options?: Record<string, unknown>
): NextGenerationSearchCoordinator;
export declare const createSearchCoordinator: typeof createNextGenerationSearchCoordinator;

export declare const NextGenerationSearchCoordinatorRuntime: Readonly<{
    NEXT_GENERATION_SEARCH_VERSION: typeof NEXT_GENERATION_SEARCH_VERSION;
    ADDRESS_V2_DERIVED_KEY: typeof ADDRESS_V2_DERIVED_KEY;
    isAddressV2Mode: typeof isAddressV2Mode;
    createAddressV2CacheKey: typeof createAddressV2CacheKey;
    buildAddressV2IndexForDataset: typeof buildAddressV2IndexForDataset;
    createAddressV2Response: typeof createAddressV2Response;
    createAddressV2QualityEnvelope: typeof createAddressV2QualityEnvelope;
    createNextGenerationSearchCoordinator: typeof createNextGenerationSearchCoordinator;
}>;