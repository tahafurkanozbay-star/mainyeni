import {
    createIconCoverageReport,
    createPresentationFacets,
    createPresentationPage,
    createRecordPresentation,
    createRecordPresentations,
    createSharedIconCandidate,
    createSharedMapModels,
    filterPresentations,
    resolveSharedRecordIcon
} from "./RecordPresentationRuntime";

describe("RecordPresentationRuntime", () => {
    describe("shared icon candidates", () => {
        test("reads type and category from root records", () => {
            expect(createSharedIconCandidate({
                id: 1,
                type: "park",
                category: "Parklar"
            })).toEqual(expect.objectContaining({
                id: "1",
                type: "park",
                category: "Parklar"
            }));
        });

        test("reads semantic candidates from ArcGIS attr records", () => {
            expect(createSharedIconCandidate({
                attr: {
                    OBJECTID: 12,
                    ADI: "Eczane",
                    KATEGORI: "Eczaneler",
                    type: "eczane"
                }
            })).toEqual(expect.objectContaining({
                id: "12",
                type: "eczane",
                category: "Eczaneler"
            }));
        });

        test("reads explicit icon keys without creating another mapping authority", () => {
            expect(createSharedIconCandidate({
                title: "WiFi",
                serviceTitle: "YeniWifiNoktalariQeryUrl"
            })).toEqual(expect.objectContaining({
                iconKey: "YeniWifiNoktalariQeryUrl"
            }));
        });

        test("keeps zero identifiers", () => {
            expect(createSharedIconCandidate({ id: 0, category: "Parklar" }).id).toBe("0");
        });
    });

    describe("shared resolver integration", () => {
        test("resolves Parklar from the shared JSON registry", () => {
            const resolved = resolveSharedRecordIcon({
                title: "Park",
                category: "Parklar"
            });
            expect(resolved.id).toBe("parklar");
            expect(resolved.url).toBe("images/icons/map/ABB/parklar.svg");
            expect(resolved.isFallback).toBe(false);
        });

        test("resolves Turkish diacritic-insensitive aliases", () => {
            const resolved = resolveSharedRecordIcon({
                title: "Kütüphane",
                type: "KUTUPHANE"
            });
            expect(resolved.id).toBe("kutuphane");
            expect(resolved.url).toBe("images/icons/map/ABB/kutuphane.svg");
            expect(resolved.isFallback).toBe(false);
        });

        test("resolves service-title aliases from iconKey", () => {
            const resolved = resolveSharedRecordIcon({
                title: "Kablosuz Ağ",
                iconKey: "YeniWifiNoktalariQeryUrl"
            });
            expect(resolved.id).toBe("wifi");
            expect(resolved.url).toBe("images/icons/map/ABB/wifierisimnoktalari.svg");
        });

        test("resolves case-insensitive emergency assembly aliases", () => {
            const resolved = resolveSharedRecordIcon({
                type: "ASSEMBLY AREA"
            });
            expect(resolved.id).toBe("aciltoplanma");
            expect(resolved.isFallback).toBe(false);
        });

        test("resolves pharmacy aliases with Turkish diacritics", () => {
            const resolved = resolveSharedRecordIcon({
                type: "NÖBETÇİ ECZANE"
            });
            expect(resolved.id).toBe("eczane");
            expect(resolved.url).toBe("images/icons/sidebar/eczane.png");
        });

        test("uses the shared default fallback for unknown records", () => {
            const resolved = resolveSharedRecordIcon({
                type: "bilinmeyen yeni kategori"
            });
            expect(resolved.id).toBe("default");
            expect(resolved.url).toBe("images/icons/map/pictureMarker.png");
            expect(resolved.isFallback).toBe(true);
        });

        test("reports fallback through the existing resolver callback", () => {
            const onFallback = vi.fn();
            resolveSharedRecordIcon({ type: "unknown-x" }, { onFallback });
            expect(onFallback).toHaveBeenCalledTimes(1);
            expect(onFallback.mock.calls[0][0]).toEqual(expect.objectContaining({
                fallback: "default"
            }));
        });
    });

    describe("record presentation", () => {
        test("normalizes data and icon metadata in one model", () => {
            const source = {
                attr: {
                    OBJECTID: 9,
                    ADI: "Kuğulu Park",
                    KATEGORI: "Parklar",
                    ADRES: "Kavaklıdere",
                    ILCE_ADI: "Çankaya",
                    LAT: "39.901",
                    LNG: "32.860"
                }
            };
            const presentation = createRecordPresentation(source, 4);
            expect(presentation).toEqual(expect.objectContaining({
                id: "9",
                key: "id:9",
                title: "Kuğulu Park",
                subtitle: "Kavaklıdere",
                address: "Kavaklıdere",
                category: "Parklar",
                categoryKey: "parklar",
                coordinates: { latitude: 39.901, longitude: 32.86 },
                source,
                sourceIndex: 4
            }));
            expect(presentation.icon).toEqual(expect.objectContaining({
                key: "parklar",
                src: "images/icons/map/ABB/parklar.svg",
                alt: "Kuğulu Park",
                isFallback: false
            }));
            expect(presentation.searchText).toContain("kugulu park");
            expect(presentation.searchText).toContain("kavaklidere");
        });

        test("uses readable title and category fallbacks", () => {
            const presentation = createRecordPresentation({ type: "unknown-x" });
            expect(presentation.title).toBe("İsimsiz kayıt");
            expect(presentation.category).toBe("unknown-x");
            expect(presentation.icon.isFallback).toBe(true);
        });

        test("uses Diğer when no semantic category or type exists", () => {
            const presentation = createRecordPresentation({ title: "Kayıt" });
            expect(presentation.category).toBe("Diğer");
            expect(presentation.categoryKey).toBe("diger");
        });

        test("normalizes an invalid collection to an empty presentation list", () => {
            expect(createRecordPresentations(null)).toEqual([]);
        });

        test("creates presentation models for a record collection", () => {
            const result = createRecordPresentations([
                { id: 1, title: "Park", category: "Parklar" },
                { id: 2, title: "Eczane", category: "Eczaneler" }
            ]);
            expect(result).toHaveLength(2);
            expect(result.map(item => item.icon.key)).toEqual(["parklar", "eczane"]);
        });
    });

    describe("facets", () => {
        const presentations = createRecordPresentations([
            { id: 1, title: "Park A", category: "Parklar" },
            { id: 2, title: "Park B", category: "Parklar" },
            { id: 3, title: "Eczane", category: "Eczaneler" },
            { id: 4, title: "Unknown", category: "Yeni Bilinmeyen Tür" }
        ]);

        test("counts normalized categories", () => {
            expect(createPresentationFacets(presentations).categories).toEqual([
                { key: "parklar", label: "Parklar", count: 2 },
                { key: "eczaneler", label: "Eczaneler", count: 1 },
                { key: "yeni-bilinmeyen-tur", label: "Yeni Bilinmeyen Tür", count: 1 }
            ]);
        });

        test("counts shared icon keys", () => {
            expect(createPresentationFacets(presentations).icons).toEqual(expect.arrayContaining([
                {
                    key: "parklar",
                    src: "images/icons/map/ABB/parklar.svg",
                    count: 2,
                    fallbackCount: 0
                },
                {
                    key: "default",
                    src: "images/icons/map/pictureMarker.png",
                    count: 1,
                    fallbackCount: 1
                }
            ]));
        });

        test("reports fallback icon count", () => {
            expect(createPresentationFacets(presentations).fallbackIconCount).toBe(1);
        });

        test("handles empty presentation collections", () => {
            expect(createPresentationFacets(null)).toEqual({
                categories: [],
                icons: [],
                fallbackIconCount: 0
            });
        });
    });

    describe("presentation filtering", () => {
        const presentations = createRecordPresentations([
            { id: 1, title: "Kuğulu Park", category: "Parklar", address: "Kavaklıdere" },
            { id: 2, title: "Seğmenler Parkı", category: "Parklar", address: "Çankaya" },
            { id: 3, title: "Eczane", category: "Eczaneler", address: "Kızılay" },
            { id: 4, title: "Unknown", category: "Yeni Tür", address: "Ulus" }
        ]);

        test("filters by normalized query", () => {
            expect(filterPresentations(presentations, { query: "kugulu" }).map(item => item.id)).toEqual(["1"]);
        });

        test("filters query with Turkish diacritics", () => {
            expect(filterPresentations(presentations, { query: "KIZILAY" }).map(item => item.id)).toEqual(["3"]);
        });

        test("filters by normalized category", () => {
            expect(filterPresentations(presentations, { category: "PARKLAR" }).map(item => item.id)).toEqual(["1", "2"]);
        });

        test("filters by shared icon key", () => {
            expect(filterPresentations(presentations, { iconKey: "eczane" }).map(item => item.id)).toEqual(["3"]);
        });

        test("filters fallback-only records", () => {
            expect(filterPresentations(presentations, { fallbackOnly: true }).map(item => item.id)).toEqual(["4"]);
        });

        test("combines filters", () => {
            expect(filterPresentations(presentations, {
                query: "park",
                category: "Parklar",
                iconKey: "parklar"
            })).toHaveLength(2);
        });

        test("returns every record when filters are empty", () => {
            expect(filterPresentations(presentations, {})).toEqual(presentations);
        });
    });

    describe("pagination", () => {
        const presentations = createRecordPresentations(Array.from({ length: 12 }, (_, index) => ({
            id: index + 1,
            title: `Park ${index + 1}`,
            category: "Parklar"
        })));

        test("creates progress-safe pages", () => {
            const first = createPresentationPage(presentations, { limit: 5 });
            const second = createPresentationPage(presentations, {
                limit: 5,
                offset: first.page.nextOffset
            });
            expect(first.page).toEqual({
                offset: 0,
                limit: 5,
                count: 5,
                total: 12,
                hasMore: true,
                nextOffset: 5
            });
            expect(second.page.offset).toBe(5);
            expect(second.items[0].id).toBe("6");
        });

        test("closes the final page", () => {
            const result = createPresentationPage(presentations, { limit: 20 });
            expect(result.page.count).toBe(12);
            expect(result.page.hasMore).toBe(false);
            expect(result.page.nextOffset).toBeNull();
        });

        test("applies filters before paging and facets", () => {
            const mixed = createRecordPresentations([
                { id: 1, title: "Park 1", category: "Parklar" },
                { id: 2, title: "Park 2", category: "Parklar" },
                { id: 3, title: "Eczane", category: "Eczaneler" }
            ]);
            const result = createPresentationPage(mixed, {
                category: "Parklar",
                limit: 1
            });
            expect(result.page.total).toBe(2);
            expect(result.items).toHaveLength(1);
            expect(result.facets.categories).toEqual([
                { key: "parklar", label: "Parklar", count: 2 }
            ]);
        });

        test("normalizes invalid pagination values", () => {
            expect(createPresentationPage(presentations, {
                offset: -10,
                limit: 0
            }).page).toEqual(expect.objectContaining({
                offset: 0,
                limit: 1
            }));
        });
    });

    describe("icon coverage", () => {
        test("reports full icon coverage", () => {
            const presentations = createRecordPresentations([
                { id: 1, title: "Park", category: "Parklar" },
                { id: 2, title: "Eczane", category: "Eczaneler" },
                { id: 3, title: "Metro", type: "metro hattı" }
            ]);
            const report = createIconCoverageReport(presentations);
            expect(report.total).toBe(3);
            expect(report.matched).toBe(3);
            expect(report.fallback).toBe(0);
            expect(report.coverageRatio).toBe(1);
            expect(report.fallbackRecords).toEqual([]);
        });

        test("reports unknown category records without hiding them", () => {
            const presentations = createRecordPresentations([
                { id: 1, title: "Park", category: "Parklar" },
                { id: 2, title: "Unknown", category: "Yeni Tür" }
            ]);
            const report = createIconCoverageReport(presentations);
            expect(report.total).toBe(2);
            expect(report.matched).toBe(1);
            expect(report.fallback).toBe(1);
            expect(report.coverageRatio).toBe(0.5);
            expect(report.fallbackRecords[0]).toEqual(expect.objectContaining({
                id: "2",
                title: "Unknown",
                category: "Yeni Tür"
            }));
        });

        test("empty collections have complete vacuous coverage", () => {
            expect(createIconCoverageReport([])).toEqual(expect.objectContaining({
                total: 0,
                matched: 0,
                fallback: 0,
                coverageRatio: 1,
                fallbackRecords: []
            }));
        });
    });

    describe("shared 2D/3D/list map models", () => {
        test("uses the same shared icon key in every presentation mode", () => {
            const models = createSharedMapModels({
                id: 1,
                title: "Eczane",
                category: "Eczaneler"
            });
            expect(models.iconKey).toBe("eczane");
            expect(models.list.key).toBe("eczane");
            expect(models.graphic3D.iconKey).toBe("eczane");
            expect(models.marker2D.url).toBe("images/icons/sidebar/eczane.png");
            expect(models.list.src).toBe(models.marker2D.url);
            expect(models.graphic3D.billboard).toBe(models.marker2D.url);
        });

        test("uses identical fallback icon state across modes", () => {
            const models = createSharedMapModels({
                id: 1,
                title: "Unknown",
                category: "Yeni Tür"
            });
            expect(models.iconKey).toBe("default");
            expect(models.list.key).toBe("default");
            expect(models.list.isFallback).toBe(true);
            expect(models.graphic3D.iconKey).toBe("default");
            expect(models.graphic3D.isFallback).toBe(true);
            expect(models.marker2D.url).toBe("images/icons/map/pictureMarker.png");
        });

        test("supports deterministic marker sizing without changing the icon mapping", () => {
            const zoomedIn = createSharedMapModels({ category: "Parklar" }, {
                zoom: 12,
                minSize: 24,
                maxSize: 48,
                zoomThreshold: 10
            });
            const zoomedOut = createSharedMapModels({ category: "Parklar" }, {
                zoom: 8,
                minSize: 24,
                maxSize: 48,
                zoomThreshold: 10
            });
            expect(zoomedIn.iconKey).toBe("parklar");
            expect(zoomedOut.iconKey).toBe("parklar");
            expect(zoomedIn.marker2D.width).toBe("24px");
            expect(zoomedOut.marker2D.width).toBe("48px");
        });
    });
});
