export type MutationIdempotencyEntryState =
  | 'in-flight'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type MutationIdempotencyEventKind =
  | 'admitted'
  | 'attempt'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'pruned'
  | 'disposed'
  | 'observer-failed';

export interface MutationIdempotencyRegistryOptions {
  readonly maxEntries?: number;
  readonly maxEntriesPerOwner?: number;
  readonly maxAttempts?: number;
  readonly retentionMs?: number;
  readonly staleInFlightAfterMs?: number;
  readonly maxKeyLength?: number;
  readonly maxOwnerLength?: number;
  readonly historyLimit?: number;
  readonly clock?: () => number;
  readonly onEvent?: (event: MutationIdempotencyEvent) => void;
}

export interface MutationIdempotencyBeginRequest {
  readonly key: string;
  readonly owner: string;
  readonly method: string;
  readonly signal?: AbortSignal;
}

export interface MutationIdempotencyEvent {
  readonly sequence: number;
  readonly at: number;
  readonly kind: MutationIdempotencyEventKind;
  readonly owner?: string;
  readonly method?: string;
  readonly state?: MutationIdempotencyEntryState;
  readonly errorName?: string;
  readonly ageMs?: number;
}

export interface MutationIdempotencyHistoryEntry {
  readonly owner: string;
  readonly method: string;
  readonly state: Exclude<MutationIdempotencyEntryState, 'in-flight'>;
  readonly startedAt: number;
  readonly settledAt: number;
  readonly durationMs: number;
  readonly logicalAttempts: number;
  readonly errorName?: string;
}

export interface MutationIdempotencyCounters {
  readonly admitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly inFlightConflicts: number;
  readonly retainedConflicts: number;
  readonly pruned: number;
  readonly observerFailures: number;
}

export interface MutationIdempotencyRegistrySnapshot {
  readonly disposed: boolean;
  readonly limits: Readonly<{
    readonly maxEntries: number;
    readonly maxEntriesPerOwner: number;
    readonly maxAttempts: number;
    readonly retentionMs: number;
    readonly staleInFlightAfterMs: number;
  }>;
  readonly entries: number;
  readonly inFlight: number;
  readonly retained: number;
  readonly owners: number;
  readonly staleInFlight: number;
  readonly oldestInFlightAgeMs: number;
  readonly counters: MutationIdempotencyCounters;
  readonly history: readonly MutationIdempotencyHistoryEntry[];
}

export interface MutationIdempotencyLeaseSnapshot {
  readonly owner: string;
  readonly method: string;
  readonly state: MutationIdempotencyEntryState;
  readonly startedAt: number;
  readonly logicalAttempts: number;
  readonly ageMs: number;
}

export interface MutationIdempotencyLease {
  readonly owner: string;
  readonly method: string;
  readonly state: MutationIdempotencyEntryState;
  readonly markAttempt: () => boolean;
  readonly complete: () => boolean;
  readonly fail: (reason?: unknown) => boolean;
  readonly cancel: (reason?: unknown) => boolean;
  readonly snapshot: () => MutationIdempotencyLeaseSnapshot;
}

export interface MutationIdempotencyRegistry {
  readonly begin: (request: MutationIdempotencyBeginRequest) => MutationIdempotencyLease;
  readonly snapshot: () => MutationIdempotencyRegistrySnapshot;
  readonly prune: () => number;
  readonly dispose: (reason?: unknown) => void;
}

export class MutationIdempotencyError extends Error {
  constructor(
    readonly code:
      | 'INVALID_IDEMPOTENCY_KEY'
      | 'INVALID_OWNER'
      | 'INVALID_METHOD'
      | 'REGISTRY_DISPOSED'
      | 'REGISTRY_CAPACITY_EXCEEDED'
      | 'OWNER_CAPACITY_EXCEEDED'
      | 'IDEMPOTENCY_KEY_IN_FLIGHT'
      | 'IDEMPOTENCY_KEY_REUSED'
      | 'MUTATION_ABORTED'
      | 'ATTEMPT_LIMIT_EXCEEDED'
      | 'INVALID_CLOCK',
    message: string,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'MutationIdempotencyError';
  }
}

interface MutableEntry {
  readonly key: string;
  readonly owner: string;
  readonly method: string;
  readonly startedAt: number;
  state: MutationIdempotencyEntryState;
  logicalAttempts: number;
  settledAt: number | null;
  expiresAt: number | null;
  errorName: string | undefined;
}

interface MutableCounters {
  admitted: number;
  completed: number;
  failed: number;
  cancelled: number;
  rejected: number;
  inFlightConflicts: number;
  retainedConflicts: number;
  pruned: number;
  observerFailures: number;
}

const DEFAULTS = Object.freeze({
  maxEntries: 512,
  maxEntriesPerOwner: 64,
  maxAttempts: 5,
  retentionMs: 5 * 60_000,
  staleInFlightAfterMs: 2 * 60_000,
  maxKeyLength: 128,
  maxOwnerLength: 160,
  historyLimit: 256,
});

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const METHOD_PATTERN = /^[a-z]+$/;
const CONTROL_CHARACTER_LIMIT = 0x1f;
const DELETE_CHARACTER = 0x7f;

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= CONTROL_CHARACTER_LIMIT || code === DELETE_CHARACTER) return true;
  }
  return false;
};

const boundedInteger = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MutationIdempotencyError(
      'INVALID_CLOCK',
      name + ' must be an integer between ' + minimum + ' and ' + maximum,
    );
  }
  return value;
};

const normalizeKey = (value: unknown, maximum: number): string => {
  if (typeof value !== 'string') {
    throw new MutationIdempotencyError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency key must be a string.',
    );
  }
  const normalized = value.trim();
  if (
    normalized.length < 8
    || normalized.length > maximum
    || !IDEMPOTENCY_KEY_PATTERN.test(normalized)
  ) {
    throw new MutationIdempotencyError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency key must contain 8-' + maximum + ' safe ASCII characters.',
    );
  }
  return normalized;
};

const normalizeOwner = (value: unknown, maximum: number): string => {
  if (typeof value !== 'string') {
    throw new MutationIdempotencyError('INVALID_OWNER', 'Mutation owner must be a string.');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || hasControlCharacter(normalized)) {
    throw new MutationIdempotencyError(
      'INVALID_OWNER',
      'Mutation owner must contain bounded printable text.',
    );
  }
  return normalized;
};

const normalizeMethod = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new MutationIdempotencyError('INVALID_METHOD', 'Mutation method must be a string.');
  }
  const normalized = value.trim().toLowerCase();
  if (!METHOD_PATTERN.test(normalized) || normalized.length > 16) {
    throw new MutationIdempotencyError(
      'INVALID_METHOD',
      'Mutation method must contain bounded alphabetic text.',
    );
  }
  return normalized;
};

const safeErrorName = (reason: unknown): string | undefined => {
  if (reason === undefined || reason === null) return undefined;
  if (reason instanceof Error && reason.name.trim()) return reason.name.slice(0, 80);
  if (
    typeof reason === 'object'
    && reason !== null
    && 'name' in reason
    && typeof (reason as { name?: unknown }).name === 'string'
  ) {
    const name = String((reason as { name: string }).name).trim();
    return name ? name.slice(0, 80) : 'UnknownError';
  }
  return 'UnknownError';
};

const freezeCounters = (counters: MutableCounters): MutationIdempotencyCounters =>
  Object.freeze({
    admitted: counters.admitted,
    completed: counters.completed,
    failed: counters.failed,
    cancelled: counters.cancelled,
    rejected: counters.rejected,
    inFlightConflicts: counters.inFlightConflicts,
    retainedConflicts: counters.retainedConflicts,
    pruned: counters.pruned,
    observerFailures: counters.observerFailures,
  });

class BoundedMutationIdempotencyRegistry implements MutationIdempotencyRegistry {
  readonly #maxEntries: number;
  readonly #maxEntriesPerOwner: number;
  readonly #maxAttempts: number;
  readonly #retentionMs: number;
  readonly #staleInFlightAfterMs: number;
  readonly #maxKeyLength: number;
  readonly #maxOwnerLength: number;
  readonly #historyLimit: number;
  readonly #clock: () => number;
  readonly #onEvent: ((event: MutationIdempotencyEvent) => void) | undefined;
  readonly #entries = new Map<string, MutableEntry>();
  readonly #ownerCounts = new Map<string, number>();
  readonly #history: MutationIdempotencyHistoryEntry[] = [];
  readonly #counters: MutableCounters = {
    admitted: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    rejected: 0,
    inFlightConflicts: 0,
    retainedConflicts: 0,
    pruned: 0,
    observerFailures: 0,
  };

  #eventSequence = 0;
  #disposed = false;
  #lastObservedAt: number | undefined;

  constructor(options: MutationIdempotencyRegistryOptions = {}) {
    this.#maxEntries = boundedInteger(
      'maxEntries',
      options.maxEntries ?? DEFAULTS.maxEntries,
      1,
      10_000,
    );
    this.#maxEntriesPerOwner = boundedInteger(
      'maxEntriesPerOwner',
      options.maxEntriesPerOwner ?? DEFAULTS.maxEntriesPerOwner,
      1,
      this.#maxEntries,
    );
    this.#maxAttempts = boundedInteger(
      'maxAttempts',
      options.maxAttempts ?? DEFAULTS.maxAttempts,
      1,
      32,
    );
    this.#retentionMs = boundedInteger(
      'retentionMs',
      options.retentionMs ?? DEFAULTS.retentionMs,
      1_000,
      24 * 60 * 60_000,
    );
    this.#staleInFlightAfterMs = boundedInteger(
      'staleInFlightAfterMs',
      options.staleInFlightAfterMs ?? DEFAULTS.staleInFlightAfterMs,
      1_000,
      24 * 60 * 60_000,
    );
    this.#maxKeyLength = boundedInteger(
      'maxKeyLength',
      options.maxKeyLength ?? DEFAULTS.maxKeyLength,
      16,
      512,
    );
    this.#maxOwnerLength = boundedInteger(
      'maxOwnerLength',
      options.maxOwnerLength ?? DEFAULTS.maxOwnerLength,
      16,
      512,
    );
    this.#historyLimit = boundedInteger(
      'historyLimit',
      options.historyLimit ?? DEFAULTS.historyLimit,
      0,
      4_096,
    );
    this.#clock = options.clock ?? Date.now;
    this.#onEvent = options.onEvent;
  }

  begin(request: MutationIdempotencyBeginRequest): MutationIdempotencyLease {
    this.#assertUsable();
    const now = this.#now();
    this.#pruneAt(now);

    if (request.signal?.aborted) {
      this.#reject('MUTATION_ABORTED', 'Mutation was aborted before idempotency admission.', request.signal.reason);
    }

    const key = normalizeKey(request.key, this.#maxKeyLength);
    const owner = normalizeOwner(request.owner, this.#maxOwnerLength);
    const method = normalizeMethod(request.method);
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.state === 'in-flight') {
        this.#counters.inFlightConflicts += 1;
        this.#reject(
          'IDEMPOTENCY_KEY_IN_FLIGHT',
          'Idempotency key is already executing.',
        );
      }
      this.#counters.retainedConflicts += 1;
      this.#reject(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency key was already consumed within the retention window.',
      );
    }

    if (this.#entries.size >= this.#maxEntries) {
      this.#reject(
        'REGISTRY_CAPACITY_EXCEEDED',
        'Mutation idempotency registry capacity is exhausted.',
      );
    }

    const ownerCount = this.#ownerCounts.get(owner) ?? 0;
    if (ownerCount >= this.#maxEntriesPerOwner) {
      this.#reject(
        'OWNER_CAPACITY_EXCEEDED',
        'Mutation idempotency owner capacity is exhausted.',
      );
    }

    const entry: MutableEntry = {
      key,
      owner,
      method,
      startedAt: now,
      state: 'in-flight',
      logicalAttempts: 0,
      settledAt: null,
      expiresAt: null,
      errorName: undefined,
    };
    this.#entries.set(key, entry);
    this.#ownerCounts.set(owner, ownerCount + 1);
    this.#counters.admitted += 1;
    this.#emit({
      kind: 'admitted',
      owner,
      method,
      state: 'in-flight',
    });

    return this.#createLease(entry);
  }

  snapshot(): MutationIdempotencyRegistrySnapshot {
    const now = this.#now();
    this.#pruneAt(now);
    let inFlight = 0;
    let retained = 0;
    let staleInFlight = 0;
    let oldestInFlightAgeMs = 0;

    for (const entry of this.#entries.values()) {
      if (entry.state === 'in-flight') {
        inFlight += 1;
        const ageMs = Math.max(0, now - entry.startedAt);
        oldestInFlightAgeMs = Math.max(oldestInFlightAgeMs, ageMs);
        if (ageMs >= this.#staleInFlightAfterMs) staleInFlight += 1;
      } else {
        retained += 1;
      }
    }

    return Object.freeze({
      disposed: this.#disposed,
      limits: Object.freeze({
        maxEntries: this.#maxEntries,
        maxEntriesPerOwner: this.#maxEntriesPerOwner,
        maxAttempts: this.#maxAttempts,
        retentionMs: this.#retentionMs,
        staleInFlightAfterMs: this.#staleInFlightAfterMs,
      }),
      entries: this.#entries.size,
      inFlight,
      retained,
      owners: this.#ownerCounts.size,
      staleInFlight,
      oldestInFlightAgeMs,
      counters: freezeCounters(this.#counters),
      history: Object.freeze(this.#history.slice()),
    });
  }

  prune(): number {
    return this.#pruneAt(this.#now());
  }

  dispose(reason?: unknown): void {
    if (this.#disposed) return;
    const now = this.#now();
    for (const entry of this.#entries.values()) {
      if (entry.state === 'in-flight') {
        this.#settle(entry, 'cancelled', reason, now);
      }
    }
    this.#entries.clear();
    this.#ownerCounts.clear();
    this.#disposed = true;
    this.#emit({
      kind: 'disposed',
      errorName: safeErrorName(reason),
    });
  }

  #createLease(entry: MutableEntry): MutationIdempotencyLease {
    const registry = this;
    return Object.freeze({
      owner: entry.owner,
      method: entry.method,
      get state() {
        return entry.state;
      },
      markAttempt: () => {
        if (entry.state !== 'in-flight') return false;
        if (entry.logicalAttempts >= registry.#maxAttempts) {
          registry.#reject(
            'ATTEMPT_LIMIT_EXCEEDED',
            'Mutation attempt limit is exhausted.',
          );
        }
        entry.logicalAttempts += 1;
        registry.#emit({
          kind: 'attempt',
          owner: entry.owner,
          method: entry.method,
          state: entry.state,
        });
        return true;
      },
      complete: () => registry.#settle(entry, 'completed'),
      fail: (reason?: unknown) => registry.#settle(entry, 'failed', reason),
      cancel: (reason?: unknown) => registry.#settle(entry, 'cancelled', reason),
      snapshot: () => registry.#leaseSnapshot(entry),
    });
  }

  #leaseSnapshot(entry: MutableEntry): MutationIdempotencyLeaseSnapshot {
    return Object.freeze({
      owner: entry.owner,
      method: entry.method,
      state: entry.state,
      startedAt: entry.startedAt,
      logicalAttempts: entry.logicalAttempts,
      ageMs: Math.max(0, this.#now() - entry.startedAt),
    });
  }

  #settle(
    entry: MutableEntry,
    state: Exclude<MutationIdempotencyEntryState, 'in-flight'>,
    reason?: unknown,
    explicitNow?: number,
  ): boolean {
    if (entry.state !== 'in-flight') return false;
    const now = explicitNow ?? this.#now();
    entry.state = state;
    entry.settledAt = now;
    entry.expiresAt = now + this.#retentionMs;
    entry.errorName = state === 'failed' || state === 'cancelled'
      ? safeErrorName(reason)
      : undefined;

    if (state === 'completed') this.#counters.completed += 1;
    else if (state === 'failed') this.#counters.failed += 1;
    else this.#counters.cancelled += 1;

    this.#recordHistory(entry);
    this.#emit({
      kind: state,
      owner: entry.owner,
      method: entry.method,
      state,
      ...(entry.errorName ? { errorName: entry.errorName } : {}),
      ageMs: Math.max(0, now - entry.startedAt),
    });
    return true;
  }

  #recordHistory(entry: MutableEntry): void {
    if (this.#historyLimit === 0 || entry.settledAt === null || entry.state === 'in-flight') return;
    this.#history.push(Object.freeze({
      owner: entry.owner,
      method: entry.method,
      state: entry.state,
      startedAt: entry.startedAt,
      settledAt: entry.settledAt,
      durationMs: Math.max(0, entry.settledAt - entry.startedAt),
      logicalAttempts: entry.logicalAttempts,
      ...(entry.errorName ? { errorName: entry.errorName } : {}),
    }));
    const overflow = this.#history.length - this.#historyLimit;
    if (overflow > 0) this.#history.splice(0, overflow);
  }

  #pruneAt(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (
        entry.state === 'in-flight'
        || entry.expiresAt === null
        || entry.expiresAt > now
      ) {
        continue;
      }
      this.#entries.delete(key);
      this.#decrementOwner(entry.owner);
      removed += 1;
      this.#counters.pruned += 1;
      this.#emit({
        kind: 'pruned',
        owner: entry.owner,
        method: entry.method,
        state: entry.state,
        ageMs: Math.max(0, now - entry.startedAt),
      });
    }
    return removed;
  }

  #decrementOwner(owner: string): void {
    const count = (this.#ownerCounts.get(owner) ?? 1) - 1;
    if (count <= 0) this.#ownerCounts.delete(owner);
    else this.#ownerCounts.set(owner, count);
  }

  #assertUsable(): void {
    if (this.#disposed) {
      this.#reject('REGISTRY_DISPOSED', 'Mutation idempotency registry is disposed.');
    }
  }

  #reject(
    code: MutationIdempotencyError['code'],
    message: string,
    reason?: unknown,
  ): never {
    this.#counters.rejected += 1;
    this.#emit({
      kind: 'rejected',
      errorName: safeErrorName(reason),
    });
    throw new MutationIdempotencyError(code, message, reason);
  }

  #emit(event: Omit<MutationIdempotencyEvent, 'sequence' | 'at'>): void {
    if (!this.#onEvent) return;
    const payload = Object.freeze({
      sequence: ++this.#eventSequence,
      at: this.#now(),
      ...event,
    });
    try {
      this.#onEvent(payload);
    } catch {
      this.#counters.observerFailures += 1;
      if (event.kind === 'observer-failed') return;
      // Observer failures are intentionally contained. A second observer call
      // would recurse, so the failure is represented only in counters.
    }
  }

  #now(): number {
    const value = Number(this.#clock());
    if (!Number.isFinite(value) || value < 0) {
      throw new MutationIdempotencyError(
        'INVALID_CLOCK',
        'Mutation idempotency clock returned an invalid timestamp.',
      );
    }
    if (this.#lastObservedAt !== undefined && value < this.#lastObservedAt) {
      throw new MutationIdempotencyError(
        'INVALID_CLOCK',
        'Mutation idempotency clock must be monotonic.',
      );
    }
    this.#lastObservedAt = value;
    return value;
  }
}

export const createMutationIdempotencyRegistry = (
  options: MutationIdempotencyRegistryOptions = {},
): MutationIdempotencyRegistry => new BoundedMutationIdempotencyRegistry(options);
