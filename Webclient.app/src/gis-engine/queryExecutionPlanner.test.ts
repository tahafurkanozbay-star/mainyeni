import type { ArcGisMetadataContract } from './arcgisMetadataAdapter';
import {
  createQueryExecutionPlan,
  QueryExecutionPlannerError,
  recommendNextPageSize,
} from './queryExecutionPlanner';

const metadata = (overrides: Partial<ArcGisMetadataContract> = {}): ArcGisMetadataContract => {
  const fields: ArcGisMetadataContract['fields'] = [
    { name: 'OBJECTID', alias: 'OBJECTID', type: 'oid', nullable: false, editable: false, length: null, defaultValue: null, domain: null },
    { name: 'GLOBALID', alias: 'GLOBALID', type: 'global-id', nullable: false, editable: false, length: null, defaultValue: null, domain: null },
    { name: 'NAME', alias: 'Ad', type: 'string', nullable: true, editable: true, length: 255, defaultValue: null, domain: null },
    { name: 'STATUS', alias: 'Durum', type: 'integer', nullable: true, editable: true, length: null, defaultValue: null, domain: null },
  ];
  return {
    resourceUrl: 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer/0',
    name: 'Kent',
    type: 'Feature Layer',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    objectIdField: 'OBJECTID',
    globalIdField: 'GLOBALID',
    displayField: 'NAME',
    geometryField: null,
    maxRecordCount: 1000,
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
    ...overrides,
  };
};

describe('createQueryExecutionPlan', () => {
  it('selects stable offset pagination only when metadata advertises both capabilities', () => {
    const plan = createQueryExecutionPlan(metadata(), {
      where: 'STATUS = 1',
      outFields: ['NAME'],
      returnGeometry: false,
    }, { maxFeatures: 5000, preferredPageSize: 500 });
    expect(plan.strategy).toBe('offset-pagination');
    expect(plan.stableOrder).toBe(true);
    expect(plan.pageSize).toBe(500);
    expect(plan.page(2)).toEqual({ index: 2, offset: 1000, limit: 500 });
    expect(plan.pageSpec(1).window).toEqual({ resultOffset: 500, resultRecordCount: 500 });
  });

  it('injects the object id field for de-duplication integrity', () => {
    const plan = createQueryExecutionPlan(metadata(), { outFields: ['NAME'], returnGeometry: false });
    expect(plan.query.outFields).toContain('NAME');
    expect(plan.query.outFields).toContain('OBJECTID');
    expect(plan.diagnostics.some((entry) => entry.code === 'field-projection-expanded')).toBe(true);
  });

  it('drops fields absent from server metadata', () => {
    const plan = createQueryExecutionPlan(metadata(), { outFields: ['NAME', 'SECRET_CLIENT_GUESS'] });
    expect(plan.query.outFields).not.toContain('SECRET_CLIENT_GUESS');
    expect(plan.diagnostics.some((entry) => entry.code === 'unknown-field-dropped')).toBe(true);
  });

  it('bounds field projection while retaining identity fields', () => {
    const plan = createQueryExecutionPlan(metadata(), { outFields: ['NAME', 'STATUS', 'GLOBALID'] }, { maxOutFields: 2 });
    expect(plan.query.outFields).toContain('OBJECTID');
    expect(plan.query.outFields.length).toBeLessThanOrEqual(2);
    expect(plan.diagnostics.some((entry) => entry.code === 'field-projection-truncated')).toBe(true);
  });

  it('does not guess pagination when advanced capability is absent', () => {
    const plan = createQueryExecutionPlan(metadata({ capabilities: new Set(['query', 'order-by']) }), {}, { maxFeatures: 5000 });
    expect(plan.strategy).toBe('bounded-single-page');
    expect(plan.pageSpec(0).window).toBeUndefined();
    expect(plan.diagnostics.some((entry) => entry.code === 'pagination-unavailable')).toBe(true);
  });

  it('does not claim stable ordering without an object id', () => {
    const plan = createQueryExecutionPlan(metadata({ objectIdField: null, identityReady: false }), {});
    expect(plan.stableOrder).toBe(false);
    expect(plan.strategy).toBe('bounded-single-page');
    expect(plan.diagnostics.some((entry) => entry.code === 'identity-not-ready')).toBe(true);
  });

  it('clamps page size to verified maxRecordCount', () => {
    const plan = createQueryExecutionPlan(metadata({ maxRecordCount: 250 }), {}, { preferredPageSize: 1000 });
    expect(plan.pageSize).toBe(250);
    expect(plan.diagnostics.some((entry) => entry.code === 'page-size-clamped')).toBe(true);
  });

  it('keeps browser exports bounded unless explicitly permitted by runtime policy', () => {
    const plan = createQueryExecutionPlan(metadata(), { purpose: 'export' }, { maxFeatures: 50_000, maxPages: 10 });
    expect(plan.maxFeatures).toBeLessThanOrEqual(10_000);
    expect(plan.diagnostics.some((entry) => entry.code === 'export-bounded')).toBe(true);
  });

  it('normalizes empty where clauses to deterministic 1=1', () => {
    const plan = createQueryExecutionPlan(metadata(), { where: '   ' });
    expect(plan.query.where).toBe('1=1');
  });

  it('rejects overlong where clauses before transport', () => {
    expect(() => createQueryExecutionPlan(metadata(), { where: 'x'.repeat(500) }, { maxWhereLength: 256 })).toThrow(QueryExecutionPlannerError);
  });

  it('throws for layers that are not query ready', () => {
    expect(() => createQueryExecutionPlan(metadata({ queryReady: false }), {})).toThrow('not query-ready');
  });

  it('generates deterministic signatures for equivalent plans', () => {
    const first = createQueryExecutionPlan(metadata(), { where: 'STATUS=1', outFields: ['NAME'] });
    const second = createQueryExecutionPlan(metadata(), { where: 'STATUS=1', outFields: ['NAME'] });
    const third = createQueryExecutionPlan(metadata(), { where: 'STATUS=2', outFields: ['NAME'] });
    expect(first.signature).toBe(second.signature);
    expect(first.signature).not.toBe(third.signature);
  });

  it('rejects page access beyond its bounded page count', () => {
    const plan = createQueryExecutionPlan(metadata(), {}, { maxFeatures: 1000, preferredPageSize: 500 });
    expect(() => plan.page(2)).toThrow('outside bounded range');
  });
});

describe('recommendNextPageSize', () => {
  it('reduces page size under latency pressure', () => {
    expect(recommendNextPageSize(1000, { latencyMs: 3000, featureCount: 1000, exceededTransferLimit: true })).toBeLessThan(1000);
  });

  it('increases page size when transfer limit is hit with latency headroom', () => {
    expect(recommendNextPageSize(1000, { latencyMs: 100, featureCount: 1000, exceededTransferLimit: true })).toBeGreaterThan(1000);
  });

  it('never escapes configured bounds', () => {
    expect(recommendNextPageSize(100, { latencyMs: 9999, featureCount: 100, exceededTransferLimit: true }, { minimum: 100 })).toBe(100);
    expect(recommendNextPageSize(5000, { latencyMs: 10, featureCount: 5000, exceededTransferLimit: true }, { maximum: 5000 })).toBe(5000);
  });
});
