import {
  canCacheOfflineResponse,
  classifyOfflineRequest,
  createOfflinePolicy,
  limitsForOfflineRequest,
  offlineCacheName,
  offlinePolicyFingerprint,
  timeoutForOfflineRequest,
} from './offlinePolicy';

const origin = 'https://kentrehberi.example';

const request = (
  path: string,
  init: RequestInit & { readonly destination?: RequestDestination } = {},
): Request => {
  const value = new Request(new URL(path, origin), init);
  if (init.destination) {
    Object.defineProperty(value, 'destination', { value: init.destination });
  }
  return value;
};

describe('offline policy', () => {
  test('normalizes bounded defaults', () => {
    const policy = createOfflinePolicy();
    expect(policy.cachePrefix).toBe('kent-rehberi');
    expect(policy.cacheVersion).toBe('v1');
    expect(policy.staticCache.maxEntries).toBeGreaterThan(0);
    expect(policy.staticCache.maxBytes).toBeGreaterThan(policy.staticCache.maxEntryBytes);
    expect(policy.apiCache.maxAgeMs).toBeLessThan(policy.staticCache.maxAgeMs);
    expect(policy.sensitiveQueryKeys).toContain('token');
  });

  test('clamps unsafe configuration values', () => {
    const policy = createOfflinePolicy({
      cachePrefix: '  Kent Rehberi !!! ',
      cacheVersion: '../../v2',
      staticCache: {
        maxEntries: 100_000,
        maxBytes: 999_999_999,
        maxEntryBytes: 999_999_999,
        maxAgeMs: 999_999_999_999,
      },
      navigationTimeoutMs: 1,
    });
    expect(policy.cachePrefix).toBe('Kent-Rehberi-');
    expect(policy.cacheVersion).toBe('..-..-v2');
    expect(policy.staticCache.maxEntries).toBe(5000);
    expect(policy.staticCache.maxBytes).toBe(512 * 1024 * 1024);
    expect(policy.staticCache.maxEntryBytes).toBe(64 * 1024 * 1024);
    expect(policy.navigationTimeoutMs).toBe(500);
  });

  test('builds deterministic cache names', () => {
    const policy = createOfflinePolicy({ cachePrefix: 'kent', cacheVersion: 'r42' });
    expect(offlineCacheName(policy, 'static')).toBe('kent-r42-static');
    expect(offlineCacheName(policy, 'api')).toBe('kent-r42-api');
  });

  test('rejects non-GET requests before URL classification', () => {
    const decision = classifyOfflineRequest(
      request('/api/items', { method: 'POST' }),
      origin,
    );
    expect(decision).toMatchObject({
      kind: 'bypass',
      strategy: 'network-only',
      cacheable: false,
      reason: 'method-not-cacheable',
    });
  });

  test('rejects cross-origin requests', () => {
    const decision = classifyOfflineRequest(new Request('https://evil.example/a.js'), origin);
    expect(decision.reason).toBe('cross-origin');
    expect(decision.cacheName).toBeNull();
  });

  test('rejects authorization and range headers', () => {
    const authorized = classifyOfflineRequest(request('/assets/app.js', {
      headers: { Authorization: 'Bearer secret' },
    }), origin);
    const ranged = classifyOfflineRequest(request('/assets/map.bin', {
      headers: { Range: 'bytes=0-10' },
    }), origin);
    expect(authorized.reason).toBe('sensitive-or-range-header');
    expect(ranged.reason).toBe('sensitive-or-range-header');
  });

  test.each([
    '/api/items?token=abc',
    '/api/items?ACCESS_TOKEN=abc',
    '/images/a.png?signature=abc',
    '/assets/app.js?api_key=abc',
  ])('rejects sensitive query material: %s', (path) => {
    expect(classifyOfflineRequest(request(path), origin).reason).toBe('sensitive-query');
  });

  test('classifies navigation as network-first shell cache', () => {
    const navigation = request('/map', { destination: 'document' });
    Object.defineProperty(navigation, 'mode', { value: 'navigate' });
    const decision = classifyOfflineRequest(navigation, origin);
    expect(decision.kind).toBe('navigation');
    expect(decision.strategy).toBe('network-first');
    expect(decision.cacheable).toBe(true);
    expect(decision.cacheName).toContain('-static');
  });

  test('classifies API reads as opt-in network-first', () => {
    const decision = classifyOfflineRequest(request('/api/kent-rehberi?limit=25'), origin);
    expect(decision.kind).toBe('api-read');
    expect(decision.strategy).toBe('network-first');
    expect(decision.cacheable).toBe(false);
    expect(decision.reason).toContain('public-response-opt-in');
  });

  test.each([
    ['/assets/app-123.js', 'script'],
    ['/fonts/app.woff2', 'font'],
    ['/images/logo.png', 'image'],
    ['/manifest.webmanifest', 'manifest'],
    ['/styles/site.css', 'style'],
  ])('classifies static resource %s', (path, destination) => {
    const decision = classifyOfflineRequest(
      request(path, { destination: destination as RequestDestination }),
      origin,
    );
    expect(decision.kind).toBe('static');
    expect(decision.strategy).toBe('stale-while-revalidate');
    expect(decision.cacheable).toBe(true);
  });

  test('recognizes static extension even when destination is empty', () => {
    const decision = classifyOfflineRequest(request('/custom/app.svg'), origin);
    expect(decision.kind).toBe('static');
  });

  test('leaves unknown GET network-only', () => {
    const decision = classifyOfflineRequest(request('/unclassified'), origin);
    expect(decision).toMatchObject({
      kind: 'bypass',
      strategy: 'network-only',
      cacheable: false,
      reason: 'unclassified-get',
    });
  });

  test('accepts cacheable same-origin static success response', () => {
    const req = request('/assets/app.js');
    const response = new Response('ok', {
      status: 200,
      headers: { 'cache-control': 'public, max-age=3600' },
    });
    Object.defineProperty(response, 'url', { value: req.url });
    expect(canCacheOfflineResponse(req, response, 'static', origin)).toBe(true);
  });

  test.each([
    'private, max-age=3600',
    'no-store',
  ])('rejects private cache control: %s', (cacheControl) => {
    const req = request('/assets/app.js');
    const response = new Response('ok', {
      status: 200,
      headers: { 'cache-control': cacheControl },
    });
    Object.defineProperty(response, 'url', { value: req.url });
    expect(canCacheOfflineResponse(req, response, 'static', origin)).toBe(false);
  });

  test('rejects failed and partial responses', () => {
    const req = request('/assets/app.js');
    const failed = new Response('nope', { status: 500 });
    const partial = new Response('part', { status: 206 });
    Object.defineProperty(failed, 'url', { value: req.url });
    Object.defineProperty(partial, 'url', { value: req.url });
    expect(canCacheOfflineResponse(req, failed, 'static', origin)).toBe(false);
    expect(canCacheOfflineResponse(req, partial, 'static', origin)).toBe(false);
  });

  test('requires explicit public opt-in for API responses', () => {
    const req = request('/api/items');
    const privateResponse = new Response('{}', { status: 200 });
    const optedIn = new Response('{}', {
      status: 200,
      headers: { 'x-kent-rehberi-offline': 'public' },
    });
    Object.defineProperty(privateResponse, 'url', { value: req.url });
    Object.defineProperty(optedIn, 'url', { value: req.url });
    expect(canCacheOfflineResponse(req, privateResponse, 'api-read', origin)).toBe(false);
    expect(canCacheOfflineResponse(req, optedIn, 'api-read', origin)).toBe(true);
  });

  test('accepts cache-control public as API opt-in', () => {
    const req = request('/api/items');
    const response = new Response('{}', {
      status: 200,
      headers: { 'cache-control': 'public, max-age=120' },
    });
    Object.defineProperty(response, 'url', { value: req.url });
    expect(canCacheOfflineResponse(req, response, 'api-read', origin)).toBe(true);
  });

  test('rejects wildcard vary responses', () => {
    const req = request('/assets/app.js');
    const response = new Response('ok', {
      status: 200,
      headers: { vary: '*' },
    });
    Object.defineProperty(response, 'url', { value: req.url });
    expect(canCacheOfflineResponse(req, response, 'static', origin)).toBe(false);
  });

  test('selects timeouts and budgets by request kind', () => {
    const policy = createOfflinePolicy({
      navigationTimeoutMs: 1111,
      apiTimeoutMs: 2222,
      staticTimeoutMs: 3333,
      staticCache: { maxEntries: 10 },
      apiCache: { maxEntries: 20 },
    });
    expect(timeoutForOfflineRequest('navigation', policy)).toBe(1111);
    expect(timeoutForOfflineRequest('api-read', policy)).toBe(2222);
    expect(timeoutForOfflineRequest('static', policy)).toBe(3333);
    expect(limitsForOfflineRequest('static', policy).maxEntries).toBe(10);
    expect(limitsForOfflineRequest('api-read', policy).maxEntries).toBe(20);
  });

  test('fingerprint is deterministic and policy-sensitive', () => {
    const a = createOfflinePolicy();
    const b = createOfflinePolicy();
    const c = createOfflinePolicy({ cacheVersion: 'v2' });
    expect(offlinePolicyFingerprint(a)).toBe(offlinePolicyFingerprint(b));
    expect(offlinePolicyFingerprint(a)).not.toBe(offlinePolicyFingerprint(c));
    expect(offlinePolicyFingerprint(a)).toMatch(/^[a-f0-9]{8}$/u);
  });
});
