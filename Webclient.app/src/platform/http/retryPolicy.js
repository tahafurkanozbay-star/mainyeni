import { AppError, isAbortError } from '../errors/appError';

export const DEFAULT_RETRY_BASE_DELAY_MS = 250;
export const DEFAULT_RETRY_MAX_DELAY_MS = 4000;
export const DEFAULT_RETRY_JITTER_MS = 100;
export const DEFAULT_RETRY_AFTER_MAX_MS = 30000;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);

const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, value));

const finiteInteger = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
};

export const normalizeRetryOptions = (options = {}) => Object.freeze({
  baseDelayMs: clamp(
    finiteInteger(options.baseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS),
    0,
    10000
  ),
  maxDelayMs: clamp(
    finiteInteger(options.maxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS),
    1,
    60000
  ),
  jitterMs: clamp(
    finiteInteger(options.jitterMs, DEFAULT_RETRY_JITTER_MS),
    0,
    1000
  ),
  retryAfterMaxMs: clamp(
    finiteInteger(options.retryAfterMaxMs, DEFAULT_RETRY_AFTER_MAX_MS),
    0,
    120000
  )
});

export const isRetryableStatus = (status) => {
  const numeric = Number(status);
  if (!Number.isFinite(numeric)) return false;
  return RETRYABLE_STATUS_CODES.has(numeric) || (numeric >= 500 && numeric <= 599);
};

export const isRetryableError = (error) => {
  if (!error || isAbortError(error)) return false;
  if (error.code === 'ABORTED') return false;
  if (error.code === 'TIMEOUT') return true;
  if (error.code === 'NETWORK_ERROR') return true;
  if (error.retryable === true) return true;

  const status = error.status ?? error.response?.status;
  if (status !== null && status !== undefined) return isRetryableStatus(status);

  if (error instanceof TypeError) return true;
  return false;
};

export const parseRetryAfter = (value, options = {}) => {
  if (value === null || value === undefined || value === '') return null;

  const normalized = normalizeRetryOptions(options);
  const text = String(value).trim();
  if (!text) return null;

  if (/^-\d+(?:\.\d+)?$/.test(text)) return null;

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return clamp(
      Math.round(seconds * 1000),
      0,
      normalized.retryAfterMaxMs
    );
  }

  const parsedDate = Date.parse(text);
  if (!Number.isFinite(parsedDate)) return null;

  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(now)) return null;

  return clamp(
    Math.max(0, parsedDate - now),
    0,
    normalized.retryAfterMaxMs
  );
};

export const calculateBackoffDelay = (attempt, options = {}) => {
  const normalized = normalizeRetryOptions(options);
  const safeAttempt = clamp(finiteInteger(attempt, 0), 0, 12);
  const exponential = normalized.baseDelayMs * (2 ** safeAttempt);
  const bounded = Math.min(exponential, normalized.maxDelayMs);

  const random = typeof options.random === 'function' ? options.random : Math.random;
  const randomValue = Number(random());
  const normalizedRandom = Number.isFinite(randomValue)
    ? clamp(randomValue, 0, 1)
    : 0;

  const jitter = Math.round(normalizedRandom * normalized.jitterMs);
  return Math.min(normalized.maxDelayMs, bounded + jitter);
};

export const getRetryAfterHeader = (error) => {
  if (!error) return null;

  const response = error.response;
  const headers = response?.headers ?? error.headers;
  if (!headers) return null;

  if (typeof headers.get === 'function') {
    return headers.get('retry-after');
  }

  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'retry-after');
  return key ? headers[key] : null;
};

export const calculateRetryDelay = (attempt, error, options = {}) => {
  const retryAfter = parseRetryAfter(getRetryAfterHeader(error), options);
  if (retryAfter !== null) return retryAfter;
  return calculateBackoffDelay(attempt, options);
};

const createAbortError = (message = 'Request cancelled') =>
  new AppError(message, {
    code: 'ABORTED',
    retryable: false
  });

export const throwIfAborted = (signal) => {
  if (signal?.aborted) throw createAbortError();
};

export const waitForRetry = (milliseconds, signal, dependencies = {}) => {
  const duration = Math.max(0, finiteInteger(milliseconds, 0));
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const onAbort = () => settle(reject, createAbortError());

    if (signal?.aborted) {
      onAbort();
      return;
    }

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimer(() => settle(resolve), duration);
  });
};

export const createRetryDecision = ({
  error,
  attempt = 0,
  maxRetries = 0,
  retryAllowed = true,
  signal,
  options = {}
} = {}) => {
  if (signal?.aborted || isAbortError(error) || error?.code === 'ABORTED') {
    return Object.freeze({
      retry: false,
      reason: 'aborted',
      attempt,
      delayMs: 0
    });
  }

  if (!retryAllowed) {
    return Object.freeze({
      retry: false,
      reason: 'method-not-retryable',
      attempt,
      delayMs: 0
    });
  }

  if (!isRetryableError(error)) {
    return Object.freeze({
      retry: false,
      reason: 'error-not-retryable',
      attempt,
      delayMs: 0
    });
  }

  const normalizedAttempt = Math.max(0, finiteInteger(attempt, 0));
  const normalizedMaxRetries = clamp(finiteInteger(maxRetries, 0), 0, 10);

  if (normalizedAttempt >= normalizedMaxRetries) {
    return Object.freeze({
      retry: false,
      reason: 'retry-budget-exhausted',
      attempt: normalizedAttempt,
      delayMs: 0
    });
  }

  return Object.freeze({
    retry: true,
    reason: 'retryable',
    attempt: normalizedAttempt,
    delayMs: calculateRetryDelay(normalizedAttempt, error, options)
  });
};

export const executeWithRetry = async (operation, configuration = {}) => {
  if (typeof operation !== 'function') {
    throw new TypeError('operation must be a function');
  }

  const {
    maxRetries = 0,
    retryAllowed = true,
    signal,
    onAttempt,
    onRetry,
    retryOptions = {},
    wait = waitForRetry
  } = configuration;

  let attempt = 0;
  throwIfAborted(signal);

  while (true) {
    try {
      if (typeof onAttempt === 'function') {
        onAttempt({ attempt, signal });
      }

      return await operation({ attempt, signal });
    } catch (error) {
      const decision = createRetryDecision({
        error,
        attempt,
        maxRetries,
        retryAllowed,
        signal,
        options: retryOptions
      });

      if (!decision.retry) throw error;

      if (typeof onRetry === 'function') {
        onRetry({
          error,
          attempt,
          nextAttempt: attempt + 1,
          delayMs: decision.delayMs,
          reason: decision.reason
        });
      }

      await wait(decision.delayMs, signal);
      attempt += 1;
      throwIfAborted(signal);
    }
  }
};

export const RetryPolicy = Object.freeze({
  normalizeRetryOptions,
  isRetryableStatus,
  isRetryableError,
  parseRetryAfter,
  calculateBackoffDelay,
  calculateRetryDelay,
  createRetryDecision,
  waitForRetry,
  executeWithRetry,
  throwIfAborted
});
