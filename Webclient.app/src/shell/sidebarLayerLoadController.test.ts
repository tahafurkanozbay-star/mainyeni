import { describe, expect, it, vi } from 'vitest';
import { createSidebarLayerLoadController } from './sidebarLayerLoadController';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('createSidebarLayerLoadController', () => {
  it('starts with an immutable idle snapshot', () => {
    const controller = createSidebarLayerLoadController({
      serviceKeys: ['a', 'b'],
      loadLayer: async (key) => ({ key }),
    });
    const snapshot = controller.getSnapshot();
    expect(snapshot).toMatchObject({
      phase: 'idle',
      totalCount: 2,
      completedCount: 0,
      loadedCount: 0,
      failedCount: 0,
      pendingCount: 2,
      activeCount: 0,
      attempt: 0,
      revision: 0,
      canRetry: false,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.loadedLayers)).toBe(true);
    expect(Object.isFrozen(snapshot.failures)).toBe(true);
  });

  it('loads every admitted service and finishes ready', async () => {
    const loadLayer = vi.fn(async (key: string) => ({ key }));
    const controller = createSidebarLayerLoadController({ serviceKeys: ['a', 'b', 'c'], loadLayer });
    await controller.start();
    expect(loadLayer).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      totalCount: 3,
      completedCount: 3,
      loadedCount: 3,
      failedCount: 0,
      pendingCount: 0,
      activeCount: 0,
      canRetry: false,
    });
    expect(controller.getSnapshot().loadedLayers.map((entry) => entry.serviceKey)).toEqual(['a', 'b', 'c']);
  });

  it('preserves input order even when loads resolve out of order', async () => {
    const waits = new Map([
      ['a', deferred<{ key: string } | null>()],
      ['b', deferred<{ key: string } | null>()],
      ['c', deferred<{ key: string } | null>()],
    ]);
    const controller = createSidebarLayerLoadController({
      serviceKeys: ['a', 'b', 'c'],
      concurrency: 3,
      loadLayer: (key) => waits.get(key)!.promise,
    });
    const run = controller.start();
    await flush();
    waits.get('c')!.resolve({ key: 'c' });
    waits.get('a')!.resolve({ key: 'a' });
    waits.get('b')!.resolve({ key: 'b' });
    await run;
    expect(controller.getSnapshot().loadedLayers.map((entry) => entry.serviceKey)).toEqual(['a', 'b', 'c']);
  });

  it('never exceeds the configured concurrency budget', async () => {
    let active = 0;
    let peak = 0;
    const gates = new Map<string, Deferred<{ key: string } | null>>();
    const loadLayer = vi.fn((key: string) => {
      active += 1;
      peak = Math.max(peak, active);
      const gate = deferred<{ key: string } | null>();
      gates.set(key, gate);
      return gate.promise.finally(() => { active -= 1; });
    });
    const controller = createSidebarLayerLoadController({
      serviceKeys: ['a', 'b', 'c', 'd', 'e'],
      concurrency: 2,
      loadLayer,
    });
    const run = controller.start();
    await vi.waitFor(() => expect(loadLayer).toHaveBeenCalledTimes(2));
    expect(peak).toBe(2);
    gates.get('a')!.resolve({ key: 'a' });
    await vi.waitFor(() => expect(loadLayer).toHaveBeenCalledTimes(3));
    gates.get('b')!.resolve({ key: 'b' });
    await vi.waitFor(() => expect(loadLayer).toHaveBeenCalledTimes(4));
    gates.get('c')!.resolve({ key: 'c' });
    gates.get('d')!.resolve({ key: 'd' });
    await vi.waitFor(() => expect(loadLayer).toHaveBeenCalledTimes(5));
    gates.get('e')!.resolve({ key: 'e' });
    await run;
    expect(peak).toBe(2);
  });

  it('clamps concurrency above the hard maximum', async () => {
    let active = 0;
    let peak = 0;
    const gates: Deferred<object | null>[] = [];
    const controller = createSidebarLayerLoadController({
      serviceKeys: Array.from({ length: 12 }, (_, index) => `service-${index}`),
      concurrency: 100,
      loadLayer: async () => {
        active += 1;
        peak = Math.max(peak, active);
        const gate = deferred<object | null>();
        gates.push(gate);
        const result = await gate.promise;
        active -= 1;
        return result;
      },
    });
    const run = controller.start();
    await flush();
    expect(peak).toBe(8);
    while (gates.length > 0) {
      const batch = gates.splice(0, gates.length);
      batch.forEach((gate) => gate.resolve({}));
      await flush();
    }
    await run;
  });

  it('treats a null layer as a degraded result', async () => {
    const controller = createSidebarLayerLoadController({
      serviceKeys: ['a', 'b'],
      loadLayer: async (key) => key === 'a' ? { key } : null,
    });
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'degraded',
      loadedCount: 1,
      failedCount: 1,
      canRetry: true,
    });
    expect(controller.getSnapshot().failures).toEqual([
      { serviceKey: 'b', kind: 'empty-result', attempt: 1 },
    ]);
    expect(controller.getDiagnostics()).toMatchObject({
      loaderFailureCount: 1,
      lastLoaderFailureKind: 'empty-result',
    });
  });

  it('sanitizes thrown loader errors to their error kind', async () => {
    const controller = createSidebarLayerLoadController({
      serviceKeys: ['private'],
      loadLayer: async () => { throw new TypeError('sensitive endpoint detail'); },
    });
    await controller.start();
    expect(controller.getSnapshot().failures).toEqual([
      { serviceKey: 'private', kind: 'TypeError', attempt: 1 },
    ]);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('sensitive endpoint detail');
    expect(controller.getDiagnostics()).toMatchObject({
      loaderFailureCount: 1,
      lastLoaderFailureKind: 'TypeError',
    });
  });

  it('retries only failed services while preserving successful layers', async () => {
    const attempts = new Map<string, number>();
    const loadLayer = vi.fn(async (key: string) => {
      const next = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, next);
      if (key === 'b' && next === 1) return null;
      return { key, next };
    });
    const controller = createSidebarLayerLoadController({ serviceKeys: ['a', 'b', 'c'], loadLayer });
    await controller.start();
    expect(controller.getSnapshot().phase).toBe('degraded');
    expect(loadLayer).toHaveBeenCalledTimes(3);
    await controller.retryFailed();
    expect(loadLayer).toHaveBeenCalledTimes(4);
    expect(attempts.get('a')).toBe(1);
    expect(attempts.get('b')).toBe(2);
    expect(attempts.get('c')).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', loadedCount: 3, failedCount: 0 });
  });

  it('does nothing when retry is requested without failures', async () => {
    const loadLayer = vi.fn(async (key: string) => ({ key }));
    const controller = createSidebarLayerLoadController({ serviceKeys: ['a'], loadLayer });
    await controller.start();
    await controller.retryFailed();
    expect(loadLayer).toHaveBeenCalledTimes(1);
  });

  it('returns the same in-flight promise when start is called twice', async () => {
    const gate = deferred<object | null>();
    const controller = createSidebarLayerLoadController({ serviceKeys: ['a'], loadLayer: () => gate.promise });
    const first = controller.start();
    const second = controller.start();
    expect(second).toBe(first);
    gate.resolve({});
    await first;
  });

  it('cancels queued work and ignores late in-flight results', async () => {
    const gates = new Map<string, Deferred<object | null>>();
    const loadLayer = vi.fn((key: string) => {
      const gate = deferred<object | null>();
      gates.set(key, gate);
      return gate.promise;
    });
    const controller = createSidebarLayerLoadController({
      serviceKeys: ['a', 'b', 'c'],
      concurrency: 1,
      loadLayer,
    });
    const run = controller.start();
    await flush();
    expect(loadLayer).toHaveBeenCalledTimes(1);
    controller.cancel();
    expect(controller.getSnapshot().phase).toBe('cancelled');
    gates.get('a')!.resolve({ late: true });
    await run;
    expect(controller.getSnapshot().loadedCount).toBe(0);
    expect(loadLayer).toHaveBeenCalledTimes(1);
  });

  it('can restart remaining work after cancellation', async () => {
    const first = deferred<object | null>();
    let call = 0;
    const controller = createSidebarLayerLoadController({
      serviceKeys: ['a'],
      loadLayer: () => {
        call += 1;
        return call === 1 ? first.promise : Promise.resolve({ recovered: true });
      },
    });
    const initialRun = controller.start();
    await flush();
    controller.cancel();
    first.resolve({ ignored: true });
    await initialRun;
    await controller.start();
    expect(call).toBe(2);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', loadedCount: 1 });
  });

  it('tracks active and pending counts while work is running', async () => {
    const a = deferred<object | null>();
    const b = deferred<object | null>();
    const controller = createSidebarLayerLoadController({
      serviceKeys: ['a', 'b', 'c'],
      concurrency: 2,
      loadLayer: (key) => key === 'a' ? a.promise : key === 'b' ? b.promise : Promise.resolve({ key }),
    });
    const run = controller.start();
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'loading', activeCount: 2, pendingCount: 1 });
    a.resolve({ key: 'a' });
    await flush();
    expect(controller.getSnapshot().completedCount).toBeGreaterThanOrEqual(1);
    b.resolve({ key: 'b' });
    await run;
    expect(controller.getSnapshot().pendingCount).toBe(0);
  });

  it('publishes progress revisions to subscribers', async () => {
    const listener = vi.fn();
    const controller = createSidebarLayerLoadController({
      serviceKeys: ['a'],
      loadLayer: async () => ({}),
    });
    const unsubscribe = controller.subscribe(listener);
    await controller.start();
    expect(listener).toHaveBeenCalled();
    expect(controller.getSnapshot().revision).toBeGreaterThan(0);
    const calls = listener.mock.calls.length;
    unsubscribe();
    await controller.start();
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('isolates observer failures from healthy progress observers', async () => {
    const healthy = vi.fn();
    const controller = createSidebarLayerLoadController({
      serviceKeys: ['a'],
      loadLayer: async () => ({}),
    });
    controller.subscribe(() => { throw new RangeError('private observer detail'); });
    controller.subscribe(healthy);
    await expect(controller.start()).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalled();
    expect(controller.getDiagnostics()).toMatchObject({
      observerFailureCount: expect.any(Number),
      lastObserverFailureKind: 'RangeError',
    });
    expect(JSON.stringify(controller.getDiagnostics())).not.toContain('private observer detail');
  });

  it('freezes diagnostics snapshots', () => {
    const controller = createSidebarLayerLoadController({ serviceKeys: [], loadLayer: async () => ({}) });
    expect(Object.isFrozen(controller.getDiagnostics())).toBe(true);
  });

  it('announces loading, degraded and ready states without raw errors', async () => {
    let fail = true;
    const controller = createSidebarLayerLoadController({
      serviceKeys: ['a'],
      loadLayer: async () => {
        if (fail) throw new Error('private detail');
        return {};
      },
    });
    const first = controller.start();
    expect(controller.getSnapshot().announcement).toMatch(/0\/1/u);
    await first;
    expect(controller.getSnapshot().announcement).toMatch(/hazır.*hazırlanamadı/u);
    fail = false;
    await controller.retryFailed();
    expect(controller.getSnapshot().announcement).toBe('1 harita katmanı hazır.');
  });

  it('rejects duplicate service keys', () => {
    expect(() => createSidebarLayerLoadController({
      serviceKeys: ['a', 'a'],
      loadLayer: async () => ({}),
    })).toThrow(/Duplicate sidebar layer service key/u);
  });

  it('rejects empty service keys', () => {
    expect(() => createSidebarLayerLoadController({
      serviceKeys: ['a', ' '],
      loadLayer: async () => ({}),
    })).toThrow(/cannot be empty/u);
  });

  it('rejects oversized service keys', () => {
    expect(() => createSidebarLayerLoadController({
      serviceKeys: ['x'.repeat(161)],
      loadLayer: async () => ({}),
    })).toThrow(RangeError);
  });

  it('rejects catalogs beyond the bounded admission budget', () => {
    expect(() => createSidebarLayerLoadController({
      serviceKeys: Array.from({ length: 129 }, (_, index) => `key-${index}`),
      loadLayer: async () => ({}),
    })).toThrow(RangeError);
  });

  it('supports an empty catalog as an immediate ready state', async () => {
    const controller = createSidebarLayerLoadController({ serviceKeys: [], loadLayer: async () => ({}) });
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', totalCount: 0, loadedCount: 0 });
  });
});