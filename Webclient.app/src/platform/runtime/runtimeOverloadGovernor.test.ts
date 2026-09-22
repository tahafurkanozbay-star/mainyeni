import { describe, expect, it } from 'vitest';
import { RuntimeOverloadGovernor, type OverloadObservation } from './runtimeOverloadGovernor';

function sample(at: number, overrides: Partial<OverloadObservation> = {}): OverloadObservation {
  return {
    at,
    latencyMs: 100,
    errorRate: 0,
    queueUtilization: 0.1,
    concurrencyUtilization: 0.1,
    ...overrides,
  };
}

describe('RuntimeOverloadGovernor', () => {
  it('stays normal until the minimum evidence window is available', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 3, windowSize: 4 });
    governor.observe(sample(1, { latencyMs: 2_000, errorRate: 0.3, queueUtilization: 1, concurrencyUtilization: 1 }));
    governor.observe(sample(2, { latencyMs: 2_000, errorRate: 0.3, queueUtilization: 1, concurrencyUtilization: 1 }));
    expect(governor.diagnostics().level).toBe('normal');
    expect(governor.diagnostics().score).toBe(0);
  });

  it('enters emergency when every bounded pressure signal is saturated', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 2 });
    for (let at = 1; at <= 2; at += 1) {
      governor.observe(sample(at, { latencyMs: 2_000, errorRate: 0.3, queueUtilization: 1, concurrencyUtilization: 1 }));
    }
    expect(governor.diagnostics().level).toBe('emergency');
    expect(governor.diagnostics().score).toBe(1);
  });

  it('keeps critical work admitted while shedding non-critical work in emergency', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    governor.observe(sample(1, { latencyMs: 2_000, errorRate: 0.3, queueUtilization: 1, concurrencyUtilization: 1 }));
    expect(governor.admit('critical')).toMatchObject({ admitted: true, reason: 'admitted', level: 'emergency' });
    expect(governor.admit('interactive')).toMatchObject({ admitted: false, reason: 'emergency-shed' });
    expect(governor.admit('background')).toMatchObject({ admitted: false, reason: 'emergency-shed' });
  });

  it('sheds only background work at overloaded level', () => {
    const governor = new RuntimeOverloadGovernor({
      minimumSamples: 1,
      guardedScore: 0.2,
      overloadedScore: 0.4,
      emergencyScore: 0.95,
    });
    governor.observe(sample(1, { latencyMs: 1_700, queueUtilization: 0.8 }));
    expect(governor.diagnostics().level).toBe('overloaded');
    expect(governor.admit('critical').admitted).toBe(true);
    expect(governor.admit('interactive').admitted).toBe(true);
    expect(governor.admit('background')).toMatchObject({ admitted: false, reason: 'lane-shed' });
  });

  it('recovers one level at a time after stable samples and cooldown', () => {
    const governor = new RuntimeOverloadGovernor({
      windowSize: 2,
      minimumSamples: 1,
      recoverySamples: 2,
      cooldownMs: 10,
    });
    governor.observe(sample(0, { latencyMs: 2_000, errorRate: 0.3, queueUtilization: 1, concurrencyUtilization: 1 }));
    expect(governor.diagnostics().level).toBe('emergency');
    governor.observe(sample(10));
    governor.observe(sample(20));
    governor.observe(sample(30));
    expect(governor.diagnostics().level).toBe('overloaded');
    governor.observe(sample(40));
    governor.observe(sample(50));
    expect(governor.diagnostics().level).toBe('guarded');
    governor.observe(sample(60));
    governor.observe(sample(70));
    expect(governor.diagnostics().level).toBe('normal');
  });

  it('does not recover while score remains above the recovery threshold', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1, recoverySamples: 1, cooldownMs: 0 });
    governor.observe(sample(1, { latencyMs: 2_000, errorRate: 0.3, queueUtilization: 1, concurrencyUtilization: 1 }));
    governor.observe(sample(2, { latencyMs: 900, errorRate: 0.08, queueUtilization: 0.6, concurrencyUtilization: 0.7 }));
    expect(governor.diagnostics().level).toBe('emergency');
    expect(governor.diagnostics().stableSamples).toBe(0);
  });

  it('uses p95 latency so a hot tail remains visible inside the bounded window', () => {
    const governor = new RuntimeOverloadGovernor({ windowSize: 20, minimumSamples: 1 });
    for (let at = 1; at <= 18; at += 1) governor.observe(sample(at));
    governor.observe(sample(19, { latencyMs: 1_500 }));
    governor.observe(sample(20, { latencyMs: 1_500 }));
    expect(governor.diagnostics().p95LatencyMs).toBe(1_500);
  });

  it('evicts observations beyond the configured rolling window', () => {
    const governor = new RuntimeOverloadGovernor({ windowSize: 3, minimumSamples: 1 });
    governor.observe(sample(1, { latencyMs: 1_900 }));
    governor.observe(sample(2));
    governor.observe(sample(3));
    governor.observe(sample(4));
    expect(governor.diagnostics().sampleCount).toBe(3);
    expect(governor.diagnostics().p95LatencyMs).toBe(100);
  });

  it('bounds transition history', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1, windowSize: 1, recoverySamples: 1, cooldownMs: 0, historySize: 2 });
    governor.observe(sample(1, { latencyMs: 2_000, errorRate: 0.3, queueUtilization: 1, concurrencyUtilization: 1 }));
    governor.observe(sample(2));
    governor.observe(sample(3));
    governor.observe(sample(4));
    governor.observe(sample(5, { latencyMs: 2_000, errorRate: 0.3, queueUtilization: 1, concurrencyUtilization: 1 }));
    expect(governor.diagnostics().history).toHaveLength(2);
  });

  it('returns defensive frozen diagnostic structures', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    governor.observe(sample(1, { latencyMs: 2_000, errorRate: 0.3, queueUtilization: 1, concurrencyUtilization: 1 }));
    const diagnostics = governor.diagnostics();
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics.history)).toBe(true);
    expect(Object.isFrozen(diagnostics.history[0])).toBe(true);
  });

  it('reset removes samples, transitions, score, and overload state', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    governor.observe(sample(1, { latencyMs: 2_000, errorRate: 0.3, queueUtilization: 1, concurrencyUtilization: 1 }));
    governor.reset();
    expect(governor.diagnostics()).toMatchObject({
      level: 'normal', score: 0, sampleCount: 0, stableSamples: 0, lastTransitionAt: null,
    });
    expect(governor.diagnostics().history).toEqual([]);
  });

  it('accepts a new clock epoch after reset', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    governor.observe(sample(100));
    governor.reset();
    expect(() => governor.observe(sample(1))).not.toThrow();
  });

  it('rejects non-monotonic observations without mutating the window', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    governor.observe(sample(10));
    expect(() => governor.observe(sample(9))).toThrow(/monotonic/);
    expect(governor.diagnostics().sampleCount).toBe(1);
  });

  it.each([
    ['errorRate', -0.1], ['errorRate', 1.1], ['queueUtilization', -0.1], ['queueUtilization', 1.1],
    ['concurrencyUtilization', -0.1], ['concurrencyUtilization', 1.1],
  ] as const)('rejects invalid %s pressure %s', (field, value) => {
    const governor = new RuntimeOverloadGovernor();
    expect(() => governor.observe(sample(1, { [field]: value }))).toThrow(/between 0 and 1/);
  });

  it('rejects negative latency and timestamp values', () => {
    const governor = new RuntimeOverloadGovernor();
    expect(() => governor.observe(sample(-1))).toThrow(/at cannot be negative/);
    expect(() => governor.observe(sample(1, { latencyMs: -1 }))).toThrow(/latencyMs cannot be negative/);
  });

  it('rejects NaN and infinite observation values', () => {
    const governor = new RuntimeOverloadGovernor();
    expect(() => governor.observe(sample(Number.NaN))).toThrow(/finite/);
    expect(() => governor.observe(sample(1, { latencyMs: Number.POSITIVE_INFINITY }))).toThrow(/finite/);
  });

  it('rejects impossible evidence-window configuration', () => {
    expect(() => new RuntimeOverloadGovernor({ windowSize: 2, minimumSamples: 3 })).toThrow(/cannot exceed/);
  });

  it('rejects unordered score thresholds', () => {
    expect(() => new RuntimeOverloadGovernor({ guardedScore: 0.7, overloadedScore: 0.6 })).toThrow(/strictly ordered/);
    expect(() => new RuntimeOverloadGovernor({ recoveryScore: 0.5, guardedScore: 0.4 })).toThrow(/strictly ordered/);
  });

  it('rejects invalid latency and error threshold ranges', () => {
    expect(() => new RuntimeOverloadGovernor({ targetLatencyMs: 500, maxLatencyMs: 500 })).toThrow(/latency thresholds/);
    expect(() => new RuntimeOverloadGovernor({ targetErrorRate: 0.2, maxErrorRate: 0.1 })).toThrow(/error thresholds/);
  });

  it('does not expose mutable internal observation state through diagnostics', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    const input = sample(1);
    governor.observe(input);
    const before = governor.diagnostics();
    expect(before.meanErrorRate).toBe(0);
    expect(before.meanQueueUtilization).toBe(0.1);
  });
});
