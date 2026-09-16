import {
    SEARCH_COORDINATOR_MODES,
    createCoordinatorCacheKey,
    createCoordinatorResultCache,
    createSearchCoordinator,
    inferCoordinatorMode,
    looksLikeCoordinateQuery,
    mergeCoordinatorResponses,
    normalizeCoordinatorMode,
    normalizeCoordinatorPayload,
    normalizeCoordinatorRequest
} from "./SearchCoordinatorRuntime";

const genericRecords = () => [
    {
        id: 0,
        title: "Kuğulu Park",
        category: "Parklar",
        address: "Kavaklıdere Çankaya",
        district: "Çankaya",
        neighborhood: "Kavaklıdere",
        coordinates: { latitude: 39.902, longitude: 32.859 }
    },
    {
        id: 2,
        title: "Milli Kütüphane",
        category: "Kütüphaneler",
        address: "Bahçelievler Çankaya",
        district: "Çankaya",
        neighborhood: "Bahçelievler",
        coordinates: { latitude: 39.927, longitude: 32.829 }
    },
    {
        id: 3,
        title: "Mamak Kültür Merkezi",
        category: "Kültür Merkezleri",
        address: "Mamak Ankara",
        district: "Mamak",
        coordinates: { latitude: 39.94, longitude: 32.91 }
    }
];

const addressRecords = () => [
    {
        id: 10,
        title: "Tunalı Hilmi Caddesi 10",
        district: "Çankaya",
        neighborhood: "Kavaklıdere",
        street: "Tunalı Hilmi Caddesi",
        door: "10",
        category: "adres",
        latitude: 39.909,
        longitude: 32.86
    },
    {
        id: 11,
        title: "Tunalı Hilmi Caddesi 20",
        district: "Çankaya",
        neighborhood: "Kavaklıdere",
        street: "Tunalı Hilmi Caddesi",
        door: "20",
        category: "adres",
        latitude: 39.91,
        longitude: 32.861
    },
    {
        id: 12,
        title: "Hoşdere Caddesi 1",
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Hoşdere Caddesi",
        door: "1",
        category: "adres",
        latitude: 39.891,
        longitude: 32.852
    }
];

describe("SearchCoordinatorRuntime", () => {
    describe("request planning", () => {
        test("normalizes supported modes", () => {
            expect(normalizeCoordinatorMode("TEXT")).toBe("text");
            expect(normalizeCoordinatorMode("address")).toBe("address");
            expect(normalizeCoordinatorMode("unknown")).toBe("auto");
        });

        test("detects coordinate queries", () => {
            expect(looksLikeCoordinateQuery("32.859 39.902")).toBe(true);
            expect(looksLikeCoordinateQuery([32.859, 39.902])).toBe(true);
            expect(looksLikeCoordinateQuery("Kuğulu Park")).toBe(false);
        });

        test("prefers explicit search modes", () => {
            expect(inferCoordinatorMode({ mode: "text", center: [32.8, 39.9] })).toBe("text");
            expect(inferCoordinatorMode({ mode: "address" })).toBe("address");
        });

        test("infers nearest mode from coordinates", () => {
            expect(inferCoordinatorMode({ query: "32.859 39.902" })).toBe("nearest");
            expect(inferCoordinatorMode({ center: [32.859, 39.902] })).toBe("nearest");
        });

        test("infers address mode from address filters", () => {
            expect(inferCoordinatorMode({ district: "Çankaya" })).toBe("address");
            expect(inferCoordinatorMode({ address: true })).toBe("address");
        });

        test("defaults ordinary queries to text mode", () => {
            expect(inferCoordinatorMode({ query: "kuğulu park" })).toBe("text");
        });

        test("normalizes dataset lists and pagination", () => {
            const request = normalizeCoordinatorRequest({
                query: "  KUĞULU   PARK ",
                datasets: ["places", "places", "addresses"],
                offset: -4,
                limit: 9999
            });
            expect(request.normalizedQuery).toBe("kugulu park");
            expect(request.datasets).toEqual(["places", "addresses"]);
            expect(request.offset).toBe(0);
            expect(request.limit).toBe(500);
        });

        test("parses explicit centers", () => {
            const request = normalizeCoordinatorRequest({ center: [32.85, 39.9] });
            expect(request.center).toEqual({ latitude: 39.9, longitude: 32.85 });
            expect(request.mode).toBe("nearest");
        });
    });

    describe("result cache", () => {
        test("creates revision-sensitive cache keys", () => {
            const first = createCoordinatorCacheKey("places", 1, { query: "park" });
            const second = createCoordinatorCacheKey("places", 2, { query: "park" });
            expect(first).not.toBe(second);
        });

        test("normalizes query identity in cache keys", () => {
            const first = createCoordinatorCacheKey("places", 1, { query: " KUĞULU  PARK " });
            const second = createCoordinatorCacheKey("places", 1, { query: "kuğulu park" });
            expect(first).toBe(second);
        });

        test("expires cached results", () => {
            const cache = createCoordinatorResultCache({ ttlMs: 10 });
            cache.set("a", 1, 0);
            expect(cache.get("a", 5)).toBe(1);
            expect(cache.get("a", 11)).toBeUndefined();
            expect(cache.diagnostics(11).expirations).toBe(1);
        });

        test("uses LRU eviction", () => {
            const cache = createCoordinatorResultCache({ maxEntries: 2, ttlMs: 1000 });
            cache.set("a", 1, 0);
            cache.set("b", 2, 0);
            cache.get("a", 1);
            cache.set("c", 3, 2);
            expect(cache.get("b", 3)).toBeUndefined();
            expect(cache.get("a", 3)).toBe(1);
            expect(cache.get("c", 3)).toBe(3);
        });

        test("invalidates one dataset without clearing others", () => {
            const cache = createCoordinatorResultCache({ ttlMs: 1000 });
            const one = createCoordinatorCacheKey("places", 1, { query: "park" });
            const two = createCoordinatorCacheKey("addresses", 1, { query: "park" });
            cache.set(one, 1, 0);
            cache.set(two, 2, 0);
            expect(cache.invalidateDataset("places")).toBe(1);
            expect(cache.get(one, 1)).toBeUndefined();
            expect(cache.get(two, 1)).toBe(2);
        });
    });

    describe("payload ingestion", () => {
        test("passes direct arrays without legacy adaptation", () => {
            const normalized = normalizeCoordinatorPayload(genericRecords());
            expect(normalized.records).toHaveLength(3);
            expect(normalized.adapted).toBeNull();
        });

        test("adapts legacy service results", () => {
            const normalized = normalizeCoordinatorPayload({
                Title: "Yerler",
                Data: genericRecords()
            });
            expect(normalized.records).toHaveLength(3);
            expect(normalized.adapted.title).toBe("Yerler");
        });
    });

    describe("text search integration", () => {
        test("searches a registered dataset through schema execution runtime", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            const response = coordinator.searchLocal("places", {
                query: "kuğulu park",
                mode: "text",
                facetFields: ["category", "district"]
            });
            expect(response.mode).toBe("text");
            expect(response.records).toHaveLength(1);
            expect(response.records[0].title).toBe("Kuğulu Park");
            expect(response.dataset).toBe("places");
            expect(response.page.total).toBe(1);
        });

        test("preserves zero ids through text indexing", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            const response = coordinator.searchLocal("places", { query: "Kuğulu", mode: "text" });
            expect(response.records[0].id).toBe("0");
        });

        test("supports generic filters", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            const response = coordinator.searchLocal("places", {
                query: "",
                mode: "text",
                filters: [{ field: "district", operator: "eq", value: "Çankaya" }]
            });
            expect(response.records).toHaveLength(2);
            expect(response.records.every(record => record.district === "Çankaya")).toBe(true);
        });

        test("builds and reuses derived execution index", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            coordinator.searchLocal("places", { query: "park", mode: "text" });
            const buildsAfterFirst = coordinator.registry.diagnostics().derivedBuilds;
            coordinator.searchLocal("places", { query: "kütüphane", mode: "text", useCache: false });
            expect(coordinator.registry.diagnostics().derivedBuilds).toBe(buildsAfterFirst);
            expect(coordinator.registry.diagnostics().derivedHits).toBeGreaterThan(0);
        });

        test("uses result cache for identical requests", () => {
            const coordinator = createSearchCoordinator({ cacheOptions: { ttlMs: 1000 } });
            coordinator.register("places", genericRecords(), {}, { now: 0 });
            const first = coordinator.searchLocal("places", { query: "park", mode: "text" }, { now: 10 });
            const second = coordinator.searchLocal("places", { query: "park", mode: "text" }, { now: 20 });
            expect(second).toBe(first);
            expect(coordinator.diagnostics({ now: 20 }).cacheHits).toBe(1);
        });

        test("dataset replacement invalidates prior cached results", () => {
            const coordinator = createSearchCoordinator({ cacheOptions: { ttlMs: 1000 } });
            coordinator.register("places", genericRecords());
            const before = coordinator.searchLocal("places", { query: "park", mode: "text" });
            coordinator.ingest("places", [{ id: 99, title: "Yeni Park", category: "Parklar" }]);
            const after = coordinator.searchLocal("places", { query: "park", mode: "text" });
            expect(before.datasetRevision).toBe(1);
            expect(after.datasetRevision).toBe(2);
            expect(after.records[0].title).toBe("Yeni Park");
        });
    });

    describe("address search integration", () => {
        test("searches Turkish street names", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("addresses", addressRecords());
            const response = coordinator.searchLocal("addresses", {
                query: "tunalı hilmi caddesi",
                mode: "address"
            });
            expect(response.mode).toBe("address");
            expect(response.records).toHaveLength(2);
            expect(response.records.every(record => record.canonicalAddress.includes("Tunalı Hilmi"))).toBe(true);
        });

        test("applies district and neighborhood filters", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("addresses", addressRecords());
            const response = coordinator.searchLocal("addresses", {
                query: "",
                mode: "address",
                district: "Çankaya",
                neighborhood: "Ayrancı"
            });
            expect(response.records).toHaveLength(1);
            expect(response.records[0].fields.neighborhood).toBe("Ayrancı");
        });

        test("automatically infers address mode from district filter", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("addresses", addressRecords());
            const response = coordinator.searchLocal("addresses", {
                query: "Hoşdere",
                district: "Çankaya"
            });
            expect(response.mode).toBe(SEARCH_COORDINATOR_MODES.Address);
        });
    });

    describe("nearest search integration", () => {
        test("finds nearest addresses for coordinate queries", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("addresses", addressRecords());
            const response = coordinator.searchLocal("addresses", {
                query: "32.860 39.909",
                radiusMeters: 1000,
                limit: 10
            });
            expect(response.mode).toBe("nearest");
            expect(response.records.length).toBeGreaterThan(0);
            expect(response.results[0].distanceMeters).toBeLessThan(100);
        });

        test("returns no records outside radius", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("addresses", addressRecords());
            const response = coordinator.searchLocal("addresses", {
                center: [33.5, 40.5],
                radiusMeters: 10,
                limit: 10
            });
            expect(response.records).toEqual([]);
        });
    });

    describe("quality integration", () => {
        test("attaches quality snapshot and release gate by default", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            const response = coordinator.searchLocal("places", { query: "park", mode: "text" });
            expect(response.quality).not.toBeNull();
            expect(response.qualityGate).toEqual(expect.objectContaining({
                releasable: expect.any(Boolean),
                findings: expect.any(Array)
            }));
        });

        test("can disable quality work for hot paths", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            const response = coordinator.searchLocal("places", {
                query: "park",
                mode: "text",
                includeQuality: false
            });
            expect(response.quality).toBeNull();
            expect(response.qualityGate).toBeNull();
        });

        test("can expose schema report for diagnostics", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            const response = coordinator.searchLocal("places", {
                query: "",
                mode: "text",
                includeSchemaReport: true
            });
            expect(response.schemaReport).toEqual(expect.objectContaining({
                schemaId: expect.any(String),
                diagnostics: expect.any(Object)
            }));
        });
    });

    describe("async dataset loading", () => {
        test("loads missing datasets then searches them", async () => {
            const coordinator = createSearchCoordinator();
            coordinator.registerLoader("places", () => genericRecords());
            const response = await coordinator.search("places", { query: "kütüphane", mode: "text" });
            expect(response.records).toHaveLength(1);
            expect(response.records[0].title).toBe("Milli Kütüphane");
        });

        test("deduplicates concurrent coordinator loads through registry", async () => {
            const coordinator = createSearchCoordinator();
            let release;
            const loader = jest.fn(() => new Promise(resolve => {
                release = resolve;
            }));
            coordinator.registerLoader("places", loader);
            const first = coordinator.search("places", { query: "park", mode: "text" });
            const second = coordinator.search("places", { query: "park", mode: "text" });
            await Promise.resolve();
            expect(loader).toHaveBeenCalledTimes(1);
            release(genericRecords());
            const [left, right] = await Promise.all([first, second]);
            expect(left.records[0].title).toBe("Kuğulu Park");
            expect(right.records[0].title).toBe("Kuğulu Park");
        });

        test("rejects aborted searches", async () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            await expect(coordinator.search("places", { query: "park" }, {
                signal: { aborted: true }
            })).rejects.toMatchObject({ name: "AbortError" });
        });

        test("searchLocal reports unavailable datasets", () => {
            const coordinator = createSearchCoordinator();
            expect(() => coordinator.searchLocal("missing", { query: "park" })).toThrow("Dataset is not available locally");
        });
    });

    describe("multi-dataset search", () => {
        test("queries multiple datasets and deduplicates response records", async () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("one", genericRecords());
            coordinator.register("two", [genericRecords()[0], { id: 9, title: "Seğmenler Parkı", category: "Parklar" }]);
            const response = await coordinator.searchMany(["one", "two"], {
                query: "park",
                mode: "text",
                includeQuality: false
            });
            expect(response.datasets).toEqual(["one", "two"]);
            expect(response.results).toHaveLength(2);
            expect(response.diagnostics.duplicateCount).toBeGreaterThanOrEqual(1);
        });

        test("isolates one dataset failure from successful datasets", async () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("one", genericRecords());
            const response = await coordinator.searchMany(["one", "missing"], {
                query: "park",
                mode: "text"
            });
            expect(response.results.length).toBeGreaterThan(0);
            expect(response.errors).toHaveLength(1);
            expect(response.errors[0].dataset).toBe("missing");
        });
    });

    describe("response merging", () => {
        test("deduplicates shared record keys across coordinator responses", () => {
            const response = mergeCoordinatorResponses([
                {
                    dataset: "one",
                    results: [{ document: { key: "id:1", title: "Park" } }],
                    records: [{ key: "id:1" }]
                },
                {
                    dataset: "two",
                    results: [
                        { document: { key: "id:1", title: "Park" } },
                        { document: { key: "id:2", title: "Müze" } }
                    ],
                    records: [{ key: "id:1" }, { key: "id:2" }]
                }
            ]);
            expect(response.results).toHaveLength(2);
            expect(response.diagnostics.rawResultCount).toBe(3);
            expect(response.diagnostics.duplicateCount).toBe(1);
        });
    });

    describe("invalidation and diagnostics", () => {
        test("invalidates derived index and marks dataset stale", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            coordinator.searchLocal("places", { query: "park", mode: "text" });
            expect(coordinator.invalidate("places")).toBe(true);
            expect(coordinator.registry.has("places")).toBe(false);
            expect(coordinator.registry.has("places", { allowStale: true })).toBe(true);
        });

        test("reports coordinator, registry and cache diagnostics", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            coordinator.searchLocal("places", { query: "park", mode: "text" });
            const diagnostics = coordinator.diagnostics();
            expect(diagnostics).toEqual(expect.objectContaining({
                searches: 1,
                textSearches: 1,
                registry: expect.objectContaining({ datasetCount: 1 }),
                resultCache: expect.objectContaining({ size: 1 })
            }));
        });

        test("remove clears dataset and its result cache", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            coordinator.searchLocal("places", { query: "park", mode: "text" });
            expect(coordinator.remove("places")).toBe(true);
            expect(coordinator.registry.peek("places")).toBeNull();
            expect(coordinator.resultCache.diagnostics().size).toBe(0);
        });
    });
});