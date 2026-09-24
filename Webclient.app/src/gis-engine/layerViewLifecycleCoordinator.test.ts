import { describe, expect, it, vi } from 'vitest';
import { LayerViewLifecycleCoordinator, type LayerViewKey, type LayerViewResource } from './layerViewLifecycleCoordinator';

const key = (layerId: string, mode: '2d' | '3d' = '2d'): LayerViewKey => ({ layerId, mode });
const resource = () => ({ dispose: vi.fn(async () => undefined), suspend: vi.fn(async () => undefined), resume: vi.fn(async () => undefined) }) satisfies LayerViewResource;

describe('LayerViewLifecycleCoordinator', () => {
  it('deduplicates concurrent ensure calls for one generation', async () => {
    let resolve!: (value: LayerViewResource) => void;
    const load = vi.fn(() => new Promise<LayerViewResource>((done) => { resolve = done; }));
    const runtime = new LayerViewLifecycleCoordinator();
    runtime.register({ key: key('roads'), priority: 'normal', load });
    const first = runtime.ensure(key('roads'));
    const second = runtime.ensure(key('roads'));
    expect(load).toHaveBeenCalledTimes(1);
    resolve(resource());
    await expect(first).resolves.toMatchObject({ phase: 'ready', generation: 1 });
    await expect(second).resolves.toMatchObject({ phase: 'ready', generation: 1 });
    expect(runtime.snapshot()).toMatchObject({ activeLoads: 0, readyResources: 1 });
  });

  it('aborts an in-flight load when suspended and ignores stale completion', async () => {
    let resolve!: (value: LayerViewResource) => void;
    let capturedSignal!: AbortSignal;
    const stale = resource();
    const runtime = new LayerViewLifecycleCoordinator();
    runtime.register({ key: key('parcels'), priority: 'normal', load: ({ signal }) => { capturedSignal = signal; return new Promise((done) => { resolve = done; }); } });
    const pending = runtime.ensure(key('parcels'));
    await runtime.suspend(key('parcels'));
    expect(capturedSignal.aborted).toBe(true);
    resolve(stale);
    await pending;
    expect(stale.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().entries[0]?.phase).toBe('suspended');
  });

  it('uses suspend/resume hooks without reloading a retained resource', async () => {
    const retained = resource();
    const load = vi.fn(async () => retained);
    const runtime = new LayerViewLifecycleCoordinator();
    runtime.register({ key: key('buildings', '3d'), priority: 'high', load });
    await runtime.ensure(key('buildings', '3d'));
    await runtime.suspend(key('buildings', '3d'));
    await runtime.ensure(key('buildings', '3d'));
    expect(retained.suspend).toHaveBeenCalledTimes(1);
    expect(retained.resume).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('evicts lower-priority LRU ready resources under pressure', async () => {
    let now = 0;
    const low = resource(); const normal = resource(); const high = resource();
    const runtime = new LayerViewLifecycleCoordinator({ maxReadyResources: 2, now: () => ++now });
    runtime.register({ key: key('low'), priority: 'low', load: async () => low });
    runtime.register({ key: key('normal'), priority: 'normal', load: async () => normal });
    runtime.register({ key: key('high', '3d'), priority: 'high', load: async () => high });
    await runtime.ensure(key('low')); await runtime.ensure(key('normal')); await runtime.ensure(key('high', '3d'));
    expect(low.dispose).toHaveBeenCalledTimes(1);
    expect(normal.dispose).not.toHaveBeenCalled();
    expect(high.dispose).not.toHaveBeenCalled();
    expect(runtime.snapshot().readyResources).toBe(2);
  });

  it('does not evict a higher-priority resident for lower-priority incoming work', async () => {
    const critical = resource(); const low = resource();
    const runtime = new LayerViewLifecycleCoordinator({ maxReadyResources: 1 });
    runtime.register({ key: key('critical'), priority: 'critical', load: async () => critical });
    runtime.register({ key: key('low'), priority: 'low', load: async () => low });
    await runtime.ensure(key('critical'));
    await runtime.ensure(key('low'));
    expect(critical.dispose).not.toHaveBeenCalled();
    expect(low.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().entries.find((entry) => entry.key.layerId === 'low')?.phase).toBe('suspended');
  });

  it('bounds concurrent loading without creating a hidden queue', async () => {
    const runtime = new LayerViewLifecycleCoordinator({ maxConcurrentLoads: 1 });
    let finish!: (value: LayerViewResource) => void;
    runtime.register({ key: key('a'), priority: 'normal', load: async () => new Promise((resolve) => { finish = resolve; }) });
    runtime.register({ key: key('b'), priority: 'normal', load: async () => resource() });
    const pending = runtime.ensure(key('a'));
    await expect(runtime.ensure(key('b'))).rejects.toThrow('concurrency exhausted');
    finish(resource()); await pending;
    await expect(runtime.ensure(key('b'))).resolves.toMatchObject({ phase: 'ready' });
  });

  it('records load failure without leaking the active-load budget', async () => {
    const runtime = new LayerViewLifecycleCoordinator({ maxConcurrentLoads: 1 });
    runtime.register({ key: key('broken'), priority: 'normal', load: async () => { throw new Error('sdk failure'); } });
    await expect(runtime.ensure(key('broken'))).resolves.toMatchObject({ phase: 'failed', error: 'sdk failure' });
    expect(runtime.snapshot().activeLoads).toBe(0);
  });

  it('removes resources deterministically and makes repeated removal idempotent', async () => {
    const owned = resource();
    const runtime = new LayerViewLifecycleCoordinator();
    runtime.register({ key: key('poi'), priority: 'high', load: async () => owned });
    await runtime.ensure(key('poi'));
    await expect(runtime.remove(key('poi'))).resolves.toBe(true);
    await expect(runtime.remove(key('poi'))).resolves.toBe(false);
    expect(owned.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().entries).toHaveLength(0);
  });

  it('disposes all retained resources and rejects future mutation', async () => {
    const a = resource(); const b = resource();
    const runtime = new LayerViewLifecycleCoordinator();
    runtime.register({ key: key('a'), priority: 'normal', load: async () => a });
    runtime.register({ key: key('b', '3d'), priority: 'normal', load: async () => b });
    await runtime.ensure(key('a')); await runtime.ensure(key('b', '3d'));
    await runtime.dispose();
    expect(a.dispose).toHaveBeenCalledTimes(1); expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toMatchObject({ disposed: true, readyResources: 0 });
    expect(() => runtime.register({ key: key('c'), priority: 'normal', load: async () => resource() })).toThrow('disposed');
  });

  it('bounds metadata and evicts oldest inactive entries', () => {
    let now = 0;
    const runtime = new LayerViewLifecycleCoordinator({ maxEntries: 2, now: () => ++now });
    const load = async () => resource();
    runtime.register({ key: key('old'), priority: 'low', load });
    runtime.register({ key: key('new'), priority: 'low', load });
    runtime.register({ key: key('latest'), priority: 'low', load });
    expect(runtime.snapshot().entries.map((entry) => entry.key.layerId)).toEqual(['latest', 'new']);
  });

  it('normalizes identifiers and keeps 2d/3d ownership independent', async () => {
    const runtime = new LayerViewLifecycleCoordinator();
    runtime.register({ key: key(' roads ', '2d'), priority: 'normal', load: async () => resource() });
    runtime.register({ key: key('roads', '3d'), priority: 'normal', load: async () => resource() });
    await runtime.ensure(key('roads', '2d')); await runtime.ensure(key('roads', '3d'));
    expect(runtime.snapshot().readyResources).toBe(2);
    expect(runtime.snapshot().entries.map((entry) => entry.key.mode)).toEqual(['2d', '3d']);
  });

  it('validates bounded configuration and empty layer identifiers', () => {
    expect(() => new LayerViewLifecycleCoordinator({ maxEntries: 0 })).toThrow('positive integer');
    const runtime = new LayerViewLifecycleCoordinator();
    expect(() => runtime.register({ key: key('  '), priority: 'normal', load: async () => resource() })).toThrow('layerId');
  });
});
