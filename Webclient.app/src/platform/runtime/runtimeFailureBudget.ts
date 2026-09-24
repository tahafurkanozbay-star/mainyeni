export type RuntimeFailureBudgetLane = 'critical' | 'interactive' | 'background';
export type RuntimeFailureBudgetOutcome = 'success' | 'failure' | 'timeout' | 'cancelled' | 'rejected';

export interface RuntimeFailureBudgetPolicy {
  readonly windowSize: number;
  readonly minimumSamples: number;
  readonly maximumFailureRate: number;
  readonly maximumTimeoutRate: number;
}
export interface RuntimeFailureBudgetOptions {
  readonly critical?: Partial<RuntimeFailureBudgetPolicy>;
  readonly interactive?: Partial<RuntimeFailureBudgetPolicy>;
  readonly background?: Partial<RuntimeFailureBudgetPolicy>;
}
export interface RuntimeFailureBudgetLaneSnapshot {
  readonly lane: RuntimeFailureBudgetLane;
  readonly samples: number;
  readonly successes: number;
  readonly failures: number;
  readonly timeouts: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly failureRate: number;
  readonly timeoutRate: number;
  readonly exhausted: boolean;
  readonly remainingFailureRatio: number;
}
export interface RuntimeFailureBudgetSnapshot {
  readonly sequence: number;
  readonly lanes: Readonly<Record<RuntimeFailureBudgetLane, RuntimeFailureBudgetLaneSnapshot>>;
}
export interface RuntimeFailureBudgetDiagnostics {
  readonly sequence: number;
  readonly totalSamples: number;
  readonly exhaustedLanes: readonly RuntimeFailureBudgetLane[];
  readonly pressure: Readonly<Record<RuntimeFailureBudgetLane, number>>;
}
interface Sample { readonly sequence: number; readonly outcome: RuntimeFailureBudgetOutcome }

const LANES: readonly RuntimeFailureBudgetLane[] = Object.freeze(['critical', 'interactive', 'background']);
const OUTCOMES: readonly RuntimeFailureBudgetOutcome[] = Object.freeze(['success', 'failure', 'timeout', 'cancelled', 'rejected']);
const DEFAULTS: Readonly<Record<RuntimeFailureBudgetLane, RuntimeFailureBudgetPolicy>> = Object.freeze({
  critical: Object.freeze({ windowSize: 100, minimumSamples: 12, maximumFailureRate: 0.25, maximumTimeoutRate: 0.12 }),
  interactive: Object.freeze({ windowSize: 120, minimumSamples: 16, maximumFailureRate: 0.18, maximumTimeoutRate: 0.08 }),
  background: Object.freeze({ windowSize: 80, minimumSamples: 12, maximumFailureRate: 0.12, maximumTimeoutRate: 0.06 }),
});
const positiveInteger = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError(`${name} must be a positive safe integer <= ${maximum}`);
  return value;
};
const rate = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new RangeError(`${name} must be > 0 and <= 1`);
  return value;
};
const normalize = (lane: RuntimeFailureBudgetLane, value: Partial<RuntimeFailureBudgetPolicy> | undefined): RuntimeFailureBudgetPolicy => {
  const fallback = DEFAULTS[lane];
  const windowSize = positiveInteger(value?.windowSize ?? fallback.windowSize, `${lane}.windowSize`, 10_000);
  const minimumSamples = positiveInteger(value?.minimumSamples ?? fallback.minimumSamples, `${lane}.minimumSamples`, windowSize);
  if (minimumSamples > windowSize) throw new RangeError(`${lane}.minimumSamples must not exceed windowSize`);
  return Object.freeze({ windowSize, minimumSamples, maximumFailureRate: rate(value?.maximumFailureRate ?? fallback.maximumFailureRate, `${lane}.maximumFailureRate`), maximumTimeoutRate: rate(value?.maximumTimeoutRate ?? fallback.maximumTimeoutRate, `${lane}.maximumTimeoutRate`) });
};
const assertLane = (lane: RuntimeFailureBudgetLane): void => {
  if (!LANES.includes(lane)) throw new TypeError(`unsupported runtime failure budget lane: ${String(lane)}`);
};
const assertOutcome = (outcome: RuntimeFailureBudgetOutcome): void => {
  if (!OUTCOMES.includes(outcome)) throw new TypeError(`unsupported runtime failure budget outcome: ${String(outcome)}`);
};

export class RuntimeFailureBudget {
  readonly #policies: Readonly<Record<RuntimeFailureBudgetLane, RuntimeFailureBudgetPolicy>>;
  readonly #samples: Record<RuntimeFailureBudgetLane, Sample[]> = { critical: [], interactive: [], background: [] };
  #sequence = 0;

  constructor(options: RuntimeFailureBudgetOptions = {}) {
    this.#policies = Object.freeze({ critical: normalize('critical', options.critical), interactive: normalize('interactive', options.interactive), background: normalize('background', options.background) });
  }

  record(lane: RuntimeFailureBudgetLane, outcome: RuntimeFailureBudgetOutcome): RuntimeFailureBudgetLaneSnapshot {
    assertLane(lane); assertOutcome(outcome);
    const samples = this.#samples[lane];
    samples.push(Object.freeze({ sequence: ++this.#sequence, outcome }));
    const excess = samples.length - this.#policies[lane].windowSize;
    if (excess > 0) samples.splice(0, excess);
    return this.lane(lane);
  }

  recordMany(lane: RuntimeFailureBudgetLane, outcomes: readonly RuntimeFailureBudgetOutcome[]): RuntimeFailureBudgetLaneSnapshot {
    assertLane(lane);
    if (!Array.isArray(outcomes)) throw new TypeError('outcomes must be an array');
    if (outcomes.length > 10_000) throw new RangeError('outcomes must contain at most 10000 entries');
    for (const outcome of outcomes) this.record(lane, outcome);
    return this.lane(lane);
  }

  lane(lane: RuntimeFailureBudgetLane): RuntimeFailureBudgetLaneSnapshot {
    assertLane(lane);
    const samples = this.#samples[lane]; const policy = this.#policies[lane];
    let successes = 0, failures = 0, timeouts = 0, cancelled = 0, rejected = 0;
    for (const sample of samples) {
      if (sample.outcome === 'success') successes += 1;
      else if (sample.outcome === 'failure') failures += 1;
      else if (sample.outcome === 'timeout') timeouts += 1;
      else if (sample.outcome === 'cancelled') cancelled += 1;
      else rejected += 1;
    }
    const count = samples.length;
    const failureRate = count === 0 ? 0 : (failures + timeouts) / count;
    const timeoutRate = count === 0 ? 0 : timeouts / count;
    const mature = count >= policy.minimumSamples;
    const exhausted = mature && (failureRate >= policy.maximumFailureRate || timeoutRate >= policy.maximumTimeoutRate);
    const remainingFailureRatio = Math.max(0, Math.min(1, 1 - failureRate / policy.maximumFailureRate));
    return Object.freeze({ lane, samples: count, successes, failures, timeouts, cancelled, rejected, failureRate, timeoutRate, exhausted, remainingFailureRatio });
  }

  snapshot(): RuntimeFailureBudgetSnapshot {
    return Object.freeze({ sequence: this.#sequence, lanes: Object.freeze({ critical: this.lane('critical'), interactive: this.lane('interactive'), background: this.lane('background') }) });
  }

  diagnostics(): RuntimeFailureBudgetDiagnostics {
    const snapshot = this.snapshot();
    const exhaustedLanes = LANES.filter((lane) => snapshot.lanes[lane].exhausted);
    const pressure = Object.fromEntries(LANES.map((lane) => {
      const state = snapshot.lanes[lane]; const policy = this.#policies[lane];
      const failurePressure = state.failureRate / policy.maximumFailureRate;
      const timeoutPressure = state.timeoutRate / policy.maximumTimeoutRate;
      return [lane, Math.max(0, Math.min(1, Math.max(failurePressure, timeoutPressure)))];
    })) as Record<RuntimeFailureBudgetLane, number>;
    return Object.freeze({ sequence: snapshot.sequence, totalSamples: LANES.reduce((sum, lane) => sum + snapshot.lanes[lane].samples, 0), exhaustedLanes: Object.freeze(exhaustedLanes), pressure: Object.freeze(pressure) });
  }

  policy(lane: RuntimeFailureBudgetLane): RuntimeFailureBudgetPolicy { assertLane(lane); return this.#policies[lane]; }

  reset(lane?: RuntimeFailureBudgetLane): void {
    if (lane !== undefined) { assertLane(lane); this.#samples[lane].length = 0; }
    else for (const value of LANES) this.#samples[value].length = 0;
  }
}
