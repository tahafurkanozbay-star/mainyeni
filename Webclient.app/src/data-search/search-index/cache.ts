import {
  normalizeInteger,
  normalizeSearchText,
} from '../../Toolbox/DataIntegrityHelper';
import {
  isRecord,
  type CachedIndexSearcher,
  type CachedSearcherOptions,
  type IndexedSearchOptions,
  type IndexedSearchResult,
  type InvertedSearchIndex,
  type QueryCache,
  type QueryCacheOptions,
  type SerializedSearchIndex,
  type UnknownRecord,
} from './contracts';
import {
  createInvertedSearchIndex,
} from './indexing';
import {
  normalizeIndexedSearchOptions,
  searchInvertedIndex,
} from './search';

export const DEFAULT_CACHE_SIZE = 100;
export const DEFAULT_CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export const createQueryCacheKey = (
  query: unknown,
  options: IndexedSearchOptions = {},
): string => JSON.stringify({
  query: normalizeSearchText(query),
  options: normalizeIndexedSearchOptions(options),
});

export const createBoundedQueryCache = <T = unknown>(
  options: QueryCacheOptions = {},
): QueryCache<T> => {
  const maxEntries = normalizeInteger(options.maxEntries, {
    min: 1,
    max: 1_000,
    fallback: DEFAULT_CACHE_SIZE,
  }) ?? DEFAULT_CACHE_SIZE;
  const ttlMs = normalizeInteger(options.ttlMs, {
    min: 1,
    max: 3_600_000,
    fallback: DEFAULT_CACHE_TTL_MS,
  }) ?? DEFAULT_CACHE_TTL_MS;
  const entries = new Map<string, CacheEntry<T>>();

  const removeExpired = (now: number): void => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  };

  const touch = (key: string, entry: CacheEntry<T>): void => {
    entries.delete(key);
    entries.set(key, entry);
  };

  return {
    get(key, now = Date.now()) {
      removeExpired(now);
      const entry = entries.get(key);
      if (!entry) return undefined;
      touch(key, entry);
      return entry.value;
    },

    set(key, value, customTtlMs = ttlMs, now = Date.now()) {
      removeExpired(now);
      const effectiveTtl = normalizeInteger(customTtlMs, {
        min: 1,
        max: 3_600_000,
        fallback: ttlMs,
      }) ?? ttlMs;
      touch(key, { value, expiresAt: now + effectiveTtl });

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return value;
    },

    delete(key) {
      return entries.delete(key);
    },

    clear() {
      entries.clear();
    },

    has(key, now = Date.now()) {
      removeExpired(now);
      return entries.has(key);
    },

    size(now = Date.now()) {
      removeExpired(now);
      return entries.size;
    },

    keys(now = Date.now()) {
      removeExpired(now);
      return Array.from(entries.keys());
    },
  };
};

export const createCachedIndexSearcher = (
  index: InvertedSearchIndex,
  options: CachedSearcherOptions = {},
): CachedIndexSearcher => {
  const cache = options.cache
    ?? createBoundedQueryCache<IndexedSearchResult>(options.cacheOptions);

  return {
    search(query, searchOptions = {}) {
      const key = createQueryCacheKey(query, searchOptions);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const result = searchInvertedIndex(index, query, searchOptions);
      cache.set(key, result, searchOptions.cacheTtlMs);
      return result;
    },

    invalidate() {
      cache.clear();
    },

    cache,
  };
};

export const serializeSearchIndex = (
  index: InvertedSearchIndex,
): SerializedSearchIndex => ({
  version: 1,
  prefixLength: index.prefixLength,
  documents: index.documents.map(document => ({
    ...document,
    source: undefined,
  })) as UnknownRecord[],
  diagnostics: index.diagnostics,
});

export const hydrateSearchIndex = (serialized: unknown): InvertedSearchIndex => {
  if (!isRecord(serialized)
    || serialized.version !== 1
    || !Array.isArray(serialized.documents)) {
    return createInvertedSearchIndex([]);
  }

  return createInvertedSearchIndex(serialized.documents, {
    prefixLength: serialized.prefixLength,
  });
};
