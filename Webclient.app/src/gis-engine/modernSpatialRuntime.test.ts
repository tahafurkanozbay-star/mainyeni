import { describe, expect, it } from 'vitest';
import {
  createArcGisValidatedQueryPlan,
  deriveArcGisServiceCapabilities,
  advanceArcGisPagedQueryState,
  validateArcGisEditIntent,
} from './arcgisCapabilityAdapter';
import { createClusterLodDecision, clusterPointsIntoGrid, computeClusterDensity } from './clusterLodPolicy';
import { createSpatialCacheCoordinator } from './spatialCacheCoordinator';
import { createSceneLayerLifecycleRuntime } from './sceneLayerLifecycleRuntime';
import { TerrainStreamGovernor, terrainBudgetForQuality } from './terrainStreamGovernor';

describe('ArcGIS capability adapter', () => {
  it('derives query and editing capabilities without inventing unsupported features', () => {
    const capabilities = deriveArcGisServiceCapabilities({
      type: 'Feature Layer',
      name: 'Roads',
      geometryType: 'esriGeometryPolyline',
      objectIdField: 'OBJECTID',
      globalIdField: 'GLOBALID',
      maxRecordCount: 2_000,
      capabilities: 'Query,Create,Update',
      spatialReference: { wkid: 3857 },
      fields: [
        { name: 'OBJECTID', type: 'esriFieldTypeOID' },
        { name: 'NAME', type: 'esriFieldTypeString' },
      ],
      advancedQueryCapabilities: {
        supportsPagination: true,
        supportsOrderBy: true,
        supportsDistinct: true,
        supportsStatistics: true,
        supportsHavingClause: true,
        supportsQueryWithDistance: true,
      },
      allowGeometryUpdates: true,
    });

    expect(capabilities.kind).toBe('feature-server');
    expect(capabilities.geometryType).toBe('polyline');
    expect(capabilities.maxRecordCount).toBe(2_000);
    expect(capabilities.supportsQuery).toBe(true);
    expect(capabilities.supportsPagination).toBe(true);
    expect(capabilities.supportsCreate).toBe(true);
    expect(capabilities.supportsUpdate).toBe(true);
    expect(capabilities.supportsDelete).toBe(false);
    expect(capabilities.spatialReferenceWkid).toBe(3857);
    expect(capabilities.warnings).toEqual([]);
  });

  it('emits integrity warnings for incomplete metadata', () => {
    const capabilities = deriveArcGisServiceCapabilities({
      type: 'Unknown Layer',
      capabilities: 'Query',
    });

    expect(capabilities.supportsQuery).toBe(true);
    expect(capabilities.warnings).toContain('object-id-field-missing');
    expect(capabilities.warnings).toContain('advanced-query-capabilities-missing');
    expect(capabilities.warnings).toContain('service-kind-unknown');
    expect(capabilities.warnings).toContain('geometry-type-unknown');
    expect(capabilities.warnings).toContain('spatial-reference-wkid-missing');
  });

  it('bounds query page size to service maxRecordCount', () => {
    const capabilities = deriveArcGisServiceCapabilities({
      type: 'Feature Layer',
      geometryType: 'esriGeometryPoint',
      objectIdField: 'OID',
      maxRecordCount: 500,
      capabilities: 'Query',
      spatialReference: { latestWkid: 4326 },
      fields: [{ name: 'OID' }, { name: 'NAME' }],
      advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
    });

    const plan = createArcGisValidatedQueryPlan(capabilities, {
      where: '',
      outFields: ['OID', 'NAME', 'NOT_ALLOWED'],
      resultOffset: 500,
      resultRecordCount: 10_000,
      orderByFields: ['NAME desc'],
    });

    expect(plan.pageSize).toBe(500);
    expect(plan.params.where).toBe('1=1');
    expect(plan.params.outFields).toBe('OID,NAME');
    expect(plan.params.resultOffset).toBe(500);
    expect(plan.params.resultRecordCount).toBe(500);
    expect(plan.params.orderByFields).toBe('NAME DESC');
  });

  it('fails closed for unsupported optional query capabilities', () => {
    const capabilities = deriveArcGisServiceCapabilities({
      type: 'Map Layer',
      geometryType: 'esriGeometryPolygon',
      objectIdField: 'OID',
      maxRecordCount: 1_000,
      capabilities: 'Query',
      spatialReference: { wkid: 4326 },
      fields: [{ name: 'OID' }],
      advancedQueryCapabilities: {},
    });

    const plan = createArcGisValidatedQueryPlan(capabilities, {
      resultOffset: 20,
      returnDistinctValues: true,
      outStatistics: [{ statisticType: 'count', onStatisticField: 'OID', outStatisticFieldName: 'n' }],
      having: 'COUNT(OID) > 1',
      distance: 100,
      units: 'meters',
    });

    expect(plan.paginationEnabled).toBe(false);
    expect(plan.warnings).toEqual(expect.arrayContaining([
      'pagination-not-supported',
      'distinct-not-supported',
      'statistics-not-supported',
      'having-not-supported',
      'distance-query-not-supported',
    ]));
    expect(plan.params).not.toHaveProperty('distance');
  });

  it('advances bounded pagination deterministically', () => {
    const first = advanceArcGisPagedQueryState(null, [1, 2, 3], {
      pageSize: 3,
      exceededTransferLimit: true,
      maxRecords: 5,
    });
    const second = advanceArcGisPagedQueryState(first, [4, 5, 6], {
      pageSize: 3,
      exceededTransferLimit: true,
      maxRecords: 5,
    });

    expect(first.complete).toBe(false);
    expect(second.features).toEqual([1, 2, 3, 4, 5]);
    expect(second.complete).toBe(true);
    expect(second.pageCount).toBe(2);
  });

  it('rejects edits that metadata does not advertise', () => {
    const capabilities = deriveArcGisServiceCapabilities({
      type: 'Feature Layer',
      geometryType: 'esriGeometryPoint',
      objectIdField: 'OID',
      capabilities: 'Query,Update',
      spatialReference: { wkid: 4326 },
    });
    const guard = validateArcGisEditIntent(capabilities, {
      creates: [{ attributes: {} }],
      updates: [{ attributes: { OID: 1 } }],
      deletes: [1],
    });
    expect(guard.allowed).toBe(false);
    expect(guard.reasons).toEqual(['create-not-supported', 'delete-not-supported']);
  });
});

describe('cluster and LOD policy', () => {
  it('classifies density by features per viewport area', () => {
    expect(computeClusterDensity(100, 1_000, 1_000)).toBe('sparse');
    expect(computeClusterDensity(20_000, 1_000, 1_000)).toBe('medium');
    expect(computeClusterDensity(50_000, 1_000, 1_000)).toBe('dense');
    expect(computeClusterDensity(120_000, 1_000, 1_000)).toBe('extreme');
  });

  it('uses aggressive clustering under extreme density', () => {
    const decision = createClusterLodDecision({
      featureCount: 180_000,
      viewportWidth: 1_280,
      viewportHeight: 720,
      zoom: 11,
      averageFrameMs: 18,
      deviceMemoryGb: 8,
    });
    expect(decision.mode).toBe('aggressive');
    expect(decision.clusterRadiusPx).toBeGreaterThan(50);
    expect(decision.maxVisibleFeatures).toBeGreaterThan(5_000);
  });

  it('reduces detail under slow frame and low memory pressure', () => {
    const healthy = createClusterLodDecision({
      featureCount: 12_000,
      viewportWidth: 1_920,
      viewportHeight: 1_080,
      zoom: 15,
      averageFrameMs: 16,
      deviceMemoryGb: 8,
    });
    const pressured = createClusterLodDecision({
      featureCount: 12_000,
      viewportWidth: 1_920,
      viewportHeight: 1_080,
      zoom: 15,
      averageFrameMs: 48,
      deviceMemoryGb: 1,
      reducedMotion: true,
    });
    expect(pressured.maxVisibleFeatures).toBeLessThan(healthy.maxVisibleFeatures);
    expect(pressured.animationEnabled).toBe(false);
    expect(pressured.mode).not.toBe('off');
  });

  it('clusters points deterministically and bounds retained ids', () => {
    const clusters = clusterPointsIntoGrid([
      { id: 'a', x: 1, y: 1 },
      { id: 'b', x: 4, y: 5, weight: 2 },
      { id: 'c', x: 101, y: 101 },
      { id: 'd', x: Number.NaN, y: 0 },
    ], 50, 1);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.count).toBe(2);
    expect(clusters[0]?.totalWeight).toBe(3);
    expect(clusters[0]?.ids).toHaveLength(1);
  });
});

describe('spatial cache coordinator', () => {
  it('caches values with TTL and reports hits', () => {
    let now = 1_000;
    const cache = createSpatialCacheCoordinator({ now: () => now, defaultTtlMs: 500 });
    cache.put('roads', { count: 12 }, { tags: ['network'] });
    expect(cache.get<{ count: number }>('roads')).toEqual({ count: 12 });
    expect(cache.getSnapshot().hits).toBe(1);
    now = 2_000;
    expect(cache.get('roads')).toBeUndefined();
    expect(cache.getSnapshot().size).toBe(0);
  });

  it('invalidates entries by normalized tags', () => {
    const cache = createSpatialCacheCoordinator();
    cache.put('roads:a', 1, { tags: ['Roads', 'district:1'] });
    cache.put('roads:b', 2, { tags: ['roads', 'district:2'] });
    cache.put('parks', 3, { tags: ['parks'] });
    expect(cache.invalidateTags(['ROADS'])).toBe(2);
    expect(cache.has('parks')).toBe(true);
  });

  it('evicts low priority records before critical records', () => {
    const cache = createSpatialCacheCoordinator({ maxEntries: 2, maxBytes: 10_000 });
    cache.put('critical', 'a', { priority: 'critical' });
    cache.put('low', 'b', { priority: 'low' });
    cache.put('normal', 'c', { priority: 'normal' });
    expect(cache.has('critical')).toBe(true);
    expect(cache.has('low')).toBe(false);
    expect(cache.has('normal')).toBe(true);
  });

  it('deduplicates concurrent loaders', async () => {
    const cache = createSpatialCacheCoordinator();
    let calls = 0;
    const loader = async (): Promise<number> => {
      calls += 1;
      await Promise.resolve();
      return 42;
    };
    const [first, second] = await Promise.all([
      cache.request('same', loader),
      cache.request('same', loader),
    ]);
    expect(first).toBe(42);
    expect(second).toBe(42);
    expect(calls).toBe(1);
    expect(cache.getSnapshot().dedupeHits).toBe(1);
  });
});

describe('terrain stream governor', () => {
  it('exposes bounded quality budgets', () => {
    expect(terrainBudgetForQuality('eco').maxResidentBytes).toBeLessThan(terrainBudgetForQuality('quality').maxResidentBytes);
    expect(terrainBudgetForQuality('balanced').maxConcurrentRequests).toBe(6);
  });

  it('detects critical pressure from memory and frame time', () => {
    const governor = new TerrainStreamGovernor({ quality: 'balanced' });
    governor.setResidentUsage(600 * 1024 * 1024, 800);
    governor.recordFrame(55);
    governor.recordFrame(50);
    expect(governor.getSnapshot().pressure).toBe('critical');
  });

  it('prioritizes visible terrain and defers distant prefetch', () => {
    const governor = new TerrainStreamGovernor({ quality: 'balanced', now: () => 10_000 });
    const snapshot = governor.plan([
      { id: 'visible', level: 12, distanceMeters: 200, screenPixels: 120, estimatedBytes: 1_000_000, visible: true },
      { id: 'far', level: 12, distanceMeters: 9_000, screenPixels: 40, estimatedBytes: 1_000_000, visible: false },
    ]);
    const visible = snapshot.decisions.find((decision) => decision.tileId === 'visible');
    const far = snapshot.decisions.find((decision) => decision.tileId === 'far');
    expect(visible?.action).toBe('request');
    expect(far?.action).toBe('evict');
  });

  it('respects request concurrency limits', () => {
    const governor = new TerrainStreamGovernor({ quality: 'eco' });
    governor.setActiveRequests(3);
    const snapshot = governor.plan([
      { id: 'a', level: 10, distanceMeters: 10, screenPixels: 100, estimatedBytes: 1000, visible: true },
    ]);
    expect(snapshot.decisions[0]?.action).toBe('defer');
    expect(snapshot.decisions[0]?.reason).toBe('request-concurrency');
  });
});

describe('scene layer lifecycle runtime', () => {
  it('registers and loads a requested layer', async () => {
    const runtime = createSceneLayerLifecycleRuntime<string>({ maxConcurrentLoads: 1 });
    runtime.register({ id: 'roads', priority: 'high' }, {
      load: async () => 'resource',
    });
    const snapshot = await runtime.request('roads');
    expect(snapshot.phase).toBe('ready');
    expect(runtime.getSnapshot().loadedLayers).toBe(1);
    await runtime.dispose();
  });

  it('suspends and resumes without reloading an owned resource', async () => {
    let loads = 0;
    let suspends = 0;
    let activations = 0;
    const runtime = createSceneLayerLifecycleRuntime<string>();
    runtime.register({ id: 'buildings' }, {
      load: async () => {
        loads += 1;
        return 'resource';
      },
      activate: () => {
        activations += 1;
      },
      suspend: () => {
        suspends += 1;
      },
    });
    await runtime.request('buildings');
    await runtime.suspend('buildings');
    await runtime.resume('buildings');
    expect(loads).toBe(1);
    expect(suspends).toBe(1);
    expect(activations).toBe(2);
    await runtime.dispose();
  });

  it('honors scale and zoom constraints during viewport reconciliation', async () => {
    const runtime = createSceneLayerLifecycleRuntime<string>();
    runtime.register({ id: 'parcel', minZoom: 15, maxZoom: 20 }, {
      load: async () => 'parcel-resource',
    });
    await runtime.setViewport({ zoom: 10 });
    expect(runtime.getLayerSnapshot('parcel')?.phase).toBe('idle');
    await runtime.setViewport({ zoom: 16 });
    await runtime.reconcile();
    expect(runtime.getLayerSnapshot('parcel')?.phase).toBe('ready');
    await runtime.dispose();
  });

  it('disposes all resources without leaking ownership', async () => {
    const disposed: string[] = [];
    const runtime = createSceneLayerLifecycleRuntime<string>();
    runtime.register({ id: 'a' }, { load: async () => 'a', dispose: (resource) => { disposed.push(resource); } });
    runtime.register({ id: 'b' }, { load: async () => 'b', dispose: (resource) => { disposed.push(resource); } });
    await runtime.request('a');
    await runtime.request('b');
    await runtime.dispose();
    expect(disposed.sort()).toEqual(['a', 'b']);
    expect(runtime.getSnapshot().loadedLayers).toBe(0);
  });
});
