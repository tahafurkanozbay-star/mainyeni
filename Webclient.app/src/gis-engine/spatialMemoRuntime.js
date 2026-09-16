import { geometryFingerprint } from './geometryIntegrityRuntime';

export class SpatialMemoError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SpatialMemoError';
    this.code = details.code || 'SPATIAL_MEMO_ERROR';
    this.key = details.key || null;
    this.cause = details.cause;
  }
}

const DEFAULTS = Object.freeze({
  ttlMs: 60000,
  maxEntries: 256,
  maxBytes: 8 * 1024 * 1024,
  maxTtlMs: 24 * 60 * 60 * 1000,
});

const now = () => Date.now();

const positiveInteger = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const nonNegativeInteger = (value, fallback = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
};

const safeJsonSize = (value) => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : serialized.length * 2;
  } catch (_) {
    return 0;
  }
};

const normalizeKey = (key) => {
  const normalized = String(key ?? '').trim();
  if (!normalized) {
    throw new SpatialMemoError('A stable spatial memo key is required.', {
      code: 'INVALID_KEY',
    });
  }
  return normalized;
};

const stable = (value, seen = new WeakSet()) => {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (typeof value.toJSON === 'function') return stable(value.toJSON(), seen);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stable(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
};

const hash = (value) => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
};

const normalizeOperation = (operation) => {
  const value = String(operation ?? '').trim().toLowerCase();
  if (!value) {
    throw new SpatialMemoError('A spatial operation name is required.', {
      code: 'INVALID_OPERATION',
    });
  }
  return value;
};

const argumentFingerprint = (value) => {
  if (value && typeof value === 'object') {
    const geometryLike = value.geometry || value;
    if (
      geometryLike &&
      typeof geometryLike === 'object' &&
      (
        'x' in geometryLike ||
        'points' in geometryLike ||
        'paths' in geometryLike ||
        'rings' in geometryLike ||
        'xmin' in geometryLike
      )
    ) {
      return geometryFingerprint(geometryLike);
    }
  }
  return `arg:${hash(stable(value))}`;
};

export const createSpatialMemoKey = (operation, args = [], options = {}) => {
  const normalizedOperation = normalizeOperation(operation);
  const values = Array.isArray(args) ? args : [args];
  const parts = values.map(argumentFingerprint);
  if (options.namespace) parts.unshift(`ns:${String(options.namespace)}`);
  if (options.version) parts.push(`v:${String(options.version)}`);
  return `${normalizedOperation}:${parts.join(':')}`;
};

const cancelledError = (key) => new SpatialMemoError('Spatial computation cancelled.', {
  code: 'CANCELLED',
  key,
});

const destroyedError = (key) => new SpatialMemoError('Spatial memo runtime has been destroyed.', {
  code: 'RUNTIME_DESTROYED',
  key,
});

const createController = () => (
  typeof AbortController === 'undefined' ? null : new AbortController()
);

const safeAbort = (controller) => {
  if (!controller || controller.signal?.aborted) return false;
  try {
    controller.abort();
    return true;
  } catch (_) {
    return false;
  }
};

export const createSpatialMemoRuntime = (configuration = {}) => {
  const clock = typeof configuration.now === 'function' ? configuration.now : now;
  const settings = {
    ttlMs: positiveInteger(configuration.ttlMs, DEFAULTS.ttlMs, DEFAULTS.maxTtlMs),
    maxEntries: positiveInteger(configuration.maxEntries, DEFAULTS.maxEntries, 10000),
    maxBytes: positiveInteger(configuration.maxBytes, DEFAULTS.maxBytes, 256 * 1024 * 1024),
  };
  const cache = new Map();
  const inFlight = new Map();
  let cacheBytes = 0;
  let destroyed = false;

  const metrics = {
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

  const deleteEntry = (key, reason = null) => {
    const entry = cache.get(key);
    if (!entry) return false;
    cache.delete(key);
    cacheBytes = Math.max(0, cacheBytes - entry.sizeBytes);
    if (reason === 'evicted') metrics.evictions += 1;
    if (reason === 'expired') metrics.expirations += 1;
    return true;
  };

  const touch = (key, entry) => {
    cache.delete(key);
    cache.set(key, entry);
  };

  const evict = () => {
    while (cache.size > settings.maxEntries || cacheBytes > settings.maxBytes) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      deleteEntry(oldest, 'evicted');
    }
  };

  const read = (key, options = {}) => {
    if (options.cache === false) return { hit: false };
    const entry = cache.get(key);
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
    touch(key, entry);
    metrics.cacheHits += 1;
    return { hit: true, value: entry.value };
  };

  const write = (key, value, options = {}) => {
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
      tags: [...new Set((options.tags || []).filter(Boolean).map(String))],
    });
    cacheBytes += sizeBytes;
    metrics.cacheWrites += 1;
    evict();
    return cache.has(key);
  };

  const release = (entry, subscriber, reason = null) => {
    if (!entry.subscribers.has(subscriber)) return;
    entry.subscribers.delete(subscriber);
    if (reason === 'cancelled') metrics.cancellations += 1;
    if (entry.subscribers.size === 0 && !entry.settled && safeAbort(entry.controller)) {
      metrics.underlyingAborts += 1;
    }
  };

  const subscribe = (entry, signal) => new Promise((resolve, reject) => {
    const subscriber = { done: false, signal, abortHandler: null };
    entry.subscribers.add(subscriber);

    const finish = (callback, value, reason = null) => {
      if (subscriber.done) return;
      subscriber.done = true;
      if (subscriber.abortHandler && signal) signal.removeEventListener('abort', subscriber.abortHandler);
      release(entry, subscriber, reason);
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

  const start = (key, factory, options) => {
    const controller = createController();
    const startedAt = clock();
    const entry = {
      key,
      controller,
      subscribers: new Set(),
      settled: false,
      promise: null,
    };
    metrics.computations += 1;

    let computation;
    try {
      computation = Promise.resolve(factory({
        key,
        signal: controller?.signal,
        startedAt,
      }));
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
        const abandonedAbort = controller?.signal?.aborted && entry.subscribers.size === 0;
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
    entry.promise.catch(() => {});
    inFlight.set(key, entry);
    return entry;
  };

  const execute = async (rawKey, factory, options = {}) => {
    const key = normalizeKey(rawKey);
    if (destroyed) throw destroyedError(key);
    if (typeof factory !== 'function') {
      throw new SpatialMemoError('A spatial computation factory is required.', {
        code: 'INVALID_FACTORY',
        key,
      });
    }
    if (options.signal?.aborted) throw cancelledError(key);
    metrics.requests += 1;

    const cached = read(key, options);
    if (cached.hit) return cached.value;

    let entry = options.dedupe === false ? null : inFlight.get(key);
    if (entry) {
      metrics.deduped += 1;
    } else {
      entry = start(key, factory, options);
    }
    return subscribe(entry, options.signal);
  };

  const invalidate = (selector) => {
    const predicate = typeof selector === 'function'
      ? selector
      : (_, key) => key === String(selector);
    let removed = 0;
    [...cache.entries()].forEach(([key, entry]) => {
      if (predicate(entry.value, key, entry) && deleteEntry(key)) removed += 1;
    });
    return removed;
  };

  const invalidateTag = (tag) => {
    const normalized = String(tag);
    return invalidate((_, __, entry) => entry.tags.includes(normalized));
  };

  const sweepExpired = () => {
    const current = clock();
    [...cache.entries()].forEach(([key, entry]) => {
      if (entry.expiresAt <= current) deleteEntry(key, 'expired');
    });
    return cache.size;
  };

  const clear = ({ abortInFlight = false } = {}) => {
    cache.clear();
    cacheBytes = 0;
    if (abortInFlight) {
      inFlight.forEach((entry) => safeAbort(entry.controller));
      inFlight.clear();
    }
  };

  const configure = (patch = {}) => {
    if (patch.ttlMs !== undefined) {
      settings.ttlMs = positiveInteger(patch.ttlMs, settings.ttlMs, DEFAULTS.maxTtlMs);
    }
    if (patch.maxEntries !== undefined) {
      settings.maxEntries = positiveInteger(patch.maxEntries, settings.maxEntries, 10000);
    }
    if (patch.maxBytes !== undefined) {
      settings.maxBytes = positiveInteger(patch.maxBytes, settings.maxBytes, 256 * 1024 * 1024);
    }
    evict();
    return { ...settings };
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    clear({ abortInFlight: true });
  };

  return Object.freeze({
    execute,
    read: (key) => {
      const result = read(normalizeKey(key));
      return result.hit ? result.value : undefined;
    },
    invalidate,
    invalidateTag,
    sweepExpired,
    clear,
    configure,
    destroy,
    getSettings: () => ({ ...settings }),
    getStats: () => ({
      ...metrics,
      cacheEntries: cache.size,
      cacheBytes,
      inFlight: inFlight.size,
    }),
  });
};
