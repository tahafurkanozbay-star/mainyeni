export type OfflineRequestClass = 'navigation' | 'configuration' | 'static-asset' | 'gis-data' | 'mutation' | 'unknown';
export type OfflineStrategy = 'network-only' | 'network-first' | 'cache-first' | 'stale-while-revalidate' | 'deny';

export interface OfflinePolicyInput {
  method?: string;
  url?: string;
  requestClass?: OfflineRequestClass;
  authenticated?: boolean;
  sensitive?: boolean;
  cacheable?: boolean;
  online?: boolean;
}

export interface OfflineDecision {
  readonly requestClass: OfflineRequestClass;
  readonly strategy: OfflineStrategy;
  readonly allowCacheRead: boolean;
  readonly allowCacheWrite: boolean;
  readonly allowNetwork: boolean;
  readonly maxAgeMs: number;
  readonly reason: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const STATIC_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff', '.woff2', '.json'
]);

const normalizeMethod = (value: unknown): string => String(value || 'GET').trim().toUpperCase();

const normalizePath = (value: unknown): string => {
  const raw = String(value || '/');
  try {
    const base = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://localhost.invalid';
    const parsed = new URL(raw, base);
    return parsed.pathname || '/';
  } catch (_error) {
    return '/';
  }
};

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
};

export const classifyOfflineRequest = (input: OfflinePolicyInput = {}): OfflineRequestClass => {
  if (input.requestClass) return input.requestClass;
  const method = normalizeMethod(input.method);
  if (!SAFE_METHODS.has(method)) return 'mutation';

  const path = normalizePath(input.url);
  if (path === '/' || path.endsWith('.html')) return 'navigation';
  if (path.startsWith('/api/')) {
    if (/\/(config|configuration|appsettings|gis\/config)/i.test(path)) return 'configuration';
    return 'gis-data';
  }
  if (STATIC_EXTENSIONS.has(extensionOf(path))) return 'static-asset';
  return 'unknown';
};

const decision = (
  requestClass: OfflineRequestClass,
  strategy: OfflineStrategy,
  allowCacheRead: boolean,
  allowCacheWrite: boolean,
  allowNetwork: boolean,
  maxAgeMs: number,
  reason: string
): OfflineDecision => Object.freeze({
  requestClass,
  strategy,
  allowCacheRead,
  allowCacheWrite,
  allowNetwork,
  maxAgeMs,
  reason
});

/**
 * Pure offline policy. It does not register a service worker or persist API
 * responses by itself. Sensitive/authenticated GIS payloads remain network-only.
 */
export const decideOfflineStrategy = (input: OfflinePolicyInput = {}): OfflineDecision => {
  const method = normalizeMethod(input.method);
  const requestClass = classifyOfflineRequest(input);
  const online = input.online !== false;
  const sensitive = input.sensitive === true || input.authenticated === true;
  const explicitlyCacheable = input.cacheable === true;

  if (!SAFE_METHODS.has(method) || requestClass === 'mutation') {
    return decision(requestClass, online ? 'network-only' : 'deny', false, false, online, 0,
      online ? 'mutation-network-only' : 'mutation-offline-denied');
  }

  if (sensitive) {
    return decision(requestClass, online ? 'network-only' : 'deny', false, false, online, 0,
      online ? 'sensitive-network-only' : 'sensitive-offline-denied');
  }

  if (requestClass === 'static-asset') {
    return decision(requestClass, 'cache-first', true, true, online, 7 * 24 * 60 * 60 * 1000,
      'immutable-or-versioned-static-asset');
  }

  if (requestClass === 'navigation') {
    return decision(requestClass, 'network-first', true, true, online, 24 * 60 * 60 * 1000,
      'application-shell-navigation');
  }

  if (requestClass === 'configuration') {
    return decision(requestClass, 'network-first', true, true, online, 5 * 60 * 1000,
      'bounded-public-configuration');
  }

  if (requestClass === 'gis-data') {
    if (!explicitlyCacheable) {
      return decision(requestClass, online ? 'network-only' : 'deny', false, false, online, 0,
        online ? 'gis-data-requires-explicit-cache-opt-in' : 'gis-data-not-available-offline');
    }
    return decision(requestClass, 'stale-while-revalidate', true, true, online, 60 * 1000,
      'explicit-nonsensitive-gis-cache');
  }

  if (explicitlyCacheable) {
    return decision(requestClass, 'network-first', true, true, online, 60 * 1000,
      'explicit-cache-opt-in');
  }

  return decision(requestClass, online ? 'network-only' : 'deny', false, false, online, 0,
    online ? 'default-network-only' : 'offline-no-safe-cache-contract');
};

export interface OfflineCacheRecord<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly storedAt: number;
  readonly expiresAt: number;
}

export class OfflineMemoryStore<T = unknown> {
  private readonly entries = new Map<string, OfflineCacheRecord<T>>();
  private readonly maxEntries: number;
  private readonly clock: () => number;

  constructor(options: { maxEntries?: number; clock?: () => number } = {}) {
    const parsed = Number.parseInt(String(options.maxEntries ?? 80), 10);
    this.maxEntries = Number.isFinite(parsed) ? Math.max(1, Math.min(500, parsed)) : 80;
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  }

  get(key: string): T | undefined {
    const record = this.entries.get(String(key));
    if (!record) return undefined;
    if (record.expiresAt <= this.clock()) {
      this.entries.delete(String(key));
      return undefined;
    }
    this.entries.delete(String(key));
    this.entries.set(String(key), record);
    return record.value;
  }

  set(key: string, value: T, maxAgeMs: number): T {
    const ttl = Math.max(0, Math.min(7 * 24 * 60 * 60 * 1000, Number(maxAgeMs) || 0));
    if (ttl <= 0) return value;
    const now = this.clock();
    const normalizedKey = String(key);
    this.entries.delete(normalizedKey);
    this.entries.set(normalizedKey, Object.freeze({
      key: normalizedKey,
      value,
      storedAt: now,
      expiresAt: now + ttl
    }));
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  delete(key: string): boolean {
    return this.entries.delete(String(key));
  }

  clear(): void {
    this.entries.clear();
  }

  prune(): number {
    const now = this.clock();
    let removed = 0;
    for (const [key, record] of Array.from(this.entries.entries())) {
      if (record.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }
}

export const createOfflineMemoryStore = <T = unknown>(
  options: { maxEntries?: number; clock?: () => number } = {}
) => new OfflineMemoryStore<T>(options);
