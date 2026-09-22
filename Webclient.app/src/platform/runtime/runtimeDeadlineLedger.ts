export type RuntimeDeadlineLane = 'critical' | 'interactive' | 'background';

export interface RuntimeDeadlineRequest {
  readonly key: string;
  readonly lane: RuntimeDeadlineLane;
  readonly nowMs: number;
  readonly timeoutMs: number;
  readonly parentDeadlineMs?: number;
}

export interface RuntimeDeadlineLedgerOptions {
  readonly maxEntries?: number;
  readonly maxTimeoutMs?: number;
  readonly maxHistory?: number;
}

export interface RuntimeDeadlineLease {
  readonly key: string;
  readonly lane: RuntimeDeadlineLane;
  readonly createdAtMs: number;
  readonly deadlineMs: number;
  readonly timeoutMs: number;
  remainingMs(nowMs: number): number;
  expired(nowMs: number): boolean;
  complete(nowMs: number): boolean;
}

export interface RuntimeDeadlineHistoryEntry {
  readonly key: string;
  readonly lane: RuntimeDeadlineLane;
  readonly outcome: 'completed' | 'expired' | 'released';
  readonly createdAtMs: number;
  readonly finishedAtMs: number;
  readonly deadlineMs: number;
}

export interface RuntimeDeadlineSnapshot {
  readonly active: number;
  readonly created: number;
  readonly completed: number;
  readonly expired: number;
  readonly rejected: number;
  readonly released: number;
  readonly lastNowMs: number | null;
  readonly byLane: Readonly<Record<RuntimeDeadlineLane, number>>;
  readonly history: readonly RuntimeDeadlineHistoryEntry[];
}

interface Entry {
  readonly key: string;
  readonly lane: RuntimeDeadlineLane;
  readonly createdAtMs: number;
  readonly deadlineMs: number;
  readonly timeoutMs: number;
  settled: boolean;
}

const DEFAULT_MAX_ENTRIES = 256;
const HARD_MAX_ENTRIES = 4096;
const DEFAULT_MAX_TIMEOUT_MS = 60_000;
const HARD_MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_HISTORY = 64;
const HARD_MAX_HISTORY = 512;

const lanes: readonly RuntimeDeadlineLane[] = ['critical', 'interactive', 'background'];

const finiteNonNegative = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`);
  return value;
};

const positiveInteger = (value: number, name: string, hardMax: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return Math.min(value, hardMax);
};

const immutableHistory = (history: readonly RuntimeDeadlineHistoryEntry[]): readonly RuntimeDeadlineHistoryEntry[] =>
  Object.freeze(history.map(item => Object.freeze({ ...item })));

/**
 * Caller-clocked ownership ledger for runtime deadlines.
 *
 * The ledger deliberately does not own timers, AbortControllers, queues, network
 * transports or retries. It gives those owners a single bounded source of truth
 * for effective deadlines, parent-deadline propagation and expiry accounting.
 */
export class RuntimeDeadlineLedger {
  readonly #maxEntries: number;
  readonly #maxTimeoutMs: number;
  readonly #maxHistory: number;
  readonly #entries = new Map<string, Entry>();
  readonly #history: RuntimeDeadlineHistoryEntry[] = [];
  #lastNowMs: number | null = null;
  #created = 0;
  #completed = 0;
  #expired = 0;
  #rejected = 0;
  #released = 0;

  constructor(options: RuntimeDeadlineLedgerOptions = {}) {
    this.#maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 'maxEntries', HARD_MAX_ENTRIES);
    this.#maxTimeoutMs = Math.min(
      finiteNonNegative(options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS, 'maxTimeoutMs'),
      HARD_MAX_TIMEOUT_MS,
    );
    if (this.#maxTimeoutMs === 0) throw new RangeError('maxTimeoutMs must be greater than zero');
    this.#maxHistory = positiveInteger(options.maxHistory ?? DEFAULT_MAX_HISTORY, 'maxHistory', HARD_MAX_HISTORY);
  }

  create(request: RuntimeDeadlineRequest): RuntimeDeadlineLease | null {
    const nowMs = this.#observeNow(request.nowMs);
    const key = request.key.trim();
    if (!key) throw new TypeError('key must not be empty');
    if (!lanes.includes(request.lane)) throw new TypeError('lane is invalid');
    if (this.#entries.has(key)) {
      this.#rejected += 1;
      return null;
    }
    this.sweep(nowMs);
    if (this.#entries.size >= this.#maxEntries) {
      this.#rejected += 1;
      return null;
    }

    const requestedTimeout = Math.min(finiteNonNegative(request.timeoutMs, 'timeoutMs'), this.#maxTimeoutMs);
    if (requestedTimeout === 0) {
      this.#rejected += 1;
      return null;
    }
    const localDeadline = nowMs + requestedTimeout;
    if (!Number.isFinite(localDeadline)) throw new RangeError('effective deadline is not finite');
    const parentDeadline = request.parentDeadlineMs === undefined
      ? Number.POSITIVE_INFINITY
      : finiteNonNegative(request.parentDeadlineMs, 'parentDeadlineMs');
    const deadlineMs = Math.min(localDeadline, parentDeadline);
    if (deadlineMs <= nowMs) {
      this.#rejected += 1;
      return null;
    }

    const entry: Entry = {
      key,
      lane: request.lane,
      createdAtMs: nowMs,
      deadlineMs,
      timeoutMs: deadlineMs - nowMs,
      settled: false,
    };
    this.#entries.set(key, entry);
    this.#created += 1;
    return this.#lease(entry);
  }

  get(key: string, nowMs: number): RuntimeDeadlineLease | null {
    const now = this.#observeNow(nowMs);
    const entry = this.#entries.get(key);
    if (!entry || entry.settled) return null;
    if (now >= entry.deadlineMs) {
      this.#settle(entry, now, 'expired');
      return null;
    }
    return this.#lease(entry);
  }

  release(key: string, nowMs: number): boolean {
    const now = this.#observeNow(nowMs);
    const entry = this.#entries.get(key);
    if (!entry || entry.settled) return false;
    this.#settle(entry, now, now >= entry.deadlineMs ? 'expired' : 'released');
    return true;
  }

  sweep(nowMs: number): number {
    const now = this.#observeNow(nowMs);
    let count = 0;
    for (const entry of [...this.#entries.values()]) {
      if (!entry.settled && now >= entry.deadlineMs) {
        this.#settle(entry, now, 'expired');
        count += 1;
      }
    }
    return count;
  }

  snapshot(): RuntimeDeadlineSnapshot {
    const byLane: Record<RuntimeDeadlineLane, number> = { critical: 0, interactive: 0, background: 0 };
    for (const entry of this.#entries.values()) byLane[entry.lane] += 1;
    return Object.freeze({
      active: this.#entries.size,
      created: this.#created,
      completed: this.#completed,
      expired: this.#expired,
      rejected: this.#rejected,
      released: this.#released,
      lastNowMs: this.#lastNowMs,
      byLane: Object.freeze(byLane),
      history: immutableHistory(this.#history),
    });
  }

  #lease(entry: Entry): RuntimeDeadlineLease {
    return Object.freeze({
      key: entry.key,
      lane: entry.lane,
      createdAtMs: entry.createdAtMs,
      deadlineMs: entry.deadlineMs,
      timeoutMs: entry.timeoutMs,
      remainingMs: (nowMs: number): number => {
        const now = this.#observeNow(nowMs);
        return Math.max(0, entry.deadlineMs - now);
      },
      expired: (nowMs: number): boolean => this.#observeNow(nowMs) >= entry.deadlineMs,
      complete: (nowMs: number): boolean => {
        const now = this.#observeNow(nowMs);
        if (entry.settled || !this.#entries.has(entry.key)) return false;
        this.#settle(entry, now, now >= entry.deadlineMs ? 'expired' : 'completed');
        return true;
      },
    });
  }

  #observeNow(nowMs: number): number {
    finiteNonNegative(nowMs, 'nowMs');
    if (this.#lastNowMs !== null && nowMs < this.#lastNowMs) throw new RangeError('nowMs must be monotonic');
    this.#lastNowMs = nowMs;
    return nowMs;
  }

  #settle(entry: Entry, nowMs: number, outcome: RuntimeDeadlineHistoryEntry['outcome']): void {
    if (entry.settled) return;
    entry.settled = true;
    this.#entries.delete(entry.key);
    if (outcome === 'completed') this.#completed += 1;
    else if (outcome === 'expired') this.#expired += 1;
    else this.#released += 1;
    this.#history.push(Object.freeze({
      key: entry.key,
      lane: entry.lane,
      outcome,
      createdAtMs: entry.createdAtMs,
      finishedAtMs: nowMs,
      deadlineMs: entry.deadlineMs,
    }));
    if (this.#history.length > this.#maxHistory) this.#history.splice(0, this.#history.length - this.#maxHistory);
  }
}
