import {
    ADDRESS_SEARCH_V2_VERSION,
    AddressSearchV2Error,
    createAddressSearchV2Diagnostics,
    createAddressSearchV2Index,
    createAddressSearchV2Plan,
    createAddressSearchV2QualityReport,
    createAddressSemanticDuplicateReport,
    createAddressSemanticFingerprint,
    createSpatialCandidatePositions,
    findNearestAddressesV2,
    getAddressSemanticDuplicates,
    intersectCandidatePositions,
    matchesAddressHierarchyV2,
    normalizeAddressV2Options,
    scoreAddressCandidateV2,
    searchAddressV2Index,
    throwIfAddressSearchAborted,
    validateAddressSearchV2Index
} from "./AddressSearchV2Runtime";
import {
    ADDRESS_V2_DERIVED_KEY,
    NEXT_GENERATION_SEARCH_VERSION,
    buildAddressV2IndexForDataset,
    createAddressV2CacheKey,
    createAddressV2Response,
    createNextGenerationSearchCoordinator,
    isAddressV2Mode
} from "./NextGenerationSearchCoordinatorRuntime";
import {
    SEARCH_COORDINATOR_MODES,
    createSearchCoordinator as createBaseSearchCoordinator
} from "./SearchCoordinatorRuntime";

const fixtures = [
    { id: "district-cankaya", level: "district", title: "Çankaya", district: "Çankaya" },
    { id: "district-mamak", level: "district", title: "Mamak", district: "Mamak" },
    {
        id: "neighborhood-ayranci",
        level: "neighborhood",
        title: "Ayrancı",
        district: "Çankaya",
        neighborhood: "Ayrancı"
    },
    {
        id: "neighborhood-kavaklidere",
        level: "neighborhood",
        title: "Kavaklıdere",
        district: "Çankaya",
        neighborhood: "Kavaklıdere"
    },
    {
        id: "street-hosdere",
        level: "street",
        title: "Hoşdere Caddesi",
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Hoşdere Caddesi",
        latitude: 39.8948,
        longitude: 32.8473
    },
    {
        id: "street-tunali",
        level: "street",
        title: "Tunalı Hilmi Caddesi",
        district: "Çankaya",
        neighborhood: "Kavaklıdere",
        street: "Tunalı Hilmi Caddesi",
        latitude: 39.909,
        longitude: 32.861
    },
    {
        id: "street-gunes",
        level: "street",
        title: "Güneş Sokak",
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Güneş Sokak",
        latitude: 39.8958,
        longitude: 32.848
    },
    {
        id: "door-hosdere-10",
        level: "door",
        title: "Hoşdere 10",
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Hoşdere Caddesi",
        door: "10",
        latitude: 39.895,
        longitude: 32.847
    },
    {
        id: "door-hosdere-12a",
        level: "door",
        title: "Hoşdere 12/A",
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Hoşdere Caddesi",
        door: "12 / A",
        latitude: 39.8953,
        longitude: 32.8472
    },
    {
        id: "door-hosdere-100",
        level: "door",
        title: "Hoşdere 100",
        district: "Çankaya",
        neighborhood: "Ayrancı",
        street: "Hoşdere Caddesi",
        door: "100",
        latitude: 39.8954,
        longitude: 32.8474
    },
    {
        id: "door-tunali-50",
        level: "door",
        title: "Tunalı Hilmi 50",
        district: "Çankaya",
        neighborhood: "Kavaklıdere",
        street: "Tunalı Hilmi Caddesi",
        door: "50",
        latitude: 39.9085,
        longitude: 32.8607
    }
];

const index = createAddressSearchV2Index(fixtures);

describe("AddressSearchV2Runtime", () => {
    test("publishes a next-generation search version", () => {
        expect(ADDRESS_SEARCH_V2_VERSION).toBe("2.0.0");
        expect(index.version).toBe(ADDRESS_SEARCH_V2_VERSION);
    });

    test("normalizes paging, spatial and candidate limits safely", () => {
        expect(normalizeAddressV2Options({ offset: -4, limit: 0, radiusMeters: -5, minScore: -2 }))
            .toEqual(expect.objectContaining({
                offset: 0,
                limit: 25,
                radiusMeters: 0,
                minScore: 0,
                maxCandidates: 5000
            }));
        expect(normalizeAddressV2Options({ limit: 99999 }).limit).toBe(500);
        expect(normalizeAddressV2Options({ maxCandidates: 999999 }).maxCandidates).toBe(50000);
    });

    test("builds base, semantic and spatial indexes together", () => {
        expect(index.documents).toHaveLength(fixtures.length);
        expect(index.baseIndex.byToken.get("hosdere").size).toBeGreaterThan(0);
        expect(index.spatialIndex.coordinatesByPosition.size).toBe(7);
        expect(index.bySemanticFingerprint.size).toBeGreaterThan(0);
        expect(validateAddressSearchV2Index(index)).toEqual([]);
    });

    test("creates canonical semantic fingerprints independent of road suffix aliases", () => {
        const left = createAddressSemanticFingerprint({
            level: "street",
            district: "Çankaya",
            neighborhood: "Ayrancı",
            street: "Hoşdere Cd."
        });
        const right = createAddressSemanticFingerprint({
            level: "street",
            district: "CANKAYA",
            neighborhood: "AYRANCI",
            street: "Hosdere Caddesi"
        });
        expect(left).toBe(right);
    });

    test("reports semantic duplicate groups without silently deleting records", () => {
        const duplicateReport = createAddressSemanticDuplicateReport([
            { level: "street", district: "Çankaya", neighborhood: "Ayrancı", street: "Hoşdere Cd." },
            { level: "street", district: "Çankaya", neighborhood: "Ayrancı", street: "Hoşdere Caddesi" },
            { level: "street", district: "Çankaya", neighborhood: "Ayrancı", street: "Güneş Sokak" }
        ]);
        expect(duplicateReport.duplicateCount).toBe(1);
        expect(duplicateReport.duplicateGroupCount).toBe(1);
        expect(duplicateReport.groups[0].positions).toEqual([0, 1]);
    });

    test("matches hierarchy filters through canonical aliases", () => {
        const document = index.baseIndex.byId.get("street-hosdere");
        expect(matchesAddressHierarchyV2(document, {
            district: "CANKAYA",
            neighborhood: "Ayrancı Mahallesi".replace(" Mahallesi", ""),
            street: "Hoşdere Cd."
        })).toBe(true);
        expect(matchesAddressHierarchyV2(document, { street: "Güneş Sk." })).toBe(false);
    });

    test("intersects candidate positions in linear time over the smaller set", () => {
        expect(Array.from(intersectCandidatePositions(new Set([1, 2, 3]), new Set([2, 3, 4])))).toEqual([2, 3]);
        expect(Array.from(intersectCandidatePositions(new Set(), new Set([1])))).toEqual([]);
    });

    test("creates indexed plan for a strong street query", () => {
        const planned = createAddressSearchV2Plan(index, "Hoşdere Cd.", { district: "Çankaya" });
        expect(planned.analysis.inferredLevel).toBe("street");
        expect(planned.plan.candidateCount).toBe(1);
        expect(planned.plan.strategy).toMatch(/index/);
    });

    test("creates door-level plan for road name plus exact number", () => {
        const planned = createAddressSearchV2Plan(index, "Hoşdere Cd. 10");
        expect(planned.analysis.inferredLevel).toBe("door");
        expect(planned.plan.positions.map(position => index.documents[position].id)).toEqual([
            "door-hosdere-10"
        ]);
    });

    test("intersects text candidates with spatial candidates", () => {
        const spatial = createSpatialCandidatePositions(index, normalizeAddressV2Options({
            center: [32.847, 39.895],
            radiusMeters: 200,
            maxCandidates: 100
        }));
        expect(spatial.positions.size).toBeGreaterThan(0);
        expect(Array.from(spatial.positions).map(position => index.documents[position].id))
            .toEqual(expect.arrayContaining(["street-hosdere", "door-hosdere-10"]));
    });

    test("ranks canonical road aliases as equivalent", () => {
        const long = searchAddressV2Index(index, "Hoşdere Caddesi");
        const short = searchAddressV2Index(index, "Hosdere Cd.");
        expect(long.results[0].document.id).toBe("street-hosdere");
        expect(short.results[0].document.id).toBe("street-hosdere");
    });

    test("rejects structural false positives for unknown strong street names", () => {
        const result = searchAddressV2Index(index, "Bilinmeyen Cadde");
        expect(result.results).toEqual([]);
        expect(result.page.total).toBe(0);
        expect(result.diagnostics.planner.strategy).toBe("empty-index-result");
    });

    test("preserves useful weak-only road-type discovery", () => {
        const result = searchAddressV2Index(index, "cadde", {
            district: "Çankaya",
            limit: 20
        });
        expect(result.results.map(item => item.document.id)).toEqual(expect.arrayContaining([
            "street-hosdere", "street-tunali"
        ]));
        expect(result.results.map(item => item.document.id)).not.toContain("street-gunes");
    });

    test("requires exact door-number evidence", () => {
        const result = searchAddressV2Index(index, "Hoşdere Cd. 10", { limit: 20 });
        expect(result.results.map(item => item.document.id)).toEqual(["door-hosdere-10"]);
        expect(result.results.map(item => item.document.id)).not.toContain("door-hosdere-100");
    });

    test("keeps explicit hierarchy level authoritative", () => {
        const result = searchAddressV2Index(index, "Hoşdere", { level: "door" });
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results.every(item => item.document.level === "door")).toBe(true);
    });

    test("supports canonical street filters across suffix abbreviations", () => {
        const result = searchAddressV2Index(index, "Hoşdere", {
            street: "Hoşdere Cd.",
            level: "door"
        });
        expect(result.results.map(item => item.document.id)).toEqual(expect.arrayContaining([
            "door-hosdere-10", "door-hosdere-12a", "door-hosdere-100"
        ]));
    });

    test("applies exact radius after indexed spatial candidate planning", () => {
        const result = searchAddressV2Index(index, "Hoşdere", {
            center: [32.847, 39.895],
            radiusMeters: 150,
            limit: 20
        });
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results.every(item => item.distanceMeters === null || item.distanceMeters <= 150)).toBe(true);
        expect(result.results.map(item => item.document.id)).not.toContain("street-tunali");
    });

    test("keeps result evidence optional to reduce response payload", () => {
        const compact = searchAddressV2Index(index, "Hoşdere", { includeEvidence: false });
        const diagnostic = searchAddressV2Index(index, "Hoşdere", { includeEvidence: true });
        expect(compact.results[0].matched).toBeUndefined();
        expect(diagnostic.results[0].matched).toBeDefined();
    });

    test("paginates deterministically and always advances nextOffset", () => {
        const first = searchAddressV2Index(index, "Hoşdere", { level: "door", limit: 1 });
        const second = searchAddressV2Index(index, "Hoşdere", {
            level: "door",
            limit: 1,
            offset: first.page.nextOffset
        });
        expect(first.page).toEqual(expect.objectContaining({
            offset: 0,
            count: 1,
            hasMore: true,
            nextOffset: 1
        }));
        expect(second.page.offset).toBe(1);
        expect(second.results[0].document.id).not.toBe(first.results[0].document.id);
    });

    test("finds nearest addresses using spatial index rather than global sort", () => {
        const nearest = findNearestAddressesV2(index, [32.847, 39.895], {
            radiusMeters: 3000,
            limit: 3
        });
        expect(nearest.results).toHaveLength(3);
        expect(nearest.results[1].distanceMeters).toBeGreaterThanOrEqual(nearest.results[0].distanceMeters);
        expect(nearest.diagnostics.strategy).toBe("grid-radius");
    });

    test("supports nearest hierarchy filters", () => {
        const nearest = findNearestAddressesV2(index, [32.847, 39.895], {
            radiusMeters: 3000,
            level: "door",
            limit: 10
        });
        expect(nearest.results.length).toBeGreaterThan(0);
        expect(nearest.results.every(item => item.document.level === "door")).toBe(true);
    });

    test("returns a quality report covering hierarchy, spatial coverage and semantic duplicates", () => {
        const report = createAddressSearchV2QualityReport(index);
        expect(report).toEqual(expect.objectContaining({
            version: ADDRESS_SEARCH_V2_VERSION,
            total: fixtures.length,
            geocodedCount: 7,
            hierarchyIssueCount: 0,
            semanticDuplicateCount: 0,
            spatialIssueCount: 0
        }));
        expect(report.spatialCoverageRatio).toBeCloseTo(7 / fixtures.length, 8);
    });

    test("returns semantic duplicate records by fingerprint", () => {
        const source = [
            ...fixtures,
            {
                id: "street-hosdere-alias",
                level: "street",
                title: "Hoşdere Cd.",
                district: "Çankaya",
                neighborhood: "Ayrancı",
                street: "Hoşdere Cd."
            }
        ];
        const duplicateIndex = createAddressSearchV2Index(source);
        const reference = duplicateIndex.baseIndex.byId.get("street-hosdere");
        expect(getAddressSemanticDuplicates(duplicateIndex, reference).map(item => item.id))
            .toEqual(expect.arrayContaining(["street-hosdere", "street-hosdere-alias"]));
    });

    test("reports release-oriented diagnostics", () => {
        expect(createAddressSearchV2Diagnostics(index)).toEqual(expect.objectContaining({
            version: ADDRESS_SEARCH_V2_VERSION,
            documentCount: fixtures.length,
            tokenCount: expect.any(Number),
            spatialCellCount: expect.any(Number),
            validationIssueCount: 0
        }));
    });

    test("throws typed error for missing index", () => {
        expect(() => searchAddressV2Index(null, "Hoşdere")).toThrow(AddressSearchV2Error);
    });

    test("honors pre-aborted search signal", () => {
        const controller = new AbortController();
        controller.abort();
        expect(() => throwIfAddressSearchAborted(controller.signal)).toThrow(expect.objectContaining({
            name: "AbortError",
            code: "ADDRESS_SEARCH_ABORTED"
        }));
        expect(() => searchAddressV2Index(index, "Hoşdere", { signal: controller.signal }))
            .toThrow(expect.objectContaining({ name: "AbortError" }));
    });

    test("scores spatial proximity as a bounded tie-break boost", () => {
        const document = index.baseIndex.byId.get("door-hosdere-10");
        const analysis = createAddressSearchV2Plan(index, "Hoşdere 10", { level: "door" }).analysis;
        const near = scoreAddressCandidateV2(document, analysis, {
            center: [32.847, 39.895],
            radiusMeters: 500
        });
        const noCenter = scoreAddressCandidateV2(document, analysis, {});
        expect(near.distanceBoost).toBeGreaterThan(0);
        expect(near.score).toBeGreaterThan(noCenter.score);
    });
});

describe("NextGenerationSearchCoordinatorRuntime", () => {
    test("publishes v2 mode and derived-index contracts", () => {
        expect(NEXT_GENERATION_SEARCH_VERSION).toBe("2.0.0");
        expect(ADDRESS_V2_DERIVED_KEY).toBe("address-index:v2");
        expect(isAddressV2Mode(SEARCH_COORDINATOR_MODES.Address)).toBe(true);
        expect(isAddressV2Mode(SEARCH_COORDINATOR_MODES.Nearest)).toBe(true);
        expect(isAddressV2Mode(SEARCH_COORDINATOR_MODES.Text)).toBe(false);
    });

    test("builds revision-aware derived V2 index through existing dataset registry", () => {
        const base = createBaseSearchCoordinator();
        const dataset = base.register("addresses", fixtures);
        const first = buildAddressV2IndexForDataset(base.registry, dataset);
        const second = buildAddressV2IndexForDataset(base.registry, dataset);
        expect(first).toBe(second);
        expect(first.version).toBe(ADDRESS_SEARCH_V2_VERSION);
    });

    test("creates version-separated result cache keys", () => {
        const dataset = { name: "addresses", revision: 2 };
        const key = createAddressV2CacheKey(dataset, { mode: "address", query: "Hoşdere", limit: 10 });
        expect(key.startsWith("v2:")).toBe(true);
        expect(key).toContain("addresses");
    });

    test("creates address and nearest response envelopes with V2 engine diagnostics", () => {
        const address = createAddressV2Response(index, {
            mode: SEARCH_COORDINATOR_MODES.Address,
            query: "Hoşdere Cd.",
            offset: 0,
            limit: 10,
            radiusMeters: 5000
        });
        const nearest = createAddressV2Response(index, {
            mode: SEARCH_COORDINATOR_MODES.Nearest,
            query: "",
            center: { latitude: 39.895, longitude: 32.847 },
            offset: 0,
            limit: 3,
            radiusMeters: 5000
        });
        expect(address.mode).toBe("address");
        expect(address.diagnostics.engine).toBe("address-v2");
        expect(nearest.mode).toBe("nearest");
        expect(nearest.diagnostics.engine).toBe("address-v2");
    });

    test("routes address search to V2 while retaining base text search", async () => {
        const coordinator = createNextGenerationSearchCoordinator();
        coordinator.register("addresses", fixtures);
        const address = await coordinator.search("addresses", {
            mode: "address",
            query: "Bilinmeyen Cadde",
            includeQuality: false
        });
        expect(address.runtimeVersion).toBe(NEXT_GENERATION_SEARCH_VERSION);
        expect(address.results).toEqual([]);

        const text = await coordinator.search("addresses", {
            mode: "text",
            query: "Hoşdere",
            includeQuality: false
        });
        expect(text.mode).toBe("text");
        expect(text.runtimeVersion).toBeUndefined();
        expect(text.results.length).toBeGreaterThan(0);
    });

    test("supports local V2 address search", () => {
        const coordinator = createNextGenerationSearchCoordinator();
        coordinator.register("addresses", fixtures);
        const result = coordinator.searchLocal("addresses", {
            mode: "address",
            query: "Hoşdere Cd. 10",
            includeQuality: false
        });
        expect(result.results.map(item => item.document.id)).toEqual(["door-hosdere-10"]);
        expect(coordinator.diagnostics().localV2Searches).toBe(1);
    });

    test("supports multi-dataset V2 search without one dataset failure collapsing all results", async () => {
        const coordinator = createNextGenerationSearchCoordinator();
        coordinator.register("one", fixtures);
        coordinator.register("two", fixtures.slice(0, 7));
        const result = await coordinator.searchMany(["one", "missing", "two"], {
            mode: "address",
            query: "Hoşdere Cd.",
            includeQuality: false
        });
        expect(result.datasets).toEqual(expect.arrayContaining(["one", "two"]));
        expect(result.errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ dataset: "missing" })
        ]));
        expect(result.results.length).toBeGreaterThan(0);
    });

    test("uses revision-sensitive V2 cache and invalidates through existing coordinator contract", async () => {
        const coordinator = createNextGenerationSearchCoordinator();
        coordinator.register("addresses", fixtures);
        const request = {
            mode: "address",
            query: "Hoşdere",
            includeQuality: false,
            useCache: true
        };
        const first = await coordinator.search("addresses", request, { now: 100 });
        const second = await coordinator.search("addresses", request, { now: 200 });
        expect(second).toEqual(first);
        expect(coordinator.diagnostics()).toEqual(expect.objectContaining({
            v2CacheHits: 1,
            v2CacheMisses: 1
        }));
        coordinator.invalidate("addresses");
        expect(coordinator.resultCache.diagnostics(200).size).toBe(0);
    });

    test("keeps quality and release-gate integration available for V2", async () => {
        const coordinator = createNextGenerationSearchCoordinator();
        coordinator.register("addresses", fixtures);
        const result = await coordinator.search("addresses", {
            mode: "address",
            query: "Hoşdere",
            includeQuality: true,
            includeSchemaReport: true
        });
        expect(result.schemaId).toBeTruthy();
        expect(result.schemaReport).not.toBeNull();
        expect(result.addressQuality.version).toBe(ADDRESS_SEARCH_V2_VERSION);
        expect(result.quality).not.toBeNull();
        expect(result.qualityGate).not.toBeNull();
    });

    test("preserves ingest, loader, invalidate, remove and clear facade contracts", async () => {
        const coordinator = createNextGenerationSearchCoordinator();
        coordinator.ingest("array", fixtures, { metadata: { source: "test" } });
        expect(coordinator.registry.get("array")).not.toBeNull();
        coordinator.registerLoader("loaded", async () => fixtures);
        const loaded = await coordinator.search("loaded", {
            mode: "address",
            query: "Hoşdere",
            includeQuality: false
        });
        expect(loaded.results.length).toBeGreaterThan(0);
        expect(coordinator.remove("array")).toBeTruthy();
        expect(coordinator.clear()).toBeGreaterThanOrEqual(1);
    });

    test("reports V2 diagnostics alongside the existing base coordinator", () => {
        const coordinator = createNextGenerationSearchCoordinator();
        coordinator.register("addresses", fixtures);
        coordinator.searchLocal("addresses", {
            mode: "address",
            query: "Hoşdere",
            includeQuality: false
        });
        expect(coordinator.diagnostics()).toEqual(expect.objectContaining({
            version: NEXT_GENERATION_SEARCH_VERSION,
            addressV2Searches: 1,
            base: expect.objectContaining({ registry: expect.any(Object) })
        }));
    });
});