import {
    normalizeCategoryKey,
    normalizeCoordinates,
    normalizeFiniteNumber,
    normalizeInteger,
    normalizeSearchText,
    normalizeText
} from "./DataIntegrityHelper";
import {
    ADDRESS_RECORD_SCHEMA,
    createSearchDocumentFromSchema,
    normalizeRecordCollection
} from "./RecordSchemaRuntime";

export const ADDRESS_LEVELS = Object.freeze({
    District: "district",
    Neighborhood: "neighborhood",
    Street: "street",
    Building: "building",
    Door: "door",
    Address: "address"
});

export const ADDRESS_LEVEL_ORDER = Object.freeze([
    ADDRESS_LEVELS.District,
    ADDRESS_LEVELS.Neighborhood,
    ADDRESS_LEVELS.Street,
    ADDRESS_LEVELS.Building,
    ADDRESS_LEVELS.Door,
    ADDRESS_LEVELS.Address
]);

export const DEFAULT_ADDRESS_SEARCH_LIMIT = 25;
export const MAX_ADDRESS_SEARCH_LIMIT = 250;
export const EARTH_RADIUS_METERS = 6371008.8;

const isNil = value => value === null || value === undefined;
const unique = values => Array.from(new Set(values.filter(Boolean)));

export const normalizeAddressToken = value => normalizeSearchText(value)
    .replace(/[.,;:()\[\]{}]/g, " ")
    .replace(/[\/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const tokenizeAddress = value => unique(
    normalizeAddressToken(value).split(" ").map(token => token.trim()).filter(Boolean)
);

export const normalizeDoorNumber = value => normalizeText(value)
    .replace(/\s+/g, "")
    .toLocaleUpperCase("tr-TR");

export const normalizePostalCode = value => {
    const digits = normalizeText(value).replace(/\D/g, "");
    return digits.length === 5 ? digits : "";
};

export const normalizeAddressLevel = value => {
    const key = normalizeCategoryKey(value);
    const aliases = {
        ilce: ADDRESS_LEVELS.District,
        district: ADDRESS_LEVELS.District,
        mahalle: ADDRESS_LEVELS.Neighborhood,
        neighborhood: ADDRESS_LEVELS.Neighborhood,
        cadde: ADDRESS_LEVELS.Street,
        caddesi: ADDRESS_LEVELS.Street,
        sokak: ADDRESS_LEVELS.Street,
        sokagi: ADDRESS_LEVELS.Street,
        bulvar: ADDRESS_LEVELS.Street,
        bulvari: ADDRESS_LEVELS.Street,
        yol: ADDRESS_LEVELS.Street,
        street: ADDRESS_LEVELS.Street,
        bina: ADDRESS_LEVELS.Building,
        building: ADDRESS_LEVELS.Building,
        kapi: ADDRESS_LEVELS.Door,
        door: ADDRESS_LEVELS.Door,
        address: ADDRESS_LEVELS.Address,
        adres: ADDRESS_LEVELS.Address
    };
    return aliases[key] || null;
};

const inferQueryLevel = query => {
    const tokens = tokenizeAddress(query);
    const streetDesignators = new Set(["cadde", "caddesi", "sokak", "sokagi", "bulvar", "bulvari"]);
    return tokens.some(token => streetDesignators.has(token)) ? ADDRESS_LEVELS.Street : null;
};

export const inferAddressLevel = record => {
    const explicit = normalizeAddressLevel(
        record?.level
        ?? record?.addressLevel
        ?? record?.type
        ?? record?.category
        ?? record?.attr?.level
        ?? record?.attr?.type
    );
    if (explicit) return explicit;
    const door = normalizeDoorNumber(record?.door ?? record?.kapino ?? record?.attr?.kapino);
    if (door) return ADDRESS_LEVELS.Door;
    if (normalizeText(record?.building ?? record?.bina ?? record?.attr?.building)) return ADDRESS_LEVELS.Building;
    if (normalizeText(record?.street ?? record?.cadde ?? record?.sokak ?? record?.attr?.street)) return ADDRESS_LEVELS.Street;
    if (normalizeText(record?.neighborhood ?? record?.mahalle ?? record?.attr?.mahalle)) return ADDRESS_LEVELS.Neighborhood;
    if (normalizeText(record?.district ?? record?.ilce ?? record?.attr?.ilce)) return ADDRESS_LEVELS.District;
    return ADDRESS_LEVELS.Address;
};

export const createAddressParts = document => {
    const district = normalizeText(document?.district);
    const neighborhood = normalizeText(document?.neighborhood);
    const street = normalizeText(document?.street);
    const door = normalizeDoorNumber(document?.door);
    const title = normalizeText(document?.title);
    const address = normalizeText(document?.address);
    const parts = [district, neighborhood, street, door].filter(Boolean);
    if (!parts.length && address) parts.push(address);
    if (!parts.length && title) parts.push(title);
    return { district, neighborhood, street, door, title, address, parts };
};

export const formatCanonicalAddress = document => {
    const parts = createAddressParts(document);
    const hierarchy = [parts.street, parts.door, parts.neighborhood, parts.district].filter(Boolean);
    if (hierarchy.length) return hierarchy.join(", ");
    return parts.address || parts.title || "";
};

export const createAddressHierarchyKey = document => {
    const parts = createAddressParts(document);
    return [parts.district, parts.neighborhood, parts.street, parts.door]
        .map(normalizeAddressToken)
        .join("|");
};

export const createAddressParentKey = document => {
    const level = document?.level || inferAddressLevel(document);
    const parts = createAddressParts(document);
    if (level === ADDRESS_LEVELS.District) return null;
    if (level === ADDRESS_LEVELS.Neighborhood) {
        return `district:${normalizeAddressToken(parts.district)}`;
    }
    if (level === ADDRESS_LEVELS.Street) {
        return `neighborhood:${normalizeAddressToken(parts.district)}|${normalizeAddressToken(parts.neighborhood)}`;
    }
    if (level === ADDRESS_LEVELS.Building || level === ADDRESS_LEVELS.Door) {
        return `street:${normalizeAddressToken(parts.district)}|${normalizeAddressToken(parts.neighborhood)}|${normalizeAddressToken(parts.street)}`;
    }
    return null;
};

export const normalizeAddressDocument = (record, sourceIndex = 0) => {
    const base = createSearchDocumentFromSchema(record, ADDRESS_RECORD_SCHEMA, sourceIndex);
    const level = inferAddressLevel({ ...record, ...base.fields, attr: record?.attr });
    const canonicalAddress = formatCanonicalAddress(base);
    const tokens = unique([
        ...tokenizeAddress(base.title),
        ...tokenizeAddress(base.address),
        ...tokenizeAddress(base.district),
        ...tokenizeAddress(base.neighborhood),
        ...tokenizeAddress(base.street),
        ...tokenizeAddress(base.door),
        ...tokenizeAddress(canonicalAddress)
    ]);
    return {
        ...base,
        level,
        canonicalAddress,
        hierarchyKey: createAddressHierarchyKey(base),
        parentKey: createAddressParentKey({ ...base, level }),
        tokens,
        normalizedDoor: normalizeDoorNumber(base.door),
        normalizedDistrict: normalizeAddressToken(base.district),
        normalizedNeighborhood: normalizeAddressToken(base.neighborhood),
        normalizedStreet: normalizeAddressToken(base.street)
    };
};

const parseCoordinateTokens = tokens => {
    if (!Array.isArray(tokens) || tokens.length < 2) return null;
    const first = normalizeFiniteNumber(tokens[0], null);
    const second = normalizeFiniteNumber(tokens[1], null);
    if (first === null || second === null) return null;
    const longitudeLatitude = normalizeCoordinates({ longitude: first, latitude: second });
    if (longitudeLatitude) return longitudeLatitude;
    return normalizeCoordinates({ longitude: second, latitude: first });
};

export const parseCoordinatePair = value => {
    if (Array.isArray(value)) return parseCoordinateTokens(value);
    if (value && typeof value === "object") return normalizeCoordinates(value);
    if (typeof value !== "string") return null;

    const text = normalizeText(value);
    if (!text) return null;

    const whitespaceTokens = text.split(/\s+/).filter(Boolean);
    if (whitespaceTokens.length === 2) {
        const result = parseCoordinateTokens(whitespaceTokens.map(token => token.replace(",", ".")));
        if (result) return result;
    }

    const semicolonTokens = text.split(";").map(token => token.trim()).filter(Boolean);
    if (semicolonTokens.length === 2) {
        const result = parseCoordinateTokens(semicolonTokens.map(token => token.replace(",", ".")));
        if (result) return result;
    }

    const commaTokens = text.split(",").map(token => token.trim()).filter(Boolean);
    if (commaTokens.length === 2) return parseCoordinateTokens(commaTokens);
    return null;
};

export const toRadians = degrees => degrees * Math.PI / 180;

export const haversineDistanceMeters = (left, right) => {
    const a = parseCoordinatePair(left);
    const b = parseCoordinatePair(right);
    if (!a || !b) return null;
    const latitudeDelta = toRadians(b.latitude - a.latitude);
    const longitudeDelta = toRadians(b.longitude - a.longitude);
    const latitude1 = toRadians(a.latitude);
    const latitude2 = toRadians(b.latitude);
    const sinLat = Math.sin(latitudeDelta / 2);
    const sinLon = Math.sin(longitudeDelta / 2);
    const h = sinLat * sinLat + Math.cos(latitude1) * Math.cos(latitude2) * sinLon * sinLon;
    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const createBoundingBox = (center, radiusMeters) => {
    const point = parseCoordinatePair(center);
    const radius = normalizeFiniteNumber(radiusMeters, null);
    if (!point || radius === null || radius < 0) return null;
    const latitudeDelta = radius / 111320;
    const longitudeScale = Math.max(Math.cos(toRadians(point.latitude)), 0.000001);
    const longitudeDelta = radius / (111320 * longitudeScale);
    return {
        minLatitude: Math.max(-90, point.latitude - latitudeDelta),
        maxLatitude: Math.min(90, point.latitude + latitudeDelta),
        minLongitude: Math.max(-180, point.longitude - longitudeDelta),
        maxLongitude: Math.min(180, point.longitude + longitudeDelta)
    };
};

export const isInsideBoundingBox = (coordinates, bounds) => {
    const point = parseCoordinatePair(coordinates);
    if (!point || !bounds) return false;
    return point.latitude >= bounds.minLatitude
        && point.latitude <= bounds.maxLatitude
        && point.longitude >= bounds.minLongitude
        && point.longitude <= bounds.maxLongitude;
};

const addToMapSet = (map, key, value) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
};

export const createAddressIndex = (records, options = {}) => {
    const normalized = normalizeRecordCollection(records, ADDRESS_RECORD_SCHEMA, {
        dedupe: options.dedupe !== false,
        keepInvalid: true
    });
    const documents = normalized.documents.map((document, index) => normalizeAddressDocument(document.source, index));
    const byKey = new Map();
    const byId = new Map();
    const byLevel = new Map();
    const byDistrict = new Map();
    const byNeighborhood = new Map();
    const byStreet = new Map();
    const byToken = new Map();
    const byParent = new Map();
    const duplicateKeys = [];
    const conflictingIds = [];

    documents.forEach((document, index) => {
        if (byKey.has(document.key)) duplicateKeys.push(document.key);
        byKey.set(document.key, document);
        if (document.id) {
            if (byId.has(document.id) && byId.get(document.id).key !== document.key) conflictingIds.push(document.id);
            else byId.set(document.id, document);
        }
        addToMapSet(byLevel, document.level, index);
        addToMapSet(byDistrict, document.normalizedDistrict, index);
        addToMapSet(byNeighborhood, `${document.normalizedDistrict}|${document.normalizedNeighborhood}`, index);
        addToMapSet(byStreet, `${document.normalizedDistrict}|${document.normalizedNeighborhood}|${document.normalizedStreet}`, index);
        addToMapSet(byParent, document.parentKey, index);
        document.tokens.forEach(token => addToMapSet(byToken, token, index));
    });

    return {
        documents,
        byKey,
        byId,
        byLevel,
        byDistrict,
        byNeighborhood,
        byStreet,
        byToken,
        byParent,
        diagnostics: {
            ...normalized.diagnostics,
            indexedCount: documents.length,
            duplicateKeys: unique(duplicateKeys),
            conflictingIds: unique(conflictingIds),
            districtCount: byDistrict.size,
            neighborhoodCount: byNeighborhood.size,
            streetCount: byStreet.size,
            tokenCount: byToken.size
        },
        drift: normalized.drift
    };
};

export const getAddressChildren = (index, documentOrParentKey) => {
    if (!index?.documents || !index?.byParent) return [];
    const parentKey = typeof documentOrParentKey === "string"
        ? documentOrParentKey
        : (() => {
            const document = documentOrParentKey;
            if (!document) return null;
            if (document.level === ADDRESS_LEVELS.District) return `district:${document.normalizedDistrict}`;
            if (document.level === ADDRESS_LEVELS.Neighborhood) {
                return `neighborhood:${document.normalizedDistrict}|${document.normalizedNeighborhood}`;
            }
            if (document.level === ADDRESS_LEVELS.Street) {
                return `street:${document.normalizedDistrict}|${document.normalizedNeighborhood}|${document.normalizedStreet}`;
            }
            return null;
        })();
    if (!parentKey) return [];
    const positions = index.byParent.get(parentKey);
    return positions ? Array.from(positions).map(position => index.documents[position]).filter(Boolean) : [];
};

export const getAddressAncestors = (index, document) => {
    if (!index?.documents || !document) return [];
    const result = [];
    if (document.normalizedDistrict) {
        const position = Array.from(index.byDistrict.get(document.normalizedDistrict) || [])
            .find(candidate => index.documents[candidate]?.level === ADDRESS_LEVELS.District);
        if (!isNil(position)) result.push(index.documents[position]);
    }
    if (document.normalizedNeighborhood) {
        const key = `${document.normalizedDistrict}|${document.normalizedNeighborhood}`;
        const position = Array.from(index.byNeighborhood.get(key) || [])
            .find(candidate => index.documents[candidate]?.level === ADDRESS_LEVELS.Neighborhood);
        if (!isNil(position)) result.push(index.documents[position]);
    }
    if (document.normalizedStreet) {
        const key = `${document.normalizedDistrict}|${document.normalizedNeighborhood}|${document.normalizedStreet}`;
        const position = Array.from(index.byStreet.get(key) || [])
            .find(candidate => index.documents[candidate]?.level === ADDRESS_LEVELS.Street);
        if (!isNil(position)) result.push(index.documents[position]);
    }
    return result;
};

const scoreToken = (candidate, queryToken) => {
    if (!candidate || !queryToken) return 0;
    if (candidate === queryToken) return 100;
    if (candidate.startsWith(queryToken)) return 70;
    if (candidate.includes(queryToken)) return 40;
    if (queryToken.includes(candidate) && candidate.length >= 3) return 20;
    return 0;
};

export const scoreAddressDocument = (document, query) => {
    const queryText = normalizeAddressToken(query);
    if (!queryText) return 0;
    const queryTokens = tokenizeAddress(queryText);
    if (!queryTokens.length) return 0;
    const canonical = normalizeAddressToken(document.canonicalAddress);
    const title = normalizeAddressToken(document.title);
    const exactBonus = canonical === queryText || title === queryText ? 500 : 0;
    const prefixBonus = canonical.startsWith(queryText) || title.startsWith(queryText) ? 200 : 0;
    let tokenScore = 0;
    let matchedTokens = 0;
    queryTokens.forEach(queryToken => {
        const best = document.tokens.reduce(
            (maximum, token) => Math.max(maximum, scoreToken(token, queryToken)),
            0
        );
        if (best > 0) matchedTokens += 1;
        tokenScore += best;
    });
    if (matchedTokens === 0 && exactBonus === 0 && prefixBonus === 0) return 0;
    const completeness = matchedTokens === queryTokens.length ? 150 : matchedTokens * 10;
    const levelBonus = {
        [ADDRESS_LEVELS.Door]: 60,
        [ADDRESS_LEVELS.Building]: 50,
        [ADDRESS_LEVELS.Street]: 40,
        [ADDRESS_LEVELS.Neighborhood]: 30,
        [ADDRESS_LEVELS.District]: 20,
        [ADDRESS_LEVELS.Address]: 10
    }[document.level] || 0;
    return exactBonus + prefixBonus + tokenScore + completeness + levelBonus;
};

export const normalizeAddressSearchOptions = options => {
    const rawLimit = normalizeFiniteNumber(options?.limit, null);
    const limit = rawLimit === null || rawLimit <= 0
        ? DEFAULT_ADDRESS_SEARCH_LIMIT
        : Math.min(MAX_ADDRESS_SEARCH_LIMIT, Math.max(1, Math.trunc(rawLimit)));
    const rawOffset = normalizeFiniteNumber(options?.offset, 0);
    return {
        offset: Math.max(0, Math.trunc(rawOffset || 0)),
        limit,
        level: normalizeAddressLevel(options?.level),
        district: normalizeAddressToken(options?.district),
        neighborhood: normalizeAddressToken(options?.neighborhood),
        street: normalizeAddressToken(options?.street),
        center: parseCoordinatePair(options?.center),
        radiusMeters: Math.max(0, normalizeFiniteNumber(options?.radiusMeters, 0) || 0),
        minScore: Math.max(0, normalizeFiniteNumber(options?.minScore, 1) || 0)
    };
};

export const filterAddressDocuments = (documents, options = {}) => {
    const normalized = normalizeAddressSearchOptions(options);
    const bounds = normalized.center && normalized.radiusMeters > 0
        ? createBoundingBox(normalized.center, normalized.radiusMeters)
        : null;
    return (Array.isArray(documents) ? documents : []).filter(document => {
        if (normalized.level && document.level !== normalized.level) return false;
        if (normalized.district && document.normalizedDistrict !== normalized.district) return false;
        if (normalized.neighborhood && document.normalizedNeighborhood !== normalized.neighborhood) return false;
        if (normalized.street && document.normalizedStreet !== normalized.street) return false;
        if (bounds) {
            if (!document.coordinates || !isInsideBoundingBox(document.coordinates, bounds)) return false;
            const distance = haversineDistanceMeters(normalized.center, document.coordinates);
            if (distance === null || distance > normalized.radiusMeters) return false;
        }
        return true;
    });
};

export const searchAddressIndex = (index, query, options = {}) => {
    const queryText = normalizeAddressToken(query);
    const inferredLevel = options?.level ? null : inferQueryLevel(queryText);
    const normalizedOptions = normalizeAddressSearchOptions({
        ...options,
        level: options?.level || inferredLevel
    });
    const filtered = filterAddressDocuments(index?.documents, normalizedOptions);
    const scored = filtered
        .map(document => ({
            document,
            score: queryText ? scoreAddressDocument(document, queryText) : 1,
            distanceMeters: normalizedOptions.center && document.coordinates
                ? haversineDistanceMeters(normalizedOptions.center, document.coordinates)
                : null
        }))
        .filter(item => item.score >= normalizedOptions.minScore)
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            if (left.distanceMeters !== null && right.distanceMeters !== null && left.distanceMeters !== right.distanceMeters) {
                return left.distanceMeters - right.distanceMeters;
            }
            return left.document.canonicalAddress.localeCompare(right.document.canonicalAddress, "tr-TR", {
                sensitivity: "base",
                numeric: true
            });
        });
    const pageItems = scored.slice(normalizedOptions.offset, normalizedOptions.offset + normalizedOptions.limit);
    const nextOffset = normalizedOptions.offset + pageItems.length;
    return {
        results: pageItems,
        page: {
            offset: normalizedOptions.offset,
            limit: normalizedOptions.limit,
            count: pageItems.length,
            total: scored.length,
            hasMore: nextOffset < scored.length,
            nextOffset: nextOffset < scored.length ? nextOffset : null
        }
    };
};

export const findNearestAddresses = (index, center, options = {}) => {
    const point = parseCoordinatePair(center);
    if (!point) return [];
    const limit = normalizeInteger(options.limit, {
        min: 1,
        max: MAX_ADDRESS_SEARCH_LIMIT,
        fallback: DEFAULT_ADDRESS_SEARCH_LIMIT
    });
    const radiusMeters = Math.max(0, normalizeFiniteNumber(options.radiusMeters, 5000) || 5000);
    const bounds = createBoundingBox(point, radiusMeters);
    return (index?.documents || [])
        .filter(document => document.coordinates && isInsideBoundingBox(document.coordinates, bounds))
        .map(document => ({
            document,
            distanceMeters: haversineDistanceMeters(point, document.coordinates)
        }))
        .filter(item => item.distanceMeters !== null && item.distanceMeters <= radiusMeters)
        .sort((left, right) => left.distanceMeters - right.distanceMeters)
        .slice(0, limit);
};

export const detectAddressHierarchyIssues = index => {
    const issues = [];
    (index?.documents || []).forEach(document => {
        if (document.level === ADDRESS_LEVELS.Neighborhood && !document.normalizedDistrict) {
            issues.push({ code: "neighborhood-without-district", key: document.key, severity: "warning" });
        }
        if (document.level === ADDRESS_LEVELS.Street && (!document.normalizedDistrict || !document.normalizedNeighborhood)) {
            issues.push({ code: "street-without-parent", key: document.key, severity: "warning" });
        }
        if (document.level === ADDRESS_LEVELS.Door && (!document.normalizedStreet || !document.normalizedDoor)) {
            issues.push({ code: "door-without-street-or-number", key: document.key, severity: "warning" });
        }
        if ((document.fields.latitude === null) !== (document.fields.longitude === null)) {
            issues.push({ code: "partial-coordinate-pair", key: document.key, severity: "warning" });
        }
    });
    (index?.diagnostics?.conflictingIds || []).forEach(id => {
        issues.push({ code: "conflicting-id", id, severity: "error" });
    });
    return issues;
};

export const createAddressQualityReport = index => {
    const documents = index?.documents || [];
    const levelCounts = ADDRESS_LEVEL_ORDER.reduce((result, level) => ({
        ...result,
        [level]: documents.filter(document => document.level === level).length
    }), {});
    const geocodedCount = documents.filter(document => Boolean(document.coordinates)).length;
    const hierarchyIssues = detectAddressHierarchyIssues(index);
    return {
        total: documents.length,
        geocodedCount,
        ungeocodedCount: documents.length - geocodedCount,
        geocodedRatio: documents.length ? geocodedCount / documents.length : 0,
        levelCounts,
        hierarchyIssues,
        hierarchyIssueCount: hierarchyIssues.length,
        diagnostics: index?.diagnostics || null,
        drift: index?.drift || null
    };
};

export const AddressSearchRuntime = {
    ADDRESS_LEVELS,
    ADDRESS_LEVEL_ORDER,
    DEFAULT_ADDRESS_SEARCH_LIMIT,
    MAX_ADDRESS_SEARCH_LIMIT,
    EARTH_RADIUS_METERS,
    normalizeAddressToken,
    tokenizeAddress,
    normalizeDoorNumber,
    normalizePostalCode,
    normalizeAddressLevel,
    inferAddressLevel,
    createAddressParts,
    formatCanonicalAddress,
    createAddressHierarchyKey,
    createAddressParentKey,
    normalizeAddressDocument,
    parseCoordinatePair,
    toRadians,
    haversineDistanceMeters,
    createBoundingBox,
    isInsideBoundingBox,
    createAddressIndex,
    getAddressChildren,
    getAddressAncestors,
    scoreAddressDocument,
    normalizeAddressSearchOptions,
    filterAddressDocuments,
    searchAddressIndex,
    findNearestAddresses,
    detectAddressHierarchyIssues,
    createAddressQualityReport
};
