import { describe, expect, it } from 'vitest';
import { ArcGisServiceRetryBudgetCoordinator, type ArcGisServiceRetryBudgetPolicy } from './ArcGisServiceRetryBudgetCoordinator';

const policy: ArcGisServiceRetryBudgetPolicy = {
  maxServices: 2,
  maxAttemptsPerRequest: 3,
  maxRetriesPerWindow: 4,
  maxRetriesPerServiceWindow: 2,
  windowMs: 1_000,
  baseBackoffMs: 100,
  maxBackoffMs: 1_000,
  maxJitterMs: 50,
  maxRequestLifetimeMs: 5_000,
  maxServiceKeyLength: 64,
  maxRequestIdLength: 64,
  maxClockSkewMs: 10,
};

describe('ArcGisServiceRetryBudgetCoordinator', () => {
  it('admits bounded retries with deterministic class-aware backoff', () => {
    const c = new ArcGisServiceRetryBudgetCoordinator(policy);
    expect(c.admit('parcels', 'r1', 1, 100, 100, 'interactive', 0)).toEqual({ admitted: true, reason: 'backoff', retryAtMs: 150, attempt: 1 });
    expect(c.admit('parcels', 'r1', 2, 100, 200, 'foreground', 7)).toEqual({ admitted: true, reason: 'backoff', retryAtMs: 407, attempt: 2 });
    expect(c.admit('parcels', 'r1', 3, 100, 300, 'background', 0)).toEqual({ admitted: false, reason: 'service-budget', retryAtMs: null, attempt: 3 });
  });

  it('rejects request attempt and lifetime overflow without consuming budget', () => {
    const c = new ArcGisServiceRetryBudgetCoordinator(policy);
    expect(c.admit('roads', 'r', 4, 0, 100, 'foreground').reason).toBe('attempt-limit');
    expect(c.admit('roads', 'r', 1, 0, 5_001, 'foreground').reason).toBe('deadline');
    expect(c.snapshot(5_001).globalRetriesInWindow).toBe(0);
  });

  it('enforces global and per-service windows', () => {
    const c = new ArcGisServiceRetryBudgetCoordinator({ ...policy, maxRetriesPerServiceWindow: 4 });
    for (let i = 0; i < 4; i += 1) expect(c.admit(i < 2 ? 'a' : 'b', `r${i}`, 1, 0, 100 + i, 'foreground').admitted).toBe(true);
    expect(c.admit('a', 'overflow', 1, 0, 200, 'foreground').reason).toBe('window-budget');
    expect(c.admit('a', 'new-window', 1, 0, 1_200, 'foreground').admitted).toBe(true);
  });

  it('evicts service state deterministically when bounded capacity is reached', () => {
    const c = new ArcGisServiceRetryBudgetCoordinator(policy);
    c.admit('a', 'a1', 1, 0, 100, 'foreground');
    c.admit('b', 'b1', 1, 0, 200, 'foreground');
    c.admit('c', 'c1', 1, 0, 300, 'foreground');
    expect(c.snapshot(300).services.map(item => item.serviceKey)).toEqual(['b', 'c']);
  });

  it('restores valid primitive state atomically', () => {
    const c = new ArcGisServiceRetryBudgetCoordinator(policy);
    c.restore({ globalWindowStartedAtMs: 100, globalRetriesInWindow: 1, services: [{ serviceKey: 'buildings', windowStartedAtMs: 100, retriesInWindow: 1, lastRetryAtMs: 150 }] }, 200);
    const snapshot = c.snapshot(200);
    expect(snapshot.globalRetriesInWindow).toBe(1);
    expect(snapshot.services[0]?.serviceKey).toBe('buildings');
  });

  it('fails closed on duplicate, future and over-budget restore state', () => {
    const c = new ArcGisServiceRetryBudgetCoordinator(policy);
    const before = c.snapshot(100);
    expect(() => c.restore({ globalWindowStartedAtMs: 100, globalRetriesInWindow: 0, services: [
      { serviceKey: 'x', windowStartedAtMs: 100, retriesInWindow: 0, lastRetryAtMs: null },
      { serviceKey: 'x', windowStartedAtMs: 100, retriesInWindow: 0, lastRetryAtMs: null },
    ] }, 100)).toThrow(/duplicate/);
    expect(c.snapshot(100).services).toEqual(before.services);
    expect(() => c.restore({ globalWindowStartedAtMs: 111, globalRetriesInWindow: 0, services: [] }, 100)).toThrow(/future/);
    expect(() => c.restore({ globalWindowStartedAtMs: 100, globalRetriesInWindow: 5, services: [] }, 100)).toThrow(/budget/);
  });

  it('rejects malformed identities and stale clocks', () => {
    const c = new ArcGisServiceRetryBudgetCoordinator(policy);
    expect(() => c.admit('bad\0service', 'r', 1, 0, 100, 'foreground')).toThrow(/bounds/);
    c.snapshot(100);
    expect(() => c.snapshot(89)).toThrow(/stale/);
  });

  it('caps exponential backoff and jitter without unsafe integer growth', () => {
    const c = new ArcGisServiceRetryBudgetCoordinator({ ...policy, maxAttemptsPerRequest: 40, maxRetriesPerServiceWindow: 40, maxRetriesPerWindow: 40 });
    const result = c.admit('imagery', 'r', 31, 0, 100, 'background', 50);
    expect(result.admitted).toBe(true);
    expect(result.retryAtMs).toBe(1_100);
  });

  it('disposes idempotently and rejects later use', () => {
    const c = new ArcGisServiceRetryBudgetCoordinator(policy);
    c.admit('a', 'r', 1, 0, 100, 'foreground');
    c.dispose();
    c.dispose();
    expect(() => c.snapshot(100)).toThrow(/disposed/);
  });
});
