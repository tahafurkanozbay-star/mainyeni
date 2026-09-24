import { describe, expect, it } from 'vitest';
import { RuntimeFailureBudget } from './runtimeFailureBudget';

describe('RuntimeFailureBudget', () => {
  it('keeps independent bounded rolling windows per lane', () => {
    const budget = new RuntimeFailureBudget({ interactive: { windowSize: 3, minimumSamples: 2 } });
    budget.recordMany('interactive', ['failure', 'success', 'timeout']);
    const snapshot = budget.record('interactive', 'success');
    expect(snapshot).toMatchObject({ samples: 3, failures: 0, timeouts: 1, successes: 2 });
    expect(budget.lane('critical').samples).toBe(0);
  });

  it('does not exhaust an immature budget', () => {
    const budget = new RuntimeFailureBudget({ critical: { minimumSamples: 3, maximumFailureRate: 0.1 } });
    expect(budget.record('critical', 'failure').exhausted).toBe(false);
    expect(budget.record('critical', 'failure').exhausted).toBe(false);
  });

  it('exhausts on mature failure or timeout pressure', () => {
    const budget = new RuntimeFailureBudget({ background: { windowSize: 4, minimumSamples: 4, maximumFailureRate: 0.5, maximumTimeoutRate: 0.2 } });
    budget.recordMany('background', ['success', 'success', 'success', 'timeout']);
    const snapshot = budget.lane('background');
    expect(snapshot.failureRate).toBe(0.25);
    expect(snapshot.timeoutRate).toBe(0.25);
    expect(snapshot.exhausted).toBe(true);
  });

  it('counts cancellation and rejection without treating them as execution failures', () => {
    const budget = new RuntimeFailureBudget({ interactive: { minimumSamples: 2 } });
    budget.recordMany('interactive', ['cancelled', 'rejected']);
    const snapshot = budget.lane('interactive');
    expect(snapshot).toMatchObject({ cancelled: 1, rejected: 1, failureRate: 0, exhausted: false });
  });

  it('returns immutable aggregate diagnostics with normalized pressure', () => {
    const budget = new RuntimeFailureBudget({ critical: { minimumSamples: 2, maximumFailureRate: 0.5, maximumTimeoutRate: 0.5 } });
    budget.recordMany('critical', ['failure', 'success']);
    budget.record('background', 'success');
    const diagnostics = budget.diagnostics();
    expect(diagnostics.totalSamples).toBe(3);
    expect(diagnostics.pressure.critical).toBe(1);
    expect(diagnostics.exhaustedLanes).toEqual(['critical']);
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics.pressure)).toBe(true);
    expect(Object.isFrozen(diagnostics.exhaustedLanes)).toBe(true);
  });

  it('exposes frozen normalized policies without mutable aliases', () => {
    const budget = new RuntimeFailureBudget({ background: { windowSize: 7, minimumSamples: 3 } });
    const policy = budget.policy('background');
    expect(policy.windowSize).toBe(7);
    expect(policy.minimumSamples).toBe(3);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('supports bounded batch recording while preserving sequence ordering', () => {
    const budget = new RuntimeFailureBudget({ critical: { windowSize: 3, minimumSamples: 1 } });
    const lane = budget.recordMany('critical', ['failure', 'timeout', 'success', 'success']);
    expect(lane.samples).toBe(3);
    expect(lane.failures).toBe(0);
    expect(lane.timeouts).toBe(1);
    expect(budget.snapshot().sequence).toBe(4);
  });

  it('returns frozen snapshots and supports scoped reset', () => {
    const budget = new RuntimeFailureBudget();
    budget.record('critical', 'success'); budget.record('background', 'failure');
    const snapshot = budget.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.lanes)).toBe(true);
    budget.reset('critical');
    expect(budget.lane('critical').samples).toBe(0); expect(budget.lane('background').samples).toBe(1);
    budget.reset(); expect(budget.lane('background').samples).toBe(0);
  });

  it('rejects invalid or internally inconsistent policy values', () => {
    expect(() => new RuntimeFailureBudget({ critical: { windowSize: 0 } })).toThrow(RangeError);
    expect(() => new RuntimeFailureBudget({ critical: { windowSize: 2, minimumSamples: 3 } })).toThrow(RangeError);
    expect(() => new RuntimeFailureBudget({ critical: { maximumFailureRate: Number.NaN } })).toThrow(RangeError);
    expect(() => new RuntimeFailureBudget({ critical: { maximumTimeoutRate: 2 } })).toThrow(RangeError);
  });

  it('fails closed for forged lane/outcome values and oversized batches', () => {
    const budget = new RuntimeFailureBudget();
    expect(() => budget.record('unknown' as never, 'success')).toThrow(TypeError);
    expect(() => budget.record('critical', 'unknown' as never)).toThrow(TypeError);
    expect(() => budget.lane('unknown' as never)).toThrow(TypeError);
    expect(() => budget.recordMany('critical', Array.from({ length: 10_001 }, () => 'success' as const))).toThrow(RangeError);
    expect(budget.snapshot().sequence).toBe(0);
  });
});
