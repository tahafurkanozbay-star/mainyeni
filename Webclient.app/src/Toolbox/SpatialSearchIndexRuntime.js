import {
    normalizeFiniteNumber,
    normalizeInteger,
    normalizeText
} from "./DataIntegrityHelper";
import {
    createBoundingBox,
    haversineDistanceMeters,
    isInsideBoundingBox,
    parseCoordinatePair
} from "./AddressSearchRuntime";

export const SPATIAL_INDEX_VERSION = "1.0.0";
export const DEFAULT_SPATIAL_CELL_SIZE_DEGREES = 0.01;
export const MIN_SPATIAL_CELL_SIZE_DEGREES = 0.0001;
export const MAX_SPATIAL_CELL_SIZE_DEGREES = 5;
export const DEFAULT_SPATIAL_RESULT_LIMIT = 50;
export const MAX_SPATIAL_RESULT_LIMIT = 5000;
export const DEFAULT_SPATIAL_MAX_CELLS = 4096;
export const MAX_SPATIAL_MAX_CELLS = 50000;

const asArray = value => Array.isArray(value) ? value : [];
const unique = values => Array.from(new Set(values));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const normalizeSpatialCellSize = value => {
    const numeric = normalizeFiniteNumber(value, DEFAULT_SPATIAL_CELL_SIZE_DEGREES);
    return clamp(
        numeric || DEFAULT_SPATIAL_CELL_SIZE_DEGREES,
        MIN_SPATIAL_CELL_SIZE_DEGREES,
        MAX_SPATIAL_CELL_SIZE_DEGREES
    );
};

export const normalizeSpatialLimit = value => normalizeInteger(value, {
    min: 1,
    max: MAX_SPATIAL_RESULT_LIMIT,
    fallback: DEFAULT_SPATIAL_RESULT_LIMIT
});

export const normalizeSpatialMaxCells = value => normalizeInteger(value, {
    min: 1,
    max: MAX_SPATIAL_MAX_CELLS,
    fallback: DEFAULT_SPATIAL_MAX_CELLS
});

export const longitudeToCellX = (longitude, cellSize) => Math.floor((longitude + 180) / cellSize);
export const latitudeToCellY = (latitude, cellSize) => Math.floor((latitude + 90) / cellSize);

export const createSpatialCellKey = (coordinates, cellSize = DEFAULT_SPATIAL_CELL_SIZE_DEGREES) => {
    const point = parseCoordinatePair(coordinates);
    if (!point) return null;
    const size = normalizeSpatialCellSize(cellSize);
    return `${longitudeToCellX(point.longitude, size)}:${latitudeToCellY(point.latitude, size)}`;
};

export const parseSpatialCellKey = key => {
    const [x, y] = normalizeText(key).split(":").map(value => Number.parseInt(value, 10));
    if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
    return { x, y };
};

export const getSpatialCellBounds = (key, cellSize = DEFAULT_SPATIAL_CELL_SIZE_DEGREES) => {
    const cell = parseSpatialCellKey(key);
    if (!cell) return null;
    const size = normalizeSpatialCellSize(cellSize);
    const minLongitude = cell.x * size - 180;
    const minLatitude = cell.y * size - 90;
    return {
        minLongitude,
        maxLongitude: Math.min(180, minLongitude + size),
        minLatitude,
        maxLatitude: Math.min(90, minLatitude + size)
    };
};

export const resolveDocumentCoordinates = document => parseCoordinatePair(
    document?.coordinates
    || document?.geometry
    || {
        latitude: document?.latitude ?? document?.fields?.latitude,
        longitude: document?.longitude ?? document?.fields?.longitude
    }
);

export const createSpatialDocumentFingerprint = document => {
    const coordinates = resolveDocumentCoordinates(document);
    if (!coordinates) return null;
    const id = document?.key ?? document?.id ?? document?.sourceIndex ?? "unknown";
    return `${String(id)}@${coordinates.longitude.toFixed(7)},${coordinates.latitude.toFixed(7)}`;
};

export const createSpatialIndex = (documents, options = {}) => {
    const cellSize = normalizeSpatialCellSize(options.cellSizeDegrees);
    const cells = new Map();
    const positionsByFingerprint = new Map();
    const coordinatesByPosition = new Map();
    const invalidPositions = [];
    const duplicateFingerprints = [];
    const source = asArray(documents);

    source.forEach((document, position) => {
        const coordinates = resolveDocumentCoordinates(document);
        if (!coordinates) {
            invalidPositions.push(position);
            return;
        }
        const cellKey = createSpatialCellKey(coordinates, cellSize);
        if (!cells.has(cellKey)) cells.set(cellKey, new Set());
        cells.get(cellKey).add(position);
        coordinatesByPosition.set(position, coordinates);
        const fingerprint = createSpatialDocumentFingerprint(document);
        if (fingerprint) {
            if (positionsByFingerprint.has(fingerprint)) duplicateFingerprints.push(fingerprint);
            if (!positionsByFingerprint.has(fingerprint)) positionsByFingerprint.set(fingerprint, new Set());
            positionsByFingerprint.get(fingerprint).add(position);
        }
    });

    const cellLoads = Array.from(cells.values()).map(set => set.size);
    const maxCellLoad = cellLoads.length ? Math.max(...cellLoads) : 0;
    const minCellLoad = cellLoads.length ? Math.min(...cellLoads) : 0;
    const averageCellLoad = cellLoads.length
        ? cellLoads.reduce((total, value) => total + value, 0) / cellLoads.length
        : 0;
    return {
        version: SPATIAL_INDEX_VERSION,
        documents: source,
        cellSize,
        cells,
        coordinatesByPosition,
        positionsByFingerprint,
        diagnostics: {
            totalCount: source.length,
            indexedCount: coordinatesByPosition.size,
            invalidCoordinateCount: invalidPositions.length,
            invalidPositions,
            cellCount: cells.size,
            maxCellLoad,
            minCellLoad,
            averageCellLoad,
            duplicateFingerprintCount: unique(duplicateFingerprints).length,
            duplicateFingerprints: unique(duplicateFingerprints)
        }
    };
};

export const getCellRangeForBounds = (bounds, cellSize = DEFAULT_SPATIAL_CELL_SIZE_DEGREES) => {
    if (!bounds) return null;
    const size = normalizeSpatialCellSize(cellSize);
    const minX = longitudeToCellX(clamp(bounds.minLongitude, -180, 180), size);
    const maxX = longitudeToCellX(clamp(bounds.maxLongitude, -180, 180), size);
    const minY = latitudeToCellY(clamp(bounds.minLatitude, -90, 90), size);
    const maxY = latitudeToCellY(clamp(bounds.maxLatitude, -90, 90), size);
    return { minX, maxX, minY, maxY };
};

export const enumerateSpatialCells = (bounds, options = {}) => {
    const size = normalizeSpatialCellSize(options.cellSizeDegrees);
    const maxCells = normalizeSpatialMaxCells(options.maxCells);
    const range = getCellRangeForBounds(bounds, size);
    if (!range) return { keys: [], truncated: false, estimatedCount: 0 };
    const estimatedCount = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    const keys = [];
    let truncated = false;
    for (let y = range.minY; y <= range.maxY; y += 1) {
        for (let x = range.minX; x <= range.maxX; x += 1) {
            if (keys.length >= maxCells) {
                truncated = true;
                break;
            }
            keys.push(`${x}:${y}`);
        }
        if (truncated) break;
    }
    return { keys, truncated, estimatedCount };
};

export const getPositionsForSpatialCells = (index, cellKeys) => {
    const positions = new Set();
    asArray(cellKeys).forEach(key => {
        const cell = index?.cells?.get(key);
        if (!cell) return;
        cell.forEach(position => positions.add(position));
    });
    return positions;
};

export const querySpatialBounds = (index, bounds, options = {}) => {
    if (!index?.documents || !bounds) {
        return { results: [], diagnostics: { reason: "invalid-index-or-bounds" } };
    }
    const enumeration = enumerateSpatialCells(bounds, {
        cellSizeDegrees: index.cellSize,
        maxCells: options.maxCells
    });
    const positions = getPositionsForSpatialCells(index, enumeration.keys);
    const results = Array.from(positions)
        .map(position => ({
            position,
            document: index.documents[position],
            coordinates: index.coordinatesByPosition.get(position)
        }))
        .filter(item => item.coordinates && isInsideBoundingBox(item.coordinates, bounds));
    return {
        results,
        diagnostics: {
            strategy: "grid-bounds",
            enumeratedCellCount: enumeration.keys.length,
            estimatedCellCount: enumeration.estimatedCount,
            cellEnumerationTruncated: enumeration.truncated,
            candidateCount: positions.size,
            matchedCount: results.length
        }
    };
};

export const querySpatialRadius = (index, center, radiusMeters, options = {}) => {
    const point = parseCoordinatePair(center);
    const radius = Math.max(0, normalizeFiniteNumber(radiusMeters, 0) || 0);
    if (!point || radius <= 0) {
        return { results: [], diagnostics: { reason: "invalid-center-or-radius", radiusMeters: radius } };
    }
    const bounds = createBoundingBox(point, radius);
    const bounded = querySpatialBounds(index, bounds, options);
    const limit = normalizeSpatialLimit(options.limit);
    const matches = bounded.results
        .map(item => ({
            ...item,
            distanceMeters: haversineDistanceMeters(point, item.coordinates)
        }))
        .filter(item => item.distanceMeters !== null && item.distanceMeters <= radius)
        .sort((left, right) => left.distanceMeters - right.distanceMeters || left.position - right.position);
    const total = matches.length;
    const results = matches.slice(0, limit);
    return {
        results,
        page: {
            offset: 0,
            limit,
            count: results.length,
            total,
            hasMore: total > results.length,
            nextOffset: total > results.length ? results.length : null
        },
        diagnostics: {
            ...bounded.diagnostics,
            strategy: "grid-radius",
            radiusMeters: radius,
            exactDistanceMatchedCount: total,
            returnedCount: results.length
        }
    };
};

export const queryNearestSpatial = (index, center, options = {}) => {
    const radiusMeters = Math.max(1, normalizeFiniteNumber(options.radiusMeters, 5000) || 5000);
    return querySpatialRadius(index, center, radiusMeters, options);
};

export const createAdaptiveSpatialCellSize = (documents, options = {}) => {
    const count = asArray(documents).length;
    const preferred = normalizeFiniteNumber(options.preferredCellSizeDegrees, null);
    if (preferred !== null) return normalizeSpatialCellSize(preferred);
    if (count <= 1000) return 0.025;
    if (count <= 10000) return 0.01;
    if (count <= 100000) return 0.005;
    return 0.0025;
};

export const createAdaptiveSpatialIndex = (documents, options = {}) => createSpatialIndex(documents, {
    ...options,
    cellSizeDegrees: options.cellSizeDegrees || createAdaptiveSpatialCellSize(documents, options)
});

export const validateSpatialIndex = index => {
    const issues = [];
    if (!index || index.version !== SPATIAL_INDEX_VERSION) {
        issues.push({ code: "spatial-index-version-mismatch", severity: "error" });
        return issues;
    }
    const totalCount = index.documents?.length || 0;
    index.cells.forEach((positions, key) => {
        if (!parseSpatialCellKey(key)) issues.push({ code: "invalid-cell-key", key, severity: "error" });
        positions.forEach(position => {
            if (!Number.isInteger(position) || position < 0 || position >= totalCount) {
                issues.push({ code: "position-out-of-range", key, position, severity: "error" });
            }
            const coordinates = index.coordinatesByPosition.get(position);
            if (!coordinates) issues.push({ code: "missing-position-coordinates", position, severity: "error" });
            else if (createSpatialCellKey(coordinates, index.cellSize) !== key) {
                issues.push({ code: "position-cell-mismatch", key, position, severity: "error" });
            }
        });
    });
    return issues;
};

export const createSpatialIndexQualityReport = index => {
    const issues = validateSpatialIndex(index);
    const totalCount = index?.documents?.length || 0;
    const indexedCount = index?.coordinatesByPosition?.size || 0;
    return {
        version: index?.version || null,
        totalCount,
        indexedCount,
        coverageRatio: totalCount ? indexedCount / totalCount : 0,
        cellSizeDegrees: index?.cellSize || null,
        cellCount: index?.cells?.size || 0,
        invalidCoordinateCount: index?.diagnostics?.invalidCoordinateCount || 0,
        maxCellLoad: index?.diagnostics?.maxCellLoad || 0,
        averageCellLoad: index?.diagnostics?.averageCellLoad || 0,
        duplicateFingerprintCount: index?.diagnostics?.duplicateFingerprintCount || 0,
        issueCount: issues.length,
        issues
    };
};

export const createSpatialIndexSnapshot = index => ({
    version: index?.version || null,
    cellSize: index?.cellSize || null,
    diagnostics: index?.diagnostics ? { ...index.diagnostics, invalidPositions: [...index.diagnostics.invalidPositions] } : null,
    cells: index?.cells
        ? Array.from(index.cells.entries()).map(([key, positions]) => ({ key, positions: Array.from(positions) }))
        : []
});

export const restoreSpatialIndexSnapshot = (documents, snapshot) => {
    if (!snapshot || snapshot.version !== SPATIAL_INDEX_VERSION) return null;
    const index = createSpatialIndex(documents, { cellSizeDegrees: snapshot.cellSize });
    return validateSpatialIndex(index).length ? null : index;
};

export const SpatialSearchIndexRuntime = {
    SPATIAL_INDEX_VERSION,
    DEFAULT_SPATIAL_CELL_SIZE_DEGREES,
    MIN_SPATIAL_CELL_SIZE_DEGREES,
    MAX_SPATIAL_CELL_SIZE_DEGREES,
    DEFAULT_SPATIAL_RESULT_LIMIT,
    MAX_SPATIAL_RESULT_LIMIT,
    DEFAULT_SPATIAL_MAX_CELLS,
    MAX_SPATIAL_MAX_CELLS,
    normalizeSpatialCellSize,
    normalizeSpatialLimit,
    normalizeSpatialMaxCells,
    longitudeToCellX,
    latitudeToCellY,
    createSpatialCellKey,
    parseSpatialCellKey,
    getSpatialCellBounds,
    resolveDocumentCoordinates,
    createSpatialDocumentFingerprint,
    createSpatialIndex,
    getCellRangeForBounds,
    enumerateSpatialCells,
    getPositionsForSpatialCells,
    querySpatialBounds,
    querySpatialRadius,
    queryNearestSpatial,
    createAdaptiveSpatialCellSize,
    createAdaptiveSpatialIndex,
    validateSpatialIndex,
    createSpatialIndexQualityReport,
    createSpatialIndexSnapshot,
    restoreSpatialIndexSnapshot
};