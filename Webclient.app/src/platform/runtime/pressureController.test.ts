import { describe, expect, it } from 'vitest';
import type { ResourceBudgetSnapshot, RuntimeBudget } from './contracts';
import { createRuntimePressureController, type RuntimePressureSample } from './pressureController';

const budget: RuntimeBudget = Object.freeze({
  tier: 'enhanced',
  maxConcurrentNetwork: 10,
  maxConcurrentCpu: 4,
  maxQueuedTasks: 320,
  maxCacheEntries: 320,
  maxCacheBytes: 64 * 1024 * 1024,
  maxVisibleFeatures2d: 20_000,
  maxVisibleFeatures3d: 7_000,
  maxGpuHeavyLayers: 4,
  frameBudgetMs: 14,
  backgroundSliceMs: 8,
  telemetryCapacity: 1_000,
});

const resourceSnapshot = (
  used: Partial<ResourceBudgetSnapshot['used']> = {},
): ResourceBudgetSnapshot => {
  const normalized = {
    network: used.network ?? 0,
    cpu: used.cpu ?? 0,
    memory: used.memory ?? 0,
    render: used.render ?? 0,
    storage: used.storage ?? 0,
  };
  return Object.freeze({
    budget,
    used: Object.freeze(normalized),
    available: Object.freeze({
      network: Math.max(0, budget.maxConcurrentNetwork - normalized.network),
      cpu: Math.max(0, budget.maxConcurrentCpu - normalized.cpu),
      memory: Math.max(0, budget.maxCacheBytes - normalized.memory),
      render: Math.max(0, budget.maxGpuHeavyLayers - normalized.render),
      storage: Math.max(0, budget.maxCacheEntries - normalized.storage),
    }),
    reservationCount: 0,
    rejectedReservations: 0,
  });
};

const sample = (overrides: Partial<RuntimePressureSample> = {}): RuntimePressureSample => ({
  at: 1_000,
  queueDepth: 0,
  queueCapacity: 100,
  p95LatencyMs: 40,
  targetLatencyMs: 200,
  failureRate: 0,
  frameTimeMs: 8,
  frameBudgetMs: 16,
  resourceSnapshot: resourceSnapshot(),
  ...overrides,
});

describe('createRuntimePressureController', () => {
  it('starts nominal with the original runtime budget', () => {
    const controller = createRuntimePressureController(budget);
    expect(controller.snapshot()).toMatchObject({
      level: 'nominal',
      score: 0,
      changed: false,
      recoveryStreak: 0,
      budget,
    });
    expect(controller.history()).toEqual([]);
  });

  it('keeps healthy observations nominal', () => {
    const controller = createRuntimePressureController(budget);
    const decision = controller.record(sample());
    expect(decision.level).toBe('nominal');
    expect(decision.changed).toBe(false);
    expect(decision.reasons).toEqual([]);
    expect(decision.budget).toEqual(budget);
  });

  it('escalates immediately when multiple pressure signals become critical', () => {
    const controller = createRuntimePressureController(budget);
    const decision = controller.record(sample({
      queueDepth: 100,
      p95LatencyMs: 400,
      failureRate: 1,
      frameTimeMs: 40,
      resourceSnapshot: resourceSnapshot({
        network: 10,
        cpu: 4,
        memory: budget.maxCacheBytes,
        render: 4,
        storage: 320,
      }),
    }));
    expect(decision.level).toBe('critical');
    expect(decision.changed).toBe(true);
    expect(decision.previousLevel).toBe('nominal');
    expect(decision.reasons).toEqual(['queue', 'latency', 'failures', 'frame', 'resources']);
  });

  it('constrains expensive capacity at critical pressure while retaining progress floors', () => {
    const controller = createRuntimePressureController(budget);
    const decision = controller.record(sample({
      queueDepth: 100,
      p95LatencyMs: 500,
      failureRate: 1,
      frameTimeMs: 50,
      resourceSnapshot: resourceSnapshot({ network: 10, cpu: 4, render: 4 }),
    }));
    expect(decision.level).toBe('critical');
    expect(decision.budget.maxConcurrentNetwork).toBe(4);
    expect(decision.budget.maxConcurrentCpu).toBe(1);
    expect(decision.budget.maxQueuedTasks).toBe(128);
    expect(decision.budget.maxVisibleFeatures2d).toBe(8_000);
    expect(decision.budget.maxVisibleFeatures3d).toBe(2_800);
    expect(decision.budget.maxGpuHeavyLayers).toBe(1);
    expect(decision.budget.backgroundSliceMs).toBe(3);
    expect(decision.budget.maxCacheEntries).toBe(budget.maxCacheEntries);
    expect(decision.budget.maxCacheBytes).toBe(budget.maxCacheBytes);
  });

  it('records individual reasons independently from the aggregate level', () => {
    const controller = createRuntimePressureController(budget);
    const decision = controller.record(sample({
      queueDepth: 85,
      p95LatencyMs: 50,
      failureRate: 0,
      frameTimeMs: 8,
    }));
    expect(decision.reasons).toContain('queue');
    expect(decision.reasons).not.toContain('latency');
    expect(decision.reasons).not.toContain('failures');
    expect(decision.reasons).not.toContain('frame');
  });

  it('does not treat missing frame telemetry as frame pressure', () => {
    const controller = createRuntimePressureController(budget);
    const decision = controller.record(sample({ frameTimeMs: null }));
    expect(decision.reasons).not.toContain('frame');
    expect(Number.isFinite(decision.score)).toBe(true);
  });

  it('clamps malformed negative observations instead of producing negative pressure', () => {
    const controller = createRuntimePressureController(budget);
    const decision = controller.record(sample({
      queueDepth: -100,
      queueCapacity: 100,
      p95LatencyMs: -10,
      targetLatencyMs: 200,
      failureRate: -1,
      frameTimeMs: -20,
    }));
    expect(decision.score).toBeGreaterThanOrEqual(0);
    expect(decision.level).toBe('nominal');
  });

  it('handles zero capacities without division by zero', () => {
    const controller = createRuntimePressureController(budget);
    const decision = controller.record(sample({
      queueDepth: 10,
      queueCapacity: 0,
      p95LatencyMs: 300,
      targetLatencyMs: 0,
      frameTimeMs: 30,
      frameBudgetMs: 0,
    }));
    expect(Number.isFinite(decision.score)).toBe(true);
    expect(decision.score).toBeGreaterThanOrEqual(0);
    expect(decision.score).toBeLessThanOrEqual(1);
  });

  it('requires consecutive healthy samples before recovering one level', () => {
    const controller = createRuntimePressureController(budget, { recoverySamples: 3 });
    controller.record(sample({
      queueDepth: 100,
      p95LatencyMs: 500,
      failureRate: 1,
      frameTimeMs: 50,
      resourceSnapshot: resourceSnapshot({ network: 10, cpu: 4, render: 4 }),
    }));
    const first = controller.record(sample());
    const second = controller.record(sample());
    const third = controller.record(sample());
    expect(first.level).toBe('critical');
    expect(first.recoveryStreak).toBe(1);
    expect(second.level).toBe('critical');
    expect(second.recoveryStreak).toBe(2);
    expect(third.level).toBe('high');
    expect(third.recoveryStreak).toBe(0);
    expect(third.changed).toBe(true);
  });

  it('recovers only one level per hysteresis window', () => {
    const controller = createRuntimePressureController(budget, { recoverySamples: 2 });
    controller.record(sample({
      queueDepth: 100,
      p95LatencyMs: 500,
      failureRate: 1,
      frameTimeMs: 50,
      resourceSnapshot: resourceSnapshot({ network: 10, cpu: 4, render: 4 }),
    }));
    controller.record(sample());
    expect(controller.record(sample()).level).toBe('high');
    controller.record(sample());
    expect(controller.record(sample()).level).toBe('elevated');
    controller.record(sample());
    expect(controller.record(sample()).level).toBe('nominal');
  });

  it('resets a recovery streak when pressure rebounds', () => {
    const controller = createRuntimePressureController(budget, { recoverySamples: 3 });
    controller.record(sample({
      queueDepth: 100,
      p95LatencyMs: 500,
      failureRate: 1,
      frameTimeMs: 50,
      resourceSnapshot: resourceSnapshot({ network: 10, cpu: 4, render: 4 }),
    }));
    expect(controller.record(sample()).recoveryStreak).toBe(1);
    const rebound = controller.record(sample({ queueDepth: 70, p95LatencyMs: 250 }));
    expect(rebound.recoveryStreak).toBe(0);
    expect(rebound.level).toBe('critical');
  });

  it('can escalate directly while a recovery streak is in progress', () => {
    const controller = createRuntimePressureController(budget, {
      recoverySamples: 4,
      elevatedThreshold: 0.2,
      highThreshold: 0.4,
      criticalThreshold: 0.7,
    });
    controller.record(sample({ queueDepth: 100, p95LatencyMs: 400 }));
    controller.record(sample());
    const escalated = controller.record(sample({
      queueDepth: 100,
      p95LatencyMs: 500,
      failureRate: 1,
      frameTimeMs: 50,
      resourceSnapshot: resourceSnapshot({ network: 10, cpu: 4, render: 4 }),
    }));
    expect(escalated.level).toBe('critical');
    expect(escalated.recoveryStreak).toBe(0);
  });

  it('honors custom signal weights', () => {
    const controller = createRuntimePressureController(budget, {
      elevatedThreshold: 0.5,
      weights: { queue: 1, latency: 0, failures: 0, frame: 0, resources: 0 },
    });
    expect(controller.record(sample({ queueDepth: 60 })).level).toBe('elevated');
    expect(controller.record(sample({ queueDepth: 10, p95LatencyMs: 1_000, failureRate: 1 })).score).toBeCloseTo(0.1);
  });

  it('bounds decision history to configured sample capacity', () => {
    const controller = createRuntimePressureController(budget, { sampleCapacity: 3 });
    for (let index = 0; index < 8; index += 1) {
      controller.record(sample({ at: 1_000 + index, queueDepth: index * 5 }));
    }
    expect(controller.history()).toHaveLength(3);
    expect(controller.snapshot()).toBe(controller.history()[2]);
  });

  it('returns a defensive frozen history snapshot', () => {
    const controller = createRuntimePressureController(budget);
    controller.record(sample());
    const history = controller.history();
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
  });

  it('reset clears history and restores the original nominal budget', () => {
    const controller = createRuntimePressureController(budget);
    controller.record(sample({
      queueDepth: 100,
      p95LatencyMs: 500,
      failureRate: 1,
      frameTimeMs: 50,
      resourceSnapshot: resourceSnapshot({ network: 10, cpu: 4, render: 4 }),
    }));
    controller.reset();
    expect(controller.history()).toEqual([]);
    expect(controller.snapshot()).toMatchObject({
      level: 'nominal',
      score: 0,
      recoveryStreak: 0,
      budget,
    });
  });
});
