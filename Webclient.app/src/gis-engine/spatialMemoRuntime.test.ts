import {
  SpatialMemoError,
  createSpatialMemoKey,
  createSpatialMemoRuntime,
} from './spatialMemoRuntime';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('spatialMemoRuntime', () => {
  test('creates deterministic keys for geometry arguments', () => {
    const left = createSpatialMemoKey('buffer', [{ x: 1, y: 2 }, 100, 'meters']);
    const right = createSpatialMemoKey('BUFFER', [{ y: 2, x: 1 }, 100, 'meters']);
    expect(left).toBe(right);
  });

  test('allows namespaces and semantic versions in keys', () => {
    const key = createSpatialMemoKey('nearest', [{ x: 1, y: 2 }], {
      namespace: 'selection',
      version: 2,
    });
    expect(key).toContain('ns:selection');
    expect(key).toContain('v:2');
  });

  test('rejects an empty operation name', () => {
    expect(() => createSpatialMemoKey('', [])).toThrow(SpatialMemoError);
  });

  test('caches successful CPU computation results', async () => {
    const runtime = createSpatialMemoRuntime();
    const factory = jest.fn(async () => ({ area: 42 }));
    await expect(runtime.execute('area:a', factory)).resolves.toEqual({ area: 42 });
    await expect(runtime.execute('area:a', factory)).resolves.toEqual({ area: 42 });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.getStats()).toEqual(expect.objectContaining({
      requests: 2,
      computations: 1,
      cacheHits: 1,
    }));
  });

  test('deduplicates concurrent computations by stable key', async () => {
    const runtime = createSpatialMemoRuntime();
    const work = deferred();
    const factory = jest.fn(() => work.promise);
    const first = runtime.execute('buffer:a', factory);
    const second = runtime.execute('buffer:a', factory);
    expect(factory).toHaveBeenCalledTimes(1);
    work.resolve({ ok: true });
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(runtime.getStats().deduped).toBe(1);
  });

  test('can explicitly disable in-flight dedupe', async () => {
    const runtime = createSpatialMemoRuntime();
    const factory = jest.fn(async () => ({ value: factory.mock.calls.length }));
    const values = await Promise.all([
      runtime.execute('x', factory, { dedupe: false, cache: false }),
      runtime.execute('x', factory, { dedupe: false, cache: false }),
    ]);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(values).toHaveLength(2);
  });

  test('does not cache values rejected by cache policy', async () => {
    const runtime = createSpatialMemoRuntime();
    const factory = jest.fn(async () => ({ transient: true }));
    const options = { isCacheable: () => false };
    await runtime.execute('transient', factory, options);
    await runtime.execute('transient', factory, options);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(runtime.getStats().cacheSkips).toBe(2);
  });

  test('does not cache a value larger than the byte budget', async () => {
    const runtime = createSpatialMemoRuntime({ maxBytes: 10 });
    const factory = jest.fn(async () => ({ huge: 'x'.repeat(100) }));
    await runtime.execute('huge', factory);
    await runtime.execute('huge', factory);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(runtime.getStats().cacheEntries).toBe(0);
  });

  test('honors custom size estimator for typed geometry buffers', async () => {
    const runtime = createSpatialMemoRuntime({ maxBytes: 100 });
    await runtime.execute('typed', async () => ({ vertices: [1, 2, 3] }), {
      sizeOf: () => 24,
    });
    expect(runtime.getStats().cacheBytes).toBe(24);
  });

  test('evicts least-recently-used entries when entry budget is exceeded', async () => {
    const runtime = createSpatialMemoRuntime({ maxEntries: 2 });
    await runtime.execute('a', async () => 'A');
    await runtime.execute('b', async () => 'B');
    expect(runtime.read('a')).toBe('A');
    await runtime.execute('c', async () => 'C');
    expect(runtime.read('a')).toBe('A');
    expect(runtime.read('b')).toBeUndefined();
    expect(runtime.read('c')).toBe('C');
    expect(runtime.getStats().evictions).toBe(1);
  });

  test('evicts by byte budget even when entry count is below limit', async () => {
    const runtime = createSpatialMemoRuntime({ maxBytes: 20, maxEntries: 10 });
    await runtime.execute('a', async () => 'A', { sizeOf: () => 12 });
    await runtime.execute('b', async () => 'B', { sizeOf: () => 12 });
    expect(runtime.read('a')).toBeUndefined();
    expect(runtime.read('b')).toBe('B');
  });

  test('expires entries after TTL using an injected deterministic clock', async () => {
    let time = 1000;
    const runtime = createSpatialMemoRuntime({ ttlMs: 50, now: () => time });
    await runtime.execute('a', async () => 'A');
    expect(runtime.read('a')).toBe('A');
    time = 1051;
    expect(runtime.read('a')).toBeUndefined();
    expect(runtime.getStats().expirations).toBe(1);
  });

  test('sweeps expired entries without touching live values', async () => {
    let time = 0;
    const runtime = createSpatialMemoRuntime({ ttlMs: 100, now: () => time });
    await runtime.execute('short', async () => 'S', { ttlMs: 10 });
    await runtime.execute('long', async () => 'L', { ttlMs: 100 });
    time = 11;
    expect(runtime.sweepExpired()).toBe(1);
    expect(runtime.read('long')).toBe('L');
  });

  test('invalidates entries by tag for layer lifecycle cleanup', async () => {
    const runtime = createSpatialMemoRuntime();
    await runtime.execute('a', async () => 'A', { tags: ['layer:roads'] });
    await runtime.execute('b', async () => 'B', { tags: ['layer:roads', 'analysis'] });
    await runtime.execute('c', async () => 'C', { tags: ['layer:parks'] });
    expect(runtime.invalidateTag('layer:roads')).toBe(2);
    expect(runtime.read('a')).toBeUndefined();
    expect(runtime.read('c')).toBe('C');
  });

  test('invalidates entries using a predicate over cached values and metadata', async () => {
    const runtime = createSpatialMemoRuntime();
    await runtime.execute('a', async () => ({ score: 1 }));
    await runtime.execute('b', async () => ({ score: 10 }));
    expect(runtime.invalidate((value) => value.score > 5)).toBe(1);
    expect(runtime.read('a')).toEqual({ score: 1 });
    expect(runtime.read('b')).toBeUndefined();
  });

  test('cancels only the leaving subscriber while shared work still has consumers', async () => {
    const runtime = createSpatialMemoRuntime();
    const work = deferred();
    const controller = new AbortController();
    let underlyingSignal;
    const factory = jest.fn(({ signal }) => {
      underlyingSignal = signal;
      return work.promise;
    });
    const first = runtime.execute('shared', factory, { signal: controller.signal });
    const second = runtime.execute('shared', factory);
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(underlyingSignal.aborted).toBe(false);
    work.resolve('result');
    await expect(second).resolves.toBe('result');
  });

  test('aborts underlying computation after the final subscriber cancels', async () => {
    const runtime = createSpatialMemoRuntime();
    const controller = new AbortController();
    let signal;
    const factory = ({ signal: incoming }) => {
      signal = incoming;
      return new Promise((resolve, reject) => {
        incoming.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    };
    const promise = runtime.execute('cancel-all', factory, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(signal.aborted).toBe(true);
    expect(runtime.getStats().underlyingAborts).toBe(1);
  });

  test('rejects an already-cancelled request before computation starts', async () => {
    const runtime = createSpatialMemoRuntime();
    const controller = new AbortController();
    controller.abort();
    const factory = jest.fn();
    await expect(runtime.execute('cancelled', factory, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(factory).not.toHaveBeenCalled();
  });

  test('does not convert computation failures into cached successes', async () => {
    const runtime = createSpatialMemoRuntime();
    const factory = jest.fn(async () => {
      throw new Error('geometry engine failure');
    });
    await expect(runtime.execute('failure', factory)).rejects.toThrow('geometry engine failure');
    await expect(runtime.execute('failure', factory)).rejects.toThrow('geometry engine failure');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(runtime.getStats().errors).toBe(2);
  });

  test('configure shrinks a live cache to the new entry budget', async () => {
    const runtime = createSpatialMemoRuntime({ maxEntries: 4 });
    await runtime.execute('a', async () => 'A');
    await runtime.execute('b', async () => 'B');
    await runtime.execute('c', async () => 'C');
    expect(runtime.configure({ maxEntries: 1 }).maxEntries).toBe(1);
    expect(runtime.getStats().cacheEntries).toBe(1);
  });

  test('configure shrinks a live cache to the new memory budget', async () => {
    const runtime = createSpatialMemoRuntime({ maxBytes: 100 });
    await runtime.execute('a', async () => 'A', { sizeOf: () => 40 });
    await runtime.execute('b', async () => 'B', { sizeOf: () => 40 });
    runtime.configure({ maxBytes: 50 });
    expect(runtime.getStats().cacheBytes).toBeLessThanOrEqual(50);
  });

  test('clear can retain in-flight work while dropping cached geometry', async () => {
    const runtime = createSpatialMemoRuntime();
    await runtime.execute('cached', async () => 'value');
    runtime.clear();
    expect(runtime.getStats().cacheEntries).toBe(0);
  });

  test('destroy prevents new work and clears runtime state', async () => {
    const runtime = createSpatialMemoRuntime();
    await runtime.execute('cached', async () => 'value');
    runtime.destroy();
    expect(runtime.getStats().cacheEntries).toBe(0);
    await expect(runtime.execute('later', async () => 'x'))
      .rejects.toMatchObject({ code: 'RUNTIME_DESTROYED' });
  });

  test('requires a computation factory', async () => {
    const runtime = createSpatialMemoRuntime();
    await expect(runtime.execute('x', null)).rejects.toMatchObject({ code: 'INVALID_FACTORY' });
  });
});
