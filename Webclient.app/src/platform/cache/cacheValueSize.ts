import { CacheContractError } from './cacheContracts';

export interface CacheValueSizeOptions {
  readonly maxDepth?: number;
  readonly maxVisited?: number;
}

export const estimateCacheValueBytes = (
  value: unknown,
  options: CacheValueSizeOptions = {},
): number => {
  const maxDepth = options.maxDepth ?? 8;
  const maxVisited = options.maxVisited ?? 10000;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 32) {
    throw new RangeError('maxDepth must be between 1 and 32');
  }
  if (!Number.isSafeInteger(maxVisited) || maxVisited < 1 || maxVisited > 1000000) {
    throw new RangeError('maxVisited must be between 1 and 1000000');
  }

  const seen = new Set<object>();
  let visited = 0;
  const measure = (current: unknown, depth: number): number => {
    visited += 1;
    if (visited > maxVisited) {
      throw new CacheContractError('invalid-byte-size', 'cache value exceeded item limit');
    }
    if (current === null || current === undefined) return 4;
    if (typeof current === 'boolean') return 4;
    if (typeof current === 'number') return 8;
    if (typeof current === 'bigint') return Math.max(8, current.toString().length * 2);
    if (typeof current === 'string') return Math.max(2, current.length * 2);
    if (typeof current === 'function' || typeof current === 'symbol') {
      throw new CacheContractError('invalid-byte-size', 'cache value contains unsupported data');
    }
    if (depth >= maxDepth) {
      throw new CacheContractError('invalid-byte-size', 'cache value exceeded depth limit');
    }
    if (seen.has(current)) {
      throw new CacheContractError('invalid-byte-size', 'cache value contains a cycle');
    }

    seen.add(current);
    try {
      if (current instanceof ArrayBuffer) return Math.max(1, current.byteLength);
      if (ArrayBuffer.isView(current)) return Math.max(1, current.byteLength);
      if (current instanceof Date) return 16;
      if (Array.isArray(current)) {
        return 16 + current.reduce((sum, item) => sum + measure(item, depth + 1), 0);
      }

      let bytes = 32;
      for (const [key, item] of Object.entries(current)) {
        bytes += key.length * 2;
        bytes += measure(item, depth + 1);
      }
      return bytes;
    } finally {
      seen.delete(current);
    }
  };

  return Math.max(1, measure(value, 0));
};
