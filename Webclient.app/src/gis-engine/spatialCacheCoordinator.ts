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
  defaultTtlMs?: number;
  maxTtlMs?: number;
  now?: () => number;
  estimateBytes?: (value: unknown) => number;
  onEvict?: (key: string, reason: string) => void;
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
  activeRequests: number;
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
  request: <TValue>(key: string, loader: (signal: AbortSignal) => Promise<TValue>, options?: SpatialRequestOptions) => Promise<TValue>;
  getSnapshot: () => SpatialCacheSnapshot;
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
}

interface InFlightRequest<TValue = unknown> {
  controller: AbortController;
  promise: Promise<TValue>;
  subscribers: number;
}

const PRIORITY_WEIGHT: Readonly<Record<SpatialCachePriority, number>> = Object.freeze({
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
});

const finitePositive = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
};

const normalizeKey = (key: string): string => {
  const normalized = key.trim();
  if (!normalized) throw new Error('Spatial cache key is required');
  return normalized;
};

const defaultEstimateBytes = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return 1024;
  }
};

const normalizeTags = (tags?: readonly string[]): readonly string[] => Object.freeze(
  [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))],
);

export const createSpatialCacheCoordinator = (options: SpatialCacheOptions = {}): SpatialCacheCoordinator => {
  const maxEntries = Math.max(1, Math.floor(finitePositive(options.maxEntries, 256)));
  const maxBytes = Math.max(1024, Math.floor(finitePositive(options.maxBytes, 64 * 1024 * 1024)));
  const defaultTtlMs = Math.max(100, Math.floor(finitePositive(options.defaultTtlMs, 30_000)));
  const maxTtlMs = Math.max(defaultTtlMs, Math.floor(finitePositive(options.maxTtlMs, 10 * 60_000)));
  const now = options.now ?? Date.now;
  const estimateBytes = options.estimateBytes ?? defaultEstimateBytes;
  const entries = new Map<string, MutableEntry>();
  const inFlight = new Map<string, InFlightRequest>();

  let totalBytes = 0;
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let dedupeHits = 0;

  const removeEntry = (key: string, reason: string): boolean => {
    const existing = entries.get(key);
    if (!existing) return false;
    entries.delete(key);
    totalBytes = Math.max(0, totalBytes - existing.estimatedBytes);
    evictions += 1;
    options.onEvict?.(key, reason);
    return true;
  };

  const pruneExpired = (): void => {
    const timestamp = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) removeEntry(key, 'expired');
    }
  };

  const chooseVictim = (): MutableEntry | null => {
    const candidates = [...entries.values()].filter((entry) => entry.priority !== 'critical');
    if (!candidates.length) return null;
    candidates.sort((left, right) => {
      const priorityDelta = PRIORITY_WEIGHT[left.priority] - PRIORITY_WEIGHT[right.priority];
      if (priorityDelta !== 0) return priorityDelta;
      const hitDelta = left.hits - right.hits;
      if (hitDelta !== 0) return hitDelta;
      return left.lastAccessAt - right.lastAccessAt;
    });
    return candidates[0] ?? null;
  };

  const enforceBudget = (): void => {
    pruneExpired();
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const victim = chooseVictim();
      if (!victim) break;
      removeEntry(victim.key, entries.size > maxEntries ? 'entry-budget' : 'byte-budget');
    }
  };

  const get = <TValue>(key: string): TValue | undefined => {
    const normalized = normalizeKey(key);
    const entry = entries.get(normalized);
    if (!entry) {
      misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= now()) {
      removeEntry(normalized, 'expired');
      misses += 1;
      return undefined;
    }
    entry.hits += 1;
    entry.lastAccessAt = now();
    hits += 1;
    return entry.value as TValue;
  };

  const put = <TValue>(key: string, value: TValue, putOptions: SpatialCachePutOptions = {}): SpatialCacheEntry<TValue> => {
    const normalized = normalizeKey(key);
    const timestamp = now();
    const ttlMs = Math.min(maxTtlMs, Math.max(100, finitePositive(putOptions.ttlMs, defaultTtlMs)));
    const bytes = Math.max(0, Math.floor(finitePositive(putOptions.estimatedBytes, estimateBytes(value))));
    const previous = entries.get(normalized);
    if (previous) totalBytes = Math.max(0, totalBytes - previous.estimatedBytes);

    const entry: MutableEntry<TValue> = {
      key: normalized,
      value,
      tags: normalizeTags(putOptions.tags),
      priority: putOptions.priority ?? 'normal',
      createdAt: timestamp,
      expiresAt: timestamp + ttlMs,
      lastAccessAt: timestamp,
      hits: 0,
      estimatedBytes: bytes,
    };
    entries.set(normalized, entry as MutableEntry);
    totalBytes += bytes;
    enforceBudget();
    return Object.freeze({ ...entry });
  };

  const has = (key: string): boolean => {
    const normalized = normalizeKey(key);
    const entry = entries.get(normalized);
    if (!entry) return false;
    if (entry.expiresAt <= now()) {
      removeEntry(normalized, 'expired');
      return false;
    }
    return true;
  };

  const deleteEntry = (key: string, reason = 'manual'): boolean => removeEntry(normalizeKey(key), reason);

  const invalidateTags = (tags: readonly string[], reason = 'tag-invalidate'): number => {
    const targets = new Set(normalizeTags(tags));
    if (!targets.size) return 0;
    let removed = 0;
    for (const [key, entry] of entries) {
      if (entry.tags.some((tag) => targets.has(tag))) {
        removed += Number(removeEntry(key, reason));
      }
    }
    return removed;
  };

  const clear = (reason = 'clear'): void => {
    for (const key of entries.keys()) removeEntry(key, reason);
  };

  const request = async <TValue>(
    key: string,
    loader: (signal: AbortSignal) => Promise<TValue>,
    requestOptions: SpatialRequestOptions = {},
  ): Promise<TValue> => {
    const normalized = normalizeKey(key);
    if (!requestOptions.bypassCache) {
      const cached = get<TValue>(normalized);
      if (cached !== undefined) return cached;
    }

    const existing = inFlight.get(normalized) as InFlightRequest<TValue> | undefined;
    if (existing) {
      existing.subscribers += 1;
      dedupeHits += 1;
      if (!requestOptions.signal) return existing.promise;
      return new Promise<TValue>((resolve, reject) => {
        const abort = (): void => {
          existing.subscribers = Math.max(0, existing.subscribers - 1);
          if (existing.subscribers === 0) existing.controller.abort('all-subscribers-aborted');
          reject(requestOptions.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        if (requestOptions.signal?.aborted) {
          abort();
          return;
        }
        requestOptions.signal?.addEventListener('abort', abort, { once: true });
        existing.promise.then(resolve, reject).finally(() => {
          requestOptions.signal?.removeEventListener('abort', abort);
        });
      });
    }

    const controller = new AbortController();
    const record: InFlightRequest<TValue> = {
      controller,
      subscribers: 1,
      promise: Promise.resolve(undefined as TValue),
    };

    const forwardAbort = (): void => {
      record.subscribers = Math.max(0, record.subscribers - 1);
      if (record.subscribers === 0) controller.abort(requestOptions.signal?.reason ?? 'subscriber-aborted');
    };
    requestOptions.signal?.addEventListener('abort', forwardAbort, { once: true });

    record.promise = loader(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) put(normalized, value, requestOptions);
        return value;
      })
      .finally(() => {
        requestOptions.signal?.removeEventListener('abort', forwardAbort);
        inFlight.delete(normalized);
      });

    inFlight.set(normalized, record as InFlightRequest);
    return record.promise;
  };

  const getSnapshot = (): SpatialCacheSnapshot => {
    pruneExpired();
    return Object.freeze({
      size: entries.size,
      estimatedBytes: totalBytes,
      hits,
      misses,
      evictions,
      dedupeHits,
      activeRequests: inFlight.size,
      keys: Object.freeze([...entries.keys()]),
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
