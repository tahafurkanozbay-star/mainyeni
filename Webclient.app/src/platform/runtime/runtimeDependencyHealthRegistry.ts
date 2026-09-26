export type RuntimeDependencyHealthState = 'healthy' | 'degraded' | 'unavailable';
export type RuntimeDependencyObservationOutcome = 'success' | 'failure' | 'timeout' | 'rejected';

export interface RuntimeDependencyHealthPolicy {
  readonly windowSize: number;
  readonly minimumSamples: number;
  readonly degradedFailureRatio: number;
  readonly unavailableFailureRatio: number;
  readonly recoverySuccesses: number;
  readonly staleAfterMs: number;
  readonly maximumDependencies: number;
  readonly maximumHistory: number;
}

export interface RuntimeDependencyObservation {
  readonly dependency: string;
  readonly outcome: RuntimeDependencyObservationOutcome;
  readonly observedAt: number;
  readonly latencyMs?: number;
}

export interface RuntimeDependencyHealthSnapshot {
  readonly dependency: string;
  readonly state: RuntimeDependencyHealthState;
  readonly sampleCount: number;
  readonly failureCount: number;
  readonly consecutiveSuccesses: number;
  readonly failureRatio: number;
  readonly averageLatencyMs: number | null;
  readonly lastObservedAt: number | null;
  readonly stale: boolean;
  readonly revision: number;
}

export interface RuntimeDependencyHealthTransition {
  readonly dependency: string;
  readonly from: RuntimeDependencyHealthState;
  readonly to: RuntimeDependencyHealthState;
  readonly reason: 'failure-ratio' | 'recovery' | 'stale' | 'reset';
  readonly occurredAt: number;
  readonly revision: number;
}

interface MutableDependencyState {
  readonly dependency: string;
  state: RuntimeDependencyHealthState;
  readonly observations: RuntimeDependencyObservation[];
  consecutiveSuccesses: number;
  lastObservedAt: number | null;
  revision: number;
}

const DEFAULT_POLICY: RuntimeDependencyHealthPolicy = Object.freeze({
  windowSize: 32,
  minimumSamples: 4,
  degradedFailureRatio: 0.25,
  unavailableFailureRatio: 0.6,
  recoverySuccesses: 3,
  staleAfterMs: 60_000,
  maximumDependencies: 128,
  maximumHistory: 256,
});

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function assertRatio(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
}

function normalizeDependency(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError('dependency must not be empty');
  if (normalized.length > 160) throw new RangeError('dependency must not exceed 160 characters');
  return normalized;
}

function isFailure(outcome: RuntimeDependencyObservationOutcome): boolean {
  return outcome !== 'success';
}

function copyObservation(observation: RuntimeDependencyObservation): RuntimeDependencyObservation {
  return observation.latencyMs === undefined
    ? { dependency: observation.dependency, outcome: observation.outcome, observedAt: observation.observedAt }
    : { dependency: observation.dependency, outcome: observation.outcome, observedAt: observation.observedAt, latencyMs: observation.latencyMs };
}

function severity(state: RuntimeDependencyHealthState): number {
  return state === 'healthy' ? 0 : state === 'degraded' ? 1 : 2;
}

export class RuntimeDependencyHealthRegistry {
  readonly #policy: RuntimeDependencyHealthPolicy;
  readonly #dependencies = new Map<string, MutableDependencyState>();
  readonly #history: RuntimeDependencyHealthTransition[] = [];
  #revision = 0;

  public constructor(policy: Partial<RuntimeDependencyHealthPolicy> = {}) {
    const merged: RuntimeDependencyHealthPolicy = { ...DEFAULT_POLICY, ...policy };
    assertPositiveInteger(merged.windowSize, 'windowSize');
    assertPositiveInteger(merged.minimumSamples, 'minimumSamples');
    assertPositiveInteger(merged.recoverySuccesses, 'recoverySuccesses');
    assertPositiveInteger(merged.staleAfterMs, 'staleAfterMs');
    assertPositiveInteger(merged.maximumDependencies, 'maximumDependencies');
    assertPositiveInteger(merged.maximumHistory, 'maximumHistory');
    assertRatio(merged.degradedFailureRatio, 'degradedFailureRatio');
    assertRatio(merged.unavailableFailureRatio, 'unavailableFailureRatio');
    if (merged.minimumSamples > merged.windowSize) throw new RangeError('minimumSamples must not exceed windowSize');
    if (merged.degradedFailureRatio > merged.unavailableFailureRatio) throw new RangeError('degradedFailureRatio must not exceed unavailableFailureRatio');
    this.#policy = Object.freeze({ ...merged });
  }

  public get policy(): RuntimeDependencyHealthPolicy { return this.#policy; }

  public observe(input: Omit<RuntimeDependencyObservation, 'dependency'> & { readonly dependency: string }): RuntimeDependencyHealthSnapshot {
    const dependency = normalizeDependency(input.dependency);
    if (!Number.isFinite(input.observedAt) || input.observedAt < 0) throw new RangeError('observedAt must be a non-negative finite number');
    if (input.latencyMs !== undefined && (!Number.isFinite(input.latencyMs) || input.latencyMs < 0)) throw new RangeError('latencyMs must be a non-negative finite number');
    const state = this.#getOrCreate(dependency);
    if (state.lastObservedAt !== null && input.observedAt < state.lastObservedAt) throw new RangeError('observedAt must be monotonic per dependency');
    const observation: RuntimeDependencyObservation = input.latencyMs === undefined
      ? { dependency, outcome: input.outcome, observedAt: input.observedAt }
      : { dependency, outcome: input.outcome, observedAt: input.observedAt, latencyMs: input.latencyMs };
    state.observations.push(observation);
    if (state.observations.length > this.#policy.windowSize) state.observations.splice(0, state.observations.length - this.#policy.windowSize);
    state.lastObservedAt = input.observedAt;
    state.consecutiveSuccesses = input.outcome === 'success' ? state.consecutiveSuccesses + 1 : 0;
    state.revision = ++this.#revision;
    this.#reconcileState(state, input.observedAt);
    return this.#snapshot(state, input.observedAt);
  }

  public snapshot(dependency: string, now: number): RuntimeDependencyHealthSnapshot | null {
    this.#assertNow(now);
    const state = this.#dependencies.get(normalizeDependency(dependency));
    if (state === undefined) return null;
    this.#reconcileStaleness(state, now);
    return this.#snapshot(state, now);
  }

  public snapshots(now: number): readonly RuntimeDependencyHealthSnapshot[] {
    this.#assertNow(now);
    const result: RuntimeDependencyHealthSnapshot[] = [];
    for (const state of this.#dependencies.values()) {
      this.#reconcileStaleness(state, now);
      result.push(this.#snapshot(state, now));
    }
    return result.sort((left, right) => left.dependency.localeCompare(right.dependency));
  }

  public transitions(): readonly RuntimeDependencyHealthTransition[] { return this.#history.map((transition) => ({ ...transition })); }

  public observations(dependency: string): readonly RuntimeDependencyObservation[] {
    const state = this.#dependencies.get(normalizeDependency(dependency));
    return state === undefined ? [] : state.observations.map(copyObservation);
  }

  public reset(dependency: string, now: number): boolean {
    this.#assertNow(now);
    const key = normalizeDependency(dependency);
    const state = this.#dependencies.get(key);
    if (state === undefined) return false;
    const previous = state.state;
    state.state = 'healthy';
    state.observations.splice(0, state.observations.length);
    state.consecutiveSuccesses = 0;
    state.lastObservedAt = null;
    state.revision = ++this.#revision;
    if (previous !== 'healthy') this.#recordTransition(state, previous, 'healthy', 'reset', now);
    return true;
  }

  public remove(dependency: string): boolean { return this.#dependencies.delete(normalizeDependency(dependency)); }

  public clear(): void {
    this.#dependencies.clear();
    this.#history.splice(0, this.#history.length);
    this.#revision = 0;
  }

  #getOrCreate(dependency: string): MutableDependencyState {
    const existing = this.#dependencies.get(dependency);
    if (existing !== undefined) return existing;
    if (this.#dependencies.size >= this.#policy.maximumDependencies) throw new RangeError('maximum dependency capacity reached');
    const created: MutableDependencyState = { dependency, state: 'healthy', observations: [], consecutiveSuccesses: 0, lastObservedAt: null, revision: ++this.#revision };
    this.#dependencies.set(dependency, created);
    return created;
  }

  #reconcileState(state: MutableDependencyState, now: number): void {
    if (state.observations.length < this.#policy.minimumSamples) return;
    let failures = 0;
    for (const observation of state.observations) if (isFailure(observation.outcome)) failures += 1;
    const ratio = failures / state.observations.length;
    const evidenceState: RuntimeDependencyHealthState = ratio >= this.#policy.unavailableFailureRatio
      ? 'unavailable'
      : ratio >= this.#policy.degradedFailureRatio ? 'degraded' : 'healthy';

    let desired = evidenceState;
    const improving = severity(evidenceState) < severity(state.state);
    if (improving) {
      if (state.consecutiveSuccesses < this.#policy.recoverySuccesses) desired = state.state;
      else if (state.state === 'unavailable') desired = 'degraded';
    } else if (state.state === 'degraded' && state.consecutiveSuccesses > this.#policy.recoverySuccesses && evidenceState === 'degraded') {
      // A full additional successful observation after the recovery threshold proves
      // sustained recovery even while an older failure remains in the rolling window.
      desired = 'healthy';
    }

    if (desired !== state.state) {
      const previous = state.state;
      state.state = desired;
      state.revision = ++this.#revision;
      this.#recordTransition(state, previous, desired, severity(desired) < severity(previous) ? 'recovery' : 'failure-ratio', now);
    }
  }

  #reconcileStaleness(state: MutableDependencyState, now: number): void {
    if (state.lastObservedAt === null || now - state.lastObservedAt <= this.#policy.staleAfterMs || state.state === 'unavailable') return;
    const previous = state.state;
    state.state = 'unavailable';
    state.consecutiveSuccesses = 0;
    state.revision = ++this.#revision;
    this.#recordTransition(state, previous, 'unavailable', 'stale', now);
  }

  #recordTransition(state: MutableDependencyState, from: RuntimeDependencyHealthState, to: RuntimeDependencyHealthState, reason: RuntimeDependencyHealthTransition['reason'], occurredAt: number): void {
    this.#history.push({ dependency: state.dependency, from, to, reason, occurredAt, revision: state.revision });
    if (this.#history.length > this.#policy.maximumHistory) this.#history.splice(0, this.#history.length - this.#policy.maximumHistory);
  }

  #snapshot(state: MutableDependencyState, now: number): RuntimeDependencyHealthSnapshot {
    let failures = 0;
    let latencyTotal = 0;
    let latencyCount = 0;
    for (const observation of state.observations) {
      if (isFailure(observation.outcome)) failures += 1;
      if (observation.latencyMs !== undefined) { latencyTotal += observation.latencyMs; latencyCount += 1; }
    }
    return {
      dependency: state.dependency,
      state: state.state,
      sampleCount: state.observations.length,
      failureCount: failures,
      consecutiveSuccesses: state.consecutiveSuccesses,
      failureRatio: state.observations.length === 0 ? 0 : failures / state.observations.length,
      averageLatencyMs: latencyCount === 0 ? null : latencyTotal / latencyCount,
      lastObservedAt: state.lastObservedAt,
      stale: state.lastObservedAt !== null && now - state.lastObservedAt > this.#policy.staleAfterMs,
      revision: state.revision,
    };
  }

  #assertNow(now: number): void {
    if (!Number.isFinite(now) || now < 0) throw new RangeError('now must be a non-negative finite number');
  }
}
