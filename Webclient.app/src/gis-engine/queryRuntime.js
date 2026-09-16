export class QueryRuntimeError extends Error {
  constructor(message, details = {}) {
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

const now = () => Date.now();

const normalizePositiveInteger = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.floor(numeric));
};

const normalizeNonNegativeInteger = (value, fallback = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
};

const makeCancelledError = (key) => new QueryRuntimeError('GIS query cancelled.', {
  code: 'CANCELLED',
  key,
});

const makeDestroyedError = (key) => new QueryRuntimeError('GIS query runtime has been destroyed.', {
  code: 'RUNTIME_DESTROYED',
  key,
});

const throwIfAborted = (signal, key) => {
  if (signal?.aborted) throw makeCancelledError(key);
};

const safeJsonSize = (value) => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return 0;
    // UTF-16 strings occupy at most two bytes per code unit for the purposes of
    // a conservative in-memory cache budget. This is intentionally an estimate,
    // not a wire-size claim.
    return serialized.length * 2;
  } catch (_) {
    return 0;
  }
};

const normalizeKey = (key) => {
  if (key === null || key === undefined || key === '') {
    throw new QueryRuntimeError('A stable query key is required.', { code: 'INVALID_QUERY_KEY' });
  }
  return String(key);
};

const cloneMetrics = (metrics, runtime) => ({
  ...metrics,
  cacheEntries: runtime.cache.size,
  cacheBytes: runtime.cacheBytes,
  inFlight: runtime.inFlight.size,
  subscribers: Array.from(runtime.inFlight.values())
    .reduce((total, entry) => total + entry.subscribers.size, 0),
});

const defaultCacheable = () => true;

const createAbortController = () => (
  typeof AbortController === 'undefined' ? null : new AbortController()
);

const touchEntry = (cache, key, entry) => {
  cache.delete(key);
  cache.set(key, entry);
};

export const createQueryRuntime = (configuration = {}) => {
  const settings = {
    ttlMs: normalizePositiveInteger(configuration.ttlMs, DEFAULT_TTL_MS, 24 * 60 * 60 * 1000),
    maxEntries: normalizePositiveInteger(configuration.maxEntries, DEFAULT_MAX_ENTRIES, 10000),
    maxBytes: normalizePositiveInteger(configuration.maxBytes, DEFAULT_MAX_BYTES, 256 * 1024 * 1024),
  };

  const runtime = {
    cache: new Map(),
    cacheBytes: 0,
    inFlight: new Map(),
    destroyed: false,
  };

  const metrics = {
    requests: 0,
    networkStarts: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheWrites: 0,
    cacheSkips: 0,
    cacheExpirations: 0,
    cacheEvictions: 0,
    deduped: 0,
    cancellations: 0,
    sharedAborts: 0,
    errors: 0,
    successes: 0,
    totalDurationMs: 0,
    lastDurationMs: null,
  };

  const deleteCacheEntry = (key, reason = null) => {
    const entry = runtime.cache.get(key);
    if (!entry) return false;
    runtime.cache.delete(key);
    runtime.cacheBytes = Math.max(0, runtime.cacheBytes - entry.sizeBytes);
    if (reason === 'expired') metrics.cacheExpirations += 1;
    if (reason === 'evicted') metrics.cacheEvictions += 1;
    return true;
  };

  const evictToBudget = () => {
    while (
      runtime.cache.size > settings.maxEntries ||
      runtime.cacheBytes > settings.maxBytes
    ) {
      const oldestKey = runtime.cache.keys().next().value;
      if (oldestKey === undefined) break;
      deleteCacheEntry(oldestKey, 'evicted');
    }
  };

  const sweepExpired = (currentTime = now()) => {
    runtime.cache.forEach((entry, key) => {
      if (entry.expiresAt <= currentTime) deleteCacheEntry(key, 'expired');
    });
    return runtime.cache.size;
  };

  const readCache = (key, options = {}) => {
    if (options.cache === false) return { hit: false, value: undefined };
    const entry = runtime.cache.get(key);
    if (!entry) {
      metrics.cacheMisses += 1;
      return { hit: false, value: undefined };
    }
    if (entry.expiresAt <= now()) {
      deleteCacheEntry(key, 'expired');
      metrics.cacheMisses += 1;
      return { hit: false, value: undefined };
    }
    entry.lastAccessAt = now();
    entry.hits += 1;
    touchEntry(runtime.cache, key, entry);
    metrics.cacheHits += 1;
    return { hit: true, value: entry.value, metadata: { ...entry } };
  };

  const writeCache = (key, value, options = {}) => {
    if (options.cache === false) {
      metrics.cacheSkips += 1;
      return false;
    }

    const isCacheable = typeof options.isCacheable === 'function'
      ? options.isCacheable
      : defaultCacheable;
    if (!isCacheable(value)) {
      metrics.cacheSkips += 1;
      return false;
    }

    const sizeBytes = normalizeNonNegativeInteger(
      typeof options.sizeOf === 'function' ? options.sizeOf(value) : safeJsonSize(value),
      0,
    );

    if (sizeBytes > settings.maxBytes) {
      metrics.cacheSkips += 1;
      return false;
    }

    const ttlMs = normalizePositiveInteger(options.ttlMs, settings.ttlMs, 24 * 60 * 60 * 1000);
    const createdAt = now();
    const existing = runtime.cache.get(key);
    if (existing) runtime.cacheBytes = Math.max(0, runtime.cacheBytes - existing.sizeBytes);

    runtime.cache.delete(key);
    runtime.cache.set(key, {
      key,
      value,
      createdAt,
      lastAccessAt: createdAt,
      expiresAt: createdAt + ttlMs,
      sizeBytes,
      hits: 0,
      tags: Array.isArray(options.tags) ? [...new Set(options.tags.map(String))] : [],
    });
    runtime.cacheBytes += sizeBytes;
    metrics.cacheWrites += 1;
    evictToBudget();
    return runtime.cache.has(key);
  };

  const releaseSubscriber = (entry, token, reason = null) => {
    if (!entry.subscribers.has(token)) return;
    entry.subscribers.delete(token);
    if (reason === 'cancelled') metrics.cancellations += 1;

    if (
      !entry.settled &&
      entry.subscribers.size === 0 &&
      entry.controller &&
      !entry.controller.signal.aborted
    ) {
      entry.controller.abort();
      metrics.sharedAborts += 1;
    }
  };

  const subscribe = (entry, externalSignal) => new Promise((resolve, reject) => {
    const token = {};
    let completed = false;
    let abortHandler = null;

    const finish = (callback, value, reason = null) => {
      if (completed) return;
      completed = true;
      if (abortHandler && externalSignal) {
        externalSignal.removeEventListener('abort', abortHandler);
      }
      releaseSubscriber(entry, token, reason);
      callback(value);
    };

    entry.subscribers.add(token);

    if (externalSignal) {
      abortHandler = () => finish(reject, makeCancelledError(entry.key), 'cancelled');
      if (externalSignal.aborted) {
        abortHandler();
        return;
      }
      externalSignal.addEventListener('abort', abortHandler, { once: true });
    }

    entry.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });

  const startRequest = (key, factory, options) => {
    if (runtime.destroyed) throw makeDestroyedError(key);
    if (typeof factory !== 'function') {
      throw new QueryRuntimeError('A query request factory is required.', {
        code: 'INVALID_QUERY_FACTORY',
        key,
      });
    }

    const controller = createAbortController();
    const startedAt = now();
    const entry = {
      key,
      controller,
      subscribers: new Set(),
      settled: false,
      startedAt,
      promise: null,
    };

    metrics.networkStarts += 1;

    entry.promise = Promise.resolve()
      .then(() => factory({
        key,
        signal: controller?.signal,
        startedAt,
      }))
      .then((value) => {
        metrics.successes += 1;
        writeCache(key, value, options);
        return value;
      })
      .catch((error) => {
        // A shared AbortController abort caused by all consumers leaving is an
        // expected lifecycle event, not a service-health error.
        const sharedAbort = controller?.signal?.aborted && entry.subscribers.size === 0;
        if (!sharedAbort) metrics.errors += 1;
        throw error;
      })
      .finally(() => {
        entry.settled = true;
        const duration = Math.max(0, now() - startedAt);
        metrics.totalDurationMs += duration;
        metrics.lastDurationMs = duration;
        if (runtime.inFlight.get(key) === entry) runtime.inFlight.delete(key);
      });

    // Prevent a request abandoned by all subscribers from surfacing as an
    // unhandled rejection if the underlying SDK rejects after abort.
    entry.promise.catch(() => {});
    runtime.inFlight.set(key, entry);
    return entry;
  };

  const execute = async (rawKey, factory, options = {}) => {
    const key = normalizeKey(rawKey);
    if (runtime.destroyed) throw makeDestroyedError(key);
    throwIfAborted(options.signal, key);
    metrics.requests += 1;

    const cached = readCache(key, options);
    if (cached.hit) return cached.value;

    let entry = options.dedupe === false ? null : runtime.inFlight.get(key);
    if (entry) {
      metrics.deduped += 1;
    } else {
      entry = startRequest(key, factory, options);
    }

    return subscribe(entry, options.signal);
  };

  const prefetch = async (rawKey, factory, options = {}) => execute(rawKey, factory, {
    ...options,
    signal: undefined,
  });

  const getCached = (rawKey, options = {}) => {
    const key = normalizeKey(rawKey);
    const cached = readCache(key, options);
    return cached.hit ? cached.value : undefined;
  };

  const peek = (rawKey) => {
    const key = normalizeKey(rawKey);
    const entry = runtime.cache.get(key);
    if (!entry || entry.expiresAt <= now()) return null;
    return {
      key: entry.key,
      createdAt: entry.createdAt,
      lastAccessAt: entry.lastAccessAt,
      expiresAt: entry.expiresAt,
      sizeBytes: entry.sizeBytes,
      hits: entry.hits,
      tags: [...entry.tags],
    };
  };

  const invalidate = (selector) => {
    let removed = 0;
    const predicate = typeof selector === 'function'
      ? selector
      : (entry, key) => key === String(selector);

    [...runtime.cache.entries()].forEach(([key, entry]) => {
      if (!predicate(entry.value, key, entry)) return;
      if (deleteCacheEntry(key)) removed += 1;
    });
    return removed;
  };

  const invalidateTag = (tag) => {
    const normalizedTag = String(tag);
    return invalidate((_, __, entry) => entry.tags.includes(normalizedTag));
  };

  const clear = ({ abortInFlight = false } = {}) => {
    runtime.cache.clear();
    runtime.cacheBytes = 0;
    if (abortInFlight) {
      runtime.inFlight.forEach((entry) => {
        if (entry.controller && !entry.controller.signal.aborted) entry.controller.abort();
      });
      runtime.inFlight.clear();
    }
  };

  const destroy = () => {
    if (runtime.destroyed) return;
    runtime.destroyed = true;
    clear({ abortInFlight: true });
  };

  const configure = (patch = {}) => {
    if (patch.ttlMs !== undefined) {
      settings.ttlMs = normalizePositiveInteger(patch.ttlMs, settings.ttlMs, 24 * 60 * 60 * 1000);
    }
    if (patch.maxEntries !== undefined) {
      settings.maxEntries = normalizePositiveInteger(patch.maxEntries, settings.maxEntries, 10000);
    }
    if (patch.maxBytes !== undefined) {
      settings.maxBytes = normalizePositiveInteger(patch.maxBytes, settings.maxBytes, 256 * 1024 * 1024);
    }
    evictToBudget();
    return { ...settings };
  };

  return {
    execute,
    prefetch,
    getCached,
    peek,
    invalidate,
    invalidateTag,
    sweepExpired,
    clear,
    destroy,
    configure,
    getSettings: () => ({ ...settings }),
    getStats: () => cloneMetrics(metrics, runtime),
  };
};

export const createArcGisQueryCachePolicy = (options = {}) => ({
  cache: options.cache !== false,
  ttlMs: options.ttlMs,
  tags: options.tags,
  isCacheable: (result) => {
    if (!result || result.type === 'error') return false;
    if (result.exceededTransferLimit === true) return false;
    if (result.page?.hasMore === true) return false;
    return true;
  },
});

export const createQueryRuntimeKey = ({ serviceUrl, operation = 'features', queryKey = '' } = {}) => {
  const normalizedUrl = String(serviceUrl || '').trim().replace(/\/+$/, '');
  const normalizedOperation = String(operation || 'features').trim().toLowerCase();
  if (!normalizedUrl) {
    throw new QueryRuntimeError('A service URL is required to build a query runtime key.', {
      code: 'INVALID_SERVICE_URL',
    });
  }
  return `${normalizedOperation}:${normalizedUrl}:${String(queryKey || '')}`;
};
