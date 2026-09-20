import { apiClient } from '../platform/http/httpClient';
import {
  isPlainRecord,
  type RawRequestConfig,
  type RequestBody,
} from '../platform/http/contracts';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

export type HttpQueryParameters = Readonly<Record<string, unknown>>;

export interface HttpRequestOptions {
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: unknown;
  readonly params?: HttpQueryParameters;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly cache?: boolean;
  readonly dedupe?: boolean;
}

export class HttpRequestError extends Error {
  readonly status: number;
  readonly data: unknown;
  readonly url: string;

  constructor(status: number, data: unknown, url: string) {
    super(`HTTP ${status}`);
    this.name = 'HttpRequestError';
    this.status = status;
    this.data = data;
    this.url = url;
  }
}

export class HttpTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super('İstek zaman aşımına uğradı.');
    this.name = 'HttpTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class HttpAbortError extends Error {
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super('İstek iptal edildi.');
    this.name = 'AbortError';
    this.reason = reason;
  }
}

const normalizeTimeoutMs = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.trunc(numeric)));
};

const normalizeHeaders = (headers: HeadersInit): Headers => new Headers(headers);

const toRequestBody = (value: unknown): RequestBody => {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value;
  if (isPlainRecord(value)) return value;
  if (typeof FormData !== 'undefined' && value instanceof FormData) return value;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return value;
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return value;
  throw new TypeError('Unsupported HTTP request body.');
};

const toPlatformConfig = (options: HttpRequestOptions): RawRequestConfig => ({
  ...(options.headers === undefined ? {} : { headers: normalizeHeaders(options.headers) }),
  ...(options.params === undefined ? {} : { params: { ...options.params } }),
  ...(options.signal === undefined ? {} : { signal: options.signal }),
  timeout: normalizeTimeoutMs(options.timeoutMs),
  cache: options.cache === true,
  dedupe: options.dedupe ?? options.signal === undefined,
  maxRetries: 0,
  priority: 'high',
  schedulerGroup: 'business-api',
});

export const requestData = async <TResult = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<TResult> => {
  const method = String(options.method ?? 'GET').trim().toLowerCase();
  return apiClient.request<TResult>({
    ...toPlatformConfig(options),
    url,
    method,
    ...(options.body === undefined ? {} : { data: toRequestBody(options.body) }),
  });
};

type MethodlessOptions = Omit<HttpRequestOptions, 'method'>;

export const HttpBusiness = Object.freeze({
  Get: <TResult = unknown>(
    url: string,
    options: MethodlessOptions = {},
  ): Promise<TResult> => apiClient.get<TResult>(url, {
    ...toPlatformConfig(options),
    cache: options.cache === true,
    dedupe: options.dedupe ?? options.signal === undefined,
  }),

  Post: <TResult = unknown>(
    url: string,
    data: unknown,
    options: MethodlessOptions = {},
  ): Promise<TResult> => apiClient.post<TResult>(
    url,
    toRequestBody(data),
    {
      ...toPlatformConfig(options),
      cache: false,
      dedupe: false,
    },
  ),
});
