import {
    ADDRESS_LEVELS,
    ADDRESS_LEVEL_ORDER,
    DEFAULT_ADDRESS_SEARCH_LIMIT,
    EARTH_RADIUS_METERS,
    MAX_ADDRESS_SEARCH_LIMIT,
    createAddressHierarchyKey,
    createAddressIndex,
    createAddressParentKey,
    createAddressParts,
    createAddressQualityReport,
    createBoundingBox,
    detectAddressHierarchyIssues,
    filterAddressDocuments,
    findNearestAddresses,
    formatCanonicalAddress,
    getAddressAncestors,
    getAddressChildren,
    haversineDistanceMeters,
    inferAddressLevel,
    isInsideBoundingBox,
    normalizeAddressDocument,
    normalizeAddressLevel,
    normalizeAddressSearchOptions,
    normalizeAddressToken,
    normalizeDoorNumber,
    normalizePostalCode,
    parseCoordinatePair,
    scoreAddressDocument,
    searchAddressIndex,
    tokenizeAddress
} from "./AddressSearchRuntime";

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

describe("AddressSearchRuntime", () => {
    test("keeps deterministic hierarchy constants", () => {
        expect(ADDRESS_LEVEL_ORDER).toEqual([
            "district", "neighborhood", "street", "building", "door", "address"
        ]);
        expect(DEFAULT_ADDRESS_SEARCH_LIMIT).toBeGreaterThan(0);
        expect(MAX_ADDRESS_SEARCH_LIMIT).toBeGreaterThan(DEFAULT_ADDRESS_SEARCH_LIMIT);
        expect(EARTH_RADIUS_METERS).toBeGreaterThan(6370000);
    });

    describe("locale and hierarchy normalization", () => {
        test("normalizes Turkish casing, diacritics and punctuation", () => {
            expect(normalizeAddressToken(" ÇİĞDEM Mahallesi ")).toBe("cigdem mahallesi");
            expect(normalizeAddressToken("Hoşdere Cd./No:12-A")).toBe("hosdere cd no 12 a");
            expect(tokenizeAddress("Park Park Çankaya")).toEqual(["park", "cankaya"]);
        });

        test("normalizes door and postal values", () => {
            expect(normalizeDoorNumber(" 12 / a ")).toBe("12/A");
            expect(normalizeDoorNumber(0)).toBe("0");
            expect(normalizePostalCode("06 600")).toBe("06600");
            expect(normalizePostalCode("6600")).toBe("");
        });

        test.each([
            ["ilçe", ADDRESS_LEVELS.District],
            ["mahalle", ADDRESS_LEVELS.Neighborhood],
            ["cadde", ADDRESS_LEVELS.Street],
            ["sokak", ADDRESS_LEVELS.Street],
            ["bulvar", ADDRESS_LEVELS.Street],
            ["bina", ADDRESS_LEVELS.Building],
            ["kapı", ADDRESS_LEVELS.Door],
            ["adres", ADDRESS_LEVELS.Address]
        ])("normalizes %s to %s", (input, expected) => {
            expect(normalizeAddressLevel(input)).toBe(expected);
        });

        test("infers the most specific known hierarchy level", () => {
            expect(inferAddressLevel({ level: "district", street: "ignored" })).toBe(ADDRESS_LEVELS.District);
            expect(inferAddressLevel({ street: "A", door: "12" })).toBe(ADDRESS_LEVELS.Door);
            expect(inferAddressLevel({ building: "B", street: "A" })).toBe(ADDRESS_LEVELS.Building);
            expect(inferAddressLevel({ street: "A" })).toBe(ADDRESS_LEVELS.Street);
            expect(inferAddressLevel({ neighborhood: "A" })).toBe(ADDRESS_LEVELS.Neighborhood);
            expect(inferAddressLevel({ district: "A" })).toBe(ADDRESS_LEVELS.District);
            expect(inferAddressLevel({ title: "A" })).toBe(ADDRESS_LEVELS.Address);
        });
    });

    describe("canonical address contract", () => {
        const document = {
            title: "Bina",
            district: "Çankaya",
            neighborhood: "Ayrancı",
            street: "Hoşdere Caddesi",
            door: " 12 / A ",
            address: "Legacy address"
        };

        test("extracts and formats hierarchy deterministically", () => {
            expect(createAddressParts(document)).toEqual({
                district: "Çankaya",
                neighborhood: "Ayrancı",
                street: "Hoşdere Caddesi",
                door: "12/A",
                title: "Bina",
                address: "Legacy address",
                parts: ["Çankaya", "Ayrancı", "Hoşdere Caddesi", "12/A"]
            });
            expect(formatCanonicalAddress(document)).toBe("Hoşdere Caddesi, 12/A, Ayrancı, Çankaya");
            expect(createAddressHierarchyKey(document)).toBe("cankaya|ayranci|hosdere caddesi|12 a");
        });

        test("creates deterministic parent keys", () => {
            expect(createAddressParentKey({ level: "district", district: "Çankaya" })).toBeNull();
            expect(createAddressParentKey({
                level: "neighborhood", district: "Çankaya", neighborhood: "Ayrancı"
            })).toBe("district:cankaya");
            expect(createAddressParentKey({
                level: "street", district: "Çankaya", neighborhood: "Ayrancı", street: "Hoşdere"
            })).toBe("neighborhood:cankaya|ayranci");
            expect(createAddressParentKey({
                level: "door", district: "Çankaya", neighborhood: "Ayrancı", street: "Hoşdere", door: "10"
            })).toBe("street:cankaya|ayranci|hosdere");
        });

        test("normalizes ArcGIS attribute aliases and zero ids", () => {
            const documentResult = normalizeAddressDocument({
                level: "door",
                attr: {
                    OBJECTID: 0,
                    ADI: "Hoşdere 12",
                    ILCE_ADI: "Çankaya",
                    MAHALLE_ADI: "Ayrancı",
                    YOL_ADI: "Hoşdere Caddesi",
                    KAPI_NO: "12 / A",
                    Y: 39.895,
                    X: 32.847
                }
            });
            expect(documentResult).toEqual(expect.objectContaining({
                id: "0",
                level: ADDRESS_LEVELS.Door,
                canonicalAddress: "Hoşdere Caddesi, 12/A, Ayrancı, Çankaya",
                normalizedDistrict: "cankaya",
                normalizedNeighborhood: "ayranci",
                normalizedStreet: "hosdere caddesi",
                normalizedDoor: "12/A",
                coordinates: { latitude: 39.895, longitude: 32.847 }
            }));
        });
    });

    describe("coordinate validation and spatial helpers", () => {
        test("parses x/y arrays and safely falls back to y/x", () => {
            expect(parseCoordinatePair([32.85, 39.92])).toEqual({ latitude: 39.92, longitude: 32.85 });
            expect(parseCoordinatePair([39.92, 120])).toEqual({ latitude: 39.92, longitude: 120 });
        });

        test("parses object and string forms including decimal commas", () => {
            expect(parseCoordinatePair({ lat: 39.92, lng: 32.85 })).toEqual({ latitude: 39.92, longitude: 32.85 });
            expect(parseCoordinatePair("32.85 39.92")).toEqual({ latitude: 39.92, longitude: 32.85 });
            expect(parseCoordinatePair("32,85 39,92")).toEqual({ latitude: 39.92, longitude: 32.85 });
            expect(parseCoordinatePair("32.85;39.92")).toEqual({ latitude: 39.92, longitude: 32.85 });
        });

        test("rejects malformed or out-of-range coordinates", () => {
            expect(parseCoordinatePair(["bad", 39])).toBeNull();
            expect(parseCoordinatePair("bad data")).toBeNull();
            expect(parseCoordinatePair({ latitude: 120, longitude: 220 })).toBeNull();
            expect(parseCoordinatePair(null)).toBeNull();
        });

        test("computes stable haversine distance and bounding boxes", () => {
            const same = { latitude: 39.92, longitude: 32.85 };
            expect(haversineDistanceMeters(same, same)).toBeCloseTo(0, 8);
            const distance = haversineDistanceMeters(same, { latitude: 39.93, longitude: 32.85 });
            expect(distance).toBeGreaterThan(1000);
            expect(distance).toBeLessThan(1200);
            const bounds = createBoundingBox(same, 1000);
            expect(isInsideBoundingBox(same, bounds)).toBe(true);
            expect(isInsideBoundingBox({ latitude: 40.5, longitude: 33.5 }, bounds)).toBe(false);
            expect(createBoundingBox(same, -1)).toBeNull();
        });
    });

    describe("index and hierarchy traversal", () => {
        const index = createAddressIndex(fixtures);

        test("indexes ids, levels, hierarchy and normalized tokens", () => {
            expect(index.documents).toHaveLength(fixtures.length);
            expect(index.byId.get("street-hosdere").title).toBe("Hoşdere Caddesi");
            expect(index.byLevel.get(ADDRESS_LEVELS.Door).size).toBe(3);
            expect(index.byDistrict.get("cankaya").size).toBe(8);
            expect(index.byNeighborhood.get("cankaya|ayranci").size).toBe(4);
            expect(index.byStreet.get("cankaya|ayranci|hosdere caddesi").size).toBe(3);
            expect(index.byToken.get("hosdere").size).toBe(3);
        });

        test("deduplicates repeated source records by default", () => {
            const duplicated = createAddressIndex([fixtures[0], fixtures[0], fixtures[1]]);
            expect(duplicated.documents).toHaveLength(2);
            expect(duplicated.diagnostics.duplicateCount).toBe(1);
        });

        test("traverses children and ancestors without global scans in callers", () => {
            expect(getAddressChildren(index, index.byId.get("district-cankaya")).map(item => item.id)).toEqual([
                "neighborhood-ayranci", "neighborhood-kavaklidere"
            ]);
            expect(getAddressChildren(index, index.byId.get("street-hosdere")).map(item => item.id)).toEqual([
                "door-hosdere-10", "door-hosdere-12a"
            ]);
            expect(getAddressAncestors(index, index.byId.get("door-hosdere-10")).map(item => item.id)).toEqual([
                "district-cankaya", "neighborhood-ayranci", "street-hosdere"
            ]);
        });
    });

    describe("search scoring, filtering and paging", () => {
        const index = createAddressIndex(fixtures);

        test("never awards level bonus to a non-matching query", () => {
            expect(scoreAddressDocument(index.byId.get("district-mamak"), "hosdere")).toBe(0);
        });

        test("rewards exact and complete token matches", () => {
            const door = index.byId.get("door-hosdere-10");
            expect(scoreAddressDocument(door, door.canonicalAddress)).toBeGreaterThan(scoreAddressDocument(door, "Hoşdere"));
            expect(scoreAddressDocument(door, "Hoşdere 10 Çankaya")).toBeGreaterThan(scoreAddressDocument(door, "Hoşdere bilinmeyen"));
        });

        test("normalizes options with safe defaults and bounds", () => {
            expect(normalizeAddressSearchOptions({ offset: -1, limit: 0, radiusMeters: -5, minScore: -1 }))
                .toEqual(expect.objectContaining({
                    offset: 0,
                    limit: DEFAULT_ADDRESS_SEARCH_LIMIT,
                    radiusMeters: 0,
                    minScore: 0
                }));
            expect(normalizeAddressSearchOptions({ limit: 99999 }).limit).toBe(MAX_ADDRESS_SEARCH_LIMIT);
        });

        test("filters by hierarchy and exact spatial radius", () => {
            expect(filterAddressDocuments(index.documents, {
                district: "Çankaya", neighborhood: "Ayrancı", street: "Hoşdere Caddesi"
            })).toHaveLength(3);
            const nearby = filterAddressDocuments(index.documents, {
                center: [32.847, 39.895], radiusMeters: 100
            });
            expect(nearby.map(item => item.id)).toEqual(expect.arrayContaining([
                "street-hosdere", "door-hosdere-10", "door-hosdere-12a"
            ]));
            expect(nearby.map(item => item.id)).not.toContain("street-tunali");
        });

        test("searches Turkish text and rejects false positives", () => {
            expect(searchAddressIndex(index, "hosdere").results[0].document.canonicalAddress).toContain("Hoşdere");
            expect(searchAddressIndex(index, "ayranci").results.some(item => item.document.neighborhood === "Ayrancı")).toBe(true);
            expect(searchAddressIndex(index, "hosdere", { district: "Mamak" }).results).toEqual([]);
        });

        test("street designators naturally narrow the hierarchy to street records", () => {
            const result = searchAddressIndex(index, "cadde", {
                district: "Çankaya", neighborhood: "Kavaklıdere"
            });
            expect(result.results.map(item => item.document.id)).toEqual(["street-tunali"]);
        });

        test("explicit level filters remain authoritative", () => {
            const result = searchAddressIndex(index, "hosdere", { level: "door" });
            expect(result.results.map(item => item.document.id)).toEqual(expect.arrayContaining([
                "door-hosdere-10", "door-hosdere-12a"
            ]));
            expect(result.results.every(item => item.document.level === ADDRESS_LEVELS.Door)).toBe(true);
        });

        test("pagination always progresses and terminates", () => {
            const first = searchAddressIndex(index, "", { minScore: 0, limit: 3 });
            const second = searchAddressIndex(index, "", { minScore: 0, limit: 3, offset: first.page.nextOffset });
            expect(first.page).toEqual(expect.objectContaining({ offset: 0, count: 3, hasMore: true, nextOffset: 3 }));
            expect(second.page.offset).toBe(3);
            const final = searchAddressIndex(index, "", { minScore: 0, limit: 20 });
            expect(final.page).toEqual(expect.objectContaining({
                count: fixtures.length,
                total: fixtures.length,
                hasMore: false,
                nextOffset: null
            }));
        });
    });

    describe("nearest search and integrity report", () => {
        const index = createAddressIndex(fixtures);

        test("orders nearest addresses and respects radius/limit", () => {
            const nearest = findNearestAddresses(index, [32.847, 39.895], { radiusMeters: 1000, limit: 3 });
            expect(nearest).toHaveLength(3);
            expect(nearest[1].distanceMeters).toBeGreaterThanOrEqual(nearest[0].distanceMeters);
            expect(findNearestAddresses(index, "invalid")).toEqual([]);
        });

        test("detects broken hierarchy and partial coordinates", () => {
            const broken = createAddressIndex([
                { id: 1, level: "neighborhood", neighborhood: "A" },
                { id: 2, level: "street", district: "Çankaya", street: "B", latitude: 39.9 },
                { id: 3, level: "door", district: "Çankaya", neighborhood: "Ayrancı", door: "10" }
            ]);
            expect(detectAddressHierarchyIssues(broken)).toEqual(expect.arrayContaining([
                { code: "neighborhood-without-district", key: "id:1", severity: "warning" },
                { code: "street-without-parent", key: "id:2", severity: "warning" },
                { code: "partial-coordinate-pair", key: "id:2", severity: "warning" },
                { code: "door-without-street-or-number", key: "id:3", severity: "warning" }
            ]));
        });

        test("creates aggregate quality metrics", () => {
            const report = createAddressQualityReport(index);
            expect(report.total).toBe(fixtures.length);
            expect(report.geocodedCount).toBe(5);
            expect(report.ungeocodedCount).toBe(4);
            expect(report.geocodedRatio).toBeCloseTo(5 / 9, 8);
            expect(report.levelCounts).toEqual(expect.objectContaining({
                district: 2, neighborhood: 2, street: 2, door: 3
            }));
            expect(report.hierarchyIssueCount).toBe(0);
        });
    });
});
