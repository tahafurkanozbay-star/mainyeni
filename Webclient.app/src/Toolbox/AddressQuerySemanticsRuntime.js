import {
    normalizeFiniteNumber,
    normalizeSearchText,
    normalizeText
} from "./DataIntegrityHelper";

export const ADDRESS_QUERY_VERSION = "2.0.0";

export const ADDRESS_LEVELS_V2 = Object.freeze({
    District: "district",
    Neighborhood: "neighborhood",
    Street: "street",
    Building: "building",
    Door: "door",
    Address: "address"
});

export const ADDRESS_TOKEN_CLASS = Object.freeze({
    Strong: "strong",
    Structural: "structural",
    Number: "number",
    PostalCode: "postal-code"
});

export const ADDRESS_TOKEN_ALIASES = Object.freeze({
    cd: "cadde",
    cad: "cadde",
    cadde: "cadde",
    caddesi: "cadde",
    sk: "sokak",
    sok: "sokak",
    sokak: "sokak",
    sokagi: "sokak",
    blv: "bulvar",
    bulv: "bulvar",
    bulvar: "bulvar",
    bulvari: "bulvar",
    yol: "yol",
    yolu: "yol",
    mh: "mahalle",
    mah: "mahalle",
    mahalle: "mahalle",
    mahallesi: "mahalle",
    ilce: "ilce",
    ilcesi: "ilce",
    semt: "semt",
    semti: "semt",
    apt: "apartman",
    apartman: "apartman",
    apartmani: "apartman",
    bina: "bina",
    binasi: "bina",
    blok: "blok",
    blogu: "blok",
    no: "no",
    numara: "no",
    numarasi: "no",
    kapi: "no",
    kapino: "no",
    site: "site",
    sitesi: "site",
    mevki: "mevki",
    mevkii: "mevki"
});

export const ADDRESS_STRUCTURE_TOKENS = Object.freeze([
    "cadde",
    "sokak",
    "bulvar",
    "yol",
    "mahalle",
    "ilce",
    "semt",
    "apartman",
    "bina",
    "blok",
    "no",
    "site",
    "mevki"
]);

export const ADDRESS_ROAD_TOKENS = Object.freeze(["cadde", "sokak", "bulvar", "yol"]);
export const ADDRESS_BUILDING_TOKENS = Object.freeze(["apartman", "bina", "blok", "site"]);
export const ADDRESS_LOCALITY_TOKENS = Object.freeze(["mahalle", "ilce", "semt", "mevki"]);

const STRUCTURE_SET = new Set(ADDRESS_STRUCTURE_TOKENS);
const ROAD_SET = new Set(ADDRESS_ROAD_TOKENS);
const BUILDING_SET = new Set(ADDRESS_BUILDING_TOKENS);
const LOCALITY_SET = new Set(ADDRESS_LOCALITY_TOKENS);

const FIELD_WEIGHTS = Object.freeze({
    title: 1.1,
    address: 1,
    street: 1.3,
    neighborhood: 1.15,
    district: 1.05,
    door: 1.4,
    postalCode: 1.25
});

const asArray = value => Array.isArray(value) ? value : [];
const unique = values => Array.from(new Set(values.filter(Boolean)));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isNumericToken = value => /^\d+[a-z]?$/.test(value || "");
const isPostalCode = value => /^\d{5}$/.test(value || "");

export const normalizeAddressSemanticText = value => normalizeSearchText(value)
    .replace(/[.,;:(){}]/g, " ")
    .split("[").join(" ")
    .split("]").join(" ")
    .split("/").join(" ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const tokenizeAddressSemanticText = value => normalizeAddressSemanticText(value)
    .split(" ")
    .map(token => token.trim())
    .filter(Boolean);

export const canonicalizeAddressToken = value => {
    const token = normalizeAddressSemanticText(value);
    return ADDRESS_TOKEN_ALIASES[token] || token;
};

export const canonicalizeAddressTokens = value => unique(
    tokenizeAddressSemanticText(value).map(canonicalizeAddressToken)
);

export const canonicalizeAddressText = value => canonicalizeAddressTokens(value).join(" ");

export const classifyAddressToken = token => {
    const canonical = canonicalizeAddressToken(token);
    if (!canonical) return null;
    if (isPostalCode(canonical)) return ADDRESS_TOKEN_CLASS.PostalCode;
    if (isNumericToken(canonical)) return ADDRESS_TOKEN_CLASS.Number;
    if (STRUCTURE_SET.has(canonical)) return ADDRESS_TOKEN_CLASS.Structural;
    return ADDRESS_TOKEN_CLASS.Strong;
};

export const createAddressTokenDescriptor = (token, index = 0) => {
    const raw = normalizeAddressSemanticText(token);
    const canonical = canonicalizeAddressToken(raw);
    const tokenClass = classifyAddressToken(canonical);
    return {
        index,
        raw,
        canonical,
        tokenClass,
        isStrong: tokenClass === ADDRESS_TOKEN_CLASS.Strong,
        isStructural: tokenClass === ADDRESS_TOKEN_CLASS.Structural,
        isNumber: tokenClass === ADDRESS_TOKEN_CLASS.Number,
        isPostalCode: tokenClass === ADDRESS_TOKEN_CLASS.PostalCode,
        isRoadType: ROAD_SET.has(canonical),
        isBuildingType: BUILDING_SET.has(canonical),
        isLocalityType: LOCALITY_SET.has(canonical)
    };
};

export const normalizeDoorSemanticToken = value => normalizeAddressSemanticText(value)
    .replace(/\s+/g, "")
    .toLocaleLowerCase("tr-TR");

export const parseAddressNumberToken = value => {
    const normalized = normalizeDoorSemanticToken(value);
    const match = /^(\d+)([a-z])?$/.exec(normalized);
    if (!match) return null;
    return {
        raw: normalizeText(value),
        normalized,
        number: Number.parseInt(match[1], 10),
        suffix: match[2] || ""
    };
};

export const inferAddressQueryLevel = analysis => {
    if (!analysis) return null;
    if (analysis.hasDoorHint) return ADDRESS_LEVELS_V2.Door;
    if (analysis.roadTokens.length) return ADDRESS_LEVELS_V2.Street;
    if (analysis.buildingTokens.length) return ADDRESS_LEVELS_V2.Building;
    if (analysis.localityTokens.includes("mahalle") || analysis.localityTokens.includes("semt")) {
        return ADDRESS_LEVELS_V2.Neighborhood;
    }
    if (analysis.localityTokens.includes("ilce")) return ADDRESS_LEVELS_V2.District;
    return null;
};

export const analyzeAddressQuery = (query, options = {}) => {
    const normalizedText = normalizeAddressSemanticText(query);
    const rawTokens = tokenizeAddressSemanticText(normalizedText);
    const descriptors = rawTokens.map(createAddressTokenDescriptor);
    const canonicalTokens = unique(descriptors.map(item => item.canonical));
    const strongTokens = unique(descriptors.filter(item => item.isStrong).map(item => item.canonical));
    const structuralTokens = unique(descriptors.filter(item => item.isStructural).map(item => item.canonical));
    const numericTokens = unique(descriptors.filter(item => item.isNumber).map(item => item.canonical));
    const postalTokens = unique(descriptors.filter(item => item.isPostalCode).map(item => item.canonical));
    const roadTokens = structuralTokens.filter(token => ROAD_SET.has(token));
    const buildingTokens = structuralTokens.filter(token => BUILDING_SET.has(token));
    const localityTokens = structuralTokens.filter(token => LOCALITY_SET.has(token));
    const hasExplicitNumberLabel = structuralTokens.includes("no");
    const hasDoorHint = hasExplicitNumberLabel
        || (numericTokens.length > 0 && (roadTokens.length > 0 || options.assumeDoorForNumber === true));
    const weakOnly = canonicalTokens.length > 0
        && strongTokens.length === 0
        && numericTokens.length === 0
        && postalTokens.length === 0;
    const analysis = {
        version: ADDRESS_QUERY_VERSION,
        raw: normalizeText(query),
        normalizedText,
        canonicalText: canonicalTokens.join(" "),
        rawTokens,
        descriptors,
        canonicalTokens,
        strongTokens,
        structuralTokens,
        numericTokens,
        postalTokens,
        roadTokens,
        buildingTokens,
        localityTokens,
        hasExplicitNumberLabel,
        hasDoorHint,
        weakOnly,
        requiresStrongEvidence: strongTokens.length > 0,
        requiresNumericEvidence: numericTokens.length > 0,
        requiresPostalEvidence: postalTokens.length > 0,
        explicitLevel: normalizeText(options.level).toLocaleLowerCase("tr-TR") || null
    };
    return {
        ...analysis,
        inferredLevel: analysis.explicitLevel || inferAddressQueryLevel(analysis),
        signature: createAddressQuerySignature(analysis, options)
    };
};

export const createAddressQuerySignature = (analysisOrQuery, options = {}) => {
    const analysis = typeof analysisOrQuery === "object" && analysisOrQuery?.canonicalTokens
        ? analysisOrQuery
        : analyzeAddressQuery(analysisOrQuery, { ...options, _skipSignature: true });
    return JSON.stringify({
        v: ADDRESS_QUERY_VERSION,
        q: analysis.canonicalTokens,
        district: canonicalizeAddressText(options.district),
        neighborhood: canonicalizeAddressText(options.neighborhood),
        street: canonicalizeAddressText(options.street),
        level: normalizeText(options.level).toLocaleLowerCase("tr-TR") || analysis.inferredLevel || null,
        center: options.center || null,
        radiusMeters: normalizeFiniteNumber(options.radiusMeters, null)
    });
};

export const createDocumentSemanticFields = document => {
    const fields = {
        title: canonicalizeAddressText(document?.title),
        address: canonicalizeAddressText(document?.address || document?.canonicalAddress),
        street: canonicalizeAddressText(document?.street || document?.fields?.street),
        neighborhood: canonicalizeAddressText(document?.neighborhood || document?.fields?.neighborhood),
        district: canonicalizeAddressText(document?.district || document?.fields?.district),
        door: canonicalizeAddressText(document?.door || document?.fields?.door),
        postalCode: canonicalizeAddressText(document?.postalCode || document?.fields?.postalCode)
    };
    const fieldTokens = Object.entries(fields).reduce((result, [name, value]) => {
        result[name] = canonicalizeAddressTokens(value);
        return result;
    }, {});
    return {
        fields,
        fieldTokens,
        allTokens: unique(Object.values(fieldTokens).flat()),
        roadTokens: unique(Object.values(fieldTokens).flat().filter(token => ROAD_SET.has(token))),
        numericTokens: unique(Object.values(fieldTokens).flat().filter(isNumericToken)),
        postalTokens: unique(Object.values(fieldTokens).flat().filter(isPostalCode))
    };
};

export const scoreSemanticToken = (candidate, queryToken, tokenClass = classifyAddressToken(queryToken)) => {
    if (!candidate || !queryToken) return 0;
    if (tokenClass === ADDRESS_TOKEN_CLASS.Number || tokenClass === ADDRESS_TOKEN_CLASS.PostalCode) {
        return candidate === queryToken ? 125 : 0;
    }
    if (tokenClass === ADDRESS_TOKEN_CLASS.Structural) return candidate === queryToken ? 15 : 0;
    if (candidate === queryToken) return 110;
    if (candidate.startsWith(queryToken)) return 75;
    if (candidate.includes(queryToken)) return 45;
    if (queryToken.includes(candidate) && candidate.length >= 3) return 20;
    return 0;
};

export const scoreAddressSemanticField = (fieldName, fieldTokens, descriptor) => {
    const weight = FIELD_WEIGHTS[fieldName] || 1;
    const best = asArray(fieldTokens).reduce(
        (maximum, token) => Math.max(maximum, scoreSemanticToken(token, descriptor.canonical, descriptor.tokenClass)),
        0
    );
    return {
        field: fieldName,
        token: descriptor.canonical,
        score: Math.round(best * weight)
    };
};

export const findBestAddressTokenMatch = (semanticDocument, descriptor) => {
    const fieldMatches = Object.entries(semanticDocument.fieldTokens)
        .map(([name, tokens]) => scoreAddressSemanticField(name, tokens, descriptor))
        .sort((left, right) => right.score - left.score || left.field.localeCompare(right.field));
    return fieldMatches[0] || { field: null, token: descriptor.canonical, score: 0 };
};

export const evaluateAddressEvidence = (document, analysisOrQuery) => {
    const analysis = typeof analysisOrQuery === "object" && analysisOrQuery?.canonicalTokens
        ? analysisOrQuery
        : analyzeAddressQuery(analysisOrQuery);
    const semanticDocument = createDocumentSemanticFields(document);
    const matches = analysis.descriptors.map(descriptor => ({
        descriptor,
        ...findBestAddressTokenMatch(semanticDocument, descriptor)
    }));
    const matched = matches.filter(item => item.score > 0);
    const matchedStrong = matched.filter(item => item.descriptor.isStrong);
    const matchedNumbers = matched.filter(item => item.descriptor.isNumber);
    const matchedPostal = matched.filter(item => item.descriptor.isPostalCode);
    const matchedStructural = matched.filter(item => item.descriptor.isStructural);
    const strongCoverage = analysis.strongTokens.length
        ? matchedStrong.length / analysis.strongTokens.length
        : 1;
    const tokenCoverage = analysis.canonicalTokens.length
        ? matched.length / analysis.canonicalTokens.length
        : 0;
    const numericSatisfied = !analysis.requiresNumericEvidence
        || matchedNumbers.length === analysis.numericTokens.length;
    const postalSatisfied = !analysis.requiresPostalEvidence
        || matchedPostal.length === analysis.postalTokens.length;
    const strongSatisfied = !analysis.requiresStrongEvidence || matchedStrong.length > 0;
    const structuralSatisfied = !analysis.weakOnly || matchedStructural.length > 0;
    const documentRoads = semanticDocument.roadTokens;
    const roadTypeMismatch = analysis.roadTokens.length > 0
        && documentRoads.length > 0
        && !analysis.roadTokens.some(token => documentRoads.includes(token));
    return {
        analysis,
        semanticDocument,
        matches,
        matched,
        matchedStrong,
        matchedNumbers,
        matchedPostal,
        matchedStructural,
        matchedCount: matched.length,
        matchedStrongCount: matchedStrong.length,
        strongCoverage,
        tokenCoverage,
        numericSatisfied,
        postalSatisfied,
        strongSatisfied,
        structuralSatisfied,
        roadTypeMismatch,
        eligible: strongSatisfied && numericSatisfied && postalSatisfied && structuralSatisfied
    };
};

export const scoreAddressDocumentSemantic = (document, analysisOrQuery, options = {}) => {
    const evidence = evaluateAddressEvidence(document, analysisOrQuery);
    if (!evidence.eligible || evidence.analysis.canonicalTokens.length === 0) {
        return { ...evidence, score: 0, bonuses: {}, penalties: {} };
    }
    const canonicalAddress = canonicalizeAddressText(document?.canonicalAddress || document?.address);
    const canonicalTitle = canonicalizeAddressText(document?.title);
    const exactBonus = canonicalAddress === evidence.analysis.canonicalText
        || canonicalTitle === evidence.analysis.canonicalText ? 500 : 0;
    const prefixBonus = canonicalAddress.startsWith(evidence.analysis.canonicalText)
        || canonicalTitle.startsWith(evidence.analysis.canonicalText) ? 200 : 0;
    const fieldScore = evidence.matches.reduce((total, item) => total + item.score, 0);
    const completeBonus = evidence.tokenCoverage === 1 ? 150 : Math.round(evidence.tokenCoverage * 80);
    const strongCoverageBonus = Math.round(evidence.strongCoverage * 120);
    const level = normalizeText(document?.level).toLocaleLowerCase("tr-TR");
    const inferredLevel = evidence.analysis.inferredLevel;
    const levelBonus = inferredLevel && level === inferredLevel ? 80 : 0;
    const roadPenalty = evidence.roadTypeMismatch ? 45 : 0;
    const weakQueryPenalty = evidence.analysis.weakOnly ? 20 : 0;
    const rawScore = exactBonus
        + prefixBonus
        + fieldScore
        + completeBonus
        + strongCoverageBonus
        + levelBonus
        - roadPenalty
        - weakQueryPenalty;
    const score = clamp(Math.round(rawScore), 0, normalizeFiniteNumber(options.maxScore, 5000) || 5000);
    return {
        ...evidence,
        score,
        bonuses: {
            exact: exactBonus,
            prefix: prefixBonus,
            completeness: completeBonus,
            strongCoverage: strongCoverageBonus,
            level: levelBonus
        },
        penalties: {
            roadTypeMismatch: roadPenalty,
            weakQuery: weakQueryPenalty
        }
    };
};

export const compareAddressSemanticScores = (left, right) => {
    if ((right?.score || 0) !== (left?.score || 0)) return (right?.score || 0) - (left?.score || 0);
    if ((right?.strongCoverage || 0) !== (left?.strongCoverage || 0)) {
        return (right?.strongCoverage || 0) - (left?.strongCoverage || 0);
    }
    if ((right?.tokenCoverage || 0) !== (left?.tokenCoverage || 0)) {
        return (right?.tokenCoverage || 0) - (left?.tokenCoverage || 0);
    }
    return normalizeText(left?.document?.canonicalAddress || left?.document?.title)
        .localeCompare(normalizeText(right?.document?.canonicalAddress || right?.document?.title), "tr-TR", {
            sensitivity: "base",
            numeric: true
        });
};

export const summarizeAddressAnalysis = analysisOrQuery => {
    const analysis = typeof analysisOrQuery === "object" && analysisOrQuery?.canonicalTokens
        ? analysisOrQuery
        : analyzeAddressQuery(analysisOrQuery);
    return {
        version: analysis.version,
        canonicalText: analysis.canonicalText,
        tokenCount: analysis.canonicalTokens.length,
        strongTokenCount: analysis.strongTokens.length,
        structuralTokenCount: analysis.structuralTokens.length,
        numericTokenCount: analysis.numericTokens.length,
        postalTokenCount: analysis.postalTokens.length,
        weakOnly: analysis.weakOnly,
        hasDoorHint: analysis.hasDoorHint,
        inferredLevel: analysis.inferredLevel
    };
};

export const AddressQuerySemanticsRuntime = {
    ADDRESS_QUERY_VERSION,
    ADDRESS_LEVELS_V2,
    ADDRESS_TOKEN_CLASS,
    ADDRESS_TOKEN_ALIASES,
    ADDRESS_STRUCTURE_TOKENS,
    ADDRESS_ROAD_TOKENS,
    ADDRESS_BUILDING_TOKENS,
    ADDRESS_LOCALITY_TOKENS,
    normalizeAddressSemanticText,
    tokenizeAddressSemanticText,
    canonicalizeAddressToken,
    canonicalizeAddressTokens,
    canonicalizeAddressText,
    classifyAddressToken,
    createAddressTokenDescriptor,
    normalizeDoorSemanticToken,
    parseAddressNumberToken,
    inferAddressQueryLevel,
    analyzeAddressQuery,
    createAddressQuerySignature,
    createDocumentSemanticFields,
    scoreSemanticToken,
    scoreAddressSemanticField,
    findBestAddressTokenMatch,
    evaluateAddressEvidence,
    scoreAddressDocumentSemantic,
    compareAddressSemanticScores,
    summarizeAddressAnalysis
};