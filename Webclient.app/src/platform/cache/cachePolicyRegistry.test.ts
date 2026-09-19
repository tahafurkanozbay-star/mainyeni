import { describe, expect, it } from 'vitest';
import { CachePolicyRegistry } from './cachePolicyRegistry';

describe('CachePolicyRegistry', () => {
  it('registers and resolves an explicit namespace policy', () => {
    const registry = new CachePolicyRegistry();
    const policy = registry.register({
      namespace: 'catalog',
      classification: 'public',
      ttlMs: 60000,
      staleWhileRevalidateMs: 10000,
      allowedTags: ['places', 'district:1'],
    });

    const resolved = registry.resolve({
      namespace: 'catalog',
      method: 'GET',
      tags: ['places'],
    });

    expect(policy).toMatchObject({
      namespace: 'catalog',
      classification: 'public',
      ttlMs: 60000,
      staleWhileRevalidateMs: 10000,
      enabled: true,
    });
    expect(resolved.decision).toMatchObject({
      cacheable: true,
      mode: 'stale-while-revalidate',
      ttlMs: 60000,
      staleWhileRevalidateMs: 10000,
    });
    expect(resolved.tags).toEqual(['places']);
  });

  it('fails closed for an unregistered namespace', () => {
    const registry = new CachePolicyRegistry();
    expect(() => registry.resolve({ namespace: 'unknown' }))
      .toThrow('no cache policy is registered');
  });

  it('preserves previous fields during partial policy updates', () => {
    const registry = new CachePolicyRegistry();
    registry.register({
      namespace: 'catalog',
      classification: 'public',
      ttlMs: 50000,
      staleWhileRevalidateMs: 5000,
      allowedTags: ['places'],
    });

    const updated = registry.register({
      namespace: 'catalog',
      ttlMs: 25000,
    });

    expect(updated).toMatchObject({
      classification: 'public',
      ttlMs: 25000,
      staleWhileRevalidateMs: 5000,
      allowedTags: ['places'],
      enabled: true,
    });
  });

  it('can explicitly disable cache admission for a namespace', () => {
    const registry = new CachePolicyRegistry();
    registry.register({
      namespace: 'catalog',
      classification: 'public',
      enabled: false,
    });

    expect(registry.resolve({ namespace: 'catalog' }).decision)
      .toMatchObject({
        cacheable: false,
        mode: 'network-only',
        reason: 'not-explicitly-cacheable',
      });
  });

  it('inherits personal data classification into fail-closed policy decisions', () => {
    const registry = new CachePolicyRegistry();
    registry.register({
      namespace: 'profile',
      classification: 'personal',
      allowedTags: ['profile'],
    });

    expect(registry.resolve({
      namespace: 'profile',
      method: 'GET',
      tags: ['profile'],
    }).decision).toMatchObject({
      cacheable: false,
      reason: 'sensitive-data',
    });
  });

  it('rejects authentication-bearing requests even for public namespaces', () => {
    const registry = new CachePolicyRegistry();
    registry.register({
      namespace: 'catalog',
      classification: 'public',
    });

    expect(registry.resolve({
      namespace: 'catalog',
      authenticated: true,
    }).decision).toMatchObject({
      cacheable: false,
      reason: 'authorization',
    });
    expect(registry.resolve({
      namespace: 'catalog',
      containsAuthorization: true,
    }).decision).toMatchObject({
      cacheable: false,
      reason: 'authorization',
    });
  });

  it('rejects request tags outside the namespace allowlist', () => {
    const registry = new CachePolicyRegistry();
    registry.register({
      namespace: 'catalog',
      allowedTags: ['places'],
    });

    expect(() => registry.resolve({
      namespace: 'catalog',
      tags: ['roads'],
    })).toThrow('cache tag is not allowed');
  });

  it('accepts deduplicated request tags from the allowlist', () => {
    const registry = new CachePolicyRegistry();
    registry.register({
      namespace: 'catalog',
      allowedTags: ['places', 'roads'],
    });

    const resolved = registry.resolve({
      namespace: 'catalog',
      tags: ['places', 'places', 'roads'],
    });
    expect(resolved.tags).toEqual(['places', 'roads']);
  });

  it('allows bounded per-request freshness overrides', () => {
    const registry = new CachePolicyRegistry();
    registry.register({
      namespace: 'catalog',
      classification: 'public',
      ttlMs: 60000,
      staleWhileRevalidateMs: 10000,
    });

    const resolved = registry.resolve({
      namespace: 'catalog',
      ttlMs: 5000,
      staleWhileRevalidateMs: 1000,
    });
    expect(resolved.decision).toMatchObject({
      cacheable: true,
      ttlMs: 5000,
      staleWhileRevalidateMs: 1000,
    });
  });

  it('inherits method safety from the central cache policy', () => {
    const registry = new CachePolicyRegistry();
    registry.register({
      namespace: 'catalog',
      classification: 'public',
    });

    expect(registry.resolve({
      namespace: 'catalog',
      method: 'POST',
    }).decision).toMatchObject({
      cacheable: false,
      reason: 'unsafe-method',
    });
  });

  it('bounds the number of namespace policies', () => {
    const registry = new CachePolicyRegistry({ maxPolicies: 1 });
    registry.register({ namespace: 'catalog' });
    expect(() => registry.register({ namespace: 'search' }))
      .toThrow('cache policy registry capacity is exhausted');

    registry.register({ namespace: 'catalog', ttlMs: 1000 });
    expect(registry.snapshot()).toEqual({ policies: 1, maxPolicies: 1 });
  });

  it('unregisters policies deterministically', () => {
    const registry = new CachePolicyRegistry();
    registry.register({ namespace: 'catalog' });

    expect(registry.unregister('catalog')).toBe(true);
    expect(registry.unregister('catalog')).toBe(false);
    expect(registry.get('catalog')).toBeUndefined();
  });

  it('lists policies in deterministic namespace order', () => {
    const registry = new CachePolicyRegistry();
    registry.register({ namespace: 'search' });
    registry.register({ namespace: 'catalog' });

    expect(registry.list().map((policy) => policy.namespace))
      .toEqual(['catalog', 'search']);
  });

  it('returns immutable policy and tag views', () => {
    const registry = new CachePolicyRegistry();
    const policy = registry.register({
      namespace: 'catalog',
      allowedTags: ['places'],
    });
    const listed = registry.list();

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowedTags)).toBe(true);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
  });

  it('rejects unsafe durations and tag limits', () => {
    const registry = new CachePolicyRegistry({ maxAllowedTagsPerPolicy: 1 });
    expect(() => registry.register({
      namespace: 'catalog',
      ttlMs: -1,
    })).toThrow(RangeError);
    expect(() => registry.register({
      namespace: 'catalog',
      staleWhileRevalidateMs: 600001,
    })).toThrow(RangeError);
    expect(() => registry.register({
      namespace: 'catalog',
      allowedTags: ['a', 'b'],
    })).toThrow(RangeError);
  });
});
