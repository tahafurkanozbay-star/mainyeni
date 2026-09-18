import { describe, expect, it } from 'vitest';
import type { ResourceBudgetSnapshot, RuntimeBudget } from './contracts';
import { createAdaptiveRuntimeControl } from './adaptiveRuntimeControl';

const budget: RuntimeBudget = Object.freeze({
  tier: 'balanced',
  maxConcurrentNetwork: 4,
  maxConcurrentCpu: 2,
  maxQueuedTasks: 16,
  maxCacheEntries: 100,
  maxCacheBytes: 1_000_000,
  maxVisibleFeatures2d: 2_000,
  maxVisibleFeatures3d: 800,
  maxGpuHeavyLayers: 4,
  frameBudgetMs: 16,
  backgroundSliceMs: 8,
  telemetryCapacity: 100,
});

const resources = (used = 0): ResourceBudgetSnapshot => Object.freeze({
  budget,
  used: Object.freeze({ network: used, cpu: used, memory: used, render: used, storage: used }),
  available: Object.freeze({ network: 4, cpu: 2, memory: 100, render: 4, storage: 100 }),
  reservationCount: 0,
  rejectedReservations: 0,
  expiredReservations: 0,
});

const sample = (overrides: Partial<Parameters<ReturnType<typeof createAdaptiveRuntimeControl>['record']>[0]> = {}) => ({
  at: 1,
  p95LatencyMs: 100,
  targetLatencyMs: 200,
  failureRate: 0,
  frameTimeMs: 8,
  frameBudgetMs: 16,
  resourceSnapshot: resources(),
  ...overrides,
});

describe('adaptiveRuntimeControl', () => {
  it('derives admission limits from the runtime budget', async () => {
    const control = createAdaptiveRuntimeControl({ budget });
    const leases = await Promise.all([
      control.acquire({ key: 'n1', lane: 'network' }),
      control.acquire({ key: 'n2', lane: 'network' }),
      control.acquire({ key: 'c1', lane: 'cpu', cost: 2 }),
    ]);

    expect(control.snapshot().admission.active).toBe(3);
    expect(control.snapshot().effectiveBudget).toEqual(budget);
    leases.forEach((lease) => lease.release());
    expect(control.snapshot().admission.completed).toBe(3);
    control.dispose();
  });

  it('feeds live queue pressure into the pressure decision', async () => {
    const control = createAdaptiveRuntimeControl({
      budget,
      admission: { maxActive: 1, maxQueued: 4, maxCost: 1 },
      pressure: { elevatedThreshold: 0.2, highThreshold: 0.45, criticalThreshold: 0.7 },
    });
    const active = await control.acquire({ key: 'active' });
    const queued = control.acquire({ key: 'queued' });
    const decision = control.record(sample({ p95LatencyMs: 300, failureRate: 0.2 })).pressure;

    expect(decision.level).not.toBe('nominal');
    expect(decision.reasons).toContain('latency');
    expect(control.snapshot().admission.queued).toBe(1);
    active.release();
    const queuedLease = await queued;
    queuedLease.release();
    control.dispose();
  });

  it('constrains the effective budget under critical pressure', () => {
    const control = createAdaptiveRuntimeControl({ budget });
    const result = control.record(sample({
      p95LatencyMs: 10_000,
      failureRate: 1,
      frameTimeMs: 100,
      resourceSnapshot: resources(100),
    }));

    expect(result.pressure.level).toBe('critical');
    expect(result.effectiveBudget.maxConcurrentNetwork).toBeLessThan(budget.maxConcurrentNetwork);
    expect(result.effectiveBudget.maxVisibleFeatures2d).toBeLessThan(budget.maxVisibleFeatures2d);
    control.dispose();
  });

  it('supports selective cancellation without disturbing active leases', async () => {
    const control = createAdaptiveRuntimeControl({ budget, admission: { maxActive: 1, maxQueued: 8, maxCost: 1 } });
    const active = await control.acquire({ key: 'active', lane: 'foreground' });
    const background = control.acquire({ key: 'background', lane: 'background' });
    const foreground = control.acquire({ key: 'foreground', lane: 'foreground' });

    expect(control.cancelQueued((request) => request.lane === 'background')).toBe(1);
    await expect(background).rejects.toMatchObject({ code: 'PLATFORM_ADMISSION_CANCELLED' });
    expect(control.snapshot().admission.active).toBe(1);
    active.release();
    const foregroundLease = await foreground;
    foregroundLease.release();
    control.dispose();
  });

  it('rejects new work after deterministic disposal', async () => {
    const control = createAdaptiveRuntimeControl({ budget });
    control.dispose();
    await expect(control.acquire({ key: 'late' })).rejects.toThrow('disposed');
    expect(() => control.record(sample())).toThrow('disposed');
  });
});
