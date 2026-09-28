import { describe, expect, it } from 'vitest';
import { ArcGisServicePaginationCoordinator, type ArcGisServicePaginationPolicy } from './ArcGisServicePaginationCoordinator';

const policy: ArcGisServicePaginationPolicy = {
  maxSessions: 3,
  maxSessionsPerService: 2,
  maxServiceKeyLength: 32,
  maxSessionKeyLength: 32,
  maxPages: 3,
  maxFeatures: 10,
  maxBytes: 1000,
  maxPageSize: 5,
  maxDurationMs: 100,
  terminalRetentionMs: 20,
  maxClockSkewMs: 2,
};

describe('ArcGisServicePaginationCoordinator', () => {
  it('tracks bounded ArcGIS page traversal without retaining payloads', () => {
    const runtime = new ArcGisServicePaginationCoordinator(policy);
    expect(runtime.begin('parcels', 'q-1', 10, 0)).toMatchObject({ state: 'active', pages: 0, nextOffset: 0 });
    expect(runtime.decide('parcels', 'q-1', 10)).toEqual({ admitted: true, reason: 'ready', nextOffset: 0, remainingPages: 3, remainingFeatures: 10, remainingBytes: 1000 });
    expect(runtime.recordPage({ serviceKey: 'parcels', sessionKey: 'q-1', timestampMs: 11, featureCount: 4, byteCount: 300, nextOffset: 4, hasMore: true })).toMatchObject({ pages: 1, features: 4, bytes: 300, nextOffset: 4, state: 'active' });
    expect(runtime.recordPage({ serviceKey: 'parcels', sessionKey: 'q-1', timestampMs: 12, featureCount: 2, byteCount: 120, nextOffset: 6, hasMore: false })).toMatchObject({ pages: 2, features: 6, state: 'complete', terminalAtMs: 12 });
    expect(runtime.decide('parcels', 'q-1', 12)).toMatchObject({ admitted: false, reason: 'terminal' });
  });

  it('rejects non-advancing offsets and page payloads beyond policy', () => {
    const runtime = new ArcGisServicePaginationCoordinator(policy);
    runtime.begin('addresses', 'search', 1, 10);
    expect(() => runtime.recordPage({ serviceKey: 'addresses', sessionKey: 'search', timestampMs: 2, featureCount: 1, byteCount: 1, nextOffset: 10, hasMore: true })).toThrow(/offset did not advance/);
    expect(() => runtime.recordPage({ serviceKey: 'addresses', sessionKey: 'search', timestampMs: 2, featureCount: 6, byteCount: 1, nextOffset: 16, hasMore: true })).toThrow(/page feature count/);
    expect(runtime.snapshot(2).sessions[0]).toMatchObject({ pages: 0, features: 0, bytes: 0 });
  });

  it('fails closed before aggregate feature and byte budgets can be exceeded', () => {
    const runtime = new ArcGisServicePaginationCoordinator(policy);
    runtime.begin('poi', 'viewport', 0);
    runtime.recordPage({ serviceKey: 'poi', sessionKey: 'viewport', timestampMs: 1, featureCount: 5, byteCount: 700, nextOffset: 5, hasMore: true });
    expect(() => runtime.recordPage({ serviceKey: 'poi', sessionKey: 'viewport', timestampMs: 2, featureCount: 5, byteCount: 301, nextOffset: 10, hasMore: true })).toThrow(/byte budget/);
    runtime.recordPage({ serviceKey: 'poi', sessionKey: 'viewport', timestampMs: 2, featureCount: 5, byteCount: 300, nextOffset: 10, hasMore: true });
    expect(runtime.decide('poi', 'viewport', 3)).toMatchObject({ admitted: false, reason: 'feature-limit', remainingFeatures: 0, remainingBytes: 0 });
  });

  it('enforces page and duration admission limits', () => {
    const runtime = new ArcGisServicePaginationCoordinator({ ...policy, maxFeatures: 20, maxBytes: 5000 });
    runtime.begin('buildings', 'tiles', 100);
    for (let page = 0; page < 3; page += 1) runtime.recordPage({ serviceKey: 'buildings', sessionKey: 'tiles', timestampMs: 101 + page, featureCount: 1, byteCount: 1, nextOffset: page + 1, hasMore: true });
    expect(runtime.decide('buildings', 'tiles', 104)).toMatchObject({ admitted: false, reason: 'page-limit', remainingPages: 0 });
    runtime.begin('terrain', 'slow', 110);
    expect(runtime.decide('terrain', 'slow', 210)).toMatchObject({ admitted: false, reason: 'duration-limit' });
  });

  it('keeps cancellation and failure terminal and prunable', () => {
    const runtime = new ArcGisServicePaginationCoordinator(policy);
    runtime.begin('a', 'one', 10);
    expect(runtime.cancel('a', 'one', 11)).toMatchObject({ state: 'cancelled', terminalAtMs: 11 });
    runtime.begin('a', 'two', 12);
    expect(runtime.fail('a', 'two', 13)).toMatchObject({ state: 'failed', terminalAtMs: 13 });
    expect(() => runtime.cancel('a', 'two', 14)).toThrow(/terminal/);
    expect(runtime.prune(34)).toBe(2);
    expect(runtime.snapshot(34).sessions).toHaveLength(0);
  });

  it('evicts terminal sessions deterministically but never active work', () => {
    const runtime = new ArcGisServicePaginationCoordinator({ ...policy, maxSessions: 2, maxSessionsPerService: 2 });
    runtime.begin('svc', 'old', 1);
    runtime.cancel('svc', 'old', 2);
    runtime.begin('svc', 'active', 3);
    runtime.begin('svc', 'replacement', 4);
    expect(runtime.snapshot(4).sessions.map((entry) => entry.sessionKey)).toEqual(['active', 'replacement']);
    expect(() => runtime.begin('svc', 'overflow', 5)).toThrow(/exhausted by active/);
  });

  it('restores valid primitive snapshots atomically', () => {
    const source = new ArcGisServicePaginationCoordinator(policy);
    source.begin('parcels', 'one', 5);
    source.recordPage({ serviceKey: 'parcels', sessionKey: 'one', timestampMs: 6, featureCount: 2, byteCount: 100, nextOffset: 2, hasMore: true });
    source.begin('roads', 'two', 7);
    source.cancel('roads', 'two', 8);
    const snapshot = source.snapshot(8);
    const target = new ArcGisServicePaginationCoordinator(policy);
    target.restore(snapshot, 8);
    expect(target.snapshot(8).sessions).toEqual(snapshot.sessions);
  });

  it('rejects duplicate, over-budget, malformed and future snapshot state without partial mutation', () => {
    const runtime = new ArcGisServicePaginationCoordinator(policy);
    runtime.begin('safe', 'existing', 10);
    const before = runtime.snapshot(10).sessions;
    const valid = { serviceKey: 'svc', sessionKey: 'x', startedAtMs: 1, updatedAtMs: 2, state: 'active' as const, pages: 1, features: 1, bytes: 1, nextOffset: 1, generation: 1, terminalAtMs: null };
    expect(() => runtime.restore({ sessions: [valid, valid] }, 10)).toThrow(/duplicate/);
    expect(() => runtime.restore({ sessions: [{ ...valid, features: 11 }] }, 10)).toThrow(/exceeds budgets/);
    expect(() => runtime.restore({ sessions: [{ ...valid, serviceKey: 'bad\0key' }] }, 10)).toThrow(/outside configured bounds/);
    expect(() => runtime.restore({ sessions: [{ ...valid, updatedAtMs: 20 }] }, 10)).toThrow(/chronology/);
    expect(runtime.snapshot(10).sessions).toEqual(before);
  });

  it('rejects inconsistent terminal snapshot chronology', () => {
    const runtime = new ArcGisServicePaginationCoordinator(policy);
    const base = { serviceKey: 'svc', sessionKey: 'x', startedAtMs: 1, updatedAtMs: 5, state: 'complete' as const, pages: 1, features: 1, bytes: 1, nextOffset: 1, generation: 1 };
    expect(() => runtime.restore({ sessions: [{ ...base, terminalAtMs: null }] }, 10)).toThrow(/missing timestamp/);
    expect(() => runtime.restore({ sessions: [{ ...base, terminalAtMs: 4 }] }, 10)).toThrow(/terminal timestamp/);
  });

  it('rejects stale clocks and becomes unusable after disposal', () => {
    const runtime = new ArcGisServicePaginationCoordinator(policy);
    runtime.begin('svc', 'one', 100);
    expect(() => runtime.decide('svc', 'one', 97)).toThrow(/stale pagination clock/);
    runtime.dispose();
    expect(() => runtime.snapshot(101)).toThrow(/disposed/);
    runtime.dispose();
  });

  it('validates policy relationships and identifiers', () => {
    expect(() => new ArcGisServicePaginationCoordinator({ ...policy, maxSessions: 1, maxSessionsPerService: 2 })).toThrow(/per-service/);
    expect(() => new ArcGisServicePaginationCoordinator({ ...policy, maxFeatures: 4, maxPageSize: 5 })).toThrow(/page size/);
    const runtime = new ArcGisServicePaginationCoordinator(policy);
    expect(() => runtime.begin('', 'x', 1)).toThrow(/service key/);
    expect(() => runtime.begin('x', 'bad\u0001key', 1)).toThrow(/session key/);
  });
});
