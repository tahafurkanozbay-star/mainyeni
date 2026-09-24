import { describe, expect, it } from 'vitest';
import { RuntimeConcurrencyGovernor, type RuntimeConcurrencyPolicy } from './runtimeConcurrencyGovernor';

const policy = (overrides: Partial<RuntimeConcurrencyPolicy> = {}): RuntimeConcurrencyPolicy => ({
  globalConcurrency: 2,
  globalQueue: 4,
  laneConcurrency: { interactive: 2, background: 1, maintenance: 1 },
  laneQueue: { interactive: 2, background: 2, maintenance: 2 },
  historyLimit: 8,
  ...overrides,
});

describe('RuntimeConcurrencyGovernor', () => {
  it('admits within global and lane concurrency budgets', () => {
    const governor = new RuntimeConcurrencyGovernor(policy());
    expect(governor.admit({ id: 'ui-1', lane: 'interactive' }).decision).toBe('admit');
    expect(governor.admit({ id: 'bg-1', lane: 'background' }).decision).toBe('admit');
    expect(governor.snapshot()).toMatchObject({ active: 2, queued: 0, activeByLane: { interactive: 1, background: 1, maintenance: 0 } });
  });

  it('queues when lane capacity is exhausted and promotes after release', () => {
    const governor = new RuntimeConcurrencyGovernor(policy());
    governor.admit({ id: 'bg-1', lane: 'background' });
    expect(governor.admit({ id: 'bg-2', lane: 'background' }).decision).toBe('queue');
    const promoted = governor.release('bg-1');
    expect(promoted.map(({ id }) => id)).toEqual(['bg-2']);
    expect(governor.snapshot().activeByLane.background).toBe(1);
  });

  it('preserves FIFO order within a lane', () => {
    const governor = new RuntimeConcurrencyGovernor(policy({ globalConcurrency: 1 }));
    governor.admit({ id: 'ui-1', lane: 'interactive' });
    governor.admit({ id: 'ui-2', lane: 'interactive' });
    governor.admit({ id: 'ui-3', lane: 'interactive' });
    expect(governor.release('ui-1').map(({ id }) => id)).toEqual(['ui-2']);
    expect(governor.release('ui-2').map(({ id }) => id)).toEqual(['ui-3']);
  });

  it('prioritizes interactive queue when global capacity returns', () => {
    const governor = new RuntimeConcurrencyGovernor(policy({ globalConcurrency: 1 }));
    governor.admit({ id: 'bg-active', lane: 'background' });
    governor.admit({ id: 'maintenance', lane: 'maintenance' });
    governor.admit({ id: 'interactive', lane: 'interactive' });
    expect(governor.release('bg-active').map(({ id }) => id)).toEqual(['interactive']);
  });

  it('rejects duplicate ownership deterministically', () => {
    const governor = new RuntimeConcurrencyGovernor(policy());
    governor.admit({ id: 'same', lane: 'interactive' });
    expect(governor.admit({ id: 'same', lane: 'background' })).toMatchObject({ decision: 'reject', reason: 'duplicate' });
  });

  it('enforces per-lane queue capacity', () => {
    const governor = new RuntimeConcurrencyGovernor(policy({ globalConcurrency: 1, laneQueue: { interactive: 2, background: 1, maintenance: 1 } }));
    governor.admit({ id: 'bg-1', lane: 'background' });
    expect(governor.admit({ id: 'bg-2', lane: 'background' }).decision).toBe('queue');
    expect(governor.admit({ id: 'bg-3', lane: 'background' })).toMatchObject({ decision: 'reject', reason: 'queue-full' });
  });

  it('enforces global queue capacity across lanes', () => {
    const governor = new RuntimeConcurrencyGovernor(policy({ globalConcurrency: 1, globalQueue: 1 }));
    governor.admit({ id: 'active', lane: 'interactive' });
    governor.admit({ id: 'queued', lane: 'background' });
    expect(governor.admit({ id: 'overflow', lane: 'maintenance' })).toMatchObject({ decision: 'reject', reason: 'queue-full' });
  });

  it('cancels queued ownership without consuming active capacity', () => {
    const governor = new RuntimeConcurrencyGovernor(policy({ globalConcurrency: 1 }));
    governor.admit({ id: 'active', lane: 'interactive' });
    governor.admit({ id: 'queued', lane: 'background' });
    governor.cancel('queued');
    expect(governor.has('queued')).toBe(false);
    expect(governor.snapshot()).toMatchObject({ active: 1, queued: 0 });
  });

  it('treats active cancellation as release and promotes queued work', () => {
    const governor = new RuntimeConcurrencyGovernor(policy({ globalConcurrency: 1 }));
    governor.admit({ id: 'active', lane: 'interactive' });
    governor.admit({ id: 'next', lane: 'interactive' });
    expect(governor.cancel('active').map(({ id }) => id)).toEqual(['next']);
  });

  it('disposes queued work and rejects future admissions', () => {
    const governor = new RuntimeConcurrencyGovernor(policy({ globalConcurrency: 1 }));
    governor.admit({ id: 'active', lane: 'interactive' });
    governor.admit({ id: 'queued', lane: 'background' });
    governor.dispose();
    expect(governor.snapshot()).toMatchObject({ active: 1, queued: 0, disposed: true });
    expect(governor.admit({ id: 'future', lane: 'interactive' })).toMatchObject({ decision: 'reject', reason: 'disposed' });
  });

  it('bounds immutable event history', () => {
    const governor = new RuntimeConcurrencyGovernor(policy({ historyLimit: 3 }));
    governor.admit({ id: 'a', lane: 'interactive' });
    governor.release('a');
    governor.admit({ id: 'b', lane: 'interactive' });
    governor.release('b');
    const history = governor.history();
    expect(history).toHaveLength(3);
    expect(history.map(({ sequence }) => sequence)).toEqual([2, 3, 4]);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
  });

  it('returns immutable snapshots and policy', () => {
    const governor = new RuntimeConcurrencyGovernor(policy());
    const snapshot = governor.snapshot();
    expect(Object.isFrozen(governor.policy)).toBe(true);
    expect(Object.isFrozen(governor.policy.laneConcurrency)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.activeByLane)).toBe(true);
  });

  it.each([
    ['', 'interactive'],
    ['   ', 'background'],
    ['x'.repeat(257), 'maintenance'],
  ] as const)('rejects hostile request id %j', (id, lane) => {
    const governor = new RuntimeConcurrencyGovernor(policy());
    expect(() => governor.admit({ id, lane })).toThrow(TypeError);
  });

  it('rejects unsupported lanes at runtime', () => {
    const governor = new RuntimeConcurrencyGovernor(policy());
    expect(() => governor.admit({ id: 'bad', lane: 'urgent' as never })).toThrow(TypeError);
  });

  it.each([
    { globalConcurrency: 0 },
    { globalQueue: -1 },
    { historyLimit: 0 },
    { globalConcurrency: Number.POSITIVE_INFINITY },
    { globalQueue: 100_001 },
  ])('rejects invalid scalar policy %j', (override) => {
    expect(() => new RuntimeConcurrencyGovernor(policy(override))).toThrow(RangeError);
  });

  it('rejects invalid lane budgets', () => {
    expect(() => new RuntimeConcurrencyGovernor(policy({ laneConcurrency: { interactive: 0, background: 1, maintenance: 1 } }))).toThrow(RangeError);
    expect(() => new RuntimeConcurrencyGovernor(policy({ laneQueue: { interactive: 1, background: -1, maintenance: 1 } }))).toThrow(RangeError);
  });

  it('ignores unknown release and cancellation ids', () => {
    const governor = new RuntimeConcurrencyGovernor(policy());
    expect(governor.release('missing')).toEqual([]);
    expect(governor.cancel('missing')).toEqual([]);
    expect(governor.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });
});
