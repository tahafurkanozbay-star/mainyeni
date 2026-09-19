import {
  cacheInteger,
  cacheKey,
  cacheNamespace,
  cacheTag,
  immutableStringList,
  type CacheKey,
  type CacheNamespace,
  type CacheTag,
} from './cacheContracts';

export interface CacheMutationGuardOptions {
  readonly maxTrackedKeys?: number;
  readonly maxTrackedNamespaces?: number;
  readonly maxTrackedTags?: number;
  readonly maxTagsPerToken?: number;
}

export interface CacheMutationToken {
  readonly key: CacheKey;
  readonly namespace: CacheNamespace;
  readonly tags: readonly CacheTag[];
  readonly globalGeneration: number;
  readonly keyGeneration: number;
  readonly namespaceGeneration: number;
  readonly tagGenerations: readonly Readonly<{ tag: CacheTag; generation: number }>[];
}

export interface CacheMutationGuardSnapshot {
  readonly globalGeneration: number;
  readonly trackedKeys: number;
  readonly trackedNamespaces: number;
  readonly trackedTags: number;
  readonly invalidations: number;
  readonly fallbackGlobalInvalidations: number;
}

export class CacheMutationGuard {
  readonly #maxTrackedKeys: number;
  readonly #maxTrackedNamespaces: number;
  readonly #maxTrackedTags: number;
  readonly #maxTagsPerToken: number;
  readonly #keys = new Map<CacheKey, number>();
  readonly #namespaces = new Map<CacheNamespace, number>();
  readonly #tags = new Map<CacheTag, number>();
  #globalGeneration = 0;
  #invalidations = 0;
  #fallbackGlobalInvalidations = 0;

  constructor(options: CacheMutationGuardOptions = {}) {
    this.#maxTrackedKeys = cacheInteger(
      'maxTrackedKeys',
      options.maxTrackedKeys ?? 4096,
      1,
      100000,
    );
    this.#maxTrackedNamespaces = cacheInteger(
      'maxTrackedNamespaces',
      options.maxTrackedNamespaces ?? 256,
      1,
      10000,
    );
    this.#maxTrackedTags = cacheInteger(
      'maxTrackedTags',
      options.maxTrackedTags ?? 4096,
      1,
      100000,
    );
    this.#maxTagsPerToken = cacheInteger(
      'maxTagsPerToken',
      options.maxTagsPerToken ?? 16,
      0,
      128,
    );
  }

  capture(
    rawKey: string,
    rawNamespace: string,
    rawTags: readonly string[] = [],
  ): CacheMutationToken {
    const key = cacheKey(rawKey);
    const namespace = cacheNamespace(rawNamespace);
    const tags = immutableStringList(rawTags, {
      maximumItems: this.#maxTagsPerToken,
      maximumLength: 128,
      label: 'cache mutation tag',
    }).map((value) => cacheTag(value));

    return Object.freeze({
      key,
      namespace,
      tags: Object.freeze([...tags]),
      globalGeneration: this.#globalGeneration,
      keyGeneration: this.#keys.get(key) ?? 0,
      namespaceGeneration: this.#namespaces.get(namespace) ?? 0,
      tagGenerations: Object.freeze(tags.map((tag) => Object.freeze({
        tag,
        generation: this.#tags.get(tag) ?? 0,
      }))),
    });
  }

  isCurrent(token: CacheMutationToken): boolean {
    if (token.globalGeneration !== this.#globalGeneration) return false;
    if ((this.#keys.get(token.key) ?? 0) !== token.keyGeneration) return false;
    if ((this.#namespaces.get(token.namespace) ?? 0) !== token.namespaceGeneration) {
      return false;
    }
    for (const item of token.tagGenerations) {
      if ((this.#tags.get(item.tag) ?? 0) !== item.generation) return false;
    }
    return true;
  }

  invalidateKey(rawKey: string): void {
    const key = cacheKey(rawKey);
    this.#invalidations += 1;
    if (!this.#keys.has(key) && this.#keys.size >= this.#maxTrackedKeys) {
      this.#fallbackToGlobal();
      return;
    }
    this.#keys.set(key, nextGeneration(this.#keys.get(key) ?? 0));
  }

  invalidateNamespace(rawNamespace: string): void {
    const namespace = cacheNamespace(rawNamespace);
    this.#invalidations += 1;
    if (!this.#namespaces.has(namespace) && this.#namespaces.size >= this.#maxTrackedNamespaces) {
      this.#fallbackToGlobal();
      return;
    }
    this.#namespaces.set(
      namespace,
      nextGeneration(this.#namespaces.get(namespace) ?? 0),
    );
  }

  invalidateTags(rawTags: readonly string[]): void {
    const tags = immutableStringList(rawTags, {
      maximumItems: 64,
      maximumLength: 128,
      label: 'cache mutation tag',
    }).map((value) => cacheTag(value));
    if (tags.length === 0) return;

    this.#invalidations += 1;
    const newTags = tags.filter((tag) => !this.#tags.has(tag)).length;
    if (this.#tags.size + newTags > this.#maxTrackedTags) {
      this.#fallbackToGlobal();
      return;
    }
    for (const tag of tags) {
      this.#tags.set(tag, nextGeneration(this.#tags.get(tag) ?? 0));
    }
  }

  invalidateAll(): void {
    this.#invalidations += 1;
    this.#globalGeneration = nextGeneration(this.#globalGeneration);
    this.#keys.clear();
    this.#namespaces.clear();
    this.#tags.clear();
  }

  snapshot(): CacheMutationGuardSnapshot {
    return Object.freeze({
      globalGeneration: this.#globalGeneration,
      trackedKeys: this.#keys.size,
      trackedNamespaces: this.#namespaces.size,
      trackedTags: this.#tags.size,
      invalidations: this.#invalidations,
      fallbackGlobalInvalidations: this.#fallbackGlobalInvalidations,
    });
  }

  #fallbackToGlobal(): void {
    this.#fallbackGlobalInvalidations += 1;
    this.#globalGeneration = nextGeneration(this.#globalGeneration);
    this.#keys.clear();
    this.#namespaces.clear();
    this.#tags.clear();
  }
}

const nextGeneration = (current: number): number => {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('cache mutation generation is exhausted');
  }
  return current + 1;
};
