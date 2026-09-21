import { describe, expect, it } from 'vitest';
import { RuntimeBulkhead, type RuntimeBulkheadConfig } from './runtimeBulkhead';

const config = (overrides: Partial<RuntimeBulkheadConfig> = {}): RuntimeBulkheadConfig => ({
  globalConcurrency: 4,
  globalQueue: 6,
  maxHistory: 8,
  maxWaitMs: 100,
  lanes: {
    critical: { concurrency: 3, queue: 3, reserved: 1 },
    interactive: { concurrency: 3, queue: 3, reserved: 1 },
    background: { concurrency: 2, queue: 2, reserved: 0 },
  },
  ...overrides,
});

describe('RuntimeBulkhead', () => {
  it('validates global and lane bounds', () => {
    expect(() => new RuntimeBulkhead(config({ globalConcurrency: 0 }))).toThrow(RangeError);
    expect(() => new RuntimeBulkhead(config({ globalQueue: -1 }))).toThrow(RangeError);
    expect(() => new RuntimeBulkhead(config({ maxWaitMs: 0 }))).toThrow(RangeError);
    expect(() => new RuntimeBulkhead(config({ maxHistory: 0 }))).toThrow(RangeError);
    expect(() => new RuntimeBulkhead(config({ globalConcurrency: 1 }))).toThrow('reserved capacity');
  });

  it('admits work and exposes defensive diagnostics', () => {
    const bulkhead = new RuntimeBulkhead(config());
    const result = bulkhead.admit({ lane: 'critical', key: 'a', now: 10 });
    expect(result.kind).toBe('admitted');
    const snapshot = bulkhead.snapshot();
    expect(snapshot.active).toBe(1);
    expect(snapshot.activeByLane.critical).toBe(1);
    expect(snapshot.availableGlobal).toBe(3);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
  });

  it('protects reserved higher-priority capacity', () => {
    const bulkhead = new RuntimeBulkhead(config());
    expect(bulkhead.admit({ lane: 'background', now: 1 }).kind).toBe('admitted');
    expect(bulkhead.admit({ lane: 'background', now: 2 }).kind).toBe('admitted');
    const queued = bulkhead.admit({ lane: 'interactive', now: 3 });
    expect(queued.kind).toBe('admitted');
    const background = bulkhead.admit({ lane: 'background', now: 4 });
    expect(background.kind).toBe('queued');
    expect(bulkhead.admit({ lane: 'critical', now: 5 }).kind).toBe('admitted');
    expect(bulkhead.snapshot().active).toBe(4);
  });

  it('enforces lane concurrency independently of global capacity', () => {
    const bulkhead = new RuntimeBulkhead(config());
    bulkhead.admit({ lane: 'background', now: 1 });
    bulkhead.admit({ lane: 'background', now: 2 });
    const third = bulkhead.admit({ lane: 'background', now: 3 });
    expect(third.kind).toBe('queued');
    expect(bulkhead.snapshot().queuedByLane.background).toBe(1);
  });

  it('rejects duplicate keys across active and queued ownership', () => {
    const bulkhead = new RuntimeBulkhead(config());
    bulkhead.admit({ lane: 'critical', key: 'same', now: 1 });
    expect(bulkhead.admit({ lane: 'critical', key: 'same', now: 2 })).toEqual({ kind: 'rejected', reason: 'duplicate' });

    const constrained = new RuntimeBulkhead(config({ globalConcurrency: 2 }));
    constrained.admit({ lane: 'critical', now: 1 });
    constrained.admit({ lane: 'interactive', now: 2 });
    expect(constrained.admit({ lane: 'critical', key: 'queued-key', now: 3 }).kind).toBe('queued');
    expect(constrained.admit({ lane: 'critical', key: 'queued-key', now: 4 })).toEqual({ kind: 'rejected', reason: 'duplicate' });
  });

  it('promotes critical before interactive before background and preserves FIFO', () => {
    const bulkhead = new RuntimeBulkhead(config({ globalConcurrency: 2 }));
    const first = bulkhead.admit({ lane: 'critical', now: 1 });
    const second = bulkhead.admit({ lane: 'interactive', now: 2 });
    expect(first.kind).toBe('admitted');
    expect(second.kind).toBe('admitted');
    const bg = bulkhead.admit({ lane: 'background', key: 'bg', now: 3 });
    const interactive = bulkhead.admit({ lane: 'interactive', key: 'ui', now: 4 });
    const critical = bulkhead.admit({ lane: 'critical', key: 'critical', now: 5 });
    expect(bg.kind).toBe('queued');
    expect(interactive.kind).toBe('queued');
    expect(critical.kind).toBe('queued');
    if (first.kind !== 'admitted') throw new Error('expected lease');
    const promoted = bulkhead.release(first.lease.id, 10);
    expect(promoted.map((lease) => lease.key)).toEqual(['critical']);
  });

  it('cancels queued ownership and allows key reuse', () => {
    const bulkhead = new RuntimeBulkhead(config({ globalConcurrency: 2 }));
    bulkhead.admit({ lane: 'critical', now: 1 });
    bulkhead.admit({ lane: 'interactive', now: 2 });
    const queued = bulkhead.admit({ lane: 'critical', key: 'retry', now: 3 });
    if (queued.kind !== 'queued') throw new Error('expected queued');
    expect(bulkhead.cancel(queued.request.id, 4)).toBe(true);
    expect(bulkhead.cancel(queued.request.id, 5)).toBe(false);
    const after = bulkhead.admit({ lane: 'critical', key: 'retry', now: 6 });
    expect(after.kind).toBe('queued');
  });

  it('expires old queued work without timers', () => {
    const bulkhead = new RuntimeBulkhead(config({ globalConcurrency: 2, maxWaitMs: 50 }));
    bulkhead.admit({ lane: 'critical', now: 1 });
    bulkhead.admit({ lane: 'interactive', now: 2 });
    bulkhead.admit({ lane: 'critical', key: 'old', now: 10 });
    bulkhead.sweep(61);
    expect(bulkhead.snapshot().queued).toBe(0);
    expect(bulkhead.snapshot().history.some((entry) => entry.event === 'expire')).toBe(true);
    expect(bulkhead.admit({ lane: 'critical', key: 'old', now: 62 }).kind).toBe('queued');
  });

  it('bounds global queue length', () => {
    const bulkhead = new RuntimeBulkhead(config({ globalConcurrency: 2, globalQueue: 1 }));
    bulkhead.admit({ lane: 'critical', now: 1 });
    bulkhead.admit({ lane: 'interactive', now: 2 });
    expect(bulkhead.admit({ lane: 'critical', now: 3 }).kind).toBe('queued');
    expect(bulkhead.admit({ lane: 'interactive', now: 4 })).toEqual({ kind: 'rejected', reason: 'global-queue' });
  });

  it('bounds per-lane queue length', () => {
    const bulkhead = new RuntimeBulkhead(config({ globalConcurrency: 2 }));
    bulkhead.admit({ lane: 'critical', now: 1 });
    bulkhead.admit({ lane: 'interactive', now: 2 });
    bulkhead.admit({ lane: 'background', now: 3 });
    bulkhead.admit({ lane: 'background', now: 4 });
    expect(bulkhead.admit({ lane: 'background', now: 5 })).toEqual({ kind: 'rejected', reason: 'lane-queue' });
  });

  it('does not mutate state when an unknown lease is released', () => {
    const bulkhead = new RuntimeBulkhead(config());
    bulkhead.admit({ lane: 'critical', now: 1 });
    const before = bulkhead.snapshot();
    expect(bulkhead.release(999, 2)).toEqual([]);
    const after = bulkhead.snapshot();
    expect(after.active).toBe(before.active);
    expect(after.queued).toBe(before.queued);
  });

  it('bounds history while preserving latest events', () => {
    const bulkhead = new RuntimeBulkhead(config({ maxHistory: 3 }));
    for (let index = 0; index < 6; index += 1) {
      const admitted = bulkhead.admit({ lane: 'critical', now: index * 2 });
      if (admitted.kind === 'admitted') bulkhead.release(admitted.lease.id, index * 2 + 1);
    }
    const history = bulkhead.snapshot().history;
    expect(history).toHaveLength(3);
    expect(history.at(-1)?.event).toBe('release');
  });

  it('reset releases all ownership and queued keys deterministically', () => {
    const bulkhead = new RuntimeBulkhead(config({ globalConcurrency: 2 }));
    bulkhead.admit({ lane: 'critical', key: 'active', now: 1 });
    bulkhead.admit({ lane: 'interactive', now: 2 });
    bulkhead.admit({ lane: 'critical', key: 'queued', now: 3 });
    bulkhead.reset(10);
    expect(bulkhead.snapshot().active).toBe(0);
    expect(bulkhead.snapshot().queued).toBe(0);
    expect(bulkhead.admit({ lane: 'critical', key: 'active', now: 11 }).kind).toBe('admitted');
  });

  it('rejects non-finite explicit time without allocating ownership', () => {
    const bulkhead = new RuntimeBulkhead(config());
    expect(bulkhead.admit({ lane: 'critical', now: Number.NaN })).toEqual({ kind: 'rejected', reason: 'invalid' });
    expect(bulkhead.snapshot().active).toBe(0);
  });
});
