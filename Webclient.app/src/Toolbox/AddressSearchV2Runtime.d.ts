export type AddressLevelV2 = "district" | "neighborhood" | "street" | "building" | "door" | "address";

export interface AddressCoordinates {
    latitude: number;
    longitude: number;
}

export interface AddressSourceDocument {
    id?: string | number | null;
    key?: string | null;
    sourceIndex?: number;
    level?: AddressLevelV2 | string | null;
    title?: string | null;
    address?: string | null;
    canonicalAddress?: string | null;
    district?: string | null;
    neighborhood?: string | null;
    street?: string | null;
    door?: string | number | null;
    postalCode?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    coordinates?: AddressCoordinates | null;
    fields?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface AddressSearchV2Options {
    offset?: number;
    limit?: number;
    level?: AddressLevelV2 | string | null;
    district?: string;
    neighborhood?: string;
    street?: string;
    center?: AddressCoordinates | readonly [number, number] | string | null;
    radiusMeters?: number;
    minScore?: number;
    maxCandidates?: number;
    maxSpatialCells?: number;
    allowWeakFullScan?: boolean;
    includeEvidence?: boolean;
    signal?: AbortSignal;
}

export interface AddressSemanticDuplicateGroup {
    fingerprint: string;
    positions: number[];
    count: number;
    duplicateCount: number;
}

export interface AddressSemanticDuplicateReport {
    fingerprintCount: number;
    duplicateGroupCount: number;
    duplicateCount: number;
    groups: AddressSemanticDuplicateGroup[];
}

export interface AddressSearchV2IndexDiagnostics {
    base: Record<string, unknown>;
    spatial: Record<string, unknown>;
    semanticDuplicates: AddressSemanticDuplicateReport;
}

export interface AddressSearchV2Index {
    version: string;
    baseIndex: Record<string, unknown> & { documents: AddressSourceDocument[] };
    documents: AddressSourceDocument[];
    byKey: Map<string, AddressSourceDocument>;
    byId: Map<string, AddressSourceDocument>;
    byLevel: Map<string, Set<number>>;
    byDistrict: Map<string, Set<number>>;
    byNeighborhood: Map<string, Set<number>>;
    byStreet: Map<string, Set<number>>;
    byToken: Map<string, Set<number>>;
    byParent: Map<string, Set<number>>;
    spatialIndex: Record<string, unknown>;
    bySemanticFingerprint: Map<string, Set<number>>;
    diagnostics: AddressSearchV2IndexDiagnostics;
    drift: unknown;
}

export interface AddressQuerySummary {
    version: string;
    canonicalText: string;
    tokenCount: number;
    strongTokenCount: number;
    structuralTokenCount: number;
    numericTokenCount: number;
    postalTokenCount: number;
    weakOnly: boolean;
    hasDoorHint: boolean;
    inferredLevel: AddressLevelV2 | null;
}

export interface AddressPlannerDiagnostics {
    version: string;
    strategy: string;
    effectiveLevel: AddressLevelV2 | string | null;
    candidateCount: number;
    preLimitCount: number;
    totalCount: number;
    selectivity: number;
    truncated: boolean;
    maxCandidates: number;
    sources: Array<Record<string, unknown>>;
}

export interface AddressSearchV2Hit {
    document: AddressSourceDocument;
    score: number;
    distanceMeters: number | null;
    distanceBoost?: number;
    matched?: unknown[];
    matchedStrong?: unknown[];
    matchedNumbers?: unknown[];
    matchedPostal?: unknown[];
    matchedStructural?: unknown[];
    matchedCount?: number;
    matchedStrongCount?: number;
    strongCoverage?: number;
    tokenCoverage?: number;
    roadTypeMismatch?: boolean;
}

export interface AddressSearchV2Page {
    offset: number;
    limit: number;
    count: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
}

export interface AddressSearchV2Response {
    version: string;
    results: AddressSearchV2Hit[];
    page: AddressSearchV2Page;
    diagnostics: {
        query: AddressQuerySummary;
        planner: AddressPlannerDiagnostics;
        planIssueCount: number;
        planIssues: Array<Record<string, unknown>>;
        scoredCandidateCount: number;
        matchedCount: number;
        spatial: Record<string, unknown> | null;
    };
}

export interface NearestAddressV2Hit {
    document: AddressSourceDocument;
    distanceMeters: number;
}

export interface NearestAddressV2Response {
    version?: string;
    results: NearestAddressV2Hit[];
    page: AddressSearchV2Page | null;
    diagnostics: Record<string, unknown>;
}

export interface AddressSearchV2QualityReport {
    version: string;
    total: number;
    geocodedCount: number;
    ungeocodedCount: number;
    geocodedRatio: number;
    levelCounts: Record<string, number>;
    hierarchyIssueCount: number;
    hierarchyIssues: Array<Record<string, unknown>>;
    semanticDuplicateCount: number;
    semanticDuplicateGroupCount: number;
    spatialCoverageRatio: number;
    spatialIssueCount: number;
    base: Record<string, unknown>;
    spatial: Record<string, unknown>;
    semanticDuplicates: AddressSemanticDuplicateReport;
    drift: unknown;
}

export interface AddressSearchV2Diagnostics {
    version: string | null;
    documentCount: number;
    tokenCount: number;
    districtCount: number;
    neighborhoodCount: number;
    streetCount: number;
    spatialCellCount: number;
    semanticDuplicateCount: number;
    semanticDuplicateGroupCount: number;
    validationIssueCount: number;
    validationIssues: Array<Record<string, unknown>>;
}

export declare const ADDRESS_SEARCH_V2_VERSION: string;
export declare const DEFAULT_ADDRESS_V2_LIMIT: number;
export declare const MAX_ADDRESS_V2_LIMIT: number;
export declare const DEFAULT_ADDRESS_V2_MAX_CANDIDATES: number;

export declare class AddressSearchV2Error extends Error {
    code: string;
    details: unknown;
    constructor(code: string, message: string, details?: unknown);
}

export declare function throwIfAddressSearchAborted(signal?: AbortSignal): void;
export declare function normalizeAddressV2Options(options?: AddressSearchV2Options): Required<Pick<
    AddressSearchV2Options,
    "offset" | "limit" | "radiusMeters" | "minScore" | "maxCandidates" | "allowWeakFullScan" | "includeEvidence"
>> & AddressSearchV2Options;
export declare function createAddressSemanticFingerprint(document: AddressSourceDocument): string | null;
export declare function createAddressSemanticDuplicateReport(documents: AddressSourceDocument[]): AddressSemanticDuplicateReport;
export declare function createAddressSearchV2Index(
    records: AddressSourceDocument[],
    options?: Record<string, unknown>
): AddressSearchV2Index;
export declare function matchesAddressHierarchyV2(
    document: AddressSourceDocument,
    options?: AddressSearchV2Options
): boolean;
export declare function intersectCandidatePositions(left: Set<number>, right: Set<number>): Set<number>;
export declare function createSpatialCandidatePositions(
    index: AddressSearchV2Index,
    options: AddressSearchV2Options
): { positions: Set<number>; response: Record<string, unknown> } | null;
export declare function createAddressSearchV2Plan(
    index: AddressSearchV2Index,
    query: string,
    options?: AddressSearchV2Options
): {
    analysis: Record<string, unknown>;
    options: AddressSearchV2Options;
    plan: Record<string, unknown> & { positions: number[]; candidateCount: number };
};
export declare function scoreAddressCandidateV2(
    document: AddressSourceDocument,
    analysis: Record<string, unknown>,
    options?: AddressSearchV2Options
): AddressSearchV2Hit;
export declare function compareAddressSearchV2Hits(left: AddressSearchV2Hit, right: AddressSearchV2Hit): number;
export declare function searchAddressV2Index(
    index: AddressSearchV2Index,
    query: string,
    options?: AddressSearchV2Options
): AddressSearchV2Response;
export declare function findNearestAddressesV2(
    index: AddressSearchV2Index,
    center: AddressSearchV2Options["center"],
    options?: AddressSearchV2Options
): NearestAddressV2Response;
export declare function getAddressSemanticDuplicates(
    index: AddressSearchV2Index,
    documentOrFingerprint: AddressSourceDocument | string
): AddressSourceDocument[];
export declare function createAddressSearchV2QualityReport(index: AddressSearchV2Index): AddressSearchV2QualityReport;
export declare function validateAddressSearchV2Index(index: AddressSearchV2Index): Array<Record<string, unknown>>;
export declare function createAddressSearchV2Diagnostics(index: AddressSearchV2Index): AddressSearchV2Diagnostics;

export declare const AddressSearchV2Runtime: Readonly<{
    ADDRESS_SEARCH_V2_VERSION: typeof ADDRESS_SEARCH_V2_VERSION;
    DEFAULT_ADDRESS_V2_LIMIT: typeof DEFAULT_ADDRESS_V2_LIMIT;
    MAX_ADDRESS_V2_LIMIT: typeof MAX_ADDRESS_V2_LIMIT;
    DEFAULT_ADDRESS_V2_MAX_CANDIDATES: typeof DEFAULT_ADDRESS_V2_MAX_CANDIDATES;
    AddressSearchV2Error: typeof AddressSearchV2Error;
    throwIfAddressSearchAborted: typeof throwIfAddressSearchAborted;
    normalizeAddressV2Options: typeof normalizeAddressV2Options;
    createAddressSemanticFingerprint: typeof createAddressSemanticFingerprint;
    createAddressSemanticDuplicateReport: typeof createAddressSemanticDuplicateReport;
    createAddressSearchV2Index: typeof createAddressSearchV2Index;
    matchesAddressHierarchyV2: typeof matchesAddressHierarchyV2;
    intersectCandidatePositions: typeof intersectCandidatePositions;
    createSpatialCandidatePositions: typeof createSpatialCandidatePositions;
    createAddressSearchV2Plan: typeof createAddressSearchV2Plan;
    scoreAddressCandidateV2: typeof scoreAddressCandidateV2;
    compareAddressSearchV2Hits: typeof compareAddressSearchV2Hits;
    searchAddressV2Index: typeof searchAddressV2Index;
    findNearestAddressesV2: typeof findNearestAddressesV2;
    getAddressSemanticDuplicates: typeof getAddressSemanticDuplicates;
    createAddressSearchV2QualityReport: typeof createAddressSearchV2QualityReport;
    validateAddressSearchV2Index: typeof validateAddressSearchV2Index;
    createAddressSearchV2Diagnostics: typeof createAddressSearchV2Diagnostics;
}>;