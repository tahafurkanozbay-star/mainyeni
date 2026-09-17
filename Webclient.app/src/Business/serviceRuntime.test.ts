import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  BusinessAbortError,
  BusinessTimeoutError,
  ServiceNotFoundError,
  type ArcGisQueryOptions,
  type BusinessRuntimeDependencies,
  type QueryExecutionControl,
  type ServiceDescriptor,
} from './contracts';
import { createBusinessQueryRuntime } from './serviceRuntime';

const services: readonly ServiceDescriptor[] = Object.freeze([
  Object.freeze({ title: 'Parks', eg: '/arcgis/rest/services/Parks/FeatureServer/0' }),
  Object.freeze({ title: 'Taxi', eg: '/arcgis/rest/services/Taxi/FeatureServer/0' }),
]);

const createDependencies = (overrides: Partial<BusinessRuntimeDependencies> = {}) => {
  const execute = vi.fn(async (options: ArcGisQueryOptions, _control?: QueryExecutionControl) => ({
    features: [{ attributes: { objectid: 1, where: options.where } }],
    fields: [{ name: 'objectid' }],
  }));
  const executeSpatial = vi.fn(async (options: ArcGisQueryOptions, _control?: QueryExecutionControl) => ({
    features: [{ attributes: { objectid: 2, distance: options.distance } }],
    fields: [{ name: 'objectid' }],
  }));

  const dependencies: BusinessRuntimeDependencies = {
    resolveService: {
      list: () => services,
      find: (serviceKey) => services.find((service) => service.title === serviceKey) ?? null,
      resolveUrl: (service) => typeof service.eg === 'string' ? service.eg : null,
    },
    executor: { execute, executeSpatial },
    maxDiagnostics: 20,
    maxCacheEntries: 5,
    maxConcurrent: 2,
    ...overrides,
  };

  return { dependencies, execute, executeSpatial };
};

const deferred = <TValue>() => {
  let resolve!: (value: TValue | PromiseLike<TValue>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<TValue>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('business query runtime service resolution', () => {
  test('executes standard query through injected executor', async () => {
    const { dependencies, execute, executeSpatial } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);

    const result = await runtime.query('Parks', { name: 'Çankaya' }, true, { cache: false });

    expect(result).toMatchObject({ features: [{ attributes: { objectid: 1 } }] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(executeSpatial).not.toHaveBeenCalled();
    const options = execute.mock.calls[0]?.[0] as ArcGisQueryOptions;
    expect(options.url).toBe('/arcgis/rest/services/Parks/FeatureServer/0');
    expect(options.returnGeometry).toBe(true);
    expect(options.outFields).toEqual(['*']);
    expect(options.orderByFields).toEqual(['adi']);
    expect(options.where).toContain('ÇANKAYA');
    runtime.dispose();
  });

  test('executes nearby query through spatial executor', async () => {
    const { dependencies, execute, executeSpatial } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);
    const location = { x: 33, y: 40 };

    await runtime.query('Taxi', {
      showNearby: true,
      bufferDistance: 2.5,
      userLocation: location,
    }, false, { cache: false });

    expect(execute).not.toHaveBeenCalled();
    expect(executeSpatial).toHaveBeenCalledTimes(1);
    const options = executeSpatial.mock.calls[0]?.[0] as ArcGisQueryOptions;
    expect(options.geometry).toBe(location);
    expect(options.distance).toBe(250);
    expect(options.units).toBe('meters');
    expect(options.spatialRelationship).toBe('intersects');
    runtime.dispose();
  });

  test('fails closed for missing service', async () => {
    const { dependencies } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);
    await expect(runtime.query('Missing', {}, false)).rejects.toBeInstanceOf(ServiceNotFoundError);
    expect(runtime.snapshot().failed).toBe(0);
    runtime.dispose();
  });

  test('fails closed for service with unsupported URL protocol', async () => {
    const { dependencies } = createDependencies({
      resolveService: {
        list: () => [{ title: 'Bad', eg: 'javascript:alert(1)' }],
        find: () => ({ title: 'Bad', eg: 'javascript:alert(1)' }),
        resolveUrl: () => 'javascript:alert(1)',
      },
    });
    const runtime = createBusinessQueryRuntime(dependencies);
    await expect(runtime.query('Bad')).rejects.toMatchObject({ code: 'SERVICE_URL_INVALID' });
    runtime.dispose();
  });

  test('creates stable service-bound facade', async () => {
    const { dependencies, execute } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);
    const parks = runtime.createBusiness('Parks');
    await parks.Query({ ObjectId: 7 }, false, { cache: false });
    const options = execute.mock.calls[0]?.[0] as ArcGisQueryOptions;
    expect(options.where).toContain('ObjectId = 7');
    runtime.dispose();
  });
});

describe('business query runtime cache', () => {
  test('returns cached value inside TTL', async () => {
    const { dependencies, execute } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);
    const first = await runtime.query('Parks', { name: 'Park' }, false, { cacheTtlMs: 5000 });
    const second = await runtime.query('Parks', { name: 'Park' }, false, { cacheTtlMs: 5000 });

    expect(second).toBe(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().cacheHits).toBe(1);
    expect(runtime.snapshot().diagnostics.at(-1)?.status).toBe('cache-hit');
    runtime.dispose();
  });

  test('does not cache location-bound nearby query', async () => {
    const { dependencies, executeSpatial } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);
    const query = { showNearby: true, bufferDistance: 5, userLocation: { x: 1, y: 2 } };

    await runtime.query('Parks', query, false, { cacheTtlMs: 5000 });
    await runtime.query('Parks', query, false, { cacheTtlMs: 5000 });

    expect(executeSpatial).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().cacheHits).toBe(0);
    runtime.dispose();
  });

  test('respects explicit cache false', async () => {
    const { dependencies, execute } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);
    await runtime.query('Parks', { name: 'Park' }, false, { cache: false });
    await runtime.query('Parks', { name: 'Park' }, false, { cache: false });
    expect(execute).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  test('clears all cache entries', async () => {
    const { dependencies, execute } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);
    await runtime.query('Parks', { name: 'A' }, false, { cacheTtlMs: 5000 });
    await runtime.query('Taxi', { name: 'B' }, false, { cacheTtlMs: 5000 });
    expect(runtime.clearCache()).toBe(2);
    await runtime.query('Parks', { name: 'A' }, false, { cacheTtlMs: 5000 });
    expect(execute).toHaveBeenCalledTimes(3);
    runtime.dispose();
  });

  test('clears only requested service cache', async () => {
    const { dependencies, execute } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);
    await runtime.query('Parks', { name: 'A' }, false, { cacheTtlMs: 5000 });
    await runtime.query('Taxi', { name: 'B' }, false, { cacheTtlMs: 5000 });
    expect(runtime.clearCache('Parks')).toBe(1);
    await runtime.query('Taxi', { name: 'B' }, false, { cacheTtlMs: 5000 });
    await runtime.query('Parks', { name: 'A' }, false, { cacheTtlMs: 5000 });
    expect(execute).toHaveBeenCalledTimes(3);
    runtime.dispose();
  });
});

describe('business query runtime deduplication', () => {
  test('shares in-flight promise for equivalent request', async () => {
    const gate = deferred<unknown>();
    const { dependencies, execute } = createDependencies({
      executor: {
        execute: vi.fn(() => gate.promise),
        executeSpatial: vi.fn(() => gate.promise),
      },
    });
    const runtime = createBusinessQueryRuntime(dependencies);

    const first = runtime.query('Parks', { name: 'A' }, false, { cache: false });
    const second = runtime.query('Parks', { name: 'A' }, false, { cache: false });
    await flush();
    gate.resolve({ features: [] });

    await expect(first).resolves.toEqual({ features: [] });
    await expect(second).resolves.toEqual({ features: [] });
    expect((dependencies.executor.execute as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().deduplicated).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    runtime.dispose();
  });

  test('allows dedupe opt-out', async () => {
    const gates = [deferred<unknown>(), deferred<unknown>()];
    let index = 0;
    const execute = vi.fn(() => gates[index++]?.promise ?? Promise.resolve({ features: [] }));
    const { dependencies } = createDependencies({ executor: { execute, executeSpatial: execute } });
    const runtime = createBusinessQueryRuntime(dependencies);

    const first = runtime.query('Parks', { name: 'A' }, false, { cache: false, deduplicate: false });
    const second = runtime.query('Parks', { name: 'A' }, false, { cache: false, deduplicate: false });
    await flush();
    expect(execute).toHaveBeenCalledTimes(2);
    gates[0]?.resolve({ features: [{ attributes: { id: 1 } }] });
    gates[1]?.resolve({ features: [{ attributes: { id: 2 } }] });
    await Promise.all([first, second]);
    expect(runtime.snapshot().deduplicated).toBe(0);
    runtime.dispose();
  });

  test('different request key bypasses equivalent-query dedupe', async () => {
    const gates = [deferred<unknown>(), deferred<unknown>()];
    let index = 0;
    const execute = vi.fn(() => gates[index++]?.promise ?? Promise.resolve({ features: [] }));
    const { dependencies } = createDependencies({ executor: { execute, executeSpatial: execute } });
    const runtime = createBusinessQueryRuntime(dependencies);

    const first = runtime.query('Parks', { name: 'A' }, false, { cache: false, requestKey: 'first' });
    const second = runtime.query('Parks', { name: 'A' }, false, { cache: false, requestKey: 'second' });
    await flush();
    expect(execute).toHaveBeenCalledTimes(2);
    gates.forEach((gate) => gate.resolve({ features: [] }));
    await Promise.all([first, second]);
    runtime.dispose();
  });
});

describe('business query runtime concurrency and queue', () => {
  test('enforces max concurrent executor calls', async () => {
    const firstGate = deferred<unknown>();
    const secondGate = deferred<unknown>();
    const thirdGate = deferred<unknown>();
    const gates = [firstGate, secondGate, thirdGate];
    let index = 0;
    const execute = vi.fn(() => gates[index++]?.promise ?? Promise.resolve({ features: [] }));
    const { dependencies } = createDependencies({
      executor: { execute, executeSpatial: execute },
      maxConcurrent: 2,
    });
    const runtime = createBusinessQueryRuntime(dependencies);

    const first = runtime.query('Parks', { name: 'A' }, false, { cache: false, deduplicate: false });
    const second = runtime.query('Parks', { name: 'B' }, false, { cache: false, deduplicate: false });
    const third = runtime.query('Parks', { name: 'C' }, false, { cache: false, deduplicate: false });
    await flush();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().active).toBe(2);
    expect(runtime.snapshot().queued).toBe(1);

    firstGate.resolve({ features: [] });
    await first;
    await flush();
    expect(execute).toHaveBeenCalledTimes(3);

    secondGate.resolve({ features: [] });
    thirdGate.resolve({ features: [] });
    await Promise.all([second, third]);
    expect(runtime.snapshot().active).toBe(0);
    expect(runtime.snapshot().queued).toBe(0);
    runtime.dispose();
  });

  test('cancels queued request before executor runs', async () => {
    const gate = deferred<unknown>();
    const execute = vi.fn(() => gate.promise);
    const { dependencies } = createDependencies({
      executor: { execute, executeSpatial: execute },
      maxConcurrent: 1,
    });
    const runtime = createBusinessQueryRuntime(dependencies);
    const controller = new AbortController();

    const first = runtime.query('Parks', { name: 'A' }, false, { cache: false, deduplicate: false });
    const queued = runtime.query('Parks', { name: 'B' }, false, {
      cache: false,
      deduplicate: false,
      signal: controller.signal,
    });
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    controller.abort(new BusinessAbortError('caller cancelled'));
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().cancelled).toBeGreaterThanOrEqual(1);

    gate.resolve({ features: [] });
    await first;
    runtime.dispose();
  });

  test('cancels queued requests by service key', async () => {
    const gate = deferred<unknown>();
    const execute = vi.fn(() => gate.promise);
    const { dependencies } = createDependencies({
      executor: { execute, executeSpatial: execute },
      maxConcurrent: 1,
    });
    const runtime = createBusinessQueryRuntime(dependencies);

    const running = runtime.query('Taxi', { name: 'A' }, false, { cache: false, deduplicate: false });
    const queuedParks = runtime.query('Parks', { name: 'B' }, false, { cache: false, deduplicate: false });
    const queuedTaxi = runtime.query('Taxi', { name: 'C' }, false, { cache: false, deduplicate: false });
    await flush();

    expect(runtime.cancelQueued((serviceKey) => serviceKey === 'Parks')).toBe(1);
    await expect(queuedParks).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot().queued).toBe(1);

    gate.resolve({ features: [] });
    await running;
    // The queued Taxi call can now start and is resolved by a fresh executor promise.
    await expect(queuedTaxi).resolves.toEqual({ features: [] });
    runtime.dispose();
  });
});

describe('business query runtime deadlines and cancellation', () => {
  test('enforces hard deadline even when executor ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const timeoutMs = 250;
    const execute = vi.fn(() => new Promise<unknown>(() => undefined));
    const { dependencies } = createDependencies({ executor: { execute, executeSpatial: execute } });
    const runtime = createBusinessQueryRuntime(dependencies, {
      policy: { defaultTimeoutMs: timeoutMs, maxTimeoutMs: 1000 },
    });

    const pending = runtime.query('Parks', {}, false, { cache: false, timeoutMs });
    const rejection = expect(pending).rejects.toBeInstanceOf(BusinessTimeoutError);
    await vi.advanceTimersByTimeAsync(timeoutMs + 1);
    await rejection;
    expect(runtime.snapshot().timedOut).toBe(1);
    expect(runtime.snapshot().active).toBe(0);
    runtime.dispose();
  });

  test('rejects immediately when already aborted', async () => {
    const { dependencies, execute } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);
    const controller = new AbortController();
    controller.abort(new BusinessAbortError('cancelled first'));

    await expect(runtime.query('Parks', {}, false, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    runtime.dispose();
  });

  test('propagates executor abort error', async () => {
    const execute = vi.fn(async () => { throw new BusinessAbortError('executor cancelled'); });
    const { dependencies } = createDependencies({ executor: { execute, executeSpatial: execute } });
    const runtime = createBusinessQueryRuntime(dependencies);

    await expect(runtime.query('Parks', {}, false, { cache: false })).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.snapshot().cancelled).toBe(1);
    expect(runtime.snapshot().failed).toBe(0);
    runtime.dispose();
  });

  test('records ordinary executor errors without storing error message', async () => {
    const execute = vi.fn(async () => { throw Object.assign(new Error('private payload'), { code: 'REMOTE_FAILURE' }); });
    const { dependencies } = createDependencies({ executor: { execute, executeSpatial: execute } });
    const runtime = createBusinessQueryRuntime(dependencies);

    await expect(runtime.query('Parks', {}, false, { cache: false })).rejects.toThrow('private payload');
    const snapshot = runtime.snapshot();
    expect(snapshot.failed).toBe(1);
    expect(snapshot.diagnostics.at(-1)?.code).toBe('REMOTE_FAILURE');
    expect(JSON.stringify(snapshot)).not.toContain('private payload');
    runtime.dispose();
  });
});

describe('business query runtime lifecycle and diagnostics', () => {
  test('returns immutable bounded snapshots', async () => {
    const { dependencies } = createDependencies({ maxDiagnostics: 2 });
    const runtime = createBusinessQueryRuntime(dependencies);
    await runtime.query('Parks', { name: 'A' }, false, { cache: false });
    await runtime.query('Parks', { name: 'B' }, false, { cache: false });
    await runtime.query('Parks', { name: 'C' }, false, { cache: false });

    const snapshot = runtime.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.diagnostics)).toBe(true);
    expect(snapshot.diagnostics).toHaveLength(2);
    expect(snapshot.completed).toBe(3);
    runtime.dispose();
  });

  test('dispose clears cache and rejects future work', async () => {
    const { dependencies } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);
    await runtime.query('Parks', {}, false, { cacheTtlMs: 1000 });
    runtime.dispose();
    expect(runtime.clearCache()).toBe(0);
    await expect(runtime.query('Parks')).rejects.toMatchObject({ code: 'RUNTIME_DISPOSED' });
  });

  test('dispose is idempotent', () => {
    const { dependencies } = createDependencies();
    const runtime = createBusinessQueryRuntime(dependencies);
    expect(() => runtime.dispose()).not.toThrow();
    expect(() => runtime.dispose()).not.toThrow();
  });
});