import {
  ARCGIS_QUERY_STRATEGY,
  ARCGIS_SPATIAL_RELATIONSHIP,
  SpatialQueryPlannerError,
  compileArcGisQueryPlan,
  createArcGisObjectIdDiscoveryRequest,
  createArcGisPageRequest,
  createArcGisQueryIdentity,
} from './spatialQueryPlanner';

const baseContract = (overrides = {}) => ({
  serviceId: 'poi',
  resourceUrl: 'https://example.test/arcgis/rest/services/Kent/FeatureServer/0',
  supportsQuery: true,
  supportsPagination: true,
  supportsOrderBy: true,
  supportsStatistics: true,
  supportsZ: false,
  supportsM: false,
  objectIdField: 'OBJECTID',
  displayField: 'NAME',
  maxRecordCount: 1000,
  geometryType: 'point',
  spatialReference: { wkid: 3857 },
  queryCapabilities: [
    'query',
    'pagination',
    'order-by',
    'statistics',
    'distinct',
    'centroid',
  ],
  time: {
    hasTime: true,
    startField: 'START_DATE',
    endField: null,
  },
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID' },
    { name: 'NAME', type: 'esriFieldTypeString' },
    { name: 'DISTRICT', type: 'esriFieldTypeString' },
    { name: 'VALUE', type: 'esriFieldTypeDouble' },
    { name: 'START_DATE', type: 'esriFieldTypeDate' },
  ],
  editing: { editing: false },
  ...overrides,
});

describe('compileArcGisQueryPlan', () => {
  test('chooses bounded offset pagination from verified service metadata', () => {
    const plan = compileArcGisQueryPlan(baseContract(), {
      outFields: ['NAME', 'DISTRICT'],
      pageSize: 5000,
    });

    expect(plan.strategy).toBe(ARCGIS_QUERY_STRATEGY.OFFSET);
    expect(plan.pageSize).toBe(1000);
    expect(plan.baseRequest.outFields).toEqual(['OBJECTID', 'NAME', 'DISTRICT']);
    expect(plan.baseRequest.returnGeometry).toBe(true);
    expect(plan.baseRequest.outSR).toBe(3857);
    expect(plan.diagnostics).toMatchObject({
      queryReady: true,
      stableIdentity: true,
      fieldCount: 3,
    });
  });

  test('falls back to object-id pagination when offset pagination is not advertised', () => {
    const plan = compileArcGisQueryPlan(baseContract({
      supportsPagination: false,
      queryCapabilities: ['query', 'order-by', 'statistics'],
    }), {
      outFields: ['NAME'],
    });

    expect(plan.strategy).toBe(ARCGIS_QUERY_STRATEGY.OBJECT_IDS);
    expect(plan.objectIdField).toBe('OBJECTID');
    expect(plan.pageSize).toBe(1000);

    expect(createArcGisObjectIdDiscoveryRequest(plan)).toMatchObject({
      where: '1=1',
      returnIdsOnly: true,
      returnGeometry: false,
    });

    expect(createArcGisPageRequest(plan, {
      objectIds: [3, 7, 11],
    })).toMatchObject({
      objectIds: '3,7,11',
      outFields: ['OBJECTID', 'NAME'],
    });
  });

  test('uses a bounded single request only when no pagination identity is available', () => {
    const plan = compileArcGisQueryPlan(baseContract({
      supportsPagination: false,
      objectIdField: null,
      globalIdField: null,
      maxRecordCount: 250,
      queryCapabilities: ['query'],
    }), {
      outFields: ['NAME'],
    });

    expect(plan.strategy).toBe(ARCGIS_QUERY_STRATEGY.SINGLE);
    expect(plan.pageSize).toBe(250);
    expect(plan.warnings).toContain('query-without-stable-identity');
    expect(createArcGisPageRequest(plan)).toMatchObject({
      resultRecordCount: 250,
    });
  });

  test('never invents a page size for a pagination-capable service missing maxRecordCount metadata', () => {
    expect(() => compileArcGisQueryPlan(baseContract({
      maxRecordCount: null,
    }), {
      outFields: ['NAME'],
    })).toThrow(expect.objectContaining({
      code: 'MISSING_MAX_RECORD_COUNT',
    }));
  });

  test('rejects planning when query capability is not advertised', () => {
    expect(() => compileArcGisQueryPlan(baseContract({
      supportsQuery: false,
    }))).toThrow(expect.objectContaining({
      code: 'QUERY_NOT_SUPPORTED',
    }));
  });

  test('selects only fields present in the verified capability contract', () => {
    const plan = compileArcGisQueryPlan(baseContract(), {
      outFields: ['NAME', 'does_not_exist', 'district', 'OBJECTID'],
    });

    expect(plan.baseRequest.outFields).toEqual(['OBJECTID', 'NAME']);
  });

  test('requires structured order-by definitions and validates field names', () => {
    const plan = compileArcGisQueryPlan(baseContract(), {
      orderBy: [
        { field: 'DISTRICT', direction: 'ASC' },
        { field: 'NAME', direction: 'desc' },
      ],
    });

    expect(plan.baseRequest.orderByFields).toBe('DISTRICT ASC,NAME DESC');

    expect(() => compileArcGisQueryPlan(baseContract(), {
      orderBy: ['NAME DESC'],
    })).toThrow(expect.objectContaining({
      code: 'INVALID_ORDER_BY',
    }));

    expect(() => compileArcGisQueryPlan(baseContract(), {
      orderBy: [{ field: 'UNKNOWN', direction: 'ASC' }],
    })).toThrow(expect.objectContaining({
      code: 'UNKNOWN_FIELD',
    }));
  });

  test('does not emit orderByFields when service metadata does not advertise the capability', () => {
    expect(() => compileArcGisQueryPlan(baseContract({
      supportsOrderBy: false,
      queryCapabilities: ['query', 'pagination'],
    }), {
      orderBy: [{ field: 'NAME' }],
    })).toThrow(expect.objectContaining({
      code: 'ORDER_BY_NOT_SUPPORTED',
    }));
  });

  test('compiles spatial filters only with an explicit input spatial reference', () => {
    const geometry = { x: 32.85, y: 39.92 };
    expect(() => compileArcGisQueryPlan(baseContract(), {
      geometry,
    })).toThrow(expect.objectContaining({
      code: 'MISSING_INPUT_SPATIAL_REFERENCE',
    }));

    const plan = compileArcGisQueryPlan(baseContract(), {
      geometry: {
        ...geometry,
        spatialReference: { wkid: 4326 },
      },
      spatialRelationship: 'WITHIN',
    });

    expect(plan.baseRequest).toMatchObject({
      geometry,
      geometryType: 'esriGeometryPoint',
      inSR: 4326,
      spatialRel: ARCGIS_SPATIAL_RELATIONSHIP.WITHIN,
    });
    expect(plan.diagnostics.spatial).toBe(true);
  });

  test('infers point, multipoint, polyline, polygon and envelope geometry types deterministically', () => {
    const cases = [
      [{ x: 1, y: 2, spatialReference: { wkid: 4326 } }, 'esriGeometryPoint'],
      [{ points: [[1, 2]], spatialReference: { wkid: 4326 } }, 'esriGeometryMultipoint'],
      [{ paths: [[[1, 2], [3, 4]]], spatialReference: { wkid: 4326 } }, 'esriGeometryPolyline'],
      [{ rings: [[[1, 2], [3, 4], [1, 2]]], spatialReference: { wkid: 4326 } }, 'esriGeometryPolygon'],
      [{
        xmin: 1,
        ymin: 2,
        xmax: 3,
        ymax: 4,
        spatialReference: { wkid: 4326 },
      }, 'esriGeometryEnvelope'],
    ];

    cases.forEach(([geometry, geometryType]) => {
      const plan = compileArcGisQueryPlan(baseContract(), { geometry });
      expect(plan.baseRequest.geometryType).toBe(geometryType);
    });
  });

  test('requires explicit unit confirmation before maxAllowableOffset is emitted', () => {
    expect(() => compileArcGisQueryPlan(baseContract(), {
      generalization: {
        maxAllowableOffset: 2.5,
      },
    })).toThrow(expect.objectContaining({
      code: 'UNCONFIRMED_GENERALIZATION_UNITS',
    }));

    const plan = compileArcGisQueryPlan(baseContract(), {
      generalization: {
        maxAllowableOffset: 2.5,
        geometryPrecision: 5,
        unitsConfirmed: true,
      },
    });

    expect(plan.baseRequest).toMatchObject({
      maxAllowableOffset: 2.5,
      geometryPrecision: 5,
    });
    expect(plan.diagnostics.generalized).toBe(true);
  });

  test('refuses generalization when service spatial reference metadata is unavailable', () => {
    expect(() => compileArcGisQueryPlan(baseContract({
      spatialReference: null,
    }), {
      generalization: {
        maxAllowableOffset: 5,
        unitsConfirmed: true,
      },
    })).toThrow(expect.objectContaining({
      code: 'MISSING_SPATIAL_REFERENCE',
    }));
  });

  test('compiles structured statistics without enabling geometry by default', () => {
    const plan = compileArcGisQueryPlan(baseContract(), {
      statistics: [
        { type: 'count', field: '*', name: 'row_count' },
        { type: 'avg', field: 'VALUE', name: 'avg_value' },
      ],
      groupBy: ['DISTRICT'],
      outFields: ['DISTRICT'],
    });

    expect(plan.strategy).toBe(ARCGIS_QUERY_STRATEGY.STATISTICS);
    expect(plan.pageSize).toBeNull();
    expect(plan.baseRequest.returnGeometry).toBe(false);
    expect(plan.baseRequest.outStatistics).toEqual([
      {
        statisticType: 'count',
        onStatisticField: '*',
        outStatisticFieldName: 'row_count',
      },
      {
        statisticType: 'avg',
        onStatisticField: 'VALUE',
        outStatisticFieldName: 'avg_value',
      },
    ]);
    expect(plan.baseRequest.groupByFieldsForStatistics).toEqual(['DISTRICT']);
  });

  test('rejects statistics and group-by when the service does not advertise support', () => {
    const contract = baseContract({
      supportsStatistics: false,
      queryCapabilities: ['query', 'pagination', 'order-by'],
    });

    expect(() => compileArcGisQueryPlan(contract, {
      statistics: [{ type: 'sum', field: 'VALUE', name: 'sum_value' }],
    })).toThrow(expect.objectContaining({
      code: 'STATISTICS_NOT_SUPPORTED',
    }));

    expect(() => compileArcGisQueryPlan(contract, {
      groupBy: ['DISTRICT'],
    })).toThrow(expect.objectContaining({
      code: 'GROUP_BY_NOT_SUPPORTED',
    }));
  });

  test('rejects unsafe statistic output aliases instead of forwarding arbitrary tokens', () => {
    expect(() => compileArcGisQueryPlan(baseContract(), {
      statistics: [{
        type: 'sum',
        field: 'VALUE',
        name: 'sum(value);drop table',
      }],
    })).toThrow(expect.objectContaining({
      code: 'INVALID_STATISTIC_NAME',
    }));
  });

  test('uses service time capability for bounded temporal filters', () => {
    const plan = compileArcGisQueryPlan(baseContract(), {
      time: {
        start: new Date('2026-01-01T00:00:00Z'),
        end: new Date('2026-02-01T00:00:00Z'),
      },
    });

    expect(plan.baseRequest.time).toBe('1767225600000,1769904000000');
    expect(plan.diagnostics.timeFiltered).toBe(true);

    expect(() => compileArcGisQueryPlan(baseContract({
      time: null,
    }), {
      time: [1, 2],
    })).toThrow(expect.objectContaining({
      code: 'TIME_NOT_SUPPORTED',
    }));
  });

  test('rejects inverted temporal ranges', () => {
    expect(() => compileArcGisQueryPlan(baseContract(), {
      time: [200, 100],
    })).toThrow(expect.objectContaining({
      code: 'INVALID_TIME_RANGE',
    }));
  });

  test('enables distinct and centroid only when metadata advertises each capability', () => {
    const plan = compileArcGisQueryPlan(baseContract(), {
      returnDistinctValues: true,
      returnCentroid: true,
    });

    expect(plan.baseRequest.returnDistinctValues).toBe(true);
    expect(plan.baseRequest.returnCentroid).toBe(true);

    expect(() => compileArcGisQueryPlan(baseContract({
      queryCapabilities: ['query', 'pagination', 'order-by', 'statistics'],
    }), {
      returnDistinctValues: true,
    })).toThrow(expect.objectContaining({
      code: 'DISTINCT_NOT_SUPPORTED',
    }));
  });

  test('does not request Z or M unless both service metadata and caller opt in', () => {
    const noZM = compileArcGisQueryPlan(baseContract(), {
      returnZ: true,
      returnM: true,
    });
    expect(noZM.baseRequest.returnZ).toBe(false);
    expect(noZM.baseRequest.returnM).toBe(false);

    const withZM = compileArcGisQueryPlan(baseContract({
      supportsZ: true,
      supportsM: true,
    }), {
      returnZ: true,
      returnM: true,
    });
    expect(withZM.baseRequest.returnZ).toBe(true);
    expect(withZM.baseRequest.returnM).toBe(true);
  });

  test('creates deterministic query identities independent of object property insertion order', () => {
    const first = createArcGisQueryIdentity({
      b: 2,
      a: {
        y: 2,
        x: 1,
      },
    });
    const second = createArcGisQueryIdentity({
      a: {
        x: 1,
        y: 2,
      },
      b: 2,
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^arcgis-query:[a-f0-9]{8}:/);
  });

  test('different query semantics produce different identities', () => {
    const first = compileArcGisQueryPlan(baseContract(), {
      where: 'DISTRICT = 1',
    });
    const second = compileArcGisQueryPlan(baseContract(), {
      where: 'DISTRICT = 2',
    });

    expect(first.identity).not.toBe(second.identity);
  });

  test('offset page requests are bounded by the compiled service page size', () => {
    const plan = compileArcGisQueryPlan(baseContract(), {
      pageSize: 250,
    });

    const request = createArcGisPageRequest(plan, {
      offset: 500,
      count: 9999,
    });

    expect(request.resultOffset).toBe(500);
    expect(request.resultRecordCount).toBe(250);
  });

  test('object-id page requests reject empty and oversized chunks', () => {
    const plan = compileArcGisQueryPlan(baseContract({
      supportsPagination: false,
      maxRecordCount: 2,
    }));

    expect(() => createArcGisPageRequest(plan, {
      objectIds: [],
    })).toThrow(expect.objectContaining({
      code: 'EMPTY_OBJECT_ID_PAGE',
    }));

    expect(() => createArcGisPageRequest(plan, {
      objectIds: [1, 2, 3],
    })).toThrow(expect.objectContaining({
      code: 'OBJECT_ID_PAGE_TOO_LARGE',
    }));
  });

  test('object-id discovery strips result-shaping fields and keeps query filters', () => {
    const plan = compileArcGisQueryPlan(baseContract({
      supportsPagination: false,
    }), {
      where: "DISTRICT = 'CANKAYA'",
      geometry: {
        x: 32.85,
        y: 39.92,
        spatialReference: { wkid: 4326 },
      },
      orderBy: [{ field: 'NAME', direction: 'ASC' }],
    });

    const discovery = createArcGisObjectIdDiscoveryRequest(plan);
    expect(discovery).toMatchObject({
      where: "DISTRICT = 'CANKAYA'",
      geometryType: 'esriGeometryPoint',
      spatialRel: 'esriSpatialRelIntersects',
      returnIdsOnly: true,
      returnGeometry: false,
    });
    expect(discovery.outFields).toBeUndefined();
    expect(discovery.orderByFields).toBeUndefined();
  });

  test('control characters and unbounded where clauses are rejected', () => {
    expect(() => compileArcGisQueryPlan(baseContract(), {
      where: 'NAME = \u0001',
    })).toThrow(expect.objectContaining({
      code: 'INVALID_WHERE',
    }));

    expect(() => compileArcGisQueryPlan(baseContract(), {
      where: 'x'.repeat(9000),
    })).toThrow(expect.objectContaining({
      code: 'WHERE_TOO_LONG',
    }));
  });

  test('requires at least one verified output field instead of silently using wildcard output', () => {
    expect(() => compileArcGisQueryPlan(baseContract({
      objectIdField: null,
      displayField: null,
      fields: [],
      supportsPagination: false,
      maxRecordCount: 100,
      queryCapabilities: ['query'],
    }), {
      outFields: ['UNKNOWN'],
    })).toThrow(expect.objectContaining({
      code: 'NO_OUTPUT_FIELDS',
    }));
  });

  test('invalid page plan input fails with a typed planner error', () => {
    expect(() => createArcGisPageRequest(null)).toThrow(SpatialQueryPlannerError);
    expect(() => createArcGisObjectIdDiscoveryRequest({
      strategy: ARCGIS_QUERY_STRATEGY.OFFSET,
      baseRequest: {},
    })).toThrow(expect.objectContaining({
      code: 'OBJECT_ID_DISCOVERY_NOT_APPLICABLE',
    }));
  });
});
