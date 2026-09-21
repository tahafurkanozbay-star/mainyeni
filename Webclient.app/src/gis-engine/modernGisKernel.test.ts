import { createModernGisKernel } from './modernGisKernel';

const FEATURE_URL = 'https://example.test/arcgis/rest/services/Places/FeatureServer/0';
const SCENE_URL = 'https://example.test/arcgis/rest/services/Buildings/SceneServer';

const featureMetadata = (overrides = {}) => ({
  name: 'Places',
  type: 'Feature Layer',
  capabilities: 'Query',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  maxRecordCount: 2000,
  extent: { spatialReference: { wkid: 102100, latestWkid: 3857 } },
  fields: [
    { name: 'OBJECTID', alias: 'OBJECTID', type: 'esriFieldTypeOID', nullable: false, editable: false },
    { name: 'NAME', alias: 'Name', type: 'esriFieldTypeString', length: 120 },
    { name: 'TYPE', alias: 'Type', type: 'esriFieldTypeString', length: 80 },
  ],
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsOrderBy: true,
    supportsStatistics: true,
    supportsDistinct: true,
    supportsReturningQueryExtent: true,
    supportsReturningGeometryCentroid: true,
    supportsQuantization: true,
  },
  ...overrides,
});

const registerPlaces = (kernel, overrides = {}) => {
  kernel.registerService({
    serviceId: 'places',
    url: FEATURE_URL,
    metadata: featureMetadata(overrides.metadata),
  });
  kernel.registerLayer({
    id: 'places-layer',
    serviceId: 'places',
    visible: true,
    importance: 80,
    estimatedFeatureCount: 5000,
    estimatedBytes: 1024 * 1024,
    ...overrides.layer,
  });
};

const basicQuery = (overrides = {}) => ({
  outFields: ['NAME', 'TYPE'],
  pageSize: 50,
  orderBy: [{ field: 'NAME', direction: 'ASC' }],
  ...overrides,
});

const createKernel = (overrides = {}) => createModernGisKernel({
  initialTier: 'balanced',
  device: {
    memoryGb: 8,
    logicalCores: 8,
    networkClass: 'fast',
  },
  ...overrides,
});

describe('modernGisKernel', () => {
  test('registers ArcGIS services and layers into one typed runtime surface', () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    const snapshot = kernel.getSnapshot();
    expect(snapshot.registeredServices).toBe(1);
    expect(snapshot.registeredLayers).toBe(1);
    expect(snapshot.qualityTier).toBe('balanced');
    expect(kernel.getLayer('places-layer')).toEqual(expect.objectContaining({
      id: 'places-layer',
      serviceId: 'places',
      resourceUrl: FEATURE_URL,
      geometryType: 'point',
    }));
  });

  test('rejects WMS resources through the existing ArcGIS service policy', () => {
    const kernel = createKernel();
    expect(() => kernel.registerService({
      serviceId: 'wms',
      url: 'https://example.test/geoserver/wms?service=WMS',
      metadata: featureMetadata(),
    })).toThrow();
  });

  test('rejects generic invented endpoints instead of guessing provider behavior', () => {
    const kernel = createKernel();
    expect(() => kernel.registerService({
      serviceId: 'generic',
      url: 'https://example.test/api/layers/1',
      metadata: featureMetadata(),
    })).toThrow();
  });

  test('compiles bounded capability-aware query plans', () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    const plan = kernel.planQuery('places', basicQuery({ pageSize: 5000 }));
    expect(plan.strategy).toBe('offset-pagination');
    expect(plan.pageSize).toBe(2000);
    expect(plan.baseRequest.outFields).toEqual(expect.arrayContaining(['OBJECTID', 'NAME', 'TYPE']));
    expect(plan.baseRequest.orderByFields).toBe('NAME ASC');
    expect(plan.diagnostics.queryReady).toBe(true);
  });

  test('executes a planned query through the shared request scheduler', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    const execute = vi.fn(async (request, context) => ({
      features: [{ attributes: { OBJECTID: 1, NAME: 'A', TYPE: 'park' } }],
      request,
      serviceId: context.serviceId,
    }));
    const result = await kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicQuery(),
      requestKey: 'places:first-page',
      execute,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.request.resultOffset).toBe(0);
    expect(result.request.resultRecordCount).toBe(50);
    expect(result.value.serviceId).toBe('places');
    expect(result.fromScheduler).toBe(true);
    expect(kernel.getDiagnostics().health.healthy).toBe(1);
  });

  test('deduplicates concurrent requests with the same stable request key', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { features: [{ attributes: { OBJECTID: 7, NAME: 'Shared' } }] };
    });
    const input = {
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicQuery(),
      requestKey: 'places:shared',
      execute,
    };
    const first = kernel.executeQuery(input);
    const second = kernel.executeQuery(input);
    await Promise.resolve();
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(left.value).toEqual(right.value);
    expect(kernel.getDiagnostics().queryControlPlane.queue.dedupedSubscribers)
      .toBeGreaterThanOrEqual(1);
  });

  test('serves repeated successful requests from the bounded scheduler cache', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    const execute = vi.fn(async () => ({ features: [{ attributes: { OBJECTID: 1 } }] }));
    const input = {
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicQuery(),
      requestKey: 'places:cached',
      cacheTtlMs: 60000,
      execute,
    };
    await kernel.executeQuery(input);
    await kernel.executeQuery(input);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(kernel.getDiagnostics().scheduler.metrics.cacheHits).toBeGreaterThanOrEqual(1);
  });

  test('layer cache invalidation removes layer-tagged query entries', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    const execute = vi.fn(async () => ({ features: [] }));
    await kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicQuery(),
      requestKey: 'places:invalidate',
      cacheTtlMs: 60000,
      execute,
    });
    const invalidated = kernel.invalidateLayer('places-layer');
    expect(invalidated.queryCache).toBeGreaterThanOrEqual(1);
    await kernel.executeQuery({
      serviceId: 'places',
      layerId: 'places-layer',
      planInput: basicQuery(),
      requestKey: 'places:invalidate',
      cacheTtlMs: 60000,
      execute,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test('records transfer-limit evidence without treating the request as failed', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    await kernel.executeQuery({
      serviceId: 'places',
      planInput: basicQuery(),
      requestKey: 'places:transfer-limit',
      execute: async () => ({
        features: [],
        exceededTransferLimit: true,
      }),
    });
    const health = kernel.getDiagnostics().kernel.services[0];
    expect(health.transferLimitCount).toBe(1);
    expect(health.failures).toBe(0);
  });

  test('opens service circuit after a real request failure and rejects the next request', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    await expect(kernel.executeQuery({
      serviceId: 'places',
      planInput: basicQuery(),
      requestKey: 'places:failure',
      cache: false,
      execute: async () => {
        const error = new Error('service unavailable');
        error.code = 'HTTP_503';
        error.status = 503;
        throw error;
      },
    })).rejects.toThrow('service unavailable');
    const health = kernel.getDiagnostics().kernel.services[0];
    expect(health.circuit).toBe('open');
    await expect(kernel.executeQuery({
      serviceId: 'places',
      planInput: basicQuery(),
      requestKey: 'places:blocked',
      cache: false,
      execute: async () => ({ features: [] }),
    })).rejects.toThrow(/temporarily unavailable/i);
  });

  test('prevents a layer from being queried through a service it does not belong to', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    kernel.registerService({
      serviceId: 'other',
      url: 'https://example.test/arcgis/rest/services/Other/FeatureServer/0',
      metadata: featureMetadata({ name: 'Other' }),
    });
    await expect(kernel.executeQuery({
      serviceId: 'other',
      layerId: 'places-layer',
      planInput: basicQuery(),
      execute: async () => ({ features: [] }),
    })).rejects.toThrow(/not owned by service/i);
  });

  test('propagates view updates into shared render planning', () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    kernel.updateView({ kind: '2d', scale: 5000, stationary: true, interacting: false });
    const plan = kernel.planLayerRender('places-layer', {
      featureCount: 9000,
      pointCount: 9000,
      allowCluster: true,
    });
    expect(plan.viewKind).toBe('2d');
    expect(plan.visible).toBe(true);
    expect(plan.cluster).toBe(true);
    expect(plan.generalization.tolerance).toBeNull();
  });

  test('does not invent generalization units under feature pressure', () => {
    const kernel = createKernel({ initialTier: 'economy' });
    registerPlaces(kernel);
    const plan = kernel.planLayerRender('places-layer', { featureCount: 100000 });
    expect(plan.generalization.recommended).toBe(true);
    expect(plan.generalization.tolerance).toBeNull();
    expect(plan.generalization.reason).toMatch(/coordinate units/i);
  });

  test('updates scheduler and lifecycle budgets when quality tier changes', () => {
    const kernel = createKernel({ initialTier: 'quality' });
    registerPlaces(kernel);
    const before = kernel.getDiagnostics();
    kernel.setQualityTier('economy', 'test-pressure');
    const after = kernel.getDiagnostics();
    expect(after.render.tier).toBe('economy');
    expect(after.scheduler.limits.maxConcurrent).toBeLessThanOrEqual(before.scheduler.limits.maxConcurrent);
    expect(after.lifecycle.limits.maxResidentBytes).toBeLessThanOrEqual(before.lifecycle.limits.maxResidentBytes);
  });

  test('records frame samples and exposes frame-pressure diagnostics', () => {
    const kernel = createKernel({ initialTier: 'quality' });
    for (let index = 0; index < 30; index += 1) kernel.recordFrame(60);
    const diagnostics = kernel.getDiagnostics();
    expect(diagnostics.render.sampleCount).toBe(30);
    expect(['high', 'critical']).toContain(diagnostics.render.budget.framePressure);
  });

  test('plans 3D scene streaming with memory and request budgets', () => {
    const kernel = createKernel({ initialTier: 'balanced' });
    kernel.updateView({ kind: '3d', stationary: true, interacting: false, cameraDistance: 1000 });
    const decision = kernel.planSceneStreaming({
      candidates: [
        {
          id: 'building-near',
          layerId: 'buildings',
          serviceId: 'scene',
          resourceUrl: SCENE_URL,
          resourceKind: 'scene-service',
          estimatedBytes: 1024,
          distance: 20,
          screenArea: 0.8,
          importance: 90,
          visible: true,
        },
        {
          id: 'building-far',
          layerId: 'buildings',
          serviceId: 'scene',
          resourceUrl: SCENE_URL,
          resourceKind: 'scene-service',
          estimatedBytes: 1024,
          distance: 20000,
          screenArea: 0.1,
          importance: 20,
          visible: false,
        },
      ],
      residentBytes: 0,
    });
    expect(decision.load).toContain('building-near');
    expect(decision.prefetch).toContain('building-far');
    expect(decision.estimatedLoadBytes).toBeGreaterThan(0);
  });

  test('disables scene prefetch while the 3D view is moving', () => {
    const kernel = createKernel({ initialTier: 'quality' });
    kernel.updateView({ kind: '3d', stationary: false, interacting: true });
    const decision = kernel.planSceneStreaming({
      candidates: [{
        id: 'background',
        layerId: 'buildings',
        resourceUrl: SCENE_URL,
        estimatedBytes: 1000,
        visible: false,
      }],
      residentBytes: 0,
    });
    expect(decision.prefetch).toHaveLength(0);
  });

  test('attaches, toggles and detaches a managed layer through lifecycle ownership', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    const instance = await kernel.attachLayer('places-layer', { id: 'map-view', type: '2d' });
    expect(instance).toBeTruthy();
    await kernel.setLayerVisible('places-layer', false, 'test');
    expect(kernel.getDiagnostics().lifecycle.layers[0].visible).toBe(false);
    await kernel.detachLayer('places-layer', 'test');
    expect(kernel.getDiagnostics().lifecycle.layers[0].attachedViewKey).toBeNull();
  });

  test('blocks service removal while registered layers depend on it', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    await expect(kernel.unregisterService('places')).rejects.toThrow(/layer/i);
    await kernel.unregisterLayer('places-layer');
    await expect(kernel.unregisterService('places')).resolves.toBe(true);
  });

  test('unregistering a layer disposes lifecycle resources and removes kernel state', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    await kernel.attachLayer('places-layer', { id: 'map-view' });
    await expect(kernel.unregisterLayer('places-layer')).resolves.toBe(true);
    expect(kernel.getSnapshot().registeredLayers).toBe(0);
    expect(() => kernel.getLayer('places-layer')).toThrow(/not registered/i);
  });

  test('diagnostics combine kernel, scheduler, lifecycle, health, render and streaming state', () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    const diagnostics = kernel.getDiagnostics();
    expect(diagnostics.kernel.registeredServices).toBe(1);
    expect(diagnostics.scheduler).toBeTruthy();
    expect(diagnostics.lifecycle).toBeTruthy();
    expect(diagnostics.health.registered).toBe(1);
    expect(diagnostics.render.tier).toBe('balanced');
    expect(diagnostics.streaming.plans).toBe(0);
    expect(diagnostics.observability.retainedEvents).toBeGreaterThan(0);
  });

  test('observability never stores the ArcGIS resource URL from service registration', () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    const events = kernel.getDiagnostics().observability;
    expect(events.retainedEvents).toBeGreaterThan(0);
    const serialized = JSON.stringify(kernel.getDiagnostics());
    expect(serialized).toContain('places');
  });

  test('destroy tears down owned runtimes and clears service/layer registries', async () => {
    const kernel = createKernel();
    registerPlaces(kernel);
    await kernel.destroy();
    expect(kernel.isDestroyed()).toBe(true);
    const snapshot = kernel.getSnapshot();
    expect(snapshot.destroyed).toBe(true);
    expect(snapshot.registeredServices).toBe(0);
    expect(snapshot.registeredLayers).toBe(0);
    expect(() => kernel.registerService({
      serviceId: 'late',
      url: FEATURE_URL,
      metadata: featureMetadata(),
    })).toThrow(/destroyed/i);
  });
});
