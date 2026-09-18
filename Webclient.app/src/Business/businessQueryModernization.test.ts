const mocks = vi.hoisted(() => {
  const configurationServices: Array<Record<string, unknown>> = [];
  const map = {
    add: vi.fn(),
    remove: vi.fn(),
  };
  const mapView = {
    map,
    popup: {},
    goTo: vi.fn().mockResolvedValue(undefined),
  };
  const mapManager = {
    GetConfigurationServices: vi.fn(() => configurationServices),
    GetMapView: vi.fn(() => mapView),
  };
  const executeQuery = vi.fn();
  const executeSpatialQuery = vi.fn();
  const loadArcgisModules = vi.fn();
  const dispatch = vi.fn();
  const store = {
    getState: vi.fn(() => ({
      Common: { BigPopupLinkRef: null },
    })),
    dispatch,
  };

  return {
    configurationServices,
    map,
    mapView,
    mapManager,
    executeQuery,
    executeSpatialQuery,
    loadArcgisModules,
    dispatch,
    store,
  };
});

vi.mock('../Store/Managers/MapManager', () => ({
  default: mocks.mapManager,
  MapManager: mocks.mapManager,
}));

vi.mock('../Toolbox/GisQueryHelper', () => ({
  GisQueryHelper: {
    ExecuteQuery: mocks.executeQuery,
    ExecuteSpatialQuery: mocks.executeSpatialQuery,
  },
}));

vi.mock('../gis-engine/arcgisModuleRuntime', () => ({
  loadArcgisModules: mocks.loadArcgisModules,
}));

vi.mock('../Store/Store', () => ({
  default: mocks.store,
}));

import { CommonBusiness } from './CommonBusiness';
import { EventQueryBusiness } from './EventQueryBusiness';
import { NumberingQueryBusiness } from './NumberingQueryBusiness';
import { RouteQueryBusiness } from './RouteQueryBusiness';

const success = (data: readonly unknown[] = []) => ({
  type: 10,
  data,
  fields: [],
  exceededTransferLimit: false,
  page: {
    offset: 0,
    count: data.length,
    hasMore: false,
    nextOffset: null,
  },
});

const service = (title: string, url: string) => ({
  title,
  eg: url,
});

describe('strict TypeScript business query integrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.configurationServices.splice(
      0,
      mocks.configurationServices.length,
      service('EventQueryUrl', '/arcgis/events/FeatureServer/0'),
      service('RouteQueryUrl', '/arcgis/routes/FeatureServer/0'),
      service('NumberingDistrictQueryUrl', '/arcgis/district/FeatureServer/0'),
      service('NumberingNeighborhoodQueryUrl', '/arcgis/neighborhood/FeatureServer/0'),
      service('StreetQueryUrl', '/arcgis/street/FeatureServer/0'),
      service('StreetCenterLineUrl', '/arcgis/centerline/FeatureServer/0'),
      service('StreetCenterLineWayUrl', '/arcgis/centerline-way/FeatureServer/0'),
      service('DoorQueryUrl', '/arcgis/door/FeatureServer/0'),
      service('BuildingQueryUrl', '/arcgis/building/FeatureServer/0'),
      service('StructureQueryUrl', '/arcgis/structure/FeatureServer/0'),
      service('NumberingInfoQueryUrl', '/arcgis/numbering/FeatureServer/0'),
      service('AttachmentService', '/arcgis/attachment/FeatureServer/0'),
      service('PlacesService', '/arcgis/places/FeatureServer/0'),
    );
    mocks.executeQuery.mockResolvedValue(success());
    mocks.executeSpatialQuery.mockResolvedValue(success());
  });

  describe('EventQueryBusiness', () => {
    test('escapes quote-bearing text filters before executing the GIS query', async () => {
      await EventQueryBusiness.Query({
        name: "Çankaya' OR 1=1 --",
        districtId: "district' OR '1'='1",
        nbhoodId: "nb'hood",
        Id: "event'id",
        startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: new Date('2026-12-31T00:00:00Z'),
      }, true);

      expect(mocks.executeQuery).toHaveBeenCalledTimes(1);
      const options = mocks.executeQuery.mock.calls[0]?.[0] as Record<string, unknown>;
      const where = String(options.where);

      expect(options.url).toBe('/arcgis/events/FeatureServer/0');
      expect(options.returnGeometry).toBe(true);
      expect(where).toContain("ÇANKAYA'' OR 1=1 --");
      expect(where).toContain("ilceid='district'' OR ''1''=''1'");
      expect(where).toContain("mahalleid='nb''hood'");
      expect(where).toContain("id='event''id'");
      expect(where).not.toContain("ilceid='district' OR '1'='1'");
    });

    test('uses bounded spatial distance for nearby queries', async () => {
      await EventQueryBusiness.Query({
        showNearby: true,
        bufferDistance: 999_999,
        userLocation: { x: 32.85, y: 39.92 },
      });

      expect(mocks.executeSpatialQuery).toHaveBeenCalledWith(expect.objectContaining({
        distance: 50_000,
        units: 'meters',
        spatialRelationship: 'intersects',
      }));
      expect(mocks.executeQuery).not.toHaveBeenCalled();
    });

    test('rejects deterministically when configuration service is missing', async () => {
      mocks.configurationServices.splice(0, mocks.configurationServices.length);

      await expect(EventQueryBusiness.Query({ name: 'test' }))
        .rejects.toMatchObject({ type: expect.anything() });
      expect(mocks.executeQuery).not.toHaveBeenCalled();
    });
  });

  describe('RouteQueryBusiness', () => {
    test('accepts safe legacy numeric-string route identifiers', async () => {
      await RouteQueryBusiness.Query({
        Id: '42',
        routeLevel: '3',
        districtId: "a'b",
        name: "rota'",
      });

      const options = mocks.executeQuery.mock.calls[0]?.[0] as Record<string, unknown>;
      const where = String(options.where);
      expect(where).toContain('objectid=42');
      expect(where).toContain('zorlukderecesi=3');
      expect(where).toContain("ilceid='a''b'");
      expect(where).toContain("UPPER(adi) LIKE '%ROTA''%'");
    });

    test('fails closed for unsafe object-id literals', async () => {
      await RouteQueryBusiness.Query({
        Id: '42 OR 1=1',
        routeLevel: '2; DROP TABLE',
      });

      const options = mocks.executeQuery.mock.calls[0]?.[0] as Record<string, unknown>;
      const where = String(options.where);
      expect(where).toContain('1=0');
      expect(where).not.toContain('42 OR 1=1');
      expect(where).not.toContain('DROP TABLE');
    });

    test('keeps route-type visibility filters when no explicit route id exists', async () => {
      await RouteQueryBusiness.Query({
        showCultureWalkingRoute: false,
        showNatureWalkingRoute: false,
      });

      const options = mocks.executeQuery.mock.calls[0]?.[0] as Record<string, unknown>;
      const where = String(options.where);
      expect(where).toContain('tip <> 1');
      expect(where).toContain('tip <> 2');
    });
  });

  describe('NumberingQueryBusiness', () => {
    test('builds an escaped, deduplicated centerline IN filter', async () => {
      mocks.executeQuery
        .mockResolvedValueOnce(success([
          { attr: { yolortahatid: "line'1" }, geometry: null },
          { attr: { yolortahatid: "line'1" }, geometry: null },
          { attr: { yolortahatid: 'line2' }, geometry: null },
        ]))
        .mockResolvedValueOnce(success());

      await NumberingQueryBusiness.GetStreets("nb'hood");

      expect(mocks.executeQuery).toHaveBeenCalledTimes(2);
      const first = mocks.executeQuery.mock.calls[0]?.[0] as Record<string, unknown>;
      const second = mocks.executeQuery.mock.calls[1]?.[0] as Record<string, unknown>;
      expect(first.where).toBe("mahalleid='nb''hood'");
      expect(second.where).toBe("id IN ('line''1','line2')");
    });

    test('returns an empty success without a second network query when no centerline exists', async () => {
      mocks.executeQuery.mockResolvedValueOnce(success([]));

      const result = await NumberingQueryBusiness.GetStreets('nb-1');

      expect(mocks.executeQuery).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ type: 10, data: [] });
    });

    test('sorts district results with Turkish collation without mutating the source array', async () => {
      const source = [
        { attr: { ad: 'Ümitköy' }, geometry: null },
        { attr: { ad: 'Çankaya' }, geometry: null },
        { attr: { ad: 'Ankara' }, geometry: null },
      ];
      mocks.executeQuery.mockResolvedValueOnce(success(source));

      const result = await NumberingQueryBusiness.GetDistricts();

      expect(source.map((item) => item.attr.ad)).toEqual(['Ümitköy', 'Çankaya', 'Ankara']);
      expect(Array.isArray(result.data) ? result.data.map((item) => item.attr?.ad) : [])
        .toEqual(['Ankara', 'Çankaya', 'Ümitköy']);
    });

    test('keeps file-service failures nullable for legacy callers', async () => {
      const result = await NumberingQueryBusiness.GetBuildingPhotoList({ id: 5 });
      expect(result).toBeNull();
    });
  });

  describe('CommonBusiness', () => {
    test('normalizes legacy service URL aliases', () => {
      expect(CommonBusiness.GenerateUrl({ eg: '/a' })).toBe('/a');
      expect(CommonBusiness.GenerateUrl({ Eg: '/b' })).toBe('/b');
      expect(CommonBusiness.GenerateUrl({ url: '/c' })).toBe('/c');
      expect(CommonBusiness.GenerateUrl({ Url: '/d' })).toBe('/d');
      expect(CommonBusiness.GenerateUrl('not-a-service')).toBeNull();
    });

    test('creates safe popup website links and rejects javascript URLs', async () => {
      const unsafe = await CommonBusiness.Clustering.GetPopupInfo({
        graphic: {
          attributes: {
            adi: 'Unsafe',
            websitesi: 'javascript:alert(1)',
          },
        },
      });
      expect(unsafe?.querySelector('a')).toBeNull();

      const safe = await CommonBusiness.Clustering.GetPopupInfo({
        graphic: {
          attributes: {
            adi: 'Safe',
            websitesi: 'https://example.test/place',
          },
        },
      });
      const anchor = safe?.querySelector('a');
      expect(anchor?.href).toBe('https://example.test/place');
      expect(anchor?.rel).toBe('noopener noreferrer');
      expect(anchor?.target).toBe('_blank');
    });

    test('encodes attachment identifiers in generated URLs', () => {
      expect(CommonBusiness.Attachments.GetAttachmentUrl(
        'AttachmentService',
        'object/1',
        'att 2',
      )).toBe('/arcgis/attachment/FeatureServer/0/object%2F1/attachments/att%202');
    });

    test('loads GeoJSON through a temporary Blob URL and revokes it after load', async () => {
      const createObjectURL = vi.fn(() => 'blob:https://local.test/layer');
      const revokeObjectURL = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: createObjectURL,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: revokeObjectURL,
      });

      const load = vi.fn().mockResolvedValue(undefined);
      const GeoJSONLayer = vi.fn(function GeoJSONLayerMock(options: Record<string, unknown>) {
        return { ...options, load };
      });
      const FeatureLayer = vi.fn(function FeatureLayerMock(options: Record<string, unknown>) {
        return { ...options };
      });
      const MapImageLayer = vi.fn(function MapImageLayerMock(options: Record<string, unknown>) {
        return { ...options };
      });

      mocks.loadArcgisModules.mockResolvedValueOnce([
        FeatureLayer,
        MapImageLayer,
        GeoJSONLayer,
      ]);

      const layer = await CommonBusiness.CreateLayer({
        layerType: 4,
        title: 'Demo GeoJSON',
        type: 'FeatureCollection',
        features: [],
      });

      expect(layer).not.toBeNull();
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(load).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://local.test/layer');
    });

    test('applies a safe object-id filter to nearby FeatureLayer queries', async () => {
      const queryObjectIds = vi.fn().mockResolvedValue([1, 2, Number.NaN, '3']);
      const FeatureLayer = vi.fn(function FeatureLayerMock(options: Record<string, unknown>) {
        return {
          ...options,
          queryObjectIds,
          definitionExpression: '',
        };
      });
      mocks.loadArcgisModules.mockImplementation(async (ids: readonly string[]) => {
        if (ids.length === 1 && ids[0] === 'esri/layers/FeatureLayer') {
          return [FeatureLayer];
        }
        if (ids[0] === 'esri/config') {
          return [
            { request: { proxyUrl: '', forceProxy: false } },
            { addProxyRule: vi.fn() },
          ];
        }
        return [];
      });

      const result = await CommonBusiness.Clustering.CreateLayerWithoutClustering(
        'PlacesService',
        'Places',
        {
          showNearby: true,
          bufferDistance: 20,
          userLocation: { x: 32.85, y: 39.92 },
        },
        null,
        false,
      );

      expect(queryObjectIds).toHaveBeenCalledWith(expect.objectContaining({
        distance: 2000,
        units: 'meters',
      }));
      expect(result.layerObj.definitionExpression).toContain('objectid IN (1,2)');
      expect(result.layerObj.definitionExpression).not.toContain('3');
    });
  });
});
