import { describe, expect, it } from 'vitest';
import { ArcGisServiceCircuitCoordinator } from './ArcGisServiceCircuitCoordinator';

const policy = {
  maxServices: 2,
  maxServiceKeyLength: 32,
  failureThreshold: 3,
  successThreshold: 2,
  openDurationMs: 100,
  maxOpenDurationMs: 800,
  backoffMultiplier: 2,
  maxClockSkewMs: 10,
  retentionMs: 1_000,
} as const;

const create = () => new ArcGisServiceCircuitCoordinator(policy);

describe('ArcGisServiceCircuitCoordinator', () => {
  it('admits unknown services without materializing state', () => {
    const coordinator = create();
    expect(coordinator.admit('parcels', 10)).toEqual({ serviceKey: 'parcels', admitted: true, state: 'closed', retryAtMs: null, revision: 0 });
    expect(coordinator.snapshot(10).circuits).toEqual([]);
  });

  it('opens after the configured consecutive failure threshold', () => {
    const coordinator = create();
    expect(coordinator.record('roads', 'failure', 10).state).toBe('closed');
    expect(coordinator.record('roads', 'failure', 20).state).toBe('closed');
    const opened = coordinator.record('roads', 'failure', 30);
    expect(opened.state).toBe('open');
    expect(opened.openedAtMs).toBe(30);
    expect(opened.retryAtMs).toBe(130);
    expect(coordinator.admit('roads', 40).admitted).toBe(false);
  });

  it('moves an eligible open circuit to half-open during admission', () => {
    const coordinator = create();
    coordinator.record('roads', 'failure', 10);
    coordinator.record('roads', 'failure', 20);
    coordinator.record('roads', 'failure', 30);
    expect(coordinator.admit('roads', 129).state).toBe('open');
    const admission = coordinator.admit('roads', 130);
    expect(admission.admitted).toBe(true);
    expect(admission.state).toBe('half-open');
    expect(coordinator.get('roads', 130)?.state).toBe('half-open');
  });

  it('requires configured successes before closing a half-open circuit', () => {
    const coordinator = create();
    coordinator.record('roads', 'failure', 10);
    coordinator.record('roads', 'failure', 20);
    coordinator.record('roads', 'failure', 30);
    coordinator.admit('roads', 130);
    expect(coordinator.record('roads', 'success', 131).state).toBe('half-open');
    const closed = coordinator.record('roads', 'success', 132);
    expect(closed.state).toBe('closed');
    expect(closed.openedAtMs).toBeNull();
    expect(closed.retryAtMs).toBeNull();
  });

  it('reopens immediately when a half-open probe fails', () => {
    const coordinator = create();
    coordinator.record('roads', 'failure', 10);
    coordinator.record('roads', 'failure', 20);
    coordinator.record('roads', 'failure', 30);
    coordinator.admit('roads', 130);
    const reopened = coordinator.record('roads', 'failure', 131);
    expect(reopened.state).toBe('open');
    expect(reopened.openCount).toBe(2);
    expect(reopened.retryAtMs).toBe(331);
  });

  it('caps exponential reopen delay', () => {
    const coordinator = create();
    let now = 0;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      if (cycle === 0) {
        coordinator.record('roads', 'failure', ++now);
        coordinator.record('roads', 'failure', ++now);
        coordinator.record('roads', 'failure', ++now);
      } else {
        const current = coordinator.get('roads', now)!;
        now = current.retryAtMs!;
        coordinator.admit('roads', now);
        coordinator.record('roads', 'failure', ++now);
      }
    }
    const state = coordinator.get('roads', now)!;
    expect(state.retryAtMs! - state.openedAtMs!).toBe(800);
  });

  it('does not allow outcomes while admission is denied', () => {
    const coordinator = create();
    coordinator.record('roads', 'failure', 10);
    coordinator.record('roads', 'failure', 20);
    coordinator.record('roads', 'failure', 30);
    expect(() => coordinator.record('roads', 'success', 40)).toThrow('admission');
    expect(() => coordinator.record('roads', 'failure', 40)).toThrow('admission');
  });

  it('resets closed failure streak on success', () => {
    const coordinator = create();
    coordinator.record('roads', 'failure', 10);
    expect(coordinator.record('roads', 'success', 20).consecutiveFailures).toBe(0);
    expect(coordinator.record('roads', 'failure', 30).consecutiveFailures).toBe(1);
  });

  it('rejects stale observations beyond clock skew', () => {
    const coordinator = create();
    coordinator.record('roads', 'success', 100);
    expect(() => coordinator.record('roads', 'failure', 89)).toThrow('stale');
    expect(() => coordinator.record('roads', 'failure', 90)).not.toThrow();
  });

  it('bounds and sanitizes service identity', () => {
    const coordinator = create();
    expect(() => coordinator.record('', 'success', 1)).toThrow('service key');
    expect(() => coordinator.record('x'.repeat(33), 'success', 1)).toThrow('service key');
    expect(() => coordinator.record('roads\0evil', 'success', 1)).toThrow('service key');
    expect(coordinator.record('  roads  ', 'success', 1).serviceKey).toBe('roads');
  });

  it('rejects invalid outcomes at runtime', () => {
    const coordinator = create();
    expect(() => coordinator.record('roads', 'timeout' as never, 1)).toThrow('outcome');
  });

  it('evicts the oldest service deterministically at capacity', () => {
    const coordinator = create();
    coordinator.record('b', 'success', 10);
    coordinator.record('a', 'success', 10);
    coordinator.record('c', 'success', 20);
    expect(coordinator.get('a', 20)).toBeNull();
    expect(coordinator.snapshot(20).circuits.map(item => item.serviceKey)).toEqual(['b', 'c']);
  });

  it('prunes retained state after the configured horizon', () => {
    const coordinator = create();
    coordinator.record('roads', 'success', 10);
    expect(coordinator.get('roads', 1_010)).not.toBeNull();
    expect(coordinator.get('roads', 1_011)).toBeNull();
  });

  it('restores valid closed, half-open and open state atomically', () => {
    const coordinator = create();
    coordinator.restore({ circuits: [
      { serviceKey: 'a', state: 'closed', consecutiveFailures: 1, consecutiveSuccesses: 0, openedAtMs: null, retryAtMs: null, lastObservedAtMs: 100, openCount: 0, revision: 1 },
      { serviceKey: 'b', state: 'open', consecutiveFailures: 3, consecutiveSuccesses: 0, openedAtMs: 100, retryAtMs: 200, lastObservedAtMs: 100, openCount: 1, revision: 2 },
    ] }, 100);
    expect(coordinator.snapshot(100).circuits).toHaveLength(2);
    expect(coordinator.get('b', 100)?.state).toBe('open');
  });

  it('rejects duplicate restored service identities without replacing live state', () => {
    const coordinator = create();
    coordinator.record('live', 'success', 10);
    const item = { serviceKey: 'roads', state: 'closed' as const, consecutiveFailures: 0, consecutiveSuccesses: 0, openedAtMs: null, retryAtMs: null, lastObservedAtMs: 20, openCount: 0, revision: 1 };
    expect(() => coordinator.restore({ circuits: [item, item] }, 20)).toThrow('duplicate');
    expect(coordinator.get('live', 20)).not.toBeNull();
  });

  it('rejects future restored observations', () => {
    const coordinator = create();
    expect(() => coordinator.restore({ circuits: [{ serviceKey: 'roads', state: 'closed', consecutiveFailures: 0, consecutiveSuccesses: 0, openedAtMs: null, retryAtMs: null, lastObservedAtMs: 111, openCount: 0, revision: 1 }] }, 100)).toThrow('future');
  });

  it('rejects inconsistent open restore state', () => {
    const coordinator = create();
    expect(() => coordinator.restore({ circuits: [{ serviceKey: 'roads', state: 'open', consecutiveFailures: 2, consecutiveSuccesses: 0, openedAtMs: 100, retryAtMs: 200, lastObservedAtMs: 100, openCount: 1, revision: 1 }] }, 100)).toThrow('inconsistent');
  });

  it('rejects open restore durations beyond the configured maximum', () => {
    const coordinator = create();
    expect(() => coordinator.restore({ circuits: [{ serviceKey: 'roads', state: 'open', consecutiveFailures: 3, consecutiveSuccesses: 0, openedAtMs: 100, retryAtMs: 901, lastObservedAtMs: 100, openCount: 1, revision: 1 }] }, 100)).toThrow('duration');
  });

  it('rejects open timestamps on a closed restore item', () => {
    const coordinator = create();
    expect(() => coordinator.restore({ circuits: [{ serviceKey: 'roads', state: 'closed', consecutiveFailures: 0, consecutiveSuccesses: 0, openedAtMs: 100, retryAtMs: null, lastObservedAtMs: 100, openCount: 0, revision: 1 }] }, 100)).toThrow('non-open');
  });

  it('rejects threshold failures on a closed restore item', () => {
    const coordinator = create();
    expect(() => coordinator.restore({ circuits: [{ serviceKey: 'roads', state: 'closed', consecutiveFailures: 3, consecutiveSuccesses: 0, openedAtMs: null, retryAtMs: null, lastObservedAtMs: 100, openCount: 0, revision: 1 }] }, 100)).toThrow('closed');
  });

  it('rejects failures carried into half-open restored state', () => {
    const coordinator = create();
    expect(() => coordinator.restore({ circuits: [{ serviceKey: 'roads', state: 'half-open', consecutiveFailures: 1, consecutiveSuccesses: 0, openedAtMs: null, retryAtMs: null, lastObservedAtMs: 100, openCount: 1, revision: 1 }] }, 100)).toThrow('half-open');
  });

  it('freezes returned state and snapshots', () => {
    const coordinator = create();
    const item = coordinator.record('roads', 'success', 1);
    const snapshot = coordinator.snapshot(1);
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.circuits)).toBe(true);
    expect(Object.isFrozen(snapshot.circuits[0])).toBe(true);
  });

  it('becomes unusable after idempotent disposal', () => {
    const coordinator = create();
    coordinator.record('roads', 'success', 1);
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.snapshot(2)).toThrow('disposed');
    expect(() => coordinator.admit('roads', 2)).toThrow('disposed');
    expect(() => coordinator.record('roads', 'success', 2)).toThrow('disposed');
  });

  it('validates policy invariants', () => {
    expect(() => new ArcGisServiceCircuitCoordinator({ ...policy, backoffMultiplier: 0.5 })).toThrow('backoffMultiplier');
    expect(() => new ArcGisServiceCircuitCoordinator({ ...policy, openDurationMs: 900 })).toThrow('openDurationMs');
    expect(() => new ArcGisServiceCircuitCoordinator({ ...policy, maxServices: 0 })).toThrow('maxServices');
  });
});
