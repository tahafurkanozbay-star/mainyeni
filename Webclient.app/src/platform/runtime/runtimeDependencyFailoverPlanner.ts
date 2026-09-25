import type { RuntimeDependencyReadinessDecision, RuntimeReadinessState } from './runtimeDependencyReadinessCoordinator';

export type RuntimeFailoverTargetState = 'available' | 'degraded' | 'unavailable';
export type RuntimeFailoverAction = 'primary' | 'fallback' | 'shed' | 'block';
export type RuntimeFailoverReason =
  | 'primary-ready'
  | 'primary-degraded'
  | 'fallback-selected'
  | 'fallback-degraded'
  | 'capacity-exhausted'
  | 'no-eligible-target'
  | 'readiness-blocked';

export interface RuntimeFailoverPolicy {
  readonly maximumServices: number;
  readonly maximumTargetsPerService: number;
  readonly maximumHistory: number;
  readonly recoveryConfirmations: number;
  readonly minimumHealthyCapacity: number;
}

export interface RuntimeFailoverTarget {
  readonly id: string;
  readonly priority: number;
  readonly state: RuntimeFailoverTargetState;
  readonly capacity: number;
  readonly load: number;
}

export interface RuntimeFailoverRequest {
  readonly service: string;
  readonly readiness: RuntimeDependencyReadinessDecision;
  readonly targets: readonly RuntimeFailoverTarget[];
  readonly requestedUnits: number;
  readonly evaluatedAt: number;
}

export interface RuntimeFailoverDecision {
  readonly service: string;
  readonly action: RuntimeFailoverAction;
  readonly reason: RuntimeFailoverReason;
  readonly targetId: string | null;
  readonly requestedUnits: number;
  readonly availableUnits: number;
  readonly readinessState: RuntimeReadinessState;
  readonly evaluatedAt: number;
  readonly revision: number;
}

export interface RuntimeFailoverTransition {
  readonly service: string;
  readonly fromTargetId: string | null;
  readonly toTargetId: string | null;
  readonly action: RuntimeFailoverAction;
  readonly reason: RuntimeFailoverReason;
  readonly occurredAt: number;
  readonly revision: number;
}

interface MutableServiceState {
  selectedTargetId: string | null;
  pendingPrimaryId: string | null;
  recoveryConfirmations: number;
  decision: RuntimeFailoverDecision;
}

const DEFAULT_POLICY: RuntimeFailoverPolicy = Object.freeze({
  maximumServices: 128,
  maximumTargetsPerService: 16,
  maximumHistory: 256,
  recoveryConfirmations: 2,
  minimumHealthyCapacity: 1,
});

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function normalizeId(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} must not be empty`);
  if (normalized.length > 160) throw new RangeError(`${name} must not exceed 160 characters`);
  return normalized;
}

function nonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a non-negative finite number`);
}

function copyDecision(value: RuntimeFailoverDecision): RuntimeFailoverDecision {
  return { ...value };
}

export class RuntimeDependencyFailoverPlanner {
  readonly #policy: RuntimeFailoverPolicy;
  readonly #services = new Map<string, MutableServiceState>();
  readonly #history: RuntimeFailoverTransition[] = [];
  #revision = 0;
  #lastEvaluatedAt = 0;

  public constructor(policy: Partial<RuntimeFailoverPolicy> = {}) {
    const merged = { ...DEFAULT_POLICY, ...policy };
    positiveInteger(merged.maximumServices, 'maximumServices');
    positiveInteger(merged.maximumTargetsPerService, 'maximumTargetsPerService');
    positiveInteger(merged.maximumHistory, 'maximumHistory');
    positiveInteger(merged.recoveryConfirmations, 'recoveryConfirmations');
    positiveInteger(merged.minimumHealthyCapacity, 'minimumHealthyCapacity');
    this.#policy = Object.freeze(merged);
  }

  public get policy(): RuntimeFailoverPolicy { return this.#policy; }

  public plan(request: RuntimeFailoverRequest): RuntimeFailoverDecision {
    const service = normalizeId(request.service, 'service');
    if (request.readiness.service !== service) throw new Error(`readiness service does not match request: ${service}`);
    nonNegativeFinite(request.evaluatedAt, 'evaluatedAt');
    positiveInteger(request.requestedUnits, 'requestedUnits');
    if (request.evaluatedAt < this.#lastEvaluatedAt) throw new RangeError('evaluatedAt must be monotonic');
    this.#lastEvaluatedAt = request.evaluatedAt;
    if (request.targets.length > this.#policy.maximumTargetsPerService) throw new RangeError('maximum failover targets exceeded');

    const targets = this.#normalizeTargets(request.targets);
    const previous = this.#services.get(service);
    if (previous === undefined && this.#services.size >= this.#policy.maximumServices) {
      throw new RangeError('maximum failover service capacity reached');
    }

    if (request.readiness.state === 'blocked') {
      return this.#commit(service, previous, null, 'block', 'readiness-blocked', 0, request);
    }

    const eligible = targets.filter((target) => target.state !== 'unavailable');
    const withCapacity = eligible.filter((target) => this.#availableUnits(target) >= request.requestedUnits);
    if (withCapacity.length === 0) {
      const availableUnits = eligible.reduce((maximum, target) => Math.max(maximum, this.#availableUnits(target)), 0);
      const reason: RuntimeFailoverReason = eligible.length === 0 ? 'no-eligible-target' : 'capacity-exhausted';
      return this.#commit(service, previous, null, 'shed', reason, availableUnits, request);
    }

    const primary = withCapacity[0];
    if (primary === undefined) throw new Error('failover invariant violated: selected target missing');
    let selected = primary;
    let action: RuntimeFailoverAction = primary.priority === 0 ? 'primary' : 'fallback';
    let reason: RuntimeFailoverReason = this.#reasonFor(primary, request.readiness.state);

    if (previous?.selectedTargetId !== null && previous?.selectedTargetId !== undefined) {
      const current = withCapacity.find((target) => target.id === previous.selectedTargetId);
      if (current !== undefined && primary.priority < current.priority) {
        if (previous.pendingPrimaryId === primary.id) previous.recoveryConfirmations += 1;
        else {
          previous.pendingPrimaryId = primary.id;
          previous.recoveryConfirmations = 1;
        }
        if (previous.recoveryConfirmations < this.#policy.recoveryConfirmations) {
          selected = current;
          action = current.priority === 0 ? 'primary' : 'fallback';
          reason = this.#reasonFor(current, request.readiness.state);
        }
      } else {
        previous.pendingPrimaryId = null;
        previous.recoveryConfirmations = 0;
      }
    }

    if (selected.state === 'degraded' && this.#availableUnits(selected) < this.#policy.minimumHealthyCapacity) {
      return this.#commit(service, previous, null, 'shed', 'capacity-exhausted', this.#availableUnits(selected), request);
    }
    return this.#commit(service, previous, selected.id, action, reason, this.#availableUnits(selected), request);
  }

  public get(service: string): RuntimeFailoverDecision | null {
    const state = this.#services.get(normalizeId(service, 'service'));
    return state === undefined ? null : copyDecision(state.decision);
  }

  public decisions(): readonly RuntimeFailoverDecision[] {
    return [...this.#services.values()].map((state) => copyDecision(state.decision)).sort((left, right) => left.service.localeCompare(right.service));
  }

  public transitions(): readonly RuntimeFailoverTransition[] {
    return this.#history.map((transition) => ({ ...transition }));
  }

  public remove(service: string): boolean { return this.#services.delete(normalizeId(service, 'service')); }

  public clear(): void {
    this.#services.clear();
    this.#history.splice(0, this.#history.length);
    this.#revision = 0;
    this.#lastEvaluatedAt = 0;
  }

  #normalizeTargets(input: readonly RuntimeFailoverTarget[]): RuntimeFailoverTarget[] {
    const seen = new Set<string>();
    const targets = input.map((target) => {
      const id = normalizeId(target.id, 'target id');
      if (seen.has(id)) throw new Error(`duplicate failover target: ${id}`);
      seen.add(id);
      if (!Number.isInteger(target.priority) || target.priority < 0) throw new RangeError('target priority must be a non-negative integer');
      positiveInteger(target.capacity, 'target capacity');
      nonNegativeFinite(target.load, 'target load');
      if (target.load > target.capacity) throw new RangeError(`target load exceeds capacity: ${id}`);
      return { ...target, id };
    });
    targets.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    return targets;
  }

  #availableUnits(target: RuntimeFailoverTarget): number {
    return Math.max(0, Math.floor(target.capacity - target.load));
  }

  #reasonFor(target: RuntimeFailoverTarget, readiness: RuntimeReadinessState): RuntimeFailoverReason {
    if (target.priority > 0) return target.state === 'degraded' ? 'fallback-degraded' : 'fallback-selected';
    return readiness === 'degraded' || target.state === 'degraded' ? 'primary-degraded' : 'primary-ready';
  }

  #commit(
    service: string,
    previous: MutableServiceState | undefined,
    targetId: string | null,
    action: RuntimeFailoverAction,
    reason: RuntimeFailoverReason,
    availableUnits: number,
    request: RuntimeFailoverRequest,
  ): RuntimeFailoverDecision {
    const revision = ++this.#revision;
    const decision: RuntimeFailoverDecision = Object.freeze({
      service,
      action,
      reason,
      targetId,
      requestedUnits: request.requestedUnits,
      availableUnits,
      readinessState: request.readiness.state,
      evaluatedAt: request.evaluatedAt,
      revision,
    });
    const fromTargetId = previous?.selectedTargetId ?? null;
    if (previous === undefined) {
      this.#services.set(service, { selectedTargetId: targetId, pendingPrimaryId: null, recoveryConfirmations: 0, decision });
    } else {
      previous.selectedTargetId = targetId;
      previous.decision = decision;
      if (fromTargetId !== targetId) {
        previous.pendingPrimaryId = null;
        previous.recoveryConfirmations = 0;
      }
    }
    if (fromTargetId !== targetId) {
      this.#history.push(Object.freeze({ service, fromTargetId, toTargetId: targetId, action, reason, occurredAt: request.evaluatedAt, revision }));
      if (this.#history.length > this.#policy.maximumHistory) this.#history.splice(0, this.#history.length - this.#policy.maximumHistory);
    }
    return copyDecision(decision);
  }
}
