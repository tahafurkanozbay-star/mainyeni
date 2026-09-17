import { describe, expect, test } from 'vitest';
import { createArcGisQuerySessionRuntime } from './arcgisQuerySessionRuntime';

const metadata = {
  type: 'Feature Layer',
  capabilities: 'Query',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  maxRecordCount: 2,
  extent: { spatialReference: { wkid: 3857 } },
  fields: [
    { name: 'OBJECTID', alias: 'Object ID', type: 'esriFieldTypeOID' },
    { name: 'NAME', alias: 'Name', type: 'esriFieldTypeString' },
  ],
  advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
};

const descriptor = {
  layerId: 'places',
  resourceUrl: 'https://example.test/arcgis/rest/services/Places/FeatureServer/0',
  metadata,
  metadataVersion: 'v1',
};

describe('arcgisQuerySessionRuntime', () => {
  test('registers only query-ready verified ArcGIS REST layers', () => {
    const runtime = createArcGisQuerySessionRuntime({ queryFeatures: async () => ({ features: [] }) });
    const contract = runtime.registerLayer(descriptor);
    expect(contract.supportsQuery).toBe(true);
    expect(contract.objectIdField).toBe('OBJECTID');
    expect(runtime.snapshot().layerCount).toBe(1);
  });

  test('rejects WMS/WFS and generic URLs at registration', () => {
    const runtime = createArcGisQuerySessionRuntime({ queryFeatures: async () => ({ features: [] }) });
    expect(() => runtime.registerLayer({ ...descriptor, resourceUrl: 'https://example.test/wms' }))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN_OGC_RESOURCE' }));
    expect(() => runtime.registerLayer({ ...descriptor, resourceUrl: 'https://example.test/api/layer' }))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_RESOURCE_URL' }));
  });

  test('rejects capability contracts that are not query-ready', () => {
    const runtime = createArcGisQuerySessionRuntime({ queryFeatures: async () => ({ features: [] }) });
    expect(() => runtime.registerLayer({
      ...descriptor,
      metadata: { type: 'Feature Layer', capabilities: 'Query', geometryType: 'esriGeometryPoint', fields: metadata.fields },
    })).toThrow(expect.objectContaining({ code: 'CAPABILITY_NOT_QUERY_READY' }));
  });

  test('executes offset pagination through the injected transport only', async () => {
    const calls: Record<string, unknown>[] = [];
    const runtime = createArcGisQuerySessionRuntime({
      queryFeatures: async ({ parameters }) => {
        calls.push({ ...parameters });
        const offset = Number(parameters.resultOffset ?? 0);
        if (offset === 0) return { features: [{ attributes: { OBJECTID: 1 } }, { attributes: { OBJECTID: 2 } }], exceededTransferLimit: true };
        return { features: [{ attributes: { OBJECTID: 3 } }], exceededTransferLimit: false };
      },
    });
    runtime.registerLayer(descriptor);
    const result = await runtime.execute('places', { where: '1=1' }, { pageSize: 2, maxPages: 4 });
    expect(result.features).toHaveLength(3);
    expect(result.pageCount).toBe(2);
    expect(calls[0]).toEqual(expect.objectContaining({ resultOffset: 0, resultRecordCount: 2 }));
    expect(calls[1]).toEqual(expect.objectContaining({ resultOffset: 2, resultRecordCount: 2 }));
  });

  test('filters requested outFields to metadata-advertised fields', async () => {
    let observed = '';
    const runtime = createArcGisQuerySessionRuntime({
      queryFeatures: async ({ parameters }) => {
        observed = String(parameters.outFields ?? '');
        return { features: [] };
      },
    });
    runtime.registerLayer(descriptor);
    await runtime.execute('places', {}, { outFields: ['NAME', 'SECRET', 'OBJECTID', 'NAME'] });
    expect(observed).toBe('NAME,OBJECTID');
  });

  test('dedupes identical concurrent queries and fans out one result', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createArcGisQuerySessionRuntime({
      queryFeatures: async () => {
        calls += 1;
        await gate;
        return { features: [{ attributes: { OBJECTID: 1 } }] };
      },
    });
    runtime.registerLayer(descriptor);
    const first = runtime.execute('places', { where: 'NAME IS NOT NULL' });
    const second = runtime.execute('places', { where: 'NAME IS NOT NULL' });
    expect(runtime.snapshot().inFlightCount).toBe(1);
    release?.();
    const [left, right] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(left.features).toEqual(right.features);
    expect(runtime.snapshot().metrics.deduped).toBe(1);
  });

  test('uses bounded TTL cache for repeat queries', async () => {
    let calls = 0;
    const runtime = createArcGisQuerySessionRuntime({
      queryFeatures: async () => {
        calls += 1;
        return { features: [{ attributes: { OBJECTID: calls } }] };
      },
    }, { cacheTtlMs: 60_000, maxCacheEntries: 2 });
    runtime.registerLayer(descriptor);
    await runtime.execute('places', { where: 'A=1' });
    const cached = await runtime.execute('places', { where: 'A=1' });
    expect(calls).toBe(1);
    expect(cached.features[0]?.attributes?.OBJECTID).toBe(1);
    expect(runtime.snapshot().metrics.cacheHits).toBe(1);
  });

  test('invalidates layer cache when metadata version changes', async () => {
    let calls = 0;
    const runtime = createArcGisQuerySessionRuntime({
      queryFeatures: async () => ({ features: [{ attributes: { OBJECTID: ++calls } }] }),
    });
    runtime.registerLayer(descriptor);
    await runtime.execute('places', { where: '1=1' });
    runtime.registerLayer({ ...descriptor, metadataVersion: 'v2' });
    const result = await runtime.execute('places', { where: '1=1' });
    expect(calls).toBe(2);
    expect(result.features[0]?.attributes?.OBJECTID).toBe(2);
  });

  test('fails closed on spatial-reference mismatch instead of assuming reprojection', async () => {
    const runtime = createArcGisQuerySessionRuntime({ queryFeatures: async () => ({ features: [] }) });
    runtime.registerLayer(descriptor);
    await expect(runtime.execute('places', { outSR: 4326 })).rejects.toEqual(
      expect.objectContaining({ code: 'SPATIAL_REFERENCE_MISMATCH' }),
    );
  });

  test('accepts the service spatial reference when explicitly requested', async () => {
    const runtime = createArcGisQuerySessionRuntime({ queryFeatures: async () => ({ features: [] }) });
    runtime.registerLayer(descriptor);
    await expect(runtime.execute('places', { outSR: 3857 })).resolves.toEqual(expect.objectContaining({ features: [] }));
  });

  test('supports subscriber cancellation without corrupting shared callers', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createArcGisQuerySessionRuntime({
      queryFeatures: async () => {
        await gate;
        return { features: [{ attributes: { OBJECTID: 1 } }] };
      },
    });
    runtime.registerLayer(descriptor);
    const controller = new AbortController();
    const cancelled = runtime.execute('places', { where: '1=1' }, { signal: controller.signal });
    const survivor = runtime.execute('places', { where: '1=1' });
    controller.abort('superseded');
    await expect(cancelled).rejects.toEqual(expect.objectContaining({ name: 'AbortError' }));
    release?.();
    await expect(survivor).resolves.toEqual(expect.objectContaining({ features: expect.any(Array) }));
  });

  test('aborts underlying work when every subscriber cancels', async () => {
    let observedAbort = false;
    const runtime = createArcGisQuerySessionRuntime({
      queryFeatures: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          observedAbort = true;
          reject(new Error('aborted'));
        }, { once: true });
      }),
    });
    runtime.registerLayer(descriptor);
    const controller = new AbortController();
    const pending = runtime.execute('places', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toEqual(expect.objectContaining({ name: 'AbortError' }));
    await Promise.resolve();
    expect(observedAbort).toBe(true);
  });

  test('enforces an in-flight backpressure bound', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createArcGisQuerySessionRuntime({
      queryFeatures: async () => { await gate; return { features: [] }; },
    }, { maxInFlight: 1 });
    runtime.registerLayer(descriptor);
    const first = runtime.execute('places', { where: 'A=1' });
    await expect(runtime.execute('places', { where: 'B=1' })).rejects.toEqual(
      expect.objectContaining({ code: 'BACKPRESSURE_LIMIT' }),
    );
    release?.();
    await first;
  });

  test('unregister cancels in-flight work and removes the layer', async () => {
    const runtime = createArcGisQuerySessionRuntime({
      queryFeatures: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('invalidated')), { once: true });
      }),
    });
    runtime.registerLayer(descriptor);
    const pending = runtime.execute('places', {});
    expect(runtime.unregisterLayer('places')).toBe(true);
    await expect(pending).rejects.toThrow('invalidated');
    expect(runtime.snapshot().layerCount).toBe(0);
  });

  test('supports object-id pagination through an injected object-id adapter', async () => {
    const runtime = createArcGisQuerySessionRuntime({
      queryObjectIds: async () => ({ objectIds: [1, 2, 3] }),
      queryFeatures: async ({ parameters }) => {
        const ids = String(parameters.objectIds ?? '').split(',').filter(Boolean);
        return { features: ids.map((id) => ({ attributes: { OBJECTID: Number(id) } })) };
      },
    });
    runtime.registerLayer({
      ...descriptor,
      metadata: { ...metadata, advancedQueryCapabilities: { supportsPagination: false, supportsOrderBy: false } },
    });
    const result = await runtime.execute('places', {}, { strategy: 'object-ids', pageSize: 2 });
    expect(result.features.map((feature) => feature.attributes?.OBJECTID)).toEqual([1, 2, 3]);
  });

  test('destroy cancels work, clears resources and rejects new execution', async () => {
    const runtime = createArcGisQuerySessionRuntime({ queryFeatures: async () => ({ features: [] }) });
    runtime.registerLayer(descriptor);
    runtime.destroy();
    expect(runtime.snapshot().destroyed).toBe(true);
    expect(runtime.snapshot().layerCount).toBe(0);
    await expect(runtime.execute('places')).rejects.toEqual(expect.objectContaining({ code: 'RUNTIME_DESTROYED' }));
  });
});
