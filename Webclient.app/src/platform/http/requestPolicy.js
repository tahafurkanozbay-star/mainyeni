import { AppError } from '../errors/appError';
import { normalizeApplicationPath } from '../network/endpointPolicy';

export const SAFE_HTTP_METHODS = Object.freeze(['get', 'head']);
export const IDEMPOTENT_HTTP_METHODS = Object.freeze(['get', 'head', 'put', 'delete', 'options']);
export const BODYLESS_HTTP_METHODS = Object.freeze(['get', 'head']);
export const DEFAULT_ACCEPT_HEADER = 'application/json';

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-client-key',
  'x-client-secret',
  'x-secret',
  'x-access-token'
]);

const MANAGED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'origin',
  'referer'
]);

const SECRET_KEY_PATTERN = /(password|passwd|secret|token|credential|authorization|cookie|api[-_]?key|client[-_]?key)/i;

const isPlainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export const normalizeMethod = (value = 'get') => {
  const method = String(value || 'get').trim().toLowerCase();
  if (!/^[a-z]+$/.test(method)) {
    throw new AppError('HTTP method is invalid.', {
      code: 'INVALID_HTTP_METHOD',
      retryable: false,
      details: { method: String(value || '') }
    });
  }
  return method;
};

export const isSafeMethod = (method) => SAFE_HTTP_METHODS.includes(normalizeMethod(method));

export const isIdempotentMethod = (method) =>
  IDEMPOTENT_HTTP_METHODS.includes(normalizeMethod(method));

export const methodAllowsBody = (method) =>
  !BODYLESS_HTTP_METHODS.includes(normalizeMethod(method));

export const normalizeHeaderName = (name) => String(name || '').trim().toLowerCase();

export const assertSafeHeaderName = (name) => {
  const normalized = normalizeHeaderName(name);
  if (!normalized || !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(normalized)) {
    throw new AppError('Request header name is invalid.', {
      code: 'INVALID_REQUEST_HEADER',
      retryable: false
    });
  }
  if (FORBIDDEN_REQUEST_HEADERS.has(normalized)) {
    throw new AppError('Privileged browser request header is blocked.', {
      code: 'PRIVILEGED_HEADER_BLOCKED',
      retryable: false,
      details: { header: normalized }
    });
  }
  if (MANAGED_REQUEST_HEADERS.has(normalized)) {
    throw new AppError('Browser-managed request header is blocked.', {
      code: 'MANAGED_HEADER_BLOCKED',
      retryable: false,
      details: { header: normalized }
    });
  }
  return normalized;
};

const normalizeHeaderValue = (value) => {
  const normalized = String(value ?? '').trim();
  if (/[\r\n\0]/.test(normalized)) {
    throw new AppError('Request header value contains invalid control characters.', {
      code: 'INVALID_REQUEST_HEADER',
      retryable: false
    });
  }
  return normalized;
};

export const sanitizeRequestHeaders = (headers = {}) => {
  if (headers === null || headers === undefined) {
    return { Accept: DEFAULT_ACCEPT_HEADER };
  }

  const isHeadersInstance = typeof Headers !== 'undefined' && headers instanceof Headers;
  const entries = isHeadersInstance
    ? Array.from(headers.entries())
    : Object.entries(headers);

  const result = {};
  let hasAccept = false;

  entries.forEach(([name, value]) => {
    const normalizedName = assertSafeHeaderName(name);
    if (value === null || value === undefined) return;

    const normalizedValue = normalizeHeaderValue(value);
    if (!normalizedValue) return;

    if (normalizedName === 'accept') hasAccept = true;
    result[name] = normalizedValue;
  });

  if (!hasAccept) result.Accept = DEFAULT_ACCEPT_HEADER;
  return result;
};

export const hasSensitiveRequestMetadata = (value, depth = 0) => {
  if (depth > 4 || value === null || value === undefined) return false;

  if (Array.isArray(value)) {
    return value.some((item) => hasSensitiveRequestMetadata(item, depth + 1));
  }

  if (typeof value !== 'object') return false;

  return Object.keys(value).some((key) =>
    SECRET_KEY_PATTERN.test(key) ||
    hasSensitiveRequestMetadata(value[key], depth + 1));
};

const appendQueryValue = (searchParams, key, value) => {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.forEach((item) => appendQueryValue(searchParams, key, item));
    return;
  }

  if (value instanceof Date) {
    searchParams.append(key, value.toISOString());
    return;
  }

  if (typeof value === 'object') {
    searchParams.append(key, JSON.stringify(value));
    return;
  }

  searchParams.append(key, String(value));
};

export const serializeQueryParams = (params) => {
  if (!params) return '';
  if (params instanceof URLSearchParams) return params.toString();
  if (!isPlainObject(params)) {
    throw new AppError('Request query parameters must be a plain object.', {
      code: 'INVALID_QUERY_PARAMS',
      retryable: false
    });
  }

  const searchParams = new URLSearchParams();
  Object.keys(params)
    .sort()
    .forEach((key) => appendQueryValue(searchParams, key, params[key]));

  return searchParams.toString();
};

export const joinApplicationUrl = (baseUrl, path, params) => {
  const normalizedBase = normalizeApplicationPath(baseUrl || '/api').replace(/\/$/, '');
  const normalizedPath = normalizeApplicationPath(path || '/');

  let pathname;
  if (normalizedBase === '/') pathname = normalizedPath;
  else if (normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`)) {
    pathname = normalizedPath;
  } else {
    pathname = `${normalizedBase}${normalizedPath}`.replace(/\/{2,}/g, '/');
  }

  const query = serializeQueryParams(params);
  return query ? `${pathname}${pathname.includes('?') ? '&' : '?'}${query}` : pathname;
};

const isFormData = (value) =>
  typeof FormData !== 'undefined' && value instanceof FormData;

const isBlob = (value) =>
  typeof Blob !== 'undefined' && value instanceof Blob;

const isArrayBuffer = (value) =>
  typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer;

const isUrlSearchParams = (value) =>
  typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams;

export const classifyRequestBody = (value) => {
  if (value === undefined || value === null) return 'none';
  if (typeof value === 'string') return 'text';
  if (isFormData(value)) return 'form-data';
  if (isBlob(value)) return 'blob';
  if (isArrayBuffer(value)) return 'array-buffer';
  if (isUrlSearchParams(value)) return 'url-search-params';
  if (isPlainObject(value) || Array.isArray(value) || typeof value === 'number' || typeof value === 'boolean') {
    return 'json';
  }
  return 'unsupported';
};

const headerExists = (headers, target) =>
  Object.keys(headers).some((key) => key.toLowerCase() === target.toLowerCase());

const withContentType = (headers, contentType) => {
  if (!contentType || headerExists(headers, 'content-type')) return headers;
  return { ...headers, 'Content-Type': contentType };
};

export const serializeRequestBody = (method, data, headers = {}) => {
  const normalizedMethod = normalizeMethod(method);
  if (!methodAllowsBody(normalizedMethod)) {
    if (data !== undefined && data !== null) {
      throw new AppError('GET/HEAD requests cannot include a request body.', {
        code: 'BODY_NOT_ALLOWED',
        retryable: false,
        details: { method: normalizedMethod }
      });
    }
    return { body: undefined, headers };
  }

  const type = classifyRequestBody(data);
  if (type === 'none') return { body: undefined, headers };
  if (type === 'text') {
    return { body: data, headers: withContentType(headers, 'text/plain;charset=UTF-8') };
  }
  if (type === 'form-data' || type === 'blob' || type === 'array-buffer') {
    return { body: data, headers };
  }
  if (type === 'url-search-params') {
    return {
      body: data,
      headers: withContentType(headers, 'application/x-www-form-urlencoded;charset=UTF-8')
    };
  }
  if (type === 'json') {
    try {
      return {
        body: JSON.stringify(data),
        headers: withContentType(headers, 'application/json;charset=UTF-8')
      };
    } catch (error) {
      throw new AppError('Request body could not be serialized.', {
        code: 'REQUEST_SERIALIZATION_FAILED',
        retryable: false,
        cause: error
      });
    }
  }

  throw new AppError('Request body type is not supported.', {
    code: 'UNSUPPORTED_REQUEST_BODY',
    retryable: false,
    details: { type: Object.prototype.toString.call(data) }
  });
};

export const stableSerialize = (value, seen = new WeakSet()) => {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    return JSON.stringify(value);
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
    return JSON.stringify(value.toString());
  }

  if (seen.has(value)) {
    throw new AppError('Circular request metadata cannot be serialized.', {
      code: 'CIRCULAR_REQUEST_METADATA',
      retryable: false
    });
  }
  seen.add(value);

  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`;
  } else {
    result = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`)
      .join(',')}}`;
  }

  seen.delete(value);
  return result;
};

export const createRequestKey = (config = {}) => {
  const method = normalizeMethod(config.method);
  const url = normalizeApplicationPath(config.url || '/');
  const query = serializeQueryParams(config.params);
  return [method, url, query].join('|');
};

export const normalizeRequestConfig = (config = {}, defaults = {}) => {
  if (!isPlainObject(config)) {
    throw new AppError('Request configuration must be an object.', {
      code: 'INVALID_REQUEST_CONFIG',
      retryable: false
    });
  }

  const method = normalizeMethod(config.method || 'get');
  const url = normalizeApplicationPath(config.url || '/');
  const headers = sanitizeRequestHeaders(config.headers);
  const timeoutCandidate = Number(config.timeout ?? defaults.timeoutMs ?? 15000);
  const timeout = Number.isFinite(timeoutCandidate)
    ? Math.max(1, Math.min(60000, Math.round(timeoutCandidate)))
    : 15000;
  const maxRetriesCandidate = Number(config.maxRetries ?? defaults.maxRetries ?? 0);
  const maxRetries = Number.isFinite(maxRetriesCandidate)
    ? Math.max(0, Math.min(4, Math.floor(maxRetriesCandidate)))
    : 0;

  const safeMethod = isSafeMethod(method);
  const idempotentMethod = isIdempotentMethod(method);
  const containsSensitiveMetadata =
    hasSensitiveRequestMetadata(config.params) ||
    hasSensitiveRequestMetadata(config.data);

  const cache = config.cache === true && safeMethod && !containsSensitiveMetadata;
  const dedupe = config.dedupe === true && safeMethod && !config.signal && !containsSensitiveMetadata;
  const retryAllowed = idempotentMethod || config.retryUnsafe === true;

  return Object.freeze({
    ...config,
    method,
    url,
    headers,
    timeout,
    maxRetries,
    cache,
    dedupe,
    retryAllowed,
    safeMethod,
    idempotentMethod,
    containsSensitiveMetadata,
    cacheTtlMs: Math.max(0, Number(config.cacheTtlMs ?? defaults.cacheTtlMs ?? 0) || 0)
  });
};

export const RequestPolicy = Object.freeze({
  normalizeMethod,
  isSafeMethod,
  isIdempotentMethod,
  methodAllowsBody,
  sanitizeRequestHeaders,
  serializeQueryParams,
  joinApplicationUrl,
  classifyRequestBody,
  serializeRequestBody,
  stableSerialize,
  createRequestKey,
  normalizeRequestConfig,
  hasSensitiveRequestMetadata
});
