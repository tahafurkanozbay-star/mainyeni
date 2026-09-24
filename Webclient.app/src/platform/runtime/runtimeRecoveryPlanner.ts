import type { RuntimeFailureBudgetLane } from './runtimeFailureBudget';
import type { RuntimeOverloadState } from './runtimeOverloadGuard';

export type RuntimeRecoveryAction = 'none' | 'throttle' | 'drain' | 'probe';

export interface RuntimeRecoveryPolicy {
  readonly healthyProbeInterval: number;
  readonly pressuredCooldown: number;
  readonly overloadedCooldown: number;
  readonly maximumAttempts: number;
  readonly stableSamplesForRecovery: number;
  readonly historyLimit: number;
}

export interface RuntimeRecoverySignal {
  readonly lane: RuntimeFailureBudgetLane;
  readonly overload: RuntimeOverloadState;
  readonly pressure: number;
  readonly now: number;
}

export interface RuntimeRecoveryDecision {
  readonly lane: RuntimeFailureBudgetLane;
  readonly action: RuntimeRecoveryAction;
  readonly reason: 'healthy' | 'cooldown' | 'pressure' | 'overload' | 'attempt-budget' | 'recovery-probe';
  readonly attempt: number;
  readonly eligibleAt: number;
}

export interface RuntimeRecoveryLaneSnapshot {
  readonly lane: RuntimeFailureBudgetLane;
  readonly attempts: number;
  readonly stableSamples: number;
  readonly lastAction: RuntimeRecoveryAction;
  readonly lastActionAt: number | null;
  readonly nextEligibleAt: number;
}

export interface RuntimeRecoveryEvent extends RuntimeRecoveryDecision {
  readonly sequence: number;
  readonly at: number;
}

export interface RuntimeRecoverySnapshot {
  readonly sequence: number;
  readonly lanes: Readonly<Record<RuntimeFailureBudgetLane, RuntimeRecoveryLaneSnapshot>>;
  readonly history: readonly RuntimeRecoveryEvent[];
}

interface LaneState {
  attempts: number;
  stableSamples: number;
  lastAction: RuntimeRecoveryAction;
  lastActionAt: number | null;
  nextEligibleAt: number;
}

const LANES: readonly RuntimeFailureBudgetLane[] = Object.freeze(['critical', 'interactive', 'background']);
const DEFAULT_POLICY: RuntimeRecoveryPolicy = Object.freeze({
  healthyProbeInterval: 30_000,
  pressuredCooldown: 5_000,
  overloadedCooldown: 15_000,
  maximumAttempts: 8,
  stableSamplesForRecovery: 3,
  historyLimit: 128,
});

const assertLane = (lane: RuntimeFailureBudgetLane): void => {
  if (!LANES.includes(lane)) throw new TypeError(`unsupported runtime recovery lane: ${String(lane)}`);
};

const finiteNonNegative = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`);
  return value;
};

const positiveInteger = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer <= ${maximum}`);
  }
  return value;
};

const pressure = (value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('pressure must be between 0 and 1');
  return value;
};

const normalizePolicy = (value: Partial<RuntimeRecoveryPolicy>): RuntimeRecoveryPolicy => Object.freeze({
  healthyProbeInterval: finiteNonNegative(value.healthyProbeInterval ?? DEFAULT_POLICY.healthyProbeInterval, 'healthyProbeInterval'),
  pressuredCooldown: finiteNonNegative(value.pressuredCooldown ?? DEFAULT_POLICY.pressuredCooldown, 'pressuredCooldown'),
  overloadedCooldown: finiteNonNegative(value.overloadedCooldown ?? DEFAULT_POLICY.overloadedCooldown, 'overloadedCooldown'),
  maximumAttempts: positiveInteger(value.maximumAttempts ?? DEFAULT_POLICY.maximumAttempts, 'maximumAttempts', 10_000),
  stableSamplesForRecovery: positiveInteger(value.stableSamplesForRecovery ?? DEFAULT_POLICY.stableSamplesForRecovery, 'stableSamplesForRecovery', 10_000),
  historyLimit: positiveInteger(value.historyLimit ?? DEFAULT_POLICY.historyLimit, 'historyLimit', 10_000),
});

const createLaneState = (): LaneState => ({ attempts: 0, stableSamples: 0, lastAction: 'none', lastActionAt: null, nextEligibleAt: 0 });

export class RuntimeRecoveryPlanner {
  readonly #policy: RuntimeRecoveryPolicy;
  readonly #lanes: Record<RuntimeFailureBudgetLane, LaneState> = {
    critical: createLaneState(), interactive: createLaneState(), background: createLaneState(),
  };
  readonly #history: RuntimeRecoveryEvent[] = [];
  #sequence = 0;
  #lastNow = 0;

  constructor(policy: Partial<RuntimeRecoveryPolicy> = {}) { this.#policy = normalizePolicy(policy); }

  evaluate(signal: RuntimeRecoverySignal): RuntimeRecoveryDecision {
    assertLane(signal.lane);
    const now = finiteNonNegative(signal.now, 'now');
    const currentPressure = pressure(signal.pressure);
    if (now < this.#lastNow) throw new RangeError('now must be monotonic');
    this.#lastNow = now;
    const lane = this.#lanes[signal.lane];
    if (signal.overload === 'healthy') {
      lane.stableSamples += 1;
      if (lane.stableSamples >= this.#policy.stableSamplesForRecovery) {
        lane.attempts = 0; lane.lastAction = 'none'; lane.lastActionAt = null; lane.nextEligibleAt = 0;
        return this.#decision(signal.lane, 'none', 'healthy', now);
      }
      if (lane.lastAction !== 'none' && now >= lane.nextEligibleAt) return this.#commit(signal.lane, 'probe', 'recovery-probe', now, this.#policy.healthyProbeInterval);
      return this.#decision(signal.lane, 'none', 'healthy', now);
    }
    lane.stableSamples = 0;
    if (now < lane.nextEligibleAt) return this.#decision(signal.lane, 'none', 'cooldown', lane.nextEligibleAt);
    const maxAttempts = this.#policy.maximumAttempts;
    if (lane.attempts >= maxAttempts) return this.#decision(signal.lane, 'none', 'attempt-budget', now);
    if (signal.overload === 'overloaded') return this.#commit(signal.lane, 'drain', 'overload', now, this.#policy.overloadedCooldown);
    if (currentPressure > 0) return this.#commit(signal.lane, 'throttle', 'pressure', now, this.#policy.pressuredCooldown);
    return this.#decision(signal.lane, 'none', 'pressure', now);
  }

  evaluateMany(signals: readonly RuntimeRecoverySignal[]): RuntimeRecoverySnapshot {
    if (!Array.isArray(signals)) throw new TypeError('signals must be an array');
    if (signals.length > 10_000) throw new RangeError('signals must contain at most 10000 entries');
    for (const signal of signals) this.evaluate(signal);
    return this.snapshot();
  }

  lane(lane: RuntimeFailureBudgetLane): RuntimeRecoveryLaneSnapshot {
    assertLane(lane); const value = this.#lanes[lane];
    return Object.freeze({ lane, attempts: value.attempts, stableSamples: value.stableSamples, lastAction: value.lastAction, lastActionAt: value.lastActionAt, nextEligibleAt: value.nextEligibleAt });
  }

  snapshot(): RuntimeRecoverySnapshot {
    return Object.freeze({ sequence: this.#sequence, lanes: Object.freeze({ critical: this.lane('critical'), interactive: this.lane('interactive'), background: this.lane('background') }), history: Object.freeze(this.#history.map((event) => Object.freeze({ ...event }))) });
  }

  policy(): RuntimeRecoveryPolicy { return this.#policy; }

  reset(lane?: RuntimeFailureBudgetLane): void {
    if (lane !== undefined) { assertLane(lane); this.#lanes[lane] = createLaneState(); }
    else { for (const current of LANES) this.#lanes[current] = createLaneState(); this.#history.length = 0; this.#lastNow = 0; }
    this.#sequence += 1;
  }

  #decision(lane: RuntimeFailureBudgetLane, action: RuntimeRecoveryAction, reason: RuntimeRecoveryDecision['reason'], eligibleAt: number): RuntimeRecoveryDecision {
    return Object.freeze({ lane, action, reason, attempt: this.#lanes[lane].attempts, eligibleAt });
  }

  #commit(laneName: RuntimeFailureBudgetLane, action: RuntimeRecoveryAction, reason: RuntimeRecoveryDecision['reason'], now: number, cooldown: number): RuntimeRecoveryDecision {
    const lane = this.#lanes[laneName]; lane.attempts += 1; lane.lastAction = action; lane.lastActionAt = now; lane.nextEligibleAt = now + cooldown; this.#sequence += 1;
    const decision = this.#decision(laneName, action, reason, lane.nextEligibleAt);
    this.#history.push(Object.freeze({ ...decision, sequence: this.#sequence, at: now }));
    const overflow = this.#history.length - this.#policy.historyLimit; if (overflow > 0) this.#history.splice(0, overflow);
    return decision;
  }
}
