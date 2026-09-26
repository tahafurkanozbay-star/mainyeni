export type DependencyDeploymentDecision = 'allow' | 'canary' | 'block';
export type DependencyDeploymentRisk = 'low' | 'elevated' | 'high' | 'critical';

export interface DependencyDeploymentGatePolicy {
  readonly maxServices: number;
  readonly maxDependenciesPerService: number;
  readonly maxConcurrentDeployments: number;
  readonly maxHistoryEntries: number;
  readonly maxEvidenceAgeMs: number;
  readonly elevatedChangeUnits: number;
  readonly highChangeUnits: number;
  readonly criticalChangeUnits: number;
  readonly recoveryConfirmations: number;
}

export interface DependencyDeploymentRequest {
  readonly service: string;
  readonly dependency: string;
  readonly deploymentId: string;
  readonly changeUnits: number;
  readonly required: boolean;
  readonly dependencyReady: boolean;
  readonly dependencyDegraded: boolean;
  readonly evidenceAt: number;
  readonly evaluatedAt: number;
}

export interface DependencyDeploymentResult {
  readonly service: string;
  readonly dependency: string;
  readonly deploymentId: string;
  readonly decision: DependencyDeploymentDecision;
  readonly risk: DependencyDeploymentRisk;
  readonly reasons: readonly string[];
  readonly activeDeployments: number;
  readonly recoveryEvidence: number;
  readonly evaluatedAt: number;
}

export interface DependencyDeploymentSnapshot {
  readonly service: string;
  readonly dependencies: readonly string[];
  readonly activeDeployments: readonly string[];
  readonly lastEvaluatedAt: number | undefined;
}

interface ServiceState {
  readonly dependencies: Set<string>;
  readonly activeDeployments: Set<string>;
  readonly recoveryEvidence: Map<string, number>;
  lastEvaluatedAt?: number;
}

const DEFAULT_POLICY: DependencyDeploymentGatePolicy = {
  maxServices: 128,
  maxDependenciesPerService: 64,
  maxConcurrentDeployments: 8,
  maxHistoryEntries: 512,
  maxEvidenceAgeMs: 60_000,
  elevatedChangeUnits: 25,
  highChangeUnits: 50,
  criticalChangeUnits: 80,
  recoveryConfirmations: 2,
};

const positiveInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
};

const boundedPercent = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${name} must be between 0 and 100`);
};

const nonBlank = (value: string, name: string): void => {
  if (value.trim().length === 0) throw new Error(`${name} must not be blank`);
};

export class RuntimeDependencyDeploymentGate {
  readonly #policy: DependencyDeploymentGatePolicy;
  readonly #services = new Map<string, ServiceState>();
  readonly #history: DependencyDeploymentResult[] = [];

  constructor(policy: Partial<DependencyDeploymentGatePolicy> = {}) {
    this.#policy = { ...DEFAULT_POLICY, ...policy };
    positiveInteger(this.#policy.maxServices, 'maxServices');
    positiveInteger(this.#policy.maxDependenciesPerService, 'maxDependenciesPerService');
    positiveInteger(this.#policy.maxConcurrentDeployments, 'maxConcurrentDeployments');
    positiveInteger(this.#policy.maxHistoryEntries, 'maxHistoryEntries');
    positiveInteger(this.#policy.maxEvidenceAgeMs, 'maxEvidenceAgeMs');
    positiveInteger(this.#policy.recoveryConfirmations, 'recoveryConfirmations');
    boundedPercent(this.#policy.elevatedChangeUnits, 'elevatedChangeUnits');
    boundedPercent(this.#policy.highChangeUnits, 'highChangeUnits');
    boundedPercent(this.#policy.criticalChangeUnits, 'criticalChangeUnits');
    if (!(this.#policy.elevatedChangeUnits < this.#policy.highChangeUnits && this.#policy.highChangeUnits < this.#policy.criticalChangeUnits)) {
      throw new Error('deployment risk thresholds must be strictly monotonic');
    }
  }

  evaluate(request: DependencyDeploymentRequest): DependencyDeploymentResult {
    this.#validateRequest(request);
    const state = this.#requireService(request.service);
    if (state.lastEvaluatedAt !== undefined && request.evaluatedAt < state.lastEvaluatedAt) {
      throw new Error('deployment evidence must be monotonic per service');
    }
    state.lastEvaluatedAt = request.evaluatedAt;
    this.#registerDependency(state, request.dependency);

    const risk = this.#risk(request.changeUnits);
    const reasons: string[] = [];
    let decision: DependencyDeploymentDecision = 'allow';
    const evidenceAge = request.evaluatedAt - request.evidenceAt;

    if (evidenceAge < 0 || evidenceAge > this.#policy.maxEvidenceAgeMs) {
      decision = 'block';
      reasons.push('dependency-evidence-stale');
    } else if (!request.dependencyReady && request.required) {
      decision = 'block';
      reasons.push('required-dependency-not-ready');
    } else if (!request.dependencyReady || request.dependencyDegraded) {
      decision = 'canary';
      reasons.push(request.dependencyDegraded ? 'dependency-degraded' : 'optional-dependency-not-ready');
    }

    const recoveryKey = `${request.dependency}:${risk}`;
    const needsRecovery = risk === 'high' || risk === 'critical';
    let recoveryEvidence = state.recoveryEvidence.get(recoveryKey) ?? 0;
    if (needsRecovery && decision !== 'block') {
      recoveryEvidence += 1;
      state.recoveryEvidence.set(recoveryKey, recoveryEvidence);
      if (recoveryEvidence < this.#policy.recoveryConfirmations) {
        decision = 'canary';
        reasons.push('recovery-confirmation-pending');
      }
    } else if (!needsRecovery) {
      state.recoveryEvidence.delete(recoveryKey);
    }

    if (risk === 'critical' && decision === 'allow') {
      decision = 'canary';
      reasons.push('critical-change-requires-canary');
    }

    const alreadyActive = state.activeDeployments.has(request.deploymentId);
    if (!alreadyActive && decision !== 'block' && state.activeDeployments.size >= this.#policy.maxConcurrentDeployments) {
      decision = 'block';
      reasons.push('deployment-capacity-exceeded');
    }
    if (decision !== 'block') state.activeDeployments.add(request.deploymentId);

    const result: DependencyDeploymentResult = {
      service: request.service,
      dependency: request.dependency,
      deploymentId: request.deploymentId,
      decision,
      risk,
      reasons: [...reasons],
      activeDeployments: state.activeDeployments.size,
      recoveryEvidence,
      evaluatedAt: request.evaluatedAt,
    };
    this.#history.push(result);
    if (this.#history.length > this.#policy.maxHistoryEntries) this.#history.splice(0, this.#history.length - this.#policy.maxHistoryEntries);
    return { ...result, reasons: [...result.reasons] };
  }

  complete(service: string, deploymentId: string): boolean {
    nonBlank(service, 'service');
    nonBlank(deploymentId, 'deploymentId');
    return this.#services.get(service)?.activeDeployments.delete(deploymentId) ?? false;
  }

  snapshot(service: string): DependencyDeploymentSnapshot | undefined {
    const state = this.#services.get(service);
    if (!state) return undefined;
    return {
      service,
      dependencies: [...state.dependencies].sort(),
      activeDeployments: [...state.activeDeployments].sort(),
      lastEvaluatedAt: state.lastEvaluatedAt,
    };
  }

  history(): readonly DependencyDeploymentResult[] {
    return this.#history.map((entry) => ({ ...entry, reasons: [...entry.reasons] }));
  }

  removeService(service: string): boolean {
    return this.#services.delete(service);
  }

  #requireService(service: string): ServiceState {
    const existing = this.#services.get(service);
    if (existing) return existing;
    if (this.#services.size >= this.#policy.maxServices) throw new Error('deployment service capacity exceeded');
    const created: ServiceState = { dependencies: new Set(), activeDeployments: new Set(), recoveryEvidence: new Map() };
    this.#services.set(service, created);
    return created;
  }

  #registerDependency(state: ServiceState, dependency: string): void {
    if (state.dependencies.has(dependency)) return;
    if (state.dependencies.size >= this.#policy.maxDependenciesPerService) throw new Error('deployment dependency capacity exceeded');
    state.dependencies.add(dependency);
  }

  #risk(changeUnits: number): DependencyDeploymentRisk {
    if (changeUnits >= this.#policy.criticalChangeUnits) return 'critical';
    if (changeUnits >= this.#policy.highChangeUnits) return 'high';
    if (changeUnits >= this.#policy.elevatedChangeUnits) return 'elevated';
    return 'low';
  }

  #validateRequest(request: DependencyDeploymentRequest): void {
    nonBlank(request.service, 'service');
    nonBlank(request.dependency, 'dependency');
    nonBlank(request.deploymentId, 'deploymentId');
    boundedPercent(request.changeUnits, 'changeUnits');
    if (!Number.isFinite(request.evidenceAt) || !Number.isFinite(request.evaluatedAt)) throw new Error('deployment timestamps must be finite');
  }
}
