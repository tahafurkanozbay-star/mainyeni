import {
    getRecordCategory,
    getRecordId,
    getRecordTitle,
    normalizeSearchCollection,
    normalizeSearchRecord,
    readFirstValue
} from "./QuerySearchRuntime";

describe("QuerySearchRuntime shared icon integration", () => {
    test("normalizes Parklar records with the shared JSON icon", () => {
        const record = normalizeSearchRecord({
            attr: {
                OBJECTID: 1,
                ADI: "Kuğulu Park",
                KATEGORI: "Parklar"
            }
        });
        expect(record.icon).toEqual(expect.objectContaining({
            key: "parklar",
            src: "images/icons/map/ABB/parklar.svg",
            alt: "Kuğulu Park",
            isFallback: false
        }));
    });

    test("normalizes Turkish aliases through the existing resolver", () => {
        const record = normalizeSearchRecord({
            id: 2,
            title: "Kütüphane",
            type: "KUTUPHANE"
        });
        expect(record.icon.key).toBe("kutuphane");
        expect(record.icon.src).toBe("images/icons/map/ABB/kutuphane.svg");
        expect(record.icon.isFallback).toBe(false);
    });

    test("uses deterministic fallback for unknown semantic types", () => {
        const record = normalizeSearchRecord({
            id: 3,
            title: "Yeni Kategori",
            category: "Bilinmeyen Veri Türü"
        });
        expect(record.icon).toEqual(expect.objectContaining({
            key: "default",
            src: "images/icons/map/pictureMarker.png",
            isFallback: true
        }));
    });

    test("uses explicit service-title icon aliases", () => {
        const record = normalizeSearchRecord({
            id: 4,
            title: "WiFi Noktası",
            serviceTitle: "YeniWifiNoktalariQeryUrl"
        });
        expect(record.icon.key).toBe("wifi");
        expect(record.icon.src).toBe("images/icons/map/ABB/wifierisimnoktalari.svg");
    });

    test("reads the attributes container in addition to root/attr/properties", () => {
        const source = {
            attributes: {
                OBJECTID: 42,
                ADI: "Acil Toplanma Alanı",
                KATEGORI: "Acil Toplanma Alanları"
            }
        };
        expect(readFirstValue(source, ["OBJECTID"])).toBe(42);
        expect(getRecordId(source)).toBe(42);
        expect(getRecordTitle(source)).toBe("Acil Toplanma Alanı");
        expect(getRecordCategory(source)).toBe("Acil Toplanma Alanları");
        expect(normalizeSearchRecord(source).icon.key).toBe("aciltoplanma");
    });

    test("preserves zero ids while resolving icons", () => {
        const record = normalizeSearchRecord({
            id: 0,
            title: "Eczane",
            category: "Eczaneler"
        });
        expect(record.id).toBe(0);
        expect(record.key).toBe("id:0");
        expect(record.icon.key).toBe("eczane");
    });

    test("normalizes collections with per-record shared icons", () => {
        const result = normalizeSearchCollection([
            { id: 1, title: "Park", category: "Parklar" },
            { id: 2, title: "Taksi", type: "taksi durağı" },
            { id: 3, title: "Unknown", category: "Bilinmeyen" }
        ]);
        expect(result.map(item => item.icon.key)).toEqual([
            "parklar",
            "taksi",
            "default"
        ]);
    });
});
