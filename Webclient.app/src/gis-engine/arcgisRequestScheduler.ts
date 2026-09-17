import { assertAllowedArcGisResourceUrl } from './serviceCapabilityRuntime';

export const ARCGIS_REQUEST_PRIORITY = Object.freeze({
  IMMEDIATE: 0,
  INTERACTIVE: 10,
  NORMAL: 20,
  PREFETCH: 30,
  BACKGROUND: 40,
} as const);

export type ArcGisRequestPriorityName = keyof typeof ARCGIS_REQUEST_PRIORITY;
export type ArcGisRequestPriority = typeof ARCGIS_REQUEST_PRIORITY[ArcGisRequestPriorityName];
export type ArcGisRequestJobState = 'queued' | 'active' | 'completed' | 'failed' | 'cancelled';
export type ArcGisCacheState = 'miss' | 'fresh' | 'stale' | 'expired';

export interface ArcGisRequestSchedulerErrorDetails {
  code?: string;
  requestKey?: string | null;
  resourceUrl?: string | null;
  cause?: unknown;
}

export class ArcGisRequestSchedulerError extends Error {
  readonly code: string;
  readonly requestKey: string | null;
  readonly resourceUrl: string | null;
  override readonly cause: unknown;

  constructor(message: string, details: ArcGisRequestSchedulerErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ArcGisRequestSchedulerError';
    this.code = details.code ?? 'ARCGIS_REQUEST_SCHEDULER_ERROR';
    this.requestKey = details.requestKey ?? null;
    this.resourceUrl = details.resourceUrl ?? null;
    this.cause = details.cause;
  }
}

export interface ArcGisRequestExecutionContext {
  readonly signal: AbortSignal;
  readonly requestKey: string;
  readonly resourceUrl: string;
}

export type ArcGisRequestExecutor<T> = (
  context: ArcGisRequestExecutionContext,
) => Promise<T> | T;

export interface ArcGisRequestScheduleOptions<T = unknown> {
  key?: unknown;
  requestKey?: unknown;
  resourceUrl?: unknown;
  url?: unknown;
  execute?: ArcGisRequestExecutor<T>;
  factory?: ArcGisRequestExecutor<T>;
  priority?: ArcGisRequestPriorityName | number | string;
  signal?: AbortSignal;
  cache?: boolean;
  cacheTtlMs?: number;
  staleTtlMs?: number;
  allowStale?: boolean;
  allowStaleOnError?: boolean;
  estimatedBytes?: number;
  tags?: readonly unknown[];
}

export interface ArcGisRequestSchedulerConfiguration {
  maxConcurrent?: number;
  maxConcurrentPerOrigin?: number;
  maxQueueSize?: number;
  cacheTtlMs?: number;
  staleTtlMs?: number;
  maxCacheEntries?: number;
  maxCacheBytes?: number;
  defaultEstimatedBytes?: number;
  now?: () => number;
  onEvent?: (event: Readonly<ArcGisRequestSchedulerEvent>) => void;
  onListenerError?: (error: unknown, event: Readonly<ArcGisRequestSchedulerEvent>) => void;
}

export interface ArcGisRequestSchedulerEvent extends Readonly<Record<string, unknown>> {
  readonly type: string;
  readonly timestamp: number;
}

export interface ArcGisRequestSchedulerMetrics {
  scheduled: number;
  started: number;
  completed: number;
  failed: number;
  deduped: number;
  cacheHits: number;
  staleHits: number;
  cacheMisses: number;
  evicted: number;
  cancelledSubscribers: number;
  cancelledJobs: number;
  rejectedByBackpressure: number;
  peakQueueDepth: number;
  peakActive: number;
  bytesCached: number;
}

export interface ArcGisRequestSchedulerLimits {
  readonly maxConcurrent: number;
  readonly maxConcurrentPerOrigin: number;
  readonly maxQueueSize: number;
  readonly maxCacheEntries: number;
  readonly maxCacheBytes: number;
}

export interface ArcGisRequestSchedulerSnapshot {
  readonly destroyed: boolean;
  readonly activeCount: number;
  readonly queueDepth: number;
  readonly inFlightCount: number;
  readonly activeByOrigin: Readonly<Record<string, number>>;
  readonly cacheEntries: number;
  readonly cacheBytes: number;
  readonly limits: ArcGisRequestSchedulerLimits;
  readonly metrics: Readonly<ArcGisRequestSchedulerMetrics>;
}

export interface ArcGisRequestScheduler {
  schedule: <T>(request?: ArcGisRequestScheduleOptions<T>) => Promise<T>;
  cancel: (key: unknown, reason?: string) => boolean;
  invalidate: (key: unknown) => boolean;
  invalidateTag: (tag: unknown) => number;
  clearCache: () => number;
  configure: (configuration?: Pick<
    ArcGisRequestSchedulerConfiguration,
    'maxConcurrent' | 'maxConcurrentPerOrigin' | 'maxQueueSize' | 'maxCacheEntries' | 'maxCacheBytes'
  >) => ArcGisRequestSchedulerSnapshot;
  subscribe: (listener: (event: Readonly<ArcGisRequestSchedulerEvent>) => void) => () => boolean;
  getSnapshot: () => ArcGisRequestSchedulerSnapshot;
  destroy: (reason?: string) => void;
}

interface CacheWriteOptions {
  cache: boolean | undefined;
  cacheTtlMs: number | undefined;
  staleTtlMs: number | undefined;
  allowStaleOnError: boolean | undefined;
  estimatedBytes: number | undefined;
  tags: readonly string[];
}

interface CacheReadOptions {
  allowStale?: boolean;
}

interface CacheEntry {
  readonly value: unknown;
  readonly bytes: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly staleUntil: number;
  readonly tags: readonly string[];
}

interface CacheReadResult {
  readonly state: ArcGisCacheState;
  readonly entry: CacheEntry;
}

interface InternalSubscriber {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  cancelled: boolean;
  cancelReason: string;
  settled: boolean;
  unsubscribeAbort: (() => void) | null;
}

interface InternalJob {
  readonly key: string;
  readonly resourceUrl: string;
  readonly origin: string;
  readonly execute: ArcGisRequestExecutor<unknown>;
  readonly priority: number;
  readonly sequence: number;
  readonly enqueuedAt: number;
  startedAt: number | null;
  state: ArcGisRequestJobState;
  readonly controller: AbortController;
  readonly subscribers: Set<InternalSubscriber>;
  readonly options: CacheWriteOptions;
}

interface EventBus {
  emit: (event: Readonly<ArcGisRequestSchedulerEvent>) => void;
  subscribe: (listener: (event: Readonly<ArcGisRequestSchedulerEvent>) => void) => () => boolean;
  clear: () => void;
  size: () => number;
}

const DEFAULTS = Object.freeze({
  maxConcurrent: 6,
  maxConcurrentPerOrigin: 4,
  maxQueueSize: 256,
  cacheTtlMs: 15_000,
  staleTtlMs: 60_000,
  maxCacheEntries: 128,
  maxCacheBytes: 8 * 1024 * 1024,
  defaultEstimatedBytes: 4096,
});

const finite = (value: unknown, fallback: number | null = null): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const numeric = finite(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const nonNegative = (value: unknown, fallback = 0): number => {
  const numeric = finite(value);
  return numeric !== null && numeric >= 0 ? numeric : fallback;
};

const normalizeRequestKey = (value: unknown): string => {
  const key = String(value ?? '').trim();
  if (!key) {
    throw new ArcGisRequestSchedulerError('A stable ArcGIS request key is required.', {
      code: 'INVALID_REQUEST_KEY',
    });
  }
  return key;
};

const normalizePriority = (value: unknown): number => {
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    if (normalized === 'IMMEDIATE') return ARCGIS_REQUEST_PRIORITY.IMMEDIATE;
    if (normalized === 'INTERACTIVE') return ARCGIS_REQUEST_PRIORITY.INTERACTIVE;
    if (normalized === 'NORMAL') return ARCGIS_REQUEST_PRIORITY.NORMAL;
    if (normalized === 'PREFETCH') return ARCGIS_REQUEST_PRIORITY.PREFETCH;
    if (normalized === 'BACKGROUND') return ARCGIS_REQUEST_PRIORITY.BACKGROUND;
  }
  const numeric = finite(value, ARCGIS_REQUEST_PRIORITY.NORMAL) ?? ARCGIS_REQUEST_PRIORITY.NORMAL;
  return Math.max(
    ARCGIS_REQUEST_PRIORITY.IMMEDIATE,
    Math.min(ARCGIS_REQUEST_PRIORITY.BACKGROUND, Math.floor(numeric)),
  );
};

const normalizeResourceUrl = (value: unknown): string => {
  const normalized = assertAllowedArcGisResourceUrl(value);
  if (!normalized) {
    throw new ArcGisRequestSchedulerError('ArcGIS requests require a verified ArcGIS REST resource URL.', {
      code: 'INVALID_RESOURCE_URL',
      resourceUrl: value === null || value === undefined ? null : String(value),
    });
  }
  return normalized;
};

const normalizeOrigin = (resourceUrl: string): string => {
  try {
    return new URL(resourceUrl, 'https://local.invalid').origin;
  } catch (error: unknown) {
    throw new ArcGisRequestSchedulerError('ArcGIS resource URL could not be parsed.', {
      code: 'INVALID_RESOURCE_URL',
      resourceUrl,
      cause: error,
    });
  }
};

const abortError = (reason: unknown = 'Request aborted'): Error => {
  const error = new Error(String(reason || 'Request aborted'));
  error.name = 'AbortError';
  return error;
};

const estimateBytes = (value: unknown, fallback: number): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? fallback : Math.max(1, serialized.length * 2);
  } catch {
    return fallback;
  }
};

const uniqueStrings = (values: readonly unknown[] = []): string[] => [...new Set(
  values
    .filter((value) => value !== null && value !== undefined && String(value).trim().length > 0)
    .map((value) => String(value).trim()),
)];

const createEventBus = (
  onListenerError: ArcGisRequestSchedulerConfiguration['onListenerError'],
): EventBus => {
  const listeners = new Set<(event: Readonly<ArcGisRequestSchedulerEvent>) => void>();
  return {
    emit(event) {
      [...listeners].forEach((listener) => {
        try {
          listener(event);
        } catch (error: unknown) {
          onListenerError?.(error, event);
        }
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
    },
    size() {
      return listeners.size;
    },
  };
};

export const createArcGisRequestScheduler = (
  configuration: ArcGisRequestSchedulerConfiguration = {},
): ArcGisRequestScheduler => {
  const settings = {
    ...DEFAULTS,
    ...configuration,
  };
  let maxConcurrent = positiveInteger(settings.maxConcurrent, DEFAULTS.maxConcurrent, 64);
  let maxConcurrentPerOrigin = positiveInteger(
    settings.maxConcurrentPerOrigin,
    DEFAULTS.maxConcurrentPerOrigin,
    maxConcurrent,
  );
  let maxQueueSize = positiveInteger(settings.maxQueueSize, DEFAULTS.maxQueueSize, 10_000);
  let maxCacheEntries = positiveInteger(settings.maxCacheEntries, DEFAULTS.maxCacheEntries, 10_000);
  let maxCacheBytes = positiveInteger(settings.maxCacheBytes, DEFAULTS.maxCacheBytes, 512 * 1024 * 1024);
  const clock = typeof settings.now === 'function' ? settings.now : () => Date.now();
  const eventBus = createEventBus(settings.onListenerError);
  const queue: InternalJob[] = [];
  const jobs = new Map<string, InternalJob>();
  const activeByOrigin = new Map<string, number>();
  const cache = new Map<string, CacheEntry>();
  const tagIndex = new Map<string, Set<string>>();
  let sequence = 0;
  let activeCount = 0;
  let cacheBytes = 0;
  let destroyed = false;
  const metrics: ArcGisRequestSchedulerMetrics = {
    scheduled: 0,
    started: 0,
    completed: 0,
    failed: 0,
    deduped: 0,
    cacheHits: 0,
    staleHits: 0,
    cacheMisses: 0,
    evicted: 0,
    cancelledSubscribers: 0,
    cancelledJobs: 0,
    rejectedByBackpressure: 0,
    peakQueueDepth: 0,
    peakActive: 0,
    bytesCached: 0,
  };

  const emit = (type: string, details: Readonly<Record<string, unknown>> = {}): Readonly<ArcGisRequestSchedulerEvent> => {
    const event = Object.freeze({ type, timestamp: clock(), ...details });
    eventBus.emit(event);
    try {
      settings.onEvent?.(event);
    } catch (error: unknown) {
      settings.onListenerError?.(error, event);
    }
    return event;
  };

  const cacheState = (entry: CacheEntry | undefined, at = clock()): ArcGisCacheState => {
    if (!entry) return 'miss';
    if (entry.expiresAt > at) return 'fresh';
    if (entry.staleUntil > at) return 'stale';
    return 'expired';
  };

  const unindexCacheEntry = (key: string, entry: CacheEntry | undefined): void => {
    (entry?.tags ?? []).forEach((tag) => {
      const keys = tagIndex.get(tag);
      if (!keys) return;
      keys.delete(key);
      if (keys.size === 0) tagIndex.delete(tag);
    });
  };

  const deleteCacheEntry = (key: string, reason: 'delete' | 'evict' = 'delete'): boolean => {
    const entry = cache.get(key);
    if (!entry) return false;
    cache.delete(key);
    unindexCacheEntry(key, entry);
    cacheBytes = Math.max(0, cacheBytes - entry.bytes);
    metrics.bytesCached = cacheBytes;
    if (reason === 'evict') metrics.evicted += 1;
    return true;
  };

  const touchCacheEntry = (key: string, entry: CacheEntry): void => {
    cache.delete(key);
    cache.set(key, entry);
  };

  const enforceCacheBudget = (): void => {
    while (cache.size > maxCacheEntries || cacheBytes > maxCacheBytes) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      deleteCacheEntry(oldestKey, 'evict');
      emit('cache-evicted', { requestKey: oldestKey });
    }
  };

  const readCache = (key: string, options: CacheReadOptions = {}): CacheReadResult | null => {
    const entry = cache.get(key);
    const state = cacheState(entry);
    if (state === 'expired') {
      deleteCacheEntry(key);
      metrics.cacheMisses += 1;
      return null;
    }
    if (!entry) {
      metrics.cacheMisses += 1;
      return null;
    }
    if (state === 'stale' && options.allowStale !== true) {
      metrics.cacheMisses += 1;
      return { state, entry };
    }
    touchCacheEntry(key, entry);
    if (state === 'fresh') metrics.cacheHits += 1;
    if (state === 'stale') metrics.staleHits += 1;
    return { state, entry };
  };

  const writeCache = (key: string, value: unknown, options: CacheWriteOptions): CacheEntry | null => {
    if (options.cache === false) return null;
    const ttlMs = nonNegative(options.cacheTtlMs, nonNegative(settings.cacheTtlMs, DEFAULTS.cacheTtlMs));
    const staleTtlMs = nonNegative(options.staleTtlMs, nonNegative(settings.staleTtlMs, DEFAULTS.staleTtlMs));
    if (ttlMs === 0 && staleTtlMs === 0) return null;
    const bytes = positiveInteger(
      options.estimatedBytes,
      estimateBytes(value, settings.defaultEstimatedBytes),
      maxCacheBytes + 1,
    );
    if (bytes > maxCacheBytes) {
      emit('cache-skip-oversize', { requestKey: key, bytes, maxCacheBytes });
      return null;
    }
    deleteCacheEntry(key);
    const createdAt = clock();
    const entry: CacheEntry = Object.freeze({
      value,
      bytes,
      createdAt,
      expiresAt: createdAt + ttlMs,
      staleUntil: createdAt + ttlMs + staleTtlMs,
      tags: Object.freeze([...options.tags]),
    });
    cache.set(key, entry);
    cacheBytes += bytes;
    metrics.bytesCached = cacheBytes;
    entry.tags.forEach((tag) => {
      let keys = tagIndex.get(tag);
      if (!keys) {
        keys = new Set<string>();
        tagIndex.set(tag, keys);
      }
      keys.add(key);
    });
    enforceCacheBudget();
    return entry;
  };

  const nextRunnableIndex = (): number => {
    for (let index = 0; index < queue.length; index += 1) {
      const job = queue[index];
      if (!job) continue;
      const perOrigin = activeByOrigin.get(job.origin) ?? 0;
      if (perOrigin < maxConcurrentPerOrigin) return index;
    }
    return -1;
  };

  const allSubscribersCancelled = (job: InternalJob): boolean => (
    job.subscribers.size > 0
    && [...job.subscribers].every((subscriber) => subscriber.cancelled)
  );

  const cleanupSubscriber = (subscriber: InternalSubscriber): void => {
    try {
      subscriber.unsubscribeAbort?.();
    } catch {
      // Abort-listener cleanup must never replace a scheduler outcome.
    }
    subscriber.unsubscribeAbort = null;
  };

  const settleSubscriber = (
    subscriber: InternalSubscriber,
    outcome: 'resolve' | 'reject',
    value: unknown,
  ): void => {
    if (subscriber.settled) return;
    subscriber.settled = true;
    cleanupSubscriber(subscriber);
    if (subscriber.cancelled && outcome === 'resolve') {
      subscriber.reject(abortError(subscriber.cancelReason));
      return;
    }
    if (outcome === 'resolve') subscriber.resolve(value);
    else subscriber.reject(value);
  };

  const cancelJobIfOrphaned = (job: InternalJob): void => {
    if (!allSubscribersCancelled(job)) return;
    if (job.state === 'queued') {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      jobs.delete(job.key);
      job.state = 'cancelled';
      metrics.cancelledJobs += 1;
      emit('request-cancelled', { requestKey: job.key, phase: 'queued' });
      job.subscribers.forEach((subscriber) => {
        settleSubscriber(subscriber, 'reject', abortError(subscriber.cancelReason));
      });
      return;
    }
    if (job.state === 'active' && !job.controller.signal.aborted) {
      metrics.cancelledJobs += 1;
      job.controller.abort(abortError('All request subscribers cancelled'));
      emit('request-cancelled', { requestKey: job.key, phase: 'active' });
    }
  };

  const addSubscriber = <T>(job: InternalJob, signal: AbortSignal | undefined): Promise<T> => {
    const promise = new Promise<unknown>((resolve, reject) => {
      const subscriber: InternalSubscriber = {
        resolve,
        reject,
        cancelled: false,
        cancelReason: 'Request subscriber aborted',
        settled: false,
        unsubscribeAbort: null,
      };
      job.subscribers.add(subscriber);
      const cancel = (reason: unknown): void => {
        if (subscriber.settled || subscriber.cancelled) return;
        subscriber.cancelled = true;
        subscriber.cancelReason = String(reason || subscriber.cancelReason);
        metrics.cancelledSubscribers += 1;
        settleSubscriber(subscriber, 'reject', abortError(subscriber.cancelReason));
        cancelJobIfOrphaned(job);
      };
      if (signal) {
        if (signal.aborted) {
          cancel(signal.reason ?? 'Request subscriber aborted');
          return;
        }
        const onAbort = (): void => cancel(signal.reason ?? 'Request subscriber aborted');
        signal.addEventListener('abort', onAbort, { once: true });
        subscriber.unsubscribeAbort = () => signal.removeEventListener('abort', onAbort);
      }
    });
    return promise as Promise<T>;
  };

  const settleJob = (job: InternalJob, outcome: 'resolve' | 'reject', value: unknown): void => {
    job.subscribers.forEach((subscriber) => {
      if (subscriber.cancelled) return;
      settleSubscriber(subscriber, outcome, value);
    });
    job.subscribers.forEach(cleanupSubscriber);
    job.subscribers.clear();
  };

  const releaseActive = (job: InternalJob): void => {
    activeCount = Math.max(0, activeCount - 1);
    const originActive = Math.max(0, (activeByOrigin.get(job.origin) ?? 0) - 1);
    if (originActive > 0) activeByOrigin.set(job.origin, originActive);
    else activeByOrigin.delete(job.origin);
  };

  const pump = (): void => {
    if (destroyed) return;
    while (activeCount < maxConcurrent && queue.length > 0) {
      const index = nextRunnableIndex();
      if (index < 0) return;
      const [job] = queue.splice(index, 1);
      if (!job || job.state !== 'queued') continue;
      if (allSubscribersCancelled(job)) {
        cancelJobIfOrphaned(job);
        continue;
      }
      job.state = 'active';
      job.startedAt = clock();
      activeCount += 1;
      activeByOrigin.set(job.origin, (activeByOrigin.get(job.origin) ?? 0) + 1);
      metrics.started += 1;
      metrics.peakActive = Math.max(metrics.peakActive, activeCount);
      emit('request-started', {
        requestKey: job.key,
        resourceUrl: job.resourceUrl,
        priority: job.priority,
        queueMs: Math.max(0, job.startedAt - job.enqueuedAt),
      });

      let execution: Promise<unknown>;
      try {
        execution = Promise.resolve(job.execute({
          signal: job.controller.signal,
          requestKey: job.key,
          resourceUrl: job.resourceUrl,
        }));
      } catch (error: unknown) {
        execution = Promise.reject(error);
      }

      void execution.then(
        (value) => {
          job.state = 'completed';
          metrics.completed += 1;
          writeCache(job.key, value, job.options);
          if (jobs.get(job.key) === job) jobs.delete(job.key);
          releaseActive(job);
          settleJob(job, 'resolve', value);
          emit('request-completed', {
            requestKey: job.key,
            resourceUrl: job.resourceUrl,
            durationMs: Math.max(0, clock() - (job.startedAt ?? clock())),
          });
          pump();
        },
        (error: unknown) => {
          job.state = 'failed';
          const stale = readCache(job.key, { allowStale: true });
          if (jobs.get(job.key) === job) jobs.delete(job.key);
          releaseActive(job);
          if (
            job.options.allowStaleOnError === true
            && stale?.entry
            && cacheState(stale.entry) === 'stale'
          ) {
            metrics.staleHits += 1;
            settleJob(job, 'resolve', stale.entry.value);
            emit('request-stale-fallback', {
              requestKey: job.key,
              resourceUrl: job.resourceUrl,
              error,
            });
          } else {
            metrics.failed += 1;
            settleJob(job, 'reject', error);
            emit('request-failed', {
              requestKey: job.key,
              resourceUrl: job.resourceUrl,
              error,
            });
          }
          pump();
        },
      );
    }
  };

  const schedule = <T>(request: ArcGisRequestScheduleOptions<T> = {}): Promise<T> => {
    if (destroyed) {
      return Promise.reject(new ArcGisRequestSchedulerError('ArcGIS request scheduler has been destroyed.', {
        code: 'SCHEDULER_DESTROYED',
      }));
    }

    let key: string;
    let resourceUrl: string;
    try {
      key = normalizeRequestKey(request.key ?? request.requestKey);
      resourceUrl = normalizeResourceUrl(request.resourceUrl ?? request.url);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    const origin = normalizeOrigin(resourceUrl);
    const execute = request.execute ?? request.factory;
    if (typeof execute !== 'function') {
      return Promise.reject(new ArcGisRequestSchedulerError('ArcGIS request scheduler requires an execute adapter.', {
        code: 'INVALID_EXECUTE_ADAPTER',
        requestKey: key,
        resourceUrl,
      }));
    }

    const cached = request.cache === false
      ? null
      : readCache(key, { allowStale: request.allowStale === true });
    if (cached?.entry && (cached.state === 'fresh' || request.allowStale === true)) {
      emit('cache-hit', { requestKey: key, state: cached.state });
      return Promise.resolve(cached.entry.value as T);
    }

    const existing = jobs.get(key);
    if (existing && (existing.state === 'queued' || existing.state === 'active')) {
      metrics.deduped += 1;
      emit('request-deduped', { requestKey: key, state: existing.state });
      return addSubscriber<T>(existing, request.signal);
    }
    if (existing) jobs.delete(key);

    if (queue.length >= maxQueueSize) {
      metrics.rejectedByBackpressure += 1;
      return Promise.reject(new ArcGisRequestSchedulerError('ArcGIS request queue capacity exceeded.', {
        code: 'QUEUE_CAPACITY_EXCEEDED',
        requestKey: key,
        resourceUrl,
      }));
    }

    const job: InternalJob = {
      key,
      resourceUrl,
      origin,
      execute: execute as ArcGisRequestExecutor<unknown>,
      priority: normalizePriority(request.priority),
      sequence: sequence += 1,
      enqueuedAt: clock(),
      startedAt: null,
      state: 'queued',
      controller: new AbortController(),
      subscribers: new Set<InternalSubscriber>(),
      options: {
        cache: request.cache,
        cacheTtlMs: request.cacheTtlMs,
        staleTtlMs: request.staleTtlMs,
        allowStaleOnError: request.allowStaleOnError,
        estimatedBytes: request.estimatedBytes,
        tags: Object.freeze(uniqueStrings(request.tags)),
      },
    };
    jobs.set(key, job);
    queue.push(job);
    queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
    metrics.scheduled += 1;
    metrics.peakQueueDepth = Math.max(metrics.peakQueueDepth, queue.length);
    emit('request-queued', {
      requestKey: key,
      resourceUrl,
      priority: job.priority,
      queueDepth: queue.length,
    });
    const promise = addSubscriber<T>(job, request.signal);
    pump();
    return promise;
  };

  const invalidate = (key: unknown): boolean => deleteCacheEntry(normalizeRequestKey(key));

  const invalidateTag = (tagValue: unknown): number => {
    const tag = String(tagValue ?? '').trim();
    if (!tag) return 0;
    const keys = [...(tagIndex.get(tag) ?? [])];
    let removed = 0;
    keys.forEach((key) => {
      if (deleteCacheEntry(key)) removed += 1;
    });
    return removed;
  };

  const clearCache = (): number => {
    const removed = cache.size;
    [...cache.keys()].forEach((key) => deleteCacheEntry(key));
    return removed;
  };

  const cancel = (key: unknown, reason = 'Request cancelled'): boolean => {
    const normalized = normalizeRequestKey(key);
    const job = jobs.get(normalized);
    if (!job) return false;
    job.subscribers.forEach((subscriber) => {
      if (subscriber.settled) return;
      subscriber.cancelled = true;
      subscriber.cancelReason = reason;
      settleSubscriber(subscriber, 'reject', abortError(reason));
    });
    cancelJobIfOrphaned(job);
    return true;
  };

  const snapshot = (): ArcGisRequestSchedulerSnapshot => Object.freeze({
    destroyed,
    activeCount,
    queueDepth: queue.length,
    inFlightCount: jobs.size,
    activeByOrigin: Object.freeze(Object.fromEntries(activeByOrigin.entries())),
    cacheEntries: cache.size,
    cacheBytes,
    limits: Object.freeze({
      maxConcurrent,
      maxConcurrentPerOrigin,
      maxQueueSize,
      maxCacheEntries,
      maxCacheBytes,
    }),
    metrics: Object.freeze({ ...metrics }),
  });

  const configure = (
    next: Pick<
      ArcGisRequestSchedulerConfiguration,
      'maxConcurrent' | 'maxConcurrentPerOrigin' | 'maxQueueSize' | 'maxCacheEntries' | 'maxCacheBytes'
    > = {},
  ): ArcGisRequestSchedulerSnapshot => {
    if (destroyed) return snapshot();
    maxConcurrent = positiveInteger(next.maxConcurrent, maxConcurrent, 64);
    maxConcurrentPerOrigin = positiveInteger(
      next.maxConcurrentPerOrigin,
      maxConcurrentPerOrigin,
      maxConcurrent,
    );
    maxQueueSize = positiveInteger(next.maxQueueSize, maxQueueSize, 10_000);
    maxCacheEntries = positiveInteger(next.maxCacheEntries, maxCacheEntries, 10_000);
    maxCacheBytes = positiveInteger(next.maxCacheBytes, maxCacheBytes, 512 * 1024 * 1024);
    enforceCacheBudget();
    pump();
    emit('scheduler-configured', {
      maxConcurrent,
      maxConcurrentPerOrigin,
      maxQueueSize,
      maxCacheEntries,
      maxCacheBytes,
    });
    return snapshot();
  };

  const destroy = (reason = 'ArcGIS request scheduler destroyed'): void => {
    if (destroyed) return;
    destroyed = true;
    [...jobs.values()].forEach((job) => {
      job.subscribers.forEach((subscriber) => {
        if (subscriber.settled) return;
        subscriber.cancelled = true;
        subscriber.cancelReason = reason;
        settleSubscriber(subscriber, 'reject', abortError(reason));
      });
      if (!job.controller.signal.aborted) job.controller.abort(abortError(reason));
    });
    queue.length = 0;
    jobs.clear();
    activeByOrigin.clear();
    clearCache();
    eventBus.clear();
  };

  return Object.freeze({
    schedule,
    cancel,
    invalidate,
    invalidateTag,
    clearCache,
    configure,
    subscribe: eventBus.subscribe,
    getSnapshot: snapshot,
    destroy,
  });
};
