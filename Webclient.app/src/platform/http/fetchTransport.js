import { normalizeApplicationPath } from '../network/endpointPolicy';

const METHODS_WITHOUT_BODY = new Set(['get', 'head']);
const JSON_CONTENT_TYPE = 'application/json';
const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const stableObject = (value) => {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!isPlainObject(value)) return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableObject(value[key]);
    return result;
  }, {});
};

const serializeQueryValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (isPlainObject(value)) return JSON.stringify(stableObject(value));
  return String(value);
};

export const buildQueryString = (params) => {
  if (!params || typeof params !== 'object') return '';
  const search = new URLSearchParams();

  Object.keys(params).sort().forEach((key) => {
    const value = params[key];
    if (value === undefined || value === null) return;

    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined && item !== null) {
          search.append(key, serializeQueryValue(item));
        }
      });
      return;
    }

    search.append(key, serializeQueryValue(value));
  });

  const value = search.toString();
  return value ? `?${value}` : '';
};

export const combineApplicationUrl = (baseUrl, requestUrl, params) => {
  const base = normalizeApplicationPath(baseUrl || '/api').replace(/\/$/, '');
  const request = normalizeApplicationPath(requestUrl || '/');
  const combined = request === '/'
    ? (base || '/')
    : `${base === '/' ? '' : base}${request}`;
  const normalized = normalizeApplicationPath(combined || '/');
  return `${normalized}${buildQueryString(params)}`;
};

const hasHeader = (headers, name) => {
  if (!headers) return false;
  if (typeof headers.has === 'function') return headers.has(name);
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
};

const createHeaders = (headers) => {
  const result = new Headers();
  if (!headers) return result;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => result.set(key, value));
    return result;
  }

  Object.entries(headers).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    result.set(key, String(value));
  });
  return result;
};

const isBodyInit = (value) => {
  if (typeof value === 'string') return true;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  if (typeof FormData !== 'undefined' && value instanceof FormData) return true;
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return true;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return true;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView?.(value)) return true;
  return false;
};

export const createRequestBody = (data, headers) => {
  if (data === undefined || data === null) return undefined;
  if (isBodyInit(data)) return data;

  if (!hasHeader(headers, 'content-type')) {
    headers.set('Content-Type', JSON_CONTENT_TYPE);
  }
  return JSON.stringify(data);
};

const contentTypeOf = (response) =>
  String(response?.headers?.get?.('content-type') || '').toLowerCase();

export const parseResponseBody = async (response, responseType) => {
  if (response.status === 204 || response.status === 205) return null;

  if (responseType === 'arrayBuffer') return response.arrayBuffer();
  if (responseType === 'blob' && typeof response.blob === 'function') return response.blob();
  if (responseType === 'text') return response.text();

  const contentType = contentTypeOf(response);
  const expectsJson = responseType === 'json' ||
    contentType.includes(JSON_CONTENT_TYPE) ||
    contentType.includes(PROBLEM_JSON_CONTENT_TYPE) ||
    contentType.includes('+json');

  if (!expectsJson) return response.text();

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    const parseError = new Error('Server returned invalid JSON.');
    parseError.name = 'HttpTransportError';
    parseError.code = 'INVALID_JSON_RESPONSE';
    parseError.status = response.status;
    parseError.response = {
      status: response.status,
      data: null,
      headers: response.headers
    };
    parseError.cause = error;
    throw parseError;
  }
};

export const createHttpTransportError = ({
  message,
  code,
  status,
  data,
  headers,
  cause
} = {}) => {
  const error = new Error(message || 'HTTP request failed.');
  error.name = 'HttpTransportError';
  error.code = code || 'HTTP_TRANSPORT_ERROR';
  error.status = Number.isInteger(status) ? status : null;
  error.response = error.status === null
    ? null
    : { status: error.status, data, headers: headers || null };
  error.cause = cause;
  return error;
};

const createAbortError = (cause) => {
  const error = new Error('Request cancelled');
  error.name = 'AbortError';
  error.code = 'ABORTED';
  error.cause = cause;
  return error;
};

const createTimeoutError = (timeoutMs, cause) => createHttpTransportError({
  message: 'Request timed out.',
  code: 'ETIMEDOUT',
  status: 408,
  cause,
  data: { timeoutMs }
});

export const createRequestCancellation = ({ signal, timeoutMs, timers = {} } = {}) => {
  const controller = new AbortController();
  const setTimer = timers.setTimeout || setTimeout;
  const clearTimer = timers.clearTimeout || clearTimeout;
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  let timedOut = false;
  let timer = null;

  const abortFromSignal = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromSignal();
  else if (signal) signal.addEventListener('abort', abortFromSignal, { once: true });

  if (timeout > 0 && !controller.signal.aborted) {
    timer = setTimer(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer !== null) clearTimer(timer);
      if (signal) signal.removeEventListener('abort', abortFromSignal);
    }
  };
};

const validateFetchImplementation = (fetchImpl) => {
  if (typeof fetchImpl !== 'function') {
    throw createHttpTransportError({
      message: 'Fetch transport is unavailable in this runtime.',
      code: 'FETCH_UNAVAILABLE'
    });
  }
  return fetchImpl;
};

export const createFetchTransport = (options = {}) => {
  const {
    baseUrl = '/api',
    fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
    defaultTimeoutMs = 15000,
    defaultHeaders = { Accept: 'application/json' },
    credentials = 'include',
    timers
  } = options;

  const executeFetch = validateFetchImplementation(fetchImpl);

  return async (request = {}) => {
    const method = String(request.method || 'get').trim().toLowerCase();
    const url = combineApplicationUrl(baseUrl, request.url, request.params);
    const headers = createHeaders(defaultHeaders);
    createHeaders(request.headers).forEach((value, key) => headers.set(key, value));
    const cancellation = createRequestCancellation({
      signal: request.signal,
      timeoutMs: request.timeout ?? defaultTimeoutMs,
      timers
    });

    const body = METHODS_WITHOUT_BODY.has(method)
      ? undefined
      : createRequestBody(request.data, headers);

    try {
      let response;
      try {
        response = await executeFetch(url, {
          method: method.toUpperCase(),
          headers,
          body,
          credentials,
          cache: request.fetchCache || 'no-store',
          redirect: request.redirect || 'follow',
          signal: cancellation.signal
        });
      } catch (error) {
        if (cancellation.didTimeout()) throw createTimeoutError(request.timeout ?? defaultTimeoutMs, error);
        if (cancellation.signal.aborted || request.signal?.aborted || error?.name === 'AbortError') {
          throw createAbortError(error);
        }
        throw createHttpTransportError({
          message: 'Network request failed.',
          code: 'NETWORK_ERROR',
          cause: error
        });
      }

      let data;
      try {
        data = await parseResponseBody(response, request.responseType);
      } catch (error) {
        if (error?.name === 'HttpTransportError') throw error;
        throw createHttpTransportError({
          message: 'Response body could not be read.',
          code: 'RESPONSE_READ_ERROR',
          status: response.status,
          headers: response.headers,
          cause: error
        });
      }

      if (!response.ok) {
        throw createHttpTransportError({
          message: `HTTP ${response.status}`,
          code: 'HTTP_ERROR',
          status: response.status,
          data,
          headers: response.headers
        });
      }

      return {
        data,
        status: response.status,
        headers: response.headers,
        url
      };
    } finally {
      cancellation.cleanup();
    }
  };
};
