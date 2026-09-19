import {
  cacheKey,
  cacheNamespace,
  immutableStringList,
  type CacheKey,
  type CacheNamespace,
} from './cacheContracts';

export interface CacheKeyRequest {
  readonly namespace: string;
  readonly method?: string;
  readonly url: string;
  readonly vary?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly ignoredQueryParameters?: readonly string[];
  readonly maximumLength?: number;
}

export interface ParsedCacheKey {
  readonly namespace: CacheNamespace;
  readonly method: string;
  readonly resource: string;
  readonly vary: readonly string[];
  readonly serialized: CacheKey;
}

const normalizeMethod = (value: string | undefined): string => {
  const method = (value ?? 'GET').trim().toUpperCase();
  if (!method || method.length > 16) throw new RangeError('cache method must contain 1-16 characters');
  for (const character of method) {
    const code = character.charCodeAt(0);
    const alpha = code >= 65 && code <= 90;
    if (!alpha && character !== '-') throw new RangeError('cache method contains an invalid character');
  }
  return method;
};

const percentEncode = (value: string): string =>
  encodeURIComponent(value).replaceAll('%20', '+');

const canonicalQuery = (
  url: URL,
  ignored: ReadonlySet<string>,
): string => {
  const pairs: Array<readonly [string, string]> = [];
  url.searchParams.forEach((value, key) => {
    if (!ignored.has(key)) pairs.push(Object.freeze([key, value]));
  });
  pairs.sort((left, right) =>
    left[0].localeCompare(right[0])
    || left[1].localeCompare(right[1]));

  return pairs
    .map(([key, value]) => percentEncode(key) + '=' + percentEncode(value))
    .join('&');
};

const canonicalResource = (
  input: string,
  ignored: ReadonlySet<string>,
): string => {
  const trimmed = input.trim();
  if (!trimmed) throw new RangeError('cache url must not be empty');

  let parsed: URL;
  try {
    parsed = new URL(trimmed, 'https://cache.local');
  } catch {
    throw new RangeError('cache url is invalid');
  }

  if (parsed.username || parsed.password) {
    throw new RangeError('cache url cannot contain credentials');
  }

  const external = parsed.origin !== 'https://cache.local';
  const path = parsed.pathname || '/';
  const query = canonicalQuery(parsed, ignored);
  const origin = external ? parsed.origin.toLowerCase() : '';
  return origin + path + (query ? '?' + query : '');
};

const varyValue = (
  value: string | number | boolean | null | undefined,
): string => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('cache vary number must be finite');
    return String(value);
  }
  return value.trim();
};

const canonicalVary = (
  vary: CacheKeyRequest['vary'],
): readonly string[] => {
  if (!vary) return Object.freeze([]);
  const keys = Object.keys(vary).sort((left, right) => left.localeCompare(right));
  if (keys.length > 32) throw new RangeError('cache vary cannot contain more than 32 fields');

  const pairs = keys.map((key) => {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey || normalizedKey.length > 64) {
      throw new RangeError('cache vary key must contain 1-64 characters');
    }
    return percentEncode(normalizedKey) + '=' + percentEncode(varyValue(vary[key]));
  });
  return Object.freeze(pairs);
};

export const createCacheKey = (
  request: CacheKeyRequest,
): ParsedCacheKey => {
  const namespace = cacheNamespace(request.namespace);
  const method = normalizeMethod(request.method);
  const ignored = new Set(immutableStringList(request.ignoredQueryParameters, {
    maximumItems: 32,
    maximumLength: 96,
    label: 'ignored query parameter',
  }));
  const resource = canonicalResource(request.url, ignored);
  const vary = canonicalVary(request.vary);
  const serialized = cacheKey(
    namespace + '|' + method + '|' + resource + (vary.length ? '|v:' + vary.join('&') : ''),
    request.maximumLength ?? 2048,
  );

  return Object.freeze({
    namespace,
    method,
    resource,
    vary,
    serialized,
  });
};

export const sameCacheIdentity = (
  left: CacheKeyRequest,
  right: CacheKeyRequest,
): boolean => createCacheKey(left).serialized === createCacheKey(right).serialized;

export const cacheKeyNamespace = (
  serialized: string,
): CacheNamespace => {
  const separator = serialized.indexOf('|');
  if (separator <= 0) throw new RangeError('serialized cache key has no namespace');
  return cacheNamespace(serialized.slice(0, separator));
};
