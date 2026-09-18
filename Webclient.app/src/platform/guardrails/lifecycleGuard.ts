import type {
  LifecycleGuardPolicy,
  LifecycleGuardSnapshot,
  LifecycleResourceSnapshot,
} from './contracts';

export interface ResourceLease {
  readonly resourceId: string;
  readonly ownerId: string;
  readonly acquired: boolean;
  readonly reason: string | null;
}

export interface LifecycleGuard {
  readonly acquire: (resourceId: string, ownerId: string, kind?: string, at?: number) => ResourceLease;
  readonly touch: (resourceId: string, ownerId: string, at?: number) => LifecycleResourceSnapshot;
  readonly release: (resourceId: string, ownerId: string, at?: number) => LifecycleResourceSnapshot;
  readonly releaseOwner: (ownerId: string, at?: number) => readonly LifecycleResourceSnapshot[];
  readonly sweep: (at?: number) => readonly LifecycleResourceSnapshot[];
  readonly snapshot: () => LifecycleGuardSnapshot;
  readonly dispose: () => void;
}

export const DEFAULT_LIFECYCLE_GUARD_POLICY: LifecycleGuardPolicy = Object.freeze({
  maxTrackedResources: 1_024,
  maxOwnersPerResource: 16,
  staleAfterMs: 5 * 60_000,
  maxHistory: 512,
});

interface MutableResource {
  id: string;
  kind: string;
  owners: Set<string>;
  acquiredAt: number;
  lastTouchedAt: number;
  releasedAt: number | null;
  state: 'active' | 'released' | 'stale';
}

const positiveInt = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
};

export const normalizeLifecycleGuardPolicy = (
  input: Partial<LifecycleGuardPolicy> = {},
): LifecycleGuardPolicy => Object.freeze({
  maxTrackedResources: positiveInt(
    input.maxTrackedResources ?? DEFAULT_LIFECYCLE_GUARD_POLICY.maxTrackedResources,
    DEFAULT_LIFECYCLE_GUARD_POLICY.maxTrackedResources,
  ),
  maxOwnersPerResource: positiveInt(
    input.maxOwnersPerResource ?? DEFAULT_LIFECYCLE_GUARD_POLICY.maxOwnersPerResource,
    DEFAULT_LIFECYCLE_GUARD_POLICY.maxOwnersPerResource,
  ),
  staleAfterMs: positiveInt(
    input.staleAfterMs ?? DEFAULT_LIFECYCLE_GUARD_POLICY.staleAfterMs,
    DEFAULT_LIFECYCLE_GUARD_POLICY.staleAfterMs,
  ),
  maxHistory: positiveInt(
    input.maxHistory ?? DEFAULT_LIFECYCLE_GUARD_POLICY.maxHistory,
    DEFAULT_LIFECYCLE_GUARD_POLICY.maxHistory,
  ),
});

const cleanId = (value: string, maxLength = 256): string =>
  value.trim().slice(0, maxLength);

const toSnapshot = (resource: MutableResource): LifecycleResourceSnapshot =>
  Object.freeze({
    id: resource.id,
    kind: resource.kind,
    ownerCount: resource.owners.size,
    acquiredAt: resource.acquiredAt,
    lastTouchedAt: resource.lastTouchedAt,
    releasedAt: resource.releasedAt,
    state: resource.state,
  });

export const createLifecycleGuard = (
  policyInput: Partial<LifecycleGuardPolicy> = {},
  now: () => number = Date.now,
): LifecycleGuard => {
  const policy = normalizeLifecycleGuardPolicy(policyInput);
  const active = new Map<string, MutableResource>();
  let history: LifecycleResourceSnapshot[] = [];
  let rejected = 0;
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('Lifecycle guard is disposed.');
  };

  const timestamp = (value?: number): number => {
    if (value !== undefined && Number.isFinite(value)) return value;
    return now();
  };

  const pushHistory = (snapshot: LifecycleResourceSnapshot): void => {
    history = [...history, snapshot];
    if (history.length > policy.maxHistory) {
      history = history.slice(history.length - policy.maxHistory);
    }
  };

  const acquire = (
    resourceIdInput: string,
    ownerIdInput: string,
    kindInput = 'generic',
    atInput?: number,
  ): ResourceLease => {
    assertActive();
    const resourceId = cleanId(resourceIdInput);
    const ownerId = cleanId(ownerIdInput);
    const kind = cleanId(kindInput, 128) || 'generic';
    const at = timestamp(atInput);

    if (!resourceId || !ownerId) {
      rejected += 1;
      return Object.freeze({
        resourceId,
        ownerId,
        acquired: false,
        reason: 'invalid-identity',
      });
    }

    const existing = active.get(resourceId);
    if (existing) {
      if (existing.owners.has(ownerId)) {
        existing.lastTouchedAt = Math.max(existing.lastTouchedAt, at);
        return Object.freeze({
          resourceId,
          ownerId,
          acquired: true,
          reason: null,
        });
      }

      if (existing.owners.size >= policy.maxOwnersPerResource) {
        rejected += 1;
        return Object.freeze({
          resourceId,
          ownerId,
          acquired: false,
          reason: 'owner-capacity',
        });
      }

      existing.owners.add(ownerId);
      existing.lastTouchedAt = Math.max(existing.lastTouchedAt, at);
      return Object.freeze({
        resourceId,
        ownerId,
        acquired: true,
        reason: null,
      });
    }

    if (active.size >= policy.maxTrackedResources) {
      rejected += 1;
      return Object.freeze({
        resourceId,
        ownerId,
        acquired: false,
        reason: 'resource-capacity',
      });
    }

    active.set(resourceId, {
      id: resourceId,
      kind,
      owners: new Set([ownerId]),
      acquiredAt: at,
      lastTouchedAt: at,
      releasedAt: null,
      state: 'active',
    });

    return Object.freeze({
      resourceId,
      ownerId,
      acquired: true,
      reason: null,
    });
  };

  const requireResource = (resourceId: string): MutableResource => {
    const resource = active.get(resourceId);
    if (!resource) throw new Error('Unknown lifecycle resource.');
    return resource;
  };

  const requireOwner = (resource: MutableResource, ownerId: string): void => {
    if (!resource.owners.has(ownerId)) {
      throw new Error('Owner does not hold the lifecycle resource.');
    }
  };

  const touch = (
    resourceIdInput: string,
    ownerIdInput: string,
    atInput?: number,
  ): LifecycleResourceSnapshot => {
    assertActive();
    const resourceId = cleanId(resourceIdInput);
    const ownerId = cleanId(ownerIdInput);
    const resource = requireResource(resourceId);
    requireOwner(resource, ownerId);
    resource.lastTouchedAt = Math.max(resource.lastTouchedAt, timestamp(atInput));
    return toSnapshot(resource);
  };

  const finalizeIfUnowned = (
    resource: MutableResource,
    at: number,
    state: 'released' | 'stale',
  ): LifecycleResourceSnapshot => {
    resource.state = state;
    resource.releasedAt = Math.max(resource.lastTouchedAt, at);
    const snapshot = toSnapshot(resource);
    active.delete(resource.id);
    pushHistory(snapshot);
    return snapshot;
  };

  const release = (
    resourceIdInput: string,
    ownerIdInput: string,
    atInput?: number,
  ): LifecycleResourceSnapshot => {
    assertActive();
    const resourceId = cleanId(resourceIdInput);
    const ownerId = cleanId(ownerIdInput);
    const resource = requireResource(resourceId);
    requireOwner(resource, ownerId);
    const at = timestamp(atInput);
    resource.owners.delete(ownerId);
    resource.lastTouchedAt = Math.max(resource.lastTouchedAt, at);

    if (resource.owners.size === 0) {
      return finalizeIfUnowned(resource, at, 'released');
    }

    return toSnapshot(resource);
  };

  const releaseOwner = (
    ownerIdInput: string,
    atInput?: number,
  ): readonly LifecycleResourceSnapshot[] => {
    assertActive();
    const ownerId = cleanId(ownerIdInput);
    if (!ownerId) return Object.freeze([]);
    const at = timestamp(atInput);
    const changed: LifecycleResourceSnapshot[] = [];

    for (const resource of [...active.values()]) {
      if (!resource.owners.has(ownerId)) continue;
      resource.owners.delete(ownerId);
      resource.lastTouchedAt = Math.max(resource.lastTouchedAt, at);
      if (resource.owners.size === 0) {
        changed.push(finalizeIfUnowned(resource, at, 'released'));
      } else {
        changed.push(toSnapshot(resource));
      }
    }

    return Object.freeze(changed);
  };

  const sweep = (
    atInput?: number,
  ): readonly LifecycleResourceSnapshot[] => {
    assertActive();
    const at = timestamp(atInput);
    const changed: LifecycleResourceSnapshot[] = [];

    for (const resource of [...active.values()]) {
      if (at - resource.lastTouchedAt <= policy.staleAfterMs) continue;
      resource.owners.clear();
      changed.push(finalizeIfUnowned(resource, at, 'stale'));
    }

    return Object.freeze(changed);
  };

  const snapshot = (): LifecycleGuardSnapshot => {
    assertActive();
    const activeSnapshots = [...active.values()]
      .map(toSnapshot)
      .sort((left, right) =>
        left.acquiredAt - right.acquiredAt || left.id.localeCompare(right.id),
      );
    const retainedHistory = [...history];
    return Object.freeze({
      active: activeSnapshots.length,
      released: retainedHistory.filter((item) => item.state === 'released').length,
      stale: retainedHistory.filter((item) => item.state === 'stale').length,
      rejected,
      resources: Object.freeze([...activeSnapshots, ...retainedHistory]),
    });
  };

  const dispose = (): void => {
    active.clear();
    history = [];
    disposed = true;
  };

  return Object.freeze({
    acquire,
    touch,
    release,
    releaseOwner,
    sweep,
    snapshot,
    dispose,
  });
};
