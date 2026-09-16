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
        level: "door",
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
        level: "door",
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
        level: "door",
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
        test("normalizes supported and unknown modes", () => {
            expect(normalizeCoordinatorMode("TEXT")).toBe("text");
            expect(normalizeCoordinatorMode("address")).toBe("address");
            expect(normalizeCoordinatorMode("unknown")).toBe("auto");
        });

        test("detects coordinate queries without misclassifying text", () => {
            expect(looksLikeCoordinateQuery("32.859 39.902")).toBe(true);
            expect(looksLikeCoordinateQuery([32.859, 39.902])).toBe(true);
            expect(looksLikeCoordinateQuery("Kuğulu Park")).toBe(false);
        });

        test("prefers explicit modes and otherwise infers nearest/address/text", () => {
            expect(inferCoordinatorMode({ mode: "text", center: [32.8, 39.9] })).toBe("text");
            expect(inferCoordinatorMode({ query: "32.859 39.902" })).toBe("nearest");
            expect(inferCoordinatorMode({ district: "Çankaya" })).toBe("address");
            expect(inferCoordinatorMode({ query: "kuğulu park" })).toBe("text");
        });

        test("normalizes query, datasets, pagination and center", () => {
            const request = normalizeCoordinatorRequest({
                query: "  KUĞULU   PARK ",
                datasets: ["places", "places", "addresses"],
                center: [32.85, 39.9],
                offset: -4,
                limit: 9999
            });
            expect(request.normalizedQuery).toBe("kugulu park");
            expect(request.datasets).toEqual(["places", "addresses"]);
            expect(request.offset).toBe(0);
            expect(request.limit).toBe(500);
            expect(request.center).toEqual({ latitude: 39.9, longitude: 32.85 });
        });
    });

    describe("revision-sensitive result cache", () => {
        test("normalizes query identity but distinguishes revision", () => {
            const normalizedA = createCoordinatorCacheKey("places", 1, { query: " KUĞULU  PARK " });
            const normalizedB = createCoordinatorCacheKey("places", 1, { query: "kuğulu park" });
            const nextRevision = createCoordinatorCacheKey("places", 2, { query: "kuğulu park" });
            expect(normalizedA).toBe(normalizedB);
            expect(nextRevision).not.toBe(normalizedA);
        });

        test("expires entries and applies LRU eviction", () => {
            const cache = createCoordinatorResultCache({ maxEntries: 2, ttlMs: 10 });
            cache.set("a", 1, 0);
            cache.set("b", 2, 0);
            cache.get("a", 1);
            cache.set("c", 3, 2);
            expect(cache.get("b", 3)).toBeUndefined();
            expect(cache.get("a", 3)).toBe(1);
            expect(cache.get("c", 11)).toBe(3);
            expect(cache.get("c", 13)).toBeUndefined();
        });

        test("invalidates only one dataset", () => {
            const cache = createCoordinatorResultCache({ ttlMs: 1000 });
            const places = createCoordinatorCacheKey("places", 1, { query: "park" });
            const addresses = createCoordinatorCacheKey("addresses", 1, { query: "park" });
            cache.set(places, 1, 0);
            cache.set(addresses, 2, 0);
            expect(cache.invalidateDataset("places")).toBe(1);
            expect(cache.get(places, 1)).toBeUndefined();
            expect(cache.get(addresses, 1)).toBe(2);
        });
    });

    describe("payload ingestion", () => {
        test("uses direct arrays without adaptation", () => {
            const normalized = normalizeCoordinatorPayload(genericRecords());
            expect(normalized.records).toHaveLength(3);
            expect(normalized.adapted).toBeNull();
        });

        test("adapts legacy service containers", () => {
            const normalized = normalizeCoordinatorPayload({ Title: "Yerler", Data: genericRecords() });
            expect(normalized.records).toHaveLength(3);
            expect(normalized.adapted.title).toBe("Yerler");
        });
    });

    describe("text search", () => {
        test("searches schema-normalized records and preserves id zero", () => {
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
            expect(response.records[0].id).toBe("0");
            expect(response.page.total).toBe(1);
        });

        test("applies generic filters", () => {
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

        test("reuses derived execution indexes", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            coordinator.searchLocal("places", { query: "park", mode: "text" });
            const afterFirst = coordinator.registry.diagnostics().derivedBuilds;
            coordinator.searchLocal("places", { query: "kütüphane", mode: "text", useCache: false });
            expect(coordinator.registry.diagnostics().derivedBuilds).toBe(afterFirst);
            expect(coordinator.registry.diagnostics().derivedHits).toBeGreaterThan(0);
        });

        test("caches identical requests and invalidates them on replacement", () => {
            const coordinator = createSearchCoordinator({ cacheOptions: { ttlMs: 1000 } });
            coordinator.register("places", genericRecords(), {}, { now: 0 });
            const first = coordinator.searchLocal("places", { query: "park", mode: "text" }, { now: 10 });
            expect(coordinator.searchLocal("places", { query: "park", mode: "text" }, { now: 20 })).toBe(first);
            coordinator.ingest("places", [{ id: 99, title: "Yeni Park", category: "Parklar" }]);
            const after = coordinator.searchLocal("places", { query: "park", mode: "text" });
            expect(after.datasetRevision).toBe(2);
            expect(after.records[0].title).toBe("Yeni Park");
        });
    });

    describe("address and nearest search", () => {
        test("searches Turkish street text at an explicit hierarchy level", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("addresses", addressRecords());
            const response = coordinator.searchLocal("addresses", {
                query: "tunalı hilmi caddesi",
                mode: "address",
                level: "door",
                street: "Tunalı Hilmi Caddesi"
            });
            expect(response.records).toHaveLength(2);
            expect(response.records.every(record => record.canonicalAddress.includes("Tunalı Hilmi"))).toBe(true);
        });

        test("applies hierarchy filters and automatic address mode", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("addresses", addressRecords());
            const response = coordinator.searchLocal("addresses", {
                query: "Hoşdere",
                district: "Çankaya",
                neighborhood: "Ayrancı"
            });
            expect(response.mode).toBe(SEARCH_COORDINATOR_MODES.Address);
            expect(response.records).toHaveLength(1);
        });

        test("finds nearest addresses and respects radius", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("addresses", addressRecords());
            const nearby = coordinator.searchLocal("addresses", {
                query: "32.860 39.909",
                radiusMeters: 1000,
                limit: 10
            });
            expect(nearby.mode).toBe("nearest");
            expect(nearby.records.length).toBeGreaterThan(0);
            expect(nearby.results[0].distanceMeters).toBeLessThan(100);

            const empty = coordinator.searchLocal("addresses", {
                center: [33.5, 40.5],
                radiusMeters: 10,
                limit: 10
            });
            expect(empty.records).toEqual([]);
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

        test("supports hot-path quality opt-out and explicit schema diagnostics", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            expect(coordinator.searchLocal("places", {
                query: "park", mode: "text", includeQuality: false
            }).quality).toBeNull();
            expect(coordinator.searchLocal("places", {
                query: "", mode: "text", includeSchemaReport: true
            }).schemaReport).toEqual(expect.objectContaining({
                schemaId: expect.any(String),
                diagnostics: expect.any(Object)
            }));
        });
    });

    describe("async loading and cancellation", () => {
        test("loads a missing dataset then searches it", async () => {
            const coordinator = createSearchCoordinator();
            coordinator.registerLoader("places", () => genericRecords());
            const response = await coordinator.search("places", { query: "kütüphane", mode: "text" });
            expect(response.records[0].title).toBe("Milli Kütüphane");
        });

        test("deduplicates concurrent loader work", async () => {
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

        test("rejects aborted and unavailable searches deterministically", async () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            await expect(coordinator.search("places", { query: "park" }, {
                signal: { aborted: true }
            })).rejects.toMatchObject({ name: "AbortError" });
            expect(() => coordinator.searchLocal("missing", { query: "park" }))
                .toThrow("Dataset is not available locally");
        });
    });

    describe("multi-dataset isolation", () => {
        test("deduplicates overlap while retaining distinct exact-token matches", async () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("one", genericRecords());
            coordinator.register("two", [
                genericRecords()[0],
                { id: 9, title: "Seğmenler Park", category: "Parklar" }
            ]);
            const response = await coordinator.searchMany(["one", "two"], {
                query: "park",
                mode: "text",
                includeQuality: false
            });
            expect(response.datasets).toEqual(["one", "two"]);
            expect(response.results).toHaveLength(2);
            expect(response.diagnostics.duplicateCount).toBeGreaterThanOrEqual(1);
        });

        test("isolates one dataset failure", async () => {
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

        test("merge helper deduplicates stable keys", () => {
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
        test("marks datasets stale, removes cache and reports nested diagnostics", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            coordinator.searchLocal("places", { query: "park", mode: "text" });
            expect(coordinator.invalidate("places")).toBe(true);
            expect(coordinator.registry.has("places")).toBe(false);
            expect(coordinator.registry.has("places", { allowStale: true })).toBe(true);
            expect(coordinator.diagnostics()).toEqual(expect.objectContaining({
                searches: 1,
                textSearches: 1,
                registry: expect.objectContaining({ datasetCount: 1 }),
                resultCache: expect.any(Object)
            }));
        });

        test("remove clears dataset and cache", () => {
            const coordinator = createSearchCoordinator();
            coordinator.register("places", genericRecords());
            coordinator.searchLocal("places", { query: "park", mode: "text" });
            expect(coordinator.remove("places")).toBe(true);
            expect(coordinator.registry.peek("places")).toBeNull();
            expect(coordinator.resultCache.diagnostics().size).toBe(0);
        });
    });
});