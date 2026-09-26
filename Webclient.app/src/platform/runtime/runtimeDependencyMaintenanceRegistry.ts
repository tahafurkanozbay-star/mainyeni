export type DependencyMaintenanceMode = 'observe' | 'degraded' | 'blocked';

export interface DependencyMaintenancePolicy {
  readonly maxServices: number;
  readonly maxWindowsPerService: number;
  readonly maxHistoryEntries: number;
  readonly maxWindowDurationMs: number;
}

export interface DependencyMaintenanceWindow {
  readonly id: string;
  readonly service: string;
  readonly dependency: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly mode: DependencyMaintenanceMode;
  readonly reason: string;
}

export interface DependencyMaintenanceDecision {
  readonly service: string;
  readonly dependency: string;
  readonly evaluatedAt: number;
  readonly mode: DependencyMaintenanceMode | undefined;
  readonly activeWindowIds: readonly string[];
  readonly reasons: readonly string[];
}

const DEFAULT_POLICY: DependencyMaintenancePolicy = {
  maxServices: 128,
  maxWindowsPerService: 32,
  maxHistoryEntries: 512,
  maxWindowDurationMs: 86_400_000,
};

const positiveInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
};

const nonBlank = (value: string, name: string): void => {
  if (value.trim().length === 0) throw new Error(`${name} must not be blank`);
};

const modeRank: Record<DependencyMaintenanceMode, number> = { observe: 0, degraded: 1, blocked: 2 };

export class RuntimeDependencyMaintenanceRegistry {
  readonly #policy: DependencyMaintenancePolicy;
  readonly #windows = new Map<string, Map<string, DependencyMaintenanceWindow>>();
  readonly #lastEvaluatedAt = new Map<string, number>();
  readonly #history: DependencyMaintenanceDecision[] = [];

  constructor(policy: Partial<DependencyMaintenancePolicy> = {}) {
    this.#policy = { ...DEFAULT_POLICY, ...policy };
    positiveInteger(this.#policy.maxServices, 'maxServices');
    positiveInteger(this.#policy.maxWindowsPerService, 'maxWindowsPerService');
    positiveInteger(this.#policy.maxHistoryEntries, 'maxHistoryEntries');
    positiveInteger(this.#policy.maxWindowDurationMs, 'maxWindowDurationMs');
  }

  register(window: DependencyMaintenanceWindow): void {
    this.#validateWindow(window);
    let service = this.#windows.get(window.service);
    if (!service) {
      if (this.#windows.size >= this.#policy.maxServices) throw new Error('maintenance service capacity exceeded');
      service = new Map();
      this.#windows.set(window.service, service);
    }
    if (!service.has(window.id) && service.size >= this.#policy.maxWindowsPerService) {
      throw new Error('maintenance window capacity exceeded');
    }
    const existing = service.get(window.id);
    if (existing && (existing.dependency !== window.dependency || existing.startsAt !== window.startsAt)) {
      throw new Error('maintenance window id cannot be rebound');
    }
    service.set(window.id, { ...window });
  }

  evaluate(serviceName: string, dependency: string, evaluatedAt: number): DependencyMaintenanceDecision {
    nonBlank(serviceName, 'service');
    nonBlank(dependency, 'dependency');
    if (!Number.isFinite(evaluatedAt)) throw new Error('evaluatedAt must be finite');
    const previous = this.#lastEvaluatedAt.get(serviceName);
    if (previous !== undefined && evaluatedAt < previous) throw new Error('maintenance evaluation must be monotonic per service');
    this.#lastEvaluatedAt.set(serviceName, evaluatedAt);

    const service = this.#windows.get(serviceName);
    const active = service ? [...service.values()].filter((window) => window.dependency === dependency && window.startsAt <= evaluatedAt && evaluatedAt < window.endsAt) : [];
    active.sort((left, right) => left.id.localeCompare(right.id));
    let mode: DependencyMaintenanceMode | undefined;
    for (const window of active) {
      if (mode === undefined || modeRank[window.mode] > modeRank[mode]) mode = window.mode;
    }
    const decision: DependencyMaintenanceDecision = {
      service: serviceName,
      dependency,
      evaluatedAt,
      mode,
      activeWindowIds: active.map((window) => window.id),
      reasons: active.map((window) => window.reason),
    };
    this.#history.push(decision);
    if (this.#history.length > this.#policy.maxHistoryEntries) this.#history.splice(0, this.#history.length - this.#policy.maxHistoryEntries);
    return this.#copy(decision);
  }

  remove(service: string, windowId: string): boolean {
    nonBlank(service, 'service');
    nonBlank(windowId, 'windowId');
    const windows = this.#windows.get(service);
    if (!windows) return false;
    const removed = windows.delete(windowId);
    if (windows.size === 0) this.#windows.delete(service);
    return removed;
  }

  windows(service: string): readonly DependencyMaintenanceWindow[] {
    const windows = this.#windows.get(service);
    if (!windows) return [];
    return [...windows.values()].sort((left, right) => left.id.localeCompare(right.id)).map((window) => ({ ...window }));
  }

  history(): readonly DependencyMaintenanceDecision[] {
    return this.#history.map((decision) => this.#copy(decision));
  }

  #copy(decision: DependencyMaintenanceDecision): DependencyMaintenanceDecision {
    return { ...decision, activeWindowIds: [...decision.activeWindowIds], reasons: [...decision.reasons] };
  }

  #validateWindow(window: DependencyMaintenanceWindow): void {
    nonBlank(window.id, 'id');
    nonBlank(window.service, 'service');
    nonBlank(window.dependency, 'dependency');
    nonBlank(window.reason, 'reason');
    if (!Number.isFinite(window.startsAt) || !Number.isFinite(window.endsAt)) throw new Error('maintenance timestamps must be finite');
    if (window.endsAt <= window.startsAt) throw new Error('maintenance window must have positive duration');
    if (window.endsAt - window.startsAt > this.#policy.maxWindowDurationMs) throw new Error('maintenance window duration exceeded');
  }
}
