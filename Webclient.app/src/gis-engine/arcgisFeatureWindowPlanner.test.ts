import { describe, expect, it } from 'vitest';
import { applyArcGisFeatureWindowPlan, planArcGisFeatureWindow } from './arcgisFeatureWindowPlanner';
import { type ArcGisMetadataContract } from './arcgisMetadataAdapter';
import { type ArcGisQuerySpec } from './arcgisQueryContract';

const contract = (overrides: Partial<ArcGisMetadataContract> = {}): ArcGisMetadataContract => ({
  serviceUrl: '/arcgis/rest/services/example/FeatureServer/0',
  serviceType: 'FeatureServer',
  layerId: 0,
  name: 'Example',
  geometryType: 'esriGeometryPoint',
  spatialReference: Object.freeze({ wkid: 4326 }),
  fields: Object.freeze([]),
  objectIdField: 'OBJECTID',
  globalIdField: undefined,
  maxRecordCount: 2000,
  queryReady: true,
  identityReady: true,
  capabilities: new Set(['query', 'pagination']),
  ...overrides,
} as ArcGisMetadataContract);

const spec = (overrides: Partial<ArcGisQuerySpec> = {}): ArcGisQuerySpec => ({
  where: '1=1',
  outFields: Object.freeze(['*']),
  returnGeometry: true,
  ...overrides,
} as ArcGisQuerySpec);

describe('ArcGIS feature window planner', () => {
  it('adds stable identity as a deterministic sort tie-breaker', () => {
    const plan = planArcGisFeatureWindow(contract(), spec({ orderByFields: ['NAME ASC'] }));
    expect(plan.orderByFields).toEqual(['NAME ASC', 'OBJECTID ASC']);
    expect(applyArcGisFeatureWindowPlan(spec(), plan).orderByFields).toEqual(['OBJECTID ASC']);
  });

  it('does not duplicate an existing identity order regardless of direction or case', () => {
    const plan = planArcGisFeatureWindow(contract(), spec({ orderByFields: ['name ASC', 'objectid DESC'] }));
    expect(plan.orderByFields).toEqual(['name ASC', 'objectid DESC']);
  });

  it('bounds page size by verified service metadata', () => {
    const plan = planArcGisFeatureWindow(contract({ maxRecordCount: 250 }), spec(), { pageSize: 5000 });
    expect(plan.pageSize).toBe(250);
  });

  it('reports when the page budget is tighter than the feature budget', () => {
    const plan = planArcGisFeatureWindow(contract(), spec(), { pageSize: 100, maxPages: 2, maxFeatures: 1000 });
    expect(plan.warnings).toContain('page-budget-limits-feature-budget');
  });

  it('fails closed without verified pagination support', () => {
    expect(() => planArcGisFeatureWindow(contract({ capabilities: new Set(['query']) }), spec())).toThrowError(
      expect.objectContaining({ code: 'PAGINATION_UNSUPPORTED' }),
    );
  });

  it('fails closed without a verified stable identity', () => {
    expect(() => planArcGisFeatureWindow(contract({ identityReady: false, objectIdField: undefined }), spec())).toThrowError(
      expect.objectContaining({ code: 'STABLE_IDENTITY_REQUIRED' }),
    );
  });
});
