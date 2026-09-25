export type DependencyIncidentSeverity = 'info' | 'warning' | 'critical';
export type DependencyIncidentState = 'observing' | 'open' | 'mitigating' | 'recovering' | 'resolved';

export interface DependencyIncidentPolicy {
  readonly maxServices: number;
  readonly maxDependenciesPerService: number;
  readonly maxOpenIncidents: number;
  readonly maxHistoryEntries: number;
  readonly maxEvidenceAgeMs: number;
  readonly warningFailureCount: number;
  readonly criticalFailureCount: number;
  readonly recoveryConfirmations: number;
  readonly escalationAfterMs: number;
}

export interface DependencyIncidentEvidence {
  readonly service: string;
  readonly dependency: string;
  readonly incidentId: string;
  readonly dependencyReady: boolean;
  readonly dependencyDegraded: boolean;
  readonly required: boolean;
  readonly observedAt: number;
  readonly evaluatedAt: number;
}

export interface DependencyIncidentDecision {
  readonly service: string;
  readonly dependency: string;
  readonly incidentId: string;
  readonly state: DependencyIncidentState;
  readonly severity: DependencyIncidentSeverity;
  readonly reasons: readonly string[];
  readonly consecutiveFailures: number;
  readonly recoveryEvidence: number;
  readonly openedAt: number | undefined;
  readonly evaluatedAt: number;
}

export interface DependencyIncidentSnapshot {
  readonly service: string;
  readonly dependencies: readonly string[];
  readonly openIncidentIds: readonly string[];
  readonly lastEvaluatedAt: number | undefined;
}

interface IncidentState {
  readonly id: string;
  readonly dependency: string;
  state: DependencyIncidentState;
  severity: DependencyIncidentSeverity;
  consecutiveFailures: number;
  recoveryEvidence: number;
  openedAt?: number;
}

interface ServiceState {
  readonly dependencies: Set<string>;
  readonly incidents: Map<string, IncidentState>;
  lastEvaluatedAt?: number;
}

const DEFAULT_POLICY: DependencyIncidentPolicy = {
  maxServices: 128,
  maxDependenciesPerService: 64,
  maxOpenIncidents: 32,
  maxHistoryEntries: 512,
  maxEvidenceAgeMs: 60_000,
  warningFailureCount: 2,
  criticalFailureCount: 4,
  recoveryConfirmations: 2,
  escalationAfterMs: 120_000,
};

const positiveInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
};

const nonBlank = (value: string, name: string): void => {
  if (value.trim().length === 0) throw new Error(`${name} must not be blank`);
};

export class RuntimeDependencyIncidentCoordinator {
  readonly #policy: DependencyIncidentPolicy;
  readonly #services = new Map<string, ServiceState>();
  readonly #history: DependencyIncidentDecision[] = [];

  constructor(policy: Partial<DependencyIncidentPolicy> = {}) {
    this.#policy = { ...DEFAULT_POLICY, ...policy };
    positiveInteger(this.#policy.maxServices, 'maxServices');
    positiveInteger(this.#policy.maxDependenciesPerService, 'maxDependenciesPerService');
    positiveInteger(this.#policy.maxOpenIncidents, 'maxOpenIncidents');
    positiveInteger(this.#policy.maxHistoryEntries, 'maxHistoryEntries');
    positiveInteger(this.#policy.maxEvidenceAgeMs, 'maxEvidenceAgeMs');
    positiveInteger(this.#policy.warningFailureCount, 'warningFailureCount');
    positiveInteger(this.#policy.criticalFailureCount, 'criticalFailureCount');
    positiveInteger(this.#policy.recoveryConfirmations, 'recoveryConfirmations');
    positiveInteger(this.#policy.escalationAfterMs, 'escalationAfterMs');
    if (this.#policy.warningFailureCount >= this.#policy.criticalFailureCount) {
      throw new Error('warningFailureCount must be lower than criticalFailureCount');
    }
  }

  evaluate(evidence: DependencyIncidentEvidence): DependencyIncidentDecision {
    this.#validateEvidence(evidence);
    const service = this.#requireService(evidence.service);
    if (service.lastEvaluatedAt !== undefined && evidence.evaluatedAt < service.lastEvaluatedAt) {
      throw new Error('incident evidence must be monotonic per service');
    }
    service.lastEvaluatedAt = evidence.evaluatedAt;
    this.#registerDependency(service, evidence.dependency);

    const age = evidence.evaluatedAt - evidence.observedAt;
    const stale = age < 0 || age > this.#policy.maxEvidenceAgeMs;
    const unhealthy = stale || !evidence.dependencyReady || evidence.dependencyDegraded;
    let incident = service.incidents.get(evidence.incidentId);

    if (!incident) {
      if (service.incidents.size >= this.#policy.maxOpenIncidents) throw new Error('incident capacity exceeded');
      incident = {
        id: evidence.incidentId,
        dependency: evidence.dependency,
        state: 'observing',
        severity: 'info',
        consecutiveFailures: 0,
        recoveryEvidence: 0,
      };
      service.incidents.set(evidence.incidentId, incident);
    } else if (incident.dependency !== evidence.dependency) {
      throw new Error('incidentId cannot be reused for another dependency');
    }

    const reasons: string[] = [];
    if (stale) reasons.push('dependency-evidence-stale');
    if (!evidence.dependencyReady) reasons.push('dependency-not-ready');
    if (evidence.dependencyDegraded) reasons.push('dependency-degraded');

    if (unhealthy) {
      incident.recoveryEvidence = 0;
      incident.consecutiveFailures += 1;
      if (incident.openedAt === undefined && incident.consecutiveFailures >= this.#policy.warningFailureCount) {
        incident.openedAt = evidence.evaluatedAt;
        incident.state = 'open';
      }
      if (incident.consecutiveFailures >= this.#policy.criticalFailureCount || (evidence.required && !evidence.dependencyReady)) {
        incident.severity = 'critical';
        incident.state = 'mitigating';
        reasons.push('critical-dependency-impact');
      } else if (incident.consecutiveFailures >= this.#policy.warningFailureCount) {
        incident.severity = 'warning';
      }
      if (incident.openedAt !== undefined && evidence.evaluatedAt - incident.openedAt >= this.#policy.escalationAfterMs) {
        incident.severity = 'critical';
        incident.state = 'mitigating';
        reasons.push('incident-escalation-deadline-exceeded');
      }
    } else if (incident.openedAt !== undefined) {
      incident.recoveryEvidence += 1;
      incident.state = 'recovering';
      incident.severity = 'warning';
      reasons.push('recovery-confirmation-pending');
      if (incident.recoveryEvidence >= this.#policy.recoveryConfirmations) {
        incident.state = 'resolved';
        incident.severity = 'info';
        reasons.splice(reasons.indexOf('recovery-confirmation-pending'), 1);
        reasons.push('recovery-confirmed');
      }
    } else {
      incident.consecutiveFailures = 0;
      incident.recoveryEvidence = 0;
      incident.state = 'observing';
      incident.severity = 'info';
    }

    const decision = this.#decision(evidence, incident, reasons);
    this.#history.push(decision);
    if (this.#history.length > this.#policy.maxHistoryEntries) {
      this.#history.splice(0, this.#history.length - this.#policy.maxHistoryEntries);
    }
    if (incident.state === 'resolved') service.incidents.delete(incident.id);
    return this.#copyDecision(decision);
  }

  snapshot(service: string): DependencyIncidentSnapshot | undefined {
    const state = this.#services.get(service);
    if (!state) return undefined;
    return {
      service,
      dependencies: [...state.dependencies].sort(),
      openIncidentIds: [...state.incidents.keys()].sort(),
      lastEvaluatedAt: state.lastEvaluatedAt,
    };
  }

  history(): readonly DependencyIncidentDecision[] {
    return this.#history.map((entry) => this.#copyDecision(entry));
  }

  removeService(service: string): boolean {
    return this.#services.delete(service);
  }

  #decision(evidence: DependencyIncidentEvidence, incident: IncidentState, reasons: string[]): DependencyIncidentDecision {
    return {
      service: evidence.service,
      dependency: evidence.dependency,
      incidentId: evidence.incidentId,
      state: incident.state,
      severity: incident.severity,
      reasons: [...reasons],
      consecutiveFailures: incident.consecutiveFailures,
      recoveryEvidence: incident.recoveryEvidence,
      openedAt: incident.openedAt,
      evaluatedAt: evidence.evaluatedAt,
    };
  }

  #copyDecision(decision: DependencyIncidentDecision): DependencyIncidentDecision {
    return { ...decision, reasons: [...decision.reasons] };
  }

  #requireService(name: string): ServiceState {
    const existing = this.#services.get(name);
    if (existing) return existing;
    if (this.#services.size >= this.#policy.maxServices) throw new Error('incident service capacity exceeded');
    const created: ServiceState = { dependencies: new Set(), incidents: new Map() };
    this.#services.set(name, created);
    return created;
  }

  #registerDependency(service: ServiceState, dependency: string): void {
    if (service.dependencies.has(dependency)) return;
    if (service.dependencies.size >= this.#policy.maxDependenciesPerService) throw new Error('incident dependency capacity exceeded');
    service.dependencies.add(dependency);
  }

  #validateEvidence(evidence: DependencyIncidentEvidence): void {
    nonBlank(evidence.service, 'service');
    nonBlank(evidence.dependency, 'dependency');
    nonBlank(evidence.incidentId, 'incidentId');
    if (!Number.isFinite(evidence.observedAt) || !Number.isFinite(evidence.evaluatedAt)) {
      throw new Error('incident timestamps must be finite');
    }
  }
}
