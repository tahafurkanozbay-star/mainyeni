import type { RuntimeFailureBudgetLane } from './runtimeFailureBudget';

export type RuntimeHealthEscalationSeverity = 'healthy' | 'watch' | 'degraded' | 'critical';
export type RuntimeHealthSignalKind = 'availability' | 'latency' | 'saturation' | 'integrity';

export interface RuntimeHealthEscalationPolicy {
  readonly windowSize: number;
  readonly minimumSamples: number;
  readonly watchScore: number;
  readonly degradedScore: number;
  readonly criticalScore: number;
  readonly recoverySamples: number;
  readonly maximumHistory: number;
  readonly availabilityWeight: number;
  readonly latencyWeight: number;
  readonly saturationWeight: number;
  readonly integrityWeight: number;
}

export interface RuntimeHealthSignal {
  readonly lane: RuntimeFailureBudgetLane;
  readonly kind: RuntimeHealthSignalKind;
  readonly pressure: number;
  readonly at: number;
}

export interface RuntimeHealthEscalationTransition {
  readonly lane: RuntimeFailureBudgetLane;
  readonly from: RuntimeHealthEscalationSeverity;
  readonly to: RuntimeHealthEscalationSeverity;
  readonly score: number;
  readonly sampleCount: number;
  readonly at: number;
}

export interface RuntimeHealthLaneSnapshot {
  readonly lane: RuntimeFailureBudgetLane;
  readonly severity: RuntimeHealthEscalationSeverity;
  readonly mature: boolean;
  readonly score: number;
  readonly sampleCount: number;
  readonly healthyRecoverySamples: number;
  readonly signals: Readonly<Record<RuntimeHealthSignalKind, number>>;
}

export interface RuntimeHealthEscalationSnapshot {
  readonly severity: RuntimeHealthEscalationSeverity;
  readonly lanes: Readonly<Record<RuntimeFailureBudgetLane, RuntimeHealthLaneSnapshot>>;
}

interface Sample {
  readonly kind: RuntimeHealthSignalKind;
  readonly pressure: number;
  readonly at: number;
}

interface LaneState {
  severity: RuntimeHealthEscalationSeverity;
  samples: Sample[];
  healthyRecoverySamples: number;
}

const LANES: readonly RuntimeFailureBudgetLane[] = Object.freeze(['critical', 'interactive', 'background']);
const KINDS: readonly RuntimeHealthSignalKind[] = Object.freeze(['availability', 'latency', 'saturation', 'integrity']);
const SEVERITY_ORDER: Readonly<Record<RuntimeHealthEscalationSeverity, number>> = Object.freeze({ healthy: 0, watch: 1, degraded: 2, critical: 3 });
const DEFAULT_POLICY: RuntimeHealthEscalationPolicy = Object.freeze({
  windowSize: 24,
  minimumSamples: 6,
  watchScore: 0.25,
  degradedScore: 0.5,
  criticalScore: 0.75,
  recoverySamples: 3,
  maximumHistory: 128,
  availabilityWeight: 4,
  latencyWeight: 2,
  saturationWeight: 2,
  integrityWeight: 5,
});

const boundedInteger = (value: number, name: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
};
const boundedRatio = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  return value;
};
const normalizePolicy = (input: Partial<RuntimeHealthEscalationPolicy>): RuntimeHealthEscalationPolicy => {
  const policy = Object.freeze({
    windowSize: boundedInteger(input.windowSize ?? DEFAULT_POLICY.windowSize, 'windowSize', 1, 10_000),
    minimumSamples: boundedInteger(input.minimumSamples ?? DEFAULT_POLICY.minimumSamples, 'minimumSamples', 1, 10_000),
    watchScore: boundedRatio(input.watchScore ?? DEFAULT_POLICY.watchScore, 'watchScore'),
    degradedScore: boundedRatio(input.degradedScore ?? DEFAULT_POLICY.degradedScore, 'degradedScore'),
    criticalScore: boundedRatio(input.criticalScore ?? DEFAULT_POLICY.criticalScore, 'criticalScore'),
    recoverySamples: boundedInteger(input.recoverySamples ?? DEFAULT_POLICY.recoverySamples, 'recoverySamples', 1, 10_000),
    maximumHistory: boundedInteger(input.maximumHistory ?? DEFAULT_POLICY.maximumHistory, 'maximumHistory', 0, 10_000),
    availabilityWeight: boundedInteger(input.availabilityWeight ?? DEFAULT_POLICY.availabilityWeight, 'availabilityWeight', 1, 1_000),
    latencyWeight: boundedInteger(input.latencyWeight ?? DEFAULT_POLICY.latencyWeight, 'latencyWeight', 1, 1_000),
    saturationWeight: boundedInteger(input.saturationWeight ?? DEFAULT_POLICY.saturationWeight, 'saturationWeight', 1, 1_000),
    integrityWeight: boundedInteger(input.integrityWeight ?? DEFAULT_POLICY.integrityWeight, 'integrityWeight', 1, 1_000),
  });
  if (policy.minimumSamples > policy.windowSize) throw new RangeError('minimumSamples must not exceed windowSize');
  if (!(policy.watchScore < policy.degradedScore && policy.degradedScore < policy.criticalScore)) throw new RangeError('health thresholds must be strictly increasing');
  return policy;
};
const assertLane = (lane: RuntimeFailureBudgetLane): void => {
  if (!LANES.includes(lane)) throw new TypeError(`unsupported health lane: ${String(lane)}`);
};
const assertKind = (kind: RuntimeHealthSignalKind): void => {
  if (!KINDS.includes(kind)) throw new TypeError(`unsupported health signal kind: ${String(kind)}`);
};
const assertAt = (at: number): void => {
  if (!Number.isSafeInteger(at) || at < 0) throw new RangeError('at must be a non-negative safe integer');
};

export class RuntimeHealthEscalationMatrix {
  readonly #policy: RuntimeHealthEscalationPolicy;
  readonly #lanes: Record<RuntimeFailureBudgetLane, LaneState> = {
    critical: { severity: 'healthy', samples: [], healthyRecoverySamples: 0 },
    interactive: { severity: 'healthy', samples: [], healthyRecoverySamples: 0 },
    background: { severity: 'healthy', samples: [], healthyRecoverySamples: 0 },
  };
  readonly #history: RuntimeHealthEscalationTransition[] = [];
  #lastAt: number | null = null;

  constructor(policy: Partial<RuntimeHealthEscalationPolicy> = {}) {
    this.#policy = normalizePolicy(policy);
  }

  policy(): RuntimeHealthEscalationPolicy { return this.#policy; }

  record(signal: RuntimeHealthSignal): RuntimeHealthLaneSnapshot {
    assertLane(signal.lane);
    assertKind(signal.kind);
    assertAt(signal.at);
    boundedRatio(signal.pressure, 'pressure');
    this.#advance(signal.at);
    const state = this.#lanes[signal.lane];
    state.samples.push(Object.freeze({ kind: signal.kind, pressure: signal.pressure, at: signal.at }));
    if (state.samples.length > this.#policy.windowSize) state.samples.splice(0, state.samples.length - this.#policy.windowSize);
    this.#evaluate(signal.lane, signal.at);
    return this.#laneSnapshot(signal.lane);
  }

  recordBatch(signals: readonly RuntimeHealthSignal[]): RuntimeHealthEscalationSnapshot {
    if (!Array.isArray(signals)) throw new TypeError('signals must be an array');
    if (signals.length > 10_000) throw new RangeError('signals batch exceeds 10000 entries');
    for (const signal of signals) this.record(signal);
    return this.snapshot();
  }

  snapshot(): RuntimeHealthEscalationSnapshot {
    const lanes = Object.freeze({
      critical: this.#laneSnapshot('critical'),
      interactive: this.#laneSnapshot('interactive'),
      background: this.#laneSnapshot('background'),
    });
    let severity: RuntimeHealthEscalationSeverity = 'healthy';
    for (const lane of LANES) if (SEVERITY_ORDER[lanes[lane].severity] > SEVERITY_ORDER[severity]) severity = lanes[lane].severity;
    return Object.freeze({ severity, lanes });
  }

  history(): readonly RuntimeHealthEscalationTransition[] {
    return Object.freeze(this.#history.map((entry) => Object.freeze({ ...entry })));
  }

  reset(lane?: RuntimeFailureBudgetLane): void {
    if (lane === undefined) {
      for (const laneName of LANES) this.#clearLane(laneName);
      this.#history.length = 0;
      this.#lastAt = null;
      return;
    }
    assertLane(lane);
    this.#clearLane(lane);
  }

  #clearLane(lane: RuntimeFailureBudgetLane): void {
    const state = this.#lanes[lane];
    state.severity = 'healthy';
    state.samples.length = 0;
    state.healthyRecoverySamples = 0;
  }

  #advance(at: number): void {
    if (this.#lastAt !== null && at < this.#lastAt) throw new RangeError('health matrix time must be monotonic');
    this.#lastAt = at;
  }

  #weight(kind: RuntimeHealthSignalKind): number {
    if (kind === 'availability') return this.#policy.availabilityWeight;
    if (kind === 'latency') return this.#policy.latencyWeight;
    if (kind === 'saturation') return this.#policy.saturationWeight;
    return this.#policy.integrityWeight;
  }

  #score(state: LaneState): number {
    if (state.samples.length === 0) return 0;
    let weightedPressure = 0;
    let totalWeight = 0;
    for (const sample of state.samples) {
      const weight = this.#weight(sample.kind);
      weightedPressure += sample.pressure * weight;
      totalWeight += weight;
    }
    return totalWeight === 0 ? 0 : weightedPressure / totalWeight;
  }

  #targetSeverity(score: number): RuntimeHealthEscalationSeverity {
    if (score >= this.#policy.criticalScore) return 'critical';
    if (score >= this.#policy.degradedScore) return 'degraded';
    if (score >= this.#policy.watchScore) return 'watch';
    return 'healthy';
  }

  #evaluate(lane: RuntimeFailureBudgetLane, at: number): void {
    const state = this.#lanes[lane];
    if (state.samples.length < this.#policy.minimumSamples) return;
    const score = this.#score(state);
    const target = this.#targetSeverity(score);
    const currentRank = SEVERITY_ORDER[state.severity];
    const targetRank = SEVERITY_ORDER[target];
    if (targetRank > currentRank) {
      state.healthyRecoverySamples = 0;
      this.#transition(lane, target, score, at);
      return;
    }
    if (targetRank === currentRank) {
      state.healthyRecoverySamples = 0;
      return;
    }
    state.healthyRecoverySamples += 1;
    if (state.healthyRecoverySamples < this.#policy.recoverySamples) return;
    state.healthyRecoverySamples = 0;
    const nextRank = Math.max(targetRank, currentRank - 1);
    const next = (Object.keys(SEVERITY_ORDER) as RuntimeHealthEscalationSeverity[]).find((severity) => SEVERITY_ORDER[severity] === nextRank) ?? 'healthy';
    this.#transition(lane, next, score, at);
  }

  #transition(lane: RuntimeFailureBudgetLane, to: RuntimeHealthEscalationSeverity, score: number, at: number): void {
    const state = this.#lanes[lane];
    const from = state.severity;
    if (from === to) return;
    state.severity = to;
    const transition = Object.freeze({ lane, from, to, score, sampleCount: state.samples.length, at });
    if (this.#policy.maximumHistory > 0) {
      this.#history.push(transition);
      if (this.#history.length > this.#policy.maximumHistory) this.#history.splice(0, this.#history.length - this.#policy.maximumHistory);
    }
  }

  #laneSnapshot(lane: RuntimeFailureBudgetLane): RuntimeHealthLaneSnapshot {
    const state = this.#lanes[lane];
    const sums: Record<RuntimeHealthSignalKind, { total: number; count: number }> = {
      availability: { total: 0, count: 0 }, latency: { total: 0, count: 0 }, saturation: { total: 0, count: 0 }, integrity: { total: 0, count: 0 },
    };
    for (const sample of state.samples) { sums[sample.kind].total += sample.pressure; sums[sample.kind].count += 1; }
    const mean = (kind: RuntimeHealthSignalKind): number => sums[kind].count === 0 ? 0 : sums[kind].total / sums[kind].count;
    return Object.freeze({
      lane,
      severity: state.severity,
      mature: state.samples.length >= this.#policy.minimumSamples,
      score: this.#score(state),
      sampleCount: state.samples.length,
      healthyRecoverySamples: state.healthyRecoverySamples,
      signals: Object.freeze({ availability: mean('availability'), latency: mean('latency'), saturation: mean('saturation'), integrity: mean('integrity') }),
    });
  }
}
