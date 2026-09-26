export type DependencyChangeRisk = 'low' | 'elevated' | 'high' | 'critical';
export type DependencyChangeDecision = 'allow' | 'stage' | 'block';

export interface DependencyChangeGuardPolicy {
  readonly maxServices: number;
  readonly maxDependenciesPerService: number;
  readonly maxHistoryEntries: number;
  readonly maxChangeUnits: number;
  readonly maxConcurrentChanges: number;
  readonly elevatedRiskUnits: number;
  readonly highRiskUnits: number;
  readonly criticalRiskUnits: number;
  readonly recoveryConfirmations: number;
}

export interface DependencyChangeRequest {
  readonly service: string;
  readonly dependency: string;
  readonly changeId: string;
  readonly changeUnits: number;
  readonly dependencyHealthy: boolean;
  readonly dependencyStale: boolean;
  readonly required: boolean;
  readonly evaluatedAt: number;
}

export interface DependencyChangeGuardResult {
  readonly service: string;
  readonly dependency: string;
  readonly changeId: string;
  readonly decision: DependencyChangeDecision;
  readonly risk: DependencyChangeRisk;
  readonly reasons: readonly string[];
  readonly activeChanges: number;
  readonly recoveryEvidence: number;
  readonly evaluatedAt: number;
}

export interface DependencyChangeGuardEvent {
  readonly sequence: number;
  readonly service: string;
  readonly dependency: string;
  readonly changeId: string;
  readonly decision: DependencyChangeDecision;
  readonly risk: DependencyChangeRisk;
  readonly evaluatedAt: number;
}

interface ServiceState {
  readonly dependencies: Set<string>;
  readonly activeChanges: Set<string>;
  recoveryEvidence: number;
  lastEvaluatedAt: number;
}

const DEFAULT_POLICY: DependencyChangeGuardPolicy = {
  maxServices: 128,
  maxDependenciesPerService: 32,
  maxHistoryEntries: 256,
  maxChangeUnits: 100,
  maxConcurrentChanges: 4,
  elevatedRiskUnits: 25,
  highRiskUnits: 50,
  criticalRiskUnits: 80,
  recoveryConfirmations: 2,
};

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function validatePolicy(policy: DependencyChangeGuardPolicy): void {
  assertPositiveInteger(policy.maxServices, 'maxServices');
  assertPositiveInteger(policy.maxDependenciesPerService, 'maxDependenciesPerService');
  assertPositiveInteger(policy.maxHistoryEntries, 'maxHistoryEntries');
  assertPositiveInteger(policy.maxChangeUnits, 'maxChangeUnits');
  assertPositiveInteger(policy.maxConcurrentChanges, 'maxConcurrentChanges');
  assertPositiveInteger(policy.recoveryConfirmations, 'recoveryConfirmations');
  const thresholds = [policy.elevatedRiskUnits, policy.highRiskUnits, policy.criticalRiskUnits];
  if (thresholds.some((value) => !Number.isFinite(value) || value < 0 || value > policy.maxChangeUnits)) {
    throw new Error('risk thresholds must be finite and within maxChangeUnits');
  }
  if (!(policy.elevatedRiskUnits <= policy.highRiskUnits && policy.highRiskUnits <= policy.criticalRiskUnits)) {
    throw new Error('risk thresholds must be monotonic');
  }
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be blank`);
  return normalized;
}

export class RuntimeDependencyChangeGuard {
  readonly #policy: DependencyChangeGuardPolicy;
  readonly #services = new Map<string, ServiceState>();
  readonly #history: DependencyChangeGuardEvent[] = [];
  #sequence = 0;

  constructor(policy: Partial<DependencyChangeGuardPolicy> = {}) {
    this.#policy = { ...DEFAULT_POLICY, ...policy };
    validatePolicy(this.#policy);
  }

  evaluate(request: DependencyChangeRequest): DependencyChangeGuardResult {
    const service = requireText(request.service, 'service');
    const dependency = requireText(request.dependency, 'dependency');
    const changeId = requireText(request.changeId, 'changeId');
    if (!Number.isFinite(request.evaluatedAt) || request.evaluatedAt < 0) throw new Error('evaluatedAt must be finite and non-negative');
    if (!Number.isFinite(request.changeUnits) || request.changeUnits < 0 || request.changeUnits > this.#policy.maxChangeUnits) {
      throw new Error('changeUnits must be finite and within policy capacity');
    }

    let state = this.#services.get(service);
    if (!state) {
      if (this.#services.size >= this.#policy.maxServices) throw new Error('dependency change guard service capacity exceeded');
      state = { dependencies: new Set<string>(), activeChanges: new Set<string>(), recoveryEvidence: 0, lastEvaluatedAt: -1 };
      this.#services.set(service, state);
    }
    if (request.evaluatedAt < state.lastEvaluatedAt) throw new Error('dependency change evidence must be monotonic');
    state.lastEvaluatedAt = request.evaluatedAt;

    if (!state.dependencies.has(dependency)) {
      if (state.dependencies.size >= this.#policy.maxDependenciesPerService) throw new Error('dependency capacity exceeded for service');
      state.dependencies.add(dependency);
    }

    const reasons: string[] = [];
    let decision: DependencyChangeDecision = 'allow';
    let risk = this.#riskFor(request.changeUnits);

    if (request.dependencyStale) {
      decision = 'block';
      risk = 'critical';
      reasons.push('dependency-evidence-stale');
      state.recoveryEvidence = 0;
    } else if (!request.dependencyHealthy && request.required) {
      decision = 'block';
      risk = 'critical';
      reasons.push('required-dependency-unhealthy');
      state.recoveryEvidence = 0;
    } else if (!request.dependencyHealthy) {
      decision = 'stage';
      risk = risk === 'low' ? 'elevated' : risk;
      reasons.push('optional-dependency-unhealthy');
      state.recoveryEvidence = 0;
    } else {
      state.recoveryEvidence = Math.min(this.#policy.recoveryConfirmations, state.recoveryEvidence + 1);
      if (state.recoveryEvidence < this.#policy.recoveryConfirmations && request.changeUnits >= this.#policy.highRiskUnits) {
        decision = 'stage';
        reasons.push('recovery-confirmation-pending');
      }
    }

    const alreadyActive = state.activeChanges.has(changeId);
    if (!alreadyActive && state.activeChanges.size >= this.#policy.maxConcurrentChanges) {
      decision = 'block';
      risk = 'critical';
      reasons.push('concurrent-change-capacity-exceeded');
    }

    if (risk === 'critical' && decision === 'allow') {
      decision = 'stage';
      reasons.push('critical-change-requires-staging');
    }

    if (decision !== 'block') state.activeChanges.add(changeId);
    const result: DependencyChangeGuardResult = {
      service,
      dependency,
      changeId,
      decision,
      risk,
      reasons: [...reasons],
      activeChanges: state.activeChanges.size,
      recoveryEvidence: state.recoveryEvidence,
      evaluatedAt: request.evaluatedAt,
    };
    this.#record(result);
    return result;
  }

  complete(serviceName: string, changeIdValue: string): boolean {
    const service = requireText(serviceName, 'service');
    const changeId = requireText(changeIdValue, 'changeId');
    return this.#services.get(service)?.activeChanges.delete(changeId) ?? false;
  }

  removeService(serviceName: string): boolean {
    return this.#services.delete(requireText(serviceName, 'service'));
  }

  snapshot(serviceName: string): { readonly dependencies: readonly string[]; readonly activeChanges: readonly string[]; readonly recoveryEvidence: number } | undefined {
    const state = this.#services.get(requireText(serviceName, 'service'));
    if (!state) return undefined;
    return {
      dependencies: [...state.dependencies].sort(),
      activeChanges: [...state.activeChanges].sort(),
      recoveryEvidence: state.recoveryEvidence,
    };
  }

  history(): readonly DependencyChangeGuardEvent[] {
    return this.#history.map((event) => ({ ...event }));
  }

  #riskFor(units: number): DependencyChangeRisk {
    if (units >= this.#policy.criticalRiskUnits) return 'critical';
    if (units >= this.#policy.highRiskUnits) return 'high';
    if (units >= this.#policy.elevatedRiskUnits) return 'elevated';
    return 'low';
  }

  #record(result: DependencyChangeGuardResult): void {
    this.#history.push({
      sequence: ++this.#sequence,
      service: result.service,
      dependency: result.dependency,
      changeId: result.changeId,
      decision: result.decision,
      risk: result.risk,
      evaluatedAt: result.evaluatedAt,
    });
    while (this.#history.length > this.#policy.maxHistoryEntries) this.#history.shift();
  }
}
