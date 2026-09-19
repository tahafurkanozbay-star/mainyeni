import { describe, expect, it } from 'vitest';
import { BoundedFailureBudget } from './failureBudget';

const clock = () => {
  let now = 10_000;
  return { now: () => now, advance: (milliseconds: number) => { now += milliseconds; }, set: (value: number) => { now = value; } };
};

describe('BoundedFailureBudget', () => {
  it('starts healthy with an immutable empty snapshot and one-attempt contract', () => {
    const time = clock();
    const budget = new BoundedFailureBudget({ clock: time.now });
    expect(budget.maxAttempts).toBe(1);
    const snapshot = budget.snapshot();
    expect(snapshot).toEqual({ state: 'healthy', windowStartedAt: 10_000, windowEndsAt: 70_000, totalWeight: 0, successWeight: 0, failureWeight: 0, ignoredWeight: 0, failureRatio: 0, samples: 0, recoveryProgress: 0, transitionCount: 0 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(budget.allowsOptionalWork()).toBe(true);
  });

  it('does not degrade before the minimum sample floor', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ minimumSamples: 4, clock: time.now });
    budget.record('failure'); budget.record('failure'); budget.record('failure');
    expect(budget.snapshot().state).toBe('healthy'); expect(budget.snapshot().failureRatio).toBe(1);
  });

  it('enters degraded state at the configured ratio', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ minimumSamples: 5, degradedFailureRatio: 0.2, exhaustedFailureRatio: 0.6, recoveryFailureRatio: 0.1, clock: time.now });
    for (let index = 0; index < 4; index += 1) budget.record('success');
    const snapshot = budget.record('failure'); expect(snapshot.state).toBe('degraded'); expect(snapshot.failureRatio).toBeCloseTo(0.2); expect(snapshot.transitionCount).toBe(1); expect(budget.allowsOptionalWork()).toBe(true);
  });

  it('enters exhausted state and rejects optional admission signal', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ minimumSamples: 4, degradedFailureRatio: 0.25, exhaustedFailureRatio: 0.5, recoveryFailureRatio: 0.1, clock: time.now });
    budget.record('success'); budget.record('success'); budget.record('failure'); const snapshot = budget.record('failure');
    expect(snapshot.state).toBe('exhausted'); expect(snapshot.failureRatio).toBe(0.5); expect(budget.allowsOptionalWork()).toBe(false);
  });

  it('uses weight for ratios while retaining bounded sample evidence', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ minimumSamples: 2, clock: time.now });
    budget.record('success', { weight: 9 }); const snapshot = budget.record('failure', { weight: 1 });
    expect(snapshot.successWeight).toBe(9); expect(snapshot.failureWeight).toBe(1); expect(snapshot.totalWeight).toBe(10); expect(snapshot.failureRatio).toBeCloseTo(0.1); expect(snapshot.samples).toBe(2); expect(snapshot.state).toBe('healthy');
  });

  it('keeps ignored outcomes outside the failure ratio', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ minimumSamples: 3, clock: time.now });
    budget.record('success', { weight: 2 }); budget.record('failure', { weight: 1 }); const snapshot = budget.record('ignored', { weight: 100 });
    expect(snapshot.totalWeight).toBe(103); expect(snapshot.ignoredWeight).toBe(100); expect(snapshot.failureRatio).toBeCloseTo(1 / 3);
  });

  it('prunes expired buckets from the rolling window', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ windowMs: 10_000, bucketMs: 1_000, minimumSamples: 2, clock: time.now });
    budget.record('failure'); time.advance(1_000); budget.record('failure'); expect(budget.snapshot().failureWeight).toBe(2); time.advance(9_000);
    const snapshot = budget.snapshot(); expect(snapshot.failureWeight).toBe(0); expect(snapshot.samples).toBe(0); expect(snapshot.state).toBe('exhausted');
  });

  it('keeps adjacent buckets and expires them independently', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ windowMs: 5_000, bucketMs: 1_000, clock: time.now });
    budget.record('success'); time.advance(999); budget.record('failure'); expect(budget.snapshot().samples).toBe(2); time.advance(1); budget.record('success'); expect(budget.snapshot().samples).toBe(3); time.advance(4_000); expect(budget.snapshot().samples).toBe(1);
  });

  it('requires consecutive recovery evidence below the recovery ratio', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ windowMs: 10_000, bucketMs: 1_000, minimumSamples: 2, degradedFailureRatio: 0.25, exhaustedFailureRatio: 0.5, recoveryFailureRatio: 0.1, recoverySamples: 2, clock: time.now });
    budget.record('failure'); budget.record('failure'); expect(budget.snapshot().state).toBe('exhausted');
    time.advance(10_000);
    const first = budget.record('success'); expect(first.state).toBe('exhausted'); expect(first.recoveryProgress).toBe(1); expect(budget.allowsOptionalWork()).toBe(false);
    const second = budget.record('success'); expect(second.state).toBe('healthy'); expect(second.recoveryProgress).toBe(0); expect(budget.allowsOptionalWork()).toBe(true);
  });

  it('does not let ignored evidence unlock an exhausted budget', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ windowMs: 10_000, bucketMs: 1_000, minimumSamples: 2, degradedFailureRatio: 0.25, exhaustedFailureRatio: 0.5, recoveryFailureRatio: 0.1, recoverySamples: 2, clock: time.now });
    budget.record('failure'); budget.record('failure'); time.advance(10_000);
    const ignored = budget.record('ignored'); expect(ignored.state).toBe('exhausted'); expect(ignored.recoveryProgress).toBe(0);
    const success = budget.record('success'); expect(success.state).toBe('exhausted'); expect(success.recoveryProgress).toBe(1);
  });

  it('resets partial recovery when a new failure arrives', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ windowMs: 10_000, bucketMs: 1_000, minimumSamples: 2, degradedFailureRatio: 0.25, exhaustedFailureRatio: 0.5, recoveryFailureRatio: 0.1, recoverySamples: 2, clock: time.now });
    budget.record('failure'); budget.record('failure'); time.advance(10_000);
    expect(budget.record('success').recoveryProgress).toBe(1);
    const failed = budget.record('failure'); expect(failed.state).toBe('exhausted'); expect(failed.recoveryProgress).toBe(0);
  });

  it('recovers with hysteresis when enough low-failure evidence accumulates', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ windowMs: 20_000, bucketMs: 1_000, minimumSamples: 4, degradedFailureRatio: 0.2, exhaustedFailureRatio: 0.5, recoveryFailureRatio: 0.1, recoverySamples: 2, clock: time.now });
    budget.record('failure'); budget.record('failure'); budget.record('success'); budget.record('success'); expect(budget.snapshot().state).toBe('exhausted'); time.advance(20_000); for (let index = 0; index < 4; index += 1) budget.record('success'); expect(budget.snapshot().state).toBe('healthy');
  });

  it('records bounded immutable history with transition evidence', () => {
    const time = clock(); const budget = new BoundedFailureBudget({ minimumSamples: 2, degradedFailureRatio: 0.25, exhaustedFailureRatio: 0.5, recoveryFailureRatio: 0.1, historyLimit: 3, clock: time.now });
    budget.record('success', { owner: 'search' }); budget.record('failure', { owner: 'search' }); budget.record('failure', { owner: 'map' }); const history = budget.history();
    expect(history).toHaveLength(3); expect(history.some(event => event.kind === 'transition')).toBe(true); expect(Object.isFrozen(history)).toBe(true); expect(history.every(event => Object.isFrozen(event))).toBe(true);
  });

  it('supports disabling retained history', () => { const time = clock(); const budget = new BoundedFailureBudget({ historyLimit: 0, clock: time.now }); budget.record('failure'); budget.reset(); expect(budget.history()).toEqual([]); });
  it('reset clears rolling evidence and returns to healthy', () => { const time = clock(); const budget = new BoundedFailureBudget({ minimumSamples: 2, clock: time.now }); budget.record('failure'); budget.record('failure'); expect(budget.snapshot().state).toBe('exhausted'); const snapshot = budget.reset(); expect(snapshot.state).toBe('healthy'); expect(snapshot.samples).toBe(0); expect(snapshot.totalWeight).toBe(0); });

  it('validates structural configuration fail closed', () => {
    expect(() => new BoundedFailureBudget({ windowMs: 999 })).toThrow(RangeError); expect(() => new BoundedFailureBudget({ windowMs: 10_000, bucketMs: 3_000 })).toThrow('divisible'); expect(() => new BoundedFailureBudget({ degradedFailureRatio: 0.5, exhaustedFailureRatio: 0.5 })).toThrow(RangeError); expect(() => new BoundedFailureBudget({ recoveryFailureRatio: 0.2, degradedFailureRatio: 0.2 })).toThrow(RangeError); expect(() => new BoundedFailureBudget({ minimumSamples: 0 })).toThrow(RangeError); expect(() => new BoundedFailureBudget({ historyLimit: 1_001 })).toThrow(RangeError);
  });

  it('validates record weight and owner boundaries', () => {
    const budget = new BoundedFailureBudget(); expect(() => budget.record('success', { weight: 0 })).toThrow(RangeError); expect(() => budget.record('success', { weight: Number.NaN })).toThrow(RangeError); expect(() => budget.record('success', { weight: 1_001 })).toThrow(RangeError); expect(() => budget.record('success', { owner: '   ' })).toThrow(RangeError); expect(() => budget.record('success', { owner: 'x'.repeat(129) })).toThrow(RangeError);
  });

  it('rejects unknown runtime outcomes despite compile-time typing', () => { const budget = new BoundedFailureBudget(); expect(() => budget.record('timeout' as never)).toThrow(TypeError); });
  it('rejects non-finite and backward clocks', () => { expect(() => new BoundedFailureBudget({ clock: () => Number.NaN }).snapshot()).toThrow(RangeError); const time = clock(); const budget = new BoundedFailureBudget({ clock: time.now }); budget.record('success'); time.set(9_999); expect(() => budget.snapshot()).toThrow('monotonic'); });
  it('normalizes owner whitespace in retained evidence', () => { const time = clock(); const budget = new BoundedFailureBudget({ clock: time.now }); budget.record('success', { owner: '  search  ' }); expect(budget.history().at(-1)?.owner).toBe('search'); });
  it('caps the number of live buckets by the rolling window', () => { const time = clock(); const budget = new BoundedFailureBudget({ windowMs: 5_000, bucketMs: 1_000, clock: time.now }); for (let index = 0; index < 20; index += 1) { budget.record(index % 2 === 0 ? 'success' : 'failure'); time.advance(1_000); } expect(budget.snapshot().samples).toBeLessThanOrEqual(4); });
  it('does not perform work, polling, or network activity', () => { const time = clock(); const budget = new BoundedFailureBudget({ clock: time.now }); const before = time.now(); budget.record('success'); budget.record('ignored'); expect(time.now()).toBe(before); expect(budget.snapshot().samples).toBe(2); });
});
