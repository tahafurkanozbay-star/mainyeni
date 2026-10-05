import {
  RuntimeAdmissionGovernor,
  type RuntimeAdmissionPolicy,
  type RuntimeAdmissionResource,
  type RuntimeAdmissionTicket,
} from './runtimeAdmissionGovernor';
import {
  RuntimeBackpressureGovernor,
  type RuntimeBackpressureLease,
  type RuntimeBackpressurePolicy,
} from './runtimeBackpressureGovernor';
import {
  RuntimeDeadlineGovernor,
  type RuntimeDeadlineLease,
  type RuntimeDeadlinePolicy,
} from './runtimeDeadlineGovernor';
import {
  RuntimeLoadShedGovernor,
  type RuntimeLoadSample,
  type RuntimeLoadShedPolicy,
  type RuntimePressureBand,
} from './runtimeLoadShedGovernor';

export type RuntimeWorkPriority = 'critical' | 'interactive' | 'background';
export type RuntimeWorkStatus = 'admitted' | 'deferred' | 'shed' | 'rejected';
export type RuntimeWorkOutcome = 'completed' | 'cancelled' | 'expired';
export type RuntimeWorkRejectReason =
  | 'capacity'
  | 'load-shed'
  | 'backpressure-defer'
  | 'backpressure-shed'
  | 'admission'
  | 'deadline';

export interface RuntimeWorkCoordinatorPolicy {
  readonly maxActiveGlobal: number;
  readonly maxActivePerScope: number;
  readonly maxUnitsGlobal: number;
  readonly maxUnitsPerScope: number;
  readonly maxUnitsPerWork: number;
  readonly criticalReserveUnits: number;
  readonly criticalReserveSlots: number;
  readonly maxWorkMs: number;
  readonly minWorkMs: number;
  readonly maxScopes: number;
  readonly idleScopeTtlMs: number;
  readonly maxClockSkewMs: number;
  readonly loadShed: Partial<RuntimeLoadShedPolicy>;
}

export interface RuntimeWorkRequest {
  readonly scope: string;
  readonly priority: RuntimeWorkPriority;
  readonly resource: RuntimeAdmissionResource;
  readonly units: number;
  readonly deadlineMs: number;
}

export interface RuntimeWorkPermit {
  readonly id: string;
  readonly scope: string;
  readonly priority: RuntimeWorkPriority;
  readonly resource: RuntimeAdmissionResource;
  readonly units: number;
  readonly generation: number;
  readonly startedAt: number;
  readonly expiresAt: number;
}

export interface RuntimeWorkDecision {
  readonly status: RuntimeWorkStatus;
  readonly reason: RuntimeWorkRejectReason | null;
  readonly pressureBand: RuntimePressureBand;
  readonly evaluatedAt: number;
  readonly permit: RuntimeWorkPermit | null;
}

export interface RuntimeWorkCoordinatorSnapshot {
  readonly active: number;
  readonly scopes: number;
  readonly units: number;
  readonly critical: number;
  readonly interactive: number;
  readonly background: number;
  readonly admitted: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly expired: number;
  readonly deferred: number;
  readonly shed: number;
  readonly rejected: number;
  readonly generation: number;
  readonly disposed: boolean;
  readonly admission: ReturnType<RuntimeAdmissionGovernor['snapshot']>;
  readonly deadline: ReturnType<RuntimeDeadlineGovernor['snapshot']>;
  readonly backpressure: ReturnType<RuntimeBackpressureGovernor['snapshot']>;
  readonly loadShed: ReturnType<RuntimeLoadShedGovernor['snapshot']>;
}

interface PermitState {
  readonly permit: RuntimeWorkPermit;
  readonly admission: RuntimeAdmissionTicket;
  readonly deadline: RuntimeDeadlineLease;
  readonly backpressure: RuntimeBackpressureLease;
}

const DEFAULT_POLICY: RuntimeWorkCoordinatorPolicy = Object.freeze({
  maxActiveGlobal: 32,
  maxActivePerScope: 8,
  maxUnitsGlobal: 1024,
  maxUnitsPerScope: 256,
  maxUnitsPerWork: 128,
  criticalReserveUnits: 128,
  criticalReserveSlots: 2,
  maxWorkMs: 30_000,
  minWorkMs: 25,
  maxScopes: 128,
  idleScopeTtlMs: 300_000,
  maxClockSkewMs: 1_000,
  loadShed: Object.freeze({}),
});

const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER - 1;

function safeInteger(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function validatePriority(value: RuntimeWorkPriority): RuntimeWorkPriority {
  if (value !== 'critical' && value !== 'interactive' && value !== 'background') {
    throw new TypeError('unsupported runtime work priority');
  }
  return value;
}

function validateResource(value: RuntimeAdmissionResource): RuntimeAdmissionResource {
  if (value !== 'cpu' && value !== 'memory' && value !== 'network' && value !== 'gpu') {
    throw new TypeError('unsupported runtime work resource');
  }
  return value;
}

function validateScope(value: string): string {
  if (!SAFE_SCOPE.test(value)) {
    throw new TypeError('scope must be a bounded platform identifier');
  }
  return value;
}

function resolvePolicy(input: Partial<RuntimeWorkCoordinatorPolicy>): RuntimeWorkCoordinatorPolicy {
  const policy: RuntimeWorkCoordinatorPolicy = {
    ...DEFAULT_POLICY,
    ...input,
    loadShed: Object.freeze({ ...(input.loadShed ?? DEFAULT_POLICY.loadShed) }),
  };
  safeInteger(policy.maxActiveGlobal, 'maxActiveGlobal', 1);
  safeInteger(policy.maxActivePerScope, 'maxActivePerScope', 1);
  safeInteger(policy.maxUnitsGlobal, 'maxUnitsGlobal', 1);
  safeInteger(policy.maxUnitsPerScope, 'maxUnitsPerScope', 1);
  safeInteger(policy.maxUnitsPerWork, 'maxUnitsPerWork', 1);
  safeInteger(policy.criticalReserveUnits, 'criticalReserveUnits', 0);
  safeInteger(policy.criticalReserveSlots, 'criticalReserveSlots', 0);
  safeInteger(policy.maxWorkMs, 'maxWorkMs', 1);
  safeInteger(policy.minWorkMs, 'minWorkMs', 1);
  safeInteger(policy.maxScopes, 'maxScopes', 1);
  safeInteger(policy.idleScopeTtlMs, 'idleScopeTtlMs', 1);
  safeInteger(policy.maxClockSkewMs, 'maxClockSkewMs', 0);
  if (policy.maxActivePerScope > policy.maxActiveGlobal) throw new RangeError('maxActivePerScope must not exceed maxActiveGlobal');
  if (policy.maxUnitsPerScope > policy.maxUnitsGlobal) throw new RangeError('maxUnitsPerScope must not exceed maxUnitsGlobal');
  if (policy.maxUnitsPerWork > policy.maxUnitsPerScope) throw new RangeError('maxUnitsPerWork must not exceed maxUnitsPerScope');
  if (policy.criticalReserveUnits >= policy.maxUnitsGlobal) throw new RangeError('criticalReserveUnits must be smaller than maxUnitsGlobal');
  if (policy.criticalReserveSlots >= policy.maxActiveGlobal) throw new RangeError('criticalReserveSlots must be smaller than maxActiveGlobal');
  if (policy.minWorkMs > policy.maxWorkMs) throw new RangeError('minWorkMs must not exceed maxWorkMs');
  return Object.freeze(policy);
}

/**
 * Payload-free composite authority for expensive browser runtime work.
 *
 * It stores scalar permits only. Work payloads, ArcGIS SDK objects, DOM nodes, callbacks,
 * promises, AbortControllers, response bodies, credentials, and user identifiers stay owned
 * by the caller. Admission is transactional: if a later authority rejects, every earlier
 * lease is released before the decision is returned.
 */
export class RuntimeWorkCoordinator {
  private readonly policy: RuntimeWorkCoordinatorPolicy;
  private readonly now: () => number;
  private readonly admission: RuntimeAdmissionGovernor;
  private readonly deadline: RuntimeDeadlineGovernor;
  private readonly backpressure: RuntimeBackpressureGovernor;
  private readonly loadShed: RuntimeLoadShedGovernor;
  private readonly permits = new Map<string, PermitState>();
  private readonly scopeCounts = new Map<string, number>();
  private generation = 1;
  private sequence = 0;
  private lastNow = 0;
  private admitted = 0;
  private completed = 0;
  private cancelled = 0;
  private expired = 0;
  private deferred = 0;
  private shed = 0;
  private rejected = 0;
  private disposed = false;

  constructor(policy: Partial<RuntimeWorkCoordinatorPolicy> = {}, now: () => number = Date.now) {
    this.policy = resolvePolicy(policy);
    this.now = now;
    this.lastNow = this.readClock();

    const admissionPolicy: Partial<RuntimeAdmissionPolicy> = {
      maxScopes: this.policy.maxScopes,
      maxTicketsGlobal: this.policy.maxActiveGlobal,
      maxTicketsPerScope: this.policy.maxActivePerScope,
      maxUnitsGlobal: this.policy.maxUnitsGlobal,
      maxUnitsPerScope: this.policy.maxUnitsPerScope,
      maxUnitsPerTicket: this.policy.maxUnitsPerWork,
      criticalReserveUnits: this.policy.criticalReserveUnits,
      ticketTtlMs: this.policy.maxWorkMs,
      idleScopeTtlMs: this.policy.idleScopeTtlMs,
      maxClockSkewMs: this.policy.maxClockSkewMs,
    };
    const deadlinePolicy: Partial<RuntimeDeadlinePolicy> = {
      maxScopes: this.policy.maxScopes,
      maxActiveGlobal: this.policy.maxActiveGlobal,
      maxActivePerScope: this.policy.maxActivePerScope,
      maxDeadlineMs: this.policy.maxWorkMs,
      minDeadlineMs: this.policy.minWorkMs,
      maxClockSkewMs: this.policy.maxClockSkewMs,
      idleScopeTtlMs: this.policy.idleScopeTtlMs,
      criticalReserve: this.policy.criticalReserveSlots,
    };
    const backpressurePolicy: Partial<RuntimeBackpressurePolicy> = {
      maxScopes: this.policy.maxScopes,
      maxInflightGlobal: this.policy.maxActiveGlobal,
      maxInflightPerScope: this.policy.maxActivePerScope,
      criticalReserve: this.policy.criticalReserveSlots,
      leaseTtlMs: this.policy.maxWorkMs,
      idleScopeTtlMs: this.policy.idleScopeTtlMs,
      maxClockRollbackMs: this.policy.maxClockSkewMs,
    };
    const loadPolicy: Partial<RuntimeLoadShedPolicy> = {
      maxScopes: this.policy.maxScopes,
      idleScopeTtlMs: this.policy.idleScopeTtlMs,
      maxClockSkewMs: this.policy.maxClockSkewMs,
      ...this.policy.loadShed,
    };

    this.admission = new RuntimeAdmissionGovernor(admissionPolicy, now);
    this.deadline = new RuntimeDeadlineGovernor(deadlinePolicy, now);
    this.backpressure = new RuntimeBackpressureGovernor(backpressurePolicy);
    this.loadShed = new RuntimeLoadShedGovernor(loadPolicy, now);
  }

  recordLoad(scopeInput: string, sample: RuntimeLoadSample): RuntimePressureBand {
    this.assertUsable();
    const scope = validateScope(scopeInput);
    this.tick();
    return this.loadShed.record(scope, sample);
  }

  admit(request: RuntimeWorkRequest): RuntimeWorkDecision {
    this.assertUsable();
    const scope = validateScope(request.scope);
    const priority = validatePriority(request.priority);
    const resource = validateResource(request.resource);
    safeInteger(request.units, 'units', 1);
    safeInteger(request.deadlineMs, 'deadlineMs', this.policy.minWorkMs);
    if (request.units > this.policy.maxUnitsPerWork) throw new RangeError('units exceeds coordinator per-work maximum');
    if (request.deadlineMs > this.policy.maxWorkMs) throw new RangeError('deadlineMs exceeds coordinator maximum');

    const now = this.tick();
    this.sweepAt(now);
    if (this.permits.size >= this.policy.maxActiveGlobal) return this.reject('capacity', 'rejected', 'normal', now);
    const activeInScope = this.scopeCounts.get(scope) ?? 0;
    if (activeInScope >= this.policy.maxActivePerScope) return this.reject('capacity', 'rejected', 'normal', now);

    const loadDecision = this.loadShed.decide(scope, priority);
    if (!loadDecision.admitted) return this.reject('load-shed', 'shed', loadDecision.band, now);

    let pressureDecision: 'admit' | 'defer' | 'shed';
    try {
      pressureDecision = this.backpressure.decide({ scope, lane: priority, now });
    } catch (error) {
      if (error instanceof Error && error.message === 'runtime backpressure scope capacity exhausted') {
        return this.reject('capacity', 'rejected', loadDecision.band, now);
      }
      throw error;
    }
    if (pressureDecision === 'defer') return this.reject('backpressure-defer', 'deferred', loadDecision.band, now);
    if (pressureDecision === 'shed') return this.reject('backpressure-shed', 'shed', loadDecision.band, now);

    let backpressure: RuntimeBackpressureLease | null = null;
    let admission: RuntimeAdmissionTicket | null = null;
    try {
      backpressure = this.backpressure.acquire({ scope, lane: priority, now });
      if (!backpressure) return this.reject('backpressure-defer', 'deferred', loadDecision.band, now);

      admission = this.admission.admit({ scope, priority, resource, units: request.units });
      if (!admission) {
        this.backpressure.release(backpressure, now);
        return this.reject('admission', 'rejected', loadDecision.band, now);
      }

      const deadline = this.deadline.acquire({ scope, priority, deadlineMs: request.deadlineMs });
      if (!deadline) {
        this.admission.release(admission);
        this.backpressure.release(backpressure, now);
        return this.reject('deadline', 'rejected', loadDecision.band, now);
      }

      const permit: RuntimeWorkPermit = Object.freeze({
        id: this.nextId(scope),
        scope,
        priority,
        resource,
        units: request.units,
        generation: this.generation,
        startedAt: now,
        expiresAt: deadline.expiresAt,
      });
      this.permits.set(permit.id, { permit, admission, deadline, backpressure });
      this.scopeCounts.set(scope, activeInScope + 1);
      this.admitted = this.bump(this.admitted);
      return Object.freeze({ status: 'admitted', reason: null, pressureBand: loadDecision.band, evaluatedAt: now, permit });
    } catch (error) {
      if (admission) this.admission.release(admission);
      if (backpressure) this.backpressure.release(backpressure, now);
      throw error;
    }
  }

  complete(permit: RuntimeWorkPermit): boolean { return this.finish(permit, 'completed'); }
  cancel(permit: RuntimeWorkPermit): boolean { return this.finish(permit, 'cancelled'); }

  isActive(permit: RuntimeWorkPermit): boolean {
    if (this.disposed) return false;
    const now = this.tick();
    this.sweepAt(now);
    return this.resolve(permit) !== null;
  }

  remainingMs(permit: RuntimeWorkPermit): number | null {
    if (this.disposed) return null;
    const now = this.tick();
    this.sweepAt(now);
    const state = this.resolve(permit);
    return state ? Math.max(0, state.permit.expiresAt - now) : null;
  }

  resetScope(scopeInput: string): number {
    this.assertUsable();
    const scope = validateScope(scopeInput);
    const now = this.tick();
    this.sweepAt(now);
    let removed = 0;
    for (const state of Array.from(this.permits.values())) {
      if (state.permit.scope !== scope) continue;
      this.settleState(state, 'cancelled', now);
      removed += 1;
    }
    this.loadShed.resetScope(scope);
    this.backpressure.resetScope(scope, now);
    return removed;
  }

  sweep(): number { this.assertUsable(); return this.sweepAt(this.tick()); }

  snapshot(): RuntimeWorkCoordinatorSnapshot {
    let units = 0;
    let critical = 0;
    let interactive = 0;
    let background = 0;
    for (const state of this.permits.values()) {
      units += state.permit.units;
      if (state.permit.priority === 'critical') critical += 1;
      else if (state.permit.priority === 'interactive') interactive += 1;
      else background += 1;
    }
    return Object.freeze({
      active: this.permits.size,
      scopes: this.scopeCounts.size,
      units,
      critical,
      interactive,
      background,
      admitted: this.admitted,
      completed: this.completed,
      cancelled: this.cancelled,
      expired: this.expired,
      deferred: this.deferred,
      shed: this.shed,
      rejected: this.rejected,
      generation: this.generation,
      disposed: this.disposed,
      admission: this.admission.snapshot(),
      deadline: this.deadline.snapshot(),
      backpressure: this.backpressure.snapshot(),
      loadShed: this.loadShed.snapshot(),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    const now = this.tick();
    for (const state of Array.from(this.permits.values())) this.settleState(state, 'cancelled', now);
    this.permits.clear();
    this.scopeCounts.clear();
    this.admission.dispose();
    this.deadline.dispose();
    this.backpressure.dispose();
    this.loadShed.dispose();
    this.advanceGeneration();
    this.disposed = true;
  }

  private finish(permit: RuntimeWorkPermit, outcome: Exclude<RuntimeWorkOutcome, 'expired'>): boolean {
    if (this.disposed) return false;
    const now = this.tick();
    this.sweepAt(now);
    const state = this.resolve(permit);
    if (!state) return false;
    this.settleState(state, outcome, now);
    return true;
  }

  private sweepAt(now: number): number {
    this.loadShed.sweep();
    this.admission.sweep();
    this.deadline.sweep();
    this.backpressure.sweep(now);
    let removed = 0;
    for (const state of Array.from(this.permits.values())) {
      const deadlineActive = this.deadline.isActive(state.deadline);
      const admissionActive = this.admission.isActive(state.admission);
      if (deadlineActive && admissionActive && state.permit.expiresAt > now) continue;
      this.settleState(state, 'expired', now);
      removed += 1;
    }
    return removed;
  }

  private settleState(state: PermitState, outcome: RuntimeWorkOutcome, now: number): void {
    if (!this.permits.delete(state.permit.id)) return;
    if (outcome === 'completed') this.deadline.complete(state.deadline);
    else this.deadline.cancel(state.deadline);
    this.admission.release(state.admission);
    this.backpressure.release(state.backpressure, now);
    this.decrementScope(state.permit.scope);
    if (outcome === 'completed') this.completed = this.bump(this.completed);
    else if (outcome === 'cancelled') this.cancelled = this.bump(this.cancelled);
    else this.expired = this.bump(this.expired);
  }

  private decrementScope(scope: string): void {
    const count = this.scopeCounts.get(scope);
    if (!count || count <= 1) this.scopeCounts.delete(scope);
    else this.scopeCounts.set(scope, count - 1);
  }

  private resolve(candidate: RuntimeWorkPermit): PermitState | null {
    if (!candidate || candidate.generation !== this.generation) return null;
    const state = this.permits.get(candidate.id);
    if (!state) return null;
    const permit = state.permit;
    if (permit.scope !== candidate.scope || permit.priority !== candidate.priority || permit.resource !== candidate.resource ||
        permit.units !== candidate.units || permit.startedAt !== candidate.startedAt || permit.expiresAt !== candidate.expiresAt) return null;
    return state;
  }

  private reject(reason: RuntimeWorkRejectReason, status: Exclude<RuntimeWorkStatus, 'admitted'>,
    band: RuntimePressureBand, now: number): RuntimeWorkDecision {
    if (status === 'deferred') this.deferred = this.bump(this.deferred);
    else if (status === 'shed') this.shed = this.bump(this.shed);
    else this.rejected = this.bump(this.rejected);
    return Object.freeze({ status, reason, pressureBand: band, evaluatedAt: now, permit: null });
  }

  private nextId(scope: string): string {
    this.sequence = this.sequence >= MAX_COUNTER ? 1 : this.sequence + 1;
    return `rwc-${this.generation}-${this.sequence}-${scope}`;
  }

  private tick(): number {
    const current = this.readClock();
    if (current + this.policy.maxClockSkewMs < this.lastNow) throw new Error('runtime work coordinator clock moved backwards beyond policy');
    this.lastNow = Math.max(this.lastNow, current);
    return this.lastNow;
  }

  private readClock(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new Error('runtime work coordinator clock must return a finite non-negative value');
    return value;
  }

  private bump(value: number): number { return value >= MAX_COUNTER ? MAX_COUNTER : value + 1; }
  private advanceGeneration(): void { this.generation = this.generation >= MAX_COUNTER ? 1 : this.generation + 1; }
  private assertUsable(): void { if (this.disposed) throw new Error('RuntimeWorkCoordinator is disposed'); }
}

export function createRuntimeWorkCoordinator(
  policy: Partial<RuntimeWorkCoordinatorPolicy> = {},
  now: () => number = Date.now,
): RuntimeWorkCoordinator {
  return new RuntimeWorkCoordinator(policy, now);
}
