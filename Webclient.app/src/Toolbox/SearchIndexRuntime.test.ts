import {
    DEFAULT_CACHE_SIZE,
    DEFAULT_CACHE_TTL_MS,
    DEFAULT_PREFIX_LENGTH,
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
    boundedLevenshtein,
    createBoundedQueryCache,
    createCachedIndexSearcher,
    createFacetSummary,
    createInvertedSearchIndex,
    createQueryCacheKey,
    createTokenPrefixes,
    getFilterCandidatePositions,
    getQueryCandidatePositions,
    hydrateSearchIndex,
    intersectPostings,
    normalizeIndexedSearchOptions,
    normalizeSearchDocument,
    normalizeSearchFilters,
    scoreSearchDocument,
    searchInvertedIndex,
    serializeSearchIndex,
    tokenizeSearchText,
    unionPostings
} from "./SearchIndexRuntime";

const documents = [
    {
        id: "park-1",
        title: "Kuğulu Park",
        category: "Parklar",
        type: "park",
        address: "Tunalı Hilmi Caddesi",
        district: "Çankaya",
        neighborhood: "Kavaklıdere",
        street: "Tunalı Hilmi Caddesi"
    },
    {
        id: "park-2",
        title: "Seğmenler Parkı",
        category: "Parklar",
        type: "park",
        address: "Çankaya Caddesi",
        district: "Çankaya",
        neighborhood: "Gaziosmanpaşa",
        street: "Çankaya Caddesi"
    },
    {
        id: "library-1",
        title: "Adnan Ötüken Kütüphanesi",
        category: "Kütüphaneler",
        type: "kütüphane",
        address: "Kızılay",
        district: "Çankaya",
        neighborhood: "Kızılay"
    },
    {
        id: "metro-1",
        title: "Kızılay Metro",
        category: "EGO",
        type: "metro hattı",
        address: "Kızılay Meydanı",
        district: "Çankaya",
        neighborhood: "Kızılay"
    },
    {
        id: "pharmacy-1",
        title: "Bahçelievler Eczanesi",
        category: "Eczaneler",
        type: "eczane",
        address: "7. Cadde",
        district: "Çankaya",
        neighborhood: "Bahçelievler"
    },
    {
        id: "market-1",
        title: "Başkent Market",
        category: "İştirakler",
        type: "başkent market",
        address: "Ulus",
        district: "Altındağ",
        neighborhood: "Hacı Bayram"
    }
];

describe("SearchIndexRuntime", () => {
    describe("constants", () => {
        test("keeps bounded search defaults", () => {
            expect(DEFAULT_SEARCH_LIMIT).toBeGreaterThan(0);
            expect(MAX_SEARCH_LIMIT).toBeGreaterThan(DEFAULT_SEARCH_LIMIT);
            expect(DEFAULT_PREFIX_LENGTH).toBeGreaterThan(0);
        });

        test("keeps bounded cache defaults", () => {
            expect(DEFAULT_CACHE_SIZE).toBeGreaterThan(0);
            expect(DEFAULT_CACHE_TTL_MS).toBeGreaterThan(0);
        });
    });

    describe("tokenization", () => {
        test("normalizes Turkish text and punctuation", () => {
            expect(tokenizeSearchText(" ÇİĞDEM, Ihlamur / Örnek ")).toEqual([
                "cigdem",
                "ihlamur",
                "ornek"
            ]);
        });

        test("removes repeated tokens deterministically", () => {
            expect(tokenizeSearchText("park park PARK")).toEqual(["park"]);
        });

        test("returns an empty list for nullish values", () => {
            expect(tokenizeSearchText(null)).toEqual([]);
            expect(tokenizeSearchText(undefined)).toEqual([]);
        });

        test("keeps numeric address and line tokens", () => {
            expect(tokenizeSearchText("413 Hat 7. Cadde")).toEqual(["413", "hat", "7", "cadde"]);
        });
    });

    describe("prefix generation", () => {
        test("generates all prefixes from the minimum length", () => {
            expect(createTokenPrefixes("ankara", 3)).toEqual([
                "ank",
                "anka",
                "ankar",
                "ankara"
            ]);
        });

        test("returns the token when it is shorter than the minimum", () => {
            expect(createTokenPrefixes("ab", 3)).toEqual(["ab"]);
        });

        test("normalizes Turkish characters before prefixing", () => {
            expect(createTokenPrefixes("Çiğdem", 3)[0]).toBe("cig");
        });

        test("returns no prefixes for empty tokens", () => {
            expect(createTokenPrefixes("", 3)).toEqual([]);
        });

        test("normalizes unsafe minimum lengths", () => {
            expect(createTokenPrefixes("abcd", 0)).toEqual(["abc", "abcd"]);
            expect(createTokenPrefixes("abcd", "bad")).toEqual(["abc", "abcd"]);
        });
    });

    describe("bounded edit distance", () => {
        test.each([
            ["park", "park", 2, 0],
            ["park", "par", 2, 1],
            ["park", "pork", 2, 1],
            ["park", "parks", 2, 1],
            ["ankara", "ankraa", 2, 2]
        ])("computes %s/%s within bound", (left, right, bound, expected) => {
            expect(boundedLevenshtein(left, right, bound)).toBe(expected);
        });

        test("returns bound plus one when length difference cannot match", () => {
            expect(boundedLevenshtein("a", "abcdef", 2)).toBe(3);
        });

        test("short-circuits rows that exceed the bound", () => {
            expect(boundedLevenshtein("park", "zzzz", 1)).toBe(2);
        });

        test("normalizes Turkish text before comparing", () => {
            expect(boundedLevenshtein("Çiğdem", "cigdem", 1)).toBe(0);
        });

        test("handles empty values", () => {
            expect(boundedLevenshtein("", "ab", 2)).toBe(2);
            expect(boundedLevenshtein("abc", "", 2)).toBe(3);
        });
    });

    describe("document normalization", () => {
        test("creates normalized keys and token lists", () => {
            const result = normalizeSearchDocument(documents[0], 0);
            expect(result).toEqual(expect.objectContaining({
                id: "park-1",
                title: "Kuğulu Park",
                category: "Parklar",
                categoryKey: "parklar",
                type: "park",
                typeKey: "park",
                district: "Çankaya",
                districtKey: "cankaya",
                neighborhood: "Kavaklıdere",
                neighborhoodKey: "kavaklidere",
                street: "Tunalı Hilmi Caddesi",
                streetKey: "tunali-hilmi-caddesi",
                sourceIndex: 0
            }));
            expect(result.tokens).toEqual(expect.arrayContaining([
                "kugulu",
                "park",
                "tunali",
                "hilmi",
                "caddesi",
                "cankaya",
                "kavaklidere"
            ]));
        });

        test("uses explicit search text in the normalized haystack", () => {
            const result = normalizeSearchDocument({
                id: "x",
                title: "A",
                searchText: "özel anahtar"
            });
            expect(result.tokens).toEqual(expect.arrayContaining(["ozel", "anahtar"]));
        });

        test("creates deterministic fallback ids", () => {
            expect(normalizeSearchDocument({}, 3).id).toBe("document-3");
        });

        test("preserves an explicit numeric source index", () => {
            expect(normalizeSearchDocument({ sourceIndex: 99 }, 3).sourceIndex).toBe(99);
        });
    });

    describe("index construction", () => {
        test("creates every posting family", () => {
            const index = createInvertedSearchIndex(documents);
            expect(index.documents).toHaveLength(documents.length);
            expect(index.byId.get("park-1")).toBe(0);
            expect(index.tokenPostings.get("park")).toEqual(new Set([0, 1]));
            expect(index.prefixPostings.get("par")).toEqual(new Set([0, 1]));
            expect(index.categoryPostings.get("parklar")).toEqual(new Set([0, 1]));
            expect(index.typePostings.get("park")).toEqual(new Set([0, 1]));
            expect(index.districtPostings.get("cankaya")?.size).toBe(5);
            expect(index.neighborhoodPostings.get("kizilay")).toEqual(new Set([2, 3]));
        });

        test("records deterministic diagnostics", () => {
            const index = createInvertedSearchIndex(documents);
            expect(index.diagnostics).toEqual(expect.objectContaining({
                inputCount: documents.length,
                indexedCount: documents.length,
                uniqueIdCount: documents.length,
                duplicateIds: [],
                categoryCount: 5,
                districtCount: 2
            }));
            expect(index.diagnostics.tokenCount).toBeGreaterThan(10);
            expect(index.diagnostics.prefixCount).toBeGreaterThan(index.diagnostics.tokenCount);
        });

        test("reports duplicate ids without dropping documents", () => {
            const index = createInvertedSearchIndex([
                { id: "x", title: "A" },
                { id: "x", title: "B" }
            ]);
            expect(index.documents).toHaveLength(2);
            expect(index.byId.size).toBe(1);
            expect(index.diagnostics.duplicateIds).toEqual(["x"]);
        });

        test("supports custom prefix length", () => {
            const index = createInvertedSearchIndex([{ id: "x", title: "Ankara" }], { prefixLength: 2 });
            expect(index.prefixLength).toBe(2);
            expect(index.prefixPostings.get("an")).toEqual(new Set([0]));
        });

        test("normalizes invalid document collections", () => {
            expect(createInvertedSearchIndex(null).documents).toEqual([]);
        });
    });

    describe("posting operations", () => {
        test("intersects posting sets from the smallest set", () => {
            expect(intersectPostings([
                new Set([1, 2, 3, 4]),
                new Set([2, 3]),
                new Set([3, 5])
            ])).toEqual(new Set([3]));
        });

        test("returns null when there are no posting sets", () => {
            expect(intersectPostings([])).toBeNull();
            expect(intersectPostings([null])).toBeNull();
        });

        test("unions posting sets", () => {
            expect(unionPostings([
                new Set([1, 2]),
                new Set([2, 3]),
                null
            ])).toEqual(new Set([1, 2, 3]));
        });
    });

    describe("filter normalization", () => {
        test("normalizes and deduplicates every filter family", () => {
            expect(normalizeSearchFilters({
                categories: ["Parklar", "PARKLAR"],
                types: ["Kütüphane"],
                districts: ["Çankaya", "CANKAYA"],
                neighborhoods: ["Kızılay"],
                streets: ["Tunalı Hilmi"],
                ids: [1, "1", " park-1 "]
            })).toEqual({
                categories: ["parklar"],
                types: ["kutuphane"],
                districts: ["cankaya"],
                neighborhoods: ["kizilay"],
                streets: ["tunali-hilmi"],
                ids: ["1", "park-1"]
            });
        });

        test("returns stable empty filters", () => {
            expect(normalizeSearchFilters()).toEqual({
                categories: [],
                types: [],
                districts: [],
                neighborhoods: [],
                streets: [],
                ids: []
            });
        });
    });

    describe("candidate selection", () => {
        const index = createInvertedSearchIndex(documents);

        test("finds exact query token postings", () => {
            expect(getQueryCandidatePositions(index, "park")).toEqual(new Set([0, 1]));
        });

        test("finds prefix query postings", () => {
            expect(getQueryCandidatePositions(index, "kug")).toEqual(new Set([0]));
        });

        test("intersects multiple query token postings", () => {
            expect(getQueryCandidatePositions(index, "kizilay metro")).toEqual(new Set([3]));
        });

        test("returns null for empty queries", () => {
            expect(getQueryCandidatePositions(index, "")).toBeNull();
        });

        test("combines category and district filters", () => {
            expect(getFilterCandidatePositions(index, {
                categories: ["Parklar"],
                districts: ["Çankaya"]
            })).toEqual(new Set([0, 1]));
        });

        test("combines id filters with semantic filters", () => {
            expect(getFilterCandidatePositions(index, {
                categories: ["Parklar"],
                ids: ["park-2", "library-1"]
            })).toEqual(new Set([1]));
        });

        test("returns null when no filters are active", () => {
            expect(getFilterCandidatePositions(index, {})).toBeNull();
        });
    });

    describe("scoring", () => {
        const index = createInvertedSearchIndex(documents);
        const park = index.documents[0];

        test("rewards exact title matches", () => {
            expect(scoreSearchDocument(park, "Kuğulu Park")).toBeGreaterThan(
                scoreSearchDocument(park, "Kuğulu")
            );
        });

        test("rewards prefix matches over substring matches", () => {
            expect(scoreSearchDocument(park, "kuğ")).toBeGreaterThan(
                scoreSearchDocument(park, "gulu")
            );
        });

        test("supports bounded fuzzy matching", () => {
            expect(scoreSearchDocument(park, "kuglu", { fuzzyDistance: 1 })).toBeGreaterThan(0);
        });

        test("can disable fuzzy matching", () => {
            expect(scoreSearchDocument(park, "zzzz", { fuzzyDistance: 0 })).toBe(0);
        });

        test("empty queries receive a neutral score", () => {
            expect(scoreSearchDocument(park, "")).toBe(1);
        });
    });

    describe("facet summaries", () => {
        const index = createInvertedSearchIndex(documents);

        test("counts categories, types and districts", () => {
            const facets = createFacetSummary(index.documents);
            expect(facets.category[0]).toEqual({ key: "parklar", label: "Parklar", count: 2 });
            expect(facets.district[0]).toEqual({ key: "cankaya", label: "Çankaya", count: 5 });
            expect(facets.type).toEqual(expect.arrayContaining([
                { key: "park", label: "park", count: 2 }
            ]));
        });

        test("supports custom facet fields", () => {
            const facets = createFacetSummary(index.documents, ["neighborhood"]);
            expect(Object.keys(facets)).toEqual(["neighborhood"]);
            expect(facets.neighborhood).toEqual(expect.arrayContaining([
                { key: "kizilay", label: "Kızılay", count: 2 }
            ]));
        });

        test("skips blank facet values", () => {
            expect(createFacetSummary([normalizeSearchDocument({ category: "" }, 0)]).category).toEqual([]);
        });
    });

    describe("search option normalization", () => {
        test("normalizes paging, score and fuzzy bounds", () => {
            expect(normalizeIndexedSearchOptions({
                offset: "5",
                limit: "20",
                fuzzyDistance: "2",
                minScore: "10",
                filters: { categories: ["Parklar"] },
                facetFields: ["category"]
            })).toEqual({
                offset: 5,
                limit: 20,
                fuzzyDistance: 2,
                minScore: 10,
                filters: {
                    categories: ["parklar"],
                    types: [],
                    districts: [],
                    neighborhoods: [],
                    streets: [],
                    ids: []
                },
                facetFields: ["category"]
            });
        });

        test("caps excessive page sizes", () => {
            expect(normalizeIndexedSearchOptions({ limit: 999999 }).limit).toBe(MAX_SEARCH_LIMIT);
        });

        test("uses defaults for invalid values", () => {
            expect(normalizeIndexedSearchOptions({
                offset: -10,
                limit: 0,
                fuzzyDistance: 99,
                minScore: -10
            })).toEqual(expect.objectContaining({
                offset: 0,
                limit: DEFAULT_SEARCH_LIMIT,
                fuzzyDistance: 3,
                minScore: 0
            }));
        });
    });

    describe("indexed search", () => {
        const index = createInvertedSearchIndex(documents);

        test("finds diacritic-insensitive title matches", () => {
            const result = searchInvertedIndex(index, "kugulu");
            expect(result.results[0].document.id).toBe("park-1");
        });

        test("finds prefix matches without scanning caller-side arrays", () => {
            const result = searchInvertedIndex(index, "kut");
            expect(result.results[0].document.id).toBe("library-1");
            expect(result.diagnostics.candidateCount).toBe(1);
        });

        test("finds multi-token matches", () => {
            const result = searchInvertedIndex(index, "kizilay metro");
            expect(result.results.map(item => item.document.id)).toEqual(["metro-1"]);
        });

        test("falls back to fuzzy scoring when exact postings are absent", () => {
            const result = searchInvertedIndex(index, "kuglu", { fuzzyDistance: 1 });
            expect(result.results.some(item => item.document.id === "park-1")).toBe(true);
        });

        test("filters by category", () => {
            const result = searchInvertedIndex(index, "", {
                minScore: 0,
                filters: { categories: ["Parklar"] }
            });
            expect(result.results.map(item => item.document.id)).toEqual(["park-1", "park-2"]);
        });

        test("filters by type and district", () => {
            const result = searchInvertedIndex(index, "", {
                minScore: 0,
                filters: {
                    types: ["park"],
                    districts: ["Çankaya"]
                }
            });
            expect(result.results.map(item => item.document.id)).toEqual(["park-1", "park-2"]);
        });

        test("filters by ids", () => {
            const result = searchInvertedIndex(index, "", {
                minScore: 0,
                filters: { ids: ["metro-1", "market-1"] }
            });
            expect(result.results.map(item => item.document.id)).toEqual(["market-1", "metro-1"]);
        });

        test("produces facets from the full matched set", () => {
            const result = searchInvertedIndex(index, "kizilay", { limit: 1 });
            expect(result.page.count).toBe(1);
            expect(result.page.total).toBe(2);
            expect(result.facets.category).toHaveLength(2);
        });

        test("paginates with progress-safe offsets", () => {
            const first = searchInvertedIndex(index, "", { minScore: 0, limit: 2 });
            const second = searchInvertedIndex(index, "", {
                minScore: 0,
                limit: 2,
                offset: first.page.nextOffset
            });
            expect(first.page).toEqual({
                offset: 0,
                limit: 2,
                count: 2,
                total: documents.length,
                hasMore: true,
                nextOffset: 2
            });
            expect(second.page.offset).toBe(2);
            expect(second.results[0].document.id).not.toBe(first.results[0].document.id);
        });

        test("returns null nextOffset on the last page", () => {
            const result = searchInvertedIndex(index, "", { minScore: 0, limit: 100 });
            expect(result.page.hasMore).toBe(false);
            expect(result.page.nextOffset).toBeNull();
        });

        test("returns stable diagnostics", () => {
            const result = searchInvertedIndex(index, "park");
            expect(result.diagnostics).toEqual({
                candidateCount: 2,
                matchedCount: 2,
                queryTokenCount: 1
            });
        });
    });

    describe("query cache keys", () => {
        test("normalizes equivalent Turkish query values", () => {
            expect(createQueryCacheKey(" ÇİĞDEM ", {})).toBe(createQueryCacheKey("cigdem", {}));
        });

        test("includes filters and paging", () => {
            expect(createQueryCacheKey("park", { limit: 10, filters: { categories: ["Park"] } }))
                .not.toBe(createQueryCacheKey("park", { limit: 20, filters: { categories: ["Park"] } }));
        });
    });

    describe("bounded query cache", () => {
        test("stores and retrieves values", () => {
            const cache = createBoundedQueryCache({ maxEntries: 2, ttlMs: 1000 });
            cache.set("a", 1, 1000, 0);
            expect(cache.get("a", 10)).toBe(1);
            expect(cache.has("a", 10)).toBe(true);
            expect(cache.size(10)).toBe(1);
        });

        test("expires stale values", () => {
            const cache = createBoundedQueryCache({ maxEntries: 2, ttlMs: 100 });
            cache.set("a", 1, 100, 0);
            expect(cache.get("a", 99)).toBe(1);
            expect(cache.get("a", 100)).toBeUndefined();
            expect(cache.size(100)).toBe(0);
        });

        test("evicts least recently used entries", () => {
            const cache = createBoundedQueryCache({ maxEntries: 2, ttlMs: 1000 });
            cache.set("a", 1, 1000, 0);
            cache.set("b", 2, 1000, 0);
            cache.get("a", 1);
            cache.set("c", 3, 1000, 1);
            expect(cache.has("a", 1)).toBe(true);
            expect(cache.has("b", 1)).toBe(false);
            expect(cache.has("c", 1)).toBe(true);
        });

        test("deletes and clears entries", () => {
            const cache = createBoundedQueryCache({ maxEntries: 3, ttlMs: 1000 });
            cache.set("a", 1, 1000, 0);
            cache.set("b", 2, 1000, 0);
            expect(cache.delete("a")).toBe(true);
            expect(cache.keys(1)).toEqual(["b"]);
            cache.clear();
            expect(cache.size(1)).toBe(0);
        });
    });

    describe("cached searcher", () => {
        test("returns the same cached result object for identical searches", () => {
            const index = createInvertedSearchIndex(documents);
            const searcher = createCachedIndexSearcher(index, {
                cacheOptions: { maxEntries: 10, ttlMs: 10000 }
            });
            const first = searcher.search("park", { limit: 5 });
            const second = searcher.search("PARK", { limit: 5 });
            expect(second).toBe(first);
            expect(searcher.cache.size()).toBe(1);
        });

        test("does not collide different filters", () => {
            const index = createInvertedSearchIndex(documents);
            const searcher = createCachedIndexSearcher(index);
            const parks = searcher.search("", {
                minScore: 0,
                filters: { categories: ["Parklar"] }
            });
            const libraries = searcher.search("", {
                minScore: 0,
                filters: { categories: ["Kütüphaneler"] }
            });
            expect(parks.results).toHaveLength(2);
            expect(libraries.results).toHaveLength(1);
            expect(searcher.cache.size()).toBe(2);
        });

        test("invalidates cached queries", () => {
            const index = createInvertedSearchIndex(documents);
            const searcher = createCachedIndexSearcher(index);
            searcher.search("park");
            expect(searcher.cache.size()).toBe(1);
            searcher.invalidate();
            expect(searcher.cache.size()).toBe(0);
        });
    });

    describe("serialization", () => {
        test("serializes the portable index state without source references", () => {
            const index = createInvertedSearchIndex(documents);
            const serialized = serializeSearchIndex(index);
            expect(serialized.version).toBe(1);
            expect(serialized.prefixLength).toBe(DEFAULT_PREFIX_LENGTH);
            expect(serialized.documents).toHaveLength(documents.length);
            expect(serialized.documents[0].source).toBeUndefined();
        });

        test("hydrates a functionally equivalent search index", () => {
            const original = createInvertedSearchIndex(documents);
            const hydrated = hydrateSearchIndex(serializeSearchIndex(original));
            expect(searchInvertedIndex(hydrated, "kizilay").results.map(item => item.document.id))
                .toEqual(searchInvertedIndex(original, "kizilay").results.map(item => item.document.id));
        });

        test("rejects unsupported serialized shapes safely", () => {
            expect(hydrateSearchIndex(null).documents).toEqual([]);
            expect(hydrateSearchIndex({ version: 2, documents })).toEqual(expect.objectContaining({
                documents: []
            }));
            expect(hydrateSearchIndex({ version: 1, documents: null })).toEqual(expect.objectContaining({
                documents: []
            }));
        });
    });
});
