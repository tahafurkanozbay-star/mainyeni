import type {
  OfflineCacheLimits,
  OfflinePolicy,
  OfflineRequestDecision,
  OfflineRequestKind,
  OfflineStrategy,
} from './contracts';

const DEFAULT_STATIC_LIMITS: OfflineCacheLimits = Object.freeze({
  maxEntries: 180,
  maxBytes: 48 * 1024 * 1024,
  maxEntryBytes: 6 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
});

const DEFAULT_API_LIMITS: OfflineCacheLimits = Object.freeze({
  maxEntries: 80,
  maxBytes: 16 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024,
  maxAgeMs: 30 * 60 * 1000,
});

const DEFAULT_STATIC_EXTENSIONS = Object.freeze([
  '.js', '.mjs', '.css', '.json', '.webmanifest',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
] as const);

const DEFAULT_SENSITIVE_QUERY_KEYS = Object.freeze([
  'access_token', 'apikey', 'api_key', 'authorization', 'auth', 'code',
  'credential', 'jwt', 'key', 'password', 'secret', 'session', 'signature',
  'sig', 'token',
] as const);

const CACHE_CONTROL_PRIVATE = /(?:^|,)\s*(?:private|no-store)\b/iu;
const CACHE_CONTROL_NO_CACHE = /(?:^|,)\s*no-cache\b/iu;
const STATIC_PATH = /(?:^|\/)(?:assets|images|fonts)\//u;
const API_PATH = /^\/api(?:\/|$)/u;

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const normalizeToken = (value: unknown, fallback: string): string => {
  const text = String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]+/gu, '-');
  return (text || fallback).slice(0, 80);
};

const normalizeLimits = (
  value: Partial<OfflineCacheLimits> | undefined,
  fallback: OfflineCacheLimits,
): OfflineCacheLimits => Object.freeze({
  maxEntries: clampInteger(value?.maxEntries, fallback.maxEntries, 1, 5000),
  maxBytes: clampInteger(value?.maxBytes, fallback.maxBytes, 1024 * 1024, 512 * 1024 * 1024),
  maxEntryBytes: clampInteger(value?.maxEntryBytes, fallback.maxEntryBytes, 16 * 1024, 64 * 1024 * 1024),
  maxAgeMs: clampInteger(value?.maxAgeMs, fallback.maxAgeMs, 1000, 30 * 24 * 60 * 60 * 1000),
});

export interface CreateOfflinePolicyOptions {
  readonly cachePrefix?: string;
  readonly cacheVersion?: string;
  readonly staticCache?: Partial<OfflineCacheLimits>;
  readonly apiCache?: Partial<OfflineCacheLimits>;
  readonly navigationTimeoutMs?: number;
  readonly apiTimeoutMs?: number;
  readonly staticTimeoutMs?: number;
  readonly sensitiveQueryKeys?: readonly string[];
  readonly publicApiHeader?: string;
  readonly publicApiHeaderValue?: string;
  readonly allowedStaticExtensions?: readonly string[];
}

export const createOfflinePolicy = (
  options: CreateOfflinePolicyOptions = {},
): OfflinePolicy => Object.freeze({
  cachePrefix: normalizeToken(options.cachePrefix, 'kent-rehberi'),
  cacheVersion: normalizeToken(options.cacheVersion, 'v1'),
  staticCache: normalizeLimits(options.staticCache, DEFAULT_STATIC_LIMITS),
  apiCache: normalizeLimits(options.apiCache, DEFAULT_API_LIMITS),
  navigationTimeoutMs: clampInteger(options.navigationTimeoutMs, 4500, 500, 30_000),
  apiTimeoutMs: clampInteger(options.apiTimeoutMs, 8000, 500, 60_000),
  staticTimeoutMs: clampInteger(options.staticTimeoutMs, 6000, 500, 60_000),
  sensitiveQueryKeys: Object.freeze(
    [...new Set((options.sensitiveQueryKeys ?? DEFAULT_SENSITIVE_QUERY_KEYS)
      .map((key) => String(key).trim().toLowerCase())
      .filter(Boolean))].sort(),
  ),
  publicApiHeader: String(options.publicApiHeader ?? 'x-kent-rehberi-offline').trim().toLowerCase(),
  publicApiHeaderValue: String(options.publicApiHeaderValue ?? 'public').trim().toLowerCase(),
  allowedStaticExtensions: Object.freeze(
    [...new Set((options.allowedStaticExtensions ?? DEFAULT_STATIC_EXTENSIONS)
      .map((extension) => String(extension).trim().toLowerCase())
      .filter((extension) => extension.startsWith('.')))].sort(),
  ),
});

export const offlineCacheName = (
  policy: OfflinePolicy,
  kind: 'static' | 'api',
): string => policy.cachePrefix + '-' + policy.cacheVersion + '-' + kind;

const hasSensitiveQuery = (url: URL, policy: OfflinePolicy): boolean => {
  for (const key of url.searchParams.keys()) {
    if (policy.sensitiveQueryKeys.includes(key.toLowerCase())) return true;
  }
  return false;
};

const hasUnsafeRequestHeader = (request: Request): boolean => {
  const blocked = ['authorization', 'proxy-authorization'];
  return blocked.some((header) => request.headers.has(header));
};

const isStaticPath = (url: URL, policy: OfflinePolicy): boolean => {
  if (STATIC_PATH.test(url.pathname)) return true;
  const lower = url.pathname.toLowerCase();
  return policy.allowedStaticExtensions.some((extension) => lower.endsWith(extension));
};

const requestDestinationIsStatic = (request: Request): boolean => [
  'audio', 'font', 'image', 'manifest', 'script', 'style', 'video', 'worker',
].includes(request.destination);

const decision = (
  kind: OfflineRequestKind,
  strategy: OfflineStrategy,
  cacheName: string | null,
  cacheable: boolean,
  reason: string,
  url: string | null,
): OfflineRequestDecision => Object.freeze({
  kind, strategy, cacheName, cacheable, reason, url,
});

export const classifyOfflineRequest = (
  request: Request,
  origin: string,
  policy: OfflinePolicy = createOfflinePolicy(),
): OfflineRequestDecision => {
  if (request.method.toUpperCase() !== 'GET') {
    return decision('bypass', 'network-only', null, false, 'method-not-cacheable', null);
  }
  if (hasUnsafeRequestHeader(request) || request.headers.has('range')) {
    return decision('bypass', 'network-only', null, false, 'sensitive-or-range-header', null);
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return decision('bypass', 'network-only', null, false, 'invalid-url', null);
  }
  if (url.origin !== origin) {
    return decision('bypass', 'network-only', null, false, 'cross-origin', url.href);
  }
  if (hasSensitiveQuery(url, policy)) {
    return decision('bypass', 'network-only', null, false, 'sensitive-query', url.href);
  }

  if (request.mode === 'navigate' || request.destination === 'document') {
    return decision(
      'navigation',
      'network-first',
      offlineCacheName(policy, 'static'),
      true,
      'same-origin-navigation',
      url.href,
    );
  }

  if (API_PATH.test(url.pathname)) {
    return decision(
      'api-read',
      'network-first',
      offlineCacheName(policy, 'api'),
      false,
      'api-requires-public-response-opt-in',
      url.href,
    );
  }

  if (requestDestinationIsStatic(request) || isStaticPath(url, policy)) {
    return decision(
      'static',
      'stale-while-revalidate',
      offlineCacheName(policy, 'static'),
      true,
      'same-origin-static',
      url.href,
    );
  }

  return decision('bypass', 'network-only', null, false, 'unclassified-get', url.href);
};

const responseCacheControl = (response: Response): string =>
  String(response.headers.get('cache-control') ?? '').toLowerCase();

const responseIsPublicApi = (response: Response, policy: OfflinePolicy): boolean => {
  const value = String(response.headers.get(policy.publicApiHeader) ?? '').trim().toLowerCase();
  if (value === policy.publicApiHeaderValue) return true;
  const cacheControl = responseCacheControl(response);
  return /(?:^|,)\s*public\b/iu.test(cacheControl) && !CACHE_CONTROL_PRIVATE.test(cacheControl);
};

export const canCacheOfflineResponse = (
  request: Request,
  response: Response,
  kind: Exclude<OfflineRequestKind, 'bypass'>,
  origin: string,
  policy: OfflinePolicy = createOfflinePolicy(),
): boolean => {
  if (!response || !response.ok) return false;
  if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.status === 206) return false;
  const cacheControl = responseCacheControl(response);
  if (CACHE_CONTROL_PRIVATE.test(cacheControl)) return false;
  if (response.headers.get('vary')?.trim() === '*') return false;

  let responseUrl: URL | null = null;
  try {
    responseUrl = response.url ? new URL(response.url) : new URL(request.url);
  } catch {
    return false;
  }
  if (responseUrl.origin !== origin) return false;

  if (kind === 'api-read') return responseIsPublicApi(response, policy);
  if (kind === 'navigation') return !CACHE_CONTROL_NO_CACHE.test(cacheControl);
  return true;
};

export const timeoutForOfflineRequest = (
  kind: OfflineRequestKind,
  policy: OfflinePolicy,
): number => {
  if (kind === 'navigation') return policy.navigationTimeoutMs;
  if (kind === 'api-read') return policy.apiTimeoutMs;
  return policy.staticTimeoutMs;
};

export const limitsForOfflineRequest = (
  kind: OfflineRequestKind,
  policy: OfflinePolicy,
): OfflineCacheLimits => kind === 'api-read' ? policy.apiCache : policy.staticCache;

export const offlinePolicyFingerprint = (policy: OfflinePolicy): string => {
  const source = JSON.stringify({
    cachePrefix: policy.cachePrefix,
    cacheVersion: policy.cacheVersion,
    staticCache: policy.staticCache,
    apiCache: policy.apiCache,
    navigationTimeoutMs: policy.navigationTimeoutMs,
    apiTimeoutMs: policy.apiTimeoutMs,
    staticTimeoutMs: policy.staticTimeoutMs,
    sensitiveQueryKeys: policy.sensitiveQueryKeys,
    publicApiHeader: policy.publicApiHeader,
    publicApiHeaderValue: policy.publicApiHeaderValue,
    allowedStaticExtensions: policy.allowedStaticExtensions,
  });
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
