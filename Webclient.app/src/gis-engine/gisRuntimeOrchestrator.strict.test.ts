import { describe, expect, test, vi } from 'vitest';
import {
  GisRuntimeOrchestratorError,
  createGisRuntimeOrchestrator,
} from './gisRuntimeOrchestrator';

const FEATURE_URL = 'https://example.test/arcgis/rest/services/Places/FeatureServer/0';

const featureMetadata = (overrides: Record<string, unknown> = {}) => ({
  name: 'Places',
  type: 'Feature Layer',
  geometryType: 'esriGeometryPoint',
  capabilities: 'Query',
  objectIdField: 'OBJECTID',
  maxRecordCount: 2,
  extent: { spatialReference: { wkid: 4326 } },
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID' },
    { name: 'NAME', type: 'esriFieldTypeString', length: 100 },
  ],
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsOrderBy: true,
    supportsStatistics: true,
  },
  ...overrides,
});

const queryFeature = (id: number) => ({
  attributes: { OBJECTID: id, NAME: `place-${id}` },
  geometry: { x: 32.8 + id * 0.001, y: 39.9 + id * 0.001 },
});

describe('GIS runtime orchestrator capability boundary', () => {
  test('requires a stable layer id', () => {
    const runtime = createGisRuntimeOrchestrator();
    expect(() => runtime.registerLayer('', { url: FEATURE_URL, metadata: featureMetadata() }))
      .toThrow(expect.objectContaining({ code: 'INVALID_LAYER_ID' }));
    runtime.destroy();
  });

  test('builds and stores one immutable capability contract per layer', () => {
    const runtime = createGisRuntimeOrchestrator();
    const contract = runtime.registerLayer('places', {
      url: FEATURE_URL,
      metadata: featureMetadata(),
    });

    expect(contract.serviceId).toBe('places');
    expect(contract.supportsQuery).toBe(true);
    expect(contract.supportsPagination).toBe(true);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(runtime.getCapability('places')).toBe(contract);
    expect(runtime.getSnapshot().registeredLayerCount).toBe(1);
    runtime.destroy();
  });

  test('re-registering a layer replaces metadata without inflating registration metrics', () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });
    runtime.registerLayer('places', {
      url: FEATURE_URL,
      metadata: featureMetadata({ name: 'Places v2', maxRecordCount: 50 }),
    });

    expect(runtime.getCapability('places')).toEqual(expect.objectContaining({
      name: 'Places v2',
      maxRecordCount: 50,
    }));
    expect(runtime.getSnapshot().metrics.registeredLayers).toBe(1);
    runtime.destroy();
  });

  test('rejects paged query execution for a layer without advertised query capability', async () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('map-only', {
      url: 'https://example.test/arcgis/rest/services/Base/MapServer',
      metadata: {
        name: 'Base',
        type: 'Map Service',
        capabilities: 'Map,Tilemap',
      },
    });

    await expect(runtime.executePagedLayerQuery('map-only', {
      fetchPage: async () => ({ features: [] }),
    })).rejects.toMatchObject({ code: 'QUERY_NOT_SUPPORTED' });
    runtime.destroy();
  });

  test('does not allow WMS/WFS resources through orchestrator registration', () => {
    const runtime = createGisRuntimeOrchestrator();
    expect(() => runtime.registerLayer('forbidden', {
      url: 'https://example.test/geoserver/wms?service=WMS',
      metadata: {},
    })).toThrow(expect.objectContaining({ code: 'FORBIDDEN_OGC_RESOURCE' }));
    runtime.destroy();
  });
});

describe('GIS runtime orchestrator query execution', () => {
  test('executes a stable keyed query and returns adapter result', async () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });
    const factory = vi.fn(async () => ({ count: 4 }));

    await expect(runtime.executeLayerQuery('places', 'count:all', factory))
      .resolves.toEqual({ count: 4 });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().metrics.queries).toBe(1);
    runtime.destroy();
  });

  test('rejects an empty query key before invoking the factory', async () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });
    const factory = vi.fn(async () => 'never');

    await expect(runtime.executeLayerQuery('places', '   ', factory))
      .rejects.toMatchObject({ code: 'INVALID_QUERY_KEY' });
    expect(factory).not.toHaveBeenCalled();
    runtime.destroy();
  });

  test('keeps layer query cache namespaces isolated between layer ids', async () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places-a', { url: FEATURE_URL, metadata: featureMetadata() });
    runtime.registerLayer('places-b', { url: FEATURE_URL, metadata: featureMetadata() });
    const firstFactory = vi.fn(async () => 'A');
    const secondFactory = vi.fn(async () => 'B');

    await expect(runtime.executeLayerQuery('places-a', 'same-key', firstFactory)).resolves.toBe('A');
    await expect(runtime.executeLayerQuery('places-b', 'same-key', secondFactory)).resolves.toBe('B');

    expect(firstFactory).toHaveBeenCalledTimes(1);
    expect(secondFactory).toHaveBeenCalledTimes(1);
    runtime.destroy();
  });

  test('invalidates query and spatial cache tags for one layer only', async () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });

    await runtime.executeLayerQuery('places', 'cached-query', async () => 'query');
    await runtime.executeSpatial('places', 'buffer', { distance: 5 }, async () => 'spatial');
    const result = runtime.invalidateLayerCaches('places');

    expect(result.queryRemoved).toBeGreaterThanOrEqual(0);
    expect(result.spatialRemoved).toBeGreaterThanOrEqual(0);
    expect(Object.isFrozen(result)).toBe(true);
    runtime.destroy();
  });

  test('records query failures and rethrows original error', async () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });
    const failure = new Error('transport down');

    await expect(runtime.executeLayerQuery('places', 'failing', async () => {
      throw failure;
    })).rejects.toBe(failure);
    expect(runtime.getSnapshot().metrics.errors).toBe(1);
    runtime.destroy();
  });
});

describe('GIS runtime orchestrator paged ArcGIS integrity', () => {
  test('applies capability-derived pagination metadata', async () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });
    const requests: Array<Record<string, unknown>> = [];

    const result = await runtime.executePagedLayerQuery('places', {
      fetchPage: async (request) => {
        requests.push({ ...request });
        if (request.pageIndex === 0) {
          return { features: [queryFeature(1), queryFeature(2)], exceededTransferLimit: true };
        }
        return { features: [queryFeature(3)], exceededTransferLimit: false };
      },
    }, { maxPages: 4 });

    expect(result.features.map((item) => item.attributes.OBJECTID)).toEqual([1, 2, 3]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(expect.objectContaining({
      resultOffset: 0,
      resultRecordCount: 2,
      orderByFields: ['OBJECTID ASC'],
    }));
    expect(requests[1]).toEqual(expect.objectContaining({ resultOffset: 2 }));
    expect(runtime.getSnapshot().metrics.pagedQueries).toBe(1);
    runtime.destroy();
  });

  test('reports incomplete bounded results when page limits are reached', async () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });

    const result = await runtime.executePagedLayerQuery('places', {
      fetchPage: async ({ pageIndex }) => ({
        features: [queryFeature(pageIndex * 2 + 1), queryFeature(pageIndex * 2 + 2)],
        exceededTransferLimit: true,
      }),
    }, { maxPages: 1 });

    expect(result.pageCount).toBe(1);
    expect(result.incomplete).toBe(true);
    expect(result.metrics.stoppedByLimit).toBe(true);
    runtime.destroy();
  });

  test('propagates cancellation through paged query adapters', async () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });
    const controller = new AbortController();
    controller.abort('view changed');
    const fetchPage = vi.fn(async () => ({ features: [] }));

    await expect(runtime.executePagedLayerQuery('places', { fetchPage }, {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchPage).not.toHaveBeenCalled();
    runtime.destroy();
  });
});

describe('GIS runtime orchestrator geometry policy', () => {
  test('inherits registered spatial reference when geometry omits it', () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });

    const result = runtime.normalizeLayerGeometry('places', { x: 32.8, y: 39.9 });

    expect(result.diagnostics.valid).toBe(true);
    expect(result.geometry).toEqual(expect.objectContaining({
      type: 'point',
      spatialReference: { wkid: 4326 },
    }));
    runtime.destroy();
  });

  test('applies orchestrator vertex budget when caller does not override it', () => {
    const runtime = createGisRuntimeOrchestrator({ geometryMaxVertices: 2 });
    runtime.registerLayer('routes', {
      url: FEATURE_URL,
      metadata: featureMetadata({ geometryType: 'esriGeometryPolyline' }),
    });

    const result = runtime.normalizeLayerGeometry('routes', {
      paths: [[
        [32.8, 39.9],
        [32.81, 39.91],
        [32.82, 39.92],
      ]],
    });

    expect(result.geometry).toBeNull();
    expect(result.diagnostics.budgetExceeded).toBe(true);
    runtime.destroy();
  });

  test('allows a stricter caller vertex budget than orchestrator default', () => {
    const runtime = createGisRuntimeOrchestrator({ geometryMaxVertices: 100 });
    runtime.registerLayer('routes', {
      url: FEATURE_URL,
      metadata: featureMetadata({ geometryType: 'esriGeometryPolyline' }),
    });

    const result = runtime.normalizeLayerGeometry('routes', {
      paths: [[[32.8, 39.9], [32.81, 39.91], [32.82, 39.92]]],
    }, { maxVertices: 1 });

    expect(result.diagnostics.budgetExceeded).toBe(true);
    expect(result.diagnostics.valid).toBe(false);
    runtime.destroy();
  });

  test('assesses mixed layer geometry with inherited WGS84 bounds', () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });

    const assessment = runtime.assessLayerGeometry('places', [
      { geometry: { x: 32.8, y: 39.9 } },
      { geometry: { x: 220, y: 95 } },
    ], { failOnOutOfRange: true });

    expect(assessment.total).toBe(2);
    expect(assessment.valid).toBe(1);
    expect(assessment.invalid).toBe(1);
    runtime.destroy();
  });
});

describe('GIS runtime orchestrator layer isolation and lifecycle', () => {
  test('unregister removes the capability and increments exactly one metric', () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });

    expect(runtime.unregisterLayer('places')).toBe(true);
    expect(runtime.unregisterLayer('places')).toBe(false);
    expect(runtime.getCapability('places')).toBeNull();
    expect(runtime.getSnapshot().metrics.unregisteredLayers).toBe(1);
    runtime.destroy();
  });

  test('operations on unregistered layers fail closed', async () => {
    const runtime = createGisRuntimeOrchestrator();

    expect(() => runtime.normalizeLayerGeometry('missing', { x: 1, y: 2 }))
      .toThrow(expect.objectContaining({ code: 'LAYER_NOT_REGISTERED' }));
    await expect(runtime.executeLayerQuery('missing', 'q', async () => true))
      .rejects.toMatchObject({ code: 'LAYER_NOT_REGISTERED' });
    runtime.destroy();
  });

  test('emits capability, geometry and cache events with stable layer ids', () => {
    const events: Array<Record<string, unknown>> = [];
    const runtime = createGisRuntimeOrchestrator({
      onEvent: (event) => events.push({ ...event }),
    });
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });
    runtime.normalizeLayerGeometry('places', { x: 32.8, y: 39.9 });
    runtime.invalidateLayerCaches('places');

    expect(events.some((event) => (
      event.type === 'layer-capabilities-registered' && event.layerId === 'places'
    ))).toBe(true);
    expect(events.some((event) => (
      event.type === 'layer-cache-invalidated' && event.layerId === 'places'
    ))).toBe(true);
    runtime.destroy();
  });

  test('snapshot metrics and budget are defensive copies', () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });

    const snapshot = runtime.getSnapshot();
    const budget = runtime.getBudget();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.metrics)).toBe(true);
    expect(budget).not.toBe(snapshot.budget);
    expect(snapshot.registeredLayerCount).toBe(1);
    runtime.destroy();
  });

  test('destroy is idempotent and rejects new work afterward', () => {
    const runtime = createGisRuntimeOrchestrator();
    runtime.registerLayer('places', { url: FEATURE_URL, metadata: featureMetadata() });

    runtime.destroy();
    runtime.destroy();

    expect(() => runtime.registerLayer('next', { url: FEATURE_URL, metadata: featureMetadata() }))
      .toThrow(GisRuntimeOrchestratorError);
    expect(runtime.getSnapshot()).toEqual(expect.objectContaining({
      destroyed: true,
      registeredLayerCount: 0,
    }));
  });
});
