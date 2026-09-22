import { describe, expect, it } from 'vitest';
import { RuntimeFailureBudget } from './runtimeFailureBudget';

describe('RuntimeFailureBudget', () => {
  it('keeps independent bounded rolling windows per lane', () => {
    const budget = new RuntimeFailureBudget({ interactive: { windowSize: 3, minimumSamples: 2 } });
    budget.record('interactive', 'failure');
    budget.record('interactive', 'success');
    budget.record('interactive', 'timeout');
    const snapshot = budget.record('interactive', 'success');
    expect(snapshot.samples).toBe(3);
    expect(snapshot.failures).toBe(0);
    expect(snapshot.timeouts).toBe(1);
    expect(snapshot.successes).toBe(2);
    expect(budget.lane('critical').samples).toBe(0);
  });

  it('does not exhaust an immature budget', () => {
    const budget = new RuntimeFailureBudget({ critical: { minimumSamples: 3, maximumFailureRate: 0.1 } });
    expect(budget.record('critical', 'failure').exhausted).toBe(false);
    expect(budget.record('critical', 'failure').exhausted).toBe(false);
  });

  it('exhausts on mature failure or timeout pressure', () => {
    const budget = new RuntimeFailureBudget({ background: { windowSize: 4, minimumSamples: 4, maximumFailureRate: 0.5, maximumTimeoutRate: 0.2 } });
    budget.record('background', 'success');
    budget.record('background', 'success');
    budget.record('background', 'success');
    const snapshot = budget.record('background', 'timeout');
    expect(snapshot.failureRate).toBe(0.25);
    expect(snapshot.timeoutRate).toBe(0.25);
    expect(snapshot.exhausted).toBe(true);
  });

  it('counts cancellation and rejection without treating them as execution failures', () => {
    const budget = new RuntimeFailureBudget({ interactive: { minimumSamples: 2 } });
    budget.record('interactive', 'cancelled');
    const snapshot = budget.record('interactive', 'rejected');
    expect(snapshot.cancelled).toBe(1);
    expect(snapshot.rejected).toBe(1);
    expect(snapshot.failureRate).toBe(0);
    expect(snapshot.exhausted).toBe(false);
  });

  it('returns frozen snapshots and supports scoped reset', () => {
    const budget = new RuntimeFailureBudget();
    budget.record('critical', 'success');
    budget.record('background', 'failure');
    const snapshot = budget.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes)).toBe(true);
    budget.reset('critical');
    expect(budget.lane('critical').samples).toBe(0);
    expect(budget.lane('background').samples).toBe(1);
    budget.reset();
    expect(budget.lane('background').samples).toBe(0);
  });

  it('rejects invalid or internally inconsistent policy values', () => {
    expect(() => new RuntimeFailureBudget({ critical: { windowSize: 0 } })).toThrow(RangeError);
    expect(() => new RuntimeFailureBudget({ critical: { windowSize: 2, minimumSamples: 3 } })).toThrow(RangeError);
    expect(() => new RuntimeFailureBudget({ critical: { maximumFailureRate: Number.NaN } })).toThrow(RangeError);
    expect(() => new RuntimeFailureBudget({ critical: { maximumTimeoutRate: 2 } })).toThrow(RangeError);
  });
});
