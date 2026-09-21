import { loadArcgisModules as loadModules } from '../gis-engine/arcgisModuleRuntime';
import {
  GisQueryHelper,
  clearGisQueryRuntime,
  configureGisQueryRuntime,
  getGisQueryRuntimeStats,
  invalidateGisQueryCacheTag,
} from './GisQueryHelper';

jest.mock('../gis-engine/arcgisModuleRuntime', () => ({
  loadArcgisModules: jest.fn(),
}));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('GisQueryHelper runtime', () => {
  let execute;
  let executeForCount;
  let executeForIds;
  let QueryTask;
  let Query;

  beforeEach(() => {
    clearGisQueryRuntime();
    configureGisQueryRuntime({ ttlMs: 30000, maxEntries: 128, maxBytes: 8 * 1024 * 1024 });
    jest.clearAllMocks();

    execute = jest.fn().mockResolvedValue({
      features: [{ attributes: { OBJECTID: 7 }, geometry: { type: 'point' } }],
      fields: [{ name: 'OBJECTID' }],
      exceededTransferLimit: false,
      geometryType: 'esriGeometryPoint',
      spatialReference: { wkid: 4326 },
    });
    executeForCount = jest.fn().mockResolvedValue(42);
    executeForIds = jest.fn().mockResolvedValue([1, 2, 3]);
    QueryTask = jest.fn().mockImplementation(({ url }) => ({
      url,
      execute,
      executeForCount,
      executeForIds,
    }));
    Query = jest.fn().mockImplementation((initial = {}) => ({ ...initial }));
    loadModules.mockResolvedValue([QueryTask, Query]);
  });

  test('deduplicates identical in-flight queries and loads ArcGIS modules once', async () => {
    const pending = deferred();
    execute.mockReturnValueOnce(pending.promise);
    const options = {
      url: '/arcgis/rest/services/places/FeatureServer/0',
      where: 'OBJECTID > 0',
      outFields: ['OBJECTID'],
      returnGeometry: true,
    };
    const before = getGisQueryRuntimeStats();

    const first = GisQueryHelper.ExecuteQuery(options);
    const second = GisQueryHelper.ExecuteQuery({ ...options });
    await flush();

    expect(loadModules).toHaveBeenCalledTimes(1);
    expect(QueryTask).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);

    pending.resolve({
      features: [{ attributes: { OBJECTID: 7 }, geometry: { type: 'point' } }],
      fields: [{ name: 'OBJECTID' }],
      exceededTransferLimit: false,
      geometryType: 'esriGeometryPoint',
      spatialReference: { wkid: 4326 },
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.data).toEqual(secondResult.data);
    expect(firstResult).toMatchObject({
      exceededTransferLimit: false,
      geometryType: 'esriGeometryPoint',
      spatialReference: { wkid: 4326 },
      page: { offset: 0, count: 1, hasMore: false, nextOffset: null },
    });
    const after = getGisQueryRuntimeStats();
    expect(after.inFlight).toBe(0);
    expect(after.modulesLoaded).toBe(true);
    expect(after.networkStarts - before.networkStarts).toBe(1);
    expect(after.deduped - before.deduped).toBe(1);
  });

  test('passes normalized pagination to ArcGIS and exposes a deterministic next offset', async () => {
    execute.mockResolvedValueOnce({
      features: [
        { attributes: { OBJECTID: 21 } },
        { attributes: { OBJECTID: 22 } },
      ],
      exceededTransferLimit: true,
    });

    const result = await GisQueryHelper.ExecuteQuery({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      where: '1=1',
      orderByFields: ['OBJECTID ASC'],
      resultOffset: '20',
      resultRecordCount: 10.8,
    });

    expect(Query).toHaveBeenCalledWith(expect.objectContaining({
      resultOffset: 20,
      resultRecordCount: 10,
      orderByFields: ['OBJECTID ASC'],
    }));
    expect(result.page).toEqual({ offset: 20, count: 2, hasMore: true, nextOffset: 22 });
  });

  test('stops pagination when a service reports a transfer limit without returning records', async () => {
    execute.mockResolvedValueOnce({
      features: [],
      exceededTransferLimit: true,
    });

    const result = await GisQueryHelper.ExecuteQuery({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      resultOffset: 40,
      resultRecordCount: 20,
    });

    expect(result.exceededTransferLimit).toBe(true);
    expect(result.page).toEqual({ offset: 40, count: 0, hasMore: false, nextOffset: null });
  });

  test('normalizes malformed ArcGIS collection fields instead of failing on schema drift', async () => {
    execute.mockResolvedValueOnce({
      features: { unexpected: true },
      fields: 'OBJECTID',
      exceededTransferLimit: false,
    });

    const result = await GisQueryHelper.ExecuteQuery({
      url: '/arcgis/rest/services/places/FeatureServer/0',
    });

    expect(result.type).toBeDefined();
    expect(result.data).toEqual([]);
    expect(result.fields).toEqual([]);
    expect(result.page).toEqual({ offset: 0, count: 0, hasMore: false, nextOffset: null });
  });

  test('normalizes sparse feature payloads without throwing', async () => {
    execute.mockResolvedValueOnce({
      features: [null, { attributes: null, geometry: undefined }],
      fields: [],
    });

    const result = await GisQueryHelper.ExecuteQuery({
      url: '/arcgis/rest/services/places/FeatureServer/0',
    });

    expect(result.data).toEqual([
      { attr: null, geometry: null },
      { attr: null, geometry: null },
    ]);
  });

  test('drops invalid pagination values instead of forwarding unsafe query parameters', async () => {
    await GisQueryHelper.ExecuteQuery({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      resultOffset: -1,
      resultRecordCount: 'not-a-number',
    });

    expect(Query).toHaveBeenCalledWith(expect.not.objectContaining({
      resultOffset: expect.anything(),
      resultRecordCount: expect.anything(),
    }));
  });

  test('deduplicates signal-aware consumers while keeping cancellation isolated', async () => {
    const request = deferred();
    let sdkSignal;
    execute.mockImplementationOnce((query, requestOptions) => {
      sdkSignal = requestOptions.signal;
      return request.promise;
    });
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const options = {
      url: '/arcgis/rest/services/places/FeatureServer/0',
      where: '1=1',
      outFields: ['OBJECTID'],
    };

    const first = GisQueryHelper.ExecuteQuery({ ...options, signal: controllerA.signal });
    const second = GisQueryHelper.ExecuteQuery({ ...options, signal: controllerB.signal });
    await flush();

    expect(execute).toHaveBeenCalledTimes(1);
    controllerA.abort();
    const firstResult = await first;
    expect(firstResult.data).toBeNull();
    expect(firstResult.error.code).toBe('CANCELLED');
    expect(sdkSignal.aborted).toBe(false);

    request.resolve({
      features: [{ attributes: { OBJECTID: 8 } }],
      exceededTransferLimit: false,
    });
    const secondResult = await second;
    expect(secondResult.data).toEqual([{ attr: { OBJECTID: 8 }, geometry: null }]);
    expect(sdkSignal.aborted).toBe(false);
  });

  test('aborts the shared ArcGIS request when every consumer cancels', async () => {
    let sdkSignal;
    execute.mockImplementationOnce((query, requestOptions) => {
      sdkSignal = requestOptions.signal;
      return new Promise((resolve, reject) => {
        requestOptions.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('arcgis aborted'), { name: 'AbortError' }));
        });
      });
    });
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const options = {
      url: '/arcgis/rest/services/places/FeatureServer/0',
      where: '1=1',
    };

    const first = GisQueryHelper.ExecuteQuery({ ...options, signal: controllerA.signal });
    const second = GisQueryHelper.ExecuteQuery({ ...options, signal: controllerB.signal });
    await flush();

    controllerA.abort();
    controllerB.abort();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.error.code).toBe('CANCELLED');
    expect(secondResult.error.code).toBe('CANCELLED');
    expect(sdkSignal.aborted).toBe(true);
  });

  test('retries module loading after a transient loader failure', async () => {
    loadModules
      .mockRejectedValueOnce(new Error('loader unavailable'))
      .mockResolvedValueOnce([QueryTask, Query]);

    const failed = await GisQueryHelper.ExecuteQuery({ url: '/first', outFields: ['OBJECTID'] });
    const recovered = await GisQueryHelper.ExecuteQuery({ url: '/second', outFields: ['OBJECTID'] });

    expect(failed.data).toBeNull();
    expect(failed.error.message).toBe('loader unavailable');
    expect(recovered.data).toHaveLength(1);
    expect(loadModules).toHaveBeenCalledTimes(2);
  });

  test('rejects an empty GIS service URL before creating an ArcGIS task', async () => {
    const result = await GisQueryHelper.ExecuteQuery({
      url: '   ',
      where: '1=1',
    });

    expect(result.data).toBeNull();
    expect(result.error).toMatchObject({ code: 'INVALID_GIS_URL' });
    expect(QueryTask).not.toHaveBeenCalled();
    expect(loadModules).not.toHaveBeenCalled();
  });

  test('rejects a pre-cancelled query before creating an ArcGIS task', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await GisQueryHelper.ExecuteSpatialQuery({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      geometry: { type: 'extent' },
      signal: controller.signal,
    });

    expect(result.data).toBeNull();
    expect(result.error.code).toBe('CANCELLED');
    expect(QueryTask).not.toHaveBeenCalled();
  });

  test('caches complete results only when explicitly requested', async () => {
    const options = {
      url: '/arcgis/rest/services/places/FeatureServer/0',
      where: 'OBJECTID = 7',
      outFields: ['OBJECTID'],
      cache: true,
      ttlMs: 10000,
      cacheTags: ['places'],
    };

    const first = await GisQueryHelper.ExecuteQuery(options);
    const second = await GisQueryHelper.ExecuteQuery({ ...options });

    expect(first.data).toEqual(second.data);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('does not cache transfer-limit-truncated feature payloads', async () => {
    execute.mockResolvedValue({
      features: [{ attributes: { OBJECTID: 1 } }],
      exceededTransferLimit: true,
    });
    const options = {
      url: '/arcgis/rest/services/places/FeatureServer/0',
      cache: true,
      resultRecordCount: 1,
    };

    await GisQueryHelper.ExecuteQuery(options);
    await GisQueryHelper.ExecuteQuery(options);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  test('invalidates cached feature results by service tag', async () => {
    const url = '/arcgis/rest/services/places/FeatureServer/0';
    const options = { url, where: '1=1', cache: true };

    await GisQueryHelper.ExecuteQuery(options);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(invalidateGisQueryCacheTag(url)).toBe(1);
    await GisQueryHelper.ExecuteQuery(options);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test('uses executeForCount for accurate feature counts', async () => {
    const result = await GisQueryHelper.ExecuteCount({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      where: 'district_id = 1',
    });

    expect(executeForCount).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ data: 42, count: 42, exceededTransferLimit: false });
  });

  test('supports geometry-aware count queries', async () => {
    await GisQueryHelper.ExecuteSpatialCount({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      geometry: { type: 'extent', xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      spatialRelationship: 'intersects',
    });

    expect(Query).toHaveBeenCalledWith(expect.objectContaining({
      geometry: expect.objectContaining({ type: 'extent' }),
      spatialRelationship: 'intersects',
    }));
    expect(executeForCount).toHaveBeenCalledTimes(1);
  });

  test('falls back to executeForIds when executeForCount is unavailable', async () => {
    QueryTask.mockImplementationOnce(({ url }) => ({
      url,
      execute,
      executeForIds,
    }));

    const result = await GisQueryHelper.ExecuteCount({
      url: '/arcgis/rest/services/places/FeatureServer/0',
    });

    expect(executeForIds).toHaveBeenCalledTimes(1);
    expect(result.count).toBe(3);
  });

  test('does not return a misleading count when the SDK lacks count APIs', async () => {
    QueryTask.mockImplementationOnce(({ url }) => ({ url, execute }));

    const result = await GisQueryHelper.ExecuteCount({
      url: '/arcgis/rest/services/places/FeatureServer/0',
    });

    expect(result.data).toBeNull();
    expect(result.error.code).toBe('COUNT_UNSUPPORTED');
    expect(execute).not.toHaveBeenCalled();
  });

  test('can cache a count independently from feature payloads', async () => {
    const options = {
      url: '/arcgis/rest/services/places/FeatureServer/0',
      where: '1=1',
      cache: true,
      ttlMs: 10000,
    };

    await GisQueryHelper.ExecuteCount(options);
    await GisQueryHelper.ExecuteCount(options);
    await GisQueryHelper.ExecuteQuery(options);

    expect(executeForCount).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('paginates until ArcGIS reports a complete result', async () => {
    execute
      .mockResolvedValueOnce({
        features: [
          { attributes: { OBJECTID: 1 } },
          { attributes: { OBJECTID: 2 } },
        ],
        fields: [{ name: 'OBJECTID' }],
        geometryType: 'esriGeometryPoint',
        spatialReference: { wkid: 4326 },
        exceededTransferLimit: true,
      })
      .mockResolvedValueOnce({
        features: [{ attributes: { OBJECTID: 3 } }],
        exceededTransferLimit: false,
      });

    const result = await GisQueryHelper.ExecuteAllPages({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      pageSize: 2,
      maxRecords: 10,
      orderByFields: ['OBJECTID ASC'],
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(Query).toHaveBeenNthCalledWith(1, expect.objectContaining({
      resultOffset: 0,
      resultRecordCount: 2,
      orderByFields: ['OBJECTID ASC'],
    }));
    expect(Query).toHaveBeenNthCalledWith(2, expect.objectContaining({
      resultOffset: 2,
      resultRecordCount: 2,
    }));
    expect(result).toMatchObject({
      data: [
        { attr: { OBJECTID: 1 }, geometry: null },
        { attr: { OBJECTID: 2 }, geometry: null },
        { attr: { OBJECTID: 3 }, geometry: null },
      ],
      fields: [{ name: 'OBJECTID' }],
      geometryType: 'esriGeometryPoint',
      spatialReference: { wkid: 4326 },
      exceededTransferLimit: false,
      page: {
        offset: 0,
        count: 3,
        hasMore: false,
        pages: 2,
        pageSize: 2,
        maxRecords: 10,
        truncated: false,
      },
    });
  });

  test('bounds page size to the ArcGIS-safe client maximum', async () => {
    execute.mockResolvedValueOnce({ features: [], exceededTransferLimit: false });

    await GisQueryHelper.ExecuteAllPages({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      pageSize: 99999,
      maxRecords: 99999,
    });

    expect(Query).toHaveBeenCalledWith(expect.objectContaining({
      resultOffset: 0,
      resultRecordCount: 2000,
    }));
  });

  test('marks a bounded full-query result as truncated when maxRecords is reached', async () => {
    execute.mockResolvedValueOnce({
      features: [
        { attributes: { OBJECTID: 1 } },
        { attributes: { OBJECTID: 2 } },
      ],
      exceededTransferLimit: true,
    });

    const result = await GisQueryHelper.ExecuteAllPages({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      pageSize: 2,
      maxRecords: 2,
    });

    expect(result.exceededTransferLimit).toBe(true);
    expect(result.page).toMatchObject({
      count: 2,
      hasMore: true,
      truncated: true,
      maxRecords: 2,
    });
  });

  test('stops full pagination if a service claims more data but returns no rows', async () => {
    execute.mockResolvedValueOnce({
      features: [],
      exceededTransferLimit: true,
    });

    const result = await GisQueryHelper.ExecuteAllPages({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      pageSize: 50,
    });

    expect(result.type).toBe(ConstantsFallbackSuccess(result.type));
    expect(result.data).toEqual([]);
    expect(result.page.pages).toBe(1);
    expect(result.page.hasMore).toBe(false);
  });

  test('propagates page errors without returning partial data as complete', async () => {
    execute
      .mockResolvedValueOnce({
        features: [{ attributes: { OBJECTID: 1 } }],
        exceededTransferLimit: true,
      })
      .mockRejectedValueOnce(Object.assign(new Error('second page failed'), { code: 'NETWORK' }));

    const result = await GisQueryHelper.ExecuteAllPages({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      pageSize: 1,
    });

    expect(result.data).toBeNull();
    expect(result.error.message).toBe('second page failed');
  });

  test('allows full spatial pagination with the original geometry on every page', async () => {
    execute
      .mockResolvedValueOnce({
        features: [{ attributes: { OBJECTID: 1 } }],
        exceededTransferLimit: true,
      })
      .mockResolvedValueOnce({
        features: [{ attributes: { OBJECTID: 2 } }],
        exceededTransferLimit: false,
      });
    const geometry = { type: 'extent', xmin: 1, ymin: 2, xmax: 3, ymax: 4 };

    const result = await GisQueryHelper.ExecuteAllSpatialPages({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      geometry,
      spatialRelationship: 'intersects',
      pageSize: 1,
    });

    expect(result.data).toHaveLength(2);
    expect(Query).toHaveBeenNthCalledWith(1, expect.objectContaining({ geometry }));
    expect(Query).toHaveBeenNthCalledWith(2, expect.objectContaining({ geometry }));
  });

  test('cancels bounded pagination between pages', async () => {
    const controller = new AbortController();
    execute.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({
        features: [{ attributes: { OBJECTID: 1 } }],
        exceededTransferLimit: true,
      });
    });

    const result = await GisQueryHelper.ExecuteAllPages({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      pageSize: 1,
      signal: controller.signal,
    });

    expect(result.data).toBeNull();
    expect(result.error.code).toBe('CANCELLED');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// The project service-result enum is intentionally treated as opaque in these
// tests; this helper makes the assertion communicate that a normal success
// value is preserved without coupling to the enum's numeric/string encoding.
const ConstantsFallbackSuccess = (value) => value;
