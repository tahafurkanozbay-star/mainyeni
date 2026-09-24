import type {
  Coordinate,
  NormalizedRecord,
  Page,
  SpatialBounds,
  SpatialHit,
  SpatialIndex,
  SpatialIndexOptions,
} from './contracts';
import { throwIfAborted } from './contracts';
import { createPageInfo, normalizeCoordinates, normalizeInteger } from './normalization';

export const EARTH_RADIUS_METERS = 6_371_008.8;
export const DEFAULT_CELL_SIZE_METERS = 500;
export const DEFAULT_MAX_CELLS_PER_QUERY = 20_000;
export const DEFAULT_MAX_SPATIAL_CANDIDATES = 50_000;

interface NormalizedSpatialOptions {
  readonly cellSizeMeters: number;
  readonly maxCellsPerQuery: number;
  readonly maxCandidates: number;
}

const normalizeOptions = (options: SpatialIndexOptions = {}): NormalizedSpatialOptions => ({
  cellSizeMeters: normalizeInteger(options.cellSizeMeters, {
    min: 25,
    max: 100_000,
    fallback: DEFAULT_CELL_SIZE_METERS,
  }),
  maxCellsPerQuery: normalizeInteger(options.maxCellsPerQuery, {
    min: 1,
    max: 250_000,
    fallback: DEFAULT_MAX_CELLS_PER_QUERY,
  }),
  maxCandidates: normalizeInteger(options.maxCandidates, {
    min: 1,
    max: 1_000_000,
    fallback: DEFAULT_MAX_SPATIAL_CANDIDATES,
  }),
});

const degreesForMeters = (meters: number): number => Math.max(0.00001, meters / 111_320);
const radians = (degrees: number): number => degrees * Math.PI / 180;

export const haversineDistanceMeters = (
  leftInput: Coordinate | readonly [number, number] | null | undefined,
  rightInput: Coordinate | readonly [number, number] | null | undefined,
): number | null => {
  const left = normalizeCoordinates(leftInput);
  const right = normalizeCoordinates(rightInput);
  if (!left || !right) return null;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, a));
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
};

export const createSpatialBounds = (
  centerInput: Coordinate | readonly [number, number] | null | undefined,
  radiusMetersInput: unknown,
): SpatialBounds | null => {
  const center = normalizeCoordinates(centerInput);
  const radiusMeters = Number(radiusMetersInput);
  if (!center || !Number.isFinite(radiusMeters) || radiusMeters < 0) return null;
  if (radiusMeters === 0) {
    return Object.freeze({
      minLatitude: center.latitude,
      maxLatitude: center.latitude,
      minLongitude: center.longitude,
      maxLongitude: center.longitude,
    });
  }
  const latitudeDelta = radiusMeters / 111_320;
  const cosine = Math.max(0.01, Math.cos(radians(center.latitude)));
  const longitudeDelta = radiusMeters / (111_320 * cosine);
  return Object.freeze({
    minLatitude: Math.max(-90, center.latitude - latitudeDelta),
    maxLatitude: Math.min(90, center.latitude + latitudeDelta),
    minLongitude: Math.max(-180, center.longitude - longitudeDelta),
    maxLongitude: Math.min(180, center.longitude + longitudeDelta),
  });
};

export const isCoordinateInsideBounds = (
  coordinateInput: Coordinate | readonly [number, number] | null | undefined,
  bounds: SpatialBounds | null | undefined,
): boolean => {
  const coordinate = normalizeCoordinates(coordinateInput);
  if (!coordinate || !bounds) return false;
  return coordinate.latitude >= bounds.minLatitude
    && coordinate.latitude <= bounds.maxLatitude
    && coordinate.longitude >= bounds.minLongitude
    && coordinate.longitude <= bounds.maxLongitude;
};

const cellCoordinate = (value: number, size: number, offset: number): number =>
  Math.floor((value + offset) / size);

const cellKey = (latitude: number, longitude: number, cellSizeDegrees: number): string => {
  const latitudeCell = cellCoordinate(latitude, cellSizeDegrees, 90);
  const longitudeCell = cellCoordinate(longitude, cellSizeDegrees, 180);
  return `${latitudeCell}:${longitudeCell}`;
};

const parseCellKey = (key: string): readonly [number, number] | null => {
  const parts = key.split(':');
  const latitudeCell = Number(parts[0]);
  const longitudeCell = Number(parts[1]);
  return Number.isInteger(latitudeCell) && Number.isInteger(longitudeCell)
    ? [latitudeCell, longitudeCell]
    : null;
};

export const buildSpatialIndex = <TRecord extends NormalizedRecord>(
  records: readonly TRecord[],
  options: SpatialIndexOptions = {},
): SpatialIndex<TRecord> => {
  const normalized = normalizeOptions(options);
  const cellSizeDegrees = degreesForMeters(normalized.cellSizeMeters);
  const mutableBuckets = new Map<string, number[]>();
  let geocodedCount = 0;
  let skippedCount = 0;

  for (let position = 0; position < records.length; position += 1) {
    const record = records[position];
    if (!record?.coordinates) {
      skippedCount += 1;
      continue;
    }
    geocodedCount += 1;
    const key = cellKey(
      record.coordinates.latitude,
      record.coordinates.longitude,
      cellSizeDegrees,
    );
    const bucket = mutableBuckets.get(key);
    if (bucket) bucket.push(position);
    else mutableBuckets.set(key, [position]);
  }

  const buckets = new Map<string, readonly number[]>();
  for (const [key, positions] of mutableBuckets) {
    buckets.set(key, Object.freeze([...positions]));
  }

  return Object.freeze({
    records,
    buckets,
    cellSizeDegrees,
    geocodedCount,
    skippedCount,
  });
};

const cellRange = (
  bounds: SpatialBounds,
  cellSizeDegrees: number,
): Readonly<{
  minLatitudeCell: number;
  maxLatitudeCell: number;
  minLongitudeCell: number;
  maxLongitudeCell: number;
}> => Object.freeze({
  minLatitudeCell: cellCoordinate(bounds.minLatitude, cellSizeDegrees, 90),
  maxLatitudeCell: cellCoordinate(bounds.maxLatitude, cellSizeDegrees, 90),
  minLongitudeCell: cellCoordinate(bounds.minLongitude, cellSizeDegrees, 180),
  maxLongitudeCell: cellCoordinate(bounds.maxLongitude, cellSizeDegrees, 180),
});

const enumerateCellKeys = (
  index: SpatialIndex,
  bounds: SpatialBounds,
  maximum: number,
  signal?: AbortSignal | null,
): readonly string[] => {
  const range = cellRange(bounds, index.cellSizeDegrees);
  const keys: string[] = [];
  const centerLatitudeCell = Math.floor((range.minLatitudeCell + range.maxLatitudeCell) / 2);
  const centerLongitudeCell = Math.floor((range.minLongitudeCell + range.maxLongitudeCell) / 2);
  const maxRing = Math.max(
    centerLatitudeCell - range.minLatitudeCell,
    range.maxLatitudeCell - centerLatitudeCell,
    centerLongitudeCell - range.minLongitudeCell,
    range.maxLongitudeCell - centerLongitudeCell,
  );

  const append = (latitudeCell: number, longitudeCell: number): boolean => {
    if (
      latitudeCell < range.minLatitudeCell
      || latitudeCell > range.maxLatitudeCell
      || longitudeCell < range.minLongitudeCell
      || longitudeCell > range.maxLongitudeCell
    ) return false;
    keys.push(`${latitudeCell}:${longitudeCell}`);
    return keys.length >= maximum;
  };

  for (let ring = 0; ring <= maxRing; ring += 1) {
    throwIfAborted(signal);
    if (ring === 0) {
      if (append(centerLatitudeCell, centerLongitudeCell)) break;
      continue;
    }

    const minLatitudeCell = centerLatitudeCell - ring;
    const maxLatitudeCell = centerLatitudeCell + ring;
    const minLongitudeCell = centerLongitudeCell - ring;
    const maxLongitudeCell = centerLongitudeCell + ring;

    for (let longitudeCell = minLongitudeCell; longitudeCell <= maxLongitudeCell; longitudeCell += 1) {
      throwIfAborted(signal);
      if (append(minLatitudeCell, longitudeCell)) return Object.freeze(keys);
      if (append(maxLatitudeCell, longitudeCell)) return Object.freeze(keys);
    }

    for (let latitudeCell = minLatitudeCell + 1; latitudeCell < maxLatitudeCell; latitudeCell += 1) {
      throwIfAborted(signal);
      if (append(latitudeCell, minLongitudeCell)) return Object.freeze(keys);
      if (append(latitudeCell, maxLongitudeCell)) return Object.freeze(keys);
    }
  }

  return Object.freeze(keys);
};

export interface SpatialCandidateResult {
  readonly positions: readonly number[];
  readonly cellCount: number;
  readonly truncated: boolean;
}

export const collectSpatialCandidatePositions = (
  index: SpatialIndex,
  bounds: SpatialBounds,
  options: SpatialIndexOptions & { readonly signal?: AbortSignal | null } = {},
): SpatialCandidateResult => {
  const normalized = normalizeOptions(options);
  const keys = enumerateCellKeys(index, bounds, normalized.maxCellsPerQuery, options.signal);
  const positions = new Set<number>();
  let truncated = false;
  for (const key of keys) {
    throwIfAborted(options.signal);
    const bucket = index.buckets.get(key);
    if (!bucket) continue;
    for (const position of bucket) {
      positions.add(position);
      if (positions.size >= normalized.maxCandidates) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  return Object.freeze({
    positions: Object.freeze(Array.from(positions).sort((left, right) => left - right)),
    cellCount: keys.length,
    truncated,
  });
};

export interface RadiusSearchOptions extends SpatialIndexOptions {
  readonly radiusMeters?: number;
  readonly offset?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal | null;
}

export const searchRadius = <TRecord extends NormalizedRecord>(
  index: SpatialIndex<TRecord>,
  centerInput: Coordinate | readonly [number, number],
  options: RadiusSearchOptions = {},
): Page<SpatialHit<TRecord>> => {
  throwIfAborted(options.signal);
  const center = normalizeCoordinates(centerInput);
  if (!center) {
    return Object.freeze({
      items: Object.freeze([]),
      page: createPageInfo(0, options.limit, 0, 0),
    });
  }
  const radiusMeters = Number.isFinite(Number(options.radiusMeters))
    ? Math.max(0, Number(options.radiusMeters))
    : 5_000;
  const bounds = createSpatialBounds(center, radiusMeters);
  if (!bounds) {
    return Object.freeze({
      items: Object.freeze([]),
      page: createPageInfo(0, options.limit, 0, 0),
    });
  }
  const candidates = collectSpatialCandidatePositions(index, bounds, options);
  const hits: SpatialHit<TRecord>[] = [];
  for (const position of candidates.positions) {
    throwIfAborted(options.signal);
    const record = index.records[position];
    if (!record?.coordinates || !isCoordinateInsideBounds(record.coordinates, bounds)) continue;
    const distanceMeters = haversineDistanceMeters(center, record.coordinates);
    if (distanceMeters === null || distanceMeters > radiusMeters) continue;
    hits.push(Object.freeze({ record, distanceMeters }));
  }
  hits.sort((left, right) => left.distanceMeters - right.distanceMeters
    || left.record.sourceIndex - right.record.sourceIndex);
  const offset = normalizeInteger(options.offset, { min: 0, fallback: 0 });
  const limit = normalizeInteger(options.limit, { min: 1, max: 1000, fallback: 50 });
  const items = hits.slice(offset, offset + limit);
  return Object.freeze({
    items: Object.freeze(items),
    page: createPageInfo(offset, limit, items.length, hits.length, 50),
  });
};

export const nearest = <TRecord extends NormalizedRecord>(
  index: SpatialIndex<TRecord>,
  center: Coordinate | readonly [number, number],
  options: Omit<RadiusSearchOptions, 'offset'> = {},
): readonly SpatialHit<TRecord>[] => searchRadius(index, center, {
  ...options,
  offset: 0,
  radiusMeters: options.radiusMeters ?? 25_000,
}).items;

export interface SpatialIndexDiagnostics {
  readonly recordCount: number;
  readonly geocodedCount: number;
  readonly skippedCount: number;
  readonly bucketCount: number;
  readonly largestBucket: number;
  readonly averageBucketSize: number;
  readonly cellSizeDegrees: number;
}

export const spatialIndexDiagnostics = (index: SpatialIndex): SpatialIndexDiagnostics => {
  let largestBucket = 0;
  let postingCount = 0;
  for (const bucket of index.buckets.values()) {
    largestBucket = Math.max(largestBucket, bucket.length);
    postingCount += bucket.length;
  }
  return Object.freeze({
    recordCount: index.records.length,
    geocodedCount: index.geocodedCount,
    skippedCount: index.skippedCount,
    bucketCount: index.buckets.size,
    largestBucket,
    averageBucketSize: index.buckets.size ? postingCount / index.buckets.size : 0,
    cellSizeDegrees: index.cellSizeDegrees,
  });
};

export const validateSpatialIndex = (index: SpatialIndex): readonly string[] => {
  const issues: string[] = [];
  for (const [key, positions] of index.buckets) {
    if (!parseCellKey(key)) issues.push(`invalid-cell-key:${key}`);
    let previous = -1;
    for (const position of positions) {
      if (!Number.isInteger(position) || position < 0 || position >= index.records.length) {
        issues.push(`position-out-of-range:${key}:${String(position)}`);
      }
      if (position <= previous) issues.push(`position-order:${key}:${String(position)}`);
      previous = position;
      const coordinate = index.records[position]?.coordinates;
      if (!coordinate) issues.push(`position-without-coordinate:${key}:${String(position)}`);
    }
  }
  return Object.freeze(issues);
};