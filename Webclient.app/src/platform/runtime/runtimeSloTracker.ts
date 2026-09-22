export type SloLane = 'critical' | 'interactive' | 'background';
export type SloStatus = 'unknown' | 'healthy' | 'at-risk' | 'exhausted';

export interface SloObservation {
  readonly at: number;
  readonly lane: SloLane;
  readonly latencyMs: number;
  readonly success: boolean;
}

export interface RuntimeSloConfig {
  readonly windowSize: number;
  readonly minimumSamples: number;
  readonly targetSuccessRate: number;
  readonly targetLatencyMs: number;
  readonly burnWarning: number;
  readonly burnCritical: number;
  readonly historySize: number;
}

export interface SloLaneSnapshot {
  readonly lane: SloLane;
  readonly samples: number;
  readonly successes: number;
  readonly failures: number;
  readonly successRate: number;
  readonly p95LatencyMs: number;
  readonly errorBudget: number;
  readonly errorBudgetConsumed: number;
  readonly burnRate: number;
  readonly status: SloStatus;
}

export interface SloTransition {
  readonly at: number;
  readonly lane: SloLane;
  readonly from: SloStatus;
  readonly to: SloStatus;
  readonly burnRate: number;
}

export interface RuntimeSloSnapshot {
  readonly totalSamples: number;
  readonly lanes: Readonly<Record<SloLane, SloLaneSnapshot>>;
  readonly history: readonly SloTransition[];
}

const LANES: readonly SloLane[] = ['critical', 'interactive', 'background'];

const DEFAULT_CONFIG: RuntimeSloConfig = {
  windowSize: 100,
  minimumSamples: 10,
  targetSuccessRate: 0.99,
  targetLatencyMs: 500,
  burnWarning: 1,
  burnCritical: 2,
  historySize: 32,
};

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function validateConfig(input: Partial<RuntimeSloConfig>): RuntimeSloConfig {
  const config = { ...DEFAULT_CONFIG, ...input };
  positiveInteger(config.windowSize, 'windowSize');
  positiveInteger(config.minimumSamples, 'minimumSamples');
  positiveInteger(config.historySize, 'historySize');
  if (config.minimumSamples > config.windowSize) throw new RangeError('minimumSamples cannot exceed windowSize');
  finite(config.targetSuccessRate, 'targetSuccessRate');
  if (config.targetSuccessRate <= 0 || config.targetSuccessRate >= 1) throw new RangeError('targetSuccessRate must be between 0 and 1');
  finite(config.targetLatencyMs, 'targetLatencyMs');
  if (config.targetLatencyMs <= 0) throw new RangeError('targetLatencyMs must be positive');
  finite(config.burnWarning, 'burnWarning');
  finite(config.burnCritical, 'burnCritical');
  if (config.burnWarning <= 0 || config.burnCritical <= config.burnWarning) throw new RangeError('burn thresholds must be positive and ordered');
  return Object.freeze(config);
}

function frozenLane(snapshot: SloLaneSnapshot): SloLaneSnapshot {
  return Object.freeze(snapshot);
}

/**
 * Deterministic, bounded SLO evidence tracker for local runtime operations.
 * It owns no timer, transport, persistence, telemetry, Promise, or AbortSignal.
 * Callers feed completed observations and decide whether/how diagnostics leave the process.
 */
export class RuntimeSloTracker {
  readonly #config: RuntimeSloConfig;
  readonly #samples = new Map<SloLane, SloObservation[]>(LANES.map((lane) => [lane, []]));
  readonly #statuses = new Map<SloLane, SloStatus>(LANES.map((lane) => [lane, 'unknown']));
  readonly #history: SloTransition[] = [];
  #lastObservedAt: number | null = null;

  public constructor(config: Partial<RuntimeSloConfig> = {}) {
    this.#config = validateConfig(config);
  }

  public observe(input: SloObservation): RuntimeSloSnapshot {
    const observation = this.#validateObservation(input);
    const samples = this.#samples.get(observation.lane);
    if (!samples) throw new Error(`unsupported lane: ${observation.lane}`);
    samples.push(observation);
    if (samples.length > this.#config.windowSize) samples.shift();
    this.#lastObservedAt = observation.at;
    this.#updateStatus(observation.lane, observation.at);
    return this.snapshot();
  }

  public snapshot(): RuntimeSloSnapshot {
    const critical = this.#laneSnapshot('critical');
    const interactive = this.#laneSnapshot('interactive');
    const background = this.#laneSnapshot('background');
    const lanes = Object.freeze({ critical, interactive, background });
    return Object.freeze({
      totalSamples: critical.samples + interactive.samples + background.samples,
      lanes,
      history: Object.freeze(this.#history.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  public reset(lane?: SloLane): void {
    if (lane === undefined) {
      for (const current of LANES) {
        this.#samples.get(current)?.splice(0);
        this.#statuses.set(current, 'unknown');
      }
      this.#history.length = 0;
      this.#lastObservedAt = null;
      return;
    }
    const samples = this.#samples.get(lane);
    if (!samples) throw new RangeError(`unsupported lane: ${String(lane)}`);
    samples.length = 0;
    this.#statuses.set(lane, 'unknown');
    for (let index = this.#history.length - 1; index >= 0; index -= 1) {
      if (this.#history[index]?.lane === lane) this.#history.splice(index, 1);
    }
    if (LANES.every((current) => (this.#samples.get(current)?.length ?? 0) === 0)) this.#lastObservedAt = null;
  }

  #validateObservation(input: SloObservation): SloObservation {
    finite(input.at, 'at');
    if (input.at < 0) throw new RangeError('at cannot be negative');
    if (this.#lastObservedAt !== null && input.at < this.#lastObservedAt) throw new RangeError('observations must be monotonic');
    if (!LANES.includes(input.lane)) throw new RangeError(`unsupported lane: ${String(input.lane)}`);
    finite(input.latencyMs, 'latencyMs');
    if (input.latencyMs < 0) throw new RangeError('latencyMs cannot be negative');
    if (typeof input.success !== 'boolean') throw new TypeError('success must be boolean');
    return Object.freeze({ ...input });
  }

  #laneSnapshot(lane: SloLane): SloLaneSnapshot {
    const samples = this.#samples.get(lane) ?? [];
    const successes = samples.reduce((count, sample) => count + (sample.success ? 1 : 0), 0);
    const failures = samples.length - successes;
    const successRate = samples.length === 0 ? 1 : successes / samples.length;
    const allowedFailureRate = 1 - this.#config.targetSuccessRate;
    const observedFailureRate = samples.length === 0 ? 0 : failures / samples.length;
    const errorBudgetConsumed = allowedFailureRate === 0 ? 0 : observedFailureRate / allowedFailureRate;
    const latencyViolations = samples.reduce((count, sample) => count + (sample.latencyMs > this.#config.targetLatencyMs ? 1 : 0), 0);
    const latencyViolationRate = samples.length === 0 ? 0 : latencyViolations / samples.length;
    const latencyBurn = allowedFailureRate === 0 ? 0 : latencyViolationRate / allowedFailureRate;
    const burnRate = Math.max(errorBudgetConsumed, latencyBurn);
    return frozenLane({
      lane,
      samples: samples.length,
      successes,
      failures,
      successRate,
      p95LatencyMs: percentile95(samples.map((sample) => sample.latencyMs)),
      errorBudget: allowedFailureRate,
      errorBudgetConsumed,
      burnRate,
      status: this.#statuses.get(lane) ?? 'unknown',
    });
  }

  #deriveStatus(lane: SloLane): SloStatus {
    const snapshot = this.#laneSnapshot(lane);
    if (snapshot.samples < this.#config.minimumSamples) return 'unknown';
    if (snapshot.burnRate >= this.#config.burnCritical) return 'exhausted';
    if (snapshot.burnRate >= this.#config.burnWarning) return 'at-risk';
    return 'healthy';
  }

  #updateStatus(lane: SloLane, at: number): void {
    const previous = this.#statuses.get(lane) ?? 'unknown';
    const next = this.#deriveStatus(lane);
    if (previous === next) return;
    this.#statuses.set(lane, next);
    const burnRate = this.#laneSnapshot(lane).burnRate;
    this.#history.push(Object.freeze({ at, lane, from: previous, to: next, burnRate }));
    if (this.#history.length > this.#config.historySize) this.#history.shift();
  }
}
