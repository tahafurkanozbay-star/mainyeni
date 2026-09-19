import { isAbortError } from './contracts';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;

export type HttpQueryParameters = Readonly<Record<string, unknown>>;

export interface HttpRequestOptions {
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit | null;
  readonly params?: HttpQueryParameters;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
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

const appendQuery = (url: string, params?: HttpQueryParameters): string => {
  if (!params) return url;

  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) searchParams.set(key, String(value));
  });

  const query = searchParams.toString();
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
};

const readResponseData = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

export const requestData = async <TResult = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<TResult> => {
  const method = options.method ?? 'GET';
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const requestUrl = appendQuery(url, options.params);
  const controller = new AbortController();
  let timedOut = false;

  const abortFromParent = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener('abort', abortFromParent, { once: true });

  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new HttpTimeoutError(timeoutMs));
  }, timeoutMs);

  const requestInit: RequestInit = {
    method,
    signal: controller.signal,
  };
  if (options.headers !== undefined) requestInit.headers = options.headers;
  if (options.body !== undefined) requestInit.body = options.body;

  try {
    const response = await fetch(requestUrl, requestInit);
    const data = await readResponseData(response);

    if (!response.ok) throw new HttpRequestError(response.status, data, requestUrl);
    return data as TResult;
  } catch (error) {
    if (timedOut) throw new HttpTimeoutError(timeoutMs);
    if (options.signal?.aborted || isAbortError(error)) {
      throw new HttpAbortError(options.signal?.reason);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', abortFromParent);
  }
};

type MethodlessOptions = Omit<HttpRequestOptions, 'method'>;

export const HttpBusiness = Object.freeze({
  Get: <TResult = unknown>(
    url: string,
    options: MethodlessOptions = {},
  ): Promise<TResult> => requestData<TResult>(url, { ...options, method: 'GET' }),

  Post: <TResult = unknown>(
    url: string,
    data: unknown,
    options: MethodlessOptions = {},
  ): Promise<TResult> => {
    const serialized = options.body ?? JSON.stringify(data);
    return requestData<TResult>(url, {
      ...options,
      method: 'POST',
      ...(serialized === undefined ? {} : { body: serialized }),
    });
  },
});
