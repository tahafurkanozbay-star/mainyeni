import { geometryFingerprint } from './geometryIntegrityRuntime';

export interface SpatialMemoErrorDetails {
  code?: string;
  key?: string | null;
  cause?: unknown;
}

export class SpatialMemoError extends Error {
  code: string;
  key: string | null;
  cause?: unknown;

  constructor(message: string, details: SpatialMemoErrorDetails = {}) {
    super(message);
    this.name = 'SpatialMemoError';
    this.code = details.code || 'SPATIAL_MEMO_ERROR';
    this.key = details.key || null;
    this.cause = details.cause;
    Object.setPrototypeOf(this, SpatialMemoError.prototype);
  }
}

export interface SpatialMemoSettings {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
}

export interface SpatialMemoKeyOptions {
  namespace?: string | number;
  version?: string | number;
}

export interface SpatialMemoExecutionContext {
  key: string;
  signal?: AbortSignal;
  startedAt: number;
}

export type SpatialMemoFactory<T> = (context: SpatialMemoExecutionContext) => Promise<T> | T;
export type SpatialMemoSizeOf<T> = (value: T) => number;
export type SpatialMemoCachePredicate<T> = (value: T) => boolean;

export interface SpatialMemoExecuteOptions<T> {
  signal?: AbortSignal;
  cache?: boolean;
  dedupe?: boolean;
  ttlMs?: unknown;
  sizeOf?: SpatialMemoSizeOf<T>;
  isCacheable?: SpatialMemoCachePredicate<T>;
  tags?: Array<string | number | null | undefined>;
}

export interface SpatialMemoConfiguration {
  now?: () => number;
  ttlMs?: unknown;
  maxEntries?: unknown;
  maxBytes?: unknown;
}

export interface SpatialMemoCacheEntry<T = unknown> {
  key: string;
  value: T;
  createdAt: number;
  lastAccessAt: number;
  expiresAt: number;
  sizeBytes: number;
  hits: number;
  tags: string[];
}

interface SpatialMemoSubscriber {
  done: boolean;
  signal?: AbortSignal;
  abortHandler: (() => void) | null;
}

interface SpatialMemoInFlightEntry<T = unknown> {
  key: string;
  controller: AbortController | null;
  subscribers: Set<SpatialMemoSubscriber>;
  settled: boolean;
  promise: Promise<T>;
}

export interface SpatialMemoReadResult<T> {
  hit: boolean;
  value?: T;
}

export interface SpatialMemoMetrics {
  requests: number;
  computations: number;
  cacheHits: number;
  cacheMisses: number;
  cacheWrites: number;
  cacheSkips: number;
  evictions: number;
  expirations: number;
  deduped: number;
  cancellations: number;
  underlyingAborts: number;
  successes: number;
  errors: number;
  totalComputeMs: number;
  lastComputeMs: number | null;
}

export interface SpatialMemoStats extends SpatialMemoMetrics {
  cacheEntries: number;
  cacheBytes: number;
  inFlight: number;
}

export type SpatialMemoInvalidator = (
  value: unknown,
  key: string,
  entry: SpatialMemoCacheEntry,
) => boolean;

export interface SpatialMemoRuntime {
  execute: <T>(key: string, factory: SpatialMemoFactory<T>, options?: SpatialMemoExecuteOptions<T>) => Promise<T>;
  read: <T = unknown>(key: string) => T | undefined;
  invalidate: (selector: string | number | SpatialMemoInvalidator) => number;
  invalidateTag: (tag: string | number) => number;
  sweepExpired: () => number;
  clear: (options?: { abortInFlight?: boolean }) => void;
  configure: (patch?: Partial<Record<keyof SpatialMemoSettings, unknown>>) => SpatialMemoSettings;
  destroy: () => void;
  getSettings: () => SpatialMemoSettings;
  getStats: () => SpatialMemoStats;
}

const DEFAULTS = Object.freeze({
  ttlMs: 60000,
  maxEntries: 256,
  maxBytes: 8 * 1024 * 1024,
  maxTtlMs: 24 * 60 * 60 * 1000,
});

const runtimeNow = (): number => Date.now();

const positiveInteger = (
  value: unknown,
  fallback: number,
  max: number = Number.MAX_SAFE_INTEGER,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const nonNegativeInteger = (value: unknown, fallback: number = 0): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
};

const safeJsonSize = (value: unknown): number => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : serialized.length * 2;
  } catch (_) {
    return 0;
  }
};

const normalizeKey = (key: unknown): string => {
  const normalized = String(key === null || key === undefined ? '' : key).trim();
  if (!normalized) {
    throw new SpatialMemoError('A stable spatial memo key is required.', { code: 'INVALID_KEY' });
  }
  return normalized;
};

const stable = (value: unknown, seen: WeakSet<object> = new WeakSet<object>()): string => {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== 'object') return JSON.stringify(value);
  const objectValue = value as Record<string, unknown>;
  const objectReference = value as object;
  if (typeof objectValue.toJSON === 'function') {
    return stable((objectValue.toJSON as () => unknown)(), seen);
  }
  if (seen.has(objectReference)) return '"[Circular]"';
  seen.add(objectReference);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stable(item, seen)).join(',')}]`
    : `{${Object.keys(objectValue).sort().map((key) => `${JSON.stringify(key)}:${stable(objectValue[key], seen)}`).join(',')}}`;
  seen.delete(objectReference);
  return result;
};

const hash = (value: string): string => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
};

const normalizeOperation = (operation: unknown): string => {
  const value = String(operation === null || operation === undefined ? '' : operation).trim().toLowerCase();
  if (!value) {
    throw new SpatialMemoError('A spatial operation name is required.', { code: 'INVALID_OPERATION' });
  }
  return value;
};

const argumentFingerprint = (value: unknown): string => {
  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const geometryLike = (objectValue.geometry || objectValue) as Record<string, unknown>;
    if (
      geometryLike &&
      typeof geometryLike === 'object' &&
      ('x' in geometryLike || 'points' in geometryLike || 'paths' in geometryLike || 'rings' in geometryLike || 'xmin' in geometryLike)
    ) {
      return geometryFingerprint(geometryLike);
    }
  }
  return `arg:${hash(stable(value))}`;
};

export const createSpatialMemoKey = (
  operation: unknown,
  args: unknown | unknown[] = [],
  options: SpatialMemoKeyOptions = {},
): string => {
  const normalizedOperation = normalizeOperation(operation);
  const values = Array.isArray(args) ? args : [args];
  const parts = values.map(argumentFingerprint);
  if (options.namespace !== undefined) parts.unshift(`ns:${String(options.namespace)}`);
  if (options.version !== undefined) parts.push(`v:${String(options.version)}`);
  return `${normalizedOperation}:${parts.join(':')}`;
};

const cancelledError = (key: string): SpatialMemoError => new SpatialMemoError(
  'Spatial computation cancelled.',
  { code: 'CANCELLED', key },
);

const destroyedError = (key: string): SpatialMemoError => new SpatialMemoError(
  'Spatial memo runtime has been destroyed.',
  { code: 'RUNTIME_DESTROYED', key },
);

const createController = (): AbortController | null => (
  typeof AbortController === 'undefined' ? null : new AbortController()
);

const safeAbort = (controller: AbortController | null): boolean => {
  if (!controller || controller.signal.aborted) return false;
  try {
    controller.abort();
    return true;
  } catch (_) {
    return false;
  }
};

export const createSpatialMemoRuntime = (
  configuration: SpatialMemoConfiguration = {},
): SpatialMemoRuntime => {
  const clock = typeof configuration.now === 'function' ? configuration.now : runtimeNow;
  const settings: SpatialMemoSettings = {
    ttlMs: positiveInteger(configuration.ttlMs, DEFAULTS.ttlMs, DEFAULTS.maxTtlMs),
    maxEntries: positiveInteger(configuration.maxEntries, DEFAULTS.maxEntries, 10000),
    maxBytes: positiveInteger(configuration.maxBytes, DEFAULTS.maxBytes, 256 * 1024 * 1024),
  };
  const cache = new Map<string, SpatialMemoCacheEntry>();
  const inFlight = new Map<string, SpatialMemoInFlightEntry>();
  let cacheBytes = 0;
  let destroyed = false;

  const metrics: SpatialMemoMetrics = {
    requests: 0,
    computations: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheWrites: 0,
    cacheSkips: 0,
    evictions: 0,
    expirations: 0,
    deduped: 0,
    cancellations: 0,
    underlyingAborts: 0,
    successes: 0,
    errors: 0,
    totalComputeMs: 0,
    lastComputeMs: null,
  };

  const deleteEntry = (key: string, reason: 'evicted' | 'expired' | null = null): boolean => {
    const entry = cache.get(key);
    if (!entry) return false;
    cache.delete(key);
    cacheBytes = Math.max(0, cacheBytes - entry.sizeBytes);
    if (reason === 'evicted') metrics.evictions += 1;
    if (reason === 'expired') metrics.expirations += 1;
    return true;
  };

  const touch = (key: string, entry: SpatialMemoCacheEntry): void => {
    cache.delete(key);
    cache.set(key, entry);
  };

  const evict = (): void => {
    while (cache.size > settings.maxEntries || cacheBytes > settings.maxBytes) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      deleteEntry(oldest, 'evicted');
    }
  };

  const readInternal = <T = unknown>(
    key: string,
    options: SpatialMemoExecuteOptions<T> = {},
  ): SpatialMemoReadResult<T> => {
    if (options.cache === false) return { hit: false };
    const entry = cache.get(key) as SpatialMemoCacheEntry<T> | undefined;
    if (!entry) {
      metrics.cacheMisses += 1;
      return { hit: false };
    }
    if (entry.expiresAt <= clock()) {
      deleteEntry(key, 'expired');
      metrics.cacheMisses += 1;
      return { hit: false };
    }
    entry.hits += 1;
    entry.lastAccessAt = clock();
    touch(key, entry as SpatialMemoCacheEntry);
    metrics.cacheHits += 1;
    return { hit: true, value: entry.value };
  };

  const write = <T>(key: string, value: T, options: SpatialMemoExecuteOptions<T> = {}): boolean => {
    if (options.cache === false) {
      metrics.cacheSkips += 1;
      return false;
    }
    if (typeof options.isCacheable === 'function' && !options.isCacheable(value)) {
      metrics.cacheSkips += 1;
      return false;
    }
    const sizeBytes = nonNegativeInteger(
      typeof options.sizeOf === 'function' ? options.sizeOf(value) : safeJsonSize(value),
      0,
    );
    if (sizeBytes > settings.maxBytes) {
      metrics.cacheSkips += 1;
      return false;
    }
    const createdAt = clock();
    const ttlMs = positiveInteger(options.ttlMs, settings.ttlMs, DEFAULTS.maxTtlMs);
    const previous = cache.get(key);
    if (previous) cacheBytes = Math.max(0, cacheBytes - previous.sizeBytes);
    cache.delete(key);
    cache.set(key, {
      key,
      value,
      createdAt,
      lastAccessAt: createdAt,
      expiresAt: createdAt + ttlMs,
      sizeBytes,
      hits: 0,
      tags: Array.from(new Set((options.tags || []).filter((tag) => tag !== null && tag !== undefined).map(String))),
    });
    cacheBytes += sizeBytes;
    metrics.cacheWrites += 1;
    evict();
    return cache.has(key);
  };

  const release = (
    entry: SpatialMemoInFlightEntry,
    subscriber: SpatialMemoSubscriber,
    reason: 'cancelled' | null = null,
  ): void => {
    if (!entry.subscribers.has(subscriber)) return;
    entry.subscribers.delete(subscriber);
    if (reason === 'cancelled') metrics.cancellations += 1;
    if (entry.subscribers.size === 0 && !entry.settled && safeAbort(entry.controller)) {
      metrics.underlyingAborts += 1;
    }
  };

  const subscribe = <T>(entry: SpatialMemoInFlightEntry<T>, signal?: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
    const subscriber: SpatialMemoSubscriber = { done: false, signal, abortHandler: null };
    entry.subscribers.add(subscriber);

    const finish = (callback: (value: T | any) => void, value: T | any, reason: 'cancelled' | null = null): void => {
      if (subscriber.done) return;
      subscriber.done = true;
      if (subscriber.abortHandler && signal) signal.removeEventListener('abort', subscriber.abortHandler);
      release(entry as SpatialMemoInFlightEntry, subscriber, reason);
      callback(value);
    };

    if (signal) {
      subscriber.abortHandler = () => finish(reject, cancelledError(entry.key), 'cancelled');
      if (signal.aborted) {
        subscriber.abortHandler();
        return;
      }
      signal.addEventListener('abort', subscriber.abortHandler, { once: true });
    }

    entry.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });

  const start = <T>(
    key: string,
    factory: SpatialMemoFactory<T>,
    options: SpatialMemoExecuteOptions<T>,
  ): SpatialMemoInFlightEntry<T> => {
    const controller = createController();
    const startedAt = clock();
    const entry: SpatialMemoInFlightEntry<T> = {
      key,
      controller,
      subscribers: new Set<SpatialMemoSubscriber>(),
      settled: false,
      promise: Promise.resolve(undefined as unknown as T),
    };
    metrics.computations += 1;

    let computation: Promise<T>;
    try {
      computation = Promise.resolve(factory({ key, signal: controller ? controller.signal : undefined, startedAt }));
    } catch (error) {
      computation = Promise.reject(error);
    }

    entry.promise = computation
      .then((value) => {
        metrics.successes += 1;
        write(key, value, options);
        return value;
      })
      .catch((error) => {
        const abandonedAbort = Boolean(controller && controller.signal.aborted && entry.subscribers.size === 0);
        if (!abandonedAbort) metrics.errors += 1;
        throw error;
      })
      .finally(() => {
        entry.settled = true;
        const duration = Math.max(0, clock() - startedAt);
        metrics.totalComputeMs += duration;
        metrics.lastComputeMs = duration;
        if (inFlight.get(key) === entry) inFlight.delete(key);
      });
    entry.promise.catch(() => undefined);
    inFlight.set(key, entry as SpatialMemoInFlightEntry);
    return entry;
  };

  const execute = async <T>(
    rawKey: string,
    factory: SpatialMemoFactory<T>,
    options: SpatialMemoExecuteOptions<T> = {},
  ): Promise<T> => {
    const key = normalizeKey(rawKey);
    if (destroyed) throw destroyedError(key);
    if (typeof factory !== 'function') {
      throw new SpatialMemoError('A spatial computation factory is required.', { code: 'INVALID_FACTORY', key });
    }
    if (options.signal && options.signal.aborted) throw cancelledError(key);
    metrics.requests += 1;

    const cached = readInternal<T>(key, options);
    if (cached.hit) return cached.value as T;

    let entry = options.dedupe === false ? undefined : inFlight.get(key) as SpatialMemoInFlightEntry<T> | undefined;
    if (entry) {
      metrics.deduped += 1;
    } else {
      entry = start(key, factory, options);
    }
    return subscribe(entry, options.signal);
  };

  const invalidate = (selector: string | number | SpatialMemoInvalidator): number => {
    const predicate: SpatialMemoInvalidator = typeof selector === 'function'
      ? selector
      : (_value, key) => key === String(selector);
    let removed = 0;
    Array.from(cache.entries()).forEach(([key, entry]) => {
      if (predicate(entry.value, key, entry) && deleteEntry(key)) removed += 1;
    });
    return removed;
  };

  const invalidateTag = (tag: string | number): number => {
    const normalized = String(tag);
    return invalidate((_value, _key, entry) => entry.tags.includes(normalized));
  };

  const sweepExpired = (): number => {
    const current = clock();
    Array.from(cache.entries()).forEach(([key, entry]) => {
      if (entry.expiresAt <= current) deleteEntry(key, 'expired');
    });
    return cache.size;
  };

  const clear = ({ abortInFlight = false }: { abortInFlight?: boolean } = {}): void => {
    cache.clear();
    cacheBytes = 0;
    if (abortInFlight) {
      inFlight.forEach((entry) => safeAbort(entry.controller));
      inFlight.clear();
    }
  };

  const configure = (patch: Partial<Record<keyof SpatialMemoSettings, unknown>> = {}): SpatialMemoSettings => {
    if (patch.ttlMs !== undefined) settings.ttlMs = positiveInteger(patch.ttlMs, settings.ttlMs, DEFAULTS.maxTtlMs);
    if (patch.maxEntries !== undefined) settings.maxEntries = positiveInteger(patch.maxEntries, settings.maxEntries, 10000);
    if (patch.maxBytes !== undefined) settings.maxBytes = positiveInteger(patch.maxBytes, settings.maxBytes, 256 * 1024 * 1024);
    evict();
    return { ...settings };
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    clear({ abortInFlight: true });
  };

  return Object.freeze({
    execute,
    read: <T = unknown>(key: string): T | undefined => {
      const result = readInternal<T>(normalizeKey(key));
      return result.hit ? result.value : undefined;
    },
    invalidate,
    invalidateTag,
    sweepExpired,
    clear,
    configure,
    destroy,
    getSettings: () => ({ ...settings }),
    getStats: (): SpatialMemoStats => ({
      ...metrics,
      cacheEntries: cache.size,
      cacheBytes,
      inFlight: inFlight.size,
    }),
  });
};