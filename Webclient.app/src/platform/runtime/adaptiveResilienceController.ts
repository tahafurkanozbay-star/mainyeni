import { LoadSheddingPolicy, type LoadSheddingDecision, type LoadSheddingPriority } from './loadSheddingPolicy';

export interface ResilienceClock { now(): number; }
export interface ResilienceSample { readonly latencyMs: number; readonly success: boolean; }
export interface ResilienceControllerOptions {
  readonly minConcurrency: number;
  readonly maxConcurrency: number;
  readonly initialConcurrency: number;
  readonly queueCapacity: number;
  readonly targetLatencyMs: number;
  readonly errorRateLimit: number;
  readonly sampleWindow: number;
  readonly recoveryStep: number;
  readonly pressureDecreaseFactor: number;
  readonly retryBudgetRatio: number;
  readonly retryBudgetMinimum: number;
  readonly retryBudgetMaximum: number;
  readonly cooldownMs: number;
}
export interface ResilienceSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly concurrencyLimit: number;
  readonly sampleCount: number;
  readonly latencyP95Ms: number;
  readonly errorRate: number;
  readonly retryTokens: number;
  readonly admitted: number;
  readonly rejected: number;
  readonly completed: number;
  readonly failed: number;
  readonly adjustments: number;
}
export interface AdmissionDecision extends LoadSheddingDecision {
  readonly concurrencyLimit: number;
  readonly retryAllowed: boolean;
}
export interface WorkLease { readonly id: number; complete(sample: ResilienceSample): void; }

type MutableCounters = { admitted: number; rejected: number; completed: number; failed: number; adjustments: number };
const defaultClock: ResilienceClock = { now: () => Date.now() };
const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite.`);
  return value;
};
const integer = (value: number, name: string, minimum: number): number => {
  finite(value, name);
  if (!Number.isInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}.`);
  return value;
};
const percentile95 = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};

/**
 * A deterministic, allocation-bounded control loop for browser runtime work.
 * It deliberately owns no timers and performs no network I/O. Callers feed
 * completion samples and ask for admission synchronously, which keeps resource
 * ownership explicit and makes teardown trivial.
 */
export class AdaptiveResilienceController {
  readonly #options: ResilienceControllerOptions;
  readonly #clock: ResilienceClock;
  readonly #samples: ResilienceSample[] = [];
  readonly #active = new Set<number>();
  readonly #counters: MutableCounters = { admitted: 0, rejected: 0, completed: 0, failed: 0, adjustments: 0 };
  #nextLeaseId = 1;
  #queued = 0;
  #limit: number;
  #retryTokens: number;
  #lastAdjustmentAt = Number.NEGATIVE_INFINITY;

  public constructor(options: ResilienceControllerOptions, clock: ResilienceClock = defaultClock) {
    this.#options = AdaptiveResilienceController.#validate(options);
    this.#clock = clock;
    this.#limit = options.initialConcurrency;
    this.#retryTokens = options.retryBudgetMinimum;
  }

  static #validate(options: ResilienceControllerOptions): ResilienceControllerOptions {
    integer(options.minConcurrency, 'minConcurrency', 1);
    integer(options.maxConcurrency, 'maxConcurrency', options.minConcurrency);
    integer(options.initialConcurrency, 'initialConcurrency', options.minConcurrency);
    if (options.initialConcurrency > options.maxConcurrency) throw new RangeError('initialConcurrency exceeds maxConcurrency.');
    integer(options.queueCapacity, 'queueCapacity', 0);
    finite(options.targetLatencyMs, 'targetLatencyMs');
    if (options.targetLatencyMs <= 0) throw new RangeError('targetLatencyMs must be positive.');
    finite(options.errorRateLimit, 'errorRateLimit');
    if (options.errorRateLimit <= 0 || options.errorRateLimit > 1) throw new RangeError('errorRateLimit must be in (0, 1].');
    integer(options.sampleWindow, 'sampleWindow', 4);
    integer(options.recoveryStep, 'recoveryStep', 1);
    finite(options.pressureDecreaseFactor, 'pressureDecreaseFactor');
    if (options.pressureDecreaseFactor <= 0 || options.pressureDecreaseFactor >= 1) throw new RangeError('pressureDecreaseFactor must be in (0, 1).');
    finite(options.retryBudgetRatio, 'retryBudgetRatio');
    if (options.retryBudgetRatio < 0 || options.retryBudgetRatio > 1) throw new RangeError('retryBudgetRatio must be in [0, 1].');
    integer(options.retryBudgetMinimum, 'retryBudgetMinimum', 0);
    integer(options.retryBudgetMaximum, 'retryBudgetMaximum', options.retryBudgetMinimum);
    integer(options.cooldownMs, 'cooldownMs', 0);
    return Object.freeze({ ...options });
  }

  public setQueued(count: number): void {
    integer(count, 'queued', 0);
    this.#queued = Math.min(count, this.#options.queueCapacity + 1);
  }

  public evaluate(priority: LoadSheddingPriority, retry = false): AdmissionDecision {
    const snapshot = this.snapshot();
    const policy = new LoadSheddingPolicy({
      maxActive: this.#limit,
      maxQueued: this.#options.queueCapacity,
      maxLatencyMs: this.#options.targetLatencyMs,
      maxErrorRate: this.#options.errorRateLimit,
    });
    const base = policy.evaluate({ active: snapshot.active, queued: snapshot.queued, latencyMs: snapshot.latencyP95Ms, errorRate: snapshot.errorRate }, priority);
    const retryAllowed = !retry || this.#retryTokens > 0;
    const admitted = base.admitted && snapshot.active < this.#limit && retryAllowed;
    const reason = admitted ? base.reason : (!retryAllowed ? 'errors' : snapshot.active >= this.#limit ? 'capacity' : base.reason);
    return { ...base, admitted, reason, concurrencyLimit: this.#limit, retryAllowed };
  }

  public acquire(priority: LoadSheddingPriority, retry = false): WorkLease | null {
    const decision = this.evaluate(priority, retry);
    if (!decision.admitted) {
      this.#counters.rejected += 1;
      return null;
    }
    if (retry) this.#retryTokens = Math.max(0, this.#retryTokens - 1);
    const id = this.#nextLeaseId++;
    this.#active.add(id);
    this.#counters.admitted += 1;
    let settled = false;
    return Object.freeze({
      id,
      complete: (sample: ResilienceSample) => {
        if (settled) return;
        this.#complete(id, sample);
        settled = true;
      },
    });
  }

  #complete(id: number, sample: ResilienceSample): void {
    if (!this.#active.has(id)) return;
    finite(sample.latencyMs, 'latencyMs');
    if (sample.latencyMs < 0) throw new RangeError('latencyMs cannot be negative.');
    this.#active.delete(id);
    this.#samples.push(Object.freeze({ latencyMs: sample.latencyMs, success: sample.success }));
    if (this.#samples.length > this.#options.sampleWindow) this.#samples.splice(0, this.#samples.length - this.#options.sampleWindow);
    this.#counters.completed += 1;
    if (!sample.success) this.#counters.failed += 1;
    this.#replenishRetryBudget(sample.success);
    this.#adjust();
  }

  #replenishRetryBudget(success: boolean): void {
    if (!success) return;
    const earned = Math.max(1, Math.floor(this.#counters.completed * this.#options.retryBudgetRatio));
    const target = Math.min(this.#options.retryBudgetMaximum, Math.max(this.#options.retryBudgetMinimum, earned));
    this.#retryTokens = Math.max(this.#retryTokens, target);
  }

  #adjust(): void {
    if (this.#samples.length < Math.min(4, this.#options.sampleWindow)) return;
    const now = this.#clock.now();
    finite(now, 'clock.now()');
    if (now - this.#lastAdjustmentAt < this.#options.cooldownMs) return;
    const p95 = percentile95(this.#samples.map(sample => sample.latencyMs));
    const errors = this.#samples.reduce((count, sample) => count + (sample.success ? 0 : 1), 0) / this.#samples.length;
    const pressured = p95 >= this.#options.targetLatencyMs || errors >= this.#options.errorRateLimit;
    const previous = this.#limit;
    if (pressured) {
      this.#limit = Math.max(this.#options.minConcurrency, Math.floor(this.#limit * this.#options.pressureDecreaseFactor));
    } else if (this.#limit < this.#options.maxConcurrency) {
      this.#limit = Math.min(this.#options.maxConcurrency, this.#limit + this.#options.recoveryStep);
    }
    if (previous !== this.#limit) {
      this.#lastAdjustmentAt = now;
      this.#counters.adjustments += 1;
    }
  }

  public snapshot(): ResilienceSnapshot {
    const failures = this.#samples.reduce((count, sample) => count + (sample.success ? 0 : 1), 0);
    return Object.freeze({
      active: this.#active.size,
      queued: this.#queued,
      concurrencyLimit: this.#limit,
      sampleCount: this.#samples.length,
      latencyP95Ms: percentile95(this.#samples.map(sample => sample.latencyMs)),
      errorRate: this.#samples.length === 0 ? 0 : failures / this.#samples.length,
      retryTokens: this.#retryTokens,
      admitted: this.#counters.admitted,
      rejected: this.#counters.rejected,
      completed: this.#counters.completed,
      failed: this.#counters.failed,
      adjustments: this.#counters.adjustments,
    });
  }
}
