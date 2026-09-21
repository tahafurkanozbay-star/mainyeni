import {
    adaptFeatureRecord,
    adaptSearchResult,
    advanceAdapterPageIterator,
    createAdapterPageIterator,
    createEmptySearchResult,
    dedupeAdaptedRecords,
    extractResultRecords,
    findRecordContainer,
    getFeatureAttributes,
    inferResultContract,
    isFailureStatus,
    isSuccessStatus,
    mergeAdaptedSearchResults,
    normalizeAdapterRecord,
    normalizeGeometryCoordinates,
    normalizeResultError,
    normalizeResultPage,
    normalizeResultStatus,
    normalizeResultTitle,
    readResultFields,
    readTransferLimit
} from "./SearchResultAdapterRuntime";

const parkFeature = (id = 1, name = "Kuğulu Park") => ({
    attributes: {
        OBJECTID: id,
        ADI: name,
        KATEGORI: "Parklar",
        ADRES: "Çankaya / Ankara"
    },
    geometry: {
        x: 32.8541,
        y: 39.9208
    }
});

describe("SearchResultAdapterRuntime", () => {
    describe("contract discovery", () => {
        test("extracts direct arrays", () => {
            const input = [parkFeature(1), parkFeature(2)];
            expect(extractResultRecords(input)).toBe(input);
            expect(inferResultContract(input)).toBe("array");
        });

        test("extracts legacy Title/Data containers", () => {
            const payload = { Title: "Parklar", Data: [parkFeature(1)] };
            expect(extractResultRecords(payload)).toEqual(payload.Data);
            expect(inferResultContract(payload)).toBe("legacy-service-result");
            expect(normalizeResultTitle(payload)).toBe("Parklar");
        });

        test("extracts modern data containers", () => {
            const payload = { title: "Parklar", data: [parkFeature(1)] };
            expect(extractResultRecords(payload)).toEqual(payload.data);
            expect(inferResultContract(payload)).toBe("service-result");
        });

        test("extracts ArcGIS features", () => {
            const payload = { features: [parkFeature(1)] };
            expect(extractResultRecords(payload)).toEqual(payload.features);
            expect(inferResultContract(payload)).toBe("arcgis-or-geojson");
        });

        test("extracts nested result payloads", () => {
            const payload = { result: { response: { records: [parkFeature(1)] } } };
            expect(extractResultRecords(payload)).toHaveLength(1);
            expect(inferResultContract(payload)).toBe("nested");
        });

        test("does not recurse forever on circular payloads", () => {
            const payload = {};
            payload.result = payload;
            expect(findRecordContainer(payload)).toBeNull();
            expect(extractResultRecords(payload)).toEqual([]);
        });

        test("returns empty records for malformed scalars", () => {
            expect(extractResultRecords(null)).toEqual([]);
            expect(extractResultRecords("bad")).toEqual([]);
            expect(inferResultContract(null)).toBe("empty");
        });
    });

    describe("status and error normalization", () => {
        test.each(["success", "OK", "başarılı", true, 1])("recognizes success status %p", value => {
            expect(isSuccessStatus(value)).toBe(true);
        });

        test.each(["error", "FAILED", "Hata", false, 0])("recognizes failure status %p", value => {
            expect(isFailureStatus(value)).toBe(true);
        });

        test("reads mixed-case status fields", () => {
            expect(normalizeResultStatus({ ResultType: "SUCCESS" })).toBe("success");
            expect(normalizeResultStatus({ Status: "HATA" })).toBe("hata");
        });

        test("normalizes string errors", () => {
            expect(normalizeResultError({ ErrorMessage: "Servis hatası" })).toMatchObject({
                message: "Servis hatası"
            });
        });

        test("preserves Error instances", () => {
            const error = new Error("boom");
            expect(normalizeResultError({ error })).toBe(error);
        });

        test("creates error from object-shaped service errors", () => {
            expect(normalizeResultError({ error: { message: "timeout" } })).toMatchObject({
                message: "timeout"
            });
        });
    });

    describe("feature normalization", () => {
        test("reads ArcGIS attributes", () => {
            const feature = parkFeature(42);
            expect(getFeatureAttributes(feature)).toBe(feature.attributes);
            const record = adaptFeatureRecord(feature, 7);
            expect(record.id).toBe("42");
            expect(record.ADI).toBe("Kuğulu Park");
            expect(record.sourceIndex).toBe(7);
        });

        test("reads GeoJSON properties", () => {
            const feature = {
                id: 5,
                properties: { name: "Kütüphane", category: "Kütüphaneler" },
                geometry: { type: "Point", coordinates: [32.8, 39.9] }
            };
            const record = adaptFeatureRecord(feature);
            expect(record.id).toBe("5");
            expect(record.name).toBe("Kütüphane");
            expect(record.coordinates).toEqual({ latitude: 39.9, longitude: 32.8 });
        });

        test("normalizes direct x/y geometry", () => {
            expect(normalizeGeometryCoordinates({ x: 32.8, y: 39.9 })).toEqual({
                latitude: 39.9,
                longitude: 32.8
            });
        });

        test("normalizes GeoJSON coordinate arrays", () => {
            expect(normalizeGeometryCoordinates({ coordinates: [32.8, 39.9] })).toEqual({
                latitude: 39.9,
                longitude: 32.8
            });
        });

        test("rejects invalid coordinate ranges", () => {
            expect(normalizeGeometryCoordinates({ coordinates: [400, 200] })).toBeNull();
        });

        test("preserves zero identifiers", () => {
            const record = adaptFeatureRecord({ attributes: { OBJECTID: 0, ADI: "Merkez" } });
            expect(record.id).toBe("0");
        });

        test("returns null for non-object records", () => {
            expect(adaptFeatureRecord(null)).toBeNull();
            expect(adaptFeatureRecord("invalid")).toBeNull();
        });
    });

    describe("deduplication", () => {
        test("deduplicates by stable identifiers", () => {
            const result = dedupeAdaptedRecords([
                parkFeature(1),
                parkFeature(1, "Aynı id farklı ad"),
                parkFeature(2)
            ]);
            expect(result.records).toHaveLength(2);
            expect(result.duplicates).toBe(1);
        });

        test("keeps records with distinct ids", () => {
            const result = dedupeAdaptedRecords([parkFeature(1), parkFeature(2)]);
            expect(result.records.map(item => item.id)).toEqual(["1", "2"]);
        });

        test("creates adapter validation metadata", () => {
            const result = normalizeAdapterRecord(parkFeature(1));
            expect(result.adapterValidation).toEqual(expect.objectContaining({
                normalized: true,
                hasId: true,
                hasCoordinates: true,
                hasGeometry: true
            }));
            expect(result.adapterFingerprint).toBe("id:1");
        });
    });

    describe("field and transfer metadata", () => {
        test("reads ArcGIS fields", () => {
            const fields = [{ name: "OBJECTID" }, { name: "ADI" }];
            expect(readResultFields({ fields })).toBe(fields);
            expect(readResultFields({ Data: { fields } })).toBe(fields);
        });

        test("ignores malformed fields", () => {
            expect(readResultFields({ fields: "bad" })).toEqual([]);
        });

        test("reads transfer limit variants", () => {
            expect(readTransferLimit({ exceededTransferLimit: true })).toBe(true);
            expect(readTransferLimit({ Data: { exceededTransferLimit: true } })).toBe(true);
            expect(readTransferLimit({ exceededTransferLimit: false })).toBe(false);
        });
    });

    describe("page normalization", () => {
        test("creates progress-safe next offset when transfer limit is set", () => {
            expect(normalizeResultPage({ exceededTransferLimit: true }, 25, { offset: 50, limit: 25 })).toEqual(expect.objectContaining({
                offset: 50,
                count: 25,
                hasMore: true,
                nextOffset: 75,
                progressed: true
            }));
        });

        test("does not claim progress for empty transfer-limited pages", () => {
            expect(normalizeResultPage({ exceededTransferLimit: true }, 0, { offset: 50, limit: 25 })).toEqual(expect.objectContaining({
                count: 0,
                hasMore: false,
                nextOffset: null,
                progressed: false
            }));
        });

        test("uses explicit total to determine additional pages", () => {
            const page = normalizeResultPage({ total: 100 }, 20, { offset: 20, limit: 20 });
            expect(page.hasMore).toBe(true);
            expect(page.nextOffset).toBe(40);
            expect(page.total).toBe(100);
        });

        test("stops at explicit total", () => {
            const page = normalizeResultPage({ total: 40 }, 20, { offset: 20, limit: 20 });
            expect(page.hasMore).toBe(false);
            expect(page.nextOffset).toBeNull();
        });

        test("accepts only forward explicit next offsets", () => {
            expect(normalizeResultPage({ nextOffset: 30 }, 10, { offset: 20, limit: 10 }).nextOffset).toBe(30);
            expect(normalizeResultPage({ nextOffset: 20 }, 10, { offset: 20, limit: 10 }).nextOffset).toBeNull();
        });
    });

    describe("full payload adaptation", () => {
        test("adapts legacy service results", () => {
            const result = adaptSearchResult({
                Title: "Parklar",
                ResultType: "Success",
                Data: [parkFeature(1), parkFeature(2)]
            });
            expect(result.ok).toBe(true);
            expect(result.title).toBe("Parklar");
            expect(result.records).toHaveLength(2);
            expect(result.presentations).toHaveLength(2);
            expect(result.page.count).toBe(2);
            expect(result.diagnostics.contract).toBe("legacy-service-result");
        });

        test("adapts ArcGIS results with field metadata", () => {
            const result = adaptSearchResult({
                features: [parkFeature(1)],
                fields: [{ name: "OBJECTID" }],
                exceededTransferLimit: true
            }, { offset: 0, limit: 1 });
            expect(result.fields).toHaveLength(1);
            expect(result.page.hasMore).toBe(true);
            expect(result.page.nextOffset).toBe(1);
            expect(result.diagnostics.transferLimited).toBe(true);
        });

        test("adapts GeoJSON features", () => {
            const result = adaptSearchResult({
                type: "FeatureCollection",
                features: [{
                    id: 7,
                    properties: { name: "Müze", category: "Müzeler" },
                    geometry: { type: "Point", coordinates: [32.85, 39.93] }
                }]
            });
            expect(result.records[0]).toEqual(expect.objectContaining({
                id: "7",
                coordinates: { latitude: 39.93, longitude: 32.85 }
            }));
        });

        test("marks explicit service errors as failed", () => {
            const result = adaptSearchResult({
                ResultType: "Error",
                ErrorMessage: "Servis yanıt vermedi",
                Data: []
            });
            expect(result.ok).toBe(false);
            expect(result.error).toMatchObject({ message: "Servis yanıt vermedi" });
        });

        test("creates an error for failure status without message", () => {
            const result = adaptSearchResult({ status: "failed", records: [] });
            expect(result.ok).toBe(false);
            expect(result.error.message).toContain("failed");
        });

        test("does not expose raw payload unless explicitly requested", () => {
            const payload = { records: [parkFeature(1)] };
            expect(adaptSearchResult(payload).raw).toBeUndefined();
            expect(adaptSearchResult(payload, { includeRaw: true }).raw).toBe(payload);
        });

        test("can disable presentation work for headless pipelines", () => {
            const result = adaptSearchResult({ records: [parkFeature(1)] }, { presentation: false });
            expect(result.presentations).toEqual([]);
            expect(result.iconCoverage).toBeNull();
        });

        test("reports icon coverage through existing shared authority", () => {
            const result = adaptSearchResult({
                records: [
                    { id: 1, title: "Park", category: "Parklar" },
                    { id: 2, title: "Bilinmeyen", category: "Yeni Bilinmeyen Tür" }
                ]
            });
            expect(result.iconCoverage.total).toBe(2);
            expect(result.iconCoverage.fallback).toBeGreaterThanOrEqual(1);
        });

        test("preserves dedupe opt-out when source semantics require duplicates", () => {
            const result = adaptSearchResult({ records: [parkFeature(1), parkFeature(1)] }, { dedupe: false });
            expect(result.records).toHaveLength(2);
            expect(result.diagnostics.duplicateCount).toBe(0);
        });
    });

    describe("empty and merged results", () => {
        test("creates deterministic empty search results", () => {
            expect(createEmptySearchResult({ title: "Boş", offset: 20, limit: 10 })).toEqual(expect.objectContaining({
                title: "Boş",
                ok: true,
                records: [],
                page: expect.objectContaining({
                    offset: 20,
                    limit: 10,
                    count: 0,
                    hasMore: false,
                    nextOffset: null
                })
            }));
        });

        test("merges pages while deduplicating overlap", () => {
            const first = adaptSearchResult({ records: [parkFeature(1), parkFeature(2)] }, { offset: 0, limit: 2 });
            const second = adaptSearchResult({ records: [parkFeature(2), parkFeature(3)], total: 3 }, { offset: 2, limit: 2 });
            const merged = mergeAdaptedSearchResults(first, second);
            expect(merged.records.map(item => item.id)).toEqual(["1", "2", "3"]);
            expect(merged.page.hasMore).toBe(false);
        });

        test("propagates the latest error across page merges", () => {
            const first = adaptSearchResult({ records: [parkFeature(1)] });
            const second = adaptSearchResult({ status: "failed", ErrorMessage: "page failed", records: [] });
            expect(mergeAdaptedSearchResults(first, second).error.message).toBe("page failed");
        });
    });

    describe("page iterator", () => {
        test("creates iterator with bounded pagination", () => {
            expect(createAdapterPageIterator({ offset: 10, limit: 25 })).toEqual({
                offset: 10,
                limit: 25,
                pages: 0,
                received: 0,
                done: false
            });
        });

        test("advances using explicit forward next offset", () => {
            const state = createAdapterPageIterator({ offset: 0, limit: 2 });
            const next = advanceAdapterPageIterator(state, {
                page: { count: 2, hasMore: true, nextOffset: 2 }
            });
            expect(next.offset).toBe(2);
            expect(next.pages).toBe(1);
            expect(next.received).toBe(2);
            expect(next.done).toBe(false);
        });

        test("falls back to record count when next offset is malformed", () => {
            const state = createAdapterPageIterator({ offset: 10, limit: 2 });
            const next = advanceAdapterPageIterator(state, {
                page: { count: 2, hasMore: true, nextOffset: 10 }
            });
            expect(next.offset).toBe(12);
            expect(next.done).toBe(false);
        });

        test("stops empty non-progressing pagination", () => {
            const state = createAdapterPageIterator({ offset: 10, limit: 2 });
            const next = advanceAdapterPageIterator(state, {
                page: { count: 0, hasMore: true, nextOffset: 10 }
            });
            expect(next.done).toBe(true);
            expect(next.offset).toBe(10);
        });

        test("stops terminal pages", () => {
            const state = createAdapterPageIterator({ offset: 0, limit: 2 });
            const next = advanceAdapterPageIterator(state, {
                page: { count: 1, hasMore: false, nextOffset: null }
            });
            expect(next.done).toBe(true);
            expect(next.received).toBe(1);
        });
    });
});