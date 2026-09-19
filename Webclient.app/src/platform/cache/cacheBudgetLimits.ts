import { cacheInteger, type CacheCapacityOptions } from './cacheContracts';

export interface CacheBudgetLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntriesPerNamespace: number;
  readonly maxBytesPerNamespace: number;
  readonly maxEntryBytes: number;
  readonly maxNamespaces: number;
  readonly maxTagsPerEntry: number;
  readonly maxTagLength: number;
  readonly maxKeyLength: number;
  readonly maxNamespaceLength: number;
  readonly historyLimit: number;
}

export const normalizeCacheBudget = (
  options: CacheCapacityOptions = {},
): CacheBudgetLimits => {
  const maxEntries = cacheInteger('maxEntries', options.maxEntries ?? 512, 1, 100000);
  const maxBytes = cacheInteger('maxBytes', options.maxBytes ?? 33554432, 1024, 1073741824);
  return Object.freeze({
    maxEntries,
    maxBytes,
    maxEntriesPerNamespace: cacheInteger(
      'maxEntriesPerNamespace',
      options.maxEntriesPerNamespace ?? Math.min(192, maxEntries),
      1,
      maxEntries,
    ),
    maxBytesPerNamespace: cacheInteger(
      'maxBytesPerNamespace',
      options.maxBytesPerNamespace ?? Math.min(12582912, maxBytes),
      1,
      maxBytes,
    ),
    maxEntryBytes: cacheInteger(
      'maxEntryBytes',
      options.maxEntryBytes ?? Math.min(2097152, maxBytes),
      1,
      maxBytes,
    ),
    maxNamespaces: cacheInteger('maxNamespaces', options.maxNamespaces ?? 64, 1, 10000),
    maxTagsPerEntry: cacheInteger('maxTagsPerEntry', options.maxTagsPerEntry ?? 16, 0, 128),
    maxTagLength: cacheInteger('maxTagLength', options.maxTagLength ?? 128, 1, 512),
    maxKeyLength: cacheInteger('maxKeyLength', options.maxKeyLength ?? 2048, 32, 16384),
    maxNamespaceLength: cacheInteger(
      'maxNamespaceLength',
      options.maxNamespaceLength ?? 96,
      1,
      512,
    ),
    historyLimit: cacheInteger('historyLimit', options.historyLimit ?? 256, 0, 4096),
  });
};
