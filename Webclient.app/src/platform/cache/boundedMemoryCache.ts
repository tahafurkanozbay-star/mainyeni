import {
  CacheContractError,
  cacheDuration,
  cacheKey,
  cacheNamespace,
  cloneStoredValue,
  safeCacheNow,
  stateAt,
  SYSTEM_CACHE_CLOCK,
  type CacheCapacityOptions,
  type CacheClock,
  type CacheReadResult,
  type CacheStoredValue,
  type CacheWriteRequest,
} from './cacheContracts';
import { cacheAdmissionReason } from './cacheAdmission';
import { normalizeCacheBudget } from './cacheBudgetLimits';
import { CacheEventJournal } from './cacheEventJournal';
import { CacheLruIndex } from './cacheLruIndex';
import { CacheNamespaceLedger } from './cacheNamespaceLedger';
import { BoundedCacheTagIndex } from './cacheTagIndex';
import { estimateCacheValueBytes } from './cacheValueSize';

export interface BoundedMemoryCacheOptions extends CacheCapacityOptions {
  readonly clock?: CacheClock;
}

export interface MemoryCacheSnapshot {
  readonly entries: number;
  readonly bytes: number;
  readonly namespaces: number;
  readonly hits: number;
  readonly staleHits: number;
  readonly misses: number;
  readonly writes: number;
  readonly removals: number;
  readonly evictions: number;
  readonly rejectedWrites: number;
  readonly disposed: boolean;
}

interface CacheStats {
  hits: number;
  staleHits: number;
  misses: number;
  writes: number;
  removals: number;
  evictions: number;
  rejectedWrites: number;
}

export class BoundedMemoryCache {
  readonly #limits;
  readonly #clock: CacheClock;
  readonly #entries = new Map<string, CacheStoredValue<unknown>>();
  readonly #lru = new CacheLruIndex();
  readonly #ledger = new CacheNamespaceLedger();
  readonly #tags: BoundedCacheTagIndex;
  readonly #journal: CacheEventJournal;
  readonly #stats: CacheStats = {
    hits: 0,
    staleHits: 0,
    misses: 0,
    writes: 0,
    removals: 0,
    evictions: 0,
    rejectedWrites: 0,
  };
  #bytes = 0;
  #lastNow: number | undefined;
  #disposed = false;

  constructor(options: BoundedMemoryCacheOptions = {}) {
    this.#limits = normalizeCacheBudget(options);
    this.#clock = options.clock ?? SYSTEM_CACHE_CLOCK;
    this.#tags = new BoundedCacheTagIndex({
      maxTagsPerKey: this.#limits.maxTagsPerEntry,
    });
    this.#journal = new CacheEventJournal(this.#limits.historyLimit, this.#clock);
  }

  get<T>(rawKey: string, allowStale = true): CacheReadResult<T> {
    this.#assertOpen();
    const key = cacheKey(rawKey, this.#limits.maxKeyLength);
    const entry = this.#entries.get(key);
    if (!entry) {
      this.#stats.misses += 1;
      this.#journal.record('miss');
      return Object.freeze({ hit: false, state: 'miss', source: 'memory' });
    }

    const now = this.#now();
    const state = stateAt(entry, now);
    if (state === 'expired') {
      this.#remove(key, 'expired');
      this.#stats.misses += 1;
      this.#journal.record('miss');
      return Object.freeze({ hit: false, state: 'miss', source: 'memory' });
    }
    if (state === 'stale' && !allowStale) {
      this.#stats.misses += 1;
      this.#journal.record('miss');
      return Object.freeze({ hit: false, state: 'miss', source: 'memory' });
    }

    this.#lru.touch(key);
    const typed = cloneStoredValue(entry as CacheStoredValue<T>);
    if (state === 'fresh') {
      this.#stats.hits += 1;
      this.#journal.record('hit');
      return Object.freeze({
        hit: true,
        state,
        source: 'memory',
        value: typed.value,
        entry: typed,
      });
    }

    this.#stats.staleHits += 1;
    this.#journal.record('stale-hit');
    return Object.freeze({
      hit: true,
      state,
      source: 'stale-memory',
      value: typed.value,
      entry: typed,
    });
  }

  put<T>(request: CacheWriteRequest<T>): CacheStoredValue<T> {
    this.#assertOpen();
    const key = cacheKey(request.key, this.#limits.maxKeyLength);
    const namespace = cacheNamespace(request.namespace, this.#limits.maxNamespaceLength);
    const ttlMs = cacheDuration('ttlMs', request.ttlMs);
    const staleMs = cacheDuration(
      'staleWhileRevalidateMs',
      request.staleWhileRevalidateMs ?? 0,
    );
    if (ttlMs === 0) {
      this.#stats.rejectedWrites += 1;
      throw new CacheContractError('invalid-duration', 'cache ttl must be greater than zero');
    }

    const byteSize = request.byteSize ?? estimateCacheValueBytes(request.value);
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
      this.#stats.rejectedWrites += 1;
      throw new CacheContractError('invalid-byte-size', 'cache byte size is invalid');
    }

    const existing = this.#entries.get(key);
    this.#makeCapacity(namespace, byteSize, existing);
    const now = this.#now();
    const tags = request.tags ?? [];
    this.#tags.register(key, namespace, tags);

    if (existing) this.#detachAccounting(existing);
    const entry: CacheStoredValue<T> = Object.freeze({
      key,
      namespace,
      value: request.value,
      createdAt: existing?.createdAt ?? now,
      refreshedAt: now,
      freshUntil: now + ttlMs,
      staleUntil: now + ttlMs + staleMs,
      byteSize,
      tags: Object.freeze([...this.#tags.tagsForKey(key)]),
      version: request.version ?? ((existing?.version ?? 0) + 1),
    });
    this.#entries.set(key, entry as CacheStoredValue<unknown>);
    this.#attachAccounting(entry);
    this.#stats.writes += 1;
    this.#journal.record(existing ? 'replace' : 'write');
    return cloneStoredValue(entry);
  }

  delete(rawKey: string): boolean {
    this.#assertOpen();
    return this.#remove(cacheKey(rawKey, this.#limits.maxKeyLength), 'explicit');
  }

  invalidateTags(tags: readonly string[]): number {
    this.#assertOpen();
    const keys = this.#tags.keysForTags(tags);
    let removed = 0;
    for (const key of keys) if (this.#remove(key, 'tag-invalidation')) removed += 1;
    if (removed > 0) this.#journal.record('invalidate');
    return removed;
  }

  invalidateNamespace(rawNamespace: string): number {
    this.#assertOpen();
    const namespace = cacheNamespace(rawNamespace, this.#limits.maxNamespaceLength);
    const keys = this.#tags.keysForNamespace(namespace);
    let removed = 0;
    for (const key of keys) if (this.#remove(key, 'namespace-invalidation')) removed += 1;
    if (removed > 0) this.#journal.record('invalidate');
    return removed;
  }

  pruneExpired(limit = this.#limits.maxEntries): number {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#limits.maxEntries) {
      throw new RangeError('prune limit is invalid');
    }
    const now = this.#now();
    let removed = 0;
    for (const key of this.#lru.keysOldestFirst()) {
      if (removed >= limit) break;
      const entry = this.#entries.get(key);
      if (entry && stateAt(entry, now) === 'expired' && this.#remove(key, 'expired')) {
        removed += 1;
      }
    }
    if (removed > 0) this.#journal.record('prune');
    return removed;
  }

  snapshot(): MemoryCacheSnapshot {
    return Object.freeze({
      entries: this.#entries.size,
      bytes: this.#bytes,
      namespaces: this.#ledger.count(),
      ...this.#stats,
      disposed: this.#disposed,
    });
  }

  history() {
    return this.#journal.entries();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#entries.clear();
    this.#lru.clear();
    this.#ledger.clear();
    this.#tags.clear();
    this.#bytes = 0;
    this.#journal.record('dispose');
  }

  assertConsistent(): void {
    this.#ledger.assertTotal(this.#entries.size, this.#bytes);
    this.#lru.assertContains(new Set(this.#entries.keys()));
  }

  #makeCapacity(
    namespace: string,
    byteSize: number,
    replacing: CacheStoredValue<unknown> | undefined,
  ): void {
    const maximumEvictions = Math.min(this.#entries.size, this.#limits.maxEntries);
    for (let attempt = 0; attempt <= maximumEvictions; attempt += 1) {
      const namespaceUsage = this.#ledger.usage(namespace);
      const reason = cacheAdmissionReason(this.#limits, {
        byteSize,
        namespaceExists: namespaceUsage.entries > 0,
        replacing: replacing !== undefined,
        ...(replacing ? { replacedByteSize: replacing.byteSize } : {}),
        global: {
          entries: this.#entries.size,
          bytes: this.#bytes,
          namespaces: this.#ledger.count(),
        },
        namespace: {
          entries: namespaceUsage.entries,
          bytes: namespaceUsage.bytes,
        },
      });
      if (!reason) return;
      if (reason === 'entry-too-large') {
        this.#stats.rejectedWrites += 1;
        throw new CacheContractError('entry-too-large', 'cache entry exceeds maximum byte size');
      }

      const candidate = this.#evictionCandidate(
        reason === 'namespace-entry-capacity' || reason === 'namespace-byte-capacity'
          ? namespace
          : undefined,
        replacing?.key,
      );
      if (!candidate || !this.#remove(candidate, 'capacity')) {
        this.#stats.rejectedWrites += 1;
        throw new CacheContractError('namespace-limit', 'cache capacity cannot admit entry');
      }
      this.#stats.evictions += 1;
      if (attempt === maximumEvictions) break;
    }
    this.#stats.rejectedWrites += 1;
    throw new CacheContractError('namespace-limit', 'cache eviction bound exhausted');
  }

  #evictionCandidate(namespace?: string, excludedKey?: string): string | undefined {
    for (const key of this.#lru.keysOldestFirst()) {
      if (key === excludedKey) continue;
      const entry = this.#entries.get(key);
      if (!entry) continue;
      if (namespace && entry.namespace !== namespace) continue;
      return key;
    }
    return undefined;
  }

  #remove(key: string, _reason: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#tags.remove(key);
    this.#detachAccounting(entry);
    this.#stats.removals += 1;
    this.#journal.record('remove');
    return true;
  }

  #attachAccounting(entry: CacheStoredValue<unknown>): void {
    this.#bytes += entry.byteSize;
    this.#ledger.add(entry.namespace, entry.byteSize);
    this.#lru.touch(entry.key);
  }

  #detachAccounting(entry: CacheStoredValue<unknown>): void {
    this.#bytes -= entry.byteSize;
    this.#ledger.remove(entry.namespace, entry.byteSize);
    this.#lru.remove(entry.key);
  }

  #now(): number {
    const now = safeCacheNow(this.#clock, this.#lastNow);
    this.#lastNow = now;
    return now;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new CacheContractError('disposed', 'cache store is disposed');
  }
}
