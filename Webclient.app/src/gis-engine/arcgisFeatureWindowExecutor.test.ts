import { describe, expect, it, vi } from 'vitest';
import { createArcGisFeatureWindowExecutor } from './arcgisFeatureWindowExecutor';
import type { ArcGisMetadataContract } from './arcgisMetadataAdapter';

const contract = (overrides: Partial<ArcGisMetadataContract> = {}): ArcGisMetadataContract => ({
  resourceUrl: 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer/0',
  serviceType: 'FeatureServer',
  layerId: 0,
  name: 'Kent',
  displayField: 'NAME',
  objectIdField: 'OBJECTID',
  globalIdField: null,
  geometryType: 'point',
  spatialReference: { wkid: 4326 },
  maxRecordCount: 2,
  capabilities: new Set(['query', 'pagination', 'order-by']),
  supportsPagination: true,
  supportsOrderBy: true,
  supportsStatistics: false,
  supportsDistinct: false,
  supportsExtent: false,
  supportsCentroid: false,
  supportsQuantization: false,
  queryReady: true,
  fields: [],
  ...overrides,
} as ArcGisMetadataContract);

const response = (features: unknown[], exceededTransferLimit: boolean) => ({
  ok: true,
  status: 200,
  json: async () => ({ features, exceededTransferLimit }),
});

describe('createArcGisFeatureWindowExecutor', () => {
  it('reads multiple verified pages and preserves deterministic service identity', async () => {
    const transport = vi.fn(async ({ body }: { body: URLSearchParams }) => {
      const offset = Number(body.get('resultOffset') ?? 0);
      if (offset === 0) return response([
        { attributes: { OBJECTID: 0, NAME: 'A' } },
        { attributes: { OBJECTID: 1, NAME: 'B' } },
      ], true);
      return response([{ attributes: { OBJECTID: 2, NAME: 'C' } }], false);
    });
    const runtime = createArcGisFeatureWindowExecutor({ transport, defaultPageSize: 2 });
    const result = await runtime.execute(contract(), { where: '1=1', outFields: ['OBJECTID', 'NAME'], returnGeometry: false });
    expect(result.complete).toBe(true);
    expect(result.features.map((feature) => feature.attributes.OBJECTID)).toEqual([0, 1, 2]);
    expect(result.pages).toBe(2);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('fails closed when pagination was not verified by metadata', async () => {
    const runtime = createArcGisFeatureWindowExecutor({ transport: vi.fn() });
    await expect(runtime.execute(contract({ supportsPagination: false }), {
      where: '1=1', outFields: ['OBJECTID'], returnGeometry: false,
    })).rejects.toMatchObject({ code: 'PAGINATION_UNSUPPORTED' });
  });

  it('requires a stable service identity before reading multiple pages', async () => {
    const runtime = createArcGisFeatureWindowExecutor({ transport: vi.fn() });
    await expect(runtime.execute(contract({ objectIdField: null, globalIdField: null }), {
      where: '1=1', outFields: ['NAME'], returnGeometry: false,
    })).rejects.toMatchObject({ code: 'STABLE_IDENTITY_REQUIRED' });
  });

  it('honors feature budgets and reports truncation without unbounded requests', async () => {
    const transport = vi.fn(async () => response([
      { attributes: { OBJECTID: 1 } },
      { attributes: { OBJECTID: 2 } },
    ], true));
    const runtime = createArcGisFeatureWindowExecutor({ transport, defaultPageSize: 2 });
    const result = await runtime.execute(contract(), { where: '1=1', outFields: ['OBJECTID'], returnGeometry: false }, {
      maxFeatures: 2,
    });
    expect(result.features).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation before transport work', async () => {
    const transport = vi.fn();
    const controller = new AbortController();
    controller.abort('superseded');
    const runtime = createArcGisFeatureWindowExecutor({ transport });
    await expect(runtime.execute(contract(), {
      where: '1=1', outFields: ['OBJECTID'], returnGeometry: false,
    }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
  });
});
