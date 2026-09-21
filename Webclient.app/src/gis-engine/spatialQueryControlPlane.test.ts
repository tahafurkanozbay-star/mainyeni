import { describe, expect, it, vi } from 'vitest';
import {
  SpatialQueryControlPlaneError,
  createSpatialQueryControlPlane,
  deriveSpatialLayerNumericId,
  normalizeSpatialQueryControlPlanePolicy,
  type SpatialQueryControlPlane,
  type SpatialQueryControlRequest,
} from './spatialQueryControlPlane';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const request = <T>(
  execute: SpatialQueryControlRequest<T>['execute'],
  overrides: Partial<SpatialQueryControlRequest<T>> = {},
): SpatialQueryControlRequest<T> => ({
  ownerId: 'map-view',
  serviceId: 'municipal-assets',
  layerId: 3,
  operation: 'query-features',
  priority: 'foreground',
  estimatedFeatures: 250,
  estimatedBytes: 32_000,
  estimatedCpuMs: 12,
  estimatedGpuBytes: 0,
  key: {
    where: 'STATUS = 1',
    outFields: ['OBJECTID', 'NAME'],
    resultOffset: 0,
    resultRecordCount: 250,
    returnGeometry: true,
  },
  cache: {
    ttlMs: 5_000,
    tags: ['screen:map', 'purpose:viewport'],
  },
  execute,
  ...overrides,
});

describe('normalizeSpatialQueryControlPlanePolicy', () => {
  it('publishes bounded defaults for queue, lifecycle, cache, history and health', () => {
    const policy = normalizeSpatialQueryControlPlanePolicy();
    expect(policy.queue).toMatchObject({
      maxConcurrent: 6,
      maxQueued: 128,
      timeoutMs: 30_000,
      dedupeTtlMs: 0,
      maxSubscribersPerQuery: 64,
    });
    expect(policy.lifecycle).toMatchObject({
      maxTrackedQueries: 2_048,
      maxExecutionMs: 60_000,
    });
    expect(policy.cache).toMatchObject({
      cacheMaxEntries: 256,
      cacheMaxEstimatedBytes: 16 * 1024 * 1024,
      requestConcurrency: 6,
    });
    expect(policy).toMatchObject({
      maxHistory: 1_024,
      maxTags: 32,
      degradedQueueRatio: 0.6,
      blockedQueueRatio: 0.9,
      degradedFailureRatio: 0.2,
      blockedFailureRatio: 0.6,
      failureWindow: 32,
    });
  });

  it('rejects invalid queue and failure health threshold ordering', () => {
    expect(() => normalizeSpatialQueryControlPlanePolicy({
      degradedQueueRatio: 0.8,
      blockedQueueRatio: 0.7,
    })).toThrow(/degradedQueueRatio/u);

    expect(() => normalizeSpatialQueryControlPlanePolicy({
      degradedFailureRatio: 0.9,
      blockedFailureRatio: 0.5,
    })).toThrow(/degradedFailureRatio/u);
  });

  it('rejects out-of-range ratios and unbounded history values', () => {
    expect(() => normalizeSpatialQueryControlPlanePolicy({
      degradedQueueRatio: -0.1,
    })).toThrow(/degradedQueueRatio/u);

    expect(() => normalizeSpatialQueryControlPlanePolicy({
      blockedQueueRatio: 1.1,
    })).toThrow(/blockedQueueRatio/u);

    expect(() => normalizeSpatialQueryControlPlanePolicy({
      maxHistory: 0,
    })).toThrow(/maxHistory/u);
  });

  it('keeps failureWindow bounded by maxHistory', () => {
    expect(() => normalizeSpatialQueryControlPlanePolicy({
      maxHistory: 4,
      failureWindow: 5,
    })).toThrow(/failureWindow/u);

    expect(normalizeSpatialQueryControlPlanePolicy({
      maxHistory: 4,
      failureWindow: 4,
    }).failureWindow).toBe(4);
  });
});

describe('deriveSpatialLayerNumericId', () => {
  it('preserves valid numeric ArcGIS layer ids', () => {
    expect(deriveSpatialLayerNumericId(0)).toBe(0);
    expect(deriveSpatialLayerNumericId(42)).toBe(42);
  });

  it('derives a deterministic bounded id from string layer identities', () => {
    const first = deriveSpatialLayerNumericId('parks-layer');
    const second = deriveSpatialLayerNumericId('parks-layer');
    const other = deriveSpatialLayerNumericId('roads-layer');

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
  });

  it('rejects empty string and invalid numeric layer ids', () => {
    expect(() => deriveSpatialLayerNumericId('   ')).toThrow(/layerId/u);
    expect(() => deriveSpatialLayerNumericId(-1)).toThrow(/layerId/u);
    expect(() => deriveSpatialLayerNumericId(Number.NaN)).toThrow(/layerId/u);
  });
});

describe('SpatialQueryControlPlane execution', () => {
  it('executes a supervised query and exposes bounded subsystem snapshots', async () => {
    const operation = vi.fn(async ({ controlId, cacheKey }) => ({
      controlId,
      cacheKey,
      features: [1, 2, 3],
    }));
    const plane = createSpatialQueryControlPlane();

    const result = await plane.execute(request(operation));

    expect(result.source).toBe('operation');
    expect(result.value.features).toEqual([1, 2, 3]);
    expect(result.controlId).toMatch(/^query-/u);
    expect(result.cacheKey).toContain('municipal-assets');
    expect(operation).toHaveBeenCalledTimes(1);

    expect(plane.snapshot()).toMatchObject({
      disposed: false,
      health: 'healthy',
      executions: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
      timedOut: 0,
      operationResults: 1,
      activeExecutions: 0,
    });
    expect(plane.snapshot().queue).toMatchObject({
      active: 0,
      queued: 0,
      inflight: 0,
      completed: 1,
    });
    expect(plane.snapshot().lifecycle).toMatchObject({
      active: 0,
      completed: 1,
      failed: 0,
    });
    expect(plane.snapshot().supervision).toMatchObject({
      completed: 1,
      failed: 0,
    });
  });

  it('deduplicates concurrent identical logical queries before transport work', async () => {
    const gate = deferred<number>();
    const operation = vi.fn(() => gate.promise);
    const plane = createSpatialQueryControlPlane({
      queue: {
        maxConcurrent: 2,
        maxSubscribersPerQuery: 8,
      },
    });

    const first = plane.execute(request(operation));
    const second = plane.execute(request(operation));

    expect(operation).toHaveBeenCalledTimes(1);
    expect(plane.snapshot().queue).toMatchObject({
      inflight: 1,
      activeSubscribers: 2,
      dedupedSubscribers: 1,
    });

    gate.resolve(7);
    await expect(first).resolves.toMatchObject({ value: 7 });
    await expect(second).resolves.toMatchObject({ value: 7 });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(plane.snapshot()).toMatchObject({
      executions: 2,
      completed: 2,
    });
  });

  it('serves a repeated completed query from the bounded spatial cache', async () => {
    const operation = vi.fn(async () => ({ id: 1 }));
    const plane = createSpatialQueryControlPlane();

    const first = await plane.execute(request(operation));
    const second = await plane.execute(request(operation));

    expect(first.source).toBe('operation');
    expect(second.source).toBe('cache');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(plane.snapshot()).toMatchObject({
      cacheHits: 1,
      staleCacheHits: 0,
      operationResults: 1,
    });
  });

  it('bypasses cache when explicitly requested', async () => {
    const operation = vi.fn()
      .mockResolvedValueOnce({ generation: 1 })
      .mockResolvedValueOnce({ generation: 2 });
    const plane = createSpatialQueryControlPlane();

    const first = await plane.execute(request(operation, {
      cache: { bypassCache: true },
    }));
    const second = await plane.execute(request(operation, {
      cache: { bypassCache: true },
    }));

    expect(first.value).toEqual({ generation: 1 });
    expect(second.value).toEqual({ generation: 2 });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(plane.snapshot().cache.bypasses).toBe(2);
  });

  it('refreshes an existing cache entry through the operation path', async () => {
    const operation = vi.fn()
      .mockResolvedValueOnce({ generation: 1 })
      .mockResolvedValueOnce({ generation: 2 });
    const plane = createSpatialQueryControlPlane();

    await plane.execute(request(operation));
    const refreshed = await plane.execute(request(operation, {
      cache: { refresh: true, ttlMs: 5_000 },
    }));

    expect(refreshed.source).toBe('operation');
    expect(refreshed.value).toEqual({ generation: 2 });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(plane.snapshot().cache.refreshes).toBe(1);
  });

  it('keeps distinct cache keys isolated by service, layer, operation and query input', async () => {
    const operation = vi.fn(async ({ layerId }) => layerId);
    const plane = createSpatialQueryControlPlane();

    const first = await plane.execute(request(operation));
    const second = await plane.execute(request(operation, {
      layerId: 4,
    }));
    const third = await plane.execute(request(operation, {
      operation: 'query-statistics',
    }));
    const fourth = await plane.execute(request(operation, {
      key: {
        where: 'STATUS = 2',
        outFields: ['OBJECTID'],
      },
    }));

    expect(first.cacheKey).not.toBe(second.cacheKey);
    expect(first.cacheKey).not.toBe(third.cacheKey);
    expect(first.cacheKey).not.toBe(fourth.cacheKey);
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('rejects an already-aborted subscriber before invoking operation work', async () => {
    const controller = new AbortController();
    controller.abort('view-disposed');
    const operation = vi.fn(async () => 1);
    const plane = createSpatialQueryControlPlane();

    await expect(plane.execute(request(operation, {
      signal: controller.signal,
    }))).rejects.toMatchObject({
      name: 'SpatialQueryControlPlaneError',
      code: 'CANCELLED',
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('lets one deduplicated subscriber cancel while a survivor completes', async () => {
    const gate = deferred<number>();
    const controller = new AbortController();
    const operation = vi.fn(() => gate.promise);
    const plane = createSpatialQueryControlPlane();

    const cancelled = plane.execute(request(operation, {
      signal: controller.signal,
    }));
    const survivor = plane.execute(request(operation));

    controller.abort('panel-closed');
    await expect(cancelled).rejects.toMatchObject({
      code: 'CANCELLED',
    });

    gate.resolve(11);
    await expect(survivor).resolves.toMatchObject({ value: 11 });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(plane.snapshot().queue.cancelledSubscribers).toBe(1);
  });

  it('fails closed when active and queued capacity are both exhausted', async () => {
    const gate = deferred<number>();
    const plane = createSpatialQueryControlPlane({
      queue: {
        maxConcurrent: 1,
        maxQueued: 1,
      },
    });

    const active = plane.execute(request(() => gate.promise, {
      key: { extra: { request: 'active' } },
    }));
    const queued = plane.execute(request(async () => 2, {
      key: { extra: { request: 'queued' } },
    }));

    await expect(plane.execute(request(async () => 3, {
      key: { extra: { request: 'overflow' } },
    }))).rejects.toMatchObject({
      code: 'QUEUE_REJECTED',
    });

    gate.resolve(1);
    await active;
    await queued;
    expect(plane.snapshot().queue.rejected).toBe(1);
  });

  it('blocks an operation that exceeds supervision single-request budgets', async () => {
    const operation = vi.fn(async () => 1);
    const plane = createSpatialQueryControlPlane({
      supervision: {
        admission: {
          maxSingleEstimatedFeatures: 100,
          maxEstimatedFeaturesInFlight: 100,
        },
      },
    });

    await expect(plane.execute(request(operation, {
      estimatedFeatures: 101,
    }))).rejects.toMatchObject({
      code: 'SUPERVISION_REJECTED',
    });

    expect(operation).not.toHaveBeenCalled();
    expect(plane.snapshot().supervision.admissionBlocks).toBe(1);
  });

  it('wraps operation failures without exposing raw failure text in event diagnostics', async () => {
    const plane = createSpatialQueryControlPlane();
    const sensitive = new Error('sensitive server detail');

    await expect(plane.execute(request(async () => {
      throw sensitive;
    }))).rejects.toMatchObject({
      name: 'SpatialQueryControlPlaneError',
      code: 'OPERATION_FAILED',
    });

    const events = plane.events();
    const failed = events.find((event) => event.type === 'execution-failed');
    expect(failed).toBeDefined();
    expect(failed?.code).toBe('operation-failed');
    expect(JSON.stringify(failed)).not.toContain('sensitive server detail');
    expect(plane.snapshot()).toMatchObject({
      failed: 1,
      completed: 0,
    });
  });
});

describe('SpatialQueryControlPlane invalidation', () => {
  it('aborts active work and advances the layer epoch on layer invalidation', async () => {
    const started = deferred<void>();
    const plane = createSpatialQueryControlPlane();

    const execution = plane.execute(request(({ signal }) => {
      started.resolve();
      return new Promise<number>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }));

    await started.promise;
    const invalidation = plane.invalidateLayer('municipal-assets', 3, 'definition-changed');

    expect(invalidation.aborted).toBe(1);
    await expect(execution).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await flush();

    expect(plane.snapshot()).toMatchObject({
      layerInvalidations: 1,
      activeExecutions: 0,
    });
    expect(plane.snapshot().supervision.mutations).toBe(1);
  });

  it('invalidates only matching active service work', async () => {
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const firstGate = deferred<number>();
    const secondGate = deferred<number>();
    const plane = createSpatialQueryControlPlane({
      queue: { maxConcurrent: 4 },
    });

    const first = plane.execute(request(({ signal }) => {
      firstStarted.resolve();
      return new Promise<number>((resolve, reject) => {
        firstGate.promise.then(resolve, reject);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }));
    const second = plane.execute(request(({ signal }) => {
      secondStarted.resolve();
      return new Promise<number>((resolve, reject) => {
        secondGate.promise.then(resolve, reject);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }, {
      serviceId: 'transport-assets',
      layerId: 7,
      key: { extra: { request: 'transport' } },
    }));

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    const result = plane.invalidateService('municipal-assets', 'service-reloaded');

    expect(result.aborted).toBe(1);
    expect(result.advancedLayers).toBe(1);
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });

    secondGate.resolve(9);
    await expect(second).resolves.toMatchObject({ value: 9 });
    expect(plane.snapshot().serviceInvalidations).toBe(1);
  });

  it('removes matching cached layer entries on invalidation', async () => {
    const operation = vi.fn(async () => ({ value: 1 }));
    const plane = createSpatialQueryControlPlane();

    await plane.execute(request(operation));
    expect(plane.snapshot().cache.cache.entries).toBe(1);

    const result = plane.invalidateLayer('municipal-assets', 3);

    expect(result.cacheEntries).toBe(1);
    expect(plane.snapshot().cache.cache.entries).toBe(0);

    await plane.execute(request(operation));
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('removes all cached entries with global cache invalidation', async () => {
    const plane = createSpatialQueryControlPlane();
    await plane.execute(request(async () => 1, {
      key: { extra: { id: 1 } },
    }));
    await plane.execute(request(async () => 2, {
      key: { extra: { id: 2 } },
    }));

    expect(plane.snapshot().cache.cache.entries).toBe(2);
    expect(plane.invalidateCache()).toBe(2);
    expect(plane.snapshot()).toMatchObject({
      cacheInvalidations: 2,
    });
    expect(plane.snapshot().cache.cache.entries).toBe(0);
  });
});

describe('SpatialQueryControlPlane diagnostics and health', () => {
  it('stores privacy-safe fingerprints rather than raw owner/service identifiers', async () => {
    const plane = createSpatialQueryControlPlane();

    await plane.execute(request(async () => 1, {
      ownerId: 'operator-user-123',
      serviceId: 'private-service-name',
    }));

    const serialized = JSON.stringify(plane.events());
    expect(serialized).not.toContain('operator-user-123');
    expect(serialized).not.toContain('private-service-name');
    expect(plane.events()[0]).toMatchObject({
      ownerFingerprint: expect.stringMatching(/^owner-/u),
      serviceFingerprint: expect.stringMatching(/^service-/u),
    });
  });

  it('bounds diagnostic history and retains the newest events', async () => {
    const plane = createSpatialQueryControlPlane({
      maxHistory: 5,
      failureWindow: 5,
    });

    for (let index = 0; index < 5; index += 1) {
      await plane.execute(request(async () => index, {
        key: { extra: { index } },
      }));
    }

    expect(plane.snapshot().historySize).toBe(5);
    expect(plane.events()).toHaveLength(5);
    expect(plane.events()[0]?.sequence).toBeGreaterThan(1);
  });

  it('marks queue pressure as degraded before it becomes blocked', async () => {
    const activeGate = deferred<number>();
    const plane = createSpatialQueryControlPlane({
      queue: {
        maxConcurrent: 1,
        maxQueued: 4,
      },
      degradedQueueRatio: 0.5,
      blockedQueueRatio: 1,
    });

    const active = plane.execute(request(() => activeGate.promise, {
      key: { extra: { id: 'active' } },
    }));
    const queuedA = plane.execute(request(async () => 2, {
      key: { extra: { id: 'queued-a' } },
    }));
    const queuedB = plane.execute(request(async () => 3, {
      key: { extra: { id: 'queued-b' } },
    }));

    expect(plane.snapshot()).toMatchObject({
      health: 'degraded',
    });

    activeGate.resolve(1);
    await active;
    await queuedA;
    await queuedB;
  });

  it('marks saturated queue pressure as blocked', async () => {
    const activeGate = deferred<number>();
    const plane = createSpatialQueryControlPlane({
      queue: {
        maxConcurrent: 1,
        maxQueued: 2,
      },
      degradedQueueRatio: 0.5,
      blockedQueueRatio: 1,
    });

    const active = plane.execute(request(() => activeGate.promise, {
      key: { extra: { id: 'active' } },
    }));
    const queuedA = plane.execute(request(async () => 2, {
      key: { extra: { id: 'queued-a' } },
    }));
    const queuedB = plane.execute(request(async () => 3, {
      key: { extra: { id: 'queued-b' } },
    }));

    expect(plane.snapshot().health).toBe('blocked');

    activeGate.resolve(1);
    await active;
    await queuedA;
    await queuedB;
  });

  it('degrades health when the bounded recent failure ratio crosses policy', async () => {
    const plane = createSpatialQueryControlPlane({
      degradedFailureRatio: 0.4,
      blockedFailureRatio: 0.9,
      failureWindow: 5,
      maxHistory: 32,
    });

    for (let index = 0; index < 3; index += 1) {
      await expect(plane.execute(request(async () => {
        throw new Error('failure');
      }, {
        key: { extra: { failure: index } },
      }))).rejects.toMatchObject({
        code: 'OPERATION_FAILED',
      });
    }

    for (let index = 0; index < 2; index += 1) {
      await plane.execute(request(async () => index, {
        key: { extra: { success: index } },
      }));
    }

    expect(plane.snapshot().health).toBe('degraded');
  });

  it('marks sustained recent failures as blocked', async () => {
    const plane = createSpatialQueryControlPlane({
      degradedFailureRatio: 0.2,
      blockedFailureRatio: 0.6,
      failureWindow: 5,
      maxHistory: 32,
    });

    for (let index = 0; index < 5; index += 1) {
      await expect(plane.execute(request(async () => {
        throw new Error('failure');
      }, {
        key: { extra: { failure: index } },
      }))).rejects.toMatchObject({
        code: 'OPERATION_FAILED',
      });
    }

    expect(plane.snapshot().health).toBe('blocked');
  });

  it('returns a bounded newest-event slice', async () => {
    const plane = createSpatialQueryControlPlane({
      maxHistory: 16,
      failureWindow: 8,
    });

    await plane.execute(request(async () => 1, {
      key: { extra: { id: 1 } },
    }));
    await plane.execute(request(async () => 2, {
      key: { extra: { id: 2 } },
    }));

    const newest = plane.events(2);
    expect(newest).toHaveLength(2);
    expect(newest[1]?.sequence).toBeGreaterThan(newest[0]?.sequence ?? 0);
  });
});

describe('SpatialQueryControlPlane disposal and validation', () => {
  it('rejects empty identifiers, invalid layers and excessive tag counts', async () => {
    const plane = createSpatialQueryControlPlane({
      maxTags: 2,
    });
    const operation = vi.fn(async () => 1);

    await expect(plane.execute(request(operation, {
      ownerId: ' ',
    }))).rejects.toThrow(/ownerId/u);

    await expect(plane.execute(request(operation, {
      serviceId: ' ',
    }))).rejects.toThrow(/serviceId/u);

    await expect(plane.execute(request(operation, {
      layerId: -1,
    }))).rejects.toThrow(/layerId/u);

    await expect(plane.execute(request(operation, {
      cache: {
        tags: ['a', 'b', 'c'],
      },
    }))).rejects.toThrow(/cache tags/u);

    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects unsafe estimate ranges before admission', async () => {
    const plane = createSpatialQueryControlPlane();
    const operation = vi.fn(async () => 1);

    await expect(plane.execute(request(operation, {
      estimatedBytes: Number.POSITIVE_INFINITY,
    }))).rejects.toThrow(/estimatedBytes/u);

    await expect(plane.execute(request(operation, {
      estimatedCpuMs: -1,
    }))).rejects.toThrow(/estimatedCpuMs/u);

    expect(operation).not.toHaveBeenCalled();
  });

  it('disposes active execution and every owned subsystem deterministically', async () => {
    const started = deferred<void>();
    const plane = createSpatialQueryControlPlane();

    const execution = plane.execute(request(({ signal }) => {
      started.resolve();
      return new Promise<number>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }));

    await started.promise;
    plane.dispose('application-shutdown');

    await expect(execution).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await flush();

    expect(plane.snapshot()).toMatchObject({
      disposed: true,
      health: 'blocked',
      activeExecutions: 0,
    });
    expect(plane.snapshot().queue.disposed).toBe(true);
    expect(plane.snapshot().cache.disposed).toBe(true);
    expect(plane.snapshot().supervision.disposed).toBe(true);
  });

  it('makes disposal idempotent and rejects subsequent work', async () => {
    const plane = createSpatialQueryControlPlane();
    plane.dispose('first');
    const afterFirst = plane.snapshot();

    plane.dispose('second');
    expect(plane.snapshot()).toEqual(afterFirst);

    await expect(plane.execute(request(async () => 1))).rejects.toMatchObject({
      code: 'DISPOSED',
    });
  });

  it('exposes stable error metadata to integration callers', () => {
    const cause = new Error('cause');
    const error = new SpatialQueryControlPlaneError(
      'OPERATION_FAILED',
      'query failed',
      cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SpatialQueryControlPlaneError');
    expect(error.code).toBe('OPERATION_FAILED');
    expect(error.causeValue).toBe(cause);
  });
});
