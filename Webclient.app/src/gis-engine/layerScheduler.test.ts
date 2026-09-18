import {
  LAYER_LOAD_PRIORITY,
  LayerSchedulerError,
  applyRuntimeToSdkLayer,
  computeLayerPriority,
  createLayerLoadPlan,
  createLayerLoadScheduler,
  createLayerResidencyTracker,
  createLayerRuntimeLoader,
} from './layerScheduler';
import {
  LAYER_STATUS,
  createLayerTree,
  layerReducer,
} from './layerRuntime';

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

const descriptor = (id, overrides = {}) => ({
  id,
  title: id,
  runtime: {
    visible: true,
    opacity: 1,
    minScale: 0,
    maxScale: 0,
    status: LAYER_STATUS.IDLE,
    ...(overrides.runtime || {}),
  },
  sdkLayer: overrides.sdkLayer || null,
  ...overrides,
});

describe('layerScheduler planning', () => {
  test('selected layer has the strongest priority', () => {
    const layer = descriptor('parks');
    expect(computeLayerPriority(layer, { selectedLayerId: 'parks' }))
      .toBe(LAYER_LOAD_PRIORITY.SELECTED);
  });

  test('user requested priority wins over ordinary visibility', () => {
    const layer = descriptor('parks');
    expect(computeLayerPriority(layer, {
      visibleIds: ['parks'],
      userRequestedIds: ['parks'],
    })).toBe(LAYER_LOAD_PRIORITY.USER_REQUESTED);
  });

  test('visible priority wins over prefetch', () => {
    const layer = descriptor('parks');
    expect(computeLayerPriority(layer, {
      visibleIds: ['parks'],
      prefetchIds: ['parks'],
    })).toBe(LAYER_LOAD_PRIORITY.VISIBLE);
  });

  test('prefetch gets a low but non-background priority', () => {
    expect(computeLayerPriority(descriptor('parks'), {
      prefetchIds: ['parks'],
    })).toBe(LAYER_LOAD_PRIORITY.PREFETCH);
  });

  test('unmentioned layers remain background priority', () => {
    expect(computeLayerPriority(descriptor('parks'))).toBe(LAYER_LOAD_PRIORITY.BACKGROUND);
  });

  test('plan includes visible leaves at the current ArcGIS scale', () => {
    const tree = createLayerTree([
      { id: 'group', children: ['roads', 'parks'] },
      { id: 'roads', minScale: 500000, maxScale: 10000 },
      { id: 'parks', minScale: 5000, maxScale: 1000 },
    ]);

    const plan = createLayerLoadPlan(tree, 100000);

    expect(plan.visibleIds).toEqual(['roads']);
    expect(plan.load.map(({ layer }) => layer.id)).toEqual(['roads']);
  });

  test('hidden parent suppresses child from plan', () => {
    let tree = createLayerTree([
      { id: 'group', children: ['roads'] },
      { id: 'roads' },
    ]);
    tree = layerReducer(tree, {
      type: 'SET_VISIBLE',
      layerId: 'group',
      visible: false,
    });

    expect(createLayerLoadPlan(tree, 10000).load).toEqual([]);
  });

  test('selected layer can remain desired outside ordinary visible set', () => {
    const tree = createLayerTree([
      { id: 'parks', visible: false, minScale: 1000, maxScale: 500 },
    ]);

    const plan = createLayerLoadPlan(tree, 100000, { selectedLayerId: 'parks' });

    expect(plan.desiredIds).toContain('parks');
    expect(plan.load).toHaveLength(1);
    expect(plan.load[0]).toMatchObject({ selected: true, priority: LAYER_LOAD_PRIORITY.SELECTED });
  });

  test('prefetch does not force a layer outside its scale range', () => {
    const tree = createLayerTree([
      { id: 'parks', minScale: 1000, maxScale: 500 },
    ]);

    const plan = createLayerLoadPlan(tree, 100000, { prefetchIds: ['parks'] });

    expect(plan.desiredIds).toContain('parks');
    expect(plan.load).toEqual([]);
  });

  test('user-requested layer can override scale range intentionally', () => {
    const tree = createLayerTree([
      { id: 'parks', minScale: 1000, maxScale: 500 },
    ]);

    const plan = createLayerLoadPlan(tree, 100000, { userRequestedIds: ['parks'] });

    expect(plan.load).toHaveLength(1);
    expect(plan.load[0].userRequested).toBe(true);
  });

  test('disabled layers are excluded even when user requested', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    tree = layerReducer(tree, { type: 'SET_DISABLED', layerId: 'parks', disabled: true });

    expect(createLayerLoadPlan(tree, 10000, {
      userRequestedIds: ['parks'],
    }).load).toEqual([]);
  });

  test('plan marks loaded no-longer-desired layers for unload', () => {
    let tree = createLayerTree([
      { id: 'roads', visible: true },
      { id: 'old', visible: false },
    ]);
    tree = layerReducer(tree, { type: 'SET_SDK_LAYER', layerId: 'old', sdkLayer: { id: 'old-sdk' } });

    const plan = createLayerLoadPlan(tree, 10000);

    expect(plan.unload.map((layer) => layer.id)).toEqual(['old']);
  });

  test('plan order is deterministic by priority then layer id', () => {
    const tree = createLayerTree([
      { id: 'z' },
      { id: 'a' },
      { id: 'selected' },
    ]);

    const plan = createLayerLoadPlan(tree, 10000, { selectedLayerId: 'selected' });

    expect(plan.load.map(({ layer }) => layer.id)).toEqual(['selected', 'a', 'z']);
  });
});

describe('applyRuntimeToSdkLayer', () => {
  test('applies visibility opacity and scale range to ArcGIS layer', () => {
    const sdkLayer = {};
    const layer = descriptor('parks', {
      runtime: {
        visible: false,
        opacity: 0.35,
        minScale: 250000,
        maxScale: 5000,
      },
    });

    expect(applyRuntimeToSdkLayer(layer, sdkLayer)).toBe(true);
    expect(sdkLayer).toEqual({
      visible: false,
      opacity: 0.35,
      minScale: 250000,
      maxScale: 5000,
    });
  });

  test('clamps opacity before assigning it to SDK layer', () => {
    const sdkLayer = {};
    applyRuntimeToSdkLayer(descriptor('parks', {
      runtime: { visible: true, opacity: 9, minScale: 0, maxScale: 0 },
    }), sdkLayer);
    expect(sdkLayer.opacity).toBe(1);
  });

  test('returns false when descriptor or SDK layer is unavailable', () => {
    expect(applyRuntimeToSdkLayer(null, {})).toBe(false);
    expect(applyRuntimeToSdkLayer(descriptor('a'), null)).toBe(false);
  });
});

describe('layer residency tracker', () => {
  test('touch records deterministic last-used time', () => {
    let clock = 100;
    const tracker = createLayerResidencyTracker({ now: () => clock });

    expect(tracker.touch('parks')).toMatchObject({ layerId: 'parks', lastUsedAt: 100, pinned: false });
    clock = 200;
    expect(tracker.touch('parks', { source: 'identify' })).toMatchObject({
      layerId: 'parks', lastUsedAt: 200, source: 'identify',
    });
    expect(tracker.size()).toBe(1);
  });

  test('idleCandidates excludes active and pinned layers', () => {
    let clock = 0;
    const tracker = createLayerResidencyTracker({ idleMs: 100, now: () => clock });
    tracker.touch('old');
    tracker.touch('active');
    tracker.touch('pinned');
    tracker.pin('pinned');
    clock = 101;

    expect(tracker.idleCandidates(['active']).map((record) => record.layerId)).toEqual(['old']);
  });

  test('idleCandidates orders oldest first', () => {
    let clock = 0;
    const tracker = createLayerResidencyTracker({ idleMs: 10, now: () => clock });
    tracker.touch('a');
    clock = 5;
    tracker.touch('b');
    clock = 20;

    expect(tracker.idleCandidates().map((record) => record.layerId)).toEqual(['a', 'b']);
  });

  test('forget and clear release residency records', () => {
    const tracker = createLayerResidencyTracker();
    tracker.touch('a');
    tracker.touch('b');
    expect(tracker.forget('a')).toBe(true);
    expect(tracker.get('a')).toBeNull();
    tracker.clear();
    expect(tracker.size()).toBe(0);
  });
});

describe('layer load scheduler', () => {
  test('enforces max concurrency', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 2 });
    const requests = [deferred(), deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;
    const loader = jest.fn(({ layer }) => {
      const index = Number(layer.id);
      active += 1;
      peak = Math.max(peak, active);
      return requests[index].promise.finally(() => { active -= 1; });
    });

    const promises = [0, 1, 2, 3].map((id) => scheduler.schedule({ id: String(id) }, loader));
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);

    requests[0].resolve('0');
    requests[1].resolve('1');
    await flush();
    await flush();
    expect(loader).toHaveBeenCalledTimes(4);
    expect(peak).toBe(2);

    requests[2].resolve('2');
    requests[3].resolve('3');
    await expect(Promise.all(promises)).resolves.toEqual(['0', '1', '2', '3']);
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, peakConcurrent: 2 });
  });

  test('orders queued work by priority', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 1 });
    const blocker = deferred();
    const order = [];
    const loader = jest.fn(({ layer }) => {
      order.push(layer.id);
      if (layer.id === 'blocker') return blocker.promise;
      return Promise.resolve(layer.id);
    });

    const first = scheduler.schedule({ id: 'blocker' }, loader, { priority: 1 });
    const low = scheduler.schedule({ id: 'low' }, loader, { priority: 10 });
    const high = scheduler.schedule({ id: 'high' }, loader, { priority: 500 });
    const medium = scheduler.schedule({ id: 'medium' }, loader, { priority: 100 });
    await flush();
    expect(order).toEqual(['blocker']);

    blocker.resolve('blocker');
    await first;
    await Promise.all([low, high, medium]);

    expect(order).toEqual(['blocker', 'high', 'medium', 'low']);
  });

  test('preserves FIFO order for equal priorities', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 1 });
    const blocker = deferred();
    const order = [];
    const loader = ({ layer }) => {
      order.push(layer.id);
      return layer.id === 'blocker' ? blocker.promise : Promise.resolve(layer.id);
    };

    const running = scheduler.schedule({ id: 'blocker' }, loader, { priority: 100 });
    const a = scheduler.schedule({ id: 'a' }, loader, { priority: 100 });
    const b = scheduler.schedule({ id: 'b' }, loader, { priority: 100 });
    const c = scheduler.schedule({ id: 'c' }, loader, { priority: 100 });
    blocker.resolve('blocker');
    await running;
    await Promise.all([a, b, c]);

    expect(order).toEqual(['blocker', 'a', 'b', 'c']);
  });

  test('deduplicates same-layer queued work', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 1 });
    const request = deferred();
    const loader = jest.fn(() => request.promise);

    const first = scheduler.schedule({ id: 'parks' }, loader);
    const second = scheduler.schedule({ id: 'parks' }, loader);
    await flush();

    expect(loader).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot()).toMatchObject({ tracked: 1, active: 1 });
    request.resolve('layer');
    await expect(Promise.all([first, second])).resolves.toEqual(['layer', 'layer']);
    expect(scheduler.snapshot().deduped).toBe(1);
  });

  test('higher-priority duplicate reprioritizes queued work', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 1 });
    const blocker = deferred();
    const order = [];
    const loader = ({ layer }) => {
      order.push(layer.id);
      return layer.id === 'blocker' ? blocker.promise : Promise.resolve(layer.id);
    };

    const running = scheduler.schedule({ id: 'blocker' }, loader, { priority: 100 });
    const parksA = scheduler.schedule({ id: 'parks' }, loader, { priority: 10 });
    const roads = scheduler.schedule({ id: 'roads' }, loader, { priority: 100 });
    const parksB = scheduler.schedule({ id: 'parks' }, loader, { priority: 500 });
    expect(scheduler.snapshot().reprioritized).toBe(1);

    blocker.resolve('blocker');
    await running;
    await Promise.all([parksA, parksB, roads]);
    expect(order).toEqual(['blocker', 'parks', 'roads']);
  });

  test('lower-priority duplicate never downgrades existing queue priority', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 1 });
    const blocker = deferred();
    const loader = ({ layer }) => layer.id === 'blocker' ? blocker.promise : Promise.resolve(layer.id);
    const running = scheduler.schedule({ id: 'blocker' }, loader);
    const first = scheduler.schedule({ id: 'parks' }, loader, { priority: 500 });
    const second = scheduler.schedule({ id: 'parks' }, loader, { priority: 1 });

    expect(scheduler.snapshot().queue.find((item) => item.layerId === 'parks').priority).toBe(500);
    blocker.resolve('done');
    await running;
    await Promise.all([first, second]);
  });

  test('one consumer can cancel without aborting shared load', async () => {
    const scheduler = createLayerLoadScheduler();
    const request = deferred();
    let sharedSignal;
    const loader = jest.fn(({ signal }) => {
      sharedSignal = signal;
      return request.promise;
    });
    const a = new AbortController();
    const b = new AbortController();

    const first = scheduler.schedule({ id: 'parks' }, loader, { signal: a.signal });
    const second = scheduler.schedule({ id: 'parks' }, loader, { signal: b.signal });
    await flush();
    a.abort();

    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sharedSignal.aborted).toBe(false);
    request.resolve('sdk-layer');
    await expect(second).resolves.toBe('sdk-layer');
  });

  test('last consumer cancellation aborts running SDK work', async () => {
    const scheduler = createLayerLoadScheduler();
    let sharedSignal;
    const loader = ({ signal }) => {
      sharedSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
          name: 'AbortError',
        })));
      });
    };
    const controller = new AbortController();

    const pending = scheduler.schedule({ id: 'parks' }, loader, { signal: controller.signal });
    await flush();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sharedSignal.aborted).toBe(true);
    expect(scheduler.snapshot().underlyingAborts).toBe(1);
  });

  test('pre-cancelled requests never enter queue', async () => {
    const scheduler = createLayerLoadScheduler();
    const controller = new AbortController();
    controller.abort();
    const loader = jest.fn();

    await expect(scheduler.schedule({ id: 'parks' }, loader, {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(loader).not.toHaveBeenCalled();
    expect(scheduler.snapshot()).toMatchObject({ tracked: 0, queued: 0, active: 0 });
  });

  test('queued request is removed when its only consumer cancels', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 1 });
    const blocker = deferred();
    const loader = jest.fn(({ layer }) => layer.id === 'blocker' ? blocker.promise : Promise.resolve(layer.id));
    const running = scheduler.schedule({ id: 'blocker' }, loader);
    const controller = new AbortController();
    const queued = scheduler.schedule({ id: 'parks' }, loader, { signal: controller.signal });

    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(scheduler.has('parks')).toBe(false);
    blocker.resolve('blocker');
    await running;
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('cancel explicitly rejects all subscribers', async () => {
    const scheduler = createLayerLoadScheduler();
    const request = deferred();
    const first = scheduler.schedule({ id: 'parks' }, () => request.promise);
    const second = scheduler.schedule({ id: 'parks' }, () => request.promise);
    await flush();

    expect(scheduler.cancel('parks', 'scale changed')).toBe(true);
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  test('cancel returns false for an unknown layer', () => {
    const scheduler = createLayerLoadScheduler();
    expect(scheduler.cancel('unknown')).toBe(false);
  });

  test('cancelExcept preserves desired work and cancels the rest', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 1 });
    const blocker = deferred();
    const running = scheduler.schedule({ id: 'active' }, () => blocker.promise);
    const keep = scheduler.schedule({ id: 'keep' }, () => Promise.resolve('keep'));
    const drop = scheduler.schedule({ id: 'drop' }, () => Promise.resolve('drop'));

    expect(scheduler.cancelExcept(['active', 'keep'])).toBe(1);
    await expect(drop).rejects.toMatchObject({ code: 'CANCELLED' });
    blocker.resolve('active');
    await running;
    await expect(keep).resolves.toBe('keep');
  });

  test('reprioritize changes queued order', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 1 });
    const blocker = deferred();
    const order = [];
    const loader = ({ layer }) => {
      order.push(layer.id);
      return layer.id === 'blocker' ? blocker.promise : Promise.resolve(layer.id);
    };
    const running = scheduler.schedule({ id: 'blocker' }, loader);
    const a = scheduler.schedule({ id: 'a' }, loader, { priority: 10 });
    const b = scheduler.schedule({ id: 'b' }, loader, { priority: 20 });

    expect(scheduler.reprioritize('a', 100)).toBe(true);
    blocker.resolve('blocker');
    await running;
    await Promise.all([a, b]);
    expect(order).toEqual(['blocker', 'a', 'b']);
  });

  test('reprioritize ignores running layers', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 1 });
    const request = deferred();
    const pending = scheduler.schedule({ id: 'parks' }, () => request.promise);
    await flush();

    expect(scheduler.reprioritize('parks', 999)).toBe(false);
    request.resolve('done');
    await pending;
  });

  test('setMaxConcurrent can increase throughput for queued work', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 1 });
    const requests = [deferred(), deferred(), deferred()];
    const loader = jest.fn(({ layer }) => requests[Number(layer.id)].promise);
    const promises = [0, 1, 2].map((id) => scheduler.schedule({ id: String(id) }, loader));
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);

    expect(scheduler.setMaxConcurrent(3)).toBe(3);
    await flush();
    expect(loader).toHaveBeenCalledTimes(3);
    requests.forEach((request, index) => request.resolve(index));
    await Promise.all(promises);
  });

  test('setMaxConcurrent is bounded to protect client resources', () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 4 });
    expect(scheduler.setMaxConcurrent(999)).toBe(16);
    expect(scheduler.snapshot().maxConcurrent).toBe(16);
  });

  test('records successful load timing metrics', async () => {
    let clock = 100;
    const scheduler = createLayerLoadScheduler({ now: () => clock });
    const pending = scheduler.schedule({ id: 'parks' }, () => {
      clock = 145;
      return Promise.resolve('layer');
    });

    await pending;
    expect(scheduler.snapshot()).toMatchObject({
      completed: 1,
      failed: 0,
      totalLoadMs: 45,
      lastLoadMs: 45,
    });
  });

  test('records loader failures and propagates original error', async () => {
    const scheduler = createLayerLoadScheduler();
    const error = new Error('layer failed');

    await expect(scheduler.schedule({ id: 'parks' }, () => Promise.reject(error)))
      .rejects.toBe(error);
    expect(scheduler.snapshot()).toMatchObject({ failed: 1, completed: 0 });
  });

  test('emits observability events without trusting event listener code', async () => {
    const events = [];
    const scheduler = createLayerLoadScheduler({
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === 'started') throw new Error('observer failed');
      },
    });

    await expect(scheduler.schedule({ id: 'parks' }, () => Promise.resolve('layer')))
      .resolves.toBe('layer');
    expect(events).toEqual(['enqueued', 'started', 'completed']);
  });

  test('snapshot exposes queue and running state without internal objects', async () => {
    const scheduler = createLayerLoadScheduler({ maxConcurrent: 1 });
    const blocker = deferred();
    const running = scheduler.schedule({ id: 'running' }, () => blocker.promise);
    const queued = scheduler.schedule({ id: 'queued' }, () => Promise.resolve('queued'), {
      priority: 50,
    });
    await flush();

    const snapshot = scheduler.snapshot();
    expect(snapshot.running).toEqual([expect.objectContaining({ layerId: 'running', state: 'running' })]);
    expect(snapshot.queue).toEqual([expect.objectContaining({ layerId: 'queued', priority: 50 })]);
    blocker.resolve('running');
    await running;
    await queued;
  });

  test('rejects empty layer ids', async () => {
    const scheduler = createLayerLoadScheduler();
    await expect(scheduler.schedule({ id: '' }, () => Promise.resolve()))
      .rejects.toBeInstanceOf(LayerSchedulerError);
  });

  test('rejects missing loader function', async () => {
    const scheduler = createLayerLoadScheduler();
    await expect(scheduler.schedule({ id: 'parks' }, null))
      .rejects.toMatchObject({ code: 'INVALID_LAYER_LOADER' });
  });

  test('destroy cancels tracked work and prevents future scheduling', async () => {
    const scheduler = createLayerLoadScheduler();
    const request = deferred();
    const pending = scheduler.schedule({ id: 'parks' }, () => request.promise);
    await flush();

    scheduler.destroy();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(scheduler.schedule({ id: 'roads' }, () => Promise.resolve()))
      .rejects.toMatchObject({ code: 'SCHEDULER_DESTROYED' });
  });
});

describe('layer runtime loader integration', () => {
  let tree;
  let scheduler;
  let residency;
  let loadLayer;
  let unloadLayer;
  let runtime;

  beforeEach(() => {
    tree = createLayerTree([
      { id: 'roads', opacity: 0.5, minScale: 500000, maxScale: 10000 },
      { id: 'parks', visible: false },
      { id: 'old', visible: false },
    ]);
    tree = layerReducer(tree, {
      type: 'SET_SDK_LAYER',
      layerId: 'old',
      sdkLayer: { id: 'old-sdk' },
    });
    scheduler = createLayerLoadScheduler({ maxConcurrent: 2 });
    residency = createLayerResidencyTracker({ idleMs: 1000 });
    loadLayer = jest.fn(async (layer) => ({ id: `${layer.id}-sdk` }));
    unloadLayer = jest.fn().mockResolvedValue(undefined);
    runtime = createLayerRuntimeLoader({
      scheduler,
      getTree: () => tree,
      setTree: (next) => { tree = next; },
      loadLayer,
      unloadLayer,
      residency,
      now: () => 1000,
    });
  });

  test('load transitions layer runtime through loading to ready', async () => {
    const sdkLayer = await runtime.load(tree.byId.get('roads'), {
      priority: LAYER_LOAD_PRIORITY.VISIBLE,
      featureCount: 12,
    });

    expect(sdkLayer).toMatchObject({
      id: 'roads-sdk',
      visible: true,
      opacity: 0.5,
      minScale: 500000,
      maxScale: 10000,
    });
    expect(tree.byId.get('roads')).toMatchObject({
      sdkLayer,
      runtime: {
        status: LAYER_STATUS.READY,
        featureCount: 12,
        requestId: null,
      },
    });
  });

  test('load marks zero-feature layer as empty', async () => {
    await runtime.load(tree.byId.get('roads'), { featureCount: 0 });
    expect(tree.byId.get('roads').runtime.status).toBe(LAYER_STATUS.EMPTY);
  });

  test('load marks real failures as error', async () => {
    loadLayer.mockRejectedValueOnce(Object.assign(new Error('service down'), { code: 'SERVICE_DOWN' }));

    await expect(runtime.load(tree.byId.get('roads'))).rejects.toThrow('service down');
    expect(tree.byId.get('roads').runtime).toMatchObject({
      status: LAYER_STATUS.ERROR,
      error: { code: 'SERVICE_DOWN', message: 'service down' },
    });
  });

  test('cancelled load returns layer to idle rather than error', async () => {
    const controller = new AbortController();
    loadLayer.mockImplementationOnce(({ id }) => new Promise((resolve) => setTimeout(() => resolve({ id }), 10)));

    const pending = runtime.load(tree.byId.get('roads'), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(tree.byId.get('roads').runtime.status).toBe(LAYER_STATUS.IDLE);
  });

  test('unload calls SDK cleanup and clears descriptor reference', async () => {
    await runtime.unload('old', 'idle');

    expect(unloadLayer).toHaveBeenCalledWith(
      { id: 'old-sdk' },
      expect.objectContaining({ id: 'old' }),
      'idle',
    );
    expect(tree.byId.get('old').sdkLayer).toBeNull();
  });

  test('reconcile loads visible layers and unloads no-longer-desired layers', async () => {
    const result = await runtime.reconcile(100000);

    expect(result.plan.visibleIds).toEqual(['roads']);
    expect(loadLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'roads' }),
      expect.objectContaining({ priority: LAYER_LOAD_PRIORITY.VISIBLE }),
    );
    expect(unloadLayer).toHaveBeenCalledWith(
      { id: 'old-sdk' },
      expect.objectContaining({ id: 'old' }),
      'idle',
    );
    expect(tree.byId.get('roads').sdkLayer).toMatchObject({ id: 'roads-sdk' });
    expect(tree.byId.get('old').sdkLayer).toBeNull();
  });

  test('reconcile reuses an already loaded desired layer instead of reloading it', async () => {
    tree = layerReducer(tree, {
      type: 'SET_SDK_LAYER',
      layerId: 'roads',
      sdkLayer: { id: 'roads-existing' },
    });

    await runtime.reconcile(100000);

    expect(loadLayer).not.toHaveBeenCalled();
    expect(tree.byId.get('roads').sdkLayer).toMatchObject({
      id: 'roads-existing',
      opacity: 0.5,
    });
  });

  test('reconcile loads a selected hidden layer as an explicit user focus', async () => {
    await runtime.reconcile(100000, { selectedLayerId: 'parks' });

    expect(loadLayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'parks' }),
      expect.objectContaining({ priority: LAYER_LOAD_PRIORITY.SELECTED }),
    );
  });

  test('reconcile reports loader failure without failing all other layer results', async () => {
    tree = createLayerTree([{ id: 'a' }, { id: 'b' }]);
    loadLayer.mockImplementation(async (layer) => {
      if (layer.id === 'a') throw new Error('a failed');
      return { id: `${layer.id}-sdk` };
    });

    const result = await runtime.reconcile(10000);

    expect(result.loaded).toHaveLength(2);
    expect(result.loaded.map((entry) => entry.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(tree.byId.get('a').runtime.status).toBe(LAYER_STATUS.ERROR);
    expect(tree.byId.get('b').runtime.status).toBe(LAYER_STATUS.READY);
  });
});
