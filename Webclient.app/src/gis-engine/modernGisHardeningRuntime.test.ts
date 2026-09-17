import { describe, expect, it, vi } from 'vitest';
import {
  createModernGisHardeningRuntime,
  ModernGisHardeningRuntime,
} from './modernGisHardeningRuntime';

const serviceUrl = 'https://example.invalid/arcgis/rest/services/Places/FeatureServer/0';
const metadata = {
  name: 'Places',
  type: 'Feature Layer',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  maxRecordCount: 2,
  capabilities: 'Query',
  spatialReference: { wkid: 4326 },
  fields: [{ name: 'OBJECTID' }, { name: 'NAME' }],
  advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
};

const feature = (id: number, x = id, y = id) => ({
  attributes: { OBJECTID: id, NAME: `Place ${id}` },
  geometry: { x, y, spatialReference: { wkid: 4326 } },
});

describe('modernGisHardeningRuntime', () => {
  it('registers capability-aware services and exposes deterministic snapshots', () => {
    const runtime = createModernGisHardeningRuntime();
    const session = runtime.registerService('places', {
      serviceUrl,
      metadata,
      executor: { execute: vi.fn(async () => ({ features: [] })) },
    });

    expect(session.capabilities.objectIdField).toBe('OBJECTID');
    expect(runtime.snapshot().services).toEqual([
      expect.objectContaining({ key: 'places', serviceUrl, disposed: false }),
    ]);
  });

  it('rejects duplicate service keys', () => {
    const runtime = createModernGisHardeningRuntime();
    const configuration = {
      serviceUrl,
      metadata,
      executor: { execute: vi.fn(async () => ({ features: [] })) },
    };
    runtime.registerService('places', configuration);

    expect(() => runtime.registerService('places', configuration)).toThrow(/already registered/);
  });

  it('runs bounded query pagination through integrity quarantine before returning features', async () => {
    const execute = vi.fn(async (plan) => Number(plan.params.resultOffset) === 0
      ? { features: [feature(1), feature(2)], exceededTransferLimit: true }
      : {
          features: [feature(3), { attributes: { OBJECTID: 4, NAME: 'Broken' }, geometry: { x: Number.NaN, y: 4 } }],
          exceededTransferLimit: false,
        });
    const runtime = createModernGisHardeningRuntime();
    runtime.registerService('places', { serviceUrl, metadata, executor: { execute } });

    const result = await runtime.queryAllSafe('places', { resultRecordCount: 2, maxRecords: 10 });

    expect(result.query.pages).toBe(2);
    expect(result.query.features).toHaveLength(4);
    expect(result.integrity.quarantined).toHaveLength(1);
    expect(result.features.map((item) => item.attributes?.OBJECTID)).toEqual([1, 2, 3]);
  });

  it('fails explicitly for unknown services instead of inventing a network endpoint', async () => {
    const runtime = createModernGisHardeningRuntime();
    await expect(runtime.queryAllSafe('missing')).rejects.toMatchObject({ code: 'GIS_SERVICE_NOT_REGISTERED' });
  });

  it('runs global integrity checks for caller-owned feature batches', () => {
    const runtime = createModernGisHardeningRuntime({
      integrity: { mode: 'quarantine', objectIdField: 'OBJECTID', expectedGeometryType: 'point' },
    });
    const result = runtime.inspectFeatures([
      feature(1),
      { attributes: { OBJECTID: 2 }, geometry: { invalid: true } },
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.quarantined).toHaveLength(1);
  });

  it('evaluates clusters through the shared workload budget', () => {
    const runtime = createModernGisHardeningRuntime();
    const result = runtime.evaluateClusters({
      features: Array.from({ length: 2_000 }, (_, index) => ({ id: index, x: index % 50, y: Math.floor(index / 50) })),
      viewport: { width: 1_000, height: 800, zoom: 10 },
      performance: { frameMs: 30, deviceMemoryGb: 4 },
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(runtime.snapshot().workload.completed).toBe(1);
  });

  it('reconciles layer state through the shared 2D/3D parity runtime', () => {
    const runtime = createModernGisHardeningRuntime();
    const result = runtime.reconcileLayer({
      id: 'places',
      renderer: { key: 'places-renderer', iconKey: 'places' },
      elevationMode: 'on-the-ground',
    }, { viewMode: '3d' });

    expect(result.state.rendererKey).toBe('places-renderer');
    expect(result.state.iconKey).toBe('places');
    expect(result.state.elevationMode).toBe('on-the-ground');
  });

  it('accepts external workload accounting without coupling to ArcGIS network logic', () => {
    const runtime = createModernGisHardeningRuntime({ workload: { budgets: { scene: { maxActive: 1 } } } });
    const first = runtime.admitWorkload({ id: 'scene-a', lane: 'scene', priority: 'interactive' });
    const second = runtime.admitWorkload({ id: 'scene-b', lane: 'scene', priority: 'background' });

    expect(first.decision).toBe('start');
    expect(second.decision).toBe('queue');
  });

  it('propagates performance pressure to workload admission', () => {
    const runtime = createModernGisHardeningRuntime();
    expect(runtime.samplePerformance({ frameMs: 70, memoryGb: 8 })).toBe('critical');
    expect(runtime.snapshot().workload.pressure).toBe('critical');
  });

  it('unregisters services by disposing their session and integrity state', () => {
    const runtime = createModernGisHardeningRuntime();
    const session = runtime.registerService('places', {
      serviceUrl,
      metadata,
      executor: { execute: vi.fn(async () => ({ features: [] })) },
    });

    expect(runtime.unregisterService('places')).toBe(true);
    expect(session.disposed).toBe(true);
    expect(runtime.getService('places')).toBeNull();
    expect(runtime.unregisterService('places')).toBe(false);
  });

  it('disposes every subsystem and rejects future work', () => {
    const runtime = new ModernGisHardeningRuntime();
    runtime.registerService('places', {
      serviceUrl,
      metadata,
      executor: { execute: vi.fn(async () => ({ features: [] })) },
    });
    runtime.dispose();

    expect(runtime.snapshot()).toMatchObject({ disposed: true, services: [] });
    expect(runtime.snapshot().workload.disposed).toBe(true);
    expect(runtime.snapshot().cluster.disposed).toBe(true);
    expect(runtime.snapshot().integrity.disposed).toBe(true);
    expect(() => runtime.inspectFeatures([feature(1)])).toThrow(/disposed/);
  });
});
