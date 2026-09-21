import {
  createResourceScope,
  ResourceScopeError,
  type ResourceScope,
  type ResourceScopeOptions,
  type ResourceScopeSnapshot,
} from './resourceScope';

export interface ResourceScopeRegistryClock {
  readonly now: () => number;
}

export interface ResourceScopeRegistryPolicy {
  readonly maxScopes: number;
  readonly maxOwnerScopes: number;
  readonly historyLimit: number;
  readonly staleAfterMs: number;
}

export interface ResourceScopeCreateRequest {
  readonly name: string;
  readonly owner: string;
  readonly scopeOptions?: ResourceScopeOptions;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ResourceScopeRegistryEntry {
  readonly name: string;
  readonly owner: string;
  readonly createdAt: number;
  readonly ageMs: number;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly scope: ResourceScopeSnapshot;
}

export interface ResourceScopeRegistryHistoryEntry {
  readonly name: string;
  readonly owner: string;
  readonly createdAt: number;
  readonly closedAt: number;
  readonly lifetimeMs: number;
  readonly reason: string;
  readonly cleanupFailed: boolean;
}

export interface ResourceScopeRegistrySnapshot {
  readonly disposed: boolean;
  readonly activeScopes: number;
  readonly activeOwners: number;
  readonly created: number;
  readonly closed: number;
  readonly rejected: number;
  readonly cleanupFailures: number;
  readonly staleScopes: number;
  readonly entries: readonly ResourceScopeRegistryEntry[];
  readonly history: readonly ResourceScopeRegistryHistoryEntry[];
}

export interface ResourceScopeRegistryStaleEntry {
  readonly name: string;
  readonly owner: string;
  readonly createdAt: number;
  readonly ageMs: number;
  readonly activeResources: number;
  readonly childScopes: number;
}

export interface ResourceScopeRegistry {
  readonly create: (request: ResourceScopeCreateRequest) => ResourceScope;
  readonly get: (name: string) => ResourceScope | undefined;
  readonly has: (name: string) => boolean;
  readonly close: (name: string, reason?: unknown) => Promise<boolean>;
  readonly closeOwner: (owner: string, reason?: unknown) => Promise<number>;
  readonly closeAll: (reason?: unknown) => Promise<number>;
  readonly stale: (minimumAgeMs?: number) => readonly ResourceScopeRegistryStaleEntry[];
  readonly snapshot: () => ResourceScopeRegistrySnapshot;
  readonly dispose: (reason?: unknown) => Promise<void>;
}

export class ResourceScopeRegistryError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'REGISTRY_DISPOSED'
      | 'DUPLICATE_SCOPE'
      | 'SCOPE_CAPACITY_EXCEEDED'
      | 'OWNER_CAPACITY_EXCEEDED'
      | 'SCOPE_CLOSE_FAILED',
    message: string,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'ResourceScopeRegistryError';
  }
}

interface RegistryRecord {
  readonly name: string;
  readonly owner: string;
  readonly createdAt: number;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly scope: ResourceScope;
  closing: boolean;
}

interface MutableRegistryCounters {
  created: number;
  closed: number;
  rejected: number;
  cleanupFailures: number;
}

const SYSTEM_CLOCK: ResourceScopeRegistryClock = Object.freeze({
  now: () => Date.now(),
});

const DEFAULT_POLICY: ResourceScopeRegistryPolicy = Object.freeze({
  maxScopes: 128,
  maxOwnerScopes: 24,
  historyLimit: 256,
  staleAfterMs: 15 * 60_000,
});

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key|session|credential/i;

const positiveInteger = (
  name: string,
  value: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ResourceScopeRegistryError(
      'INVALID_REQUEST',
      name + ' must be a positive integer no greater than ' + maximum,
    );
  }
  return value;
};

const text = (name: string, value: string, maximum = 160): string => {
  if (typeof value !== 'string') {
    throw new ResourceScopeRegistryError('INVALID_REQUEST', name + ' must be a string');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new ResourceScopeRegistryError(
      'INVALID_REQUEST',
      name + ' must contain 1-' + maximum + ' characters',
    );
  }
  if (hasControlCharacter(normalized)) {
    throw new ResourceScopeRegistryError(
      'INVALID_REQUEST',
      name + ' cannot contain control characters',
    );
  }
  return normalized;
};

const safeReason = (reason: unknown): string => {
  if (reason instanceof ResourceScopeError) return reason.code.toLowerCase();
  if (reason instanceof ResourceScopeRegistryError) return reason.code.toLowerCase();
  if (reason instanceof Error && reason.name) return reason.name.slice(0, 80);
  if (typeof reason === 'string') {
    const normalized = reason.replace(/[\r\n\t]/g, ' ').trim();
    return normalized ? normalized.slice(0, 80) : 'unspecified';
  }
  return reason === undefined ? 'unspecified' : 'external';
};

const sanitizeMetadata = (
  metadata?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean | null>> => {
  if (!metadata) return Object.freeze({});
  const result: Record<string, string | number | boolean | null> = {};
  for (const [rawKey, rawValue] of Object.entries(metadata).slice(0, 16)) {
    const key = text('metadata key', rawKey, 80);
    if (SENSITIVE_KEY.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    if (rawValue === null || typeof rawValue === 'boolean') {
      result[key] = rawValue;
      continue;
    }
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      result[key] = rawValue;
      continue;
    }
    if (typeof rawValue === 'string') {
      result[key] = rawValue.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
    }
  }
  return Object.freeze(result);
};

class BoundedResourceScopeRegistry implements ResourceScopeRegistry {
  readonly #clock: ResourceScopeRegistryClock;
  readonly #policy: ResourceScopeRegistryPolicy;
  readonly #records = new Map<string, RegistryRecord>();
  readonly #ownerCounts = new Map<string, number>();
  readonly #history: ResourceScopeRegistryHistoryEntry[] = [];
  readonly #counters: MutableRegistryCounters = {
    created: 0,
    closed: 0,
    rejected: 0,
    cleanupFailures: 0,
  };

  #disposed = false;
  #lastObservedAt: number | undefined;

  constructor(
    policy: Partial<ResourceScopeRegistryPolicy> = {},
    clock: ResourceScopeRegistryClock = SYSTEM_CLOCK,
  ) {
    this.#clock = clock;
    this.#policy = Object.freeze({
      maxScopes: positiveInteger('maxScopes', policy.maxScopes ?? DEFAULT_POLICY.maxScopes, 10_000),
      maxOwnerScopes: positiveInteger(
        'maxOwnerScopes',
        policy.maxOwnerScopes ?? DEFAULT_POLICY.maxOwnerScopes,
        1_000,
      ),
      historyLimit: positiveInteger(
        'historyLimit',
        policy.historyLimit ?? DEFAULT_POLICY.historyLimit,
        4_096,
      ),
      staleAfterMs: positiveInteger(
        'staleAfterMs',
        policy.staleAfterMs ?? DEFAULT_POLICY.staleAfterMs,
        24 * 60 * 60_000,
      ),
    });
    if (this.#policy.maxOwnerScopes > this.#policy.maxScopes) {
      throw new ResourceScopeRegistryError(
        'INVALID_REQUEST',
        'maxOwnerScopes cannot exceed maxScopes',
      );
    }
  }

  create(request: ResourceScopeCreateRequest): ResourceScope {
    this.#assertUsable();
    this.#sweepTerminal();
    const name = text('scope name', request.name, 120);
    const owner = text('owner', request.owner, 160);
    if (this.#records.has(name)) {
      this.#counters.rejected += 1;
      throw new ResourceScopeRegistryError(
        'DUPLICATE_SCOPE',
        'Resource scope already exists: ' + name,
      );
    }
    if (this.#records.size >= this.#policy.maxScopes) {
      this.#counters.rejected += 1;
      throw new ResourceScopeRegistryError(
        'SCOPE_CAPACITY_EXCEEDED',
        'Resource scope registry capacity is exhausted.',
      );
    }
    const ownerCount = this.#ownerCounts.get(owner) ?? 0;
    if (ownerCount >= this.#policy.maxOwnerScopes) {
      this.#counters.rejected += 1;
      throw new ResourceScopeRegistryError(
        'OWNER_CAPACITY_EXCEEDED',
        'Resource scope owner capacity is exhausted for ' + owner + '.',
      );
    }

    const scope = createResourceScope(name, request.scopeOptions);
    const record: RegistryRecord = {
      name,
      owner,
      createdAt: this.#now(),
      metadata: sanitizeMetadata(request.metadata),
      scope,
      closing: false,
    };
    this.#records.set(name, record);
    this.#ownerCounts.set(owner, ownerCount + 1);
    this.#counters.created += 1;
    return scope;
  }

  get(name: string): ResourceScope | undefined {
    this.#assertUsable();
    this.#sweepTerminal();
    return this.#records.get(text('scope name', name, 120))?.scope;
  }

  has(name: string): boolean {
    this.#assertUsable();
    this.#sweepTerminal();
    return this.#records.has(text('scope name', name, 120));
  }

  async close(name: string, reason: unknown = 'registry-close'): Promise<boolean> {
    this.#assertUsable();
    this.#sweepTerminal();
    const normalizedName = text('scope name', name, 120);
    const record = this.#records.get(normalizedName);
    if (!record || record.closing) return false;
    record.closing = true;

    let cleanupFailed = false;
    try {
      await record.scope.close({ reason, throwOnCleanupError: true });
      return true;
    } catch (error) {
      cleanupFailed = true;
      this.#counters.cleanupFailures += 1;
      throw new ResourceScopeRegistryError(
        'SCOPE_CLOSE_FAILED',
        'Resource scope failed cleanup: ' + normalizedName,
        error,
      );
    } finally {
      this.#completeRecord(record, reason, cleanupFailed);
    }
  }

  async closeOwner(owner: string, reason: unknown = 'owner-close'): Promise<number> {
    this.#assertUsable();
    this.#sweepTerminal();
    const normalizedOwner = text('owner', owner, 160);
    const names = [...this.#records.values()]
      .filter((record) => record.owner === normalizedOwner)
      .sort((left, right) => right.createdAt - left.createdAt || right.name.localeCompare(left.name))
      .map((record) => record.name);

    const failures: unknown[] = [];
    let closed = 0;
    for (const name of names) {
      try {
        if (await this.close(name, reason)) closed += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more owner scopes failed cleanup.');
    }
    return closed;
  }

  async closeAll(reason: unknown = 'registry-close-all'): Promise<number> {
    this.#assertUsable();
    this.#sweepTerminal();
    const names = [...this.#records.values()]
      .sort((left, right) => right.createdAt - left.createdAt || right.name.localeCompare(left.name))
      .map((record) => record.name);

    const failures: unknown[] = [];
    let closed = 0;
    for (const name of names) {
      try {
        if (await this.close(name, reason)) closed += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more resource scopes failed cleanup.');
    }
    return closed;
  }

  stale(minimumAgeMs = this.#policy.staleAfterMs): readonly ResourceScopeRegistryStaleEntry[] {
    this.#assertUsable();
    this.#sweepTerminal();
    const ageThreshold = positiveInteger('minimumAgeMs', minimumAgeMs, 24 * 60 * 60_000);
    const now = this.#now();
    return Object.freeze(
      [...this.#records.values()]
        .map((record) => {
          const snapshot = record.scope.snapshot();
          return Object.freeze({
            name: record.name,
            owner: record.owner,
            createdAt: record.createdAt,
            ageMs: Math.max(0, now - record.createdAt),
            activeResources: snapshot.activeResources,
            childScopes: snapshot.childScopes,
          });
        })
        .filter((entry) => entry.ageMs >= ageThreshold)
        .sort((left, right) => right.ageMs - left.ageMs || left.name.localeCompare(right.name)),
    );
  }

  snapshot(): ResourceScopeRegistrySnapshot {
    if (!this.#disposed) this.#sweepTerminal();
    const now = this.#now();
    const entries = [...this.#records.values()]
      .map((record) => Object.freeze({
        name: record.name,
        owner: record.owner,
        createdAt: record.createdAt,
        ageMs: Math.max(0, now - record.createdAt),
        metadata: record.metadata,
        scope: record.scope.snapshot(),
      }))
      .sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name));
    const staleScopes = entries.filter((entry) => entry.ageMs >= this.#policy.staleAfterMs).length;
    return Object.freeze({
      disposed: this.#disposed,
      activeScopes: entries.length,
      activeOwners: this.#ownerCounts.size,
      created: this.#counters.created,
      closed: this.#counters.closed,
      rejected: this.#counters.rejected,
      cleanupFailures: this.#counters.cleanupFailures,
      staleScopes,
      entries: Object.freeze(entries),
      history: Object.freeze(this.#history.slice()),
    });
  }

  async dispose(reason: unknown = 'registry-disposed'): Promise<void> {
    if (this.#disposed) return;
    const failures: unknown[] = [];
    try {
      const names = [...this.#records.keys()];
      for (const name of names) {
        try {
          await this.close(name, reason);
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      this.#disposed = true;
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Resource scope registry disposal had cleanup failures.');
    }
  }

  #completeRecord(record: RegistryRecord, reason: unknown, cleanupFailed: boolean): void {
    if (!this.#records.has(record.name)) return;
    this.#records.delete(record.name);
    const nextOwnerCount = (this.#ownerCounts.get(record.owner) ?? 1) - 1;
    if (nextOwnerCount <= 0) this.#ownerCounts.delete(record.owner);
    else this.#ownerCounts.set(record.owner, nextOwnerCount);
    const closedAt = this.#now();
    this.#history.push(Object.freeze({
      name: record.name,
      owner: record.owner,
      createdAt: record.createdAt,
      closedAt,
      lifetimeMs: Math.max(0, closedAt - record.createdAt),
      reason: safeReason(reason),
      cleanupFailed,
    }));
    const overflow = this.#history.length - this.#policy.historyLimit;
    if (overflow > 0) this.#history.splice(0, overflow);
    this.#counters.closed += 1;
  }

  #sweepTerminal(): void {
    for (const record of this.#records.values()) {
      if (record.closing) continue;
      if (record.scope.state === 'closed' || record.scope.state === 'disposed') {
        this.#completeRecord(record, 'scope-self-closed', false);
      }
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new ResourceScopeRegistryError(
        'REGISTRY_DISPOSED',
        'Resource scope registry is disposed.',
      );
    }
  }

  #now(): number {
    const value = this.#clock.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new ResourceScopeRegistryError('INVALID_REQUEST', 'clock returned an invalid timestamp');
    }
    if (this.#lastObservedAt !== undefined && value < this.#lastObservedAt) {
      throw new ResourceScopeRegistryError('INVALID_REQUEST', 'clock must be monotonic');
    }
    this.#lastObservedAt = value;
    return value;
  }
}

export const createResourceScopeRegistry = (
  policy: Partial<ResourceScopeRegistryPolicy> = {},
  clock?: ResourceScopeRegistryClock,
): ResourceScopeRegistry => new BoundedResourceScopeRegistry(policy, clock);
