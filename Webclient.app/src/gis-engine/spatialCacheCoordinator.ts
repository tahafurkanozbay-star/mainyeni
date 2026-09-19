export type SpatialCachePriority = 'critical' | 'high' | 'normal' | 'low';

export interface SpatialCacheEntry<TValue> {
  key: string;
  value: TValue;
  tags: readonly string[];
  priority: SpatialCachePriority;
  createdAt: number;
  expiresAt: number;
  lastAccessAt: number;
  hits: number;
  estimatedBytes: number;
}

export interface SpatialCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxInFlight?: number;
  maxKeyLength?: number;
  maxTagsPerEntry?: number;
  maxTagLength?: number;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  now?: () => number;
  estimateBytes?: (value: unknown) => number;
  onEvict?: (key: string, reason: string) => void;
  onObserverError?: (error: unknown) => void;
}

export interface SpatialCachePutOptions {
  ttlMs?: number;
  tags?: readonly string[];
  priority?: SpatialCachePriority;
  estimatedBytes?: number;
}

export interface SpatialCacheSnapshot {
  size: number;
  estimatedBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  dedupeHits: number;
  rejectedRequests: number;
  abortedSubscribers: number;
  activeRequests: number;
  activeSubscribers: number;
  keys: readonly string[];
}

export interface SpatialRequestOptions extends SpatialCachePutOptions {
  signal?: AbortSignal;
  bypassCache?: boolean;
}

export interface SpatialCacheCoordinator {
  get: <TValue>(key: string) => TValue | undefined;
  put: <TValue>(key: string, value: TValue, options?: SpatialCachePutOptions) => SpatialCacheEntry<TValue>;
  has: (key: string) => boolean;
  delete: (key: string, reason?: string) => boolean;
  invalidateTags: (tags: readonly string[], reason?: string) => number;
  clear: (reason?: string) => void;
  request: <TValue>(
    key: string,
    loader: (signal: AbortSignal) => Promise<TValue>,
    options?: SpatialRequestOptions,
  ) => Promise<TValue>;
  getSnapshot: () => SpatialCacheSnapshot;
}

export class SpatialCacheCapacityError extends Error {
  public readonly code = 'SPATIAL_CACHE_CAPACITY';

  public constructor(message: string) {
    super(message);
    this.name = 'SpatialCacheCapacityError';
  }
}

interface MutableEntry<TValue = unknown> {
  key: string;
  value: TValue;
  tags: readonly string[];
  priority: SpatialCachePriority;
  createdAt: number;
  expiresAt: number;
  lastAccessAt: number;
  hits: number;
  estimatedBytes: number;
  sequence: number;
}

interface RequestSubscriber<TValue> {
  readonly id: number;
  readonly resolve: (value: TValue) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
}

interface InFlightRequest<TValue = unknown> {
  readonly key: string;
  readonly controller: AbortController;
  readonly loader: (signal: AbortSignal) => Promise<TValue>;
  readonly options: SpatialRequestOptions;
  readonly subscribers: Map<number, RequestSubscriber<TValue>>;
  settled: boolean;
}

interface CacheRead<TValue> {
  readonly found: boolean;
  readonly value: TValue | undefined;
}

const PRIORITY_WEIGHT: Readonly<Record<SpatialCachePriority, number>> = Object.freeze({
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
});

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 64;
const DEFAULT_MAX_KEY_LENGTH = 1_024;
const DEFAULT_MAX_TAGS = 32;
const DEFAULT_MAX_TAG_LENGTH = 128;
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_TTL_MS = 10 * 60_000;

const positiveInteger = (value: unknown, fallback: number, label: string): number => {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return candidate;
};

const nonNegativeInteger = (value: unknown, fallback: number, label: string): number => {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return candidate;
};

const normalizePriority = (priority: SpatialCachePriority | undefined): SpatialCachePriority => {
  if (priority === undefined) return 'normal';
  if (priority === 'critical' || priority === 'high' || priority === 'normal' || priority === 'low') {
    return priority;
  }
  throw new TypeError('Spatial cache priority is invalid');
};

const defaultEstimateBytes = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return 8;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : serialized.length * 2;
  } catch {
    return 1_024;
  }
};

const abortReason = (signal: AbortSignal): unknown => (
  signal.reason ?? new DOMException('Aborted', 'AbortError')
);

export const createSpatialCacheCoordinator = (options: SpatialCacheOptions = {}): SpatialCacheCoordinator => {
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 'maxEntries');
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const maxInFlight = positiveInteger(options.maxInFlight, DEFAULT_MAX_IN_FLIGHT, 'maxInFlight');
  const maxKeyLength = positiveInteger(options.maxKeyLength, DEFAULT_MAX_KEY_LENGTH, 'maxKeyLength');
  const maxTagsPerEntry = positiveInteger(options.maxTagsPerEntry, DEFAULT_MAX_TAGS, 'maxTagsPerEntry');
  const maxTagLength = positiveInteger(options.maxTagLength, DEFAULT_MAX_TAG_LENGTH, 'maxTagLength');
  const defaultTtlMs = positiveInteger(options.defaultTtlMs, DEFAULT_TTL_MS, 'defaultTtlMs');
  const maxTtlMs = Math.max(
    defaultTtlMs,
    positiveInteger(options.maxTtlMs, DEFAULT_MAX_TTL_MS, 'maxTtlMs'),
  );
  const clock = options.now ?? Date.now;
  const estimateBytes = options.estimateBytes ?? defaultEstimateBytes;
  const entries = new Map<string, MutableEntry>();
  const inFlight = new Map<string, InFlightRequest>();

  let totalBytes = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let dedupeHits = 0;
  let rejectedRequests = 0;
  let abortedSubscribers = 0;
  let entrySequence = 0;
  let subscriberSequence = 0;

  const readNow = (): number => {
    const timestamp = Number(clock());
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new RangeError('Spatial cache clock must return a finite non-negative timestamp');
    }
    return timestamp;
  };

  const normalizeKey = (key: string): string => {
    if (typeof key !== 'string') throw new TypeError('Spatial cache key must be a string');
    const normalized = key.trim();
    if (normalized.length === 0) throw new TypeError('Spatial cache key is required');
    if (normalized.length > maxKeyLength) throw new RangeError('Spatial cache key exceeds length budget');
    return normalized;
  };

  const normalizeTags = (tags?: readonly string[]): readonly string[] => {
    if (tags === undefined) return Object.freeze([]);
    if (!Array.isArray(tags)) throw new TypeError('Spatial cache tags must be an array');
    if (tags.length > maxTagsPerEntry) throw new RangeError('Spatial cache tag count exceeds budget');

    const unique = new Set<string>();
    for (const tag of tags) {
      if (typeof tag !== 'string') throw new TypeError('Spatial cache tags must be strings');
      const normalized = tag.trim().toLowerCase();
      if (normalized.length === 0) continue;
      if (normalized.length > maxTagLength) throw new RangeError('Spatial cache tag exceeds length budget');
      unique.add(normalized);
      if (unique.size > maxTagsPerEntry) throw new RangeError('Spatial cache tag count exceeds budget');
    }
    return Object.freeze(Array.from(unique));
  };

  const estimateValueBytes = (value: unknown, explicit: number | undefined): number => {
    if (explicit !== undefined) {
      return nonNegativeInteger(explicit, 0, 'estimatedBytes');
    }

    let estimated: unknown;
    try {
      estimated = estimateBytes(value);
    } catch {
      estimated = 1_024;
    }
    return nonNegativeInteger(estimated, 1_024, 'estimatedBytes');
  };

  const notifyObserverError = (error: unknown): void => {
    try {
      options.onObserverError?.(error);
    } catch (observerError) {
      const reporter = (globalThis as typeof globalThis & {
        reportError?: (reportedError: unknown) => void;
      }).reportError;
      if (typeof reporter === 'function') {
        reporter(observerError);
        return;
      }
      throw observerError;
    }
  };

  const notifyEviction = (key: string, reason: string): void => {
    try {
      options.onEvict?.(key, reason);
    } catch (error) {
      notifyObserverError(error);
    }
  };

  const removeEntry = (key: string, reason: string): boolean => {
    const existing = entries.get(key);
    if (existing === undefined) return false;
    entries.delete(key);
    totalBytes = Math.max(0, totalBytes - existing.estimatedBytes);
    evictions += 1;
    notifyEviction(key, reason);
    return true;
  };

  const pruneExpired = (timestamp = readNow()): void => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) removeEntry(key, 'expired');
    }
  };

  const chooseVictim = (allowCritical: boolean): MutableEntry | null => {
    let victim: MutableEntry | null = null;
    for (const candidate of entries.values()) {
      if (!allowCritical && candidate.priority === 'critical') continue;
      if (victim === null) {
        victim = candidate;
        continue;
      }
      const priorityDelta = PRIORITY_WEIGHT[candidate.priority] - PRIORITY_WEIGHT[victim.priority];
      if (priorityDelta < 0) {
        victim = candidate;
        continue;
      }
      if (priorityDelta > 0) continue;
      if (candidate.hits < victim.hits) {
        victim = candidate;
        continue;
      }
      if (candidate.hits > victim.hits) continue;
      if (candidate.lastAccessAt < victim.lastAccessAt) {
        victim = candidate;
        continue;
      }
      if (candidate.lastAccessAt > victim.lastAccessAt) continue;
      if (candidate.sequence < victim.sequence) victim = candidate;
    }
    return victim;
  };

  const overBudget = (): boolean => entries.size > maxEntries || totalBytes > maxBytes;

  const enforceBudget = (): void => {
    pruneExpired();
    while (overBudget()) {
      const victim = chooseVictim(false) ?? chooseVictim(true);
      if (victim === null) break;
      const reason = entries.size > maxEntries ? 'entry-budget' : 'byte-budget';
      removeEntry(victim.key, reason);
    }
  };

  const readEntry = <TValue>(key: string, countMiss: boolean): CacheRead<TValue> => {
    const normalized = normalizeKey(key);
    const entry = entries.get(normalized);
    if (entry === undefined) {
      if (countMiss) misses += 1;
      return Object.freeze({ found: false, value: undefined });
    }

    const timestamp = readNow();
    if (entry.expiresAt <= timestamp) {
      removeEntry(normalized, 'expired');
      if (countMiss) misses += 1;
      return Object.freeze({ found: false, value: undefined });
    }

    entry.hits += 1;
    entry.lastAccessAt = timestamp;
    hits += 1;
    return Object.freeze({ found: true, value: entry.value as TValue });
  };

  const get = <TValue>(key: string): TValue | undefined => readEntry<TValue>(key, true).value;

  const put = <TValue>(
    key: string,
    value: TValue,
    putOptions: SpatialCachePutOptions = {},
  ): SpatialCacheEntry<TValue> => {
    const normalized = normalizeKey(key);
    const timestamp = readNow();
    const ttlMs = Math.min(
      maxTtlMs,
      positiveInteger(putOptions.ttlMs, defaultTtlMs, 'ttlMs'),
    );
    const bytes = estimateValueBytes(value, putOptions.estimatedBytes);
    const previous = entries.get(normalized);
    if (previous !== undefined) {
      entries.delete(normalized);
      totalBytes = Math.max(0, totalBytes - previous.estimatedBytes);
    }

    const entry: MutableEntry<TValue> = {
      key: normalized,
      value,
      tags: normalizeTags(putOptions.tags),
      priority: normalizePriority(putOptions.priority),
      createdAt: timestamp,
      expiresAt: timestamp + ttlMs,
      lastAccessAt: timestamp,
      hits: 0,
      estimatedBytes: bytes,
      sequence: entrySequence,
    };
    entrySequence += 1;
    entries.set(normalized, entry as MutableEntry);
    totalBytes += bytes;
    enforceBudget();

    return Object.freeze({
      key: entry.key,
      value: entry.value,
      tags: entry.tags,
      priority: entry.priority,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      lastAccessAt: entry.lastAccessAt,
      hits: entry.hits,
      estimatedBytes: entry.estimatedBytes,
    });
  };

  const has = (key: string): boolean => {
    const normalized = normalizeKey(key);
    const entry = entries.get(normalized);
    if (entry === undefined) return false;
    if (entry.expiresAt <= readNow()) {
      removeEntry(normalized, 'expired');
      return false;
    }
    return true;
  };

  const deleteEntry = (key: string, reason = 'manual'): boolean => (
    removeEntry(normalizeKey(key), reason)
  );

  const invalidateTags = (tags: readonly string[], reason = 'tag-invalidate'): number => {
    const targets = new Set(normalizeTags(tags));
    if (targets.size === 0) return 0;

    let removed = 0;
    for (const [key, entry] of entries) {
      if (!entry.tags.some((tag) => targets.has(tag))) continue;
      if (removeEntry(key, reason)) removed += 1;
    }
    return removed;
  };

  const clear = (reason = 'clear'): void => {
    for (const key of entries.keys()) removeEntry(key, reason);
  };

  const cleanupSubscriber = <TValue>(
    record: InFlightRequest<TValue>,
    subscriber: RequestSubscriber<TValue>,
  ): void => {
    if (subscriber.signal !== undefined && subscriber.abort !== undefined) {
      subscriber.signal.removeEventListener('abort', subscriber.abort);
    }
    record.subscribers.delete(subscriber.id);
  };

  const rejectAll = <TValue>(record: InFlightRequest<TValue>, reason: unknown): void => {
    const subscribers = Array.from(record.subscribers.values());
    for (const subscriber of subscribers) {
      cleanupSubscriber(record, subscriber);
      subscriber.reject(reason);
    }
  };

  const resolveAll = <TValue>(record: InFlightRequest<TValue>, value: TValue): void => {
    const subscribers = Array.from(record.subscribers.values());
    for (const subscriber of subscribers) {
      cleanupSubscriber(record, subscriber);
      subscriber.resolve(value);
    }
  };

  const subscribe = <TValue>(
    record: InFlightRequest<TValue>,
    signal?: AbortSignal,
  ): Promise<TValue> => new Promise<TValue>((resolve, reject) => {
    if (signal?.aborted) {
      abortedSubscribers += 1;
      reject(abortReason(signal));
      if (record.subscribers.size === 0 && !record.settled) {
        record.controller.abort(abortReason(signal));
      }
      return;
    }

    const subscriber: RequestSubscriber<TValue> = {
      id: subscriberSequence,
      resolve,
      reject,
      ...(signal === undefined ? {} : { signal }),
    };
    subscriberSequence += 1;

    if (signal !== undefined) {
      subscriber.abort = (): void => {
        if (!record.subscribers.has(subscriber.id)) return;
        abortedSubscribers += 1;
        cleanupSubscriber(record, subscriber);
        reject(abortReason(signal));
        if (record.subscribers.size === 0 && !record.settled) {
          record.controller.abort(abortReason(signal));
        }
      };
      signal.addEventListener('abort', subscriber.abort, { once: true });
    }

    record.subscribers.set(subscriber.id, subscriber);
  });

  const executeRequest = async <TValue>(record: InFlightRequest<TValue>): Promise<void> => {
    try {
      const value = await record.loader(record.controller.signal);
      if (record.controller.signal.aborted) {
        rejectAll(record, record.controller.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }

      put(record.key, value, record.options);
      resolveAll(record, value);
    } catch (error) {
      rejectAll(record, error);
    } finally {
      record.settled = true;
      inFlight.delete(record.key);
    }
  };

  const request = <TValue>(
    key: string,
    loader: (signal: AbortSignal) => Promise<TValue>,
    requestOptions: SpatialRequestOptions = {},
  ): Promise<TValue> => {
    const normalized = normalizeKey(key);
    if (typeof loader !== 'function') return Promise.reject(new TypeError('Spatial cache loader is required'));
    if (requestOptions.signal?.aborted) {
      abortedSubscribers += 1;
      return Promise.reject(abortReason(requestOptions.signal));
    }

    if (!requestOptions.bypassCache) {
      const cached = readEntry<TValue>(normalized, true);
      if (cached.found) return Promise.resolve(cached.value as TValue);
    }

    const existing = inFlight.get(normalized) as InFlightRequest<TValue> | undefined;
    if (existing !== undefined) {
      dedupeHits += 1;
      return subscribe(existing, requestOptions.signal);
    }

    if (inFlight.size >= maxInFlight) {
      rejectedRequests += 1;
      return Promise.reject(new SpatialCacheCapacityError('Spatial cache in-flight request budget exceeded'));
    }

    const normalizedRequestOptions: SpatialRequestOptions = requestOptions.tags === undefined
      ? Object.freeze({ ...requestOptions })
      : Object.freeze({ ...requestOptions, tags: normalizeTags(requestOptions.tags) });
    const record: InFlightRequest<TValue> = {
      key: normalized,
      controller: new AbortController(),
      loader,
      options: normalizedRequestOptions,
      subscribers: new Map(),
      settled: false,
    };
    inFlight.set(normalized, record as InFlightRequest);

    const promise = subscribe(record, requestOptions.signal);
    void executeRequest(record);
    return promise;
  };

  const getSnapshot = (): SpatialCacheSnapshot => {
    pruneExpired();
    let activeSubscribers = 0;
    for (const requestRecord of inFlight.values()) {
      activeSubscribers += requestRecord.subscribers.size;
    }
    return Object.freeze({
      size: entries.size,
      estimatedBytes: totalBytes,
      hits,
      misses,
      evictions,
      dedupeHits,
      rejectedRequests,
      abortedSubscribers,
      activeRequests: inFlight.size,
      activeSubscribers,
      keys: Object.freeze(Array.from(entries.keys())),
    });
  };

  return Object.freeze({
    get,
    put,
    has,
    delete: deleteEntry,
    invalidateTags,
    clear,
    request,
    getSnapshot,
  });
};
