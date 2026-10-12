import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommonBusiness } from './CommonBusiness';
import { Constants_LayerType } from '../Core/Constants';
import { loadArcgisModules } from '../gis-engine/arcgisModuleRuntime';
import MapManager from '../Store/Managers/MapManager';

vi.mock('../gis-engine/arcgisModuleRuntime', () => ({ loadArcgisModules: vi.fn() }));
const loadModules = vi.mocked(loadArcgisModules);

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('capability-specific layer creation', () => {
  it('creates a service layer from frozen bootstrap descriptors without mutating them', async () => {
    const service = Object.freeze({ title: 'YeniParklarQeryUrl', eg: 'https://public.gissrv.org' });
    MapManager.SetConfigurationServices(Object.freeze([service]));
    const addProxyRule = vi.fn();
    const Layer = vi.fn(function () { return { definitionExpression: '' }; });
    loadModules.mockImplementation(async (ids) => (
      ids[0] === 'esri/config' ? [{ request: {} }, { addProxyRule }] : [Layer]
    ) as never);
    const result = await CommonBusiness.Clustering.CreateLayerWithoutClustering('YeniParklarQeryUrl', 'Parklar', {});
    expect(result.layerObj.definitionExpression).toBe('1=1');
    expect(service).not.toHaveProperty('_INDEX');
    expect(addProxyRule).toHaveBeenCalledWith(expect.objectContaining({ urlPrefix: service.eg }));
    MapManager.SetConfigurationServices([]);
  });
  it.each([
    [Constants_LayerType.FeatureLayer, 'esri/layers/FeatureLayer'],
    [Constants_LayerType.MapImageLayer, 'esri/layers/MapImageLayer'],
  ])('loads only the constructor needed by layer type %s', async (layerType, moduleId) => {
    const Layer = vi.fn(function (properties: unknown) { return { properties }; });
    loadModules.mockResolvedValue([Layer] as never);
    const layer = await CommonBusiness.CreateLayer({ layerType, id: 'layer-a', title: 'Katman', opacity: 50, visible: true });
    expect(loadModules).toHaveBeenCalledExactlyOnceWith([moduleId]);
    expect(layer).toMatchObject({ properties: { id: 'layer-a', title: 'Katman', opacity: 0.5, visible: true } });
  });

  it('does not load the SDK for unsupported layer types', async () => {
    await expect(CommonBusiness.CreateLayer({ layerType: -999 })).resolves.toBeNull();
    expect(loadModules).not.toHaveBeenCalled();
  });

  it('rejects failed GeoJSON loads while releasing the layer and object URL', async () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:layer-test' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const error = new Error('unavailable');
    const layer = { load: vi.fn(async () => { throw error; }), destroy: vi.fn() };
    const Layer = vi.fn(function () { return layer; });
    loadModules.mockResolvedValue([Layer] as never);
    await expect(CommonBusiness.CreateLayer({ layerType: Constants_LayerType.GeoJSONLayer, type: 'FeatureCollection', features: [] })).rejects.toBe(error);
    expect(loadModules).toHaveBeenCalledExactlyOnceWith(['esri/layers/GeoJSONLayer']);
    expect(layer.destroy).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:layer-test');
  });
});
