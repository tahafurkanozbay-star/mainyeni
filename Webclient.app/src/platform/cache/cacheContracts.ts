export type CacheNamespace = string;
export type CacheKey = string;
export type CacheTag = string;
export type CacheEntryState = 'fresh' | 'stale' | 'expired';
export type CacheReadSource = 'memory' | 'loader' | 'stale-memory' | 'network-only';

export interface CacheClock {
  readonly now: () => number;
}

export interface CacheStoredValue<T> {
  readonly key: CacheKey;
  readonly namespace: CacheNamespace;
  readonly value: T;
  readonly createdAt: number;
  readonly refreshedAt: number;
  readonly freshUntil: number;
  readonly staleUntil: number;
  readonly byteSize: number;
  readonly tags: readonly CacheTag[];
  readonly version: number;
}

export interface CacheReadResult<T> {
  readonly hit: boolean;
  readonly state: CacheEntryState | 'miss';
  readonly source: CacheReadSource;
  readonly value?: T;
  readonly entry?: CacheStoredValue<T>;
}

export interface CacheWriteRequest<T> {
  readonly key: CacheKey;
  readonly namespace: CacheNamespace;
  readonly value: T;
  readonly ttlMs: number;
  readonly staleWhileRevalidateMs?: number;
  readonly byteSize?: number;
  readonly tags?: readonly string[];
  readonly version?: number;
}

export interface CacheCapacityOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxEntriesPerNamespace?: number;
  readonly maxBytesPerNamespace?: number;
  readonly maxEntryBytes?: number;
  readonly maxNamespaces?: number;
  readonly maxTagsPerEntry?: number;
  readonly maxTagLength?: number;
  readonly maxKeyLength?: number;
  readonly maxNamespaceLength?: number;
  readonly historyLimit?: number;
}

export type CacheRejectionReason =
  | 'invalid-key'
  | 'invalid-namespace'
  | 'invalid-duration'
  | 'invalid-byte-size'
  | 'entry-too-large'
  | 'namespace-limit'
  | 'disposed'
  | 'clock-regression';

export class CacheContractError extends Error {
  constructor(
    readonly code: CacheRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'CacheContractError';
  }
}

export const SYSTEM_CACHE_CLOCK: CacheClock = Object.freeze({
  now: () => Date.now(),
});

export const cacheInteger = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(name + ' must be an integer between ' + minimum + ' and ' + maximum);
  }
  return value;
};

export const cacheDuration = (
  name: string,
  value: number,
  maximum = 24 * 60 * 60 * 1000,
): number => {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new CacheContractError(
      'invalid-duration',
      name + ' must be a finite duration between 0 and ' + maximum + 'ms',
    );
  }
  return Math.trunc(value);
};

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

export const cacheText = (
  name: string,
  value: string,
  maximum: number,
  code: 'invalid-key' | 'invalid-namespace' = 'invalid-key',
): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || hasControlCharacter(normalized)) {
    throw new CacheContractError(
      code,
      name + ' must contain 1-' + maximum + ' printable characters',
    );
  }
  return normalized;
};

export const cacheTag = (value: string, maximum = 128): CacheTag =>
  cacheText('cache tag', value, maximum);

export const cacheNamespace = (value: string, maximum = 96): CacheNamespace =>
  cacheText('cache namespace', value, maximum, 'invalid-namespace');

export const cacheKey = (value: string, maximum = 2048): CacheKey =>
  cacheText('cache key', value, maximum, 'invalid-key');

export const immutableStringList = (
  values: readonly string[] | undefined,
  options: {
    readonly maximumItems: number;
    readonly maximumLength: number;
    readonly label: string;
  },
): readonly string[] => {
  if (!values || values.length === 0) return Object.freeze([]);
  if (values.length > options.maximumItems) {
    throw new RangeError(options.label + ' cannot contain more than ' + options.maximumItems + ' items');
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const item = cacheText(options.label, value, options.maximumLength);
    if (seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
  }
  return Object.freeze(normalized);
};

export const safeCacheNow = (
  clock: CacheClock,
  previous: number | undefined,
): number => {
  const now = clock.now();
  if (!Number.isFinite(now) || now < 0) {
    throw new CacheContractError('clock-regression', 'cache clock returned an invalid timestamp');
  }
  if (previous !== undefined && now < previous) {
    throw new CacheContractError('clock-regression', 'cache clock must be monotonic');
  }
  return now;
};

export const stateAt = (
  entry: Pick<CacheStoredValue<unknown>, 'freshUntil' | 'staleUntil'>,
  now: number,
): CacheEntryState => {
  if (now <= entry.freshUntil) return 'fresh';
  if (now <= entry.staleUntil) return 'stale';
  return 'expired';
};

export const cloneStoredValue = <T>(entry: CacheStoredValue<T>): CacheStoredValue<T> =>
  Object.freeze({
    ...entry,
    tags: Object.freeze([...entry.tags]),
  });
