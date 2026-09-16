import { adaptArcGisLayerMetadata } from './arcgisMetadataAdapter';
import {
  createArcGisQueryExecutor,
  createArcGisQueryRequestKey,
  mergeArcGisQueryPages,
  type ArcGisQueryTransport,
} from './arcgisQueryExecutor';
import { createArcGisQueryPlan } from './arcgisQueryContract';

const resourceUrl = 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer/0';
const contract = adaptArcGisLayerMetadata(resourceUrl, {
  name: 'Kent',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  globalIdField: 'GLOBALID',
  displayField: 'NAME',
  maxRecordCount: 1000,
  capabilities: 'Query',
  extent: { spatialReference: { wkid: 4326 } },
  advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID' },
    { name: 'GLOBALID', type: 'esriFieldTypeGlobalID' },
    { name: 'NAME', type: 'esriFieldTypeString' },
  ],
});

const response = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  json: async () => payload,
});

const spec = {
  where: 'STATUS = 1',
  outFields: ['OBJECTID', 'GLOBALID', 'NAME'],
  returnGeometry: true,
  window: { resultOffset: 0, resultRecordCount: 1000 },
} as const;

describe('arcgisQueryExecutor', () => {
  it('executes the typed query plan through an injected transport', async () => {
    const calls: unknown[] = [];
    const transport: ArcGisQueryTransport = async (request) => {
      calls.push(request);
      return response({
        objectIdFieldName: 'OBJECTID',
        features: [
          { attributes: { OBJECTID: 0, GLOBALID: '{ABC}', NAME: 'Sifir Kimlik' }, geometry: { x: 32, y: 39 } },
          { attributes: { OBJECTID: 1, GLOBALID: '{DEF}', NAME: 'Bir' }, geometry: { x: 33, y: 40 } },
        ],
      });
    };
    const executor = createArcGisQueryExecutor({ transport });
    const result = await executor.execute(contract, spec, { requireStableIdentity: true });
    expect(calls).toHaveLength(1);
    expect(result.returnedFeatureCount).toBe(2);
    expect(result.identities[0]?.objectId).toBe(0);
    expect(result.identities.every((identity) => identity.stable)).toBe(true);
    expect(result.queryUrl).toBe(`${resourceUrl}/query`);
  });

  it('deduplicates repeated features by service identity while preserving first occurrence', async () => {
    const executor = createArcGisQueryExecutor({
      transport: async () => response({
        features: [
          { attributes: { OBJECTID: 7, NAME: 'First' } },
          { attributes: { OBJECTID: 7, NAME: 'Duplicate' } },
          { attributes: { OBJECTID: 8, NAME: 'Second' } },
        ],
      }),
    });
    const result = await executor.execute(contract, spec);
    expect(result.rawFeatureCount).toBe(3);
    expect(result.returnedFeatureCount).toBe(2);
    expect(result.duplicateCount).toBe(1);
    expect(result.features[0]?.attributes.NAME).toBe('First');
  });

  it('surfaces transfer limits instead of silently claiming completeness', async () => {
    const executor = createArcGisQueryExecutor({
      transport: async () => response({ features: [], exceededTransferLimit: true }),
    });
    const result = await executor.execute(contract, spec);
    expect(result.exceededTransferLimit).toBe(true);
    await expect(executor.execute(contract, spec, { rejectTransferLimit: true }))
      .rejects.toMatchObject({ code: 'TRANSFER_LIMIT_EXCEEDED' });
  });

  it('normalizes ArcGIS service errors with service code and details', async () => {
    const executor = createArcGisQueryExecutor({
      transport: async () => response({
        error: { code: 400, message: 'Invalid query', details: ['Bad field'] },
      }),
    });
    await expect(executor.execute(contract, spec)).rejects.toMatchObject({
      code: 'ARCGIS_SERVICE_ERROR',
      arcGisCode: 400,
      details: ['Bad field'],
      resourceUrl,
    });
  });

  it('normalizes HTTP failures even when ArcGIS error payload is absent', async () => {
    const executor = createArcGisQueryExecutor({
      transport: async () => response({ message: 'gateway' }, 503),
    });
    await expect(executor.execute(contract, spec)).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      httpStatus: 503,
    });
  });

  it('propagates AbortSignal cancellation without converting it to a service failure', async () => {
    const controller = new AbortController();
    const executor = createArcGisQueryExecutor({
      transport: async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
        setTimeout(() => resolve(response({ features: [] })), 1000);
      }),
    });
    const pending = executor.execute(contract, spec, { signal: controller.signal });
    controller.abort('test cancellation');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses the scheduler contract for dedupe/cache ownership without embedding fetch', async () => {
    const scheduled: unknown[] = [];
    const scheduler = {
      schedule: async <T,>(request: any): Promise<T> => {
        scheduled.push(request);
        const controller = new AbortController();
        return request.execute({ signal: controller.signal, requestKey: request.key, resourceUrl: request.resourceUrl });
      },
    };
    const executor = createArcGisQueryExecutor({
      scheduler,
      transport: async () => response({ features: [{ attributes: { OBJECTID: 1, NAME: 'A' } }] }),
    });
    const result = await executor.execute(contract, spec, {
      cacheTtlMs: 5000,
      staleTtlMs: 10000,
      tags: ['layer:poi'],
    });
    expect(result.returnedFeatureCount).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect((scheduled[0] as any).resourceUrl).toBe(resourceUrl);
    expect((scheduled[0] as any).tags).toEqual(expect.arrayContaining([resourceUrl, 'layer:poi']));
  });

  it('creates deterministic request keys independent of URLSearchParams insertion order', () => {
    const capabilities = {
      resourceUrl,
      objectIdField: 'OBJECTID',
      maxRecordCount: 1000,
      geometryType: 'point' as const,
      spatialReference: { wkid: 4326 },
      capabilities: new Set(['query', 'pagination', 'order-by'] as const),
    };
    const left = createArcGisQueryPlan(capabilities, spec);
    const right = createArcGisQueryPlan(capabilities, {
      ...spec,
      outFields: ['OBJECTID', 'GLOBALID', 'NAME'],
    });
    expect(createArcGisQueryRequestKey(left)).toBe(createArcGisQueryRequestKey(right));
  });

  it('merges pages without duplicating overlapping object IDs', async () => {
    const pages = [
      { ids: [1, 2], limited: true },
      { ids: [2, 3], limited: false },
    ];
    const executor = createArcGisQueryExecutor({
      transport: async () => response({ features: [] }),
    });
    const results = await Promise.all(pages.map(async (page, index) => {
      const local = createArcGisQueryExecutor({
        transport: async () => response({
          exceededTransferLimit: page.limited,
          features: page.ids.map((id) => ({ attributes: { OBJECTID: id, NAME: `N${id}` } })),
        }),
      });
      return local.execute(contract, { ...spec, window: { resultOffset: index * 2, resultRecordCount: 2 } });
    }));
    expect(executor).toBeDefined();
    const merged = mergeArcGisQueryPages(contract, results);
    expect(merged.features.map((feature) => feature.attributes.OBJECTID)).toEqual([1, 2, 3]);
    expect(merged.duplicateCount).toBe(1);
    expect(merged.incomplete).toBe(true);
  });
});
