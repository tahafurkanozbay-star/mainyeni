import { describe, expect, it } from 'vitest';
import { createRuntimeHealthPolicyEngine } from './runtimeHealthPolicy';
import type { RuntimeHealthEvent, RuntimeHealthSummary } from './runtimeHealthJournal';

const summary = (overrides: Partial<RuntimeHealthSummary> = {}): RuntimeHealthSummary => ({
  total: 20, retained: 20, dropped: 0, pruned: 0, failures: 0, failureRate: 0,
  p50LatencyMs: 100, p95LatencyMs: 200, p99LatencyMs: 300, lastEventAt: 1,
  bySeverity: { debug: 0, info: 20, warning: 0, error: 0, critical: 0 },
  byKind: { admission: 0, pressure: 0, lifecycle: 20, resource: 0, latency: 0, failure: 0, recovery: 0 },
  ...overrides,
});
const event = (severity: RuntimeHealthEvent['severity']): RuntimeHealthEvent => ({ at: 5, kind: 'failure', severity, code: 'sample' });

describe('runtimeHealthPolicy', () => {
  it('keeps healthy summaries healthy', () => {
    const engine = createRuntimeHealthPolicyEngine();
    const result = engine.assess(summary(), 10);
    expect(result.current).toBe('healthy');
    expect(result.assessment.score).toBeGreaterThan(90);
  });

  it('classifies failure-rate thresholds deterministically', () => {
    const engine = createRuntimeHealthPolicyEngine();
    expect(engine.assess(summary({ failureRate: 0.06 })).current).toBe('degraded');
    expect(engine.assess(summary({ failureRate: 0.2 })).current).toBe('unhealthy');
    expect(engine.assess(summary({ failureRate: 0.5 })).current).toBe('critical');
  });

  it('classifies p95 latency thresholds independently', () => {
    const engine = createRuntimeHealthPolicyEngine();
    expect(engine.assess(summary({ p95LatencyMs: 2_000 })).current).toBe('degraded');
    expect(engine.assess(summary({ p95LatencyMs: 5_000 })).current).toBe('unhealthy');
    expect(engine.assess(summary({ p95LatencyMs: 11_000 })).current).toBe('critical');
  });

  it('uses event severity as a floor before enough samples exist', () => {
    const engine = createRuntimeHealthPolicyEngine({ minimumSamples: 10 });
    const result = engine.observe(event('error'), summary({ retained: 2, total: 2 }));
    expect(result.current).toBe('unhealthy');
    expect(result.assessment.reasons).toContain('event-severity');
  });

  it('requires consecutive healthy samples before recovery', () => {
    const engine = createRuntimeHealthPolicyEngine({ recoverySamples: 2 });
    expect(engine.assess(summary({ failureRate: 0.4 })).current).toBe('critical');
    expect(engine.assess(summary()).current).toBe('critical');
    expect(engine.assess(summary()).current).toBe('healthy');
  });

  it('does not delay deterioration while recovery hysteresis is active', () => {
    const engine = createRuntimeHealthPolicyEngine({ recoverySamples: 3 });
    expect(engine.assess(summary({ failureRate: 0.2 })).current).toBe('unhealthy');
    expect(engine.assess(summary()).current).toBe('unhealthy');
    expect(engine.assess(summary({ failureRate: 0.5 })).current).toBe('critical');
  });

  it('normalizes inverted policy thresholds into monotonic bands', () => {
    const engine = createRuntimeHealthPolicyEngine({
      degradedFailureRate: 0.3, unhealthyFailureRate: 0.1, criticalFailureRate: 0.2,
      degradedP95LatencyMs: 5_000, unhealthyP95LatencyMs: 1_000, criticalP95LatencyMs: 2_000,
    });
    expect(engine.assess(summary({ failureRate: 0.31, p95LatencyMs: 5_100 })).current).toBe('critical');
  });

  it('bounds reasons and score', () => {
    const engine = createRuntimeHealthPolicyEngine({ maxReasons: 1 });
    const result = engine.assess(summary({ failureRate: 1, p95LatencyMs: 100_000 }));
    expect(result.assessment.reasons).toHaveLength(1);
    expect(result.assessment.score).toBeGreaterThanOrEqual(0);
  });

  it('reset returns the engine to a clean healthy snapshot', () => {
    const engine = createRuntimeHealthPolicyEngine({}, () => 42);
    engine.assess(summary({ failureRate: 1 }));
    engine.reset();
    expect(engine.snapshot()).toMatchObject({ state: 'healthy', score: 100, assessedAt: 42 });
  });

  it('rejects operations after disposal', () => {
    const engine = createRuntimeHealthPolicyEngine();
    engine.dispose();
    expect(() => engine.assess(summary())).toThrow('disposed');
    expect(() => engine.snapshot()).toThrow('disposed');
  });
});
