const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type HttpQueryPrimitive = string | number | boolean | null | undefined;

export interface HttpRequestOptions {
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit | null;
  readonly params?: Readonly<Record<string, HttpQueryPrimitive>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly credentials?: RequestCredentials;
}

export class HttpBusinessError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, data: unknown) {
    super(`HTTP ${status}`);
    this.name = 'HttpBusinessError';
    this.status = status;
    this.data = data;
  }
}

export class HttpBusinessTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`İstek ${timeoutMs} ms içinde tamamlanamadı.`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class HttpBusinessAbortError extends Error {
  constructor() {
    super('İstek iptal edildi.');
    this.name = 'AbortError';
  }
}

const boundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
};

export const appendHttpQuery = (
  url: string,
  params?: Readonly<Record<string, HttpQueryPrimitive>>,
): string => {
  if (!params) return url;

  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) searchParams.set(key, String(value));
  });

  const query = searchParams.toString();
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
};

const readBodyBytes = async (
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> => {
  const advertised = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(advertised) && advertised > maximumBytes) {
    throw new RangeError('HTTP response exceeded the configured byte budget.');
  }

  if (!response.body) {
    const bytes = new TextEncoder().encode(await response.text());
    if (bytes.byteLength > maximumBytes) {
      throw new RangeError('HTTP response exceeded the configured byte budget.');
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel('response-byte-budget-exceeded');
        throw new RangeError('HTTP response exceeded the configured byte budget.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const parseResponseData = async (
  response: Response,
  maximumBytes: number,
): Promise<unknown> => {
  const bytes = await readBodyBytes(response, maximumBytes);
  if (bytes.byteLength === 0) return null;

  const text = new TextDecoder().decode(bytes);
  if (!text) return null;

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const expectsJson = contentType.includes('application/json')
    || contentType.includes('+json');

  if (expectsJson || /^[\s]*[\[{]/u.test(text)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (expectsJson) {
        throw new TypeError('HTTP endpoint returned malformed JSON.');
      }
    }
  }
  return text;
};

interface RequestSignalHandle {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  dispose(): void;
}

const createRequestSignal = (
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestSignalHandle => {
  const controller = new AbortController();
  let timeoutTriggered = false;

  const abortFromParent = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason ?? new HttpBusinessAbortError());
    }
  };

  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  const timeoutId = globalThis.setTimeout(() => {
    if (controller.signal.aborted) return;
    timeoutTriggered = true;
    controller.abort(new HttpBusinessTimeoutError(timeoutMs));
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      globalThis.clearTimeout(timeoutId);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
};

export const requestData = async <TValue = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<TValue> => {
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    1_000,
    MAX_TIMEOUT_MS,
  );
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    1_024,
    MAX_RESPONSE_BYTES,
  );
  const request = createRequestSignal(options.signal, timeoutMs);

  try {
    const response = await fetch(
      appendHttpQuery(url, options.params),
      {
        method: options.method ?? 'GET',
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
        credentials: options.credentials ?? 'same-origin',
        signal: request.signal,
      },
    );
    const data = await parseResponseData(response, maxResponseBytes);

    if (!response.ok) throw new HttpBusinessError(response.status, data);
    return data as TValue;
  } catch (error) {
    if (request.timedOut()) throw new HttpBusinessTimeoutError(timeoutMs);
    if (options.signal?.aborted) {
      if (options.signal.reason instanceof Error) throw options.signal.reason;
      throw new HttpBusinessAbortError();
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new HttpBusinessAbortError();
    }
    throw error;
  } finally {
    request.dispose();
  }
};

export const HttpBusiness = Object.freeze({
  Get: <TValue = unknown>(
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<TValue> => requestData<TValue>(url, { ...options, method: 'GET' }),

  Post: <TValue = unknown>(
    url: string,
    data: unknown,
    options: HttpRequestOptions = {},
  ): Promise<TValue> => requestData<TValue>(url, {
    ...options,
    method: 'POST',
    body: options.body ?? JSON.stringify(data),
  }),
});
