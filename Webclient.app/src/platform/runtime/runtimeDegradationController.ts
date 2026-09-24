import type { RuntimeFailureBudgetLane } from './runtimeFailureBudget';

export type RuntimeDegradationLevel = 'normal' | 'constrained' | 'degraded' | 'emergency';
export type RuntimeDegradationSignal = 'failure' | 'latency' | 'saturation' | 'memory';

export interface RuntimeDegradationPolicy {
  readonly windowSize: number;
  readonly minimumSamples: number;
  readonly constrainedThreshold: number;
  readonly degradedThreshold: number;
  readonly emergencyThreshold: number;
  readonly recoveryThreshold: number;
  readonly recoverySamples: number;
  readonly maximumHistory: number;
}

export interface RuntimeDegradationSample {
  readonly lane: RuntimeFailureBudgetLane;
  readonly signal: RuntimeDegradationSignal;
  readonly pressure: number;
  readonly at: number;
}

export interface RuntimeDegradationLaneSnapshot {
  readonly lane: RuntimeFailureBudgetLane;
  readonly level: RuntimeDegradationLevel;
  readonly score: number;
  readonly samples: number;
  readonly healthyStreak: number;
  readonly lastChangedAt: number | null;
}

export interface RuntimeDegradationSnapshot {
  readonly sequence: number;
  readonly level: RuntimeDegradationLevel;
  readonly lanes: Readonly<Record<RuntimeFailureBudgetLane, RuntimeDegradationLaneSnapshot>>;
}

export interface RuntimeDegradationEvent {
  readonly sequence: number;
  readonly lane: RuntimeFailureBudgetLane;
  readonly from: RuntimeDegradationLevel;
  readonly to: RuntimeDegradationLevel;
  readonly score: number;
  readonly at: number;
}

interface StoredSample {
  signal: RuntimeDegradationSignal;
  pressure: number;
}

interface LaneState {
  level: RuntimeDegradationLevel;
  samples: StoredSample[];
  healthyStreak: number;
  lastChangedAt: number | null;
  lastAt: number | null;
}

const LANES: readonly RuntimeFailureBudgetLane[] = Object.freeze(['critical', 'interactive', 'background']);
const SIGNALS: readonly RuntimeDegradationSignal[] = Object.freeze(['failure', 'latency', 'saturation', 'memory']);
const LEVEL_WEIGHT: Readonly<Record<RuntimeDegradationLevel, number>> = Object.freeze({ normal: 0, constrained: 1, degraded: 2, emergency: 3 });
const SIGNAL_WEIGHT: Readonly<Record<RuntimeDegradationSignal, number>> = Object.freeze({ failure: 1, latency: 0.85, saturation: 0.95, memory: 1 });

const DEFAULT_POLICY: RuntimeDegradationPolicy = Object.freeze({
  windowSize: 24,
  minimumSamples: 6,
  constrainedThreshold: 0.45,
  degradedThreshold: 0.65,
  emergencyThreshold: 0.85,
  recoveryThreshold: 0.3,
  recoverySamples: 4,
  maximumHistory: 128,
});

const integer = (value: number, name: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
};

const rate = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  return value;
};

const normalizePolicy = (input: Partial<RuntimeDegradationPolicy>): RuntimeDegradationPolicy => {
  const policy = Object.freeze({
    windowSize: integer(input.windowSize ?? DEFAULT_POLICY.windowSize, 'windowSize', 1, 10_000),
    minimumSamples: integer(input.minimumSamples ?? DEFAULT_POLICY.minimumSamples, 'minimumSamples', 1, 10_000),
    constrainedThreshold: rate(input.constrainedThreshold ?? DEFAULT_POLICY.constrainedThreshold, 'constrainedThreshold'),
    degradedThreshold: rate(input.degradedThreshold ?? DEFAULT_POLICY.degradedThreshold, 'degradedThreshold'),
    emergencyThreshold: rate(input.emergencyThreshold ?? DEFAULT_POLICY.emergencyThreshold, 'emergencyThreshold'),
    recoveryThreshold: rate(input.recoveryThreshold ?? DEFAULT_POLICY.recoveryThreshold, 'recoveryThreshold'),
    recoverySamples: integer(input.recoverySamples ?? DEFAULT_POLICY.recoverySamples, 'recoverySamples', 1, 10_000),
    maximumHistory: integer(input.maximumHistory ?? DEFAULT_POLICY.maximumHistory, 'maximumHistory', 0, 10_000),
  });
  if (policy.minimumSamples > policy.windowSize) throw new RangeError('minimumSamples must not exceed windowSize');
  if (!(policy.recoveryThreshold < policy.constrainedThreshold && policy.constrainedThreshold < policy.degradedThreshold && policy.degradedThreshold < policy.emergencyThreshold)) {
    throw new RangeError('degradation thresholds must be strictly ordered');
  }
  return policy;
};

const newLaneState = (): LaneState => ({ level: 'normal', samples: [], healthyStreak: 0, lastChangedAt: null, lastAt: null });

const assertLane = (lane: RuntimeFailureBudgetLane): void => {
  if (!LANES.includes(lane)) throw new TypeError(`unsupported degradation lane: ${String(lane)}`);
};

const assertSignal = (signal: RuntimeDegradationSignal): void => {
  if (!SIGNALS.includes(signal)) throw new TypeError(`unsupported degradation signal: ${String(signal)}`);
};

const frozenLane = (lane: RuntimeFailureBudgetLane, state: LaneState, score: number): RuntimeDegradationLaneSnapshot => Object.freeze({
  lane,
  level: state.level,
  score,
  samples: state.samples.length,
  healthyStreak: state.healthyStreak,
  lastChangedAt: state.lastChangedAt,
});

export class RuntimeDegradationController {
  readonly #policy: RuntimeDegradationPolicy;
  readonly #lanes: Record<RuntimeFailureBudgetLane, LaneState> = {
    critical: newLaneState(), interactive: newLaneState(), background: newLaneState(),
  };
  readonly #history: RuntimeDegradationEvent[] = [];
  #sequence = 0;

  constructor(policy: Partial<RuntimeDegradationPolicy> = {}) {
    this.#policy = normalizePolicy(policy);
  }

  policy(): RuntimeDegradationPolicy { return this.#policy; }

  record(sample: RuntimeDegradationSample): RuntimeDegradationLaneSnapshot {
    assertLane(sample.lane);
    assertSignal(sample.signal);
    rate(sample.pressure, 'pressure');
    if (!Number.isSafeInteger(sample.at) || sample.at < 0) throw new RangeError('at must be a non-negative safe integer');
    const state = this.#lanes[sample.lane];
    if (state.lastAt !== null && sample.at < state.lastAt) throw new RangeError('sample time must be monotonic within a lane');
    state.lastAt = sample.at;
    state.samples.push({ signal: sample.signal, pressure: sample.pressure });
    if (state.samples.length > this.#policy.windowSize) state.samples.splice(0, state.samples.length - this.#policy.windowSize);
    const score = this.#score(state);
    const next = this.#nextLevel(state, score);
    if (next !== state.level) this.#transition(sample.lane, state, next, score, sample.at);
    return frozenLane(sample.lane, state, score);
  }

  recordBatch(samples: readonly RuntimeDegradationSample[]): RuntimeDegradationSnapshot {
    if (samples.length > 10_000) throw new RangeError('degradation batch must contain at most 10000 samples');
    for (const sample of samples) this.record(sample);
    return this.snapshot();
  }

  snapshot(): RuntimeDegradationSnapshot {
    const lanes = Object.freeze({
      critical: frozenLane('critical', this.#lanes.critical, this.#score(this.#lanes.critical)),
      interactive: frozenLane('interactive', this.#lanes.interactive, this.#score(this.#lanes.interactive)),
      background: frozenLane('background', this.#lanes.background, this.#score(this.#lanes.background)),
    });
    let level: RuntimeDegradationLevel = 'normal';
    for (const lane of LANES) if (LEVEL_WEIGHT[lanes[lane].level] > LEVEL_WEIGHT[level]) level = lanes[lane].level;
    return Object.freeze({ sequence: this.#sequence, level, lanes });
  }

  history(): readonly RuntimeDegradationEvent[] { return Object.freeze(this.#history.map((event) => Object.freeze({ ...event }))); }

  reset(lane?: RuntimeFailureBudgetLane): void {
    if (lane !== undefined) {
      assertLane(lane);
      this.#lanes[lane] = newLaneState();
    } else {
      for (const current of LANES) this.#lanes[current] = newLaneState();
    }
    this.#sequence += 1;
  }

  clearHistory(): void { this.#history.length = 0; }

  #score(state: LaneState): number {
    if (state.samples.length === 0) return 0;
    let weighted = 0;
    let weights = 0;
    for (const sample of state.samples) {
      const weight = SIGNAL_WEIGHT[sample.signal];
      weighted += sample.pressure * weight;
      weights += weight;
    }
    return weights === 0 ? 0 : weighted / weights;
  }

  #nextLevel(state: LaneState, score: number): RuntimeDegradationLevel {
    if (state.samples.length < this.#policy.minimumSamples) return state.level;
    let pressured: RuntimeDegradationLevel = 'normal';
    if (score >= this.#policy.emergencyThreshold) pressured = 'emergency';
    else if (score >= this.#policy.degradedThreshold) pressured = 'degraded';
    else if (score >= this.#policy.constrainedThreshold) pressured = 'constrained';
    if (LEVEL_WEIGHT[pressured] > LEVEL_WEIGHT[state.level]) {
      state.healthyStreak = 0;
      return pressured;
    }
    if (score <= this.#policy.recoveryThreshold) state.healthyStreak += 1;
    else state.healthyStreak = 0;
    if (state.healthyStreak < this.#policy.recoverySamples || state.level === 'normal') return state.level;
    state.healthyStreak = 0;
    if (state.level === 'emergency') return 'degraded';
    if (state.level === 'degraded') return 'constrained';
    return 'normal';
  }

  #transition(lane: RuntimeFailureBudgetLane, state: LaneState, to: RuntimeDegradationLevel, score: number, at: number): void {
    const from = state.level;
    state.level = to;
    state.lastChangedAt = at;
    this.#sequence += 1;
    if (this.#policy.maximumHistory === 0) return;
    this.#history.push(Object.freeze({ sequence: this.#sequence, lane, from, to, score, at }));
    if (this.#history.length > this.#policy.maximumHistory) this.#history.splice(0, this.#history.length - this.#policy.maximumHistory);
  }
}
