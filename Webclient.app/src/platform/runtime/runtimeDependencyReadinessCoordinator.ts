import type { RuntimeDependencyHealthSnapshot } from './runtimeDependencyHealthRegistry';
import type { RuntimeDependencyImpactSnapshot } from './runtimeDependencyTopology';

export type RuntimeReadinessState = 'ready' | 'degraded' | 'blocked';
export type RuntimeReadinessReason =
  | 'healthy'
  | 'dependency-degraded'
  | 'dependency-blocked'
  | 'dependency-stale'
  | 'missing-health-evidence'
  | 'insufficient-health-evidence';

export interface RuntimeDependencyReadinessPolicy {
  readonly maximumServices: number;
  readonly maximumEvidenceAgeMs: number;
  readonly minimumHealthSamples: number;
  readonly recoveryConfirmations: number;
  readonly maximumHistory: number;
}

export interface RuntimeDependencyReadinessInput {
  readonly service: string;
  readonly topology: RuntimeDependencyImpactSnapshot;
  readonly health: readonly RuntimeDependencyHealthSnapshot[];
  readonly evaluatedAt: number;
}

export interface RuntimeDependencyReadinessDecision {
  readonly service: string;
  readonly state: RuntimeReadinessState;
  readonly reason: RuntimeReadinessReason;
  readonly blockers: readonly string[];
  readonly degradedBy: readonly string[];
  readonly staleDependencies: readonly string[];
  readonly missingDependencies: readonly string[];
  readonly evaluatedAt: number;
  readonly revision: number;
}

export interface RuntimeDependencyReadinessTransition {
  readonly service: string;
  readonly from: RuntimeReadinessState;
  readonly to: RuntimeReadinessState;
  readonly reason: RuntimeReadinessReason;
  readonly occurredAt: number;
  readonly revision: number;
}

interface MutableReadinessState {
  state: RuntimeReadinessState;
  pendingRecoveryState: RuntimeReadinessState | null;
  recoveryConfirmations: number;
  decision: RuntimeDependencyReadinessDecision;
}

const DEFAULT_POLICY: RuntimeDependencyReadinessPolicy = Object.freeze({
  maximumServices: 128,
  maximumEvidenceAgeMs: 60_000,
  minimumHealthSamples: 1,
  recoveryConfirmations: 2,
  maximumHistory: 256,
});

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function normalizeService(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError('service must not be empty');
  if (normalized.length > 160) throw new RangeError('service must not exceed 160 characters');
  return normalized;
}

function assertTime(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('evaluatedAt must be a non-negative finite number');
}

function severity(value: RuntimeReadinessState): number {
  if (value === 'ready') return 0;
  return value === 'degraded' ? 1 : 2;
}

function uniqueSorted(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort();
}

export class RuntimeDependencyReadinessCoordinator {
  readonly #policy: RuntimeDependencyReadinessPolicy;
  readonly #services = new Map<string, MutableReadinessState>();
  readonly #history: RuntimeDependencyReadinessTransition[] = [];
  #revision = 0;
  #lastEvaluatedAt = 0;

  public constructor(policy: Partial<RuntimeDependencyReadinessPolicy> = {}) {
    const merged = { ...DEFAULT_POLICY, ...policy };
    positiveInteger(merged.maximumServices, 'maximumServices');
    positiveInteger(merged.maximumEvidenceAgeMs, 'maximumEvidenceAgeMs');
    positiveInteger(merged.minimumHealthSamples, 'minimumHealthSamples');
    positiveInteger(merged.recoveryConfirmations, 'recoveryConfirmations');
    positiveInteger(merged.maximumHistory, 'maximumHistory');
    this.#policy = Object.freeze(merged);
  }

  public get policy(): RuntimeDependencyReadinessPolicy { return this.#policy; }

  public evaluate(input: RuntimeDependencyReadinessInput): RuntimeDependencyReadinessDecision {
    assertTime(input.evaluatedAt);
    if (input.evaluatedAt < this.#lastEvaluatedAt) throw new RangeError('evaluatedAt must be monotonic');
    this.#lastEvaluatedAt = input.evaluatedAt;
    const service = normalizeService(input.service);
    if (input.topology.node !== service) throw new Error(`topology node does not match service: ${service}`);

    const healthByDependency = new Map<string, RuntimeDependencyHealthSnapshot>();
    for (const snapshot of input.health) {
      if (healthByDependency.has(snapshot.dependency)) throw new Error(`duplicate health evidence: ${snapshot.dependency}`);
      if (snapshot.lastObservedAt !== null && snapshot.lastObservedAt > input.evaluatedAt) {
        throw new RangeError(`health evidence is from the future: ${snapshot.dependency}`);
      }
      healthByDependency.set(snapshot.dependency, snapshot);
    }

    const topologyDependencies = uniqueSorted([...input.topology.blockedBy, ...input.topology.degradedBy]);
    const blockers = new Set(input.topology.blockedBy);
    const degradedBy = new Set(input.topology.degradedBy);
    const staleDependencies = new Set<string>();
    const missingDependencies = new Set<string>();
    let insufficientEvidence = false;

    for (const dependency of topologyDependencies) {
      const health = healthByDependency.get(dependency);
      if (health === undefined) {
        missingDependencies.add(dependency);
        blockers.add(dependency);
        continue;
      }
      if (health.sampleCount < this.#policy.minimumHealthSamples) {
        insufficientEvidence = true;
        blockers.add(dependency);
      }
      const evidenceAge = health.lastObservedAt === null ? Number.POSITIVE_INFINITY : input.evaluatedAt - health.lastObservedAt;
      if (health.stale || evidenceAge > this.#policy.maximumEvidenceAgeMs) {
        staleDependencies.add(dependency);
        blockers.add(dependency);
      }
      if (health.state === 'unavailable') blockers.add(dependency);
      else if (health.state === 'degraded') degradedBy.add(dependency);
    }

    let candidateState: RuntimeReadinessState;
    let reason: RuntimeReadinessReason;
    if (missingDependencies.size > 0) {
      candidateState = 'blocked';
      reason = 'missing-health-evidence';
    } else if (staleDependencies.size > 0) {
      candidateState = 'blocked';
      reason = 'dependency-stale';
    } else if (insufficientEvidence) {
      candidateState = 'blocked';
      reason = 'insufficient-health-evidence';
    } else if (blockers.size > 0 || input.topology.effectiveImpact === 'blocked') {
      candidateState = 'blocked';
      reason = 'dependency-blocked';
    } else if (degradedBy.size > 0 || input.topology.effectiveImpact === 'degraded') {
      candidateState = 'degraded';
      reason = 'dependency-degraded';
    } else {
      candidateState = 'ready';
      reason = 'healthy';
    }

    let mutable = this.#services.get(service);
    if (mutable === undefined) {
      if (this.#services.size >= this.#policy.maximumServices) throw new RangeError('maximum readiness service capacity reached');
      const decision = this.#decision(service, candidateState, reason, blockers, degradedBy, staleDependencies, missingDependencies, input.evaluatedAt);
      mutable = { state: candidateState, pendingRecoveryState: null, recoveryConfirmations: 0, decision };
      this.#services.set(service, mutable);
      return { ...decision, blockers: [...decision.blockers], degradedBy: [...decision.degradedBy], staleDependencies: [...decision.staleDependencies], missingDependencies: [...decision.missingDependencies] };
    }

    const previous = mutable.state;
    let next = candidateState;
    if (severity(candidateState) < severity(previous)) {
      if (mutable.pendingRecoveryState === candidateState) mutable.recoveryConfirmations += 1;
      else {
        mutable.pendingRecoveryState = candidateState;
        mutable.recoveryConfirmations = 1;
      }
      if (mutable.recoveryConfirmations < this.#policy.recoveryConfirmations) next = previous;
    } else {
      mutable.pendingRecoveryState = null;
      mutable.recoveryConfirmations = 0;
    }

    if (next !== previous) {
      mutable.state = next;
      mutable.pendingRecoveryState = null;
      mutable.recoveryConfirmations = 0;
      this.#recordTransition(service, previous, next, reason, input.evaluatedAt);
    }
    const effectiveReason = next === candidateState ? reason : mutable.decision.reason;
    mutable.decision = this.#decision(service, next, effectiveReason, blockers, degradedBy, staleDependencies, missingDependencies, input.evaluatedAt);
    return this.#copyDecision(mutable.decision);
  }

  public get(service: string): RuntimeDependencyReadinessDecision | null {
    const state = this.#services.get(normalizeService(service));
    return state === undefined ? null : this.#copyDecision(state.decision);
  }

  public decisions(): readonly RuntimeDependencyReadinessDecision[] {
    return [...this.#services.values()].map((value) => this.#copyDecision(value.decision)).sort((left, right) => left.service.localeCompare(right.service));
  }

  public transitions(): readonly RuntimeDependencyReadinessTransition[] {
    return this.#history.map((transition) => ({ ...transition }));
  }

  public remove(service: string): boolean { return this.#services.delete(normalizeService(service)); }

  public clear(): void {
    this.#services.clear();
    this.#history.splice(0, this.#history.length);
    this.#revision = 0;
    this.#lastEvaluatedAt = 0;
  }

  #decision(
    service: string,
    state: RuntimeReadinessState,
    reason: RuntimeReadinessReason,
    blockers: Iterable<string>,
    degradedBy: Iterable<string>,
    staleDependencies: Iterable<string>,
    missingDependencies: Iterable<string>,
    evaluatedAt: number,
  ): RuntimeDependencyReadinessDecision {
    return {
      service,
      state,
      reason,
      blockers: uniqueSorted(blockers),
      degradedBy: uniqueSorted(degradedBy),
      staleDependencies: uniqueSorted(staleDependencies),
      missingDependencies: uniqueSorted(missingDependencies),
      evaluatedAt,
      revision: ++this.#revision,
    };
  }

  #copyDecision(decision: RuntimeDependencyReadinessDecision): RuntimeDependencyReadinessDecision {
    return {
      ...decision,
      blockers: [...decision.blockers],
      degradedBy: [...decision.degradedBy],
      staleDependencies: [...decision.staleDependencies],
      missingDependencies: [...decision.missingDependencies],
    };
  }

  #recordTransition(service: string, from: RuntimeReadinessState, to: RuntimeReadinessState, reason: RuntimeReadinessReason, occurredAt: number): void {
    this.#history.push({ service, from, to, reason, occurredAt, revision: this.#revision + 1 });
    if (this.#history.length > this.#policy.maximumHistory) this.#history.splice(0, this.#history.length - this.#policy.maximumHistory);
  }
}
