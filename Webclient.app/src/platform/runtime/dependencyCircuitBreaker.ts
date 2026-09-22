export type CircuitState = 'closed' | 'open' | 'half-open';
export type CircuitOutcome = 'success' | 'failure' | 'timeout';

export interface CircuitClock { now(): number; }
export interface CircuitBreakerOptions {
  readonly failureWindow: number;
  readonly minimumSamples: number;
  readonly failureRateThreshold: number;
  readonly timeoutWeight: number;
  readonly openDurationMs: number;
  readonly maxOpenDurationMs: number;
  readonly backoffMultiplier: number;
  readonly halfOpenMaxProbes: number;
  readonly halfOpenSuccesses: number;
  readonly historyLimit: number;
}
export interface CircuitLease {
  readonly id: number;
  readonly state: CircuitState;
  readonly admittedAt: number;
}
export interface CircuitTransition {
  readonly at: number;
  readonly from: CircuitState;
  readonly to: CircuitState;
  readonly reason: 'failure-rate' | 'open-expired' | 'probe-failed' | 'probe-recovered' | 'reset';
  readonly openDurationMs: number;
}
export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly samples: number;
  readonly weightedFailures: number;
  readonly failureRate: number;
  readonly activeProbes: number;
  readonly successfulProbes: number;
  readonly rejected: number;
  readonly opened: number;
  readonly currentOpenDurationMs: number;
  readonly reopenAt: number | null;
}

type Sample = Readonly<{ outcome: CircuitOutcome; weight: number }>;
type LeaseRecord = Readonly<{ id: number; probe: boolean; admittedAt: number }>;
const defaultClock: CircuitClock = { now: () => Date.now() };

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite.`);
  return value;
};
const integer = (value: number, name: string, minimum: number): number => {
  finite(value, name);
  if (!Number.isInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}.`);
  return value;
};
const ratio = (value: number, name: string, allowZero = false): number => {
  finite(value, name);
  if (value < (allowZero ? 0 : Number.EPSILON) || value > 1) throw new RangeError(`${name} must be in ${allowZero ? '[0, 1]' : '(0, 1]'}.`);
  return value;
};

/**
 * Timer-free circuit breaker for injected dependency transports.
 * It owns no fetch/timer/retry loop: callers explicitly acquire a lease before
 * dependency work and complete it exactly once with the observed outcome.
 */
export class DependencyCircuitBreaker {
  readonly #options: CircuitBreakerOptions;
  readonly #clock: CircuitClock;
  readonly #samples: Sample[] = [];
  readonly #leases = new Map<number, LeaseRecord>();
  readonly #history: CircuitTransition[] = [];
  #state: CircuitState = 'closed';
  #nextLeaseId = 1;
  #openedAt: number | null = null;
  #openDurationMs: number;
  #successfulProbes = 0;
  #rejected = 0;
  #opened = 0;

  public constructor(options: CircuitBreakerOptions, clock: CircuitClock = defaultClock) {
    this.#options = DependencyCircuitBreaker.#validateOptions(options);
    this.#clock = clock;
    this.#openDurationMs = options.openDurationMs;
  }

  static #validateOptions(options: CircuitBreakerOptions): CircuitBreakerOptions {
    integer(options.failureWindow, 'failureWindow', 2);
    integer(options.minimumSamples, 'minimumSamples', 1);
    if (options.minimumSamples > options.failureWindow) throw new RangeError('minimumSamples cannot exceed failureWindow.');
    ratio(options.failureRateThreshold, 'failureRateThreshold');
    finite(options.timeoutWeight, 'timeoutWeight');
    if (options.timeoutWeight <= 0 || options.timeoutWeight > 1) throw new RangeError('timeoutWeight must be in (0, 1].');
    integer(options.openDurationMs, 'openDurationMs', 1);
    integer(options.maxOpenDurationMs, 'maxOpenDurationMs', options.openDurationMs);
    finite(options.backoffMultiplier, 'backoffMultiplier');
    if (options.backoffMultiplier < 1) throw new RangeError('backoffMultiplier must be >= 1.');
    integer(options.halfOpenMaxProbes, 'halfOpenMaxProbes', 1);
    integer(options.halfOpenSuccesses, 'halfOpenSuccesses', 1);
    if (options.halfOpenSuccesses > options.halfOpenMaxProbes) throw new RangeError('halfOpenSuccesses cannot exceed halfOpenMaxProbes.');
    integer(options.historyLimit, 'historyLimit', 1);
    return Object.freeze({ ...options });
  }

  #now(): number { return finite(this.#clock.now(), 'clock.now()'); }

  #refresh(now: number): void {
    if (this.#state !== 'open' || this.#openedAt === null) return;
    if (now - this.#openedAt < this.#openDurationMs) return;
    this.#transition('half-open', 'open-expired', now);
    this.#successfulProbes = 0;
  }

  public tryAcquire(): CircuitLease | null {
    const now = this.#now();
    this.#refresh(now);
    if (this.#state === 'open') {
      this.#rejected += 1;
      return null;
    }
    const probe = this.#state === 'half-open';
    if (probe && this.#activeProbeCount() >= this.#options.halfOpenMaxProbes) {
      this.#rejected += 1;
      return null;
    }
    const id = this.#nextLeaseId++;
    this.#leases.set(id, Object.freeze({ id, probe, admittedAt: now }));
    return Object.freeze({ id, state: this.#state, admittedAt: now });
  }

  public complete(lease: CircuitLease, outcome: CircuitOutcome): CircuitSnapshot {
    const record = this.#leases.get(lease.id);
    if (!record) throw new Error(`Unknown or already completed circuit lease ${lease.id}.`);
    if (record.admittedAt !== lease.admittedAt) throw new Error(`Circuit lease ${lease.id} ownership mismatch.`);
    if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'timeout') throw new RangeError(`Unknown circuit outcome: ${String(outcome)}.`);
    const now = this.#now();
    this.#leases.delete(lease.id);
    if (record.probe) this.#completeProbe(outcome, now);
    else this.#recordClosedOutcome(outcome, now);
    return this.snapshot();
  }

  #recordClosedOutcome(outcome: CircuitOutcome, now: number): void {
    if (this.#state !== 'closed') return;
    const weight = outcome === 'success' ? 0 : outcome === 'timeout' ? this.#options.timeoutWeight : 1;
    this.#samples.push(Object.freeze({ outcome, weight }));
    if (this.#samples.length > this.#options.failureWindow) this.#samples.splice(0, this.#samples.length - this.#options.failureWindow);
    if (this.#samples.length < this.#options.minimumSamples) return;
    if (this.#failureRate() >= this.#options.failureRateThreshold) this.#open('failure-rate', now, false);
  }

  #completeProbe(outcome: CircuitOutcome, now: number): void {
    if (this.#state !== 'half-open') return;
    if (outcome !== 'success') {
      this.#successfulProbes = 0;
      this.#open('probe-failed', now, true);
      return;
    }
    this.#successfulProbes += 1;
    if (this.#successfulProbes < this.#options.halfOpenSuccesses) return;
    this.#samples.length = 0;
    this.#successfulProbes = 0;
    this.#openDurationMs = this.#options.openDurationMs;
    this.#transition('closed', 'probe-recovered', now);
  }

  #open(reason: 'failure-rate' | 'probe-failed', now: number, backoff: boolean): void {
    if (backoff) this.#openDurationMs = Math.min(this.#options.maxOpenDurationMs, Math.max(this.#options.openDurationMs, Math.ceil(this.#openDurationMs * this.#options.backoffMultiplier)));
    this.#openedAt = now;
    this.#opened += 1;
    this.#transition('open', reason, now);
  }

  #transition(to: CircuitState, reason: CircuitTransition['reason'], now: number): void {
    const from = this.#state;
    if (from === to) return;
    this.#state = to;
    this.#history.push(Object.freeze({ at: now, from, to, reason, openDurationMs: this.#openDurationMs }));
    if (this.#history.length > this.#options.historyLimit) this.#history.splice(0, this.#history.length - this.#options.historyLimit);
  }

  #failureRate(): number {
    if (this.#samples.length === 0) return 0;
    return this.#samples.reduce((sum, sample) => sum + sample.weight, 0) / this.#samples.length;
  }

  #activeProbeCount(): number {
    let count = 0;
    for (const lease of this.#leases.values()) if (lease.probe) count += 1;
    return count;
  }

  public snapshot(): CircuitSnapshot {
    const now = this.#now();
    this.#refresh(now);
    return Object.freeze({
      state: this.#state,
      samples: this.#samples.length,
      weightedFailures: this.#samples.reduce((sum, sample) => sum + sample.weight, 0),
      failureRate: this.#failureRate(),
      activeProbes: this.#activeProbeCount(),
      successfulProbes: this.#successfulProbes,
      rejected: this.#rejected,
      opened: this.#opened,
      currentOpenDurationMs: this.#openDurationMs,
      reopenAt: this.#state === 'open' && this.#openedAt !== null ? this.#openedAt + this.#openDurationMs : null,
    });
  }

  public history(): readonly CircuitTransition[] {
    return Object.freeze(this.#history.map(entry => Object.freeze({ ...entry })));
  }

  public reset(): void {
    const now = this.#now();
    const from = this.#state;
    this.#samples.length = 0;
    this.#leases.clear();
    this.#successfulProbes = 0;
    this.#openedAt = null;
    this.#openDurationMs = this.#options.openDurationMs;
    this.#state = 'closed';
    if (from !== 'closed') {
      this.#history.push(Object.freeze({ at: now, from, to: 'closed', reason: 'reset', openDurationMs: this.#openDurationMs }));
      if (this.#history.length > this.#options.historyLimit) this.#history.splice(0, this.#history.length - this.#options.historyLimit);
    }
  }
}
