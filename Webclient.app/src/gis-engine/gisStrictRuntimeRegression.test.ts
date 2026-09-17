import { describe, expect, test, vi } from 'vitest';
import {
  ARCGIS_PAGINATION_STRATEGY,
  createArcGisPaginationPlan,
  executeArcGisPagination,
  mergeArcGisFeaturePages,
} from './arcgisPaginationRuntime';
import {
  createArcGisRequestScheduler,
} from './arcgisRequestScheduler';
import {
  GEOMETRY_ISSUE,
  assessGeometryCollection,
  geometryExtent,
  normalizeGeometry,
} from './geometryIntegrityRuntime';
import {
  GIS_LAYER_STATE,
  createLayerLifecycleRuntime,
} from './layerLifecycleRuntime';
import {
  ArcGisCapabilityError,
  assessCapabilityContract,
  assertAllowedArcGisResourceUrl,
  buildArcGisCapabilityContract,
  selectCapabilityFields,
} from './serviceCapabilityRuntime';

const SERVICE_URL = 'https://example.test/arcgis/rest/services/Places/FeatureServer/0';

const metadata = (overrides: Record<string, unknown> = {}) => ({
  name: 'Places',
  type: 'Feature Layer',
  capabilities: 'Query',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  maxRecordCount: 2,
  extent: { spatialReference: { wkid: 4326 } },
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID', nullable: false, editable: false },
    { name: 'NAME', type: 'esriFieldTypeString', length: 120 },
  ],
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsOrderBy: true,
    supportsStatistics: true,
  },
  ...overrides,
});

const feature = (id: number | string, name = `feature-${id}`) => ({
  attributes: { OBJECTID: id, NAME: name },
  geometry: { x: Number(id), y: Number(id) },
});

describe('strict ArcGIS capability boundary', () => {
  test('keeps WMS/WFS blocked regardless of casing or query position', () => {
    const invalid = [
      'https://example.test/WMS',
      'https://example.test/arcgis?SERVICE=wFs&request=GetCapabilities',
      'https://example.test/path/wfs/items',
    ];

    invalid.forEach((url) => {
      expect(() => assertAllowedArcGisResourceUrl(url)).toThrow(ArcGisCapabilityError);
    });
  });

  test('accepts only recognized ArcGIS REST resource families', () => {
    expect(assertAllowedArcGisResourceUrl(SERVICE_URL)).toBe(SERVICE_URL);
    expect(assertAllowedArcGisResourceUrl('https://example.test/rest/services/A/MapServer/2'))
      .toContain('/MapServer/2');
    expect(() => assertAllowedArcGisResourceUrl('https://example.test/api/layers/2'))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_RESOURCE_URL' }));
  });

  test('normalizes a query-ready contract without inventing editing rights', () => {
    const contract = buildArcGisCapabilityContract({
      url: SERVICE_URL,
      serviceId: 'places',
      metadata: metadata(),
    });

    expect(contract.serviceId).toBe('places');
    expect(contract.supportsQuery).toBe(true);
    expect(contract.supportsPagination).toBe(true);
    expect(contract.supportsOrderBy).toBe(true);
    expect(contract.editing.editing).toBe(false);
    expect(assessCapabilityContract(contract)).toEqual({
      valid: true,
      issues: [],
      queryReady: true,
      stableIdentity: true,
    });
  });

  test('treats pagination without stable ordering evidence as an integrity issue', () => {
    const contract = buildArcGisCapabilityContract({
      metadata: metadata({
        objectIdField: undefined,
        fields: [{ name: 'NAME', type: 'esriFieldTypeString' }],
        advancedQueryCapabilities: {
          supportsPagination: true,
          supportsOrderBy: false,
        },
      }),
    });

    expect(assessCapabilityContract(contract).issues)
      .toContain('pagination-without-stable-identity');
  });

  test('selects only advertised fields and deduplicates caller input', () => {
    const contract = buildArcGisCapabilityContract({ metadata: metadata() });
    expect(selectCapabilityFields(contract, ['NAME', 'OBJECTID', 'NAME', 'MISSING']))
      .toEqual(['NAME', 'OBJECTID']);
  });

  test('freezes normalized capability arrays and field records', () => {
    const contract = buildArcGisCapabilityContract({ metadata: metadata() });
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.fields)).toBe(true);
    expect(Object.isFrozen(contract.fields[0])).toBe(true);
    expect(Object.isFrozen(contract.queryCapabilities)).toBe(true);
  });
});

describe('strict ArcGIS pagination integrity', () => {
  test('keeps offset pagination bounded by verified service record count', () => {
    const plan = createArcGisPaginationPlan(metadata({ maxRecordCount: 250 }), {
      pageSize: 9999,
      maxPageSize: 5000,
      maxPages: 5,
      maxFeatures: 1000,
    });

    expect(plan.strategy).toBe(ARCGIS_PAGINATION_STRATEGY.OFFSET);
    expect(plan.pageSize).toBe(250);
    expect(plan.maxPages).toBe(5);
    expect(plan.maxFeatures).toBe(1000);
    expect(plan.orderByFields).toEqual(['OBJECTID ASC']);
  });

  test('falls back from malformed numeric limits to safe defaults', () => {
    const plan = createArcGisPaginationPlan(metadata(), {
      pageSize: Number.NaN,
      maxPages: -1,
      maxFeatures: 0,
    });

    expect(plan.pageSize).toBe(2);
    expect(plan.maxPages).toBeGreaterThan(0);
    expect(plan.maxFeatures).toBeGreaterThan(0);
  });

  test('preserves object id zero as a valid deterministic identity', () => {
    const merged = mergeArcGisFeaturePages([
      { features: [feature(0), feature(1)] },
      { features: [feature(0, 'duplicate-zero'), feature(2)] },
    ], { objectIdField: 'OBJECTID' });

    expect(merged.features.map((item) => item.attributes.OBJECTID)).toEqual([0, 1, 2]);
    expect(merged.duplicates).toBe(1);
  });

  test('marks repeated offset pages incomplete instead of looping indefinitely', async () => {
    const fetchPage = vi.fn(async () => ({
      features: [feature(1), feature(2)],
      exceededTransferLimit: true,
    }));

    const result = await executeArcGisPagination({
      metadata: metadata(),
      options: { maxPages: 20 },
      fetchPage,
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.incomplete).toBe(true);
    expect(result.metrics.stoppedByNoProgress).toBe(true);
    expect(result.features).toHaveLength(2);
  });

  test('stops before transport when cancellation is already requested', async () => {
    const controller = new AbortController();
    controller.abort('navigation changed');
    const fetchPage = vi.fn(async () => ({ features: [] }));

    await expect(executeArcGisPagination({
      metadata: metadata(),
      options: { signal: controller.signal },
      fetchPage,
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  test('uses object-id chunks when offset pagination is explicitly unsupported', async () => {
    const calls: string[][] = [];
    const result = await executeArcGisPagination({
      metadata: metadata({
        advancedQueryCapabilities: {
          supportsPagination: false,
          supportsOrderBy: false,
        },
      }),
      options: { pageSize: 2 },
      fetchObjectIds: async () => ({ objectIds: [5, 4, 4, 3] }),
      fetchPage: async (request) => {
        const ids = [...(request.objectIds ?? [])];
        calls.push(ids);
        return { features: ids.map((id) => feature(id)) };
      },
    });

    expect(calls).toEqual([['5', '4'], ['3']]);
    expect(result.features).toHaveLength(3);
    expect(result.objectIdCount).toBe(3);
  });
});

describe('geometry integrity budgets', () => {
  test('repairs an open polygon ring deterministically', () => {
    const result = normalizeGeometry({
      type: 'polygon',
      spatialReference: { wkid: 4326 },
      rings: [[
        [32.8, 39.9],
        [32.9, 39.9],
        [32.9, 40.0],
      ]],
    });

    expect(result.diagnostics.valid).toBe(true);
    expect(result.diagnostics.repairedRings).toBe(1);
    expect(result.diagnostics.issues.map((issue) => issue.code)).toContain(GEOMETRY_ISSUE.OPEN_RING);
  });

  test('fails closed when an explicit vertex budget is exceeded', () => {
    const result = normalizeGeometry({
      type: 'polyline',
      spatialReference: { wkid: 4326 },
      paths: [[
        [32.8, 39.9],
        [32.81, 39.91],
        [32.82, 39.92],
        [32.83, 39.93],
      ]],
    }, { maxVertices: 2 });

    expect(result.geometry).toBeNull();
    expect(result.diagnostics.valid).toBe(false);
    expect(result.diagnostics.budgetExceeded).toBe(true);
    expect(result.diagnostics.issues.map((issue) => issue.code))
      .toContain(GEOMETRY_ISSUE.VERTEX_BUDGET_EXCEEDED);
  });

  test('flags out-of-range WGS84 coordinates when configured as fatal', () => {
    const result = normalizeGeometry({
      type: 'point',
      x: 200,
      y: 95,
      spatialReference: { wkid: 4326 },
    }, { failOnOutOfRange: true });

    expect(result.geometry).toBeNull();
    expect(result.diagnostics.valid).toBe(false);
    expect(result.diagnostics.issues.map((issue) => issue.code)).toContain(GEOMETRY_ISSUE.OUT_OF_RANGE);
  });

  test('computes a stable extent from valid multipart coordinates', () => {
    expect(geometryExtent({
      type: 'polyline',
      paths: [
        [[10, 20], [15, 30]],
        [[5, 25], [12, 18]],
      ],
      spatialReference: { wkid: 4326 },
    })).toEqual({
      xmin: 5,
      ymin: 18,
      xmax: 15,
      ymax: 30,
      spatialReference: { wkid: 4326 },
    });
  });

  test('summarizes invalid collection entries without throwing', () => {
    const assessment = assessGeometryCollection([
      { geometry: { x: 32.8, y: 39.9, spatialReference: { wkid: 4326 } } },
      { geometry: null },
      { geometry: { paths: [[[1, 2]]] } },
    ]);

    expect(assessment.total).toBe(3);
    expect(assessment.valid).toBe(1);
    expect(assessment.invalid).toBe(2);
    expect(assessment.missing).toBe(1);
    expect(assessment.invalidIndexes).toEqual([1, 2]);
  });
});

describe('request scheduler concurrency and cancellation', () => {
  test('deduplicates concurrent requests with the same stable key', async () => {
    let resolveTransport: ((value: { ok: boolean }) => void) | null = null;
    const execute = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => {
      resolveTransport = resolve;
    }));
    const scheduler = createArcGisRequestScheduler({ maxConcurrent: 2 });

    const first = scheduler.schedule({ key: 'places:1', resourceUrl: SERVICE_URL, execute });
    const second = scheduler.schedule({ key: 'places:1', resourceUrl: SERVICE_URL, execute });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot().metrics.deduped).toBe(1);

    resolveTransport?.({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    scheduler.destroy();
  });

  test('cancelling one deduped subscriber does not abort remaining subscribers', async () => {
    let resolveTransport: ((value: string) => void) | null = null;
    let transportSignal: AbortSignal | null = null;
    const execute = vi.fn(({ signal }: { signal: AbortSignal }) => {
      transportSignal = signal;
      return new Promise<string>((resolve) => {
        resolveTransport = resolve;
      });
    });
    const scheduler = createArcGisRequestScheduler();
    const controller = new AbortController();

    const cancellable = scheduler.schedule({
      key: 'places:shared',
      resourceUrl: SERVICE_URL,
      signal: controller.signal,
      execute,
    });
    const survivor = scheduler.schedule({
      key: 'places:shared',
      resourceUrl: SERVICE_URL,
      execute,
    });

    controller.abort('consumer left view');
    await expect(cancellable).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportSignal?.aborted).toBe(false);

    resolveTransport?.('done');
    await expect(survivor).resolves.toBe('done');
    scheduler.destroy();
  });

  test('enforces per-origin concurrency while allowing queued work to drain', async () => {
    const releases: Array<() => void> = [];
    const scheduler = createArcGisRequestScheduler({
      maxConcurrent: 3,
      maxConcurrentPerOrigin: 1,
    });
    const execute = vi.fn(() => new Promise<string>((resolve) => {
      releases.push(() => resolve('ok'));
    }));

    const one = scheduler.schedule({ key: 'q1', resourceUrl: SERVICE_URL, execute });
    const two = scheduler.schedule({ key: 'q2', resourceUrl: SERVICE_URL, execute });
    const three = scheduler.schedule({ key: 'q3', resourceUrl: SERVICE_URL, execute });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot().activeCount).toBe(1);
    expect(scheduler.getSnapshot().queueDepth).toBe(2);

    releases.shift()?.();
    await one;
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await two;
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await three;
    scheduler.destroy();
  });

  test('serves a fresh cached result without executing transport again', async () => {
    let now = 1000;
    const scheduler = createArcGisRequestScheduler({
      now: () => now,
      cacheTtlMs: 100,
      staleTtlMs: 100,
    });
    const execute = vi.fn(async () => ({ value: 42 }));

    await expect(scheduler.schedule({ key: 'cached', resourceUrl: SERVICE_URL, execute }))
      .resolves.toEqual({ value: 42 });
    now += 50;
    await expect(scheduler.schedule({ key: 'cached', resourceUrl: SERVICE_URL, execute }))
      .resolves.toEqual({ value: 42 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot().metrics.cacheHits).toBeGreaterThanOrEqual(1);
    scheduler.destroy();
  });
});

describe('layer lifecycle resource ownership and budgets', () => {
  test('serializes create and attach and exposes a stable attached snapshot', async () => {
    const create = vi.fn(async (descriptor: Record<string, unknown>) => ({
      id: descriptor.id,
      visible: false,
    }));
    const attach = vi.fn(async () => undefined);
    const runtime = createLayerLifecycleRuntime({
      adapters: { create, attach },
    });

    runtime.registerLayer('places', { resourceUrl: SERVICE_URL, estimatedBytes: 1024 });
    const instance = await runtime.attach('places', { id: 'map-2d' });

    expect(instance).toEqual(expect.objectContaining({ id: 'places', visible: true }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(runtime.getLayer('places')).toEqual(expect.objectContaining({
      state: GIS_LAYER_STATE.ATTACHED,
      attachedViewKey: 'map-2d',
      visible: true,
      resident: true,
    }));
    await runtime.destroy();
  });

  test('owner retention protects a resident layer from ordinary budget eviction', async () => {
    const destroy = vi.fn(async () => undefined);
    const runtime = createLayerLifecycleRuntime({
      maxResidentLayers: 1,
      idleTtlMs: 0,
      adapters: { destroy },
    });

    runtime.registerLayer('a', { instance: { id: 'a' }, resourceUrl: SERVICE_URL });
    runtime.registerLayer('b', { instance: { id: 'b' }, resourceUrl: SERVICE_URL });
    const release = runtime.retain('a', 'map-view');
    await runtime.sweep({ reason: 'test-budget' });

    expect(runtime.getLayer('a')?.resident).toBe(true);
    expect(runtime.getSnapshot().residentLayers).toBe(1);
    expect(runtime.getLayer('b')?.resident).toBe(false);
    expect(release()).toBe(true);
    await runtime.destroy();
  });

  test('forced eviction releases a pinned layer only when explicitly requested', async () => {
    const destroy = vi.fn(async () => undefined);
    const runtime = createLayerLifecycleRuntime({ adapters: { destroy } });
    runtime.registerLayer('pinned', {
      instance: { id: 'pinned' },
      resourceUrl: SERVICE_URL,
      pinned: true,
    });

    await expect(runtime.evict('pinned')).resolves.toBe(false);
    expect(runtime.getLayer('pinned')?.resident).toBe(true);
    await expect(runtime.evict('pinned', { force: true, reason: 'admin-release' })).resolves.toBe(true);
    expect(runtime.getLayer('pinned')).toEqual(expect.objectContaining({
      state: GIS_LAYER_STATE.EVICTED,
      resident: false,
    }));
    await runtime.destroy();
  });

  test('rejects an in-place ArcGIS resource URL swap while the layer is resident', () => {
    const runtime = createLayerLifecycleRuntime();
    runtime.registerLayer('places', { instance: { id: 'places' }, resourceUrl: SERVICE_URL });

    expect(() => runtime.registerLayer('places', {
      resourceUrl: 'https://example.test/arcgis/rest/services/Other/FeatureServer/0',
    })).toThrow(expect.objectContaining({ code: 'RESOURCE_URL_CHANGE_REQUIRES_EVICTION' }));
  });

  test('destroy evicts resident instances and clears runtime state', async () => {
    const destroy = vi.fn(async () => undefined);
    const runtime = createLayerLifecycleRuntime({ adapters: { destroy } });
    runtime.registerLayer('one', { instance: { id: 'one' }, resourceUrl: SERVICE_URL });
    runtime.registerLayer('two', { instance: { id: 'two' }, resourceUrl: SERVICE_URL });

    await runtime.destroy();

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot()).toEqual(expect.objectContaining({
      destroyed: true,
      layerCount: 0,
      residentLayers: 0,
    }));
  });
});
