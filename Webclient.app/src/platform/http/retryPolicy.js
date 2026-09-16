import { isAbortError } from '../errors/appError';

export const RETRYABLE_METHODS = new Set(['get', 'head', 'options']);
export const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);

const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5000;
const DEFAULT_JITTER_RATIO = 0.2;

const asFiniteNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const isRetryableStatus = (status) => {
  const numericStatus = Number(status);
  if (!Number.isFinite(numericStatus) || numericStatus <= 0) return true;
  return RETRYABLE_STATUS_CODES.has(numericStatus) || numericStatus >= 500;
};

export const isMethodRetryable = (method, retryUnsafe = false) => {
  const normalized = String(method || 'get').trim().toLowerCase();
  return RETRYABLE_METHODS.has(normalized) || retryUnsafe === true;
};

const readHeader = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);

  const match = Object.keys(headers).find(
    (key) => key.toLowerCase() === name.toLowerCase()
  );
  return match ? headers[match] : null;
};

/**
 * Parses Retry-After according to HTTP semantics. Both delay-seconds and HTTP-date are supported.
 * Invalid, expired and excessively distant values are ignored or bounded by maxDelayMs.
 */
export const parseRetryAfterMs = (headers, options = {}) => {
  const {
    now = Date.now(),
    maxDelayMs = 60000
  } = options;
  const rawValue = readHeader(headers, 'retry-after');
  if (rawValue === null || rawValue === undefined) return null;

  const raw = String(rawValue).trim();
  if (!raw) return null;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(Math.ceil(seconds * 1000), Math.max(0, maxDelayMs));
  }

  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  const delay = Math.max(0, date - now);
  return Math.min(delay, Math.max(0, maxDelayMs));
};

export const computeBackoffDelayMs = (attempt, options = {}) => {
  const {
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    jitterRatio = DEFAULT_JITTER_RATIO,
    random = Math.random
  } = options;

  const safeAttempt = Math.max(0, Math.floor(asFiniteNumber(attempt, 0)));
  const base = Math.max(0, asFiniteNumber(baseDelayMs, DEFAULT_BASE_DELAY_MS));
  const max = Math.max(base, asFiniteNumber(maxDelayMs, DEFAULT_MAX_DELAY_MS));
  const ratio = Math.min(1, Math.max(0, asFiniteNumber(jitterRatio, DEFAULT_JITTER_RATIO)));
  const exponential = Math.min(base * (2 ** safeAttempt), max);
  const randomValue = Math.min(1, Math.max(0, asFiniteNumber(random(), 0.5)));
  const jitterWindow = exponential * ratio;
  const jitter = ((randomValue * 2) - 1) * jitterWindow;

  return Math.max(0, Math.min(max, Math.round(exponential + jitter)));
};

export const getErrorStatus = (error) => {
  const candidates = [
    error?.status,
    error?.response?.status,
    error?.details?.status
  ];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status > 0) return status;
  }
  return null;
};

export const getErrorHeaders = (error) =>
  error?.response?.headers || error?.headers || error?.details?.headers || null;

export const createRetryDecision = ({
  error,
  method,
  attempt,
  maxRetries,
  retryUnsafe = false,
  signal,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  jitterRatio = DEFAULT_JITTER_RATIO,
  random = Math.random,
  now = Date.now()
} = {}) => {
  const normalizedAttempt = Math.max(0, Math.floor(asFiniteNumber(attempt, 0)));
  const normalizedMaxRetries = Math.max(0, Math.floor(asFiniteNumber(maxRetries, 0)));

  if (signal?.aborted || isAbortError(error)) {
    return Object.freeze({ retry: false, reason: 'aborted', delayMs: 0 });
  }
  if (!isMethodRetryable(method, retryUnsafe)) {
    return Object.freeze({ retry: false, reason: 'unsafe-method', delayMs: 0 });
  }
  if (normalizedAttempt >= normalizedMaxRetries) {
    return Object.freeze({ retry: false, reason: 'retry-limit', delayMs: 0 });
  }

  const status = getErrorStatus(error);
  if (!isRetryableStatus(status)) {
    return Object.freeze({ retry: false, reason: 'non-retryable-status', delayMs: 0, status });
  }

  const retryAfterMs = parseRetryAfterMs(getErrorHeaders(error), {
    now,
    maxDelayMs
  });
  const delayMs = retryAfterMs === null
    ? computeBackoffDelayMs(normalizedAttempt, {
      baseDelayMs,
      maxDelayMs,
      jitterRatio,
      random
    })
    : retryAfterMs;

  return Object.freeze({
    retry: true,
    reason: retryAfterMs === null ? 'backoff' : 'retry-after',
    delayMs,
    status
  });
};

export const waitForRetryDelay = (milliseconds, signal, timers = {}) => {
  const setTimer = timers.setTimeout || setTimeout;
  const clearTimer = timers.clearTimeout || clearTimeout;
  const delay = Math.max(0, Math.floor(asFiniteNumber(milliseconds, 0)));

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Request cancelled'), {
        name: 'AbortError',
        code: 'ABORTED'
      }));
      return;
    }

    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimer(timer);
      if (signal) signal.removeEventListener('abort', abortHandler);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abortHandler = () => finish(() => reject(Object.assign(
      new Error('Request cancelled'),
      { name: 'AbortError', code: 'ABORTED' }
    )));

    timer = setTimer(() => finish(resolve), delay);
    if (signal) signal.addEventListener('abort', abortHandler, { once: true });
  });
};

export const retryPolicyDefaults = Object.freeze({
  baseDelayMs: DEFAULT_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
  jitterRatio: DEFAULT_JITTER_RATIO
});
