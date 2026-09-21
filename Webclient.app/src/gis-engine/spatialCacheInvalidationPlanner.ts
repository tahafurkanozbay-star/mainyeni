import type { SpatialCacheEnvelope } from './spatialResultCache';

export type SpatialMutationKind = 'add' | 'update' | 'delete' | 'schema' | 'unknown';

export interface SpatialCacheInvalidationScope {
  readonly serviceId: string;
  readonly layerId: number;
  readonly envelope?: SpatialCacheEnvelope;
  readonly objectIds?: readonly number[];
  readonly mutation: SpatialMutationKind;
}

export interface SpatialCacheDependency {
  readonly cacheKey: string;
  readonly serviceId: string;
  readonly layerId: number;
  readonly envelope?: SpatialCacheEnvelope;
  readonly objectIds?: readonly number[];
  readonly tags?: readonly string[];
}

export interface SpatialCacheInvalidationPlannerPolicy {
  readonly maxTrackedEntries: number;
  readonly maxObjectIdsPerEntry: number;
  readonly maxInvalidationKeys: number;
}

export interface SpatialCacheInvalidationPlan {
  readonly keys: readonly string[];
  readonly reason: 'schema' | 'extent-overlap' | 'object-id-overlap' | 'layer-wide' | 'none';
  readonly truncated: boolean;
  readonly examined: number;
}

export interface SpatialCacheInvalidationPlannerSnapshot {
  readonly trackedEntries: number;
  readonly registrations: number;
  readonly replacements: number;
  readonly evictions: number;
  readonly plans: number;
  readonly plannedKeys: number;
  readonly truncatedPlans: number;
  readonly generation: number;
}

interface TrackedDependency {
  readonly cacheKey: string;
  readonly serviceId: string;
  readonly layerId: number;
  readonly envelope?: SpatialCacheEnvelope;
  readonly objectIds: ReadonlySet<number>;
  readonly tags: readonly string[];
  readonly sequence: number;
}

const DEFAULT_POLICY: SpatialCacheInvalidationPlannerPolicy = {
  maxTrackedEntries: 4096,
  maxObjectIdsPerEntry: 2048,
  maxInvalidationKeys: 1024,
};

const positiveSafeInteger = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
};

const nonNegativeSafeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
};

const finiteCoordinate = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
};

const normalizeText = (value: string): string => value.trim();

const normalizeEnvelope = (envelope: SpatialCacheEnvelope | undefined): SpatialCacheEnvelope | undefined => {
  if (!envelope) return undefined;
  const xmin = finiteCoordinate(envelope.xmin, 'xmin');
  const ymin = finiteCoordinate(envelope.ymin, 'ymin');
  const xmax = finiteCoordinate(envelope.xmax, 'xmax');
  const ymax = finiteCoordinate(envelope.ymax, 'ymax');
  if (xmin > xmax || ymin > ymax) throw new RangeError('envelope bounds are inverted');
  if (envelope.spatialReferenceWkid !== undefined) {
    nonNegativeSafeInteger(envelope.spatialReferenceWkid, 'spatialReferenceWkid');
    return Object.freeze({ xmin, ymin, xmax, ymax, spatialReferenceWkid: envelope.spatialReferenceWkid });
  }
  return Object.freeze({ xmin, ymin, xmax, ymax });
};

const normalizeObjectIds = (values: readonly number[] | undefined, maximum: number): ReadonlySet<number> => {
  if (!values || values.length === 0) return new Set<number>();
  if (values.length > maximum) throw new RangeError(`objectIds cannot exceed ${maximum} entries`);
  const normalized = new Set<number>();
  for (const value of values) normalized.add(nonNegativeSafeInteger(value, 'objectId'));
  return normalized;
};

const normalizeTags = (tags: readonly string[] | undefined): readonly string[] => Object.freeze(
  [...new Set((tags ?? []).map(normalizeText).filter(Boolean))].sort(),
);

const sameSpatialReference = (left: SpatialCacheEnvelope, right: SpatialCacheEnvelope): boolean => {
  if (left.spatialReferenceWkid === undefined || right.spatialReferenceWkid === undefined) return true;
  return left.spatialReferenceWkid === right.spatialReferenceWkid;
};

const envelopesIntersect = (left: SpatialCacheEnvelope, right: SpatialCacheEnvelope): boolean => {
  if (!sameSpatialReference(left, right)) return false;
  return left.xmin <= right.xmax && left.xmax >= right.xmin && left.ymin <= right.ymax && left.ymax >= right.ymin;
};

const objectIdsIntersect = (left: ReadonlySet<number>, right: ReadonlySet<number>): boolean => {
  if (left.size === 0 || right.size === 0) return false;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of smaller) if (larger.has(value)) return true;
  return false;
};

export const normalizeSpatialCacheInvalidationPlannerPolicy = (
  policy: Partial<SpatialCacheInvalidationPlannerPolicy> = {},
): SpatialCacheInvalidationPlannerPolicy => {
  const normalized = { ...DEFAULT_POLICY, ...policy };
  positiveSafeInteger(normalized.maxTrackedEntries, 'maxTrackedEntries', 100_000);
  positiveSafeInteger(normalized.maxObjectIdsPerEntry, 'maxObjectIdsPerEntry', 100_000);
  positiveSafeInteger(normalized.maxInvalidationKeys, 'maxInvalidationKeys', 100_000);
  return Object.freeze(normalized);
};

export const createSpatialCacheInvalidationPlanner = (
  policyInput: Partial<SpatialCacheInvalidationPlannerPolicy> = {},
): Readonly<{
  register(dependency: SpatialCacheDependency): void;
  unregister(cacheKey: string): boolean;
  plan(scope: SpatialCacheInvalidationScope): SpatialCacheInvalidationPlan;
  invalidateTag(tag: string): SpatialCacheInvalidationPlan;
  clear(): void;
  snapshot(): SpatialCacheInvalidationPlannerSnapshot;
}> => {
  const policy = normalizeSpatialCacheInvalidationPlannerPolicy(policyInput);
  const tracked = new Map<string, TrackedDependency>();
  let sequence = 0;
  let registrations = 0;
  let replacements = 0;
  let evictions = 0;
  let plans = 0;
  let plannedKeys = 0;
  let truncatedPlans = 0;
  let generation = 0;

  const evictToBudget = (): void => {
    while (tracked.size > policy.maxTrackedEntries) {
      let victim: TrackedDependency | undefined;
      for (const candidate of tracked.values()) {
        if (!victim || candidate.sequence < victim.sequence ||
          (candidate.sequence === victim.sequence && candidate.cacheKey.localeCompare(victim.cacheKey) < 0)) {
          victim = candidate;
        }
      }
      if (!victim) return;
      tracked.delete(victim.cacheKey);
      evictions += 1;
      generation += 1;
    }
  };

  const register = (dependency: SpatialCacheDependency): void => {
    const cacheKey = normalizeText(dependency.cacheKey);
    const serviceId = normalizeText(dependency.serviceId);
    if (!cacheKey) throw new TypeError('cacheKey is required');
    if (!serviceId) throw new TypeError('serviceId is required');
    nonNegativeSafeInteger(dependency.layerId, 'layerId');
    const existing = tracked.has(cacheKey);
    const envelope = normalizeEnvelope(dependency.envelope);
    const normalized: TrackedDependency = Object.freeze({
      cacheKey,
      serviceId,
      layerId: dependency.layerId,
      ...(envelope ? { envelope } : {}),
      objectIds: normalizeObjectIds(dependency.objectIds, policy.maxObjectIdsPerEntry),
      tags: normalizeTags(dependency.tags),
      sequence: ++sequence,
    });
    tracked.set(cacheKey, normalized);
    registrations += 1;
    if (existing) replacements += 1;
    generation += 1;
    evictToBudget();
  };

  const unregister = (cacheKeyInput: string): boolean => {
    const cacheKey = normalizeText(cacheKeyInput);
    if (!cacheKey) return false;
    const removed = tracked.delete(cacheKey);
    if (removed) generation += 1;
    return removed;
  };

  const buildPlan = (
    candidates: Iterable<TrackedDependency>,
    reasonFor: (dependency: TrackedDependency) => SpatialCacheInvalidationPlan['reason'] | undefined,
  ): SpatialCacheInvalidationPlan => {
    let examined = 0;
    let reason: SpatialCacheInvalidationPlan['reason'] = 'none';
    const keys: string[] = [];
    let truncated = false;
    for (const dependency of candidates) {
      examined += 1;
      const candidateReason = reasonFor(dependency);
      if (!candidateReason) continue;
      if (reason === 'none') reason = candidateReason;
      if (keys.length >= policy.maxInvalidationKeys) {
        truncated = true;
        continue;
      }
      keys.push(dependency.cacheKey);
    }
    keys.sort();
    plans += 1;
    plannedKeys += keys.length;
    if (truncated) truncatedPlans += 1;
    return Object.freeze({ keys: Object.freeze(keys), reason, truncated, examined });
  };

  const plan = (scope: SpatialCacheInvalidationScope): SpatialCacheInvalidationPlan => {
    const serviceId = normalizeText(scope.serviceId);
    if (!serviceId) throw new TypeError('serviceId is required');
    nonNegativeSafeInteger(scope.layerId, 'layerId');
    const envelope = normalizeEnvelope(scope.envelope);
    const objectIds = normalizeObjectIds(scope.objectIds, policy.maxObjectIdsPerEntry);
    const mutation = scope.mutation;
    return buildPlan(tracked.values(), (dependency) => {
      if (dependency.serviceId !== serviceId || dependency.layerId !== scope.layerId) return undefined;
      if (mutation === 'schema') return 'schema';
      if (objectIds.size > 0 && objectIdsIntersect(objectIds, dependency.objectIds)) return 'object-id-overlap';
      if (envelope && dependency.envelope && envelopesIntersect(envelope, dependency.envelope)) return 'extent-overlap';
      if (!envelope && objectIds.size === 0) return 'layer-wide';
      if (mutation === 'unknown' && (!dependency.envelope || dependency.objectIds.size === 0)) return 'layer-wide';
      return undefined;
    });
  };

  const invalidateTag = (tagInput: string): SpatialCacheInvalidationPlan => {
    const tag = normalizeText(tagInput);
    if (!tag) return buildPlan([], () => undefined);
    return buildPlan(tracked.values(), (dependency) => dependency.tags.includes(tag) ? 'layer-wide' : undefined);
  };

  const clear = (): void => {
    if (tracked.size === 0) return;
    tracked.clear();
    generation += 1;
  };

  const snapshot = (): SpatialCacheInvalidationPlannerSnapshot => Object.freeze({
    trackedEntries: tracked.size,
    registrations,
    replacements,
    evictions,
    plans,
    plannedKeys,
    truncatedPlans,
    generation,
  });

  return Object.freeze({ register, unregister, plan, invalidateTag, clear, snapshot });
};
