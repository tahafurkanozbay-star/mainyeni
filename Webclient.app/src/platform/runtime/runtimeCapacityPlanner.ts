export type CapacityLane = 'critical' | 'interactive' | 'background';
export type CapacityPressure = 'healthy' | 'warm' | 'hot' | 'critical';

export interface CapacityClock { now(): number; }
export interface CapacityPlannerOptions {
  readonly minConcurrency: number;
  readonly maxConcurrency: number;
  readonly initialConcurrency: number;
  readonly maxQueued: number;
  readonly sampleWindow: number;
  readonly targetLatencyMs: number;
  readonly latencyCriticalMultiplier: number;
  readonly errorWarmThreshold: number;
  readonly errorCriticalThreshold: number;
  readonly queueWarmRatio: number;
  readonly queueCriticalRatio: number;
  readonly decreaseFactor: number;
  readonly recoveryStep: number;
  readonly recoveryStableSamples: number;
  readonly adjustmentCooldownMs: number;
  readonly historyLimit: number;
}
export interface CapacityObservation {
  readonly latencyMs: number;
  readonly success: boolean;
  readonly queued: number;
  readonly active: number;
}
export interface CapacityLaneBudget {
  readonly lane: CapacityLane;
  readonly concurrency: number;
  readonly queue: number;
}
export interface CapacitySnapshot {
  readonly pressure: CapacityPressure;
  readonly concurrencyLimit: number;
  readonly sampleCount: number;
  readonly stableSamples: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly errorRate: number;
  readonly queueRatio: number;
  readonly observedActive: number;
  readonly observedQueued: number;
  readonly adjustments: number;
  readonly laneBudgets: Readonly<Record<CapacityLane, CapacityLaneBudget>>;
}
export interface CapacityAdjustment {
  readonly at: number;
  readonly from: number;
  readonly to: number;
  readonly pressure: CapacityPressure;
  readonly reason: 'latency' | 'errors' | 'queue' | 'recovery';
}

type StoredObservation = Readonly<CapacityObservation>;
const lanes: readonly CapacityLane[] = ['critical', 'interactive', 'background'];
const defaultClock: CapacityClock = { now: () => Date.now() };

const assertFinite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite.`);
  return value;
};
const assertInteger = (value: number, name: string, minimum: number): number => {
  assertFinite(value, name);
  if (!Number.isInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}.`);
  return value;
};
const assertRatio = (value: number, name: string, allowZero = true): number => {
  assertFinite(value, name);
  const minimum = allowZero ? 0 : Number.EPSILON;
  if (value < minimum || value > 1) throw new RangeError(`${name} must be in ${allowZero ? '[0, 1]' : '(0, 1]'}.`);
  return value;
};
const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
};
const freezeBudgets = (budgets: Record<CapacityLane, CapacityLaneBudget>): Readonly<Record<CapacityLane, CapacityLaneBudget>> =>
  Object.freeze({
    critical: Object.freeze(budgets.critical),
    interactive: Object.freeze(budgets.interactive),
    background: Object.freeze(budgets.background),
  });

/**
 * Allocation-bounded, timer-free capacity planner for shared browser runtime work.
 * Callers provide observations from their existing scheduler. The planner never
 * starts work, owns no network transport, and exposes deterministic lane budgets.
 */
export class RuntimeCapacityPlanner {
  readonly #options: CapacityPlannerOptions;
  readonly #clock: CapacityClock;
  readonly #samples: StoredObservation[] = [];
  readonly #history: CapacityAdjustment[] = [];
  #limit: number;
  #stableSamples = 0;
  #lastAdjustmentAt = Number.NEGATIVE_INFINITY;
  #adjustments = 0;

  public constructor(options: CapacityPlannerOptions, clock: CapacityClock = defaultClock) {
    this.#options = RuntimeCapacityPlanner.#validate(options);
    this.#clock = clock;
    this.#limit = options.initialConcurrency;
  }

  static #validate(options: CapacityPlannerOptions): CapacityPlannerOptions {
    assertInteger(options.minConcurrency, 'minConcurrency', 1);
    assertInteger(options.maxConcurrency, 'maxConcurrency', options.minConcurrency);
    assertInteger(options.initialConcurrency, 'initialConcurrency', options.minConcurrency);
    if (options.initialConcurrency > options.maxConcurrency) throw new RangeError('initialConcurrency exceeds maxConcurrency.');
    assertInteger(options.maxQueued, 'maxQueued', 1);
    assertInteger(options.sampleWindow, 'sampleWindow', 4);
    assertFinite(options.targetLatencyMs, 'targetLatencyMs');
    if (options.targetLatencyMs <= 0) throw new RangeError('targetLatencyMs must be positive.');
    assertFinite(options.latencyCriticalMultiplier, 'latencyCriticalMultiplier');
    if (options.latencyCriticalMultiplier <= 1) throw new RangeError('latencyCriticalMultiplier must be > 1.');
    assertRatio(options.errorWarmThreshold, 'errorWarmThreshold');
    assertRatio(options.errorCriticalThreshold, 'errorCriticalThreshold', false);
    if (options.errorWarmThreshold >= options.errorCriticalThreshold) throw new RangeError('error thresholds must increase.');
    assertRatio(options.queueWarmRatio, 'queueWarmRatio');
    assertRatio(options.queueCriticalRatio, 'queueCriticalRatio', false);
    if (options.queueWarmRatio >= options.queueCriticalRatio) throw new RangeError('queue thresholds must increase.');
    assertRatio(options.decreaseFactor, 'decreaseFactor', false);
    if (options.decreaseFactor >= 1) throw new RangeError('decreaseFactor must be < 1.');
    assertInteger(options.recoveryStep, 'recoveryStep', 1);
    assertInteger(options.recoveryStableSamples, 'recoveryStableSamples', 1);
    assertInteger(options.adjustmentCooldownMs, 'adjustmentCooldownMs', 0);
    assertInteger(options.historyLimit, 'historyLimit', 1);
    return Object.freeze({ ...options });
  }

  public observe(observation: CapacityObservation): CapacitySnapshot {
    const sample = RuntimeCapacityPlanner.#validateObservation(observation);
    this.#samples.push(sample);
    if (this.#samples.length > this.#options.sampleWindow) this.#samples.splice(0, this.#samples.length - this.#options.sampleWindow);
    const pressure = this.#classifyPressure();
    this.#stableSamples = pressure === 'healthy' ? this.#stableSamples + 1 : 0;
    this.#adjust(pressure);
    return this.snapshot();
  }

  static #validateObservation(observation: CapacityObservation): StoredObservation {
    assertFinite(observation.latencyMs, 'latencyMs');
    if (observation.latencyMs < 0) throw new RangeError('latencyMs cannot be negative.');
    assertInteger(observation.queued, 'queued', 0);
    assertInteger(observation.active, 'active', 0);
    return Object.freeze({ ...observation });
  }

  #metrics(): { latencyP50Ms: number; latencyP95Ms: number; errorRate: number; queueRatio: number; active: number; queued: number } {
    if (this.#samples.length === 0) return { latencyP50Ms: 0, latencyP95Ms: 0, errorRate: 0, queueRatio: 0, active: 0, queued: 0 };
    const latencies = this.#samples.map(sample => sample.latencyMs);
    const latest = this.#samples.at(-1)!;
    const failures = this.#samples.reduce((count, sample) => count + (sample.success ? 0 : 1), 0);
    return {
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
      errorRate: failures / this.#samples.length,
      queueRatio: Math.min(1, latest.queued / this.#options.maxQueued),
      active: latest.active,
      queued: latest.queued,
    };
  }

  #classifyPressure(): CapacityPressure {
    const metrics = this.#metrics();
    if (
      metrics.latencyP95Ms >= this.#options.targetLatencyMs * this.#options.latencyCriticalMultiplier ||
      metrics.errorRate >= this.#options.errorCriticalThreshold ||
      metrics.queueRatio >= this.#options.queueCriticalRatio
    ) return 'critical';
    if (
      metrics.latencyP95Ms >= this.#options.targetLatencyMs ||
      metrics.errorRate >= this.#options.errorWarmThreshold ||
      metrics.queueRatio >= this.#options.queueWarmRatio
    ) return 'hot';
    if (
      metrics.latencyP95Ms >= this.#options.targetLatencyMs * 0.8 ||
      metrics.errorRate > 0 ||
      metrics.queueRatio > 0
    ) return 'warm';
    return 'healthy';
  }

  #adjust(pressure: CapacityPressure): void {
    const now = assertFinite(this.#clock.now(), 'clock.now()');
    if (now - this.#lastAdjustmentAt < this.#options.adjustmentCooldownMs) return;
    const previous = this.#limit;
    let reason: CapacityAdjustment['reason'] = 'recovery';
    if (pressure === 'critical' || pressure === 'hot') {
      this.#limit = Math.max(this.#options.minConcurrency, Math.floor(this.#limit * this.#options.decreaseFactor));
      const metrics = this.#metrics();
      reason = metrics.errorRate >= this.#options.errorWarmThreshold ? 'errors' : metrics.queueRatio >= this.#options.queueWarmRatio ? 'queue' : 'latency';
    } else if (pressure === 'healthy' && this.#stableSamples >= this.#options.recoveryStableSamples) {
      this.#limit = Math.min(this.#options.maxConcurrency, this.#limit + this.#options.recoveryStep);
      this.#stableSamples = 0;
    }
    if (this.#limit === previous) return;
    this.#lastAdjustmentAt = now;
    this.#adjustments += 1;
    this.#history.push(Object.freeze({ at: now, from: previous, to: this.#limit, pressure, reason }));
    if (this.#history.length > this.#options.historyLimit) this.#history.splice(0, this.#history.length - this.#options.historyLimit);
  }

  #laneBudgets(): Readonly<Record<CapacityLane, CapacityLaneBudget>> {
    const pressure = this.#classifyPressure();
    const critical = Math.max(1, Math.ceil(this.#limit * 0.25));
    const interactive = Math.max(pressure === 'critical' ? 0 : 1, Math.floor(this.#limit * (pressure === 'healthy' ? 0.6 : 0.5)));
    const background = Math.max(0, this.#limit - critical - interactive);
    const queueBase = this.#options.maxQueued;
    return freezeBudgets({
      critical: { lane: 'critical', concurrency: critical, queue: Math.max(1, Math.ceil(queueBase * 0.2)) },
      interactive: { lane: 'interactive', concurrency: interactive, queue: pressure === 'critical' ? 0 : Math.ceil(queueBase * 0.5) },
      background: { lane: 'background', concurrency: pressure === 'critical' ? 0 : background, queue: pressure === 'healthy' ? Math.floor(queueBase * 0.3) : 0 },
    });
  }

  public budgetFor(lane: CapacityLane): CapacityLaneBudget {
    if (!lanes.includes(lane)) throw new RangeError(`Unknown capacity lane: ${String(lane)}.`);
    return this.#laneBudgets()[lane];
  }

  public snapshot(): CapacitySnapshot {
    const metrics = this.#metrics();
    return Object.freeze({
      pressure: this.#classifyPressure(),
      concurrencyLimit: this.#limit,
      sampleCount: this.#samples.length,
      stableSamples: this.#stableSamples,
      latencyP50Ms: metrics.latencyP50Ms,
      latencyP95Ms: metrics.latencyP95Ms,
      errorRate: metrics.errorRate,
      queueRatio: metrics.queueRatio,
      observedActive: metrics.active,
      observedQueued: metrics.queued,
      adjustments: this.#adjustments,
      laneBudgets: this.#laneBudgets(),
    });
  }

  public history(): readonly CapacityAdjustment[] {
    return Object.freeze(this.#history.map(entry => Object.freeze({ ...entry })));
  }

  public reset(): void {
    this.#samples.length = 0;
    this.#history.length = 0;
    this.#limit = this.#options.initialConcurrency;
    this.#stableSamples = 0;
    this.#lastAdjustmentAt = Number.NEGATIVE_INFINITY;
    this.#adjustments = 0;
  }
}
