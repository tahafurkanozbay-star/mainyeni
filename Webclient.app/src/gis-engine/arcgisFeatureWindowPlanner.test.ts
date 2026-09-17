import { describe, expect, it } from 'vitest';
import { adaptArcGisLayerMetadata } from './arcgisMetadataAdapter';
import { applyArcGisFeatureWindowPlan, planArcGisFeatureWindow } from './arcgisFeatureWindowPlanner';
import { type ArcGisQuerySpec } from './arcgisQueryContract';

const resourceUrl = 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer/0';
const contract = (overrides: Record<string, unknown> = {}) => adaptArcGisLayerMetadata(resourceUrl, {
  name: 'Kent',
  type: 'Feature Layer',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  maxRecordCount: 2000,
  capabilities: 'Query',
  extent: { spatialReference: { wkid: 4326 } },
  advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
  fields: [{ name: 'OBJECTID', alias: 'Object ID', type: 'esriFieldTypeOID', nullable: false, editable: false }],
  ...overrides,
});
const spec = (overrides: Partial<ArcGisQuerySpec> = {}): ArcGisQuerySpec => ({ where: '1=1', outFields: Object.freeze(['*']), returnGeometry: true, ...overrides });

describe('ArcGIS feature window planner', () => {
  it('adds stable identity as a deterministic sort tie-breaker', () => {
    const plan = planArcGisFeatureWindow(contract(), spec({ orderBy: [{ field: 'NAME', direction: 'ASC' }] }));
    expect(plan.orderBy).toEqual([{ field: 'NAME', direction: 'ASC' }, { field: 'OBJECTID', direction: 'ASC' }]);
    expect(applyArcGisFeatureWindowPlan(spec(), plan).orderBy).toEqual([{ field: 'OBJECTID', direction: 'ASC' }]);
  });
  it('does not duplicate an existing identity order', () => {
    const plan = planArcGisFeatureWindow(contract(), spec({ orderBy: [{ field: 'objectid', direction: 'DESC' }] }));
    expect(plan.orderBy).toEqual([{ field: 'objectid', direction: 'DESC' }]);
  });
  it('bounds page size by verified service metadata', () => {
    expect(planArcGisFeatureWindow(contract({ maxRecordCount: 250 }), spec(), { pageSize: 5000 }).pageSize).toBe(250);
  });
  it('reports when the page budget is tighter than the feature budget', () => {
    expect(planArcGisFeatureWindow(contract(), spec(), { pageSize: 100, maxPages: 2, maxFeatures: 1000 }).warnings).toContain('page-budget-limits-feature-budget');
  });
  it('fails closed without verified pagination support', () => {
    expect(() => planArcGisFeatureWindow(contract({ advancedQueryCapabilities: { supportsOrderBy: true } }), spec())).toThrowError(expect.objectContaining({ code: 'PAGINATION_UNSUPPORTED' }));
  });
  it('fails closed without verified order-by support', () => {
    expect(() => planArcGisFeatureWindow(contract({ advancedQueryCapabilities: { supportsPagination: true } }), spec())).toThrowError(expect.objectContaining({ code: 'ORDER_BY_UNSUPPORTED' }));
  });
  it('fails closed without a verified stable identity', () => {
    expect(() => planArcGisFeatureWindow(contract({ objectIdField: null, fields: [] }), spec())).toThrowError(expect.objectContaining({ code: 'STABLE_IDENTITY_REQUIRED' }));
  });
});
