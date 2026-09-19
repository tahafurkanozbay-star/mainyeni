import {
  cacheKey,
  cacheNamespace,
  cacheTag,
  immutableStringList,
  type CacheKey,
  type CacheNamespace,
  type CacheTag,
} from './cacheContracts';

export interface CacheTagIndexOptions {
  readonly maxTags?: number;
  readonly maxKeysPerTag?: number;
  readonly maxTagsPerKey?: number;
}

interface KeyMetadata {
  readonly namespace: CacheNamespace;
  readonly tags: Set<CacheTag>;
}

export class BoundedCacheTagIndex {
  readonly #maxTags: number;
  readonly #maxKeysPerTag: number;
  readonly #maxTagsPerKey: number;
  readonly #keys = new Map<CacheKey, KeyMetadata>();
  readonly #tags = new Map<CacheTag, Set<CacheKey>>();
  readonly #namespaces = new Map<CacheNamespace, Set<CacheKey>>();

  constructor(options: CacheTagIndexOptions = {}) {
    this.#maxTags = bounded(options.maxTags ?? 4096, 1, 100000, 'maxTags');
    this.#maxKeysPerTag = bounded(options.maxKeysPerTag ?? 2048, 1, 100000, 'maxKeysPerTag');
    this.#maxTagsPerKey = bounded(options.maxTagsPerKey ?? 16, 0, 128, 'maxTagsPerKey');
  }

  register(rawKey: string, rawNamespace: string, rawTags: readonly string[] = []): void {
    const key = cacheKey(rawKey);
    const namespace = cacheNamespace(rawNamespace);
    const tags = immutableStringList(rawTags, {
      maximumItems: this.#maxTagsPerKey,
      maximumLength: 128,
      label: 'cache tag',
    }).map((value) => cacheTag(value));

    const previous = this.#keys.get(key);
    if (previous) this.remove(key);
    const newTags = tags.filter((tag) => !this.#tags.has(tag)).length;
    if (this.#tags.size + newTags > this.#maxTags) {
      if (previous) this.#restore(key, previous);
      throw new RangeError('cache tag capacity exceeded');
    }
    for (const tag of tags) {
      if ((this.#tags.get(tag)?.size ?? 0) >= this.#maxKeysPerTag) {
        if (previous) this.#restore(key, previous);
        throw new RangeError('cache tag key capacity exceeded');
      }
    }

    const metadata = { namespace, tags: new Set(tags) };
    this.#keys.set(key, metadata);
    this.#namespaceSet(namespace).add(key);
    for (const tag of tags) this.#tagSet(tag).add(key);
  }

  remove(rawKey: string): boolean {
    const key = cacheKey(rawKey);
    const metadata = this.#keys.get(key);
    if (!metadata) return false;
    this.#keys.delete(key);
    const namespaceKeys = this.#namespaces.get(metadata.namespace);
    namespaceKeys?.delete(key);
    if (namespaceKeys?.size === 0) this.#namespaces.delete(metadata.namespace);
    for (const tag of metadata.tags) {
      const keys = this.#tags.get(tag);
      keys?.delete(key);
      if (keys?.size === 0) this.#tags.delete(tag);
    }
    return true;
  }

  keysForTags(rawTags: readonly string[]): readonly CacheKey[] {
    const result = new Set<CacheKey>();
    for (const rawTag of rawTags) {
      for (const key of this.#tags.get(cacheTag(rawTag)) ?? []) result.add(key);
    }
    return Object.freeze([...result].sort());
  }

  keysForNamespace(rawNamespace: string): readonly CacheKey[] {
    const namespace = cacheNamespace(rawNamespace);
    return Object.freeze([...(this.#namespaces.get(namespace) ?? [])].sort());
  }

  tagsForKey(rawKey: string): readonly CacheTag[] {
    const key = cacheKey(rawKey);
    return Object.freeze([...(this.#keys.get(key)?.tags ?? [])].sort());
  }

  clear(): void {
    this.#keys.clear();
    this.#tags.clear();
    this.#namespaces.clear();
  }

  #restore(key: CacheKey, metadata: KeyMetadata): void {
    this.#keys.set(key, metadata);
    this.#namespaceSet(metadata.namespace).add(key);
    for (const tag of metadata.tags) this.#tagSet(tag).add(key);
  }

  #namespaceSet(namespace: CacheNamespace): Set<CacheKey> {
    let keys = this.#namespaces.get(namespace);
    if (!keys) {
      keys = new Set();
      this.#namespaces.set(namespace, keys);
    }
    return keys;
  }

  #tagSet(tag: CacheTag): Set<CacheKey> {
    let keys = this.#tags.get(tag);
    if (!keys) {
      keys = new Set();
      this.#tags.set(tag, keys);
    }
    return keys;
  }
}

const bounded = (value: number, min: number, max: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(name + ' must be between ' + min + ' and ' + max);
  }
  return value;
};
