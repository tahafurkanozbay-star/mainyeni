import {
  adaptArcGisLayerMetadata,
  diffArcGisMetadataContracts,
  metadataContractToQueryCapabilities,
  selectMetadataFields,
} from './arcgisMetadataAdapter';

const resourceUrl = 'https://example.invalid/arcgis/rest/services/Kent/FeatureServer/0';

const metadata = (overrides: Record<string, unknown> = {}) => ({
  name: 'Kent Noktalari',
  type: 'Feature Layer',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  globalIdField: 'GLOBALID',
  displayField: 'NAME',
  maxRecordCount: 2000,
  capabilities: 'Query,Create,Update',
  hasAttachments: true,
  extent: { spatialReference: { wkid: 4326 } },
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsOrderBy: true,
    supportsStatistics: true,
    supportsDistinct: true,
    supportsReturningQueryExtent: true,
  },
  fields: [
    { name: 'OBJECTID', alias: 'Object ID', type: 'esriFieldTypeOID', nullable: false, editable: false },
    { name: 'GLOBALID', alias: 'Global ID', type: 'esriFieldTypeGlobalID', nullable: false, editable: false },
    { name: 'NAME', alias: 'Ad', type: 'esriFieldTypeString', length: 200 },
    { name: 'CATEGORY', alias: 'Kategori', type: 'esriFieldTypeString', domain: {
      type: 'codedValue',
      codedValues: [{ code: 'PARK', name: 'Park' }, { code: 'HOSPITAL', name: 'Hastane' }],
    } },
  ],
  drawingInfo: {
    renderer: { type: 'uniqueValue', field: 'CATEGORY', visualVariables: [{ type: 'sizeInfo' }] },
    labelingInfo: [{ labelExpression: '[NAME]' }],
    transparency: 15,
  },
  ...overrides,
});

describe('arcgisMetadataAdapter', () => {
  it('adapts real ArcGIS metadata semantics without guessing unsupported capabilities', () => {
    const contract = adaptArcGisLayerMetadata(resourceUrl, metadata());
    expect(contract.resourceUrl).toBe(resourceUrl);
    expect(contract.geometryType).toBe('point');
    expect(contract.spatialReference).toEqual({ wkid: 4326 });
    expect(contract.objectIdField).toBe('OBJECTID');
    expect(contract.globalIdField).toBe('GLOBALID');
    expect(contract.maxRecordCount).toBe(2000);
    expect(contract.capabilities.has('query')).toBe(true);
    expect(contract.capabilities.has('pagination')).toBe(true);
    expect(contract.capabilities.has('order-by')).toBe(true);
    expect(contract.capabilities.has('centroid')).toBe(false);
    expect(contract.queryReady).toBe(true);
    expect(contract.identityReady).toBe(true);
  });

  it('normalizes fields, coded domains and renderer metadata', () => {
    const contract = adaptArcGisLayerMetadata(resourceUrl, metadata());
    const category = contract.fieldMap.get('CATEGORY');
    expect(category?.domain?.type).toBe('coded-value');
    expect(category?.domain?.codedValues.get('PARK')).toBe('Park');
    expect(contract.renderer.type).toBe('uniqueValue');
    expect(contract.renderer.field).toBe('CATEGORY');
    expect(contract.renderer.visualVariableCount).toBe(1);
    expect(contract.renderer.labelingRuleCount).toBe(1);
    expect(contract.renderer.transparency).toBe(15);
  });

  it('preserves object id zero capable contracts and safe query capability conversion', () => {
    const contract = adaptArcGisLayerMetadata(resourceUrl, metadata());
    const query = metadataContractToQueryCapabilities(contract);
    expect(query.resourceUrl).toBe(resourceUrl);
    expect(query.objectIdField).toBe('OBJECTID');
    expect(query.maxRecordCount).toBe(2000);
    expect(query.capabilities.has('statistics')).toBe(true);
  });

  it('reports missing spatial reference as a query-readiness error instead of inventing one', () => {
    const contract = adaptArcGisLayerMetadata(resourceUrl, metadata({ extent: undefined, spatialReference: undefined }));
    expect(contract.spatialReference).toBeNull();
    expect(contract.queryReady).toBe(false);
    expect(contract.issues.some((entry) => entry.code === 'missing-spatial-reference' && entry.severity === 'error')).toBe(true);
  });

  it('reports duplicate and invalid field metadata deterministically', () => {
    const contract = adaptArcGisLayerMetadata(resourceUrl, metadata({
      fields: [
        { name: 'OBJECTID', type: 'esriFieldTypeOID' },
        { name: 'OBJECTID', type: 'esriFieldTypeInteger' },
        { name: 'unsafe field', type: 'esriFieldTypeString' },
      ],
      displayField: 'MISSING',
    }));
    expect(contract.issues.some((entry) => entry.code === 'duplicate-field-name')).toBe(true);
    expect(contract.issues.some((entry) => entry.code === 'invalid-field-name' && entry.field === 'unsafe field')).toBe(true);
    expect(contract.issues.some((entry) => entry.code === 'display-field-not-found')).toBe(true);
  });

  it('rejects service roots, WMS-like URLs and non-object metadata', () => {
    expect(() => adaptArcGisLayerMetadata(
      'https://example.invalid/arcgis/rest/services/Kent/FeatureServer',
      metadata(),
    )).toThrow('concrete FeatureServer/MapServer layer resources');
    expect(() => adaptArcGisLayerMetadata(
      'https://example.invalid/wms/FeatureServer/0',
      metadata(),
    )).toThrow();
    expect(() => adaptArcGisLayerMetadata(resourceUrl, null)).toThrow('metadata must be an object');
  });

  it('selects only known fields and removes duplicate requests', () => {
    const contract = adaptArcGisLayerMetadata(resourceUrl, metadata());
    expect(selectMetadataFields(contract, ['NAME', 'MISSING', 'NAME', 'OBJECTID']).map((field) => field.name))
      .toEqual(['NAME', 'OBJECTID']);
  });

  it('detects schema drift that can invalidate paging or geometry integrity', () => {
    const before = adaptArcGisLayerMetadata(resourceUrl, metadata());
    const after = adaptArcGisLayerMetadata(resourceUrl, metadata({
      geometryType: 'esriGeometryPolygon',
      objectIdField: 'OID2',
      extent: { spatialReference: { wkid: 3857 } },
      maxRecordCount: 500,
      advancedQueryCapabilities: { supportsPagination: false, supportsOrderBy: false },
      fields: [
        { name: 'OID2', type: 'esriFieldTypeOID' },
        { name: 'NAME', type: 'esriFieldTypeString' },
        { name: 'NEW_FIELD', type: 'esriFieldTypeString' },
      ],
    }));
    const drift = diffArcGisMetadataContracts(before, after);
    expect(drift.breaking).toEqual(expect.arrayContaining([
      'geometry-type-changed',
      'object-id-field-changed',
      'spatial-reference-changed',
    ]));
    expect(drift.warnings).toEqual(expect.arrayContaining([
      'pagination-capability-removed',
      'max-record-count-reduced',
    ]));
    expect(drift.addedFields).toContain('NEW_FIELD');
    expect(drift.removedFields).toEqual(expect.arrayContaining(['OBJECTID', 'GLOBALID', 'CATEGORY']));
  });
});
