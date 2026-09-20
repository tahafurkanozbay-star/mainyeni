import { describe, expect, it } from 'vitest';
import { OfflineCachePolicy } from './offlineCachePolicy';

const response = (overrides: Partial<{ status: number; headers: Record<string, string>; sizeBytes: number }> = {}) => ({
  status: overrides.status ?? 200,
  headers: overrides.headers ?? { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
  sizeBytes: overrides.sizeBytes ?? 128,
});

const policy = (overrides: ConstructorParameters<typeof OfflineCachePolicy>[0] = { origin: 'https://kent.example' }) =>
  new OfflineCachePolicy({ origin: 'https://kent.example', ...overrides });

describe('OfflineCachePolicy', () => {
  it('admits bounded same-origin GET responses', () => {
    const cache = policy();
    const decision = cache.admit({ url: 'https://kent.example/assets/config.json' }, response());
    expect(decision).toMatchObject({ admitted: true, reason: 'admit', key: 'GET:/assets/config.json' });
    expect(cache.snapshot()).toMatchObject({ entries: 1, bytes: 128, admitted: 1, rejected: 0 });
  });

  it('normalizes relative URLs against the configured origin', () => {
    const decision = policy().evaluate({ url: '/assets/config.json?lang=tr' }, response());
    expect(decision.key).toBe('GET:/assets/config.json?lang=tr');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects mutation method %s', method => {
    expect(policy().evaluate({ url: '/assets/a.json', method }, response())).toMatchObject({ admitted: false, reason: 'unsupported-method' });
  });

  it('permits HEAD without converting it into GET identity', () => {
    expect(policy().evaluate({ url: '/assets/a.json', method: 'HEAD' }, response()).key).toBe('HEAD:/assets/a.json');
  });

  it('rejects cross-origin URLs', () => {
    expect(policy().evaluate({ url: 'https://evil.example/assets/a.json' }, response()).reason).toBe('cross-origin');
  });

  it('rejects userinfo-bearing URLs', () => {
    expect(policy().evaluate({ url: 'https://user:pass@kent.example/assets/a.json' }, response()).reason).toBe('cross-origin');
  });

  it('rejects paths outside explicit cache prefixes', () => {
    expect(policy().evaluate({ url: '/api/private' }, response()).reason).toBe('cross-origin');
  });

  it.each(['authorization', 'Authorization', 'cookie', 'x-api-key'])('rejects sensitive request header %s', header => {
    expect(policy().evaluate({ url: '/assets/a.json', headers: { [header]: 'secret' } }, response()).reason).toBe('sensitive-request');
  });

  it.each(['set-cookie', 'set-cookie2'])('rejects sensitive response header %s', header => {
    expect(policy().evaluate({ url: '/assets/a.json' }, response({ headers: { 'content-type': 'application/json', [header]: 'x=y' } })).reason).toBe('sensitive-response');
  });

  it('rejects Vary star responses', () => {
    expect(policy().evaluate({ url: '/assets/a.json' }, response({ headers: { 'content-type': 'application/json', vary: '*' } })).reason).toBe('sensitive-response');
  });

  it.each([0, 201, 204, 206, 301, 304, 400, 404, 500])('rejects status %s', status => {
    expect(policy().evaluate({ url: '/assets/a.json' }, response({ status })).reason).toBe('uncacheable-status');
  });

  it.each(['no-store', 'private', 'public, no-store', 'max-age=60, private'])('rejects cache-control %s', value => {
    expect(policy().evaluate({ url: '/assets/a.json' }, response({ headers: { 'content-type': 'application/json', 'cache-control': value } })).reason).toBe('uncacheable-directive');
  });

  it('rejects missing size evidence', () => {
    const result = policy().evaluate({ url: '/assets/a.json' }, { status: 200, headers: { 'content-type': 'application/json' } });
    expect(result.reason).toBe('oversized-response');
  });

  it('accepts content-length as size evidence', () => {
    const result = policy().evaluate({ url: '/assets/a.json' }, { status: 200, headers: { 'content-type': 'application/json', 'content-length': '32' } });
    expect(result.admitted).toBe(true);
  });

  it('rejects malformed content-length', () => {
    const result = policy().evaluate({ url: '/assets/a.json' }, { status: 200, headers: { 'content-type': 'application/json', 'content-length': '-1' } });
    expect(result.reason).toBe('oversized-response');
  });

  it('rejects oversized responses', () => {
    expect(policy({ origin: 'https://kent.example', maxEntryBytes: 1024 }).evaluate({ url: '/assets/a.json' }, response({ sizeBytes: 1025 })).reason).toBe('oversized-response');
  });

  it.each(['text/html', 'application/octet-stream', 'video/mp4'])('rejects unsupported content type %s', contentType => {
    expect(policy().evaluate({ url: '/assets/a.json' }, response({ headers: { 'content-type': contentType } })).reason).toBe('unsupported-content-type');
  });

  it.each(['application/json', 'image/png', 'image/svg+xml', 'font/woff2', 'text/css', 'text/javascript', 'application/javascript'])('admits supported content type %s', contentType => {
    expect(policy().evaluate({ url: '/assets/a.json' }, response({ headers: { 'content-type': `${contentType}; charset=utf-8` } })).admitted).toBe(true);
  });

  it('uses default TTL when cache-control has no max-age', () => {
    let now = 1000;
    const cache = policy({ origin: 'https://kent.example', clock: () => now, defaultTtlMs: 5000 });
    expect(cache.evaluate({ url: '/assets/a.json' }, response({ headers: { 'content-type': 'application/json' } })).expiresAt).toBe(6000);
  });

  it('honors bounded max-age', () => {
    const cache = policy({ origin: 'https://kent.example', clock: () => 1000, defaultTtlMs: 1000, maxTtlMs: 5000 });
    expect(cache.evaluate({ url: '/assets/a.json' }, response({ headers: { 'content-type': 'application/json', 'cache-control': 'max-age=999' } })).expiresAt).toBe(6000);
  });

  it('prefers s-maxage over max-age', () => {
    const cache = policy({ origin: 'https://kent.example', clock: () => 1000, defaultTtlMs: 1000, maxTtlMs: 10000 });
    expect(cache.evaluate({ url: '/assets/a.json' }, response({ headers: { 'content-type': 'application/json', 'cache-control': 'max-age=9, s-maxage=2' } })).expiresAt).toBe(3000);
  });

  it('rejects max-age zero as immediately expired', () => {
    expect(policy().evaluate({ url: '/assets/a.json' }, response({ headers: { 'content-type': 'application/json', 'cache-control': 'max-age=0' } })).reason).toBe('expired');
  });

  it('tracks hits without exposing response bodies', () => {
    let now = 1000;
    const cache = policy({ origin: 'https://kent.example', clock: () => now });
    cache.admit({ url: '/assets/a.json' }, response());
    now += 10;
    const entry = cache.access('GET:/assets/a.json');
    expect(entry).toMatchObject({ hits: 1, lastAccessedAt: 1010 });
    expect(cache.history().at(-1)?.type).toBe('hit');
  });

  it('records misses with bounded identity only', () => {
    const cache = policy();
    expect(cache.access('GET:/assets/missing.json')).toBeUndefined();
    expect(cache.history().at(-1)).toMatchObject({ type: 'miss', key: 'GET:/assets/missing.json' });
  });

  it('expires entries on access', () => {
    let now = 1000;
    const cache = policy({ origin: 'https://kent.example', clock: () => now, defaultTtlMs: 1000 });
    cache.admit({ url: '/assets/a.json' }, response({ headers: { 'content-type': 'application/json' } }));
    now = 2000;
    expect(cache.access('GET:/assets/a.json')).toBeUndefined();
    expect(cache.snapshot()).toMatchObject({ entries: 0, expired: 1 });
  });

  it('prunes multiple expired entries deterministically', () => {
    let now = 1000;
    const cache = policy({ origin: 'https://kent.example', clock: () => now, defaultTtlMs: 1000 });
    cache.admit({ url: '/assets/a.json' }, response({ headers: { 'content-type': 'application/json' } }));
    cache.admit({ url: '/assets/b.json' }, response({ headers: { 'content-type': 'application/json' } }));
    now = 2001;
    expect(cache.prune()).toBe(2);
    expect(cache.snapshot().entries).toBe(0);
  });

  it('evicts least recently used entry when count budget is exceeded', () => {
    let now = 1000;
    const cache = policy({ origin: 'https://kent.example', clock: () => now, maxEntries: 2 });
    cache.admit({ url: '/assets/a.json' }, response());
    now += 1;
    cache.admit({ url: '/assets/b.json' }, response());
    now += 1;
    cache.access('GET:/assets/a.json');
    now += 1;
    cache.admit({ url: '/assets/c.json' }, response());
    expect(cache.entries().map(entry => entry.key)).toEqual(['GET:/assets/a.json', 'GET:/assets/c.json']);
    expect(cache.snapshot().evicted).toBe(1);
  });

  it('replaces an existing key without increasing entry count', () => {
    const cache = policy();
    cache.admit({ url: '/assets/a.json' }, response({ sizeBytes: 10 }));
    cache.admit({ url: '/assets/a.json' }, response({ sizeBytes: 20 }));
    expect(cache.snapshot()).toMatchObject({ entries: 1, bytes: 20, admitted: 2 });
  });

  it('removes entries explicitly', () => {
    const cache = policy();
    cache.admit({ url: '/assets/a.json' }, response());
    expect(cache.remove('GET:/assets/a.json')).toBe(true);
    expect(cache.remove('GET:/assets/a.json')).toBe(false);
  });

  it('bounds diagnostic history', () => {
    const cache = policy({ origin: 'https://kent.example', historyLimit: 2 });
    cache.access('a'); cache.access('b'); cache.access('c');
    expect(cache.history()).toHaveLength(2);
    expect(cache.history().map(event => event.key)).toEqual(['b', 'c']);
  });

  it('supports disabled diagnostic history', () => {
    const cache = policy({ origin: 'https://kent.example', historyLimit: 0 });
    cache.access('missing');
    expect(cache.history()).toEqual([]);
  });

  it('supports explicit path prefixes', () => {
    const cache = policy({ origin: 'https://kent.example', allowedPathPrefixes: ['/offline/'] });
    expect(cache.evaluate({ url: '/offline/a.json' }, response()).admitted).toBe(true);
    expect(cache.evaluate({ url: '/assets/a.json' }, response()).admitted).toBe(false);
  });

  it('does not confuse sibling path prefixes', () => {
    const cache = policy({ origin: 'https://kent.example', allowedPathPrefixes: ['/asset/'] });
    expect(cache.evaluate({ url: '/assets/a.json' }, response()).admitted).toBe(false);
  });

  it('rejects insecure non-localhost origins', () => {
    const insecureOrigin = ['http', '://kent.example'].join('');
    expect(() => new OfflineCachePolicy({ origin: insecureOrigin })).toThrow(/HTTPS/);
  });

  it.each(['localhost', '127.0.0.1'])('permits local development origin %s', host => {
    const origin = ['http', `://${host}`].join('');
    expect(new OfflineCachePolicy({ origin }).origin).toBe(origin);
  });

  it('rejects origin URLs with paths', () => {
    expect(() => new OfflineCachePolicy({ origin: 'https://kent.example/app' })).toThrow(/origin/);
  });

  it('validates count and byte budgets', () => {
    expect(() => policy({ origin: 'https://kent.example', maxEntries: 0 })).toThrow(RangeError);
    expect(() => policy({ origin: 'https://kent.example', maxEntryBytes: 100 })).toThrow(RangeError);
  });

  it('keeps event sequence monotonic', () => {
    const cache = policy();
    cache.access('a'); cache.access('b'); cache.access('c');
    expect(cache.history().map(event => event.sequence)).toEqual([1, 2, 3]);
  });
});
