export type RuntimeDependencySloState = 'healthy' | 'degraded' | 'exhausted';
export type RuntimeDependencySloOutcome = 'success' | 'failure' | 'timeout' | 'rejected';

export interface RuntimeDependencySloPolicy {
  readonly windowSize: number;
  readonly minimumSamples: number;
  readonly degradedFailureRatio: number;
  readonly exhaustedFailureRatio: number;
  readonly degradedLatencyMs: number;
  readonly exhaustedLatencyMs: number;
  readonly recoveryConfirmations: number;
  readonly maximumDependencies: number;
  readonly maximumHistory: number;
}

export interface RuntimeDependencySloSample {
  readonly dependency: string;
  readonly outcome: RuntimeDependencySloOutcome;
  readonly latencyMs: number;
  readonly observedAt: number;
}

export interface RuntimeDependencySloSnapshot {
  readonly dependency: string;
  readonly state: RuntimeDependencySloState;
  readonly sampleCount: number;
  readonly failureCount: number;
  readonly failureRatio: number;
  readonly averageLatencyMs: number;
  readonly maximumLatencyMs: number;
  readonly consecutiveRecoverySamples: number;
  readonly revision: number;
  readonly evaluatedAt: number;
}

export interface RuntimeDependencySloTransition {
  readonly dependency: string;
  readonly from: RuntimeDependencySloState;
  readonly to: RuntimeDependencySloState;
  readonly at: number;
  readonly revision: number;
}

const DEFAULT_POLICY: RuntimeDependencySloPolicy = {
  windowSize: 32,
  minimumSamples: 4,
  degradedFailureRatio: 0.2,
  exhaustedFailureRatio: 0.5,
  degradedLatencyMs: 1_000,
  exhaustedLatencyMs: 3_000,
  recoveryConfirmations: 3,
  maximumDependencies: 128,
  maximumHistory: 256,
};

interface DependencyState {
  samples: RuntimeDependencySloSample[];
  snapshot: RuntimeDependencySloSnapshot;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function finiteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
}

function ratio(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
}

function normalizeDependency(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('dependency must not be blank');
  if (normalized.length > 160) throw new Error('dependency exceeds maximum identifier length');
  return normalized;
}

function copySnapshot(snapshot: RuntimeDependencySloSnapshot): RuntimeDependencySloSnapshot {
  return { ...snapshot };
}

function copyTransition(transition: RuntimeDependencySloTransition): RuntimeDependencySloTransition {
  return { ...transition };
}

export class RuntimeDependencySloController {
  readonly #policy: RuntimeDependencySloPolicy;
  readonly #dependencies = new Map<string, DependencyState>();
  readonly #history: RuntimeDependencySloTransition[] = [];
  #revision = 0;
  #lastObservedAt = -1;

  constructor(policy: Partial<RuntimeDependencySloPolicy> = {}) {
    this.#policy = { ...DEFAULT_POLICY, ...policy };
    positiveInteger(this.#policy.windowSize, 'windowSize');
    positiveInteger(this.#policy.minimumSamples, 'minimumSamples');
    positiveInteger(this.#policy.recoveryConfirmations, 'recoveryConfirmations');
    positiveInteger(this.#policy.maximumDependencies, 'maximumDependencies');
    positiveInteger(this.#policy.maximumHistory, 'maximumHistory');
    if (this.#policy.minimumSamples > this.#policy.windowSize) throw new Error('minimumSamples cannot exceed windowSize');
    ratio(this.#policy.degradedFailureRatio, 'degradedFailureRatio');
    ratio(this.#policy.exhaustedFailureRatio, 'exhaustedFailureRatio');
    if (this.#policy.degradedFailureRatio > this.#policy.exhaustedFailureRatio) throw new Error('degradedFailureRatio cannot exceed exhaustedFailureRatio');
    finiteNonNegative(this.#policy.degradedLatencyMs, 'degradedLatencyMs');
    finiteNonNegative(this.#policy.exhaustedLatencyMs, 'exhaustedLatencyMs');
    if (this.#policy.degradedLatencyMs > this.#policy.exhaustedLatencyMs) throw new Error('degradedLatencyMs cannot exceed exhaustedLatencyMs');
  }

  record(sample: RuntimeDependencySloSample): RuntimeDependencySloSnapshot {
    const dependency = normalizeDependency(sample.dependency);
    finiteNonNegative(sample.latencyMs, 'latencyMs');
    finiteNonNegative(sample.observedAt, 'observedAt');
    if (sample.observedAt < this.#lastObservedAt) throw new Error('SLO evidence time must be monotonic');
    this.#lastObservedAt = sample.observedAt;

    let current = this.#dependencies.get(dependency);
    if (!current) {
      if (this.#dependencies.size >= this.#policy.maximumDependencies) throw new Error('maximum dependency SLO capacity exceeded');
      current = {
        samples: [],
        snapshot: {
          dependency,
          state: 'healthy',
          sampleCount: 0,
          failureCount: 0,
          failureRatio: 0,
          averageLatencyMs: 0,
          maximumLatencyMs: 0,
          consecutiveRecoverySamples: 0,
          revision: 0,
          evaluatedAt: sample.observedAt,
        },
      };
      this.#dependencies.set(dependency, current);
    }

    current.samples.push({ ...sample, dependency });
    if (current.samples.length > this.#policy.windowSize) current.samples.splice(0, current.samples.length - this.#policy.windowSize);

    const sampleCount = current.samples.length;
    let failureCount = 0;
    let latencyTotal = 0;
    let maximumLatencyMs = 0;
    for (const evidence of current.samples) {
      if (evidence.outcome !== 'success') failureCount += 1;
      latencyTotal += evidence.latencyMs;
      maximumLatencyMs = Math.max(maximumLatencyMs, evidence.latencyMs);
    }
    const failureRatio = sampleCount === 0 ? 0 : failureCount / sampleCount;
    const averageLatencyMs = sampleCount === 0 ? 0 : latencyTotal / sampleCount;
    const candidate = this.#candidateState(sampleCount, failureRatio, averageLatencyMs, maximumLatencyMs);
    const previous = current.snapshot;
    const recovering = this.#severity(candidate) < this.#severity(previous.state);
    const recoverySample = sample.outcome === 'success' && sample.latencyMs < this.#policy.degradedLatencyMs;
    const confirmations = recovering && recoverySample ? previous.consecutiveRecoverySamples + 1 : recovering ? 0 : candidate === previous.state && previous.state !== 'healthy' && recoverySample ? previous.consecutiveRecoverySamples + 1 : 0;
    const nextState = recovering && confirmations < this.#policy.recoveryConfirmations ? previous.state : candidate;

    this.#revision += 1;
    const snapshot: RuntimeDependencySloSnapshot = {
      dependency,
      state: nextState,
      sampleCount,
      failureCount,
      failureRatio,
      averageLatencyMs,
      maximumLatencyMs,
      consecutiveRecoverySamples: nextState === candidate ? 0 : confirmations,
      revision: this.#revision,
      evaluatedAt: sample.observedAt,
    };
    current.snapshot = snapshot;
    if (nextState !== previous.state) this.#recordTransition(dependency, previous.state, nextState, sample.observedAt, this.#revision);
    return copySnapshot(snapshot);
  }

  get(dependency: string): RuntimeDependencySloSnapshot | null {
    const state = this.#dependencies.get(normalizeDependency(dependency));
    return state ? copySnapshot(state.snapshot) : null;
  }

  snapshots(): readonly RuntimeDependencySloSnapshot[] {
    return [...this.#dependencies.values()].map((state) => copySnapshot(state.snapshot)).sort((left, right) => left.dependency.localeCompare(right.dependency));
  }

  transitions(): readonly RuntimeDependencySloTransition[] {
    return this.#history.map(copyTransition);
  }

  remove(dependency: string): boolean {
    return this.#dependencies.delete(normalizeDependency(dependency));
  }

  clear(): void {
    this.#dependencies.clear();
    this.#history.length = 0;
    this.#revision = 0;
    this.#lastObservedAt = -1;
  }

  #candidateState(sampleCount: number, failureRatio: number, averageLatencyMs: number, maximumLatencyMs: number): RuntimeDependencySloState {
    if (sampleCount < this.#policy.minimumSamples) return 'healthy';
    if (failureRatio >= this.#policy.exhaustedFailureRatio || averageLatencyMs >= this.#policy.exhaustedLatencyMs || maximumLatencyMs >= this.#policy.exhaustedLatencyMs * 2) return 'exhausted';
    if (failureRatio >= this.#policy.degradedFailureRatio || averageLatencyMs >= this.#policy.degradedLatencyMs) return 'degraded';
    return 'healthy';
  }

  #severity(state: RuntimeDependencySloState): number {
    return state === 'healthy' ? 0 : state === 'degraded' ? 1 : 2;
  }

  #recordTransition(dependency: string, from: RuntimeDependencySloState, to: RuntimeDependencySloState, at: number, revision: number): void {
    this.#history.push({ dependency, from, to, at, revision });
    if (this.#history.length > this.#policy.maximumHistory) this.#history.splice(0, this.#history.length - this.#policy.maximumHistory);
  }
}
