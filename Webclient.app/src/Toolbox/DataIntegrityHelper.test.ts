import {
    createRecordFingerprint,
    createSearchIndex,
    normalizeCategoryKey,
    normalizeCoordinates,
    normalizeId,
    normalizeInteger,
    normalizePagination,
    normalizeRecord,
    normalizeRecords,
    normalizeSearchText,
    normalizeText,
    searchIndex,
    sortRecords
} from "./DataIntegrityHelper";

describe("DataIntegrityHelper", () => {
    test("normalizes unicode, whitespace and control characters", () => {
        expect(normalizeText("  Ankara\n\t Büyükşehir  ")).toBe("Ankara Büyükşehir");
        expect(normalizeText(null)).toBe("");
        expect(normalizeText(undefined, { empty: "-" })).toBe("-");
    });

    test.each([
        ["Çankaya", "cankaya"],
        ["İSTANBUL", "istanbul"],
        ["IĞDIR", "igdir"],
        ["Şehit Ömer", "sehit omer"],
        ["  Keçiören  ", "kecioren"]
    ])("creates locale-aware search text for %s", (input, expected) => {
        expect(normalizeSearchText(input)).toBe(expected);
    });

    test.each([
        ["Acil Toplanma Alanı", "acil-toplanma-alani"],
        ["  Taksi / Durak ", "taksi-durak"],
        ["Eczane", "eczane"],
        [null, ""]
    ])("creates deterministic category key", (input, expected) => {
        expect(normalizeCategoryKey(input)).toBe(expected);
    });

    test("preserves zero identifiers and rejects unusable identifiers", () => {
        expect(normalizeId(0)).toBe("0");
        expect(normalizeId("  001 ")).toBe("001");
        expect(normalizeId(12)).toBe("12");
        expect(normalizeId("")).toBeNull();
        expect(normalizeId(null)).toBeNull();
        expect(normalizeId(Number.NaN)).toBeNull();
    });

    test("clamps integer pagination values", () => {
        expect(normalizeInteger("12", { min: 0 })).toBe(12);
        expect(normalizeInteger(-2, { min: 0 })).toBe(0);
        expect(normalizeInteger(4.5, { fallback: 7 })).toBe(7);
        expect(normalizePagination({ offset: -10, limit: 50000 })).toEqual({ offset: 0, limit: 1000 });
        expect(normalizePagination({ offset: "20", limit: "25" })).toEqual({ offset: 20, limit: 25 });
        expect(normalizePagination({ offset: "bad", limit: 0 })).toEqual({ offset: 0, limit: 1 });
    });

    test.each([
        [{ lat: 39.9334, lng: 32.8597 }, { latitude: 39.9334, longitude: 32.8597 }],
        [{ y: "39.9", x: "32.8" }, { latitude: 39.9, longitude: 32.8 }],
        [{ latitude: 91, longitude: 32 }, null],
        [{ latitude: 39, longitude: 181 }, null],
        [{ latitude: "x", longitude: 32 }, null],
        [null, null]
    ])("normalizes coordinate shapes", (input, expected) => {
        expect(normalizeCoordinates(input)).toEqual(expected);
    });

    test("normalizes schema drift across record naming conventions", () => {
        expect(normalizeRecord({ OBJECTID: 0, ADI: "  Çankaya Parkı ", ADRES: " Kızılay\nAnkara ", kategori: "Yeşil Alan", Y: 39.92, X: 32.85 })).toMatchObject({
            id: "0",
            title: "Çankaya Parkı",
            searchTitle: "cankaya parki",
            category: "Yeşil Alan",
            categoryKey: "yesil-alan",
            address: "Kızılay Ankara",
            coordinates: { latitude: 39.92, longitude: 32.85 }
        });
    });

    test("supports explicit schema aliases", () => {
        const result = normalizeRecord({ pk: "a-1", label: "Merkez", kind: "Kamu", street: "Atatürk", north: 40, east: 33 }, {
            id: ["pk"], title: ["label"], category: ["kind"], address: ["street"], latitude: ["north"], longitude: ["east"]
        });
        expect(result).toMatchObject({ id: "a-1", title: "Merkez", categoryKey: "kamu", address: "Atatürk" });
    });

    test("rejects non-object records without throwing", () => {
        expect(normalizeRecord(null)).toBeNull();
        expect(normalizeRecord("record")).toBeNull();
        expect(normalizeRecord([])).toBeNull();
    });

    test("deduplicates by stable identifier", () => {
        const result = normalizeRecords([
            { id: 1, name: "A" },
            { id: "1", name: "A duplicate" },
            { id: 2, name: "B" }
        ]);
        expect(result.records.map(item => item.id)).toEqual(["1", "2"]);
        expect(result.diagnostics).toEqual({ input: 3, accepted: 2, invalid: 0, duplicates: 1 });
    });

    test("deduplicates id-less records by semantic fingerprint", () => {
        const result = normalizeRecords([
            { name: "Park", address: "Çankaya", category: "Yeşil", lat: 39.9, lng: 32.8 },
            { name: "PARK", address: "Cankaya", category: "yesil", lat: 39.9, lng: 32.8 }
        ]);
        expect(result.records).toHaveLength(1);
        expect(result.diagnostics.duplicates).toBe(1);
    });

    test("does not collapse empty records without fingerprints", () => {
        const result = normalizeRecords([{}, {}]);
        expect(result.records).toHaveLength(2);
        expect(result.diagnostics.duplicates).toBe(0);
    });

    test("counts malformed records as invalid", () => {
        const result = normalizeRecords([null, "bad", { id: 1 }]);
        expect(result.records).toHaveLength(1);
        expect(result.diagnostics.invalid).toBe(2);
    });

    test("creates stable semantic fingerprints", () => {
        const item = normalizeRecord({ name: "Park", address: "Çankaya", category: "Yeşil", lat: 39.9, lng: 32.8 });
        expect(createRecordFingerprint(item)).toBe("semantic:park|cankaya|yesil|39.900000,32.800000");
        expect(createRecordFingerprint(normalizeRecord({}))).toBeNull();
    });

    test("searches normalized title, address and category", () => {
        const { records } = normalizeRecords([
            { id: 1, name: "Çankaya Belediyesi", address: "Kızılay", category: "Kamu" },
            { id: 2, name: "Keçiören Parkı", address: "Etlik", category: "Yeşil Alan" },
            { id: 3, name: "Eczane", address: "Çankaya", category: "Sağlık" }
        ]);
        const index = createSearchIndex(records);
        expect(searchIndex(index, "cankaya").records.map(item => item.id)).toEqual(["1", "3"]);
        expect(searchIndex(index, "yesil").records.map(item => item.id)).toEqual(["2"]);
        expect(searchIndex(index, "etlik").records.map(item => item.id)).toEqual(["2"]);
    });

    test("filters category aliases using the same deterministic normalization", () => {
        const { records } = normalizeRecords([
            { id: 1, name: "A", category: "Acil Toplanma Alanı" },
            { id: 2, name: "B", category: "Eczane" }
        ]);
        const result = searchIndex(createSearchIndex(records), "", { category: "ACİL TOPLANMA ALANI" });
        expect(result.records.map(item => item.id)).toEqual(["1"]);
    });

    test("paginates without producing non-progressing next offsets", () => {
        const { records } = normalizeRecords(Array.from({ length: 7 }, (_, index) => ({ id: index, name: `Kayıt ${index}` })));
        const index = createSearchIndex(records);
        const first = searchIndex(index, "", { offset: 0, limit: 3 });
        const second = searchIndex(index, "", { offset: first.page.nextOffset, limit: 3 });
        const third = searchIndex(index, "", { offset: second.page.nextOffset, limit: 3 });
        expect(first.page).toEqual({ offset: 0, limit: 3, count: 3, total: 7, hasMore: true, nextOffset: 3 });
        expect(second.page.nextOffset).toBe(6);
        expect(third.page).toMatchObject({ count: 1, hasMore: false, nextOffset: null });
    });

    test("returns stable empty page for out-of-range offsets", () => {
        const { records } = normalizeRecords([{ id: 1, name: "A" }]);
        expect(searchIndex(createSearchIndex(records), "", { offset: 99, limit: 10 }).page).toEqual({
            offset: 99, limit: 10, count: 0, total: 1, hasMore: false, nextOffset: null
        });
    });

    test("sorts without mutating source records", () => {
        const records = [{ title: "Z10" }, { title: "z2" }, { title: "Çankaya" }];
        const sorted = sortRecords(records);
        expect(sorted.map(item => (item as { title: string }).title)).toEqual(["Çankaya", "z2", "Z10"]);
        expect(records.map(item => item.title)).toEqual(["Z10", "z2", "Çankaya"]);
    });
});
