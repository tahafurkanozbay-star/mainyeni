export type ResourcePriority = 'critical' | 'interactive' | 'normal' | 'background';
export type ResourceState = 'reserved' | 'active' | 'idle' | 'retiring';

export interface ResourceLifecyclePolicy {
  readonly maxResources: number;
  readonly maxWeight: number;
  readonly maxIdleMs: number;
  readonly maxLeaseMs: number;
  readonly maxPerScope?: Readonly<Record<string, number>>;
}

export interface ResourceDescriptor {
  readonly key: string;
  readonly scope?: string;
  readonly priority?: ResourcePriority;
  readonly weight?: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ResourceSnapshotEntry {
  readonly id: string;
  readonly key: string;
  readonly scope: string;
  readonly priority: ResourcePriority;
  readonly state: ResourceState;
  readonly weight: number;
  readonly createdAt: number;
  readonly touchedAt: number;
  readonly leaseDeadline: number;
  readonly generation: number;
}

export interface ResourceLifecycleSnapshot {
  readonly resources: readonly ResourceSnapshotEntry[];
  readonly totalWeight: number;
  readonly reserved: number;
  readonly active: number;
  readonly idle: number;
  readonly retiring: number;
  readonly admitted: number;
  readonly rejected: number;
  readonly retired: number;
  readonly expired: number;
  readonly evicted: number;
}

export interface ResourceLease {
  readonly id: string;
  readonly key: string;
  readonly scope: string;
  readonly generation: number;
  readonly activate: () => boolean;
  readonly touch: () => boolean;
  readonly idle: () => boolean;
  readonly retire: () => boolean;
  readonly release: () => boolean;
}

export class ResourceCapacityError extends Error {
  readonly code = 'PLATFORM_RESOURCE_CAPACITY';
  constructor(message = 'Runtime resource capacity is exhausted.') {
    super(message);
    this.name = 'ResourceCapacityError';
  }
}

interface InternalResource extends ResourceSnapshotEntry {
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

const priorityRank: Readonly<Record<ResourcePriority, number>> = Object.freeze({
  critical: 0,
  interactive: 1,
  normal: 2,
  background: 3,
});

const positiveInteger = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

const normalizeKey = (value: string): string => value.trim().slice(0, 160);
const normalizeScope = (value?: string): string => value?.trim().slice(0, 80) || 'default';

export const createResourceLifecycleRegistry = (
  input: ResourceLifecyclePolicy,
  now: () => number = Date.now,
) => {
  const policy = Object.freeze({
    maxResources: positiveInteger(input.maxResources, 128),
    maxWeight: positiveInteger(input.maxWeight, 512),
    maxIdleMs: positiveInteger(input.maxIdleMs, 60_000),
    maxLeaseMs: positiveInteger(input.maxLeaseMs, 300_000),
    maxPerScope: Object.freeze({ ...input.maxPerScope }),
  });

  const resources = new Map<string, InternalResource>();
  const generations = new Map<string, number>();
  let sequence = 0;
  let admitted = 0;
  let rejected = 0;
  let retired = 0;
  let expired = 0;
  let evicted = 0;
  let disposed = false;

  const nextId = (): string => {
    sequence += 1;
    return `resource-${sequence.toString(36)}`;
  };

  const totalWeight = (): number => {
    let total = 0;
    for (const resource of resources.values()) total += resource.weight;
    return total;
  };

  const scopeCount = (scope: string): number => {
    let count = 0;
    for (const resource of resources.values()) if (resource.scope === scope) count += 1;
    return count;
  };

  const update = (id: string, generation: number, patch: Partial<InternalResource>): boolean => {
    const current = resources.get(id);
    if (!current || current.generation !== generation || disposed) return false;
    resources.set(id, Object.freeze({ ...current, ...patch }));
    return true;
  };

  const remove = (id: string, generation: number, reason: 'retired' | 'expired' | 'evicted'): boolean => {
    const current = resources.get(id);
    if (!current || current.generation !== generation) return false;
    resources.delete(id);
    if (reason === 'retired') retired += 1;
    if (reason === 'expired') expired += 1;
    if (reason === 'evicted') evicted += 1;
    return true;
  };

  const sweep = (): number => {
    if (disposed) return 0;
    const timestamp = now();
    const stale = [...resources.values()].filter((resource) =>
      timestamp > resource.leaseDeadline
      || (resource.state === 'idle' && timestamp - resource.touchedAt > policy.maxIdleMs));
    let count = 0;
    for (const resource of stale) {
      if (remove(resource.id, resource.generation, 'expired')) count += 1;
    }
    return count;
  };

  const evictionCandidates = (): InternalResource[] => [...resources.values()]
    .filter((resource) => resource.state === 'idle' && resource.priority !== 'critical')
    .sort((left, right) =>
      priorityRank[right.priority] - priorityRank[left.priority]
      || left.touchedAt - right.touchedAt
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id));

  const ensureCapacity = (scope: string, weight: number): boolean => {
    sweep();
    const scopeLimit = policy.maxPerScope[scope];
    const overScope = (): boolean => scopeLimit !== undefined && scopeCount(scope) >= Math.max(0, Math.floor(scopeLimit));
    const overGlobal = (): boolean => resources.size >= policy.maxResources || totalWeight() + weight > policy.maxWeight;
    if (!overScope() && !overGlobal()) return true;

    for (const candidate of evictionCandidates()) {
      if (!overScope() && !overGlobal()) break;
      // A scope-specific overflow may only be repaired by evicting from that scope.
      if (overScope() && candidate.scope !== scope && !overGlobal()) continue;
      remove(candidate.id, candidate.generation, 'evicted');
    }
    return !overScope() && !overGlobal();
  };

  const reserve = (descriptor: ResourceDescriptor): ResourceLease => {
    if (disposed) throw new ResourceCapacityError('Resource registry is disposed.');
    const key = normalizeKey(descriptor.key);
    if (!key) throw new ResourceCapacityError('Resource key is required.');
    const scope = normalizeScope(descriptor.scope);
    const priority = descriptor.priority ?? 'normal';
    const weight = Math.min(policy.maxWeight, positiveInteger(descriptor.weight ?? 1, 1));
    if (!ensureCapacity(scope, weight)) {
      rejected += 1;
      throw new ResourceCapacityError();
    }

    const timestamp = now();
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    const id = nextId();
    const resource: InternalResource = Object.freeze({
      id,
      key,
      scope,
      priority,
      state: 'reserved',
      weight,
      createdAt: timestamp,
      touchedAt: timestamp,
      leaseDeadline: timestamp + policy.maxLeaseMs,
      generation,
      metadata: Object.freeze({ ...descriptor.metadata }),
    });
    resources.set(id, resource);
    admitted += 1;

    let released = false;
    const transition = (state: ResourceState): boolean => {
      if (released) return false;
      const current = resources.get(id);
      if (!current || current.generation !== generation) return false;
      const timestampNow = now();
      return update(id, generation, {
        state,
        touchedAt: timestampNow,
        leaseDeadline: timestampNow + policy.maxLeaseMs,
      });
    };

    return Object.freeze({
      id,
      key,
      scope,
      generation,
      activate: () => transition('active'),
      touch: () => {
        if (released) return false;
        const current = resources.get(id);
        if (!current || current.generation !== generation) return false;
        const timestampNow = now();
        return update(id, generation, {
          touchedAt: timestampNow,
          leaseDeadline: timestampNow + policy.maxLeaseMs,
        });
      },
      idle: () => transition('idle'),
      retire: () => transition('retiring'),
      release: () => {
        if (released) return false;
        released = true;
        return remove(id, generation, 'retired');
      },
    });
  };

  const retireScope = (scopeInput: string): number => {
    const scope = normalizeScope(scopeInput);
    let count = 0;
    for (const resource of [...resources.values()]) {
      if (resource.scope !== scope) continue;
      if (remove(resource.id, resource.generation, 'retired')) count += 1;
    }
    return count;
  };

  const retireKey = (keyInput: string): number => {
    const key = normalizeKey(keyInput);
    let count = 0;
    for (const resource of [...resources.values()]) {
      if (resource.key !== key) continue;
      if (remove(resource.id, resource.generation, 'retired')) count += 1;
    }
    return count;
  };

  const snapshot = (): ResourceLifecycleSnapshot => {
    sweep();
    const entries = [...resources.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(({ metadata: _metadata, ...resource }) => Object.freeze(resource));
    const states = { reserved: 0, active: 0, idle: 0, retiring: 0 };
    for (const resource of entries) states[resource.state] += 1;
    return Object.freeze({
      resources: Object.freeze(entries),
      totalWeight: entries.reduce((sum, resource) => sum + resource.weight, 0),
      ...states,
      admitted,
      rejected,
      retired,
      expired,
      evicted,
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    retired += resources.size;
    resources.clear();
  };

  return Object.freeze({ reserve, sweep, retireScope, retireKey, snapshot, dispose });
};
