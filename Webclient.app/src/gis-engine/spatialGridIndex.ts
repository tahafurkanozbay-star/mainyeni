import {
  containsPoint,
  intersectsExtent,
  normalizeExtent,
  normalizeSpatialReference,
  type NormalizedExtent,
  type SpatialExtent,
  type SpatialPoint,
  type SpatialReferenceLike,
} from './spatialExtent';

export type SpatialIndexIdentity = string | number;

export type SpatialIndexRecord<T> = Readonly<{
  id: SpatialIndexIdentity;
  extent: SpatialExtent;
  value: T;
  owner?: string;
}>;

export type SpatialIndexHit<T> = Readonly<{
  id: SpatialIndexIdentity;
  extent: NormalizedExtent;
  value: T;
  owner: string | null;
}>;

export type SpatialIndexSnapshot = Readonly<{
  featureCount: number;
  cellCount: number;
  referenceCount: number;
  ownerCount: number;
  cellSize: number;
  maximumFeatures: number;
  maximumCells: number;
  maximumReferences: number;
  maximumCellsPerFeature: number;
  maximumBucketSize: number;
  spatialReference: Readonly<{ wkid: number }> | null;
}>;

export class SpatialGridIndexError extends Error {
  readonly code: string;

  constructor(message: string, code = 'SPATIAL_GRID_INDEX_ERROR') {
    super(message);
    this.name = 'SpatialGridIndexError';
    this.code = code;
  }
}

type IndexedRecord<T> = {
  key: string;
  id: SpatialIndexIdentity;
  extent: NormalizedExtent;
  value: T;
  owner: string | null;
  cells: readonly string[];
  sequence: number;
};

type PreparedRecord<T> = Omit<IndexedRecord<T>, 'sequence'>;
type CellDelta = readonly [key: string, delta: -1 | 1];

const integer = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return fallback;
  return Math.min(numeric, maximum);
};

const positive = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(numeric, maximum);
};

const boundedOwner = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const owner = String(value).trim();
  if (!owner) return null;
  if (owner.length > 256) throw new SpatialGridIndexError('Spatial index owner must be bounded.', 'INVALID_OWNER');
  return owner;
};

const identityKey = (value: SpatialIndexIdentity): string => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SpatialGridIndexError('Spatial index numeric identity must be finite.', 'INVALID_IDENTITY');
    return `n:${String(value)}`;
  }
  const text = value.trim();
  if (!text || text.length > 512) throw new SpatialGridIndexError('Spatial index identity must be non-empty and bounded.', 'INVALID_IDENTITY');
  return `s:${text}`;
};

const cellKey = (x: number, y: number): string => `${x}:${y}`;

const sameSpatialReference = (
  left: Readonly<{ wkid: number }> | null,
  right: Readonly<{ wkid: number }> | null,
): boolean => left === null || right === null || left.wkid === right.wkid;

const normalizedReference = (value: SpatialReferenceLike | undefined): Readonly<{ wkid: number }> | null => {
  const normalized = normalizeSpatialReference(value);
  return normalized ? Object.freeze({ wkid: normalized.wkid }) : null;
};

const extentReference = (extent: NormalizedExtent): Readonly<{ wkid: number }> | null => (
  extent.spatialReference ? Object.freeze({ wkid: extent.spatialReference.wkid }) : null
);

export type SpatialGridIndex<T> = Readonly<{
  upsert(record: SpatialIndexRecord<T>): SpatialIndexHit<T>;
  upsertMany(records: readonly SpatialIndexRecord<T>[]): readonly SpatialIndexHit<T>[];
  replaceAll(records: readonly SpatialIndexRecord<T>[]): readonly SpatialIndexHit<T>[];
  get(id: SpatialIndexIdentity): SpatialIndexHit<T> | null;
  has(id: SpatialIndexIdentity): boolean;
  remove(id: SpatialIndexIdentity): boolean;
  removeOwner(owner: string): number;
  queryExtent(extent: SpatialExtent, limit?: number): readonly SpatialIndexHit<T>[];
  queryPoint(point: SpatialPoint, limit?: number): readonly SpatialIndexHit<T>[];
  owners(): readonly string[];
  snapshot(): SpatialIndexSnapshot;
  clear(): void;
  dispose(): void;
}>;

/**
 * Bounded uniform-grid index for normalized ArcGIS client data. Cell traversal
 * is represented as a single linear cursor rather than nested synchronous
 * iteration. The index never reprojects or guesses a known spatial reference.
 */
export const createSpatialGridIndex = <T>(options: Readonly<{
  cellSize?: number;
  maximumFeatures?: number;
  maximumCells?: number;
  maximumReferences?: number;
  maximumCellsPerFeature?: number;
  maximumBucketSize?: number;
  spatialReference?: SpatialReferenceLike;
}> = {}): SpatialGridIndex<T> => {
  const cellSize = positive(options.cellSize, 1_000, 1_000_000_000);
  const maximumFeatures = integer(options.maximumFeatures, 25_000, 1_000_000);
  const maximumCells = integer(options.maximumCells, 100_000, 4_000_000);
  const maximumReferences = integer(options.maximumReferences, 250_000, 8_000_000);
  const maximumCellsPerFeature = integer(options.maximumCellsPerFeature, 4_096, 65_536);
  const maximumBucketSize = integer(options.maximumBucketSize, 10_000, 250_000);
  const configuredReference = normalizedReference(options.spatialReference);
  let activeReference = configuredReference;
  let referenceCount = 0;
  let sequence = 0;
  let disposed = false;

  const records = new Map<string, IndexedRecord<T>>();
  const cells = new Map<string, Set<string>>();
  const owners = new Map<string, Set<string>>();

  const assertLive = (): void => {
    if (disposed) throw new SpatialGridIndexError('Spatial grid index is disposed.', 'DISPOSED');
  };

  const cellRange = (extent: NormalizedExtent): Readonly<{
    minX: number;
    minY: number;
    width: number;
    count: number;
  }> => {
    const minX = Math.floor(extent.xmin / cellSize);
    const maxX = Math.floor(extent.xmax / cellSize);
    const minY = Math.floor(extent.ymin / cellSize);
    const maxY = Math.floor(extent.ymax / cellSize);
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const count = width * height;
    if (!Number.isSafeInteger(count) || count <= 0 || count > maximumCellsPerFeature) {
      throw new SpatialGridIndexError(
        `Spatial feature spans ${String(count)} grid cells; maximum is ${maximumCellsPerFeature}.`,
        'FEATURE_CELL_BUDGET_EXCEEDED',
      );
    }
    return Object.freeze({ minX, minY, width, count });
  };

  const keysForExtent = (extent: NormalizedExtent): readonly string[] => {
    const range = cellRange(extent);
    return Object.freeze(Array.from({ length: range.count }, (_, offset) => {
      const x = range.minX + (offset % range.width);
      const y = range.minY + Math.floor(offset / range.width);
      return cellKey(x, y);
    }));
  };

  const prepare = (record: SpatialIndexRecord<T>): PreparedRecord<T> => {
    const key = identityKey(record.id);
    const extent = normalizeExtent(record.extent);
    return Object.freeze({
      key,
      id: record.id,
      extent,
      value: record.value,
      owner: boundedOwner(record.owner),
      cells: keysForExtent(extent),
    });
  };

  const resolveReference = (
    prepared: readonly PreparedRecord<T>[],
    base: Readonly<{ wkid: number }> | null,
  ): Readonly<{ wkid: number }> | null => {
    const known = prepared.map((item) => extentReference(item.extent)).filter((item): item is Readonly<{ wkid: number }> => item !== null);
    const target = base ?? known[0] ?? null;
    if (target && known.some((item) => item.wkid !== target.wkid)) {
      const mismatched = known.find((item) => item.wkid !== target.wkid);
      throw new SpatialGridIndexError(
        `Spatial reference mismatch: ${String(target.wkid)} != ${String(mismatched?.wkid)}`,
        'SPATIAL_REFERENCE_MISMATCH',
      );
    }
    return target;
  };

  const hitFor = (record: IndexedRecord<T>): SpatialIndexHit<T> => Object.freeze({
    id: record.id,
    extent: record.extent,
    value: record.value,
    owner: record.owner,
  });

  const assertUnique = (prepared: readonly PreparedRecord<T>[], message: string): void => {
    const seen = new Set<string>();
    const duplicate = prepared.find((item) => {
      if (seen.has(item.key)) return true;
      seen.add(item.key);
      return false;
    });
    if (duplicate) throw new SpatialGridIndexError(`${message}: ${duplicate.key}`, 'DUPLICATE_IDENTITY');
  };

  const applyDeltas = (counts: Map<string, number>, deltas: readonly CellDelta[]): void => {
    deltas.reduce((total, [key, delta]) => {
      const next = (counts.get(key) ?? 0) + delta;
      if (next <= 0) counts.delete(key);
      else counts.set(key, next);
      return total + delta;
    }, 0);
  };

  const assertProjectedBudget = (prepared: readonly PreparedRecord<T>[]): void => {
    const featureCount = records.size + prepared.filter((item) => !records.has(item.key)).length;
    if (featureCount > maximumFeatures) throw new SpatialGridIndexError('Spatial feature budget exceeded.', 'FEATURE_BUDGET_EXCEEDED');

    const counts = new Map<string, number>(Array.from(cells, ([key, bucket]) => [key, bucket.size] as const));
    const deltas = prepared.flatMap((item): readonly CellDelta[] => {
      const previous = records.get(item.key);
      const removals = (previous?.cells ?? []).map((key): CellDelta => [key, -1]);
      const additions = item.cells.map((key): CellDelta => [key, 1]);
      return [...removals, ...additions];
    });
    applyDeltas(counts, deltas);

    if (counts.size > maximumCells) throw new SpatialGridIndexError('Spatial cell budget exceeded.', 'CELL_BUDGET_EXCEEDED');
    const projectedReferences = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
    if (projectedReferences > maximumReferences) {
      throw new SpatialGridIndexError('Spatial cell-reference budget exceeded.', 'REFERENCE_BUDGET_EXCEEDED');
    }
    const oversized = Array.from(counts.entries()).find(([, count]) => count > maximumBucketSize);
    if (oversized) throw new SpatialGridIndexError(`Spatial bucket ${oversized[0]} exceeds its bounded size.`, 'BUCKET_BUDGET_EXCEEDED');
  };

  const assertReplacementBudget = (prepared: readonly PreparedRecord<T>[]): void => {
    if (prepared.length > maximumFeatures) throw new SpatialGridIndexError('Spatial feature budget exceeded.', 'FEATURE_BUDGET_EXCEEDED');
    const counts = new Map<string, number>();
    applyDeltas(counts, prepared.flatMap((item) => item.cells.map((key): CellDelta => [key, 1])));
    if (counts.size > maximumCells) throw new SpatialGridIndexError('Spatial cell budget exceeded.', 'CELL_BUDGET_EXCEEDED');
    const references = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
    if (references > maximumReferences) throw new SpatialGridIndexError('Spatial reference budget exceeded.', 'REFERENCE_BUDGET_EXCEEDED');
    if (Array.from(counts.values()).some((count) => count > maximumBucketSize)) {
      throw new SpatialGridIndexError('Spatial bucket budget exceeded.', 'BUCKET_BUDGET_EXCEEDED');
    }
  };

  const detach = (record: IndexedRecord<T>): void => {
    const removed = record.cells.reduce((count, key) => {
      const bucket = cells.get(key);
      if (!bucket || !bucket.delete(record.key)) return count;
      if (bucket.size === 0) cells.delete(key);
      return count + 1;
    }, 0);
    referenceCount -= removed;
    if (record.owner) {
      const owned = owners.get(record.owner);
      owned?.delete(record.key);
      if (owned?.size === 0) owners.delete(record.owner);
    }
  };

  const attach = (prepared: PreparedRecord<T>): IndexedRecord<T> => {
    const previous = records.get(prepared.key);
    if (previous) detach(previous);
    sequence += 1;
    const next: IndexedRecord<T> = { ...prepared, sequence };
    records.set(prepared.key, next);
    const added = next.cells.reduce((count, key) => {
      let bucket = cells.get(key);
      if (!bucket) {
        bucket = new Set<string>();
        cells.set(key, bucket);
      }
      if (bucket.has(next.key)) return count;
      bucket.add(next.key);
      return count + 1;
    }, 0);
    referenceCount += added;
    if (next.owner) {
      const owned = owners.get(next.owner) ?? new Set<string>();
      owned.add(next.key);
      owners.set(next.owner, owned);
    }
    return next;
  };

  const upsert = (record: SpatialIndexRecord<T>): SpatialIndexHit<T> => {
    assertLive();
    const prepared = prepare(record);
    const nextReference = resolveReference([prepared], activeReference);
    assertProjectedBudget([prepared]);
    const hit = hitFor(attach(prepared));
    activeReference = nextReference;
    return hit;
  };

  const upsertMany = (input: readonly SpatialIndexRecord<T>[]): readonly SpatialIndexHit<T>[] => {
    assertLive();
    if (input.length > maximumFeatures) throw new SpatialGridIndexError('Spatial batch exceeds feature budget.', 'FEATURE_BUDGET_EXCEEDED');
    const prepared = input.map(prepare);
    assertUnique(prepared, 'Duplicate spatial identity in batch');
    const nextReference = resolveReference(prepared, activeReference);
    assertProjectedBudget(prepared);
    const hits = prepared.map((item) => hitFor(attach(item)));
    activeReference = nextReference;
    return Object.freeze(hits);
  };

  const replaceAll = (input: readonly SpatialIndexRecord<T>[]): readonly SpatialIndexHit<T>[] => {
    assertLive();
    const prepared = input.map(prepare);
    assertUnique(prepared, 'Duplicate spatial identity in replacement');
    const replacementReference = resolveReference(prepared, configuredReference);
    assertReplacementBudget(prepared);
    records.clear();
    cells.clear();
    owners.clear();
    referenceCount = 0;
    activeReference = replacementReference;
    return Object.freeze(prepared.map((item) => hitFor(attach(item))));
  };

  const get = (id: SpatialIndexIdentity): SpatialIndexHit<T> | null => {
    assertLive();
    const record = records.get(identityKey(id));
    return record ? hitFor(record) : null;
  };

  const has = (id: SpatialIndexIdentity): boolean => {
    assertLive();
    return records.has(identityKey(id));
  };

  const remove = (id: SpatialIndexIdentity): boolean => {
    assertLive();
    const key = identityKey(id);
    const record = records.get(key);
    if (!record) return false;
    records.delete(key);
    detach(record);
    if (records.size === 0 && configuredReference === null) activeReference = null;
    return true;
  };

  const removeOwner = (rawOwner: string): number => {
    assertLive();
    const owner = boundedOwner(rawOwner);
    if (!owner) return 0;
    const owned = owners.get(owner);
    if (!owned) return 0;
    const removed = Array.from(owned).reduce((count, key) => {
      const record = records.get(key);
      if (!record) return count;
      records.delete(key);
      detach(record);
      return count + 1;
    }, 0);
    if (records.size === 0 && configuredReference === null) activeReference = null;
    return removed;
  };

  const boundedLimit = (value: number | undefined): number => integer(value, 1_000, 100_000);

  const queryExtent = (input: SpatialExtent, limit?: number): readonly SpatialIndexHit<T>[] => {
    assertLive();
    const extent = normalizeExtent(input);
    const incoming = extentReference(extent);
    if (!sameSpatialReference(activeReference, incoming)) return Object.freeze([]);
    const candidates = keysForExtent(extent).reduce((result, key) => {
      const bucket = cells.get(key);
      if (!bucket) return result;
      Array.from(bucket).reduce((set, identity) => set.add(identity), result);
      return result;
    }, new Set<string>());
    const matching = Array.from(candidates)
      .map((key) => records.get(key))
      .filter((record): record is IndexedRecord<T> => record !== undefined && intersectsExtent(record.extent, extent))
      .sort((left, right) => left.sequence - right.sequence || left.key.localeCompare(right.key));
    return Object.freeze(matching.slice(0, boundedLimit(limit)).map(hitFor));
  };

  const queryPoint = (point: SpatialPoint, limit?: number): readonly SpatialIndexHit<T>[] => {
    assertLive();
    const pointReference = normalizedReference(point.spatialReference);
    if (!sameSpatialReference(activeReference, pointReference)) return Object.freeze([]);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new SpatialGridIndexError('Spatial query point coordinates must be finite.', 'INVALID_POINT');
    }
    const bucket = cells.get(cellKey(Math.floor(point.x / cellSize), Math.floor(point.y / cellSize)));
    if (!bucket) return Object.freeze([]);
    const matching = Array.from(bucket)
      .map((key) => records.get(key))
      .filter((record): record is IndexedRecord<T> => record !== undefined && containsPoint(record.extent, point))
      .sort((left, right) => left.sequence - right.sequence || left.key.localeCompare(right.key));
    return Object.freeze(matching.slice(0, boundedLimit(limit)).map(hitFor));
  };

  const snapshot = (): SpatialIndexSnapshot => Object.freeze({
    featureCount: records.size,
    cellCount: cells.size,
    referenceCount,
    ownerCount: owners.size,
    cellSize,
    maximumFeatures,
    maximumCells,
    maximumReferences,
    maximumCellsPerFeature,
    maximumBucketSize,
    spatialReference: activeReference,
  });

  const clear = (): void => {
    assertLive();
    records.clear();
    cells.clear();
    owners.clear();
    referenceCount = 0;
    if (configuredReference === null) activeReference = null;
  };

  const dispose = (): void => {
    if (disposed) return;
    records.clear();
    cells.clear();
    owners.clear();
    referenceCount = 0;
    disposed = true;
  };

  return Object.freeze({
    upsert,
    upsertMany,
    replaceAll,
    get,
    has,
    remove,
    removeOwner,
    queryExtent,
    queryPoint,
    owners: () => Object.freeze(Array.from(owners.keys()).sort()),
    snapshot,
    clear,
    dispose,
  });
};