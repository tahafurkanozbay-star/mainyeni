import { RequestCache } from '../cache/requestCache';
import { createNetworkDiagnostics, recordNetworkEvent } from './networkDiagnostics';
import { createRequestKey, normalizeRequestConfig } from './requestPolicy';
import { executeWithRetry } from './retryPolicy';

const DEFAULT_MAX_CACHE_ENTRIES = 150;

const now = (clock) => {
  const value = Number((clock || Date.now)());
  return Number.isFinite(value) ? value : Date.now();
};

const cloneCachedResult = (entry) => Object.freeze({
  ...entry,
  metadata: entry?.metadata
    ? Object.freeze({ ...entry.metadata, cache: 'hit' })
    : Object.freeze({ cache: 'hit' }),
  fromCache: true
});

export class RequestCoordinator {
  constructor(options = {}) {
    if (!options.transport || typeof options.transport.request !== 'function') {
      throw new TypeError('RequestCoordinator requires transport.request');
    }

    this.transport = options.transport;
    this.defaults = Object.freeze({
      timeoutMs: options.timeoutMs ?? options.transport.defaults?.timeoutMs ?? 15000,
      maxRetries: options.maxRetries ?? options.transport.defaults?.maxRetries ?? 0,
      cacheTtlMs: options.cacheTtlMs ?? options.transport.defaults?.cacheTtlMs ?? 0
    });
    this.cache = options.cache || new RequestCache({
      ttlMs: this.defaults.cacheTtlMs,
      maxEntries: options.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES
    });
    this.inFlight = new Map();
    this.diagnostics = options.diagnostics || createNetworkDiagnostics();
    this.clock = options.clock || Date.now;
    this.wait = options.wait;
    this.retryOptions = options.retryOptions || {};
  }

  normalize(config) {
    return normalizeRequestConfig(config, this.defaults);
  }

  getKey(config) {
    return createRequestKey(config);
  }

  readCache(config, key) {
    if (!config.cache) return undefined;

    const cached = this.cache.get(key);
    if (cached === undefined) {
      recordNetworkEvent(this.diagnostics, 'network.cache.miss', {
        method: config.method,
        url: config.url
      });
      return undefined;
    }

    recordNetworkEvent(this.diagnostics, 'network.cache.hit', {
      method: config.method,
      url: config.url
    });
    return cloneCachedResult(cached);
  }

  writeCache(config, key, result) {
    if (!config.cache || !result || result.status < 200 || result.status >= 300) return;
    this.cache.set(key, result, config.cacheTtlMs);
    recordNetworkEvent(this.diagnostics, 'network.cache.write', {
      method: config.method,
      url: config.url,
      status: result.status,
      cacheTtlMs: config.cacheTtlMs
    });
  }

  async execute(config, key) {
    const startedAt = now(this.clock);
    recordNetworkEvent(this.diagnostics, 'network.request.started', {
      method: config.method,
      url: config.url,
      timeoutMs: config.timeout,
      maxRetries: config.maxRetries,
      cache: config.cache,
      dedupe: config.dedupe
    });

    try {
      const result = await executeWithRetry(
        ({ attempt }) => this.transport.request({ ...config, attempt }),
        {
          maxRetries: config.maxRetries,
          retryAllowed: config.retryAllowed,
          signal: config.signal,
          retryOptions: this.retryOptions,
          wait: this.wait,
          onAttempt: ({ attempt }) => {
            recordNetworkEvent(this.diagnostics, 'network.request.attempt', {
              method: config.method,
              url: config.url,
              attempt
            });
          },
          onRetry: ({ error, attempt, nextAttempt, delayMs }) => {
            recordNetworkEvent(this.diagnostics, 'network.request.retry', {
              method: config.method,
              url: config.url,
              status: error?.status,
              code: error?.code,
              attempt,
              nextAttempt,
              delayMs
            });
          }
        }
      );

      const durationMs = Math.max(0, now(this.clock) - startedAt);
      const completed = Object.freeze({
        ...result,
        durationMs: result?.durationMs ?? durationMs,
        fromCache: false
      });

      this.writeCache(config, key, completed);
      recordNetworkEvent(this.diagnostics, 'network.request.completed', {
        method: config.method,
        url: config.url,
        status: completed.status,
        durationMs
      });
      return completed;
    } catch (error) {
      const durationMs = Math.max(0, now(this.clock) - startedAt);
      recordNetworkEvent(this.diagnostics, 'network.request.failed', {
        method: config.method,
        url: config.url,
        status: error?.status,
        code: error?.code,
        retryable: error?.retryable === true,
        durationMs
      });
      throw error;
    }
  }

  request(rawConfig = {}) {
    const config = this.normalize(rawConfig);
    const key = this.getKey(config);
    const cached = this.readCache(config, key);
    if (cached !== undefined) return Promise.resolve(cached);

    if (config.dedupe && this.inFlight.has(key)) {
      recordNetworkEvent(this.diagnostics, 'network.dedupe.join', {
        method: config.method,
        url: config.url
      });
      return this.inFlight.get(key);
    }

    const promise = this.execute(config, key)
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
          recordNetworkEvent(this.diagnostics, 'network.dedupe.release', {
            method: config.method,
            url: config.url
          });
        }
      });

    if (config.dedupe) {
      this.inFlight.set(key, promise);
      recordNetworkEvent(this.diagnostics, 'network.dedupe.start', {
        method: config.method,
        url: config.url
      });
    }

    return promise;
  }

  clearCache() {
    const sizeBefore = this.cache.size();
    this.cache.clear();
    recordNetworkEvent(this.diagnostics, 'network.cache.clear', { removed: sizeBefore });
    return sizeBefore;
  }

  invalidateCache(prefix = '') {
    const removed = prefix ? this.cache.invalidatePrefix(prefix) : this.clearCache();
    if (prefix) {
      recordNetworkEvent(this.diagnostics, 'network.cache.invalidate', { prefix, removed });
    }
    return removed;
  }

  getCacheSize() {
    return this.cache.size();
  }

  getInFlightSize() {
    return this.inFlight.size;
  }

  getDiagnostics(options = {}) {
    return this.diagnostics.snapshot(options);
  }

  getDiagnosticSummary() {
    return this.diagnostics.summary();
  }

  clearDiagnostics() {
    this.diagnostics.clear();
  }
}

export const createRequestCoordinator = (options = {}) =>
  new RequestCoordinator(options);

export const createCoordinatedClient = (options = {}) => {
  const coordinator = createRequestCoordinator(options);

  const requestRaw = (config = {}) => coordinator.request(config);
  const request = async (config = {}) => {
    const result = await requestRaw(config);
    return result.data;
  };

  return Object.freeze({
    request,
    requestRaw,
    get: (url, config = {}) => request({ ...config, url, method: 'get' }),
    head: (url, config = {}) => request({ ...config, url, method: 'head' }),
    post: (url, data, config = {}) => request({ ...config, url, data, method: 'post', cache: false, dedupe: false }),
    put: (url, data, config = {}) => request({ ...config, url, data, method: 'put', cache: false, dedupe: false }),
    patch: (url, data, config = {}) => request({ ...config, url, data, method: 'patch', cache: false, dedupe: false }),
    delete: (url, config = {}) => request({ ...config, url, method: 'delete', cache: false, dedupe: false }),
    clearCache: () => coordinator.clearCache(),
    invalidateCache: (prefix) => coordinator.invalidateCache(prefix),
    getCacheSize: () => coordinator.getCacheSize(),
    getInFlightSize: () => coordinator.getInFlightSize(),
    getDiagnostics: (optionsArg) => coordinator.getDiagnostics(optionsArg),
    getDiagnosticSummary: () => coordinator.getDiagnosticSummary(),
    clearDiagnostics: () => coordinator.clearDiagnostics(),
    coordinator
  });
};
