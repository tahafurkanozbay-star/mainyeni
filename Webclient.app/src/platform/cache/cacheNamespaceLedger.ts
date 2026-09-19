import { cacheNamespace, type CacheNamespace } from './cacheContracts';

export interface CacheNamespaceUsage {
  readonly namespace: CacheNamespace;
  readonly entries: number;
  readonly bytes: number;
}

interface MutableUsage {
  entries: number;
  bytes: number;
}

export class CacheNamespaceLedger {
  readonly #usage = new Map<CacheNamespace, MutableUsage>();

  add(rawNamespace: string, bytes: number): void {
    const namespace = cacheNamespace(rawNamespace);
    validateBytes(bytes);
    const current = this.#usage.get(namespace) ?? { entries: 0, bytes: 0 };
    current.entries += 1;
    current.bytes += bytes;
    this.#usage.set(namespace, current);
  }

  remove(rawNamespace: string, bytes: number): void {
    const namespace = cacheNamespace(rawNamespace);
    validateBytes(bytes);
    const current = this.#usage.get(namespace);
    if (!current || current.entries <= 0 || current.bytes < bytes) {
      throw new Error('cache namespace ledger underflow for ' + namespace);
    }
    current.entries -= 1;
    current.bytes -= bytes;
    if (current.entries === 0) {
      if (current.bytes !== 0) throw new Error('cache namespace ledger byte leak');
      this.#usage.delete(namespace);
    }
  }

  usage(rawNamespace: string): CacheNamespaceUsage {
    const namespace = cacheNamespace(rawNamespace);
    const current = this.#usage.get(namespace);
    return Object.freeze({
      namespace,
      entries: current?.entries ?? 0,
      bytes: current?.bytes ?? 0,
    });
  }

  count(): number {
    return this.#usage.size;
  }

  all(): readonly CacheNamespaceUsage[] {
    return Object.freeze([...this.#usage.entries()]
      .map(([namespace, usage]) => Object.freeze({ namespace, ...usage }))
      .sort((left, right) => left.namespace.localeCompare(right.namespace)));
  }

  clear(): void {
    this.#usage.clear();
  }

  assertTotal(entries: number, bytes: number): void {
    let actualEntries = 0;
    let actualBytes = 0;
    for (const usage of this.#usage.values()) {
      actualEntries += usage.entries;
      actualBytes += usage.bytes;
    }
    if (actualEntries !== entries || actualBytes !== bytes) {
      throw new Error('cache namespace ledger total mismatch');
    }
  }
}

const validateBytes = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('cache byte size must be a positive safe integer');
  }
};
