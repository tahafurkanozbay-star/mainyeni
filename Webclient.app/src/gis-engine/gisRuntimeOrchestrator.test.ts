import { GIS_PERFORMANCE_PROFILE } from './adaptivePerformanceRuntime';
import { createGisRuntimeOrchestrator } from './gisRuntimeOrchestrator';

const metadata = (overrides = {}) => ({
  name: 'Places',
  type: 'Feature Layer',
  capabilities: 'Query',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  maxRecordCount: 2,
  extent: { spatialReference: { wkid: 4326 } },
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID' },
    { name: 'NAME', type: 'esriFieldTypeString' },
    { name: 'TYPE', type: 'esriFieldTypeString' },
  ],
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsOrderBy: true,
    supportsStatistics: true,
  },
  ...overrides,
});

const registerPlaces = (runtime, overrides = {}) => runtime.registerLayer('places', {
  url: 'https://example.test/arcgis/rest/services/Places/FeatureServer/0',
  metadata: metadata(overrides),
});

const feature = (id) => ({
  attributes: { OBJECTID: id, NAME: `Place ${id}` },
  geometry: { x: 32 + id / 100, y: 39 + id / 100, spatialReference: { wkid: 4326 } },
});

describe('gisRuntimeOrchestrator', () => {
  test('registers verified ArcGIS capability contracts', () => {
    const runtime = createGisRuntimeOrchestrator();
    const contract = registerPlaces(runtime);
    expect(contract).toEqual(expect.objectContaining({
      serviceId: 'places',
      geometryType: 'point',
      objectIdField: 'OBJECTID',
      supportsQuery: true,
      supportsPagination: true,
    }));
    expect(runtime.getCapability('places')).toBe(contract);
    expect(runtime.getSnapshot().registeredLayerCount).toBe(1);
    runtime.destroy();
  });

  test('rejects WMS/WFS registration at the orchestration boundary', () => {
    const runtime = createGisRuntimeOrchestrator();
    expect(() => runtime.registerLayer('forbidden', {
      url: 'https://example.test/wms',
      metadata: metadata(),
    })).toThrow(expect.objectContaining({ code: 'FORBIDDEN_OGC_RESOURCE' }));
    runtime.destroy();
  });

  test('requires registration before layer operations', async () => {
    const runtime = createGisRuntimeOrchestrator();
    await expect(runtime.executeLayerQuery('missing', 'query', async () => []))
      .rejects.toMatchObject({ code: 'LAYER_NOT_REGISTERED' });
    runtime.destroy();
  });

  test('deduplicates and caches layer queries through shared query runtime', async () => {
    const runtime = createGisRuntimeOrchestrator();
    registerPlaces(runtime);
    const factory = vi.fn(async () => ({ features: [feature(1)] }));
    const first = runtime.executeLayerQuery('places', 'visible:all', factory);
    const second = runtime.executeLayerQuery('places', 'visible:all', factory);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { features: [feature(1)] },
      { features: [feature(1)] },
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
    await runtime.executeLayerQuery('places', 'visible:all', factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().query.deduped).toBe(1);
    runtime.destroy();
  });

  test('invalidates layer-scoped query cache on demand', async () => {
    const runtime = createGisRuntimeOrchestrator();
    registerPlaces(runtime);
    const factory = vi.fn(async () => ({ features: [feature(1)] }));
    await runtime.executeLayerQuery('places', 'all', factory);
    expect(runtime.invalidateLayerCaches('places').queryRemoved).toBe(1);
    await runtime.executeLayerQuery('places', 'all', factory);
    expect(factory).toHaveBeenCalledTimes(2);
    runtime.destroy();
  });

  test('executes metadata-driven ArcGIS pagination through injected adapters', async () => {
    const runtime = createGisRuntimeOrchestrator();
    registerPlaces(runtime);
    const calls = [];
    const result = await runtime.executePagedLayerQuery('places', {
      fetchPage: async (request) => {
        calls.push(request);
        return request.resultOffset === 0
          ? { features: [feature(1), feature(2)], exceededTransferLimit: true }
          : { features: [feature(3)], exceededTransferLimit: false };
      },
    });
    expect(calls).toHaveLength(2);
    expect(result.features).toHaveLength(3);
    expect(result.incomplete).toBe(false);
    runtime.destroy();
  });

  test('refuses paged querying when metadata does not advertise query support', async () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('tiles', {
      url: 'https://example.test/rest/services/Base/VectorTileServer',
      metadata: { type: 'Vector Tile Service', tileInfo: { format: 'pbf' } },
    });
    await expect(runtime.executePagedLayerQuery('tiles', {
      fetchPage: async () => ({ features: [] }),
    })).rejects.toMatchObject({ code: 'QUERY_NOT_SUPPORTED' });
    runtime.destroy();
  });

  test('assesses geometry with registered layer spatial reference defaults', () => {
    const runtime = createGisRuntimeOrchestrator();
    registerPlaces(runtime);
    const result = runtime.assessLayerGeometry('places', [
      { geometry: { x: 32, y: 39 } },
      { geometry: null },
    ]);
    expect(result.total).toBe(2);
    expect(result.valid).toBe(1);
    expect(result.invalid).toBe(1);
    runtime.destroy();
  });

  test('normalizes geometry using registered spatial reference when source omits it', () => {
    const runtime = createGisRuntimeOrchestrator();
    registerPlaces(runtime);
    const result = runtime.normalizeLayerGeometry('places', { x: 32, y: 39 });
    expect(result.geometry.spatialReference).toEqual({ wkid: 4326 });
    runtime.destroy();
  });

  test('memoizes CPU-heavy spatial work separately from network query cache', async () => {
    const runtime = createGisRuntimeOrchestrator();
    registerPlaces(runtime);
    const factory = vi.fn(async () => ({ distance: 10 }));
    const args = [{ x: 32, y: 39 }, { x: 33, y: 40 }];
    await runtime.executeSpatial('places', 'distance', args, factory);
    await runtime.executeSpatial('places', 'distance', args, factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().spatialMemo.cacheHits).toBe(1);
    runtime.destroy();
  });

  test('layer cache invalidation clears both network query and CPU spatial memo entries', async () => {
    const runtime = createGisRuntimeOrchestrator();
    registerPlaces(runtime);
    await runtime.executeLayerQuery('places', 'all', async () => ({ features: [] }));
    await runtime.executeSpatial('places', 'area', [{ x: 1, y: 2 }], async () => 1);
    expect(runtime.invalidateLayerCaches('places')).toEqual({
      queryRemoved: 1,
      spatialRemoved: 1,
    });
    runtime.destroy();
  });

  test('plans rendering using capability metadata and current adaptive budget', () => {
    const runtime = createGisRuntimeOrchestrator({ profile: GIS_PERFORMANCE_PROFILE.BALANCED });
    registerPlaces(runtime);
    const result = runtime.planPresentation('places', {
      featureStats: { featureCount: 1200 },
      view: { mode: '2d', scale: 10000 },
      options: { supportsClustering: true, labelField: 'NAME', categoryField: 'TYPE' },
    });
    expect(result.next.geometryType).toBe('point');
    expect(result.next.renderPlan.shouldCluster).toBe(true);
    expect(result.next.request.outFields).toEqual(['OBJECTID', 'NAME', 'TYPE']);
    runtime.destroy();
  });

  test('presentation planning retains LOD state across calls to prevent flapping', () => {
    const runtime = createGisRuntimeOrchestrator();
    registerPlaces(runtime);
    const first = runtime.planPresentation('places', {
      featureStats: { featureCount: 100 },
      view: { mode: '2d', scale: 160000 },
    });
    const near = runtime.planPresentation('places', {
      featureStats: { featureCount: 100 },
      view: { mode: '2d', scale: 145000 },
      options: { hysteresis: 0.1 },
    });
    expect(first.next.tier).toBe('overview');
    expect(near.next.tier).toBe('overview');
    runtime.destroy();
  });

  test('switching to eco profile shrinks query and scheduler budgets live', () => {
    const runtime = createGisRuntimeOrchestrator({
      profile: GIS_PERFORMANCE_PROFILE.QUALITY,
      deviceCapabilities: {
        profile: GIS_PERFORMANCE_PROFILE.QUALITY,
        memoryGb: 8,
        logicalCores: 8,
        constrainedNetwork: false,
        reducedMotion: false,
      },
    });
    const before = runtime.getSnapshot();
    expect(before.layerScheduler.maxConcurrent).toBe(6);
    expect(before.query.cacheBytes).toBe(0);
    runtime.setPerformanceProfile(GIS_PERFORMANCE_PROFILE.ECO, 'test');
    const after = runtime.getSnapshot();
    expect(after.profile).toBe(GIS_PERFORMANCE_PROFILE.ECO);
    expect(after.layerScheduler.maxConcurrent).toBe(2);
    expect(after.budget.maxVisibleFeatures).toBe(2500);
    expect(after.metrics.budgetTransitions).toBe(1);
    runtime.destroy();
  });

  test('adaptive frame pressure updates all dependent performance budgets', () => {
    let now = 0;
    const runtime = createGisRuntimeOrchestrator({
      profile: GIS_PERFORMANCE_PROFILE.QUALITY,
      deviceCapabilities: {
        profile: GIS_PERFORMANCE_PROFILE.QUALITY,
        memoryGb: 8,
        logicalCores: 8,
        constrainedNetwork: false,
        reducedMotion: false,
      },
      performanceNow: () => now,
      performanceSettings: {
        minSamples: 2,
        sampleWindow: 4,
        cooldownMs: 0,
        longFrameRatio: 0.5,
        criticalFrameRatio: 0.5,
      },
    });
    runtime.recordFrame(100);
    now += 16;
    runtime.recordFrame(100);
    expect(runtime.getProfile()).toBe(GIS_PERFORMANCE_PROFILE.BALANCED);
    expect(runtime.getSnapshot().layerScheduler.maxConcurrent).toBe(4);
    runtime.destroy();
  });

  test('schedules layer loads under the adaptive scheduler budget', async () => {
    const runtime = createGisRuntimeOrchestrator({ profile: GIS_PERFORMANCE_PROFILE.ECO });
    registerPlaces(runtime);
    const loader = vi.fn(async ({ layerId }) => ({ layerId, loaded: true }));
    await expect(runtime.scheduleLayerLoad({ id: 'places' }, loader))
      .resolves.toEqual({ layerId: 'places', loaded: true });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().metrics.layerLoads).toBe(1);
    runtime.destroy();
  });

  test('unregistering a layer removes capability, presentation and layer-scoped caches', async () => {
    const runtime = createGisRuntimeOrchestrator();
    registerPlaces(runtime);
    await runtime.executeLayerQuery('places', 'all', async () => ({ features: [] }));
    runtime.planPresentation('places', {
      featureStats: { featureCount: 1 },
      view: { mode: '2d', scale: 1000 },
    });
    expect(runtime.unregisterLayer('places')).toBe(true);
    expect(runtime.getCapability('places')).toBeNull();
    expect(runtime.getSnapshot().registeredLayerCount).toBe(0);
    expect(runtime.getSnapshot().presentationLayerCount).toBe(0);
    runtime.destroy();
  });

  test('emits lifecycle and performance events to subscribers without exposing feature payloads', () => {
    const runtime = createGisRuntimeOrchestrator({ profile: GIS_PERFORMANCE_PROFILE.BALANCED });
    const events = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    registerPlaces(runtime);
    runtime.setPerformanceProfile(GIS_PERFORMANCE_PROFILE.ECO, 'test');
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'layer-capabilities-registered',
      'performance-budget',
    ]));
    expect(events.find((event) => event.type === 'performance-budget')).not.toHaveProperty('features');
    unsubscribe();
    runtime.destroy();
  });

  test('listener exceptions do not break GIS runtime actions', () => {
    const onListenerError = vi.fn();
    const runtime = createGisRuntimeOrchestrator({ onListenerError });
    runtime.subscribe(() => {
      throw new Error('observer failed');
    });
    expect(() => registerPlaces(runtime)).not.toThrow();
    expect(onListenerError).toHaveBeenCalled();
    runtime.destroy();
  });

  test('query errors increment diagnostics and remain visible to the caller', async () => {
    const runtime = createGisRuntimeOrchestrator();
    registerPlaces(runtime);
    await expect(runtime.executeLayerQuery('places', 'broken', async () => {
      throw new Error('service unavailable');
    })).rejects.toThrow('service unavailable');
    expect(runtime.getSnapshot().metrics.errors).toBe(1);
    runtime.destroy();
  });

  test('destroy releases owned runtimes and rejects subsequent operations', () => {
    const runtime = createGisRuntimeOrchestrator();
    registerPlaces(runtime);
    runtime.destroy();
    expect(runtime.getSnapshot().destroyed).toBe(true);
    expect(() => runtime.planPresentation('places', {}))
      .toThrow(expect.objectContaining({ code: 'RUNTIME_DESTROYED' }));
  });
});
