import { AppError, isAbortError } from '../errors/appError';

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerTransition {
  readonly from: CircuitBreakerState;
  readonly to: CircuitBreakerState;
  readonly timestamp: number;
  readonly reason: string;
  readonly failureRate: number | null;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  minimumSamples?: number;
  failureRateThreshold?: number;
  sampleWindowSize?: number;
  openDurationMs?: number;
  maxOpenDurationMs?: number;
  halfOpenMaxConcurrent?: number;
  halfOpenSuccessThreshold?: number;
  clock?: () => number;
  shouldCountFailure?: (error: unknown) => boolean;
  onTransition?: (transition: CircuitBreakerTransition) => void;
}

export interface CircuitBreakerSnapshot {
  readonly state: CircuitBreakerState;
  readonly sampleCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly failureRate: number | null;
  readonly consecutiveFailures: number;
  readonly halfOpenSuccesses: number;
  readonly halfOpenInFlight: number;
  readonly openedAt: number | null;
  readonly retryAt: number | null;
  readonly openDurationMs: number;
  readonly totalExecutions: number;
  readonly rejectedExecutions: number;
  readonly transitions: number;
}

interface OutcomeSample {
  success: boolean;
  timestamp: number;
}

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const clampRatio = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0.05, Math.min(1, parsed));
};

const defaultShouldCountFailure = (error: unknown): boolean => {
  if (isAbortError(error)) return false;
  if (error instanceof AppError) {
    if (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND') return false;
    return error.retryable || error.status === null || (error.status ?? 0) >= 500 || error.status === 429;
  }
  return true;
};

export class CircuitOpenError extends AppError {
  readonly retryAt: number | null;

  constructor(retryAt: number | null) {
    super('Servis geçici olarak korumaya alındı. Lütfen daha sonra tekrar deneyin.', {
      code: 'CIRCUIT_OPEN',
      retryable: true,
      details: retryAt === null ? null : { retryAt }
    });
    this.name = 'CircuitOpenError';
    this.retryAt = retryAt;
  }
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly minimumSamples: number;
  private readonly failureRateThreshold: number;
  private readonly sampleWindowSize: number;
  private readonly baseOpenDurationMs: number;
  private readonly maxOpenDurationMs: number;
  private readonly halfOpenMaxConcurrent: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly clock: () => number;
  private readonly shouldCountFailure: (error: unknown) => boolean;
  private readonly onTransition?: (transition: CircuitBreakerTransition) => void;
  private readonly samples: OutcomeSample[] = [];
  private state: CircuitBreakerState = 'closed';
  private openedAt: number | null = null;
  private retryAt: number | null = null;
  private currentOpenDurationMs: number;
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private halfOpenInFlight = 0;
  private totalExecutions = 0;
  private rejectedExecutions = 0;
  private transitionCount = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = clampInteger(options.failureThreshold, 5, 1, 50);
    this.minimumSamples = clampInteger(options.minimumSamples, 6, 1, 100);
    this.failureRateThreshold = clampRatio(options.failureRateThreshold, 0.5);
    this.sampleWindowSize = clampInteger(options.sampleWindowSize, 20, this.minimumSamples, 200);
    this.baseOpenDurationMs = clampInteger(options.openDurationMs, 10000, 100, 300000);
    this.maxOpenDurationMs = clampInteger(
      options.maxOpenDurationMs,
      120000,
      this.baseOpenDurationMs,
      900000
    );
    this.halfOpenMaxConcurrent = clampInteger(options.halfOpenMaxConcurrent, 1, 1, 10);
    this.halfOpenSuccessThreshold = clampInteger(options.halfOpenSuccessThreshold, 2, 1, 20);
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this.shouldCountFailure = typeof options.shouldCountFailure === 'function'
      ? options.shouldCountFailure
      : defaultShouldCountFailure;
    this.onTransition = options.onTransition;
    this.currentOpenDurationMs = this.baseOpenDurationMs;
  }

  private failureRate(): number | null {
    if (this.samples.length === 0) return null;
    const failures = this.samples.filter((sample) => !sample.success).length;
    return Math.round((failures / this.samples.length) * 10000) / 10000;
  }

  private emitTransition(from: CircuitBreakerState, to: CircuitBreakerState, reason: string): void {
    const transition: CircuitBreakerTransition = Object.freeze({
      from,
      to,
      timestamp: this.clock(),
      reason,
      failureRate: this.failureRate()
    });
    this.transitionCount += 1;
    if (typeof this.onTransition !== 'function') return;
    try {
      this.onTransition(transition);
    } catch (_error) {
      // A monitoring hook must never affect circuit behavior.
    }
  }

  private transitionTo(next: CircuitBreakerState, reason: string): void {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;

    if (next === 'open') {
      const now = this.clock();
      this.openedAt = now;
      this.retryAt = now + this.currentOpenDurationMs;
      this.halfOpenSuccesses = 0;
      this.halfOpenInFlight = 0;
    } else if (next === 'half-open') {
      this.halfOpenSuccesses = 0;
      this.halfOpenInFlight = 0;
    } else {
      this.openedAt = null;
      this.retryAt = null;
      this.currentOpenDurationMs = this.baseOpenDurationMs;
      this.consecutiveFailures = 0;
      this.halfOpenSuccesses = 0;
      this.halfOpenInFlight = 0;
      this.samples.length = 0;
    }

    this.emitTransition(previous, next, reason);
  }

  private maybeEnterHalfOpen(): void {
    if (this.state !== 'open') return;
    const now = this.clock();
    if (this.retryAt !== null && now >= this.retryAt) {
      this.transitionTo('half-open', 'open-duration-elapsed');
    }
  }

  private recordSample(success: boolean): void {
    this.samples.push({ success, timestamp: this.clock() });
    while (this.samples.length > this.sampleWindowSize) this.samples.shift();
  }

  private evaluateClosedAfterFailure(): void {
    if (this.state !== 'closed') return;
    const rate = this.failureRate();
    const consecutiveTrip = this.consecutiveFailures >= this.failureThreshold;
    const rateTrip = this.samples.length >= this.minimumSamples
      && rate !== null
      && rate >= this.failureRateThreshold;
    if (consecutiveTrip || rateTrip) {
      this.transitionTo('open', consecutiveTrip ? 'consecutive-failure-threshold' : 'failure-rate-threshold');
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
        this.transitionTo('closed', 'half-open-recovery-confirmed');
      }
      return;
    }

    this.consecutiveFailures = 0;
    this.recordSample(true);
  }

  private onFailure(error: unknown): void {
    if (!this.shouldCountFailure(error)) return;

    if (this.state === 'half-open') {
      this.currentOpenDurationMs = Math.min(
        this.maxOpenDurationMs,
        Math.max(this.baseOpenDurationMs, this.currentOpenDurationMs * 2)
      );
      this.transitionTo('open', 'half-open-probe-failed');
      return;
    }

    this.consecutiveFailures += 1;
    this.recordSample(false);
    this.evaluateClosedAfterFailure();
  }

  private acquire(): void {
    this.maybeEnterHalfOpen();
    if (this.state === 'open') {
      this.rejectedExecutions += 1;
      throw new CircuitOpenError(this.retryAt);
    }
    if (this.state === 'half-open') {
      if (this.halfOpenInFlight >= this.halfOpenMaxConcurrent) {
        this.rejectedExecutions += 1;
        throw new CircuitOpenError(this.retryAt);
      }
      this.halfOpenInFlight += 1;
    }
    this.totalExecutions += 1;
  }

  private releaseHalfOpenSlot(): void {
    if (this.state === 'half-open' && this.halfOpenInFlight > 0) this.halfOpenInFlight -= 1;
  }

  async execute<T>(operation: () => Promise<T> | T): Promise<T> {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    this.acquire();
    const enteredHalfOpen = this.state === 'half-open';
    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    } finally {
      if (enteredHalfOpen) this.releaseHalfOpenSlot();
    }
  }

  canExecute(): boolean {
    this.maybeEnterHalfOpen();
    if (this.state === 'closed') return true;
    if (this.state === 'open') return false;
    return this.halfOpenInFlight < this.halfOpenMaxConcurrent;
  }

  forceOpen(reason = 'manual-open'): void {
    if (this.state === 'open') return;
    this.transitionTo('open', reason.slice(0, 96));
  }

  reset(reason = 'manual-reset'): void {
    if (this.state === 'closed') {
      this.samples.length = 0;
      this.consecutiveFailures = 0;
      this.currentOpenDurationMs = this.baseOpenDurationMs;
      return;
    }
    this.transitionTo('closed', reason.slice(0, 96));
  }

  snapshot(): CircuitBreakerSnapshot {
    const successCount = this.samples.filter((sample) => sample.success).length;
    const failureCount = this.samples.length - successCount;
    return Object.freeze({
      state: this.state,
      sampleCount: this.samples.length,
      successCount,
      failureCount,
      failureRate: this.failureRate(),
      consecutiveFailures: this.consecutiveFailures,
      halfOpenSuccesses: this.halfOpenSuccesses,
      halfOpenInFlight: this.halfOpenInFlight,
      openedAt: this.openedAt,
      retryAt: this.retryAt,
      openDurationMs: this.currentOpenDurationMs,
      totalExecutions: this.totalExecutions,
      rejectedExecutions: this.rejectedExecutions,
      transitions: this.transitionCount
    });
  }
}

export interface CircuitBreakerRegistryOptions extends CircuitBreakerOptions {
  maxBreakers?: number;
}

export class CircuitBreakerRegistry {
  private readonly maxBreakers: number;
  private readonly breakerOptions: CircuitBreakerOptions;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(options: CircuitBreakerRegistryOptions = {}) {
    this.maxBreakers = clampInteger(options.maxBreakers, 40, 1, 200);
    const { maxBreakers: _ignored, ...breakerOptions } = options;
    this.breakerOptions = breakerOptions;
  }

  private normalizeKey(value: unknown): string {
    const raw = String(value || 'default').replace(/[?#].*$/, '');
    const safe = raw.trim().toLowerCase().replace(/[^a-z0-9._:/-]+/g, '-').slice(0, 120);
    return safe || 'default';
  }

  get(key: unknown): CircuitBreaker {
    const normalized = this.normalizeKey(key);
    const existing = this.breakers.get(normalized);
    if (existing) return existing;
    if (this.breakers.size >= this.maxBreakers) {
      const oldestKey = this.breakers.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.breakers.delete(oldestKey);
    }
    const breaker = new CircuitBreaker(this.breakerOptions);
    this.breakers.set(normalized, breaker);
    return breaker;
  }

  async execute<T>(key: unknown, operation: () => Promise<T> | T): Promise<T> {
    return this.get(key).execute(operation);
  }

  reset(key?: unknown): void {
    if (key !== undefined) {
      this.breakers.get(this.normalizeKey(key))?.reset('registry-reset');
      return;
    }
    this.breakers.forEach((breaker) => breaker.reset('registry-reset-all'));
  }

  delete(key: unknown): boolean {
    return this.breakers.delete(this.normalizeKey(key));
  }

  clear(): void {
    this.breakers.clear();
  }

  snapshot(): Readonly<Record<string, CircuitBreakerSnapshot>> {
    const result: Record<string, CircuitBreakerSnapshot> = {};
    Array.from(this.breakers.keys()).sort().forEach((key) => {
      const breaker = this.breakers.get(key);
      if (breaker) result[key] = breaker.snapshot();
    });
    return Object.freeze(result);
  }

  size(): number {
    return this.breakers.size;
  }
}

export const createCircuitBreaker = (options: CircuitBreakerOptions = {}): CircuitBreaker =>
  new CircuitBreaker(options);

export const createCircuitBreakerRegistry = (
  options: CircuitBreakerRegistryOptions = {}
): CircuitBreakerRegistry => new CircuitBreakerRegistry(options);
