import { describe, expect, it, vi } from 'vitest';
import { LayerListLoadCoordinator } from './layerListLoadCoordinator';

const items = Array.from({ length: 6 }, (_, index) => ({
  key: `layer-${index + 1}`,
  source: index + 1,
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('LayerListLoadCoordinator', () => {
  it('starts in an idle immutable snapshot', () => {
    const coordinator = new LayerListLoadCoordinator<number, number>();
    const snapshot = coordinator.getSnapshot();
    expect(snapshot).toMatchObject({
      revision: 0,
      status: 'idle',
      queued: 0,
      active: 0,
      progressPercent: 100,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('returns ready immediately for an empty queue', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>();
    const result = await coordinator.load([], async (item) => item.source);
    expect(result).toEqual({
      successes: [],
      failures: [],
      cancelled: false,
      generation: 1,
    });
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'ready',
      total: 0,
      completed: 0,
      progressPercent: 100,
    });
  });

  it('loads successful work and preserves source identity', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>({ concurrency: 2 });
    const result = await coordinator.load(items.slice(0, 3), async (item) => item.source * 10);
    expect(result.cancelled).toBe(false);
    expect(result.successes.map((entry) => entry.result)).toEqual([10, 20, 30]);
    expect(result.failures).toEqual([]);
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'ready',
      completed: 3,
      failed: 0,
      total: 3,
      progressPercent: 100,
      announcement: '3 katman hazır.',
    });
  });

  it('never exceeds configured concurrency', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>({ concurrency: 2 });
    let active = 0;
    let peak = 0;
    const gates = items.map(() => deferred<number>());

    const loading = coordinator.load(items, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      const result = await gates[item.source - 1]!.promise;
      active -= 1;
      return result;
    });

    await vi.waitFor(() => {
      expect(coordinator.getSnapshot().active).toBe(2);
    });
    expect(peak).toBe(2);

    gates[0]!.resolve(10);
    gates[1]!.resolve(20);
    await vi.waitFor(() => {
      expect(coordinator.getSnapshot().completed).toBe(2);
      expect(coordinator.getSnapshot().active).toBe(2);
    });

    gates[2]!.resolve(30);
    gates[3]!.resolve(40);
    await vi.waitFor(() => {
      expect(coordinator.getSnapshot().completed).toBe(4);
      expect(coordinator.getSnapshot().active).toBe(2);
    });

    gates[4]!.resolve(50);
    gates[5]!.resolve(60);
    const result = await loading;
    expect(result.successes).toHaveLength(6);
    expect(peak).toBe(2);
  });

  it('supports concurrency one for deterministic serial work', async () => {
    const order: number[] = [];
    const coordinator = new LayerListLoadCoordinator<number, number>({ concurrency: 1 });
    await coordinator.load(items.slice(0, 3), async (item) => {
      order.push(item.source);
      return item.source;
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it('caps excessive concurrency at twelve workers', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>({ concurrency: 99 });
    let active = 0;
    let peak = 0;
    const many = Array.from({ length: 20 }, (_, index) => ({ key: String(index), source: index }));
    const gate = deferred<void>();
    const loading = coordinator.load(many, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return item.source;
    });
    await vi.waitFor(() => expect(coordinator.getSnapshot().active).toBe(12));
    gate.resolve();
    await loading;
    expect(peak).toBe(12);
  });

  it('bounds the number of scheduled items', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>({ maxItems: 3 });
    const worker = vi.fn(async (item: { source: number }) => item.source);
    const result = await coordinator.load(items, worker);
    expect(worker).toHaveBeenCalledTimes(3);
    expect(result.successes).toHaveLength(3);
    expect(coordinator.getSnapshot().total).toBe(3);
  });

  it('normalizes empty item keys without changing source payload', async () => {
    const coordinator = new LayerListLoadCoordinator<{ id: number }, number>();
    const source = { id: 7 };
    const result = await coordinator.load([{ key: ' ', source }], async (item) => item.source.id);
    expect(result.successes[0]).toMatchObject({
      key: 'layer-1',
      source,
      result: 7,
    });
  });

  it('isolates individual failures and returns a partial result', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>({ concurrency: 2 });
    const result = await coordinator.load(items.slice(0, 4), async (item) => {
      if (item.source === 2 || item.source === 4) throw new TypeError('failed');
      return item.source;
    });
    expect(result.successes.map((entry) => entry.result)).toEqual([1, 3]);
    expect(result.failures).toEqual([
      expect.objectContaining({ key: 'layer-2', failureKind: 'TypeError' }),
      expect.objectContaining({ key: 'layer-4', failureKind: 'TypeError' }),
    ]);
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'partial',
      completed: 2,
      failed: 2,
      progressPercent: 100,
      announcement: '2 katman hazır, 2 katman yüklenemedi.',
    });
  });

  it('classifies non-Error rejection values without retaining messages', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>();
    const result = await coordinator.load(items.slice(0, 1), async () => Promise.reject({ token: 'secret' }));
    expect(result.failures[0]?.failureKind).toBe('object');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('publishes monotonic progress as items settle', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>({ concurrency: 1 });
    const percentages: number[] = [];
    coordinator.subscribe(() => percentages.push(coordinator.getSnapshot().progressPercent));
    await coordinator.load(items.slice(0, 4), async (item) => item.source);
    const settled = percentages.filter((value, index) => index === 0 || value !== percentages[index - 1]);
    expect(settled.at(-1)).toBe(100);
    expect(settled.every((value, index) => index === 0 || value >= settled[index - 1]!)).toBe(true);
  });

  it('cancels the active generation and ignores late results', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>({ concurrency: 1 });
    const gate = deferred<number>();
    const loading = coordinator.load(items.slice(0, 2), async () => gate.promise);
    await vi.waitFor(() => expect(coordinator.getSnapshot().active).toBe(1));
    coordinator.cancel();
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'cancelled',
      active: 0,
      queued: 0,
    });
    gate.resolve(10);
    const result = await loading;
    expect(result.cancelled).toBe(true);
    expect(result.successes).toHaveLength(0);
  });

  it('disposes late results after cancellation', async () => {
    const disposeResult = vi.fn();
    const coordinator = new LayerListLoadCoordinator<number, { destroy: () => void }>({ concurrency: 1 });
    const gate = deferred<{ destroy: () => void }>();
    const lateRuntime = { destroy: vi.fn() };
    const loading = coordinator.load(
      [{ key: 'late', source: 1 }],
      async () => gate.promise,
      disposeResult,
    );
    await vi.waitFor(() => expect(coordinator.getSnapshot().active).toBe(1));
    coordinator.cancel();
    gate.resolve(lateRuntime);
    const result = await loading;
    expect(result.cancelled).toBe(true);
    expect(result.successes).toHaveLength(0);
    expect(disposeResult).toHaveBeenCalledTimes(1);
    expect(disposeResult).toHaveBeenCalledWith(lateRuntime);
  });

  it('disposes stale results when a newer generation wins', async () => {
    const disposeResult = vi.fn();
    const coordinator = new LayerListLoadCoordinator<number, number>({ concurrency: 1 });
    const oldGate = deferred<number>();
    const oldLoad = coordinator.load(
      [{ key: 'old', source: 1 }],
      async () => oldGate.promise,
      disposeResult,
    );
    await vi.waitFor(() => expect(coordinator.getSnapshot().active).toBe(1));
    await coordinator.load([{ key: 'new', source: 2 }], async (item) => item.source);
    oldGate.resolve(10);
    await oldLoad;
    expect(disposeResult).toHaveBeenCalledWith(10);
  });

  it('a new load invalidates an older in-flight generation', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>({ concurrency: 1 });
    const oldGate = deferred<number>();
    const oldLoad = coordinator.load([{ key: 'old', source: 1 }], async () => oldGate.promise);
    await vi.waitFor(() => expect(coordinator.getSnapshot().active).toBe(1));
    const newResult = await coordinator.load([{ key: 'new', source: 2 }], async (item) => item.source);
    expect(newResult.successes[0]?.key).toBe('new');
    oldGate.resolve(1);
    const oldResult = await oldLoad;
    expect(oldResult.cancelled).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      generation: 2,
      status: 'ready',
      completed: 1,
    });
  });

  it('notifies observers on load lifecycle changes', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>();
    const observer = vi.fn();
    coordinator.subscribe(observer);
    await coordinator.load(items.slice(0, 2), async (item) => item.source);
    expect(observer.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('contains observer errors so loading can continue', async () => {
    const report = vi.fn();
    vi.stubGlobal('reportError', report);
    const coordinator = new LayerListLoadCoordinator<number, number>();
    coordinator.subscribe(() => { throw new Error('observer'); });
    await expect(coordinator.load(items.slice(0, 1), async (item) => item.source)).resolves.toMatchObject({
      cancelled: false,
    });
    expect(report).toHaveBeenCalled();
    expect(coordinator.getObserverDiagnostics()).toMatchObject({
      failureCount: expect.any(Number),
      lastFailureKind: 'Error',
      activeObserverCount: 1,
    });
    vi.unstubAllGlobals();
  });

  it('keeps healthy observers running when the observer reporter also throws', async () => {
    const healthy = vi.fn();
    const coordinator = new LayerListLoadCoordinator<number, number>({
      onObserverError: () => { throw new TypeError('reporter'); },
    });
    coordinator.subscribe(() => { throw new Error('observer'); });
    coordinator.subscribe(healthy);
    await coordinator.load(items.slice(0, 1), async (item) => item.source);
    expect(healthy).toHaveBeenCalled();
    expect(coordinator.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 2,
      lastFailureKind: 'TypeError',
      disposed: false,
    });
    expect(coordinator.getObserverDiagnostics().failureCount).toBeGreaterThanOrEqual(2);
  });

  it('tracks rejected subscriptions and terminal observer state', () => {
    const coordinator = new LayerListLoadCoordinator<number, number>({ maxObservers: 1 });
    coordinator.subscribe(vi.fn());
    coordinator.subscribe(vi.fn());
    expect(coordinator.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 1,
      rejectedObserverCount: 1,
      disposed: false,
    });
    coordinator.dispose();
    expect(coordinator.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      rejectedObserverCount: 1,
      disposed: true,
    });
  });

  it('caps observer subscriptions', () => {
    const coordinator = new LayerListLoadCoordinator<number, number>({ maxObservers: 1 });
    const first = vi.fn();
    const second = vi.fn();
    coordinator.subscribe(first);
    coordinator.subscribe(second);
    coordinator.cancel();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('dispose invalidates in-flight work and clears observers', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>({ concurrency: 1 });
    const observer = vi.fn();
    coordinator.subscribe(observer);
    const gate = deferred<number>();
    const loading = coordinator.load([{ key: 'a', source: 1 }], async () => gate.promise);
    await vi.waitFor(() => expect(coordinator.getSnapshot().active).toBe(1));
    coordinator.dispose();
    const callsAtDispose = observer.mock.calls.length;
    gate.resolve(1);
    const result = await loading;
    expect(result.cancelled).toBe(true);
    expect(coordinator.getSnapshot()).toMatchObject({
      status: 'cancelled',
      active: 0,
      queued: 0,
    });
    expect(observer).toHaveBeenCalledTimes(callsAtDispose);
  });

  it('load after disposal is a cancelled no-op', async () => {
    const coordinator = new LayerListLoadCoordinator<number, number>();
    coordinator.dispose();
    const worker = vi.fn(async (item: { source: number }) => item.source);
    const result = await coordinator.load(items, worker);
    expect(result.cancelled).toBe(true);
    expect(worker).not.toHaveBeenCalled();
  });
});
