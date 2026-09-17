import { assertAllowedArcGisResourceUrl } from './serviceCapabilityRuntime';

export const ARCGIS_REQUEST_PRIORITY = Object.freeze({
  IMMEDIATE: 0,
  INTERACTIVE: 10,
  NORMAL: 20,
  PREFETCH: 30,
  BACKGROUND: 40,
});

export class ArcGisRequestSchedulerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ArcGisRequestSchedulerError';
    this.code = details.code || 'ARCGIS_REQUEST_SCHEDULER_ERROR';
    this.requestKey = details.requestKey || null;
    this.resourceUrl = details.resourceUrl || null;
    this.cause = details.cause;
  }
}

const DEFAULTS = Object.freeze({
  maxConcurrent: 6,
  maxConcurrentPerOrigin: 4,
  maxQueueSize: 256,
  cacheTtlMs: 15000,
  staleTtlMs: 60000,
  maxCacheEntries: 128,
  maxCacheBytes: 8 * 1024 * 1024,
  defaultEstimatedBytes: 4096,
});

const finite = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = finite(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const nonNegative = (value, fallback = 0) => {
  const numeric = finite(value);
  return numeric !== null && numeric >= 0 ? numeric : fallback;
};

const normalizeRequestKey = (value) => {
  const key = String(value ?? '').trim();
  if (!key) {
    throw new ArcGisRequestSchedulerError('A stable ArcGIS request key is required.', {
      code: 'INVALID_REQUEST_KEY',
    });
  }
  return key;
};

const normalizePriority = (value) => {
  if (typeof value === 'string') {
    const found = ARCGIS_REQUEST_PRIORITY[String(value).trim().toUpperCase()];
    if (found !== undefined) return found;
  }
  return Math.max(
    ARCGIS_REQUEST_PRIORITY.IMMEDIATE,
    Math.min(ARCGIS_REQUEST_PRIORITY.BACKGROUND, Math.floor(finite(value, ARCGIS_REQUEST_PRIORITY.NORMAL))),
  );
};

const normalizeOrigin = (resourceUrl) => {
  const normalized = assertAllowedArcGisResourceUrl(resourceUrl);
  if (!normalized) {
    throw new ArcGisRequestSchedulerError('ArcGIS requests require a verified ArcGIS REST resource URL.', {
      code: 'INVALID_RESOURCE_URL',
      resourceUrl,
    });
  }
  try {
    return new URL(normalized, 'https://local.invalid').origin;
  } catch (error) {
    throw new ArcGisRequestSchedulerError('ArcGIS resource URL could not be parsed.', {
      code: 'INVALID_RESOURCE_URL',
      resourceUrl: normalized,
      cause: error,
    });
  }
};

const abortError = (reason = 'Request aborted') => {
  const error = new Error(String(reason || 'Request aborted'));
  error.name = 'AbortError';
  return error;
};

const estimateBytes = (value, fallback) => {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try {
    return Math.max(1, JSON.stringify(value).length * 2);
  } catch (_) {
    return fallback;
  }
};

const uniqueStrings = (values = []) => [...new Set(
  values
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map((value) => String(value).trim()),
)];

const createEventBus = (onListenerError) => {
  const listeners = new Set();
  return {
    emit(event) {
      [...listeners].forEach((listener) => {
        try {
          listener(event);
        } catch (error) {
          onListenerError?.(error, event);
        }
      });
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
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

export const createArcGisRequestScheduler = (configuration = {}) => {
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
  let maxQueueSize = positiveInteger(settings.maxQueueSize, DEFAULTS.maxQueueSize, 10000);
  let maxCacheEntries = positiveInteger(settings.maxCacheEntries, DEFAULTS.maxCacheEntries, 10000);
  let maxCacheBytes = positiveInteger(settings.maxCacheBytes, DEFAULTS.maxCacheBytes, 512 * 1024 * 1024);
  const clock = typeof settings.now === 'function' ? settings.now : () => Date.now();
  const eventBus = createEventBus(settings.onListenerError);
  const queue = [];
  const jobs = new Map();
  const activeByOrigin = new Map();
  const cache = new Map();
  const tagIndex = new Map();
  let sequence = 0;
  let activeCount = 0;
  let cacheBytes = 0;
  let destroyed = false;
  const metrics = {
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

  const emit = (type, details = {}) => {
    const event = Object.freeze({
      type,
      timestamp: clock(),
      ...details,
    });
    eventBus.emit(event);
    try {
      settings.onEvent?.(event);
    } catch (error) {
      settings.onListenerError?.(error, event);
    }
    return event;
  };

  const cacheState = (entry, at = clock()) => {
    if (!entry) return 'miss';
    if (entry.expiresAt > at) return 'fresh';
    if (entry.staleUntil > at) return 'stale';
    return 'expired';
  };

  const unindexCacheEntry = (key, entry) => {
    (entry?.tags || []).forEach((tag) => {
      const keys = tagIndex.get(tag);
      if (!keys) return;
      keys.delete(key);
      if (!keys.size) tagIndex.delete(tag);
    });
  };

  const deleteCacheEntry = (key, reason = 'delete') => {
    const entry = cache.get(key);
    if (!entry) return false;
    cache.delete(key);
    unindexCacheEntry(key, entry);
    cacheBytes = Math.max(0, cacheBytes - entry.bytes);
    metrics.bytesCached = cacheBytes;
    if (reason === 'evict') metrics.evicted += 1;
    return true;
  };

  const touchCacheEntry = (key, entry) => {
    cache.delete(key);
    cache.set(key, entry);
  };

  const enforceCacheBudget = () => {
    while (cache.size > maxCacheEntries || cacheBytes > maxCacheBytes) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      deleteCacheEntry(oldestKey, 'evict');
      emit('cache-evicted', { requestKey: oldestKey });
    }
  };

  const readCache = (key, options = {}) => {
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

  const writeCache = (key, value, options = {}) => {
    if (options.cache === false) return null;
    const ttlMs = nonNegative(options.cacheTtlMs, nonNegative(settings.cacheTtlMs, DEFAULTS.cacheTtlMs));
    const staleTtlMs = nonNegative(options.staleTtlMs, nonNegative(settings.staleTtlMs, DEFAULTS.staleTtlMs));
    if (ttlMs === 0 && staleTtlMs === 0) return null;
    const bytes = positiveInteger(
      options.estimatedBytes,
      estimateBytes(value, DEFAULTS.defaultEstimatedBytes),
      maxCacheBytes + 1,
    );
    if (bytes > maxCacheBytes) {
      emit('cache-skip-oversize', { requestKey: key, bytes, maxCacheBytes });
      return null;
    }
    deleteCacheEntry(key);
    const createdAt = clock();
    const entry = Object.freeze({
      value,
      bytes,
      createdAt,
      expiresAt: createdAt + ttlMs,
      staleUntil: createdAt + ttlMs + staleTtlMs,
      tags: Object.freeze(uniqueStrings(options.tags)),
    });
    cache.set(key, entry);
    cacheBytes += bytes;
    metrics.bytesCached = cacheBytes;
    entry.tags.forEach((tag) => {
      if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
      tagIndex.get(tag).add(key);
    });
    enforceCacheBudget();
    return entry;
  };

  const nextRunnableIndex = () => {
    for (let index = 0; index < queue.length; index += 1) {
      const job = queue[index];
      const perOrigin = activeByOrigin.get(job.origin) || 0;
      if (perOrigin < maxConcurrentPerOrigin) return index;
    }
    return -1;
  };

  const allSubscribersCancelled = (job) => (
    job.subscribers.size > 0
    && [...job.subscribers].every((subscriber) => subscriber.cancelled)
  );

  const cleanupSubscriber = (subscriber) => {
    try {
      subscriber.unsubscribeAbort?.();
    } catch (_) {
      // Abort listener cleanup must never fail the scheduler.
    }
    subscriber.unsubscribeAbort = null;
  };

  const settleSubscriber = (subscriber, outcome, value) => {
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

  const cancelJobIfOrphaned = (job) => {
    if (!job || !allSubscribersCancelled(job)) return;
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

  const addSubscriber = (job, signal) => new Promise((resolve, reject) => {
    const subscriber = {
      resolve,
      reject,
      cancelled: false,
      cancelReason: 'Request subscriber aborted',
      settled: false,
      unsubscribeAbort: null,
    };
    job.subscribers.add(subscriber);
    const cancel = (reason) => {
      if (subscriber.settled || subscriber.cancelled) return;
      subscriber.cancelled = true;
      subscriber.cancelReason = reason || subscriber.cancelReason;
      metrics.cancelledSubscribers += 1;
      settleSubscriber(subscriber, 'reject', abortError(subscriber.cancelReason));
      cancelJobIfOrphaned(job);
    };
    if (signal) {
      if (signal.aborted) {
        cancel(signal.reason || 'Request subscriber aborted');
        return;
      }
      const onAbort = () => cancel(signal.reason || 'Request subscriber aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      subscriber.unsubscribeAbort = () => signal.removeEventListener('abort', onAbort);
    }
  });

  const settleJob = (job, outcome, value) => {
    job.subscribers.forEach((subscriber) => {
      if (subscriber.cancelled) return;
      settleSubscriber(subscriber, outcome, value);
    });
    job.subscribers.forEach(cleanupSubscriber);
    job.subscribers.clear();
  };

  const releaseActive = (job) => {
    activeCount = Math.max(0, activeCount - 1);
    const originActive = Math.max(0, (activeByOrigin.get(job.origin) || 0) - 1);
    if (originActive) activeByOrigin.set(job.origin, originActive);
    else activeByOrigin.delete(job.origin);
  };

  const pump = () => {
    if (destroyed) return;
    while (activeCount < maxConcurrent && queue.length) {
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
      activeByOrigin.set(job.origin, (activeByOrigin.get(job.origin) || 0) + 1);
      metrics.started += 1;
      metrics.peakActive = Math.max(metrics.peakActive, activeCount);
      emit('request-started', {
        requestKey: job.key,
        resourceUrl: job.resourceUrl,
        priority: job.priority,
        queueMs: Math.max(0, job.startedAt - job.enqueuedAt),
      });

      let execution;
      try {
        execution = Promise.resolve(job.execute({
          signal: job.controller.signal,
          requestKey: job.key,
          resourceUrl: job.resourceUrl,
        }));
      } catch (error) {
        execution = Promise.reject(error);
      }
      execution.then(
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
            durationMs: Math.max(0, clock() - job.startedAt),
          });
          pump();
        },
        (error) => {
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

  const schedule = (request = {}) => {
    if (destroyed) {
      return Promise.reject(new ArcGisRequestSchedulerError('ArcGIS request scheduler has been destroyed.', {
        code: 'SCHEDULER_DESTROYED',
      }));
    }
    const key = normalizeRequestKey(request.key ?? request.requestKey);
    const resourceUrl = assertAllowedArcGisResourceUrl(request.resourceUrl || request.url);
    const origin = normalizeOrigin(resourceUrl);
    const execute = request.execute || request.factory;
    if (typeof execute !== 'function') {
      return Promise.reject(new ArcGisRequestSchedulerError('ArcGIS request scheduler requires an execute adapter.', {
        code: 'INVALID_EXECUTE_ADAPTER',
        requestKey: key,
        resourceUrl,
      }));
    }

    const cached = request.cache === false ? null : readCache(key, { allowStale: request.allowStale === true });
    if (cached?.entry && (cached.state === 'fresh' || request.allowStale === true)) {
      emit('cache-hit', { requestKey: key, state: cached.state });
      return Promise.resolve(cached.entry.value);
    }

    const existing = jobs.get(key);
    if (existing && (existing.state === 'queued' || existing.state === 'active')) {
      metrics.deduped += 1;
      emit('request-deduped', { requestKey: key, state: existing.state });
      return addSubscriber(existing, request.signal);
    }
    // A subscriber may resume immediately after settleJob, before the job's
    // finally callback removes it. Never attach to an already-settled job: it
    // has no future settlement event and would leave the new request pending.
    if (existing) jobs.delete(key);

    if (queue.length >= maxQueueSize) {
      metrics.rejectedByBackpressure += 1;
      return Promise.reject(new ArcGisRequestSchedulerError('ArcGIS request queue capacity exceeded.', {
        code: 'QUEUE_CAPACITY_EXCEEDED',
        requestKey: key,
        resourceUrl,
      }));
    }

    const job = {
      key,
      resourceUrl,
      origin,
      execute,
      priority: normalizePriority(request.priority),
      sequence: sequence += 1,
      enqueuedAt: clock(),
      startedAt: null,
      state: 'queued',
      controller: new AbortController(),
      subscribers: new Set(),
      options: {
        cache: request.cache,
        cacheTtlMs: request.cacheTtlMs,
        staleTtlMs: request.staleTtlMs,
        allowStaleOnError: request.allowStaleOnError,
        estimatedBytes: request.estimatedBytes,
        tags: uniqueStrings(request.tags),
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
    const promise = addSubscriber(job, request.signal);
    pump();
    return promise;
  };

  const invalidate = (key) => deleteCacheEntry(normalizeRequestKey(key));

  const invalidateTag = (tagValue) => {
    const tag = String(tagValue ?? '').trim();
    if (!tag) return 0;
    const keys = [...(tagIndex.get(tag) || [])];
    let removed = 0;
    keys.forEach((key) => {
      if (deleteCacheEntry(key)) removed += 1;
    });
    return removed;
  };

  const clearCache = () => {
    const removed = cache.size;
    [...cache.keys()].forEach((key) => deleteCacheEntry(key));
    return removed;
  };

  const cancel = (key, reason = 'Request cancelled') => {
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

  const configure = (next = {}) => {
    if (destroyed) return snapshot();
    maxConcurrent = positiveInteger(next.maxConcurrent, maxConcurrent, 64);
    maxConcurrentPerOrigin = positiveInteger(next.maxConcurrentPerOrigin, maxConcurrentPerOrigin, maxConcurrent);
    maxQueueSize = positiveInteger(next.maxQueueSize, maxQueueSize, 10000);
    maxCacheEntries = positiveInteger(next.maxCacheEntries, maxCacheEntries, 10000);
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

  const snapshot = () => Object.freeze({
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

  const destroy = (reason = 'ArcGIS request scheduler destroyed') => {
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
