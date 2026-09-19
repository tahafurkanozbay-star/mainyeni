import { beforeEach, describe, expect, it, vi } from 'vitest';
import MapManager from '../Store/Managers/MapManager';
import { GisQueryHelper } from '../Toolbox/GisQueryHelper';
import { RouteQueryBusiness } from './RouteQueryBusiness';
import { clearBusinessRuntimeDiagnostics } from './runtime';

vi.mock('../Toolbox/GisQueryHelper', () => ({
  GisQueryHelper: {
    ExecuteQuery: vi.fn(),
    ExecuteSpatialQuery: vi.fn(),
  },
}));

vi.mock('../Store/Managers/MapManager', () => ({
  __esModule: true,
  default: {
    GetConfigurationServices: vi.fn(),
  },
}));

const queryMock = vi.mocked(GisQueryHelper.ExecuteQuery);
const spatialMock = vi.mocked(GisQueryHelper.ExecuteSpatialQuery);
const servicesMock = vi.mocked(MapManager.GetConfigurationServices);

describe('RouteQueryBusiness strict TypeScript runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBusinessRuntimeDiagnostics();
    servicesMock.mockReturnValue([
      { title: 'RouteQueryUrl', url: '/gis/routes' },
    ]);
    queryMock.mockResolvedValue({ type: 10, data: [] });
    spatialMock.mockResolvedValue({ type: 10, data: [] });
  });

  it('escapes name and district filters without raw concatenation', async () => {
    await RouteQueryBusiness.Query({
      name: "O'Connor",
      districtId: "A'B",
      showCultureWalkingRoute: true,
      showNatureWalkingRoute: true,
    });

    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({
      url: '/gis/routes',
      where: expect.stringContaining("UPPER(adi) LIKE '%O''CONNOR%'"),
    }));
    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.stringContaining("ilceid='A''B'"),
    }));
  });

  it('applies route-type exclusions only to list queries', async () => {
    await RouteQueryBusiness.Query({
      showCultureWalkingRoute: false,
      showNatureWalkingRoute: false,
    });

    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.stringContaining('tip <> 1'),
    }));
    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.stringContaining('tip <> 2'),
    }));
  });

  it('does not exclude route types when a concrete object id is requested', async () => {
    await RouteQueryBusiness.Query({
      Id: 42,
      showCultureWalkingRoute: false,
      showNatureWalkingRoute: false,
    });

    const options = queryMock.mock.calls[0]?.[0];
    expect(options?.where).toContain('objectid=42');
    expect(options?.where).not.toContain('tip <> 1');
    expect(options?.where).not.toContain('tip <> 2');
  });

  it('uses the spatial executor and preserves legacy buffer-distance scaling', async () => {
    const point = { x: 1, y: 2 };
    await RouteQueryBusiness.Query({
      showNearby: true,
      userLocation: point,
      bufferDistance: 5,
    }, true);

    expect(spatialMock).toHaveBeenCalledWith(expect.objectContaining({
      url: '/gis/routes',
      geometry: point,
      distance: 500,
      units: 'meters',
      spatialRelationship: 'intersects',
      returnGeometry: true,
      where: '(tip=1 or tip=2)',
    }));
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('clamps excessive nearby distance at the shared policy boundary', async () => {
    await RouteQueryBusiness.Query({
      showNearby: true,
      userLocation: { x: 1, y: 2 },
      bufferDistance: 9999,
    });

    expect(spatialMock).toHaveBeenCalledWith(expect.objectContaining({
      distance: 10_000,
    }));
  });

  it('fails with typed service metadata when route service is absent', async () => {
    servicesMock.mockReturnValue([]);

    await expect(RouteQueryBusiness.Query({}))
      .rejects.toMatchObject({
        code: 'BUSINESS_SERVICE_NOT_FOUND',
        serviceKey: 'RouteQueryUrl',
      });
  });
});
