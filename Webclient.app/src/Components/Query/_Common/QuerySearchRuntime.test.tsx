import {
    DEFAULT_GROUP_LIMIT,
    createAriaOptionId,
    createStableResultKey,
    filterBySearchFields,
    filterEgoLines,
    filterEgoStops,
    getRecordAddress,
    getRecordCategory,
    getRecordId,
    getRecordPhone,
    getRecordTitle,
    groupSearchResults,
    isResultActivationKey,
    isSmallViewport,
    matchesSearchText,
    moveActiveIndex,
    normalizeActiveIndex,
    normalizeEgoLine,
    normalizeEgoStop,
    normalizeSearchCollection,
    normalizeSearchRecord,
    normalizeTurkishSearchText,
    normalizeWhitespace,
    parseRouteCoordinatePairs,
    readFirstValue
} from "./QuerySearchRuntime";

describe("QuerySearchRuntime", () => {
    describe("text normalization", () => {
        test("normalizes nullish and repeated whitespace", () => {
            expect(normalizeWhitespace(null)).toBe("");
            expect(normalizeWhitespace(undefined)).toBe("");
            expect(normalizeWhitespace("  Ankara   Büyükşehir  ")).toBe("Ankara Büyükşehir");
        });

        test("normalizes Turkish casing consistently", () => {
            expect(normalizeTurkishSearchText("çiğdem ıhlamur izmir")).toBe("ÇİĞDEM IHLAMUR İZMİR");
        });

        test("matches Turkish text independent of casing", () => {
            expect(matchesSearchText("İtfaiye İstasyonu", "itfaiye")).toBe(true);
            expect(matchesSearchText("Çankaya", "çANk")).toBe(true);
            expect(matchesSearchText("Keçiören", "yenimahalle")).toBe(false);
        });

        test("empty search text matches every value", () => {
            expect(matchesSearchText("anything", "")).toBe(true);
            expect(matchesSearchText(null, "   ")).toBe(true);
        });
    });

    describe("record attribute access", () => {
        test("reads values from root records", () => {
            expect(readFirstValue({ title: "Root" }, ["title"])).toBe("Root");
        });

        test("reads values from attr records", () => {
            expect(readFirstValue({ attr: { ADI: "Park" } }, ["ADI", "adi"])).toBe("Park");
        });

        test("reads values from feature properties", () => {
            expect(readFirstValue({ properties: { id: 42 } }, ["id"])).toBe(42);
        });

        test("skips nullish and empty candidates", () => {
            const record = { attr: { ADI: "", adi: "Geçerli" } };
            expect(readFirstValue(record, ["ADI", "adi"], "fallback")).toBe("Geçerli");
        });

        test("uses fallback when no candidate exists", () => {
            expect(readFirstValue({}, ["missing"], "fallback")).toBe("fallback");
        });

        test("normalizes common record metadata", () => {
            const record = {
                attr: {
                    objectid: 7,
                    adi: "  Kent   Parkı ",
                    adres: " Kızılay ",
                    telefon: " 0312 000 00 00 ",
                    kategori: "Parklar"
                }
            };
            expect(getRecordId(record)).toBe(7);
            expect(getRecordTitle(record)).toBe("Kent Parkı");
            expect(getRecordAddress(record)).toBe("Kızılay");
            expect(getRecordPhone(record)).toBe("0312 000 00 00");
            expect(getRecordCategory(record)).toBe("Parklar");
        });

        test("provides readable metadata fallbacks", () => {
            expect(getRecordTitle({})).toBe("İsimsiz kayıt");
            expect(getRecordAddress({})).toBe("");
            expect(getRecordPhone({})).toBe("");
            expect(getRecordCategory({})).toBe("Diğer");
        });
    });

    describe("stable result keys", () => {
        test("prefers a server id", () => {
            expect(createStableResultKey({ attr: { id: "abc" } }, 3)).toBe("id:abc");
        });

        test("builds deterministic fallback keys", () => {
            const record = { attr: { adi: "Park", adres: "Kızılay", kategori: "Yeşil Alan" } };
            expect(createStableResultKey(record, 2)).toBe("record:Yeşil Alan|Park|Kızılay|2");
            expect(createStableResultKey(record, 2)).toBe(createStableResultKey(record, 2));
        });

        test("normalizes a raw record for UI use", () => {
            const record = {
                attr: {
                    objectid: 12,
                    ADI: "Etkinlik",
                    ADRES: "Ulus",
                    TELEFON: "123",
                    kategori: "Kültür"
                },
                type: "event"
            };
            expect(normalizeSearchRecord(record, 0)).toEqual(expect.objectContaining({
                raw: record,
                id: 12,
                key: "id:12",
                title: "Etkinlik",
                address: "Ulus",
                phone: "123",
                category: "Kültür",
                type: "event"
            }));
        });

        test("normalizes invalid collections to an empty list", () => {
            expect(normalizeSearchCollection(null)).toEqual([]);
            expect(normalizeSearchCollection({})).toEqual([]);
        });
    });

    describe("grouping", () => {
        const records = [
            { attr: { id: 1, adi: "Bir", kategori: "Park" } },
            { attr: { id: 2, adi: "İki", kategori: "Park" } },
            { attr: { id: 3, adi: "Üç", kategori: "Kültür" } }
        ];

        test("groups records without losing source order", () => {
            const grouped = groupSearchResults(records);
            expect(grouped.groups.map(group => group.category)).toEqual(["Park", "Kültür"]);
            expect(grouped.flatItems.map(item => item.id)).toEqual([1, 2, 3]);
            expect(grouped.totalCount).toBe(3);
            expect(grouped.visibleCount).toBe(3);
        });

        test("reports group start indexes", () => {
            const grouped = groupSearchResults(records);
            expect(grouped.groups[0]).toEqual(expect.objectContaining({ startIndex: 0, totalCount: 2, visibleCount: 2 }));
            expect(grouped.groups[1]).toEqual(expect.objectContaining({ startIndex: 2, totalCount: 1, visibleCount: 1 }));
        });

        test("limits visible records per category", () => {
            const many = Array.from({ length: DEFAULT_GROUP_LIMIT + 4 }, (_, index) => ({
                attr: { id: index + 1, adi: `Kayıt ${index + 1}`, kategori: "Park" }
            }));
            const grouped = groupSearchResults(many);
            expect(grouped.totalCount).toBe(DEFAULT_GROUP_LIMIT + 4);
            expect(grouped.visibleCount).toBe(DEFAULT_GROUP_LIMIT);
            expect(grouped.groups[0].visibleCount).toBe(DEFAULT_GROUP_LIMIT);
        });

        test("supports an explicit category limit", () => {
            const grouped = groupSearchResults(records, 1);
            expect(grouped.flatItems.map(item => item.id)).toEqual([1, 3]);
            expect(grouped.visibleCount).toBe(2);
        });

        test("handles empty input", () => {
            expect(groupSearchResults(null)).toEqual({ groups: [], flatItems: [], totalCount: 0, visibleCount: 0 });
        });
    });

    describe("field filtering", () => {
        const records = [
            { name: "Kızılay", code: "101" },
            { name: "İncek", code: "202" },
            { name: "Çiğdem", code: "303" }
        ];

        test("filters using named fields", () => {
            expect(filterBySearchFields(records, "202", ["name", "code"])).toEqual([records[1]]);
        });

        test("filters using selector functions", () => {
            expect(filterBySearchFields(records, "çiğ", [item => item.name])).toEqual([records[2]]);
        });

        test("returns a defensive copy for empty searches", () => {
            const result = filterBySearchFields(records, "", ["name"]);
            expect(result).toEqual(records);
            expect(result).not.toBe(records);
        });

        test("returns empty array for invalid record collections", () => {
            expect(filterBySearchFields(null, "x", ["name"])).toEqual([]);
        });
    });

    describe("EGO normalization and filtering", () => {
        const lines = [
            { haT_NO: "413", haT_ADI: "ALTINDAĞ - KIZILAY", haT_TIPI: "NORMAL" },
            { haT_NO: "185", haT_ADI: "ORAN - ULUS", haT_TIPI: "NORMAL" }
        ];
        const stops = [
            { duraK_NO: "10001", duraK_ADI: "KIZILAY", haT_TIPI: "OTOBÜS", lat: "39,920", lng: "32,850" },
            { duraK_NO: "10002", duraK_ADI: "ULUS", haT_TIPI: "OTOBÜS", lat: "39.94", lng: "32.86" }
        ];

        test("normalizes line metadata", () => {
            expect(normalizeEgoLine(lines[0])).toEqual(expect.objectContaining({
                lineNo: "413",
                lineName: "ALTINDAĞ - KIZILAY",
                lineType: "NORMAL"
            }));
        });

        test("shows no EGO lines before a search when showAll is false", () => {
            expect(filterEgoLines(lines, "", false)).toEqual([]);
        });

        test("shows every EGO line for showAll mode", () => {
            expect(filterEgoLines(lines, "", true)).toHaveLength(2);
        });

        test("filters EGO lines by name or number", () => {
            expect(filterEgoLines(lines, "413")).toHaveLength(1);
            expect(filterEgoLines(lines, "oran")).toHaveLength(1);
        });

        test("normalizes stop coordinates", () => {
            expect(normalizeEgoStop(stops[0])).toEqual(expect.objectContaining({
                stopNo: "10001",
                stopName: "KIZILAY",
                latitude: 39.92,
                longitude: 32.85
            }));
        });

        test("filters EGO stops by name or number", () => {
            expect(filterEgoStops(stops, "10002")).toHaveLength(1);
            expect(filterEgoStops(stops, "kızılay")).toHaveLength(1);
        });

        test("keeps invalid coordinates visible while marking them non-finite", () => {
            const normalized = normalizeEgoStop({ duraK_NO: "x", duraK_ADI: "Test", lat: "bad", lng: null });
            expect(Number.isFinite(normalized.latitude)).toBe(false);
            expect(Number.isFinite(normalized.longitude)).toBe(false);
        });
    });

    describe("route coordinate parsing", () => {
        test("parses decimal-comma latitude longitude pairs into x/y points", () => {
            expect(parseRouteCoordinatePairs("39,90 32,80 39,91 32,81"))
                .toEqual([[32.8, 39.9], [32.81, 39.91]]);
        });

        test("ignores malformed coordinate pairs", () => {
            expect(parseRouteCoordinatePairs("bad 32,80 39,91 32,81"))
                .toEqual([[32.81, 39.91]]);
        });

        test("ignores a trailing unpaired token", () => {
            expect(parseRouteCoordinatePairs("39.9 32.8 orphan")).toEqual([[32.8, 39.9]]);
        });

        test("returns an empty array for blank input", () => {
            expect(parseRouteCoordinatePairs("  ")).toEqual([]);
        });
    });

    describe("keyboard index helpers", () => {
        test("normalizes indexes to a valid option", () => {
            expect(normalizeActiveIndex(-10, 4)).toBe(0);
            expect(normalizeActiveIndex(99, 4)).toBe(3);
            expect(normalizeActiveIndex(2, 4)).toBe(2);
        });

        test("returns -1 when there are no options", () => {
            expect(normalizeActiveIndex(0, 0)).toBe(-1);
            expect(moveActiveIndex(0, "next", 0)).toBe(-1);
        });

        test("moves without wrapping past list boundaries", () => {
            expect(moveActiveIndex(0, "previous", 4)).toBe(0);
            expect(moveActiveIndex(0, "next", 4)).toBe(1);
            expect(moveActiveIndex(3, "next", 4)).toBe(3);
        });

        test("supports home and end navigation", () => {
            expect(moveActiveIndex(2, "first", 4)).toBe(0);
            expect(moveActiveIndex(1, "last", 4)).toBe(3);
        });

        test("recognizes keyboard activation keys", () => {
            expect(isResultActivationKey("Enter")).toBe(true);
            expect(isResultActivationKey(" ")).toBe(true);
            expect(isResultActivationKey("Escape")).toBe(false);
        });
    });

    describe("ARIA and responsive helpers", () => {
        test("creates deterministic safe option ids", () => {
            expect(createAriaOptionId("full search", "id:12/abc")).toBe("full-search-id-12-abc");
        });

        test("uses fallbacks for empty id parts", () => {
            expect(createAriaOptionId("", "")).toBe("query-search-option");
        });

        test("detects a small viewport using matchMedia", () => {
            const matchMedia = jest.fn(() => ({ matches: true }));
            expect(isSmallViewport(matchMedia)).toBe(true);
            expect(matchMedia).toHaveBeenCalledWith("(max-width: 959px)");
        });

        test("returns false when matchMedia is unavailable", () => {
            expect(isSmallViewport(null)).toBe(false);
        });
    });
});
