export interface RequestCacheOptions<TValue = unknown> {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxWeight?: number;
  readonly estimateWeight?: (value: TValue, key: string) => number;
  readonly now?: () => number;
}

export interface CacheEntrySnapshot {
  readonly key: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastAccessedAt: number;
  readonly accessCount: number;
  readonly weight: number;
}

export interface RequestCacheSnapshot {
  readonly size: number;
  readonly totalWeight: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly expirations: number;
  readonly writes: number;
  readonly hitRatio: number;
  readonly entries: readonly CacheEntrySnapshot[];
}

interface CacheEntry<TValue> {
  value: TValue;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  accessCount: number;
  weight: number;
}

const clampInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
};

const normalizeKey = (value: unknown): string => {
  const key = String(value ?? '');
  if (!key) throw new Error('Request cache key is required.');
  return key;
};

const defaultWeight = <TValue>(value: TValue): number => {
  if (typeof value === 'string') return Math.max(1, value.length * 2);
  if (value instanceof ArrayBuffer) return Math.max(1, value.byteLength);
  if (ArrayBuffer.isView(value)) return Math.max(1, value.byteLength);
  return 1;
};

/** Bounded in-memory TTL/LRU cache for explicitly cacheable, non-sensitive GET/HEAD responses. */
export class RequestCache<TValue = unknown> {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly maxWeight: number;
  private readonly entries = new Map<string, CacheEntry<TValue>>();
  private readonly estimateWeight: (value: TValue, key: string) => number;
  private readonly now: () => number;
  private totalWeight = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;
  private writes = 0;

  constructor(options: RequestCacheOptions<TValue> = {}) {
    this.ttlMs = clampInteger(options.ttlMs, 30000, 0, 60 * 60 * 1000);
    this.maxEntries = clampInteger(options.maxEntries, 100, 1, 10000);
    this.maxWeight = clampInteger(options.maxWeight, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    this.estimateWeight = options.estimateWeight ?? defaultWeight;
    this.now = options.now ?? Date.now;
  }

  private touch(key: string, entry: CacheEntry<TValue>): void {
    entry.lastAccessedAt = this.now();
    entry.accessCount += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private remove(key: string, reason: 'delete' | 'evict' | 'expire'): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.totalWeight = Math.max(0, this.totalWeight - entry.weight);
    if (reason === 'evict') this.evictions += 1;
    if (reason === 'expire') this.expirations += 1;
    return true;
  }

  private sweepExpired(now = this.now()): number {
    let removed = 0;
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (entry.expiresAt <= now && this.remove(key, 'expire')) removed += 1;
    }
    return removed;
  }

  private enforceBounds(): void {
    this.sweepExpired();
    while (this.entries.size > this.maxEntries || this.totalWeight > this.maxWeight) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.remove(oldestKey, 'evict');
    }
  }

  get(keyValue: string): TValue | undefined {
    const key = normalizeKey(keyValue);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.remove(key, 'expire');
      this.misses += 1;
      return undefined;
    }

    this.hits += 1;
    this.touch(key, entry);
    return entry.value;
  }

  peek(keyValue: string): TValue | undefined {
    const key = normalizeKey(keyValue);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.remove(key, 'expire');
      return undefined;
    }
    return entry.value;
  }

  has(keyValue: string): boolean {
    return this.peek(keyValue) !== undefined;
  }

  set(keyValue: string, value: TValue, ttlMs = this.ttlMs): TValue {
    const key = normalizeKey(keyValue);
    const ttl = clampInteger(ttlMs, this.ttlMs, 0, 60 * 60 * 1000);
    if (ttl === 0) return value;

    const estimated = Number(this.estimateWeight(value, key));
    const weight = Number.isFinite(estimated) ? Math.max(1, Math.trunc(estimated)) : 1;
    if (weight > this.maxWeight) {
      this.delete(key);
      return value;
    }

    const existing = this.entries.get(key);
    if (existing) this.totalWeight = Math.max(0, this.totalWeight - existing.weight);

    const now = this.now();
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      createdAt: now,
      expiresAt: now + ttl,
      lastAccessedAt: now,
      accessCount: 0,
      weight,
    });
    this.totalWeight += weight;
    this.writes += 1;
    this.enforceBounds();
    return value;
  }

  getOrSet(keyValue: string, factory: () => TValue, ttlMs = this.ttlMs): TValue {
    const existing = this.get(keyValue);
    if (existing !== undefined) return existing;
    const value = factory();
    return this.set(keyValue, value, ttlMs);
  }

  async getOrCreate(
    keyValue: string,
    factory: () => Promise<TValue> | TValue,
    ttlMs = this.ttlMs,
  ): Promise<TValue> {
    const existing = this.get(keyValue);
    if (existing !== undefined) return existing;
    const value = await factory();
    return this.set(keyValue, value, ttlMs);
  }

  delete(keyValue: string): boolean {
    return this.remove(normalizeKey(keyValue), 'delete');
  }

  invalidatePrefix(prefixValue: string): number {
    const prefix = String(prefixValue ?? '');
    let removed = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix) && this.remove(key, 'delete')) removed += 1;
    }
    return removed;
  }

  invalidateWhere(predicate: (key: string, value: TValue) => boolean): number {
    if (typeof predicate !== 'function') return 0;
    let removed = 0;
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (predicate(key, entry.value) && this.remove(key, 'delete')) removed += 1;
    }
    return removed;
  }

  prune(): number {
    return this.sweepExpired();
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  size(): number {
    this.sweepExpired();
    return this.entries.size;
  }

  weight(): number {
    this.sweepExpired();
    return this.totalWeight;
  }

  keys(): readonly string[] {
    this.sweepExpired();
    return Object.freeze(Array.from(this.entries.keys()));
  }

  snapshot(): RequestCacheSnapshot {
    this.sweepExpired();
    const totalReads = this.hits + this.misses;
    return Object.freeze({
      size: this.entries.size,
      totalWeight: this.totalWeight,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      writes: this.writes,
      hitRatio: totalReads > 0 ? Math.round((this.hits / totalReads) * 10000) / 10000 : 0,
      entries: Object.freeze(Array.from(this.entries.entries()).map(([key, entry]) => Object.freeze({
        key,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        lastAccessedAt: entry.lastAccessedAt,
        accessCount: entry.accessCount,
        weight: entry.weight,
      }))),
    });
  }
}

export const createRequestCache = <TValue = unknown>(options?: RequestCacheOptions<TValue>): RequestCache<TValue> =>
  new RequestCache<TValue>(options);
