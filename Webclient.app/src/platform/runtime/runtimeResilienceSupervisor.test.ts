import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeResilienceRejectedError,
  createRuntimeResilienceSupervisor,
  type RuntimeResilienceLane,
} from './runtimeResilienceSupervisor';

const load = (active = 0, queued = 0) => ({ active, queued });

const policy = () => ({
  minimumSignalSamples: {
    critical: 2,
    interactive: 2,
    background: 2,
  },
  maxErrorRate: {
    critical: 0.5,
    interactive: 0.25,
    background: 0.2,
  },
  historyLimit: 16,
  maxKeyLength: 64,
}) as const;

const create = () => createRuntimeResilienceSupervisor({
  policy: policy(),
  envelope: {
    critical: {
      maxInFlight: 4,
      maxQueued: 8,
      timeoutMs: 1_000,
      maxAttempts: 3,
    },
    interactive: {
      maxInFlight: 3,
      maxQueued: 6,
      timeoutMs: 500,
      maxAttempts: 2,
    },
    background: {
      maxInFlight: 2,
      maxQueued: 4,
      timeoutMs: 200,
      maxAttempts: 2,
    },
  },
});

describe('runtime resilience supervisor assessment', () => {
  it('admits healthy cold-start work', () => {
    const supervisor = create();
    expect(supervisor.assess({
      lane: 'interactive',
      nowMs: 0,
      load: load(0, 0),
    })).toMatchObject({
      admitted: true,
      reason: 'healthy',
      signalCount: 0,
      p95LatencyMs: 0,
      errorRate: 0,
      active: 0,
      queued: 0,
    });
  });

  it('rejects background work at active capacity', () => {
    const supervisor = create();
    expect(supervisor.assess({
      lane: 'background',
      nowMs: 0,
      load: load(2, 0),
    })).toMatchObject({
      admitted: false,
      reason: 'capacity',
    });
  });

  it('rejects background work at queue capacity', () => {
    const supervisor = create();
    expect(supervisor.assess({
      lane: 'background',
      nowMs: 0,
      load: load(0, 4),
    })).toMatchObject({
      admitted: false,
      reason: 'queue',
    });
  });

  it('allows bounded critical headroom over active threshold', () => {
    const supervisor = create();
    expect(supervisor.assess({
      lane: 'critical',
      nowMs: 0,
      load: load(5, 0),
    })).toMatchObject({
      admitted: true,
      reason: 'priority',
    });
  });

  it('rejects critical work beyond bounded headroom', () => {
    const supervisor = create();
    expect(supervisor.assess({
      lane: 'critical',
      nowMs: 0,
      load: load(6, 0),
    })).toMatchObject({
      admitted: false,
      reason: 'capacity',
    });
  });

  it('allows bounded interactive headroom', () => {
    const supervisor = create();
    expect(supervisor.assess({
      lane: 'interactive',
      nowMs: 0,
      load: load(3, 0),
    })).toMatchObject({
      admitted: true,
      reason: 'priority',
    });
  });

  it('ignores sparse error telemetry during cold start', () => {
    const supervisor = create();
    expect(supervisor.recordSignal('background', 10, false, 1)).toBe(true);
    expect(supervisor.assess({
      lane: 'background',
      nowMs: 2,
      load: load(),
    })).toMatchObject({
      admitted: true,
      reason: 'healthy',
      signalCount: 1,
      errorRate: 1,
    });
  });

  it('uses lane error telemetry after minimum sample count', () => {
    const supervisor = create();
    supervisor.recordSignal('background', 10, false, 1);
    supervisor.recordSignal('background', 20, true, 2);
    expect(supervisor.assess({
      lane: 'background',
      nowMs: 3,
      load: load(),
    })).toMatchObject({
      admitted: false,
      reason: 'errors',
      signalCount: 2,
      errorRate: 0.5,
    });
  });

  it('uses p95 latency feedback after minimum sample count', () => {
    const supervisor = create();
    supervisor.recordSignal('interactive', 600, true, 1);
    supervisor.recordSignal('interactive', 700, true, 2);
    expect(supervisor.assess({
      lane: 'interactive',
      nowMs: 3,
      load: load(),
    })).toMatchObject({
      admitted: false,
      reason: 'latency',
      p95LatencyMs: 700,
    });
  });

  it('isolates lane telemetry', () => {
    const supervisor = create();
    supervisor.recordSignal('background', 200, false, 1);
    supervisor.recordSignal('background', 200, false, 2);
    expect(supervisor.assess({
      lane: 'critical',
      nowMs: 3,
      load: load(),
    })).toMatchObject({
      admitted: true,
      reason: 'healthy',
      signalCount: 0,
    });
  });

  it('evicts stale telemetry on assessment', () => {
    const supervisor = createRuntimeResilienceSupervisor({
      policy: policy(),
      signals: { maxAgeMs: 10 },
    });
    supervisor.recordSignal('background', 100_000, false, 1);
    supervisor.recordSignal('background', 100_000, false, 2);
    const decision = supervisor.assess({
      lane: 'background',
      nowMs: 20,
      load: load(),
    });
    expect(decision.signalCount).toBe(0);
    expect(decision.admitted).toBe(true);
  });

  it('returns immutable decisions and budgets', () => {
    const supervisor = create();
    const decision = supervisor.assess({
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.budget)).toBe(true);
  });

  it('rejects malformed load counters', () => {
    const supervisor = create();
    expect(() => supervisor.assess({
      lane: 'interactive',
      nowMs: 0,
      load: load(-1, 0),
    })).toThrow(RangeError);
    expect(() => supervisor.assess({
      lane: 'interactive',
      nowMs: 0,
      load: load(1.5, 0),
    })).toThrow(RangeError);
  });

  it('rejects backwards supervisor clocks', () => {
    const supervisor = create();
    supervisor.assess({
      lane: 'interactive',
      nowMs: 10,
      load: load(),
    });
    expect(() => supervisor.assess({
      lane: 'interactive',
      nowMs: 9,
      load: load(),
    })).toThrow(RangeError);
  });
});

describe('runtime resilience supervisor begin lifecycle', () => {
  it('creates a bounded interactive deadline lease', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'query:1',
      lane: 'interactive',
      nowMs: 100,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.lease).toMatchObject({
      lane: 'interactive',
      createdAtMs: 100,
      deadlineMs: 600,
      timeoutMs: 500,
    });
    expect(result.lease.remainingMs(150)).toBe(450);
  });

  it('caps requested timeout to envelope timeout', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'query:2',
      lane: 'background',
      nowMs: 0,
      timeoutMs: 10_000,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.lease.timeoutMs).toBe(200);
  });

  it('supports a shorter caller timeout', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'query:3',
      lane: 'interactive',
      nowMs: 100,
      timeoutMs: 50,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.lease.timeoutMs).toBe(50);
    expect(result.lease.deadlineMs).toBe(150);
  });

  it('propagates a tighter parent deadline', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'child',
      lane: 'critical',
      nowMs: 1_000,
      parentDeadlineMs: 1_100,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.lease.deadlineMs).toBe(1_100);
    expect(result.lease.timeoutMs).toBe(100);
  });

  it('rejects an exhausted parent deadline', () => {
    const supervisor = create();
    expect(supervisor.begin({
      key: 'expired-child',
      lane: 'interactive',
      nowMs: 100,
      parentDeadlineMs: 100,
      load: load(),
    })).toMatchObject({
      admitted: false,
      reason: 'deadline',
    });
  });

  it('rejects zero caller timeout through deadline policy', () => {
    const supervisor = create();
    expect(supervisor.begin({
      key: 'zero-timeout',
      lane: 'critical',
      nowMs: 0,
      timeoutMs: 0,
      load: load(),
    })).toMatchObject({
      admitted: false,
      reason: 'deadline',
    });
  });

  it('rejects duplicate active ownership keys', () => {
    const supervisor = create();
    expect(supervisor.begin({
      key: 'same',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    }).admitted).toBe(true);
    expect(supervisor.begin({
      key: 'same',
      lane: 'critical',
      nowMs: 1,
      load: load(),
    })).toMatchObject({
      admitted: false,
      reason: 'duplicate',
    });
    expect(supervisor.snapshot().counters.duplicateRejected).toBe(1);
  });

  it('allows a key to be reused after completion', () => {
    const supervisor = create();
    const first = supervisor.begin({
      key: 'reuse',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    expect(first.admitted).toBe(true);
    if (!first.admitted) return;
    expect(first.lease.finish({
      outcome: 'success',
      nowMs: 10,
    })).toBe(true);
    const second = supervisor.begin({
      key: 'reuse',
      lane: 'critical',
      nowMs: 11,
      load: load(),
    });
    expect(second.admitted).toBe(true);
  });

  it('rejects empty ownership keys', () => {
    const supervisor = create();
    expect(() => supervisor.begin({
      key: '   ',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    })).toThrow(TypeError);
  });

  it('rejects overlong ownership keys without retaining them', () => {
    const supervisor = create();
    const key = 'x'.repeat(65);
    expect(() => supervisor.begin({
      key,
      lane: 'critical',
      nowMs: 0,
      load: load(),
    })).toThrow(RangeError);
    expect(JSON.stringify(supervisor.snapshot())).not.toContain(key);
  });

  it('sheds before allocating a deadline when pressure rejects', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'shed-me',
      lane: 'background',
      nowMs: 0,
      load: load(2, 0),
    });
    expect(result).toMatchObject({
      admitted: false,
      reason: 'capacity',
    });
    expect(supervisor.snapshot()).toMatchObject({
      active: 0,
      counters: {
        admitted: 0,
        shed: 1,
      },
    });
  });

  it('tracks active sessions by lane', () => {
    const supervisor = create();
    supervisor.begin({
      key: 'critical',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    supervisor.begin({
      key: 'interactive',
      lane: 'interactive',
      nowMs: 0,
      load: load(),
    });
    supervisor.begin({
      key: 'background',
      lane: 'background',
      nowMs: 0,
      load: load(),
    });
    expect(supervisor.snapshot().activeByLane).toEqual({
      critical: 1,
      interactive: 1,
      background: 1,
    });
  });
});

describe('runtime resilience supervisor completion accounting', () => {
  it('records successful completion and latency signal', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'success',
      lane: 'interactive',
      nowMs: 10,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.lease.finish({
      outcome: 'success',
      nowMs: 50,
    })).toBe(true);
    const snapshot = supervisor.snapshot();
    expect(snapshot).toMatchObject({
      active: 0,
      counters: {
        completed: 1,
        succeeded: 1,
        failed: 0,
      },
    });
    expect(snapshot.signals.lanes.interactive).toMatchObject({
      count: 1,
      successes: 1,
      p95LatencyMs: 40,
    });
  });

  it('records explicit latency when caller has a better measurement', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'measured',
      lane: 'critical',
      nowMs: 10,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    result.lease.finish({
      outcome: 'success',
      nowMs: 20,
      latencyMs: 7,
    });
    expect(supervisor.snapshot().signals.lanes.critical.meanLatencyMs).toBe(7);
  });

  it('records failure signals', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'failure',
      lane: 'background',
      nowMs: 0,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    result.lease.finish({
      outcome: 'failure',
      nowMs: 25,
    });
    expect(supervisor.snapshot()).toMatchObject({
      counters: {
        completed: 1,
        failed: 1,
      },
      signals: {
        lanes: {
          background: {
            count: 1,
            failures: 1,
            errorRate: 1,
          },
        },
      },
    });
  });

  it('classifies completion at deadline as timeout', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'late-success',
      lane: 'background',
      nowMs: 0,
      timeoutMs: 10,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    result.lease.finish({
      outcome: 'success',
      nowMs: 10,
    });
    expect(supervisor.snapshot().counters).toMatchObject({
      succeeded: 0,
      timedOut: 1,
    });
    expect(supervisor.snapshot().signals.lanes.background.errorRate).toBe(1);
  });

  it('records cancellation without poisoning failure telemetry', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'cancelled',
      lane: 'interactive',
      nowMs: 0,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    result.lease.finish({
      outcome: 'cancelled',
      nowMs: 10,
    });
    expect(supervisor.snapshot().counters.cancelled).toBe(1);
    expect(supervisor.snapshot().signals.lanes.interactive.count).toBe(0);
  });

  it('records rejected terminal outcome without failure signal', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'downstream-rejected',
      lane: 'interactive',
      nowMs: 0,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    result.lease.finish({
      outcome: 'rejected',
      nowMs: 10,
    });
    expect(supervisor.snapshot().counters.rejected).toBe(1);
    expect(supervisor.snapshot().signals.lanes.interactive.count).toBe(0);
  });

  it('records explicit release without failure signal', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'released',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    result.lease.finish({
      outcome: 'released',
      nowMs: 5,
    });
    expect(supervisor.snapshot().counters.released).toBe(1);
    expect(supervisor.snapshot().signals.lanes.critical.count).toBe(0);
  });

  it('makes lease completion idempotent', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'once',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.lease.finish({
      outcome: 'success',
      nowMs: 1,
    })).toBe(true);
    expect(result.lease.finish({
      outcome: 'failure',
      nowMs: 2,
    })).toBe(false);
    expect(supervisor.snapshot().counters).toMatchObject({
      completed: 1,
      succeeded: 1,
      failed: 0,
    });
  });

  it('supports bounded signal weights', () => {
    const supervisor = create();
    const result = supervisor.begin({
      key: 'weighted',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    result.lease.finish({
      outcome: 'success',
      nowMs: 20,
      weight: 3,
    });
    expect(supervisor.snapshot().signals.lanes.critical.weightedCount).toBe(3);
  });

  it('counts rejected invalid signal weights without corrupting active state', () => {
    const supervisor = createRuntimeResilienceSupervisor({
      policy: policy(),
      signals: { maxWeight: 2 },
    });
    const result = supervisor.begin({
      key: 'bad-weight',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    result.lease.finish({
      outcome: 'failure',
      nowMs: 1,
      weight: 3,
    });
    expect(supervisor.snapshot().counters.signalRejected).toBe(1);
    expect(supervisor.snapshot().signals.count).toBe(0);
  });
});

describe('runtime resilience supervisor deadline sweeping', () => {
  it('sweeps expired sessions deterministically', () => {
    const supervisor = create();
    supervisor.begin({
      key: 'a',
      lane: 'background',
      nowMs: 0,
      timeoutMs: 10,
      load: load(),
    });
    supervisor.begin({
      key: 'b',
      lane: 'interactive',
      nowMs: 0,
      timeoutMs: 20,
      load: load(),
    });
    supervisor.begin({
      key: 'c',
      lane: 'critical',
      nowMs: 0,
      timeoutMs: 30,
      load: load(),
    });
    expect(supervisor.sweep(20)).toBe(2);
    expect(supervisor.snapshot()).toMatchObject({
      active: 1,
      counters: {
        timedOut: 2,
        swept: 2,
      },
      activeByLane: {
        critical: 1,
        interactive: 0,
        background: 0,
      },
    });
  });

  it('keeps sessions before their exact deadline', () => {
    const supervisor = create();
    supervisor.begin({
      key: 'later',
      lane: 'background',
      nowMs: 0,
      timeoutMs: 10,
      load: load(),
    });
    expect(supervisor.sweep(9)).toBe(0);
    expect(supervisor.snapshot().active).toBe(1);
  });

  it('records timeout signal during sweep', () => {
    const supervisor = create();
    supervisor.begin({
      key: 'timeout-signal',
      lane: 'background',
      nowMs: 0,
      timeoutMs: 10,
      load: load(),
    });
    supervisor.sweep(10);
    expect(supervisor.snapshot().signals.lanes.background).toMatchObject({
      count: 1,
      failures: 1,
      p95LatencyMs: 10,
    });
  });

  it('does not sweep after disposal', () => {
    const supervisor = create();
    supervisor.dispose(0);
    expect(supervisor.sweep(10)).toBe(0);
  });
});

describe('runtime resilience supervisor events and privacy', () => {
  it('emits bounded lifecycle events', () => {
    const supervisor = createRuntimeResilienceSupervisor({
      policy: {
        ...policy(),
        historyLimit: 3,
      },
    });
    for (let index = 0; index < 4; index += 1) {
      const result = supervisor.begin({
        key: 'item:' + index,
        lane: 'critical',
        nowMs: index * 2,
        load: load(),
      });
      if (result.admitted) {
        result.lease.finish({
          outcome: 'success',
          nowMs: index * 2 + 1,
        });
      }
    }
    expect(supervisor.snapshot().events).toHaveLength(3);
  });

  it('does not expose ownership keys in events or snapshot', () => {
    const secret = 'customer-private-operation-key';
    const supervisor = create();
    const result = supervisor.begin({
      key: secret,
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    if (result.admitted) {
      result.lease.finish({
        outcome: 'failure',
        nowMs: 1,
      });
    }
    expect(JSON.stringify(supervisor.snapshot())).not.toContain(secret);
  });

  it('isolates observer exceptions and records only error name', () => {
    const observer = vi.fn(() => {
      throw new TypeError('private observer failure detail');
    });
    const supervisor = createRuntimeResilienceSupervisor({
      policy: policy(),
      onEvent: observer,
    });
    const result = supervisor.begin({
      key: 'observer',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    expect(result.admitted).toBe(true);
    const snapshot = supervisor.snapshot();
    expect(snapshot.counters.observerFailures).toBeGreaterThan(0);
    expect(snapshot.events).toContainEqual(expect.objectContaining({
      kind: 'observer-failed',
      errorName: 'TypeError',
    }));
    expect(JSON.stringify(snapshot)).not.toContain(
      'private observer failure detail',
    );
  });

  it('tracks shed events without raw request identity', () => {
    const supervisor = create();
    supervisor.begin({
      key: 'private-key',
      lane: 'background',
      nowMs: 0,
      load: load(2, 0),
    });
    expect(supervisor.snapshot().events).toContainEqual(
      expect.objectContaining({
        kind: 'shed',
        lane: 'background',
        rejectionReason: 'capacity',
      }),
    );
    expect(JSON.stringify(supervisor.snapshot().events))
      .not.toContain('private-key');
  });
});

describe('runtime resilience supervisor snapshot integrity', () => {
  it('returns deeply immutable aggregate collections', () => {
    const supervisor = create();
    supervisor.begin({
      key: 'immutable',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    const snapshot = supervisor.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.counters)).toBe(true);
    expect(Object.isFrozen(snapshot.laneCounters)).toBe(true);
    expect(Object.isFrozen(snapshot.activeByLane)).toBe(true);
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(Object.isFrozen(snapshot.envelope)).toBe(true);
  });

  it('fingerprint is stable for unchanged state', () => {
    const supervisor = create();
    const first = supervisor.snapshot().fingerprint;
    const second = supervisor.snapshot().fingerprint;
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}$/u);
  });

  it('fingerprint changes after admission', () => {
    const supervisor = create();
    const before = supervisor.snapshot().fingerprint;
    supervisor.begin({
      key: 'fingerprint',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    expect(supervisor.snapshot().fingerprint).not.toBe(before);
  });

  it('tracks per-lane counters independently', () => {
    const supervisor = create();
    const critical = supervisor.begin({
      key: 'c',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    const background = supervisor.begin({
      key: 'b',
      lane: 'background',
      nowMs: 0,
      load: load(),
    });
    if (critical.admitted) {
      critical.lease.finish({
        outcome: 'success',
        nowMs: 1,
      });
    }
    if (background.admitted) {
      background.lease.finish({
        outcome: 'failure',
        nowMs: 2,
      });
    }
    expect(supervisor.snapshot().laneCounters).toMatchObject({
      critical: {
        admitted: 1,
        succeeded: 1,
        failed: 0,
      },
      background: {
        admitted: 1,
        succeeded: 0,
        failed: 1,
      },
    });
  });

  it('counts every assessment including begin decisions', () => {
    const supervisor = create();
    supervisor.assess({
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    supervisor.begin({
      key: 'begin',
      lane: 'interactive',
      nowMs: 0,
      load: load(),
    });
    expect(supervisor.snapshot().counters.assessed).toBe(2);
  });
});

describe('runtime resilience supervisor disposal', () => {
  it('releases active sessions on deterministic disposal', () => {
    const supervisor = create();
    supervisor.begin({
      key: 'one',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    supervisor.begin({
      key: 'two',
      lane: 'interactive',
      nowMs: 0,
      load: load(),
    });
    supervisor.dispose(10);
    expect(supervisor.snapshot()).toMatchObject({
      disposed: true,
      active: 0,
      counters: {
        completed: 2,
        released: 2,
      },
    });
  });

  it('dispose is idempotent', () => {
    const supervisor = create();
    supervisor.dispose(0);
    supervisor.dispose(1);
    expect(supervisor.snapshot().events.filter(
      (event) => event.kind === 'disposed',
    )).toHaveLength(1);
  });

  it('begin returns a typed disposed rejection after disposal', () => {
    const supervisor = create();
    supervisor.dispose(0);
    expect(supervisor.begin({
      key: 'late',
      lane: 'critical',
      nowMs: 1,
      load: load(),
    })).toEqual({
      admitted: false,
      reason: 'disposed',
      decision: null,
    });
  });

  it('assessment throws a typed disposed error after disposal', () => {
    const supervisor = create();
    supervisor.dispose(0);
    expect(() => supervisor.assess({
      lane: 'critical',
      nowMs: 1,
      load: load(),
    })).toThrow(RuntimeResilienceRejectedError);
  });

  it('recordSignal throws a typed disposed error after disposal', () => {
    const supervisor = create();
    supervisor.dispose(0);
    expect(() => supervisor.recordSignal(
      'critical',
      1,
      true,
      1,
    )).toThrow(RuntimeResilienceRejectedError);
  });

  it('does not own timers, transport or persistence', () => {
    const originalSetTimeout = globalThis.setTimeout;
    const supervisor = create();
    const result = supervisor.begin({
      key: 'sync-only',
      lane: 'critical',
      nowMs: 0,
      load: load(),
    });
    expect(globalThis.setTimeout).toBe(originalSetTimeout);
    expect(result.admitted).toBe(true);
    expect('fetch' in supervisor).toBe(false);
    expect('storage' in supervisor).toBe(false);
  });
});

describe('runtime resilience supervisor policy validation', () => {
  it('rejects zero minimum signal samples', () => {
    expect(() => createRuntimeResilienceSupervisor({
      policy: {
        ...policy(),
        minimumSignalSamples: {
          critical: 0,
          interactive: 2,
          background: 2,
        },
      },
    })).toThrow(RangeError);
  });

  it('rejects invalid error rate thresholds', () => {
    expect(() => createRuntimeResilienceSupervisor({
      policy: {
        ...policy(),
        maxErrorRate: {
          critical: 2,
          interactive: 0.2,
          background: 0.1,
        },
      },
    })).toThrow(RangeError);
  });

  it('rejects zero history limit', () => {
    expect(() => createRuntimeResilienceSupervisor({
      policy: {
        ...policy(),
        historyLimit: 0,
      },
    })).toThrow(RangeError);
  });

  it('rejects zero maximum key length', () => {
    expect(() => createRuntimeResilienceSupervisor({
      policy: {
        ...policy(),
        maxKeyLength: 0,
      },
    })).toThrow(RangeError);
  });

  it.each([
    'critical',
    'interactive',
    'background',
  ] as const)('supports explicit %s lane signal recording', (lane) => {
    const supervisor = create();
    expect(supervisor.recordSignal(lane, 5, true, 1)).toBe(true);
    expect(supervisor.snapshot().signals.lanes[lane].count).toBe(1);
  });

  it('rejects malformed direct signal latency', () => {
    const supervisor = create();
    expect(() => supervisor.recordSignal(
      'critical',
      -1,
      true,
      0,
    )).toThrow(RangeError);
  });

  it('supports every declared lane without mutation', () => {
    const lanes: RuntimeResilienceLane[] = [
      'critical',
      'interactive',
      'background',
    ];
    const supervisor = create();
    for (const lane of lanes) {
      const decision = supervisor.assess({
        lane,
        nowMs: 0,
        load: load(),
      });
      expect(decision.lane).toBe(lane);
    }
  });
});
