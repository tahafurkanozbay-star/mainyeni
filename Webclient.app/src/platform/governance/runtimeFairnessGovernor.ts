export type RuntimeFairnessPriority = 'critical' | 'interactive' | 'background';

export interface RuntimeFairnessPolicy {
  readonly maxScopes: number;
  readonly maxQueuedGlobal: number;
  readonly maxQueuedPerScope: number;
  readonly maxCostPerRequest: number;
  readonly maxDeficitPerScope: number;
  readonly criticalQuantum: number;
  readonly interactiveQuantum: number;
  readonly backgroundQuantum: number;
  readonly requestTtlMs: number;
  readonly idleScopeTtlMs: number;
  readonly maxClockSkewMs: number;
}

export interface RuntimeFairnessRequest {
  readonly scope: string;
  readonly priority: RuntimeFairnessPriority;
  readonly cost: number;
}

export interface RuntimeFairnessTicket {
  readonly id: string;
  readonly scope: string;
  readonly priority: RuntimeFairnessPriority;
  readonly cost: number;
  readonly generation: number;
  readonly queuedAt: number;
  readonly expiresAt: number;
}

export interface RuntimeFairnessSnapshot {
  readonly queued: number;
  readonly scopes: number;
  readonly critical: number;
  readonly interactive: number;
  readonly background: number;
  readonly totalCost: number;
  readonly enqueued: number;
  readonly promoted: number;
  readonly cancelled: number;
  readonly expired: number;
  readonly rejected: number;
  readonly generation: number;
  readonly disposed: boolean;
}

interface TicketState extends RuntimeFairnessTicket { expiresAt: number }
interface ScopeState {
  readonly scope: string;
  readonly queue: TicketState[];
  deficit: number;
  touchedAt: number;
}

const DEFAULT_POLICY: RuntimeFairnessPolicy = Object.freeze({
  maxScopes: 128,
  maxQueuedGlobal: 256,
  maxQueuedPerScope: 32,
  maxCostPerRequest: 64,
  maxDeficitPerScope: 256,
  criticalQuantum: 16,
  interactiveQuantum: 8,
  backgroundQuantum: 4,
  requestTtlMs: 30_000,
  idleScopeTtlMs: 300_000,
  maxClockSkewMs: 1_000,
});
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER - 1;

function integer(value: number, name: string, min: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) throw new TypeError(`${name} must be an integer >= ${min}`);
  return value;
}
function scopeOf(value: string): string {
  if (!SAFE_SCOPE.test(value)) throw new TypeError('scope must be a bounded platform identifier');
  return value;
}
function priorityOf(value: RuntimeFairnessPriority): RuntimeFairnessPriority {
  if (value !== 'critical' && value !== 'interactive' && value !== 'background') throw new TypeError('unsupported fairness priority');
  return value;
}
function policyOf(input: Partial<RuntimeFairnessPolicy>): RuntimeFairnessPolicy {
  const policy = { ...DEFAULT_POLICY, ...input };
  integer(policy.maxScopes, 'maxScopes', 1);
  integer(policy.maxQueuedGlobal, 'maxQueuedGlobal', 1);
  integer(policy.maxQueuedPerScope, 'maxQueuedPerScope', 1);
  integer(policy.maxCostPerRequest, 'maxCostPerRequest', 1);
  integer(policy.maxDeficitPerScope, 'maxDeficitPerScope', 1);
  integer(policy.criticalQuantum, 'criticalQuantum', 1);
  integer(policy.interactiveQuantum, 'interactiveQuantum', 1);
  integer(policy.backgroundQuantum, 'backgroundQuantum', 1);
  integer(policy.requestTtlMs, 'requestTtlMs', 1);
  integer(policy.idleScopeTtlMs, 'idleScopeTtlMs', 1);
  integer(policy.maxClockSkewMs, 'maxClockSkewMs', 0);
  if (policy.maxQueuedPerScope > policy.maxQueuedGlobal) throw new RangeError('maxQueuedPerScope must not exceed maxQueuedGlobal');
  if (policy.maxCostPerRequest > policy.maxDeficitPerScope) throw new RangeError('maxCostPerRequest must not exceed maxDeficitPerScope');
  return Object.freeze(policy);
}

/**
 * Payload-free weighted deficit-round-robin authority for expensive runtime work.
 * It stores scalar scheduling metadata only; callers retain the work payload.
 */
export class RuntimeFairnessGovernor {
  private readonly policy: RuntimeFairnessPolicy;
  private readonly now: () => number;
  private readonly tickets = new Map<string, TicketState>();
  private readonly scopes = new Map<string, ScopeState>();
  private sequence = 0;
  private generation = 1;
  private cursor = 0;
  private lastNow = 0;
  private enqueued = 0;
  private promoted = 0;
  private cancelled = 0;
  private expired = 0;
  private rejected = 0;
  private disposed = false;

  constructor(policy: Partial<RuntimeFairnessPolicy> = {}, now: () => number = Date.now) {
    this.policy = policyOf(policy);
    this.now = now;
    this.lastNow = this.readClock();
  }

  enqueue(request: RuntimeFairnessRequest): RuntimeFairnessTicket | null {
    this.assertUsable();
    const scope = scopeOf(request.scope);
    const priority = priorityOf(request.priority);
    integer(request.cost, 'cost', 1);
    if (request.cost > this.policy.maxCostPerRequest) throw new RangeError('cost exceeds per-request maximum');
    const now = this.tick();
    this.sweepAt(now);
    if (this.tickets.size >= this.policy.maxQueuedGlobal) return this.reject();
    let state = this.scopes.get(scope);
    if (!state) {
      if (!this.ensureScopeCapacity(now)) return this.reject();
      state = { scope, queue: [], deficit: 0, touchedAt: now };
      this.scopes.set(scope, state);
    }
    if (state.queue.length >= this.policy.maxQueuedPerScope) return this.reject();
    const ticket: TicketState = {
      id: this.nextId(scope), scope, priority, cost: request.cost, generation: this.generation,
      queuedAt: now, expiresAt: now + this.policy.requestTtlMs,
    };
    state.queue.push(ticket);
    state.touchedAt = now;
    this.tickets.set(ticket.id, ticket);
    this.enqueued = this.bump(this.enqueued);
    return this.detach(ticket);
  }

  /** Promotes at most one ticket using deterministic weighted deficit round-robin. */
  promote(): RuntimeFairnessTicket | null {
    this.assertUsable();
    const now = this.tick();
    this.sweepAt(now);
    const active = this.activeScopes();
    if (active.length === 0) return null;
    const start = this.cursor % active.length;
    for (let pass = 0; pass < 2; pass += 1) {
      for (let offset = 0; offset < active.length; offset += 1) {
        const index = (start + offset) % active.length;
        const state = active[index];
        if (!state) continue;
        const head = state.queue[0];
        if (!head) continue;
        state.deficit = Math.min(this.policy.maxDeficitPerScope, state.deficit + this.quantum(head.priority));
        if (state.deficit < head.cost) continue;
        state.deficit -= head.cost;
        state.queue.shift();
        state.touchedAt = now;
        this.tickets.delete(head.id);
        this.promoted = this.bump(this.promoted);
        this.cursor = (index + 1) % active.length;
        return this.detach(head);
      }
    }
    this.cursor = (start + 1) % active.length;
    return null;
  }

  cancel(ticket: RuntimeFairnessTicket): boolean {
    if (this.disposed) return false;
    const now = this.tick();
    this.sweepAt(now);
    const state = this.resolve(ticket);
    if (!state) return false;
    this.remove(state, now);
    this.cancelled = this.bump(this.cancelled);
    return true;
  }

  isQueued(ticket: RuntimeFairnessTicket): boolean {
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
    const count = state.queue.length;
    for (const ticket of state.queue) {
      this.tickets.delete(ticket.id);
      this.cancelled = this.bump(this.cancelled);
    }
    this.scopes.delete(scope);
    this.advanceGeneration();
    this.cursor = 0;
    return count;
  }

  sweep(): number { this.assertUsable(); return this.sweepAt(this.tick()); }

  snapshot(): RuntimeFairnessSnapshot {
    let critical = 0, interactive = 0, background = 0, totalCost = 0;
    for (const ticket of this.tickets.values()) {
      totalCost += ticket.cost;
      if (ticket.priority === 'critical') critical += 1;
      else if (ticket.priority === 'interactive') interactive += 1;
      else background += 1;
    }
    return Object.freeze({ queued: this.tickets.size, scopes: this.scopes.size, critical, interactive, background, totalCost,
      enqueued: this.enqueued, promoted: this.promoted, cancelled: this.cancelled, expired: this.expired,
      rejected: this.rejected, generation: this.generation, disposed: this.disposed });
  }

  dispose(): void {
    if (this.disposed) return;
    this.tickets.clear(); this.scopes.clear(); this.cursor = 0; this.advanceGeneration(); this.disposed = true;
  }

  private activeScopes(): ScopeState[] {
    const active: ScopeState[] = [];
    for (const state of this.scopes.values()) if (state.queue.length > 0) active.push(state);
    active.sort((left, right) => left.scope.localeCompare(right.scope));
    return active;
  }
  private resolve(candidate: RuntimeFairnessTicket): TicketState | null {
    if (!candidate || candidate.generation !== this.generation) return null;
    const state = this.tickets.get(candidate.id);
    if (!state) return null;
    if (state.scope !== candidate.scope || state.priority !== candidate.priority || state.cost !== candidate.cost ||
        state.queuedAt !== candidate.queuedAt || state.expiresAt !== candidate.expiresAt) return null;
    return state;
  }
  private remove(ticket: TicketState, now: number): void {
    this.tickets.delete(ticket.id);
    const state = this.scopes.get(ticket.scope);
    if (!state) return;
    const index = state.queue.findIndex(candidate => candidate.id === ticket.id);
    if (index >= 0) state.queue.splice(index, 1);
    state.touchedAt = now;
  }
  private sweepAt(now: number): number {
    let removed = 0;
    for (const ticket of Array.from(this.tickets.values())) if (ticket.expiresAt <= now) {
      this.remove(ticket, now); this.expired = this.bump(this.expired); removed += 1;
    }
    for (const [scope, state] of this.scopes) if (state.queue.length === 0 && now - state.touchedAt >= this.policy.idleScopeTtlMs) this.scopes.delete(scope);
    return removed;
  }
  private ensureScopeCapacity(now: number): boolean {
    if (this.scopes.size < this.policy.maxScopes) return true;
    let candidate: string | null = null, touched = Number.POSITIVE_INFINITY;
    for (const [scope, state] of this.scopes) if (state.queue.length === 0 && state.touchedAt < touched) { candidate = scope; touched = state.touchedAt; }
    if (candidate === null) return false;
    this.scopes.delete(candidate);
    return touched <= now && this.scopes.size < this.policy.maxScopes;
  }
  private quantum(priority: RuntimeFairnessPriority): number {
    if (priority === 'critical') return this.policy.criticalQuantum;
    if (priority === 'interactive') return this.policy.interactiveQuantum;
    return this.policy.backgroundQuantum;
  }
  private reject(): null { this.rejected = this.bump(this.rejected); return null; }
  private nextId(scope: string): string { this.sequence = this.sequence >= MAX_COUNTER ? 1 : this.sequence + 1; return `${this.generation}:${this.sequence}:${scope}`; }
  private tick(): number {
    const current = this.readClock();
    if (current + this.policy.maxClockSkewMs < this.lastNow) throw new Error('runtime fairness clock moved backwards beyond policy');
    this.lastNow = Math.max(this.lastNow, current); return this.lastNow;
  }
  private readClock(): number { const value = this.now(); if (!Number.isFinite(value) || value < 0) throw new Error('runtime fairness clock must return a finite non-negative value'); return value; }
  private detach(ticket: TicketState): RuntimeFairnessTicket { return Object.freeze({ ...ticket }); }
  private advanceGeneration(): void { this.generation = this.generation >= MAX_COUNTER ? 1 : this.generation + 1; }
  private bump(value: number): number { return value >= MAX_COUNTER ? MAX_COUNTER : value + 1; }
  private assertUsable(): void { if (this.disposed) throw new Error('RuntimeFairnessGovernor is disposed'); }
}

export function createRuntimeFairnessGovernor(policy: Partial<RuntimeFairnessPolicy> = {}, now: () => number = Date.now): RuntimeFairnessGovernor {
  return new RuntimeFairnessGovernor(policy, now);
}
