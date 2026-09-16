import {
    normalizeCoordinates,
    normalizeFiniteNumber,
    normalizeInteger,
    normalizeSearchText,
    normalizeText
} from "./DataIntegrityHelper";
import {
    canonicalizeAddressText
} from "./AddressQuerySemanticsRuntime";
import {
    parseCoordinatePair
} from "./AddressSearchRuntime";

export const GEOCODING_ADAPTER_VERSION = "1.0.0";
export const DEFAULT_GEOCODING_LIMIT = 10;
export const MAX_GEOCODING_LIMIT = 100;
export const DEFAULT_GEOCODING_CACHE_SIZE = 250;
export const MAX_GEOCODING_CACHE_SIZE = 5000;
export const DEFAULT_GEOCODING_TTL_MS = 5 * 60 * 1000;
export const MAX_GEOCODING_TTL_MS = 24 * 60 * 60 * 1000;

export const GEOCODING_STATUS = Object.freeze({
    Ok: "ok",
    Empty: "empty",
    Invalid: "invalid",
    Aborted: "aborted",
    Failed: "failed"
});

const asArray = value => Array.isArray(value) ? value : [];
const unique = values => Array.from(new Set(values.filter(Boolean)));
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

export class GeocodingAdapterError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = "GeocodingAdapterError";
        this.code = code;
        this.details = details;
    }
}

export const throwIfGeocodingAborted = signal => {
    if (signal?.aborted) {
        const error = new GeocodingAdapterError("GEOCODING_ABORTED", "Geocoding operation was aborted");
        error.name = "AbortError";
        throw error;
    }
};

export const normalizeGeocodingLimit = value => normalizeInteger(value, {
    min: 1,
    max: MAX_GEOCODING_LIMIT,
    fallback: DEFAULT_GEOCODING_LIMIT
});

export const normalizeGeocodingConfidence = value => {
    const numeric = normalizeFiniteNumber(value, null);
    if (numeric === null) return null;
    if (numeric > 1 && numeric <= 100) return numeric / 100;
    return Math.min(1, Math.max(0, numeric));
};

export const normalizeGeocodingLabel = value => normalizeText(value).replace(/\s+/g, " ").trim();

export const normalizeGeocodingRequest = request => {
    const input = isObject(request) ? request : { query: request };
    const query = normalizeGeocodingLabel(input.query || input.address || input.text);
    const coordinates = parseCoordinatePair(input.coordinates || input.center || input.location);
    const limit = normalizeGeocodingLimit(input.limit);
    return {
        ...input,
        query,
        normalizedQuery: canonicalizeAddressText(query),
        coordinates,
        limit,
        district: normalizeGeocodingLabel(input.district),
        neighborhood: normalizeGeocodingLabel(input.neighborhood),
        street: normalizeGeocodingLabel(input.street),
        postalCode: normalizeGeocodingLabel(input.postalCode),
        language: normalizeText(input.language || "tr").toLocaleLowerCase("en-US"),
        countryCode: normalizeText(input.countryCode || "TR").toLocaleUpperCase("en-US")
    };
};

export const createGeocodingRequestKey = request => {
    const normalized = normalizeGeocodingRequest(request);
    return JSON.stringify({
        q: normalized.normalizedQuery,
        c: normalized.coordinates,
        d: canonicalizeAddressText(normalized.district),
        n: canonicalizeAddressText(normalized.neighborhood),
        s: canonicalizeAddressText(normalized.street),
        p: normalized.postalCode,
        l: normalized.language,
        cc: normalized.countryCode,
        limit: normalized.limit
    });
};

const readCandidateValue = (candidate, keys, fallback = null) => {
    const sources = [candidate, candidate?.attributes, candidate?.properties, candidate?.location].filter(Boolean);
    for (const source of sources) {
        for (const key of keys) {
            const value = source?.[key];
            if (value !== null && value !== undefined && normalizeText(value) !== "") return value;
        }
    }
    return fallback;
};

export const normalizeGeocodingCandidate = (candidate, index = 0, providerId = "unknown") => {
    if (!candidate) return null;
    const coordinates = parseCoordinatePair(
        candidate.coordinates
        || candidate.location
        || candidate.geometry
        || {
            latitude: readCandidateValue(candidate, ["latitude", "lat", "y", "Y"]),
            longitude: readCandidateValue(candidate, ["longitude", "lng", "lon", "x", "X"])
        }
    );
    if (!coordinates) return null;
    const label = normalizeGeocodingLabel(readCandidateValue(
        candidate,
        ["label", "formattedAddress", "formatted_address", "address", "title", "name", "ADI"],
        ""
    ));
    const idValue = readCandidateValue(candidate, ["id", "Id", "ID", "objectId", "OBJECTID"], null);
    const confidence = normalizeGeocodingConfidence(readCandidateValue(
        candidate,
        ["confidence", "score", "relevance", "matchScore"],
        null
    ));
    return {
        providerId,
        id: idValue === null ? null : String(idValue),
        key: idValue === null
            ? `${providerId}:${coordinates.longitude.toFixed(7)},${coordinates.latitude.toFixed(7)}:${index}`
            : `${providerId}:${String(idValue)}`,
        label,
        canonicalLabel: canonicalizeAddressText(label),
        coordinates: normalizeCoordinates(coordinates),
        confidence,
        district: normalizeGeocodingLabel(readCandidateValue(candidate, ["district", "ilce", "ILCE_ADI"], "")),
        neighborhood: normalizeGeocodingLabel(readCandidateValue(candidate, ["neighborhood", "mahalle", "MAHALLE_ADI"], "")),
        street: normalizeGeocodingLabel(readCandidateValue(candidate, ["street", "cadde", "sokak", "YOL_ADI"], "")),
        door: normalizeGeocodingLabel(readCandidateValue(candidate, ["door", "doorNumber", "kapino", "KAPI_NO"], "")),
        postalCode: normalizeGeocodingLabel(readCandidateValue(candidate, ["postalCode", "postcode", "zip"], "")),
        category: normalizeGeocodingLabel(readCandidateValue(candidate, ["category", "type", "kind"], "")),
        raw: candidate
    };
};

export const normalizeGeocodingPayload = (payload, options = {}) => {
    const providerId = normalizeText(options.providerId || "unknown") || "unknown";
    let candidates;
    if (Array.isArray(payload)) candidates = payload;
    else if (Array.isArray(payload?.results)) candidates = payload.results;
    else if (Array.isArray(payload?.features)) candidates = payload.features;
    else if (Array.isArray(payload?.candidates)) candidates = payload.candidates;
    else if (Array.isArray(payload?.items)) candidates = payload.items;
    else candidates = [];

    const normalized = candidates
        .map((candidate, index) => normalizeGeocodingCandidate(candidate, index, providerId))
        .filter(Boolean);
    const seen = new Set();
    const deduped = [];
    normalized.forEach(candidate => {
        const key = candidate.id
            ? `${providerId}:id:${candidate.id}`
            : `${candidate.coordinates.longitude.toFixed(6)}:${candidate.coordinates.latitude.toFixed(6)}:${candidate.canonicalLabel}`;
        if (seen.has(key)) return;
        seen.add(key);
        deduped.push(candidate);
    });
    return {
        candidates: deduped,
        diagnostics: {
            providerId,
            rawCount: candidates.length,
            normalizedCount: normalized.length,
            returnedCount: deduped.length,
            invalidCount: candidates.length - normalized.length,
            duplicateCount: normalized.length - deduped.length
        }
    };
};

export const rankGeocodingCandidates = (candidates, request) => {
    const normalizedRequest = normalizeGeocodingRequest(request);
    const query = normalizedRequest.normalizedQuery;
    const ranked = asArray(candidates).map(candidate => {
        const label = candidate.canonicalLabel || canonicalizeAddressText(candidate.label);
        const exact = query && label === query ? 1 : 0;
        const prefix = query && label.startsWith(query) ? 1 : 0;
        const contains = query && label.includes(query) ? 1 : 0;
        const localityMatches = [
            normalizedRequest.district && canonicalizeAddressText(candidate.district) === canonicalizeAddressText(normalizedRequest.district),
            normalizedRequest.neighborhood && canonicalizeAddressText(candidate.neighborhood) === canonicalizeAddressText(normalizedRequest.neighborhood),
            normalizedRequest.street && canonicalizeAddressText(candidate.street) === canonicalizeAddressText(normalizedRequest.street),
            normalizedRequest.postalCode && candidate.postalCode === normalizedRequest.postalCode
        ].filter(Boolean).length;
        const confidence = candidate.confidence ?? 0;
        const score = exact * 1000 + prefix * 400 + contains * 150 + localityMatches * 120 + confidence * 100;
        return { ...candidate, geocodingScore: score };
    });
    return ranked.sort((left, right) => (
        right.geocodingScore - left.geocodingScore
        || (right.confidence ?? 0) - (left.confidence ?? 0)
        || left.label.localeCompare(right.label, "tr-TR", { sensitivity: "base", numeric: true })
    ));
};

export const createGeocodingCache = (options = {}) => {
    const maxEntries = normalizeInteger(options.maxEntries, {
        min: 1,
        max: MAX_GEOCODING_CACHE_SIZE,
        fallback: DEFAULT_GEOCODING_CACHE_SIZE
    });
    const ttlMs = normalizeInteger(options.ttlMs, {
        min: 1000,
        max: MAX_GEOCODING_TTL_MS,
        fallback: DEFAULT_GEOCODING_TTL_MS
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
        clear() {
            const count = entries.size;
            entries.clear();
            return count;
        },
        diagnostics(now = Date.now()) {
            removeExpired(now);
            return { ...stats, size: entries.size, maxEntries, ttlMs };
        }
    };
};

export const createGeocodingProviderRegistry = () => {
    const providers = new Map();
    return {
        register(providerId, provider) {
            const id = normalizeText(providerId);
            if (!id) throw new GeocodingAdapterError("INVALID_PROVIDER_ID", "Geocoding provider id is required");
            if (!provider || (typeof provider.forward !== "function" && typeof provider.reverse !== "function")) {
                throw new GeocodingAdapterError(
                    "INVALID_PROVIDER",
                    `Geocoding provider ${id} must expose forward and/or reverse`
                );
            }
            providers.set(id, { id, ...provider });
            return id;
        },
        unregister(providerId) {
            return providers.delete(normalizeText(providerId));
        },
        get(providerId) {
            return providers.get(normalizeText(providerId)) || null;
        },
        list() {
            return Array.from(providers.values()).map(provider => ({
                id: provider.id,
                canForward: typeof provider.forward === "function",
                canReverse: typeof provider.reverse === "function"
            }));
        },
        clear() {
            const count = providers.size;
            providers.clear();
            return count;
        }
    };
};

export const createGeocodingAdapter = (options = {}) => {
    const registry = options.registry || createGeocodingProviderRegistry();
    const cache = options.cache || createGeocodingCache(options.cacheOptions);
    const inFlight = new Map();
    const stats = {
        forwardRequests: 0,
        reverseRequests: 0,
        providerCalls: 0,
        cacheHits: 0,
        dedupedCalls: 0,
        failures: 0,
        aborts: 0
    };

    const resolveProvider = providerId => {
        const id = normalizeText(providerId || options.defaultProviderId);
        const provider = registry.get(id);
        if (!provider) throw new GeocodingAdapterError("PROVIDER_NOT_FOUND", `Geocoding provider not found: ${id || "<none>"}`);
        return provider;
    };

    const execute = async (kind, providerId, rawRequest, executeOptions = {}) => {
        throwIfGeocodingAborted(executeOptions.signal);
        const provider = resolveProvider(providerId);
        const request = normalizeGeocodingRequest(rawRequest);
        const method = kind === "reverse" ? provider.reverse : provider.forward;
        if (typeof method !== "function") {
            throw new GeocodingAdapterError("PROVIDER_CAPABILITY_MISSING", `${provider.id} does not support ${kind}`);
        }
        if (kind === "forward" && !request.query) {
            return { status: GEOCODING_STATUS.Invalid, candidates: [], request, providerId: provider.id };
        }
        if (kind === "reverse" && !request.coordinates) {
            return { status: GEOCODING_STATUS.Invalid, candidates: [], request, providerId: provider.id };
        }

        const key = `${kind}:${provider.id}:${createGeocodingRequestKey(request)}`;
        if (executeOptions.useCache !== false) {
            const cached = cache.get(key, executeOptions.now);
            if (cached !== undefined) {
                stats.cacheHits += 1;
                return cached;
            }
        }
        if (inFlight.has(key)) {
            stats.dedupedCalls += 1;
            return inFlight.get(key);
        }

        const promise = (async () => {
            try {
                throwIfGeocodingAborted(executeOptions.signal);
                stats.providerCalls += 1;
                const payload = await method(request, {
                    signal: executeOptions.signal,
                    context: executeOptions.context
                });
                throwIfGeocodingAborted(executeOptions.signal);
                const normalized = normalizeGeocodingPayload(payload, { providerId: provider.id });
                const ranked = rankGeocodingCandidates(normalized.candidates, request).slice(0, request.limit);
                const result = {
                    status: ranked.length ? GEOCODING_STATUS.Ok : GEOCODING_STATUS.Empty,
                    providerId: provider.id,
                    request,
                    candidates: ranked,
                    diagnostics: normalized.diagnostics
                };
                if (executeOptions.useCache !== false) cache.set(key, result, executeOptions.now);
                return result;
            } catch (error) {
                if (error?.name === "AbortError" || executeOptions.signal?.aborted) {
                    stats.aborts += 1;
                    throw error;
                }
                stats.failures += 1;
                if (error instanceof GeocodingAdapterError) throw error;
                throw new GeocodingAdapterError(
                    "PROVIDER_EXECUTION_FAILED",
                    `${provider.id} ${kind} geocoding failed`,
                    { providerId: provider.id, kind, cause: error }
                );
            } finally {
                inFlight.delete(key);
            }
        })();
        inFlight.set(key, promise);
        return promise;
    };

    return {
        registry,
        cache,
        registerProvider: registry.register.bind(registry),
        unregisterProvider: registry.unregister.bind(registry),

        forward(providerId, request, executeOptions = {}) {
            stats.forwardRequests += 1;
            return execute("forward", providerId, request, executeOptions);
        },

        reverse(providerId, request, executeOptions = {}) {
            stats.reverseRequests += 1;
            return execute("reverse", providerId, request, executeOptions);
        },

        diagnostics(now = Date.now()) {
            return {
                version: GEOCODING_ADAPTER_VERSION,
                ...stats,
                inFlightCount: inFlight.size,
                providers: registry.list(),
                cache: cache.diagnostics(now)
            };
        },

        clear() {
            inFlight.clear();
            cache.clear();
            return registry.clear();
        }
    };
};

export const createStaticGeocodingProvider = (records, options = {}) => {
    const source = asArray(records);
    const providerId = normalizeText(options.id || "static");
    const search = request => {
        const needle = normalizeSearchText(request.query);
        const candidates = source.filter(record => {
            if (!needle) return false;
            const label = normalizeSearchText(
                record.label || record.formattedAddress || record.address || record.title || record.name
            );
            return label.includes(needle);
        });
        return candidates.slice(0, request.limit);
    };
    const reverse = request => {
        const target = request.coordinates;
        if (!target) return [];
        return source
            .map((record, index) => ({
                record,
                index,
                coordinates: parseCoordinatePair(record.coordinates || record.location || record.geometry)
            }))
            .filter(item => item.coordinates)
            .map(item => ({
                ...item,
                distanceSquared: (
                    (item.coordinates.latitude - target.latitude) ** 2
                    + (item.coordinates.longitude - target.longitude) ** 2
                )
            }))
            .sort((left, right) => left.distanceSquared - right.distanceSquared)
            .slice(0, request.limit)
            .map(item => item.record);
    };
    return {
        id: providerId,
        forward: async request => search(request),
        reverse: async request => reverse(request)
    };
};

export const createGeocodingQualityReport = adapter => {
    const diagnostics = adapter?.diagnostics?.() || {};
    const providerCount = asArray(diagnostics.providers).length;
    const calls = diagnostics.providerCalls || 0;
    const failures = diagnostics.failures || 0;
    return {
        version: diagnostics.version || GEOCODING_ADAPTER_VERSION,
        providerCount,
        providerCalls: calls,
        failureCount: failures,
        abortCount: diagnostics.aborts || 0,
        dedupedCalls: diagnostics.dedupedCalls || 0,
        cacheHitCount: diagnostics.cacheHits || 0,
        failureRatio: calls ? failures / calls : 0,
        healthy: providerCount > 0 && failures === 0
    };
};

export const GeocodingAdapterRuntime = {
    GEOCODING_ADAPTER_VERSION,
    GEOCODING_STATUS,
    DEFAULT_GEOCODING_LIMIT,
    MAX_GEOCODING_LIMIT,
    DEFAULT_GEOCODING_CACHE_SIZE,
    MAX_GEOCODING_CACHE_SIZE,
    DEFAULT_GEOCODING_TTL_MS,
    MAX_GEOCODING_TTL_MS,
    GeocodingAdapterError,
    throwIfGeocodingAborted,
    normalizeGeocodingLimit,
    normalizeGeocodingConfidence,
    normalizeGeocodingLabel,
    normalizeGeocodingRequest,
    createGeocodingRequestKey,
    normalizeGeocodingCandidate,
    normalizeGeocodingPayload,
    rankGeocodingCandidates,
    createGeocodingCache,
    createGeocodingProviderRegistry,
    createGeocodingAdapter,
    createStaticGeocodingProvider,
    createGeocodingQualityReport
};