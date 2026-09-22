import { describe, expect, test } from 'vitest';
import {
  DEFAULT_LOCAL_API_PROXY_TARGET,
  resolveLocalApiProxyTarget,
} from './localApiProxy';

describe('local Api.User proxy target', () => {
  test('defaults to the shared project/IIS HTTPS port', () => {
    expect(resolveLocalApiProxyTarget(undefined))
      .toBe(DEFAULT_LOCAL_API_PROXY_TARGET);
    expect(resolveLocalApiProxyTarget(''))
      .toBe('https://localhost:3003');
  });

  test.each([
    'https://localhost:3003',
    'http://localhost:3002',
    'https://127.0.0.1:3003',
  ])('accepts local-only HTTP(S) origins: %s', (value) => {
    expect(resolveLocalApiProxyTarget(value))
      .toBe(new URL(value).origin);
  });

  test.each([
    'https://planaski.ankara.bel.tr',
    'https://example.com',
    'https://localhost:3003/path',
    'https://localhost:3003/?x=1',
    'https://user:pass@localhost:3003',
    'file:///tmp/api',
    'not-a-url',
  ])('rejects non-local or non-origin target: %s', (value) => {
    expect(() => resolveLocalApiProxyTarget(value))
      .toThrow(/localhost|local/i);
  });
});
