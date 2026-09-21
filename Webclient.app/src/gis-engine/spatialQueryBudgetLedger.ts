export type SpatialQueryPriority = 'interactive' | 'normal' | 'background';

export interface SpatialQueryBudget {
  readonly features: number;
  readonly responseBytes: number;
  readonly cpuMs: number;
  readonly gpuBytes: number;
}

export interface SpatialQueryBudgetLimits extends SpatialQueryBudget {
  readonly maxLeases: number;
  readonly maxOwners: number;
  readonly maxHistory: number;
}

export interface SpatialQueryBudgetRequest extends SpatialQueryBudget {
  readonly owner: string;
  readonly serviceId: string;
  readonly layerId: string;
  readonly priority: SpatialQueryPriority;
}

export interface SpatialQueryBudgetLease extends SpatialQueryBudgetRequest {
  readonly id: string;
  readonly acquiredAt: number;
}

export interface SpatialQueryBudgetSnapshot {
  readonly limits: SpatialQueryBudgetLimits;
  readonly used: SpatialQueryBudget;
  readonly available: SpatialQueryBudget;
  readonly leases: number;
  readonly owners: number;
  readonly pressure: number;
  readonly history: readonly SpatialQueryBudgetEvent[];
}

export type SpatialQueryBudgetDecision =
  | { readonly kind: 'admit'; readonly lease: SpatialQueryBudgetLease }
  | { readonly kind: 'defer'; readonly reason: SpatialQueryBudgetReason }
  | { readonly kind: 'reject'; readonly reason: SpatialQueryBudgetReason };

export type SpatialQueryBudgetReason =
  | 'invalid-request'
  | 'single-request-exceeds-budget'
  | 'lease-capacity'
  | 'owner-capacity'
  | 'feature-pressure'
  | 'response-byte-pressure'
  | 'cpu-pressure'
  | 'gpu-pressure';

export interface SpatialQueryBudgetEvent {
  readonly type: 'acquire' | 'release' | 'reject' | 'defer';
  readonly at: number;
  readonly owner: string;
  readonly leaseId?: string;
  readonly reason?: SpatialQueryBudgetReason;
}

export interface SpatialQueryBudgetLedgerOptions {
  readonly limits: SpatialQueryBudgetLimits;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly interactiveReserveRatio?: number;
}

const EMPTY_BUDGET: SpatialQueryBudget = Object.freeze({
  features: 0,
  responseBytes: 0,
  cpuMs: 0,
  gpuBytes: 0,
});

const PRIORITY_ORDER: Readonly<Record<SpatialQueryPriority, number>> = Object.freeze({
  interactive: 0,
  normal: 1,
  background: 2,
});

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validText(value: string): boolean {
  return value.trim().length > 0;
}

function validateLimits(limits: SpatialQueryBudgetLimits): void {
  if (
    !finitePositive(limits.features) ||
    !finitePositive(limits.responseBytes) ||
    !finitePositive(limits.cpuMs) ||
    !finitePositive(limits.gpuBytes) ||
    !Number.isSafeInteger(limits.maxLeases) ||
    limits.maxLeases <= 0 ||
    !Number.isSafeInteger(limits.maxOwners) ||
    limits.maxOwners <= 0 ||
    !Number.isSafeInteger(limits.maxHistory) ||
    limits.maxHistory < 0
  ) {
    throw new RangeError('Spatial query budget limits must be finite and bounded.');
  }
}

function validRequest(request: SpatialQueryBudgetRequest): boolean {
  return (
    validText(request.owner) &&
    validText(request.serviceId) &&
    validText(request.layerId) &&
    request.priority in PRIORITY_ORDER &&
    finiteNonNegative(request.features) &&
    finiteNonNegative(request.responseBytes) &&
    finiteNonNegative(request.cpuMs) &&
    finiteNonNegative(request.gpuBytes)
  );
}

function addBudget(left: SpatialQueryBudget, right: SpatialQueryBudget): SpatialQueryBudget {
  return {
    features: left.features + right.features,
    responseBytes: left.responseBytes + right.responseBytes,
    cpuMs: left.cpuMs + right.cpuMs,
    gpuBytes: left.gpuBytes + right.gpuBytes,
  };
}

function subtractBudget(left: SpatialQueryBudget, right: SpatialQueryBudget): SpatialQueryBudget {
  return {
    features: Math.max(0, left.features - right.features),
    responseBytes: Math.max(0, left.responseBytes - right.responseBytes),
    cpuMs: Math.max(0, left.cpuMs - right.cpuMs),
    gpuBytes: Math.max(0, left.gpuBytes - right.gpuBytes),
  };
}

function exceeds(request: SpatialQueryBudget, limit: SpatialQueryBudget): SpatialQueryBudgetReason | null {
  if (request.features > limit.features) return 'feature-pressure';
  if (request.responseBytes > limit.responseBytes) return 'response-byte-pressure';
  if (request.cpuMs > limit.cpuMs) return 'cpu-pressure';
  if (request.gpuBytes > limit.gpuBytes) return 'gpu-pressure';
  return null;
}

function maxRatio(used: SpatialQueryBudget, limits: SpatialQueryBudget): number {
  return Math.max(
    used.features / limits.features,
    used.responseBytes / limits.responseBytes,
    used.cpuMs / limits.cpuMs,
    used.gpuBytes / limits.gpuBytes,
  );
}

export class SpatialQueryBudgetLedger {
  readonly #limits: SpatialQueryBudgetLimits;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #reserveRatio: number;
  readonly #leases = new Map<string, SpatialQueryBudgetLease>();
  readonly #ownerLeaseCounts = new Map<string, number>();
  readonly #history: SpatialQueryBudgetEvent[] = [];
  #used: SpatialQueryBudget = EMPTY_BUDGET;
  #disposed = false;

  constructor(options: SpatialQueryBudgetLedgerOptions) {
    validateLimits(options.limits);
    const reserveRatio = options.interactiveReserveRatio ?? 0.15;
    if (!Number.isFinite(reserveRatio) || reserveRatio < 0 || reserveRatio >= 1) {
      throw new RangeError('interactiveReserveRatio must be within [0, 1).');
    }
    this.#limits = Object.freeze({ ...options.limits });
    this.#now = options.now ?? Date.now;
    let sequence = 0;
    this.#createId = options.createId ?? (() => `spatial-budget-${++sequence}`);
    this.#reserveRatio = reserveRatio;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  acquire(request: SpatialQueryBudgetRequest): SpatialQueryBudgetDecision {
    if (this.#disposed || !validRequest(request)) {
      return this.#recordDecision('reject', request.owner, 'invalid-request');
    }

    const absoluteReason = exceeds(request, this.#limits);
    if (absoluteReason) {
      return this.#recordDecision('reject', request.owner, 'single-request-exceeds-budget');
    }

    if (this.#leases.size >= this.#limits.maxLeases) {
      return this.#recordDecision('defer', request.owner, 'lease-capacity');
    }

    const knownOwner = this.#ownerLeaseCounts.has(request.owner);
    if (!knownOwner && this.#ownerLeaseCounts.size >= this.#limits.maxOwners) {
      return this.#recordDecision('defer', request.owner, 'owner-capacity');
    }

    const effectiveLimits = this.#effectiveLimits(request.priority);
    const nextUsed = addBudget(this.#used, request);
    const pressureReason = exceeds(nextUsed, effectiveLimits);
    if (pressureReason) {
      return this.#recordDecision('defer', request.owner, pressureReason);
    }

    const leaseId = this.#nextUniqueId();
    const lease: SpatialQueryBudgetLease = Object.freeze({
      ...request,
      owner: request.owner.trim(),
      serviceId: request.serviceId.trim(),
      layerId: request.layerId.trim(),
      id: leaseId,
      acquiredAt: this.#safeNow(),
    });
    this.#leases.set(leaseId, lease);
    this.#ownerLeaseCounts.set(lease.owner, (this.#ownerLeaseCounts.get(lease.owner) ?? 0) + 1);
    this.#used = nextUsed;
    this.#pushHistory({ type: 'acquire', at: lease.acquiredAt, owner: lease.owner, leaseId });
    return { kind: 'admit', lease };
  }

  release(leaseId: string): boolean {
    const lease = this.#leases.get(leaseId);
    if (!lease) return false;
    this.#leases.delete(leaseId);
    this.#used = subtractBudget(this.#used, lease);
    const count = this.#ownerLeaseCounts.get(lease.owner) ?? 0;
    if (count <= 1) this.#ownerLeaseCounts.delete(lease.owner);
    else this.#ownerLeaseCounts.set(lease.owner, count - 1);
    this.#pushHistory({ type: 'release', at: this.#safeNow(), owner: lease.owner, leaseId });
    return true;
  }

  releaseOwner(owner: string): number {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) return 0;
    const ids: string[] = [];
    for (const [id, lease] of this.#leases) {
      if (lease.owner === normalizedOwner) ids.push(id);
    }
    for (const id of ids) this.release(id);
    return ids.length;
  }

  releaseLayer(serviceId: string, layerId: string): number {
    const service = serviceId.trim();
    const layer = layerId.trim();
    if (!service || !layer) return 0;
    const ids: string[] = [];
    for (const [id, lease] of this.#leases) {
      if (lease.serviceId === service && lease.layerId === layer) ids.push(id);
    }
    for (const id of ids) this.release(id);
    return ids.length;
  }

  has(leaseId: string): boolean {
    return this.#leases.has(leaseId);
  }

  get(leaseId: string): SpatialQueryBudgetLease | undefined {
    return this.#leases.get(leaseId);
  }

  list(): readonly SpatialQueryBudgetLease[] {
    return [...this.#leases.values()].sort((left, right) => {
      const priority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
      if (priority !== 0) return priority;
      if (left.acquiredAt !== right.acquiredAt) return left.acquiredAt - right.acquiredAt;
      return left.id.localeCompare(right.id);
    });
  }

  snapshot(): SpatialQueryBudgetSnapshot {
    const used = Object.freeze({ ...this.#used });
    const available = Object.freeze(subtractBudget(this.#limits, used));
    return Object.freeze({
      limits: this.#limits,
      used,
      available,
      leases: this.#leases.size,
      owners: this.#ownerLeaseCounts.size,
      pressure: Math.min(1, maxRatio(used, this.#limits)),
      history: Object.freeze([...this.#history]),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#leases.clear();
    this.#ownerLeaseCounts.clear();
    this.#history.length = 0;
    this.#used = EMPTY_BUDGET;
  }

  #effectiveLimits(priority: SpatialQueryPriority): SpatialQueryBudget {
    if (priority === 'interactive' || this.#reserveRatio === 0) return this.#limits;
    const multiplier = 1 - this.#reserveRatio;
    return {
      features: this.#limits.features * multiplier,
      responseBytes: this.#limits.responseBytes * multiplier,
      cpuMs: this.#limits.cpuMs * multiplier,
      gpuBytes: this.#limits.gpuBytes * multiplier,
    };
  }

  #nextUniqueId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const id = this.#createId().trim();
      if (id && !this.#leases.has(id)) return id;
    }
    throw new Error('Unable to allocate a unique spatial query budget lease id.');
  }

  #safeNow(): number {
    const value = this.#now();
    return Number.isFinite(value) ? value : 0;
  }

  #recordDecision(
    kind: 'reject' | 'defer',
    owner: string,
    reason: SpatialQueryBudgetReason,
  ): SpatialQueryBudgetDecision {
    this.#pushHistory({ type: kind, at: this.#safeNow(), owner: owner.trim(), reason });
    return { kind, reason };
  }

  #pushHistory(event: SpatialQueryBudgetEvent): void {
    if (this.#limits.maxHistory === 0) return;
    this.#history.push(Object.freeze(event));
    const overflow = this.#history.length - this.#limits.maxHistory;
    if (overflow > 0) this.#history.splice(0, overflow);
  }
}

export function createSpatialQueryBudgetLedger(
  options: SpatialQueryBudgetLedgerOptions,
): SpatialQueryBudgetLedger {
  return new SpatialQueryBudgetLedger(options);
}
