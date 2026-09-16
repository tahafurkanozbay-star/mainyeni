import {
  assertApplicationEndpoint,
  endpointFingerprint,
  isSameOriginPath,
  joinApplicationPath,
  normalizeApplicationPath,
  stripApplicationQuery,
  withApplicationQuery,
} from './endpointPolicy';

describe('typed endpoint policy security boundary', () => {
  test('accepts normal same-origin application paths', () => {
    expect(isSameOriginPath('/api/search')).toBe(true);
    expect(isSameOriginPath('/Common/FileService.svc/GetBuildingDocuments')).toBe(true);
    expect(assertApplicationEndpoint('/api/search?q=ankara')).toBe('/api/search?q=ankara');
  });

  test('blocks absolute, scheme-relative and backslash paths', () => {
    expect(isSameOriginPath('https://example.com/api')).toBe(false);
    expect(isSameOriginPath('//example.com/api')).toBe(false);
    expect(isSameOriginPath('/api\\admin')).toBe(false);
    expect(() => assertApplicationEndpoint('javascript:alert(1)')).toThrow(/blocked/i);
    expect(() => assertApplicationEndpoint('//example.com/api')).toThrow(/blocked/i);
  });

  test.each([
    '/api/%2e%2e/admin',
    '/api/%2E%2E/admin',
    '/api/%2e./admin',
    '/api/.%2e/admin',
    '/api/%252e%252e/admin',
    '/api/%252E%252E/admin',
  ])('blocks encoded dot-segment traversal: %s', (path) => {
    expect(isSameOriginPath(path)).toBe(false);
    expect(() => assertApplicationEndpoint(path)).toThrow(/blocked/i);
  });

  test.each([
    '/api/a%2fb',
    '/api/a%2Fb',
    '/api/a%5cb',
    '/api/a%255cb',
    '/api/a%252fb',
  ])('blocks encoded path separators: %s', (path) => {
    expect(isSameOriginPath(path)).toBe(false);
    expect(() => normalizeApplicationPath(path)).toThrow(/blocked/i);
  });

  test('blocks malformed percent encoding in path segments', () => {
    expect(isSameOriginPath('/api/%')).toBe(false);
    expect(isSameOriginPath('/api/%2')).toBe(false);
    expect(() => normalizeApplicationPath('/api/%zz')).toThrow(/blocked/i);
  });

  test('allows ordinary percent-encoded Unicode path segments', () => {
    expect(isSameOriginPath('/api/%C3%A7ankaya')).toBe(true);
    expect(assertApplicationEndpoint('/api/%C3%A7ankaya')).toBe('/api/%C3%A7ankaya');
  });

  test('normalizes literal dot segments without allowing root escape', () => {
    expect(normalizeApplicationPath('/api/./search')).toBe('/api/search');
    expect(normalizeApplicationPath('/api/v1/../search')).toBe('/api/search');
    expect(normalizeApplicationPath('/../../api/search')).toBe('/api/search');
  });

  test('enforces normalized allowlisted path scopes', () => {
    expect(assertApplicationEndpoint('/api/search', { allowedPrefixes: ['/api'] })).toBe('/api/search');
    expect(assertApplicationEndpoint('/api', { allowedPrefixes: ['/api'] })).toBe('/api');
    expect(() => assertApplicationEndpoint('/admin', { allowedPrefixes: ['/api'] })).toThrow(/allowed path scope/i);
    expect(() => assertApplicationEndpoint('/api/%2e%2e/admin', { allowedPrefixes: ['/api'] })).toThrow(/blocked/i);
    expect(() => assertApplicationEndpoint('/api/%252e%252e/admin', { allowedPrefixes: ['/api'] })).toThrow(/blocked/i);
  });

  test('rejects query and fragment when explicitly disabled', () => {
    expect(() => assertApplicationEndpoint('/api/search?q=x', { allowQuery: false })).toThrow(/query string/i);
    expect(() => assertApplicationEndpoint('/api/search#result', { allowHash: false })).toThrow(/fragment/i);
  });

  test('joins safe path segments and rejects encoded escape segments', () => {
    expect(joinApplicationPath('/api', 'search', 'items')).toBe('/api/search/items');
    expect(joinApplicationPath('/', 'api', 'search')).toBe('/api/search');
    expect(() => joinApplicationPath('/api', '%2e%2e', 'admin')).toThrow(/unsafe/i);
    expect(() => joinApplicationPath('/api', '%252fadmin')).toThrow(/unsafe/i);
    expect(() => joinApplicationPath('/api', 'https://example.com')).toThrow(/unsafe/i);
  });

  test('builds query strings without treating encoded values as path traversal', () => {
    const value = withApplicationQuery('/api/search', {
      q: '../ankara',
      category: 'Açık Alan',
      id: [0, 1],
      empty: '',
      missing: null,
    });

    expect(value).toContain('/api/search?');
    expect(value).toContain('q=..%2Fankara');
    expect(value).toContain('category=A%C3%A7%C4%B1k+Alan');
    expect(value).toContain('id=0');
    expect(value).toContain('id=1');
    expect(value).not.toContain('empty=');
    expect(value).not.toContain('missing=');
    expect(isSameOriginPath(value)).toBe(true);
  });

  test('strips query and hash before producing stable endpoint identity', () => {
    expect(stripApplicationQuery('/api/search?q=one#two')).toBe('/api/search');
    expect(endpointFingerprint('/API/Search?q=one')).toBe(endpointFingerprint('/api/search?q=two'));
    expect(endpointFingerprint('/api/search')).not.toBe(endpointFingerprint('/api/other'));
  });

  test('rejects raw and encoded control characters', () => {
    expect(isSameOriginPath('/api/search\nadmin')).toBe(false);
    expect(isSameOriginPath('/api/%0aadmin')).toBe(false);
    expect(isSameOriginPath('/api/%250aadmin')).toBe(false);
  });
});
