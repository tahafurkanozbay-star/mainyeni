import { describe, expect, it, vi } from 'vitest';
import type { ArcGisQueryOptions } from '../contracts';
import {
  BusinessQueryPlanError,
  createBusinessDiagnostics,
  createQueryPlanner,
  createQueryRuntime,
  createServiceRegistry,
} from './index';

const registry = () => createServiceRegistry({
  listServices: () => [
    { title: 'LayerA', url: '/gis/a' },
    { title: 'LayerB', url: '/gis/b' },
  ],
});

describe('Business query planner', () => {
  it('creates a deterministic non-spatial query plan', () => {
    const services = registry();
    const planner = createQueryPlanner(key => services.requireUrl(key));

    const first = planner.plan({
      serviceKey: 'LayerA',
      returnGeometry: true,
      orderByFields: ['ad'],
      outFields: ['id', 'ad'],
      where: "id='1'",
    });
    const second = planner.plan({
      serviceKey: 'LayerA',
      returnGeometry: true,
      orderByFields: ['ad'],
      outFields: ['id', 'ad'],
      where: "id='1'",
    });

    expect(first).toMatchObject({
      serviceKey: 'LayerA',
      spatial: false,
      options: {
        url: '/gis/a',
        returnGeometry: true,
        orderByFields: ['ad'],
        outFields: ['id', 'ad'],
        where: "id='1'",
      },
    });
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('changes fingerprint when query semantics change', () => {
    const services = registry();
    const planner = createQueryPlanner(key => services.requireUrl(key));

    const a = planner.plan({ serviceKey: 'LayerA', where: "id='1'" });
    const b = planner.plan({ serviceKey: 'LayerA', where: "id='2'" });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('normalizes duplicate fields and caps nearby distance', () => {
    const services = registry();
    const planner = createQueryPlanner(key => services.requireUrl(key));
    const plan = planner.plan({
      serviceKey: 'LayerA',
      orderByFields: ['ad', 'ad', 'id'],
      outFields: ['*', '*'],
      spatial: {
        geometry: { x: 1, y: 2 },
        distance: 1000,
      },
    });

    expect(plan.options.orderByFields).toEqual(['ad', 'id']);
    expect(plan.options.outFields).toEqual(['*']);
    expect(plan.options.distance).toBe(10_000);
    expect(plan.spatial).toBe(true);
  });

  it('fails closed on missing service keys', () => {
    const planner = createQueryPlanner(() => '/gis/a');
    expect(() => planner.plan({ serviceKey: '' }))
      .toThrow(BusinessQueryPlanError);
  });

  it('fails closed on overlong where clauses', () => {
    const planner = createQueryPlanner(
      () => '/gis/a',
      {
        maxTextLength: 160,
        maxIdentifierLength: 96,
        maxIdentifierCount: 250,
        maxWhereLength: 10,
        maxDiagnosticEntries: 256,
        defaultCacheTtlMs: 30000,
        maxCacheTtlMs: 300000,
        defaultTimeoutMs: 15000,
        maxTimeoutMs: 120000,
        minNearbyDistance: 0,
        maxNearbyDistance: 100,
      },
    );
    expect(() => planner.plan({
      serviceKey: 'A',
      where: 'x'.repeat(20),
    })).toThrow(BusinessQueryPlanError);
  });
});

describe('Business query runtime', () => {
  const setup = () => {
    const services = registry();
    const diagnostics = createBusinessDiagnostics();
    const executeQuery = vi.fn<(options: ArcGisQueryOptions) => Promise<unknown>>();
    const executeSpatialQuery = vi.fn<(options: ArcGisQueryOptions) => Promise<unknown>>();
    const runtime = createQueryRuntime({
      services,
      diagnostics,
      executeQuery,
      executeSpatialQuery,
    });
    const planner = createQueryPlanner(key => services.requireUrl(key));
    return {
      services,
      diagnostics,
      executeQuery,
      executeSpatialQuery,
      runtime,
      planner,
    };
  };

  it('executes non-spatial plans through the normal GIS executor', async () => {
    const ctx = setup();
    ctx.executeQuery.mockResolvedValue({
      type: 10,
      data: [{ id: 1 }, { id: 2 }],
    });
    const plan = ctx.planner.plan({ serviceKey: 'LayerA', where: '1=1' });

    await expect(ctx.runtime.execute(plan)).resolves.toMatchObject({ type: 10 });
    expect(ctx.executeQuery).toHaveBeenCalledWith(expect.objectContaining({
      url: '/gis/a',
      where: '1=1',
    }));
    expect(ctx.executeSpatialQuery).not.toHaveBeenCalled();

    const snapshot = ctx.diagnostics.snapshot();
    expect(snapshot.counts.started).toBe(1);
    expect(snapshot.counts.success).toBe(1);
    expect(snapshot.events.at(-1)?.featureCount).toBe(2);
  });

  it('executes spatial plans through the spatial GIS executor', async () => {
    const ctx = setup();
    ctx.executeSpatialQuery.mockResolvedValue({ type: 10, data: [] });
    const plan = ctx.planner.plan({
      serviceKey: 'LayerA',
      spatial: {
        geometry: { x: 1, y: 2 },
        distance: 5,
      },
    });

    await ctx.runtime.execute(plan);
    expect(ctx.executeSpatialQuery).toHaveBeenCalledWith(expect.objectContaining({
      geometry: { x: 1, y: 2 },
      distance: 500,
      units: 'meters',
    }));
    expect(ctx.diagnostics.snapshot().counts.empty).toBe(1);
  });

  it('forwards cache and AbortSignal controls without inventing transport semantics', async () => {
    const ctx = setup();
    ctx.executeQuery.mockResolvedValue({ type: 10, data: [] });
    const controller = new AbortController();
    const plan = ctx.planner.plan({ serviceKey: 'LayerA' });

    await ctx.runtime.execute(plan, {
      signal: controller.signal,
      cache: true,
      cacheTtlMs: 5000,
    });

    expect(ctx.executeQuery).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
      cache: true,
      ttlMs: 5000,
    }));
  });

  it('classifies legacy service-result errors as diagnostic failures', async () => {
    const ctx = setup();
    ctx.executeQuery.mockResolvedValue({ type: 20, data: null });
    const plan = ctx.planner.plan({ serviceKey: 'LayerA' });
    await ctx.runtime.execute(plan);
    expect(ctx.diagnostics.snapshot().counts.failure).toBe(1);
  });

  it('records thrown failures and rethrows the original error', async () => {
    const ctx = setup();
    const failure = Object.assign(new Error('boom'), { code: 'GIS_FAIL' });
    ctx.executeQuery.mockRejectedValue(failure);
    const plan = ctx.planner.plan({ serviceKey: 'LayerA' });

    await expect(ctx.runtime.execute(plan)).rejects.toBe(failure);
    const event = ctx.diagnostics.snapshot().events.at(-1);
    expect(event?.status).toBe('failure');
    expect(event?.code).toBe('Error');
  });

  it('records cancellation when the caller signal is aborted', async () => {
    const ctx = setup();
    const controller = new AbortController();
    controller.abort();
    const failure = new DOMException('aborted', 'AbortError');
    ctx.executeQuery.mockRejectedValue(failure);
    const plan = ctx.planner.plan({ serviceKey: 'LayerA' });

    await expect(ctx.runtime.execute(plan, { signal: controller.signal }))
      .rejects.toBe(failure);
    expect(ctx.diagnostics.snapshot().counts.cancelled).toBe(1);
  });
});
