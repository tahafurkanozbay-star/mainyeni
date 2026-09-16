import { createArcGisQueryPlan, type ArcGisLayerCapabilities } from './arcgisQueryContract';

const capabilities = (overrides: Partial<ArcGisLayerCapabilities> = {}): ArcGisLayerCapabilities => ({
  resourceUrl: 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer/0',
  objectIdField: 'OBJECTID',
  maxRecordCount: 1000,
  geometryType: 'point',
  spatialReference: { wkid: 4326 },
  capabilities: new Set(['query', 'pagination', 'order-by']),
  ...overrides,
});

describe('createArcGisQueryPlan', () => {
  it('creates a bounded stable ArcGIS layer query', () => {
    const plan = createArcGisQueryPlan(capabilities(), {
      where: 'STATUS = 1',
      outFields: ['OBJECTID', 'NAME'],
      returnGeometry: true,
      window: { resultOffset: 1000, resultRecordCount: 5000 },
    });
    expect(plan.queryUrl).toBe('https://example.invalid/arcgis/rest/services/Kent/FeatureServer/0/query');
    expect(plan.pageSize).toBe(1000);
    expect(plan.stableOrder).toBe(true);
    expect(plan.body.get('orderByFields')).toBe('OBJECTID ASC');
    expect(plan.body.get('resultRecordCount')).toBe('1000');
  });

  it('rejects service roots because queries require a concrete layer', () => {
    expect(() => createArcGisQueryPlan(capabilities({
      resourceUrl: 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer',
    }), {
      where: '1=1', outFields: ['OBJECTID'], returnGeometry: false,
    })).toThrow('verified ArcGIS layer resource URL');
  });

  it('does not guess pagination when metadata does not advertise it', () => {
    const plan = createArcGisQueryPlan(capabilities({ capabilities: new Set(['query']) }), {
      where: '1=1', outFields: [], returnGeometry: false,
      window: { resultOffset: 100, resultRecordCount: 200 },
    });
    expect(plan.pagination).toBe(false);
    expect(plan.body.has('resultOffset')).toBe(false);
  });

  it('serializes explicit spatial references without reprojection guesses', () => {
    const plan = createArcGisQueryPlan(capabilities(), {
      where: '1=1', outFields: ['OBJECTID'], returnGeometry: true,
      geometry: { xmin: 30, ymin: 39, xmax: 33, ymax: 41, spatialReference: { wkid: 4326 } },
      outSpatialReference: { wkid: 3857 },
    });
    expect(plan.body.get('inSR')).toBe('4326');
    expect(plan.body.get('outSR')).toBe('3857');
  });
});
