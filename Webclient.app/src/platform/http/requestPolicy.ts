import { AppError } from '../errors/appError';
import { normalizeApplicationPath } from '../network/endpointPolicy';
import {
  type NormalizedRequestConfig,
  type QueryParams,
  type RawRequestConfig,
  type RequestBody,
  type RuntimeDefaults,
  isPlainRecord
} from './contracts';

export const SAFE_HTTP_METHODS = Object.freeze(['get', 'head'] as const);
export const IDEMPOTENT_HTTP_METHODS = Object.freeze(['get', 'head', 'put', 'delete', 'options'] as const);
export const BODYLESS_HTTP_METHODS = Object.freeze(['get', 'head'] as const);
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

export interface SerializedBodyResult {
  body: unknown;
  headers: Record<string, string>;
}

export const normalizeMethod = (value: unknown = 'get'): string => {
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

export const isSafeMethod = (method: unknown): boolean =>
  SAFE_HTTP_METHODS.includes(normalizeMethod(method) as typeof SAFE_HTTP_METHODS[number]);

export const isIdempotentMethod = (method: unknown): boolean =>
  IDEMPOTENT_HTTP_METHODS.includes(normalizeMethod(method) as typeof IDEMPOTENT_HTTP_METHODS[number]);

export const methodAllowsBody = (method: unknown): boolean =>
  !BODYLESS_HTTP_METHODS.includes(normalizeMethod(method) as typeof BODYLESS_HTTP_METHODS[number]);

export const normalizeHeaderName = (name: unknown): string =>
  String(name || '').trim().toLowerCase();

export const assertSafeHeaderName = (name: unknown): string => {
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

const normalizeHeaderValue = (value: unknown): string => {
  const normalized = String(value ?? '').trim();
  if (/[\r\n\0]/.test(normalized)) {
    throw new AppError('Request header value contains invalid control characters.', {
      code: 'INVALID_REQUEST_HEADER',
      retryable: false
    });
  }
  return normalized;
};

export const sanitizeRequestHeaders = (
  headers: Headers | Record<string, unknown> | null | undefined = {}
): Record<string, string> => {
  if (headers === null || headers === undefined) {
    return { Accept: DEFAULT_ACCEPT_HEADER };
  }

  const isHeadersInstance = typeof Headers !== 'undefined' && headers instanceof Headers;
  const entries: Array<[string, unknown]> = isHeadersInstance
    ? Array.from((headers as Headers).entries())
    : Object.entries(headers);

  const result: Record<string, string> = {};
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

export const hasSensitiveRequestMetadata = (value: unknown, depth = 0): boolean => {
  if (depth > 4 || value === null || value === undefined) return false;

  if (Array.isArray(value)) {
    return value.some((item) => hasSensitiveRequestMetadata(item, depth + 1));
  }

  if (typeof value !== 'object') return false;

  return Object.keys(value).some((key) =>
    SECRET_KEY_PATTERN.test(key) ||
    hasSensitiveRequestMetadata((value as Record<string, unknown>)[key], depth + 1));
};

const appendQueryValue = (searchParams: URLSearchParams, key: string, value: unknown): void => {
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

export const serializeQueryParams = (params?: QueryParams | Record<string, unknown> | null): string => {
  if (!params) return '';
  if (params instanceof URLSearchParams) return params.toString();
  if (!isPlainRecord(params)) {
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

export const joinApplicationUrl = (
  baseUrl: unknown,
  path: unknown,
  params?: QueryParams | Record<string, unknown>
): string => {
  const normalizedBase = normalizeApplicationPath(baseUrl || '/api').replace(/\/$/, '');
  const normalizedPath = normalizeApplicationPath(path || '/');

  let pathname: string;
  if (normalizedBase === '/') pathname = normalizedPath;
  else if (normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`)) {
    pathname = normalizedPath;
  } else {
    pathname = `${normalizedBase}${normalizedPath}`.replace(/\/{2,}/g, '/');
  }

  const query = serializeQueryParams(params);
  return query ? `${pathname}${pathname.includes('?') ? '&' : '?'}${query}` : pathname;
};

const isFormData = (value: unknown): value is FormData =>
  typeof FormData !== 'undefined' && value instanceof FormData;

const isBlob = (value: unknown): value is Blob =>
  typeof Blob !== 'undefined' && value instanceof Blob;

const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer;

const isUrlSearchParams = (value: unknown): value is URLSearchParams =>
  typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams;

export type RequestBodyKind =
  | 'none'
  | 'text'
  | 'form-data'
  | 'blob'
  | 'array-buffer'
  | 'url-search-params'
  | 'json'
  | 'unsupported';

export const classifyRequestBody = (value: unknown): RequestBodyKind => {
  if (value === undefined || value === null) return 'none';
  if (typeof value === 'string') return 'text';
  if (isFormData(value)) return 'form-data';
  if (isBlob(value)) return 'blob';
  if (isArrayBuffer(value)) return 'array-buffer';
  if (isUrlSearchParams(value)) return 'url-search-params';
  if (isPlainRecord(value) || Array.isArray(value) || typeof value === 'number' || typeof value === 'boolean') {
    return 'json';
  }
  return 'unsupported';
};

const headerExists = (headers: Record<string, string>, target: string): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === target.toLowerCase());

const withContentType = (
  headers: Record<string, string>,
  contentType: string
): Record<string, string> => {
  if (!contentType || headerExists(headers, 'content-type')) return headers;
  return { ...headers, 'Content-Type': contentType };
};

export const serializeRequestBody = (
  method: unknown,
  data: RequestBody | unknown,
  headers: Record<string, string> = {}
): SerializedBodyResult => {
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

export const stableSerialize = (value: unknown, seen = new WeakSet<object>()): string => {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    return JSON.stringify(value) ?? '';
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

  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`;
  } else {
    const record = value as Record<string, unknown>;
    result = `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`)
      .join(',')}}`;
  }

  seen.delete(value);
  return result;
};

export const createRequestKey = (config: Partial<RawRequestConfig> = {}): string => {
  const method = normalizeMethod(config.method);
  const url = normalizeApplicationPath(config.url || '/');
  const query = serializeQueryParams(config.params as QueryParams | Record<string, unknown> | undefined);
  return [method, url, query].join('|');
};

const finiteClamped = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  integerMode: 'round' | 'floor' = 'round'
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = integerMode === 'floor' ? Math.floor(parsed) : Math.round(parsed);
  return Math.max(minimum, Math.min(maximum, normalized));
};

export const normalizeRequestConfig = (
  config: RawRequestConfig = {},
  defaults: RuntimeDefaults = {}
): NormalizedRequestConfig => {
  if (!isPlainRecord(config)) {
    throw new AppError('Request configuration must be an object.', {
      code: 'INVALID_REQUEST_CONFIG',
      retryable: false
    });
  }

  const method = normalizeMethod(config.method || 'get');
  const url = normalizeApplicationPath(config.url || '/');
  const headers = sanitizeRequestHeaders(config.headers as Headers | Record<string, unknown> | undefined);
  const timeout = finiteClamped(config.timeout ?? defaults.timeoutMs, 15000, 1, 60000);
  const maxRetries = finiteClamped(config.maxRetries ?? defaults.maxRetries, 0, 0, 4, 'floor');

  const safeMethod = isSafeMethod(method);
  const idempotentMethod = isIdempotentMethod(method);
  const containsSensitiveMetadata =
    hasSensitiveRequestMetadata(config.params) ||
    hasSensitiveRequestMetadata(config.data);

  const cache = config.cache === true && safeMethod && !containsSensitiveMetadata;
  const dedupe = config.dedupe === true && safeMethod && !config.signal && !containsSensitiveMetadata;
  const retryAllowed = idempotentMethod || config.retryUnsafe === true;
  const cacheTtlCandidate = Number(config.cacheTtlMs ?? defaults.cacheTtlMs ?? 0);

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
    cacheTtlMs: Number.isFinite(cacheTtlCandidate) ? Math.max(0, cacheTtlCandidate) : 0
  }) as NormalizedRequestConfig;
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
