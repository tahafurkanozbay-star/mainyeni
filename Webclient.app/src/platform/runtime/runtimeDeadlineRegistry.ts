export type DeadlinePriority = 'background' | 'interactive' | 'critical';
export type DeadlineState = 'scheduled' | 'claimed' | 'completed' | 'cancelled' | 'expired';

export interface DeadlineClock { now(): number; }
export interface RuntimeDeadlineRegistryOptions {
  readonly maxEntries: number;
  readonly maxEntriesPerScope: number;
  readonly maxTtlMs: number;
  readonly maxClaimMs: number;
  readonly maxScopes: number;
  readonly maxKeyLength: number;
  readonly maxScopeLength: number;
}
export interface ScheduleDeadlineInput {
  readonly key: string;
  readonly scope: string;
  readonly dueAt: number;
  readonly expiresAt: number;
  readonly priority?: DeadlinePriority;
}
export interface DeadlineRecord {
  readonly key: string;
  readonly scope: string;
  readonly dueAt: number;
  readonly expiresAt: number;
  readonly priority: DeadlinePriority;
  readonly state: DeadlineState;
  readonly generation: number;
  readonly claimedUntil: number | null;
}
export interface DeadlineClaim {
  readonly key: string;
  readonly scope: string;
  readonly generation: number;
  readonly claimedUntil: number;
}
export interface DeadlineRegistrySnapshot {
  readonly scheduled: number;
  readonly claimed: number;
  readonly scopes: number;
  readonly admitted: number;
  readonly rejected: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly expired: number;
  readonly evicted: number;
}

type MutableRecord = {
  key: string; scope: string; dueAt: number; expiresAt: number; priority: DeadlinePriority;
  state: DeadlineState; generation: number; claimedUntil: number | null; sequence: number;
};
type Counters = { admitted: number; rejected: number; completed: number; cancelled: number; expired: number; evicted: number };

const defaultClock: DeadlineClock = { now: () => Date.now() };
const priorities: Readonly<Record<DeadlinePriority, number>> = Object.freeze({ background: 0, interactive: 1, critical: 2 });
const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite.`);
  return value;
};
const positiveInteger = (value: number, name: string): number => {
  finite(value, name);
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
};
const boundedIdentifier = (value: string, name: string, maximum: number): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) throw new RangeError(`${name} length is invalid.`);
  if (/[^\p{L}\p{N}._:/-]/u.test(normalized)) throw new RangeError(`${name} contains unsupported characters.`);
  return normalized;
};
const frozenRecord = (record: MutableRecord): DeadlineRecord => Object.freeze({
  key: record.key, scope: record.scope, dueAt: record.dueAt, expiresAt: record.expiresAt,
  priority: record.priority, state: record.state, generation: record.generation, claimedUntil: record.claimedUntil,
});

/**
 * Timer-free authority for bounded runtime deadlines. The registry never owns
 * callbacks, request payloads, AbortControllers, SDK objects or timers. Callers
 * explicitly sweep and claim due work, keeping scheduling deterministic and
 * teardown cheap even when browser tabs are suspended.
 */
export class RuntimeDeadlineRegistry {
  readonly #options: RuntimeDeadlineRegistryOptions;
  readonly #clock: DeadlineClock;
  readonly #records = new Map<string, MutableRecord>();
  readonly #scopeCounts = new Map<string, number>();
  readonly #generations = new Map<string, number>();
  readonly #counters: Counters = { admitted: 0, rejected: 0, completed: 0, cancelled: 0, expired: 0, evicted: 0 };
  #sequence = 0;
  #disposed = false;

  public constructor(options: RuntimeDeadlineRegistryOptions, clock: DeadlineClock = defaultClock) {
    positiveInteger(options.maxEntries, 'maxEntries');
    positiveInteger(options.maxEntriesPerScope, 'maxEntriesPerScope');
    if (options.maxEntriesPerScope > options.maxEntries) throw new RangeError('maxEntriesPerScope exceeds maxEntries.');
    positiveInteger(options.maxTtlMs, 'maxTtlMs');
    positiveInteger(options.maxClaimMs, 'maxClaimMs');
    positiveInteger(options.maxScopes, 'maxScopes');
    positiveInteger(options.maxKeyLength, 'maxKeyLength');
    positiveInteger(options.maxScopeLength, 'maxScopeLength');
    this.#options = Object.freeze({ ...options });
    this.#clock = clock;
  }

  #now(): number { return finite(this.#clock.now(), 'clock.now()'); }
  #assertLive(): void { if (this.#disposed) throw new Error('RuntimeDeadlineRegistry is disposed.'); }
  #identity(scope: string, key: string): string { return `${scope}\u0000${key}`; }
  #nextGeneration(identity: string): number {
    const next = (this.#generations.get(identity) ?? 0) + 1;
    this.#generations.set(identity, next);
    return next;
  }
  #incrementScope(scope: string): void { this.#scopeCounts.set(scope, (this.#scopeCounts.get(scope) ?? 0) + 1); }
  #decrementScope(scope: string): void {
    const next = (this.#scopeCounts.get(scope) ?? 1) - 1;
    if (next <= 0) this.#scopeCounts.delete(scope); else this.#scopeCounts.set(scope, next);
  }
  #remove(identity: string, terminal: 'completed' | 'cancelled' | 'expired' | 'evicted'): boolean {
    const record = this.#records.get(identity);
    if (!record) return false;
    this.#records.delete(identity);
    this.#decrementScope(record.scope);
    if (terminal === 'completed') this.#counters.completed += 1;
    else if (terminal === 'cancelled') this.#counters.cancelled += 1;
    else if (terminal === 'expired') this.#counters.expired += 1;
    else this.#counters.evicted += 1;
    return true;
  }
  #evictionCandidate(): [string, MutableRecord] | null {
    let candidate: [string, MutableRecord] | null = null;
    for (const entry of this.#records) {
      const record = entry[1];
      if (record.state === 'claimed') continue;
      if (!candidate) { candidate = entry; continue; }
      const current = candidate[1];
      const rank = priorities[record.priority] - priorities[current.priority];
      if (rank < 0 || (rank === 0 && record.sequence < current.sequence)) candidate = entry;
    }
    return candidate;
  }
  #makeCapacity(now: number, incomingPriority: DeadlinePriority): boolean {
    this.sweep(now);
    if (this.#records.size < this.#options.maxEntries) return true;
    const candidate = this.#evictionCandidate();
    if (!candidate || priorities[candidate[1].priority] >= priorities[incomingPriority]) return false;
    this.#remove(candidate[0], 'evicted');
    return true;
  }

  public schedule(input: ScheduleDeadlineInput): DeadlineRecord | null {
    this.#assertLive();
    const now = this.#now();
    const key = boundedIdentifier(input.key, 'key', this.#options.maxKeyLength);
    const scope = boundedIdentifier(input.scope, 'scope', this.#options.maxScopeLength);
    finite(input.dueAt, 'dueAt'); finite(input.expiresAt, 'expiresAt');
    if (input.dueAt < now || input.expiresAt < input.dueAt) throw new RangeError('deadline interval is invalid.');
    if (input.expiresAt - now > this.#options.maxTtlMs) throw new RangeError('deadline exceeds maxTtlMs.');
    const priority = input.priority ?? 'background';
    const identity = this.#identity(scope, key);
    const existing = this.#records.get(identity);
    if (existing) {
      if (existing.state === 'claimed') { this.#counters.rejected += 1; return null; }
      existing.dueAt = input.dueAt; existing.expiresAt = input.expiresAt; existing.priority = priority;
      existing.generation = this.#nextGeneration(identity); existing.sequence = ++this.#sequence;
      return frozenRecord(existing);
    }
    const scopeCount = this.#scopeCounts.get(scope) ?? 0;
    if (scopeCount >= this.#options.maxEntriesPerScope) { this.#counters.rejected += 1; return null; }
    if (!this.#scopeCounts.has(scope) && this.#scopeCounts.size >= this.#options.maxScopes) { this.#counters.rejected += 1; return null; }
    if (!this.#makeCapacity(now, priority)) { this.#counters.rejected += 1; return null; }
    const record: MutableRecord = { key, scope, dueAt: input.dueAt, expiresAt: input.expiresAt, priority, state: 'scheduled', generation: this.#nextGeneration(identity), claimedUntil: null, sequence: ++this.#sequence };
    this.#records.set(identity, record); this.#incrementScope(scope); this.#counters.admitted += 1;
    return frozenRecord(record);
  }

  public claimDue(limit: number, claimMs: number): readonly DeadlineClaim[] {
    this.#assertLive();
    positiveInteger(limit, 'limit'); positiveInteger(claimMs, 'claimMs');
    if (claimMs > this.#options.maxClaimMs) throw new RangeError('claimMs exceeds maxClaimMs.');
    const now = this.#now(); this.sweep(now);
    const due: MutableRecord[] = [];
    for (const record of this.#records.values()) if (record.state === 'scheduled' && record.dueAt <= now) due.push(record);
    due.sort((a, b) => priorities[b.priority] - priorities[a.priority] || a.dueAt - b.dueAt || a.sequence - b.sequence);
    const claims: DeadlineClaim[] = [];
    for (let index = 0; index < due.length && claims.length < limit; index += 1) {
      const record = due[index]; if (!record) continue;
      record.state = 'claimed'; record.claimedUntil = Math.min(record.expiresAt, now + claimMs);
      claims.push(Object.freeze({ key: record.key, scope: record.scope, generation: record.generation, claimedUntil: record.claimedUntil }));
    }
    return Object.freeze(claims);
  }

  public renew(claim: DeadlineClaim, claimMs: number): DeadlineClaim | null {
    this.#assertLive(); positiveInteger(claimMs, 'claimMs');
    if (claimMs > this.#options.maxClaimMs) throw new RangeError('claimMs exceeds maxClaimMs.');
    const now = this.#now(); this.sweep(now);
    const record = this.#records.get(this.#identity(claim.scope, claim.key));
    if (!record || record.state !== 'claimed' || record.generation !== claim.generation) return null;
    record.claimedUntil = Math.min(record.expiresAt, now + claimMs);
    return Object.freeze({ key: record.key, scope: record.scope, generation: record.generation, claimedUntil: record.claimedUntil });
  }

  public complete(claim: DeadlineClaim): boolean {
    this.#assertLive(); this.sweep(this.#now());
    const identity = this.#identity(claim.scope, claim.key); const record = this.#records.get(identity);
    if (!record || record.state !== 'claimed' || record.generation !== claim.generation) return false;
    return this.#remove(identity, 'completed');
  }
  public cancel(scope: string, key: string): boolean {
    this.#assertLive();
    const safeScope = boundedIdentifier(scope, 'scope', this.#options.maxScopeLength);
    const safeKey = boundedIdentifier(key, 'key', this.#options.maxKeyLength);
    return this.#remove(this.#identity(safeScope, safeKey), 'cancelled');
  }
  public cancelScope(scope: string): number {
    this.#assertLive(); const safeScope = boundedIdentifier(scope, 'scope', this.#options.maxScopeLength); let removed = 0;
    for (const [identity, record] of this.#records) if (record.scope === safeScope && this.#remove(identity, 'cancelled')) removed += 1;
    return removed;
  }
  public sweep(at = this.#now()): number {
    this.#assertLive(); finite(at, 'at'); let changed = 0;
    for (const [identity, record] of this.#records) {
      if (record.expiresAt <= at) { if (this.#remove(identity, 'expired')) changed += 1; continue; }
      if (record.state === 'claimed' && record.claimedUntil !== null && record.claimedUntil <= at) {
        record.state = 'scheduled'; record.claimedUntil = null; changed += 1;
      }
    }
    return changed;
  }
  public get(scope: string, key: string): DeadlineRecord | null {
    this.#assertLive(); const record = this.#records.get(this.#identity(scope.trim(), key.trim())); return record ? frozenRecord(record) : null;
  }
  public snapshot(): DeadlineRegistrySnapshot {
    let scheduled = 0; let claimed = 0;
    for (const record of this.#records.values()) if (record.state === 'claimed') claimed += 1; else scheduled += 1;
    return Object.freeze({ scheduled, claimed, scopes: this.#scopeCounts.size, ...this.#counters });
  }
  public dispose(): void {
    if (this.#disposed) return;
    this.#records.clear(); this.#scopeCounts.clear(); this.#generations.clear(); this.#disposed = true;
  }
}
