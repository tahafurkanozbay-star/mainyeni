import {
    DEFAULT_SPATIAL_CELL_SIZE_DEGREES,
    MAX_SPATIAL_RESULT_LIMIT,
    SPATIAL_INDEX_VERSION,
    createAdaptiveSpatialCellSize,
    createAdaptiveSpatialIndex,
    createSpatialCellKey,
    createSpatialDocumentFingerprint,
    createSpatialIndex,
    createSpatialIndexQualityReport,
    createSpatialIndexSnapshot,
    enumerateSpatialCells,
    getCellRangeForBounds,
    getPositionsForSpatialCells,
    getSpatialCellBounds,
    latitudeToCellY,
    longitudeToCellX,
    normalizeSpatialCellSize,
    normalizeSpatialLimit,
    normalizeSpatialMaxCells,
    parseSpatialCellKey,
    queryNearestSpatial,
    querySpatialBounds,
    querySpatialRadius,
    resolveDocumentCoordinates,
    restoreSpatialIndexSnapshot,
    validateSpatialIndex
} from "./SpatialSearchIndexRuntime";
import { createBoundingBox } from "./AddressSearchRuntime";

const documents = [
    {
        id: "ankara-center",
        title: "Kızılay",
        coordinates: { latitude: 39.92077, longitude: 32.85411 }
    },
    {
        id: "guvenpark",
        title: "Güvenpark",
        latitude: 39.91965,
        longitude: 32.85334
    },
    {
        id: "tunali",
        title: "Tunalı Hilmi",
        fields: { latitude: 39.9094, longitude: 32.8613 }
    },
    {
        id: "ulus",
        title: "Ulus",
        geometry: { x: 32.8542, y: 39.9417 }
    },
    {
        id: "invalid",
        title: "Invalid coordinate",
        coordinates: { latitude: 120, longitude: 300 }
    },
    {
        id: "missing",
        title: "No coordinate"
    }
];

describe("SpatialSearchIndexRuntime", () => {
    test("publishes stable version and sane bounds", () => {
        expect(SPATIAL_INDEX_VERSION).toBe("1.0.0");
        expect(DEFAULT_SPATIAL_CELL_SIZE_DEGREES).toBeGreaterThan(0);
        expect(MAX_SPATIAL_RESULT_LIMIT).toBeGreaterThan(100);
    });

    test("normalizes cell, result and enumeration budgets", () => {
        expect(normalizeSpatialCellSize(-1)).toBeGreaterThan(0);
        expect(normalizeSpatialCellSize(100)).toBeLessThanOrEqual(5);
        expect(normalizeSpatialLimit(0)).toBeGreaterThan(0);
        expect(normalizeSpatialLimit(999999)).toBe(MAX_SPATIAL_RESULT_LIMIT);
        expect(normalizeSpatialMaxCells(-10)).toBeGreaterThan(0);
    });

    test("maps WGS84 coordinates to deterministic grid cells", () => {
        const point = { latitude: 39.92077, longitude: 32.85411 };
        const size = 0.01;
        expect(longitudeToCellX(point.longitude, size)).toBeGreaterThan(0);
        expect(latitudeToCellY(point.latitude, size)).toBeGreaterThan(0);
        const key = createSpatialCellKey(point, size);
        expect(key).toMatch(/^\d+:\d+$/);
        expect(parseSpatialCellKey(key)).toEqual(expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number)
        }));
        expect(parseSpatialCellKey("broken")).toBeNull();
    });

    test("returns geometric bounds for a cell", () => {
        const point = { latitude: 39.92077, longitude: 32.85411 };
        const key = createSpatialCellKey(point, 0.01);
        const bounds = getSpatialCellBounds(key, 0.01);
        expect(bounds.minLatitude).toBeLessThanOrEqual(point.latitude);
        expect(bounds.maxLatitude).toBeGreaterThanOrEqual(point.latitude);
        expect(bounds.minLongitude).toBeLessThanOrEqual(point.longitude);
        expect(bounds.maxLongitude).toBeGreaterThanOrEqual(point.longitude);
    });

    test("resolves coordinates from normalized, field and ArcGIS-like shapes", () => {
        expect(resolveDocumentCoordinates(documents[0])).toEqual({ latitude: 39.92077, longitude: 32.85411 });
        expect(resolveDocumentCoordinates(documents[1])).toEqual({ latitude: 39.91965, longitude: 32.85334 });
        expect(resolveDocumentCoordinates(documents[2])).toEqual({ latitude: 39.9094, longitude: 32.8613 });
        expect(resolveDocumentCoordinates(documents[3])).toEqual({ latitude: 39.9417, longitude: 32.8542 });
        expect(resolveDocumentCoordinates(documents[4])).toBeNull();
        expect(resolveDocumentCoordinates(documents[5])).toBeNull();
    });

    test("creates deterministic spatial fingerprints", () => {
        expect(createSpatialDocumentFingerprint(documents[0]))
            .toBe("ankara-center@32.8541100,39.9207700");
        expect(createSpatialDocumentFingerprint(documents[5])).toBeNull();
    });

    test("indexes valid points and reports invalid coordinate coverage", () => {
        const index = createSpatialIndex(documents, { cellSizeDegrees: 0.01 });
        expect(index.version).toBe(SPATIAL_INDEX_VERSION);
        expect(index.documents).toHaveLength(documents.length);
        expect(index.coordinatesByPosition.size).toBe(4);
        expect(index.diagnostics.invalidCoordinateCount).toBe(2);
        expect(index.diagnostics.cellCount).toBeGreaterThan(0);
        expect(index.diagnostics.indexedCount).toBe(4);
    });

    test("detects duplicate coordinate fingerprints without dropping records", () => {
        const duplicated = createSpatialIndex([documents[0], { ...documents[0] }]);
        expect(duplicated.documents).toHaveLength(2);
        expect(duplicated.diagnostics.duplicateFingerprintCount).toBe(1);
        expect(duplicated.positionsByFingerprint.values().next().value.size).toBe(2);
    });

    test("computes cell ranges for bounding boxes", () => {
        const bounds = createBoundingBox({ latitude: 39.92, longitude: 32.85 }, 1000);
        const range = getCellRangeForBounds(bounds, 0.01);
        expect(range.maxX).toBeGreaterThanOrEqual(range.minX);
        expect(range.maxY).toBeGreaterThanOrEqual(range.minY);
    });

    test("enumerates cells with a hard maximum", () => {
        const bounds = {
            minLongitude: 30,
            maxLongitude: 35,
            minLatitude: 38,
            maxLatitude: 42
        };
        const result = enumerateSpatialCells(bounds, {
            cellSizeDegrees: 0.01,
            maxCells: 25
        });
        expect(result.keys).toHaveLength(25);
        expect(result.truncated).toBe(true);
        expect(result.estimatedCount).toBeGreaterThan(25);
    });

    test("collects candidate positions from selected cells without duplicates", () => {
        const index = createSpatialIndex(documents, { cellSizeDegrees: 0.01 });
        const keys = Array.from(index.cells.keys());
        const positions = getPositionsForSpatialCells(index, [...keys, ...keys]);
        expect(positions.size).toBe(index.coordinatesByPosition.size);
    });

    test("queries exact bounds after coarse grid filtering", () => {
        const index = createSpatialIndex(documents, { cellSizeDegrees: 0.01 });
        const bounds = createBoundingBox({ latitude: 39.92077, longitude: 32.85411 }, 300);
        const result = querySpatialBounds(index, bounds);
        const ids = result.results.map(item => item.document.id);
        expect(ids).toEqual(expect.arrayContaining(["ankara-center", "guvenpark"]));
        expect(ids).not.toContain("ulus");
        expect(result.diagnostics.candidateCount).toBeGreaterThanOrEqual(result.results.length);
    });

    test("queries radius using exact haversine filtering", () => {
        const index = createSpatialIndex(documents, { cellSizeDegrees: 0.01 });
        const result = querySpatialRadius(index, [32.85411, 39.92077], 300, { limit: 10 });
        const ids = result.results.map(item => item.document.id);
        expect(ids[0]).toBe("ankara-center");
        expect(ids).toContain("guvenpark");
        expect(ids).not.toContain("tunali");
        expect(result.results[0].distanceMeters).toBeCloseTo(0, 6);
        expect(result.page.hasMore).toBe(false);
    });

    test("returns bounded nearest results in ascending distance order", () => {
        const index = createSpatialIndex(documents, { cellSizeDegrees: 0.01 });
        const result = queryNearestSpatial(index, [32.85411, 39.92077], {
            radiusMeters: 5000,
            limit: 3
        });
        expect(result.results).toHaveLength(3);
        expect(result.results[1].distanceMeters).toBeGreaterThanOrEqual(result.results[0].distanceMeters);
        expect(result.results[2].distanceMeters).toBeGreaterThanOrEqual(result.results[1].distanceMeters);
    });

    test("rejects invalid centers and non-positive radii without throwing", () => {
        const index = createSpatialIndex(documents);
        expect(querySpatialRadius(index, "invalid", 1000).results).toEqual([]);
        expect(querySpatialRadius(index, [32.85, 39.92], 0).results).toEqual([]);
    });

    test.each([
        [100, 0.025],
        [5000, 0.01],
        [50000, 0.005],
        [250000, 0.0025]
    ])("selects adaptive cell size for %s records", (count, expected) => {
        const input = Array.from({ length: count }, () => null);
        expect(createAdaptiveSpatialCellSize(input)).toBe(expected);
    });

    test("honors explicit adaptive cell-size preference", () => {
        expect(createAdaptiveSpatialCellSize(documents, { preferredCellSizeDegrees: 0.02 })).toBe(0.02);
        expect(createAdaptiveSpatialIndex(documents, { preferredCellSizeDegrees: 0.02 }).cellSize).toBe(0.02);
    });

    test("validates index consistency", () => {
        const index = createSpatialIndex(documents, { cellSizeDegrees: 0.01 });
        expect(validateSpatialIndex(index)).toEqual([]);
        const firstCell = index.cells.keys().next().value;
        index.cells.get(firstCell).add(999);
        expect(validateSpatialIndex(index)).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "position-out-of-range", severity: "error" })
        ]));
    });

    test("creates a quality report with coverage and load metrics", () => {
        const index = createSpatialIndex(documents, { cellSizeDegrees: 0.01 });
        const report = createSpatialIndexQualityReport(index);
        expect(report).toEqual(expect.objectContaining({
            totalCount: 6,
            indexedCount: 4,
            coverageRatio: 4 / 6,
            invalidCoordinateCount: 2,
            issueCount: 0
        }));
        expect(report.cellCount).toBeGreaterThan(0);
    });

    test("snapshots and restores deterministic spatial configuration", () => {
        const index = createSpatialIndex(documents, { cellSizeDegrees: 0.02 });
        const snapshot = createSpatialIndexSnapshot(index);
        expect(snapshot.version).toBe(SPATIAL_INDEX_VERSION);
        expect(snapshot.cellSize).toBe(0.02);
        expect(snapshot.cells.length).toBe(index.cells.size);
        const restored = restoreSpatialIndexSnapshot(documents, snapshot);
        expect(restored).not.toBeNull();
        expect(restored.cellSize).toBe(0.02);
        expect(validateSpatialIndex(restored)).toEqual([]);
    });

    test("rejects incompatible snapshots", () => {
        expect(restoreSpatialIndexSnapshot(documents, { version: "0" })).toBeNull();
        expect(restoreSpatialIndexSnapshot(documents, null)).toBeNull();
    });
});