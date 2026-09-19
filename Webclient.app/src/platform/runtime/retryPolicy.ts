export type RetryDecisionReason =
  | 'retryable'
  | 'attempt-limit'
  | 'elapsed-budget'
  | 'aborted'
  | 'non-retryable';

export interface RetryPolicyOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxElapsedMs?: number;
  readonly backoffFactor?: number;
  readonly jitterRatio?: number;
  readonly retryable?: (error: unknown) => boolean;
  readonly random?: () => number;
  readonly clock?: () => number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface RetryAttemptContext {
  readonly attempt: number;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly signal?: AbortSignal;
}

export interface RetryContinueDecision {
  readonly retry: true;
  readonly reason: 'retryable';
  readonly attempt: number;
  readonly delayMs: number;
  readonly elapsedMs: number;
}

export interface RetryStopDecision {
  readonly retry: false;
  readonly reason: Exclude<RetryDecisionReason, 'retryable'>;
  readonly attempt: number;
  readonly delayMs: 0;
  readonly elapsedMs: number;
}

export type RetryDecision = RetryContinueDecision | RetryStopDecision;

export interface RetrySuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly attempts: number;
  readonly elapsedMs: number;
}

export interface RetryFailure {
  readonly ok: false;
  readonly error: unknown;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly reason: Exclude<RetryDecisionReason, 'retryable'>;
}

export type RetryResult<T> = RetrySuccess<T> | RetryFailure;

export class RetryAbortedError extends Error {
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super('Retry operation was aborted');
    this.name = 'RetryAbortedError';
    this.reason = reason;
  }
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 150;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_MAX_ELAPSED_MS = 10_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_JITTER_RATIO = 0.15;

const requireInteger = (name: string, value: number, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const requireFinite = (name: string, value: number, minimum: number, maximum: number): number => {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const defaultSleep = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(new RetryAbortedError(signal.reason));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new RetryAbortedError(signal?.reason));
    };
    const timer = setTimeout(finish, delayMs);
    if (!signal) return;
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
};

export class BoundedRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxElapsedMs: number;
  readonly backoffFactor: number;
  readonly jitterRatio: number;
  readonly #retryable: (error: unknown) => boolean;
  readonly #random: () => number;
  readonly #clock: () => number;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: RetryPolicyOptions = {}) {
    this.maxAttempts = requireInteger('maxAttempts', options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, 10);
    this.baseDelayMs = requireInteger('baseDelayMs', options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS, 0, 60_000);
    this.maxDelayMs = requireInteger('maxDelayMs', options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, 0, 120_000);
    this.maxElapsedMs = requireInteger('maxElapsedMs', options.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS, 1, 300_000);
    this.backoffFactor = requireFinite('backoffFactor', options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR, 1, 10);
    this.jitterRatio = requireFinite('jitterRatio', options.jitterRatio ?? DEFAULT_JITTER_RATIO, 0, 1);
    if (this.maxDelayMs < this.baseDelayMs) throw new RangeError('maxDelayMs must be >= baseDelayMs');
    this.#retryable = options.retryable ?? (() => false);
    this.#random = options.random ?? Math.random;
    this.#clock = options.clock ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  delayForAttempt(attempt: number): number {
    requireInteger('attempt', attempt, 1, this.maxAttempts);
    if (this.baseDelayMs === 0) return 0;
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * this.backoffFactor ** Math.max(0, attempt - 1));
    const sample = this.#random();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new RangeError('random() must return a value in [0, 1]');
    const jitter = exponential * this.jitterRatio * ((sample * 2) - 1);
    return Math.max(0, Math.min(this.maxDelayMs, Math.round(exponential + jitter)));
  }

  decide(error: unknown, attempt: number, startedAt: number, signal?: AbortSignal): RetryDecision {
    requireInteger('attempt', attempt, 1, this.maxAttempts);
    const elapsedMs = Math.max(0, this.#clock() - startedAt);
    if (signal?.aborted) return { retry: false, reason: 'aborted', attempt, delayMs: 0, elapsedMs };
    if (!this.#retryable(error)) return { retry: false, reason: 'non-retryable', attempt, delayMs: 0, elapsedMs };
    if (attempt >= this.maxAttempts) return { retry: false, reason: 'attempt-limit', attempt, delayMs: 0, elapsedMs };
    const delayMs = this.delayForAttempt(attempt);
    if (elapsedMs + delayMs >= this.maxElapsedMs) {
      return { retry: false, reason: 'elapsed-budget', attempt, delayMs: 0, elapsedMs };
    }
    return { retry: true, reason: 'retryable', attempt, delayMs, elapsedMs };
  }

  async execute<T>(operation: (context: RetryAttemptContext) => Promise<T>, signal?: AbortSignal): Promise<RetryResult<T>> {
    const startedAt = this.#clock();
    let attempt = 0;
    while (attempt < this.maxAttempts) {
      attempt += 1;
      const beforeAttempt = this.#clock();
      const elapsedMs = Math.max(0, beforeAttempt - startedAt);
      if (signal?.aborted) {
        return { ok: false, error: new RetryAbortedError(signal.reason), attempts: attempt - 1, elapsedMs, reason: 'aborted' };
      }
      if (elapsedMs >= this.maxElapsedMs) {
        return { ok: false, error: new Error('Retry elapsed-time budget exhausted'), attempts: attempt - 1, elapsedMs, reason: 'elapsed-budget' };
      }
      try {
        const context: RetryAttemptContext = {
          attempt,
          startedAt,
          elapsedMs,
          remainingMs: this.maxElapsedMs - elapsedMs,
          ...(signal ? { signal } : {}),
        };
        const value = await operation(context);
        return { ok: true, value, attempts: attempt, elapsedMs: Math.max(0, this.#clock() - startedAt) };
      } catch (error) {
        const decision = this.decide(error, attempt, startedAt, signal);
        if (!decision.retry) return { ok: false, error, attempts: attempt, elapsedMs: decision.elapsedMs, reason: decision.reason };
        try {
          await this.#sleep(decision.delayMs, signal);
        } catch (sleepError) {
          return { ok: false, error: sleepError, attempts: attempt, elapsedMs: Math.max(0, this.#clock() - startedAt), reason: 'aborted' };
        }
      }
    }
    return { ok: false, error: new Error('Retry attempt budget exhausted'), attempts: attempt, elapsedMs: Math.max(0, this.#clock() - startedAt), reason: 'attempt-limit' };
  }
}