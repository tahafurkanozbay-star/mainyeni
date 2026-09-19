import { describe, expect, it } from 'vitest';
import {
  cacheKeyNamespace,
  createCacheKey,
  sameCacheIdentity,
} from './cacheKey';

describe('cacheKey', () => {
  it('normalizes method, namespace and query ordering', () => {
    const first = createCacheKey({
      namespace: ' search ',
      method: ' get ',
      url: '/api/items?b=2&a=1',
    });
    const second = createCacheKey({
      namespace: 'search',
      method: 'GET',
      url: '/api/items?a=1&b=2',
    });

    expect(first).toMatchObject({
      namespace: 'search',
      method: 'GET',
      resource: '/api/items?a=1&b=2',
    });
    expect(first.serialized).toBe(second.serialized);
  });

  it('preserves repeated query parameters deterministically', () => {
    const key = createCacheKey({
      namespace: 'layers',
      url: '/query?id=3&id=1&id=2',
    });
    expect(key.resource).toBe('/query?id=1&id=2&id=3');
  });

  it('keeps external origins in the identity', () => {
    const a = createCacheKey({
      namespace: 'external',
      url: 'https://one.example/data?q=1',
    });
    const b = createCacheKey({
      namespace: 'external',
      url: 'https://two.example/data?q=1',
    });
    expect(a.serialized).not.toBe(b.serialized);
    expect(a.resource).toBe('https://one.example/data?q=1');
  });

  it('does not embed credentials in cache identities', () => {
    expect(() => createCacheKey({
      namespace: 'unsafe',
      url: 'https://user:secret@example.test/data',
    })).toThrow('credentials');
  });

  it('supports bounded ignored query parameters', () => {
    const a = createCacheKey({
      namespace: 'search',
      url: '/items?q=park&trace=one',
      ignoredQueryParameters: ['trace'],
    });
    const b = createCacheKey({
      namespace: 'search',
      url: '/items?trace=two&q=park',
      ignoredQueryParameters: ['trace'],
    });
    expect(a.serialized).toBe(b.serialized);
    expect(a.resource).toBe('/items?q=park');
  });

  it('keeps non-ignored query changes distinct', () => {
    expect(sameCacheIdentity(
      { namespace: 'search', url: '/items?q=park' },
      { namespace: 'search', url: '/items?q=school' },
    )).toBe(false);
  });

  it('canonicalizes vary keys independently of insertion order', () => {
    const left = createCacheKey({
      namespace: 'tiles',
      url: '/tiles/1',
      vary: { locale: 'tr', format: 'json', dense: true, level: 2 },
    });
    const right = createCacheKey({
      namespace: 'tiles',
      url: '/tiles/1',
      vary: { level: 2, dense: true, format: 'json', locale: 'tr' },
    });
    expect(left.serialized).toBe(right.serialized);
    expect(left.vary).toEqual([
      'dense=true',
      'format=json',
      'level=2',
      'locale=tr',
    ]);
  });

  it('distinguishes null and undefined vary values', () => {
    const nullKey = createCacheKey({
      namespace: 'n',
      url: '/x',
      vary: { value: null },
    });
    const undefinedKey = createCacheKey({
      namespace: 'n',
      url: '/x',
      vary: { value: undefined },
    });
    expect(nullKey.serialized).not.toBe(undefinedKey.serialized);
  });

  it('rejects non-finite numeric vary values', () => {
    expect(() => createCacheKey({
      namespace: 'n',
      url: '/x',
      vary: { page: Number.NaN },
    })).toThrow('finite');
    expect(() => createCacheKey({
      namespace: 'n',
      url: '/x',
      vary: { page: Number.POSITIVE_INFINITY },
    })).toThrow('finite');
  });

  it('rejects malformed methods', () => {
    expect(() => createCacheKey({
      namespace: 'n',
      method: 'GET /admin',
      url: '/x',
    })).toThrow('invalid');
  });

  it('rejects empty namespaces and urls', () => {
    expect(() => createCacheKey({ namespace: ' ', url: '/x' })).toThrow();
    expect(() => createCacheKey({ namespace: 'n', url: ' ' })).toThrow();
  });

  it('bounds ignored parameter count', () => {
    expect(() => createCacheKey({
      namespace: 'n',
      url: '/x',
      ignoredQueryParameters: Array.from({ length: 33 }, (_, index) => 'p' + index),
    })).toThrow('more than 32');
  });

  it('bounds vary field count', () => {
    const vary = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => ['field' + index, String(index)]),
    );
    expect(() => createCacheKey({ namespace: 'n', url: '/x', vary })).toThrow('more than 32');
  });

  it('respects explicit serialized key size limits', () => {
    expect(() => createCacheKey({
      namespace: 'namespace',
      url: '/resource?value=' + 'x'.repeat(100),
      maximumLength: 32,
    })).toThrow();
  });

  it('extracts namespaces from serialized identities', () => {
    const key = createCacheKey({
      namespace: 'gis-search',
      url: '/api?q=park',
    });
    expect(cacheKeyNamespace(key.serialized)).toBe('gis-search');
  });

  it('rejects malformed serialized namespace extraction', () => {
    expect(() => cacheKeyNamespace('missing-separator')).toThrow();
    expect(() => cacheKeyNamespace('|GET|/x')).toThrow();
  });

  it('encodes whitespace and reserved values consistently', () => {
    const key = createCacheKey({
      namespace: 'search',
      url: '/x?q=kent%20rehberi&category=a%2Fb',
    });
    expect(key.resource).toBe('/x?category=a%2Fb&q=kent+rehberi');
  });

  it('treats duplicate ignored parameter names as one rule', () => {
    const key = createCacheKey({
      namespace: 'search',
      url: '/x?a=1&trace=2',
      ignoredQueryParameters: ['trace', 'trace'],
    });
    expect(key.resource).toBe('/x?a=1');
  });
});
