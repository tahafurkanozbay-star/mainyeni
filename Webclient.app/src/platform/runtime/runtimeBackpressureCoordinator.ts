import type { RuntimeFailureBudgetLane } from './runtimeFailureBudget';
import type { RuntimeSaturationLevel } from './runtimeSaturationLedger';

export type RuntimeBackpressureAction = 'admit' | 'defer' | 'shed';
export type RuntimeBackpressureReason = 'healthy' | 'saturation' | 'overload' | 'queue-limit' | 'shed-limit';
export interface RuntimeBackpressurePolicy { readonly maxDeferred: Readonly<Record<RuntimeFailureBudgetLane, number>>; readonly maxShedPerWindow: Readonly<Record<RuntimeFailureBudgetLane, number>>; readonly recoverySamples: number; readonly historyLimit: number; }
export interface RuntimeBackpressureSignal { readonly lane: RuntimeFailureBudgetLane; readonly saturation: RuntimeSaturationLevel; readonly overloaded: boolean; readonly at: number; }
export interface RuntimeBackpressureDecision { readonly action: RuntimeBackpressureAction; readonly reason: RuntimeBackpressureReason; readonly lane: RuntimeFailureBudgetLane; readonly sequence: number; readonly at: number; }
export interface RuntimeBackpressureLaneSnapshot { readonly deferred: number; readonly shed: number; readonly healthySamples: number; readonly lastAction: RuntimeBackpressureAction | null; }
export interface RuntimeBackpressureSnapshot { readonly sequence: number; readonly lanes: Readonly<Record<RuntimeFailureBudgetLane, RuntimeBackpressureLaneSnapshot>>; readonly history: readonly RuntimeBackpressureDecision[]; }
export type RuntimeBackpressurePolicyInput = Omit<Partial<RuntimeBackpressurePolicy>, 'maxDeferred' | 'maxShedPerWindow'> & { readonly maxDeferred?: Readonly<Partial<Record<RuntimeFailureBudgetLane, number>>>; readonly maxShedPerWindow?: Readonly<Partial<Record<RuntimeFailureBudgetLane, number>>>; };

const LANES: readonly RuntimeFailureBudgetLane[] = Object.freeze(['critical', 'interactive', 'background']);
const LEVELS: readonly RuntimeSaturationLevel[] = Object.freeze(['cold', 'healthy', 'warning', 'critical']);
const DEFAULT_POLICY: RuntimeBackpressurePolicy = Object.freeze({ maxDeferred: Object.freeze({ critical: 32, interactive: 24, background: 8 }), maxShedPerWindow: Object.freeze({ critical: 8, interactive: 16, background: 32 }), recoverySamples: 3, historyLimit: 256 });
const integer = (value: number, name: string, min: number, max: number): number => { if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer between ${min} and ${max}`); return value; };
const assertLane = (lane: RuntimeFailureBudgetLane): void => { if (!LANES.includes(lane)) throw new TypeError(`unsupported backpressure lane: ${String(lane)}`); };
const assertLevel = (level: RuntimeSaturationLevel): void => { if (!LEVELS.includes(level)) throw new TypeError(`unsupported saturation level: ${String(level)}`); };
const normalizeLaneNumbers = (supplied: Readonly<Partial<Record<RuntimeFailureBudgetLane, number>>> | undefined, fallback: Readonly<Record<RuntimeFailureBudgetLane, number>>, name: string): Readonly<Record<RuntimeFailureBudgetLane, number>> => Object.freeze({ critical: integer(supplied?.critical ?? fallback.critical, `${name}.critical`, 0, 10_000), interactive: integer(supplied?.interactive ?? fallback.interactive, `${name}.interactive`, 0, 10_000), background: integer(supplied?.background ?? fallback.background, `${name}.background`, 0, 10_000) });
const normalizePolicy = (value: RuntimeBackpressurePolicyInput): RuntimeBackpressurePolicy => Object.freeze({ maxDeferred: normalizeLaneNumbers(value.maxDeferred, DEFAULT_POLICY.maxDeferred, 'maxDeferred'), maxShedPerWindow: normalizeLaneNumbers(value.maxShedPerWindow, DEFAULT_POLICY.maxShedPerWindow, 'maxShedPerWindow'), recoverySamples: integer(value.recoverySamples ?? DEFAULT_POLICY.recoverySamples, 'recoverySamples', 1, 1_000), historyLimit: integer(value.historyLimit ?? DEFAULT_POLICY.historyLimit, 'historyLimit', 1, 10_000) });
interface MutableLaneState { deferred: number; shed: number; healthySamples: number; lastAction: RuntimeBackpressureAction | null; }
const newLane = (): MutableLaneState => ({ deferred: 0, shed: 0, healthySamples: 0, lastAction: null });

export class RuntimeBackpressureCoordinator {
  readonly #policy: RuntimeBackpressurePolicy;
  readonly #lanes: Record<RuntimeFailureBudgetLane, MutableLaneState> = { critical: newLane(), interactive: newLane(), background: newLane() };
  readonly #history: RuntimeBackpressureDecision[] = [];
  #sequence = 0;
  #lastAt = 0;
  constructor(policy: RuntimeBackpressurePolicyInput = {}) { this.#policy = normalizePolicy(policy); }
  decide(signal: RuntimeBackpressureSignal): RuntimeBackpressureDecision {
    assertLane(signal.lane); assertLevel(signal.saturation);
    if (typeof signal.overloaded !== 'boolean') throw new TypeError('overloaded must be boolean');
    if (!Number.isFinite(signal.at) || signal.at < 0) throw new RangeError('at must be a finite non-negative number');
    if (signal.at < this.#lastAt) throw new RangeError('at must be monotonic');
    this.#lastAt = signal.at;
    const state = this.#lanes[signal.lane];
    const healthy = !signal.overloaded && (signal.saturation === 'healthy' || signal.saturation === 'cold');
    if (healthy) { state.healthySamples = Math.min(this.#policy.recoverySamples, state.healthySamples + 1); if (state.healthySamples >= this.#policy.recoverySamples) { state.shed = 0; state.deferred = Math.max(0, state.deferred - 1); } return this.#record(signal, 'admit', 'healthy'); }
    state.healthySamples = 0;
    if (signal.overloaded || signal.saturation === 'critical') { if (state.shed >= this.#policy.maxShedPerWindow[signal.lane]) return this.#record(signal, 'defer', 'shed-limit'); state.shed += 1; return this.#record(signal, 'shed', signal.overloaded ? 'overload' : 'saturation'); }
    if (state.deferred >= this.#policy.maxDeferred[signal.lane]) { if (state.shed < this.#policy.maxShedPerWindow[signal.lane]) { state.shed += 1; return this.#record(signal, 'shed', 'queue-limit'); } return this.#record(signal, 'defer', 'shed-limit'); }
    state.deferred += 1; return this.#record(signal, 'defer', 'saturation');
  }
  releaseDeferred(lane: RuntimeFailureBudgetLane, count = 1): RuntimeBackpressureSnapshot { assertLane(lane); integer(count, 'count', 1, 10_000); this.#lanes[lane].deferred = Math.max(0, this.#lanes[lane].deferred - count); return this.snapshot(); }
  reset(lane?: RuntimeFailureBudgetLane): RuntimeBackpressureSnapshot { if (lane !== undefined) { assertLane(lane); this.#lanes[lane] = newLane(); } else { for (const current of LANES) this.#lanes[current] = newLane(); this.#history.length = 0; this.#lastAt = 0; } this.#sequence += 1; return this.snapshot(); }
  policy(): RuntimeBackpressurePolicy { return this.#policy; }
  snapshot(): RuntimeBackpressureSnapshot { const laneSnapshot = (lane: RuntimeFailureBudgetLane): RuntimeBackpressureLaneSnapshot => Object.freeze({ ...this.#lanes[lane] }); return Object.freeze({ sequence: this.#sequence, lanes: Object.freeze({ critical: laneSnapshot('critical'), interactive: laneSnapshot('interactive'), background: laneSnapshot('background') }), history: Object.freeze(this.#history.map((item) => Object.freeze({ ...item }))) }); }
  #record(signal: RuntimeBackpressureSignal, action: RuntimeBackpressureAction, reason: RuntimeBackpressureReason): RuntimeBackpressureDecision { this.#sequence += 1; this.#lanes[signal.lane].lastAction = action; const decision = Object.freeze({ action, reason, lane: signal.lane, sequence: this.#sequence, at: signal.at }); this.#history.push(decision); const overflow = this.#history.length - this.#policy.historyLimit; if (overflow > 0) this.#history.splice(0, overflow); return decision; }
}
