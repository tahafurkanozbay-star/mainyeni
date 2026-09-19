import { describe, expect, it } from 'vitest';
import { evaluateCachePolicy } from './cachePolicy';

describe('evaluateCachePolicy', () => {
  it('admits only explicitly cacheable public/internal GET or HEAD responses', () => {
    expect(evaluateCachePolicy({ method: 'GET', classification: 'public', explicitCacheable: true, ttlMs: 5_000 })).toMatchObject({ cacheable: true, mode: 'fresh', ttlMs: 5_000 });
    expect(evaluateCachePolicy({ method: 'HEAD', classification: 'internal', explicitCacheable: true, ttlMs: 5_000, staleWhileRevalidateMs: 2_000 })).toMatchObject({ cacheable: true, mode: 'stale-while-revalidate', staleWhileRevalidateMs: 2_000 });
  });

  it('fails closed for mutation methods', () => {
    expect(evaluateCachePolicy({ method: 'POST', classification: 'public', explicitCacheable: true })).toMatchObject({ cacheable: false, reason: 'unsafe-method', ttlMs: 0 });
  });

  it.each(['personal', 'sensitive'] as const)('rejects %s data', (classification) => {
    expect(evaluateCachePolicy({ classification, explicitCacheable: true })).toMatchObject({ cacheable: false, reason: 'sensitive-data' });
  });

  it('rejects authenticated and authorization-bearing responses', () => {
    expect(evaluateCachePolicy({ classification: 'public', explicitCacheable: true, authenticated: true })).toMatchObject({ cacheable: false, reason: 'authorization' });
    expect(evaluateCachePolicy({ classification: 'public', explicitCacheable: true, containsAuthorization: true })).toMatchObject({ cacheable: false, reason: 'authorization' });
  });

  it('requires explicit cache admission and clamps durations', () => {
    expect(evaluateCachePolicy({ classification: 'public' })).toMatchObject({ cacheable: false, reason: 'not-explicitly-cacheable' });
    expect(evaluateCachePolicy({ classification: 'public', explicitCacheable: true, ttlMs: Number.POSITIVE_INFINITY })).toMatchObject({ cacheable: true, ttlMs: 30_000 });
    expect(evaluateCachePolicy({ classification: 'public', explicitCacheable: true, ttlMs: 9_999_999 })).toMatchObject({ ttlMs: 3_600_000 });
  });
});
