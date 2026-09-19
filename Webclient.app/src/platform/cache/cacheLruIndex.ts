import { cacheKey, type CacheKey } from './cacheContracts';

export class CacheLruIndex {
  readonly #order = new Map<CacheKey, true>();

  touch(rawKey: string): void {
    const key = cacheKey(rawKey);
    this.#order.delete(key);
    this.#order.set(key, true);
  }

  remove(rawKey: string): boolean {
    return this.#order.delete(cacheKey(rawKey));
  }

  oldest(): CacheKey | undefined {
    return this.#order.keys().next().value;
  }

  keysOldestFirst(): readonly CacheKey[] {
    return Object.freeze([...this.#order.keys()]);
  }

  size(): number {
    return this.#order.size;
  }

  clear(): void {
    this.#order.clear();
  }

  assertContains(keys: ReadonlySet<CacheKey>): void {
    if (keys.size !== this.#order.size) {
      throw new Error('cache LRU index size mismatch');
    }
    for (const key of this.#order.keys()) {
      if (!keys.has(key)) throw new Error('cache LRU index contains an unknown key');
    }
  }
}
