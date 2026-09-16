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
    toRadians,
    tokenizeAddress
} from "./AddressSearchRuntime";

const addressFixtures = [
    {
        id: "district-cankaya",
        level: "district",
        title: "Çankaya",
        district: "Çankaya"
    },
    {
        id: "district-mamak",
        level: "district",
        title: "Mamak",
        district: "Mamak"
    },
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
    describe("constants", () => {
        test("keeps deterministic hierarchy order", () => {
            expect(ADDRESS_LEVEL_ORDER).toEqual([
                "district",
                "neighborhood",
                "street",
                "building",
                "door",
                "address"
            ]);
        });

        test("uses bounded default search limits", () => {
            expect(DEFAULT_ADDRESS_SEARCH_LIMIT).toBeGreaterThan(0);
            expect(MAX_ADDRESS_SEARCH_LIMIT).toBeGreaterThan(DEFAULT_ADDRESS_SEARCH_LIMIT);
        });

        test("uses the mean earth radius in meters", () => {
            expect(EARTH_RADIUS_METERS).toBeGreaterThan(6370000);
            expect(EARTH_RADIUS_METERS).toBeLessThan(6380000);
        });
    });

    describe("text and token normalization", () => {
        test("normalizes Turkish casing and diacritics", () => {
            expect(normalizeAddressToken(" ÇİĞDEM Mahallesi ")).toBe("cigdem mahallesi");
            expect(normalizeAddressToken("Ihlamur Sokak")).toBe("ihlamur sokak");
        });

        test("normalizes punctuation into token boundaries", () => {
            expect(normalizeAddressToken("Hoşdere Cd./No:12-A")).toBe("hosdere cd no 12 a");
        });

        test("tokenizes once and removes duplicate tokens", () => {
            expect(tokenizeAddress("Park Park PARK Çankaya")).toEqual(["park", "cankaya"]);
        });

        test("returns no tokens for blank values", () => {
            expect(tokenizeAddress("")).toEqual([]);
            expect(tokenizeAddress(null)).toEqual([]);
        });

        test("normalizes door numbers without whitespace", () => {
            expect(normalizeDoorNumber(" 12 / a ")).toBe("12/A");
            expect(normalizeDoorNumber(0)).toBe("0");
        });

        test("normalizes valid five digit postal codes", () => {
            expect(normalizePostalCode("06 600")).toBe("06600");
            expect(normalizePostalCode("06600")).toBe("06600");
        });

        test("rejects malformed postal codes", () => {
            expect(normalizePostalCode("6600")).toBe("");
            expect(normalizePostalCode("006600")).toBe("");
            expect(normalizePostalCode(null)).toBe("");
        });
    });

    describe("level normalization", () => {
        test.each([
            ["ilçe", ADDRESS_LEVELS.District],
            ["district", ADDRESS_LEVELS.District],
            ["mahalle", ADDRESS_LEVELS.Neighborhood],
            ["neighborhood", ADDRESS_LEVELS.Neighborhood],
            ["cadde", ADDRESS_LEVELS.Street],
            ["sokak", ADDRESS_LEVELS.Street],
            ["yol", ADDRESS_LEVELS.Street],
            ["street", ADDRESS_LEVELS.Street],
            ["bina", ADDRESS_LEVELS.Building],
            ["building", ADDRESS_LEVELS.Building],
            ["kapı", ADDRESS_LEVELS.Door],
            ["door", ADDRESS_LEVELS.Door],
            ["adres", ADDRESS_LEVELS.Address],
            ["address", ADDRESS_LEVELS.Address]
        ])("normalizes %s to %s", (input, expected) => {
            expect(normalizeAddressLevel(input)).toBe(expected);
        });

        test("returns null for unknown levels", () => {
            expect(normalizeAddressLevel("park")).toBeNull();
            expect(normalizeAddressLevel(null)).toBeNull();
        });

        test("prefers explicit address level", () => {
            expect(inferAddressLevel({ level: "district", street: "Ignored" })).toBe(ADDRESS_LEVELS.District);
        });

        test("infers a door when a door number exists", () => {
            expect(inferAddressLevel({ street: "A", door: "12" })).toBe(ADDRESS_LEVELS.Door);
        });

        test("infers a building before street", () => {
            expect(inferAddressLevel({ building: "Bina A", street: "Sokak" })).toBe(ADDRESS_LEVELS.Building);
        });

        test("infers street, neighborhood and district in order", () => {
            expect(inferAddressLevel({ street: "Sokak" })).toBe(ADDRESS_LEVELS.Street);
            expect(inferAddressLevel({ neighborhood: "Mahalle" })).toBe(ADDRESS_LEVELS.Neighborhood);
            expect(inferAddressLevel({ district: "İlçe" })).toBe(ADDRESS_LEVELS.District);
        });

        test("falls back to generic address level", () => {
            expect(inferAddressLevel({ title: "Adres" })).toBe(ADDRESS_LEVELS.Address);
        });
    });

    describe("address parts and canonical labels", () => {
        const document = {
            title: "Bina",
            district: "Çankaya",
            neighborhood: "Ayrancı",
            street: "Hoşdere Caddesi",
            door: " 12 / A ",
            address: "Legacy address"
        };

        test("extracts normalized address parts", () => {
            expect(createAddressParts(document)).toEqual({
                district: "Çankaya",
                neighborhood: "Ayrancı",
                street: "Hoşdere Caddesi",
                door: "12/A",
                title: "Bina",
                address: "Legacy address",
                parts: ["Çankaya", "Ayrancı", "Hoşdere Caddesi", "12/A"]
            });
        });

        test("formats hierarchy from most specific to broadest", () => {
            expect(formatCanonicalAddress(document)).toBe("Hoşdere Caddesi, 12/A, Ayrancı, Çankaya");
        });

        test("falls back to address text when hierarchy is missing", () => {
            expect(formatCanonicalAddress({ address: "Ulus Ankara" })).toBe("Ulus Ankara");
        });

        test("falls back to title when address and hierarchy are missing", () => {
            expect(formatCanonicalAddress({ title: "Kayıt" })).toBe("Kayıt");
        });

        test("creates deterministic normalized hierarchy keys", () => {
            expect(createAddressHierarchyKey(document)).toBe("cankaya|ayranci|hosdere caddesi|12 a");
        });

        test("creates district parent keys for neighborhoods", () => {
            expect(createAddressParentKey({
                level: ADDRESS_LEVELS.Neighborhood,
                district: "Çankaya",
                neighborhood: "Ayrancı"
            })).toBe("district:cankaya");
        });

        test("creates neighborhood parent keys for streets", () => {
            expect(createAddressParentKey({
                level: ADDRESS_LEVELS.Street,
                district: "Çankaya",
                neighborhood: "Ayrancı",
                street: "Hoşdere"
            })).toBe("neighborhood:cankaya|ayranci");
        });

        test("creates street parent keys for doors", () => {
            expect(createAddressParentKey({
                level: ADDRESS_LEVELS.Door,
                district: "Çankaya",
                neighborhood: "Ayrancı",
                street: "Hoşdere",
                door: "10"
            })).toBe("street:cankaya|ayranci|hosdere");
        });

        test("does not assign parents to district records", () => {
            expect(createAddressParentKey({
                level: ADDRESS_LEVELS.District,
                district: "Çankaya"
            })).toBeNull();
        });
    });

    describe("address document normalization", () => {
        test("normalizes an ArcGIS attr record", () => {
            const document = normalizeAddressDocument({
                attr: {
                    OBJECTID: 12,
                    ADI: "Hoşdere 12",
                    ILCE_ADI: "Çankaya",
                    MAHALLE_ADI: "Ayrancı",
                    YOL_ADI: "Hoşdere Caddesi",
                    KAPI_NO: "12 / A",
                    Y: 39.895,
                    X: 32.847
                },
                level: "door"
            });
            expect(document).toEqual(expect.objectContaining({
                id: "12",
                level: ADDRESS_LEVELS.Door,
                canonicalAddress: "Hoşdere Caddesi, 12/A, Ayrancı, Çankaya",
                normalizedDistrict: "cankaya",
                normalizedNeighborhood: "ayranci",
                normalizedStreet: "hosdere caddesi",
                normalizedDoor: "12/A",
                coordinates: { latitude: 39.895, longitude: 32.847 }
            }));
            expect(document.tokens).toEqual(expect.arrayContaining([
                "hosdere",
                "12",
                "a",
                "ayranci",
                "cankaya"
            ]));
        });

        test("keeps a zero id stable", () => {
            expect(normalizeAddressDocument({ id: 0, title: "Zero" }).id).toBe("0");
        });
    });

    describe("coordinate parsing", () => {
        test("parses x/y arrays", () => {
            expect(parseCoordinatePair([32.85, 39.92])).toEqual({
                latitude: 39.92,
                longitude: 32.85
            });
        });

        test("falls back to y/x arrays when needed", () => {
            expect(parseCoordinatePair([39.92, 120])).toEqual({
                latitude: 120,
                longitude: 39.92
            });
        });

        test("parses object coordinates", () => {
            expect(parseCoordinatePair({ lat: 39.92, lng: 32.85 })).toEqual({
                latitude: 39.92,
                longitude: 32.85
            });
        });

        test("parses decimal-dot coordinate strings", () => {
            expect(parseCoordinatePair("32.85 39.92")).toEqual({
                latitude: 39.92,
                longitude: 32.85
            });
        });

        test("rejects malformed coordinate inputs", () => {
            expect(parseCoordinatePair(["bad", 39])).toBeNull();
            expect(parseCoordinatePair("bad data")).toBeNull();
            expect(parseCoordinatePair(null)).toBeNull();
        });

        test("converts degrees to radians", () => {
            expect(toRadians(180)).toBeCloseTo(Math.PI, 10);
            expect(toRadians(90)).toBeCloseTo(Math.PI / 2, 10);
        });
    });

    describe("distance and bounding boxes", () => {
        test("returns zero distance for the same point", () => {
            expect(haversineDistanceMeters(
                { latitude: 39.92, longitude: 32.85 },
                { latitude: 39.92, longitude: 32.85 }
            )).toBeCloseTo(0, 8);
        });

        test("computes realistic short-distance values", () => {
            const distance = haversineDistanceMeters(
                { latitude: 39.92, longitude: 32.85 },
                { latitude: 39.93, longitude: 32.85 }
            );
            expect(distance).toBeGreaterThan(1000);
            expect(distance).toBeLessThan(1200);
        });

        test("returns null when either coordinate is invalid", () => {
            expect(haversineDistanceMeters(null, { latitude: 1, longitude: 1 })).toBeNull();
        });

        test("creates bounded search boxes", () => {
            const bounds = createBoundingBox({ latitude: 39.92, longitude: 32.85 }, 1000);
            expect(bounds.minLatitude).toBeLessThan(39.92);
            expect(bounds.maxLatitude).toBeGreaterThan(39.92);
            expect(bounds.minLongitude).toBeLessThan(32.85);
            expect(bounds.maxLongitude).toBeGreaterThan(32.85);
        });

        test("rejects negative radii", () => {
            expect(createBoundingBox({ latitude: 39.92, longitude: 32.85 }, -1)).toBeNull();
        });

        test("detects points inside and outside a box", () => {
            const bounds = createBoundingBox({ latitude: 39.92, longitude: 32.85 }, 1000);
            expect(isInsideBoundingBox({ latitude: 39.92, longitude: 32.85 }, bounds)).toBe(true);
            expect(isInsideBoundingBox({ latitude: 40.5, longitude: 33.5 }, bounds)).toBe(false);
        });
    });

    describe("index creation", () => {
        test("indexes documents by id, level, hierarchy and token", () => {
            const index = createAddressIndex(addressFixtures);
            expect(index.documents).toHaveLength(addressFixtures.length);
            expect(index.byId.get("street-hosdere").title).toBe("Hoşdere Caddesi");
            expect(index.byLevel.get(ADDRESS_LEVELS.Door).size).toBe(3);
            expect(index.byDistrict.get("cankaya").size).toBe(8);
            expect(index.byNeighborhood.get("cankaya|ayranci").size).toBe(4);
            expect(index.byStreet.get("cankaya|ayranci|hosdere caddesi").size).toBe(3);
            expect(index.byToken.get("hosdere").size).toBe(3);
        });

        test("reports deterministic index diagnostics", () => {
            const index = createAddressIndex(addressFixtures);
            expect(index.diagnostics).toEqual(expect.objectContaining({
                inputCount: addressFixtures.length,
                acceptedCount: addressFixtures.length,
                indexedCount: addressFixtures.length,
                duplicateKeys: [],
                conflictingIds: [],
                districtCount: 2
            }));
            expect(index.diagnostics.neighborhoodCount).toBeGreaterThanOrEqual(3);
            expect(index.diagnostics.streetCount).toBeGreaterThanOrEqual(3);
            expect(index.diagnostics.tokenCount).toBeGreaterThan(5);
        });

        test("deduplicates repeated source records by default", () => {
            const index = createAddressIndex([
                addressFixtures[0],
                addressFixtures[0],
                addressFixtures[1]
            ]);
            expect(index.documents).toHaveLength(2);
            expect(index.diagnostics.duplicateCount).toBe(1);
        });

        test("can preserve repeated source records when requested", () => {
            const index = createAddressIndex([
                addressFixtures[0],
                addressFixtures[0]
            ], { dedupe: false });
            expect(index.documents).toHaveLength(2);
        });
    });

    describe("hierarchy traversal", () => {
        const index = createAddressIndex(addressFixtures);

        test("finds neighborhood children of a district", () => {
            const district = index.byId.get("district-cankaya");
            expect(getAddressChildren(index, district).map(item => item.title)).toEqual([
                "Ayrancı",
                "Kavaklıdere"
            ]);
        });

        test("finds street children of a neighborhood", () => {
            const neighborhood = index.byId.get("neighborhood-ayranci");
            expect(getAddressChildren(index, neighborhood).map(item => item.title)).toEqual([
                "Hoşdere Caddesi"
            ]);
        });

        test("finds door children of a street", () => {
            const street = index.byId.get("street-hosdere");
            expect(getAddressChildren(index, street).map(item => item.title)).toEqual([
                "Hoşdere 10",
                "Hoşdere 12/A"
            ]);
        });

        test("accepts an explicit parent key", () => {
            expect(getAddressChildren(index, "district:cankaya")).toHaveLength(2);
        });

        test("returns no children for terminal records", () => {
            expect(getAddressChildren(index, index.byId.get("door-hosdere-10"))).toEqual([]);
        });

        test("builds district, neighborhood and street ancestors", () => {
            const door = index.byId.get("door-hosdere-10");
            expect(getAddressAncestors(index, door).map(item => item.id)).toEqual([
                "district-cankaya",
                "neighborhood-ayranci",
                "street-hosdere"
            ]);
        });

        test("returns available ancestors only", () => {
            const district = index.byId.get("district-cankaya");
            expect(getAddressAncestors(index, district).map(item => item.id)).toEqual([
                "district-cankaya"
            ]);
        });
    });

    describe("scoring", () => {
        const index = createAddressIndex(addressFixtures);
        const door = index.byId.get("door-hosdere-10");
        const street = index.byId.get("street-hosdere");

        test("gives exact canonical matches the largest bonus", () => {
            const exact = scoreAddressDocument(door, door.canonicalAddress);
            const partial = scoreAddressDocument(door, "Hoşdere");
            expect(exact).toBeGreaterThan(partial);
        });

        test("scores prefix matches above contains matches", () => {
            const prefix = scoreAddressDocument(street, "Hoş");
            const contains = scoreAddressDocument(street, "dere");
            expect(prefix).toBeGreaterThan(contains);
        });

        test("rewards full token coverage", () => {
            const full = scoreAddressDocument(door, "Hoşdere 10 Çankaya");
            const partial = scoreAddressDocument(door, "Hoşdere bilinmeyen");
            expect(full).toBeGreaterThan(partial);
        });

        test("returns zero for blank queries", () => {
            expect(scoreAddressDocument(door, "")).toBe(0);
        });
    });

    describe("search option normalization", () => {
        test("normalizes paging and filters", () => {
            expect(normalizeAddressSearchOptions({
                offset: "5",
                limit: "20",
                level: "kapı",
                district: " ÇANKAYA ",
                neighborhood: "Ayrancı",
                street: "Hoşdere Caddesi",
                center: [32.85, 39.92],
                radiusMeters: "1000",
                minScore: "10"
            })).toEqual({
                offset: 5,
                limit: 20,
                level: ADDRESS_LEVELS.Door,
                district: "cankaya",
                neighborhood: "ayranci",
                street: "hosdere caddesi",
                center: { latitude: 39.92, longitude: 32.85 },
                radiusMeters: 1000,
                minScore: 10
            });
        });

        test("caps excessive page sizes", () => {
            expect(normalizeAddressSearchOptions({ limit: 99999 }).limit).toBe(MAX_ADDRESS_SEARCH_LIMIT);
        });

        test("uses safe defaults for malformed options", () => {
            expect(normalizeAddressSearchOptions({
                offset: -1,
                limit: 0,
                radiusMeters: -100,
                minScore: -10
            })).toEqual(expect.objectContaining({
                offset: 0,
                limit: DEFAULT_ADDRESS_SEARCH_LIMIT,
                radiusMeters: 0,
                minScore: 0
            }));
        });
    });

    describe("filtering", () => {
        const index = createAddressIndex(addressFixtures);

        test("filters by address level", () => {
            expect(filterAddressDocuments(index.documents, { level: "door" })).toHaveLength(3);
        });

        test("filters by district", () => {
            expect(filterAddressDocuments(index.documents, { district: "Çankaya" })).toHaveLength(8);
            expect(filterAddressDocuments(index.documents, { district: "Mamak" })).toHaveLength(1);
        });

        test("filters by neighborhood", () => {
            expect(filterAddressDocuments(index.documents, {
                district: "Çankaya",
                neighborhood: "Ayrancı"
            })).toHaveLength(4);
        });

        test("filters by street", () => {
            expect(filterAddressDocuments(index.documents, {
                district: "Çankaya",
                neighborhood: "Ayrancı",
                street: "Hoşdere Caddesi"
            })).toHaveLength(3);
        });

        test("filters by exact radius after bounding-box prefilter", () => {
            const nearby = filterAddressDocuments(index.documents, {
                center: [32.847, 39.895],
                radiusMeters: 100
            });
            expect(nearby.map(item => item.id)).toEqual(expect.arrayContaining([
                "street-hosdere",
                "door-hosdere-10",
                "door-hosdere-12a"
            ]));
            expect(nearby.map(item => item.id)).not.toContain("street-tunali");
        });
    });

    describe("address search", () => {
        const index = createAddressIndex(addressFixtures);

        test("finds Turkish diacritic-insensitive text", () => {
            const result = searchAddressIndex(index, "hosdere");
            expect(result.results.length).toBeGreaterThan(0);
            expect(result.results[0].document.canonicalAddress).toContain("Hoşdere");
        });

        test("finds dotless-i normalized values", () => {
            const result = searchAddressIndex(index, "ayranci");
            expect(result.results.some(item => item.document.neighborhood === "Ayrancı")).toBe(true);
        });

        test("supports hierarchy filters while searching", () => {
            const result = searchAddressIndex(index, "cadde", {
                district: "Çankaya",
                neighborhood: "Kavaklıdere"
            });
            expect(result.results.map(item => item.document.id)).toEqual(["street-tunali"]);
        });

        test("supports level filters", () => {
            const result = searchAddressIndex(index, "hosdere", { level: "door" });
            expect(result.results.map(item => item.document.id)).toEqual(expect.arrayContaining([
                "door-hosdere-10",
                "door-hosdere-12a"
            ]));
            expect(result.results.every(item => item.document.level === ADDRESS_LEVELS.Door)).toBe(true);
        });

        test("supports paging without non-progressing cursors", () => {
            const first = searchAddressIndex(index, "", { minScore: 0, limit: 3 });
            const second = searchAddressIndex(index, "", {
                minScore: 0,
                limit: 3,
                offset: first.page.nextOffset
            });
            expect(first.page).toEqual(expect.objectContaining({
                offset: 0,
                limit: 3,
                count: 3,
                hasMore: true,
                nextOffset: 3
            }));
            expect(second.page.offset).toBe(3);
            expect(second.results[0].document.key).not.toBe(first.results[0].document.key);
        });

        test("returns null next offset on the final page", () => {
            const result = searchAddressIndex(index, "", {
                minScore: 0,
                limit: 20
            });
            expect(result.page.count).toBe(addressFixtures.length);
            expect(result.page.hasMore).toBe(false);
            expect(result.page.nextOffset).toBeNull();
        });

        test("adds distances when a center is provided", () => {
            const result = searchAddressIndex(index, "hosdere", {
                center: [32.847, 39.895]
            });
            expect(result.results[0].distanceMeters).not.toBeNull();
        });

        test("sorts equally scored spatial results by distance", () => {
            const result = searchAddressIndex(index, "hosdere", {
                center: [32.847, 39.895],
                radiusMeters: 1000
            });
            const distances = result.results
                .map(item => item.distanceMeters)
                .filter(value => value !== null);
            expect(distances.length).toBeGreaterThan(1);
        });

        test("returns an empty result for impossible filters", () => {
            expect(searchAddressIndex(index, "hosdere", { district: "Mamak" })).toEqual({
                results: [],
                page: {
                    offset: 0,
                    limit: DEFAULT_ADDRESS_SEARCH_LIMIT,
                    count: 0,
                    total: 0,
                    hasMore: false,
                    nextOffset: null
                }
            });
        });
    });

    describe("nearest address lookup", () => {
        const index = createAddressIndex(addressFixtures);

        test("orders nearby addresses by distance", () => {
            const result = findNearestAddresses(index, [32.847, 39.895], {
                radiusMeters: 1000,
                limit: 10
            });
            expect(result.length).toBeGreaterThan(1);
            result.slice(1).forEach((item, indexPosition) => {
                expect(item.distanceMeters).toBeGreaterThanOrEqual(result[indexPosition].distanceMeters);
            });
        });

        test("respects radius", () => {
            const result = findNearestAddresses(index, [32.847, 39.895], {
                radiusMeters: 50,
                limit: 10
            });
            expect(result.every(item => item.distanceMeters <= 50)).toBe(true);
        });

        test("respects limit", () => {
            const result = findNearestAddresses(index, [32.847, 39.895], {
                radiusMeters: 10000,
                limit: 2
            });
            expect(result).toHaveLength(2);
        });

        test("rejects invalid centers", () => {
            expect(findNearestAddresses(index, "invalid")).toEqual([]);
        });
    });

    describe("quality diagnostics", () => {
        test("detects hierarchy omissions", () => {
            const index = createAddressIndex([
                { id: 1, level: "neighborhood", neighborhood: "A" },
                { id: 2, level: "street", district: "Çankaya", street: "B" },
                { id: 3, level: "door", district: "Çankaya", neighborhood: "Ayrancı", door: "10" }
            ]);
            expect(detectAddressHierarchyIssues(index)).toEqual(expect.arrayContaining([
                { code: "neighborhood-without-district", key: "id:1", severity: "warning" },
                { code: "street-without-parent", key: "id:2", severity: "warning" },
                { code: "door-without-street-or-number", key: "id:3", severity: "warning" }
            ]));
        });

        test("detects partial coordinate pairs", () => {
            const index = createAddressIndex([
                {
                    id: 1,
                    level: "street",
                    district: "Çankaya",
                    neighborhood: "Ayrancı",
                    street: "A",
                    latitude: 39.9
                }
            ]);
            expect(detectAddressHierarchyIssues(index)).toContainEqual({
                code: "partial-coordinate-pair",
                key: "id:1",
                severity: "warning"
            });
        });

        test("creates aggregate quality report", () => {
            const index = createAddressIndex(addressFixtures);
            const report = createAddressQualityReport(index);
            expect(report.total).toBe(addressFixtures.length);
            expect(report.geocodedCount).toBe(5);
            expect(report.ungeocodedCount).toBe(4);
            expect(report.geocodedRatio).toBeCloseTo(5 / 9, 8);
            expect(report.levelCounts).toEqual(expect.objectContaining({
                district: 2,
                neighborhood: 2,
                street: 2,
                door: 3
            }));
            expect(report.hierarchyIssues).toEqual([]);
            expect(report.hierarchyIssueCount).toBe(0);
        });

        test("keeps empty quality reports stable", () => {
            const report = createAddressQualityReport(createAddressIndex([]));
            expect(report.total).toBe(0);
            expect(report.geocodedCount).toBe(0);
            expect(report.ungeocodedCount).toBe(0);
            expect(report.geocodedRatio).toBe(0);
            expect(report.hierarchyIssueCount).toBe(0);
        });
    });
});
