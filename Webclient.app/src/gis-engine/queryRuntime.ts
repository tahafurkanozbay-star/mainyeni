import type { AbortableOptions, Dictionary } from './contracts';

export interface QueryRuntimeErrorDetails {
  code?: string;
  key?: string | null;
  cause?: unknown;
}

export class QueryRuntimeError extends Error {
  code: string;
  key: string | null;
  cause?: unknown;
  constructor(message: string, details: QueryRuntimeErrorDetails = {}) {
    super(message);
    this.name = 'QueryRuntimeError';
    this.code = details.code || 'QUERY_RUNTIME_ERROR';
    this.key = details.key || null;
    this.cause = details.cause;
  }
}

const DEFAULT_TTL_MS = 30000;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const now = (): number => Date.now();

const normalizePositiveInteger = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.floor(numeric));
};

const normalizeNonNegativeInteger = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
};

const makeCancelledError = (key: string): QueryRuntimeError => new QueryRuntimeError('GIS query cancelled.', { code: 'CANCELLED', key });
const makeDestroyedError = (key: string): QueryRuntimeError => new QueryRuntimeError('GIS query runtime has been destroyed.', { code: 'RUNTIME_DESTROYED', key });
const throwIfAborted = (signal: AbortSignal | undefined, key: string): void => { if (signal?.aborted) throw makeCancelledError(key); };

const safeJsonSize = (value: unknown): number => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return 0;
    return serialized.length * 2;
  } catch (_) { return 0; }
};

const normalizeKey = (key: unknown): string => {
  if (key === null || key === undefined || key === '') {
    throw new QueryRuntimeError('A stable query key is required.', { code: 'INVALID_QUERY_KEY' });
  }
  return String(key);
};

export interface QueryRuntimeConfiguration { ttlMs?: number; maxEntries?: number; maxBytes?: number; }
export interface QueryRuntimeSettings { ttlMs: number; maxEntries: number; maxBytes: number; }
export interface QueryCacheEntry<T = unknown> {
  key: string; value: T; createdAt: number; lastAccessAt: number; expiresAt: number; sizeBytes: number; hits: number; tags: string[];
}
export interface QueryCacheMetadata { key: string; createdAt: number; lastAccessAt: number; expiresAt: number; sizeBytes: number; hits: number; tags: string[]; }
export interface QueryRuntimeMetrics {
  requests: number; networkStarts: number; cacheHits: number; cacheMisses: number; cacheWrites: number; cacheSkips: number;
  cacheExpirations: number; cacheEvictions: number; deduped: number; cancellations: number; sharedAborts: number; errors: number;
  successes: number; totalDurationMs: number; lastDurationMs: number | null;
}
export interface QueryRuntimeStats extends QueryRuntimeMetrics { cacheEntries: number; cacheBytes: number; inFlight: number; subscribers: number; }
export interface QueryFactoryContext { key: string; signal?: AbortSignal; startedAt: number; }
export type QueryFactory<T> = (context: QueryFactoryContext) => T | Promise<T>;
export interface QueryExecuteOptions<T = unknown> extends AbortableOptions {
  cache?: boolean; dedupe?: boolean; ttlMs?: number; tags?: unknown[]; isCacheable?: (value: T) => boolean; sizeOf?: (value: T) => number;
}
interface QueryInFlightEntry<T = unknown> { key: string; controller: AbortController | null; subscribers: Set<object>; settled: boolean; startedAt: number; promise: Promise<T>; }
interface RuntimeState { cache: Map<string, QueryCacheEntry>; cacheBytes: number; inFlight: Map<string, QueryInFlightEntry>; destroyed: boolean; }

const cloneMetrics = (metrics: QueryRuntimeMetrics, runtime: RuntimeState): QueryRuntimeStats => ({
  ...metrics,
  cacheEntries: runtime.cache.size,
  cacheBytes: runtime.cacheBytes,
  inFlight: runtime.inFlight.size,
  subscribers: Array.from(runtime.inFlight.values()).reduce((total, entry) => total + entry.subscribers.size, 0),
});
const defaultCacheable = (): boolean => true;
const createAbortController = (): AbortController | null => typeof AbortController === 'undefined' ? null : new AbortController();
const touchEntry = <T>(cache: Map<string, QueryCacheEntry<T>>, key: string, entry: QueryCacheEntry<T>): void => { cache.delete(key); cache.set(key, entry); };

export interface QueryRuntime {
  execute: <T>(key: unknown, factory: QueryFactory<T>, options?: QueryExecuteOptions<T>) => Promise<T>;
  prefetch: <T>(key: unknown, factory: QueryFactory<T>, options?: QueryExecuteOptions<T>) => Promise<T>;
  getCached: <T = unknown>(key: unknown, options?: QueryExecuteOptions<T>) => T | undefined;
  peek: (key: unknown) => QueryCacheMetadata | null;
  invalidate: (selector: unknown) => number;
  invalidateTag: (tag: unknown) => number;
  sweepExpired: (currentTime?: number) => number;
  clear: (options?: { abortInFlight?: boolean }) => void;
  destroy: () => void;
  configure: (patch?: QueryRuntimeConfiguration) => QueryRuntimeSettings;
  getSettings: () => QueryRuntimeSettings;
  getStats: () => QueryRuntimeStats;
}

export const createQueryRuntime = (configuration: QueryRuntimeConfiguration = {}): QueryRuntime => {
  const settings: QueryRuntimeSettings = {
    ttlMs: normalizePositiveInteger(configuration.ttlMs, DEFAULT_TTL_MS, 24 * 60 * 60 * 1000),
    maxEntries: normalizePositiveInteger(configuration.maxEntries, DEFAULT_MAX_ENTRIES, 10000),
    maxBytes: normalizePositiveInteger(configuration.maxBytes, DEFAULT_MAX_BYTES, 256 * 1024 * 1024),
  };
  const runtime: RuntimeState = { cache: new Map(), cacheBytes: 0, inFlight: new Map(), destroyed: false };
  const metrics: QueryRuntimeMetrics = {
    requests: 0, networkStarts: 0, cacheHits: 0, cacheMisses: 0, cacheWrites: 0, cacheSkips: 0,
    cacheExpirations: 0, cacheEvictions: 0, deduped: 0, cancellations: 0, sharedAborts: 0, errors: 0,
    successes: 0, totalDurationMs: 0, lastDurationMs: null,
  };

  const deleteCacheEntry = (key: string, reason: 'expired' | 'evicted' | null = null): boolean => {
    const entry = runtime.cache.get(key);
    if (!entry) return false;
    runtime.cache.delete(key);
    runtime.cacheBytes = Math.max(0, runtime.cacheBytes - entry.sizeBytes);
    if (reason === 'expired') metrics.cacheExpirations += 1;
    if (reason === 'evicted') metrics.cacheEvictions += 1;
    return true;
  };
  const evictToBudget = (): void => {
    while (runtime.cache.size > settings.maxEntries || runtime.cacheBytes > settings.maxBytes) {
      const oldestKey = runtime.cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      deleteCacheEntry(oldestKey, 'evicted');
    }
  };
  const sweepExpired = (currentTime = now()): number => {
    runtime.cache.forEach((entry, key) => { if (entry.expiresAt <= currentTime) deleteCacheEntry(key, 'expired'); });
    return runtime.cache.size;
  };
  const readCache = <T>(key: string, options: QueryExecuteOptions<T> = {}): { hit: boolean; value?: T } => {
    if (options.cache === false) return { hit: false };
    const entry = runtime.cache.get(key) as QueryCacheEntry<T> | undefined;
    if (!entry) { metrics.cacheMisses += 1; return { hit: false }; }
    if (entry.expiresAt <= now()) { deleteCacheEntry(key, 'expired'); metrics.cacheMisses += 1; return { hit: false }; }
    entry.lastAccessAt = now(); entry.hits += 1; touchEntry(runtime.cache as Map<string, QueryCacheEntry<T>>, key, entry); metrics.cacheHits += 1;
    return { hit: true, value: entry.value };
  };
  const writeCache = <T>(key: string, value: T, options: QueryExecuteOptions<T> = {}): boolean => {
    if (options.cache === false) { metrics.cacheSkips += 1; return false; }
    const isCacheable = typeof options.isCacheable === 'function' ? options.isCacheable : defaultCacheable;
    if (!isCacheable(value)) { metrics.cacheSkips += 1; return false; }
    const sizeBytes = normalizeNonNegativeInteger(typeof options.sizeOf === 'function' ? options.sizeOf(value) : safeJsonSize(value), 0);
    if (sizeBytes > settings.maxBytes) { metrics.cacheSkips += 1; return false; }
    const ttlMs = normalizePositiveInteger(options.ttlMs, settings.ttlMs, 24 * 60 * 60 * 1000);
    const createdAt = now();
    const existing = runtime.cache.get(key);
    if (existing) runtime.cacheBytes = Math.max(0, runtime.cacheBytes - existing.sizeBytes);
    runtime.cache.delete(key);
    runtime.cache.set(key, { key, value, createdAt, lastAccessAt: createdAt, expiresAt: createdAt + ttlMs, sizeBytes, hits: 0, tags: Array.isArray(options.tags) ? [...new Set(options.tags.map(String))] : [] });
    runtime.cacheBytes += sizeBytes; metrics.cacheWrites += 1; evictToBudget(); return runtime.cache.has(key);
  };
  const releaseSubscriber = (entry: QueryInFlightEntry, token: object, reason: 'cancelled' | null = null): void => {
    if (!entry.subscribers.has(token)) return;
    entry.subscribers.delete(token);
    if (reason === 'cancelled') metrics.cancellations += 1;
    if (!entry.settled && entry.subscribers.size === 0 && entry.controller && !entry.controller.signal.aborted) {
      entry.controller.abort(); metrics.sharedAborts += 1;
    }
  };
  const subscribe = <T>(entry: QueryInFlightEntry<T>, externalSignal?: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
    const token = {};
    let completed = false;
    let abortHandler: (() => void) | null = null;
    const finish = (callback: (value: any) => void, value: unknown, reason: 'cancelled' | null = null): void => {
      if (completed) return;
      completed = true;
      if (abortHandler && externalSignal) externalSignal.removeEventListener('abort', abortHandler);
      releaseSubscriber(entry, token, reason);
      callback(value);
    };
    entry.subscribers.add(token);
    if (externalSignal) {
      abortHandler = () => finish(reject, makeCancelledError(entry.key), 'cancelled');
      if (externalSignal.aborted) { abortHandler(); return; }
      externalSignal.addEventListener('abort', abortHandler, { once: true });
    }
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
  const startRequest = <T>(key: string, factory: QueryFactory<T>, options: QueryExecuteOptions<T>): QueryInFlightEntry<T> => {
    if (runtime.destroyed) throw makeDestroyedError(key);
    if (typeof factory !== 'function') throw new QueryRuntimeError('A query request factory is required.', { code: 'INVALID_QUERY_FACTORY', key });
    const controller = createAbortController();
    const startedAt = now();
    const entry: QueryInFlightEntry<T> = { key, controller, subscribers: new Set(), settled: false, startedAt, promise: Promise.resolve(undefined as unknown as T) };
    metrics.networkStarts += 1;
    let requestPromise: Promise<T>;
    try {
      requestPromise = Promise.resolve(factory({
        key,
        ...(controller ? { signal: controller.signal } : {}),
        startedAt,
      }));
    }
    catch (error) { requestPromise = Promise.reject(error); }
    entry.promise = requestPromise
      .then((value) => { metrics.successes += 1; writeCache(key, value, options); return value; })
      .catch((error) => { const sharedAbort = controller?.signal?.aborted && entry.subscribers.size === 0; if (!sharedAbort) metrics.errors += 1; throw error; })
      .finally(() => { entry.settled = true; const duration = Math.max(0, now() - startedAt); metrics.totalDurationMs += duration; metrics.lastDurationMs = duration; if (runtime.inFlight.get(key) === entry) runtime.inFlight.delete(key); });
    entry.promise.catch(() => {});
    runtime.inFlight.set(key, entry as QueryInFlightEntry);
    return entry;
  };
  const execute = async <T>(rawKey: unknown, factory: QueryFactory<T>, options: QueryExecuteOptions<T> = {}): Promise<T> => {
    const key = normalizeKey(rawKey);
    if (runtime.destroyed) throw makeDestroyedError(key);
    throwIfAborted(options.signal, key); metrics.requests += 1;
    const cached = readCache(key, options); if (cached.hit) return cached.value as T;
    let entry = options.dedupe === false ? null : runtime.inFlight.get(key) as QueryInFlightEntry<T> | undefined | null;
    if (entry) metrics.deduped += 1; else entry = startRequest(key, factory, options);
    return subscribe(entry, options.signal);
  };
  const prefetch = async <T>(rawKey: unknown, factory: QueryFactory<T>, options: QueryExecuteOptions<T> = {}): Promise<T> => {
    const { signal: _signal, ...prefetchOptions } = options;
    return execute(rawKey, factory, prefetchOptions);
  };
  const getCached = <T = unknown>(rawKey: unknown, options: QueryExecuteOptions<T> = {}): T | undefined => {
    const cached = readCache<T>(normalizeKey(rawKey), options); return cached.hit ? cached.value : undefined;
  };
  const peek = (rawKey: unknown): QueryCacheMetadata | null => {
    const key = normalizeKey(rawKey); const entry = runtime.cache.get(key); if (!entry || entry.expiresAt <= now()) return null;
    return { key: entry.key, createdAt: entry.createdAt, lastAccessAt: entry.lastAccessAt, expiresAt: entry.expiresAt, sizeBytes: entry.sizeBytes, hits: entry.hits, tags: [...entry.tags] };
  };
  const invalidate = (selector: unknown): number => {
    let removed = 0;
    const predicate: (value: unknown, key: string, entry: QueryCacheEntry) => boolean = typeof selector === 'function'
      ? selector as (value: unknown, key: string, entry: QueryCacheEntry) => boolean
      : (_value, key) => key === String(selector);
    [...runtime.cache.entries()].forEach(([key, entry]) => { if (predicate(entry.value, key, entry) && deleteCacheEntry(key)) removed += 1; });
    return removed;
  };
  const invalidateTag = (tag: unknown): number => invalidate((_value: unknown, _key: string, entry: QueryCacheEntry) => entry.tags.includes(String(tag)));
  const clear = ({ abortInFlight = false }: { abortInFlight?: boolean } = {}): void => {
    runtime.cache.clear(); runtime.cacheBytes = 0;
    if (abortInFlight) { runtime.inFlight.forEach((entry) => { if (entry.controller && !entry.controller.signal.aborted) entry.controller.abort(); }); runtime.inFlight.clear(); }
  };
  const destroy = (): void => { if (runtime.destroyed) return; runtime.destroyed = true; clear({ abortInFlight: true }); };
  const configure = (patch: QueryRuntimeConfiguration = {}): QueryRuntimeSettings => {
    if (patch.ttlMs !== undefined) settings.ttlMs = normalizePositiveInteger(patch.ttlMs, settings.ttlMs, 24 * 60 * 60 * 1000);
    if (patch.maxEntries !== undefined) settings.maxEntries = normalizePositiveInteger(patch.maxEntries, settings.maxEntries, 10000);
    if (patch.maxBytes !== undefined) settings.maxBytes = normalizePositiveInteger(patch.maxBytes, settings.maxBytes, 256 * 1024 * 1024);
    evictToBudget(); return { ...settings };
  };
  return { execute, prefetch, getCached, peek, invalidate, invalidateTag, sweepExpired, clear, destroy, configure, getSettings: () => ({ ...settings }), getStats: () => cloneMetrics(metrics, runtime) };
};

export interface ArcGisQueryCachePolicyOptions { cache?: boolean; ttlMs?: number; tags?: unknown[]; }
export interface ArcGisQueryResultLike extends Dictionary { type?: string; exceededTransferLimit?: boolean; page?: { hasMore?: boolean }; }
export const createArcGisQueryCachePolicy = (options: ArcGisQueryCachePolicyOptions = {}): QueryExecuteOptions<ArcGisQueryResultLike> => ({
  cache: options.cache !== false,
  ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  ...(options.tags !== undefined ? { tags: options.tags } : {}),
  isCacheable: (result) => Boolean(result && result.type !== 'error' && result.exceededTransferLimit !== true && result.page?.hasMore !== true),
});
export interface QueryRuntimeKeyInput { serviceUrl?: unknown; operation?: unknown; queryKey?: unknown; }
export const createQueryRuntimeKey = ({ serviceUrl, operation = 'features', queryKey = '' }: QueryRuntimeKeyInput = {}): string => {
  const normalizedUrl = String(serviceUrl || '').trim().replace(/\/+$/, '');
  const normalizedOperation = String(operation || 'features').trim().toLowerCase();
  if (!normalizedUrl) throw new QueryRuntimeError('A service URL is required to build a query runtime key.', { code: 'INVALID_SERVICE_URL' });
  return `${normalizedOperation}:${normalizedUrl}:${String(queryKey || '')}`;
};
