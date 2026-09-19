import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Constants_ServiceResultType } from '../Core/Constants';
import MapManager from '../Store/Managers/MapManager';
import { GisQueryHelper } from '../Toolbox/GisQueryHelper';
import { apiClient } from '../platform/http/httpClient';
import { NumberingQueryBusiness } from './NumberingQueryBusiness';
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

vi.mock('../platform/http/httpClient', () => ({
  apiClient: {
    get: vi.fn(),
  },
}));

const success = (data: readonly unknown[] = []) => ({
  type: Constants_ServiceResultType.Success,
  data,
  fields: [],
});

const service = (title: string) => ({ title, url: `/gis/${title}` });

const ALL_SERVICES = [
  'NumberingDistrictQueryUrl',
  'NumberingNeighborhoodQueryUrl',
  'StreetQueryUrl',
  'StreetCenterLineUrl',
  'StreetCenterLineWayUrl',
  'DoorQueryUrl',
  'BuildingQueryUrl',
  'StructureQueryUrl',
  'NumberingInfoQueryUrl',
].map(service);

const queryMock = vi.mocked(GisQueryHelper.ExecuteQuery);
const spatialMock = vi.mocked(GisQueryHelper.ExecuteSpatialQuery);
const serviceMock = vi.mocked(MapManager.GetConfigurationServices);
const apiGetMock = vi.mocked(apiClient.get);

describe('NumberingQueryBusiness strict TypeScript address runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBusinessRuntimeDiagnostics();
    serviceMock.mockReturnValue(ALL_SERVICES);
    queryMock.mockResolvedValue(success());
    spatialMock.mockResolvedValue(success());
  });

  it('escapes SQL literals in direct address identifiers', async () => {
    await NumberingQueryBusiness.GetDistrictById("A'B");

    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({
      where: "id='A''B'",
      url: '/gis/NumberingDistrictQueryUrl',
    }));
  });

  it('escapes Turkish text search literals instead of concatenating raw input', async () => {
    await NumberingQueryBusiness.GetDistricts({ DistrictName: "o'connor" });

    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.stringContaining("O''CONNOR"),
    }));
  });

  it('returns an empty result without issuing invalid IN when a neighborhood has no centerlines', async () => {
    queryMock.mockResolvedValueOnce(success([]));

    const result = await NumberingQueryBusiness.GetStreets('nb-1');

    expect(result).toEqual(success([]));
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('builds escaped IN filters from ids and sorts street data with Turkish collation', async () => {
    queryMock
      .mockResolvedValueOnce(success([
        { attr: { yolortahatid: "center'2" } },
        { attr: { yolortahatid: 'center-1' } },
      ]))
      .mockResolvedValueOnce(success([
        { attr: { ad: 'Ziya', yolid: '2' } },
        { attr: { ad: 'Atatürk', yolid: '1' } },
      ]));

    const result = await NumberingQueryBusiness.GetStreets('nb-1') as {
      readonly data: readonly { readonly attr: { readonly ad: string } }[];
    };

    expect(queryMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: "id IN ('center''2','center-1')",
    }));
    expect(result.data.map(item => item.attr.ad)).toEqual(['Atatürk', 'Ziya']);
  });

  it('accepts legacy pre-quoted id arrays but owns SQL quoting centrally', async () => {
    await NumberingQueryBusiness.GetStreetWaysofCenterLinesByCenterlineIDs([
      "'abc'",
      'def',
    ]);

    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({
      where: "yolortahatid IN ('abc','def')",
    }));
  });

  it('does not call door service when street has no centerline records', async () => {
    queryMock.mockResolvedValueOnce(success([]));

    const result = await NumberingQueryBusiness.GetDoors('street-1');

    expect(result).toEqual(success([]));
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('preserves zero-valued identifiers across centerline and door cascade', async () => {
    queryMock
      .mockResolvedValueOnce(success([{ attr: { id: 0, ad: 'Hat' } }]))
      .mockResolvedValueOnce(success([{ attr: { id: 0 } }]))
      .mockResolvedValueOnce(success([{ attr: { id: 'door-1', kapino: '1' } }]));

    const result = await NumberingQueryBusiness.GetDoors('street-zero') as {
      readonly data: readonly unknown[];
    };

    expect(queryMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: "yolortahatid IN ('0')",
    }));
    expect(queryMock).toHaveBeenNthCalledWith(3, expect.objectContaining({
      where: "yolortahatyonid IN ('0')",
    }));
    expect(result.data).toEqual([{ attr: { id: 'door-1', kapino: '1' } }]);
  });

  it('uses platform client with bounded cache and dedupe for building documents', async () => {
    const documents = [{ id: 1 }];
    const callback = vi.fn();
    apiGetMock.mockResolvedValue(documents);

    await expect(NumberingQueryBusiness.GetBuildingDocumentList(
      { attr: { id: 'building-1' } },
      'elektrikProje',
      callback,
    )).resolves.toEqual(documents);

    expect(apiGetMock).toHaveBeenCalledWith(
      '/Common/FileService.svc/GetBuildingDocuments',
      expect.objectContaining({
        params: {
          buildingId: 'building-1',
          category: 'elektrikProje',
        },
        cache: true,
        dedupe: true,
        cacheTtlMs: 30_000,
      }),
    );
    expect(callback).toHaveBeenCalledWith(documents);
  });

  it('forwards abort signal and disables dedupe for cancellable photo requests', async () => {
    const controller = new AbortController();
    apiGetMock.mockResolvedValue([]);

    await NumberingQueryBusiness.GetBuildingPhotoList(
      { attr: { id: 'building-2' } },
      null,
      { signal: controller.signal, cacheTtlMs: 5_000 },
    );

    expect(apiGetMock).toHaveBeenCalledWith(
      '/Common/FileService.svc/GetBuildingPhotos',
      expect.objectContaining({
        signal: controller.signal,
        cache: true,
        dedupe: false,
        cacheTtlMs: 5_000,
        params: { buildingId: 'building-2' },
      }),
    );
  });

  it('keeps legacy callback contract on normalized file-service failures', async () => {
    const callback = vi.fn();
    apiGetMock.mockRejectedValue(new Error('network'));

    await expect(NumberingQueryBusiness.GetBuildingPhotoList(
      { attr: { id: 'building-3' } },
      callback,
    )).resolves.toBeNull();
    expect(callback).toHaveBeenCalledWith(null);
  });

  it('fails deterministically when configured numbering service is missing', async () => {
    serviceMock.mockReturnValue([]);

    await expect(NumberingQueryBusiness.GetDoorById('door-1')).rejects.toMatchObject({
      code: 'BUSINESS_SERVICE_NOT_FOUND',
      serviceKey: 'DoorQueryUrl',
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('uses spatial query runtime for building intersection and preserves one-meter radius', async () => {
    const point = { x: 1, y: 2 };
    spatialMock.mockResolvedValue(success([{ attr: { id: 1 } }]));

    await NumberingQueryBusiness.IntersectBuildingsWithMapPoint(point);

    expect(spatialMock).toHaveBeenCalledWith(expect.objectContaining({
      url: '/gis/BuildingQueryUrl',
      geometry: point,
      distance: 100,
      units: 'meters',
      spatialRelationship: 'intersects',
    }));
  });

  it('returns immutable document category definitions', () => {
    const categories = NumberingQueryBusiness.GetBuildingDocumentCategoryList();
    expect(categories).toHaveLength(7);
    expect(Object.isFrozen(categories)).toBe(true);
    expect(Object.isFrozen(categories[0])).toBe(true);
  });
});
