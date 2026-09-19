import { cacheInteger, type CacheCapacityOptions } from './cacheContracts';

export interface CacheBudgetLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}
