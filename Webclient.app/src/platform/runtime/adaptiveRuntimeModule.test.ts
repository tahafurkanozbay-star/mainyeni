import { describe, expect, it } from 'vitest';
import type { RuntimeBudget } from './contracts';
import { createResourceBudgetManager } from './resourceBudget';
import { createRuntimeTelemetry } from './privacyTelemetry';
import { createTaskScheduler } from './taskScheduler';
import type { RuntimeKernelModuleContext } from './runtimeKernel';
import { createAdaptiveRuntimeModule } from './adaptiveRuntimeModule';

const budget: RuntimeBudget = Object.freeze({
  tier: 'balanced',
  maxConcurrentNetwork: 4,
  maxConcurrentCpu: 2,
  maxQueuedTasks: 12,
  maxCacheEntries: 100,
  maxCacheBytes: 1_000_000,
  maxVisibleFeatures2d: 2_000,
  maxVisibleFeatures3d: 800,
  maxGpuHeavyLayers: 4,
  frameBudgetMs: 16,
  backgroundSliceMs: 8,
  telemetryCapacity: 100,
});

const context = (runtimeBudget: RuntimeBudget = budget): RuntimeKernelModuleContext => {
  const controller = new AbortController();
  const resourceBudget = createResourceBudgetManager({ budget: runtimeBudget });
  const telemetry = createRuntimeTelemetry({ capacity: 20 });
  const scheduler = createTaskScheduler({ budget: runtimeBudget });
  return {
    signal: controller.signal,
    telemetry,
    scheduler,
    budget: resourceBudget,
    kernel: {} as RuntimeKernelModuleContext['kernel'],
  };
};

describe('adaptiveRuntimeModule', () => {
  it('rejects work before the kernel starts it', async () => {
    const adaptive = createAdaptiveRuntimeModule();
    await expect(adaptive.acquire({ key: 'early' })).rejects.toThrow('not running');
    expect(adaptive.snapshot().phase).toBe('idle');
    adaptive.dispose();
  });

  it('activates from the kernel resource budget', async () => {
    const adaptive = createAdaptiveRuntimeModule();
    const ctx = context();
    await adaptive.module.start?.(ctx);
    const lease = await adaptive.acquire({ key: 'network', lane: 'network' });

    expect(adaptive.snapshot().phase).toBe('running');
    expect(adaptive.snapshot().budget).toEqual(budget);
    expect(adaptive.snapshot().generation).toBe(1);
    expect(adaptive.snapshot().control?.admission.active).toBe(1);

    lease.release();
    adaptive.dispose();
  });

  it('does not recreate control when ready observes the same budget', async () => {
    const adaptive = createAdaptiveRuntimeModule();
    const ctx = context();
    await adaptive.module.start?.(ctx);
    await adaptive.module.ready?.(ctx);
    expect(adaptive.snapshot().generation).toBe(1);
    adaptive.dispose();
  });

  it('cancels background queues while preserving foreground work on suspend', async () => {
    const adaptive = createAdaptiveRuntimeModule({
      admission: { maxActive: 1, maxQueued: 8, maxCost: 1 },
    });
    const ctx = context();
    await adaptive.module.start?.(ctx);
    const active = await adaptive.acquire({ key: 'active', lane: 'foreground' });
    const background = adaptive.acquire({ key: 'background', lane: 'background' });
    const foreground = adaptive.acquire({ key: 'foreground', lane: 'foreground' });

    await adaptive.module.suspend?.(ctx);
    await expect(background).rejects.toMatchObject({ code: 'PLATFORM_ADMISSION_CANCELLED' });
    expect(adaptive.snapshot().phase).toBe('suspended');

    active.release();
    await adaptive.module.resume?.(ctx);
    const foregroundLease = await foreground;
    foregroundLease.release();
    adaptive.dispose();
  });

  it('supports opt-out from suspend queue cancellation', async () => {
    const adaptive = createAdaptiveRuntimeModule({
      admission: { maxActive: 1, maxQueued: 8, maxCost: 1 },
      cancelQueuedOnSuspend: false,
    });
    const ctx = context();
    await adaptive.module.start?.(ctx);
    const active = await adaptive.acquire({ key: 'active' });
    const queued = adaptive.acquire({ key: 'queued', lane: 'background' });

    await adaptive.module.suspend?.(ctx);
    expect(adaptive.snapshot().control?.admission.queued).toBe(1);
    active.release();
    await adaptive.module.resume?.(ctx);
    const queuedLease = await queued;
    queuedLease.release();
    adaptive.dispose();
  });

  it('rebuilds admission control when the kernel budget changes across resume', async () => {
    const adaptive = createAdaptiveRuntimeModule();
    const first = context();
    await adaptive.module.start?.(first);
    await adaptive.module.suspend?.(first);

    const constrained: RuntimeBudget = Object.freeze({
      ...budget,
      tier: 'minimal',
      maxConcurrentNetwork: 2,
      maxConcurrentCpu: 1,
      maxQueuedTasks: 6,
    });
    const second = context(constrained);
    await adaptive.module.resume?.(second);

    expect(adaptive.snapshot().generation).toBe(2);
    expect(adaptive.snapshot().budget?.tier).toBe('minimal');
    adaptive.dispose();
  });

  it('stops deterministically and can be started again by the kernel', async () => {
    const adaptive = createAdaptiveRuntimeModule();
    const ctx = context();
    await adaptive.module.start?.(ctx);
    await adaptive.module.stop?.(ctx);
    expect(adaptive.snapshot().phase).toBe('stopped');
    await expect(adaptive.acquire({ key: 'stopped' })).rejects.toThrow('not running');

    await adaptive.module.start?.(ctx);
    expect(adaptive.snapshot().phase).toBe('running');
    expect(adaptive.snapshot().generation).toBe(2);
    adaptive.dispose();
  });

  it('makes module disposal terminal and idempotent', async () => {
    const adaptive = createAdaptiveRuntimeModule();
    const ctx = context();
    await adaptive.module.start?.(ctx);
    await adaptive.module.dispose?.();
    await adaptive.module.dispose?.();

    expect(adaptive.snapshot().phase).toBe('disposed');
    await expect(adaptive.acquire({ key: 'late' })).rejects.toThrow('disposed');
  });
});
