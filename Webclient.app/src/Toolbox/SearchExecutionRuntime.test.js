import {
    DEFAULT_FIELD_WEIGHTS,
    DEFAULT_SEARCH_LIMIT,
    MAX_FILTERS,
    MAX_QUERY_TERMS,
    MAX_SEARCH_LIMIT,
    SEARCH_FILTER_OPERATORS,
    SEARCH_SORT_MODES,
    advanceSearchPageIterator,
    buildSearchFacetSnapshot,
    buildSearchPostings,
    compareSearchHits,
    createSearchCacheKey,
    createSearchExecutionIndex,
    createSearchPageIteratorState,
    executeSearch,
    getCandidatePositions,
    matchSearchFilter,
    matchesSearchFilters,
    mergeSearchPages,
    normalizeFilterOperator,
    normalizeSearchFilter,
    normalizeSearchFilters,
    normalizeSearchRequest,
    readDocumentField,
    scoreSearchDocument,
    scoreTextField,
    throwIfSearchAborted,
    tokenizeSearchQuery
} from "./SearchExecutionRuntime";

const records = [
    { id: "1", title: "Ankara Büyükşehir Belediyesi", category: "Kamu", type: "Kurum", address: "Emniyet Mahallesi Hipodrom Caddesi", district: "Yenimahalle", neighborhood: "Emniyet", street: "Hipodrom Caddesi", latitude: 39.941, longitude: 32.808 },
    { id: "2", title: "Kuğulu Park", category: "Park", type: "Yeşil Alan", address: "Tunalı Hilmi Caddesi", district: "Çankaya", neighborhood: "Kavaklıdere", street: "Tunalı Hilmi Caddesi", latitude: 39.907, longitude: 32.861 },
    { id: "3", title: "Seğmenler Parkı", category: "Park", type: "Yeşil Alan", address: "İran Caddesi", district: "Çankaya", neighborhood: "Çankaya", street: "İran Caddesi", latitude: 39.899, longitude: 32.864 },
    { id: "4", title: "Anıtkabir", category: "Kültür", type: "Müze", address: "Akdeniz Caddesi", district: "Çankaya", neighborhood: "Mebusevleri", street: "Akdeniz Caddesi", latitude: 39.925, longitude: 32.836 },
    { id: "5", title: "Ulus Meydanı", category: "Meydan", type: "Kamusal Alan", address: "Anafartalar", district: "Altındağ", neighborhood: "Hacı Bayram", street: "Anafartalar Caddesi", latitude: 39.942, longitude: 32.854 }
];

const index = createSearchExecutionIndex(records);

describe("SearchExecutionRuntime", () => {
    describe("constants and query normalization", () => {
        test("exposes bounded search defaults", () => {
            expect(DEFAULT_SEARCH_LIMIT).toBeGreaterThan(0);
            expect(MAX_SEARCH_LIMIT).toBeGreaterThan(DEFAULT_SEARCH_LIMIT);
            expect(MAX_QUERY_TERMS).toBeGreaterThan(0);
            expect(MAX_FILTERS).toBeGreaterThan(0);
        });

        test("keeps filter operators stable", () => {
            expect(SEARCH_FILTER_OPERATORS).toEqual({ Equals: "eq", NotEquals: "neq", In: "in", Prefix: "prefix", Contains: "contains", Exists: "exists", GreaterThanOrEqual: "gte", LessThanOrEqual: "lte", Between: "between" });
        });

        test("keeps sort modes stable", () => {
            expect(SEARCH_SORT_MODES).toEqual({ Relevance: "relevance", Title: "title", SourceOrder: "source-order" });
        });

        test("uses positive field weights", () => {
            Object.values(DEFAULT_FIELD_WEIGHTS).forEach(weight => expect(weight).toBeGreaterThan(0));
            expect(DEFAULT_FIELD_WEIGHTS.title).toBeGreaterThan(DEFAULT_FIELD_WEIGHTS.type);
        });

        test("tokenizes Turkish text deterministically", () => {
            expect(tokenizeSearchQuery(" ÇİĞDEM, Parkı / Çankaya ")).toEqual(["cigdem", "parki", "cankaya"]);
        });

        test("deduplicates repeated tokens", () => {
            expect(tokenizeSearchQuery("park PARK Park")).toEqual(["park"]);
        });

        test("caps excessive terms", () => {
            const input = Array.from({ length: MAX_QUERY_TERMS + 8 }, (_value, position) => `t${position}`).join(" ");
            expect(tokenizeSearchQuery(input)).toHaveLength(MAX_QUERY_TERMS);
        });

        test("normalizes invalid filter operator to equality", () => {
            expect(normalizeFilterOperator("unknown")).toBe(SEARCH_FILTER_OPERATORS.Equals);
        });

        test("preserves supported filter operators", () => {
            Object.values(SEARCH_FILTER_OPERATORS).forEach(operator => expect(normalizeFilterOperator(operator)).toBe(operator));
        });

        test("rejects filters without fields", () => {
            expect(normalizeSearchFilter({ value: "x" })).toBeNull();
            expect(normalizeSearchFilter(null)).toBeNull();
        });

        test("requires values for non-exists operators", () => {
            expect(normalizeSearchFilter({ field: "title", operator: "eq" })).toBeNull();
        });

        test("allows value-less exists filters", () => {
            expect(normalizeSearchFilter({ field: "title", operator: "exists" })).toEqual({ field: "title", operator: "exists", values: [], caseSensitive: false });
        });

        test("caps filter list length", () => {
            const filters = Array.from({ length: MAX_FILTERS + 5 }, (_value, position) => ({ field: "id", value: String(position) }));
            expect(normalizeSearchFilters(filters)).toHaveLength(MAX_FILTERS);
        });

        test("normalizes request pagination bounds", () => {
            const request = normalizeSearchRequest({ offset: -1, limit: 10000 });
            expect(request.offset).toBe(0);
            expect(request.limit).toBe(MAX_SEARCH_LIMIT);
        });

        test("normalizes request query and facets", () => {
            const request = normalizeSearchRequest({ query: "  Kuğulu   PARK ", facetFields: ["category", "category", "district"] });
            expect(request.query).toBe("Kuğulu PARK");
            expect(request.normalizedQuery).toBe("kugulu park");
            expect(request.terms).toEqual(["kugulu", "park"]);
            expect(request.facetFields).toEqual(["category", "district"]);
        });

        test("falls back to relevance sort", () => {
            expect(normalizeSearchRequest({ sort: "random" }).sort).toBe(SEARCH_SORT_MODES.Relevance);
        });

        test("keeps explicit empty-query policy", () => {
            expect(normalizeSearchRequest({ includeUnmatchedWhenQueryEmpty: false }).includeUnmatchedWhenQueryEmpty).toBe(false);
        });
    });

    describe("field reads and filter matching", () => {
        const document = index.documents[1];

        test("reads normalized field values before top-level values", () => {
            expect(readDocumentField(document, "district")).toBe("Çankaya");
        });

        test("returns top-level document values when field bag misses", () => {
            expect(readDocumentField(document, "key")).toBe(document.key);
        });

        test("returns null for invalid field reads", () => {
            expect(readDocumentField(null, "title")).toBeNull();
            expect(readDocumentField(document, "")).toBeNull();
        });

        test("matches equality case-insensitively by default", () => {
            expect(matchSearchFilter(document, { field: "district", operator: "eq", value: "çANKAYA" })).toBe(true);
        });

        test("supports strict case-sensitive equality", () => {
            expect(matchSearchFilter(document, { field: "district", operator: "eq", value: "çankaya", caseSensitive: true })).toBe(false);
        });

        test("supports not-equals", () => {
            expect(matchSearchFilter(document, { field: "category", operator: "neq", value: "Kültür" })).toBe(true);
        });

        test("supports membership filters", () => {
            expect(matchSearchFilter(document, { field: "category", operator: "in", values: ["Meydan", "Park"] })).toBe(true);
        });

        test("supports normalized prefix filters", () => {
            expect(matchSearchFilter(document, { field: "title", operator: "prefix", value: "kug" })).toBe(true);
        });

        test("supports normalized contains filters", () => {
            expect(matchSearchFilter(document, { field: "address", operator: "contains", value: "hilmi" })).toBe(true);
        });

        test("supports exists filters", () => {
            expect(matchSearchFilter(document, { field: "title", operator: "exists" })).toBe(true);
            expect(matchSearchFilter(document, { field: "missing", operator: "exists" })).toBe(false);
        });

        test("supports numeric greater-than-or-equal filters", () => {
            const numericDocument = { fields: { population: 100 } };
            expect(matchSearchFilter(numericDocument, { field: "population", operator: "gte", value: 100 })).toBe(true);
            expect(matchSearchFilter(numericDocument, { field: "population", operator: "gte", value: 101 })).toBe(false);
        });

        test("supports numeric less-than-or-equal filters", () => {
            const numericDocument = { fields: { population: 100 } };
            expect(matchSearchFilter(numericDocument, { field: "population", operator: "lte", value: 100 })).toBe(true);
            expect(matchSearchFilter(numericDocument, { field: "population", operator: "lte", value: 99 })).toBe(false);
        });

        test("supports order-independent between bounds", () => {
            const numericDocument = { fields: { population: 100 } };
            expect(matchSearchFilter(numericDocument, { field: "population", operator: "between", values: [120, 80] })).toBe(true);
        });

        test("requires every normalized filter to match", () => {
            expect(matchesSearchFilters(document, [{ field: "district", value: "Çankaya" }, { field: "category", value: "Park" }])).toBe(true);
            expect(matchesSearchFilters(document, [{ field: "district", value: "Çankaya" }, { field: "category", value: "Meydan" }])).toBe(false);
        });

        test("ignores malformed filter entries", () => {
            expect(matchesSearchFilters(document, [null, {}, { field: "", value: "x" }])).toBe(true);
        });
    });

    describe("ranking", () => {
        test("rewards exact text more than prefix and contains", () => {
            const exact = scoreTextField("Kuğulu Park", "kugulu park", ["kugulu", "park"]);
            const prefix = scoreTextField("Kuğulu Parkı", "kugulu park", ["kugulu", "park"]);
            const contains = scoreTextField("Ankara Kuğulu Park Alanı", "kugulu park", ["kugulu", "park"]);
            expect(exact).toBeGreaterThan(prefix);
            expect(prefix).toBeGreaterThan(contains);
        });

        test("scores blank fields as zero", () => {
            expect(scoreTextField("", "park", ["park"])).toBe(0);
            expect(scoreTextField(null, "park", ["park"])).toBe(0);
        });

        test("scores a matching document above an unrelated document", () => {
            const parkScore = scoreSearchDocument(index.documents[1], { query: "Kuğulu Park" });
            const unrelatedScore = scoreSearchDocument(index.documents[0], { query: "Kuğulu Park" });
            expect(parkScore).toBeGreaterThan(unrelatedScore);
        });

        test("empty query returns neutral score when allowed", () => {
            expect(scoreSearchDocument(index.documents[0], { query: "" })).toBe(1);
        });

        test("empty query returns zero when disallowed", () => {
            expect(scoreSearchDocument(index.documents[0], { query: "", includeUnmatchedWhenQueryEmpty: false })).toBe(0);
        });

        test("honors custom field weights", () => {
            const score = scoreSearchDocument(index.documents[1], { query: "Çankaya" }, { district: 10, title: 0 });
            expect(score).toBeGreaterThan(0);
        });
    });

    describe("indexing and candidate selection", () => {
        test("normalizes records into an execution index", () => {
            expect(index.documents).toHaveLength(records.length);
            expect(index.byId.get("2")).toBe(1);
            expect(index.byKey.size).toBe(records.length);
            expect(index.diagnostics.inputCount).toBe(records.length);
        });

        test("builds token postings", () => {
            const postings = buildSearchPostings(index.documents);
            expect(postings.get("park")).toBeDefined();
            expect(postings.get("cankaya")).toBeDefined();
        });

        test("returns all positions for an empty query", () => {
            expect(getCandidatePositions(index, { query: "" })).toEqual([0, 1, 2, 3, 4]);
        });

        test("intersects postings when all terms coexist", () => {
            expect(getCandidatePositions(index, { query: "Kuğulu Park" })).toEqual([1]);
        });

        test("falls back to union when no document contains every term", () => {
            expect(getCandidatePositions(index, { query: "Kuğulu Anıtkabir" }).sort()).toEqual([1, 3]);
        });

        test("falls back to full scan when postings have no query terms", () => {
            expect(getCandidatePositions(index, { query: "zzzzzz" })).toEqual([0, 1, 2, 3, 4]);
        });

        test("tracks schema drift diagnostics", () => {
            const drifted = createSearchExecutionIndex([...records, { id: "6", title: "Yeni", unexpected_field: "value" }]);
            expect(drifted.drift.hasDrift).toBe(true);
            expect(drifted.drift.unknownFields.some(item => item.name === "unexpected_field")).toBe(true);
        });

        test("can keep invalid records when explicitly requested", () => {
            const custom = createSearchExecutionIndex([null, records[0]], undefined, { keepInvalid: true });
            expect(custom.documents).toHaveLength(1);
            expect(custom.diagnostics.nonObjectCount).toBe(1);
        });
    });

    describe("execution, sorting, facets and pagination", () => {
        test("finds parks with deterministic relevance order", () => {
            const result = executeSearch(index, { query: "park" });
            expect(result.results.map(hit => hit.document.id)).toEqual(["2", "3"]);
            expect(result.page.total).toBe(2);
            expect(result.diagnostics.matchedCount).toBe(2);
        });

        test("applies filters before scoring", () => {
            const result = executeSearch(index, { query: "park", filters: [{ field: "district", value: "Çankaya" }] });
            expect(result.results).toHaveLength(2);
            expect(result.diagnostics.filteredOutCount).toBe(0);
        });

        test("filters empty-query datasets", () => {
            const result = executeSearch(index, { query: "", filters: [{ field: "category", value: "Park" }] });
            expect(result.results.map(hit => hit.document.id)).toEqual(["2", "3"]);
            expect(result.diagnostics.filteredOutCount).toBe(3);
        });

        test("supports title sorting", () => {
            const result = executeSearch(index, { query: "", sort: SEARCH_SORT_MODES.Title, limit: 10 });
            expect(result.results.map(hit => hit.document.title)).toEqual(["Anıtkabir", "Ankara Büyükşehir Belediyesi", "Kuğulu Park", "Seğmenler Parkı", "Ulus Meydanı"]);
        });

        test("supports stable source-order sorting", () => {
            const result = executeSearch(index, { query: "", sort: SEARCH_SORT_MODES.SourceOrder });
            expect(result.results.map(hit => hit.document.id)).toEqual(["1", "2", "3", "4", "5"]);
        });

        test("paginates without repeating records", () => {
            const first = executeSearch(index, { query: "", limit: 2 });
            const second = executeSearch(index, { query: "", limit: 2, offset: first.page.nextOffset });
            expect(first.results).toHaveLength(2);
            expect(second.results).toHaveLength(2);
            expect(first.results[0].document.id).not.toBe(second.results[0].document.id);
            expect(first.page.hasMore).toBe(true);
            expect(second.page.nextOffset).toBe(4);
        });

        test("marks the terminal page", () => {
            const terminal = executeSearch(index, { query: "", limit: 3, offset: 3 });
            expect(terminal.results).toHaveLength(2);
            expect(terminal.page.hasMore).toBe(false);
            expect(terminal.page.nextOffset).toBeNull();
        });

        test("honors minimum score", () => {
            const loose = executeSearch(index, { query: "park", minScore: 1 });
            const strict = executeSearch(index, { query: "park", minScore: 10000 });
            expect(loose.results.length).toBeGreaterThan(0);
            expect(strict.results).toHaveLength(0);
            expect(strict.diagnostics.belowScoreCount).toBeGreaterThan(0);
        });

        test("builds requested facets from matched records", () => {
            const result = executeSearch(index, { query: "", facetFields: ["category", "district"] });
            expect(result.facets.category.find(item => item.key === "park").count).toBe(2);
            expect(result.facets.district.find(item => item.key === "cankaya").count).toBe(3);
        });

        test("builds standalone facet snapshots", () => {
            expect(buildSearchFacetSnapshot(index.documents, ["category"]).category[0].count).toBe(2);
        });

        test("relevance comparator prefers higher scores", () => {
            const left = { document: index.documents[0], score: 10 };
            const right = { document: index.documents[1], score: 20 };
            expect(compareSearchHits(left, right, SEARCH_SORT_MODES.Relevance)).toBeGreaterThan(0);
        });

        test("source-order comparator prefers original source position", () => {
            const left = { document: index.documents[0], score: 0 };
            const right = { document: index.documents[1], score: 1000 };
            expect(compareSearchHits(left, right, SEARCH_SORT_MODES.SourceOrder)).toBeLessThan(0);
        });
    });

    describe("cancellation and cache identity", () => {
        test("does not throw for an active signal", () => {
            expect(() => throwIfSearchAborted({ aborted: false })).not.toThrow();
        });

        test("throws AbortError for an aborted signal", () => {
            try {
                throwIfSearchAborted({ aborted: true });
                throw new Error("expected abort");
            } catch (error) {
                expect(error.name).toBe("AbortError");
                expect(error.message).toContain("aborted");
            }
        });

        test("search execution checks cancellation before scanning", () => {
            expect(() => executeSearch(index, { query: "park" }, { signal: { aborted: true } })).toThrow("Search execution aborted");
        });

        test("cache keys normalize query casing and whitespace", () => {
            expect(createSearchCacheKey({ query: " KUĞULU   PARK " })).toBe(createSearchCacheKey({ query: "kuğulu park" }));
        });

        test("cache keys distinguish pagination", () => {
            expect(createSearchCacheKey({ query: "park", offset: 0 })).not.toBe(createSearchCacheKey({ query: "park", offset: 10 }));
        });

        test("cache keys normalize filter order", () => {
            const left = createSearchCacheKey({ filters: [{ field: "district", value: "Çankaya" }, { field: "category", value: "Park" }] });
            const right = createSearchCacheKey({ filters: [{ field: "category", value: "Park" }, { field: "district", value: "Çankaya" }] });
            expect(left).toBe(right);
        });
    });

    describe("page merging and progress safety", () => {
        test("merges pages while deduplicating keys", () => {
            const first = executeSearch(index, { query: "", limit: 2 });
            const second = executeSearch(index, { query: "", limit: 2, offset: 1 });
            expect(mergeSearchPages(first, second).results.map(hit => hit.document.id)).toEqual(["1", "2", "3"]);
        });

        test("keeps terminal pagination terminal after merge", () => {
            const first = executeSearch(index, { query: "", limit: 3 });
            const second = executeSearch(index, { query: "", limit: 3, offset: 3 });
            const merged = mergeSearchPages(first, second);
            expect(merged.page.hasMore).toBe(false);
            expect(merged.page.nextOffset).toBeNull();
        });

        test("creates iterator state from normalized request", () => {
            const state = createSearchPageIteratorState({ query: "park", offset: 5, limit: 20 });
            expect(state.nextOffset).toBe(5);
            expect(state.request.normalizedQuery).toBe("park");
            expect(state.done).toBe(false);
            expect(state.pages).toBe(0);
        });

        test("advances iterator with explicit next offset", () => {
            const state = createSearchPageIteratorState({ offset: 0, limit: 2 });
            const next = advanceSearchPageIterator(state, { page: { count: 2, hasMore: true, nextOffset: 2 } });
            expect(next.nextOffset).toBe(2);
            expect(next.done).toBe(false);
            expect(next.pages).toBe(1);
            expect(next.received).toBe(2);
        });

        test("falls back to count progress for malformed next offset", () => {
            const state = createSearchPageIteratorState({ offset: 10, limit: 2 });
            const next = advanceSearchPageIterator(state, { page: { count: 2, hasMore: true, nextOffset: 10 } });
            expect(next.nextOffset).toBe(12);
            expect(next.done).toBe(false);
        });

        test("stops on empty non-progressing pages", () => {
            const state = createSearchPageIteratorState({ offset: 10, limit: 2 });
            const next = advanceSearchPageIterator(state, { page: { count: 0, hasMore: true, nextOffset: 10 } });
            expect(next.done).toBe(true);
            expect(next.nextOffset).toBe(10);
        });

        test("stops when upstream says there is no next page", () => {
            const state = createSearchPageIteratorState({ offset: 0, limit: 2 });
            const next = advanceSearchPageIterator(state, { page: { count: 1, hasMore: false, nextOffset: null } });
            expect(next.done).toBe(true);
            expect(next.received).toBe(1);
        });
    });
});
