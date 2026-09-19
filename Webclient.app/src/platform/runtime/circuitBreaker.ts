export type CircuitState = 'closed' | 'open' | 'half-open';
export type CircuitOutcome = 'success' | 'failure' | 'rejected' | 'probe-success' | 'probe-failure';

export interface CircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly recoveryTimeoutMs?: number;
  readonly halfOpenMaxCalls?: number;
  readonly successThreshold?: number;
  readonly historyLimit?: number;
  readonly clock?: () => number;
  readonly classifyFailure?: (error: unknown) => boolean;
}

export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly halfOpenInFlight: number;
  readonly halfOpenSuccesses: number;
  readonly openedAt: number | null;
  readonly retryAt: number | null;
  readonly totalCalls: number;
  readonly totalRejected: number;
}

export interface CircuitEvent {
  readonly sequence: number;
  readonly at: number;
  readonly from: CircuitState;
  readonly to: CircuitState;
  readonly outcome: CircuitOutcome;
}

export class CircuitOpenError extends Error {
  readonly retryAt: number;

  constructor(retryAt: number) {
    super('Circuit breaker is open');
    this.name = 'CircuitOpenError';
    this.retryAt = retryAt;
  }
}

const requireInteger = (name: string, value: number, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

export class BoundedCircuitBreaker {
  readonly failureThreshold: number;
  readonly recoveryTimeoutMs: number;
  readonly halfOpenMaxCalls: number;
  readonly successThreshold: number;
  readonly historyLimit: number;
  readonly #clock: () => number;
  readonly #classifyFailure: (error: unknown) => boolean;
  readonly #history: CircuitEvent[] = [];
  #state: CircuitState = 'closed';
  #consecutiveFailures = 0;
  #halfOpenInFlight = 0;
  #halfOpenSuccesses = 0;
  #openedAt: number | null = null;
  #totalCalls = 0;
  #totalRejected = 0;
  #sequence = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = requireInteger('failureThreshold', options.failureThreshold ?? 5, 1, 100);
    this.recoveryTimeoutMs = requireInteger('recoveryTimeoutMs', options.recoveryTimeoutMs ?? 15_000, 1, 300_000);
    this.halfOpenMaxCalls = requireInteger('halfOpenMaxCalls', options.halfOpenMaxCalls ?? 1, 1, 32);
    this.successThreshold = requireInteger('successThreshold', options.successThreshold ?? 1, 1, 32);
    if (this.successThreshold > this.halfOpenMaxCalls) {
      throw new RangeError('successThreshold must be <= halfOpenMaxCalls');
    }
    this.historyLimit = requireInteger('historyLimit', options.historyLimit ?? 64, 0, 1_000);
    this.#clock = options.clock ?? Date.now;
    this.#classifyFailure = options.classifyFailure ?? (() => true);
  }

  snapshot(): CircuitSnapshot {
    const now = this.#clock();
    this.#refresh(now);
    return Object.freeze({
      state: this.#state,
      consecutiveFailures: this.#consecutiveFailures,
      halfOpenInFlight: this.#halfOpenInFlight,
      halfOpenSuccesses: this.#halfOpenSuccesses,
      openedAt: this.#openedAt,
      retryAt: this.#openedAt === null ? null : this.#openedAt + this.recoveryTimeoutMs,
      totalCalls: this.#totalCalls,
      totalRejected: this.#totalRejected,
    });
  }

  history(): readonly CircuitEvent[] {
    return Object.freeze(this.#history.map(event => Object.freeze({ ...event })));
  }

  reset(): void {
    const from = this.#state;
    this.#state = 'closed';
    this.#consecutiveFailures = 0;
    this.#halfOpenInFlight = 0;
    this.#halfOpenSuccesses = 0;
    this.#openedAt = null;
    if (from !== 'closed') this.#record(from, 'closed', 'success');
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const now = this.#clock();
    this.#refresh(now);
    if (!this.#admit(now)) {
      this.#totalRejected += 1;
      this.#record(this.#state, this.#state, 'rejected');
      const retryAt = (this.#openedAt ?? now) + this.recoveryTimeoutMs;
      throw new CircuitOpenError(retryAt);
    }

    const admittedState = this.#state;
    this.#totalCalls += 1;
    if (admittedState === 'half-open') this.#halfOpenInFlight += 1;

    try {
      const value = await operation();
      this.#onSuccess(admittedState);
      return value;
    } catch (error) {
      this.#onFailure(admittedState, error);
      throw error;
    }
  }

  #refresh(now: number): void {
    if (this.#state !== 'open' || this.#openedAt === null) return;
    if (now - this.#openedAt < this.recoveryTimeoutMs) return;
    const from = this.#state;
    this.#state = 'half-open';
    this.#halfOpenInFlight = 0;
    this.#halfOpenSuccesses = 0;
    this.#record(from, 'half-open', 'success');
  }

  #admit(now: number): boolean {
    if (this.#state === 'closed') return true;
    if (this.#state === 'open') {
      this.#refresh(now);
      if (this.#state === 'open') return false;
    }
    return this.#halfOpenInFlight < this.halfOpenMaxCalls;
  }

  #onSuccess(admittedState: CircuitState): void {
    if (admittedState === 'half-open') {
      this.#halfOpenInFlight = Math.max(0, this.#halfOpenInFlight - 1);
      if (this.#state !== 'half-open') return;
      this.#halfOpenSuccesses += 1;
      if (this.#halfOpenSuccesses >= this.successThreshold) {
        const from = this.#state;
        this.#state = 'closed';
        this.#consecutiveFailures = 0;
        this.#halfOpenSuccesses = 0;
        this.#openedAt = null;
        this.#record(from, 'closed', 'probe-success');
      } else {
        this.#record(this.#state, this.#state, 'probe-success');
      }
      return;
    }
    if (this.#state !== 'closed') return;
    this.#consecutiveFailures = 0;
    this.#record('closed', 'closed', 'success');
  }

  #onFailure(admittedState: CircuitState, error: unknown): void {
    if (admittedState === 'half-open') this.#halfOpenInFlight = Math.max(0, this.#halfOpenInFlight - 1);
    if (!this.#classifyFailure(error)) {
      if (admittedState === 'closed' && this.#state === 'closed') this.#consecutiveFailures = 0;
      return;
    }
    if (admittedState === 'half-open') {
      if (this.#state === 'half-open') this.#open('probe-failure');
      return;
    }
    if (this.#state !== 'closed') return;
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= this.failureThreshold) this.#open('failure');
    else this.#record('closed', 'closed', 'failure');
  }

  #open(outcome: CircuitOutcome): void {
    const from = this.#state;
    this.#state = 'open';
    this.#openedAt = this.#clock();
    this.#halfOpenInFlight = 0;
    this.#halfOpenSuccesses = 0;
    this.#record(from, 'open', outcome);
  }

  #record(from: CircuitState, to: CircuitState, outcome: CircuitOutcome): void {
    if (this.historyLimit === 0) return;
    this.#history.push(Object.freeze({ sequence: ++this.#sequence, at: this.#clock(), from, to, outcome }));
    while (this.#history.length > this.historyLimit) this.#history.shift();
  }
}