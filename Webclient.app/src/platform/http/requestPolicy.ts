import { AppError } from '../errors/appError';
import { normalizeApplicationPath } from '../network/endpointPolicy';
import { isPlainRecord } from './contracts';
import {
  assertWithinByteBudget,
  normalizeByteBudget,
  utf8ByteLength,
} from './byteBudget';
import type {
  NormalizedRequestConfig,
  QueryParams,
  RawRequestConfig,
  RequestBody,
  RuntimeDefaults
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

export interface SerializeRequestBodyOptions {
  readonly maxBodyBytes?: number;
}

const REQUEST_BODY_BOUNDS = Object.freeze({
  fallback: 4 * 1024 * 1024,
  minimum: 1024,
  maximum: 32 * 1024 * 1024,
});

const requestBodyTooLarge = (
  actualBytes: number,
  limitBytes: number,
): AppError => new AppError('İstek gövdesi izin verilen boyutu aşıyor.', {
  code: 'REQUEST_BODY_TOO_LARGE',
  retryable: false,
  details: {
    actualBytes,
    limitBytes,
  },
});

const assertRequestBodyBudget = (
  actualBytes: number,
  limitBytes: number,
): void => {
  assertWithinByteBudget(actualBytes, limitBytes, (snapshot) =>
    requestBodyTooLarge(snapshot.actualBytes, snapshot.limitBytes));
};

const estimateFormDataBytes = (
  value: FormData,
  limitBytes: number,
): number => {
  let bytes = 0;
  let fields = 0;
  value.forEach((entry, key) => {
    fields += 1;
    if (fields > 1024) {
      throw new AppError('FormData alan sayısı izin verilen sınırı aşıyor.', {
        code: 'REQUEST_BODY_TOO_LARGE',
        retryable: false,
        details: { maximumFields: 1024 },
      });
    }

    // Multipart boundary/header overhead varies by browser. A conservative
    // fixed allowance per field keeps the estimate fail-closed without
    // materializing the complete multipart payload in memory.
    bytes += utf8ByteLength(key) + 256;
    if (typeof entry === 'string') {
      bytes += utf8ByteLength(entry);
    } else {
      bytes += Math.max(0, Math.floor(entry.size));
      const named = entry as Blob & { readonly name?: string };
      if (typeof named.name === 'string') bytes += utf8ByteLength(named.name);
      if (entry.type) bytes += utf8ByteLength(entry.type);
    }
    assertRequestBodyBudget(bytes, limitBytes);
  });
  return bytes;
};

export const requestBodyByteLength = (
  value: unknown,
  kind: RequestBodyKind = classifyRequestBody(value),
): number | null => {
  if (kind === 'none') return 0;
  if (kind === 'text') return utf8ByteLength(value as string);
  if (kind === 'blob') return Math.max(0, Math.floor((value as Blob).size));
  if (kind === 'array-buffer') return (value as ArrayBuffer).byteLength;
  if (kind === 'url-search-params') return utf8ByteLength((value as URLSearchParams).toString());
  if (kind === 'form-data') return null;
  return null;
};

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
  headers: Record<string, string> = {},
  options: SerializeRequestBodyOptions = {},
): SerializedBodyResult => {
  const maxBodyBytes = normalizeByteBudget(options.maxBodyBytes, REQUEST_BODY_BOUNDS);
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
    assertRequestBodyBudget(utf8ByteLength(data as string), maxBodyBytes);
    return { body: data, headers: withContentType(headers, 'text/plain;charset=UTF-8') };
  }
  if (type === 'form-data') {
    estimateFormDataBytes(data as FormData, maxBodyBytes);
    return { body: data, headers };
  }
  if (type === 'blob') {
    assertRequestBodyBudget((data as Blob).size, maxBodyBytes);
    return { body: data, headers };
  }
  if (type === 'array-buffer') {
    assertRequestBodyBudget((data as ArrayBuffer).byteLength, maxBodyBytes);
    return { body: data, headers };
  }
  if (type === 'url-search-params') {
    assertRequestBodyBudget(
      utf8ByteLength((data as URLSearchParams).toString()),
      maxBodyBytes,
    );
    return {
      body: data,
      headers: withContentType(headers, 'application/x-www-form-urlencoded;charset=UTF-8')
    };
  }
  if (type === 'json') {
    try {
      const body = JSON.stringify(data);
      assertRequestBodyBudget(utf8ByteLength(body), maxBodyBytes);
      return {
        body,
        headers: withContentType(headers, 'application/json;charset=UTF-8')
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
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


const CACHE_CLASSIFICATIONS = new Set(['public', 'internal', 'personal', 'sensitive']);

export const normalizeCacheClassification = (
  value: unknown
): 'public' | 'internal' | 'personal' | 'sensitive' => {
  const normalized = String(value ?? 'internal').trim().toLowerCase();
  if (!CACHE_CLASSIFICATIONS.has(normalized)) {
    throw new AppError('Cache data classification is invalid.', {
      code: 'INVALID_CACHE_CLASSIFICATION',
      retryable: false
    });
  }
  return normalized as 'public' | 'internal' | 'personal' | 'sensitive';
};

export const normalizeCacheNamespace = (value: unknown): string => {
  const normalized = String(value ?? 'http').trim().toLowerCase();
  if (!normalized || normalized.length > 96 || !/^[a-z0-9._:-]+$/.test(normalized)) {
    throw new AppError('Cache namespace is invalid.', {
      code: 'INVALID_CACHE_NAMESPACE',
      retryable: false
    });
  }
  return normalized;
};

export const normalizeCacheTags = (value: unknown): readonly string[] => {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 16) {
    throw new AppError('Cache tags must be a bounded array.', {
      code: 'INVALID_CACHE_TAGS',
      retryable: false
    });
  }

  const tags = new Set<string>();
  for (const item of value) {
    const tag = String(item ?? '').trim();
    if (!tag || tag.length > 128 || /[\u0000-\u001f\u007f]/.test(tag)) {
      throw new AppError('Cache tag is invalid.', {
        code: 'INVALID_CACHE_TAGS',
        retryable: false
      });
    }
    tags.add(tag);
  }
  return Object.freeze([...tags]);
};

export const normalizeCacheVary = (
  value: unknown
): Readonly<Record<string, string | number | boolean | null | undefined>> => {
  if (value === undefined || value === null) return Object.freeze({});
  if (!isPlainRecord(value)) {
    throw new AppError('Cache vary metadata must be a plain object.', {
      code: 'INVALID_CACHE_VARY',
      retryable: false
    });
  }

  const keys = Object.keys(value).sort();
  if (keys.length > 16) {
    throw new AppError('Cache vary metadata exceeds its bounded field count.', {
      code: 'INVALID_CACHE_VARY',
      retryable: false
    });
  }

  const result: Record<string, string | number | boolean | null | undefined> = {};
  for (const key of keys) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey || normalizedKey.length > 64 || !/^[a-z0-9._:-]+$/.test(normalizedKey)) {
      throw new AppError('Cache vary key is invalid.', {
        code: 'INVALID_CACHE_VARY',
        retryable: false
      });
    }
    const item = value[key];
    if (
      item !== null &&
      item !== undefined &&
      typeof item !== 'string' &&
      typeof item !== 'number' &&
      typeof item !== 'boolean'
    ) {
      throw new AppError('Cache vary value must be scalar.', {
        code: 'INVALID_CACHE_VARY',
        retryable: false
      });
    }
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new AppError('Cache vary number must be finite.', {
        code: 'INVALID_CACHE_VARY',
        retryable: false
      });
    }
    result[normalizedKey] = item;
  }
  return Object.freeze(result);
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
  const cacheClassification = normalizeCacheClassification(config.cacheClassification);
  const cacheNamespace = normalizeCacheNamespace(config.cacheNamespace);
  const cacheTags = normalizeCacheTags(config.cacheTags);
  const cacheVary = normalizeCacheVary(config.cacheVary);
  const retentionAllowed =
    cacheClassification === 'public' || cacheClassification === 'internal';

  const cache = config.cache === true
    && safeMethod
    && retentionAllowed
    && !containsSensitiveMetadata;
  // The governed flight registry owns subscriber cancellation, so an
  // AbortSignal no longer forces duplicate network work for otherwise safe
  // requests. Personal/sensitive payloads are still excluded from sharing.
  const dedupe = config.dedupe === true
    && safeMethod
    && retentionAllowed
    && !containsSensitiveMetadata;
  const retryAllowed = idempotentMethod || config.retryUnsafe === true;
  const cacheTtlMs = finiteClamped(
    config.cacheTtlMs ?? defaults.cacheTtlMs,
    0,
    0,
    60 * 60 * 1000,
    'floor'
  );
  const cacheStaleWhileRevalidateMs = finiteClamped(
    config.cacheStaleWhileRevalidateMs,
    0,
    0,
    10 * 60 * 1000,
    'floor'
  );
  const maxResponseBytes = normalizeByteBudget(config.maxResponseBytes, {
    fallback: 16 * 1024 * 1024,
    minimum: 1024,
    maximum: 64 * 1024 * 1024,
  });
  const maxRequestBodyBytes = normalizeByteBudget(config.maxRequestBodyBytes, REQUEST_BODY_BOUNDS);

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
    cacheTtlMs,
    cacheStaleWhileRevalidateMs,
    cacheClassification,
    cacheNamespace,
    cacheTags,
    cacheVary,
    maxResponseBytes,
    maxRequestBodyBytes
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
  requestBodyByteLength,
  serializeRequestBody,
  stableSerialize,
  createRequestKey,
  normalizeCacheClassification,
  normalizeCacheNamespace,
  normalizeCacheTags,
  normalizeCacheVary,
  normalizeRequestConfig,
  hasSensitiveRequestMetadata
});
