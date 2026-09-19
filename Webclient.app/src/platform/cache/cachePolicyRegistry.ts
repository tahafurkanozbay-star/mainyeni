import {
  cacheInteger,
  cacheNamespace,
  immutableStringList,
  type CacheNamespace,
} from './cacheContracts';
import {
  evaluateCachePolicy,
  type CacheDataClassification,
  type CachePolicyDecision,
  type CachePolicyInput,
} from './cachePolicy';

export interface NamespaceCachePolicy {
  readonly namespace: CacheNamespace;
  readonly classification: CacheDataClassification;
  readonly ttlMs: number;
  readonly staleWhileRevalidateMs: number;
  readonly allowedTags: readonly string[];
  readonly enabled: boolean;
}

export interface CachePolicyRegistryOptions {
  readonly maxPolicies?: number;
  readonly maxAllowedTagsPerPolicy?: number;
}

export interface NamespacePolicyRegistration {
  readonly namespace: string;
  readonly classification?: CacheDataClassification;
  readonly ttlMs?: number;
  readonly staleWhileRevalidateMs?: number;
  readonly allowedTags?: readonly string[];
  readonly enabled?: boolean;
}

export interface ResolveNamespacePolicyRequest {
  readonly namespace: string;
  readonly method?: string;
  readonly authenticated?: boolean;
  readonly containsAuthorization?: boolean;
  readonly tags?: readonly string[];
  readonly ttlMs?: number;
  readonly staleWhileRevalidateMs?: number;
}

export interface ResolvedNamespacePolicy {
  readonly policy: NamespaceCachePolicy;
  readonly decision: CachePolicyDecision;
  readonly tags: readonly string[];
}

export class CachePolicyRegistry {
  readonly #maxPolicies: number;
  readonly #maxAllowedTagsPerPolicy: number;
  readonly #policies = new Map<CacheNamespace, NamespaceCachePolicy>();

  constructor(options: CachePolicyRegistryOptions = {}) {
    this.#maxPolicies = cacheInteger('maxPolicies', options.maxPolicies ?? 128, 1, 4096);
    this.#maxAllowedTagsPerPolicy = cacheInteger(
      'maxAllowedTagsPerPolicy',
      options.maxAllowedTagsPerPolicy ?? 32,
      0,
      128,
    );
  }

  register(request: NamespacePolicyRegistration): NamespaceCachePolicy {
    const namespace = cacheNamespace(request.namespace);
    const existing = this.#policies.get(namespace);
    if (!existing && this.#policies.size >= this.#maxPolicies) {
      throw new RangeError('cache policy registry capacity is exhausted');
    }

    const ttlMs = duration('ttlMs', request.ttlMs ?? existing?.ttlMs ?? 30000, 3600000);
    const staleWhileRevalidateMs = duration(
      'staleWhileRevalidateMs',
      request.staleWhileRevalidateMs ?? existing?.staleWhileRevalidateMs ?? 0,
      600000,
    );
    const allowedTags = immutableStringList(
      request.allowedTags ?? existing?.allowedTags ?? [],
      {
        maximumItems: this.#maxAllowedTagsPerPolicy,
        maximumLength: 128,
        label: 'cache policy tag',
      },
    );
    const policy: NamespaceCachePolicy = Object.freeze({
      namespace,
      classification: request.classification ?? existing?.classification ?? 'internal',
      ttlMs,
      staleWhileRevalidateMs,
      allowedTags,
      enabled: request.enabled ?? existing?.enabled ?? true,
    });
    this.#policies.set(namespace, policy);
    return policy;
  }

  unregister(rawNamespace: string): boolean {
    return this.#policies.delete(cacheNamespace(rawNamespace));
  }

  get(rawNamespace: string): NamespaceCachePolicy | undefined {
    return this.#policies.get(cacheNamespace(rawNamespace));
  }

  list(): readonly NamespaceCachePolicy[] {
    return Object.freeze([...this.#policies.values()]
      .map((policy) => Object.freeze({ ...policy, allowedTags: Object.freeze([...policy.allowedTags]) }))
      .sort((left, right) => left.namespace.localeCompare(right.namespace)));
  }

  resolve(request: ResolveNamespacePolicyRequest): ResolvedNamespacePolicy {
    const namespace = cacheNamespace(request.namespace);
    const policy = this.#policies.get(namespace);
    if (!policy) throw new RangeError('no cache policy is registered for namespace ' + namespace);

    const tags = immutableStringList(request.tags, {
      maximumItems: this.#maxAllowedTagsPerPolicy,
      maximumLength: 128,
      label: 'cache request tag',
    });
    this.#assertTagsAllowed(policy, tags);

    const input: CachePolicyInput = {
      method: request.method,
      classification: policy.classification,
      explicitCacheable: policy.enabled,
      authenticated: request.authenticated,
      containsAuthorization: request.containsAuthorization,
      ttlMs: request.ttlMs ?? policy.ttlMs,
      staleWhileRevalidateMs:
        request.staleWhileRevalidateMs ?? policy.staleWhileRevalidateMs,
    };
    const decision = evaluateCachePolicy(input);
    return Object.freeze({
      policy,
      decision,
      tags,
    });
  }

  snapshot(): Readonly<{ policies: number; maxPolicies: number }> {
    return Object.freeze({
      policies: this.#policies.size,
      maxPolicies: this.#maxPolicies,
    });
  }

  #assertTagsAllowed(
    policy: NamespaceCachePolicy,
    tags: readonly string[],
  ): void {
    if (tags.length === 0) return;
    const allowed = new Set(policy.allowedTags);
    for (const tag of tags) {
      if (!allowed.has(tag)) {
        throw new RangeError(
          'cache tag is not allowed by namespace policy ' + policy.namespace + ': ' + tag,
        );
      }
    }
  }
}

const duration = (
  name: string,
  value: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(name + ' must be between 0 and ' + maximum);
  }
  return value;
};
