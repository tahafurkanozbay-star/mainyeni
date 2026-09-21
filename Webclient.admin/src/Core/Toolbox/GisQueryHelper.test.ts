const executeQueryJSON = vi.hoisted(() => vi.fn());

vi.mock('@arcgis/core/rest/query.js', () => ({
  executeQueryJSON,
}));

import { GisQueryHelper } from './GisQueryHelper';

describe('GisQueryHelper', () => {
  beforeEach(() => {
    executeQueryJSON.mockReset();
  });

  test('executes attribute queries through ArcGIS ESM REST API', async () => {
    executeQueryJSON.mockResolvedValue({
      features: [
        {
          attributes: { OBJECTID: 7, NAME: 'Test' },
          geometry: null,
        },
      ],
    });

    await expect(GisQueryHelper.ExecuteQueryAsync({
      url: 'https://example.test/FeatureServer/0',
      outFields: ['OBJECTID', 'NAME'],
      where: 'OBJECTID = 7',
      returnGeometry: false,
      orderByFields: ['NAME ASC'],
    })).resolves.toEqual([
      {
        attr: { OBJECTID: 7, NAME: 'Test' },
        geometry: null,
      },
    ]);

    expect(executeQueryJSON).toHaveBeenCalledTimes(1);
    expect(executeQueryJSON.mock.calls[0]?.[0])
      .toBe('https://example.test/FeatureServer/0');
    expect(executeQueryJSON.mock.calls[0]?.[1]).toEqual({
      returnDistinctValues: false,
      orderByFields: ['NAME ASC'],
      returnGeometry: false,
      outFields: ['OBJECTID', 'NAME'],
      where: 'OBJECTID = 7',
    });
    expect(executeQueryJSON.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('keeps ExecuteQuery as a behavior-compatible alias', async () => {
    executeQueryJSON.mockResolvedValue({ features: [] });

    await expect(GisQueryHelper.ExecuteQuery({
      url: '/arcgis/rest/services/test/FeatureServer/0',
      outFields: ['*'],
    })).resolves.toEqual([]);

    expect(executeQueryJSON).toHaveBeenCalledTimes(1);
  });

  test('preserves spatial query properties while removing runtime-only controls', async () => {
    executeQueryJSON.mockResolvedValue({ features: [] });
    const signal = new AbortController().signal;

    await GisQueryHelper.ExecuteSpatialQuery({
      url: '/arcgis/rest/services/test/FeatureServer/0',
      geometry: { x: 32.8, y: 39.9, spatialReference: { wkid: 4326 } },
      spatialRelationship: 'intersects',
      returnGeometry: true,
      outFields: ['OBJECTID'],
      signal,
      timeoutMs: 5_000,
    });

    expect(executeQueryJSON.mock.calls[0]?.[1]).toEqual({
      geometry: { x: 32.8, y: 39.9, spatialReference: { wkid: 4326 } },
      spatialRelationship: 'intersects',
      returnGeometry: true,
      outFields: ['OBJECTID'],
    });
    expect(executeQueryJSON.mock.calls[0]?.[1]).not.toHaveProperty('signal');
    expect(executeQueryJSON.mock.calls[0]?.[1]).not.toHaveProperty('timeoutMs');
  });

  test('fails closed to null when ArcGIS rejects the request', async () => {
    executeQueryJSON.mockRejectedValue(new Error('service unavailable'));

    await expect(GisQueryHelper.ExecuteQueryAsync({
      url: 'https://example.test/FeatureServer/0',
      outFields: ['*'],
    })).resolves.toBeNull();
  });

  test('rejects empty service URLs without issuing a network request', async () => {
    await expect(GisQueryHelper.ExecuteQueryAsync({
      url: '   ',
      outFields: ['*'],
    })).resolves.toBeNull();

    expect(executeQueryJSON).not.toHaveBeenCalled();
  });

  test('propagates external abort state into the ArcGIS request signal', async () => {
    const controller = new AbortController();
    controller.abort('navigation');

    executeQueryJSON.mockImplementation(async (_url, _query, requestOptions) => {
      expect(requestOptions?.signal?.aborted).toBe(true);
      throw new DOMException('aborted', 'AbortError');
    });

    await expect(GisQueryHelper.ExecuteQueryAsync({
      url: 'https://example.test/FeatureServer/0',
      outFields: ['*'],
      signal: controller.signal,
    })).resolves.toBeNull();
  });
});
