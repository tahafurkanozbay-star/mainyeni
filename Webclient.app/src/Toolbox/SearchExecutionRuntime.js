import {
    normalizeCategoryKey,
    normalizeFiniteNumber,
    normalizeInteger,
    normalizePagination,
    normalizeSearchText,
    normalizeText
} from "./DataIntegrityHelper";
import {
    GENERIC_RECORD_SCHEMA,
    buildFacetCounts,
    normalizeRecordCollection
} from "./RecordSchemaRuntime";

export const SEARCH_FILTER_OPERATORS = Object.freeze({
    Equals: "eq",
    NotEquals: "neq",
    In: "in",
    Prefix: "prefix",
    Contains: "contains",
    Exists: "exists",
    GreaterThanOrEqual: "gte",
    LessThanOrEqual: "lte",
    Between: "between"
});

export const SEARCH_SORT_MODES = Object.freeze({
    Relevance: "relevance",
    Title: "title",
    SourceOrder: "source-order"
});

export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 250;
export const MAX_QUERY_TERMS = 12;
export const MAX_FILTERS = 16;
export const DEFAULT_FIELD_WEIGHTS = Object.freeze({
    title: 8,
    address: 5,
    district: 4,
    neighborhood: 4,
    street: 4,
    category: 3,
    type: 2,
    door: 2,
    phone: 1
});

const isNil = value => value === null || value === undefined;
const asArray = value => Array.isArray(value) ? value : isNil(value) ? [] : [value];
const unique = values => Array.from(new Set(values));

export const tokenizeSearchQuery = value => unique(
    normalizeSearchText(value)
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .map(token => token.trim())
        .filter(Boolean)
).slice(0, MAX_QUERY_TERMS);

export const normalizeFilterOperator = value => {
    const normalized = normalizeSearchText(value);
    const allowed = new Set(Object.values(SEARCH_FILTER_OPERATORS));
    return allowed.has(normalized) ? normalized : SEARCH_FILTER_OPERATORS.Equals;
};

export const normalizeSearchFilter = filter => {
    if (!filter || typeof filter !== "object") return null;
    const field = normalizeText(filter.field);
    if (!field) return null;
    const operator = normalizeFilterOperator(filter.operator);
    const values = asArray(filter.values ?? filter.value)
        .filter(value => !isNil(value) && value !== "")
        .slice(0, 100);
    if (operator !== SEARCH_FILTER_OPERATORS.Exists && !values.length) return null;
    return {
        field,
        operator,
        values,
        caseSensitive: filter.caseSensitive === true
    };
};

export const normalizeSearchFilters = filters => asArray(filters)
    .map(normalizeSearchFilter)
    .filter(Boolean)
    .slice(0, MAX_FILTERS);

export const normalizeSearchRequest = request => {
    const input = request && typeof request === "object" ? request : {};
    const page = normalizePagination({
        offset: input.offset,
        limit: input.limit ?? DEFAULT_SEARCH_LIMIT
    });
    const query = normalizeText(input.query);
    return {
        query,
        normalizedQuery: normalizeSearchText(query),
        terms: tokenizeSearchQuery(query),
        filters: normalizeSearchFilters(input.filters),
        facetFields: unique(asArray(input.facetFields).map(normalizeText).filter(Boolean)).slice(0, 12),
        offset: page.offset,
        limit: Math.min(page.limit, MAX_SEARCH_LIMIT),
        minScore: Math.max(0, normalizeFiniteNumber(input.minScore, 0) || 0),
        sort: Object.values(SEARCH_SORT_MODES).includes(input.sort) ? input.sort : SEARCH_SORT_MODES.Relevance,
        includeUnmatchedWhenQueryEmpty: input.includeUnmatchedWhenQueryEmpty !== false
    };
};

export const readDocumentField = (document, field) => {
    if (!document || !field) return null;
    if (document.fields && Object.prototype.hasOwnProperty.call(document.fields, field)) {
        return document.fields[field];
    }
    return document[field];
};

const normalizeComparable = (value, caseSensitive = false) => {
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value;
    const text = normalizeText(value);
    return caseSensitive ? text : normalizeSearchText(text);
};

const valuesEqual = (left, right, caseSensitive) => normalizeComparable(left, caseSensitive)
    === normalizeComparable(right, caseSensitive);

export const matchSearchFilter = (document, filter) => {
    const normalizedFilter = normalizeSearchFilter(filter);
    if (!normalizedFilter) return true;
    const raw = readDocumentField(document, normalizedFilter.field);
    const values = normalizedFilter.values;
    switch (normalizedFilter.operator) {
        case SEARCH_FILTER_OPERATORS.Exists:
            return !isNil(raw) && raw !== "";
        case SEARCH_FILTER_OPERATORS.NotEquals:
            return !values.some(value => valuesEqual(raw, value, normalizedFilter.caseSensitive));
        case SEARCH_FILTER_OPERATORS.In:
            return values.some(value => valuesEqual(raw, value, normalizedFilter.caseSensitive));
        case SEARCH_FILTER_OPERATORS.Prefix: {
            const candidate = normalizeComparable(raw, normalizedFilter.caseSensitive);
            return typeof candidate === "string" && values.some(value => candidate.startsWith(
                normalizeComparable(value, normalizedFilter.caseSensitive)
            ));
        }
        case SEARCH_FILTER_OPERATORS.Contains: {
            const candidate = normalizeComparable(raw, normalizedFilter.caseSensitive);
            return typeof candidate === "string" && values.some(value => candidate.includes(
                normalizeComparable(value, normalizedFilter.caseSensitive)
            ));
        }
        case SEARCH_FILTER_OPERATORS.GreaterThanOrEqual: {
            const candidate = normalizeFiniteNumber(raw, null);
            const minimum = normalizeFiniteNumber(values[0], null);
            return candidate !== null && minimum !== null && candidate >= minimum;
        }
        case SEARCH_FILTER_OPERATORS.LessThanOrEqual: {
            const candidate = normalizeFiniteNumber(raw, null);
            const maximum = normalizeFiniteNumber(values[0], null);
            return candidate !== null && maximum !== null && candidate <= maximum;
        }
        case SEARCH_FILTER_OPERATORS.Between: {
            const candidate = normalizeFiniteNumber(raw, null);
            const lower = normalizeFiniteNumber(values[0], null);
            const upper = normalizeFiniteNumber(values[1], null);
            return candidate !== null && lower !== null && upper !== null
                && candidate >= Math.min(lower, upper)
                && candidate <= Math.max(lower, upper);
        }
        case SEARCH_FILTER_OPERATORS.Equals:
        default:
            return values.some(value => valuesEqual(raw, value, normalizedFilter.caseSensitive));
    }
};

export const matchesSearchFilters = (document, filters) => normalizeSearchFilters(filters)
    .every(filter => matchSearchFilter(document, filter));

export const scoreTextField = (value, normalizedQuery, terms) => {
    const candidate = normalizeSearchText(value);
    if (!candidate) return 0;
    if (!normalizedQuery) return 1;
    let score = 0;
    if (candidate === normalizedQuery) score += 120;
    else if (candidate.startsWith(normalizedQuery)) score += 80;
    else if (candidate.includes(normalizedQuery)) score += 45;

    let matchedTerms = 0;
    terms.forEach(term => {
        if (candidate === term) {
            score += 35;
            matchedTerms += 1;
        } else if (candidate.startsWith(term)) {
            score += 24;
            matchedTerms += 1;
        } else if (candidate.includes(term)) {
            score += 12;
            matchedTerms += 1;
        }
    });
    if (terms.length && matchedTerms === terms.length) score += 40;
    return score;
};

export const scoreSearchDocument = (document, request, weights = DEFAULT_FIELD_WEIGHTS) => {
    const normalizedRequest = normalizeSearchRequest(request);
    if (!normalizedRequest.normalizedQuery) return normalizedRequest.includeUnmatchedWhenQueryEmpty ? 1 : 0;
    let score = 0;
    Object.entries(weights).forEach(([field, weight]) => {
        const numericWeight = Math.max(0, normalizeFiniteNumber(weight, 0) || 0);
        if (!numericWeight) return;
        score += scoreTextField(
            readDocumentField(document, field),
            normalizedRequest.normalizedQuery,
            normalizedRequest.terms
        ) * numericWeight;
    });

    const searchText = normalizeSearchText(document?.searchText);
    if (searchText) {
        normalizedRequest.terms.forEach(term => {
            if (searchText.includes(term)) score += 10;
        });
    }

    const categoryKey = normalizeCategoryKey(readDocumentField(document, "category"));
    if (categoryKey && normalizedRequest.terms.includes(categoryKey)) score += 25;
    return score;
};

export const buildSearchPostings = documents => {
    const postings = new Map();
    (Array.isArray(documents) ? documents : []).forEach((document, position) => {
        const tokens = unique(tokenizeSearchQuery(document?.searchText));
        tokens.forEach(token => {
            if (!postings.has(token)) postings.set(token, new Set());
            postings.get(token).add(position);
        });
    });
    return postings;
};

export const createSearchExecutionIndex = (
    records,
    compiledSchema = GENERIC_RECORD_SCHEMA,
    options = {}
) => {
    const normalized = normalizeRecordCollection(records, compiledSchema, {
        dedupe: options.dedupe !== false,
        keepInvalid: options.keepInvalid === true
    });
    const documents = normalized.documents;
    const postings = buildSearchPostings(documents);
    const byKey = new Map();
    const byId = new Map();
    documents.forEach((document, position) => {
        byKey.set(document.key, position);
        if (document.id && !byId.has(document.id)) byId.set(document.id, position);
    });
    return {
        schemaId: compiledSchema.id,
        schemaVersion: compiledSchema.version,
        documents,
        postings,
        byKey,
        byId,
        diagnostics: normalized.diagnostics,
        drift: normalized.drift
    };
};

export const getCandidatePositions = (index, request) => {
    const normalizedRequest = normalizeSearchRequest(request);
    const total = index?.documents?.length || 0;
    if (!normalizedRequest.terms.length || !index?.postings) {
        return Array.from({ length: total }, (_value, position) => position);
    }

    const sets = normalizedRequest.terms
        .map(term => index.postings.get(term))
        .filter(Boolean)
        .sort((left, right) => left.size - right.size);

    if (!sets.length) return Array.from({ length: total }, (_value, position) => position);

    const primary = Array.from(sets[0]);
    const intersection = primary.filter(position => sets.every(set => set.has(position)));
    if (intersection.length) return intersection;

    const union = new Set();
    sets.forEach(set => set.forEach(position => union.add(position)));
    return Array.from(union);
};

export const buildSearchFacetSnapshot = (documents, fields) => unique(asArray(fields)
    .map(normalizeText)
    .filter(Boolean))
    .reduce((result, fieldName) => ({
        ...result,
        [fieldName]: buildFacetCounts(documents, fieldName)
    }), {});

export const compareSearchHits = (left, right, sort) => {
    if (sort === SEARCH_SORT_MODES.SourceOrder) {
        return left.document.sourceIndex - right.document.sourceIndex;
    }
    if (sort === SEARCH_SORT_MODES.Title) {
        const titleComparison = normalizeText(left.document.title).localeCompare(
            normalizeText(right.document.title),
            "tr-TR",
            { sensitivity: "base", numeric: true }
        );
        return titleComparison || left.document.sourceIndex - right.document.sourceIndex;
    }
    if (right.score !== left.score) return right.score - left.score;
    const titleComparison = normalizeText(left.document.title).localeCompare(
        normalizeText(right.document.title),
        "tr-TR",
        { sensitivity: "base", numeric: true }
    );
    if (titleComparison) return titleComparison;
    return left.document.sourceIndex - right.document.sourceIndex;
};

export const throwIfSearchAborted = signal => {
    if (!signal?.aborted) return;
    const error = new Error("Search execution aborted");
    error.name = "AbortError";
    throw error;
};

export const executeSearch = (index, request = {}, options = {}) => {
    const normalizedRequest = normalizeSearchRequest(request);
    throwIfSearchAborted(options.signal);
    const candidatePositions = getCandidatePositions(index, normalizedRequest);
    const hits = [];
    let scanned = 0;
    let filteredOut = 0;
    let belowScore = 0;

    candidatePositions.forEach(position => {
        throwIfSearchAborted(options.signal);
        const document = index?.documents?.[position];
        if (!document) return;
        scanned += 1;
        if (!matchesSearchFilters(document, normalizedRequest.filters)) {
            filteredOut += 1;
            return;
        }
        const score = scoreSearchDocument(document, normalizedRequest, options.weights);
        if (score < normalizedRequest.minScore) {
            belowScore += 1;
            return;
        }
        if (normalizedRequest.normalizedQuery && score <= 0) {
            belowScore += 1;
            return;
        }
        hits.push({ document, score, position });
    });

    hits.sort((left, right) => compareSearchHits(left, right, normalizedRequest.sort));
    const facetSource = hits.map(hit => hit.document);
    const pageHits = hits.slice(
        normalizedRequest.offset,
        normalizedRequest.offset + normalizedRequest.limit
    );
    const nextOffset = normalizedRequest.offset + pageHits.length;

    return {
        results: pageHits,
        page: {
            offset: normalizedRequest.offset,
            limit: normalizedRequest.limit,
            count: pageHits.length,
            total: hits.length,
            hasMore: nextOffset < hits.length,
            nextOffset: nextOffset < hits.length ? nextOffset : null
        },
        facets: buildSearchFacetSnapshot(facetSource, normalizedRequest.facetFields),
        diagnostics: {
            candidateCount: candidatePositions.length,
            scannedCount: scanned,
            matchedCount: hits.length,
            filteredOutCount: filteredOut,
            belowScoreCount: belowScore
        },
        request: normalizedRequest
    };
};

export const createSearchCacheKey = request => {
    const normalized = normalizeSearchRequest(request);
    const filters = normalized.filters
        .map(filter => `${filter.field}:${filter.operator}:${filter.values.map(value => normalizeText(value)).join(",")}`)
        .sort();
    return [
        normalized.normalizedQuery,
        `offset=${normalized.offset}`,
        `limit=${normalized.limit}`,
        `min=${normalized.minScore}`,
        `sort=${normalized.sort}`,
        `filters=${filters.join(";")}`,
        `facets=${normalized.facetFields.slice().sort().join(",")}`
    ].join("|");
};

export const mergeSearchPages = (previous, next) => {
    const left = Array.isArray(previous?.results) ? previous.results : [];
    const right = Array.isArray(next?.results) ? next.results : [];
    const seen = new Set();
    const results = [];
    [...left, ...right].forEach(hit => {
        const key = hit?.document?.key ?? `position:${hit?.position}`;
        if (seen.has(key)) return;
        seen.add(key);
        results.push(hit);
    });

    const nextPage = next?.page || {};
    return {
        ...next,
        results,
        page: {
            ...nextPage,
            count: results.length,
            hasMore: Boolean(nextPage.hasMore),
            nextOffset: nextPage.hasMore ? nextPage.nextOffset : null
        }
    };
};

export const createSearchPageIteratorState = (request = {}) => {
    const normalized = normalizeSearchRequest(request);
    return {
        request: normalized,
        nextOffset: normalized.offset,
        done: false,
        pages: 0,
        received: 0
    };
};

export const advanceSearchPageIterator = (state, response) => {
    const current = state || createSearchPageIteratorState();
    const count = normalizeInteger(response?.page?.count, { min: 0, fallback: 0 });
    const nextOffset = normalizeInteger(response?.page?.nextOffset, { min: 0, fallback: null });
    const hasMore = response?.page?.hasMore === true;
    const progressed = nextOffset !== null && nextOffset > current.nextOffset;
    return {
        ...current,
        nextOffset: hasMore && progressed ? nextOffset : current.nextOffset + count,
        done: !hasMore || (!progressed && count === 0),
        pages: current.pages + 1,
        received: current.received + count
    };
};

export const SearchExecutionRuntime = {
    SEARCH_FILTER_OPERATORS,
    SEARCH_SORT_MODES,
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
    MAX_QUERY_TERMS,
    MAX_FILTERS,
    DEFAULT_FIELD_WEIGHTS,
    tokenizeSearchQuery,
    normalizeFilterOperator,
    normalizeSearchFilter,
    normalizeSearchFilters,
    normalizeSearchRequest,
    readDocumentField,
    matchSearchFilter,
    matchesSearchFilters,
    scoreTextField,
    scoreSearchDocument,
    buildSearchPostings,
    createSearchExecutionIndex,
    getCandidatePositions,
    buildSearchFacetSnapshot,
    compareSearchHits,
    throwIfSearchAborted,
    executeSearch,
    createSearchCacheKey,
    mergeSearchPages,
    createSearchPageIteratorState,
    advanceSearchPageIterator
};
