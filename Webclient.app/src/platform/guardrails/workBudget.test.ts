import { describe, expect, it } from 'vitest';
import { createWorkBudgetController, normalizeWorkBudgetPolicy } from './workBudget';

describe('workBudget', () => {
  it('starts work immediately while concurrent capacity remains', () => {
    const runtime = createWorkBudgetController({ maxConcurrent: 2 });
    const first = runtime.admit({ key: 'map' });
    const second = runtime.admit({ key: 'search' });
    expect(first).toMatchObject({ admitted: true, state: 'running' });
    expect(second).toMatchObject({ admitted: true, state: 'running' });
    expect(runtime.snapshot()).toMatchObject({ running: 2, queued: 0 });
  });

  it('queues excess work deterministically', () => {
    const runtime = createWorkBudgetController({ maxConcurrent: 1, maxQueued: 2, maxPerKey: 3 });
    runtime.admit({ key: 'a', priority: 0, at: 10 });
    const queued = runtime.admit({ key: 'b', priority: 3, at: 11 });
    expect(queued.state).toBe('queued');
    expect(runtime.snapshot().queued).toBe(1);
  });

  it('promotes higher priority queued work first', () => {
    const runtime = createWorkBudgetController({ maxConcurrent: 1, maxQueued: 4, maxPerKey: 4 });
    const running = runtime.admit({ key: 'running', at: 1 });
    const low = runtime.admit({ key: 'low', priority: 1, at: 2 });
    const high = runtime.admit({ key: 'high', priority: 10, at: 3 });
    runtime.complete(running.id, 4);
    const snapshot = runtime.snapshot();
    expect(snapshot.tickets.find((ticket) => ticket.id === high.id)?.state).toBe('running');
    expect(snapshot.tickets.find((ticket) => ticket.id === low.id)?.state).toBe('queued');
  });

  it('uses FIFO order for equal priority queued work', () => {
    const runtime = createWorkBudgetController({ maxConcurrent: 1, maxQueued: 4, maxPerKey: 4 });
    const running = runtime.admit({ key: 'running', at: 1 });
    const first = runtime.admit({ key: 'first', priority: 5, at: 2 });
    runtime.admit({ key: 'second', priority: 5, at: 3 });
    runtime.complete(running.id, 4);
    expect(runtime.snapshot().tickets.find((ticket) => ticket.id === first.id)?.state).toBe('running');
  });

  it('enforces per-key active work limits', () => {
    const runtime = createWorkBudgetController({ maxConcurrent: 4, maxPerKey: 1 });
    expect(runtime.admit({ key: 'same' }).admitted).toBe(true);
    expect(runtime.admit({ key: 'same' })).toMatchObject({
      admitted: false,
      state: 'rejected',
    });
    expect(runtime.snapshot().rejected).toBe(1);
  });

  it('rejects when both running and queued capacities are full', () => {
    const runtime = createWorkBudgetController({ maxConcurrent: 1, maxQueued: 1, maxPerKey: 3 });
    runtime.admit({ key: 'a' });
    runtime.admit({ key: 'b' });
    expect(runtime.admit({ key: 'c' }).admitted).toBe(false);
    expect(runtime.snapshot()).toMatchObject({ running: 1, queued: 1, rejected: 1 });
  });

  it('rejects empty keys', () => {
    const runtime = createWorkBudgetController();
    expect(runtime.admit({ key: '   ' }).admitted).toBe(false);
  });

  it('expires queued work after its wait budget', () => {
    const runtime = createWorkBudgetController({
      maxConcurrent: 1,
      maxQueued: 3,
      maxWaitMs: 10,
      maxPerKey: 3,
    });
    runtime.admit({ key: 'a', at: 0 });
    const queued = runtime.admit({ key: 'b', at: 0 });
    const swept = runtime.sweep(11);
    expect(swept.some((ticket) => ticket.id === queued.id && ticket.reason === 'wait-deadline')).toBe(true);
  });

  it('expires running work after its runtime budget', () => {
    const runtime = createWorkBudgetController({ maxRunMs: 10 });
    const ticket = runtime.admit({ key: 'a', at: 0 });
    const swept = runtime.sweep(11);
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ id: ticket.id, state: 'cancelled', reason: 'run-deadline' });
  });

  it('records queue wait and run durations', () => {
    const runtime = createWorkBudgetController({ maxConcurrent: 1, maxPerKey: 3 });
    const first = runtime.admit({ key: 'a', at: 10 });
    const second = runtime.admit({ key: 'b', at: 12 });
    runtime.complete(first.id, 20);
    const completed = runtime.complete(second.id, 30);
    expect(completed.queueWaitMs).toBe(8);
    expect(completed.runMs).toBe(10);
  });

  it('cancels active work and promotes queued work', () => {
    const runtime = createWorkBudgetController({ maxConcurrent: 1, maxPerKey: 3 });
    const first = runtime.admit({ key: 'a', at: 1 });
    const second = runtime.admit({ key: 'b', at: 2 });
    runtime.cancel(first.id, 'superseded', 3);
    expect(runtime.snapshot().tickets.find((ticket) => ticket.id === second.id)?.state).toBe('running');
  });

  it('bounds retained terminal history', () => {
    const runtime = createWorkBudgetController({
      maxConcurrent: 1,
      maxCompletedHistory: 2,
      maxPerKey: 5,
    });
    for (let index = 0; index < 4; index += 1) {
      const ticket = runtime.admit({ key: 'k' + index, at: index * 2 });
      runtime.complete(ticket.id, index * 2 + 1);
    }
    expect(runtime.snapshot().tickets.filter((ticket) => ticket.state === 'completed')).toHaveLength(2);
  });

  it('clears terminal entries without disturbing active work', () => {
    const runtime = createWorkBudgetController({ maxConcurrent: 2 });
    const first = runtime.admit({ key: 'a' });
    runtime.complete(first.id);
    runtime.admit({ key: 'b' });
    runtime.clearCompleted();
    expect(runtime.snapshot().tickets).toHaveLength(1);
    expect(runtime.snapshot().running).toBe(1);
  });

  it('normalizes invalid policy values', () => {
    const policy = normalizeWorkBudgetPolicy({
      maxConcurrent: 0,
      maxQueued: Number.NaN,
      maxRunMs: -10,
    });
    expect(policy.maxConcurrent).toBeGreaterThan(0);
    expect(policy.maxQueued).toBeGreaterThan(0);
    expect(policy.maxRunMs).toBeGreaterThan(0);
  });

  it('rejects operations after disposal', () => {
    const runtime = createWorkBudgetController();
    runtime.dispose();
    expect(() => runtime.snapshot()).toThrow('disposed');
    expect(() => runtime.admit({ key: 'a' })).toThrow('disposed');
  });
});
