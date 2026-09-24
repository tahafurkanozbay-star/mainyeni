import type { RuntimeFailureBudgetLane } from './runtimeFailureBudget';

export type RuntimeQuarantineReason = 'failure-budget' | 'overload' | 'operator';
export type RuntimeQuarantineState = 'active' | 'probation';

export interface RuntimeQuarantinePolicy {
  readonly maxEntries: number;
  readonly maxKeyLength: number;
  readonly quarantineMs: number;
  readonly probationMs: number;
  readonly maxProbationAttempts: number;
  readonly historyLimit: number;
}

export interface RuntimeQuarantinePolicyInput extends Partial<RuntimeQuarantinePolicy> {}

export interface RuntimeQuarantineEntry {
  readonly key: string;
  readonly lane: RuntimeFailureBudgetLane;
  readonly reason: RuntimeQuarantineReason;
  readonly state: RuntimeQuarantineState;
  readonly quarantinedAt: number;
  readonly eligibleAt: number;
  readonly expiresAt: number;
  readonly probationAttempts: number;
}

export interface RuntimeQuarantineEvent {
  readonly sequence: number;
  readonly type: 'quarantine' | 'probation' | 'release' | 'evict' | 'reject';
  readonly key: string;
  readonly lane: RuntimeFailureBudgetLane;
  readonly at: number;
  readonly reason: RuntimeQuarantineReason | 'capacity' | 'attempt-budget' | 'healthy';
}

export interface RuntimeQuarantineSnapshot {
  readonly sequence: number;
  readonly size: number;
  readonly entries: readonly RuntimeQuarantineEntry[];
  readonly history: readonly RuntimeQuarantineEvent[];
}

const LANES: readonly RuntimeFailureBudgetLane[] = Object.freeze(['critical', 'interactive', 'background']);
const REASONS: readonly RuntimeQuarantineReason[] = Object.freeze(['failure-budget', 'overload', 'operator']);
const DEFAULT_POLICY: RuntimeQuarantinePolicy = Object.freeze({
  maxEntries: 256,
  maxKeyLength: 160,
  quarantineMs: 30_000,
  probationMs: 15_000,
  maxProbationAttempts: 3,
  historyLimit: 256,
});

const integer = (value: number, name: string, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

const timestamp = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('at must be a finite non-negative number');
  return value;
};

const normalizePolicy = (input: RuntimeQuarantinePolicyInput): RuntimeQuarantinePolicy => Object.freeze({
  maxEntries: integer(input.maxEntries ?? DEFAULT_POLICY.maxEntries, 'maxEntries', 1, 10_000),
  maxKeyLength: integer(input.maxKeyLength ?? DEFAULT_POLICY.maxKeyLength, 'maxKeyLength', 1, 1_024),
  quarantineMs: integer(input.quarantineMs ?? DEFAULT_POLICY.quarantineMs, 'quarantineMs', 1, 86_400_000),
  probationMs: integer(input.probationMs ?? DEFAULT_POLICY.probationMs, 'probationMs', 1, 86_400_000),
  maxProbationAttempts: integer(input.maxProbationAttempts ?? DEFAULT_POLICY.maxProbationAttempts, 'maxProbationAttempts', 1, 1_000),
  historyLimit: integer(input.historyLimit ?? DEFAULT_POLICY.historyLimit, 'historyLimit', 1, 10_000),
});

const assertLane = (lane: RuntimeFailureBudgetLane): void => {
  if (!LANES.includes(lane)) throw new TypeError(`unsupported quarantine lane: ${String(lane)}`);
};

const assertReason = (reason: RuntimeQuarantineReason): void => {
  if (!REASONS.includes(reason)) throw new TypeError(`unsupported quarantine reason: ${String(reason)}`);
};

const cloneEntry = (entry: RuntimeQuarantineEntry): RuntimeQuarantineEntry => Object.freeze({ ...entry });
const cloneEvent = (event: RuntimeQuarantineEvent): RuntimeQuarantineEvent => Object.freeze({ ...event });

export class RuntimeQuarantineRegistry {
  readonly #policy: RuntimeQuarantinePolicy;
  readonly #entries = new Map<string, RuntimeQuarantineEntry>();
  readonly #history: RuntimeQuarantineEvent[] = [];
  #sequence = 0;
  #lastAt = 0;

  constructor(policy: RuntimeQuarantinePolicyInput = {}) {
    this.#policy = normalizePolicy(policy);
  }

  quarantine(key: string, lane: RuntimeFailureBudgetLane, reason: RuntimeQuarantineReason, at: number): RuntimeQuarantineEntry {
    const normalizedKey = this.#key(key);
    assertLane(lane);
    assertReason(reason);
    this.#clock(at);
    const existing = this.#entries.get(normalizedKey);
    if (!existing && this.#entries.size >= this.#policy.maxEntries) this.#evictOldest(at);
    const entry: RuntimeQuarantineEntry = Object.freeze({
      key: normalizedKey,
      lane,
      reason,
      state: 'active',
      quarantinedAt: at,
      eligibleAt: at + this.#policy.quarantineMs,
      expiresAt: at + this.#policy.quarantineMs + this.#policy.probationMs,
      probationAttempts: 0,
    });
    this.#entries.set(normalizedKey, entry);
    this.#record('quarantine', entry, at, reason);
    return cloneEntry(entry);
  }

  mayAttempt(key: string, at: number): boolean {
    const normalizedKey = this.#key(key);
    this.#clock(at);
    const entry = this.#entries.get(normalizedKey);
    if (!entry) return true;
    if (at < entry.eligibleAt) return false;
    if (at >= entry.expiresAt) {
      this.#entries.delete(normalizedKey);
      this.#record('release', entry, at, 'healthy');
      return true;
    }
    const maxAttempts = this.#policy.maxProbationAttempts;
    if (entry.probationAttempts >= maxAttempts) {
      this.#record('reject', entry, at, 'attempt-budget');
      return false;
    }
    const next = Object.freeze({ ...entry, state: 'probation' as const, probationAttempts: entry.probationAttempts + 1 });
    this.#entries.set(normalizedKey, next);
    this.#record('probation', next, at, entry.reason);
    return true;
  }

  reportHealthy(key: string, at: number): boolean {
    const normalizedKey = this.#key(key);
    this.#clock(at);
    const entry = this.#entries.get(normalizedKey);
    if (!entry) return false;
    this.#entries.delete(normalizedKey);
    this.#record('release', entry, at, 'healthy');
    return true;
  }

  release(key: string, at: number): boolean {
    return this.reportHealthy(key, at);
  }

  clear(lane?: RuntimeFailureBudgetLane): RuntimeQuarantineSnapshot {
    if (lane === undefined) {
      this.#entries.clear();
      this.#history.length = 0;
      this.#lastAt = 0;
      this.#sequence += 1;
      return this.snapshot();
    }
    assertLane(lane);
    for (const [key, entry] of this.#entries) if (entry.lane === lane) this.#entries.delete(key);
    this.#sequence += 1;
    return this.snapshot();
  }

  has(key: string): boolean {
    return this.#entries.has(this.#key(key));
  }

  policy(): RuntimeQuarantinePolicy {
    return this.#policy;
  }

  snapshot(): RuntimeQuarantineSnapshot {
    const entries = [...this.#entries.values()]
      .sort((left, right) => left.quarantinedAt - right.quarantinedAt || left.key.localeCompare(right.key))
      .map(cloneEntry);
    return Object.freeze({
      sequence: this.#sequence,
      size: entries.length,
      entries: Object.freeze(entries),
      history: Object.freeze(this.#history.map(cloneEvent)),
    });
  }

  #key(value: string): string {
    if (typeof value !== 'string') throw new TypeError('key must be a string');
    const normalized = value.trim();
    if (normalized.length === 0) throw new TypeError('key must not be empty');
    if (normalized.length > this.#policy.maxKeyLength) throw new RangeError(`key must be at most ${this.#policy.maxKeyLength} characters`);
    return normalized;
  }

  #clock(at: number): void {
    timestamp(at);
    if (at < this.#lastAt) throw new RangeError('at must be monotonic');
    this.#lastAt = at;
  }

  #evictOldest(at: number): void {
    let oldest: RuntimeQuarantineEntry | undefined;
    for (const entry of this.#entries.values()) {
      if (!oldest || entry.quarantinedAt < oldest.quarantinedAt || (entry.quarantinedAt === oldest.quarantinedAt && entry.key < oldest.key)) oldest = entry;
    }
    if (!oldest) return;
    this.#entries.delete(oldest.key);
    this.#record('evict', oldest, at, 'capacity');
  }

  #record(type: RuntimeQuarantineEvent['type'], entry: RuntimeQuarantineEntry, at: number, reason: RuntimeQuarantineEvent['reason']): void {
    this.#sequence += 1;
    this.#history.push(Object.freeze({ sequence: this.#sequence, type, key: entry.key, lane: entry.lane, at, reason }));
    const overflow = this.#history.length - this.#policy.historyLimit;
    if (overflow > 0) this.#history.splice(0, overflow);
  }
}
