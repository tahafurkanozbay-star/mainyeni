import { describe, expect, it } from 'vitest';
import { OfflineReplayPolicy } from './offlineReplayPolicy';

const now = 10_000;
const policy = (overrides: ConstructorParameters<typeof OfflineReplayPolicy>[0] = { origin: 'https://kent.example' }) =>
  new OfflineReplayPolicy({ origin: 'https://kent.example', clock: () => now, ...overrides });

const candidate = (overrides: Partial<Parameters<OfflineReplayPolicy['evaluate']>[0]> = {}) => ({
  url: '/api/edits/42', method: 'POST', bodyBytes: 128, createdAt: 9_000, expiresAt: 11_000, ...overrides,
});

describe('OfflineReplayPolicy', () => {
  it('admits a bounded same-origin mutation', () => expect(policy().evaluate(candidate())).toEqual({ allowed: true, normalizedUrl: '/api/edits/42', method: 'POST' }));
  it.each(['post', 'Put', 'PATCH', ' delete '])('normalizes supported method %s', method => expect(policy().evaluate(candidate({ method })).allowed).toBe(true));
  it.each(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', ''])('rejects non-mutation method %s', method => expect(policy().evaluate(candidate({ method }))).toMatchObject({ allowed: false, reason: 'unsafe-method' }));
  it('rejects cross-origin absolute URLs', () => expect(policy().evaluate(candidate({ url: 'https://evil.example/api/edits/42' }))).toMatchObject({ reason: 'cross-origin' }));
  it('rejects protocol-relative cross-origin URLs', () => expect(policy().evaluate(candidate({ url: '//evil.example/api/edits/42' }))).toMatchObject({ reason: 'cross-origin' }));
  it('rejects credentials embedded in a URL', () => expect(policy().evaluate(candidate({ url: 'https://user:pass@kent.example/api/edits/42' }))).toMatchObject({ reason: 'cross-origin' }));
  it('rejects paths outside the default API boundary', () => expect(policy().evaluate(candidate({ url: '/assets/data.json' }))).toMatchObject({ reason: 'unsafe-path' }));
  it('does not confuse an API prefix with a sibling prefix', () => expect(policy().evaluate(candidate({ url: '/api-evil/edits' }))).toMatchObject({ reason: 'unsafe-path' }));
  it('supports explicit bounded path prefixes', () => { const replay = policy({ origin: 'https://kent.example', allowedPathPrefixes: ['/commands/', '/mutations/'] }); expect(replay.evaluate(candidate({ url: '/commands/save' })).allowed).toBe(true); expect(replay.evaluate(candidate({ url: '/api/save' })).allowed).toBe(false); });
  it('deduplicates configured prefixes without changing behavior', () => expect(policy({ origin: 'https://kent.example', allowedPathPrefixes: ['/api', '/api/', '/api'] }).evaluate(candidate()).allowed).toBe(true));
  it.each(['authorization', 'Authorization', 'AUTHORIZATION', 'cookie', 'x-api-key', 'x-auth-token', 'x-access-token', 'proxy-authorization'])('rejects sensitive request header %s', name => expect(policy().evaluate(candidate({ headers: { [name]: 'secret' } }))).toMatchObject({ reason: 'sensitive-header' }));
  it.each(['set-cookie', 'www-authenticate', 'proxy-authenticate'])('rejects response/authentication header %s', name => expect(policy().evaluate(candidate({ headers: { [name]: 'value' } }))).toMatchObject({ reason: 'sensitive-header' }));
  it('allows ordinary bounded metadata headers', () => expect(policy().evaluate(candidate({ headers: { 'content-type': 'application/json', 'if-match': 'etag' } })).allowed).toBe(true));
  it('rejects oversized header values', () => expect(policy().evaluate(candidate({ headers: { 'x-correlation-id': 'x'.repeat(8_193) } }))).toMatchObject({ reason: 'sensitive-header' }));
  it('accepts an empty body', () => expect(policy().evaluate(candidate({ bodyBytes: 0 })).allowed).toBe(true));
  it('accepts a body exactly at the configured budget', () => expect(policy({ origin: 'https://kent.example', maxBodyBytes: 1024 }).evaluate(candidate({ bodyBytes: 1024 })).allowed).toBe(true));
  it('rejects a body above budget', () => expect(policy({ origin: 'https://kent.example', maxBodyBytes: 1024 }).evaluate(candidate({ bodyBytes: 1025 }))).toMatchObject({ reason: 'body-budget' }));
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid body size %s', bodyBytes => expect(policy().evaluate(candidate({ bodyBytes }))).toMatchObject({ reason: 'body-budget' }));
  it('rejects stale mutations', () => expect(policy({ origin: 'https://kent.example', maxAgeMs: 1000 }).evaluate(candidate({ createdAt: 8_999 }))).toMatchObject({ reason: 'stale' }));
  it('accepts mutation exactly at age budget', () => expect(policy({ origin: 'https://kent.example', maxAgeMs: 1000 }).evaluate(candidate({ createdAt: 9_000 })).allowed).toBe(true));
  it('rejects future creation timestamps', () => expect(policy().evaluate(candidate({ createdAt: 10_001 }))).toMatchObject({ reason: 'invalid-time' }));
  it('rejects non-finite creation timestamps', () => expect(policy().evaluate(candidate({ createdAt: Number.NaN }))).toMatchObject({ reason: 'invalid-time' }));
  it('rejects expired mutations', () => expect(policy().evaluate(candidate({ expiresAt: now }))).toMatchObject({ reason: 'expired' }));
  it('rejects expiry before creation', () => expect(policy().evaluate(candidate({ createdAt: 9_500, expiresAt: 9_400 }))).toMatchObject({ reason: 'expired' }));
  it('rejects non-finite expiry', () => expect(policy().evaluate(candidate({ expiresAt: Number.POSITIVE_INFINITY }))).toMatchObject({ reason: 'invalid-time' }));
  it('works without optional timestamps', () => expect(policy().evaluate({ url: '/api/edits/42', method: 'POST', bodyBytes: 128 }).allowed).toBe(true));
  it('preserves query while normalizing to same-origin relative URL', () => expect(policy().evaluate(candidate({ url: 'https://kent.example/api/edits?layer=roads' }))).toMatchObject({ normalizedUrl: '/api/edits?layer=roads' }));
  it('drops fragments from normalized replay URL', () => expect(policy().evaluate(candidate({ url: '/api/edits?x=1#private' }))).toMatchObject({ normalizedUrl: '/api/edits?x=1' }));
  it('records privacy-safe counters', () => { const replay = policy(); replay.evaluate(candidate()); replay.evaluate(candidate({ url: '/outside' })); expect(replay.snapshot()).toEqual({ evaluated: 2, allowed: 1, rejected: 1, lastRejection: 'unsafe-path' }); });
  it('returns frozen decisions and diagnostics', () => { const replay = policy(); expect(Object.isFrozen(replay.evaluate(candidate()))).toBe(true); expect(Object.isFrozen(replay.snapshot())).toBe(true); });
  it('does not leak rejected URL or headers through diagnostics', () => { const replay = policy(); replay.evaluate(candidate({ url: 'https://evil.example/private?token=secret', headers: { authorization: 'secret' } })); expect(JSON.stringify(replay.snapshot())).not.toContain('secret'); expect(JSON.stringify(replay.snapshot())).not.toContain('evil.example'); });
  it('requires a valid origin', () => expect(() => new OfflineReplayPolicy({ origin: 'not a url' })).toThrow());
  it('rejects non-http origins', () => expect(() => new OfflineReplayPolicy({ origin: 'file:///tmp/app' })).toThrow(TypeError));
  it('rejects origins containing a path', () => expect(() => new OfflineReplayPolicy({ origin: 'https://kent.example/app' })).toThrow(TypeError));
  it('rejects origins containing credentials', () => expect(() => new OfflineReplayPolicy({ origin: 'https://user:pass@kent.example' })).toThrow(TypeError));
  it.each(['api', '//evil.example/api', '/api\\evil', '/api#fragment'])('rejects unsafe configured prefix %s', prefix => expect(() => policy({ origin: 'https://kent.example', allowedPathPrefixes: [prefix] })).toThrow(TypeError));
  it('requires at least one path prefix', () => expect(() => policy({ origin: 'https://kent.example', allowedPathPrefixes: [] })).toThrow(RangeError));
  it('bounds path-prefix cardinality', () => expect(() => policy({ origin: 'https://kent.example', allowedPathPrefixes: Array.from({ length: 33 }, (_, index) => `/p${index}/`) })).toThrow(RangeError));
  it.each([-1, 8 * 1024 * 1024 + 1, 1.5])('rejects invalid body budget %s', maxBodyBytes => expect(() => policy({ origin: 'https://kent.example', maxBodyBytes })).toThrow(RangeError));
  it.each([999, 7 * 24 * 60 * 60 * 1000 + 1, 1.5])('rejects invalid max age %s', maxAgeMs => expect(() => policy({ origin: 'https://kent.example', maxAgeMs })).toThrow(RangeError));
  it('rejects a non-finite clock without exposing candidate data', () => expect(policy({ origin: 'https://kent.example', clock: () => Number.NaN }).evaluate(candidate())).toMatchObject({ reason: 'invalid-time' }));
});
