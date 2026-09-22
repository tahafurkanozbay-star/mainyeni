export type OverloadLane = 'critical' | 'interactive' | 'background';
export type OverloadLevel = 'normal' | 'guarded' | 'overloaded' | 'emergency';

export interface OverloadObservation {
  readonly at: number;
  readonly latencyMs: number;
  readonly errorRate: number;
  readonly queueUtilization: number;
  readonly concurrencyUtilization: number;
}

export interface OverloadGovernorConfig {
  readonly windowSize: number;
  readonly minimumSamples: number;
  readonly guardedScore: number;
  readonly overloadedScore: number;
  readonly emergencyScore: number;
  readonly recoveryScore: number;
  readonly recoverySamples: number;
  readonly cooldownMs: number;
  readonly targetLatencyMs: number;
  readonly maxLatencyMs: number;
  readonly targetErrorRate: number;
  readonly maxErrorRate: number;
  readonly historySize: number;
}

export interface OverloadAdmission {
  readonly admitted: boolean;
  readonly level: OverloadLevel;
  readonly reason: 'admitted' | 'lane-shed' | 'emergency-shed';
  readonly score: number;
}

export interface OverloadTransition {
  readonly at: number;
  readonly from: OverloadLevel;
  readonly to: OverloadLevel;
  readonly score: number;
}

export interface OverloadDiagnostics {
  readonly level: OverloadLevel;
  readonly score: number;
  readonly sampleCount: number;
  readonly stableSamples: number;
  readonly lastTransitionAt: number | null;
  readonly p95LatencyMs: number;
  readonly meanErrorRate: number;
  readonly meanQueueUtilization: number;
  readonly meanConcurrencyUtilization: number;
  readonly history: readonly OverloadTransition[];
}

const DEFAULT_CONFIG: OverloadGovernorConfig = {
  windowSize: 24,
  minimumSamples: 6,
  guardedScore: 0.45,
  overloadedScore: 0.65,
  emergencyScore: 0.85,
  recoveryScore: 0.3,
  recoverySamples: 4,
  cooldownMs: 2_000,
  targetLatencyMs: 250,
  maxLatencyMs: 2_000,
  targetErrorRate: 0.02,
  maxErrorRate: 0.3,
  historySize: 32,
};

const LEVEL_RANK: Readonly<Record<OverloadLevel, number>> = {
  normal: 0,
  guarded: 1,
  overloaded: 2,
  emergency: 3,
};

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function bounded(value: number, name: string): number {
  finite(value, name);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function normalizePressure(value: number, target: number, maximum: number): number {
  if (value <= target) return 0;
  return clamp01((value - target) / Math.max(Number.EPSILON, maximum - target));
}

function validateConfig(input: Partial<OverloadGovernorConfig>): OverloadGovernorConfig {
  const config = { ...DEFAULT_CONFIG, ...input };
  positiveInteger(config.windowSize, 'windowSize');
  positiveInteger(config.minimumSamples, 'minimumSamples');
  positiveInteger(config.recoverySamples, 'recoverySamples');
  positiveInteger(config.historySize, 'historySize');
  if (config.minimumSamples > config.windowSize) throw new RangeError('minimumSamples cannot exceed windowSize');
  bounded(config.guardedScore, 'guardedScore');
  bounded(config.overloadedScore, 'overloadedScore');
  bounded(config.emergencyScore, 'emergencyScore');
  bounded(config.recoveryScore, 'recoveryScore');
  if (!(config.recoveryScore < config.guardedScore && config.guardedScore < config.overloadedScore && config.overloadedScore < config.emergencyScore)) {
    throw new RangeError('score thresholds must be strictly ordered');
  }
  finite(config.cooldownMs, 'cooldownMs');
  if (config.cooldownMs < 0) throw new RangeError('cooldownMs cannot be negative');
  finite(config.targetLatencyMs, 'targetLatencyMs');
  finite(config.maxLatencyMs, 'maxLatencyMs');
  if (config.targetLatencyMs <= 0 || config.maxLatencyMs <= config.targetLatencyMs) throw new RangeError('latency thresholds are invalid');
  bounded(config.targetErrorRate, 'targetErrorRate');
  bounded(config.maxErrorRate, 'maxErrorRate');
  if (config.maxErrorRate <= config.targetErrorRate) throw new RangeError('error thresholds are invalid');
  return Object.freeze(config);
}

/**
 * Aggregates local runtime pressure into a deterministic overload level.
 * It deliberately owns no timer, transport, Promise, AbortSignal, or queue.
 * Callers decide when to observe and use the returned admission policy.
 */
export class RuntimeOverloadGovernor {
  readonly #config: OverloadGovernorConfig;
  readonly #samples: OverloadObservation[] = [];
  readonly #history: OverloadTransition[] = [];
  #level: OverloadLevel = 'normal';
  #score = 0;
  #stableSamples = 0;
  #lastTransitionAt: number | null = null;
  #lastObservedAt: number | null = null;

  public constructor(config: Partial<OverloadGovernorConfig> = {}) {
    this.#config = validateConfig(config);
  }

  public observe(observation: OverloadObservation): OverloadDiagnostics {
    const sample = this.#validateObservation(observation);
    this.#samples.push(sample);
    if (this.#samples.length > this.#config.windowSize) this.#samples.shift();
    this.#lastObservedAt = sample.at;
    this.#score = this.#calculateScore();
    this.#evaluateTransition(sample.at);
    return this.diagnostics();
  }

  public admit(lane: OverloadLane): OverloadAdmission {
    let admitted = true;
    let reason: OverloadAdmission['reason'] = 'admitted';
    if (this.#level === 'emergency' && lane !== 'critical') {
      admitted = false;
      reason = 'emergency-shed';
    } else if (this.#level === 'overloaded' && lane === 'background') {
      admitted = false;
      reason = 'lane-shed';
    }
    return Object.freeze({ admitted, level: this.#level, reason, score: this.#score });
  }

  public diagnostics(): OverloadDiagnostics {
    return Object.freeze({
      level: this.#level,
      score: this.#score,
      sampleCount: this.#samples.length,
      stableSamples: this.#stableSamples,
      lastTransitionAt: this.#lastTransitionAt,
      p95LatencyMs: percentile95(this.#samples.map((sample) => sample.latencyMs)),
      meanErrorRate: mean(this.#samples.map((sample) => sample.errorRate)),
      meanQueueUtilization: mean(this.#samples.map((sample) => sample.queueUtilization)),
      meanConcurrencyUtilization: mean(this.#samples.map((sample) => sample.concurrencyUtilization)),
      history: Object.freeze(this.#history.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  public reset(): void {
    this.#samples.length = 0;
    this.#history.length = 0;
    this.#level = 'normal';
    this.#score = 0;
    this.#stableSamples = 0;
    this.#lastTransitionAt = null;
    this.#lastObservedAt = null;
  }

  #validateObservation(input: OverloadObservation): OverloadObservation {
    finite(input.at, 'at');
    if (input.at < 0) throw new RangeError('at cannot be negative');
    if (this.#lastObservedAt !== null && input.at < this.#lastObservedAt) throw new RangeError('observations must be monotonic');
    finite(input.latencyMs, 'latencyMs');
    if (input.latencyMs < 0) throw new RangeError('latencyMs cannot be negative');
    bounded(input.errorRate, 'errorRate');
    bounded(input.queueUtilization, 'queueUtilization');
    bounded(input.concurrencyUtilization, 'concurrencyUtilization');
    return Object.freeze({ ...input });
  }

  #calculateScore(): number {
    if (this.#samples.length < this.#config.minimumSamples) return 0;
    const latency = normalizePressure(percentile95(this.#samples.map((sample) => sample.latencyMs)), this.#config.targetLatencyMs, this.#config.maxLatencyMs);
    const errors = normalizePressure(mean(this.#samples.map((sample) => sample.errorRate)), this.#config.targetErrorRate, this.#config.maxErrorRate);
    const queue = normalizePressure(mean(this.#samples.map((sample) => sample.queueUtilization)), 0.55, 1);
    const concurrency = normalizePressure(mean(this.#samples.map((sample) => sample.concurrencyUtilization)), 0.65, 1);
    return clamp01(latency * 0.35 + errors * 0.3 + queue * 0.2 + concurrency * 0.15);
  }

  #targetLevel(): OverloadLevel {
    if (this.#score >= this.#config.emergencyScore) return 'emergency';
    if (this.#score >= this.#config.overloadedScore) return 'overloaded';
    if (this.#score >= this.#config.guardedScore) return 'guarded';
    return 'normal';
  }

  #evaluateTransition(at: number): void {
    const target = this.#targetLevel();
    if (LEVEL_RANK[target] > LEVEL_RANK[this.#level]) {
      this.#stableSamples = 0;
      this.#transition(target, at);
      return;
    }
    if (target === this.#level) {
      this.#stableSamples = 0;
      return;
    }
    if (this.#score > this.#config.recoveryScore) {
      this.#stableSamples = 0;
      return;
    }
    this.#stableSamples += 1;
    const cooldownElapsed = this.#lastTransitionAt === null || at - this.#lastTransitionAt >= this.#config.cooldownMs;
    if (cooldownElapsed && this.#stableSamples >= this.#config.recoverySamples) {
      const nextRank = Math.max(0, LEVEL_RANK[this.#level] - 1);
      const next = (Object.keys(LEVEL_RANK) as OverloadLevel[]).find((level) => LEVEL_RANK[level] === nextRank) ?? 'normal';
      this.#stableSamples = 0;
      this.#transition(next, at);
    }
  }

  #transition(next: OverloadLevel, at: number): void {
    if (next === this.#level) return;
    const transition = Object.freeze({ at, from: this.#level, to: next, score: this.#score });
    this.#level = next;
    this.#lastTransitionAt = at;
    this.#history.push(transition);
    if (this.#history.length > this.#config.historySize) this.#history.shift();
  }
}
