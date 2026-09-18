import { loadArcgisModules as loadModules } from './arcgisModuleRuntime';
import {
  classifyIdentifyLayer,
  clearIdentifyRuntimeCache,
  collectIdentifyTargets,
  createIdentifySession,
  dedupeIdentifyResults,
  executeGlobalIdentify,
  groupIdentifyResults,
  identifyFeatureLayers,
  identifyMapServices,
} from './identifyRuntime';

jest.mock('./arcgisModuleRuntime', () => ({
  evictArcgisModule: jest.fn(),
  loadArcgisModules: jest.fn(),
}));

const createView = (layers = []) => ({
  width: 1200,
  height: 800,
  extent: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
  map: { allLayers: { items: layers } },
  hitTest: jest.fn().mockResolvedValue({ results: [] }),
});

describe('identifyRuntime', () => {
  beforeEach(() => {
    clearIdentifyRuntimeCache();
    jest.clearAllMocks();
  });

  test('classifies visible ArcGIS map and feature layers without treating groups as identify targets', () => {
    expect(classifyIdentifyLayer({ id: 'map', type: 'map-image', visible: true, url: '/roads/MapServer' }))
      .toMatchObject({ kind: 'map-service', id: 'map' });
    expect(classifyIdentifyLayer({ id: 'feature', type: 'feature', visible: true, url: '/parks/FeatureServer/0' }))
      .toMatchObject({ kind: 'feature-layer', id: 'feature' });
    expect(classifyIdentifyLayer({ id: 'group', type: 'group', visible: true }))
      .toMatchObject({ kind: 'skip', reason: 'group' });
    expect(classifyIdentifyLayer({ id: 'hidden', type: 'feature', visible: false, url: '/a/FeatureServer/0' }))
      .toMatchObject({ kind: 'skip', reason: 'hidden' });
  });

  test('infers layer kind from ArcGIS service URL suffix when SDK type is absent', () => {
    expect(classifyIdentifyLayer({ id: 'map', url: 'https://example.test/a/MapServer/2' }).kind).toBe('map-service');
    expect(classifyIdentifyLayer({ id: 'feature', url: 'https://example.test/a/FeatureServer' }).kind).toBe('feature-layer');
  });

  test('collects identify targets from map allLayers', () => {
    const view = createView([
      { id: 'one', type: 'map-image', url: '/one/MapServer' },
      { id: 'two', type: 'feature', url: '/two/FeatureServer/0' },
      { id: 'three', type: 'tile', url: '/three/TileServer' },
    ]);
    const targets = collectIdentifyTargets(view);
    expect(targets.mapServices.map((target) => target.id)).toEqual(['one']);
    expect(targets.featureLayers.map((target) => target.id)).toEqual(['two']);
    expect(targets.skipped.map((target) => target.id)).toEqual(['three']);
  });

  test('executes MapServer identify with view dimensions and normalized results', async () => {
    const identify = { identify: jest.fn().mockResolvedValue({ results: [{ layerId: 7, layerName: 'Roads', displayFieldName: 'NAME', value: 'Atatürk Bulvarı', feature: { attributes: { OBJECTID: 11, NAME: 'Atatürk Bulvarı' }, geometry: { type: 'polyline' } } }] }) };
    const IdentifyParameters = jest.fn().mockImplementation((initial) => ({ ...initial }));
    loadModules.mockResolvedValue([identify, IdentifyParameters]);
    const view = createView([{ id: 'roads', title: 'Road service', type: 'map-image', url: '/roads/MapServer' }]);
    const response = await identifyMapServices(view, { x: 1, y: 2 });
    expect(identify.identify).toHaveBeenCalledTimes(1);
    const [url, params] = identify.identify.mock.calls[0];
    expect(url).toBe('/roads/MapServer');
    expect(params).toMatchObject({ returnGeometry: true, geometry: { x: 1, y: 2 }, tolerance: 3, width: 1200, height: 800 });
    expect(response.failures).toEqual([]);
    expect(response.results[0]).toMatchObject({ source: 'identify', targetId: 'roads', targetUrl: '/roads/MapServer', layerId: 7, layerName: 'Roads', attributes: { OBJECTID: 11, NAME: 'Atatürk Bulvarı' } });
  });

  test('isolates one MapServer failure while retaining successful identify results', async () => {
    const identify = { identify: jest.fn((url) => url.includes('broken') ? Promise.reject(new Error('service unavailable')) : Promise.resolve({ results: [{ layerId: 1, layerName: 'Good', feature: { attributes: { OBJECTID: 1 } } }] })) };
    const IdentifyParameters = jest.fn().mockImplementation((initial) => ({ ...initial }));
    loadModules.mockResolvedValue([identify, IdentifyParameters]);
    const view = createView([{ id: 'good', type: 'map-image', url: '/good/MapServer' }, { id: 'broken', type: 'map-image', url: '/broken/MapServer' }]);
    const response = await identifyMapServices(view, { x: 1, y: 1 }, undefined, { concurrency: 1 });
    expect(response.results).toHaveLength(1);
    expect(response.failures).toHaveLength(1);
    expect(response.failures[0].target.id).toBe('broken');
  });

  test('uses hitTest include filter for FeatureLayers and normalizes hits', async () => {
    const featureLayer = { id: 'parks', title: 'Parks', type: 'feature', url: '/parks/FeatureServer/0' };
    const unrelated = { id: 'labels', type: 'graphics' };
    const view = createView([featureLayer, unrelated]);
    view.hitTest.mockResolvedValue({ results: [{ graphic: { layer: featureLayer, attributes: { OBJECTID: 3, NAME: 'Kuğulu' }, geometry: { x: 1, y: 2 } } }, { graphic: { layer: unrelated, attributes: { OBJECTID: 99 } } }] });
    const results = await identifyFeatureLayers(view, { x: 200, y: 300, mapPoint: { x: 1, y: 2 } });
    expect(view.hitTest).toHaveBeenCalledWith(expect.objectContaining({ x: 200, y: 300 }), { include: [featureLayer] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source: 'hit-test', targetUrl: '/parks/FeatureServer/0', layerId: 'parks', layerName: 'Parks', attributes: { OBJECTID: 3, NAME: 'Kuğulu' } });
  });

  test('deduplicates results inside the same service layer and object id', () => {
    const results = [
      { targetUrl: '/parks/MapServer', layerId: 0, attributes: { OBJECTID: 1 } },
      { targetUrl: '/parks/MapServer/', layerId: 0, attributes: { OBJECTID: 1 } },
      { targetUrl: '/parks/MapServer', layerId: 0, attributes: { OBJECTID: 2 } },
    ];
    expect(dedupeIdentifyResults(results)).toHaveLength(2);
  });

  test('preserves identical layer and object ids returned by different ArcGIS services', () => {
    const results = [
      { targetId: 'parks-a', targetUrl: '/district-a/MapServer', layerId: 0, layerName: 'Parks', attributes: { OBJECTID: 1 } },
      { targetId: 'parks-b', targetUrl: '/district-b/MapServer', layerId: 0, layerName: 'Parks', attributes: { OBJECTID: 1 } },
    ];
    expect(dedupeIdentifyResults(results)).toHaveLength(2);
  });

  test('groups normalized identify results by service namespace and layer', () => {
    const groups = groupIdentifyResults([
      { targetId: 'parks-a', targetUrl: '/a/MapServer', layerId: 0, layerName: 'Parks', attributes: { OBJECTID: 1 } },
      { targetId: 'parks-a', targetUrl: '/a/MapServer', layerId: 0, layerName: 'Parks', attributes: { OBJECTID: 2 } },
      { targetId: 'parks-b', targetUrl: '/b/MapServer', layerId: 0, layerName: 'Parks', attributes: { OBJECTID: 1 } },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ targetId: 'parks-a', targetUrl: '/a/MapServer', layerId: 0, layerName: 'Parks' });
    expect(groups[0].features).toHaveLength(2);
    expect(groups[1]).toMatchObject({ targetId: 'parks-b', targetUrl: '/b/MapServer', layerId: 0, layerName: 'Parks' });
    expect(groups[1].features).toHaveLength(1);
  });

  test('executes map-service identify and feature hit-test together', async () => {
    const mapLayer = { id: 'map', title: 'Map', type: 'map-image', url: '/map/MapServer' };
    const featureLayer = { id: 'feature', title: 'Feature', type: 'feature', url: '/feature/FeatureServer/0' };
    const identify = { identify: jest.fn().mockResolvedValue({ results: [{ layerId: 4, layerName: 'Map sublayer', feature: { attributes: { OBJECTID: 8 } } }] }) };
    const IdentifyParameters = jest.fn().mockImplementation((initial) => ({ ...initial }));
    loadModules.mockResolvedValue([identify, IdentifyParameters]);
    const view = createView([mapLayer, featureLayer]);
    view.hitTest.mockResolvedValue({ results: [{ graphic: { layer: featureLayer, attributes: { OBJECTID: 9 }, geometry: { x: 1, y: 1 } } }] });
    const response = await executeGlobalIdentify(view, { x: 100, y: 100, mapPoint: { x: 1, y: 1 } });
    expect(response.results).toHaveLength(2);
    expect(response.groups).toHaveLength(2);
    expect(response.targetCount).toBe(2);
    expect(response.failures).toEqual([]);
  });

  test('returns an empty contract when no map point is available', async () => {
    await expect(executeGlobalIdentify(createView(), {})).resolves.toEqual({ groups: [], results: [], failures: [], skipped: [], targetCount: 0 });
  });

  test('rejects an already aborted identify before loading ArcGIS modules', async () => {
    const signal = { aborted: true };
    await expect(identifyMapServices(createView(), { x: 1, y: 1 }, [], { signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(loadModules).not.toHaveBeenCalled();
  });

  test('identify session cancels stale runs even when the SDK request ignores abort', async () => {
    const mapLayer = { id: 'map', type: 'map-image', url: '/map/MapServer' };
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const identify = { identify: jest.fn().mockImplementationOnce(() => { markFirstStarted(); return new Promise(() => {}); }).mockResolvedValueOnce({ results: [] }) };
    const IdentifyParameters = jest.fn().mockImplementation((initial) => ({ ...initial }));
    loadModules.mockResolvedValue([identify, IdentifyParameters]);
    const view = createView([mapLayer]);
    const session = createIdentifySession();
    const first = session.run(view, { mapPoint: { x: 1, y: 1 } });
    await firstStarted;
    const second = session.run(view, { mapPoint: { x: 2, y: 2 } });
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(second).resolves.toMatchObject({ groups: [] });
    expect(session.active).toBe(false);
  });
});
