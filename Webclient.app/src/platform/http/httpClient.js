import { RequestCache } from '../cache/requestCache';
import { runtimeConfig } from '../config/runtimeConfig';
import { isAbortError, normalizeHttpError } from '../errors/appError';
import { normalizeApplicationPath } from '../network/endpointPolicy';
import { requestTelemetry } from '../telemetry/requestTelemetry';
import { createFetchTransport } from './fetchTransport';
import { createRetryDecision, waitForRetryDelay } from './retryPolicy';

export const SAFE_METHODS = new Set(['get', 'head']);

export const stableSerialize = (value, seen = new WeakSet()) => {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (seen.has(value)) throw new TypeError('Circular request parameters are not supported.');

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`;
    }

    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
};

const cacheKey = (config) => [
  String(config.method || 'get').toLowerCase(),
  config.url,
  stableSerialize(config.params)
].join('|');

const headerEntries = (headers) => {
  if (!headers) return [];
  if (typeof headers.entries === 'function') return Array.from(headers.entries());
  return Object.entries(headers);
};

const hasAuthorizationHeader = (headers) =>
  headerEntries(headers).some(([key, value]) =>
    String(key).toLowerCase() === 'authorization' && Boolean(value));

const createDefaultCache = () => new RequestCache({
  ttlMs: runtimeConfig.cacheTtlMs,
  maxEntries: 150
});

// Keep browser feature detection lazy. Test runners, SSR tooling and static analysis can import the
// platform client without needing a fetch global; real browser requests still fail closed if fetch
// is unavailable at execution time.
const createDefaultTransport = () => {
  let transport = null;
  return (request) => {
    if (!transport) {
      transport = createFetchTransport({
        baseUrl: runtimeConfig.apiBaseUrl,
        defaultTimeoutMs: runtimeConfig.requestTimeoutMs,
        defaultHeaders: { Accept: 'application/json' },
        credentials: 'include'
      });
    }
    return transport(request);
  };
};

const normalizeRequest = (config = {}) => ({
  ...config,
  method: String(config.method || 'get').trim().toLowerCase(),
  url: normalizeApplicationPath(config.url || '/'),
  timeout: config.timeout ?? runtimeConfig.requestTimeoutMs
});

const createExecutionContext = (telemetry, merged) =>
  telemetry?.start?.({ method: merged.method, url: merged.url }) || null;

const completeTelemetry = (telemetry, context, response, details = {}) => {
  if (!context || typeof telemetry?.complete !== 'function') return;
  telemetry.complete(context, {
    status: response?.status,
    attempts: details.attempts,
    cache: details.cache,
    deduped: details.deduped
  });
};

const failTelemetry = (telemetry, context, error, attempts) => {
  if (!context || typeof telemetry?.fail !== 'function') return;
  telemetry.fail(context, {
    status: error?.status ?? error?.response?.status,
    errorCode: error?.code,
    aborted: isAbortError(error),
    attempts
  });
};

/**
 * Creates the application HTTP boundary. Dependencies are injectable so retry/cancellation/cache
 * behavior can be regression-tested without live network access. The default transport is the
 * browser's native fetch API; no client secret or browser-only authorization boundary is added.
 */
export const createApiClient = (dependencies = {}) => {
  const responseCache = dependencies.cache || createDefaultCache();
  const transport = dependencies.transport || createDefaultTransport();
  const telemetry = dependencies.telemetry === undefined
    ? requestTelemetry
    : dependencies.telemetry;
  const retryWait = dependencies.retryWait || waitForRetryDelay;
  const inFlight = new Map();

  if (typeof transport !== 'function') {
    throw new TypeError('HTTP transport must be a function.');
  }

  const request = async (config = {}) => {
    const merged = normalizeRequest(config);
    const safeMethod = SAFE_METHODS.has(merged.method);
    const publicRequest = !hasAuthorizationHeader(merged.headers);
    const cacheable = safeMethod && publicRequest && config.cache === true;
    const dedupe = safeMethod && publicRequest && config.dedupe === true && !config.signal;
    const key = cacheKey(merged);

    if (cacheable) {
      const cached = responseCache.get(key);
      if (cached !== undefined) {
        telemetry?.cacheHit?.({ method: merged.method, url: merged.url });
        return cached;
      }
    }

    if (dedupe && inFlight.has(key)) {
      telemetry?.dedupeHit?.({ method: merged.method, url: merged.url });
      return inFlight.get(key);
    }

    const execute = async () => {
      const telemetryContext = createExecutionContext(telemetry, merged);
      let attempt = 0;

      while (true) {
        try {
          const response = await transport(merged);
          const successful = response?.status >= 200 && response?.status < 300;

          if (cacheable && successful) {
            responseCache.set(
              key,
              response.data,
              config.cacheTtlMs ?? runtimeConfig.cacheTtlMs
            );
          }

          if (!safeMethod && successful) {
            responseCache.clear();
          }

          completeTelemetry(telemetry, telemetryContext, response, {
            attempts: attempt + 1
          });
          return response.data;
        } catch (error) {
          const maxRetries = config.maxRetries ?? runtimeConfig.maxRetries;
          const decision = createRetryDecision({
            error,
            method: merged.method,
            attempt,
            maxRetries,
            retryUnsafe: config.retryUnsafe === true,
            signal: config.signal,
            baseDelayMs: config.retryBaseDelayMs,
            maxDelayMs: config.retryMaxDelayMs,
            jitterRatio: config.retryJitterRatio,
            random: config.retryRandom
          });

          if (!decision.retry) {
            const normalized = normalizeHttpError(error);
            failTelemetry(telemetry, telemetryContext, normalized, attempt + 1);
            throw normalized;
          }

          telemetry?.retry?.(telemetryContext, {
            attempt: attempt + 1,
            delayMs: decision.delayMs,
            status: decision.status
          });
          await retryWait(decision.delayMs, config.signal);
          attempt += 1;
        }
      }
    };

    const promise = execute().finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });

    if (dedupe) inFlight.set(key, promise);
    return promise;
  };

  return Object.freeze({
    request,
    get: (url, config = {}) => request({ ...config, url, method: 'get' }),
    head: (url, config = {}) => request({ ...config, url, method: 'head' }),
    post: (url, data, config = {}) => request({
      ...config, url, data, method: 'post', cache: false, dedupe: false
    }),
    put: (url, data, config = {}) => request({
      ...config, url, data, method: 'put', cache: false, dedupe: false
    }),
    patch: (url, data, config = {}) => request({
      ...config, url, data, method: 'patch', cache: false, dedupe: false
    }),
    delete: (url, config = {}) => request({
      ...config, url, method: 'delete', cache: false, dedupe: false
    }),
    clearCache: () => responseCache.clear(),
    invalidateCache: (prefix) => responseCache.invalidatePrefix(prefix),
    getCacheSize: () => responseCache.size(),
    getInFlightCount: () => inFlight.size,
    getTelemetrySnapshot: () => telemetry?.snapshot?.() || [],
    getTelemetrySummary: () => telemetry?.summary?.() || null,
    clearTelemetry: () => telemetry?.clear?.()
  });
};

export const apiClient = createApiClient();
