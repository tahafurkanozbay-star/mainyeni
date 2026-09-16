import {
    normalizeCategoryKey,
    normalizeFiniteNumber,
    normalizeInteger,
    normalizePagination,
    normalizeSearchText,
    normalizeText
} from "./DataIntegrityHelper";

export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 500;
export const DEFAULT_PREFIX_LENGTH = 3;
export const DEFAULT_CACHE_SIZE = 100;
export const DEFAULT_CACHE_TTL_MS = 30000;

const unique = values => Array.from(new Set(values));

export const tokenizeSearchText = value => unique(normalizeSearchText(value)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map(token => token.trim())
    .filter(Boolean));

export const createTokenPrefixes = (token, minimumLength = DEFAULT_PREFIX_LENGTH) => {
    const normalized = normalizeSearchText(token).replace(/[^a-z0-9]/g, "");
    if (!normalized) return [];
    const min = Math.max(1, normalizeInteger(minimumLength, { min: 1, max: 20, fallback: DEFAULT_PREFIX_LENGTH }));
    if (normalized.length < min) return [normalized];
    const prefixes = [];
    for (let length = min; length <= normalized.length; length += 1) {
        prefixes.push(normalized.slice(0, length));
    }
    return prefixes;
};

export const boundedLevenshtein = (leftValue, rightValue, maxDistance = 2) => {
    const left = normalizeSearchText(leftValue);
    const right = normalizeSearchText(rightValue);
    const limit = Math.max(0, normalizeInteger(maxDistance, { min: 0, max: 8, fallback: 2 }));
    if (left === right) return 0;
    if (!left.length) return right.length <= limit ? right.length : limit + 1;
    if (!right.length) return left.length <= limit ? left.length : limit + 1;
    if (Math.abs(left.length - right.length) > limit) return limit + 1;

    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        let rowMinimum = current[0];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
            const value = Math.min(
                current[rightIndex - 1] + 1,
                previous[rightIndex] + 1,
                previous[rightIndex - 1] + substitutionCost
            );
            current[rightIndex] = value;
            rowMinimum = Math.min(rowMinimum, value);
        }
        if (rowMinimum > limit) return limit + 1;
        previous = current;
    }
    return previous[right.length] <= limit ? previous[right.length] : limit + 1;
};

export const normalizeSearchDocument = (document, index = 0) => {
    const source = document || {};
    const id = normalizeText(source.id ?? source.key ?? `document-${index}`);
    const title = normalizeText(source.title);
    const address = normalizeText(source.address);
    const category = normalizeText(source.category);
    const type = normalizeText(source.type);
    const district = normalizeText(source.district);
    const neighborhood = normalizeText(source.neighborhood);
    const street = normalizeText(source.street);
    const searchText = normalizeSearchText([
        title,
        address,
        category,
        type,
        district,
        neighborhood,
        street,
        source.searchText
    ].filter(Boolean).join(" "));
    const tokens = tokenizeSearchText(searchText);
    return {
        ...source,
        id: id || `document-${index}`,
        title,
        address,
        category,
        categoryKey: normalizeCategoryKey(source.categoryKey || category),
        type,
        typeKey: normalizeCategoryKey(type),
        district,
        districtKey: normalizeCategoryKey(district),
        neighborhood,
        neighborhoodKey: normalizeCategoryKey(neighborhood),
        street,
        streetKey: normalizeCategoryKey(street),
        searchText,
        tokens,
        sourceIndex: Number.isInteger(source.sourceIndex) ? source.sourceIndex : index
    };
};

const addPosition = (map, key, position) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(position);
};

export const createInvertedSearchIndex = (documents, options = {}) => {
    const input = Array.isArray(documents) ? documents : [];
    const prefixLength = normalizeInteger(options.prefixLength, {
        min: 1,
        max: 20,
        fallback: DEFAULT_PREFIX_LENGTH
    });
    const normalized = input.map((document, index) => normalizeSearchDocument(document, index));
    const byId = new Map();
    const tokenPostings = new Map();
    const prefixPostings = new Map();
    const categoryPostings = new Map();
    const typePostings = new Map();
    const districtPostings = new Map();
    const neighborhoodPostings = new Map();
    const streetPostings = new Map();
    const duplicateIds = [];

    normalized.forEach((document, position) => {
        if (byId.has(document.id)) duplicateIds.push(document.id);
        else byId.set(document.id, position);
        document.tokens.forEach(token => {
            addPosition(tokenPostings, token, position);
            createTokenPrefixes(token, prefixLength).forEach(prefix => addPosition(prefixPostings, prefix, position));
        });
        addPosition(categoryPostings, document.categoryKey, position);
        addPosition(typePostings, document.typeKey, position);
        addPosition(districtPostings, document.districtKey, position);
        addPosition(neighborhoodPostings, document.neighborhoodKey, position);
        addPosition(streetPostings, document.streetKey, position);
    });

    return {
        documents: normalized,
        byId,
        tokenPostings,
        prefixPostings,
        categoryPostings,
        typePostings,
        districtPostings,
        neighborhoodPostings,
        streetPostings,
        prefixLength,
        diagnostics: {
            inputCount: input.length,
            indexedCount: normalized.length,
            uniqueIdCount: byId.size,
            duplicateIds: unique(duplicateIds),
            tokenCount: tokenPostings.size,
            prefixCount: prefixPostings.size,
            categoryCount: categoryPostings.size,
            typeCount: typePostings.size,
            districtCount: districtPostings.size,
            neighborhoodCount: neighborhoodPostings.size,
            streetCount: streetPostings.size
        }
    };
};

export const intersectPostings = postingSets => {
    const sets = (Array.isArray(postingSets) ? postingSets : []).filter(set => set instanceof Set);
    if (!sets.length) return null;
    const ordered = [...sets].sort((left, right) => left.size - right.size);
    const result = new Set(ordered[0]);
    ordered.slice(1).forEach(set => {
        Array.from(result).forEach(value => {
            if (!set.has(value)) result.delete(value);
        });
    });
    return result;
};

export const unionPostings = postingSets => {
    const result = new Set();
    (Array.isArray(postingSets) ? postingSets : []).forEach(set => {
        if (!(set instanceof Set)) return;
        set.forEach(value => result.add(value));
    });
    return result;
};

export const normalizeSearchFilters = filters => ({
    categories: unique((filters?.categories || []).map(normalizeCategoryKey).filter(Boolean)),
    types: unique((filters?.types || []).map(normalizeCategoryKey).filter(Boolean)),
    districts: unique((filters?.districts || []).map(normalizeCategoryKey).filter(Boolean)),
    neighborhoods: unique((filters?.neighborhoods || []).map(normalizeCategoryKey).filter(Boolean)),
    streets: unique((filters?.streets || []).map(normalizeCategoryKey).filter(Boolean)),
    ids: unique((filters?.ids || []).map(value => normalizeText(value)).filter(Boolean))
});

const collectFilterPostings = (index, values, postingsMap) => values.length
    ? unionPostings(values.map(value => postingsMap.get(value)))
    : null;

export const getFilterCandidatePositions = (index, filters = {}) => {
    const normalized = normalizeSearchFilters(filters);
    const postingSets = [
        collectFilterPostings(index, normalized.categories, index.categoryPostings),
        collectFilterPostings(index, normalized.types, index.typePostings),
        collectFilterPostings(index, normalized.districts, index.districtPostings),
        collectFilterPostings(index, normalized.neighborhoods, index.neighborhoodPostings),
        collectFilterPostings(index, normalized.streets, index.streetPostings)
    ].filter(Boolean);
    if (normalized.ids.length) {
        postingSets.push(new Set(normalized.ids
            .map(id => index.byId.get(id))
            .filter(position => Number.isInteger(position))));
    }
    return intersectPostings(postingSets);
};

export const getQueryCandidatePositions = (index, query) => {
    const tokens = tokenizeSearchText(query);
    if (!tokens.length) return null;
    const postingSets = tokens.map(token => {
        const exact = index.tokenPostings.get(token);
        if (exact) return exact;
        return index.prefixPostings.get(token) || new Set();
    });
    return intersectPostings(postingSets);
};

const scoreSingleToken = (documentToken, queryToken, fuzzyDistance) => {
    if (documentToken === queryToken) return 100;
    if (documentToken.startsWith(queryToken)) return 70;
    if (documentToken.includes(queryToken)) return 35;
    if (fuzzyDistance > 0 && queryToken.length >= 4 && documentToken.length >= 4) {
        const distance = boundedLevenshtein(documentToken, queryToken, fuzzyDistance);
        if (distance <= fuzzyDistance) return Math.max(10, 30 - distance * 8);
    }
    return 0;
};

export const scoreSearchDocument = (document, query, options = {}) => {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return 1;
    const queryTokens = tokenizeSearchText(normalizedQuery);
    if (!queryTokens.length) return 1;
    const fuzzyDistance = normalizeInteger(options.fuzzyDistance, {
        min: 0,
        max: 3,
        fallback: 1
    });
    let score = 0;
    let matched = 0;
    queryTokens.forEach(queryToken => {
        const best = document.tokens.reduce((maximum, documentToken) => Math.max(
            maximum,
            scoreSingleToken(documentToken, queryToken, fuzzyDistance)
        ), 0);
        if (best > 0) matched += 1;
        score += best;
    });
    if (document.searchText === normalizedQuery) score += 500;
    else if (document.searchText.startsWith(normalizedQuery)) score += 220;
    else if (document.searchText.includes(normalizedQuery)) score += 100;
    if (normalizeSearchText(document.title) === normalizedQuery) score += 400;
    else if (normalizeSearchText(document.title).startsWith(normalizedQuery)) score += 160;
    if (matched === queryTokens.length) score += 120;
    else score -= (queryTokens.length - matched) * 50;
    return Math.max(0, score);
};

export const createFacetSummary = (documents, fields = ["category", "type", "district"]) => {
    const input = Array.isArray(documents) ? documents : [];
    return fields.reduce((result, field) => {
        const counts = new Map();
        input.forEach(document => {
            const label = normalizeText(document?.[field]);
            if (!label) return;
            const key = normalizeCategoryKey(label) || normalizeSearchText(label);
            const current = counts.get(key) || { key, label, count: 0 };
            current.count += 1;
            counts.set(key, current);
        });
        result[field] = Array.from(counts.values())
            .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "tr-TR"));
        return result;
    }, {});
};

export const normalizeIndexedSearchOptions = options => {
    const page = normalizePagination({
        offset: options?.offset,
        limit: options?.limit ?? DEFAULT_SEARCH_LIMIT
    });
    return {
        offset: page.offset,
        limit: Math.min(page.limit, MAX_SEARCH_LIMIT),
        fuzzyDistance: normalizeInteger(options?.fuzzyDistance, { min: 0, max: 3, fallback: 1 }),
        minScore: Math.max(0, normalizeFiniteNumber(options?.minScore, 1) || 0),
        filters: normalizeSearchFilters(options?.filters),
        facetFields: Array.isArray(options?.facetFields) ? options.facetFields.filter(Boolean) : ["category", "type", "district"]
    };
};

const mergeCandidateSets = (documentCount, queryCandidates, filterCandidates) => {
    if (queryCandidates && filterCandidates) return intersectPostings([queryCandidates, filterCandidates]) || new Set();
    if (queryCandidates) return new Set(queryCandidates);
    if (filterCandidates) return new Set(filterCandidates);
    return new Set(Array.from({ length: documentCount }, (_, index) => index));
};

export const searchInvertedIndex = (index, query, options = {}) => {
    const normalizedOptions = normalizeIndexedSearchOptions(options);
    const queryCandidates = getQueryCandidatePositions(index, query);
    const filterCandidates = getFilterCandidatePositions(index, normalizedOptions.filters);
    let candidatePositions = mergeCandidateSets(index.documents.length, queryCandidates, filterCandidates);

    if (queryCandidates && queryCandidates.size === 0 && normalizeSearchText(query)) {
        candidatePositions = new Set(index.documents.map((_document, position) => position));
        if (filterCandidates) candidatePositions = intersectPostings([candidatePositions, filterCandidates]) || new Set();
    }

    const scored = Array.from(candidatePositions)
        .map(position => {
            const document = index.documents[position];
            return {
                document,
                position,
                score: scoreSearchDocument(document, query, normalizedOptions)
            };
        })
        .filter(item => item.document && item.score >= normalizedOptions.minScore)
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            const titleOrder = left.document.title.localeCompare(right.document.title, "tr-TR", {
                sensitivity: "base",
                numeric: true
            });
            return titleOrder || left.position - right.position;
        });

    const matchedDocuments = scored.map(item => item.document);
    const pageItems = scored.slice(
        normalizedOptions.offset,
        normalizedOptions.offset + normalizedOptions.limit
    );
    const nextOffset = normalizedOptions.offset + pageItems.length;
    return {
        results: pageItems,
        facets: createFacetSummary(matchedDocuments, normalizedOptions.facetFields),
        page: {
            offset: normalizedOptions.offset,
            limit: normalizedOptions.limit,
            count: pageItems.length,
            total: scored.length,
            hasMore: nextOffset < scored.length,
            nextOffset: nextOffset < scored.length ? nextOffset : null
        },
        diagnostics: {
            candidateCount: candidatePositions.size,
            matchedCount: scored.length,
            queryTokenCount: tokenizeSearchText(query).length
        }
    };
};

export const createQueryCacheKey = (query, options = {}) => JSON.stringify({
    query: normalizeSearchText(query),
    options: normalizeIndexedSearchOptions(options)
});

export const createBoundedQueryCache = (options = {}) => {
    const maxEntries = normalizeInteger(options.maxEntries, {
        min: 1,
        max: 1000,
        fallback: DEFAULT_CACHE_SIZE
    });
    const ttlMs = normalizeInteger(options.ttlMs, {
        min: 1,
        max: 3600000,
        fallback: DEFAULT_CACHE_TTL_MS
    });
    const entries = new Map();

    const removeExpired = now => {
        Array.from(entries.entries()).forEach(([key, entry]) => {
            if (entry.expiresAt <= now) entries.delete(key);
        });
    };

    const touch = (key, entry) => {
        entries.delete(key);
        entries.set(key, entry);
    };

    return {
        get(key, now = Date.now()) {
            removeExpired(now);
            const entry = entries.get(key);
            if (!entry) return undefined;
            touch(key, entry);
            return entry.value;
        },
        set(key, value, customTtlMs = ttlMs, now = Date.now()) {
            removeExpired(now);
            const effectiveTtl = normalizeInteger(customTtlMs, {
                min: 1,
                max: 3600000,
                fallback: ttlMs
            });
            touch(key, { value, expiresAt: now + effectiveTtl });
            while (entries.size > maxEntries) {
                const oldest = entries.keys().next().value;
                entries.delete(oldest);
            }
            return value;
        },
        delete(key) {
            return entries.delete(key);
        },
        clear() {
            entries.clear();
        },
        has(key, now = Date.now()) {
            removeExpired(now);
            return entries.has(key);
        },
        size(now = Date.now()) {
            removeExpired(now);
            return entries.size;
        },
        keys(now = Date.now()) {
            removeExpired(now);
            return Array.from(entries.keys());
        }
    };
};

export const createCachedIndexSearcher = (index, options = {}) => {
    const cache = options.cache || createBoundedQueryCache(options.cacheOptions);
    return {
        search(query, searchOptions = {}) {
            const key = createQueryCacheKey(query, searchOptions);
            const cached = cache.get(key);
            if (cached !== undefined) return cached;
            const result = searchInvertedIndex(index, query, searchOptions);
            cache.set(key, result, searchOptions.cacheTtlMs);
            return result;
        },
        invalidate() {
            cache.clear();
        },
        cache
    };
};

export const serializeSearchIndex = index => ({
    version: 1,
    prefixLength: index.prefixLength,
    documents: index.documents.map(document => ({
        ...document,
        source: undefined
    })),
    diagnostics: index.diagnostics
});

export const hydrateSearchIndex = serialized => {
    if (!serialized || serialized.version !== 1 || !Array.isArray(serialized.documents)) {
        return createInvertedSearchIndex([]);
    }
    return createInvertedSearchIndex(serialized.documents, {
        prefixLength: serialized.prefixLength
    });
};

export const SearchIndexRuntime = {
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
    DEFAULT_PREFIX_LENGTH,
    DEFAULT_CACHE_SIZE,
    DEFAULT_CACHE_TTL_MS,
    tokenizeSearchText,
    createTokenPrefixes,
    boundedLevenshtein,
    normalizeSearchDocument,
    createInvertedSearchIndex,
    intersectPostings,
    unionPostings,
    normalizeSearchFilters,
    getFilterCandidatePositions,
    getQueryCandidatePositions,
    scoreSearchDocument,
    createFacetSummary,
    normalizeIndexedSearchOptions,
    searchInvertedIndex,
    createQueryCacheKey,
    createBoundedQueryCache,
    createCachedIndexSearcher,
    serializeSearchIndex,
    hydrateSearchIndex
};
