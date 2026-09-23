import type { RuntimeFailureBudgetLane } from './runtimeFailureBudget';

export type RuntimeAdmissionDecision = 'admit' | 'defer' | 'reject';
export type RuntimeAdmissionReason = 'capacity' | 'failure-pressure' | 'queue-full' | 'admitted';

export interface RuntimeAdmissionPolicy {
  readonly maximumInFlight: number;
  readonly maximumQueued: number;
  readonly rejectPressure: number;
  readonly deferPressure: number;
}

export interface RuntimeAdmissionRequest {
  readonly lane: RuntimeFailureBudgetLane;
  readonly key: string;
  readonly pressure: number;
}

export interface RuntimeAdmissionResult {
  readonly decision: RuntimeAdmissionDecision;
  readonly reason: RuntimeAdmissionReason;
  readonly lane: RuntimeFailureBudgetLane;
  readonly key: string;
  readonly inFlight: number;
  readonly queued: number;
}

export interface RuntimeAdmissionSnapshot {
  readonly sequence: number;
  readonly totalInFlight: number;
  readonly totalQueued: number;
  readonly lanes: Readonly<Record<RuntimeFailureBudgetLane, Readonly<{ inFlight: number; queued: number }>>>;
}

interface LaneState {
  inFlight: Set<string>;
  queued: string[];
}

const LANES: readonly RuntimeFailureBudgetLane[] = Object.freeze(['critical', 'interactive', 'background']);
const DEFAULT_POLICY: Readonly<Record<RuntimeFailureBudgetLane, RuntimeAdmissionPolicy>> = Object.freeze({
  critical: Object.freeze({ maximumInFlight: 12, maximumQueued: 48, deferPressure: 0.7, rejectPressure: 0.95 }),
  interactive: Object.freeze({ maximumInFlight: 8, maximumQueued: 32, deferPressure: 0.6, rejectPressure: 0.9 }),
  background: Object.freeze({ maximumInFlight: 4, maximumQueued: 16, deferPressure: 0.5, rejectPressure: 0.8 }),
});

const assertLane = (lane: RuntimeFailureBudgetLane): void => {
  if (!LANES.includes(lane)) throw new TypeError(`unsupported runtime admission lane: ${String(lane)}`);
};

const boundedInteger = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between 0 and ${maximum}`);
  }
  return value;
};

const boundedRate = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
  return value;
};

const normalizePolicy = (lane: RuntimeFailureBudgetLane, value?: Partial<RuntimeAdmissionPolicy>): RuntimeAdmissionPolicy => {
  const fallback = DEFAULT_POLICY[lane];
  const maximumInFlight = boundedInteger(value?.maximumInFlight ?? fallback.maximumInFlight, `${lane}.maximumInFlight`, 10_000);
  const maximumQueued = boundedInteger(value?.maximumQueued ?? fallback.maximumQueued, `${lane}.maximumQueued`, 100_000);
  const deferPressure = boundedRate(value?.deferPressure ?? fallback.deferPressure, `${lane}.deferPressure`);
  const rejectPressure = boundedRate(value?.rejectPressure ?? fallback.rejectPressure, `${lane}.rejectPressure`);
  if (deferPressure > rejectPressure) throw new RangeError(`${lane}.deferPressure must not exceed rejectPressure`);
  return Object.freeze({ maximumInFlight, maximumQueued, deferPressure, rejectPressure });
};

const assertKey = (key: string): void => {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) throw new TypeError('runtime admission key must contain 1..512 characters');
};

const assertPressure = (pressure: number): void => {
  if (!Number.isFinite(pressure) || pressure < 0 || pressure > 1) throw new RangeError('runtime admission pressure must be between 0 and 1');
};

export class RuntimeAdmissionController {
  readonly #policies: Readonly<Record<RuntimeFailureBudgetLane, RuntimeAdmissionPolicy>>;
  readonly #state: Record<RuntimeFailureBudgetLane, LaneState> = {
    critical: { inFlight: new Set(), queued: [] },
    interactive: { inFlight: new Set(), queued: [] },
    background: { inFlight: new Set(), queued: [] },
  };
  #sequence = 0;

  constructor(options: Partial<Record<RuntimeFailureBudgetLane, Partial<RuntimeAdmissionPolicy>>> = {}) {
    this.#policies = Object.freeze({
      critical: normalizePolicy('critical', options.critical),
      interactive: normalizePolicy('interactive', options.interactive),
      background: normalizePolicy('background', options.background),
    });
  }

  decide(request: RuntimeAdmissionRequest): RuntimeAdmissionResult {
    assertLane(request.lane);
    assertKey(request.key);
    assertPressure(request.pressure);
    const state = this.#state[request.lane];
    const policy = this.#policies[request.lane];
    if (state.inFlight.has(request.key)) return this.#result(request.lane, request.key, 'admit', 'admitted');
    if (state.queued.includes(request.key)) return this.#result(request.lane, request.key, 'defer', 'capacity');
    if (request.pressure >= policy.rejectPressure) return this.#result(request.lane, request.key, 'reject', 'failure-pressure');
    if (request.pressure >= policy.deferPressure || state.inFlight.size >= policy.maximumInFlight) {
      if (state.queued.length >= policy.maximumQueued) return this.#result(request.lane, request.key, 'reject', 'queue-full');
      state.queued.push(request.key);
      this.#sequence += 1;
      return this.#result(request.lane, request.key, 'defer', 'capacity');
    }
    state.inFlight.add(request.key);
    this.#sequence += 1;
    return this.#result(request.lane, request.key, 'admit', 'admitted');
  }

  complete(lane: RuntimeFailureBudgetLane, key: string): boolean {
    assertLane(lane);
    assertKey(key);
    const removed = this.#state[lane].inFlight.delete(key);
    if (removed) this.#sequence += 1;
    return removed;
  }

  promote(lane: RuntimeFailureBudgetLane, pressure: number): readonly string[] {
    assertLane(lane);
    assertPressure(pressure);
    const state = this.#state[lane];
    const policy = this.#policies[lane];
    if (pressure >= policy.deferPressure) return Object.freeze([]);
    const promoted: string[] = [];
    while (state.queued.length > 0 && state.inFlight.size < policy.maximumInFlight) {
      const key = state.queued.shift();
      if (key === undefined) break;
      if (state.inFlight.has(key)) continue;
      state.inFlight.add(key);
      promoted.push(key);
      this.#sequence += 1;
    }
    return Object.freeze(promoted);
  }

  cancel(lane: RuntimeFailureBudgetLane, key: string): boolean {
    assertLane(lane);
    assertKey(key);
    const state = this.#state[lane];
    const queueIndex = state.queued.indexOf(key);
    if (queueIndex >= 0) {
      state.queued.splice(queueIndex, 1);
      this.#sequence += 1;
      return true;
    }
    if (state.inFlight.delete(key)) {
      this.#sequence += 1;
      return true;
    }
    return false;
  }

  policy(lane: RuntimeFailureBudgetLane): RuntimeAdmissionPolicy {
    assertLane(lane);
    return this.#policies[lane];
  }

  snapshot(): RuntimeAdmissionSnapshot {
    const lanes = Object.freeze({
      critical: Object.freeze({ inFlight: this.#state.critical.inFlight.size, queued: this.#state.critical.queued.length }),
      interactive: Object.freeze({ inFlight: this.#state.interactive.inFlight.size, queued: this.#state.interactive.queued.length }),
      background: Object.freeze({ inFlight: this.#state.background.inFlight.size, queued: this.#state.background.queued.length }),
    });
    return Object.freeze({
      sequence: this.#sequence,
      totalInFlight: LANES.reduce((sum, lane) => sum + lanes[lane].inFlight, 0),
      totalQueued: LANES.reduce((sum, lane) => sum + lanes[lane].queued, 0),
      lanes,
    });
  }

  reset(lane?: RuntimeFailureBudgetLane): void {
    if (lane !== undefined) {
      assertLane(lane);
      this.#state[lane].inFlight.clear();
      this.#state[lane].queued.length = 0;
      this.#sequence += 1;
      return;
    }
    for (const current of LANES) {
      this.#state[current].inFlight.clear();
      this.#state[current].queued.length = 0;
    }
    this.#sequence += 1;
  }

  #result(lane: RuntimeFailureBudgetLane, key: string, decision: RuntimeAdmissionDecision, reason: RuntimeAdmissionReason): RuntimeAdmissionResult {
    const state = this.#state[lane];
    return Object.freeze({ decision, reason, lane, key, inFlight: state.inFlight.size, queued: state.queued.length });
  }
}
