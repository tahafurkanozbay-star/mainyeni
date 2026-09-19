export interface SpatialBounds {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

export interface SpatialExtentIndexEntry<T> {
  readonly id: string;
  readonly bounds: SpatialBounds;
  readonly value: T;
  readonly estimatedBytes?: number;
}

export interface SpatialExtentIndexOptions {
  readonly maxEntries?: number;
  readonly maxEstimatedBytes?: number;
  readonly maxQueryResults?: number;
  readonly maxIdLength?: number;
}

export interface SpatialExtentIndexStats {
  readonly entries: number;
  readonly estimatedBytes: number;
  readonly mutations: number;
  readonly queries: number;
  readonly evictions: number;
}

export interface SpatialExtentQueryResult<T> {
  readonly entries: readonly SpatialExtentIndexEntry<T>[];
  readonly truncated: boolean;
  readonly visited: number;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_QUERY_RESULTS = 5_000;
const DEFAULT_MAX_ID_LENGTH = 256;
const ENTRY_OVERHEAD_BYTES = 128;

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function finiteCoordinate(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

export function normalizeSpatialBounds(bounds: SpatialBounds): SpatialBounds {
  const xmin = finiteCoordinate(bounds.xmin, 'bounds.xmin');
  const ymin = finiteCoordinate(bounds.ymin, 'bounds.ymin');
  const xmax = finiteCoordinate(bounds.xmax, 'bounds.xmax');
  const ymax = finiteCoordinate(bounds.ymax, 'bounds.ymax');
  if (xmin > xmax || ymin > ymax) {
    throw new RangeError('bounds minimum coordinates must not exceed maximum coordinates');
  }
  return Object.freeze({ xmin, ymin, xmax, ymax });
}

export function spatialBoundsIntersect(a: SpatialBounds, b: SpatialBounds): boolean {
  return a.xmax >= b.xmin && a.xmin <= b.xmax && a.ymax >= b.ymin && a.ymin <= b.ymax;
}

export function spatialBoundsContain(container: SpatialBounds, candidate: SpatialBounds): boolean {
  return container.xmin <= candidate.xmin
    && container.ymin <= candidate.ymin
    && container.xmax >= candidate.xmax
    && container.ymax >= candidate.ymax;
}

export function spatialBoundsCenter(bounds: SpatialBounds): Readonly<{ x: number; y: number }> {
  return Object.freeze({
    x: bounds.xmin + (bounds.xmax - bounds.xmin) / 2,
    y: bounds.ymin + (bounds.ymax - bounds.ymin) / 2,
  });
}

export function spatialBoundsArea(bounds: SpatialBounds): number {
  const width = bounds.xmax - bounds.xmin;
  const height = bounds.ymax - bounds.ymin;
  const area = width * height;
  return Number.isFinite(area) ? area : Number.MAX_VALUE;
}

function normalizeId(id: string, maxLength: number): string {
  if (typeof id !== 'string') throw new TypeError('entry id must be a string');
  const normalized = id.trim();
  if (normalized.length === 0) throw new TypeError('entry id must not be empty');
  if (normalized.length > maxLength) throw new RangeError('entry id exceeds length budget');
  return normalized;
}

function estimateEntryBytes(id: string, supplied: number | undefined): number {
  if (supplied !== undefined) return positiveSafeInteger(supplied, 'estimatedBytes');
  return ENTRY_OVERHEAD_BYTES + id.length * 2;
}

interface StoredEntry<T> {
  readonly id: string;
  readonly bounds: SpatialBounds;
  readonly value: T;
  readonly estimatedBytes: number;
  readonly sequence: number;
}

/**
 * Bounded deterministic coarse spatial index for already-loaded GIS objects.
 *
 * This deliberately does not own transport, ArcGIS services, projection, or
 * geometry predicates. It is a memory-pressure guard and coarse rejection
 * layer for consumers that already have trustworthy extents in one spatial
 * reference. Entries are scanned in insertion order; this keeps behavior
 * deterministic and avoids maintaining a second mutable tree for moderate
 * client-side working sets. Consumers requiring server-scale indexing should
 * continue using the authoritative ArcGIS service query path.
 */
export class SpatialExtentIndex<T> {
  readonly #maxEntries: number;
  readonly #maxEstimatedBytes: number;
  readonly #maxQueryResults: number;
  readonly #maxIdLength: number;
  readonly #entries = new Map<string, StoredEntry<T>>();
  #estimatedBytes = 0;
  #sequence = 0;
  #mutations = 0;
  #queries = 0;
  #evictions = 0;

  constructor(options: SpatialExtentIndexOptions = {}) {
    this.#maxEntries = positiveSafeInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 'maxEntries');
    this.#maxEstimatedBytes = positiveSafeInteger(
      options.maxEstimatedBytes ?? DEFAULT_MAX_BYTES,
      'maxEstimatedBytes',
    );
    this.#maxQueryResults = positiveSafeInteger(
      options.maxQueryResults ?? DEFAULT_MAX_QUERY_RESULTS,
      'maxQueryResults',
    );
    this.#maxIdLength = positiveSafeInteger(options.maxIdLength ?? DEFAULT_MAX_ID_LENGTH, 'maxIdLength');
  }

  get size(): number {
    return this.#entries.size;
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  get(id: string): SpatialExtentIndexEntry<T> | undefined {
    const stored = this.#entries.get(id);
    return stored === undefined ? undefined : this.#publicEntry(stored);
  }

  upsert(entry: SpatialExtentIndexEntry<T>): Readonly<{ evictedIds: readonly string[] }> {
    const id = normalizeId(entry.id, this.#maxIdLength);
    const bounds = normalizeSpatialBounds(entry.bounds);
    const estimatedBytes = estimateEntryBytes(id, entry.estimatedBytes);
    if (estimatedBytes > this.#maxEstimatedBytes) {
      throw new RangeError('entry exceeds index byte budget');
    }

    const previous = this.#entries.get(id);
    if (previous !== undefined) {
      this.#estimatedBytes -= previous.estimatedBytes;
      this.#entries.delete(id);
    }

    const stored: StoredEntry<T> = Object.freeze({
      id,
      bounds,
      value: entry.value,
      estimatedBytes,
      sequence: ++this.#sequence,
    });
    this.#entries.set(id, stored);
    this.#estimatedBytes += estimatedBytes;
    this.#mutations += 1;

    const evictedIds: string[] = [];
    while (this.#entries.size > this.#maxEntries || this.#estimatedBytes > this.#maxEstimatedBytes) {
      const oldest = this.#entries.entries().next().value as [string, StoredEntry<T>] | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest[0]);
      this.#estimatedBytes -= oldest[1].estimatedBytes;
      this.#evictions += 1;
      evictedIds.push(oldest[0]);
    }
    return Object.freeze({ evictedIds: Object.freeze(evictedIds) });
  }

  remove(id: string): boolean {
    const stored = this.#entries.get(id);
    if (stored === undefined) return false;
    this.#entries.delete(id);
    this.#estimatedBytes -= stored.estimatedBytes;
    this.#mutations += 1;
    return true;
  }

  clear(): void {
    if (this.#entries.size === 0) return;
    this.#entries.clear();
    this.#estimatedBytes = 0;
    this.#mutations += 1;
  }

  queryIntersects(boundsInput: SpatialBounds, limit = this.#maxQueryResults): SpatialExtentQueryResult<T> {
    const bounds = normalizeSpatialBounds(boundsInput);
    const safeLimit = Math.min(positiveSafeInteger(limit, 'limit'), this.#maxQueryResults);
    const matches: SpatialExtentIndexEntry<T>[] = [];
    let visited = 0;
    let truncated = false;
    this.#queries += 1;

    for (const stored of this.#entries.values()) {
      visited += 1;
      if (!spatialBoundsIntersect(stored.bounds, bounds)) continue;
      if (matches.length >= safeLimit) {
        truncated = true;
        break;
      }
      matches.push(this.#publicEntry(stored));
    }
    return Object.freeze({ entries: Object.freeze(matches), truncated, visited });
  }

  queryContained(boundsInput: SpatialBounds, limit = this.#maxQueryResults): SpatialExtentQueryResult<T> {
    const bounds = normalizeSpatialBounds(boundsInput);
    const safeLimit = Math.min(positiveSafeInteger(limit, 'limit'), this.#maxQueryResults);
    const matches: SpatialExtentIndexEntry<T>[] = [];
    let visited = 0;
    let truncated = false;
    this.#queries += 1;

    for (const stored of this.#entries.values()) {
      visited += 1;
      if (!spatialBoundsContain(bounds, stored.bounds)) continue;
      if (matches.length >= safeLimit) {
        truncated = true;
        break;
      }
      matches.push(this.#publicEntry(stored));
    }
    return Object.freeze({ entries: Object.freeze(matches), truncated, visited });
  }

  nearestByCenter(
    point: Readonly<{ x: number; y: number }>,
    limit = Math.min(25, this.#maxQueryResults),
  ): readonly SpatialExtentIndexEntry<T>[] {
    const x = finiteCoordinate(point.x, 'point.x');
    const y = finiteCoordinate(point.y, 'point.y');
    const safeLimit = Math.min(positiveSafeInteger(limit, 'limit'), this.#maxQueryResults);
    this.#queries += 1;
    const ranked = [...this.#entries.values()].map((stored) => {
      const center = spatialBoundsCenter(stored.bounds);
      const dx = center.x - x;
      const dy = center.y - y;
      const distanceSquared = dx * dx + dy * dy;
      return { stored, distanceSquared: Number.isFinite(distanceSquared) ? distanceSquared : Number.MAX_VALUE };
    });
    ranked.sort((a, b) => a.distanceSquared - b.distanceSquared || a.stored.sequence - b.stored.sequence);
    return Object.freeze(ranked.slice(0, safeLimit).map(({ stored }) => this.#publicEntry(stored)));
  }

  snapshot(): readonly SpatialExtentIndexEntry<T>[] {
    return Object.freeze([...this.#entries.values()].map((entry) => this.#publicEntry(entry)));
  }

  stats(): SpatialExtentIndexStats {
    return Object.freeze({
      entries: this.#entries.size,
      estimatedBytes: this.#estimatedBytes,
      mutations: this.#mutations,
      queries: this.#queries,
      evictions: this.#evictions,
    });
  }

  #publicEntry(stored: StoredEntry<T>): SpatialExtentIndexEntry<T> {
    return Object.freeze({
      id: stored.id,
      bounds: stored.bounds,
      value: stored.value,
      estimatedBytes: stored.estimatedBytes,
    });
  }
}
