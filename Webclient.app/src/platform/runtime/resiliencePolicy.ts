export type ResilienceOutcome = 'success' | 'failure' | 'timeout' | 'cancelled';
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ResiliencePolicyOptions {
  failureThreshold?: number;
  successThreshold?: number;
  openDurationMs?: number;
  windowSize?: number;
  minimumSamples?: number;
  maxHalfOpenProbes?: number;
  now?: () => number;
}

export interface ResiliencePolicySnapshot {
  state: CircuitState;
  samples: number;
  failures: number;
  successes: number;
  consecutiveSuccesses: number;
  halfOpenInFlight: number;
  openedAt: number | null;
  rejected: number;
}

export interface ResiliencePermit {
  readonly admittedAt: number;
  readonly probe: boolean;
  complete(outcome: ResilienceOutcome): void;
}

const clampInt = (value: number | undefined, fallback: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.floor(value ?? fallback)));

export class ResiliencePolicy {
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly openDurationMs: number;
  private readonly windowSize: number;
  private readonly minimumSamples: number;
  private readonly maxHalfOpenProbes: number;
  private readonly now: () => number;
  private readonly outcomes: ResilienceOutcome[] = [];
  private state: CircuitState = 'closed';
  private openedAt: number | null = null;
  private consecutiveSuccesses = 0;
  private halfOpenInFlight = 0;
  private rejected = 0;
  private epoch = 0;

  constructor(options: ResiliencePolicyOptions = {}) {
    this.failureThreshold = clampInt(options.failureThreshold, 5, 1, 100);
    this.successThreshold = clampInt(options.successThreshold, 2, 1, 100);
    this.openDurationMs = clampInt(options.openDurationMs, 15_000, 1, 3_600_000);
    this.windowSize = clampInt(options.windowSize, 20, 1, 1_000);
    this.minimumSamples = Math.min(this.windowSize, clampInt(options.minimumSamples, 5, 1, 1_000));
    this.maxHalfOpenProbes = clampInt(options.maxHalfOpenProbes, 1, 1, 100);
    this.now = options.now ?? Date.now;
  }

  acquire(): ResiliencePermit | null {
    this.refreshState();
    const probe = this.state === 'half-open';
    if (this.state === 'open' || (probe && this.halfOpenInFlight >= this.maxHalfOpenProbes)) {
      this.rejected += 1;
      return null;
    }
    if (probe) this.halfOpenInFlight += 1;
    const permitEpoch = this.epoch;
    let completed = false;
    const admittedAt = this.now();
    return {
      admittedAt,
      probe,
      complete: (outcome) => {
        if (completed) return;
        completed = true;
        // A reset/trip/close starts a new policy generation. Results from permits
        // issued by an older generation must not mutate the current circuit state.
        if (permitEpoch !== this.epoch) return;
        if (probe) this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
        this.record(outcome);
      },
    };
  }

  snapshot(): ResiliencePolicySnapshot {
    this.refreshState();
    const failures = this.outcomes.filter((value) => value === 'failure' || value === 'timeout').length;
    return {
      state: this.state,
      samples: this.outcomes.length,
      failures,
      successes: this.outcomes.filter((value) => value === 'success').length,
      consecutiveSuccesses: this.consecutiveSuccesses,
      halfOpenInFlight: this.halfOpenInFlight,
      openedAt: this.openedAt,
      rejected: this.rejected,
    };
  }

  reset(): void {
    this.epoch += 1;
    this.outcomes.length = 0;
    this.state = 'closed';
    this.openedAt = null;
    this.consecutiveSuccesses = 0;
    this.halfOpenInFlight = 0;
    this.rejected = 0;
  }

  private refreshState(): void {
    if (this.state !== 'open' || this.openedAt === null) return;
    if (this.now() - this.openedAt >= this.openDurationMs) {
      this.epoch += 1;
      this.state = 'half-open';
      this.consecutiveSuccesses = 0;
      this.halfOpenInFlight = 0;
    }
  }

  private record(outcome: ResilienceOutcome): void {
    if (outcome === 'cancelled') return;
    this.outcomes.push(outcome);
    if (this.outcomes.length > this.windowSize) this.outcomes.splice(0, this.outcomes.length - this.windowSize);

    if (this.state === 'half-open') {
      if (outcome === 'success') {
        this.consecutiveSuccesses += 1;
        if (this.consecutiveSuccesses >= this.successThreshold) {
          this.epoch += 1;
          this.state = 'closed';
          this.openedAt = null;
          this.consecutiveSuccesses = 0;
          this.outcomes.length = 0;
          this.halfOpenInFlight = 0;
        }
      } else {
        this.trip();
      }
      return;
    }

    if (outcome === 'success') this.consecutiveSuccesses += 1;
    else this.consecutiveSuccesses = 0;

    if (this.outcomes.length < this.minimumSamples) return;
    const failures = this.outcomes.filter((value) => value === 'failure' || value === 'timeout').length;
    if (failures >= this.failureThreshold) this.trip();
  }

  private trip(): void {
    this.epoch += 1;
    this.state = 'open';
    this.openedAt = this.now();
    this.consecutiveSuccesses = 0;
    this.halfOpenInFlight = 0;
  }
}
