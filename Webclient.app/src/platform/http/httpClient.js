import { runtimeConfig } from '../config/runtimeConfig';
import { RequestCache } from '../cache/requestCache';
import { AppError, ERROR_CODES, normalizeError } from '../errors/appError';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const DEFAULT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const joinUrl = (baseUrl, path) => {
  if (!path) return baseUrl || '/';
  if (/^https?:\/\//i.test(path)) return path;
  return `${String(baseUrl || '').replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
};

const normalizeQuery = (params = {}) => Object.keys(params)
  .filter((key) => params[key] !== undefined && params[key] !== null)
  .sort()
  .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(Array.isArray(params[key]) ? params[key].join(',') : params[key])}`)
  .join('&');

const createRequestKey = ({ method, url, params, body }) => `${method.toUpperCase()} ${url}?${normalizeQuery(params)}|${body ? JSON.stringify(body) : ''}`;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
    return;
  }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
  }, { once: true });
});

const withTimeoutSignal = (signal, timeoutMs) => {
  const controller = new AbortController();
  let timeout;
  const abortParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortParent, { once: true });
  }
  if (timeoutMs > 0) timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', abortParent);
    },
  };
};

const toHeaders = (headers = {}) => {
  const result = new Headers();
  Object.keys(headers).forEach((key) => result.set(key, headers[key]));
  return result;
};

const readResponseBody = async (response) => {
  const contentType = response.headers.get('content-type') || '';
  if (response.status === 204) return null;
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return await response.json();
    } catch (error) {
      throw new AppError('Response JSON could not be parsed', { code: ERROR_CODES.PARSE, status: response.status, cause: error });
    }
  }
  return response.text();
};

const shouldRetry = (error, method, attempt, maxRetries) => {
  if (!SAFE_METHODS.has(method) || attempt >= maxRetries) return false;
  if (error.code === ERROR_CODES.ABORTED || error.code === ERROR_CODES.UNAUTHORIZED || error.code === ERROR_CODES.FORBIDDEN) return false;
  if (error.code === ERROR_CODES.TIMEOUT || error.code === ERROR_CODES.NETWORK) return true;
  return DEFAULT_RETRY_STATUSES.has(error.status);
};

const backoffMs = (attempt) => Math.min(250 * (2 ** attempt), 2000) + Math.floor(Math.random() * 100);

export class ApiClient {
  constructor({
    baseUrl = runtimeConfig.apiBaseUrl,
    timeoutMs = runtimeConfig.requestTimeoutMs,
    maxRetries = runtimeConfig.maxRetries,
    cache = new RequestCache({ ttlMs: runtimeConfig.cacheTtlMs, maxEntries: 150 }),
    defaultHeaders = {},
  } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.cache = cache;
    this.defaultHeaders = { Accept: 'application/json', ...defaultHeaders };
  }

  async request({ method = 'GET', path = '/', params = {}, body, headers = {}, signal, cache = false, cacheTtlMs, retries = this.maxRetries } = {}) {
    const upperMethod = method.toUpperCase();
    const url = joinUrl(this.baseUrl, path);
    const query = normalizeQuery(params);
    const requestUrl = query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url;
    const key = createRequestKey({ method: upperMethod, url: requestUrl, params, body });

    if (cache && SAFE_METHODS.has(upperMethod)) {
      return this.cache.getOrCreate(key, () => this._requestNetwork({ upperMethod, requestUrl, body, headers, signal, retries }), { ttlMs: cacheTtlMs });
    }
    return this._requestNetwork({ upperMethod, requestUrl, body, headers, signal, retries });
  }

  get(path, options = {}) {
    return this.request({ ...options, method: 'GET', path });
  }

  post(path, body, options = {}) {
    return this.request({ ...options, method: 'POST', path, body, cache: false });
  }

  put(path, body, options = {}) {
    return this.request({ ...options, method: 'PUT', path, body, cache: false });
  }

  patch(path, body, options = {}) {
    return this.request({ ...options, method: 'PATCH', path, body, cache: false });
  }

  delete(path, options = {}) {
    return this.request({ ...options, method: 'DELETE', path, cache: false });
  }

  invalidate(pathPrefix) {
    this.cache.invalidatePrefix(pathPrefix);
  }

  async _requestNetwork({ upperMethod, requestUrl, body, headers, signal, retries }) {
    let attempt = 0;
    while (true) {
      const controller = withTimeoutSignal(signal, this.timeoutMs);
      try {
        const requestHeaders = toHeaders({ ...this.defaultHeaders, ...headers });
        const init = { method: upperMethod, headers: requestHeaders, credentials: 'same-origin', cache: 'no-store', signal: controller.signal };
        if (body !== undefined && body !== null && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
          if (typeof body === 'string' || body instanceof FormData || body instanceof Blob) init.body = body;
          else {
            requestHeaders.set('Content-Type', 'application/json');
            init.body = JSON.stringify(body);
          }
        }

        const startedAt = Date.now();
        const response = await fetch(requestUrl, init);
        const responseBody = await readResponseBody(response);
        if (!response.ok) {
          throw new AppError(`API request failed with status ${response.status}`, {
            code: response.status === 408 ? ERROR_CODES.TIMEOUT : undefined,
            status: response.status,
            endpoint: requestUrl,
            retryable: DEFAULT_RETRY_STATUSES.has(response.status),
            requestId: response.headers.get('x-request-id'),
            details: { durationMs: Date.now() - startedAt },
          });
        }
        return responseBody;
      } catch (rawError) {
        const error = normalizeError(rawError, { endpoint: requestUrl });
        if (!shouldRetry(error, upperMethod, attempt, retries)) throw error;
        attempt += 1;
        await sleep(backoffMs(attempt - 1), signal);
      } finally {
        controller.cleanup();
      }
    }
  }
}

export const apiClient = new ApiClient();
