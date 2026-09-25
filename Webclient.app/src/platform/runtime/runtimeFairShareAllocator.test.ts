import { describe, expect, it } from 'vitest';
import { RuntimeFairShareAllocator } from './runtimeFairShareAllocator';

describe('RuntimeFairShareAllocator', () => {
  it('grants immediately while capacity is available', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 8, maximumRequestUnits: 8 });
    expect(allocator.request({ id: 'a', lane: 'interactive', priority: 'standard', units: 3, at: 1 }).disposition).toBe('granted');
    expect(allocator.snapshot()).toMatchObject({ activeUnits: 3, availableUnits: 5, activeRequests: 1, queuedRequests: 0 });
  });

  it('queues work when capacity cannot satisfy the request', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 4, maximumRequestUnits: 4 });
    allocator.request({ id: 'active', lane: 'critical', priority: 'urgent', units: 4, at: 1 });
    expect(allocator.request({ id: 'waiting', lane: 'interactive', priority: 'standard', units: 2, at: 2 })).toMatchObject({ disposition: 'queued', reason: 'queued' });
    expect(allocator.snapshot().lanes.interactive).toMatchObject({ queuedRequests: 1, queuedUnits: 2 });
  });

  it('promotes queued work after release', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 4, maximumRequestUnits: 4, criticalWeight: 4, interactiveWeight: 4, backgroundWeight: 4 });
    allocator.request({ id: 'active', lane: 'critical', priority: 'urgent', units: 4, at: 1 });
    allocator.request({ id: 'waiting', lane: 'interactive', priority: 'standard', units: 2, at: 2 });
    const promoted = allocator.release('active', 3);
    expect(promoted.map((grant) => grant.id)).toContain('waiting');
    expect(allocator.snapshot()).toMatchObject({ activeUnits: 2, queuedRequests: 0 });
  });

  it('uses priority within a lane while preserving deterministic order for equal priority', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 2, maximumRequestUnits: 2, interactiveWeight: 2 });
    allocator.request({ id: 'blocker', lane: 'critical', priority: 'urgent', units: 2, at: 1 });
    allocator.request({ id: 'standard-1', lane: 'interactive', priority: 'standard', units: 1, at: 2 });
    allocator.request({ id: 'urgent', lane: 'interactive', priority: 'urgent', units: 1, at: 3 });
    allocator.request({ id: 'standard-2', lane: 'interactive', priority: 'standard', units: 1, at: 4 });
    const promoted = allocator.release('blocker', 5);
    expect(promoted.map((grant) => grant.id)).toEqual(['urgent', 'standard-1']);
    expect(allocator.snapshot().lanes.interactive.queuedRequests).toBe(1);
  });

  it('rejects duplicate ownership across active and queued work', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 1, maximumRequestUnits: 1 });
    allocator.request({ id: 'same', lane: 'critical', priority: 'urgent', units: 1, at: 1 });
    expect(allocator.request({ id: 'same', lane: 'background', priority: 'standard', units: 1, at: 2 })).toMatchObject({ disposition: 'rejected', reason: 'duplicate' });
    allocator.request({ id: 'queued', lane: 'background', priority: 'standard', units: 1, at: 3 });
    expect(allocator.request({ id: 'queued', lane: 'interactive', priority: 'urgent', units: 1, at: 4 })).toMatchObject({ disposition: 'rejected', reason: 'duplicate' });
  });

  it('enforces global and per-lane queue capacity', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 1, maximumRequestUnits: 1, maximumQueue: 2, maximumPerLaneQueue: 1 });
    allocator.request({ id: 'active', lane: 'critical', priority: 'urgent', units: 1, at: 1 });
    allocator.request({ id: 'q1', lane: 'background', priority: 'standard', units: 1, at: 2 });
    expect(allocator.request({ id: 'q2', lane: 'background', priority: 'urgent', units: 1, at: 3 })).toMatchObject({ disposition: 'rejected', reason: 'lane-queue-full' });
    expect(allocator.request({ id: 'q3', lane: 'interactive', priority: 'urgent', units: 1, at: 4 }).disposition).toBe('queued');
    expect(allocator.request({ id: 'q4', lane: 'critical', priority: 'urgent', units: 1, at: 5 })).toMatchObject({ disposition: 'rejected', reason: 'queue-full' });
  });

  it('cancels queued requests without disturbing active work', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 1, maximumRequestUnits: 1 });
    allocator.request({ id: 'active', lane: 'critical', priority: 'urgent', units: 1, at: 1 });
    allocator.request({ id: 'waiting', lane: 'background', priority: 'standard', units: 1, at: 2 });
    expect(allocator.cancel('waiting', 3)).toBe(true);
    expect(allocator.cancel('missing', 4)).toBe(false);
    expect(allocator.snapshot()).toMatchObject({ activeRequests: 1, queuedRequests: 0 });
  });

  it('rejects oversized requests without consuming queue capacity', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 8, maximumRequestUnits: 4 });
    expect(allocator.request({ id: 'huge', lane: 'background', priority: 'standard', units: 5, at: 1 })).toMatchObject({ disposition: 'rejected', reason: 'oversized' });
    expect(allocator.snapshot()).toMatchObject({ activeRequests: 0, queuedRequests: 0 });
  });

  it('keeps decision history bounded and can disable it', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 1, maximumRequestUnits: 1, maximumHistory: 2 });
    allocator.request({ id: 'a', lane: 'critical', priority: 'urgent', units: 1, at: 1 });
    allocator.request({ id: 'b', lane: 'background', priority: 'standard', units: 1, at: 2 });
    allocator.cancel('b', 3);
    expect(allocator.history()).toHaveLength(2);
    const disabled = new RuntimeFairShareAllocator({ maximumHistory: 0 });
    disabled.request({ id: 'a', lane: 'critical', priority: 'urgent', units: 1, at: 1 });
    expect(disabled.history()).toEqual([]);
  });

  it('returns immutable snapshot, active and history structures', () => {
    const allocator = new RuntimeFairShareAllocator();
    allocator.request({ id: 'a', lane: 'critical', priority: 'urgent', units: 1, at: 1 });
    const snapshot = allocator.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes.critical)).toBe(true);
    expect(Object.isFrozen(allocator.active())).toBe(true);
    expect(Object.isFrozen(allocator.active()[0])).toBe(true);
    expect(Object.isFrozen(allocator.history())).toBe(true);
  });

  it('rejects time regression across operations', () => {
    const allocator = new RuntimeFairShareAllocator();
    allocator.request({ id: 'a', lane: 'critical', priority: 'urgent', units: 1, at: 10 });
    expect(() => allocator.request({ id: 'b', lane: 'interactive', priority: 'standard', units: 1, at: 9 })).toThrow(/monotonic/);
    expect(() => allocator.release('a', 9)).toThrow(/monotonic/);
  });

  it.each([
    ['', 'critical', 'urgent', 1, 1],
    ['x', 'invalid', 'urgent', 1, 1],
    ['x', 'critical', 'invalid', 1, 1],
    ['x', 'critical', 'urgent', 0, 1],
    ['x', 'critical', 'urgent', 1, -1],
  ])('rejects hostile request input %#', (id, lane, priority, units, at) => {
    const allocator = new RuntimeFairShareAllocator();
    expect(() => allocator.request({ id, lane, priority, units, at } as never)).toThrow();
  });

  it.each([
    { capacity: 0 }, { maximumQueue: -1 }, { maximumPerLaneQueue: -1 }, { maximumHistory: -1 },
    { criticalWeight: 0 }, { interactiveWeight: 0 }, { backgroundWeight: 0 }, { maximumRequestUnits: 0 },
    { capacity: 2, maximumRequestUnits: 3 }, { maximumQueue: 1, maximumPerLaneQueue: 2 },
  ])('rejects invalid policy %#', (policy) => {
    expect(() => new RuntimeFairShareAllocator(policy)).toThrow();
  });

  it('resets ownership, queues, history, deficits and clock state', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 1, maximumRequestUnits: 1 });
    allocator.request({ id: 'active', lane: 'critical', priority: 'urgent', units: 1, at: 10 });
    allocator.request({ id: 'waiting', lane: 'background', priority: 'standard', units: 1, at: 11 });
    allocator.reset();
    expect(allocator.snapshot()).toMatchObject({ activeUnits: 0, activeRequests: 0, queuedRequests: 0 });
    expect(allocator.history()).toEqual([]);
    expect(allocator.request({ id: 'fresh', lane: 'background', priority: 'standard', units: 1, at: 1 }).disposition).toBe('granted');
  });

  it('eventually gives a queued background lane service under repeated capacity turnover', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 1, maximumRequestUnits: 1, criticalWeight: 4, interactiveWeight: 3, backgroundWeight: 1 });
    allocator.request({ id: 'holder', lane: 'critical', priority: 'urgent', units: 1, at: 1 });
    allocator.request({ id: 'critical-next', lane: 'critical', priority: 'urgent', units: 1, at: 2 });
    allocator.request({ id: 'interactive-next', lane: 'interactive', priority: 'urgent', units: 1, at: 3 });
    allocator.request({ id: 'background-next', lane: 'background', priority: 'urgent', units: 1, at: 4 });
    let activeId = 'holder';
    let at = 5;
    const seen = new Set<string>();
    for (let count = 0; count < 4; count += 1) {
      const promoted = allocator.release(activeId, at++);
      if (promoted[0]) { activeId = promoted[0].id; seen.add(activeId); }
    }
    expect(seen.has('background-next')).toBe(true);
  });

  it('does not bypass an older large request within the same priority lane', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 4, maximumRequestUnits: 4, interactiveWeight: 4 });
    allocator.request({ id: 'holder', lane: 'critical', priority: 'urgent', units: 4, at: 1 });
    allocator.request({ id: 'large', lane: 'interactive', priority: 'standard', units: 4, at: 2 });
    allocator.request({ id: 'small', lane: 'interactive', priority: 'standard', units: 1, at: 3 });
    expect(allocator.release('holder', 4)[0]?.id).toBe('large');
  });

  it('accounts active units independently per lane', () => {
    const allocator = new RuntimeFairShareAllocator({ capacity: 10, maximumRequestUnits: 10 });
    allocator.request({ id: 'c', lane: 'critical', priority: 'urgent', units: 2, at: 1 });
    allocator.request({ id: 'i', lane: 'interactive', priority: 'standard', units: 3, at: 2 });
    allocator.request({ id: 'b', lane: 'background', priority: 'opportunistic', units: 4, at: 3 });
    const snapshot = allocator.snapshot();
    expect(snapshot.lanes.critical.activeUnits).toBe(2);
    expect(snapshot.lanes.interactive.activeUnits).toBe(3);
    expect(snapshot.lanes.background.activeUnits).toBe(4);
    expect(snapshot.activeUnits).toBe(9);
  });
});
