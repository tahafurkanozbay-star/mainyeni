import { loadModules } from 'esri-loader';
import {
  GisQueryHelper,
  clearGisQueryRuntime,
  getGisQueryRuntimeStats,
} from './GisQueryHelper';

jest.mock('esri-loader', () => ({
  loadModules: jest.fn(),
}));

describe('GisQueryHelper runtime', () => {
  let execute;
  let QueryTask;
  let Query;

  beforeEach(() => {
    clearGisQueryRuntime();
    jest.clearAllMocks();

    execute = jest.fn().mockResolvedValue({
      features: [{ attributes: { OBJECTID: 7 }, geometry: { type: 'point' } }],
      fields: [{ name: 'OBJECTID' }],
      exceededTransferLimit: false,
      geometryType: 'esriGeometryPoint',
      spatialReference: { wkid: 4326 },
    });
    QueryTask = jest.fn().mockImplementation(({ url }) => ({ url, execute }));
    Query = jest.fn().mockImplementation((initial = {}) => ({ ...initial }));
    loadModules.mockResolvedValue([QueryTask, Query]);
  });

  test('deduplicates identical in-flight queries and loads ArcGIS modules once', async () => {
    const options = {
      url: '/arcgis/rest/services/places/FeatureServer/0',
      where: 'OBJECTID > 0',
      outFields: ['OBJECTID'],
      returnGeometry: true,
    };

    const first = GisQueryHelper.ExecuteQuery(options);
    const second = GisQueryHelper.ExecuteQuery({ ...options });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(loadModules).toHaveBeenCalledTimes(1);
    expect(QueryTask).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(firstResult.data).toEqual(secondResult.data);
    expect(firstResult).toMatchObject({
      exceededTransferLimit: false,
      geometryType: 'esriGeometryPoint',
      spatialReference: { wkid: 4326 },
    });
    expect(getGisQueryRuntimeStats()).toEqual({ inFlight: 0, modulesLoaded: true });
  });

  test('keeps caller-owned cancellation isolated from deduplication', async () => {
    const signalA = { aborted: false };
    const signalB = { aborted: false };
    const options = {
      url: '/arcgis/rest/services/places/FeatureServer/0',
      where: '1=1',
      outFields: ['OBJECTID'],
    };

    await Promise.all([
      GisQueryHelper.ExecuteQuery({ ...options, signal: signalA }),
      GisQueryHelper.ExecuteQuery({ ...options, signal: signalB }),
    ]);

    expect(loadModules).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, expect.anything(), { signal: signalA });
    expect(execute).toHaveBeenNthCalledWith(2, expect.anything(), { signal: signalB });
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

  test('rejects a pre-cancelled query before creating an ArcGIS task', async () => {
    const result = await GisQueryHelper.ExecuteSpatialQuery({
      url: '/arcgis/rest/services/places/FeatureServer/0',
      geometry: { type: 'extent' },
      signal: { aborted: true },
    });

    expect(result.data).toBeNull();
    expect(result.error.code).toBe('CANCELLED');
    expect(QueryTask).not.toHaveBeenCalled();
  });
});
