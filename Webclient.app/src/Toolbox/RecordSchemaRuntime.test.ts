import {
    ADDRESS_RECORD_SCHEMA,
    DEFAULT_FIELD_ALIASES,
    FIELD_TYPES,
    GENERIC_RECORD_SCHEMA,
    SOURCE_CONTAINERS,
    buildFacetCounts,
    compileSchema,
    createFieldDefinition,
    createSchemaFingerprint,
    createSchemaQualityReport,
    createSearchDocumentFromSchema,
    detectSchemaDrift,
    getRecordSources,
    inspectRecordShape,
    isPlainObject,
    normalizeBoolean,
    normalizeFieldValue,
    normalizePhone,
    normalizeRecordCollection,
    normalizeSafeHttpUrl,
    readAliasedValue,
    readRecordWithSchema,
    validateNormalizedRecord
} from "./RecordSchemaRuntime";

describe("RecordSchemaRuntime", () => {
    describe("static contracts", () => {
        test("exposes the supported source containers", () => {
            expect(SOURCE_CONTAINERS).toEqual(["root", "attr", "attributes", "properties"]);
        });

        test("exposes stable field types", () => {
            expect(FIELD_TYPES).toEqual(expect.objectContaining({
                Text: "text",
                Id: "id",
                Integer: "integer",
                Number: "number",
                Boolean: "boolean",
                Category: "category",
                Latitude: "latitude",
                Longitude: "longitude",
                Url: "url",
                Phone: "phone"
            }));
        });

        test("contains the expected high-value aliases", () => {
            expect(DEFAULT_FIELD_ALIASES.id).toEqual(expect.arrayContaining(["id", "OBJECTID", "globalid"]));
            expect(DEFAULT_FIELD_ALIASES.title).toEqual(expect.arrayContaining(["title", "ADI", "name"]));
            expect(DEFAULT_FIELD_ALIASES.category).toEqual(expect.arrayContaining(["category", "kategori", "TUR"]));
            expect(DEFAULT_FIELD_ALIASES.address).toEqual(expect.arrayContaining(["address", "ADRES", "acikAdres"]));
            expect(DEFAULT_FIELD_ALIASES.district).toEqual(expect.arrayContaining(["district", "ILCE_ADI", "ilceAdi"]));
            expect(DEFAULT_FIELD_ALIASES.neighborhood).toEqual(expect.arrayContaining(["neighborhood", "MAHALLE_ADI", "_MAHALLE_ADI"]));
            expect(DEFAULT_FIELD_ALIASES.street).toEqual(expect.arrayContaining(["street", "CADDE", "YOL_ADI"]));
            expect(DEFAULT_FIELD_ALIASES.door).toEqual(expect.arrayContaining(["door", "kapino", "KAPI_NO"]));
            expect(DEFAULT_FIELD_ALIASES.latitude).toEqual(expect.arrayContaining(["latitude", "LAT", "Y"]));
            expect(DEFAULT_FIELD_ALIASES.longitude).toEqual(expect.arrayContaining(["longitude", "LNG", "X"]));
        });
    });

    describe("plain object and source inspection", () => {
        test("recognizes plain objects only", () => {
            expect(isPlainObject({})).toBe(true);
            expect(isPlainObject({ a: 1 })).toBe(true);
            expect(isPlainObject([])).toBe(false);
            expect(isPlainObject(null)).toBe(false);
            expect(isPlainObject("x")).toBe(false);
        });

        test("returns root source for ordinary records", () => {
            expect(getRecordSources({ id: 1 })).toEqual([
                { name: "root", value: { id: 1 } }
            ]);
        });

        test("discovers nested ArcGIS and GeoJSON-like containers", () => {
            const record = {
                id: 1,
                attr: { ADI: "A" },
                attributes: { ADI: "B" },
                properties: { ADI: "C" }
            };
            expect(getRecordSources(record).map(item => item.name)).toEqual([
                "root",
                "attr",
                "attributes",
                "properties"
            ]);
        });

        test("ignores non-object nested containers", () => {
            const record = { id: 1, attr: null, attributes: [], properties: "bad" };
            expect(getRecordSources(record).map(item => item.name)).toEqual(["root"]);
        });

        test("inspects field shapes without treating container names as data fields", () => {
            const shape = inspectRecordShape({
                id: 1,
                attr: { ADI: "Park", KOD: "A" },
                properties: { adres: "Kızılay", extra: 5 }
            });
            expect(shape.sources).toEqual(["root", "attr", "properties"]);
            expect(shape.fields).toEqual(["ADI", "KOD", "adres", "extra", "id"]);
            expect(shape.bySource.root).toEqual(["attr", "id", "properties"]);
            expect(shape.bySource.attr).toEqual(["ADI", "KOD"]);
        });

        test("returns an empty shape for invalid records", () => {
            expect(inspectRecordShape(null)).toEqual({
                sources: [],
                fields: [],
                bySource: {}
            });
        });
    });

    describe("alias resolution", () => {
        test("prefers root aliases before nested containers", () => {
            const result = readAliasedValue({
                title: "Root",
                attr: { title: "Nested" }
            }, ["title"]);
            expect(result).toEqual({ value: "Root", alias: "title", source: "root" });
        });

        test("reads aliases from attr", () => {
            const result = readAliasedValue({ attr: { ADI: "Park" } }, ["title", "ADI"]);
            expect(result).toEqual({ value: "Park", alias: "ADI", source: "attr" });
        });

        test("reads aliases from attributes", () => {
            const result = readAliasedValue({ attributes: { OBJECTID: 12 } }, ["id", "OBJECTID"]);
            expect(result).toEqual({ value: 12, alias: "OBJECTID", source: "attributes" });
        });

        test("reads aliases from properties", () => {
            const result = readAliasedValue({ properties: { address: "Ulus" } }, ["address"]);
            expect(result).toEqual({ value: "Ulus", alias: "address", source: "properties" });
        });

        test("skips blank values and keeps valid zero", () => {
            expect(readAliasedValue({ id: "", Id: 0 }, ["id", "Id"])).toEqual({
                value: 0,
                alias: "Id",
                source: "root"
            });
        });

        test("uses deterministic fallback metadata", () => {
            expect(readAliasedValue({}, ["missing"], "fallback")).toEqual({
                value: "fallback",
                alias: null,
                source: null
            });
        });
    });

    describe("primitive normalization", () => {
        test.each([
            [true, true],
            [false, false],
            [1, true],
            [0, false],
            ["true", true],
            ["TRUE", true],
            ["evet", true],
            ["EVET", true],
            ["aktif", true],
            ["yes", true],
            ["false", false],
            ["hayır", false],
            ["pasif", false],
            ["no", false]
        ])("normalizes boolean value %p", (input, expected) => {
            expect(normalizeBoolean(input)).toBe(expected);
        });

        test("returns fallback for ambiguous booleans", () => {
            expect(normalizeBoolean("belki", null)).toBeNull();
            expect(normalizeBoolean(2, false)).toBe(false);
        });

        test("normalizes phone numbers to compact digits", () => {
            expect(normalizePhone("(0312) 123 45 67")).toBe("03121234567");
            expect(normalizePhone("+90 312 123 45 67")).toBe("+903121234567");
            expect(normalizePhone(null)).toBe("");
            expect(normalizePhone("abc")).toBe("");
        });

        test("accepts safe http and https urls", () => {
            expect(normalizeSafeHttpUrl("https://example.com/a?q=1")).toBe("https://example.com/a?q=1");
            expect(normalizeSafeHttpUrl("http://example.com")).toBe("http://example.com/");
        });

        test("keeps relative application urls as relative values", () => {
            expect(normalizeSafeHttpUrl("/Common/FileService.svc/item")).toBe("/Common/FileService.svc/item");
        });

        test("rejects unsafe url schemes", () => {
            expect(normalizeSafeHttpUrl("javascript:alert(1)")).toBe("");
            expect(normalizeSafeHttpUrl("data:text/html,test")).toBe("");
        });

        test("normalizes field types through one dispatcher", () => {
            expect(normalizeFieldValue("  Ankara  ", FIELD_TYPES.Text)).toBe("Ankara");
            expect(normalizeFieldValue(0, FIELD_TYPES.Id)).toBe("0");
            expect(normalizeFieldValue("42", FIELD_TYPES.Integer)).toBe(42);
            expect(normalizeFieldValue("42.5", FIELD_TYPES.Number)).toBe(42.5);
            expect(normalizeFieldValue("evet", FIELD_TYPES.Boolean)).toBe(true);
            expect(normalizeFieldValue(" Park ", FIELD_TYPES.Category)).toBe("Park");
            expect(normalizeFieldValue("39.9", FIELD_TYPES.Latitude)).toBe(39.9);
            expect(normalizeFieldValue("32.8", FIELD_TYPES.Longitude)).toBe(32.8);
            expect(normalizeFieldValue("(312) 1", FIELD_TYPES.Phone)).toBe("3121");
        });

        test("rejects invalid typed numbers and coordinates", () => {
            expect(normalizeFieldValue("42.1", FIELD_TYPES.Integer)).toBeNull();
            expect(normalizeFieldValue("bad", FIELD_TYPES.Number)).toBeNull();
            expect(normalizeFieldValue("91", FIELD_TYPES.Latitude)).toBeNull();
            expect(normalizeFieldValue("181", FIELD_TYPES.Longitude)).toBeNull();
        });
    });

    describe("schema compilation", () => {
        test("merges custom aliases with shared aliases without duplicates", () => {
            const field = createFieldDefinition("title", {
                aliases: ["CUSTOM", "ADI", "CUSTOM"],
                type: FIELD_TYPES.Text,
                required: true,
                facet: true
            });
            expect(field.aliases[0]).toBe("CUSTOM");
            expect(field.aliases.filter(alias => alias === "CUSTOM")).toHaveLength(1);
            expect(field.aliases).toEqual(expect.arrayContaining(["ADI", "title", "name"]));
            expect(field.required).toBe(true);
            expect(field.facet).toBe(true);
        });

        test("compiles searchable, facet and required field lists", () => {
            const schema = compileSchema({
                id: "test",
                version: 3,
                fields: {
                    id: { type: FIELD_TYPES.Id, searchable: false, required: true },
                    title: { required: true },
                    category: { facet: true }
                }
            });
            expect(schema.id).toBe("test");
            expect(schema.version).toBe(3);
            expect(schema.requiredFields).toEqual(["id", "title"]);
            expect(schema.searchableFields).toEqual(["title", "category"]);
            expect(schema.facetFields).toEqual(["category"]);
            expect(schema.fieldMap.get("id")?.type).toBe(FIELD_TYPES.Id);
        });

        test("creates deterministic schema fingerprints", () => {
            const first = createSchemaFingerprint(GENERIC_RECORD_SCHEMA);
            const second = createSchemaFingerprint(GENERIC_RECORD_SCHEMA);
            expect(first).toBe(second);
            expect(first).toContain("title:text:");
            expect(first).toContain("latitude:latitude:");
        });

        test("generic schema includes search and geo fields", () => {
            expect(GENERIC_RECORD_SCHEMA.searchableFields).toEqual(expect.arrayContaining([
                "title",
                "category",
                "type",
                "address",
                "district",
                "neighborhood",
                "street",
                "door",
                "phone"
            ]));
            expect(GENERIC_RECORD_SCHEMA.fieldMap.has("latitude")).toBe(true);
            expect(GENERIC_RECORD_SCHEMA.fieldMap.has("longitude")).toBe(true);
        });

        test("address schema keeps only address-relevant fields", () => {
            expect(ADDRESS_RECORD_SCHEMA.fieldMap.has("district")).toBe(true);
            expect(ADDRESS_RECORD_SCHEMA.fieldMap.has("neighborhood")).toBe(true);
            expect(ADDRESS_RECORD_SCHEMA.fieldMap.has("street")).toBe(true);
            expect(ADDRESS_RECORD_SCHEMA.fieldMap.has("door")).toBe(true);
            expect(ADDRESS_RECORD_SCHEMA.fieldMap.has("phone")).toBe(false);
        });
    });

    describe("schema reads", () => {
        test("normalizes a mixed root and attr record", () => {
            const { output, metadata } = readRecordWithSchema({
                id: 0,
                category: "  Parklar ",
                attr: {
                    ADI: "  Kuğulu   Park ",
                    ADRES: " Kavaklıdere ",
                    TELEFON: "0312 000 00 00",
                    Y: "39.901",
                    X: "32.860"
                }
            });
            expect(output).toEqual(expect.objectContaining({
                id: "0",
                title: "Kuğulu Park",
                category: "Parklar",
                address: "Kavaklıdere",
                phone: "03120000000",
                latitude: 39.901,
                longitude: 32.86
            }));
            expect(metadata.title).toEqual({ alias: "ADI", source: "attr", present: true });
            expect(metadata.id).toEqual({ alias: "id", source: "root", present: true });
        });

        test("reads GeoJSON properties without special casing the caller", () => {
            const { output } = readRecordWithSchema({
                properties: {
                    OBJECTID: 8,
                    NAME: "Kütüphane",
                    KATEGORI: "Kültür",
                    ADRES: "Ulus"
                }
            });
            expect(output.id).toBe("8");
            expect(output.title).toBe("Kütüphane");
            expect(output.category).toBe("Kültür");
            expect(output.address).toBe("Ulus");
        });

        test("uses null defaults for absent scalar fields", () => {
            const { output } = readRecordWithSchema({ title: "X" });
            expect(output.id).toBeNull();
            expect(output.latitude).toBeNull();
            expect(output.longitude).toBeNull();
            expect(output.title).toBe("X");
        });
    });

    describe("validation", () => {
        const schema = compileSchema({
            id: "required",
            fields: {
                id: { type: FIELD_TYPES.Id, required: true, searchable: false },
                title: { required: true },
                category: {
                    validate: value => value === "Park" || "unsupported-category"
                },
                latitude: { type: FIELD_TYPES.Latitude, searchable: false },
                longitude: { type: FIELD_TYPES.Longitude, searchable: false }
            }
        });

        test("marks complete records as valid", () => {
            expect(validateNormalizedRecord({
                id: "1",
                title: "A",
                category: "Park",
                latitude: 39.9,
                longitude: 32.8
            }, schema)).toEqual({ valid: true, issues: [] });
        });

        test("reports every missing required field", () => {
            const result = validateNormalizedRecord({
                id: null,
                title: "",
                category: "Park",
                latitude: null,
                longitude: null
            }, schema);
            expect(result.valid).toBe(false);
            expect(result.issues).toEqual(expect.arrayContaining([
                { code: "required-field-missing", field: "id", severity: "error" },
                { code: "required-field-missing", field: "title", severity: "error" }
            ]));
        });

        test("uses validator string as issue code", () => {
            const result = validateNormalizedRecord({
                id: "1",
                title: "A",
                category: "Other",
                latitude: null,
                longitude: null
            }, schema);
            expect(result.valid).toBe(false);
            expect(result.issues).toContainEqual({
                code: "unsupported-category",
                field: "category",
                severity: "error"
            });
        });

        test("reports partial coordinate pairs as warnings", () => {
            const result = validateNormalizedRecord({
                id: "1",
                title: "A",
                category: "Park",
                latitude: 39.9,
                longitude: null
            }, schema);
            expect(result.valid).toBe(true);
            expect(result.issues).toContainEqual({
                code: "partial-coordinate-pair",
                field: "coordinates",
                severity: "warning"
            });
        });
    });

    describe("search document creation", () => {
        test("creates stable normalized documents", () => {
            const source = {
                attr: {
                    OBJECTID: 9,
                    ADI: "Çankaya Parkı",
                    KATEGORI: "Yeşil Alan",
                    ADRES: "Çiçek Sokak",
                    ILCE_ADI: "Çankaya",
                    MAHALLE_ADI: "Ayrancı",
                    LAT: "39.89",
                    LNG: "32.85"
                }
            };
            const document = createSearchDocumentFromSchema(source, GENERIC_RECORD_SCHEMA, 4);
            expect(document).toEqual(expect.objectContaining({
                id: "9",
                key: "id:9",
                title: "Çankaya Parkı",
                category: "Yeşil Alan",
                categoryKey: "yesil-alan",
                address: "Çiçek Sokak",
                district: "Çankaya",
                neighborhood: "Ayrancı",
                coordinates: { latitude: 39.89, longitude: 32.85 },
                source,
                sourceIndex: 4
            }));
            expect(document.searchText).toContain("cankaya parki");
            expect(document.searchText).toContain("cicek sokak");
            expect(document.validation.valid).toBe(true);
        });

        test("uses semantic fingerprint when server id is absent", () => {
            const document = createSearchDocumentFromSchema({
                ADI: "Park",
                ADRES: "Ulus",
                KATEGORI: "Yeşil Alan",
                LAT: 39.9,
                LNG: 32.8
            });
            expect(document.key).toMatch(/^semantic:/);
        });

        test("falls back to source index only for empty semantic records", () => {
            const document = createSearchDocumentFromSchema({}, GENERIC_RECORD_SCHEMA, 7);
            expect(document.key).toBe("source:7");
        });
    });

    describe("collection normalization and deduplication", () => {
        test("deduplicates records by server id", () => {
            const result = normalizeRecordCollection([
                { id: 1, title: "A" },
                { id: 1, title: "B" },
                { id: 2, title: "C" }
            ]);
            expect(result.documents.map(item => item.id)).toEqual(["1", "2"]);
            expect(result.diagnostics).toEqual(expect.objectContaining({
                inputCount: 3,
                acceptedCount: 2,
                rejectedCount: 1,
                duplicateCount: 1
            }));
            expect(result.rejected[0].reason).toBe("duplicate");
        });

        test("deduplicates id-less records by semantic fingerprint", () => {
            const result = normalizeRecordCollection([
                { title: "Park", address: "Ulus", category: "Yeşil Alan" },
                { title: "PARK", address: "ULUS", category: "YESIL ALAN" }
            ]);
            expect(result.documents).toHaveLength(1);
            expect(result.diagnostics.duplicateCount).toBe(1);
        });

        test("preserves duplicates when explicitly requested", () => {
            const result = normalizeRecordCollection([
                { id: 1, title: "A" },
                { id: 1, title: "B" }
            ], GENERIC_RECORD_SCHEMA, { dedupe: false });
            expect(result.documents).toHaveLength(2);
            expect(result.diagnostics.duplicateCount).toBe(0);
        });

        test("rejects non-object records", () => {
            const result = normalizeRecordCollection([null, "x", [], { id: 1 }]);
            expect(result.documents).toHaveLength(1);
            expect(result.diagnostics.nonObjectCount).toBe(3);
            expect(result.rejected.map(item => item.reason)).toEqual([
                "record-not-object",
                "record-not-object",
                "record-not-object"
            ]);
        });

        test("rejects invalid records for strict required schemas", () => {
            const schema = compileSchema({
                id: "required-title",
                fields: {
                    title: { required: true }
                }
            });
            const result = normalizeRecordCollection([
                { title: "Valid" },
                { title: "" }
            ], schema);
            expect(result.documents).toHaveLength(1);
            expect(result.diagnostics.invalidCount).toBe(1);
            expect(result.rejected[0].reason).toBe("validation-failed");
        });

        test("keeps invalid records for diagnostics when requested", () => {
            const schema = compileSchema({
                id: "required-title",
                fields: {
                    title: { required: true }
                }
            });
            const result = normalizeRecordCollection([{ title: "" }], schema, { keepInvalid: true });
            expect(result.documents).toHaveLength(1);
            expect(result.documents[0].validation.valid).toBe(false);
            expect(result.rejected).toEqual([]);
        });
    });

    describe("schema drift detection", () => {
        test("reports unknown fields and source usage", () => {
            const report = detectSchemaDrift([
                { id: 1, title: "A", legacyCode: "x" },
                { attr: { OBJECTID: 2, ADI: "B", legacyCode: "y" } },
                { properties: { id: 3, name: "C", unexpected: true } }
            ]);
            expect(report.totalRecords).toBe(3);
            expect(report.hasDrift).toBe(true);
            expect(report.unknownFields).toEqual(expect.arrayContaining([
                { name: "legacyCode", count: 2 },
                { name: "unexpected", count: 1 }
            ]));
            expect(report.sourceUsage).toEqual(expect.arrayContaining([
                { name: "root", count: 3 },
                { name: "attr", count: 1 },
                { name: "properties", count: 1 }
            ]));
        });

        test("reports alias usage by canonical field", () => {
            const report = detectSchemaDrift([
                { title: "A" },
                { ADI: "B" },
                { attr: { name: "C" } }
            ]);
            expect(report.aliasUsage).toEqual(expect.arrayContaining([
                { name: "title:title", count: 1 },
                { name: "title:ADI", count: 1 },
                { name: "title:name", count: 1 }
            ]));
        });

        test("reports missing required aliases", () => {
            const schema = compileSchema({
                id: "required",
                fields: {
                    id: { required: true, type: FIELD_TYPES.Id },
                    title: { required: true }
                }
            });
            const report = detectSchemaDrift([
                { id: 1 },
                { title: "A" },
                {}
            ], schema);
            expect(report.missingRequired).toEqual(expect.arrayContaining([
                { name: "id", count: 2 },
                { name: "title", count: 2 }
            ]));
        });

        test("returns clean drift state for known shapes", () => {
            const schema = compileSchema({
                id: "simple",
                fields: {
                    id: { type: FIELD_TYPES.Id },
                    title: {}
                }
            });
            const report = detectSchemaDrift([
                { id: 1, title: "A" },
                { Id: 2, ADI: "B" }
            ], schema);
            expect(report.unknownFields).toEqual([]);
            expect(report.missingRequired).toEqual([]);
            expect(report.hasDrift).toBe(false);
        });
    });

    describe("facets", () => {
        test("builds deterministic normalized facet counts", () => {
            const documents = [
                { category: "Parklar", fields: { category: "Parklar" } },
                { category: "PARKLAR", fields: { category: "PARKLAR" } },
                { category: "Kültür", fields: { category: "Kültür" } }
            ];
            expect(buildFacetCounts(documents, "category")).toEqual([
                { key: "parklar", label: "Parklar", count: 2 },
                { key: "kultur", label: "Kültür", count: 1 }
            ]);
        });

        test("skips empty facet values", () => {
            expect(buildFacetCounts([
                { fields: { category: "" } },
                { fields: { category: null } },
                { fields: { category: "Park" } }
            ], "category")).toEqual([
                { key: "park", label: "Park", count: 1 }
            ]);
        });

        test("can facet direct document fields", () => {
            expect(buildFacetCounts([
                { district: "Çankaya" },
                { district: "Çankaya" },
                { district: "Mamak" }
            ], "district")).toEqual([
                { key: "cankaya", label: "Çankaya", count: 2 },
                { key: "mamak", label: "Mamak", count: 1 }
            ]);
        });
    });

    describe("quality reports", () => {
        test("combines diagnostics, drift, issues and facets", () => {
            const schema = compileSchema({
                id: "quality",
                version: 2,
                fields: {
                    id: { type: FIELD_TYPES.Id, required: true, searchable: false },
                    title: { required: true },
                    category: { facet: true },
                    district: { facet: true },
                    latitude: { type: FIELD_TYPES.Latitude, searchable: false },
                    longitude: { type: FIELD_TYPES.Longitude, searchable: false }
                }
            });
            const report = createSchemaQualityReport([
                { id: 1, title: "A", category: "Park", district: "Çankaya", latitude: 39.9, longitude: 32.8 },
                { id: 2, title: "B", category: "Park", district: "Çankaya", latitude: 39.8 },
                { title: "C", category: "Kültür", district: "Altındağ", legacy: true }
            ], schema);
            expect(report.schemaId).toBe("quality");
            expect(report.schemaVersion).toBe(2);
            expect(report.schemaFingerprint).toContain("id:id:");
            expect(report.diagnostics.inputCount).toBe(3);
            expect(report.drift.hasDrift).toBe(true);
            expect(report.drift.unknownFields).toContainEqual({ name: "legacy", count: 1 });
            expect(report.issues).toEqual(expect.arrayContaining([
                { severity: "warning", code: "partial-coordinate-pair", field: "coordinates", count: 1 },
                { severity: "error", code: "required-field-missing", field: "id", count: 1 }
            ]));
            expect(report.facets.category).toEqual([
                { key: "park", label: "Park", count: 2 },
                { key: "kultur", label: "Kültür", count: 1 }
            ]);
            expect(report.facets.district).toEqual([
                { key: "cankaya", label: "Çankaya", count: 2 },
                { key: "altindag", label: "Altındağ", count: 1 }
            ]);
        });

        test("is stable for empty collections", () => {
            const report = createSchemaQualityReport([], GENERIC_RECORD_SCHEMA);
            expect(report.diagnostics).toEqual({
                inputCount: 0,
                acceptedCount: 0,
                rejectedCount: 0,
                duplicateCount: 0,
                invalidCount: 0,
                nonObjectCount: 0
            });
            expect(report.drift.totalRecords).toBe(0);
            expect(report.issues).toEqual([]);
            expect(report.facets.category).toEqual([]);
        });
    });
});
