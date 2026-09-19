export type ResourceLeaseId = string;
export type ResourceLeaseOwner = string;

export interface ResourceLeaseClock {
  now(): number;
}

export interface ResourceLeasePolicy {
  readonly maxActiveLeases: number;
  readonly maxLeaseMs: number;
  readonly maxOwnerLeases: number;
  readonly historyLimit: number;
}

export interface ResourceLeaseRequest {
  readonly id: ResourceLeaseId;
  readonly owner: ResourceLeaseOwner;
  readonly ttlMs: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ResourceLeaseSnapshot {
  readonly id: ResourceLeaseId;
  readonly owner: ResourceLeaseOwner;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export type ResourceLeaseReleaseReason =
  | 'released'
  | 'expired'
  | 'replaced'
  | 'registry-disposed';

export interface ResourceLeaseHistoryEntry extends ResourceLeaseSnapshot {
  readonly releasedAt: number;
  readonly reason: ResourceLeaseReleaseReason;
}

export interface ResourceLeaseRegistrySnapshot {
  readonly active: readonly ResourceLeaseSnapshot[];
  readonly history: readonly ResourceLeaseHistoryEntry[];
  readonly activeByOwner: Readonly<Record<string, number>>;
  readonly disposed: boolean;
}

export interface ResourceLeaseHandle {
  readonly id: ResourceLeaseId;
  readonly owner: ResourceLeaseOwner;
  snapshot(): ResourceLeaseSnapshot | undefined;
  renew(ttlMs: number): ResourceLeaseSnapshot;
  release(): boolean;
}

export class ResourceLeaseError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'CAPACITY_EXCEEDED'
      | 'OWNER_CAPACITY_EXCEEDED'
      | 'DUPLICATE_LEASE'
      | 'LEASE_NOT_FOUND'
      | 'REGISTRY_DISPOSED',
    message: string,
  ) {
    super(message);
    this.name = 'ResourceLeaseError';
  }
}

const DEFAULT_POLICY: ResourceLeasePolicy = Object.freeze({
  maxActiveLeases: 256,
  maxLeaseMs: 5 * 60_000,
  maxOwnerLeases: 32,
  historyLimit: 256,
});

const SYSTEM_CLOCK: ResourceLeaseClock = Object.freeze({
  now: () => Date.now(),
});

interface MutableLease {
  id: ResourceLeaseId;
  owner: ResourceLeaseOwner;
  acquiredAt: number;
  expiresAt: number;
  metadata: Readonly<Record<string, string | number | boolean>>;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ResourceLeaseError('INVALID_REQUEST', `${name} must be a positive safe integer`);
  }
}

function normalizeText(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 160) {
    throw new ResourceLeaseError('INVALID_REQUEST', `${name} must contain 1-160 characters`);
  }
  return normalized;
}

function cloneMetadata(
  metadata: ResourceLeaseRequest['metadata'],
): Readonly<Record<string, string | number | boolean>> {
  if (!metadata) return Object.freeze({});
  const entries = Object.entries(metadata);
  if (entries.length > 24) {
    throw new ResourceLeaseError('INVALID_REQUEST', 'metadata may contain at most 24 entries');
  }
  const clone: Record<string, string | number | boolean> = {};
  for (const [rawKey, value] of entries) {
    const key = normalizeText(rawKey, 'metadata key');
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ResourceLeaseError('INVALID_REQUEST', `metadata ${key} must be finite`);
    }
    clone[key] = value;
  }
  return Object.freeze(clone);
}

function snapshotLease(lease: MutableLease): ResourceLeaseSnapshot {
  return Object.freeze({
    id: lease.id,
    owner: lease.owner,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    metadata: lease.metadata,
  });
}

export class ResourceLeaseRegistry {
  readonly #clock: ResourceLeaseClock;
  readonly #policy: ResourceLeasePolicy;
  readonly #active = new Map<ResourceLeaseId, MutableLease>();
  readonly #ownerCounts = new Map<ResourceLeaseOwner, number>();
  readonly #history: ResourceLeaseHistoryEntry[] = [];
  #disposed = false;

  constructor(
    policy: Partial<ResourceLeasePolicy> = {},
    clock: ResourceLeaseClock = SYSTEM_CLOCK,
  ) {
    this.#clock = clock;
    this.#policy = Object.freeze({ ...DEFAULT_POLICY, ...policy });
    assertPositiveInteger(this.#policy.maxActiveLeases, 'maxActiveLeases');
    assertPositiveInteger(this.#policy.maxLeaseMs, 'maxLeaseMs');
    assertPositiveInteger(this.#policy.maxOwnerLeases, 'maxOwnerLeases');
    assertPositiveInteger(this.#policy.historyLimit, 'historyLimit');
  }

  acquire(request: ResourceLeaseRequest): ResourceLeaseHandle {
    this.#assertUsable();
    this.sweepExpired();
    const id = normalizeText(request.id, 'id');
    const owner = normalizeText(request.owner, 'owner');
    const ttlMs = this.#normalizeTtl(request.ttlMs);
    if (this.#active.has(id)) {
      throw new ResourceLeaseError('DUPLICATE_LEASE', `lease ${id} already exists`);
    }
    if (this.#active.size >= this.#policy.maxActiveLeases) {
      throw new ResourceLeaseError('CAPACITY_EXCEEDED', 'resource lease capacity exceeded');
    }
    const ownerCount = this.#ownerCounts.get(owner) ?? 0;
    if (ownerCount >= this.#policy.maxOwnerLeases) {
      throw new ResourceLeaseError(
        'OWNER_CAPACITY_EXCEEDED',
        `resource lease capacity exceeded for owner ${owner}`,
      );
    }
    const now = this.#now();
    const lease: MutableLease = {
      id,
      owner,
      acquiredAt: now,
      expiresAt: now + ttlMs,
      metadata: cloneMetadata(request.metadata),
    };
    this.#active.set(id, lease);
    this.#ownerCounts.set(owner, ownerCount + 1);
    return this.#createHandle(id, owner);
  }

  replace(request: ResourceLeaseRequest): ResourceLeaseHandle {
    this.#assertUsable();
    const id = normalizeText(request.id, 'id');
    this.#release(id, 'replaced');
    return this.acquire({ ...request, id });
  }

  get(id: ResourceLeaseId): ResourceLeaseSnapshot | undefined {
    this.#assertUsable();
    this.sweepExpired();
    const lease = this.#active.get(id);
    return lease ? snapshotLease(lease) : undefined;
  }

  renew(id: ResourceLeaseId, ttlMs: number): ResourceLeaseSnapshot {
    this.#assertUsable();
    this.sweepExpired();
    const lease = this.#active.get(id);
    if (!lease) {
      throw new ResourceLeaseError('LEASE_NOT_FOUND', `lease ${id} does not exist`);
    }
    lease.expiresAt = this.#now() + this.#normalizeTtl(ttlMs);
    return snapshotLease(lease);
  }

  release(id: ResourceLeaseId): boolean {
    this.#assertUsable();
    return this.#release(id, 'released');
  }

  releaseOwner(owner: ResourceLeaseOwner): number {
    this.#assertUsable();
    const normalizedOwner = normalizeText(owner, 'owner');
    const ids = [...this.#active.values()]
      .filter((lease) => lease.owner === normalizedOwner)
      .map((lease) => lease.id);
    for (const id of ids) this.#release(id, 'released');
    return ids.length;
  }

  sweepExpired(): number {
    this.#assertUsable();
    const now = this.#now();
    const expired = [...this.#active.values()]
      .filter((lease) => lease.expiresAt <= now)
      .map((lease) => lease.id);
    for (const id of expired) this.#release(id, 'expired', now);
    return expired.length;
  }

  snapshot(): ResourceLeaseRegistrySnapshot {
    if (!this.#disposed) this.sweepExpired();
    const active = [...this.#active.values()]
      .map(snapshotLease)
      .sort((left, right) => left.expiresAt - right.expiresAt || left.id.localeCompare(right.id));
    const activeByOwner = Object.fromEntries(
      [...this.#ownerCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
    return Object.freeze({
      active: Object.freeze(active),
      history: Object.freeze(this.#history.slice()),
      activeByOwner: Object.freeze(activeByOwner),
      disposed: this.#disposed,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    const now = this.#now();
    for (const id of this.#active.keys()) {
      this.#release(id, 'registry-disposed', now);
    }
    this.#disposed = true;
  }

  #createHandle(id: ResourceLeaseId, owner: ResourceLeaseOwner): ResourceLeaseHandle {
    return Object.freeze({
      id,
      owner,
      snapshot: () => (this.#disposed ? undefined : this.get(id)),
      renew: (ttlMs: number) => this.renew(id, ttlMs),
      release: () => (this.#disposed ? false : this.release(id)),
    });
  }

  #release(
    id: ResourceLeaseId,
    reason: ResourceLeaseReleaseReason,
    releasedAt = this.#now(),
  ): boolean {
    const lease = this.#active.get(id);
    if (!lease) return false;
    this.#active.delete(id);
    const nextCount = (this.#ownerCounts.get(lease.owner) ?? 1) - 1;
    if (nextCount <= 0) this.#ownerCounts.delete(lease.owner);
    else this.#ownerCounts.set(lease.owner, nextCount);
    this.#history.push(Object.freeze({ ...snapshotLease(lease), releasedAt, reason }));
    const overflow = this.#history.length - this.#policy.historyLimit;
    if (overflow > 0) this.#history.splice(0, overflow);
    return true;
  }

  #normalizeTtl(ttlMs: number): number {
    assertPositiveInteger(ttlMs, 'ttlMs');
    return Math.min(ttlMs, this.#policy.maxLeaseMs);
  }

  #now(): number {
    const value = this.#clock.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new ResourceLeaseError('INVALID_REQUEST', 'clock returned an invalid timestamp');
    }
    return value;
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new ResourceLeaseError('REGISTRY_DISPOSED', 'resource lease registry is disposed');
    }
  }
}
