import {
  createAdminRuntimeEnvironment,
  normalizeAdminApiBaseUrl,
} from './adminEnvironment';

describe('adminEnvironment', () => {
  test('defaults to the same-origin API boundary', () => {
    expect(normalizeAdminApiBaseUrl(undefined)).toBe('/api');
    expect(normalizeAdminApiBaseUrl('')).toBe('/api');
  });

  test('accepts canonical relative API paths', () => {
    expect(normalizeAdminApiBaseUrl('/api/')).toBe('/api');
    expect(normalizeAdminApiBaseUrl('/admin-api')).toBe('/admin-api');
  });

  test('rejects protocol-relative URLs', () => {
    expect(() => normalizeAdminApiBaseUrl('//evil.example/api')).toThrow(/protocol-relative/i);
  });

  test('requires HTTPS for remote absolute endpoints', () => {
    expect(() => normalizeAdminApiBaseUrl('http://example.com/api')).toThrow(/HTTPS/i);
    expect(normalizeAdminApiBaseUrl('http://localhost:5000/api')).toBe('http://localhost:5000/api');
    expect(normalizeAdminApiBaseUrl('https://example.com/api/')).toBe('https://example.com/api');
  });

  test('removes credentials, query and fragment from configured endpoints', () => {
    expect(normalizeAdminApiBaseUrl('https://user:pass@example.com/api?q=1#x'))
      .toBe('https://example.com/api');
  });

  test('creates an immutable runtime contract', () => {
    const runtime = createAdminRuntimeEnvironment({
      VITE_API_URL: '/api',
      VITE_APP_VERSION: ' 2.0.0 ',
    });

    expect(runtime).toEqual({ apiBaseUrl: '/api', appVersion: '2.0.0' });
    expect(Object.isFrozen(runtime)).toBe(true);
  });
});
