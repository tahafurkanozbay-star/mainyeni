import { AppError } from '../errors/appError';
import {
  createHttpResponseError,
  createResponseMetadata,
  normalizeFetchFailure,
  parseResponseBody,
  type ResponseLike
} from './responseParser.ts';
import {
  joinApplicationUrl,
  normalizeRequestConfig,
  serializeRequestBody
} from './requestPolicy.ts';
import {
  type NormalizedRequestConfig,
  type RawRequestConfig,
  type RuntimeDefaults,
  type Transport,
  type TransportResult
} from './contracts';

const DEFAULT_FETCH_CREDENTIALS: RequestCredentials = 'same-origin';
const DEFAULT_FETCH_CACHE: RequestCache = 'no-store';
const DEFAULT_REDIRECT: RequestRedirect = 'follow';

interface LinkedAbortScopeOptions {
  signal?: AbortSignal | null;
  timeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface LinkedAbortScope {
  readonly signal: AbortSignal;
  abort(): void;
  dispose(): void;
  isTimedOut(): boolean;
  isParentAborted(): boolean;
}

interface FetchDependencies {
  defaults?: RuntimeDefaults;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  onStart?: (event: { method: string; url: string; timeout: number }) => void;
  onSuccess?: (event: {
    method: string;
    url: string;
    durationMs: number;
    status: number;
    metadata: Readonly<Record<string, unknown>>;
  }) => void;
  onFailure?: (event: {
    method: string;
    url: string;
    durationMs: number;
    status?: number | null;
    error: unknown;
  }) => void;
}

interface FetchTransportOptions extends RuntimeDefaults, Omit<FetchDependencies, 'defaults'> {}

const createAbortController = (): AbortController => {
  if (typeof AbortController === 'undefined') {
    throw new AppError('AbortController is required by the network runtime.', {
      code: 'ABORT_CONTROLLER_UNAVAILABLE',
      retryable: false
    });
  }
  return new AbortController();
};

export const createLinkedAbortScope = (
  options: LinkedAbortScopeOptions = {}
): LinkedAbortScope => {
  const controller = createAbortController();
  const parentSignal = options.signal;
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let parentAborted = false;
  let disposed = false;

  const abortFromParent = () => {
    if (disposed || controller.signal.aborted) return;
    parentAborted = true;
    controller.abort();
  };

  if (parentSignal?.aborted) {
    parentAborted = true;
    controller.abort();
  } else if (parentSignal) {
    parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  if (!controller.signal.aborted && timeoutMs > 0) {
    timeoutId = setTimer(() => {
      if (disposed || controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;

    if (timeoutId !== null) {
      clearTimer(timeoutId);
      timeoutId = null;
    }

    if (parentSignal) {
      parentSignal.removeEventListener('abort', abortFromParent);
    }
  };

  return Object.freeze({
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose,
    isTimedOut: () => timedOut,
    isParentAborted: () => parentAborted
  });
};

export const buildFetchOptions = (
  config: NormalizedRequestConfig,
  bodyResult: { body: unknown; headers: Record<string, string> }
): RequestInit => {
  const options: RequestInit = {
    method: config.method.toUpperCase(),
    headers: bodyResult.headers,
    signal: config.signal || undefined,
    credentials: (config.credentials as RequestCredentials | undefined) || DEFAULT_FETCH_CREDENTIALS,
    cache: (config.fetchCache as RequestCache | undefined) || DEFAULT_FETCH_CACHE,
    redirect: (config.redirect as RequestRedirect | undefined) || DEFAULT_REDIRECT
  };

  if (bodyResult.body !== undefined) options.body = bodyResult.body as BodyInit;
  if (config.integrity) options.integrity = String(config.integrity);
  if (config.keepalive === true) options.keepalive = true;
  return options;
};

const assertFetchRuntime = (fetchImpl: unknown): asserts fetchImpl is typeof fetch => {
  if (typeof fetchImpl !== 'function') {
    throw new AppError('Fetch API is unavailable.', {
      code: 'FETCH_UNAVAILABLE',
      retryable: false
    });
  }
};

const now = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
};

export const executeFetch = async <T = unknown>(
  rawConfig: RawRequestConfig,
  dependencies: FetchDependencies = {}
): Promise<TransportResult<T>> => {
  const defaults = dependencies.defaults || {};
  const config = normalizeRequestConfig(rawConfig, defaults);
  const fetchImpl = dependencies.fetchImpl || (
    typeof fetch === 'function' ? fetch : undefined
  );
  assertFetchRuntime(fetchImpl);

  const clock = dependencies.clock || Date.now;
  const startedAt = now(clock);
  const url = joinApplicationUrl(
    dependencies.baseUrl || defaults.baseUrl || '/api',
    config.url,
    config.params as Record<string, unknown> | URLSearchParams | undefined
  );

  const bodyResult = serializeRequestBody(
    config.method,
    config.data,
    config.headers
  );

  const linked = createLinkedAbortScope({
    signal: config.signal,
    timeoutMs: config.timeout,
    setTimeout: dependencies.setTimeout,
    clearTimeout: dependencies.clearTimeout
  });

  const fetchOptions = buildFetchOptions(
    { ...config, signal: linked.signal },
    bodyResult
  );

  dependencies.onStart?.({ method: config.method, url, timeout: config.timeout });

  try {
    const response = await fetchImpl(url, fetchOptions);
    const durationMs = Math.max(0, now(clock) - startedAt);

    if (!response || typeof response !== 'object') {
      throw new AppError('Fetch returned an invalid response.', {
        code: 'INVALID_FETCH_RESPONSE',
        retryable: true
      });
    }

    if (response.ok !== true) {
      const error = await createHttpResponseError(response as unknown as ResponseLike, {
        method: config.method,
        responseType: String(config.responseType || 'auto')
      });

      dependencies.onFailure?.({
        method: config.method,
        url,
        durationMs,
        status: response.status,
        error
      });
      throw error;
    }

    const data = await parseResponseBody(response as unknown as ResponseLike, {
      method: config.method,
      responseType: String(config.responseType || 'auto')
    }) as T;

    const metadata = createResponseMetadata(response as unknown as ResponseLike, {
      method: config.method,
      url,
      includeHeaders: config.includeResponseHeaders === true
    });

    dependencies.onSuccess?.({
      method: config.method,
      url,
      durationMs,
      status: response.status,
      metadata
    });

    return Object.freeze({
      data,
      status: Number(response.status) || 0,
      statusText: String(response.statusText || ''),
      headers: response.headers || null,
      metadata,
      durationMs
    });
  } catch (error) {
    const normalized = normalizeFetchFailure(error, {
      timedOut: linked.isTimedOut(),
      aborted: linked.isParentAborted() || config.signal?.aborted === true
    });

    if (normalized !== error) {
      dependencies.onFailure?.({
        method: config.method,
        url,
        durationMs: Math.max(0, now(clock) - startedAt),
        status: Number((normalized as { status?: unknown }).status) || null,
        error: normalized
      });
    }

    throw normalized;
  } finally {
    linked.dispose();
  }
};

export const createFetchTransport = (options: FetchTransportOptions = {}): Transport => {
  const defaults = Object.freeze({
    baseUrl: options.baseUrl || '/api',
    timeoutMs: options.timeoutMs || 15000,
    maxRetries: options.maxRetries || 0,
    cacheTtlMs: options.cacheTtlMs || 0
  });

  const dependencies: FetchDependencies = {
    defaults,
    baseUrl: defaults.baseUrl,
    fetchImpl: options.fetchImpl,
    clock: options.clock,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    onStart: options.onStart,
    onSuccess: options.onSuccess,
    onFailure: options.onFailure
  };

  const request = <T = unknown>(config: RawRequestConfig = {}) => executeFetch<T>(config, dependencies);

  return Object.freeze({
    defaults,
    request,
    get: (url: string, config: RawRequestConfig = {}) => request({ ...config, url, method: 'get' }),
    head: (url: string, config: RawRequestConfig = {}) => request({ ...config, url, method: 'head' }),
    post: (url: string, data: unknown, config: RawRequestConfig = {}) => request({ ...config, url, data, method: 'post' }),
    put: (url: string, data: unknown, config: RawRequestConfig = {}) => request({ ...config, url, data, method: 'put' }),
    patch: (url: string, data: unknown, config: RawRequestConfig = {}) => request({ ...config, url, data, method: 'patch' }),
    delete: (url: string, config: RawRequestConfig = {}) => request({ ...config, url, method: 'delete' })
  }) as Transport;
};

export const FetchTransport = Object.freeze({
  createLinkedAbortScope,
  buildFetchOptions,
  executeFetch,
  createFetchTransport
});
