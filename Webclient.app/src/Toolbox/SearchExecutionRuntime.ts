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
} as const);

export const SEARCH_SORT_MODES = Object.freeze({
    Relevance: "relevance",
    Title: "title",
    SourceOrder: "source-order"
} as const);

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
} as const);

export type SearchFilterOperator = (typeof SEARCH_FILTER_OPERATORS)[keyof typeof SEARCH_FILTER_OPERATORS];
export type SearchSortMode = (typeof SEARCH_SORT_MODES)[keyof typeof SEARCH_SORT_MODES];

type UnknownRecord = Record<string, unknown>;

export interface SearchDocument {
    [key: string]: unknown;
    key?: string;
    id?: string | number;
    sourceIndex: number;
    title?: unknown;
    searchText?: unknown;
    fields?: Record<string, unknown>;
}

export interface SearchFilterInput {
    field?: unknown;
    operator?: unknown;
    values?: unknown;
    value?: unknown;
    caseSensitive?: boolean;
}

export interface NormalizedSearchFilter {
    field: string;
    operator: SearchFilterOperator;
    values: unknown[];
    caseSensitive: boolean;
}

export interface SearchRequestInput extends UnknownRecord {
    query?: unknown;
    filters?: unknown;
    facetFields?: unknown;
    offset?: unknown;
    limit?: unknown;
    minScore?: unknown;
    sort?: unknown;
    includeUnmatchedWhenQueryEmpty?: unknown;
}

export interface NormalizedSearchRequest {
    query: string;
    normalizedQuery: string;
    terms: string[];
    filters: NormalizedSearchFilter[];
    facetFields: string[];
    offset: number;
    limit: number;
    minScore: number;
    sort: SearchSortMode;
    includeUnmatchedWhenQueryEmpty: boolean;
}

export interface SearchHit {
    document: SearchDocument;
    score: number;
    position: number;
}

export interface SearchPage {
    offset: number;
    limit: number;
    count: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
}

export interface SearchResponse {
    results: SearchHit[];
    page: SearchPage;
    facets: Record<string, unknown>;
    diagnostics: {
        candidateCount: number;
        scannedCount: number;
        matchedCount: number;
        filteredOutCount: number;
        belowScoreCount: number;
    };
    request: NormalizedSearchRequest;
}

export interface SearchExecutionIndex {
    schemaId: unknown;
    schemaVersion: unknown;
    documents: SearchDocument[];
    postings: Map<string, Set<number>>;
    byKey: Map<unknown, number>;
    byId: Map<unknown, number>;
    diagnostics: unknown;
    drift: unknown;
}

export interface SearchExecutionOptions {
    signal?: AbortSignal | null;
    weights?: Readonly<Record<string, number>>;
}

export interface SearchPageIteratorState {
    request: NormalizedSearchRequest;
    nextOffset: number;
    done: boolean;
    pages: number;
    received: number;
}

interface SearchIndexOptions {
    dedupe?: boolean;
    keepInvalid?: boolean;
}

const isRecord = (value: unknown): value is UnknownRecord =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeFiniteNumberValue = (value: unknown, fallback: number | null): number | null =>
    normalizeFiniteNumber(value as never, fallback as never) as number | null;

const normalizeIntegerValue = (
    value: unknown,
    options: Readonly<{ min?: number; max?: number; fallback: number | null }>
): number | null => normalizeInteger(value as never, options as never) as number | null;

const normalizePaginationValue = (
    value: Readonly<{ offset?: unknown; limit?: unknown }>
): Readonly<{ offset: number; limit: number }> =>
    normalizePagination(value as never) as Readonly<{ offset: number; limit: number }>;

const isNil = (value: unknown): value is null | undefined => value === null || value === undefined;
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : isNil(value) ? [] : [value];
const unique = <T>(values: readonly T[]): T[] => Array.from(new Set(values));

export const tokenizeSearchQuery = (value: unknown): string[] => unique(
    normalizeSearchText(value)
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .map(token => token.trim())
        .filter(Boolean)
).slice(0, MAX_QUERY_TERMS);

export const normalizeFilterOperator = (value: unknown): SearchFilterOperator => {
    const normalized = normalizeSearchText(value);
    const allowed = new Set<SearchFilterOperator>(Object.values(SEARCH_FILTER_OPERATORS));
    const candidate = normalized as SearchFilterOperator;
    return allowed.has(candidate) ? candidate : SEARCH_FILTER_OPERATORS.Equals;
};

export const normalizeSearchFilter = (filter: unknown): NormalizedSearchFilter | null => {
    if (!isRecord(filter)) return null;
    const input = filter as SearchFilterInput;
    const field = normalizeText(input.field);
    if (!field) return null;
    const operator = normalizeFilterOperator(input.operator);
    const values = asArray(input.values ?? input.value)
        .filter(value => !isNil(value) && value !== "")
        .slice(0, 100);
    if (operator !== SEARCH_FILTER_OPERATORS.Exists && !values.length) return null;
    return {
        field,
        operator,
        values,
        caseSensitive: input.caseSensitive === true
    };
};

export const normalizeSearchFilters = (filters: unknown): NormalizedSearchFilter[] => asArray(filters)
    .map(normalizeSearchFilter)
    .filter((filter): filter is NormalizedSearchFilter => filter !== null)
    .slice(0, MAX_FILTERS);

export const normalizeSearchRequest = (request: unknown): NormalizedSearchRequest => {
    const input: SearchRequestInput = isRecord(request) ? request : {};
    const page = normalizePaginationValue({
        offset: input.offset,
        limit: input.limit ?? DEFAULT_SEARCH_LIMIT
    });
    const query = normalizeText(input.query);
    const requestedSort = normalizeText(input.sort);
    const sort = (Object.values(SEARCH_SORT_MODES) as string[]).includes(requestedSort)
        ? requestedSort as SearchSortMode
        : SEARCH_SORT_MODES.Relevance;
    return {
        query,
        normalizedQuery: normalizeSearchText(query),
        terms: tokenizeSearchQuery(query),
        filters: normalizeSearchFilters(input.filters),
        facetFields: unique(asArray(input.facetFields).map(value => normalizeText(value)).filter(Boolean)).slice(0, 12),
        offset: page.offset,
        limit: Math.min(page.limit, MAX_SEARCH_LIMIT),
        minScore: Math.max(0, normalizeFiniteNumberValue(input.minScore, 0) ?? 0),
        sort,
        includeUnmatchedWhenQueryEmpty: input.includeUnmatchedWhenQueryEmpty !== false
    };
};

export const readDocumentField = (document: SearchDocument | null | undefined, field: string): unknown => {
    if (!document || !field) return null;
    if (document.fields && Object.prototype.hasOwnProperty.call(document.fields, field)) {
        return document.fields[field];
    }
    return document[field];
};

const normalizeComparable = (value: unknown, caseSensitive = false): string | number | boolean => {
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value;
    const text = normalizeText(value);
    return caseSensitive ? text : normalizeSearchText(text);
};

const valuesEqual = (left: unknown, right: unknown, caseSensitive: boolean): boolean => normalizeComparable(left, caseSensitive)
    === normalizeComparable(right, caseSensitive);

export const matchSearchFilter = (document: SearchDocument, filter: unknown): boolean => {
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
            return typeof candidate === "string" && values.some(value => {
                const prefix = normalizeComparable(value, normalizedFilter.caseSensitive);
                return typeof prefix === "string" && candidate.startsWith(prefix);
            });
        }
        case SEARCH_FILTER_OPERATORS.Contains: {
            const candidate = normalizeComparable(raw, normalizedFilter.caseSensitive);
            return typeof candidate === "string" && values.some(value => {
                const fragment = normalizeComparable(value, normalizedFilter.caseSensitive);
                return typeof fragment === "string" && candidate.includes(fragment);
            });
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

export const matchesSearchFilters = (document: SearchDocument, filters: unknown): boolean => normalizeSearchFilters(filters)
    .every(filter => matchSearchFilter(document, filter));

export const scoreTextField = (value: unknown, normalizedQuery: string, terms: readonly string[]): number => {
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

export const scoreSearchDocument = (
    document: SearchDocument,
    request: unknown,
    weights: Readonly<Record<string, number>> = DEFAULT_FIELD_WEIGHTS
): number => {
    const normalizedRequest = normalizeSearchRequest(request);
    if (!normalizedRequest.normalizedQuery) return normalizedRequest.includeUnmatchedWhenQueryEmpty ? 1 : 0;
    let score = 0;
    Object.entries(weights).forEach(([field, weight]) => {
        const numericWeight = Math.max(0, normalizeFiniteNumberValue(weight, 0) ?? 0);
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

export const buildSearchPostings = (documents: unknown): Map<string, Set<number>> => {
    const postings = new Map<string, Set<number>>();
    const sourceDocuments = (Array.isArray(documents) ? documents : []) as SearchDocument[];
    sourceDocuments.forEach((document, position) => {
        const tokens = unique(tokenizeSearchQuery(document?.searchText));
        tokens.forEach(token => {
            let posting = postings.get(token);
            if (!posting) {
                posting = new Set<number>();
                postings.set(token, posting);
            }
            posting.add(position);
        });
    });
    return postings;
};

export const createSearchExecutionIndex = (
    records: unknown,
    compiledSchema: typeof GENERIC_RECORD_SCHEMA = GENERIC_RECORD_SCHEMA,
    options: SearchIndexOptions = {}
): SearchExecutionIndex => {
    const normalized = normalizeRecordCollection(records, compiledSchema, {
        dedupe: options.dedupe !== false,
        keepInvalid: options.keepInvalid === true
    });
    const documents = normalized.documents as SearchDocument[];
    const postings = buildSearchPostings(documents);
    const byKey = new Map<unknown, number>();
    const byId = new Map<unknown, number>();
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

export const getCandidatePositions = (index: SearchExecutionIndex | null | undefined, request: unknown): number[] => {
    const normalizedRequest = normalizeSearchRequest(request);
    const total = index?.documents?.length || 0;
    if (!normalizedRequest.terms.length || !index?.postings) {
        return Array.from({ length: total }, (_value, position) => position);
    }

    const sets = normalizedRequest.terms
        .map(term => index.postings.get(term))
        .filter((set): set is Set<number> => Boolean(set))
        .sort((left, right) => left.size - right.size);

    if (!sets.length) return Array.from({ length: total }, (_value, position) => position);

    const primarySet = sets[0];
    if (!primarySet) return [];
    const primary = Array.from(primarySet);
    const intersection = primary.filter(position => sets.every(set => set.has(position)));
    if (intersection.length) return intersection;

    const union = new Set<number>();
    sets.forEach(set => set.forEach(position => union.add(position)));
    return Array.from(union);
};

export const buildSearchFacetSnapshot = (documents: unknown, fields: unknown): Record<string, unknown> => {
    const sourceDocuments = (Array.isArray(documents) ? documents : []) as SearchDocument[];
    return unique(asArray(fields).map(value => normalizeText(value)).filter(Boolean))
        .reduce<Record<string, unknown>>((result, fieldName) => ({
            ...result,
            [fieldName]: buildFacetCounts(sourceDocuments, fieldName)
        }), {});
};

export const compareSearchHits = (left: SearchHit, right: SearchHit, sort: SearchSortMode): number => {
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

export const throwIfSearchAborted = (signal?: AbortSignal | null): void => {
    if (!signal?.aborted) return;
    const error = new Error("Search execution aborted");
    error.name = "AbortError";
    throw error;
};

export const executeSearch = (
    index: SearchExecutionIndex,
    request: unknown = {},
    options: SearchExecutionOptions = {}
): SearchResponse => {
    const normalizedRequest = normalizeSearchRequest(request);
    throwIfSearchAborted(options.signal);
    const candidatePositions = getCandidatePositions(index, normalizedRequest);
    const hits: SearchHit[] = [];
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

export const createSearchCacheKey = (request: unknown): string => {
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

export const mergeSearchPages = (
    previous: Partial<SearchResponse> | null | undefined,
    next: Partial<SearchResponse> | null | undefined
) => {
    const left = Array.isArray(previous?.results) ? previous.results : [];
    const right = Array.isArray(next?.results) ? next.results : [];
    const seen = new Set();
    const results: SearchHit[] = [];
    [...left, ...right].forEach(hit => {
        const key = hit?.document?.key ?? `position:${hit?.position}`;
        if (seen.has(key)) return;
        seen.add(key);
        results.push(hit);
    });

    const nextPage: Partial<SearchPage> = next?.page ?? {};
    const nextResponse = next ?? {};
    return {
        ...nextResponse,
        results,
        page: {
            ...nextPage,
            count: results.length,
            hasMore: Boolean(nextPage.hasMore),
            nextOffset: nextPage.hasMore ? nextPage.nextOffset : null
        }
    };
};

export const createSearchPageIteratorState = (request: unknown = {}): SearchPageIteratorState => {
    const normalized = normalizeSearchRequest(request);
    return {
        request: normalized,
        nextOffset: normalized.offset,
        done: false,
        pages: 0,
        received: 0
    };
};

export const advanceSearchPageIterator = (
    state: SearchPageIteratorState | null | undefined,
    response: Partial<SearchResponse> | null | undefined
): SearchPageIteratorState => {
    const current = state || createSearchPageIteratorState();
    const count = normalizeIntegerValue(response?.page?.count, { min: 0, fallback: 0 }) ?? 0;
    const nextOffset = normalizeIntegerValue(response?.page?.nextOffset, { min: 0, fallback: null });
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
