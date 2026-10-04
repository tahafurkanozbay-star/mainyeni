export type RuntimeAdmissionPriority = 'critical' | 'interactive' | 'background';
export type RuntimeAdmissionResource = 'cpu' | 'memory' | 'network' | 'gpu';

export interface RuntimeAdmissionPolicy {
  readonly maxScopes: number;
  readonly maxTicketsGlobal: number;
  readonly maxTicketsPerScope: number;
  readonly maxUnitsGlobal: number;
  readonly maxUnitsPerScope: number;
  readonly maxUnitsPerTicket: number;
  readonly criticalReserveUnits: number;
  readonly ticketTtlMs: number;
  readonly idleScopeTtlMs: number;
  readonly maxClockSkewMs: number;
}

export interface RuntimeAdmissionRequest {
  readonly scope: string;
  readonly priority: RuntimeAdmissionPriority;
  readonly resource: RuntimeAdmissionResource;
  readonly units: number;
}

export interface RuntimeAdmissionTicket {
  readonly id: string;
  readonly scope: string;
  readonly priority: RuntimeAdmissionPriority;
  readonly resource: RuntimeAdmissionResource;
  readonly units: number;
  readonly generation: number;
  readonly admittedAt: number;
  readonly expiresAt: number;
}

export interface RuntimeAdmissionSnapshot {
  readonly tickets: number;
  readonly scopes: number;
  readonly units: number;
  readonly criticalUnits: number;
  readonly interactiveUnits: number;
  readonly backgroundUnits: number;
  readonly cpuUnits: number;
  readonly memoryUnits: number;
  readonly networkUnits: number;
  readonly gpuUnits: number;
  readonly admitted: number;
  readonly released: number;
  readonly expired: number;
  readonly rejected: number;
  readonly generation: number;
  readonly disposed: boolean;
}

interface TicketState extends RuntimeAdmissionTicket { expiresAt: number }
interface ScopeState { readonly tickets: Map<string, TicketState>; units: number; touchedAt: number }

const DEFAULT_POLICY: RuntimeAdmissionPolicy = Object.freeze({
  maxScopes: 128,
  maxTicketsGlobal: 128,
  maxTicketsPerScope: 16,
  maxUnitsGlobal: 1024,
  maxUnitsPerScope: 256,
  maxUnitsPerTicket: 128,
  criticalReserveUnits: 128,
  ticketTtlMs: 30_000,
  idleScopeTtlMs: 300_000,
  maxClockSkewMs: 1_000,
});
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER - 1;

function integer(value: number, name: string, min: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) throw new TypeError(`${name} must be an integer >= ${min}`);
  return value;
}

function policyOf(input: Partial<RuntimeAdmissionPolicy>): RuntimeAdmissionPolicy {
  const policy = { ...DEFAULT_POLICY, ...input };
  integer(policy.maxScopes, 'maxScopes', 1);
  integer(policy.maxTicketsGlobal, 'maxTicketsGlobal', 1);
  integer(policy.maxTicketsPerScope, 'maxTicketsPerScope', 1);
  integer(policy.maxUnitsGlobal, 'maxUnitsGlobal', 1);
  integer(policy.maxUnitsPerScope, 'maxUnitsPerScope', 1);
  integer(policy.maxUnitsPerTicket, 'maxUnitsPerTicket', 1);
  integer(policy.criticalReserveUnits, 'criticalReserveUnits', 0);
  integer(policy.ticketTtlMs, 'ticketTtlMs', 1);
  integer(policy.idleScopeTtlMs, 'idleScopeTtlMs', 1);
  integer(policy.maxClockSkewMs, 'maxClockSkewMs', 0);
  if (policy.maxTicketsPerScope > policy.maxTicketsGlobal) throw new RangeError('maxTicketsPerScope must not exceed maxTicketsGlobal');
  if (policy.maxUnitsPerScope > policy.maxUnitsGlobal) throw new RangeError('maxUnitsPerScope must not exceed maxUnitsGlobal');
  if (policy.maxUnitsPerTicket > policy.maxUnitsPerScope) throw new RangeError('maxUnitsPerTicket must not exceed maxUnitsPerScope');
  if (policy.criticalReserveUnits >= policy.maxUnitsGlobal) throw new RangeError('criticalReserveUnits must be smaller than maxUnitsGlobal');
  return Object.freeze(policy);
}

function scopeOf(value: string): string {
  if (!SAFE_SCOPE.test(value)) throw new TypeError('scope must be a bounded platform identifier');
  return value;
}
function priorityOf(value: RuntimeAdmissionPriority): RuntimeAdmissionPriority {
  if (value !== 'critical' && value !== 'interactive' && value !== 'background') throw new TypeError('unsupported admission priority');
  return value;
}
function resourceOf(value: RuntimeAdmissionResource): RuntimeAdmissionResource {
  if (value !== 'cpu' && value !== 'memory' && value !== 'network' && value !== 'gpu') throw new TypeError('unsupported admission resource');
  return value;
}

/** Payload-free bounded authority for admitting expensive runtime work. */
export class RuntimeAdmissionGovernor {
  private readonly policy: RuntimeAdmissionPolicy;
  private readonly now: () => number;
  private readonly tickets = new Map<string, TicketState>();
  private readonly scopes = new Map<string, ScopeState>();
  private sequence = 0;
  private generation = 1;
  private lastNow = 0;
  private units = 0;
  private admitted = 0;
  private released = 0;
  private expired = 0;
  private rejected = 0;
  private disposed = false;

  constructor(policy: Partial<RuntimeAdmissionPolicy> = {}, now: () => number = Date.now) {
    this.policy = policyOf(policy);
    this.now = now;
    this.lastNow = this.readClock();
  }

  admit(request: RuntimeAdmissionRequest): RuntimeAdmissionTicket | null {
    this.assertUsable();
    const scope = scopeOf(request.scope);
    const priority = priorityOf(request.priority);
    const resource = resourceOf(request.resource);
    integer(request.units, 'units', 1);
    if (request.units > this.policy.maxUnitsPerTicket) throw new RangeError('units exceeds per-ticket maximum');
    const now = this.tick();
    this.sweepAt(now);
    const existing = this.scopes.get(scope);
    if (!existing && !this.ensureScopeCapacity(now)) return this.reject();
    const state = existing ?? this.createScope(scope, now);
    if (this.tickets.size >= this.policy.maxTicketsGlobal || state.tickets.size >= this.policy.maxTicketsPerScope) return this.reject();
    if (state.units + request.units > this.policy.maxUnitsPerScope) return this.reject();
    const globalLimit = priority === 'critical' ? this.policy.maxUnitsGlobal : this.policy.maxUnitsGlobal - this.policy.criticalReserveUnits;
    if (this.units + request.units > globalLimit) return this.reject();
    const ticket: TicketState = {
      id: this.nextId(scope), scope, priority, resource, units: request.units,
      generation: this.generation, admittedAt: now, expiresAt: now + this.policy.ticketTtlMs,
    };
    this.tickets.set(ticket.id, ticket);
    state.tickets.set(ticket.id, ticket);
    state.units += ticket.units;
    state.touchedAt = now;
    this.units += ticket.units;
    this.admitted = this.bump(this.admitted);
    return this.detach(ticket);
  }

  renew(ticket: RuntimeAdmissionTicket): RuntimeAdmissionTicket | null {
    this.assertUsable();
    const now = this.tick();
    this.sweepAt(now);
    const state = this.resolve(ticket);
    if (!state) return null;
    state.expiresAt = now + this.policy.ticketTtlMs;
    const scope = this.scopes.get(state.scope);
    if (scope) scope.touchedAt = now;
    return this.detach(state);
  }

  release(ticket: RuntimeAdmissionTicket): boolean {
    if (this.disposed) return false;
    const now = this.tick();
    this.sweepAt(now);
    const state = this.resolve(ticket);
    if (!state) return false;
    this.remove(state, now);
    this.released = this.bump(this.released);
    return true;
  }

  isActive(ticket: RuntimeAdmissionTicket): boolean {
    if (this.disposed) return false;
    const now = this.tick();
    this.sweepAt(now);
    return this.resolve(ticket) !== null;
  }

  resetScope(scopeInput: string): number {
    this.assertUsable();
    const scope = scopeOf(scopeInput);
    const now = this.tick();
    this.sweepAt(now);
    const state = this.scopes.get(scope);
    if (!state) return 0;
    const count = state.tickets.size;
    for (const ticket of state.tickets.values()) {
      this.tickets.delete(ticket.id);
      this.units -= ticket.units;
      this.released = this.bump(this.released);
    }
    this.scopes.delete(scope);
    this.advanceGeneration();
    return count;
  }

  sweep(): number { this.assertUsable(); return this.sweepAt(this.tick()); }

  snapshot(): RuntimeAdmissionSnapshot {
    let criticalUnits = 0, interactiveUnits = 0, backgroundUnits = 0;
    let cpuUnits = 0, memoryUnits = 0, networkUnits = 0, gpuUnits = 0;
    for (const ticket of this.tickets.values()) {
      if (ticket.priority === 'critical') criticalUnits += ticket.units;
      else if (ticket.priority === 'interactive') interactiveUnits += ticket.units;
      else backgroundUnits += ticket.units;
      if (ticket.resource === 'cpu') cpuUnits += ticket.units;
      else if (ticket.resource === 'memory') memoryUnits += ticket.units;
      else if (ticket.resource === 'network') networkUnits += ticket.units;
      else gpuUnits += ticket.units;
    }
    return Object.freeze({ tickets: this.tickets.size, scopes: this.scopes.size, units: this.units,
      criticalUnits, interactiveUnits, backgroundUnits, cpuUnits, memoryUnits, networkUnits, gpuUnits,
      admitted: this.admitted, released: this.released, expired: this.expired, rejected: this.rejected,
      generation: this.generation, disposed: this.disposed });
  }

  dispose(): void {
    if (this.disposed) return;
    this.tickets.clear(); this.scopes.clear(); this.units = 0; this.advanceGeneration(); this.disposed = true;
  }

  private resolve(candidate: RuntimeAdmissionTicket): TicketState | null {
    if (!candidate || candidate.generation !== this.generation) return null;
    const state = this.tickets.get(candidate.id);
    if (!state) return null;
    if (state.scope !== candidate.scope || state.priority !== candidate.priority || state.resource !== candidate.resource ||
        state.units !== candidate.units || state.admittedAt !== candidate.admittedAt || state.expiresAt !== candidate.expiresAt) return null;
    return state;
  }

  private remove(ticket: TicketState, now: number): void {
    this.tickets.delete(ticket.id); this.units -= ticket.units;
    const scope = this.scopes.get(ticket.scope);
    if (!scope) return;
    scope.tickets.delete(ticket.id); scope.units -= ticket.units; scope.touchedAt = now;
  }

  private sweepAt(now: number): number {
    let removed = 0;
    for (const ticket of this.tickets.values()) if (ticket.expiresAt <= now) {
      this.remove(ticket, now); this.expired = this.bump(this.expired); removed += 1;
    }
    for (const [scope, state] of this.scopes) if (state.tickets.size === 0 && now - state.touchedAt >= this.policy.idleScopeTtlMs) this.scopes.delete(scope);
    return removed;
  }

  private ensureScopeCapacity(now: number): boolean {
    if (this.scopes.size < this.policy.maxScopes) return true;
    let candidate: string | null = null, touched = Number.POSITIVE_INFINITY;
    for (const [scope, state] of this.scopes) if (state.tickets.size === 0 && state.touchedAt < touched) { candidate = scope; touched = state.touchedAt; }
    if (candidate === null) return false;
    this.scopes.delete(candidate);
    return touched <= now && this.scopes.size < this.policy.maxScopes;
  }
  private createScope(scope: string, now: number): ScopeState {
    const state: ScopeState = { tickets: new Map(), units: 0, touchedAt: now }; this.scopes.set(scope, state); return state;
  }
  private reject(): null { this.rejected = this.bump(this.rejected); return null; }
  private nextId(scope: string): string { this.sequence = this.sequence >= MAX_COUNTER ? 1 : this.sequence + 1; return `${this.generation}:${this.sequence}:${scope}`; }
  private tick(): number {
    const current = this.readClock();
    if (current + this.policy.maxClockSkewMs < this.lastNow) throw new Error('runtime admission clock moved backwards beyond policy');
    this.lastNow = Math.max(this.lastNow, current); return this.lastNow;
  }
  private readClock(): number { const value = this.now(); if (!Number.isFinite(value) || value < 0) throw new Error('runtime admission clock must return a finite non-negative value'); return value; }
  private detach(ticket: TicketState): RuntimeAdmissionTicket { return Object.freeze({ ...ticket }); }
  private advanceGeneration(): void { this.generation = this.generation >= MAX_COUNTER ? 1 : this.generation + 1; }
  private bump(value: number): number { return value >= MAX_COUNTER ? MAX_COUNTER : value + 1; }
  private assertUsable(): void { if (this.disposed) throw new Error('RuntimeAdmissionGovernor is disposed'); }
}

export function createRuntimeAdmissionGovernor(policy: Partial<RuntimeAdmissionPolicy> = {}, now: () => number = Date.now): RuntimeAdmissionGovernor {
  return new RuntimeAdmissionGovernor(policy, now);
}
