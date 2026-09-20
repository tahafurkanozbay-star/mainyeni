import { describe, expect, it } from 'vitest';
import { OfflineCachePolicy } from './offlineCachePolicy';

const cache = (overrides: Partial<ConstructorParameters<typeof OfflineCachePolicy>[0]> = {}) => new OfflineCachePolicy({ origin: 'https://kent.example', ...overrides });
const ok = (headers: Record<string, string> = {}) => ({ status: 200, sizeBytes: 64, headers: { 'content-type': 'application/json', ...headers } });

describe('OfflineCachePolicy security and deterministic eviction', () => {
  it.each([
    'https://evil.example/assets/a.json',
    'https://kent.example.evil.example/assets/a.json',
    'https://kent.example@evil.example/assets/a.json',
    '//evil.example/assets/a.json',
  ])('rejects origin escape %s', url => {
    expect(cache().evaluate({ url }, ok()).reason).toBe('cross-origin');
  });

  it.each([
    ['/asset/a.json', ['/assets/']],
    ['/assets-evil/a.json', ['/assets/']],
    ['/api/cache/a.json', ['/api/cached/']],
  ] as const)('rejects sibling path %s', (url, allowedPathPrefixes) => {
    expect(cache({ allowedPathPrefixes }).evaluate({ url }, ok()).admitted).toBe(false);
  });

  it.each([
    ['/assets', ['/assets/']],
    ['/assets/', ['/assets/']],
    ['/assets/nested/a.json', ['/assets/']],
  ] as const)('accepts bounded path %s', (url, allowedPathPrefixes) => {
    expect(cache({ allowedPathPrefixes }).evaluate({ url }, ok()).admitted).toBe(true);
  });

  it.each(['Bearer token', 'Basic abc', ''])('never caches Authorization-bearing request value %j', value => {
    expect(cache().evaluate({ url: '/assets/a.json', headers: { Authorization: value } }, ok()).reason).toBe('sensitive-request');
  });

  it('treats request header names case-insensitively', () => {
    expect(cache().evaluate({ url: '/assets/a.json', headers: { CoOkIe: 'session=x' } }, ok()).reason).toBe('sensitive-request');
  });

  it('treats response header names case-insensitively', () => {
    expect(cache().evaluate({ url: '/assets/a.json' }, ok({ 'Set-Cookie': 'session=x' })).reason).toBe('sensitive-response');
  });

  it('rejects Vary star surrounded by other fields', () => {
    expect(cache().evaluate({ url: '/assets/a.json' }, ok({ Vary: 'Accept-Encoding, *, Accept-Language' })).reason).toBe('sensitive-response');
  });

  it.each(['NO-STORE', 'Private', 'PUBLIC, NO-STORE'])('parses cache directives case-insensitively: %s', value => {
    expect(cache().evaluate({ url: '/assets/a.json' }, ok({ 'Cache-Control': value })).reason).toBe('uncacheable-directive');
  });

  it('parses quoted max-age', () => {
    const policy = cache({ clock: () => 1000, defaultTtlMs: 1000, maxTtlMs: 10_000 });
    expect(policy.evaluate({ url: '/assets/a.json' }, ok({ 'cache-control': 'max-age="2"' })).expiresAt).toBe(3000);
  });

  it.each(['abc', '-1', '1.5', '999999999999999999999'])('falls back safely for malformed max-age %s', value => {
    const policy = cache({ clock: () => 1000, defaultTtlMs: 1000, maxTtlMs: 10_000 });
    expect(policy.evaluate({ url: '/assets/a.json' }, ok({ 'cache-control': `max-age=${value}` })).expiresAt).toBe(2000);
  });

  it('allows explicitly configured JSON vendor content type', () => {
    const policy = cache({ allowedContentTypes: ['application/vnd.kent+json'] });
    expect(policy.evaluate({ url: '/assets/a.json' }, ok({ 'content-type': 'application/vnd.kent+json' })).admitted).toBe(true);
  });

  it('does not broaden exact content type allow-list entries', () => {
    const policy = cache({ allowedContentTypes: ['application/json'] });
    expect(policy.evaluate({ url: '/assets/a.json' }, ok({ 'content-type': 'application/json-patch+json' })).admitted).toBe(false);
  });

  it('does not admit a response with missing content type', () => {
    expect(cache().evaluate({ url: '/assets/a.json' }, { status: 200, sizeBytes: 1, headers: {} }).reason).toBe('unsupported-content-type');
  });

  it('rejects negative explicit size', () => {
    expect(cache().evaluate({ url: '/assets/a.json' }, { ...ok(), sizeBytes: -1 }).reason).toBe('oversized-response');
  });

  it('rejects non-integer explicit size', () => {
    expect(cache().evaluate({ url: '/assets/a.json' }, { ...ok(), sizeBytes: 1.5 }).reason).toBe('oversized-response');
  });

  it('counts rejection decisions without storing entries', () => {
    const policy = cache();
    policy.evaluate({ url: '/private/a.json' }, ok());
    policy.evaluate({ url: '/assets/a.json', method: 'POST' }, ok());
    expect(policy.snapshot()).toMatchObject({ entries: 0, admitted: 0, rejected: 2 });
  });

  it('evaluation is side-effect free for admitted entries', () => {
    const policy = cache();
    expect(policy.evaluate({ url: '/assets/a.json' }, ok()).admitted).toBe(true);
    expect(policy.snapshot()).toMatchObject({ entries: 0, admitted: 0 });
  });

  it('admission records only bounded cache identity in diagnostics', () => {
    const policy = cache();
    policy.admit({ url: '/assets/a.json?token=not-a-secret-contract' }, ok());
    const event = policy.history().at(-1);
    expect(event?.type).toBe('admitted');
    expect(event?.key).toBe('GET:/assets/a.json?token=not-a-secret-contract');
    expect(Object.keys(event ?? {})).not.toContain('headers');
  });

  it('evicts lexicographically when age ties are exact', () => {
    const policy = cache({ clock: () => 1000, maxEntries: 2 });
    policy.admit({ url: '/assets/b.json' }, ok());
    policy.admit({ url: '/assets/a.json' }, ok());
    policy.admit({ url: '/assets/c.json' }, ok());
    expect(policy.entries().map(entry => entry.key)).toEqual(['GET:/assets/b.json', 'GET:/assets/c.json']);
  });

  it('does not evict when replacing an existing key at capacity', () => {
    const policy = cache({ maxEntries: 1 });
    policy.admit({ url: '/assets/a.json' }, ok());
    policy.admit({ url: '/assets/a.json' }, { ...ok(), sizeBytes: 32 });
    expect(policy.snapshot()).toMatchObject({ entries: 1, evicted: 0, bytes: 32 });
  });

  it('expired entries are pruned before count eviction', () => {
    let now = 1000;
    const policy = cache({ clock: () => now, maxEntries: 1, defaultTtlMs: 1000 });
    policy.admit({ url: '/assets/old.json' }, ok());
    now = 2001;
    policy.admit({ url: '/assets/new.json' }, ok());
    expect(policy.entries().map(entry => entry.key)).toEqual(['GET:/assets/new.json']);
    expect(policy.snapshot()).toMatchObject({ expired: 1, evicted: 0 });
  });

  it('remove does not alter rejection or eviction counters', () => {
    const policy = cache();
    policy.admit({ url: '/assets/a.json' }, ok());
    policy.remove('GET:/assets/a.json');
    expect(policy.snapshot()).toMatchObject({ entries: 0, admitted: 1, rejected: 0, evicted: 0, expired: 0 });
  });

  it('history keys are bounded even for long query strings', () => {
    const policy = cache();
    policy.access(`GET:/assets/a.json?${'x'.repeat(500)}`);
    expect(policy.history().at(-1)?.key?.length).toBe(256);
  });

  it('snapshot byte accounting reflects current entries only', () => {
    const policy = cache();
    policy.admit({ url: '/assets/a.json' }, { ...ok(), sizeBytes: 10 });
    policy.admit({ url: '/assets/b.json' }, { ...ok(), sizeBytes: 20 });
    expect(policy.snapshot().bytes).toBe(30);
    policy.remove('GET:/assets/a.json');
    expect(policy.snapshot().bytes).toBe(20);
  });

  it('entries are returned in expiry then key order', () => {
    let now = 1000;
    const policy = cache({ clock: () => now, defaultTtlMs: 1000, maxTtlMs: 10_000 });
    policy.admit({ url: '/assets/b.json' }, ok({ 'cache-control': 'max-age=2' }));
    policy.admit({ url: '/assets/a.json' }, ok({ 'cache-control': 'max-age=1' }));
    expect(policy.entries().map(entry => entry.key)).toEqual(['GET:/assets/a.json', 'GET:/assets/b.json']);
  });
});
