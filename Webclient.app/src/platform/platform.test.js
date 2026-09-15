import { createRuntimeConfig, assertSafeRuntimeConfig } from './config/runtimeConfig';
import { RequestCache } from './cache/requestCache';
import { AppError, normalizeAxiosError } from './errors/appError';
import { normalizeApplicationPath, assertApplicationEndpoint } from './network/endpointPolicy';
import { safeStorage } from './security/safeStorage';

const storageMock = () => ({
  data: new Map(),
  setItem(key, value) { this.data.set(key, value); },
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
  removeItem(key) { this.data.delete(key); }
});

test('runtime config defaults to same-origin API', () => {
  const config = createRuntimeConfig({});
  expect(config.apiBaseUrl).toBe('/api');
  expect(() => assertSafeRuntimeConfig(config)).not.toThrow();
});

test('runtime config rejects external and protocol-relative API URLs', () => {
  expect(createRuntimeConfig({ REACT_APP_API_URL: 'https://outside.example/api' }).apiBaseUrl).toBe('/api');
  expect(createRuntimeConfig({ REACT_APP_API_URL: '//outside.example/api' }).apiBaseUrl).toBe('/api');
});

test('application endpoints normalize to same-origin paths', () => {
  expect(normalizeApplicationPath('/api/Gis//ConfigService/List')).toBe('/api/Gis/ConfigService/List');
  expect(() => assertApplicationEndpoint('https://outside.example')).toThrow(AppError);
  expect(() => assertApplicationEndpoint('//outside.example')).toThrow(AppError);
});

test('request cache bounds memory and evicts the oldest entry', () => {
  const cache = new RequestCache({ ttlMs: 1000, maxEntries: 2 });
  cache.set('one', 1);
  cache.set('two', 2);
  cache.set('three', 3);
  expect(cache.get('one')).toBeUndefined();
  expect(cache.get('two')).toBe(2);
  expect(cache.get('three')).toBe(3);
});

test('safe storage refuses credential-like keys', () => {
  const storage = storageMock();
  expect(safeStorage.set(storage, 'authToken', 'secret')).toBe(false);
  expect(safeStorage.set(storage, 'mapUiState', { sidebar: true })).toBe(true);
  expect(safeStorage.get(storage, 'mapUiState')).toEqual({ sidebar: true });
});

test('safe storage clears expired entries', () => {
  const storage = storageMock();
  storage.data.set('temporaryState', JSON.stringify({ value: 'value', expiresAt: Date.now() - 1 }));
  expect(safeStorage.get(storage, 'temporaryState')).toBeUndefined();
});

test('server failure is normalized without exposing server internals', () => {
  const error = normalizeAxiosError({ response: { status: 500, data: { message: 'sql password leaked' } } });
  expect(error.code).toBe('SERVER_ERROR');
  expect(error.message).not.toMatch(/sql password/i);
});
