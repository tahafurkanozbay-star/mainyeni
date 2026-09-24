import type { RuntimeFailureBudgetLane } from './runtimeFailureBudget';

export type RuntimeOverloadState = 'healthy' | 'pressured' | 'overloaded';
export interface RuntimeOverloadPolicy { readonly pressureThreshold: number; readonly overloadThreshold: number; readonly recoveryThreshold: number; readonly minimumSamples: number; readonly windowSize: number; }
export interface RuntimeOverloadSample { readonly lane: RuntimeFailureBudgetLane; readonly pressure: number; }
export interface RuntimeOverloadLaneSnapshot { readonly lane: RuntimeFailureBudgetLane; readonly state: RuntimeOverloadState; readonly samples: number; readonly averagePressure: number; readonly peakPressure: number; readonly transitions: number; }
export interface RuntimeOverloadSnapshot { readonly sequence: number; readonly state: RuntimeOverloadState; readonly lanes: Readonly<Record<RuntimeFailureBudgetLane, RuntimeOverloadLaneSnapshot>>; }
interface LaneState { samples: number[]; state: RuntimeOverloadState; transitions: number; }
const LANES: readonly RuntimeFailureBudgetLane[] = Object.freeze(['critical', 'interactive', 'background']);
const DEFAULT_POLICY: RuntimeOverloadPolicy = Object.freeze({ pressureThreshold: 0.6, overloadThreshold: 0.85, recoveryThreshold: 0.4, minimumSamples: 4, windowSize: 16 });
const rate = (value: number, name: string): number => { if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`); return value; };
const integer = (value: number, name: string, maximum: number): number => { if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError(`${name} must be a positive safe integer <= ${maximum}`); return value; };
const assertLane = (lane: RuntimeFailureBudgetLane): void => { if (!LANES.includes(lane)) throw new TypeError(`unsupported runtime overload lane: ${String(lane)}`); };
const normalizePolicy = (value: Partial<RuntimeOverloadPolicy>): RuntimeOverloadPolicy => {
  const pressureThreshold = rate(value.pressureThreshold ?? DEFAULT_POLICY.pressureThreshold, 'pressureThreshold');
  const overloadThreshold = rate(value.overloadThreshold ?? DEFAULT_POLICY.overloadThreshold, 'overloadThreshold');
  const recoveryThreshold = rate(value.recoveryThreshold ?? DEFAULT_POLICY.recoveryThreshold, 'recoveryThreshold');
  const windowSize = integer(value.windowSize ?? DEFAULT_POLICY.windowSize, 'windowSize', 10_000);
  const minimumSamples = integer(value.minimumSamples ?? DEFAULT_POLICY.minimumSamples, 'minimumSamples', windowSize);
  if (minimumSamples > windowSize) throw new RangeError('minimumSamples must not exceed windowSize');
  if (recoveryThreshold > pressureThreshold) throw new RangeError('recoveryThreshold must not exceed pressureThreshold');
  if (pressureThreshold > overloadThreshold) throw new RangeError('pressureThreshold must not exceed overloadThreshold');
  return Object.freeze({ pressureThreshold, overloadThreshold, recoveryThreshold, minimumSamples, windowSize });
};
const rank = (state: RuntimeOverloadState): number => state === 'overloaded' ? 2 : state === 'pressured' ? 1 : 0;
export class RuntimeOverloadGuard {
  readonly #policy: RuntimeOverloadPolicy;
  readonly #lanes: Record<RuntimeFailureBudgetLane, LaneState> = { critical: { samples: [], state: 'healthy', transitions: 0 }, interactive: { samples: [], state: 'healthy', transitions: 0 }, background: { samples: [], state: 'healthy', transitions: 0 } };
  #sequence = 0;
  constructor(policy: Partial<RuntimeOverloadPolicy> = {}) { this.#policy = normalizePolicy(policy); }
  record(sample: RuntimeOverloadSample): RuntimeOverloadLaneSnapshot {
    assertLane(sample.lane); const pressure = rate(sample.pressure, 'pressure'); const lane = this.#lanes[sample.lane]; lane.samples.push(pressure);
    const overflow = lane.samples.length - this.#policy.windowSize; if (overflow > 0) lane.samples.splice(0, overflow);
    const next = this.#classify(lane); if (next !== lane.state) { lane.state = next; lane.transitions += 1; } this.#sequence += 1; return this.lane(sample.lane);
  }
  recordMany(samples: readonly RuntimeOverloadSample[]): RuntimeOverloadSnapshot { if (!Array.isArray(samples)) throw new TypeError('samples must be an array'); if (samples.length > 10_000) throw new RangeError('samples must contain at most 10000 entries'); for (const sample of samples) this.record(sample); return this.snapshot(); }
  lane(lane: RuntimeFailureBudgetLane): RuntimeOverloadLaneSnapshot { assertLane(lane); const value = this.#lanes[lane]; let sum = 0; let peakPressure = 0; for (const pressure of value.samples) { sum += pressure; peakPressure = Math.max(peakPressure, pressure); } return Object.freeze({ lane, state: value.state, samples: value.samples.length, averagePressure: value.samples.length === 0 ? 0 : sum / value.samples.length, peakPressure, transitions: value.transitions }); }
  snapshot(): RuntimeOverloadSnapshot { const lanes = Object.freeze({ critical: this.lane('critical'), interactive: this.lane('interactive'), background: this.lane('background') }); let state: RuntimeOverloadState = 'healthy'; for (const lane of LANES) if (rank(lanes[lane].state) > rank(state)) state = lanes[lane].state; return Object.freeze({ sequence: this.#sequence, state, lanes }); }
  policy(): RuntimeOverloadPolicy { return this.#policy; }
  reset(lane?: RuntimeFailureBudgetLane): void { const resetLane = (current: RuntimeFailureBudgetLane): void => { this.#lanes[current].samples.length = 0; this.#lanes[current].state = 'healthy'; this.#lanes[current].transitions = 0; }; if (lane !== undefined) { assertLane(lane); resetLane(lane); } else for (const current of LANES) resetLane(current); this.#sequence += 1; }
  #classify(lane: LaneState): RuntimeOverloadState { if (lane.samples.length < this.#policy.minimumSamples) return lane.state; const average = lane.samples.reduce((sum, value) => sum + value, 0) / lane.samples.length; if (lane.state !== 'healthy' && average <= this.#policy.recoveryThreshold) return 'healthy'; if (average >= this.#policy.overloadThreshold) return 'overloaded'; if (average >= this.#policy.pressureThreshold) return 'pressured'; if (lane.state === 'overloaded') return 'pressured'; return lane.state === 'pressured' ? 'pressured' : 'healthy'; }
}
