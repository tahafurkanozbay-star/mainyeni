import {
  QueryRuntimeError,
  createArcGisQueryCachePolicy,
  createQueryRuntime,
  createQueryRuntimeKey,
} from './queryRuntime';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('queryRuntime', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('deduplicates identical in-flight work', async () => {
    const runtime = createQueryRuntime();
    const request = deferred();
    const factory = jest.fn(() => request.promise);

    const first = runtime.execute('parks:all', factory, { cache: false });
    const second = runtime.execute('parks:all', factory, { cache: false });
    await flush();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.getStats()).toMatchObject({
      requests: 2,
      networkStarts: 1,
      deduped: 1,
      inFlight: 1,
      subscribers: 2,
    });

    request.resolve({ features: [1] });
    await expect(first).resolves.toEqual({ features: [1] });
    await expect(second).resolves.toEqual({ features: [1] });
    expect(runtime.getStats().inFlight).toBe(0);
  });

  test('lets one consumer cancel without cancelling another consumer', async () => {
    const runtime = createQueryRuntime();
    const request = deferred();
    let sharedSignal;
    const factory = jest.fn(({ signal }) => {
      sharedSignal = signal;
      return request.promise;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = runtime.execute('roads', factory, {
      signal: firstController.signal,
      cache: false,
    });
    const second = runtime.execute('roads', factory, {
      signal: secondController.signal,
      cache: false,
    });
    await flush();

    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED', key: 'roads' });
    expect(sharedSignal?.aborted).toBe(false);
    expect(runtime.getStats()).toMatchObject({
      cancellations: 1,
      sharedAborts: 0,
      subscribers: 1,
    });

    request.resolve({ features: [2] });
    await expect(second).resolves.toEqual({ features: [2] });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('aborts shared SDK work after the last consumer leaves', async () => {
    const runtime = createQueryRuntime();
    let sharedSignal;
    const never = new Promise(() => {});
    const factory = jest.fn(({ signal }) => {
      sharedSignal = signal;
      return never;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = runtime.execute('buildings', factory, {
      signal: firstController.signal,
      cache: false,
    });
    const second = runtime.execute('buildings', factory, {
      signal: secondController.signal,
      cache: false,
    });
    await flush();

    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sharedSignal?.aborted).toBe(false);

    secondController.abort();
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sharedSignal?.aborted).toBe(true);
    expect(runtime.getStats()).toMatchObject({
      cancellations: 2,
      sharedAborts: 1,
      subscribers: 0,
    });
  });

  test('rejects a pre-aborted consumer before starting network work', async () => {
    const runtime = createQueryRuntime();
    const factory = jest.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(runtime.execute('cancelled', factory, {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(factory).not.toHaveBeenCalled();
    expect(runtime.getStats().networkStarts).toBe(0);
  });

  test('serves a complete result from cache until TTL expiry', async () => {
    let clock = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const runtime = createQueryRuntime({ ttlMs: 5000 });
    const factory = jest.fn().mockResolvedValue({ features: [{ id: 1 }] });

    await expect(runtime.execute('cached', factory)).resolves.toEqual({
      features: [{ id: 1 }],
    });
    clock = 4000;
    await expect(runtime.execute('cached', factory)).resolves.toEqual({
      features: [{ id: 1 }],
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.getStats()).toMatchObject({
      cacheHits: 1,
      cacheWrites: 1,
      cacheEntries: 1,
    });

    clock = 7000;
    await runtime.execute('cached', factory);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(runtime.getStats().cacheExpirations).toBe(1);
  });

  test('allows per-request TTL overrides', async () => {
    let clock = 100;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const runtime = createQueryRuntime({ ttlMs: 5000 });
    const factory = jest.fn().mockResolvedValue('value');

    await runtime.execute('short-lived', factory, { ttlMs: 50 });
    clock = 151;
    await runtime.execute('short-lived', factory, { ttlMs: 50 });

    expect(factory).toHaveBeenCalledTimes(2);
  });

  test('does not cache when cache=false', async () => {
    const runtime = createQueryRuntime();
    const factory = jest.fn().mockResolvedValue({ ok: true });

    await runtime.execute('live', factory, { cache: false });
    await runtime.execute('live', factory, { cache: false });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(runtime.getStats()).toMatchObject({
      cacheEntries: 0,
      cacheWrites: 0,
      cacheSkips: 2,
    });
  });

  test('does not cache values rejected by the cacheability policy', async () => {
    const runtime = createQueryRuntime();
    const factory = jest.fn().mockResolvedValue({
      features: [1, 2],
      exceededTransferLimit: true,
    });
    const policy = createArcGisQueryCachePolicy();

    await runtime.execute('partial', factory, policy);
    await runtime.execute('partial', factory, policy);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(runtime.getStats()).toMatchObject({ cacheEntries: 0, cacheSkips: 2 });
  });

  test('caches complete ArcGIS-style results', async () => {
    const runtime = createQueryRuntime();
    const factory = jest.fn().mockResolvedValue({
      data: [{ attr: { OBJECTID: 1 } }],
      exceededTransferLimit: false,
      page: { hasMore: false },
    });
    const policy = createArcGisQueryCachePolicy({ ttlMs: 1000, tags: ['parks'] });

    await runtime.execute('complete', factory, policy);
    await runtime.execute('complete', factory, policy);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.peek('complete')).toMatchObject({ tags: ['parks'] });
  });

  test('accepts numeric ArcGIS service-result type values in cache policy contracts', async () => {
    const runtime = createQueryRuntime();
    const factory = jest.fn().mockResolvedValue({
      type: 10,
      data: [{ attr: { OBJECTID: 1 } }],
      exceededTransferLimit: false,
      page: { hasMore: false },
    });
    const policy = createArcGisQueryCachePolicy();

    await runtime.execute('numeric-service-result', factory, policy);
    await runtime.execute('numeric-service-result', factory, policy);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.peek('numeric-service-result')).not.toBeNull();
  });

  test('treats page.hasMore as incomplete even if transfer flag is absent', async () => {
    const runtime = createQueryRuntime();
    const factory = jest.fn().mockResolvedValue({
      data: [{ attr: { OBJECTID: 1 } }],
      page: { hasMore: true },
    });

    await runtime.execute('page', factory, createArcGisQueryCachePolicy());
    expect(runtime.peek('page')).toBeNull();
  });

  test('evicts the least recently used entry when maxEntries is exceeded', async () => {
    const runtime = createQueryRuntime({ maxEntries: 2, maxBytes: 100000 });
    const factory = (value) => jest.fn().mockResolvedValue(value);

    await runtime.execute('a', factory('A'));
    await runtime.execute('b', factory('B'));
    expect(runtime.getCached('a')).toBe('A');
    await runtime.execute('c', factory('C'));

    expect(runtime.getCached('a')).toBe('A');
    expect(runtime.getCached('b')).toBeUndefined();
    expect(runtime.getCached('c')).toBe('C');
    expect(runtime.getStats().cacheEvictions).toBe(1);
  });

  test('respects the byte budget and evicts older entries', async () => {
    const runtime = createQueryRuntime({ maxEntries: 10, maxBytes: 10 });
    const sizeOf = () => 6;

    await runtime.execute('a', () => Promise.resolve('A'), { sizeOf });
    await runtime.execute('b', () => Promise.resolve('B'), { sizeOf });

    expect(runtime.peek('a')).toBeNull();
    expect(runtime.peek('b')).not.toBeNull();
    expect(runtime.getStats()).toMatchObject({ cacheBytes: 6, cacheEvictions: 1 });
  });

  test('skips an individual value larger than the whole byte budget', async () => {
    const runtime = createQueryRuntime({ maxBytes: 4 });

    await runtime.execute('huge', () => Promise.resolve('value'), {
      sizeOf: () => 100,
    });

    expect(runtime.peek('huge')).toBeNull();
    expect(runtime.getStats().cacheSkips).toBe(1);
  });

  test('invalidates a single cache key', async () => {
    const runtime = createQueryRuntime();
    await runtime.execute('a', () => Promise.resolve('A'));
    await runtime.execute('b', () => Promise.resolve('B'));

    expect(runtime.invalidate('a')).toBe(1);
    expect(runtime.getCached('a')).toBeUndefined();
    expect(runtime.getCached('b')).toBe('B');
  });

  test('invalidates entries by semantic tag', async () => {
    const runtime = createQueryRuntime();
    await runtime.execute('parks:1', () => Promise.resolve(1), { tags: ['parks'] });
    await runtime.execute('parks:2', () => Promise.resolve(2), { tags: ['parks', 'poi'] });
    await runtime.execute('roads:1', () => Promise.resolve(3), { tags: ['roads'] });

    expect(runtime.invalidateTag('parks')).toBe(2);
    expect(runtime.peek('parks:1')).toBeNull();
    expect(runtime.peek('parks:2')).toBeNull();
    expect(runtime.peek('roads:1')).not.toBeNull();
  });

  test('invalidates entries with a custom predicate', async () => {
    const runtime = createQueryRuntime();
    await runtime.execute('a', () => Promise.resolve({ version: 1 }));
    await runtime.execute('b', () => Promise.resolve({ version: 2 }));

    expect(runtime.invalidate((value) => value.version < 2)).toBe(1);
    expect(runtime.peek('a')).toBeNull();
    expect(runtime.peek('b')).not.toBeNull();
  });

  test('sweeps expired entries without touching live cache values', async () => {
    let clock = 10;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const runtime = createQueryRuntime({ ttlMs: 100 });

    await runtime.execute('old', () => Promise.resolve(1), { ttlMs: 20 });
    await runtime.execute('live', () => Promise.resolve(2), { ttlMs: 100 });
    clock = 31;

    expect(runtime.sweepExpired()).toBe(1);
    expect(runtime.peek('old')).toBeNull();
    expect(runtime.peek('live')).not.toBeNull();
  });

  test('dedupe=false intentionally starts separate requests', async () => {
    const runtime = createQueryRuntime();
    const firstRequest = deferred();
    const secondRequest = deferred();
    const factory = jest.fn()
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise);

    const first = runtime.execute('same', factory, { cache: false, dedupe: false });
    const second = runtime.execute('same', factory, { cache: false, dedupe: false });
    await flush();

    expect(factory).toHaveBeenCalledTimes(2);
    firstRequest.resolve(1);
    secondRequest.resolve(2);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
  });

  test('factory failures are not cached', async () => {
    const runtime = createQueryRuntime();
    const factory = jest.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('recovered');

    await expect(runtime.execute('retry', factory)).rejects.toThrow('network');
    await expect(runtime.execute('retry', factory)).resolves.toBe('recovered');

    expect(factory).toHaveBeenCalledTimes(2);
    expect(runtime.getStats()).toMatchObject({ errors: 1, successes: 1 });
  });

  test('prefetch warms the cache for a later interactive caller', async () => {
    const runtime = createQueryRuntime();
    const factory = jest.fn().mockResolvedValue({ id: 1 });

    await runtime.prefetch('prefetched', factory);
    await expect(runtime.execute('prefetched', factory)).resolves.toEqual({ id: 1 });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.getStats().cacheHits).toBe(1);
  });

  test('clear removes cache entries without aborting work by default', async () => {
    const runtime = createQueryRuntime();
    await runtime.execute('cached', () => Promise.resolve('value'));
    const request = deferred();
    let signal;
    const pending = runtime.execute('pending', ({ signal: requestSignal }) => {
      signal = requestSignal;
      return request.promise;
    }, { cache: false });
    await flush();

    runtime.clear();
    expect(runtime.peek('cached')).toBeNull();
    expect(signal?.aborted).toBe(false);

    request.resolve('done');
    await expect(pending).resolves.toBe('done');
  });

  test('clear can abort all shared in-flight work', async () => {
    const runtime = createQueryRuntime();
    let signal;
    const pending = runtime.execute('pending', ({ signal: requestSignal }) => {
      signal = requestSignal;
      return new Promise((resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
          name: 'AbortError',
        })));
      });
    }, { cache: false });
    await flush();

    runtime.clear({ abortInFlight: true });
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow('aborted');
    expect(runtime.getStats().inFlight).toBe(0);
  });

  test('destroy aborts work and rejects future execution', async () => {
    const runtime = createQueryRuntime();
    const controller = new AbortController();
    const pending = runtime.execute('pending', ({ signal }) => new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('stopped')));
    }), { signal: controller.signal, cache: false });
    await flush();

    runtime.destroy();
    await expect(pending).rejects.toThrow('stopped');
    await expect(runtime.execute('future', () => Promise.resolve(1))).rejects.toMatchObject({
      code: 'RUNTIME_DESTROYED',
    });
  });

  test('configure tightens cache limits and evicts immediately', async () => {
    const runtime = createQueryRuntime({ maxEntries: 3, maxBytes: 1000 });
    await runtime.execute('a', () => Promise.resolve('a'));
    await runtime.execute('b', () => Promise.resolve('b'));
    await runtime.execute('c', () => Promise.resolve('c'));

    expect(runtime.configure({ maxEntries: 1 })).toMatchObject({ maxEntries: 1 });
    expect(runtime.getStats().cacheEntries).toBe(1);
    expect(runtime.peek('c')).not.toBeNull();
  });

  test('records request durations for observability', async () => {
    let clock = 100;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const runtime = createQueryRuntime();

    const result = runtime.execute('timed', () => {
      clock = 145;
      return Promise.resolve('done');
    }, { cache: false });
    await expect(result).resolves.toBe('done');

    expect(runtime.getStats()).toMatchObject({
      totalDurationMs: 45,
      lastDurationMs: 45,
    });
  });

  test('requires a stable non-empty key', async () => {
    const runtime = createQueryRuntime();

    await expect(runtime.execute('', () => Promise.resolve(1))).rejects.toMatchObject({
      code: 'INVALID_QUERY_KEY',
    });
  });

  test('requires a request factory', async () => {
    const runtime = createQueryRuntime();

    await expect(runtime.execute('key', null)).rejects.toMatchObject({
      code: 'INVALID_QUERY_FACTORY',
    });
  });

  test('builds deterministic service-operation keys', () => {
    expect(createQueryRuntimeKey({
      serviceUrl: ' /arcgis/rest/services/Parks/FeatureServer/0/ ',
      operation: 'COUNT',
      queryKey: 'where=1=1',
    })).toBe('count:/arcgis/rest/services/Parks/FeatureServer/0:where=1=1');
  });

  test('rejects service runtime keys without a URL', () => {
    expect(() => createQueryRuntimeKey({ operation: 'count' })).toThrow(QueryRuntimeError);
  });

  test('exposes immutable snapshots instead of internal cache records', async () => {
    const runtime = createQueryRuntime();
    await runtime.execute('tagged', () => Promise.resolve('value'), { tags: ['a'] });

    const snapshot = runtime.peek('tagged');
    snapshot.tags.push('mutated');

    expect(runtime.peek('tagged').tags).toEqual(['a']);
  });
});
