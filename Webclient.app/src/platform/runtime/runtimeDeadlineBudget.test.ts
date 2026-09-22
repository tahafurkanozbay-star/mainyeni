import { describe, expect, it } from 'vitest';
import { RuntimeDeadlineBudget, type RuntimeDeadlineBudgetConfig } from './runtimeDeadlineBudget';

const config: RuntimeDeadlineBudgetConfig = {
  lanes: {
    critical: { minMs: 50, targetMs: 500, maxMs: 2_000, reserveMs: 25 },
    interactive: { minMs: 40, targetMs: 300, maxMs: 1_000, reserveMs: 40 },
    background: { minMs: 20, targetMs: 100, maxMs: 500, reserveMs: 50 },
  },
  maxDepth: 3,
  maxHistory: 6,
  maxClockSkewMs: 5,
};

describe('RuntimeDeadlineBudget', () => {
  it('allocates lane target budgets without a parent', () => {
    const budget = new RuntimeDeadlineBudget(config);
    const result = budget.admit({ lane: 'interactive', now: 1_000 });
    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(result.lease).toMatchObject({ startedAt: 1_000, budgetMs: 300, deadline: 1_300, depth: 1 });
  });

  it('clamps explicit requests to lane minimum and maximum', () => {
    const budget = new RuntimeDeadlineBudget(config);
    const short = budget.admit({ lane: 'critical', now: 10, requestedMs: 1 });
    const long = budget.admit({ lane: 'background', now: 20, requestedMs: 99_999 });
    expect(short.kind === 'admitted' && short.lease.budgetMs).toBe(50);
    expect(long.kind === 'admitted' && long.lease.budgetMs).toBe(500);
  });

  it('preserves parent reserve when constraining a child budget', () => {
    const budget = new RuntimeDeadlineBudget(config);
    const result = budget.admit({ lane: 'background', now: 100, parentDeadline: 260, requestedMs: 500 });
    expect(result.kind).toBe('admitted');
    if (result.kind !== 'admitted') return;
    expect(result.lease.budgetMs).toBe(110);
    expect(result.lease.deadline).toBe(210);
  });

  it('rejects children when parent reserve leaves less than lane minimum', () => {
    const budget = new RuntimeDeadlineBudget(config);
    expect(budget.admit({ lane: 'interactive', now: 100, parentDeadline: 170 })).toEqual({
      kind: 'rejected', reason: 'insufficient-parent-budget',
    });
  });

  it('rejects already expired parents', () => {
    const budget = new RuntimeDeadlineBudget(config);
    expect(budget.admit({ lane: 'critical', now: 500, parentDeadline: 500 })).toEqual({ kind: 'rejected', reason: 'expired-parent' });
  });

  it('creates nested children against the actual parent deadline', () => {
    const budget = new RuntimeDeadlineBudget(config);
    const parent = budget.admit({ lane: 'critical', now: 1_000, requestedMs: 1_000 });
    expect(parent.kind).toBe('admitted');
    if (parent.kind !== 'admitted') return;
    const child = budget.child(parent.lease.id, { lane: 'interactive', now: 1_100, requestedMs: 900 });
    expect(child.kind).toBe('admitted');
    if (child.kind !== 'admitted') return;
    expect(child.lease.depth).toBe(2);
    expect(child.lease.parentDeadline).toBe(2_000);
    expect(child.lease.deadline).toBe(2_000 - config.lanes.interactive.reserveMs);
  });

  it('enforces nesting depth without mutating parent ownership', () => {
    const budget = new RuntimeDeadlineBudget({ ...config, maxDepth: 2 });
    const root = budget.admit({ lane: 'critical', now: 0, requestedMs: 2_000 });
    if (root.kind !== 'admitted') throw new Error('root expected');
    const child = budget.child(root.lease.id, { lane: 'critical', now: 100, requestedMs: 1_000 });
    if (child.kind !== 'admitted') throw new Error('child expected');
    expect(budget.child(child.lease.id, { lane: 'critical', now: 200 })).toEqual({ kind: 'rejected', reason: 'depth-limit' });
    expect(budget.snapshot(200).active).toBe(2);
  });

  it('prevents duplicate keyed ownership until completion', () => {
    const budget = new RuntimeDeadlineBudget(config);
    const first = budget.admit({ lane: 'critical', now: 0, key: 'catalog' });
    expect(first.kind).toBe('admitted');
    expect(budget.admit({ lane: 'background', now: 1, key: 'catalog' })).toEqual({ kind: 'rejected', reason: 'duplicate-key' });
    if (first.kind !== 'admitted') return;
    budget.complete(first.lease.id, 20);
    expect(budget.admit({ lane: 'background', now: 21, key: 'catalog' }).kind).toBe('admitted');
  });

  it('reports completion timing and timeout state', () => {
    const budget = new RuntimeDeadlineBudget(config);
    const admission = budget.admit({ lane: 'background', now: 100, requestedMs: 80 });
    if (admission.kind !== 'admitted') throw new Error('admission expected');
    expect(budget.complete(admission.lease.id, 170)).toEqual({ leaseId: admission.lease.id, finishedAt: 170, elapsedMs: 70, remainingMs: 10, timedOut: false });

    const late = budget.admit({ lane: 'background', now: 200, requestedMs: 80 });
    if (late.kind !== 'admitted') throw new Error('admission expected');
    expect(budget.complete(late.lease.id, 300)?.timedOut).toBe(true);
  });

  it('does not consume a lease when completion time violates clock-skew guard', () => {
    const budget = new RuntimeDeadlineBudget(config);
    const admission = budget.admit({ lane: 'critical', now: 100 });
    if (admission.kind !== 'admitted') throw new Error('admission expected');
    expect(budget.complete(admission.lease.id, 90)).toBeNull();
    expect(budget.snapshot(100).active).toBe(1);
    expect(budget.complete(admission.lease.id, 96)).not.toBeNull();
  });

  it('expires overdue leases deterministically and releases their keys', () => {
    const budget = new RuntimeDeadlineBudget(config);
    const a = budget.admit({ lane: 'background', now: 0, requestedMs: 100, key: 'a' });
    const b = budget.admit({ lane: 'interactive', now: 0, requestedMs: 300, key: 'b' });
    if (a.kind !== 'admitted' || b.kind !== 'admitted') throw new Error('admissions expected');
    expect(budget.sweep(101).map((lease) => lease.id)).toEqual([a.lease.id]);
    expect(budget.snapshot(101).active).toBe(1);
    expect(budget.admit({ lane: 'background', now: 102, key: 'a' }).kind).toBe('admitted');
  });

  it('treats the deadline itself as usable and expires strictly after it', () => {
    const budget = new RuntimeDeadlineBudget(config);
    const admission = budget.admit({ lane: 'background', now: 0, requestedMs: 100 });
    if (admission.kind !== 'admitted') throw new Error('admission expected');
    expect(budget.sweep(100)).toHaveLength(0);
    expect(budget.sweep(101)).toHaveLength(1);
  });

  it('cancels leases and releases duplicate keys', () => {
    const budget = new RuntimeDeadlineBudget(config);
    const admission = budget.admit({ lane: 'interactive', now: 0, key: 'search' });
    if (admission.kind !== 'admitted') throw new Error('admission expected');
    expect(budget.cancel(admission.lease.id, 5)).toBe(true);
    expect(budget.cancel(admission.lease.id, 6)).toBe(false);
    expect(budget.admit({ lane: 'interactive', now: 7, key: 'search' }).kind).toBe('admitted');
  });

  it('reports remaining time only for active valid leases', () => {
    const budget = new RuntimeDeadlineBudget(config);
    const admission = budget.admit({ lane: 'critical', now: 100, requestedMs: 500 });
    if (admission.kind !== 'admitted') throw new Error('admission expected');
    expect(budget.remaining(admission.lease.id, 250)).toBe(350);
    expect(budget.remaining(admission.lease.id, 700)).toBe(0);
    expect(budget.remaining(999, 100)).toBeNull();
    expect(budget.remaining(admission.lease.id, Number.NaN)).toBeNull();
  });

  it('produces immutable bounded diagnostics', () => {
    const budget = new RuntimeDeadlineBudget({ ...config, maxHistory: 2 });
    budget.admit({ lane: 'critical', now: 0 });
    budget.admit({ lane: 'interactive', now: 1 });
    budget.admit({ lane: 'background', now: 2 });
    const snapshot = budget.snapshot(3);
    expect(snapshot.activeByLane).toEqual({ critical: 1, interactive: 1, background: 1 });
    expect(snapshot.earliestDeadline).toBe(102);
    expect(snapshot.history).toHaveLength(2);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.activeByLane)).toBe(true);
  });

  it('counts overdue work without implicitly expiring it', () => {
    const budget = new RuntimeDeadlineBudget(config);
    budget.admit({ lane: 'background', now: 0, requestedMs: 100 });
    expect(budget.snapshot(101).overdue).toBe(1);
    expect(budget.snapshot(101).active).toBe(1);
  });

  it('reset releases all ownership while retaining bounded audit history', () => {
    const budget = new RuntimeDeadlineBudget(config);
    budget.admit({ lane: 'critical', now: 0, key: 'one' });
    budget.admit({ lane: 'background', now: 1, key: 'two' });
    budget.reset(2);
    expect(budget.snapshot(2).active).toBe(0);
    expect(budget.admit({ lane: 'critical', now: 3, key: 'one' }).kind).toBe('admitted');
  });

  it('rejects invalid timestamps without creating active state', () => {
    const budget = new RuntimeDeadlineBudget(config);
    expect(budget.admit({ lane: 'critical', now: Number.NaN })).toEqual({ kind: 'rejected', reason: 'invalid-time' });
    expect(budget.admit({ lane: 'critical', now: 0, parentDeadline: Number.POSITIVE_INFINITY })).toEqual({ kind: 'rejected', reason: 'invalid-time' });
    expect(budget.snapshot(0).active).toBe(0);
  });

  it('validates configuration invariants eagerly', () => {
    expect(() => new RuntimeDeadlineBudget({ ...config, maxDepth: 0 })).toThrow(RangeError);
    expect(() => new RuntimeDeadlineBudget({ ...config, lanes: { ...config.lanes, background: { minMs: 100, targetMs: 50, maxMs: 500, reserveMs: 0 } } })).toThrow(RangeError);
    expect(() => new RuntimeDeadlineBudget({ ...config, lanes: { ...config.lanes, critical: { ...config.lanes.critical, reserveMs: -1 } } })).toThrow(RangeError);
  });
});
