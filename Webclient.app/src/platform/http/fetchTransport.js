import { AppError } from '../errors/appError';
import {
  createHttpResponseError,
  createResponseMetadata,
  normalizeFetchFailure,
  parseResponseBody
} from './responseParser';
import {
  joinApplicationUrl,
  normalizeRequestConfig,
  serializeRequestBody
} from './requestPolicy';

const DEFAULT_FETCH_CREDENTIALS = 'same-origin';
const DEFAULT_FETCH_CACHE = 'no-store';
const DEFAULT_REDIRECT = 'follow';

const createAbortController = () => {
  if (typeof AbortController === 'undefined') {
    throw new AppError('AbortController is required by the network runtime.', {
      code: 'ABORT_CONTROLLER_UNAVAILABLE',
      retryable: false
    });
  }
  return new AbortController();
};

export const createLinkedAbortScope = (options = {}) => {
  const controller = createAbortController();
  const parentSignal = options.signal;
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;

  let timeoutId = null;
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
  } else if (parentSignal && typeof parentSignal.addEventListener === 'function') {
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

    if (parentSignal && typeof parentSignal.removeEventListener === 'function') {
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

export const buildFetchOptions = (config, bodyResult) => {
  const options = {
    method: config.method.toUpperCase(),
    headers: bodyResult.headers,
    signal: config.signal,
    credentials: config.credentials || DEFAULT_FETCH_CREDENTIALS,
    cache: config.fetchCache || DEFAULT_FETCH_CACHE,
    redirect: config.redirect || DEFAULT_REDIRECT
  };

  if (bodyResult.body !== undefined) options.body = bodyResult.body;
  if (config.integrity) options.integrity = config.integrity;
  if (config.keepalive === true) options.keepalive = true;
  return options;
};

const assertFetchRuntime = (fetchImpl) => {
  if (typeof fetchImpl !== 'function') {
    throw new AppError('Fetch API is unavailable.', {
      code: 'FETCH_UNAVAILABLE',
      retryable: false
    });
  }
};

const now = (clock) => {
  const value = Number((clock || Date.now)());
  return Number.isFinite(value) ? value : Date.now();
};

export const executeFetch = async (rawConfig, dependencies = {}) => {
  const defaults = dependencies.defaults || {};
  const config = normalizeRequestConfig(rawConfig, defaults);
  const fetchImpl = dependencies.fetchImpl || (
    typeof fetch === 'function' ? fetch.bind(globalThis) : null
  );
  assertFetchRuntime(fetchImpl);

  const clock = dependencies.clock || Date.now;
  const startedAt = now(clock);
  const url = joinApplicationUrl(
    dependencies.baseUrl || defaults.baseUrl || '/api',
    config.url,
    config.params
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

  if (typeof dependencies.onStart === 'function') {
    dependencies.onStart({ method: config.method, url, timeout: config.timeout });
  }

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
      const error = await createHttpResponseError(response, {
        method: config.method,
        responseType: config.responseType
      });

      if (typeof dependencies.onFailure === 'function') {
        dependencies.onFailure({
          method: config.method,
          url,
          durationMs,
          status: response.status,
          error
        });
      }
      throw error;
    }

    const data = await parseResponseBody(response, {
      method: config.method,
      responseType: config.responseType
    });

    const metadata = createResponseMetadata(response, {
      method: config.method,
      url,
      includeHeaders: config.includeResponseHeaders === true
    });

    if (typeof dependencies.onSuccess === 'function') {
      dependencies.onSuccess({
        method: config.method,
        url,
        durationMs,
        status: response.status,
        metadata
      });
    }

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

    if (normalized !== error && typeof dependencies.onFailure === 'function') {
      dependencies.onFailure({
        method: config.method,
        url,
        durationMs: Math.max(0, now(clock) - startedAt),
        status: normalized.status,
        error: normalized
      });
    }

    throw normalized;
  } finally {
    linked.dispose();
  }
};

export const createFetchTransport = (options = {}) => {
  const defaults = Object.freeze({
    baseUrl: options.baseUrl || '/api',
    timeoutMs: options.timeoutMs || 15000,
    maxRetries: options.maxRetries || 0,
    cacheTtlMs: options.cacheTtlMs || 0
  });

  const dependencies = {
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

  const request = (config = {}) => executeFetch(config, dependencies);

  return Object.freeze({
    defaults,
    request,
    get: (url, config = {}) => request({ ...config, url, method: 'get' }),
    head: (url, config = {}) => request({ ...config, url, method: 'head' }),
    post: (url, data, config = {}) => request({ ...config, url, data, method: 'post' }),
    put: (url, data, config = {}) => request({ ...config, url, data, method: 'put' }),
    patch: (url, data, config = {}) => request({ ...config, url, data, method: 'patch' }),
    delete: (url, config = {}) => request({ ...config, url, method: 'delete' })
  });
};

export const FetchTransport = Object.freeze({
  createLinkedAbortScope,
  buildFetchOptions,
  executeFetch,
  createFetchTransport
});
