import { describe, expect, it } from 'vitest';
import { ArcGisServiceDeadlineCoordinator, type ArcGisServiceDeadlinePolicy } from './ArcGisServiceDeadlineCoordinator';

const policy: ArcGisServiceDeadlinePolicy = {
  maxRequests: 4,
  maxRequestsPerService: 2,
  maxServiceKeyLength: 32,
  maxRequestKeyLength: 64,
  maxDurationMs: 10_000,
  maxClockSkewMs: 5,
  completedRetentionMs: 1_000,
};

const create = () => new ArcGisServiceDeadlineCoordinator(policy);

describe('ArcGisServiceDeadlineCoordinator', () => {
  it('tracks active deadlines without owning transport objects', () => {
    const coordinator = create();
    const entry = coordinator.begin({ serviceKey: 'parcels', requestKey: 'query:1', requestClass: 'interactive', startedAtMs: 100, durationMs: 50 });
    expect(entry.state).toBe('active');
    expect(entry.deadlineAtMs).toBe(150);
    expect(coordinator.decide('parcels', 'query:1', 120)).toEqual({ admitted: true, state: 'active', remainingMs: 30, shouldCancelTransport: false });
  });

  it('turns an elapsed deadline into an explicit transport cancellation signal', () => {
    const coordinator = create();
    coordinator.begin({ serviceKey: 'parcels', requestKey: 'query:1', requestClass: 'foreground', startedAtMs: 100, durationMs: 20 });
    expect(coordinator.decide('parcels', 'query:1', 120)).toEqual({ admitted: false, state: 'expired', remainingMs: 0, shouldCancelTransport: true });
    expect(coordinator.decide('parcels', 'query:1', 121).shouldCancelTransport).toBe(true);
  });

  it('records successful completion before the deadline', () => {
    const coordinator = create();
    coordinator.begin({ serviceKey: 'roads', requestKey: 'metadata', requestClass: 'background', startedAtMs: 10, durationMs: 100 });
    const result = coordinator.complete('roads', 'metadata', 40);
    expect(result.state).toBe('completed');
    expect(result.terminalAtMs).toBe(40);
    expect(coordinator.decide('roads', 'metadata', 41).admitted).toBe(false);
  });

  it('fails completion closed when the deadline already elapsed', () => {
    const coordinator = create();
    coordinator.begin({ serviceKey: 'roads', requestKey: 'features', requestClass: 'foreground', startedAtMs: 10, durationMs: 10 });
    expect(coordinator.complete('roads', 'features', 20).state).toBe('expired');
  });

  it('supports caller initiated cancellation', () => {
    const coordinator = create();
    coordinator.begin({ serviceKey: 'tiles', requestKey: 'tile:1', requestClass: 'interactive', startedAtMs: 100, durationMs: 500 });
    expect(coordinator.cancel('tiles', 'tile:1', 110).state).toBe('cancelled');
    expect(coordinator.decide('tiles', 'tile:1', 111).shouldCancelTransport).toBe(true);
  });

  it('bulk expires active work deterministically', () => {
    const coordinator = create();
    coordinator.begin({ serviceKey: 'a', requestKey: '1', requestClass: 'interactive', startedAtMs: 0, durationMs: 10 });
    coordinator.begin({ serviceKey: 'b', requestKey: '2', requestClass: 'background', startedAtMs: 0, durationMs: 20 });
    expect(coordinator.expire(10)).toBe(1);
    expect(coordinator.decide('a', '1', 10).state).toBe('expired');
    expect(coordinator.decide('b', '2', 10).state).toBe('active');
  });

  it('prunes terminal state only after retention', () => {
    const coordinator = create();
    coordinator.begin({ serviceKey: 'a', requestKey: '1', requestClass: 'interactive', startedAtMs: 0, durationMs: 10 });
    coordinator.complete('a', '1', 5);
    expect(coordinator.prune(1_005)).toBe(0);
    expect(coordinator.prune(1_006)).toBe(1);
    expect(coordinator.decide('a', '1', 1_006).state).toBe('missing');
  });

  it('rejects duplicate active request identity', () => {
    const coordinator = create();
    coordinator.begin({ serviceKey: 'a', requestKey: 'same', requestClass: 'interactive', startedAtMs: 1, durationMs: 10 });
    expect(() => coordinator.begin({ serviceKey: 'a', requestKey: 'same', requestClass: 'interactive', startedAtMs: 2, durationMs: 10 })).toThrow('already active');
  });

  it('permits reuse of terminal request identity with a new generation', () => {
    const coordinator = create();
    const first = coordinator.begin({ serviceKey: 'a', requestKey: 'same', requestClass: 'interactive', startedAtMs: 1, durationMs: 10 });
    coordinator.complete('a', 'same', 2);
    const second = coordinator.begin({ serviceKey: 'a', requestKey: 'same', requestClass: 'interactive', startedAtMs: 3, durationMs: 10 });
    expect(second.generation).toBe(first.generation + 1);
  });

  it('evicts terminal entries before admitting new work', () => {
    const coordinator = new ArcGisServiceDeadlineCoordinator({ ...policy, maxRequests: 2, maxRequestsPerService: 2 });
    coordinator.begin({ serviceKey: 'a', requestKey: 'old', requestClass: 'background', startedAtMs: 0, durationMs: 10 });
    coordinator.complete('a', 'old', 1);
    coordinator.begin({ serviceKey: 'a', requestKey: 'active', requestClass: 'interactive', startedAtMs: 2, durationMs: 10 });
    coordinator.begin({ serviceKey: 'a', requestKey: 'new', requestClass: 'interactive', startedAtMs: 3, durationMs: 10 });
    expect(coordinator.decide('a', 'old', 3).state).toBe('missing');
  });

  it('does not evict live requests when service capacity is exhausted', () => {
    const coordinator = new ArcGisServiceDeadlineCoordinator({ ...policy, maxRequests: 2, maxRequestsPerService: 2 });
    coordinator.begin({ serviceKey: 'a', requestKey: '1', requestClass: 'interactive', startedAtMs: 0, durationMs: 100 });
    coordinator.begin({ serviceKey: 'a', requestKey: '2', requestClass: 'foreground', startedAtMs: 1, durationMs: 100 });
    expect(() => coordinator.begin({ serviceKey: 'a', requestKey: '3', requestClass: 'background', startedAtMs: 2, durationMs: 100 })).toThrow('capacity exhausted by active requests');
  });

  it('enforces global capacity independently from service capacity', () => {
    const coordinator = new ArcGisServiceDeadlineCoordinator({ ...policy, maxRequests: 2, maxRequestsPerService: 1 });
    coordinator.begin({ serviceKey: 'a', requestKey: '1', requestClass: 'interactive', startedAtMs: 0, durationMs: 100 });
    coordinator.begin({ serviceKey: 'b', requestKey: '2', requestClass: 'interactive', startedAtMs: 1, durationMs: 100 });
    expect(() => coordinator.begin({ serviceKey: 'c', requestKey: '3', requestClass: 'interactive', startedAtMs: 2, durationMs: 100 })).toThrow('capacity exhausted by active requests');
  });

  it('rejects invalid keys and classes', () => {
    const coordinator = create();
    expect(() => coordinator.begin({ serviceKey: ' ', requestKey: '1', requestClass: 'interactive', startedAtMs: 0, durationMs: 1 })).toThrow();
    expect(() => coordinator.begin({ serviceKey: 'a\u0001b', requestKey: '1', requestClass: 'interactive', startedAtMs: 0, durationMs: 1 })).toThrow();
    expect(() => coordinator.begin({ serviceKey: 'a', requestKey: '1', requestClass: 'batch' as never, startedAtMs: 0, durationMs: 1 })).toThrow('invalid request class');
  });

  it('rejects duration beyond configured maximum', () => {
    expect(() => create().begin({ serviceKey: 'a', requestKey: '1', requestClass: 'interactive', startedAtMs: 0, durationMs: 10_001 })).toThrow('duration exceeds policy');
  });

  it('rejects stale clocks beyond tolerance', () => {
    const coordinator = create();
    coordinator.snapshot(100);
    expect(() => coordinator.snapshot(94)).toThrow('stale deadline clock');
  });

  it('allows bounded clock skew without moving the monotonic watermark backward', () => {
    const coordinator = create();
    coordinator.snapshot(100);
    coordinator.snapshot(96);
    expect(() => coordinator.snapshot(94)).toThrow('stale deadline clock');
  });

  it('creates immutable deterministic snapshots', () => {
    const coordinator = create();
    coordinator.begin({ serviceKey: 'z', requestKey: '2', requestClass: 'background', startedAtMs: 0, durationMs: 20 });
    coordinator.begin({ serviceKey: 'a', requestKey: '1', requestClass: 'interactive', startedAtMs: 0, durationMs: 20 });
    const snapshot = coordinator.snapshot(1);
    expect(snapshot.entries.map((entry) => entry.serviceKey)).toEqual(['a', 'z']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true);
  });

  it('restores valid primitive state atomically', () => {
    const source = create();
    source.begin({ serviceKey: 'a', requestKey: '1', requestClass: 'foreground', startedAtMs: 10, durationMs: 100 });
    source.begin({ serviceKey: 'b', requestKey: '2', requestClass: 'background', startedAtMs: 20, durationMs: 100 });
    source.cancel('b', '2', 30);
    const snapshot = source.snapshot(40);
    const target = create();
    target.restore(snapshot, 40);
    expect(target.snapshot(40).entries).toEqual(snapshot.entries);
  });

  it('rejects duplicate restore identities without mutating existing state', () => {
    const coordinator = create();
    coordinator.begin({ serviceKey: 'safe', requestKey: 'keep', requestClass: 'interactive', startedAtMs: 1, durationMs: 10 });
    const entry = coordinator.snapshot(2).entries[0]!;
    expect(() => coordinator.restore({ entries: [entry, entry] }, 2)).toThrow('duplicate deadline entry');
    expect(coordinator.decide('safe', 'keep', 2).state).toBe('active');
  });

  it('rejects malformed active terminal chronology on restore', () => {
    const coordinator = create();
    expect(() => coordinator.restore({ entries: [{ serviceKey: 'a', requestKey: '1', requestClass: 'interactive', startedAtMs: 1, deadlineAtMs: 10, terminalAtMs: 2, state: 'active', generation: 1 }] }, 5)).toThrow('active deadline cannot be terminal');
  });

  it('rejects malformed terminal entries on restore', () => {
    const coordinator = create();
    expect(() => coordinator.restore({ entries: [{ serviceKey: 'a', requestKey: '1', requestClass: 'interactive', startedAtMs: 1, deadlineAtMs: 10, terminalAtMs: null, state: 'completed', generation: 1 }] }, 5)).toThrow('terminal deadline missing timestamp');
  });

  it('rejects future restore state beyond clock skew', () => {
    const coordinator = create();
    expect(() => coordinator.restore({ entries: [{ serviceKey: 'a', requestKey: '1', requestClass: 'interactive', startedAtMs: 20, deadlineAtMs: 30, terminalAtMs: null, state: 'active', generation: 1 }] }, 10)).toThrow('future request start');
  });

  it('rejects deadline spans beyond policy during restore', () => {
    const coordinator = create();
    expect(() => coordinator.restore({ entries: [{ serviceKey: 'a', requestKey: '1', requestClass: 'interactive', startedAtMs: 0, deadlineAtMs: 20_000, terminalAtMs: null, state: 'active', generation: 1 }] }, 1)).toThrow('invalid deadline chronology');
  });

  it('rejects per-service capacity overflow during restore', () => {
    const coordinator = new ArcGisServiceDeadlineCoordinator({ ...policy, maxRequestsPerService: 1 });
    const entries = [
      { serviceKey: 'a', requestKey: '1', requestClass: 'interactive' as const, startedAtMs: 0, deadlineAtMs: 10, terminalAtMs: null, state: 'active' as const, generation: 1 },
      { serviceKey: 'a', requestKey: '2', requestClass: 'foreground' as const, startedAtMs: 0, deadlineAtMs: 10, terminalAtMs: null, state: 'active' as const, generation: 1 },
    ];
    expect(() => coordinator.restore({ entries }, 1)).toThrow('per-service deadline capacity exceeded');
  });

  it('rejects operations after disposal and releases retained primitive state', () => {
    const coordinator = create();
    coordinator.begin({ serviceKey: 'a', requestKey: '1', requestClass: 'interactive', startedAtMs: 0, durationMs: 10 });
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.snapshot(1)).toThrow('disposed');
  });

  it('validates constructor capacity invariants', () => {
    expect(() => new ArcGisServiceDeadlineCoordinator({ ...policy, maxRequests: 1, maxRequestsPerService: 2 })).toThrow('per-service request capacity exceeds global capacity');
  });
});
