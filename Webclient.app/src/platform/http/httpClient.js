import axios from 'axios';
import { RequestCache } from '../cache/requestCache';
import { runtimeConfig } from '../config/runtimeConfig';
import { isAbortError, normalizeAxiosError } from '../errors/appError';
import { normalizeApplicationPath } from '../network/endpointPolicy';

export const SAFE_METHODS = new Set(['get', 'head']);

const responseCache = new RequestCache({
  ttlMs: runtimeConfig.cacheTtlMs,
  maxEntries: 150
});
const inFlight = new Map();

const client = axios.create({
  baseURL: runtimeConfig.apiBaseUrl,
  timeout: runtimeConfig.requestTimeoutMs,
  headers: { Accept: 'application/json' },
  withCredentials: true
});

const waitForRetry = (milliseconds, signal) => new Promise((resolve, reject) => {
  let timer;
  let abortHandler;

  const cleanup = () => {
    clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  };

  timer = setTimeout(() => {
    cleanup();
    resolve();
  }, milliseconds);

  if (!signal) return;

  abortHandler = () => {
    cleanup();
    reject(Object.assign(new Error('Request cancelled'), { name: 'AbortError', code: 'ABORTED' }));
  };

  if (signal.aborted) {
    abortHandler();
    return;
  }

  signal.addEventListener('abort', abortHandler, { once: true });
});

export const stableSerialize = (value) => {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(',')}}`;
};

const cacheKey = (config) => [
  String(config.method || 'get').toLowerCase(),
  config.url,
  stableSerialize(config.params)
].join('|');

const hasAuthorizationHeader = (headers) => {
  if (!headers) return false;
  return Object.keys(headers).some((key) =>
    key.toLowerCase() === 'authorization' && Boolean(headers[key]));
};

const isRetryableStatus = (error) => {
  if (isAbortError(error)) return false;
  const status = error?.response?.status;
  return !status || status === 408 || status === 429 || status >= 500;
};

const retryDelay = (attempt) =>
  Math.min(250 * (2 ** attempt), 2000) + Math.round(Math.random() * 100);

const createCancelToken = (signal) => {
  if (!signal) return { token: undefined, cleanup: () => {} };

  const source = axios.CancelToken.source();
  const abortHandler = () => source.cancel('Request cancelled');

  if (signal.aborted) abortHandler();
  else signal.addEventListener('abort', abortHandler, { once: true });

  return {
    token: source.token,
    cleanup: () => signal.removeEventListener('abort', abortHandler)
  };
};

const request = async (config = {}) => {
  const method = String(config.method || 'get').toLowerCase();
  const url = normalizeApplicationPath(config.url || '/');
  const merged = {
    ...config,
    method,
    url,
    timeout: config.timeout ?? runtimeConfig.requestTimeoutMs
  };

  const safeMethod = SAFE_METHODS.has(method);
  const publicRequest = !hasAuthorizationHeader(merged.headers);
  const cacheable = safeMethod && publicRequest && config.cache === true;
  const dedupe = safeMethod && publicRequest && config.dedupe === true && !config.signal;
  const retryAllowed = safeMethod || config.retryUnsafe === true;
  const key = cacheKey(merged);

  if (cacheable) {
    const cached = responseCache.get(key);
    if (cached !== undefined) return cached;
  }

  if (dedupe && inFlight.has(key)) {
    return inFlight.get(key);
  }

  const execute = async () => {
    const cancellation = createCancelToken(config.signal);
    let attempt = 0;

    try {
      while (true) {
        try {
          const response = await client.request({ ...merged, cancelToken: cancellation.token });
          if (cacheable && response.status >= 200 && response.status < 300) {
            responseCache.set(key, response.data, config.cacheTtlMs ?? runtimeConfig.cacheTtlMs);
          }
          return response.data;
        } catch (error) {
          const normalized = normalizeAxiosError(error);
          const maxRetries = config.maxRetries ?? runtimeConfig.maxRetries;

          if (!retryAllowed || attempt >= maxRetries || !isRetryableStatus(error)) {
            throw normalized;
          }

          await waitForRetry(retryDelay(attempt), config.signal);
          attempt += 1;
        }
      }
    } finally {
      cancellation.cleanup();
    }
  };

  const promise = execute().finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });

  if (dedupe) inFlight.set(key, promise);
  return promise;
};

export const apiClient = {
  request,
  get: (url, config = {}) => request({ ...config, url, method: 'get' }),
  head: (url, config = {}) => request({ ...config, url, method: 'head' }),
  post: (url, data, config = {}) => request({ ...config, url, data, method: 'post', cache: false, dedupe: false }),
  put: (url, data, config = {}) => request({ ...config, url, data, method: 'put', cache: false, dedupe: false }),
  patch: (url, data, config = {}) => request({ ...config, url, data, method: 'patch', cache: false, dedupe: false }),
  delete: (url, config = {}) => request({ ...config, url, method: 'delete', cache: false, dedupe: false }),
  clearCache: () => responseCache.clear(),
  invalidateCache: (prefix) => responseCache.invalidatePrefix(prefix),
  getCacheSize: () => responseCache.size()
};
