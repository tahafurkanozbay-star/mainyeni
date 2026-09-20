import { describe, expect, test } from 'vitest';
import {
  assertApplicationEndpoint,
  endpointFingerprint,
  isSameOriginPath,
  joinApplicationPath,
  normalizeApplicationPath,
  stripApplicationQuery,
  withApplicationQuery,
} from './endpointPolicy';

describe('strict same-origin endpoint policy', () => {
  test('accepts normalized application paths and Unicode segments', () => {
    expect(isSameOriginPath('/api/search')).toBe(true);
    expect(isSameOriginPath('/api/arama/çankaya')).toBe(true);
    expect(normalizeApplicationPath('api//search/./items')).toBe('/api/search/items');
  });

  test.each([
    'https://example.com/api',
    '//example.com/api',
    '/api\\admin',
    '/api/%5cadmin',
    '/api/%0d%0aheader',
    '/api/%2e%2e/admin',
    '/api/%2E./admin',
    '/api/%2fadmin',
    '/api/%252e%252e/admin',
    '/api/%252fadmin',
    '/api/%E0%A4%A',
  ])('rejects unsafe routing material: %s', (value) => {
    expect(isSameOriginPath(value)).toBe(false);
    expect(() => assertApplicationEndpoint(value)).toThrow();
  });

  test('enforces path scopes after endpoint validation', () => {
    expect(assertApplicationEndpoint('/api/search/items', {
      allowedPrefixes: ['/api/search'],
    })).toBe('/api/search/items');

    expect(() => assertApplicationEndpoint('/api/admin', {
      allowedPrefixes: ['/api/search'],
    })).toThrow(/allowed path scope/i);
  });

  test('blocks encoded traversal before an allowlisted prefix can be bypassed', () => {
    expect(() => assertApplicationEndpoint('/api/search/%2e%2e/admin', {
      allowedPrefixes: ['/api/search'],
    })).toThrow();
    expect(() => assertApplicationEndpoint('/api/search/%252e%252e/admin', {
      allowedPrefixes: ['/api/search'],
    })).toThrow();
  });

  test('joins only safe path segments', () => {
    expect(joinApplicationPath('/api', 'search', 'items')).toBe('/api/search/items');
    expect(() => joinApplicationPath('/api', '%2e%2e', 'admin')).toThrow(/unsafe/i);
    expect(() => joinApplicationPath('/api', 'https://example.com')).toThrow(/unsafe/i);
  });

  test('encodes query values without permitting path injection', () => {
    expect(withApplicationQuery('/api/search', {
      q: 'Kızılay & Ulus',
      category: ['park', 'kütüphane'],
      ignored: null,
    })).toBe('/api/search?q=K%C4%B1z%C4%B1lay+%26+Ulus&category=park&category=k%C3%BCt%C3%BCphane');

    expect(() => withApplicationQuery('/api/%2e%2e/admin', { q: 'x' })).toThrow();
  });

  test('strips query and fragment before stable endpoint fingerprinting', () => {
    expect(stripApplicationQuery('/api/search?q=test#result')).toBe('/api/search');
    expect(endpointFingerprint('/API/Search?q=one')).toBe(endpointFingerprint('/api/search?q=two'));
  });
});
