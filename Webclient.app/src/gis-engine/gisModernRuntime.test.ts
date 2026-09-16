import type { ArcGisMetadataContract } from './arcgisMetadataAdapter';
import { ArcGisQueryRuntime } from './arcgisQueryRuntime';
import { LayerLifecycleManager } from './layerLifecycleManager';
import { buildIconRegistry } from './iconResolver';
import { createRendererPresentation, decideLayerLod, verifyRendererParity } from './rendererPolicy';
import { parseGisRuntimeConfig, RuntimeConfigError } from './runtimeConfig';

const metadata = (): ArcGisMetadataContract => {
  const fields: ArcGisMetadataContract['fields'] = [
    { name: 'OBJECTID', alias: 'OID', type: 'oid', nullable: false, editable: false, length: null, defaultValue: null, domain: null },
    { name: 'NAME', alias: 'NAME', type: 'string', nullable: true, editable: true, length: 255, defaultValue: null, domain: null },
  ];
  return {
    resourceUrl: 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer/0',
    name: 'Kent',
    type: 'Feature Layer',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    objectIdField: 'OBJECTID',
    globalIdField: null,
    displayField: 'NAME',
    geometryField: null,
    maxRecordCount: 2,
    capabilities: new Set(['query', 'pagination', 'order-by']),
    fields,
    fieldMap: new Map(fields.map((field) => [field.name, field])),
    scales: { minScale: 0, maxScale: 0 },
    time: { enabled: false, startField: null, endField: null, trackIdField: null, defaultInterval: null, defaultIntervalUnits: null },
    editing: { create: false, update: false, delete: false, sync: false, attachments: false, supportsApplyEditsWithGlobalIds: false },
    renderer: { type: null, field: null, field2: null, field3: null, normalizationField: null, visualVariableCount: 0, labelingRuleCount: 0, transparency: null },
    hasZ: false,
    hasM: false,
    issues: [],
    queryReady: true,
    identityReady: true,
  };
};

describe('strict GIS runtime config', () => {
  it('accepts ArcGIS catalog entries and resolves layer references', () => {
    const config = parseGisRuntimeConfig({
      services: [{ id: 'poi', type: 'FeatureServer', url: '/arcgis/rest/services/POI/FeatureServer/0' }],
      layers: [{ id: 'poi-layer', serviceId: 'poi', iconKey: 'poi', visible: true }],
      view: { defaultMode: '3d', defaultWkid: 4326 },
      performance: { request: { maxConcurrent: 8 }, query: { maxFeatures: 20_000 } },
    });
    expect(config.valid).toBe(true);
    expect(config.serviceById.has('poi')).toBe(true);
    expect(config.layerById.get('poi-layer')?.serviceId).toBe('poi');
    expect(config.view.defaultMode).toBe('3d');
    expect(config.performance.request.maxConcurrent).toBe(8);
  });

  it('rejects WMS/WFS/WMTS variants at the JSON boundary', () => {
    expect(() => parseGisRuntimeConfig({
      services: [{ id: 'bad', type: 'WMS', url: 'https://example.invalid/wms' }],
      layers: [],
    })).toThrow(RuntimeConfigError);
  });

  it('rejects layers referencing services rejected by the canonical catalog', () => {
    expect(() => parseGisRuntimeConfig({
      services: [{ id: 'missing-url', type: 'FeatureServer' }],
      layers: [{ id: 'x', serviceId: 'missing-url' }],
    })).toThrow('blocking errors');
  });

  it('clamps unsafe browser budgets instead of trusting arbitrary JSON', () => {
    const config = parseGisRuntimeConfig({ services: [], layers: [], performance: { request: { maxConcurrent: 999 } } }, { strict: false });
    expect(config.performance.request.maxConcurrent).toBe(32);
    expect(config.issues.some((entry) => entry.code === 'unsafe-limit-clamped')).toBe(true);
  });
});

describe('layer resource lifecycle', () => {
  it('owns and removes only the layer resources belonging to an owner', async () => {
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const map = { add: (layer: unknown) => added.push(layer), remove: (layer: unknown) => removed.push(layer) };
    const view = { type: '2d', map };
    const layerA = { id: 'a' };
    const layerB = { id: 'b' };
    const lifecycle = new LayerLifecycleManager();
    lifecycle.registerView(view);
    lifecycle.ownLayer({ ownerId: 'tool:a', layer: layerA });
    lifecycle.ownLayer({ ownerId: 'tool:b', layer: layerB });
    lifecycle.attachOwnerLayers('tool:a');
    lifecycle.attachOwnerLayers('tool:b');
    expect(added).toEqual([layerA, layerB]);
    await lifecycle.disposeOwner('tool:a');
    expect(removed).toEqual([layerA]);
    expect(lifecycle.ownerSnapshot('tool:b')?.layerIds).toContain('b');
  });

  it('aborts outstanding owner work when a generation is superseded', () => {
    const lifecycle = new LayerLifecycleManager();
    const controller = lifecycle.createAbortController('search');
    expect(lifecycle.currentGeneration('search')).toBe(0);
    expect(lifecycle.beginGeneration('search')).toBe(1);
    expect(controller.signal.aborted).toBe(true);
    expect(lifecycle.isCurrentGeneration('search', 1)).toBe(true);
  });

  it('removes tracked handles exactly once during owner disposal', async () => {
    const lifecycle = new LayerLifecycleManager();
    let removals = 0;
    lifecycle.trackHandle('identify', { remove: () => { removals += 1; } });
    await lifecycle.disposeOwner('identify');
    await lifecycle.disposeOwner('identify');
    expect(removals).toBe(1);
  });
});

describe('2D/3D renderer parity and LOD', () => {
  const registry = buildIconRegistry([
    { id: 'hospital', icon: '/assets/hospital.svg', aliases: ['health'], type: 'health' },
    { id: 'default', icon: '/assets/default.svg' },
  ]);

  it('uses the same canonical icon resolver for 2D and 3D', () => {
    const parity = verifyRendererParity({ record: { type: 'health', title: 'Hastane' }, registry });
    expect(parity.consistent).toBe(true);
    expect(parity.iconKey2d).toBe(parity.iconKey3d);
    expect(parity.iconUrl2d).toBe(parity.iconUrl3d);
  });

  it('enables clustering under point-density pressure', () => {
    const presentation = createRendererPresentation({
      mode: '2d',
      record: { type: 'health', title: 'Hastane' },
      registry,
      featureCount: 50_000,
      visibleFeatureCount: 50_000,
      deviceClass: 'balanced',
    });
    expect(presentation.cluster.enabled).toBe(true);
    expect(presentation.budget.preferClustering).toBe(true);
  });

  it('suppresses expensive labels while view is moving', () => {
    const presentation = createRendererPresentation({
      mode: '3d',
      record: { type: 'health', title: 'Hastane' },
      registry,
      featureCount: 20,
      moving: true,
    });
    expect(presentation.label.enabled).toBe(false);
    expect(presentation.budget.renderQuality).toBe('economy');
  });

  it('avoids geometry queries for layers outside their scale range', () => {
    const decision = decideLayerLod({ minScale: 50_000, currentScale: 100_000, featureCount: 100 });
    expect(decision.visible).toBe(false);
    expect(decision.queryGeometry).toBe(false);
  });
});

describe('ArcGisQueryRuntime integration', () => {
  it('executes bounded stable pages and de-duplicates object ids', async () => {
    const calls: URLSearchParams[] = [];
    const runtime = new ArcGisQueryRuntime(async (plan) => {
      calls.push(plan.body);
      const offset = Number(plan.body.get('resultOffset') ?? 0);
      if (offset === 0) return {
        features: [
          { attributes: { OBJECTID: 1, NAME: 'A' }, geometry: { x: 32, y: 40, spatialReference: { wkid: 4326 } } },
          { attributes: { OBJECTID: 2, NAME: 'B' }, geometry: { x: 33, y: 40, spatialReference: { wkid: 4326 } } },
        ],
        exceededTransferLimit: true,
      };
      return {
        features: [
          { attributes: { OBJECTID: 2, NAME: 'B duplicate' }, geometry: { x: 33, y: 40, spatialReference: { wkid: 4326 } } },
          { attributes: { OBJECTID: 3, NAME: 'C' }, geometry: { x: 34, y: 40, spatialReference: { wkid: 4326 } } },
        ],
        exceededTransferLimit: false,
      };
    }, { queryLimits: { preferredPageSize: 2, maxFeatures: 10, maxPages: 5 } });

    const result = await runtime.execute(metadata(), { outFields: ['NAME'], returnGeometry: true, cache: false });
    expect(result.features.map((feature) => feature.attributes?.OBJECTID)).toEqual([1, 2, 3]);
    expect(result.diagnostics.duplicateCount).toBe(1);
    expect(result.diagnostics.complete).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('nulls invalid feature geometry in non-strict mode instead of crashing renderers', async () => {
    const runtime = new ArcGisQueryRuntime(async () => ({
      features: [{ attributes: { OBJECTID: 1 }, geometry: { x: Number.NaN, y: 40 } }],
      exceededTransferLimit: false,
    }), { queryLimits: { maxFeatures: 2, preferredPageSize: 2 } });
    const result = await runtime.execute(metadata(), { cache: false });
    expect(result.features[0]?.geometry).toBeNull();
    expect(result.diagnostics.invalidGeometryCount).toBe(1);
    expect(result.diagnostics.droppedInvalidGeometryCount).toBe(1);
  });

  it('fails closed for invalid geometry when strict mode is requested', async () => {
    const runtime = new ArcGisQueryRuntime(async () => ({
      features: [{ attributes: { OBJECTID: 1 }, geometry: { x: Number.POSITIVE_INFINITY, y: 40 } }],
      exceededTransferLimit: false,
    }), { queryLimits: { maxFeatures: 2, preferredPageSize: 2 } });
    await expect(runtime.execute(metadata(), { strictGeometry: true, cache: false })).rejects.toMatchObject({
      code: 'INVALID_FEATURE_GEOMETRY',
    });
  });

  it('retries transient transport failures within a bounded budget', async () => {
    let attempts = 0;
    const runtime = new ArcGisQueryRuntime(async () => {
      attempts += 1;
      if (attempts === 1) throw { status: 503 };
      return { features: [{ attributes: { OBJECTID: 1 } }], exceededTransferLimit: false };
    }, { maxRetries: 1, retryBaseDelayMs: 1, retryMaxDelayMs: 1, queryLimits: { maxFeatures: 2, preferredPageSize: 2 } });
    const result = await runtime.execute(metadata(), { returnGeometry: false, cache: false });
    expect(result.features).toHaveLength(1);
    expect(result.diagnostics.retries).toBe(1);
  });

  it('does not retry a structured non-transient ArcGIS service error', async () => {
    let attempts = 0;
    const runtime = new ArcGisQueryRuntime(async () => {
      attempts += 1;
      return { error: { code: 400, message: 'Bad query' }, features: [] };
    }, { maxRetries: 3, queryLimits: { maxFeatures: 2, preferredPageSize: 2 } });
    await expect(runtime.execute(metadata(), { cache: false })).rejects.toMatchObject({ code: 'ARCGIS_SERVICE_ERROR' });
    expect(attempts).toBe(1);
  });

  it('deduplicates equivalent concurrent runtime executions through the shared coordinator', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new ArcGisQueryRuntime(async () => {
      calls += 1;
      await gate;
      return { features: [{ attributes: { OBJECTID: 1 } }], exceededTransferLimit: false };
    }, { queryLimits: { maxFeatures: 2, preferredPageSize: 2 } });
    const first = runtime.execute(metadata(), { returnGeometry: false });
    const second = runtime.execute(metadata(), { returnGeometry: false });
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(runtime.snapshot().deduped).toBe(1);
  });
});
