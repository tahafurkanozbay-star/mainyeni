import { describe, expect, it } from 'vitest';
import { ArcGisServiceQueryIntegrityCoordinator, type ArcGisServiceQueryIntegrityPolicy } from './ArcGisServiceQueryIntegrityCoordinator';

const policy = (overrides: Partial<ArcGisServiceQueryIntegrityPolicy> = {}): ArcGisServiceQueryIntegrityPolicy => ({
  maxSessions: 4,
  maxSessionsPerService: 2,
  maxServiceKeyLength: 32,
  maxSessionKeyLength: 32,
  maxIdentityLength: 40,
  maxIdentitiesPerSession: 6,
  maxPagesPerSession: 3,
  maxDiagnosticsPerSession: 2,
  maxClockSkewMs: 5,
  terminalRetentionMs: 20,
  ...overrides,
});

describe('ArcGisServiceQueryIntegrityCoordinator', () => {
  it('tracks primitive identities across pages and completes deterministically', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy());
    expect(runtime.begin(' parcels ', ' query-a ', 10)).toMatchObject({ serviceKey: 'parcels', sessionKey: 'query-a', state: 'active', pages: 0 });
    const first = runtime.recordPage({ serviceKey: 'parcels', sessionKey: 'query-a', timestampMs: 11, page: 1, identities: [1, 2, 'g-3'], hasMore: true });
    expect(first.identities).toEqual([1, 2, 'g-3']);
    expect(first.pages).toBe(1);
    const second = runtime.recordPage({ serviceKey: 'parcels', sessionKey: 'query-a', timestampMs: 12, page: 2, identities: [4, 'g-5'], hasMore: false });
    expect(second).toMatchObject({ state: 'complete', pages: 2, terminalAtMs: 12 });
    expect(second.identities).toEqual([1, 2, 'g-3', 4, 'g-5']);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.identities)).toBe(true);
  });

  it('keeps numeric and string object identities type-distinct', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy());
    runtime.begin('features', 'typed', 1);
    const result = runtime.recordPage({ serviceKey: 'features', sessionKey: 'typed', timestampMs: 2, page: 1, identities: [7, '7'], hasMore: false });
    expect(result.state).toBe('complete');
    expect(result.identities).toEqual([7, '7']);
  });

  it('fails closed on duplicate identities within the same page', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy());
    runtime.begin('features', 'dup', 1);
    const result = runtime.recordPage({ serviceKey: 'features', sessionKey: 'dup', timestampMs: 2, page: 1, identities: ['a', 'a'], hasMore: true });
    expect(result.state).toBe('failed');
    expect(result.identities).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: 'duplicate-identity', page: 1, observedAtMs: 2 }]);
  });

  it('fails closed on duplicate identities replayed by a later page', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy());
    runtime.begin('features', 'replay', 1);
    runtime.recordPage({ serviceKey: 'features', sessionKey: 'replay', timestampMs: 2, page: 1, identities: [1, 2], hasMore: true });
    const result = runtime.recordPage({ serviceKey: 'features', sessionKey: 'replay', timestampMs: 3, page: 2, identities: [2, 3], hasMore: true });
    expect(result.state).toBe('failed');
    expect(result.identities).toEqual([1, 2]);
    expect(result.diagnostics[0]?.code).toBe('duplicate-identity');
  });

  it('rejects skipped and replayed page ordinals without accepting payload identities', () => {
    const skipped = new ArcGisServiceQueryIntegrityCoordinator(policy());
    skipped.begin('svc', 'skip', 1);
    const skippedResult = skipped.recordPage({ serviceKey: 'svc', sessionKey: 'skip', timestampMs: 2, page: 2, identities: [1], hasMore: true });
    expect(skippedResult.state).toBe('failed');
    expect(skippedResult.identities).toEqual([]);
    expect(skippedResult.diagnostics[0]?.code).toBe('non-monotonic-page');

    const replayed = new ArcGisServiceQueryIntegrityCoordinator(policy());
    replayed.begin('svc', 'replay', 1);
    replayed.recordPage({ serviceKey: 'svc', sessionKey: 'replay', timestampMs: 2, page: 1, identities: [1], hasMore: true });
    const replayedResult = replayed.recordPage({ serviceKey: 'svc', sessionKey: 'replay', timestampMs: 3, page: 1, identities: [2], hasMore: true });
    expect(replayedResult.state).toBe('failed');
    expect(replayedResult.identities).toEqual([1]);
  });

  it('enforces identity and page budgets as terminal integrity failures', () => {
    const identityRuntime = new ArcGisServiceQueryIntegrityCoordinator(policy({ maxIdentitiesPerSession: 2 }));
    identityRuntime.begin('svc', 'ids', 1);
    const identityResult = identityRuntime.recordPage({ serviceKey: 'svc', sessionKey: 'ids', timestampMs: 2, page: 1, identities: [1, 2, 3], hasMore: true });
    expect(identityResult.state).toBe('failed');
    expect(identityResult.diagnostics[0]?.code).toBe('identity-budget');

    const pageRuntime = new ArcGisServiceQueryIntegrityCoordinator(policy({ maxPagesPerSession: 1 }));
    pageRuntime.begin('svc', 'pages', 1);
    pageRuntime.recordPage({ serviceKey: 'svc', sessionKey: 'pages', timestampMs: 2, page: 1, identities: [1], hasMore: true });
    const pageResult = pageRuntime.recordPage({ serviceKey: 'svc', sessionKey: 'pages', timestampMs: 3, page: 2, identities: [2], hasMore: true });
    expect(pageResult.state).toBe('failed');
    expect(pageResult.diagnostics[0]?.code).toBe('page-budget');
  });

  it('validates identity primitives and key boundaries', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy({ maxIdentityLength: 3 }));
    expect(() => runtime.begin('', 'x', 1)).toThrow('service key outside configured bounds');
    runtime.begin('svc', 'x', 1);
    expect(() => runtime.recordPage({ serviceKey: 'svc', sessionKey: 'x', timestampMs: 2, page: 1, identities: ['long'], hasMore: true })).toThrow('query identity outside configured bounds');
    expect(() => runtime.recordPage({ serviceKey: 'svc', sessionKey: 'x', timestampMs: 2, page: 1, identities: [Number.MAX_SAFE_INTEGER + 1], hasMore: true })).toThrow('query identity must be a safe integer');
  });

  it('supports explicit cancellation and failure without payload ownership', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy());
    runtime.begin('svc', 'cancel', 1);
    expect(runtime.cancel('svc', 'cancel', 2)).toMatchObject({ state: 'cancelled', terminalAtMs: 2 });
    runtime.begin('svc', 'fail', 3);
    expect(runtime.fail('svc', 'fail', 4)).toMatchObject({ state: 'failed', terminalAtMs: 4 });
    expect(() => runtime.fail('svc', 'fail', 5)).toThrow('query integrity session is terminal');
  });

  it('evicts terminal sessions before refusing to evict active work', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy({ maxSessions: 2, maxSessionsPerService: 2 }));
    runtime.begin('svc', 'old', 1);
    runtime.cancel('svc', 'old', 2);
    runtime.begin('svc', 'active', 3);
    runtime.begin('svc', 'new', 4);
    expect(runtime.get('svc', 'old')).toBeNull();
    expect(runtime.get('svc', 'active')?.state).toBe('active');
    expect(runtime.get('svc', 'new')?.state).toBe('active');
    expect(() => runtime.begin('svc', 'overflow', 5)).toThrow('query integrity capacity exhausted by active sessions');
  });

  it('enforces global capacity across services', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy({ maxSessions: 2, maxSessionsPerService: 1 }));
    runtime.begin('a', 'one', 1);
    runtime.begin('b', 'two', 2);
    expect(() => runtime.begin('c', 'three', 3)).toThrow('query integrity capacity exhausted by active sessions');
    runtime.cancel('a', 'one', 4);
    runtime.begin('c', 'three', 5);
    expect(runtime.get('a', 'one')).toBeNull();
  });

  it('prunes terminal state only after the configured retention horizon', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy({ terminalRetentionMs: 10 }));
    runtime.begin('svc', 'done', 1);
    runtime.recordPage({ serviceKey: 'svc', sessionKey: 'done', timestampMs: 2, page: 1, identities: [1], hasMore: false });
    expect(runtime.prune(12)).toBe(0);
    expect(runtime.prune(13)).toBe(1);
    expect(runtime.get('svc', 'done')).toBeNull();
  });

  it('rejects stale clocks beyond tolerance', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy({ maxClockSkewMs: 2 }));
    runtime.begin('svc', 'clock', 10);
    expect(() => runtime.recordPage({ serviceKey: 'svc', sessionKey: 'clock', timestampMs: 7, page: 1, identities: [1], hasMore: false })).toThrow('stale query integrity clock');
  });

  it('produces deterministic immutable snapshots', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy());
    runtime.begin('z', 'b', 1);
    runtime.begin('a', 'c', 2);
    runtime.begin('a', 'a', 3);
    const snapshot = runtime.snapshot(4);
    expect(snapshot.sessions.map((entry) => `${entry.serviceKey}/${entry.sessionKey}`)).toEqual(['a/a', 'a/c', 'z/b']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sessions)).toBe(true);
  });

  it('restores valid state atomically and preserves typed identity distinctions', () => {
    const source = new ArcGisServiceQueryIntegrityCoordinator(policy());
    source.begin('svc', 'q', 1);
    source.recordPage({ serviceKey: 'svc', sessionKey: 'q', timestampMs: 2, page: 1, identities: [1, '1'], hasMore: true });
    const snapshot = source.snapshot(3);
    const restored = new ArcGisServiceQueryIntegrityCoordinator(policy());
    restored.restore(snapshot, 3);
    expect(restored.get('svc', 'q')).toMatchObject({ state: 'active', pages: 1, identities: [1, '1'] });
  });

  it('rejects duplicate identities in snapshots without mutating live state', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy());
    runtime.begin('live', 'safe', 1);
    expect(() => runtime.restore({ sessions: [{ serviceKey: 'svc', sessionKey: 'bad', state: 'active', startedAtMs: 1, updatedAtMs: 1, terminalAtMs: null, pages: 1, identities: ['x', 'x'], diagnostics: [], generation: 1 }] }, 2)).toThrow('duplicate query identity in snapshot');
    expect(runtime.get('live', 'safe')?.state).toBe('active');
  });

  it('rejects invalid terminal chronology during restore atomically', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy());
    runtime.begin('live', 'safe', 1);
    expect(() => runtime.restore({ sessions: [{ serviceKey: 'svc', sessionKey: 'bad', state: 'complete', startedAtMs: 1, updatedAtMs: 5, terminalAtMs: 4, pages: 1, identities: [1], diagnostics: [], generation: 1 }] }, 6)).toThrow('invalid query integrity terminal timestamp');
    expect(runtime.get('live', 'safe')).not.toBeNull();
  });

  it('rejects future observations and oversized diagnostics during restore', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy({ maxClockSkewMs: 1, maxDiagnosticsPerSession: 1 }));
    expect(() => runtime.restore({ sessions: [{ serviceKey: 'svc', sessionKey: 'future', state: 'failed', startedAtMs: 1, updatedAtMs: 2, terminalAtMs: 2, pages: 0, identities: [], diagnostics: [{ code: 'page-budget', page: 1, observedAtMs: 5 }], generation: 1 }] }, 2)).toThrow('future query integrity diagnostic');
    expect(() => runtime.restore({ sessions: [{ serviceKey: 'svc', sessionKey: 'many', state: 'failed', startedAtMs: 1, updatedAtMs: 2, terminalAtMs: 2, pages: 0, identities: [], diagnostics: [{ code: 'page-budget', page: 1, observedAtMs: 2 }, { code: 'identity-budget', page: 1, observedAtMs: 2 }], generation: 1 }] }, 2)).toThrow('query integrity diagnostic budget exceeded');
  });

  it('rejects per-service restore overflow atomically', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy({ maxSessionsPerService: 1 }));
    runtime.begin('live', 'safe', 1);
    const entry = (sessionKey: string) => ({ serviceKey: 'svc', sessionKey, state: 'active' as const, startedAtMs: 1, updatedAtMs: 1, terminalAtMs: null, pages: 0, identities: [], diagnostics: [], generation: 1 });
    expect(() => runtime.restore({ sessions: [entry('a'), entry('b')] }, 2)).toThrow('per-service query integrity capacity exceeded');
    expect(runtime.get('live', 'safe')).not.toBeNull();
  });

  it('allows a terminal session key to begin a new generation', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy());
    const first = runtime.begin('svc', 'same', 1);
    runtime.cancel('svc', 'same', 2);
    const second = runtime.begin('svc', 'same', 3);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second).toMatchObject({ state: 'active', pages: 0, identities: [] });
  });

  it('fails closed after disposal', () => {
    const runtime = new ArcGisServiceQueryIntegrityCoordinator(policy());
    runtime.begin('svc', 'q', 1);
    runtime.dispose();
    runtime.dispose();
    expect(() => runtime.snapshot(2)).toThrow('ArcGisServiceQueryIntegrityCoordinator is disposed');
    expect(() => runtime.begin('svc', 'new', 2)).toThrow('ArcGisServiceQueryIntegrityCoordinator is disposed');
  });

  it('validates constructor policy relationships', () => {
    expect(() => new ArcGisServiceQueryIntegrityCoordinator(policy({ maxSessions: 1, maxSessionsPerService: 2 }))).toThrow('per-service query integrity capacity exceeds global capacity');
    expect(() => new ArcGisServiceQueryIntegrityCoordinator(policy({ maxSessions: 0 }))).toThrow('maxSessions outside configured bounds');
  });
});
