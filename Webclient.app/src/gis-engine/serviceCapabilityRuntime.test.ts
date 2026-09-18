import {
  ARCGIS_QUERY_CAPABILITY,
  ARCGIS_RESOURCE_KIND,
  ArcGisCapabilityError,
  assessCapabilityContract,
  assertAllowedArcGisResourceUrl,
  buildArcGisCapabilityContract,
  capabilityContractToPaginationMetadata,
  classifyArcGisResource,
  selectCapabilityFields,
} from './serviceCapabilityRuntime';

const featureMetadata = (overrides = {}) => ({
  name: 'Places',
  type: 'Feature Layer',
  capabilities: 'Query,Create,Update,Delete',
  geometryType: 'esriGeometryPoint',
  objectIdField: 'OBJECTID',
  maxRecordCount: 2000,
  extent: { spatialReference: { wkid: 102100, latestWkid: 3857 } },
  fields: [
    { name: 'OBJECTID', alias: 'OBJECTID', type: 'esriFieldTypeOID', nullable: false, editable: false },
    { name: 'NAME', alias: 'Name', type: 'esriFieldTypeString', length: 120 },
    { name: 'TYPE', alias: 'Type', type: 'esriFieldTypeString', length: 80 },
  ],
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsOrderBy: true,
    supportsStatistics: true,
    supportsDistinct: true,
    supportsReturningQueryExtent: true,
    supportsReturningGeometryCentroid: true,
    supportsQuantization: true,
  },
  ...overrides,
});

describe('serviceCapabilityRuntime', () => {
  test('accepts verified ArcGIS FeatureServer REST paths', () => {
    expect(assertAllowedArcGisResourceUrl('https://example.test/arcgis/rest/services/Places/FeatureServer/0'))
      .toBe('https://example.test/arcgis/rest/services/Places/FeatureServer/0');
  });

  test('accepts ArcGIS MapServer, ImageServer, SceneServer and VectorTileServer paths', () => {
    expect(assertAllowedArcGisResourceUrl('https://x.test/rest/services/A/MapServer')).toContain('/MapServer');
    expect(assertAllowedArcGisResourceUrl('https://x.test/rest/services/A/ImageServer')).toContain('/ImageServer');
    expect(assertAllowedArcGisResourceUrl('https://x.test/rest/services/A/SceneServer')).toContain('/SceneServer');
    expect(assertAllowedArcGisResourceUrl('https://x.test/rest/services/A/VectorTileServer')).toContain('/VectorTileServer');
  });

  test('rejects WMS paths explicitly', () => {
    expect(() => assertAllowedArcGisResourceUrl('https://example.test/wms'))
      .toThrow(ArcGisCapabilityError);
  });

  test('rejects WFS query-string service declarations explicitly', () => {
    expect(() => assertAllowedArcGisResourceUrl('https://example.test/service?service=WFS&request=GetCapabilities'))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN_OGC_RESOURCE' }));
  });

  test('rejects unverified generic URLs rather than inventing provider behavior', () => {
    expect(() => assertAllowedArcGisResourceUrl('https://example.test/api/layers'))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_RESOURCE_URL' }));
  });

  test('classifies feature layer from ArcGIS URL', () => {
    expect(classifyArcGisResource({
      url: 'https://example.test/rest/services/A/FeatureServer/3',
    })).toBe(ARCGIS_RESOURCE_KIND.FEATURE_LAYER);
  });

  test('classifies map sublayer from ArcGIS URL', () => {
    expect(classifyArcGisResource({
      url: 'https://example.test/rest/services/A/MapServer/4',
    })).toBe(ARCGIS_RESOURCE_KIND.MAP_LAYER);
  });

  test('classifies service roots from ArcGIS URLs', () => {
    expect(classifyArcGisResource({ url: 'https://x/rest/services/A/FeatureServer' }))
      .toBe(ARCGIS_RESOURCE_KIND.FEATURE_SERVICE);
    expect(classifyArcGisResource({ url: 'https://x/rest/services/A/MapServer' }))
      .toBe(ARCGIS_RESOURCE_KIND.MAP_SERVICE);
  });

  test('metadata classification takes precedence when richer evidence is present', () => {
    expect(classifyArcGisResource({
      url: 'https://x/rest/services/A/MapServer/0',
      metadata: featureMetadata(),
    })).toBe(ARCGIS_RESOURCE_KIND.FEATURE_LAYER);
  });

  test('recognizes a feature layer from fields and geometry when type text is absent', () => {
    expect(classifyArcGisResource({
      metadata: { geometryType: 'esriGeometryPoint', fields: [{ name: 'OBJECTID' }] },
    })).toBe(ARCGIS_RESOURCE_KIND.FEATURE_LAYER);
  });

  test('builds a normalized capability contract from service metadata', () => {
    const contract = buildArcGisCapabilityContract({
      url: 'https://example.test/rest/services/Places/FeatureServer/0',
      serviceId: 'places',
      metadata: featureMetadata(),
    });
    expect(contract).toEqual(expect.objectContaining({
      serviceId: 'places',
      resourceKind: ARCGIS_RESOURCE_KIND.FEATURE_LAYER,
      name: 'Places',
      geometryType: 'point',
      spatialReference: { wkid: 3857 },
      objectIdField: 'OBJECTID',
      maxRecordCount: 2000,
      supportsQuery: true,
      supportsPagination: true,
      supportsStatistics: true,
      supportsOrderBy: true,
    }));
  });

  test('normalizes query capabilities from advancedQueryCapabilities', () => {
    const contract = buildArcGisCapabilityContract({ metadata: featureMetadata() });
    expect(contract.queryCapabilities).toEqual(expect.arrayContaining([
      ARCGIS_QUERY_CAPABILITY.QUERY,
      ARCGIS_QUERY_CAPABILITY.PAGINATION,
      ARCGIS_QUERY_CAPABILITY.ORDER_BY,
      ARCGIS_QUERY_CAPABILITY.STATISTICS,
      ARCGIS_QUERY_CAPABILITY.DISTINCT,
      ARCGIS_QUERY_CAPABILITY.EXTENT,
      ARCGIS_QUERY_CAPABILITY.CENTROID,
      ARCGIS_QUERY_CAPABILITY.QUANTIZATION,
    ]));
  });

  test('discovers object id field from field metadata when direct property is absent', () => {
    const contract = buildArcGisCapabilityContract({
      metadata: featureMetadata({ objectIdField: undefined }),
    });
    expect(contract.objectIdField).toBe('OBJECTID');
  });

  test('discovers global id field from field metadata', () => {
    const contract = buildArcGisCapabilityContract({
      metadata: featureMetadata({
        fields: [
          ...featureMetadata().fields,
          { name: 'GLOBALID', type: 'esriFieldTypeGlobalID' },
        ],
      }),
    });
    expect(contract.globalIdField).toBe('GLOBALID');
  });

  test('normalizes time-aware layer contract', () => {
    const contract = buildArcGisCapabilityContract({
      metadata: featureMetadata({
        timeInfo: {
          startTimeField: 'START_AT',
          endTimeField: 'END_AT',
          trackIdField: 'TRACK_ID',
          defaultTimeInterval: 1,
          defaultTimeIntervalUnits: 'esriTimeUnitsDays',
        },
      }),
    });
    expect(contract.time).toEqual({
      startField: 'START_AT',
      endField: 'END_AT',
      trackIdField: 'TRACK_ID',
      defaultTimeInterval: 1,
      defaultTimeIntervalUnits: 'esriTimeUnitsDays',
      hasTime: true,
    });
  });

  test('normalizes Z/M and attachment capabilities', () => {
    const contract = buildArcGisCapabilityContract({
      metadata: featureMetadata({ hasZ: true, hasM: true, hasAttachments: true }),
    });
    expect(contract.supportsZ).toBe(true);
    expect(contract.supportsM).toBe(true);
    expect(contract.supportsAttachments).toBe(true);
  });

  test('normalizes editing capabilities without granting anything absent from metadata', () => {
    const editable = buildArcGisCapabilityContract({ metadata: featureMetadata() });
    expect(editable.editing).toEqual(expect.objectContaining({
      create: true,
      update: true,
      delete: true,
      editing: true,
    }));

    const queryOnly = buildArcGisCapabilityContract({
      metadata: featureMetadata({ capabilities: 'Query' }),
    });
    expect(queryOnly.editing.editing).toBe(false);
  });

  test('normalizes renderer and labeling metadata as descriptive evidence only', () => {
    const contract = buildArcGisCapabilityContract({
      metadata: featureMetadata({
        drawingInfo: {
          renderer: { type: 'uniqueValue' },
          labelingInfo: [{ labelExpression: '[NAME]' }],
          transparency: 20,
        },
      }),
    });
    expect(contract.drawing).toEqual({
      hasRenderer: true,
      rendererType: 'uniqueValue',
      hasLabeling: true,
      transparency: 20,
    });
  });

  test('normalizes fields to immutable client-safe capability data', () => {
    const contract = buildArcGisCapabilityContract({ metadata: featureMetadata() });
    expect(contract.fields[1]).toEqual(expect.objectContaining({
      name: 'NAME',
      alias: 'Name',
      type: 'esriFieldTypeString',
      nullable: true,
      editable: true,
      length: 120,
    }));
  });

  test('normalizes min/max scale safely', () => {
    const contract = buildArcGisCapabilityContract({
      metadata: featureMetadata({ minScale: 5000, maxScale: 100000 }),
    });
    expect(contract.minScale).toBe(5000);
    expect(contract.maxScale).toBe(100000);
  });

  test('collects service root layer and table ids without duplicates', () => {
    const contract = buildArcGisCapabilityContract({
      metadata: {
        type: 'Map Service',
        layers: [{ id: 0 }, { id: 1 }],
        tables: [{ id: 1 }, { id: 2 }],
      },
    });
    expect(contract.sublayerIds).toEqual(['0', '1', '2']);
  });

  test('can preserve an unknown non-OGC URL only when caller explicitly allows it', () => {
    const contract = buildArcGisCapabilityContract({
      url: 'https://example.test/internal/layer-proxy',
      metadata: featureMetadata(),
      allowUnknownUrl: true,
    });
    expect(contract.resourceUrl).toBe('https://example.test/internal/layer-proxy');
    expect(contract.resourceKind).toBe(ARCGIS_RESOURCE_KIND.FEATURE_LAYER);
  });

  test('never permits WMS/WFS through allowUnknownUrl override', () => {
    expect(() => buildArcGisCapabilityContract({
      url: 'https://example.test/wfs',
      metadata: featureMetadata(),
      allowUnknownUrl: true,
    })).toThrow(expect.objectContaining({ code: 'FORBIDDEN_OGC_RESOURCE' }));
  });

  test('converts capability contract to pagination metadata without adding unsupported capabilities', () => {
    const contract = buildArcGisCapabilityContract({ metadata: featureMetadata() });
    expect(capabilityContractToPaginationMetadata(contract)).toEqual(expect.objectContaining({
      maxRecordCount: 2000,
      objectIdField: 'OBJECTID',
      advancedQueryCapabilities: expect.objectContaining({
        supportsPagination: true,
        supportsOrderBy: true,
        supportsStatistics: true,
        supportsReturningQueryExtent: true,
      }),
    }));
  });

  test('assesses a complete query layer as query-ready and stable', () => {
    const contract = buildArcGisCapabilityContract({ metadata: featureMetadata() });
    expect(assessCapabilityContract(contract)).toEqual({
      valid: true,
      issues: [],
      queryReady: true,
      stableIdentity: true,
    });
  });

  test('flags query metadata missing a max record count', () => {
    const contract = buildArcGisCapabilityContract({
      metadata: featureMetadata({ maxRecordCount: undefined }),
    });
    expect(assessCapabilityContract(contract)).toEqual(expect.objectContaining({
      valid: false,
      queryReady: false,
      issues: expect.arrayContaining(['missing-max-record-count']),
    }));
  });

  test('flags spatial metadata missing a spatial reference', () => {
    const contract = buildArcGisCapabilityContract({
      metadata: featureMetadata({ extent: undefined, spatialReference: undefined }),
    });
    expect(assessCapabilityContract(contract).issues).toContain('missing-spatial-reference');
  });

  test('flags editing contracts without stable identity', () => {
    const contract = buildArcGisCapabilityContract({
      metadata: featureMetadata({
        objectIdField: undefined,
        fields: [{ name: 'NAME', type: 'esriFieldTypeString' }],
      }),
    });
    expect(assessCapabilityContract(contract).issues).toContain('editing-without-stable-identity');
  });

  test('selects only fields actually advertised by ArcGIS metadata', () => {
    const contract = buildArcGisCapabilityContract({ metadata: featureMetadata() });
    expect(selectCapabilityFields(contract, ['NAME', 'MISSING', 'TYPE', 'NAME']))
      .toEqual(['NAME', 'TYPE']);
  });

  test('returns an unknown resource contract when metadata evidence is insufficient', () => {
    const contract = buildArcGisCapabilityContract({ metadata: { name: 'Mystery' } });
    expect(contract.resourceKind).toBe(ARCGIS_RESOURCE_KIND.UNKNOWN);
    expect(assessCapabilityContract(contract).issues).toContain('unknown-resource-kind');
  });
});
