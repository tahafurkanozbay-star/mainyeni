export type SpatialCacheGeometryKind = 'point' | 'multipoint' | 'polyline' | 'polygon' | 'extent';

export interface SpatialCacheEnvelope {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly spatialReferenceWkid?: number;
}

export interface SpatialCacheKeyInput {
  readonly serviceId: string;
  readonly layerId: number;
  readonly operation: string;
  readonly envelope?: SpatialCacheEnvelope;
  readonly geometryKind?: SpatialCacheGeometryKind;
  readonly where?: string;
  readonly outFields?: readonly string[];
  readonly spatialRelationship?: string;
  readonly resultOffset?: number;
  readonly resultRecordCount?: number;
  readonly returnGeometry?: boolean;
  readonly extra?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

export interface SpatialCachePolicy {
  readonly maxEntries: number;
  readonly maxEstimatedBytes: number;
  readonly defaultTtlMs: number;
  readonly maxTtlMs: number;
  readonly coordinatePrecision: number;
}

export interface SpatialCachePutOptions {
  readonly ttlMs?: number;
  readonly estimatedBytes?: number;
  readonly tags?: readonly string[];
  readonly now?: number;
}

export interface SpatialCacheLookupOptions {
  readonly now?: number;
  readonly allowStale?: boolean;
}

export interface SpatialCacheLookup<T> {
  readonly status: 'hit' | 'stale' | 'miss';
  readonly value?: T;
  readonly ageMs?: number;
  readonly expiresInMs?: number;
  readonly estimatedBytes?: number;
}

export interface SpatialCacheSnapshot {
  readonly entries: number;
  readonly estimatedBytes: number;
  readonly hits: number;
  readonly staleHits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly expirations: number;
  readonly rejectedOversize: number;
  readonly generation: number;
}

interface CacheEntry<T> {
  readonly key: string;
  readonly value: T;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly estimatedBytes: number;
  readonly tags: readonly string[];
  lastAccessAt: number;
  accessSequence: number;
}

const DEFAULT_POLICY: SpatialCachePolicy = {
  maxEntries: 256,
  maxEstimatedBytes: 16 * 1024 * 1024,
  defaultTtlMs: 30_000,
  maxTtlMs: 5 * 60_000,
  coordinatePrecision: 6,
};

const finiteNonNegative = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative`);
  return value;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, ' ');
const normalizeField = (value: string): string => normalizeText(value).toLocaleUpperCase('en-US');

const stableExtra = (extra: SpatialCacheKeyInput['extra']): string => {
  if (!extra) return '';
  return Object.entries(extra)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
};

const roundCoordinate = (value: number, precision: number): number => {
  if (!Number.isFinite(value)) throw new RangeError('envelope coordinates must be finite');
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

const normalizeEnvelope = (envelope: SpatialCacheEnvelope | undefined, precision: number): string => {
  if (!envelope) return '';
  const xmin = roundCoordinate(envelope.xmin, precision);
  const ymin = roundCoordinate(envelope.ymin, precision);
  const xmax = roundCoordinate(envelope.xmax, precision);
  const ymax = roundCoordinate(envelope.ymax, precision);
  if (xmin > xmax || ymin > ymax) throw new RangeError('envelope bounds are inverted');
  return `${xmin},${ymin},${xmax},${ymax},${envelope.spatialReferenceWkid ?? ''}`;
};

export const normalizeSpatialCachePolicy = (policy: Partial<SpatialCachePolicy> = {}): SpatialCachePolicy => {
  const merged = { ...DEFAULT_POLICY, ...policy };
  positiveInteger(merged.maxEntries, 'maxEntries');
  positiveInteger(merged.maxEstimatedBytes, 'maxEstimatedBytes');
  positiveInteger(merged.defaultTtlMs, 'defaultTtlMs');
  positiveInteger(merged.maxTtlMs, 'maxTtlMs');
  if (merged.defaultTtlMs > merged.maxTtlMs) throw new RangeError('defaultTtlMs cannot exceed maxTtlMs');
  if (!Number.isSafeInteger(merged.coordinatePrecision) || merged.coordinatePrecision < 0 || merged.coordinatePrecision > 10) {
    throw new RangeError('coordinatePrecision must be an integer between 0 and 10');
  }
  return Object.freeze(merged);
};

export const createSpatialCacheKey = (input: SpatialCacheKeyInput, precision = DEFAULT_POLICY.coordinatePrecision): string => {
  if (!input.serviceId.trim()) throw new TypeError('serviceId is required');
  if (!Number.isSafeInteger(input.layerId) || input.layerId < 0) throw new RangeError('layerId must be a non-negative safe integer');
  if (!input.operation.trim()) throw new TypeError('operation is required');
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 10) throw new RangeError('precision must be between 0 and 10');

  const fields = [...new Set((input.outFields ?? []).map(normalizeField).filter(Boolean))].sort();
  return [
    normalizeText(input.serviceId),
    input.layerId,
    normalizeText(input.operation).toLowerCase(),
    input.geometryKind ?? '',
    normalizeEnvelope(input.envelope, precision),
    normalizeText(input.where ?? ''),
    fields.join(','),
    normalizeText(input.spatialRelationship ?? ''),
    input.resultOffset ?? '',
    input.resultRecordCount ?? '',
    input.returnGeometry === undefined ? '' : input.returnGeometry ? '1' : '0',
    stableExtra(input.extra),
  ].map(String).join('|');
};

const estimateJsonBytes = (value: unknown): number => {
  try {
    const json = JSON.stringify(value);
    return Math.max(1, new TextEncoder().encode(json ?? '').byteLength);
  } catch {
    return 1;
  }
};

export class SpatialResultCache<T> {
  private readonly policy: SpatialCachePolicy;
  private readonly entries = new Map<string, CacheEntry<T>>();
  private totalBytes = 0;
  private sequence = 0;
  private hits = 0;
  private staleHits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;
  private rejectedOversize = 0;
  private generation = 0;

  public constructor(policy: Partial<SpatialCachePolicy> = {}) {
    this.policy = normalizeSpatialCachePolicy(policy);
  }

  public getPolicy(): SpatialCachePolicy {
    return this.policy;
  }

  public put(key: string, value: T, options: SpatialCachePutOptions = {}): boolean {
    if (!key) throw new TypeError('cache key is required');
    const now = options.now ?? Date.now();
    finiteNonNegative(now, 'now');
    const ttlMs = Math.min(options.ttlMs ?? this.policy.defaultTtlMs, this.policy.maxTtlMs);
    positiveInteger(ttlMs, 'ttlMs');
    const estimatedBytes = Math.ceil(options.estimatedBytes ?? estimateJsonBytes(value));
    positiveInteger(estimatedBytes, 'estimatedBytes');
    if (estimatedBytes > this.policy.maxEstimatedBytes) {
      this.rejectedOversize += 1;
      return false;
    }

    const previous = this.entries.get(key);
    if (previous) {
      this.totalBytes -= previous.estimatedBytes;
      this.entries.delete(key);
    }

    const tags = Object.freeze([...new Set((options.tags ?? []).map(normalizeText).filter(Boolean))].sort());
    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: now,
      expiresAt: now + ttlMs,
      estimatedBytes,
      tags,
      lastAccessAt: now,
      accessSequence: ++this.sequence,
    };
    this.entries.set(key, entry);
    this.totalBytes += estimatedBytes;
    this.generation += 1;
    this.evictToBudget();
    return this.entries.has(key);
  }

  public get(key: string, options: SpatialCacheLookupOptions = {}): SpatialCacheLookup<T> {
    const now = options.now ?? Date.now();
    finiteNonNegative(now, 'now');
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return { status: 'miss' };
    }
    const ageMs = Math.max(0, now - entry.createdAt);
    const expiresInMs = entry.expiresAt - now;
    if (expiresInMs <= 0) {
      if (options.allowStale) {
        this.staleHits += 1;
        entry.lastAccessAt = now;
        entry.accessSequence = ++this.sequence;
        return { status: 'stale', value: entry.value, ageMs, expiresInMs, estimatedBytes: entry.estimatedBytes };
      }
      this.deleteEntry(entry);
      this.expirations += 1;
      this.misses += 1;
      return { status: 'miss' };
    }
    this.hits += 1;
    entry.lastAccessAt = now;
    entry.accessSequence = ++this.sequence;
    return { status: 'hit', value: entry.value, ageMs, expiresInMs, estimatedBytes: entry.estimatedBytes };
  }

  public has(key: string, now = Date.now()): boolean {
    const result = this.get(key, { now });
    return result.status === 'hit';
  }

  public delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.deleteEntry(entry);
    this.generation += 1;
    return true;
  }

  public invalidateTag(tag: string): number {
    const normalized = normalizeText(tag);
    if (!normalized) return 0;
    let removed = 0;
    for (const entry of this.entries.values()) {
      if (entry.tags.includes(normalized)) {
        this.deleteEntry(entry);
        removed += 1;
      }
    }
    if (removed > 0) this.generation += 1;
    return removed;
  }

  public invalidateWhere(predicate: (key: string, tags: readonly string[]) => boolean): number {
    let removed = 0;
    for (const entry of this.entries.values()) {
      if (predicate(entry.key, entry.tags)) {
        this.deleteEntry(entry);
        removed += 1;
      }
    }
    if (removed > 0) this.generation += 1;
    return removed;
  }

  public sweepExpired(now = Date.now()): number {
    finiteNonNegative(now, 'now');
    let removed = 0;
    for (const entry of this.entries.values()) {
      if (entry.expiresAt <= now) {
        this.deleteEntry(entry);
        removed += 1;
      }
    }
    this.expirations += removed;
    if (removed > 0) this.generation += 1;
    return removed;
  }

  public clear(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.totalBytes = 0;
    this.generation += 1;
  }

  public snapshot(): SpatialCacheSnapshot {
    return Object.freeze({
      entries: this.entries.size,
      estimatedBytes: this.totalBytes,
      hits: this.hits,
      staleHits: this.staleHits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      rejectedOversize: this.rejectedOversize,
      generation: this.generation,
    });
  }

  private deleteEntry(entry: CacheEntry<T>): void {
    if (!this.entries.delete(entry.key)) return;
    this.totalBytes = Math.max(0, this.totalBytes - entry.estimatedBytes);
  }

  private evictToBudget(): void {
    while (this.entries.size > this.policy.maxEntries || this.totalBytes > this.policy.maxEstimatedBytes) {
      let victim: CacheEntry<T> | undefined;
      for (const candidate of this.entries.values()) {
        if (!victim || candidate.accessSequence < victim.accessSequence ||
          (candidate.accessSequence === victim.accessSequence && candidate.key.localeCompare(victim.key) < 0)) {
          victim = candidate;
        }
      }
      if (!victim) break;
      this.deleteEntry(victim);
      this.evictions += 1;
    }
  }
}
