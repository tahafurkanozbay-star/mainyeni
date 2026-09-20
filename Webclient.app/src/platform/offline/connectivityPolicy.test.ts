import { describe, expect, it } from 'vitest';
import { ConnectivityPolicy } from './connectivityPolicy';

describe('ConnectivityPolicy', () => {
  it('starts unknown without inventing network state', () => {
    expect(new ConnectivityPolicy().snapshot()).toMatchObject({ state: 'unknown', confidence: 0 });
  });

  it('accepts explicit browser online evidence', () => {
    const policy = new ConnectivityPolicy();
    expect(policy.observe({ kind: 'browser', online: true, at: 1 })).toMatchObject({ state: 'online', consecutiveSuccesses: 1 });
  });

  it('treats explicit browser offline evidence as authoritative', () => {
    const policy = new ConnectivityPolicy();
    expect(policy.observe({ kind: 'browser', online: false, at: 1 })).toMatchObject({ state: 'offline', confidence: 1, consecutiveFailures: 1 });
  });

  it('requires bounded repeated request failures before offline', () => {
    const policy = new ConnectivityPolicy({ offlineFailureThreshold: 3 });
    expect(policy.observe({ kind: 'request-failure', at: 1 }).state).toBe('degraded');
    expect(policy.observe({ kind: 'request-failure', at: 2 }).state).toBe('degraded');
    expect(policy.observe({ kind: 'request-failure', at: 3 }).state).toBe('offline');
  });

  it('uses probe failures as stronger confidence evidence', () => {
    const policy = new ConnectivityPolicy({ offlineFailureThreshold: 2 });
    const first = policy.observe({ kind: 'probe-failure', at: 1 });
    expect(first).toMatchObject({ state: 'degraded', confidence: 0 });
    const second = policy.observe({ kind: 'probe-failure', at: 2 });
    expect(second.state).toBe('offline');
    expect(second.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('requires recovery hysteresis after offline state', () => {
    const policy = new ConnectivityPolicy({ offlineFailureThreshold: 1, recoverySuccessThreshold: 2 });
    policy.observe({ kind: 'request-failure', at: 1 });
    expect(policy.observe({ kind: 'request-success', at: 2 }).state).toBe('degraded');
    expect(policy.observe({ kind: 'request-success', at: 3 }).state).toBe('online');
  });

  it('classifies high latency as degraded despite successful requests', () => {
    const policy = new ConnectivityPolicy({ degradedLatencyMs: 1000 });
    expect(policy.observe({ kind: 'request-success', latencyMs: 1500, at: 1 })).toMatchObject({ state: 'degraded', latencyMs: 1500 });
  });

  it('returns online when latency recovers', () => {
    const policy = new ConnectivityPolicy({ degradedLatencyMs: 1000 });
    policy.observe({ kind: 'request-success', latencyMs: 1500, at: 1 });
    expect(policy.observe({ kind: 'request-success', latencyMs: 200, at: 2 }).state).toBe('online');
  });

  it('marks stale evidence unknown', () => {
    const policy = new ConnectivityPolicy({ staleAfterMs: 1000 });
    policy.observe({ kind: 'request-success', at: 1 });
    expect(policy.snapshot(1002)).toMatchObject({ state: 'unknown', confidence: 0, reason: 'connectivity-evidence-stale' });
  });

  it('preserves fresh evidence before staleness threshold', () => {
    const policy = new ConnectivityPolicy({ staleAfterMs: 1000 });
    policy.observe({ kind: 'request-success', at: 1 });
    expect(policy.snapshot(1001).state).toBe('online');
  });

  it('rejects non-monotonic signal timestamps', () => {
    const policy = new ConnectivityPolicy();
    policy.observe({ kind: 'request-success', at: 10 });
    expect(() => policy.observe({ kind: 'request-success', at: 9 })).toThrow(RangeError);
  });

  it('requires browser signal online boolean', () => {
    expect(() => new ConnectivityPolicy().observe({ kind: 'browser', at: 1 })).toThrow(TypeError);
  });

  it('validates latency', () => {
    expect(() => new ConnectivityPolicy().observe({ kind: 'request-success', latencyMs: -1, at: 1 })).toThrow(RangeError);
    expect(() => new ConnectivityPolicy().observe({ kind: 'request-success', latencyMs: Number.NaN, at: 1 })).toThrow(RangeError);
  });

  it('validates status', () => {
    expect(() => new ConnectivityPolicy().observe({ kind: 'request-failure', status: 1000, at: 1 })).toThrow(RangeError);
  });

  it('sanitizes bounded reasons', () => {
    const policy = new ConnectivityPolicy({ maxReasonLength: 16 });
    const snapshot = policy.observe({ kind: 'request-failure', reason: `network\n${'x'.repeat(40)}`, at: 1 });
    expect(snapshot.reason?.length).toBeLessThanOrEqual(16);
    expect(snapshot.reason).not.toContain('\n');
  });

  it('omits empty reasons', () => {
    const policy = new ConnectivityPolicy();
    expect(policy.observe({ kind: 'request-failure', reason: '   ', at: 1 }).reason).toBeUndefined();
  });

  it('tracks last success and failure separately', () => {
    const policy = new ConnectivityPolicy();
    policy.observe({ kind: 'request-success', at: 10 });
    const snapshot = policy.observe({ kind: 'request-failure', at: 20 });
    expect(snapshot).toMatchObject({ lastSuccessAt: 10, lastFailureAt: 20, lastSignalAt: 20 });
  });

  it('resets opposite streak on success', () => {
    const policy = new ConnectivityPolicy();
    policy.observe({ kind: 'request-failure', at: 1 });
    expect(policy.observe({ kind: 'request-success', at: 2 })).toMatchObject({ consecutiveFailures: 0, consecutiveSuccesses: 1 });
  });

  it('resets opposite streak on failure', () => {
    const policy = new ConnectivityPolicy();
    policy.observe({ kind: 'request-success', at: 1 });
    expect(policy.observe({ kind: 'request-failure', at: 2 })).toMatchObject({ consecutiveFailures: 1, consecutiveSuccesses: 0 });
  });

  it('keeps immutable bounded history', () => {
    const policy = new ConnectivityPolicy({ historyLimit: 2 });
    policy.observe({ kind: 'request-success', at: 1 });
    policy.observe({ kind: 'request-failure', at: 2 });
    policy.observe({ kind: 'request-success', at: 3 });
    const history = policy.history();
    expect(history).toHaveLength(2);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
    expect(history.map(item => item.sequence)).toEqual([2, 3]);
  });

  it('can disable history', () => {
    const policy = new ConnectivityPolicy({ historyLimit: 0 });
    policy.observe({ kind: 'request-success', at: 1 });
    expect(policy.history()).toEqual([]);
  });

  it('reset clears state and history', () => {
    const policy = new ConnectivityPolicy();
    policy.observe({ kind: 'request-success', at: 1 });
    policy.reset();
    expect(policy.snapshot(1)).toMatchObject({ state: 'unknown', confidence: 0, consecutiveSuccesses: 0, consecutiveFailures: 0 });
    expect(policy.history()).toEqual([]);
  });

  it('validates constructor thresholds', () => {
    expect(() => new ConnectivityPolicy({ historyLimit: -1 })).toThrow(RangeError);
    expect(() => new ConnectivityPolicy({ offlineFailureThreshold: 0 })).toThrow(RangeError);
    expect(() => new ConnectivityPolicy({ recoverySuccessThreshold: 0 })).toThrow(RangeError);
    expect(() => new ConnectivityPolicy({ degradedLatencyMs: 99 })).toThrow(RangeError);
    expect(() => new ConnectivityPolicy({ staleAfterMs: 999 })).toThrow(RangeError);
    expect(() => new ConnectivityPolicy({ maxReasonLength: 15 })).toThrow(RangeError);
  });

  it('uses injected monotonic clock when timestamps are omitted', () => {
    let now = 0;
    const policy = new ConnectivityPolicy({ clock: () => ++now });
    policy.observe({ kind: 'request-success' });
    expect(policy.snapshot()).toMatchObject({ lastSignalAt: 1 });
  });

  it('records the signal kind in diagnostics', () => {
    const policy = new ConnectivityPolicy();
    policy.observe({ kind: 'probe-success', at: 1 });
    expect(policy.history()[0]).toMatchObject({ signal: 'probe-success', state: 'online' });
  });

  it('does not treat HTTP status alone as connectivity state', () => {
    const policy = new ConnectivityPolicy();
    const snapshot = policy.observe({ kind: 'request-success', status: 404, at: 1 });
    expect(snapshot.state).toBe('online');
  });
});
