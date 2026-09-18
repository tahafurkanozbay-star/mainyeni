import {
  GIS_LAYER_STATE,
  LayerLifecycleRuntimeError,
  createLayerLifecycleRuntime,
} from './layerLifecycleRuntime';

const FEATURE_URL = 'https://example.test/arcgis/rest/services/Kent/FeatureServer/0';

const createHarness = (options = {}) => {
  let nextInstance = 1;
  const calls = [];
  const adapters = {
    create: jest.fn(async (descriptor) => {
      const instance = {
        id: descriptor.id,
        serial: nextInstance,
        visible: false,
      };
      nextInstance += 1;
      calls.push(['create', descriptor.id]);
      return instance;
    }),
    attach: jest.fn(async (instance, view) => {
      calls.push(['attach', instance.id, view.id]);
    }),
    detach: jest.fn(async (instance, context) => {
      calls.push(['detach', instance.id, context.reason]);
    }),
    destroy: jest.fn(async (instance, context) => {
      calls.push(['destroy', instance.id, context.reason]);
    }),
    setVisible: jest.fn(async (instance, visible, context) => {
      instance.visible = visible;
      calls.push(['visible', instance.id, visible, context.reason]);
    }),
    suspend: jest.fn(async (instance, context) => {
      calls.push(['suspend', instance.id, context.reason]);
    }),
    resume: jest.fn(async (instance, context) => {
      calls.push(['resume', instance.id, context.reason]);
    }),
  };
  const runtime = createLayerLifecycleRuntime({
    adapters,
    ...options,
  });
  return { runtime, adapters, calls };
};

describe('createLayerLifecycleRuntime', () => {
  test('registers verified ArcGIS REST layers without constructing network endpoints', () => {
    const { runtime } = createHarness();
    const layer = runtime.registerLayer('roads', {
      resourceUrl: FEATURE_URL,
      estimatedBytes: 2048,
      priority: 5,
    });

    expect(layer).toMatchObject({
      id: 'roads',
      resourceUrl: FEATURE_URL,
      state: GIS_LAYER_STATE.REGISTERED,
      resident: false,
      estimatedBytes: 2048,
      priority: 5,
    });
    expect(runtime.getSnapshot().metrics.registered).toBe(1);
  });

  test('rejects WMS/WFS resources at the lifecycle boundary', () => {
    const { runtime } = createHarness();

    expect(() => runtime.registerLayer('forbidden', {
      resourceUrl: 'https://example.test/geoserver/wfs?service=WFS',
    })).toThrow();

    expect(runtime.getSnapshot().layerCount).toBe(0);
  });

  test('deduplicates concurrent resident creation through the serialized transition lane', async () => {
    const { runtime, adapters } = createHarness();
    runtime.registerLayer('poi', { resourceUrl: FEATURE_URL });

    const [first, second, third] = await Promise.all([
      runtime.ensureResident('poi'),
      runtime.ensureResident('poi'),
      runtime.ensureResident('poi'),
    ]);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(adapters.create).toHaveBeenCalledTimes(1);
    expect(runtime.getLayer('poi').state).toBe(GIS_LAYER_STATE.DETACHED);
    await runtime.destroy();
  });

  test('attaches a resident layer once and preserves idempotency for the same view', async () => {
    const { runtime, adapters } = createHarness();
    runtime.registerLayer('buildings', { resourceUrl: FEATURE_URL });

    const view = { id: '2d-main' };
    const first = await runtime.attach('buildings', view);
    const second = await runtime.attach('buildings', view);

    expect(first).toBe(second);
    expect(adapters.create).toHaveBeenCalledTimes(1);
    expect(adapters.attach).toHaveBeenCalledTimes(1);
    expect(runtime.getLayer('buildings')).toMatchObject({
      state: GIS_LAYER_STATE.ATTACHED,
      attachedViewKey: '2d-main',
      visible: true,
    });
    await runtime.destroy();
  });

  test('detaches before switching a layer from a 2D view to a 3D view', async () => {
    const { runtime, calls } = createHarness();
    runtime.registerLayer('parcels', { resourceUrl: FEATURE_URL });

    await runtime.attach('parcels', { id: 'map-2d' });
    await runtime.attach('parcels', { id: 'scene-3d' });

    const attach2dIndex = calls.findIndex((item) => item[0] === 'attach' && item[2] === 'map-2d');
    const detachIndex = calls.findIndex((item) => item[0] === 'detach' && item[2] === 'view-switch');
    const attach3dIndex = calls.findIndex((item) => item[0] === 'attach' && item[2] === 'scene-3d');

    expect(attach2dIndex).toBeGreaterThanOrEqual(0);
    expect(detachIndex).toBeGreaterThan(attach2dIndex);
    expect(attach3dIndex).toBeGreaterThan(detachIndex);
    expect(runtime.getLayer('parcels').attachedViewKey).toBe('scene-3d');
    await runtime.destroy();
  });

  test('tracks ownership references and blocks normal eviction while the layer is retained', async () => {
    const { runtime, adapters } = createHarness();
    runtime.registerLayer('owned', { resourceUrl: FEATURE_URL });
    await runtime.ensureResident('owned');

    const releaseA = runtime.retain('owned', 'query-window');
    runtime.retain('owned', 'selection-overlay');

    await expect(runtime.evict('owned')).resolves.toBe(false);
    expect(adapters.destroy).not.toHaveBeenCalled();

    expect(releaseA()).toBe(true);
    expect(runtime.release('owned', 'selection-overlay')).toBe(true);
    await expect(runtime.evict('owned')).resolves.toBe(true);
    expect(adapters.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.getLayer('owned').state).toBe(GIS_LAYER_STATE.EVICTED);
    await runtime.destroy();
  });

  test('pinned layers survive budget sweeps until explicitly force-evicted', async () => {
    const { runtime } = createHarness({
      maxResidentLayers: 1,
      maxResidentBytes: 1024,
      idleTtlMs: 0,
    });
    runtime.registerLayer('base', {
      resourceUrl: FEATURE_URL,
      pinned: true,
      estimatedBytes: 900,
    });
    runtime.registerLayer('overlay', {
      resourceUrl: FEATURE_URL,
      estimatedBytes: 900,
    });

    await runtime.ensureResident('base');
    await runtime.ensureResident('overlay');
    const result = await runtime.sweep({ reason: 'memory-pressure' });

    expect(result.evicted).toBe(1);
    expect(runtime.getLayer('base').resident).toBe(true);
    expect(runtime.getLayer('overlay').resident).toBe(false);

    await expect(runtime.evict('base')).resolves.toBe(false);
    await expect(runtime.evict('base', { force: true })).resolves.toBe(true);
    await runtime.destroy();
  });

  test('evicts the least valuable idle layer first when resident count exceeds budget', async () => {
    let now = 0;
    const { runtime } = createHarness({
      now: () => now,
      maxResidentLayers: 2,
      maxResidentBytes: 100000,
      idleTtlMs: 0,
    });

    runtime.registerLayer('important', {
      resourceUrl: FEATURE_URL,
      priority: 1,
      estimatedBytes: 100,
    });
    runtime.registerLayer('normal', {
      resourceUrl: FEATURE_URL,
      priority: 50,
      estimatedBytes: 100,
    });
    runtime.registerLayer('disposable', {
      resourceUrl: FEATURE_URL,
      priority: 500,
      estimatedBytes: 100,
    });

    await runtime.ensureResident('important');
    now += 10;
    await runtime.ensureResident('normal');
    now += 10;
    await runtime.ensureResident('disposable');

    const result = await runtime.sweep({ reason: 'count-budget' });
    expect(result.evicted).toBe(1);
    expect(runtime.getLayer('important').resident).toBe(true);
    expect(runtime.getLayer('normal').resident).toBe(true);
    expect(runtime.getLayer('disposable').resident).toBe(false);
    await runtime.destroy();
  });

  test('enforces resident byte budget independently of layer count', async () => {
    const { runtime } = createHarness({
      maxResidentLayers: 10,
      maxResidentBytes: 1500,
      idleTtlMs: 0,
    });
    runtime.registerLayer('a', {
      resourceUrl: FEATURE_URL,
      estimatedBytes: 1000,
      priority: 1,
    });
    runtime.registerLayer('b', {
      resourceUrl: FEATURE_URL,
      estimatedBytes: 1000,
      priority: 100,
    });

    await runtime.ensureResident('a');
    await runtime.ensureResident('b');
    const result = await runtime.sweep({ reason: 'byte-budget' });

    expect(result.residentBytes).toBeLessThanOrEqual(1500);
    expect(runtime.getLayer('a').resident).toBe(true);
    expect(runtime.getLayer('b').resident).toBe(false);
    await runtime.destroy();
  });

  test('idle TTL reclaims unowned residents even when hard budgets are not exceeded', async () => {
    let now = 100;
    const { runtime } = createHarness({
      now: () => now,
      maxResidentLayers: 10,
      maxResidentBytes: 100000,
      idleTtlMs: 50,
    });
    runtime.registerLayer('idle', { resourceUrl: FEATURE_URL });
    await runtime.ensureResident('idle');

    now = 200;
    const result = await runtime.sweep({ reason: 'idle-sweep' });

    expect(result.evicted).toBe(1);
    expect(runtime.getLayer('idle').state).toBe(GIS_LAYER_STATE.EVICTED);
    await runtime.destroy();
  });

  test('suspend and resume keep the same resident instance while dropping visible load', async () => {
    const { runtime, adapters } = createHarness();
    runtime.registerLayer('scene', { resourceUrl: FEATURE_URL });
    const instance = await runtime.attach('scene', { id: 'scene-view' });

    await expect(runtime.suspend('scene', 'frame-pressure')).resolves.toBe(true);
    expect(runtime.getLayer('scene')).toMatchObject({
      state: GIS_LAYER_STATE.SUSPENDED,
      visible: false,
      resident: true,
      attachedViewKey: 'scene-view',
    });

    await expect(runtime.resume('scene')).resolves.toBe(true);
    expect(runtime.getLayer('scene')).toMatchObject({
      state: GIS_LAYER_STATE.ATTACHED,
      visible: true,
      resident: true,
    });
    expect(await runtime.ensureResident('scene')).toBe(instance);
    expect(adapters.create).toHaveBeenCalledTimes(1);
    await runtime.destroy();
  });

  test('visible layer budget demotes unowned low-value layers without destroying them', async () => {
    const { runtime } = createHarness({
      maxVisibleLayers: 1,
      maxResidentLayers: 10,
      idleTtlMs: 0,
    });
    runtime.registerLayer('important', {
      resourceUrl: FEATURE_URL,
      priority: 1,
    });
    runtime.registerLayer('optional', {
      resourceUrl: FEATURE_URL,
      priority: 100,
    });

    await runtime.attach('important', { id: 'map' });
    await runtime.attach('optional', { id: 'map' });

    const snapshot = runtime.getSnapshot();
    expect(snapshot.visibleLayers).toBe(1);
    expect(runtime.getLayer('important').visible).toBe(true);
    expect(runtime.getLayer('optional').visible).toBe(false);
    expect(runtime.getLayer('optional').resident).toBe(true);
    expect(snapshot.metrics.visibilityDemotions).toBe(1);
    await runtime.destroy();
  });

  test('owned visible layers are not automatically demoted by the visibility budget', async () => {
    const { runtime } = createHarness({
      maxVisibleLayers: 1,
      maxResidentLayers: 10,
      idleTtlMs: 0,
    });
    runtime.registerLayer('owned-visible', {
      resourceUrl: FEATURE_URL,
      priority: 100,
    });
    runtime.registerLayer('other', {
      resourceUrl: FEATURE_URL,
      priority: 1,
    });
    runtime.retain('owned-visible', 'active-tool');

    await runtime.attach('owned-visible', { id: 'map' });
    await runtime.attach('other', { id: 'map' });

    expect(runtime.getLayer('owned-visible').visible).toBe(true);
    expect(runtime.getSnapshot().visibleLayers).toBe(1);
    await runtime.destroy();
  });

  test('updating budgets immediately reconciles resident pressure', async () => {
    const { runtime } = createHarness({
      maxResidentLayers: 4,
      maxResidentBytes: 100000,
      idleTtlMs: 0,
    });

    ['one', 'two', 'three'].forEach((id, index) => runtime.registerLayer(id, {
      resourceUrl: FEATURE_URL,
      priority: index,
      estimatedBytes: 500,
    }));
    await runtime.ensureResident('one');
    await runtime.ensureResident('two');
    await runtime.ensureResident('three');

    const result = await runtime.updateBudgets({
      maxResidentLayers: 1,
      maxResidentBytes: 1000,
    });

    expect(result.residentLayers).toBe(1);
    expect(runtime.getSnapshot().limits.maxResidentLayers).toBe(1);
    expect(runtime.getSnapshot().metrics.budgetEvictions).toBe(2);
    await runtime.destroy();
  });

  test('a failed create transition is visible in state and a later retry can recover', async () => {
    let attempts = 0;
    const { runtime } = createHarness({
      adapters: {
        create: async (descriptor) => {
          attempts += 1;
          if (attempts === 1) throw new Error('GPU allocation failed');
          return { id: descriptor.id, visible: false };
        },
      },
    });
    runtime.registerLayer('retry', { resourceUrl: FEATURE_URL });

    await expect(runtime.ensureResident('retry')).rejects.toMatchObject({
      name: 'LayerLifecycleRuntimeError',
      code: 'LAYER_TRANSITION_FAILED',
    });
    expect(runtime.getLayer('retry')).toMatchObject({
      state: GIS_LAYER_STATE.FAILED,
      failureCount: 1,
    });

    await expect(runtime.ensureResident('retry')).resolves.toMatchObject({ id: 'retry' });
    expect(runtime.getLayer('retry')).toMatchObject({
      state: GIS_LAYER_STATE.DETACHED,
      resident: true,
    });
    await runtime.destroy();
  });

  test('changing a resource URL while an instance is resident is rejected to prevent identity drift', async () => {
    const { runtime } = createHarness();
    runtime.registerLayer('identity', { resourceUrl: FEATURE_URL });
    await runtime.ensureResident('identity');

    expect(() => runtime.registerLayer('identity', {
      resourceUrl: 'https://example.test/arcgis/rest/services/Other/FeatureServer/0',
    })).toThrow(expect.objectContaining({
      code: 'RESOURCE_URL_CHANGE_REQUIRES_EVICTION',
    }));
    await runtime.destroy();
  });

  test('dispose destroys the instance and removes registration', async () => {
    const { runtime, adapters } = createHarness();
    runtime.registerLayer('temporary', { resourceUrl: FEATURE_URL });
    await runtime.attach('temporary', { id: 'map' });

    await expect(runtime.dispose('temporary')).resolves.toBe(true);
    expect(runtime.getLayer('temporary')).toBeNull();
    expect(runtime.getSnapshot().layerCount).toBe(0);
    expect(adapters.destroy).toHaveBeenCalledTimes(1);
    await runtime.destroy();
  });

  test('destroy releases all resident layers and blocks new transitions', async () => {
    const { runtime, adapters } = createHarness();
    runtime.registerLayer('one', { resourceUrl: FEATURE_URL });
    runtime.registerLayer('two', { resourceUrl: FEATURE_URL });
    await runtime.ensureResident('one');
    await runtime.ensureResident('two');

    await runtime.destroy();

    expect(adapters.destroy).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot().destroyed).toBe(true);
    expect(() => runtime.registerLayer('three', {
      resourceUrl: FEATURE_URL,
    })).toThrow(LayerLifecycleRuntimeError);
  });
});
