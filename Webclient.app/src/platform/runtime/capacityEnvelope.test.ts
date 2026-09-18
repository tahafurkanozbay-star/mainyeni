import { describe, expect, it } from 'vitest';
import type { RuntimeBudget } from './contracts';
import {
  compareCapacityPressure,
  createCapacityEnvelopePlanner,
  type CapacityDemand,
} from './capacityEnvelope';

const budget: RuntimeBudget = Object.freeze({
  tier: 'balanced',
  maxConcurrentNetwork: 8,
  maxConcurrentCpu: 4,
  maxQueuedTasks: 100,
  maxCacheEntries: 200,
  maxCacheBytes: 32 * 1024 * 1024,
  maxVisibleFeatures2d: 12_000,
  maxVisibleFeatures3d: 4_000,
  maxGpuHeavyLayers: 4,
  frameBudgetMs: 12,
  backgroundSliceMs: 8,
  telemetryCapacity: 600,
});

const demand = (overrides: Partial<CapacityDemand> = {}): CapacityDemand => ({
  queueDepth: 0,
  queueCapacity: 100,
  active: 0,
  activeCapacity: 12,
  activeCost: 0,
  costCapacity: 16,
  online: true,
  saveData: false,
  reducedMotion: false,
  ...overrides,
});

describe('capacityEnvelope', () => {
  it('keeps nominal capacity when demand is healthy', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const envelope = planner.plan('nominal', demand());
    expect(envelope.pressure).toBe('nominal');
    expect(envelope.pressureFactor).toBe(1);
    expect(envelope.demandFactor).toBe(1);
    expect(envelope.maxActive).toBe(12);
    expect(envelope.maxQueued).toBe(100);
    expect(envelope.maxCost).toBe(16);
    expect(envelope.reasons).toEqual([]);
  });

  it('contracts capacity monotonically across pressure levels', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const nominal = planner.plan('nominal', demand());
    const elevated = planner.plan('elevated', demand());
    const high = planner.plan('high', demand());
    const critical = planner.plan('critical', demand());

    expect(nominal.maxActive).toBeGreaterThan(elevated.maxActive);
    expect(elevated.maxActive).toBeGreaterThanOrEqual(high.maxActive);
    expect(high.maxActive).toBeGreaterThanOrEqual(critical.maxActive);
    expect(nominal.maxQueued).toBeGreaterThan(elevated.maxQueued);
    expect(elevated.maxQueued).toBeGreaterThan(high.maxQueued);
    expect(high.maxQueued).toBeGreaterThan(critical.maxQueued);
  });

  it('contracts on queue saturation even with nominal pressure classification', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const healthy = planner.plan('nominal', demand());
    const saturated = planner.plan('nominal', demand({ queueDepth: 96 }));
    expect(saturated.demandFactor).toBeLessThan(healthy.demandFactor);
    expect(saturated.maxActive).toBeLessThan(healthy.maxActive);
    expect(saturated.maxQueued).toBeLessThan(healthy.maxQueued);
    expect(saturated.reasons).toContain('queue');
  });

  it('contracts on active concurrency saturation', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const envelope = planner.plan('nominal', demand({ active: 12 }));
    expect(envelope.demandFactor).toBeLessThan(1);
    expect(envelope.reasons).toContain('active');
  });

  it('contracts on weighted cost saturation', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const envelope = planner.plan('nominal', demand({ activeCost: 16 }));
    expect(envelope.demandFactor).toBeLessThan(1);
    expect(envelope.reasons).toContain('cost');
  });

  it('uses the most restrictive demand signal rather than averaging overload away', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const queueOnly = planner.plan('nominal', demand({ queueDepth: 99 }));
    const mixed = planner.plan('nominal', demand({ queueDepth: 99, active: 1, activeCost: 1 }));
    expect(mixed.demandFactor).toBe(queueOnly.demandFactor);
  });

  it('disables background lanes during critical pressure', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const envelope = planner.plan('critical', demand());
    expect(envelope.lanes.background.enabled).toBe(false);
    expect(envelope.lanes.prefetch.enabled).toBe(false);
    expect(envelope.lanes.maintenance.enabled).toBe(false);
    expect(envelope.lanes.interactive.enabled).toBe(true);
    expect(envelope.lanes.foreground.enabled).toBe(true);
    expect(envelope.lanes.default.enabled).toBe(true);
  });

  it('does not expose disabled lanes through admission lane limits', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const envelope = planner.plan('critical', demand());
    expect(envelope.admission.laneMaxActive?.background).toBeUndefined();
    expect(envelope.admission.laneMaxActive?.prefetch).toBeUndefined();
    expect(envelope.admission.laneMaxQueued?.maintenance).toBeUndefined();
    expect(envelope.admission.laneMaxActive?.interactive).toBeGreaterThan(0);
  });

  it('reserves active foreground capacity away from background work', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const envelope = planner.plan('nominal', demand());
    expect(envelope.lanes.interactive.reservedActive).toBeGreaterThan(0);
    expect(envelope.lanes.foreground.reservedActive).toBeGreaterThan(0);
    expect(envelope.lanes.background.reservedActive).toBe(0);
    expect(envelope.lanes.prefetch.reservedActive).toBe(0);
  });

  it('assigns deterministic lane priority biases', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const lanes = planner.plan('nominal', demand()).lanes;
    expect(lanes.interactive.priorityBias).toBeLessThan(lanes.foreground.priorityBias);
    expect(lanes.foreground.priorityBias).toBeLessThan(lanes.default.priorityBias);
    expect(lanes.default.priorityBias).toBeLessThan(lanes.background.priorityBias);
    expect(lanes.maintenance.priorityBias).toBeGreaterThan(lanes.background.priorityBias);
  });

  it('disables prefetch while offline without suppressing interactive work', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const envelope = planner.plan('nominal', demand({ online: false }));
    expect(envelope.lanes.prefetch.enabled).toBe(false);
    expect(envelope.lanes.interactive.enabled).toBe(true);
    expect(envelope.reasons).toContain('offline');
    expect(envelope.effectiveFactor).toBeLessThanOrEqual(0.3);
  });

  it('disables prefetch under save-data and reduces cache/network budget', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const baseline = planner.plan('nominal', demand());
    const constrained = planner.plan('nominal', demand({ saveData: true }));
    expect(constrained.lanes.prefetch.enabled).toBe(false);
    expect(constrained.derivedBudget.maxConcurrentNetwork)
      .toBeLessThanOrEqual(baseline.derivedBudget.maxConcurrentNetwork);
    expect(constrained.derivedBudget.maxCacheBytes)
      .toBeLessThan(baseline.derivedBudget.maxCacheBytes);
    expect(constrained.reasons).toContain('save-data');
  });

  it('reduces render-heavy budgets for reduced-motion users', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const baseline = planner.plan('nominal', demand());
    const reduced = planner.plan('nominal', demand({ reducedMotion: true }));
    expect(reduced.derivedBudget.maxVisibleFeatures2d)
      .toBeLessThan(baseline.derivedBudget.maxVisibleFeatures2d);
    expect(reduced.derivedBudget.maxVisibleFeatures3d)
      .toBeLessThan(baseline.derivedBudget.maxVisibleFeatures3d);
    expect(reduced.derivedBudget.maxGpuHeavyLayers)
      .toBeLessThanOrEqual(baseline.derivedBudget.maxGpuHeavyLayers);
    expect(reduced.reasons).toContain('reduced-motion');
  });

  it('keeps hard minimums under extreme pressure', () => {
    const planner = createCapacityEnvelopePlanner(budget, {
      minimumActive: 3,
      minimumQueued: 12,
      minimumCost: 5,
    });
    const envelope = planner.plan('critical', demand({
      queueDepth: 1000,
      queueCapacity: 100,
      active: 100,
      activeCapacity: 12,
      activeCost: 100,
      costCapacity: 16,
      online: false,
    }));
    expect(envelope.maxActive).toBeGreaterThanOrEqual(3);
    expect(envelope.maxQueued).toBeGreaterThanOrEqual(12);
    expect(envelope.maxCost).toBeGreaterThanOrEqual(5);
  });

  it('normalizes zero and non-finite demand capacities fail-safe', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const envelope = planner.plan('nominal', demand({
      queueDepth: Number.NaN,
      queueCapacity: 0,
      active: Number.POSITIVE_INFINITY,
      activeCapacity: 0,
      activeCost: Number.NaN,
      costCapacity: 0,
    }));
    expect(Number.isFinite(envelope.demandFactor)).toBe(true);
    expect(Number.isFinite(envelope.effectiveFactor)).toBe(true);
    expect(envelope.maxActive).toBeGreaterThan(0);
  });

  it('normalizes invalid policy factors into bounded safe values', () => {
    const planner = createCapacityEnvelopePlanner(budget, {
      policy: {
        nominalFactor: 5,
        elevatedFactor: Number.NaN,
        highFactor: -2,
        criticalFactor: 0,
      },
    });
    expect(planner.plan('nominal', demand()).pressureFactor).toBe(1);
    expect(planner.plan('elevated', demand()).pressureFactor).toBeGreaterThanOrEqual(0.2);
    expect(planner.plan('high', demand()).pressureFactor).toBeGreaterThanOrEqual(0.2);
    expect(planner.plan('critical', demand()).pressureFactor).toBeGreaterThanOrEqual(0.2);
  });

  it('normalizes lane weights while preserving all lanes', () => {
    const planner = createCapacityEnvelopePlanner(budget, {
      policy: {
        laneWeights: {
          interactive: 100,
          foreground: 0,
          default: 0,
          background: 0,
          prefetch: 0,
          maintenance: 0,
        },
      },
    });
    const envelope = planner.plan('nominal', demand());
    expect(envelope.lanes.interactive.maxActive).toBeGreaterThanOrEqual(
      envelope.lanes.background.maxActive,
    );
    expect(Object.keys(envelope.lanes)).toHaveLength(6);
  });

  it('returns frozen envelopes and nested policies', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const envelope = planner.plan('high', demand());
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.lanes)).toBe(true);
    expect(Object.isFrozen(envelope.lanes.interactive)).toBe(true);
    expect(Object.isFrozen(envelope.admission)).toBe(true);
    expect(Object.isFrozen(envelope.derivedBudget)).toBe(true);
    expect(Object.isFrozen(envelope.reasons)).toBe(true);
  });

  it('snapshot returns the latest planned envelope', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const high = planner.plan('high', demand({ queueDepth: 80 }));
    expect(planner.snapshot()).toBe(high);
  });

  it('reset restores a healthy nominal envelope', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    planner.plan('critical', demand({ queueDepth: 100, active: 12, activeCost: 16 }));
    const reset = planner.reset();
    expect(reset.pressure).toBe('nominal');
    expect(reset.pressureFactor).toBe(1);
    expect(reset.demandFactor).toBe(1);
    expect(reset.reasons).toEqual([]);
  });

  it('maps queue-age policy into admission policy', () => {
    const planner = createCapacityEnvelopePlanner(budget, {
      policy: { queueAgeMs: 12_345 },
    });
    const envelope = planner.plan('nominal', demand());
    expect(envelope.maxQueueAgeMs).toBe(12_345);
    expect(envelope.admission.maxQueueAgeMs).toBe(12_345);
  });

  it('supports custom queue thresholds for latency-sensitive deployments', () => {
    const strict = createCapacityEnvelopePlanner(budget, {
      policy: { queueSoftLimit: 0.2, queueHardLimit: 0.4 },
    });
    const normal = createCapacityEnvelopePlanner(budget);
    const input = demand({ queueDepth: 35 });
    expect(strict.plan('nominal', input).demandFactor)
      .toBeLessThan(normal.plan('nominal', input).demandFactor);
  });

  it('supports custom lane queue distribution without exceeding global queue capacity', () => {
    const planner = createCapacityEnvelopePlanner(budget, {
      policy: {
        laneQueueWeights: {
          interactive: 10,
          foreground: 10,
          default: 10,
          background: 1,
          prefetch: 1,
          maintenance: 1,
        },
      },
    });
    const envelope = planner.plan('nominal', demand());
    const laneQueuedTotal = Object.values(envelope.lanes)
      .reduce((sum, lane) => sum + lane.maxQueued, 0);
    expect(laneQueuedTotal).toBeGreaterThanOrEqual(envelope.maxQueued);
    expect(envelope.lanes.interactive.maxQueued).toBeGreaterThan(envelope.lanes.prefetch.maxQueued);
  });

  it('preserves base frame budget while contracting work volume', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const critical = planner.plan('critical', demand());
    expect(critical.derivedBudget.frameBudgetMs).toBe(budget.frameBudgetMs);
    expect(critical.derivedBudget.maxVisibleFeatures2d).toBeLessThan(budget.maxVisibleFeatures2d);
  });

  it('keeps telemetry bounded but available under critical pressure', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const critical = planner.plan('critical', demand());
    expect(critical.derivedBudget.telemetryCapacity).toBeGreaterThanOrEqual(50);
    expect(critical.derivedBudget.telemetryCapacity).toBeLessThan(budget.telemetryCapacity);
  });

  it('ranks pressure levels deterministically', () => {
    expect(compareCapacityPressure('nominal', 'elevated')).toBeLessThan(0);
    expect(compareCapacityPressure('elevated', 'high')).toBeLessThan(0);
    expect(compareCapacityPressure('high', 'critical')).toBeLessThan(0);
    expect(compareCapacityPressure('critical', 'critical')).toBe(0);
  });

  it('does not mutate the source runtime budget', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const before = { ...budget };
    planner.plan('critical', demand({ saveData: true, reducedMotion: true }));
    expect(budget).toEqual(before);
  });

  it('keeps admission max values aligned with the envelope', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const envelope = planner.plan('elevated', demand({ queueDepth: 50 }));
    expect(envelope.admission.maxActive).toBe(envelope.maxActive);
    expect(envelope.admission.maxQueued).toBe(envelope.maxQueued);
    expect(envelope.admission.maxCost).toBe(envelope.maxCost);
  });

  it('provides deterministic repeated plans for the same input', () => {
    const planner = createCapacityEnvelopePlanner(budget);
    const input = demand({ queueDepth: 50, active: 5, activeCost: 7 });
    const first = planner.plan('high', input);
    const second = planner.plan('high', input);
    expect(second).toEqual(first);
  });
});
