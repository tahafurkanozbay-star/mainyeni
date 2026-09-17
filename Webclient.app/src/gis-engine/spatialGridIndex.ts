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
 * Bounded uniform-grid spatial index for already-normalized ArcGIS client data.
 * It never reprojects coordinates or guesses a missing spatial reference. The
 * grid only narrows candidates; every query performs an exact extent check.
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

  const assertReference = (extent: NormalizedExtent): void => {
    const incoming = extent.spatialReference ? Object.freeze({ wkid: extent.spatialReference.wkid }) : null;
    if (!sameSpatialReference(activeReference, incoming)) {
      throw new SpatialGridIndexError(
        `Spatial reference mismatch: ${String(activeReference?.wkid)} != ${String(incoming?.wkid)}`,
        'SPATIAL_REFERENCE_MISMATCH',
      );
    }
    if (activeReference === null && incoming !== null) activeReference = incoming;
  };

  const cellRange = (extent: NormalizedExtent): Readonly<{
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
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
    return Object.freeze({ minX, maxX, minY, maxY, count });
  };

  const keysForExtent = (extent: NormalizedExtent): readonly string[] => {
    const range = cellRange(extent);
    const output = new Array<string>(range.count);
    let cursor = 0;
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        output[cursor] = cellKey(x, y);
        cursor += 1;
      }
    }
    return Object.freeze(output);
  };

  const prepare = (record: SpatialIndexRecord<T>): PreparedRecord<T> => {
    const key = identityKey(record.id);
    const extent = normalizeExtent(record.extent);
    assertReference(extent);
    const owner = boundedOwner(record.owner);
    const recordCells = keysForExtent(extent);
    return Object.freeze({ key, id: record.id, extent, value: record.value, owner, cells: recordCells });
  };

  const hitFor = (record: IndexedRecord<T>): SpatialIndexHit<T> => Object.freeze({
    id: record.id,
    extent: record.extent,
    value: record.value,
    owner: record.owner,
  });

  const projectedBudget = (prepared: readonly PreparedRecord<T>[], replacing: ReadonlySet<string>): Readonly<{
    features: number;
    references: number;
    newCells: number;
  }> => {
    let features = records.size;
    let references = referenceCount;
    const prospectiveCells = new Set<string>();
    for (const candidate of prepared) {
      const current = records.get(candidate.key);
      if (!current && !replacing.has(candidate.key)) features += 1;
      if (current) references -= current.cells.length;
      references += candidate.cells.length;
      for (const key of candidate.cells) if (!cells.has(key)) prospectiveCells.add(key);
    }
    return Object.freeze({ features, references, newCells: prospectiveCells.size });
  };

  const assertBudget = (prepared: readonly PreparedRecord<T>[], replacing: ReadonlySet<string> = new Set()): void => {
    const projected = projectedBudget(prepared, replacing);
    if (projected.features > maximumFeatures) {
      throw new SpatialGridIndexError('Spatial feature budget exceeded.', 'FEATURE_BUDGET_EXCEEDED');
    }
    if (cells.size + projected.newCells > maximumCells) {
      throw new SpatialGridIndexError('Spatial cell budget exceeded.', 'CELL_BUDGET_EXCEEDED');
    }
    if (projected.references > maximumReferences) {
      throw new SpatialGridIndexError('Spatial cell-reference budget exceeded.', 'REFERENCE_BUDGET_EXCEEDED');
    }
    const bucketGrowth = new Map<string, number>();
    for (const candidate of prepared) {
      const previous = records.get(candidate.key);
      const previousCells = new Set(previous?.cells ?? []);
      for (const key of candidate.cells) {
        if (previousCells.has(key)) continue;
        const next = (cells.get(key)?.size ?? 0) + (bucketGrowth.get(key) ?? 0) + 1;
        if (next > maximumBucketSize) {
          throw new SpatialGridIndexError(`Spatial bucket ${key} exceeds its bounded size.`, 'BUCKET_BUDGET_EXCEEDED');
        }
        bucketGrowth.set(key, (bucketGrowth.get(key) ?? 0) + 1);
      }
    }
  };

  const detach = (record: IndexedRecord<T>): void => {
    for (const key of record.cells) {
      const bucket = cells.get(key);
      if (!bucket) continue;
      if (bucket.delete(record.key)) referenceCount -= 1;
      if (bucket.size === 0) cells.delete(key);
    }
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
    for (const key of next.cells) {
      let bucket = cells.get(key);
      if (!bucket) {
        bucket = new Set<string>();
        cells.set(key, bucket);
      }
      if (!bucket.has(next.key)) {
        bucket.add(next.key);
        referenceCount += 1;
      }
    }
    if (next.owner) {
      let owned = owners.get(next.owner);
      if (!owned) {
        owned = new Set<string>();
        owners.set(next.owner, owned);
      }
      owned.add(next.key);
    }
    return next;
  };

  const upsert = (record: SpatialIndexRecord<T>): SpatialIndexHit<T> => {
    assertLive();
    const prepared = prepare(record);
    assertBudget([prepared]);
    return hitFor(attach(prepared));
  };

  const upsertMany = (input: readonly SpatialIndexRecord<T>[]): readonly SpatialIndexHit<T>[] => {
    assertLive();
    if (input.length > maximumFeatures) {
      throw new SpatialGridIndexError('Spatial batch exceeds feature budget.', 'FEATURE_BUDGET_EXCEEDED');
    }
    const prepared = input.map(prepare);
    const seen = new Set<string>();
    for (const item of prepared) {
      if (seen.has(item.key)) throw new SpatialGridIndexError(`Duplicate spatial identity in batch: ${item.key}`, 'DUPLICATE_IDENTITY');
      seen.add(item.key);
    }
    assertBudget(prepared);
    return Object.freeze(prepared.map((item) => hitFor(attach(item))));
  };

  const replaceAll = (input: readonly SpatialIndexRecord<T>[]): readonly SpatialIndexHit<T>[] => {
    assertLive();
    const prepared = input.map(prepare);
    const seen = new Set<string>();
    let references = 0;
    const prospectiveCells = new Set<string>();
    for (const item of prepared) {
      if (seen.has(item.key)) throw new SpatialGridIndexError(`Duplicate spatial identity in replacement: ${item.key}`, 'DUPLICATE_IDENTITY');
      seen.add(item.key);
      references += item.cells.length;
      for (const key of item.cells) prospectiveCells.add(key);
    }
    if (prepared.length > maximumFeatures) throw new SpatialGridIndexError('Spatial feature budget exceeded.', 'FEATURE_BUDGET_EXCEEDED');
    if (prospectiveCells.size > maximumCells) throw new SpatialGridIndexError('Spatial cell budget exceeded.', 'CELL_BUDGET_EXCEEDED');
    if (references > maximumReferences) throw new SpatialGridIndexError('Spatial reference budget exceeded.', 'REFERENCE_BUDGET_EXCEEDED');
    const bucketCounts = new Map<string, number>();
    for (const item of prepared) {
      for (const key of item.cells) {
        const count = (bucketCounts.get(key) ?? 0) + 1;
        if (count > maximumBucketSize) throw new SpatialGridIndexError('Spatial bucket budget exceeded.', 'BUCKET_BUDGET_EXCEEDED');
        bucketCounts.set(key, count);
      }
    }
    records.clear();
    cells.clear();
    owners.clear();
    referenceCount = 0;
    if (configuredReference === null) activeReference = null;
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
    const keys = Array.from(owned);
    let removed = 0;
    for (const key of keys) {
      const record = records.get(key);
      if (!record) continue;
      records.delete(key);
      detach(record);
      removed += 1;
    }
    if (records.size === 0 && configuredReference === null) activeReference = null;
    return removed;
  };

  const boundedLimit = (value: number | undefined): number => integer(value, 1_000, 100_000);

  const queryExtent = (input: SpatialExtent, limit?: number): readonly SpatialIndexHit<T>[] => {
    assertLive();
    const extent = normalizeExtent(input);
    const incoming = extent.spatialReference ? Object.freeze({ wkid: extent.spatialReference.wkid }) : null;
    if (!sameSpatialReference(activeReference, incoming)) return Object.freeze([]);
    const range = cellRange(extent);
    const candidates = new Set<string>();
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const bucket = cells.get(cellKey(x, y));
        if (!bucket) continue;
        for (const key of bucket) candidates.add(key);
      }
    }
    const output: IndexedRecord<T>[] = [];
    for (const key of candidates) {
      const record = records.get(key);
      if (!record || !intersectsExtent(record.extent, extent)) continue;
      output.push(record);
    }
    output.sort((left, right) => left.sequence - right.sequence || left.key.localeCompare(right.key));
    return Object.freeze(output.slice(0, boundedLimit(limit)).map(hitFor));
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
    const output: IndexedRecord<T>[] = [];
    for (const key of bucket) {
      const record = records.get(key);
      if (record && containsPoint(record.extent, point)) output.push(record);
    }
    output.sort((left, right) => left.sequence - right.sequence || left.key.localeCompare(right.key));
    return Object.freeze(output.slice(0, boundedLimit(limit)).map(hitFor));
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
