import {
    normalizeFiniteNumber,
    normalizeInteger,
    normalizeText
} from "./DataIntegrityHelper";
import {
    ADDRESS_LEVELS,
    createAddressIndex,
    createAddressQualityReport,
    haversineDistanceMeters,
    parseCoordinatePair
} from "./AddressSearchRuntime";
import {
    analyzeAddressQuery,
    canonicalizeAddressText,
    compareAddressSemanticScores,
    scoreAddressDocumentSemantic,
    summarizeAddressAnalysis
} from "./AddressQuerySemanticsRuntime";
import {
    createAddressCandidatePlan,
    createFallbackAddressPlan,
    createPlannerDiagnostics,
    materializeAddressCandidates,
    validateAddressCandidatePlan
} from "./AddressCandidatePlannerRuntime";
import {
    createAdaptiveSpatialIndex,
    createSpatialIndexQualityReport,
    queryNearestSpatial,
    querySpatialRadius
} from "./SpatialSearchIndexRuntime";

export const ADDRESS_SEARCH_V2_VERSION = "2.0.0";
export const DEFAULT_ADDRESS_V2_LIMIT = 25;
export const MAX_ADDRESS_V2_LIMIT = 500;
export const DEFAULT_ADDRESS_V2_MAX_CANDIDATES = 5000;

const asArray = value => Array.isArray(value) ? value : [];
const unique = values => Array.from(new Set(values.filter(Boolean)));
const isNil = value => value === null || value === undefined;

export class AddressSearchV2Error extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = "AddressSearchV2Error";
        this.code = code;
        this.details = details;
    }
}

export const throwIfAddressSearchAborted = signal => {
    if (!signal?.aborted) return;
    const error = new AddressSearchV2Error("ADDRESS_SEARCH_ABORTED", "Address search was aborted");
    error.name = "AbortError";
    throw error;
};

export const normalizeAddressV2Options = options => {
    const rawOffset = normalizeFiniteNumber(options?.offset, 0);
    const limit = normalizeInteger(options?.limit, {
        min: 1,
        max: MAX_ADDRESS_V2_LIMIT,
        fallback: DEFAULT_ADDRESS_V2_LIMIT
    });
    return {
        offset: Math.max(0, Math.trunc(rawOffset || 0)),
        limit,
        level: normalizeText(options?.level).toLocaleLowerCase("tr-TR") || null,
        district: normalizeText(options?.district),
        neighborhood: normalizeText(options?.neighborhood),
        street: normalizeText(options?.street),
        center: parseCoordinatePair(options?.center),
        radiusMeters: Math.max(0, normalizeFiniteNumber(options?.radiusMeters, 0) || 0),
        minScore: Math.max(0, normalizeFiniteNumber(options?.minScore, 1) || 0),
        maxCandidates: normalizeInteger(options?.maxCandidates, {
            min: 1,
            max: 50000,
            fallback: DEFAULT_ADDRESS_V2_MAX_CANDIDATES
        }),
        allowWeakFullScan: options?.allowWeakFullScan === true,
        includeEvidence: options?.includeEvidence === true
    };
};

export const createAddressSemanticFingerprint = document => {
    const level = normalizeText(document?.level || ADDRESS_LEVELS.Address).toLocaleLowerCase("tr-TR");
    const district = canonicalizeAddressText(document?.district || document?.fields?.district);
    const neighborhood = canonicalizeAddressText(document?.neighborhood || document?.fields?.neighborhood);
    const street = canonicalizeAddressText(document?.street || document?.fields?.street);
    const door = canonicalizeAddressText(document?.door || document?.fields?.door);
    const hierarchy = [district, neighborhood, street, door];
    if (hierarchy.some(Boolean)) return `${level}|${hierarchy.join("|")}`;
    const fallback = canonicalizeAddressText(document?.canonicalAddress || document?.address || document?.title);
    return fallback ? `${level}|${fallback}` : null;
};

export const createAddressSemanticDuplicateReport = documents => {
    const byFingerprint = new Map();
    asArray(documents).forEach((document, position) => {
        const fingerprint = createAddressSemanticFingerprint(document);
        if (!fingerprint) return;
        if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, []);
        byFingerprint.get(fingerprint).push(position);
    });
    const groups = Array.from(byFingerprint.entries())
        .filter(([, positions]) => positions.length > 1)
        .map(([fingerprint, positions]) => ({
            fingerprint,
            positions: [...positions],
            count: positions.length,
            duplicateCount: positions.length - 1
        }));
    return {
        fingerprintCount: byFingerprint.size,
        duplicateGroupCount: groups.length,
        duplicateCount: groups.reduce((total, group) => total + group.duplicateCount, 0),
        groups
    };
};

export const createAddressSearchV2Index = (records, options = {}) => {
    const baseIndex = options.baseIndex || createAddressIndex(records, options);
    const spatialIndex = options.spatialIndex || createAdaptiveSpatialIndex(baseIndex.documents, options.spatialOptions);
    const duplicateReport = createAddressSemanticDuplicateReport(baseIndex.documents);
    const bySemanticFingerprint = new Map();
    baseIndex.documents.forEach((document, position) => {
        const fingerprint = createAddressSemanticFingerprint(document);
        if (!fingerprint) return;
        if (!bySemanticFingerprint.has(fingerprint)) bySemanticFingerprint.set(fingerprint, new Set());
        bySemanticFingerprint.get(fingerprint).add(position);
    });
    return {
        version: ADDRESS_SEARCH_V2_VERSION,
        baseIndex,
        documents: baseIndex.documents,
        byKey: baseIndex.byKey,
        byId: baseIndex.byId,
        byLevel: baseIndex.byLevel,
        byDistrict: baseIndex.byDistrict,
        byNeighborhood: baseIndex.byNeighborhood,
        byStreet: baseIndex.byStreet,
        byToken: baseIndex.byToken,
        byParent: baseIndex.byParent,
        spatialIndex,
        bySemanticFingerprint,
        diagnostics: {
            base: baseIndex.diagnostics,
            spatial: spatialIndex.diagnostics,
            semanticDuplicates: duplicateReport
        },
        drift: baseIndex.drift
    };
};

export const matchesAddressHierarchyV2 = (document, options = {}) => {
    if (options.level && normalizeText(document?.level).toLocaleLowerCase("tr-TR") !== options.level) return false;
    const comparisons = [
        [options.district, document?.district || document?.fields?.district],
        [options.neighborhood, document?.neighborhood || document?.fields?.neighborhood],
        [options.street, document?.street || document?.fields?.street]
    ];
    return comparisons.every(([expected, actual]) => !expected
        || canonicalizeAddressText(expected) === canonicalizeAddressText(actual));
};

export const intersectCandidatePositions = (left, right) => {
    if (!(left instanceof Set) || !(right instanceof Set)) return new Set();
    const smaller = left.size <= right.size ? left : right;
    const larger = left.size <= right.size ? right : left;
    const result = new Set();
    smaller.forEach(position => {
        if (larger.has(position)) result.add(position);
    });
    return result;
};

export const createSpatialCandidatePositions = (index, options) => {
    if (!options.center || options.radiusMeters <= 0 || !index?.spatialIndex) return null;
    const spatial = querySpatialRadius(index.spatialIndex, options.center, options.radiusMeters, {
        limit: Math.max(options.maxCandidates, options.limit + options.offset),
        maxCells: options.maxSpatialCells
    });
    return {
        positions: new Set(spatial.results.map(item => item.position)),
        response: spatial
    };
};

export const createAddressSearchV2Plan = (index, query, options = {}) => {
    const normalized = normalizeAddressV2Options(options);
    const analysis = analyzeAddressQuery(query, normalized);
    const plannerOptions = {
        ...normalized,
        level: normalized.level || analysis.inferredLevel,
        maxCandidates: normalized.maxCandidates
    };
    let plan = createAddressCandidatePlan(index.baseIndex || index, analysis, plannerOptions);
    plan = createFallbackAddressPlan(index.baseIndex || index, plan, {
        ...plannerOptions,
        allowWeakFullScan: normalized.allowWeakFullScan
    });
    const spatial = createSpatialCandidatePositions(index, normalized);
    if (spatial) {
        const planned = new Set(plan.positions);
        const intersection = intersectCandidatePositions(planned, spatial.positions);
        plan = {
            ...plan,
            strategy: `${plan.strategy}+spatial`,
            positions: Array.from(intersection),
            candidateCount: intersection.size,
            spatialDiagnostics: spatial.response.diagnostics
        };
    }
    return { analysis, options: normalized, plan };
};

export const scoreAddressCandidateV2 = (document, analysis, options = {}) => {
    const scored = scoreAddressDocumentSemantic(document, analysis, options);
    if (!scored.score) return { document, ...scored };
    const distanceMeters = options.center && document?.coordinates
        ? haversineDistanceMeters(options.center, document.coordinates)
        : null;
    const distanceBoost = distanceMeters !== null && options.radiusMeters > 0
        ? Math.round(Math.max(0, 1 - distanceMeters / options.radiusMeters) * 40)
        : 0;
    return {
        document,
        ...scored,
        score: scored.score + distanceBoost,
        distanceMeters,
        distanceBoost
    };
};

export const compareAddressSearchV2Hits = (left, right) => {
    const semantic = compareAddressSemanticScores(left, right);
    if (semantic !== 0) return semantic;
    if (!isNil(left?.distanceMeters) && !isNil(right?.distanceMeters) && left.distanceMeters !== right.distanceMeters) {
        return left.distanceMeters - right.distanceMeters;
    }
    return (left?.position || 0) - (right?.position || 0);
};

export const searchAddressV2Index = (index, query, options = {}) => {
    if (!index?.documents) throw new AddressSearchV2Error("INVALID_INDEX", "AddressSearchV2 index is required");
    throwIfAddressSearchAborted(options.signal);
    const planned = createAddressSearchV2Plan(index, query, options);
    const planIssues = validateAddressCandidatePlan(index.baseIndex || index, planned.plan);
    const candidates = materializeAddressCandidates(index.baseIndex || index, planned.plan);
    const hits = [];

    candidates.forEach((candidate, candidateIndex) => {
        if (candidateIndex % 64 === 0) throwIfAddressSearchAborted(options.signal);
        if (!matchesAddressHierarchyV2(candidate.document, {
            ...planned.options,
            level: planned.options.level || planned.analysis.inferredLevel
        })) return;
        const hit = scoreAddressCandidateV2(candidate.document, planned.analysis, planned.options);
        if (hit.score < planned.options.minScore) return;
        hits.push({ ...hit, position: candidate.position });
    });

    hits.sort(compareAddressSearchV2Hits);
    const total = hits.length;
    const start = planned.options.offset;
    const end = start + planned.options.limit;
    const pageHits = hits.slice(start, end).map(hit => planned.options.includeEvidence
        ? hit
        : {
            document: hit.document,
            score: hit.score,
            distanceMeters: hit.distanceMeters,
            distanceBoost: hit.distanceBoost
        });
    const nextOffset = start + pageHits.length;
    return {
        version: ADDRESS_SEARCH_V2_VERSION,
        results: pageHits,
        page: {
            offset: start,
            limit: planned.options.limit,
            count: pageHits.length,
            total,
            hasMore: nextOffset < total,
            nextOffset: nextOffset < total ? nextOffset : null
        },
        diagnostics: {
            query: summarizeAddressAnalysis(planned.analysis),
            planner: createPlannerDiagnostics(planned.plan),
            planIssueCount: planIssues.length,
            planIssues,
            scoredCandidateCount: candidates.length,
            matchedCount: total,
            spatial: planned.plan.spatialDiagnostics || null
        }
    };
};

export const findNearestAddressesV2 = (index, center, options = {}) => {
    if (!index?.spatialIndex) return { results: [], page: null, diagnostics: { reason: "spatial-index-missing" } };
    throwIfAddressSearchAborted(options.signal);
    const point = parseCoordinatePair(center);
    if (!point) return { results: [], page: null, diagnostics: { reason: "invalid-center" } };
    const limit = normalizeInteger(options.limit, {
        min: 1,
        max: MAX_ADDRESS_V2_LIMIT,
        fallback: DEFAULT_ADDRESS_V2_LIMIT
    });
    const offset = Math.max(0, normalizeInteger(options.offset, { min: 0, fallback: 0 }));
    const radiusMeters = Math.max(1, normalizeFiniteNumber(options.radiusMeters, 5000) || 5000);
    const requested = Math.min(MAX_ADDRESS_V2_LIMIT, offset + limit);
    const response = queryNearestSpatial(index.spatialIndex, point, {
        radiusMeters,
        limit: requested,
        maxCells: options.maxSpatialCells
    });
    const all = response.results
        .filter(item => matchesAddressHierarchyV2(item.document, options))
        .slice(0, requested);
    const pageItems = all.slice(offset, offset + limit).map(item => ({
        document: item.document,
        distanceMeters: item.distanceMeters
    }));
    const total = response.page?.total ?? all.length;
    const nextOffset = offset + pageItems.length;
    return {
        version: ADDRESS_SEARCH_V2_VERSION,
        results: pageItems,
        page: {
            offset,
            limit,
            count: pageItems.length,
            total,
            hasMore: nextOffset < total,
            nextOffset: nextOffset < total ? nextOffset : null
        },
        diagnostics: response.diagnostics
    };
};

export const getAddressSemanticDuplicates = (index, documentOrFingerprint) => {
    if (!index?.bySemanticFingerprint) return [];
    const fingerprint = typeof documentOrFingerprint === "string"
        ? documentOrFingerprint
        : createAddressSemanticFingerprint(documentOrFingerprint);
    if (!fingerprint) return [];
    const positions = index.bySemanticFingerprint.get(fingerprint);
    return positions
        ? Array.from(positions).map(position => index.documents[position]).filter(Boolean)
        : [];
};

export const createAddressSearchV2QualityReport = index => {
    const base = createAddressQualityReport(index?.baseIndex || index);
    const spatial = createSpatialIndexQualityReport(index?.spatialIndex);
    const semanticDuplicates = index?.diagnostics?.semanticDuplicates
        || createAddressSemanticDuplicateReport(index?.documents);
    return {
        version: ADDRESS_SEARCH_V2_VERSION,
        total: base.total,
        geocodedCount: base.geocodedCount,
        ungeocodedCount: base.ungeocodedCount,
        geocodedRatio: base.geocodedRatio,
        levelCounts: base.levelCounts,
        hierarchyIssueCount: base.hierarchyIssueCount,
        hierarchyIssues: base.hierarchyIssues,
        semanticDuplicateCount: semanticDuplicates.duplicateCount,
        semanticDuplicateGroupCount: semanticDuplicates.duplicateGroupCount,
        spatialCoverageRatio: spatial.coverageRatio,
        spatialIssueCount: spatial.issueCount,
        base,
        spatial,
        semanticDuplicates,
        drift: index?.drift || base.drift || null
    };
};

export const validateAddressSearchV2Index = index => {
    const issues = [];
    if (!index || index.version !== ADDRESS_SEARCH_V2_VERSION) {
        issues.push({ code: "address-v2-version-mismatch", severity: "error" });
        return issues;
    }
    if (!Array.isArray(index.documents)) issues.push({ code: "address-v2-documents-missing", severity: "error" });
    if (!index.baseIndex?.byToken) issues.push({ code: "address-v2-token-index-missing", severity: "error" });
    const spatial = createSpatialIndexQualityReport(index.spatialIndex);
    spatial.issues.forEach(issue => issues.push({ ...issue, source: "spatial" }));
    return issues;
};

export const createAddressSearchV2Diagnostics = index => {
    const validationIssues = validateAddressSearchV2Index(index);
    const duplicateReport = index?.diagnostics?.semanticDuplicates || { duplicateCount: 0, duplicateGroupCount: 0 };
    return {
        version: index?.version || null,
        documentCount: index?.documents?.length || 0,
        tokenCount: index?.baseIndex?.byToken?.size || 0,
        districtCount: index?.baseIndex?.byDistrict?.size || 0,
        neighborhoodCount: index?.baseIndex?.byNeighborhood?.size || 0,
        streetCount: index?.baseIndex?.byStreet?.size || 0,
        spatialCellCount: index?.spatialIndex?.cells?.size || 0,
        semanticDuplicateCount: duplicateReport.duplicateCount || 0,
        semanticDuplicateGroupCount: duplicateReport.duplicateGroupCount || 0,
        validationIssueCount: validationIssues.length,
        validationIssues
    };
};

export const AddressSearchV2Runtime = {
    ADDRESS_SEARCH_V2_VERSION,
    DEFAULT_ADDRESS_V2_LIMIT,
    MAX_ADDRESS_V2_LIMIT,
    DEFAULT_ADDRESS_V2_MAX_CANDIDATES,
    AddressSearchV2Error,
    throwIfAddressSearchAborted,
    normalizeAddressV2Options,
    createAddressSemanticFingerprint,
    createAddressSemanticDuplicateReport,
    createAddressSearchV2Index,
    matchesAddressHierarchyV2,
    intersectCandidatePositions,
    createSpatialCandidatePositions,
    createAddressSearchV2Plan,
    scoreAddressCandidateV2,
    compareAddressSearchV2Hits,
    searchAddressV2Index,
    findNearestAddressesV2,
    getAddressSemanticDuplicates,
    createAddressSearchV2QualityReport,
    validateAddressSearchV2Index,
    createAddressSearchV2Diagnostics
};