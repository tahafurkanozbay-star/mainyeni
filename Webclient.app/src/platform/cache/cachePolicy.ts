export type CacheDataClassification = 'public' | 'internal' | 'personal' | 'sensitive';
export type CacheFreshnessMode = 'fresh' | 'stale-while-revalidate' | 'network-only';

export interface CachePolicyInput {
  readonly method?: string;
  readonly classification?: CacheDataClassification;
  readonly authenticated?: boolean;
  readonly containsAuthorization?: boolean;
  readonly explicitCacheable?: boolean;
  readonly ttlMs?: number;
  readonly staleWhileRevalidateMs?: number;
}

export interface CachePolicyDecision {
  readonly cacheable: boolean;
  readonly mode: CacheFreshnessMode;
  readonly ttlMs: number;
  readonly staleWhileRevalidateMs: number;
  readonly reason: 'cacheable' | 'unsafe-method' | 'sensitive-data' | 'authorization' | 'not-explicitly-cacheable';
}

const clampDuration = (value: unknown, fallback: number, maximum: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(0, Math.trunc(parsed)));
};

/**
 * Central fail-closed cache admission policy. It intentionally does not infer that
 * authenticated or personal responses are safe to retain in browser memory.
 */
export const evaluateCachePolicy = (input: CachePolicyInput): CachePolicyDecision => {
  const method = String(input.method ?? 'GET').trim().toUpperCase();
  const classification = input.classification ?? 'internal';
  const ttlMs = clampDuration(input.ttlMs, 30_000, 60 * 60 * 1000);
  const staleWhileRevalidateMs = clampDuration(input.staleWhileRevalidateMs, 0, 10 * 60 * 1000);

  if (method !== 'GET' && method !== 'HEAD') {
    return Object.freeze({ cacheable: false, mode: 'network-only', ttlMs: 0, staleWhileRevalidateMs: 0, reason: 'unsafe-method' });
  }
  if (classification === 'personal' || classification === 'sensitive') {
    return Object.freeze({ cacheable: false, mode: 'network-only', ttlMs: 0, staleWhileRevalidateMs: 0, reason: 'sensitive-data' });
  }
  if (input.authenticated || input.containsAuthorization) {
    return Object.freeze({ cacheable: false, mode: 'network-only', ttlMs: 0, staleWhileRevalidateMs: 0, reason: 'authorization' });
  }
  if (input.explicitCacheable !== true || ttlMs === 0) {
    return Object.freeze({ cacheable: false, mode: 'network-only', ttlMs: 0, staleWhileRevalidateMs: 0, reason: 'not-explicitly-cacheable' });
  }
  return Object.freeze({
    cacheable: true,
    mode: staleWhileRevalidateMs > 0 ? 'stale-while-revalidate' : 'fresh',
    ttlMs,
    staleWhileRevalidateMs,
    reason: 'cacheable',
  });
};
