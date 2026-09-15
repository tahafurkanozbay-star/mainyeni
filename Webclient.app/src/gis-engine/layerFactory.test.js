import { loadModules } from 'esri-loader';
import { create2DLayer, create3DLayer } from './layerFactory';

jest.mock('esri-loader', () => ({
  loadModules: jest.fn(),
}));

const FeatureLayer = jest.fn().mockImplementation((options) => ({ ...options, type: 'feature' }));
const MapImageLayer = jest.fn().mockImplementation((options) => ({ ...options, type: 'map-image' }));
const VectorTileLayer = jest.fn().mockImplementation((options) => ({ ...options, type: 'vector-tile' }));
const ImageryLayer = jest.fn().mockImplementation((options) => ({ ...options, type: 'imagery' }));
const SceneLayer = jest.fn().mockImplementation((options) => ({ ...options, type: 'scene' }));

const sdkModules = {
  'esri/layers/FeatureLayer': FeatureLayer,
  'esri/layers/MapImageLayer': MapImageLayer,
  'esri/layers/VectorTileLayer': VectorTileLayer,
  'esri/layers/ImageryLayer': ImageryLayer,
  'esri/layers/SceneLayer': SceneLayer,
};

describe('layerFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadModules.mockImplementation(([name]) => Promise.resolve([sdkModules[name]]));
  });

  test('creates a FeatureServer sublayer only when the observed URL is a FeatureServer root', async () => {
    const layer = await create2DLayer({
      id: 'parks',
      title: 'Parks',
      type: 'FeatureServer',
      url: '/arcgis/rest/services/parks/FeatureServer',
      sublayerId: 3,
      minScale: 250000,
      maxScale: 5000,
      opacity: 0.6,
    });

    expect(FeatureLayer).toHaveBeenCalledWith({
      url: '/arcgis/rest/services/parks/FeatureServer/3',
    });
    expect(layer).toMatchObject({
      id: 'parks',
      title: 'Parks',
      visible: true,
      opacity: 0.6,
      minScale: 250000,
      maxScale: 5000,
    });
  });

  test('does not invent a FeatureServer path for an explicitly typed server-owned alias', async () => {
    await create2DLayer({
      id: 'alias',
      type: 'FeatureServer',
      url: '/Gis/Proxy/places',
      sublayerId: 7,
    });

    expect(FeatureLayer).toHaveBeenLastCalledWith({ url: '/Gis/Proxy/places' });
  });

  test('rejects WMS before attempting to load an ArcGIS layer module', async () => {
    const callCount = loadModules.mock.calls.length;

    await expect(create2DLayer({
      id: 'legacy-wms',
      type: 'WMS',
      url: '/legacy/wms',
    })).rejects.toThrow(/not supported/i);

    expect(loadModules).toHaveBeenCalledTimes(callCount);
  });

  test('creates SceneServer layers for 3D and reuses the ArcGIS module promise', async () => {
    const service = {
      id: 'buildings',
      type: 'SceneServer',
      url: '/arcgis/rest/services/buildings/SceneServer',
    };

    const first = await create3DLayer(service);
    const second = await create3DLayer({ ...service, id: 'buildings-copy' });

    expect(first.type).toBe('scene');
    expect(second.type).toBe('scene');
    expect(loadModules.mock.calls.filter(([names]) => names[0] === 'esri/layers/SceneLayer')).toHaveLength(1);
  });

  test('supports MapServer layers in both 2D and 3D without WMS/WFS fallbacks', async () => {
    const service = {
      id: 'boundaries',
      type: 'MapServer',
      url: '/arcgis/rest/services/boundaries/MapServer',
    };

    const layer2D = await create2DLayer(service);
    const layer3D = await create3DLayer({ ...service, id: 'boundaries-3d' });

    expect(layer2D.type).toBe('map-image');
    expect(layer3D.type).toBe('map-image');
  });
});
