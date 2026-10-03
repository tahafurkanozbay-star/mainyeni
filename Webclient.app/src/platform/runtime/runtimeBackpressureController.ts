export type RuntimePressureLane = 'interactive' | 'background' | 'maintenance';
export type RuntimePressureLevel = 'normal' | 'elevated' | 'critical';
export type RuntimePressureDecision = 'admit' | 'defer' | 'reject';

export interface RuntimePressurePolicy {
  readonly maxScopes: number;
  readonly maxDeferred: number;
  readonly maxDeferredPerScope: number;
  readonly maxIdentifierLength: number;
  readonly deferTtlMs: number;
  readonly idleScopeTtlMs: number;
  readonly elevatedConcurrencyFactor: number;
  readonly criticalConcurrencyFactor: number;
  readonly baseConcurrency: Readonly<Record<RuntimePressureLane, number>>;
}

export interface RuntimePressureSample {
  readonly cpu: number;
  readonly memory: number;
  readonly network: number;
}

export interface RuntimePressureRequest {
  readonly id: string;
  readonly scope: string;
  readonly lane: RuntimePressureLane;
}

export interface RuntimePressurePermit {
  readonly id: string;
  readonly scope: string;
  readonly lane: RuntimePressureLane;
  readonly generation: number;
  readonly admittedAt: number;
}

export interface RuntimePressureAdmission {
  readonly decision: RuntimePressureDecision;
  readonly permit?: RuntimePressurePermit;
  readonly reason?: 'capacity' | 'queue-full' | 'duplicate' | 'scope-limit' | 'disposed';
}

export interface RuntimePressureSnapshot {
  readonly level: RuntimePressureLevel;
  readonly active: number;
  readonly deferred: number;
  readonly scopes: number;
  readonly activeByLane: Readonly<Record<RuntimePressureLane, number>>;
  readonly deferredByLane: Readonly<Record<RuntimePressureLane, number>>;
  readonly generation: number;
  readonly disposed: boolean;
}

interface DeferredState {
  readonly request: RuntimePressureRequest;
  readonly queuedAt: number;
  readonly expiresAt: number;
  readonly sequence: number;
}

interface ScopeState {
  active: number;
  deferred: number;
  lastTouchedAt: number;
}

const LANES: readonly RuntimePressureLane[] = ['interactive', 'background', 'maintenance'];
const MAX_INTEGER = 100_000;
const MAX_TTL = 86_400_000;

function integer(name: string, value: number, min: number, max = MAX_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function factor(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new RangeError(`${name} must be > 0 and <= 1`);
  return value;
}

function normalizeIdentifier(value: string, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (!normalized || normalized.length > max || !/^[a-z0-9][a-z0-9:._/-]*$/.test(normalized)) return null;
  return normalized;
}

function validatePolicy(policy: RuntimePressurePolicy): RuntimePressurePolicy {
  return Object.freeze({
    maxScopes: integer('maxScopes', policy.maxScopes, 1),
    maxDeferred: integer('maxDeferred', policy.maxDeferred, 0),
    maxDeferredPerScope: integer('maxDeferredPerScope', policy.maxDeferredPerScope, 0),
    maxIdentifierLength: integer('maxIdentifierLength', policy.maxIdentifierLength, 8, 512),
    deferTtlMs: integer('deferTtlMs', policy.deferTtlMs, 1, MAX_TTL),
    idleScopeTtlMs: integer('idleScopeTtlMs', policy.idleScopeTtlMs, 1, MAX_TTL),
    elevatedConcurrencyFactor: factor('elevatedConcurrencyFactor', policy.elevatedConcurrencyFactor),
    criticalConcurrencyFactor: factor('criticalConcurrencyFactor', policy.criticalConcurrencyFactor),
    baseConcurrency: Object.freeze({
      interactive: integer('baseConcurrency.interactive', policy.baseConcurrency.interactive, 1),
      background: integer('baseConcurrency.background', policy.baseConcurrency.background, 1),
      maintenance: integer('baseConcurrency.maintenance', policy.baseConcurrency.maintenance, 1),
    }),
  });
}

function pressureLevel(sample: RuntimePressureSample): RuntimePressureLevel {
  const values = [sample.cpu, sample.memory, sample.network];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new RangeError('pressure samples must be finite ratios between 0 and 1');
  const peak = Math.max(...values);
  if (peak >= 0.9) return 'critical';
  if (peak >= 0.7) return 'elevated';
  return 'normal';
}

/**
 * Payload-free backpressure authority for browser runtime work.
 * It stores identifiers and aggregate counters only; callers retain callbacks,
 * request bodies, credentials, SDK objects and cancellation primitives.
 */
export class RuntimeBackpressureController {
  readonly #policy: RuntimePressurePolicy;
  readonly #now: () => number;
  readonly #active = new Map<string, RuntimePressurePermit>();
  readonly #deferred = new Map<string, DeferredState>();
  readonly #scopes = new Map<string, ScopeState>();
  readonly #activeByLane: Record<RuntimePressureLane, number> = { interactive: 0, background: 0, maintenance: 0 };
  readonly #deferredByLane: Record<RuntimePressureLane, number> = { interactive: 0, background: 0, maintenance: 0 };
  #level: RuntimePressureLevel = 'normal';
  #generation = 1;
  #sequence = 0;
  #disposed = false;

  constructor(options: { readonly policy: RuntimePressurePolicy; readonly now?: () => number }) {
    this.#policy = validatePolicy(options.policy);
    this.#now = options.now ?? Date.now;
  }

  sample(sample: RuntimePressureSample): readonly RuntimePressurePermit[] {
    this.#assertLive();
    const now = this.#time();
    this.#sweep(now);
    this.#level = pressureLevel(sample);
    return this.#promote(now);
  }

  admit(input: RuntimePressureRequest): RuntimePressureAdmission {
    if (this.#disposed) return Object.freeze({ decision: 'reject', reason: 'disposed' });
    const request = this.#request(input);
    const now = this.#time();
    this.#sweep(now);
    if (this.#active.has(request.id) || this.#deferred.has(request.id)) return Object.freeze({ decision: 'reject', reason: 'duplicate' });
    const scope = this.#scope(request.scope, now);
    if (!scope) return Object.freeze({ decision: 'reject', reason: 'scope-limit' });
    if (this.#hasCapacity(request.lane)) return this.#activate(request, scope, now);
    if (this.#deferred.size >= this.#policy.maxDeferred || scope.deferred >= this.#policy.maxDeferredPerScope) {
      return Object.freeze({ decision: 'reject', reason: 'queue-full' });
    }
    this.#sequence += 1;
    this.#deferred.set(request.id, { request, queuedAt: now, expiresAt: now + this.#policy.deferTtlMs, sequence: this.#sequence });
    this.#deferredByLane[request.lane] += 1;
    scope.deferred += 1;
    scope.lastTouchedAt = now;
    return Object.freeze({ decision: 'defer', reason: 'capacity' });
  }

  release(permit: RuntimePressurePermit): readonly RuntimePressurePermit[] {
    if (this.#disposed || !this.#validPermit(permit)) return Object.freeze([]);
    const current = this.#active.get(permit.id);
    if (!current || current.generation !== permit.generation || current.scope !== permit.scope || current.lane !== permit.lane || current.admittedAt !== permit.admittedAt) return Object.freeze([]);
    this.#active.delete(permit.id);
    this.#activeByLane[permit.lane] -= 1;
    const scope = this.#scopes.get(permit.scope);
    if (scope) { scope.active -= 1; scope.lastTouchedAt = this.#time(); }
    return this.#promote(this.#time());
  }

  cancel(id: string): boolean {
    if (this.#disposed) return false;
    const normalized = normalizeIdentifier(id, this.#policy.maxIdentifierLength);
    if (!normalized) return false;
    const deferred = this.#deferred.get(normalized);
    if (!deferred) return false;
    this.#removeDeferred(deferred);
    return true;
  }

  resetScope(scopeId: string): boolean {
    if (this.#disposed) return false;
    const scope = normalizeIdentifier(scopeId, this.#policy.maxIdentifierLength);
    if (!scope || !this.#scopes.has(scope)) return false;
    for (const [id, permit] of this.#active) if (permit.scope === scope) { this.#active.delete(id); this.#activeByLane[permit.lane] -= 1; }
    for (const deferred of this.#deferred.values()) if (deferred.request.scope === scope) this.#removeDeferred(deferred);
    this.#scopes.delete(scope);
    this.#generation += 1;
    return true;
  }

  sweep(): readonly RuntimePressurePermit[] {
    if (this.#disposed) return Object.freeze([]);
    const now = this.#time();
    this.#sweep(now);
    return this.#promote(now);
  }

  snapshot(): RuntimePressureSnapshot {
    return Object.freeze({
      level: this.#level,
      active: this.#active.size,
      deferred: this.#deferred.size,
      scopes: this.#scopes.size,
      activeByLane: Object.freeze({ ...this.#activeByLane }),
      deferredByLane: Object.freeze({ ...this.#deferredByLane }),
      generation: this.#generation,
      disposed: this.#disposed,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#active.clear();
    this.#deferred.clear();
    this.#scopes.clear();
    for (const lane of LANES) { this.#activeByLane[lane] = 0; this.#deferredByLane[lane] = 0; }
    this.#generation += 1;
  }

  #request(input: RuntimePressureRequest): RuntimePressureRequest {
    const id = normalizeIdentifier(input.id, this.#policy.maxIdentifierLength);
    const scope = normalizeIdentifier(input.scope, this.#policy.maxIdentifierLength);
    if (!id || !scope || !LANES.includes(input.lane)) throw new TypeError('invalid runtime pressure request');
    return Object.freeze({ id, scope, lane: input.lane });
  }

  #scope(id: string, now: number): ScopeState | null {
    const existing = this.#scopes.get(id);
    if (existing) { existing.lastTouchedAt = now; return existing; }
    if (this.#scopes.size >= this.#policy.maxScopes) this.#evictIdle(now);
    if (this.#scopes.size >= this.#policy.maxScopes) return null;
    const created: ScopeState = { active: 0, deferred: 0, lastTouchedAt: now };
    this.#scopes.set(id, created);
    return created;
  }

  #limit(lane: RuntimePressureLane): number {
    const base = this.#policy.baseConcurrency[lane];
    const factorValue = this.#level === 'normal' ? 1 : this.#level === 'elevated' ? this.#policy.elevatedConcurrencyFactor : this.#policy.criticalConcurrencyFactor;
    return Math.max(1, Math.floor(base * factorValue));
  }

  #hasCapacity(lane: RuntimePressureLane): boolean { return this.#activeByLane[lane] < this.#limit(lane); }

  #activate(request: RuntimePressureRequest, scope: ScopeState, now: number): RuntimePressureAdmission {
    const permit = Object.freeze({ id: request.id, scope: request.scope, lane: request.lane, generation: this.#generation, admittedAt: now });
    this.#active.set(request.id, permit);
    this.#activeByLane[request.lane] += 1;
    scope.active += 1;
    scope.lastTouchedAt = now;
    return Object.freeze({ decision: 'admit', permit });
  }

  #promote(now: number): readonly RuntimePressurePermit[] {
    const promoted: RuntimePressurePermit[] = [];
    const ordered = [...this.#deferred.values()].sort((a, b) => {
      const laneOrder = LANES.indexOf(a.request.lane) - LANES.indexOf(b.request.lane);
      return laneOrder || a.sequence - b.sequence || a.request.id.localeCompare(b.request.id);
    });
    for (const deferred of ordered) {
      if (!this.#hasCapacity(deferred.request.lane)) continue;
      const scope = this.#scopes.get(deferred.request.scope);
      if (!scope) { this.#removeDeferred(deferred); continue; }
      this.#removeDeferred(deferred);
      const admission = this.#activate(deferred.request, scope, now);
      if (admission.permit) promoted.push(admission.permit);
    }
    return Object.freeze(promoted);
  }

  #removeDeferred(deferred: DeferredState): void {
    if (!this.#deferred.delete(deferred.request.id)) return;
    this.#deferredByLane[deferred.request.lane] -= 1;
    const scope = this.#scopes.get(deferred.request.scope);
    if (scope) { scope.deferred -= 1; scope.lastTouchedAt = this.#time(); }
  }

  #sweep(now: number): void {
    for (const deferred of this.#deferred.values()) if (deferred.expiresAt <= now) this.#removeDeferred(deferred);
    this.#evictIdle(now);
  }

  #evictIdle(now: number): void {
    const candidates = [...this.#scopes.entries()]
      .filter(([, state]) => state.active === 0 && state.deferred === 0 && now - state.lastTouchedAt >= this.#policy.idleScopeTtlMs)
      .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt || a[0].localeCompare(b[0]));
    for (const [id] of candidates) this.#scopes.delete(id);
  }

  #validPermit(value: RuntimePressurePermit): boolean {
    return Boolean(value && typeof value.id === 'string' && typeof value.scope === 'string' && LANES.includes(value.lane) && Number.isSafeInteger(value.generation) && Number.isFinite(value.admittedAt));
  }

  #time(): number {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) throw new RangeError('runtime clock must return a non-negative finite number');
    return value;
  }

  #assertLive(): void { if (this.#disposed) throw new Error('runtime backpressure controller is disposed'); }
}
