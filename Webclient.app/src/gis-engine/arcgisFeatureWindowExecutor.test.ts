import { describe, expect, it, vi } from 'vitest';
import { createArcGisFeatureWindowExecutor } from './arcgisFeatureWindowExecutor';
import type { ArcGisMetadataContract } from './arcgisMetadataAdapter';

const contract = (overrides: Partial<ArcGisMetadataContract> = {}): ArcGisMetadataContract => ({
  resourceUrl: 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer/0', name: 'Kent', type: 'Feature Layer', displayField: 'NAME', objectIdField: 'OBJECTID', globalIdField: null, geometryField: null, geometryType: 'point', spatialReference: { wkid: 4326 }, maxRecordCount: 2,
  capabilities: new Set(['query', 'pagination', 'order-by']), fields: [], fieldMap: new Map(), scales: { minScale: 0, maxScale: 0 }, time: { enabled: false, startField: null, endField: null, trackIdField: null, defaultInterval: null, defaultIntervalUnits: null }, editing: { create: false, update: false, delete: false, sync: false, attachments: false, supportsApplyEditsWithGlobalIds: false }, renderer: { type: null, field: null, field2: null, field3: null, normalizationField: null, visualVariableCount: 0, labelingRuleCount: 0, transparency: null }, hasZ: false, hasM: false, issues: [], queryReady: true, identityReady: true, ...overrides,
});
const response = (features: unknown[], exceededTransferLimit: boolean) => ({ ok: true, status: 200, json: async () => ({ features, exceededTransferLimit }) });

describe('createArcGisFeatureWindowExecutor', () => {
  it('reads multiple verified pages and preserves deterministic service identity', async () => {
    const transport = vi.fn(async ({ body }: { body: URLSearchParams }) => Number(body.get('resultOffset') ?? 0) === 0
      ? response([{ attributes: { OBJECTID: 0, NAME: 'A' } }, { attributes: { OBJECTID: 1, NAME: 'B' } }], true)
      : response([{ attributes: { OBJECTID: 2, NAME: 'C' } }], false));
    const result = await createArcGisFeatureWindowExecutor({ transport, defaultPageSize: 2 }).execute(contract(), { where: '1=1', outFields: ['OBJECTID', 'NAME'], returnGeometry: false });
    expect(result.complete).toBe(true); expect(result.features.map((feature) => feature.attributes.OBJECTID)).toEqual([0, 1, 2]); expect(result.pages).toBe(2); expect(transport).toHaveBeenCalledTimes(2);
  });
  it('fails closed when pagination was not verified by metadata', async () => {
    const runtime = createArcGisFeatureWindowExecutor({ transport: vi.fn() });
    await expect(runtime.execute(contract({ capabilities: new Set(['query', 'order-by']) }), { where: '1=1', outFields: ['OBJECTID'], returnGeometry: false })).rejects.toMatchObject({ code: 'PAGINATION_UNSUPPORTED' });
  });
  it('requires stable identity', async () => {
    const runtime = createArcGisFeatureWindowExecutor({ transport: vi.fn() });
    await expect(runtime.execute(contract({ objectIdField: null, globalIdField: null, identityReady: false }), { where: '1=1', outFields: ['NAME'], returnGeometry: false })).rejects.toMatchObject({ code: 'STABLE_IDENTITY_REQUIRED' });
  });
  it('honors feature budgets', async () => {
    const transport = vi.fn(async () => response([{ attributes: { OBJECTID: 1 } }, { attributes: { OBJECTID: 2 } }], true));
    const result = await createArcGisFeatureWindowExecutor({ transport, defaultPageSize: 2 }).execute(contract(), { where: '1=1', outFields: ['OBJECTID'], returnGeometry: false }, { maxFeatures: 2 });
    expect(result.features).toHaveLength(2); expect(result.truncated).toBe(true); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('propagates cancellation before transport work', async () => {
    const transport = vi.fn(); const controller = new AbortController(); controller.abort('superseded');
    await expect(createArcGisFeatureWindowExecutor({ transport }).execute(contract(), { where: '1=1', outFields: ['OBJECTID'], returnGeometry: false }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
  });
});
