import { describe, expect, it, vi } from 'vitest';
import { createViewStateSyncCoordinator } from './viewStateSyncCoordinator';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
};

describe('createViewStateSyncCoordinator', () => {
  it('publishes 2D camera state to the registered 3D adapter', async () => {
    const apply3d = vi.fn(async () => {});
    const sync = createViewStateSyncCoordinator();
    sync.register({ id: 'map', mode: '2d', apply: vi.fn() });
    sync.register({ id: 'scene', mode: '3d', apply: apply3d });

    const snapshot = await sync.publish('map', { center: [32.8, 39.9], zoom: 12, selectedObjectId: 0 });

    expect(snapshot.revision).toBe(1);
    expect(snapshot.state.mode).toBe('2d');
    expect(snapshot.state.selectedObjectId).toBe(0);
    expect(apply3d).toHaveBeenCalledTimes(1);
    expect(apply3d.mock.calls[0]?.[0].state.center).toEqual([32.8, 39.9]);
  });

  it('does not echo a publication back to its origin adapter', async () => {
    const mapApply = vi.fn(async () => {});
    const sceneApply = vi.fn(async () => {});
    const sync = createViewStateSyncCoordinator();
    sync.register({ id: 'map', mode: '2d', apply: mapApply });
    sync.register({ id: 'scene', mode: '3d', apply: sceneApply });

    await sync.publish('map', { scale: 10_000 });

    expect(mapApply).not.toHaveBeenCalled();
    expect(sceneApply).toHaveBeenCalledTimes(1);
  });

  it('forces the canonical mode to the publishing adapter mode', async () => {
    const sync = createViewStateSyncCoordinator({ initialState: { mode: '2d' } });
    sync.register({ id: 'scene', mode: '3d', apply: vi.fn() });

    await sync.publish('scene', { mode: '2d', heading: 45, tilt: 60 });

    expect(sync.state().mode).toBe('3d');
    expect(sync.state().heading).toBe(45);
    expect(sync.state().tilt).toBe(60);
  });

  it('aborts a stale asynchronous adapter apply when newer state arrives', async () => {
    const first = deferred();
    const signals: AbortSignal[] = [];
    const states: number[] = [];
    const apply = vi.fn(async ({ state, signal }: { state: { zoom: number | null }; signal: AbortSignal }) => {
      signals.push(signal);
      states.push(state.zoom ?? -1);
      if (states.length === 1) await first.promise;
    });
    const sync = createViewStateSyncCoordinator();
    sync.register({ id: 'map', mode: '2d', apply: vi.fn() });
    sync.register({ id: 'scene', mode: '3d', apply });

    const older = sync.publish('map', { zoom: 10 });
    await Promise.resolve();
    const newer = sync.publish('map', { zoom: 11 });

    expect(signals[0]?.aborted).toBe(true);
    first.resolve();
    await Promise.all([older, newer]);
    expect(states).toEqual([10, 11]);
    expect(sync.state().zoom).toBe(11);
    expect(sync.snapshot().revision).toBe(2);
  });

  it('reports adapter failures without rolling back canonical state', async () => {
    const errors: unknown[] = [];
    const sync = createViewStateSyncCoordinator({ onAdapterError: ({ error }) => errors.push(error) });
    sync.register({ id: 'map', mode: '2d', apply: vi.fn() });
    sync.register({ id: 'scene', mode: '3d', apply: async () => { throw new Error('renderer unavailable'); } });

    const result = await sync.publish('map', { zoom: 7 });

    expect(result.state.zoom).toBe(7);
    expect(errors).toHaveLength(1);
  });

  it('rejects publications from unknown adapters', async () => {
    const sync = createViewStateSyncCoordinator();
    await expect(sync.publish('missing', { zoom: 1 })).rejects.toMatchObject({ code: 'UNKNOWN_ADAPTER' });
  });

  it('rejects duplicate adapter ownership', () => {
    const sync = createViewStateSyncCoordinator();
    sync.register({ id: 'map', mode: '2d', apply: vi.fn() });
    expect(() => sync.register({ id: 'map', mode: '3d', apply: vi.fn() })).toThrow('Duplicate view adapter id');
  });

  it('enforces bounded adapter cardinality', () => {
    const sync = createViewStateSyncCoordinator({ maximumAdapters: 1 });
    sync.register({ id: 'map', mode: '2d', apply: vi.fn() });
    expect(() => sync.register({ id: 'scene', mode: '3d', apply: vi.fn() })).toThrow('budget exceeded');
  });

  it('unregisters adapter ownership idempotently', () => {
    const sync = createViewStateSyncCoordinator();
    const unregister = sync.register({ id: 'map', mode: '2d', apply: vi.fn() });

    expect(unregister()).toBe(true);
    expect(unregister()).toBe(false);
    expect(sync.snapshot().adapterCount).toBe(0);
  });

  it('does not increment revision for semantically equal state', async () => {
    const sceneApply = vi.fn(async () => {});
    const sync = createViewStateSyncCoordinator({ initialState: { zoom: 5 } });
    sync.register({ id: 'scene', mode: '3d', apply: sceneApply });

    const result = await sync.setState({ zoom: 5 });

    expect(result.revision).toBe(0);
    expect(sceneApply).not.toHaveBeenCalled();
  });

  it('switches 2D and 3D mode through the same canonical state', async () => {
    const mapApply = vi.fn(async () => {});
    const sceneApply = vi.fn(async () => {});
    const sync = createViewStateSyncCoordinator({ initialState: { selectedLayerId: 'roads', selectedObjectId: 0 } });
    sync.register({ id: 'map', mode: '2d', apply: mapApply });
    sync.register({ id: 'scene', mode: '3d', apply: sceneApply });

    await sync.switchMode('3d');

    expect(sync.state().mode).toBe('3d');
    expect(sync.state().selectedLayerId).toBe('roads');
    expect(sync.state().selectedObjectId).toBe(0);
    expect(mapApply).toHaveBeenCalledTimes(1);
    expect(sceneApply).toHaveBeenCalledTimes(1);
  });

  it('aborts pending work and rejects future mutation after disposal', async () => {
    const gate = deferred();
    let observedSignal: AbortSignal | null = null;
    const sync = createViewStateSyncCoordinator();
    sync.register({ id: 'map', mode: '2d', apply: vi.fn() });
    sync.register({
      id: 'scene',
      mode: '3d',
      apply: async ({ signal }) => {
        observedSignal = signal;
        await gate.promise;
      },
    });

    const pending = sync.publish('map', { zoom: 9 });
    await Promise.resolve();
    sync.dispose();
    expect(observedSignal?.aborted).toBe(true);
    gate.resolve();
    await pending;
    await expect(sync.setState({ zoom: 10 })).rejects.toMatchObject({ code: 'DISPOSED' });
  });
});
