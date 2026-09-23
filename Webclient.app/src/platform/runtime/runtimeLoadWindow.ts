export type RuntimeLoadLane = 'interactive' | 'background' | 'maintenance';
export type RuntimeLoadOutcome = 'success' | 'failure' | 'cancelled' | 'rejected';
export type RuntimeLoadState = 'idle' | 'healthy' | 'pressured' | 'critical';

export interface RuntimeLoadWindowPolicy {
  readonly sampleLimit: number;
  readonly minimumSamples: number;
  readonly pressureFailureRatio: number;
  readonly criticalFailureRatio: number;
  readonly pressureRejectionRatio: number;
  readonly criticalRejectionRatio: number;
  readonly recoverySuccesses: number;
}

export interface RuntimeLoadSample {
  readonly lane: RuntimeLoadLane;
  readonly outcome: RuntimeLoadOutcome;
  readonly durationMs: number;
  readonly observedAt: number;
}

export interface RuntimeLoadLaneSnapshot {
  readonly lane: RuntimeLoadLane;
  readonly state: RuntimeLoadState;
  readonly samples: number;
  readonly successes: number;
  readonly failures: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly failureRatio: number;
  readonly rejectionRatio: number;
  readonly averageDurationMs: number;
  readonly maximumDurationMs: number;
  readonly consecutiveSuccesses: number;
}

export interface RuntimeLoadSnapshot {
  readonly state: RuntimeLoadState;
  readonly lanes: Readonly<Record<RuntimeLoadLane, RuntimeLoadLaneSnapshot>>;
  readonly totalSamples: number;
  readonly lastObservedAt: number | null;
}

const LANES: readonly RuntimeLoadLane[] = ['interactive', 'background', 'maintenance'];
const MAX_SAMPLES = 100_000;
const MAX_DURATION_MS = 86_400_000;

const assertInteger = (name: string, value: number, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const assertRatio = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  return value;
};

const validatePolicy = (input: RuntimeLoadWindowPolicy): RuntimeLoadWindowPolicy => {
  const sampleLimit = assertInteger('sampleLimit', input.sampleLimit, 1, MAX_SAMPLES);
  const minimumSamples = assertInteger('minimumSamples', input.minimumSamples, 1, sampleLimit);
  const pressureFailureRatio = assertRatio('pressureFailureRatio', input.pressureFailureRatio);
  const criticalFailureRatio = assertRatio('criticalFailureRatio', input.criticalFailureRatio);
  const pressureRejectionRatio = assertRatio('pressureRejectionRatio', input.pressureRejectionRatio);
  const criticalRejectionRatio = assertRatio('criticalRejectionRatio', input.criticalRejectionRatio);
  if (criticalFailureRatio < pressureFailureRatio) throw new RangeError('criticalFailureRatio must be >= pressureFailureRatio');
  if (criticalRejectionRatio < pressureRejectionRatio) throw new RangeError('criticalRejectionRatio must be >= pressureRejectionRatio');
  return Object.freeze({
    sampleLimit,
    minimumSamples,
    pressureFailureRatio,
    criticalFailureRatio,
    pressureRejectionRatio,
    criticalRejectionRatio,
    recoverySuccesses: assertInteger('recoverySuccesses', input.recoverySuccesses, 1, sampleLimit),
  });
};

const validateSample = (sample: RuntimeLoadSample): RuntimeLoadSample => {
  if (!LANES.includes(sample.lane)) throw new TypeError(`unsupported runtime lane: ${String(sample.lane)}`);
  if (!['success', 'failure', 'cancelled', 'rejected'].includes(sample.outcome)) throw new TypeError(`unsupported runtime outcome: ${String(sample.outcome)}`);
  if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0 || sample.durationMs > MAX_DURATION_MS) {
    throw new RangeError(`durationMs must be finite between 0 and ${MAX_DURATION_MS}`);
  }
  if (!Number.isSafeInteger(sample.observedAt) || sample.observedAt < 0) throw new RangeError('observedAt must be a non-negative safe integer');
  return Object.freeze({ ...sample });
};

const severity = (state: RuntimeLoadState): number => ({ idle: 0, healthy: 1, pressured: 2, critical: 3 })[state];

/** Bounded, caller-clocked evidence window for runtime admission and recovery policy. */
export class RuntimeLoadWindow {
  readonly #policy: RuntimeLoadWindowPolicy;
  readonly #samples: Record<RuntimeLoadLane, RuntimeLoadSample[]> = { interactive: [], background: [], maintenance: [] };
  readonly #state: Record<RuntimeLoadLane, RuntimeLoadState> = { interactive: 'idle', background: 'idle', maintenance: 'idle' };
  readonly #successRun: Record<RuntimeLoadLane, number> = { interactive: 0, background: 0, maintenance: 0 };
  #lastObservedAt: number | null = null;

  constructor(policy: RuntimeLoadWindowPolicy) { this.#policy = validatePolicy(policy); }

  get policy(): RuntimeLoadWindowPolicy { return this.#policy; }

  record(input: RuntimeLoadSample): RuntimeLoadSnapshot {
    const sample = validateSample(input);
    if (this.#lastObservedAt !== null && sample.observedAt < this.#lastObservedAt) throw new RangeError('observedAt must be monotonic');
    this.#lastObservedAt = sample.observedAt;
    const laneSamples = this.#samples[sample.lane];
    laneSamples.push(sample);
    const overflow = laneSamples.length - this.#policy.sampleLimit;
    if (overflow > 0) laneSamples.splice(0, overflow);
    this.#successRun[sample.lane] = sample.outcome === 'success' ? this.#successRun[sample.lane] + 1 : 0;
    this.#state[sample.lane] = this.#classify(sample.lane);
    return this.snapshot();
  }

  reset(lane?: RuntimeLoadLane): void {
    const targets = lane === undefined ? LANES : [lane];
    if (lane !== undefined && !LANES.includes(lane)) throw new TypeError(`unsupported runtime lane: ${String(lane)}`);
    for (const target of targets) {
      this.#samples[target].length = 0;
      this.#state[target] = 'idle';
      this.#successRun[target] = 0;
    }
    if (lane === undefined) this.#lastObservedAt = null;
  }

  snapshot(): RuntimeLoadSnapshot {
    const lanes = Object.freeze({
      interactive: this.#laneSnapshot('interactive'),
      background: this.#laneSnapshot('background'),
      maintenance: this.#laneSnapshot('maintenance'),
    });
    const state = LANES.map((lane) => lanes[lane].state).reduce((worst, current) => severity(current) > severity(worst) ? current : worst, 'idle' as RuntimeLoadState);
    return Object.freeze({
      state,
      lanes,
      totalSamples: LANES.reduce((total, lane) => total + this.#samples[lane].length, 0),
      lastObservedAt: this.#lastObservedAt,
    });
  }

  #classify(lane: RuntimeLoadLane): RuntimeLoadState {
    const snapshot = this.#laneSnapshot(lane);
    if (snapshot.samples < this.#policy.minimumSamples) return 'idle';
    const critical = snapshot.failureRatio >= this.#policy.criticalFailureRatio || snapshot.rejectionRatio >= this.#policy.criticalRejectionRatio;
    const pressured = snapshot.failureRatio >= this.#policy.pressureFailureRatio || snapshot.rejectionRatio >= this.#policy.pressureRejectionRatio;
    const desired: RuntimeLoadState = critical ? 'critical' : pressured ? 'pressured' : 'healthy';
    const previous = this.#state[lane];
    if (severity(desired) < severity(previous) && this.#successRun[lane] < this.#policy.recoverySuccesses) return previous;
    return desired;
  }

  #laneSnapshot(lane: RuntimeLoadLane): RuntimeLoadLaneSnapshot {
    const samples = this.#samples[lane];
    let successes = 0, failures = 0, cancelled = 0, rejected = 0, totalDuration = 0, maximumDurationMs = 0;
    for (const sample of samples) {
      if (sample.outcome === 'success') successes += 1;
      else if (sample.outcome === 'failure') failures += 1;
      else if (sample.outcome === 'cancelled') cancelled += 1;
      else rejected += 1;
      totalDuration += sample.durationMs;
      maximumDurationMs = Math.max(maximumDurationMs, sample.durationMs);
    }
    const count = samples.length;
    return Object.freeze({
      lane,
      state: this.#state[lane],
      samples: count,
      successes,
      failures,
      cancelled,
      rejected,
      failureRatio: count === 0 ? 0 : failures / count,
      rejectionRatio: count === 0 ? 0 : rejected / count,
      averageDurationMs: count === 0 ? 0 : totalDuration / count,
      maximumDurationMs,
      consecutiveSuccesses: this.#successRun[lane],
    });
  }
}
