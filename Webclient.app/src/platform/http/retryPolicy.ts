import { AppError, isAbortError } from '../errors/appError';
import {
  type RetryDecision,
  type RetryExecutionConfiguration,
  type RetryOptions,
  getErrorCode,
  getErrorRetryable,
  getErrorStatus,
  readErrorLike
} from './contracts';

export const DEFAULT_RETRY_BASE_DELAY_MS = 250;
export const DEFAULT_RETRY_MAX_DELAY_MS = 4000;
export const DEFAULT_RETRY_JITTER_MS = 100;
export const DEFAULT_RETRY_AFTER_MAX_MS = 30000;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);

export interface NormalizedRetryOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterMs: number;
  readonly retryAfterMaxMs: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const finiteInteger = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
};

export const normalizeRetryOptions = (options: RetryOptions = {}): NormalizedRetryOptions => Object.freeze({
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

export const isRetryableStatus = (status: unknown): boolean => {
  const numeric = Number(status);
  if (!Number.isFinite(numeric)) return false;
  return RETRYABLE_STATUS_CODES.has(numeric) || (numeric >= 500 && numeric <= 599);
};

export const isRetryableError = (error: unknown): boolean => {
  if (!error || isAbortError(error)) return false;
  if (getErrorCode(error) === 'ABORTED') return false;
  if (getErrorCode(error) === 'TIMEOUT') return true;
  if (getErrorCode(error) === 'NETWORK_ERROR') return true;
  if (getErrorRetryable(error)) return true;

  const status = getErrorStatus(error);
  if (status !== null) return isRetryableStatus(status);

  if (error instanceof TypeError) return true;
  return false;
};

export const parseRetryAfter = (value: unknown, options: RetryOptions = {}): number | null => {
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

export const calculateBackoffDelay = (attempt: unknown, options: RetryOptions = {}): number => {
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

const readRetryAfterFromHeaders = (headers: unknown): unknown => {
  if (!headers || typeof headers !== 'object') return null;
  if ('get' in headers && typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get('retry-after');
  }

  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find((name) => name.toLowerCase() === 'retry-after');
  return key ? record[key] : null;
};

export const getRetryAfterHeader = (error: unknown): unknown => {
  if (!error) return null;
  const candidate = readErrorLike(error);
  const headers = candidate.response?.headers ?? candidate.headers;
  return readRetryAfterFromHeaders(headers);
};

export const calculateRetryDelay = (
  attempt: unknown,
  error: unknown,
  options: RetryOptions = {}
): number => {
  const retryAfter = parseRetryAfter(getRetryAfterHeader(error), options);
  if (retryAfter !== null) return retryAfter;
  return calculateBackoffDelay(attempt, options);
};

const createAbortError = (message = 'Request cancelled') =>
  new AppError(message, {
    code: 'ABORTED',
    retryable: false
  });

export const throwIfAborted = (signal?: AbortSignal | null): void => {
  if (signal?.aborted) throw createAbortError();
};

interface TimerDependencies {
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export const waitForRetry = (
  milliseconds: unknown,
  signal?: AbortSignal | null,
  dependencies: TimerDependencies = {}
): Promise<void> => {
  const duration = Math.max(0, finiteInteger(milliseconds, 0));
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = () => settleReject(createAbortError());

    if (signal?.aborted) {
      onAbort();
      return;
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimer(settleResolve, duration);
  });
};

interface RetryDecisionInput {
  error?: unknown;
  attempt?: number;
  maxRetries?: number;
  retryAllowed?: boolean;
  signal?: AbortSignal | null;
  options?: RetryOptions;
}

export const createRetryDecision = ({
  error,
  attempt = 0,
  maxRetries = 0,
  retryAllowed = true,
  signal,
  options = {}
}: RetryDecisionInput = {}): RetryDecision => {
  if (signal?.aborted || isAbortError(error) || getErrorCode(error) === 'ABORTED') {
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

export const executeWithRetry = async <T>(
  operation: (context: { attempt: number; signal?: AbortSignal | null }) => Promise<T> | T,
  configuration: RetryExecutionConfiguration = {}
): Promise<T> => {
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
      onAttempt?.({ attempt, signal });
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

      onRetry?.({
        error,
        attempt,
        nextAttempt: attempt + 1,
        delayMs: decision.delayMs,
        reason: decision.reason
      });

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
