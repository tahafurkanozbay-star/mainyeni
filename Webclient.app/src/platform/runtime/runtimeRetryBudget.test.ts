import { describe, expect, it } from 'vitest';
import { RuntimeRetryBudget, type RuntimeRetryBudgetConfig } from './runtimeRetryBudget';

const config = (): RuntimeRetryBudgetConfig => ({
  maxActive: 2,
  maxHistory: 5,
  maxRetryAfterMs: 5_000,
  lanes: {
    critical: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 2_000, multiplier: 2, jitterRatio: 0 },
    interactive: { maxAttempts: 4, baseDelayMs: 200, maxDelayMs: 2_000, multiplier: 2, jitterRatio: 0 },
    background: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 2_000, multiplier: 2, jitterRatio: 0 },
  },
});

function admitted(runtime: RuntimeRetryBudget, lane: 'critical' | 'interactive' | 'background' = 'interactive', extra = {}) {
  const result = runtime.admit({ lane, now: 1_000, ...extra });
  expect(result.kind).toBe('admitted');
  if (result.kind !== 'admitted') throw new Error('expected admission');
  return result.lease;
}

describe('RuntimeRetryBudget', () => {
  it('validates bounded configuration', () => {
    expect(() => new RuntimeRetryBudget({ ...config(), maxActive: 0 })).toThrow(RangeError);
    expect(() => new RuntimeRetryBudget({ ...config(), lanes: { ...config().lanes, critical: { ...config().lanes.critical, jitterRatio: 2 } } })).toThrow(RangeError);
    expect(() => new RuntimeRetryBudget({ ...config(), lanes: { ...config().lanes, background: { ...config().lanes.background, maxDelayMs: 10 } } })).toThrow(RangeError);
  });

  it('enforces capacity and duplicate ownership', () => {
    const runtime = new RuntimeRetryBudget(config());
    admitted(runtime, 'critical', { key: 'a' });
    expect(runtime.admit({ lane: 'critical', now: 1_001, key: 'a' })).toEqual({ kind: 'rejected', reason: 'duplicate-key' });
    admitted(runtime, 'background', { key: 'b' });
    expect(runtime.admit({ lane: 'interactive', now: 1_002 })).toEqual({ kind: 'rejected', reason: 'capacity' });
  });

  it('computes capped exponential retry delays without owning timers', () => {
    const runtime = new RuntimeRetryBudget(config());
    const lease = admitted(runtime, 'critical');
    expect(runtime.next(lease.id, 1_100)).toEqual({ kind: 'retry', attempt: 1, delayMs: 100, scheduledAt: 1_200 });
    expect(runtime.next(lease.id, 1_200)).toEqual({ kind: 'retry', attempt: 2, delayMs: 200, scheduledAt: 1_400 });
    expect(runtime.next(lease.id, 1_400)).toEqual({ kind: 'retry', attempt: 3, delayMs: 400, scheduledAt: 1_800 });
    expect(runtime.snapshot().attempts).toBe(3);
  });

  it('stops at attempt limit without mutating attempt count', () => {
    const runtime = new RuntimeRetryBudget(config());
    const lease = admitted(runtime, 'background');
    expect(runtime.next(lease.id, 1_100)?.kind).toBe('retry');
    expect(runtime.next(lease.id, 1_700)?.kind).toBe('retry');
    expect(runtime.next(lease.id, 2_800)).toEqual({ kind: 'stop', reason: 'attempt-limit' });
    expect(runtime.snapshot().attempts).toBe(2);
  });

  it('honors bounded server retry-after hints', () => {
    const runtime = new RuntimeRetryBudget(config());
    const lease = admitted(runtime);
    expect(runtime.next(lease.id, 1_100, 2_500)).toEqual({ kind: 'retry', attempt: 1, delayMs: 2_500, scheduledAt: 3_600 });
    expect(runtime.next(lease.id, 3_600, 5_001)).toEqual({ kind: 'stop', reason: 'retry-after-budget' });
  });

  it('refuses retries that would exhaust the caller deadline', () => {
    const runtime = new RuntimeRetryBudget(config());
    const lease = admitted(runtime, 'interactive', { deadline: 1_250 });
    expect(runtime.next(lease.id, 1_100)).toEqual({ kind: 'stop', reason: 'deadline-budget' });
    expect(runtime.admit({ lane: 'interactive', now: 2_000, deadline: 2_000 })).toEqual({ kind: 'rejected', reason: 'deadline-expired' });
  });

  it('uses deterministic bounded jitter', () => {
    const cfg = config();
    const jittered = { ...cfg, lanes: { ...cfg.lanes, critical: { ...cfg.lanes.critical, jitterRatio: 0.25 } } };
    const a = new RuntimeRetryBudget(jittered);
    const b = new RuntimeRetryBudget(jittered);
    const la = admitted(a, 'critical');
    const lb = admitted(b, 'critical');
    const da = a.next(la.id, 1_100);
    const db = b.next(lb.id, 1_100);
    expect(da).toEqual(db);
    expect(da?.kind).toBe('retry');
    if (da?.kind === 'retry') expect(da.delayMs).toBeGreaterThanOrEqual(75);
    if (da?.kind === 'retry') expect(da.delayMs).toBeLessThanOrEqual(125);
  });

  it('releases keys only after valid completion or cancellation', () => {
    const runtime = new RuntimeRetryBudget(config());
    const lease = admitted(runtime, 'critical', { key: 'request' });
    expect(runtime.complete(lease.id, Number.NaN)).toBe(false);
    expect(runtime.admit({ lane: 'critical', now: 1_100, key: 'request' }).kind).toBe('rejected');
    expect(runtime.complete(lease.id, 1_200)).toBe(true);
    expect(runtime.admit({ lane: 'critical', now: 1_300, key: 'request' }).kind).toBe('admitted');
  });

  it('keeps diagnostics bounded and immutable by value', () => {
    const runtime = new RuntimeRetryBudget(config());
    for (let i = 0; i < 4; i += 1) {
      const lease = admitted(runtime, 'critical');
      runtime.cancel(lease.id, 1_100 + i);
    }
    const snapshot = runtime.snapshot();
    expect(snapshot.history).toHaveLength(5);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
    expect(Object.isFrozen(snapshot.activeByLane)).toBe(true);
  });

  it('reset deterministically releases all ownership', () => {
    const runtime = new RuntimeRetryBudget(config());
    admitted(runtime, 'critical', { key: 'a' });
    admitted(runtime, 'background', { key: 'b' });
    runtime.reset(2_000);
    expect(runtime.snapshot().active).toBe(0);
    expect(runtime.admit({ lane: 'critical', now: 2_100, key: 'a' }).kind).toBe('admitted');
  });
});
