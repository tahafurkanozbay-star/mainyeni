import type { RuntimeFailureBudgetLane } from './runtimeFailureBudget';

export type RuntimePressureMode = 'normal' | 'constrained' | 'critical';
export type RuntimePressureDecision = 'admit' | 'defer' | 'reject';
export type RuntimePressureReason =
  | 'healthy'
  | 'lane-capacity'
  | 'global-capacity'
  | 'queue-capacity'
  | 'pressure'
  | 'critical-pressure'
  | 'duplicate';

export interface RuntimePressurePolicy {
  readonly maximumGlobalInFlight: number;
  readonly maximumGlobalQueued: number;
  readonly maximumLaneInFlight: number;
  readonly maximumLaneQueued: number;
  readonly constrainedThreshold: number;
  readonly criticalThreshold: number;
  readonly recoveryThreshold: number;
  readonly minimumHealthySamples: number;
  readonly maximumHistory: number;
}

export interface RuntimePressureSample {
  readonly lane: RuntimeFailureBudgetLane;
  readonly at: number;
  readonly utilization: number;
  readonly failurePressure: number;
  readonly saturation: number;
}

export interface RuntimePressureRequest {
  readonly id: string;
  readonly lane: RuntimeFailureBudgetLane;
  readonly at: number;
}

export interface RuntimePressureResult {
  readonly id: string;
  readonly lane: RuntimeFailureBudgetLane;
  readonly decision: RuntimePressureDecision;
  readonly reason: RuntimePressureReason;
  readonly mode: RuntimePressureMode;
  readonly pressure: number;
  readonly at: number;
}

export interface RuntimePressureTransition {
  readonly sequence: number;
  readonly lane: RuntimeFailureBudgetLane;
  readonly from: RuntimePressureMode;
  readonly to: RuntimePressureMode;
  readonly pressure: number;
  readonly at: number;
}

export interface RuntimePressureLaneSnapshot {
  readonly lane: RuntimeFailureBudgetLane;
  readonly mode: RuntimePressureMode;
  readonly pressure: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly healthySamples: number;
  readonly lastSampleAt: number | null;
}

export interface RuntimePressureSnapshot {
  readonly sequence: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly lanes: Readonly<Record<RuntimeFailureBudgetLane, RuntimePressureLaneSnapshot>>;
}

interface LaneState {
  mode: RuntimePressureMode;
  pressure: number;
  healthySamples: number;
  lastSampleAt: number | null;
  inFlight: Set<string>;
  queue: string[];
}

const LANES: readonly RuntimeFailureBudgetLane[] = Object.freeze(['critical', 'interactive', 'background']);

const DEFAULT_POLICY: RuntimePressurePolicy = Object.freeze({
  maximumGlobalInFlight: 24,
  maximumGlobalQueued: 96,
  maximumLaneInFlight: 12,
  maximumLaneQueued: 48,
  constrainedThreshold: 0.65,
  criticalThreshold: 0.9,
  recoveryThreshold: 0.45,
  minimumHealthySamples: 3,
  maximumHistory: 128,
});

const boundedInteger = (value: number, name: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const boundedRate = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
  return value;
};

const assertLane = (lane: RuntimeFailureBudgetLane): void => {
  if (!LANES.includes(lane)) throw new TypeError(`unsupported pressure lane: ${String(lane)}`);
};

const assertId = (id: string): void => {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
    throw new TypeError('pressure request id must contain between 1 and 256 characters');
  }
};

const assertAt = (at: number): void => {
  if (!Number.isSafeInteger(at) || at < 0) throw new RangeError('at must be a non-negative safe integer');
};

const normalizePolicy = (input: Partial<RuntimePressurePolicy>): RuntimePressurePolicy => {
  const policy = Object.freeze({
    maximumGlobalInFlight: boundedInteger(input.maximumGlobalInFlight ?? DEFAULT_POLICY.maximumGlobalInFlight, 'maximumGlobalInFlight', 1, 100_000),
    maximumGlobalQueued: boundedInteger(input.maximumGlobalQueued ?? DEFAULT_POLICY.maximumGlobalQueued, 'maximumGlobalQueued', 0, 100_000),
    maximumLaneInFlight: boundedInteger(input.maximumLaneInFlight ?? DEFAULT_POLICY.maximumLaneInFlight, 'maximumLaneInFlight', 1, 100_000),
    maximumLaneQueued: boundedInteger(input.maximumLaneQueued ?? DEFAULT_POLICY.maximumLaneQueued, 'maximumLaneQueued', 0, 100_000),
    constrainedThreshold: boundedRate(input.constrainedThreshold ?? DEFAULT_POLICY.constrainedThreshold, 'constrainedThreshold'),
    criticalThreshold: boundedRate(input.criticalThreshold ?? DEFAULT_POLICY.criticalThreshold, 'criticalThreshold'),
    recoveryThreshold: boundedRate(input.recoveryThreshold ?? DEFAULT_POLICY.recoveryThreshold, 'recoveryThreshold'),
    minimumHealthySamples: boundedInteger(input.minimumHealthySamples ?? DEFAULT_POLICY.minimumHealthySamples, 'minimumHealthySamples', 1, 10_000),
    maximumHistory: boundedInteger(input.maximumHistory ?? DEFAULT_POLICY.maximumHistory, 'maximumHistory', 0, 10_000),
  });
  if (policy.recoveryThreshold >= policy.constrainedThreshold) throw new RangeError('recoveryThreshold must be below constrainedThreshold');
  if (policy.constrainedThreshold >= policy.criticalThreshold) throw new RangeError('constrainedThreshold must be below criticalThreshold');
  if (policy.maximumLaneInFlight > policy.maximumGlobalInFlight) throw new RangeError('maximumLaneInFlight must not exceed maximumGlobalInFlight');
  if (policy.maximumLaneQueued > policy.maximumGlobalQueued) throw new RangeError('maximumLaneQueued must not exceed maximumGlobalQueued');
  return policy;
};

const createLaneState = (): LaneState => ({
  mode: 'normal',
  pressure: 0,
  healthySamples: 0,
  lastSampleAt: null,
  inFlight: new Set<string>(),
  queue: [],
});

export class RuntimePressureOrchestrator {
  readonly #policy: RuntimePressurePolicy;
  readonly #lanes: Record<RuntimeFailureBudgetLane, LaneState> = {
    critical: createLaneState(),
    interactive: createLaneState(),
    background: createLaneState(),
  };
  readonly #history: RuntimePressureTransition[] = [];
  readonly #owners = new Map<string, RuntimeFailureBudgetLane>();
  #sequence = 0;
  #lastAt: number | null = null;

  constructor(policy: Partial<RuntimePressurePolicy> = {}) {
    this.#policy = normalizePolicy(policy);
  }

  policy(): RuntimePressurePolicy {
    return this.#policy;
  }

  sample(input: RuntimePressureSample): RuntimePressureLaneSnapshot {
    assertLane(input.lane);
    assertAt(input.at);
    this.#advance(input.at);
    const utilization = boundedRate(input.utilization, 'utilization');
    const failurePressure = boundedRate(input.failurePressure, 'failurePressure');
    const saturation = boundedRate(input.saturation, 'saturation');
    const state = this.#lanes[input.lane];
    const pressure = Math.max(utilization, failurePressure, saturation);
    state.pressure = pressure;
    state.lastSampleAt = input.at;

    if (pressure >= this.#policy.criticalThreshold) {
      state.healthySamples = 0;
      this.#transition(input.lane, 'critical', pressure, input.at);
    } else if (pressure >= this.#policy.constrainedThreshold) {
      state.healthySamples = 0;
      if (state.mode === 'normal') this.#transition(input.lane, 'constrained', pressure, input.at);
    } else if (pressure <= this.#policy.recoveryThreshold) {
      state.healthySamples += 1;
      if (state.healthySamples >= this.#policy.minimumHealthySamples) {
        if (state.mode === 'critical') this.#transition(input.lane, 'constrained', pressure, input.at);
        else if (state.mode === 'constrained') this.#transition(input.lane, 'normal', pressure, input.at);
        state.healthySamples = 0;
      }
    } else {
      state.healthySamples = 0;
    }
    return this.#laneSnapshot(input.lane);
  }

  request(input: RuntimePressureRequest): RuntimePressureResult {
    assertLane(input.lane);
    assertId(input.id);
    assertAt(input.at);
    this.#advance(input.at);
    const existingLane = this.#owners.get(input.id);
    if (existingLane !== undefined) {
      return this.#result(input, existingLane === input.lane ? 'defer' : 'reject', 'duplicate');
    }
    const state = this.#lanes[input.lane];
    if (state.mode === 'critical') return this.#result(input, 'reject', 'critical-pressure');
    if (state.mode === 'constrained') return this.#enqueue(input, 'pressure');
    if (this.#globalInFlight() >= this.#policy.maximumGlobalInFlight) return this.#enqueue(input, 'global-capacity');
    if (state.inFlight.size >= this.#policy.maximumLaneInFlight) return this.#enqueue(input, 'lane-capacity');
    state.inFlight.add(input.id);
    this.#owners.set(input.id, input.lane);
    this.#sequence += 1;
    return this.#result(input, 'admit', 'healthy');
  }

  complete(lane: RuntimeFailureBudgetLane, id: string, at: number): readonly string[] {
    assertLane(lane);
    assertId(id);
    assertAt(at);
    this.#advance(at);
    const state = this.#lanes[lane];
    if (!state.inFlight.delete(id)) return Object.freeze([]);
    this.#owners.delete(id);
    this.#sequence += 1;
    return this.promote(lane, at);
  }

  cancel(lane: RuntimeFailureBudgetLane, id: string, at: number): boolean {
    assertLane(lane);
    assertId(id);
    assertAt(at);
    this.#advance(at);
    const state = this.#lanes[lane];
    if (state.inFlight.delete(id)) {
      this.#owners.delete(id);
      this.#sequence += 1;
      return true;
    }
    const index = state.queue.indexOf(id);
    if (index < 0) return false;
    state.queue.splice(index, 1);
    this.#owners.delete(id);
    this.#sequence += 1;
    return true;
  }

  promote(lane: RuntimeFailureBudgetLane, at: number): readonly string[] {
    assertLane(lane);
    assertAt(at);
    this.#advance(at);
    const state = this.#lanes[lane];
    if (state.mode !== 'normal') return Object.freeze([]);
    const globalSlots = Math.max(0, this.#policy.maximumGlobalInFlight - this.#globalInFlight());
    const laneSlots = Math.max(0, this.#policy.maximumLaneInFlight - state.inFlight.size);
    const maximumPromotions = Math.min(globalSlots, laneSlots, state.queue.length);
    if (maximumPromotions === 0) return Object.freeze([]);
    const promoted: string[] = [];
    for (let index = 0; index < maximumPromotions; index += 1) {
      const id = state.queue.shift();
      if (id === undefined) break;
      state.inFlight.add(id);
      promoted.push(id);
      this.#sequence += 1;
    }
    return Object.freeze(promoted);
  }

  history(): readonly RuntimePressureTransition[] {
    return Object.freeze(this.#history.map((entry) => Object.freeze({ ...entry })));
  }

  snapshot(): RuntimePressureSnapshot {
    return Object.freeze({
      sequence: this.#sequence,
      inFlight: this.#globalInFlight(),
      queued: this.#globalQueued(),
      lanes: Object.freeze({
        critical: this.#laneSnapshot('critical'),
        interactive: this.#laneSnapshot('interactive'),
        background: this.#laneSnapshot('background'),
      }),
    });
  }

  reset(lane?: RuntimeFailureBudgetLane): void {
    if (lane === undefined) {
      for (const laneName of LANES) this.#clearLane(laneName);
      this.#owners.clear();
      this.#history.length = 0;
      this.#sequence = 0;
      this.#lastAt = null;
      return;
    }
    assertLane(lane);
    this.#clearLane(lane);
    this.#history.splice(0, this.#history.length, ...this.#history.filter((entry) => entry.lane !== lane));
    this.#sequence += 1;
  }

  #enqueue(input: RuntimePressureRequest, reason: RuntimePressureReason): RuntimePressureResult {
    const state = this.#lanes[input.lane];
    if (this.#globalQueued() >= this.#policy.maximumGlobalQueued || state.queue.length >= this.#policy.maximumLaneQueued) {
      return this.#result(input, 'reject', 'queue-capacity');
    }
    state.queue.push(input.id);
    this.#owners.set(input.id, input.lane);
    this.#sequence += 1;
    return this.#result(input, 'defer', reason);
  }

  #transition(lane: RuntimeFailureBudgetLane, to: RuntimePressureMode, pressure: number, at: number): void {
    const state = this.#lanes[lane];
    if (state.mode === to) return;
    const transition = Object.freeze({ sequence: ++this.#sequence, lane, from: state.mode, to, pressure, at });
    state.mode = to;
    if (this.#policy.maximumHistory === 0) return;
    this.#history.push(transition);
    if (this.#history.length > this.#policy.maximumHistory) {
      this.#history.splice(0, this.#history.length - this.#policy.maximumHistory);
    }
  }

  #result(input: RuntimePressureRequest, decision: RuntimePressureDecision, reason: RuntimePressureReason): RuntimePressureResult {
    return Object.freeze({ id: input.id, lane: input.lane, decision, reason, mode: this.#lanes[input.lane].mode, pressure: this.#lanes[input.lane].pressure, at: input.at });
  }

  #laneSnapshot(lane: RuntimeFailureBudgetLane): RuntimePressureLaneSnapshot {
    const state = this.#lanes[lane];
    return Object.freeze({ lane, mode: state.mode, pressure: state.pressure, inFlight: state.inFlight.size, queued: state.queue.length, healthySamples: state.healthySamples, lastSampleAt: state.lastSampleAt });
  }

  #globalInFlight(): number {
    return this.#lanes.critical.inFlight.size + this.#lanes.interactive.inFlight.size + this.#lanes.background.inFlight.size;
  }

  #globalQueued(): number {
    return this.#lanes.critical.queue.length + this.#lanes.interactive.queue.length + this.#lanes.background.queue.length;
  }

  #advance(at: number): void {
    if (this.#lastAt !== null && at < this.#lastAt) throw new RangeError('runtime pressure time must be monotonic');
    this.#lastAt = at;
  }

  #clearLane(lane: RuntimeFailureBudgetLane): void {
    const state = this.#lanes[lane];
    for (const id of state.inFlight) this.#owners.delete(id);
    for (const id of state.queue) this.#owners.delete(id);
    state.inFlight.clear();
    state.queue.length = 0;
    state.mode = 'normal';
    state.pressure = 0;
    state.healthySamples = 0;
    state.lastSampleAt = null;
  }
}
