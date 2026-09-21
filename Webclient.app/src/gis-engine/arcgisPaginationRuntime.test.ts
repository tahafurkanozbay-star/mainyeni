import {
  ARCGIS_PAGINATION_STRATEGY,
  ArcGisPaginationError,
  createArcGisPaginationPlan,
  executeArcGisPagination,
  mergeArcGisFeaturePages,
  normalizeArcGisLayerPaginationMetadata,
} from './arcgisPaginationRuntime';

const metadata = (overrides = {}) => ({
  maxRecordCount: 2,
  objectIdField: 'OBJECTID',
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsOrderBy: true,
  },
  ...overrides,
});

const feature = (id, name = `feature-${id}`) => ({
  attributes: { OBJECTID: id, NAME: name },
  geometry: { x: id, y: id },
});

describe('arcgisPaginationRuntime', () => {
  test('normalizes ArcGIS pagination capabilities without inventing service behavior', () => {
    expect(normalizeArcGisLayerPaginationMetadata(metadata())).toEqual(expect.objectContaining({
      objectIdField: 'OBJECTID',
      maxRecordCount: 2,
      supportsPagination: true,
      supportsOrderBy: true,
    }));
  });

  test('discovers the OID field from field metadata', () => {
    const normalized = normalizeArcGisLayerPaginationMetadata({
      maxRecordCount: 1000,
      fields: [
        { name: 'NAME', type: 'esriFieldTypeString' },
        { name: 'FID', type: 'esriFieldTypeOID' },
      ],
    });
    expect(normalized.objectIdField).toBe('FID');
  });

  test('prefers offset pagination when service metadata explicitly supports it', () => {
    expect(createArcGisPaginationPlan(metadata()).strategy)
      .toBe(ARCGIS_PAGINATION_STRATEGY.OFFSET);
  });

  test('falls back to object-id pagination when offset pagination is unsupported', () => {
    const plan = createArcGisPaginationPlan(metadata({
      advancedQueryCapabilities: { supportsPagination: false },
    }));
    expect(plan.strategy).toBe(ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS);
  });

  test('uses a single bounded page when neither paging strategy is supported', () => {
    const plan = createArcGisPaginationPlan({ maxRecordCount: 500 });
    expect(plan.strategy).toBe(ARCGIS_PAGINATION_STRATEGY.SINGLE_PAGE);
    expect(plan.pageSize).toBe(500);
  });

  test('caps requested page size to the verified service maxRecordCount', () => {
    const plan = createArcGisPaginationPlan(metadata({ maxRecordCount: 250 }), {
      pageSize: 5000,
    });
    expect(plan.pageSize).toBe(250);
  });

  test('adds deterministic OID ordering only when order-by is supported', () => {
    expect(createArcGisPaginationPlan(metadata()).orderByFields).toEqual(['OBJECTID ASC']);
    expect(createArcGisPaginationPlan(metadata({
      advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: false },
    })).orderByFields).toEqual([]);
  });

  test('merges pages deterministically and removes duplicate object ids', () => {
    const merged = mergeArcGisFeaturePages([
      { features: [feature(1), feature(2)] },
      { features: [feature(2), feature(3)] },
    ], { objectIdField: 'OBJECTID' });
    expect(merged.features.map((item) => item.attributes.OBJECTID)).toEqual([1, 2, 3]);
    expect(merged.duplicates).toBe(1);
  });

  test('deduplicates geometrically-identical records when an OID is unavailable', () => {
    const duplicate = { attributes: { NAME: 'A' }, geometry: { x: 1, y: 2 } };
    const merged = mergeArcGisFeaturePages([
      { features: [duplicate] },
      { features: [{ geometry: { y: 2, x: 1 }, attributes: { NAME: 'A' } }] },
    ]);
    expect(merged.features).toHaveLength(1);
    expect(merged.duplicates).toBe(1);
  });

  test('stops merge at maxFeatures and reports truncation', () => {
    const merged = mergeArcGisFeaturePages([
      { features: [feature(1), feature(2), feature(3)] },
    ], { objectIdField: 'OBJECTID', maxFeatures: 2 });
    expect(merged.features).toHaveLength(2);
    expect(merged.truncated).toBe(true);
  });

  test('executes offset pagination while transfer limit indicates more data', async () => {
    const calls = [];
    const result = await executeArcGisPagination({
      metadata: metadata(),
      options: { pageSize: 2, maxPages: 10 },
      fetchPage: async (request) => {
        calls.push(request);
        if (request.resultOffset === 0) {
          return { features: [feature(1), feature(2)], exceededTransferLimit: true };
        }
        return { features: [feature(3)], exceededTransferLimit: false };
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.objectContaining({
      resultOffset: 0,
      resultRecordCount: 2,
      orderByFields: ['OBJECTID ASC'],
    }));
    expect(calls[1].resultOffset).toBe(2);
    expect(result.features.map((item) => item.attributes.OBJECTID)).toEqual([1, 2, 3]);
    expect(result.incomplete).toBe(false);
  });

  test('continues offset pagination when a full page is returned without transfer flag', async () => {
    let call = 0;
    const result = await executeArcGisPagination({
      metadata: metadata(),
      fetchPage: async () => {
        call += 1;
        return call === 1
          ? { features: [feature(1), feature(2)] }
          : { features: [] };
      },
    });
    expect(call).toBe(2);
    expect(result.features).toHaveLength(2);
  });

  test('stops offset pagination when the service repeats the same page', async () => {
    const result = await executeArcGisPagination({
      metadata: metadata(),
      options: { maxPages: 10 },
      fetchPage: async () => ({
        features: [feature(1), feature(2)],
        exceededTransferLimit: true,
      }),
    });
    expect(result.metrics.stoppedByNoProgress).toBe(true);
    expect(result.pageCount).toBe(2);
    expect(result.features).toHaveLength(2);
  });

  test('honors maxFeatures under offset pagination', async () => {
    const result = await executeArcGisPagination({
      metadata: metadata(),
      options: { pageSize: 2, maxFeatures: 3 },
      fetchPage: async ({ resultOffset }) => ({
        features: resultOffset === 0 ? [feature(1), feature(2)] : [feature(3), feature(4)],
        exceededTransferLimit: true,
      }),
    });
    expect(result.features).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.metrics.stoppedByLimit).toBe(true);
  });

  test('uses object-id chunks when pagination offsets are unavailable', async () => {
    const requests = [];
    const result = await executeArcGisPagination({
      metadata: metadata({
        advancedQueryCapabilities: { supportsPagination: false, supportsOrderBy: false },
      }),
      options: { pageSize: 2 },
      fetchObjectIds: async () => ({ objectIds: [4, 2, 1, 3] }),
      fetchPage: async (request) => {
        requests.push(request);
        return {
          features: request.objectIds.map((id) => feature(Number(id))),
        };
      },
    });
    expect(requests.map((request) => request.objectIds)).toEqual([
      ['4', '2'],
      ['1', '3'],
    ]);
    expect(result.objectIdCount).toBe(4);
    expect(result.features).toHaveLength(4);
  });

  test('deduplicates object ids before chunking', async () => {
    const requests = [];
    await executeArcGisPagination({
      metadata: metadata({ advancedQueryCapabilities: { supportsPagination: false } }),
      fetchObjectIds: async () => ({ objectIds: [1, 1, 2, 2] }),
      fetchPage: async (request) => {
        requests.push(request.objectIds);
        return { features: request.objectIds.map((id) => feature(Number(id))) };
      },
    });
    expect(requests).toEqual([['1', '2']]);
  });

  test('reports object-id truncation when safety limits are reached', async () => {
    const result = await executeArcGisPagination({
      metadata: metadata({ advancedQueryCapabilities: { supportsPagination: false } }),
      options: { pageSize: 2, maxFeatures: 3 },
      fetchObjectIds: async () => ({ objectIds: [1, 2, 3, 4, 5] }),
      fetchPage: async ({ objectIds }) => ({
        features: objectIds.map((id) => feature(Number(id))),
      }),
    });
    expect(result.features).toHaveLength(3);
    expect(result.incomplete).toBe(true);
    expect(result.metrics.stoppedByLimit).toBe(true);
  });

  test('falls back from forced object-id mode to offset when object-id adapter is absent and offsets are supported', async () => {
    const result = await executeArcGisPagination({
      metadata: metadata(),
      options: { strategy: ARCGIS_PAGINATION_STRATEGY.OBJECT_IDS },
      fetchPage: async () => ({ features: [feature(1)] }),
    });
    expect(result.plan.strategy).toBe(ARCGIS_PAGINATION_STRATEGY.OFFSET);
    expect(result.features).toHaveLength(1);
  });

  test('rejects missing object-id adapter when no safe fallback exists', async () => {
    await expect(executeArcGisPagination({
      metadata: metadata({ advancedQueryCapabilities: { supportsPagination: false } }),
      fetchPage: async () => ({ features: [] }),
    })).rejects.toMatchObject({ code: 'INVALID_FETCH_OBJECT_IDS' });
  });

  test('rejects an invalid page adapter', async () => {
    await expect(executeArcGisPagination({ metadata: metadata() }))
      .rejects.toBeInstanceOf(ArcGisPaginationError);
  });

  test('observes an already-aborted signal before issuing requests', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchPage = vi.fn();
    await expect(executeArcGisPagination({
      metadata: metadata(),
      options: { signal: controller.signal },
      fetchPage,
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  test('observes cancellation between pages', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(executeArcGisPagination({
      metadata: metadata(),
      options: { signal: controller.signal },
      fetchPage: async () => {
        calls += 1;
        if (calls === 1) controller.abort();
        return { features: [feature(1), feature(2)], exceededTransferLimit: true };
      },
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls).toBe(1);
  });

  test('single-page strategy exposes transfer-limit incompleteness instead of silently claiming completeness', async () => {
    const result = await executeArcGisPagination({
      metadata: { maxRecordCount: 2 },
      fetchPage: async () => ({
        features: [feature(1), feature(2)],
        exceededTransferLimit: true,
      }),
    });
    expect(result.plan.strategy).toBe(ARCGIS_PAGINATION_STRATEGY.SINGLE_PAGE);
    expect(result.incomplete).toBe(true);
    expect(result.metrics.transferLimitPages).toBe(1);
  });
});
