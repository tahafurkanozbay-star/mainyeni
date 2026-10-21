import { describe, expect, it, vi } from 'vitest';
import {
  ESRI_3D_BUILDINGS_SCENE_LAYER_URL,
  Esri3DBuildingsRuntime,
  type Esri3DBuildingsLayerConstructor,
  type Esri3DBuildingsLayerLike,
} from './esri3DBuildingsRuntime';

class FakeSceneLayer implements Esri3DBuildingsLayerLike {
  visible = true;
  loaded = false;
  readonly properties: Record<string, unknown>;
  readonly load = vi.fn(async () => { this.loaded = true; });
  readonly destroy = vi.fn();

  constructor(properties: Record<string, unknown> = {}) {
    this.properties = properties;
    this.visible = properties.visible === true;
  }
}

const layerConstructor = FakeSceneLayer as unknown as Esri3DBuildingsLayerConstructor;
type FakeMap = {
  layers: Esri3DBuildingsLayerLike[];
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

const createMap = (): FakeMap => {
  const map: FakeMap = {
    layers: [],
    add: vi.fn((layer: Esri3DBuildingsLayerLike) => { map.layers.push(layer); }),
    remove: vi.fn((layer: Esri3DBuildingsLayerLike) => {
      map.layers = map.layers.filter((candidate) => candidate !== layer);
    }),
  };
  return map;
};

describe('Esri 3D buildings runtime', () => {
  it('creates the official SceneLayer only when activated in 3D', async () => {
    const loadSceneLayer = vi.fn(async () => layerConstructor);
    const map = createMap();
    const runtime = new Esri3DBuildingsRuntime({ loadSceneLayer });

    expect(loadSceneLayer).not.toHaveBeenCalled();
    expect(map.add).not.toHaveBeenCalled();

    await runtime.activate({ map });
    await Promise.resolve();

    expect(loadSceneLayer).toHaveBeenCalledTimes(1);
    expect(map.add).toHaveBeenCalledTimes(1);
    expect(map.layers).toHaveLength(1);
    expect((map.layers[0] as FakeSceneLayer).properties).toMatchObject({
      id: 'kentrehberi-esri-3d-buildings',
      title: 'Esri 3D Buildings',
      url: ESRI_3D_BUILDINGS_SCENE_LAYER_URL,
      visible: true,
      listMode: 'hide',
      legendEnabled: false,
      popupEnabled: true,
    });
    expect((map.layers[0] as FakeSceneLayer).load).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('hides and reuses the same layer when switching between 3D and 2D', async () => {
    const loadSceneLayer = vi.fn(async () => layerConstructor);
    const map = createMap();
    const runtime = new Esri3DBuildingsRuntime({ loadSceneLayer });

    await runtime.activate({ map });
    await Promise.resolve();
    const layer = map.layers[0] as FakeSceneLayer;

    runtime.deactivate();
    expect(layer.visible).toBe(false);
    expect(map.remove).not.toHaveBeenCalled();

    await runtime.activate({ map });
    expect(layer.visible).toBe(true);
    expect(loadSceneLayer).toHaveBeenCalledTimes(1);
    expect(map.add).toHaveBeenCalledTimes(1);

    runtime.dispose();
    expect(map.remove).toHaveBeenCalledWith(layer);
    expect(layer.destroy).toHaveBeenCalledTimes(1);
    expect(map.layers).toHaveLength(0);
  });

  it('removes the old layer when the underlying map changes', async () => {
    const loadSceneLayer = vi.fn(async () => layerConstructor);
    const firstMap = createMap();
    const secondMap = createMap();
    const runtime = new Esri3DBuildingsRuntime({ loadSceneLayer });

    await runtime.activate({ map: firstMap });
    const firstLayer = firstMap.layers[0] as FakeSceneLayer;
    await runtime.activate({ map: secondMap });

    expect(firstMap.remove).toHaveBeenCalledWith(firstLayer);
    expect(firstMap.layers).toHaveLength(0);
    expect(secondMap.layers).toHaveLength(1);
    expect(loadSceneLayer).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('reports remote layer load failures and removes the unusable layer without crashing transitions', async () => {
    class BrokenSceneLayer extends FakeSceneLayer {
      override readonly load = vi.fn(async () => { throw new Error('service unavailable'); });
    }
    const onError = vi.fn();
    const map = createMap();
    const runtime = new Esri3DBuildingsRuntime({
      loadSceneLayer: async () => BrokenSceneLayer as unknown as Esri3DBuildingsLayerConstructor,
      onError,
    });

    await runtime.activate({ map });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'gis.esri-3d-buildings.load');
    expect(map.layers).toHaveLength(0);
    runtime.dispose();
  });

  it('rejects a view with no add-capable map', async () => {
    const runtime = new Esri3DBuildingsRuntime({ loadSceneLayer: vi.fn(async () => layerConstructor) });
    await expect(runtime.activate({ map: null })).rejects.toThrow('harita nesnesi hazır değil');
  });
});
