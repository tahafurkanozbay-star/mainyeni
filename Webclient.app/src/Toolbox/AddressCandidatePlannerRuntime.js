import {
    normalizeFiniteNumber,
    normalizeInteger,
    normalizeText
} from "./DataIntegrityHelper";
import {
    ADDRESS_LEVELS_V2,
    ADDRESS_TOKEN_ALIASES,
    analyzeAddressQuery,
    canonicalizeAddressText,
    canonicalizeAddressToken,
    canonicalizeAddressTokens
} from "./AddressQuerySemanticsRuntime";

export const ADDRESS_PLANNER_VERSION = "2.0.0";
export const DEFAULT_MAX_ADDRESS_CANDIDATES = 5000;
export const MAX_ADDRESS_CANDIDATES = 50000;

const asArray = value => Array.isArray(value) ? value : [];
const unique = values => Array.from(new Set(values.filter(Boolean)));
const toSet = values => values instanceof Set ? new Set(values) : new Set(asArray(values));
const normalizeHierarchy = value => canonicalizeAddressText(value);

const REVERSE_ALIASES = Object.entries(ADDRESS_TOKEN_ALIASES).reduce((result, [alias, canonical]) => {
    if (!result[canonical]) result[canonical] = [];
    result[canonical].push(alias);
    return result;
}, {});

export const normalizeCandidateLimit = value => normalizeInteger(value, {
    min: 1,
    max: MAX_ADDRESS_CANDIDATES,
    fallback: DEFAULT_MAX_ADDRESS_CANDIDATES
});

export const unionSets = sets => {
    const result = new Set();
    asArray(sets).forEach(set => {
        if (!set) return;
        set.forEach(value => result.add(value));
    });
    return result;
};

export const intersectSets = sets => {
    const filtered = asArray(sets).filter(set => set instanceof Set);
    if (!filtered.length) return new Set();
    const sorted = [...filtered].sort((left, right) => left.size - right.size);
    const result = new Set(sorted[0]);
    for (let index = 1; index < sorted.length && result.size; index += 1) {
        const candidate = sorted[index];
        Array.from(result).forEach(value => {
            if (!candidate.has(value)) result.delete(value);
        });
    }
    return result;
};

export const limitCandidateSet = (set, limit) => {
    const normalizedLimit = normalizeCandidateLimit(limit);
    if (!(set instanceof Set) || set.size <= normalizedLimit) return set instanceof Set ? new Set(set) : new Set();
    return new Set(Array.from(set).slice(0, normalizedLimit));
};

export const getAllAddressPositions = index => new Set(
    Array.from({ length: index?.documents?.length || 0 }, (_, position) => position)
);

export const getTokenLookupVariants = token => {
    const canonical = canonicalizeAddressToken(token);
    return unique([
        canonical,
        ...(REVERSE_ALIASES[canonical] || []),
        normalizeText(token).toLocaleLowerCase("tr-TR")
    ]);
};

export const getPositionsForToken = (index, token) => {
    if (!index?.byToken) return new Set();
    const variants = getTokenLookupVariants(token);
    return unionSets(variants.map(variant => index.byToken.get(variant)).filter(Boolean));
};

export const getPositionsForTokens = (index, tokens, mode = "union") => {
    const sets = unique(asArray(tokens).map(canonicalizeAddressToken))
        .map(token => getPositionsForToken(index, token))
        .filter(set => set.size > 0);
    if (!sets.length) return new Set();
    return mode === "intersection" ? intersectSets(sets) : unionSets(sets);
};

export const getPositionsForLevel = (index, level) => {
    const normalized = normalizeText(level).toLocaleLowerCase("tr-TR");
    if (!normalized || !index?.byLevel) return new Set();
    return toSet(index.byLevel.get(normalized));
};

export const getPositionsForDistrict = (index, district) => {
    const raw = normalizeText(district);
    if (!raw || !index?.byDistrict) return new Set();
    const canonical = normalizeHierarchy(raw);
    const direct = index.byDistrict.get(canonical);
    if (direct) return toSet(direct);
    const fallbackKeys = Array.from(index.byDistrict.keys()).filter(
        key => normalizeHierarchy(key) === canonical
    );
    return unionSets(fallbackKeys.map(key => index.byDistrict.get(key)));
};

export const getPositionsForNeighborhood = (index, district, neighborhood) => {
    const neighborhoodKey = normalizeHierarchy(neighborhood);
    if (!neighborhoodKey || !index?.byNeighborhood) return new Set();
    const districtKey = normalizeHierarchy(district);
    if (districtKey) {
        const direct = index.byNeighborhood.get(`${districtKey}|${neighborhoodKey}`);
        if (direct) return toSet(direct);
    }
    const suffix = `|${neighborhoodKey}`;
    const matchingKeys = Array.from(index.byNeighborhood.keys()).filter(
        key => normalizeHierarchy(key.split("|").pop()) === neighborhoodKey || key.endsWith(suffix)
    );
    return unionSets(matchingKeys.map(key => index.byNeighborhood.get(key)));
};

export const getPositionsForStreet = (index, district, neighborhood, street) => {
    const streetKey = normalizeHierarchy(street);
    if (!streetKey || !index?.byStreet) return new Set();
    const districtKey = normalizeHierarchy(district);
    const neighborhoodKey = normalizeHierarchy(neighborhood);
    if (districtKey && neighborhoodKey) {
        const direct = index.byStreet.get(`${districtKey}|${neighborhoodKey}|${streetKey}`);
        if (direct) return toSet(direct);
    }
    const matchingKeys = Array.from(index.byStreet.keys()).filter(key => {
        const pieces = key.split("|");
        const indexedStreet = normalizeHierarchy(pieces[pieces.length - 1]);
        if (indexedStreet !== streetKey) return false;
        if (districtKey && normalizeHierarchy(pieces[0]) !== districtKey) return false;
        if (neighborhoodKey && normalizeHierarchy(pieces[1]) !== neighborhoodKey) return false;
        return true;
    });
    return unionSets(matchingKeys.map(key => index.byStreet.get(key)));
};

export const createHierarchyCandidateSets = (index, options = {}) => {
    const sets = [];
    const sources = [];
    if (options.level) {
        const positions = getPositionsForLevel(index, options.level);
        sets.push(positions);
        sources.push({ kind: "level", value: options.level, count: positions.size });
    }
    if (options.district) {
        const positions = getPositionsForDistrict(index, options.district);
        sets.push(positions);
        sources.push({ kind: "district", value: options.district, count: positions.size });
    }
    if (options.neighborhood) {
        const positions = getPositionsForNeighborhood(index, options.district, options.neighborhood);
        sets.push(positions);
        sources.push({ kind: "neighborhood", value: options.neighborhood, count: positions.size });
    }
    if (options.street) {
        const positions = getPositionsForStreet(index, options.district, options.neighborhood, options.street);
        sets.push(positions);
        sources.push({ kind: "street", value: options.street, count: positions.size });
    }
    return { sets, sources };
};

export const createTokenCandidateSets = (index, analysis) => {
    const strongUnion = getPositionsForTokens(index, analysis.strongTokens, "union");
    const numberIntersection = getPositionsForTokens(index, analysis.numericTokens, "intersection");
    const postalIntersection = getPositionsForTokens(index, analysis.postalTokens, "intersection");
    const structuralUnion = getPositionsForTokens(index, analysis.structuralTokens, "union");
    const sources = [];
    if (analysis.strongTokens.length) {
        sources.push({ kind: "strong", values: analysis.strongTokens, count: strongUnion.size });
    }
    if (analysis.numericTokens.length) {
        sources.push({ kind: "number", values: analysis.numericTokens, count: numberIntersection.size });
    }
    if (analysis.postalTokens.length) {
        sources.push({ kind: "postal", values: analysis.postalTokens, count: postalIntersection.size });
    }
    if (analysis.structuralTokens.length) {
        sources.push({ kind: "structural", values: analysis.structuralTokens, count: structuralUnion.size });
    }
    return {
        strongUnion,
        numberIntersection,
        postalIntersection,
        structuralUnion,
        sources
    };
};

export const resolvePrimaryTokenCandidateSet = tokenSets => {
    if (tokenSets.numberIntersection.size) {
        if (tokenSets.strongUnion.size) return intersectSets([tokenSets.numberIntersection, tokenSets.strongUnion]);
        return tokenSets.numberIntersection;
    }
    if (tokenSets.postalIntersection.size) {
        if (tokenSets.strongUnion.size) return intersectSets([tokenSets.postalIntersection, tokenSets.strongUnion]);
        return tokenSets.postalIntersection;
    }
    if (tokenSets.strongUnion.size) return tokenSets.strongUnion;
    if (tokenSets.structuralUnion.size) return tokenSets.structuralUnion;
    return new Set();
};

export const estimatePlannerSelectivity = (candidateCount, totalCount) => {
    if (!Number.isFinite(totalCount) || totalCount <= 0) return 0;
    return Math.max(0, Math.min(1, candidateCount / totalCount));
};

export const createAddressCandidatePlan = (index, query, options = {}) => {
    const analysis = typeof query === "object" && query?.canonicalTokens
        ? query
        : analyzeAddressQuery(query, options);
    const totalCount = index?.documents?.length || 0;
    const maxCandidates = normalizeCandidateLimit(options.maxCandidates);
    const effectiveLevel = options.level || analysis.inferredLevel;
    const hierarchy = createHierarchyCandidateSets(index, {
        ...options,
        level: effectiveLevel
    });
    const tokenSets = createTokenCandidateSets(index, analysis);
    const primaryTokens = resolvePrimaryTokenCandidateSet(tokenSets);
    const constraints = [];
    if (primaryTokens.size) constraints.push(primaryTokens);
    hierarchy.sets.filter(set => set.size > 0).forEach(set => constraints.push(set));

    let candidates;
    let strategy;
    if (constraints.length) {
        candidates = intersectSets(constraints);
        strategy = constraints.length > 1 ? "intersect-indexes" : "single-index";
    } else if (analysis.canonicalTokens.length || hierarchy.sets.length) {
        candidates = new Set();
        strategy = "empty-index-result";
    } else {
        candidates = getAllAddressPositions(index);
        strategy = "full-scan-empty-query";
    }

    const preLimitCount = candidates.size;
    candidates = limitCandidateSet(candidates, maxCandidates);
    const positions = Array.from(candidates);
    return {
        version: ADDRESS_PLANNER_VERSION,
        analysis,
        effectiveLevel,
        strategy,
        positions,
        candidateCount: positions.length,
        preLimitCount,
        truncated: preLimitCount > positions.length,
        totalCount,
        selectivity: estimatePlannerSelectivity(preLimitCount, totalCount),
        sources: [...tokenSets.sources, ...hierarchy.sources],
        maxCandidates
    };
};

export const materializeAddressCandidates = (index, plan) => asArray(plan?.positions)
    .map(position => ({ position, document: index?.documents?.[position] }))
    .filter(item => Boolean(item.document));

export const validateAddressCandidatePlan = (index, plan) => {
    const issues = [];
    if (!plan || plan.version !== ADDRESS_PLANNER_VERSION) {
        issues.push({ code: "planner-version-mismatch", severity: "error" });
    }
    const totalCount = index?.documents?.length || 0;
    const seen = new Set();
    asArray(plan?.positions).forEach(position => {
        if (!Number.isInteger(position) || position < 0 || position >= totalCount) {
            issues.push({ code: "candidate-out-of-range", position, severity: "error" });
            return;
        }
        if (seen.has(position)) issues.push({ code: "duplicate-candidate", position, severity: "warning" });
        seen.add(position);
    });
    if ((plan?.candidateCount || 0) !== seen.size) {
        issues.push({
            code: "candidate-count-mismatch",
            expected: plan?.candidateCount || 0,
            actual: seen.size,
            severity: "warning"
        });
    }
    return issues;
};

export const createPlannerDiagnostics = plan => ({
    version: plan?.version || ADDRESS_PLANNER_VERSION,
    strategy: plan?.strategy || "unknown",
    effectiveLevel: plan?.effectiveLevel || null,
    candidateCount: plan?.candidateCount || 0,
    preLimitCount: plan?.preLimitCount || 0,
    totalCount: plan?.totalCount || 0,
    selectivity: normalizeFiniteNumber(plan?.selectivity, 0) || 0,
    truncated: Boolean(plan?.truncated),
    maxCandidates: plan?.maxCandidates || DEFAULT_MAX_ADDRESS_CANDIDATES,
    sources: asArray(plan?.sources).map(source => ({ ...source }))
});

export const chooseAddressPlanBudget = (recordCount, options = {}) => {
    const total = Math.max(0, normalizeFiniteNumber(recordCount, 0) || 0);
    const requested = normalizeFiniteNumber(options.maxCandidates, null);
    if (requested !== null) return normalizeCandidateLimit(requested);
    if (total <= 1000) return Math.max(1, Math.ceil(total || DEFAULT_MAX_ADDRESS_CANDIDATES));
    if (total <= 10000) return Math.min(5000, Math.ceil(total * 0.6));
    if (total <= 100000) return Math.min(15000, Math.ceil(total * 0.25));
    return Math.min(MAX_ADDRESS_CANDIDATES, Math.ceil(total * 0.1));
};

export const shouldFallbackToFullScan = (plan, options = {}) => {
    if (!plan) return false;
    if (options.allowFullScan === false) return false;
    if (!plan.analysis?.canonicalTokens?.length) return true;
    if (plan.candidateCount > 0) return false;
    if (plan.analysis?.requiresStrongEvidence || plan.analysis?.requiresNumericEvidence) return false;
    return plan.analysis?.weakOnly === true && options.allowWeakFullScan === true;
};

export const createFallbackAddressPlan = (index, plan, options = {}) => {
    if (!shouldFallbackToFullScan(plan, options)) return plan;
    const maxCandidates = chooseAddressPlanBudget(index?.documents?.length || 0, options);
    const all = limitCandidateSet(getAllAddressPositions(index), maxCandidates);
    return {
        ...plan,
        strategy: "bounded-full-scan-fallback",
        positions: Array.from(all),
        candidateCount: all.size,
        preLimitCount: index?.documents?.length || 0,
        truncated: (index?.documents?.length || 0) > all.size,
        maxCandidates
    };
};

export const inferPlannerLevel = (query, options = {}) => {
    const analysis = analyzeAddressQuery(query, options);
    if (options.level) return normalizeText(options.level).toLocaleLowerCase("tr-TR");
    if (analysis.inferredLevel) return analysis.inferredLevel;
    if (options.street) return ADDRESS_LEVELS_V2.Street;
    if (options.neighborhood) return ADDRESS_LEVELS_V2.Neighborhood;
    if (options.district) return ADDRESS_LEVELS_V2.District;
    return null;
};

export const AddressCandidatePlannerRuntime = {
    ADDRESS_PLANNER_VERSION,
    DEFAULT_MAX_ADDRESS_CANDIDATES,
    MAX_ADDRESS_CANDIDATES,
    normalizeCandidateLimit,
    unionSets,
    intersectSets,
    limitCandidateSet,
    getAllAddressPositions,
    getTokenLookupVariants,
    getPositionsForToken,
    getPositionsForTokens,
    getPositionsForLevel,
    getPositionsForDistrict,
    getPositionsForNeighborhood,
    getPositionsForStreet,
    createHierarchyCandidateSets,
    createTokenCandidateSets,
    resolvePrimaryTokenCandidateSet,
    estimatePlannerSelectivity,
    createAddressCandidatePlan,
    materializeAddressCandidates,
    validateAddressCandidatePlan,
    createPlannerDiagnostics,
    chooseAddressPlanBudget,
    shouldFallbackToFullScan,
    createFallbackAddressPlan,
    inferPlannerLevel
};