import { describe, expect, it } from 'vitest';
import { RuntimeOverloadGovernor, type OverloadLane } from './runtimeOverloadGovernor';
import { RuntimeResourceBudget } from './runtimeResourceBudget';
import { RuntimeSloTracker } from './runtimeSloTracker';

const MB = 1024 * 1024;

function pressure(governor: RuntimeOverloadGovernor, at: number): void {
  governor.observe({ at, latencyMs: 2_000, errorRate: 0.3, queueUtilization: 1, concurrencyUtilization: 1 });
}

function healthy(governor: RuntimeOverloadGovernor, at: number): void {
  governor.observe({ at, latencyMs: 100, errorRate: 0, queueUtilization: 0.1, concurrencyUtilization: 0.1 });
}

describe('runtime resilience primitive composition', () => {
  it('preserves critical admission during emergency while resource ownership stays bounded', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    const resources = new RuntimeResourceBudget({
      maxBytes: 10 * MB,
      maxItemBytes: 5 * MB,
      criticalReservedBytes: 2 * MB,
      interactiveReservedBytes: 2 * MB,
    });
    pressure(governor, 1);
    expect(governor.admit('critical').admitted).toBe(true);
    expect(governor.admit('interactive').admitted).toBe(false);
    expect(resources.acquire('critical-map-state', 'critical', 2 * MB).admitted).toBe(true);
    expect(resources.snapshot()).toMatchObject({ items: 1, bytes: 2 * MB });
  });

  it('keeps overload admission independent from byte accounting side effects', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    const resources = new RuntimeResourceBudget({ maxBytes: 4 * MB, maxItemBytes: 4 * MB, criticalReservedBytes: 0, interactiveReservedBytes: 0 });
    healthy(governor, 1);
    expect(governor.admit('background').admitted).toBe(true);
    expect(resources.acquire('large-background', 'background', 4 * MB).admitted).toBe(true);
    expect(resources.acquire('another-background', 'background', 1)).toMatchObject({ admitted: false, reason: 'global-capacity' });
    expect(governor.admit('background').admitted).toBe(true);
  });

  it('allows caller policy to require both overload and resource admission', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1, windowSize: 1 });
    const resources = new RuntimeResourceBudget({ maxBytes: 5 * MB, maxItemBytes: 5 * MB, criticalReservedBytes: MB, interactiveReservedBytes: MB });
    const admit = (key: string, lane: OverloadLane, bytes: number): boolean => {
      if (!governor.admit(lane).admitted) return false;
      return resources.acquire(key, lane, bytes).admitted;
    };
    healthy(governor, 1);
    expect(admit('background-a', 'background', 3 * MB)).toBe(true);
    expect(admit('background-b', 'background', 1)).toBe(false);
    pressure(governor, 2);
    expect(admit('interactive-a', 'interactive', 1)).toBe(false);
    expect(admit('critical-a', 'critical', 2 * MB)).toBe(true);
  });

  it('feeds completion evidence into SLO tracking without coupling it to admission', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    const slo = new RuntimeSloTracker({ minimumSamples: 2, targetSuccessRate: 0.5, burnWarning: 1, burnCritical: 2 });
    healthy(governor, 1);
    expect(governor.admit('interactive').admitted).toBe(true);
    slo.observe({ at: 1, lane: 'interactive', latencyMs: 100, success: true });
    slo.observe({ at: 2, lane: 'interactive', latencyMs: 100, success: true });
    expect(slo.snapshot().lanes.interactive.status).toBe('healthy');
    expect(governor.diagnostics().sampleCount).toBe(1);
  });

  it('reports SLO exhaustion while overload can remain normal when evidence differs', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    const slo = new RuntimeSloTracker({ minimumSamples: 2, targetSuccessRate: 0.5, burnWarning: 1, burnCritical: 2 });
    healthy(governor, 1);
    slo.observe({ at: 1, lane: 'interactive', latencyMs: 100, success: false });
    slo.observe({ at: 2, lane: 'interactive', latencyMs: 100, success: false });
    expect(governor.diagnostics().level).toBe('normal');
    expect(slo.snapshot().lanes.interactive.status).toBe('exhausted');
  });

  it('reports overload emergency while historical SLO evidence can remain healthy', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    const slo = new RuntimeSloTracker({ minimumSamples: 2, targetSuccessRate: 0.5, burnWarning: 1, burnCritical: 2 });
    slo.observe({ at: 1, lane: 'critical', latencyMs: 100, success: true });
    slo.observe({ at: 2, lane: 'critical', latencyMs: 100, success: true });
    pressure(governor, 3);
    expect(governor.diagnostics().level).toBe('emergency');
    expect(slo.snapshot().lanes.critical.status).toBe('healthy');
  });

  it('releases resource leases independently of overload recovery', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1, windowSize: 1, recoverySamples: 1, cooldownMs: 0 });
    const resources = new RuntimeResourceBudget({ maxBytes: 4 * MB, maxItemBytes: 4 * MB, criticalReservedBytes: 0, interactiveReservedBytes: 0 });
    const lease = resources.acquire('critical-a', 'critical', 4 * MB).lease;
    pressure(governor, 1);
    lease?.release();
    expect(resources.snapshot().bytes).toBe(0);
    expect(governor.diagnostics().level).toBe('emergency');
    healthy(governor, 2);
    expect(governor.diagnostics().level).toBe('overloaded');
  });

  it('reset boundaries remain local to each primitive', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    const resources = new RuntimeResourceBudget({ maxBytes: 4 * MB, maxItemBytes: 4 * MB });
    const slo = new RuntimeSloTracker({ minimumSamples: 1 });
    pressure(governor, 1);
    resources.acquire('a', 'critical', MB);
    slo.observe({ at: 1, lane: 'critical', latencyMs: 100, success: true });
    resources.reset();
    expect(resources.snapshot().items).toBe(0);
    expect(governor.diagnostics().level).toBe('emergency');
    expect(slo.snapshot().lanes.critical.status).toBe('healthy');
    governor.reset();
    expect(slo.snapshot().totalSamples).toBe(1);
  });

  it('keeps diagnostic histories independently bounded under repeated churn', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1, windowSize: 1, recoverySamples: 1, cooldownMs: 0, historySize: 2 });
    const resources = new RuntimeResourceBudget({ maxBytes: 4 * MB, maxItemBytes: 4 * MB, historySize: 2 });
    const slo = new RuntimeSloTracker({ minimumSamples: 1, windowSize: 1, targetSuccessRate: 0.5, burnWarning: 1, burnCritical: 2, historySize: 2 });
    for (let index = 1; index <= 6; index += 1) {
      if (index % 2 === 0) healthy(governor, index); else pressure(governor, index);
      const lease = resources.acquire(`resource-${index}`, 'critical', 1).lease;
      lease?.release();
      slo.observe({ at: index, lane: 'critical', latencyMs: 100, success: index % 2 === 0 });
    }
    expect(governor.diagnostics().history.length).toBeLessThanOrEqual(2);
    expect(resources.snapshot().history.length).toBeLessThanOrEqual(2);
    expect(slo.snapshot().history.length).toBeLessThanOrEqual(2);
  });

  it('does not introduce timer-driven mutation between explicit calls', () => {
    const governor = new RuntimeOverloadGovernor({ minimumSamples: 1 });
    const resources = new RuntimeResourceBudget({ maxBytes: 4 * MB, maxItemBytes: 4 * MB });
    const slo = new RuntimeSloTracker({ minimumSamples: 1 });
    healthy(governor, 1);
    resources.acquire('a', 'critical', 1);
    slo.observe({ at: 1, lane: 'critical', latencyMs: 100, success: true });
    const before = {
      governor: governor.diagnostics(),
      resources: resources.snapshot(),
      slo: slo.snapshot(),
    };
    const after = {
      governor: governor.diagnostics(),
      resources: resources.snapshot(),
      slo: slo.snapshot(),
    };
    expect(after).toEqual(before);
  });
});
