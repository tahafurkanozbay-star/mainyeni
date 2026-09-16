import {
  abortError,
  asFiniteNumber,
  clampNumber,
  isAbortLike,
  positiveInteger,
  throwIfAborted,
  type CircuitBreakerPolicy,
  type CircuitSnapshot,
  type CircuitState,
  type RetryPolicy,
} from './contracts';

export interface ResilienceClock {
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random: () => number;
}

export interface RetryAttemptContext {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
  readonly previousError?: unknown;
}

export interface RetryExecutionOptions {
  readonly signal?: AbortSignal;
  readonly policy?: Partial<RetryPolicy>;
  readonly clock?: Partial<ResilienceClock>;
  readonly onAttempt?: (context: RetryAttemptContext) => void;
  readonly onRetry?: (error: unknown, context: RetryAttemptContext, delayMs: number) => void;
}

export interface CircuitBreakerOptions {
  readonly policy?: Partial<CircuitBreakerPolicy>;
  readonly now?: () => number;
  readonly onTransition?: (next: CircuitState, previous: CircuitState, snapshot: CircuitSnapshot) => void;
}

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  constructor(readonly retryAfterMs: number) {
    super(`Circuit breaker is open; retry after ${retryAfterMs}ms.`);
    this.name = 'CircuitOpenError';
  }
}

export class OperationTimeoutError extends Error {
  readonly code = 'OPERATION_TIMEOUT';
  constructor(readonly timeoutMs: number) {
    super(`Operation exceeded ${timeoutMs}ms timeout.`);
    this.name = 'OperationTimeoutError';
  }
}

const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
  jitterRatio: 0.2,
  retryable: (error: unknown) => !isAbortLike(error),
});

const DEFAULT_CIRCUIT_POLICY: CircuitBreakerPolicy = Object.freeze({
  failureThreshold: 5,
  successThreshold: 2,
  openDurationMs: 15000,
  rollingWindowMs: 30000,
  minimumSamples: 5,
});

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

/**
 * Resilience observers are diagnostic hooks, not control-flow hooks. A metrics,
 * logging or UI listener must never replace the business result/error that the
 * resilience primitive is protecting.
 */
const notifyObserver = <TArgs extends readonly unknown[]>(
  observer: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void => {
  if (!observer) return;
  try {
    observer(...args);
  } catch {
    // Observability failures are intentionally isolated from business control flow.
  }
};

const normalizedRetryPolicy = (policy: Partial<RetryPolicy> = {}): RetryPolicy => Object.freeze({
  maxAttempts: positiveInteger(policy.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts, 10),
  baseDelayMs: positiveInteger(policy.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs, 60000),
  maxDelayMs: positiveInteger(policy.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs, 300000),
  jitterRatio: clampNumber(policy.jitterRatio, 0, 1, DEFAULT_RETRY_POLICY.jitterRatio),
  retryable: policy.retryable ?? DEFAULT_RETRY_POLICY.retryable,
});

const normalizedCircuitPolicy = (policy: Partial<CircuitBreakerPolicy> = {}): CircuitBreakerPolicy => Object.freeze({
  failureThreshold: positiveInteger(policy.failureThreshold, DEFAULT_CIRCUIT_POLICY.failureThreshold, 100),
  successThreshold: positiveInteger(policy.successThreshold, DEFAULT_CIRCUIT_POLICY.successThreshold, 100),
  openDurationMs: positiveInteger(policy.openDurationMs, DEFAULT_CIRCUIT_POLICY.openDurationMs, 30 * 60 * 1000),
  rollingWindowMs: positiveInteger(policy.rollingWindowMs, DEFAULT_CIRCUIT_POLICY.rollingWindowMs, 60 * 60 * 1000),
  minimumSamples: positiveInteger(policy.minimumSamples, DEFAULT_CIRCUIT_POLICY.minimumSamples, 1000),
});

export const retryDelayMs = (
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random = Math.random,
): number => {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** exponent));
  const jitterWindow = base * policy.jitterRatio;
  const jitter = (clampNumber(random(), 0, 1, 0.5) * 2 - 1) * jitterWindow;
  return Math.max(0, Math.round(base + jitter));
};

export const executeWithRetry = async <TValue>(
  operation: (context: RetryAttemptContext) => Promise<TValue> | TValue,
  options: RetryExecutionOptions = {},
): Promise<TValue> => {
  if (typeof operation !== 'function') throw new TypeError('Retry operation must be a function.');
  const policy = normalizedRetryPolicy(options.policy);
  const clock: ResilienceClock = {
    now: options.clock?.now ?? Date.now,
    sleep: options.clock?.sleep ?? sleep,
    random: options.clock?.random ?? Math.random,
  };
  let previousError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    const context: RetryAttemptContext = {
      attempt,
      maxAttempts: policy.maxAttempts,
      signal: options.signal,
      ...(attempt > 1 ? { previousError } : {}),
    };
    notifyObserver(options.onAttempt, context);
    try {
      return await operation(context);
    } catch (error) {
      previousError = error;
      if (isAbortLike(error) || options.signal?.aborted) throw error;
      const retryable = policy.retryable?.(error, attempt) !== false;
      if (!retryable || attempt >= policy.maxAttempts) throw error;
      const delayMs = retryDelayMs(attempt, policy, clock.random);
      notifyObserver(options.onRetry, error, context, delayMs);
      await clock.sleep(delayMs, options.signal);
    }
  }

  throw previousError ?? new Error('Retry operation exhausted without result.');
};

interface CircuitSample {
  readonly timestamp: number;
  readonly success: boolean;
}

export interface CircuitBreaker {
  readonly execute: <TValue>(operation: () => Promise<TValue> | TValue) => Promise<TValue>;
  readonly allow: () => boolean;
  readonly recordSuccess: () => void;
  readonly recordFailure: () => void;
  readonly snapshot: () => CircuitSnapshot;
  readonly reset: () => void;
}

export const createCircuitBreaker = (options: CircuitBreakerOptions = {}): CircuitBreaker => {
  const policy = normalizedCircuitPolicy(options.policy);
  const now = options.now ?? Date.now;
  const samples: CircuitSample[] = [];
  let state: CircuitState = 'closed';
  let openedAt: number | null = null;
  let halfOpenSuccesses = 0;
  let halfOpenProbeInFlight = false;

  const prune = (): void => {
    const minimumTimestamp = now() - policy.rollingWindowMs;
    while (samples.length > 0 && (samples[0]?.timestamp ?? 0) < minimumTimestamp) samples.shift();
  };

  const counts = (): { successes: number; failures: number } => {
    prune();
    let successes = 0;
    let failures = 0;
    for (const sample of samples) {
      if (sample.success) successes += 1;
      else failures += 1;
    }
    return { successes, failures };
  };

  const snapshot = (): CircuitSnapshot => {
    const { successes, failures } = counts();
    return Object.freeze({
      state,
      failures,
      successes,
      consecutiveHalfOpenSuccesses: halfOpenSuccesses,
      openedAt,
      sampleCount: successes + failures,
    });
  };

  const transition = (next: CircuitState): void => {
    if (next === state) return;
    const previous = state;
    state = next;
    if (next === 'open') {
      openedAt = now();
      halfOpenSuccesses = 0;
      halfOpenProbeInFlight = false;
    } else if (next === 'half-open') {
      halfOpenSuccesses = 0;
      halfOpenProbeInFlight = false;
    } else {
      openedAt = null;
      halfOpenSuccesses = 0;
      halfOpenProbeInFlight = false;
      samples.splice(0);
    }
    notifyObserver(options.onTransition, next, previous, snapshot());
  };

  const shouldOpen = (): boolean => {
    const { failures, successes } = counts();
    const total = failures + successes;
    return total >= policy.minimumSamples && failures >= policy.failureThreshold;
  };

  const allow = (): boolean => {
    if (state === 'closed') return true;
    if (state === 'open') {
      const elapsed = openedAt === null ? 0 : Math.max(0, now() - openedAt);
      if (elapsed >= policy.openDurationMs) transition('half-open');
      else return false;
    }
    if (halfOpenProbeInFlight) return false;
    halfOpenProbeInFlight = true;
    return true;
  };

  const recordSuccess = (): void => {
    if (state === 'half-open') {
      halfOpenProbeInFlight = false;
      halfOpenSuccesses += 1;
      if (halfOpenSuccesses >= policy.successThreshold) transition('closed');
      return;
    }
    samples.push({ timestamp: now(), success: true });
    prune();
  };

  const recordFailure = (): void => {
    if (state === 'half-open') {
      halfOpenProbeInFlight = false;
      transition('open');
      return;
    }
    samples.push({ timestamp: now(), success: false });
    prune();
    if (shouldOpen()) transition('open');
  };

  const execute = async <TValue>(operation: () => Promise<TValue> | TValue): Promise<TValue> => {
    if (!allow()) {
      const elapsed = openedAt === null ? 0 : Math.max(0, now() - openedAt);
      throw new CircuitOpenError(Math.max(0, policy.openDurationMs - elapsed));
    }
    try {
      const value = await operation();
      recordSuccess();
      return value;
    } catch (error) {
      if (isAbortLike(error)) {
        if (state === 'half-open') halfOpenProbeInFlight = false;
        throw error;
      }
      recordFailure();
      throw error;
    }
  };

  const reset = (): void => {
    samples.splice(0);
    const previous = state;
    state = 'closed';
    openedAt = null;
    halfOpenSuccesses = 0;
    halfOpenProbeInFlight = false;
    if (previous !== 'closed') notifyObserver(options.onTransition, 'closed', previous, snapshot());
  };

  return Object.freeze({ execute, allow, recordSuccess, recordFailure, snapshot, reset });
};

/**
 * Enforces a deadline even when a legacy operation ignores the supplied
 * AbortSignal. The losing operation promise may still finish internally, but
 * it can no longer hold the caller open beyond the declared deadline.
 */
export const withTimeout = async <TValue>(
  operation: (signal: AbortSignal) => Promise<TValue> | TValue,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<TValue> => {
  const normalizedTimeout = positiveInteger(timeoutMs, 15000, 10 * 60 * 1000);
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const timeoutError = new OperationTimeoutError(normalizedTimeout);
  let rejectDeadline: (reason: unknown) => void = () => undefined;
  let finished = false;

  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });

  const fail = (reason: unknown): void => {
    if (finished) return;
    if (!controller.signal.aborted) controller.abort(reason);
    rejectDeadline(reason);
  };

  const timer = setTimeout(() => fail(timeoutError), normalizedTimeout);
  const parentAbort = () => fail(parentSignal?.reason ?? abortError());
  parentSignal?.addEventListener('abort', parentAbort, { once: true });

  try {
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    return await Promise.race([operationPromise, deadline]);
  } finally {
    finished = true;
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', parentAbort);
  }
};

export const composeAbortSignals = (
  signals: readonly (AbortSignal | null | undefined)[],
): { readonly signal: AbortSignal; readonly dispose: () => void } => {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];

  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason ?? abortError());
      break;
    }
    const handler = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason ?? abortError());
    };
    signal.addEventListener('abort', handler, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', handler));
  }

  return Object.freeze({
    signal: controller.signal,
    dispose: () => cleanups.splice(0).forEach((cleanup) => cleanup()),
  });
};

export const retryAfterMs = (value: unknown, now = Date.now()): number | null => {
  const numeric = asFiniteNumber(value);
  if (numeric !== null) return Math.max(0, Math.round(numeric * 1000));
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null;
};
