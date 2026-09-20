import { describe, expect, it, vi } from 'vitest';
import { createViewportBudgetController } from './viewportBudgetController';
import { createViewportQueryExecutionRuntime } from './viewportQueryExecutionRuntime';
import { createViewportTilePlanner } from './viewportTilePlanner';

const extent = Object.freeze({
  xmin: 0,
  ymin: 0,
  xmax: 100,
  ymax: 100,
  spatialReference: 'EPSG:3857',
});

const input = Object.freeze({
  layerId: 'roads',
  extent,
  scale: 10_000,
  pixelWidth: 1000,
  pixelHeight: 1000,
  estimatedFeatureDensity: 0.02,
});

describe('viewportQueryExecutionRuntime', () => {
  it('executes a healthy sparse viewport and commits results', async () => {
    const runtime = createViewportQueryExecutionRuntime<{ name: string }>();
    const executor = vi.fn(async ({ tile }) => ({
      features: [{ id: tile.id, payload: { name: 'road' }, estimatedBytes: 20 }],
      complete: true,
    }));
    const result = await runtime.execute(input, executor);
    expect(result.status).toBe('complete');
    expect(result.features.length).toBeGreaterThan(0);
    expect(executor).toHaveBeenCalledTimes(result.tilePlan.tileCount);
    expect(runtime.snapshot().executionsCompleted).toBe(1);
  });

  it('runs dense viewport tiles through bounded parallel workers', async () => {
    let running = 0;
    let maximumRunning = 0;
    const runtime = createViewportQueryExecutionRuntime({
      maximumConcurrentTiles: 2,
      tilePlanner: createViewportTilePlanner({
        maximumEstimatedFeaturesPerTile: 100,
        maximumTiles: 8,
      }),
    });
    const result = await runtime.execute(
      { ...input, estimatedFeatureDensity: 0.2 },
      async ({ tile }) => {
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        await Promise.resolve();
        running -= 1;
        return { features: [{ id: tile.id, payload: tile.index }] };
      },
    );
    expect(result.tilePlan.tileCount).toBeGreaterThan(1);
    expect(maximumRunning).toBeLessThanOrEqual(2);
  });

  it('reduces effective tile concurrency under critical pressure', async () => {
    let running = 0;
    let maximumRunning = 0;
    const budget = createViewportBudgetController();
    budget.sample({ frameMs: 60, timestamp: 1 });
    const runtime = createViewportQueryExecutionRuntime({
      maximumConcurrentTiles: 4,
      budgetController: budget,
      tilePlanner: createViewportTilePlanner({
        maximumEstimatedFeaturesPerTile: 100,
        maximumTiles: 8,
      }),
    });
    await runtime.execute(
      { ...input, estimatedFeatureDensity: 0.2 },
      async ({ tile }) => {
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        await Promise.resolve();
        running -= 1;
        return { features: [{ id: tile.id, payload: null }] };
      },
    );
    expect(maximumRunning).toBeLessThanOrEqual(1);
  });

  it('suppresses prefetch work entirely at critical pressure', async () => {
    const budget = createViewportBudgetController();
    budget.sample({ gpuPressure: 0.95, timestamp: 1 });
    const runtime = createViewportQueryExecutionRuntime({ budgetController: budget });
    const executor = vi.fn(async () => ({ features: [] }));
    const result = await runtime.execute({ ...input, priority: 'prefetch' }, executor);
    expect(result.status).toBe('skipped');
    expect(executor).not.toHaveBeenCalled();
    expect(result.warnings).toContain('critical-pressure-prefetch-suppressed');
    expect(runtime.snapshot().tileRequestsSkipped).toBe(1);
  });

  it('allows interactive work under critical pressure', async () => {
    const budget = createViewportBudgetController();
    budget.sample({ gpuPressure: 0.95, timestamp: 1 });
    const runtime = createViewportQueryExecutionRuntime({ budgetController: budget });
    const executor = vi.fn(async ({ tile }) => ({
      features: [{ id: tile.id, payload: null }],
    }));
    const result = await runtime.execute({ ...input, priority: 'interactive' }, executor);
    expect(result.status).toBe('complete');
    expect(executor).toHaveBeenCalled();
  });

  it('aborts a superseded layer generation', async () => {
    const runtime = createViewportQueryExecutionRuntime();
    let release!: () => void;
    const firstStarted = new Promise<void>((resolve) => { release = resolve; });
    let firstSignal: AbortSignal | null = null;
    const first = runtime.execute(input, async ({ signal, tile }) => {
      firstSignal = signal;
      await firstStarted;
      if (signal.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return { features: [{ id: tile.id, payload: 'old' }] };
    });
    await Promise.resolve();
    const second = runtime.execute({ ...input, scale: 11_000 }, async ({ tile }) => ({
      features: [{ id: tile.id, payload: 'new' }],
    }));
    release();
    const secondResult = await second;
    const firstResult = await first;
    expect(firstSignal?.aborted).toBe(true);
    expect(['stale', 'cancelled']).toContain(firstResult.status);
    expect(secondResult.status).toBe('complete');
    expect(runtime.readLayer('roads').every((feature) => feature.payload === 'new')).toBe(true);
  });

  it('links caller cancellation to transport work', async () => {
    const runtime = createViewportQueryExecutionRuntime();
    const controller = new AbortController();
    let signal: AbortSignal | null = null;
    const pending = runtime.execute({ ...input, signal: controller.signal }, async (context) => {
      signal = context.signal;
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    });
    await Promise.resolve();
    controller.abort('navigation changed');
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(['cancelled', 'partial']).toContain(result.status);
  });

  it('returns partial results when one tile fails without fail-fast', async () => {
    const runtime = createViewportQueryExecutionRuntime({
      tilePlanner: createViewportTilePlanner({
        maximumEstimatedFeaturesPerTile: 100,
        maximumTiles: 4,
      }),
    });
    const result = await runtime.execute(
      { ...input, estimatedFeatureDensity: 0.1 },
      async ({ tile }) => {
        if (tile.index === 0) throw new Error('service slice failed');
        return { features: [{ id: tile.id, payload: tile.index }] };
      },
    );
    expect(result.status).toBe('partial');
    expect(result.tileResults.some((tile) => tile.status === 'rejected')).toBe(true);
    expect(result.features.length).toBeGreaterThan(0);
    expect(runtime.snapshot().tileRequestsFailed).toBe(1);
  });

  it('stops scheduling new tile work after a fail-fast error', async () => {
    const runtime = createViewportQueryExecutionRuntime({
      maximumConcurrentTiles: 1,
      tilePlanner: createViewportTilePlanner({
        maximumEstimatedFeaturesPerTile: 100,
        maximumTiles: 8,
      }),
    });
    const executor = vi.fn(async ({ tile }) => {
      if (tile.index === 0) throw new Error('fatal');
      return { features: [{ id: tile.id, payload: null }] };
    });
    const result = await runtime.execute(
      { ...input, estimatedFeatureDensity: 0.2, failFast: true },
      executor,
    );
    expect(result.status).toBe('partial');
    expect(executor.mock.calls.length).toBeLessThan(result.tilePlan.tileCount);
  });

  it('deduplicates overlapping tile feature identities in the result window', async () => {
    const runtime = createViewportQueryExecutionRuntime({
      tilePlanner: createViewportTilePlanner({
        maximumEstimatedFeaturesPerTile: 100,
        maximumTiles: 4,
      }),
    });
    const result = await runtime.execute(
      { ...input, estimatedFeatureDensity: 0.1 },
      async ({ tile }) => ({
        features: [
          { id: 'shared', payload: tile.id, estimatedBytes: 10 },
          { id: tile.id, payload: tile.index, estimatedBytes: 10 },
        ],
      }),
    );
    const shared = result.features.filter((feature) => feature.id === 'shared');
    expect(shared).toHaveLength(1);
  });

  it('propagates transfer-limit warnings without inventing pagination behavior', async () => {
    const runtime = createViewportQueryExecutionRuntime();
    const result = await runtime.execute(input, async () => ({
      features: [],
      exceededTransferLimit: true,
    }));
    expect(result.warnings).toContain('transport-transfer-limit-exceeded');
  });

  it('applies pressure feature-budget reduction before tile planning', async () => {
    const budget = createViewportBudgetController();
    budget.sample({ frameMs: 30, timestamp: 1 });
    const runtime = createViewportQueryExecutionRuntime({ budgetController: budget });
    const result = await runtime.execute(input, async () => ({ features: [] }));
    expect(result.warnings).toContain('pressure-feature-budget-reduced');
    expect(result.tilePlan.featureBudget).toBeLessThanOrEqual(result.queryPlan.maxFeatures);
  });

  it('supports explicit layer cancellation and clearing', async () => {
    const runtime = createViewportQueryExecutionRuntime();
    await runtime.execute(input, async ({ tile }) => ({
      features: [{ id: tile.id, payload: null }],
    }));
    expect(runtime.readLayer('roads').length).toBeGreaterThan(0);
    expect(runtime.cancelLayer('roads')).toBe(true);
    expect(runtime.clearLayer('roads')).toBe(true);
    expect(runtime.readLayer('roads')).toEqual([]);
  });

  it('returns false when cancelling an unknown layer', () => {
    const runtime = createViewportQueryExecutionRuntime();
    expect(runtime.cancelLayer('unknown')).toBe(false);
  });

  it('uses pressure samples in subsequent execution snapshots', async () => {
    const runtime = createViewportQueryExecutionRuntime();
    runtime.samplePerformance({ frameMs: 30, timestamp: 1 });
    const result = await runtime.execute(input, async () => ({ features: [] }));
    expect(result.pressure.pressure).toBe('elevated');
    expect(runtime.snapshot().pressure.pressure).toBe('elevated');
  });

  it('rejects invalid concurrency and cache configuration eagerly', () => {
    expect(() => createViewportQueryExecutionRuntime({ maximumConcurrentTiles: 0 })).toThrow('maximumConcurrentTiles');
    expect(() => createViewportQueryExecutionRuntime({ cacheTtlMs: -1 })).toThrow('cacheTtlMs');
    expect(() => createViewportQueryExecutionRuntime({
      cacheTtlMs: 100,
      cacheTtlMaximumMs: 50,
    })).toThrow('cacheTtlMs cannot exceed');
  });

  it('rejects malformed layer ids before allocating work', async () => {
    const runtime = createViewportQueryExecutionRuntime();
    await expect(runtime.execute({ ...input, layerId: ' ' }, async () => ({ features: [] })))
      .rejects.toThrow('layerId');
    expect(runtime.snapshot().executionsStarted).toBe(0);
  });

  it('disposes all layer work and rejects later use', async () => {
    const runtime = createViewportQueryExecutionRuntime();
    runtime.dispose();
    expect(() => runtime.snapshot()).toThrow('disposed');
    await expect(runtime.execute(input, async () => ({ features: [] }))).rejects.toThrow('disposed');
  });

  it('makes disposal idempotent', () => {
    const runtime = createViewportQueryExecutionRuntime();
    expect(() => {
      runtime.dispose();
      runtime.dispose();
    }).not.toThrow();
  });
});
