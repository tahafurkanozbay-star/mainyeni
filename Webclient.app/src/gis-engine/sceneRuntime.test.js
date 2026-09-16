import { loadModules } from 'esri-loader';
import { createViewStateBridge } from './viewState';
import { create3DLayer } from './layerFactory';
import {
  addSceneLayer,
  addSceneLayers,
  applySceneBookmark,
  applyViewStateToSceneView,
  bindSceneState,
  buildSceneBookmark,
  configureGround,
  create2D3DSyncState,
  createSceneMeasureContract,
  createSceneView,
  destroySceneView,
  focusPickedGraphic,
  pickScene,
  resetSceneRuntimeModuleCache,
  snapshotSceneState,
} from './sceneRuntime';

jest.mock('esri-loader', () => ({
  loadModules: jest.fn(),
}));

jest.mock('./layerFactory', () => ({
  create3DLayer: jest.fn(),
}));

const flush = () => Promise.resolve().then(() => Promise.resolve());

const createScene = (overrides = {}) => {
  const watchers = new Map();
  const handles = [];
  let clickHandler = null;
  const view = {
    camera: {
      position: { longitude: 32.85, latitude: 39.93 },
      heading: 15,
      tilt: 45,
    },
    scale: 25000,
    extent: {
      xmin: 1,
      ymin: 2,
      xmax: 3,
      ymax: 4,
      spatialReference: { wkid: 4326 },
    },
    map: {
      basemap: { id: 'shared-basemap' },
      ground: { opacity: 1 },
      add: jest.fn(),
    },
    watch: jest.fn((property, callback) => {
      watchers.set(property, callback);
      const handle = { remove: jest.fn() };
      handles.push(handle);
      return handle;
    }),
    on: jest.fn((eventName, handler) => {
      if (eventName === 'click') clickHandler = handler;
      const handle = { remove: jest.fn() };
      handles.push(handle);
      return handle;
    }),
    hitTest: jest.fn().mockResolvedValue({ results: [] }),
    goTo: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn(),
    ...overrides,
  };
  return {
    view,
    watchers,
    handles,
    click: (event = { x: 1, y: 2 }) => clickHandler?.(event),
    emit: (property, value) => watchers.get(property)?.(value),
  };
};

describe('sceneRuntime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSceneRuntimeModuleCache();
  });

  test('reuses a caller-owned map and does not load esri/Map', async () => {
    const sharedMap = { id: 'shared-map' };
    const SceneView = jest.fn().mockImplementation((options) => ({ ...options, type: '3d' }));
    loadModules.mockImplementation(([name]) => {
      if (name === 'esri/views/SceneView') return Promise.resolve([SceneView]);
      throw new Error(`Unexpected module: ${name}`);
    });

    const result = await createSceneView({ id: 'container' }, {
      map: sharedMap,
      camera: { heading: 10 },
    });

    expect(result.map).toBe(sharedMap);
    expect(result.ownsMap).toBe(false);
    expect(loadModules).toHaveBeenCalledTimes(1);
    expect(loadModules).toHaveBeenCalledWith(['esri/views/SceneView']);
    expect(SceneView).toHaveBeenCalledWith(expect.objectContaining({
      map: sharedMap,
      camera: { heading: 10 },
      qualityProfile: 'medium',
      ui: { components: [] },
    }));
  });

  test('creates a local Map without silently requesting a basemap or world elevation', async () => {
    const Map = jest.fn().mockImplementation((options) => ({ options }));
    const SceneView = jest.fn().mockImplementation((options) => ({ ...options }));
    loadModules.mockImplementation(([name]) => Promise.resolve([
      name === 'esri/Map' ? Map : SceneView,
    ]));

    const result = await createSceneView({ id: 'container' });

    expect(Map).toHaveBeenCalledWith({});
    expect(result.ownsMap).toBe(true);
    expect(result.map.options).toEqual({});
    expect(JSON.stringify(Map.mock.calls)).not.toContain('world-elevation');
    expect(JSON.stringify(Map.mock.calls)).not.toContain('streets-vector');
  });

  test('uses basemap and ground only when explicitly supplied', async () => {
    const Map = jest.fn().mockImplementation((options) => ({ options }));
    const SceneView = jest.fn().mockImplementation((options) => options);
    loadModules.mockImplementation(([name]) => Promise.resolve([
      name === 'esri/Map' ? Map : SceneView,
    ]));

    await createSceneView({}, {
      basemap: 'osm',
      ground: { id: 'configured-ground' },
    });

    expect(Map).toHaveBeenCalledWith({
      basemap: 'osm',
      ground: { id: 'configured-ground' },
    });
  });

  test('caches SceneView and Map modules across scene creation', async () => {
    const Map = jest.fn().mockImplementation(() => ({}));
    const SceneView = jest.fn().mockImplementation((options) => options);
    loadModules.mockImplementation(([name]) => Promise.resolve([
      name === 'esri/Map' ? Map : SceneView,
    ]));

    await createSceneView({ id: 1 });
    await createSceneView({ id: 2 });

    expect(loadModules.mock.calls.filter(([names]) => names[0] === 'esri/Map')).toHaveLength(1);
    expect(loadModules.mock.calls.filter(([names]) => names[0] === 'esri/views/SceneView')).toHaveLength(1);
  });

  test('resetSceneRuntimeModuleCache permits SDK loader recovery', async () => {
    const SceneViewA = jest.fn().mockImplementation((options) => ({ ...options, sdk: 'a' }));
    const SceneViewB = jest.fn().mockImplementation((options) => ({ ...options, sdk: 'b' }));
    loadModules
      .mockResolvedValueOnce([SceneViewA])
      .mockResolvedValueOnce([SceneViewB]);

    const first = await createSceneView({}, { map: {} });
    resetSceneRuntimeModuleCache();
    const second = await createSceneView({}, { map: {} });

    expect(first.view.sdk).toBe('a');
    expect(second.view.sdk).toBe('b');
  });

  test('destroySceneView detaches the container before SDK destruction', () => {
    const view = { container: {}, destroy: jest.fn() };

    destroySceneView(view);

    expect(view.container).toBeNull();
    expect(view.destroy).toHaveBeenCalledTimes(1);
  });

  test('destroySceneView accepts the createSceneView result shape', () => {
    const view = { container: {}, destroy: jest.fn() };

    destroySceneView({ view, map: {} });

    expect(view.container).toBeNull();
    expect(view.destroy).toHaveBeenCalledTimes(1);
  });

  test('allows fully transparent ground and clamps opacity', async () => {
    const view = { map: { ground: { opacity: 1 } } };

    await configureGround(view, { opacity: 0 });
    expect(view.map.ground.opacity).toBe(0);

    await configureGround(view, { opacity: 2 });
    expect(view.map.ground.opacity).toBe(1);

    await configureGround(view, { opacity: -1 });
    expect(view.map.ground.opacity).toBe(0);
  });

  test('configures ground navigation and surface color only when ground exists', async () => {
    const view = { map: { ground: {} } };

    await expect(configureGround(view, {
      navigationConstraint: { type: 'none' },
      surfaceColor: '#fff',
    })).resolves.toBe(view);

    expect(view.map.ground).toMatchObject({
      navigationConstraint: { type: 'none' },
      surfaceColor: '#fff',
    });
    await expect(configureGround({ map: {} }, { opacity: 0 })).resolves.toEqual({ map: {} });
  });

  test('adds a verified 3d layer to the existing view map', async () => {
    const { view } = createScene();
    const layer = { id: 'buildings' };
    create3DLayer.mockResolvedValue(layer);

    const result = await addSceneLayer(view, { id: 'buildings' }, {
      featureReduction: { type: 'cluster' },
      elevationInfo: { mode: 'absolute-height' },
      index: 2,
    });

    expect(result).toBe(layer);
    expect(layer).toMatchObject({
      featureReduction: { type: 'cluster' },
      elevationInfo: { mode: 'absolute-height' },
    });
    expect(view.map.add).toHaveBeenCalledWith(layer, 2);
  });

  test('rejects layer addition when a SceneView map is unavailable', async () => {
    await expect(addSceneLayer({}, { id: 'missing-map' })).rejects.toThrow(/attached map/i);
    expect(create3DLayer).not.toHaveBeenCalled();
  });

  test('loads multiple scene layers with a bounded worker pool', async () => {
    const { view } = createScene();
    let active = 0;
    let peak = 0;
    const pending = [];
    create3DLayer.mockImplementation((service) => new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      pending.push(() => {
        active -= 1;
        resolve({ id: service.id });
      });
    }));

    const promise = addSceneLayers(view, [
      { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
    ], { concurrency: 2 });
    await flush();
    expect(peak).toBe(2);

    pending.splice(0, 2).forEach((resolve) => resolve());
    await flush();
    expect(peak).toBe(2);
    pending.splice(0).forEach((resolve) => resolve());

    const results = await promise;
    expect(results).toHaveLength(4);
    expect(results.every((entry) => entry.status === 'fulfilled')).toBe(true);
    expect(peak).toBe(2);
  });

  test('multi-layer load records individual failures without stopping by default', async () => {
    const { view } = createScene();
    create3DLayer
      .mockResolvedValueOnce({ id: 'a' })
      .mockRejectedValueOnce(new Error('broken layer'))
      .mockResolvedValueOnce({ id: 'c' });

    const results = await addSceneLayers(view, [
      { id: 'a' }, { id: 'b' }, { id: 'c' },
    ], { concurrency: 1 });

    expect(results.map((entry) => entry.status)).toEqual([
      'fulfilled', 'rejected', 'fulfilled',
    ]);
    expect(results[1].reason.message).toBe('broken layer');
  });

  test('multi-layer load honors stopOnError', async () => {
    const { view } = createScene();
    create3DLayer
      .mockRejectedValueOnce(new Error('first broken'))
      .mockResolvedValue({ id: 'should-not-load' });

    const results = await addSceneLayers(view, [
      { id: 'a' }, { id: 'b' }, { id: 'c' },
    ], { concurrency: 1, stopOnError: true });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('rejected');
    expect(create3DLayer).toHaveBeenCalledTimes(1);
  });

  test('multi-layer load stops scheduling new work after cancellation', async () => {
    const { view } = createScene();
    const controller = new AbortController();
    create3DLayer.mockImplementationOnce(async () => {
      controller.abort();
      return { id: 'a' };
    });

    const results = await addSceneLayers(view, [
      { id: 'a' }, { id: 'b' }, { id: 'c' },
    ], { concurrency: 1, signal: controller.signal });

    expect(results).toHaveLength(1);
    expect(create3DLayer).toHaveBeenCalledTimes(1);
  });

  test('pickScene normalizes hit-test results', async () => {
    const graphic = { id: 1, layer: { id: 'parks' } };
    const { view } = createScene({
      hitTest: jest.fn().mockResolvedValue({
        results: [{ graphic, mapPoint: { x: 1, y: 2 } }],
      }),
    });

    await expect(pickScene(view, { x: 10, y: 20 })).resolves.toEqual([{
      graphic,
      layer: graphic.layer,
      mapPoint: { x: 1, y: 2 },
    }]);
  });

  test('pickScene forwards include and exclude filters', async () => {
    const { view } = createScene();
    const include = [{ id: 'included' }];
    const exclude = [{ id: 'excluded' }];

    await pickScene(view, { x: 1, y: 2 }, { include, exclude });

    expect(view.hitTest).toHaveBeenCalledWith({ x: 1, y: 2 }, { include, exclude });
  });

  test('pickScene returns empty immediately for a pre-cancelled request', async () => {
    const { view } = createScene();
    const controller = new AbortController();
    controller.abort();

    await expect(pickScene(view, { x: 1, y: 2 }, { signal: controller.signal })).resolves.toEqual([]);
    expect(view.hitTest).not.toHaveBeenCalled();
  });

  test('pickScene ignores late SDK hit results after cancellation', async () => {
    let resolveHit;
    const { view } = createScene({
      hitTest: jest.fn(() => new Promise((resolve) => { resolveHit = resolve; })),
    });
    const controller = new AbortController();

    const pending = pickScene(view, { x: 1, y: 2 }, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual([]);
    resolveHit({ results: [{ graphic: { id: 1 } }] });
  });

  test('focusPickedGraphic moves to selected geometry', async () => {
    const { view } = createScene();
    const graphic = { geometry: { type: 'point', x: 1, y: 2 } };

    await expect(focusPickedGraphic(view, graphic, { duration: 250 })).resolves.toBe(true);
    expect(view.goTo).toHaveBeenCalledWith(graphic.geometry, {
      duration: 250,
      animate: true,
    });
  });

  test('focusPickedGraphic supports a custom target factory', async () => {
    const { view } = createScene();
    const graphic = { geometry: { type: 'point' } };

    await focusPickedGraphic(view, graphic, {
      targetFactory: () => ({ target: 'custom' }),
      animate: false,
    });

    expect(view.goTo).toHaveBeenCalledWith({ target: 'custom' }, {
      duration: 500,
      animate: false,
    });
  });

  test('focusPickedGraphic treats abort-related goTo rejection as cancellation', async () => {
    const { view } = createScene({
      goTo: jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    });

    await expect(focusPickedGraphic(view, { geometry: {} })).resolves.toBe(false);
  });

  test('snapshots scene camera into the shared view-state contract', () => {
    const { view } = createScene();

    expect(snapshotSceneState(view)).toMatchObject({
      mode: '3d',
      center: [32.85, 39.93],
      scale: 25000,
      heading: 15,
      tilt: 45,
      extent: { xmin: 1, ymin: 2, xmax: 3, ymax: 4, wkid: 4326 },
      basemapId: 'shared-basemap',
    });
  });

  test('snapshots projected camera x/y when longitude and latitude are absent', () => {
    const { view } = createScene({
      camera: { position: { x: 100, y: 200 }, heading: 0, tilt: 30 },
    });

    expect(snapshotSceneState(view).center).toEqual([100, 200]);
  });

  test('applies scene center scale heading and tilt through one goTo', async () => {
    const { view } = createScene();

    await expect(applyViewStateToSceneView(view, {
      mode: '3d',
      center: [33, 40],
      scale: 12000,
      heading: 25,
      tilt: 55,
    }, { duration: 100, animate: true })).resolves.toBe(true);

    expect(view.goTo).toHaveBeenCalledWith({
      center: [33, 40],
      scale: 12000,
      heading: 25,
      tilt: 55,
    }, {
      duration: 100,
      animate: true,
    });
  });

  test('applies an extent-only scene state', async () => {
    const { view } = createScene();

    await applyViewStateToSceneView(view, {
      mode: '3d',
      extent: { xmin: 1, ymin: 2, xmax: 3, ymax: 4, wkid: 3857 },
      center: null,
      scale: null,
      heading: null,
      tilt: null,
    });

    expect(view.goTo).toHaveBeenCalledWith({
      extent: {
        xmin: 1,
        ymin: 2,
        xmax: 3,
        ymax: 4,
        spatialReference: { wkid: 3857 },
      },
    }, expect.anything());
  });

  test('refuses to apply a 2d state to SceneView unless cross-mode is explicit', async () => {
    const { view } = createScene();

    await expect(applyViewStateToSceneView(view, {
      mode: '2d', center: [33, 40], scale: 10000,
    })).resolves.toBe(false);
    expect(view.goTo).not.toHaveBeenCalled();
  });

  test('removes scene handles and ignores async hit results after teardown', async () => {
    let resolveHit;
    const { view, handles, click } = createScene({
      hitTest: jest.fn(() => new Promise((resolve) => { resolveHit = resolve; })),
    });
    const bridge = createViewStateBridge({ mode: '3d' });
    const selectionCallback = jest.fn();

    const unbind = bindSceneState(view, bridge, selectionCallback);
    const pendingClick = click();
    unbind();
    resolveHit({ results: [{ graphic: { attributes: { OBJECTID: 9 } } }] });
    await pendingClick;

    handles.forEach((handle) => expect(handle.remove).toHaveBeenCalledTimes(1));
    expect(selectionCallback).not.toHaveBeenCalled();
    expect(bridge.getState().selectedObjectId).toBeNull();
  });

  test('new scene click cancels an older pending hit-test selection', async () => {
    const firstHit = {};
    firstHit.promise = new Promise((resolve) => { firstHit.resolve = resolve; });
    const secondGraphic = {
      attributes: { OBJECTID: 22 },
      layer: { id: 'parks' },
    };
    const { view, click } = createScene({
      hitTest: jest.fn()
        .mockReturnValueOnce(firstHit.promise)
        .mockResolvedValueOnce({ results: [{ graphic: secondGraphic }] }),
    });
    const bridge = createViewStateBridge({ mode: '3d' });
    const callback = jest.fn();

    bindSceneState(view, bridge, callback);
    const firstClick = click({ x: 1, y: 1 });
    const secondClick = click({ x: 2, y: 2 });
    await secondClick;
    firstHit.resolve({
      results: [{
        graphic: { attributes: { OBJECTID: 11 }, layer: { id: 'roads' } },
      }],
    });
    await firstClick;

    expect(bridge.getState()).toMatchObject({
      selectedLayerId: 'parks',
      selectedObjectId: 22,
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('scene click clears selection when nothing is hit', async () => {
    const { view, click } = createScene();
    const bridge = createViewStateBridge({
      mode: '3d',
      selectedLayerId: 'parks',
      selectedObjectId: 1,
    });
    const callback = jest.fn();

    bindSceneState(view, bridge, callback);
    await click();

    expect(bridge.getState()).toMatchObject({
      selectedLayerId: null,
      selectedObjectId: null,
    });
    expect(callback).toHaveBeenCalledWith(null, []);
  });

  test('scene camera watch publishes shared state', () => {
    const { view, emit } = createScene();
    const bridge = createViewStateBridge({ mode: '3d' });
    const listener = jest.fn();
    bridge.subscribe(listener);

    bindSceneState(view, bridge);
    view.camera = {
      position: { longitude: 33, latitude: 40 },
      heading: 20,
      tilt: 50,
    };
    emit('camera', view.camera);

    expect(listener).toHaveBeenCalled();
    expect(bridge.getState()).toMatchObject({
      mode: '3d',
      center: [33, 40],
      heading: 20,
      tilt: 50,
    });
  });

  test('incoming 3d bridge state can drive SceneView without a publish loop', async () => {
    const { view } = createScene();
    const bridge = createViewStateBridge(snapshotSceneState(view));

    const unbind = bindSceneState(view, bridge, undefined, {
      applyIncoming: true,
    });
    bridge.setState({
      mode: '3d',
      center: [31, 41],
      scale: 50000,
      heading: 30,
      tilt: 60,
    });
    await flush();

    expect(view.goTo).toHaveBeenCalledWith(expect.objectContaining({
      center: [31, 41],
      scale: 50000,
      heading: 30,
      tilt: 60,
    }), expect.anything());
    unbind();
  });

  test('incoming 2d bridge state is ignored by SceneView binding', async () => {
    const { view } = createScene();
    const bridge = createViewStateBridge(snapshotSceneState(view));

    const unbind = bindSceneState(view, bridge, undefined, { applyIncoming: true });
    bridge.setState({ mode: '2d', center: [31, 41], scale: 50000 });
    await flush();

    expect(view.goTo).not.toHaveBeenCalled();
    unbind();
  });

  test('buildSceneBookmark records camera and scale without external resources', () => {
    const { view } = createScene();
    view.camera.position.toJSON = () => ({ longitude: 32.85, latitude: 39.93, z: 1000 });

    expect(buildSceneBookmark(view, 'home', 'Home')).toEqual({
      id: 'home',
      title: 'Home',
      mode: '3d',
      camera: {
        position: { longitude: 32.85, latitude: 39.93, z: 1000 },
        heading: 15,
        tilt: 45,
      },
      scale: 25000,
    });
  });

  test('applySceneBookmark restores camera and scale', async () => {
    const { view } = createScene();
    const bookmark = {
      camera: { position: { longitude: 32, latitude: 39 }, heading: 10, tilt: 40 },
      scale: 12000,
    };

    await expect(applySceneBookmark(view, bookmark, {
      duration: 200,
      animate: false,
    })).resolves.toBe(true);

    expect(view.goTo).toHaveBeenCalledWith({
      camera: bookmark.camera,
      scale: 12000,
    }, {
      duration: 200,
      animate: false,
    });
  });

  test('applySceneBookmark handles SDK abort as a cancelled navigation', async () => {
    const { view } = createScene({
      goTo: jest.fn().mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
    });

    await expect(applySceneBookmark(view, { camera: {} })).resolves.toBe(false);
  });

  test('publishes explicit supported measurement contracts', () => {
    expect(createSceneMeasureContract('height')).toMatchObject({
      kind: 'height',
      supported: true,
      useArcGISMeasurement: true,
    });
    expect(createSceneMeasureContract('area')).toMatchObject({
      units: ['square-meters', 'square-kilometers'],
    });
    expect(createSceneMeasureContract('volume')).toMatchObject({
      kind: 'volume',
      supported: false,
    });
  });

  test('creates a normalized shared 2d/3d synchronization state', () => {
    expect(create2D3DSyncState({
      mode: '3d',
      center: ['32', '39'],
      scale: '25000',
    })).toMatchObject({
      mode: '3d',
      center: [32, 39],
      scale: 25000,
    });
  });
});
