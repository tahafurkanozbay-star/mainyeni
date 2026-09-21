import { describe, expect, it, vi } from 'vitest';

import { createModernGisKernel } from './modernGisKernel';
import {
  createSpatialQueryControlPlane,
  deriveSpatialLayerNumericId,
} from './spatialQueryControlPlane';

const FEATURE_URL = 'https://example.test/arcgis/rest/services/Places/FeatureServer/0';

const featureMetadata = (): Readonly<Record<string, unknown>> => Object.freeze({
  name: 'Places',
  type: 'Feature Layer',
  capabilities: 'Query',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  maxRecordCount: 2_000,
  extent: {
    spatialReference: {
      wkid: 102100,
      latestWkid: 3857,
    },
  },
  fields: [
    {
      name: 'OBJECTID',
      alias: 'OBJECTID',
      type: 'esriFieldTypeOID',
      nullable: false,
      editable: false,
    },
    {
      name: 'NAME',
      alias: 'Name',
      type: 'esriFieldTypeString',
      length: 120,
    },
  ],
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsOrderBy: true,
    supportsStatistics: true,
    supportsDistinct: true,
    supportsReturningQueryExtent: true,
    supportsReturningGeometryCentroid: true,
    supportsQuantization: true,
  },
});

type Kernel = ReturnType<typeof createModernGisKernel>;

const createKernel = (
  queryControlPlane = createSpatialQueryControlPlane(),
): Kernel => createModernGisKernel({
  initialTier: 'balanced',
  device: {
    memoryGb: 8,
    logicalCores: 8,
    networkClass: 'fast',
  },
  queryControlPlane,
});

const registerPlaces = (kernel: Kernel): void => {
  kernel.registerService({
    serviceId: 'places',
    url: FEATURE_URL,
    metadata: featureMetadata(),
  });
  kernel.registerLayer({
    id: 'places-layer',
    serviceId: 'places',
    visible: true,
    importance: 80,
    estimatedFeatureCount: 5_000,
    estimatedBytes: 1024 * 1024,
  });
};

const basicPlan = () => ({
  outFields: ['NAME'],
  pageSize: 50,
  orderBy: [{ field: 'NAME', direction: 'ASC' as const }],
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('modern GIS kernel query control-plane integration', () => {
  it('exposes the governed control-plane snapshot through kernel diagnostics', () => {
    const kernel = createKernel();
    registerPlaces(kernel);

    expect(kernel.getDiagnostics().queryControlPlane).toMatchObject({
      disposed: false,
      health: 'healthy',
      executions: 0,
      completed: 0,
      activeExecutions: 0,
    });
    expect(kernel.queryControlPlane).toBeDefined();
  });

  it('routes production executeQuery through the control plane before the scheduler', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    const execute = vi.fn(async () => ({
      features: [{ attributes: { OBJECTID: 1, NAME: 'Park' } }],
    }));

    const result = await kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:governed',
      execute,
    });

    expect(result.value.features).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(kernel.getDiagnostics().queryControlPlane).toMatchObject({
      executions: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
      operationResults: 1,
    });
    expect(kernel.getDiagnostics().queryControlPlane.lifecycle).toMatchObject({
      completed: 1,
      active: 0,
    });
    expect(kernel.getDiagnostics().queryControlPlane.supervision).toMatchObject({
      completed: 1,
      failed: 0,
    });
  });

  it('deduplicates concurrent same-key kernel requests at the governance boundary', async () => {
    const gate = deferred<void>();
    const execute = vi.fn(async () => {
      await gate.promise;
      return {
        features: [{ attributes: { OBJECTID: 7, NAME: 'Shared' } }],
      };
    });
    const kernel = createKernel();
    registerPlaces(kernel);

    const input = {
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:shared-governed',
      execute,
    };

    const first = kernel.executeQuery(input);
    const second = kernel.executeQuery(input);

    await Promise.resolve();
    expect(kernel.getDiagnostics().queryControlPlane.queue).toMatchObject({
      inflight: 1,
      activeSubscribers: 2,
      dedupedSubscribers: 1,
    });

    gate.resolve();
    const [left, right] = await Promise.all([first, second]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(left.value).toEqual(right.value);
    expect(kernel.getDiagnostics().queryControlPlane).toMatchObject({
      executions: 2,
      completed: 2,
    });
  });

  it('preserves scheduler result caching while the control plane avoids double caching', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    const execute = vi.fn(async () => ({
      features: [{ attributes: { OBJECTID: 11 } }],
    }));
    const input = {
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:scheduler-cache',
      cacheTtlMs: 60_000,
      execute,
    };

    await kernel.executeQuery(input);
    await kernel.executeQuery(input);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(kernel.getDiagnostics().scheduler.metrics.cacheHits).toBeGreaterThanOrEqual(1);
    expect(kernel.getDiagnostics().queryControlPlane.cache).toMatchObject({
      bypasses: 2,
      cacheServed: 0,
    });
  });

  it('maps interactive kernel priority into the governed query queue', async () => {
    const firstGate = deferred<void>();
    const order: string[] = [];
    const controlPlane = createSpatialQueryControlPlane({
      queue: {
        maxConcurrent: 1,
        maxQueued: 8,
      },
    });
    const kernel = createKernel(controlPlane);
    registerPlaces(kernel);

    const active = kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:active',
      priority: 'foreground',
      execute: async () => {
        order.push('active');
        await firstGate.promise;
        return { features: [] };
      },
    });

    const background = kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:background',
      priority: 'background',
      execute: async () => {
        order.push('background');
        return { features: [] };
      },
    });

    const interactive = kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:interactive',
      priority: 'interactive',
      execute: async () => {
        order.push('interactive');
        return { features: [] };
      },
    });

    firstGate.resolve();
    await active;
    await interactive;
    await background;

    expect(order).toEqual(['active', 'interactive', 'background']);
  });

  it('maps prefetch priority into the background governance lane', async () => {
    const firstGate = deferred<void>();
    const order: string[] = [];
    const controlPlane = createSpatialQueryControlPlane({
      queue: {
        maxConcurrent: 1,
        maxQueued: 8,
      },
    });
    const kernel = createKernel(controlPlane);
    registerPlaces(kernel);

    const active = kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:active-prefetch-test',
      priority: 'foreground',
      execute: async () => {
        await firstGate.promise;
        return { features: [] };
      },
    });
    const prefetch = kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:prefetch',
      priority: 'prefetch',
      execute: async () => {
        order.push('prefetch');
        return { features: [] };
      },
    });
    const normal = kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:normal',
      priority: 'foreground',
      execute: async () => {
        order.push('normal');
        return { features: [] };
      },
    });

    firstGate.resolve();
    await active;
    await normal;
    await prefetch;

    expect(order).toEqual(['normal', 'prefetch']);
  });

  it('propagates caller abort through control plane and scheduler to transport execution', async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const kernel = createKernel();
    registerPlaces(kernel);

    const execution = kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:abort',
      signal: controller.signal,
      execute: async (_request, context) => {
        observedSignal = context.signal;
        started.resolve();
        return new Promise((_, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      },
    });

    await started.promise;
    controller.abort('panel-closed');

    await expect(execution).rejects.toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(kernel.getDiagnostics().queryControlPlane.queue.cancelledSubscribers).toBe(1);
  });

  it('aborts active layer query work when kernel invalidates the layer', async () => {
    const started = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const kernel = createKernel();
    registerPlaces(kernel);

    const execution = kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:invalidate-active',
      execute: async (_request, context) => {
        observedSignal = context.signal;
        started.resolve();
        return new Promise((_, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      },
    });

    await started.promise;
    const result = kernel.invalidateLayer('places-layer');

    expect(result.queryCache).toBeGreaterThanOrEqual(0);
    await expect(execution).rejects.toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(kernel.getDiagnostics().queryControlPlane).toMatchObject({
      layerInvalidations: 1,
      activeExecutions: 0,
    });
    expect(kernel.getDiagnostics().queryControlPlane.supervision.mutations).toBe(1);
  });

  it('invalidates governed layer state during layer unregister', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);

    await kernel.unregisterLayer('places-layer');

    expect(kernel.getSnapshot().registeredLayers).toBe(0);
    expect(kernel.getDiagnostics().queryControlPlane.layerInvalidations).toBe(1);
  });

  it('invalidates governed service state during service unregister', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);

    await kernel.unregisterLayer('places-layer');
    await kernel.unregisterService('places');

    expect(kernel.getSnapshot().registeredServices).toBe(0);
    expect(kernel.getDiagnostics().queryControlPlane.serviceInvalidations).toBe(1);
  });

  it('uses a deterministic numeric epoch identity for string kernel layer ids', () => {
    const first = deriveSpatialLayerNumericId('places-layer');
    const second = deriveSpatialLayerNumericId('places-layer');

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(Number.isSafeInteger(first)).toBe(true);
  });

  it('reports transport failures through both service health and query governance', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);

    await expect(kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:failure-governed',
      cache: false,
      execute: async () => {
        const error = Object.assign(new Error('unavailable'), {
          status: 503,
          code: 'HTTP_503',
        });
        throw error;
      },
    })).rejects.toBeDefined();

    expect(kernel.getDiagnostics().queryControlPlane).toMatchObject({
      failed: 1,
      completed: 0,
    });
    expect(kernel.getDiagnostics().kernel.services[0]).toMatchObject({
      failures: 1,
      circuit: 'open',
    });
  });

  it('does not expose raw transport error text in control-plane event history', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);

    await expect(kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:sensitive-error',
      cache: false,
      execute: async () => {
        throw new Error('database-host-private-detail');
      },
    })).rejects.toBeDefined();

    expect(JSON.stringify(kernel.queryControlPlane.events())).not.toContain(
      'database-host-private-detail',
    );
  });

  it('retains existing service-health preflight rejection before query work starts', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);

    await expect(kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:open-circuit',
      cache: false,
      execute: async () => {
        throw Object.assign(new Error('service unavailable'), {
          status: 503,
        });
      },
    })).rejects.toBeDefined();

    const before = kernel.getDiagnostics().queryControlPlane.executions;
    const execute = vi.fn(async () => ({ features: [] }));

    await expect(kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:preflight-blocked',
      cache: false,
      execute,
    })).rejects.toThrow(/temporarily unavailable/iu);

    expect(execute).not.toHaveBeenCalled();
    expect(kernel.getDiagnostics().queryControlPlane.executions).toBe(before);
  });

  it('keeps query-control diagnostics separate from raw ArcGIS resource URLs', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);

    await kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:privacy',
      execute: async () => ({ features: [] }),
    });

    const controlEvents = JSON.stringify(kernel.queryControlPlane.events());
    expect(controlEvents).not.toContain(FEATURE_URL);
    expect(controlEvents).not.toContain('https://');
  });

  it('disposes the query control plane before kernel teardown completes', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);

    await kernel.destroy();

    expect(kernel.isDestroyed()).toBe(true);
    expect(kernel.queryControlPlane.snapshot()).toMatchObject({
      disposed: true,
      health: 'blocked',
      activeExecutions: 0,
    });
  });

  it('aborts in-flight governed work when the entire kernel is destroyed', async () => {
    const started = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const kernel = createKernel();
    registerPlaces(kernel);

    const execution = kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicPlan(),
      requestKey: 'places:destroy-active',
      execute: async (_request, context) => {
        observedSignal = context.signal;
        started.resolve();
        return new Promise((_, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      },
    });

    await started.promise;
    const destroyed = kernel.destroy();

    await expect(execution).rejects.toBeDefined();
    await destroyed;
    expect(observedSignal?.aborted).toBe(true);
    expect(kernel.queryControlPlane.snapshot().disposed).toBe(true);
  });
});
