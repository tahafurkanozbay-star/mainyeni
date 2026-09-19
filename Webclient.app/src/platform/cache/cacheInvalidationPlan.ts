import { immutableStringList } from './cacheContracts';

export interface CacheInvalidationTarget {
  readonly delete: (key: string) => boolean;
  readonly invalidateTags: (tags: readonly string[]) => number;
  readonly invalidateNamespace: (namespace: string) => number;
}

export interface CacheInvalidationRequest {
  readonly keys?: readonly string[];
  readonly tags?: readonly string[];
  readonly namespaces?: readonly string[];
}

export interface CacheInvalidationPlan {
  readonly keys: readonly string[];
  readonly tags: readonly string[];
  readonly namespaces: readonly string[];
}

export interface CacheInvalidationResult {
  readonly exactRemoved: number;
  readonly tagRemoved: number;
  readonly namespaceRemoved: number;
  readonly totalRemoved: number;
}

export const createCacheInvalidationPlan = (
  request: CacheInvalidationRequest,
): CacheInvalidationPlan => Object.freeze({
  keys: normalize(request.keys, 256, 2048, 'cache invalidation key'),
  tags: normalize(request.tags, 64, 128, 'cache invalidation tag'),
  namespaces: normalize(request.namespaces, 32, 96, 'cache invalidation namespace'),
});

export const applyCacheInvalidationPlan = (
  target: CacheInvalidationTarget,
  plan: CacheInvalidationPlan,
): CacheInvalidationResult => {
  let exactRemoved = 0;
  let tagRemoved = 0;
  let namespaceRemoved = 0;

  for (const key of plan.keys) {
    if (target.delete(key)) exactRemoved += 1;
  }
  if (plan.tags.length > 0) tagRemoved += target.invalidateTags(plan.tags);
  for (const namespace of plan.namespaces) {
    namespaceRemoved += target.invalidateNamespace(namespace);
  }

  return Object.freeze({
    exactRemoved,
    tagRemoved,
    namespaceRemoved,
    totalRemoved: exactRemoved + tagRemoved + namespaceRemoved,
  });
};

export const combineCacheInvalidationPlans = (
  ...plans: readonly CacheInvalidationPlan[]
): CacheInvalidationPlan => createCacheInvalidationPlan({
  keys: plans.flatMap((plan) => plan.keys),
  tags: plans.flatMap((plan) => plan.tags),
  namespaces: plans.flatMap((plan) => plan.namespaces),
});

const normalize = (
  values: readonly string[] | undefined,
  maximumItems: number,
  maximumLength: number,
  label: string,
): readonly string[] => immutableStringList(values, {
  maximumItems,
  maximumLength,
  label,
});
