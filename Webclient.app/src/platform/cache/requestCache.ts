export interface RequestCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  clock?: () => number;
}

export interface RequestCacheEntry<T> {
  readonly value: T;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly hits: number;
}

export interface RequestCacheSnapshot {
  readonly size: number;
  readonly maxEntries: number;
  readonly ttlMs: number;
  readonly hits: number;
  readonly misses: number;
  readonly sets: number;
  readonly deletes: number;
  readonly evictions: number;
  readonly expirations: number;
  readonly hitRatio: number | null;
  readonly oldestAgeMs: number | null;
  readonly newestAgeMs: number | null;
}

interface MutableRequestCacheEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number;
  hits: number;
}

const clampInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
};

const normalizeClock = (clock?: () => number): (() => number) =>
  typeof clock === 'function' ? clock : () => Date.now();

const ratio = (numerator: number, denominator: number): number | null => {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
};

/**
 * Bounded in-memory TTL/LRU cache for explicitly cacheable, non-sensitive
 * request results. The cache deliberately does not persist across reloads.
 */
export class RequestCache<T = unknown> {
  readonly ttlMs: number;
  readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly entries = new Map<string, MutableRequestCacheEntry<T>>();
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(options: RequestCacheOptions = {}) {
    this.ttlMs = clampInteger(options.ttlMs, 30000, 0, 3600000);
    this.maxEntries = clampInteger(options.maxEntries, 100, 1, 5000);
    this.clock = normalizeClock(options.clock);
  }

  private isExpired(entry: MutableRequestCacheEntry<T>, now = this.clock()): boolean {
    return entry.expiresAt <= now;
  }

  private touch(key: string, entry: MutableRequestCacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
  }

  get(key: string): T | undefined {
    const normalizedKey = String(key);
    const entry = this.entries.get(normalizedKey);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.entries.delete(normalizedKey);
      this.expirations += 1;
      this.misses += 1;
      return undefined;
    }

    entry.hits += 1;
    this.hits += 1;
    this.touch(normalizedKey, entry);
    return entry.value;
  }

  peek(key: string): T | undefined {
    const normalizedKey = String(key);
    const entry = this.entries.get(normalizedKey);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.entries.delete(normalizedKey);
      this.expirations += 1;
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.peek(key) !== undefined;
  }

  set(key: string, value: T, ttlMs = this.ttlMs): T {
    const normalizedKey = String(key);
    const ttl = clampInteger(ttlMs, this.ttlMs, 0, 3600000);
    this.sets += 1;

    if (ttl === 0) {
      this.entries.delete(normalizedKey);
      return value;
    }

    const now = this.clock();
    this.entries.delete(normalizedKey);
    this.entries.set(normalizedKey, {
      value,
      createdAt: now,
      expiresAt: now + ttl,
      hits: 0
    });
    this.evictOverflow();
    return value;
  }

  getOrSet(key: string, factory: () => T, ttlMs = this.ttlMs): T {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = factory();
    return this.set(key, value, ttlMs);
  }

  delete(key: string): boolean {
    const removed = this.entries.delete(String(key));
    if (removed) this.deletes += 1;
    return removed;
  }

  invalidatePrefix(prefix: string): number {
    const normalizedPrefix = String(prefix);
    let removed = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(normalizedPrefix)) {
        this.entries.delete(key);
        this.deletes += 1;
        removed += 1;
      }
    }
    return removed;
  }

  invalidateWhere(predicate: (key: string, value: T) => boolean): number {
    if (typeof predicate !== 'function') return 0;
    let removed = 0;
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (this.isExpired(entry)) {
        this.entries.delete(key);
        this.expirations += 1;
        continue;
      }
      if (predicate(key, entry.value)) {
        this.entries.delete(key);
        this.deletes += 1;
        removed += 1;
      }
    }
    return removed;
  }

  pruneExpired(): number {
    const now = this.clock();
    let removed = 0;
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (this.isExpired(entry, now)) {
        this.entries.delete(key);
        this.expirations += 1;
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  keys(): readonly string[] {
    this.pruneExpired();
    return Object.freeze(Array.from(this.entries.keys()));
  }

  snapshot(): RequestCacheSnapshot {
    this.pruneExpired();
    const now = this.clock();
    const ages = Array.from(this.entries.values()).map((entry) => Math.max(0, now - entry.createdAt));
    const requests = this.hits + this.misses;

    return Object.freeze({
      size: this.entries.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      evictions: this.evictions,
      expirations: this.expirations,
      hitRatio: ratio(this.hits, requests),
      oldestAgeMs: ages.length ? Math.max(...ages) : null,
      newestAgeMs: ages.length ? Math.min(...ages) : null
    });
  }

  resetStatistics(): void {
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.deletes = 0;
    this.evictions = 0;
    this.expirations = 0;
  }
}

export const createRequestCache = <T = unknown>(
  options: RequestCacheOptions = {}
): RequestCache<T> => new RequestCache<T>(options);
