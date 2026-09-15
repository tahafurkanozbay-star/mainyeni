import {
  bindSceneState,
  configureGround,
  createSceneMeasureContract,
} from './sceneRuntime';

jest.mock('esri-loader', () => ({
  loadModules: jest.fn(),
}));

jest.mock('./layerFactory', () => ({
  create3DLayer: jest.fn(),
}));

describe('sceneRuntime', () => {
  test('allows fully transparent ground and clamps invalid opacity', async () => {
    const view = { map: { ground: { opacity: 1 } } };

    await configureGround(view, { opacity: 0 });
    expect(view.map.ground.opacity).toBe(0);

    await configureGround(view, { opacity: 2 });
    expect(view.map.ground.opacity).toBe(1);

    await configureGround(view, { opacity: -1 });
    expect(view.map.ground.opacity).toBe(0);
  });

  test('removes scene handles and ignores async hit results after teardown', async () => {
    let clickHandler;
    let resolveHit;
    const watchHandle = { remove: jest.fn() };
    const clickHandle = { remove: jest.fn() };
    const view = {
      camera: { position: { longitude: 32.8, latitude: 39.9 }, heading: 0, tilt: 45 },
      scale: 10000,
      watch: jest.fn(() => watchHandle),
      on: jest.fn((eventName, handler) => {
        if (eventName === 'click') clickHandler = handler;
        return clickHandle;
      }),
      hitTest: jest.fn(() => new Promise((resolve) => { resolveHit = resolve; })),
    };
    const bridge = {
      getState: jest.fn(() => ({ mode: '3d' })),
      setState: jest.fn(),
    };
    const selectionCallback = jest.fn();

    const unbind = bindSceneState(view, bridge, selectionCallback);
    const pendingClick = clickHandler({ x: 1, y: 1 });
    unbind();
    resolveHit({ results: [{ graphic: { attributes: { OBJECTID: 9 } } }] });
    await pendingClick;

    expect(watchHandle.remove).toHaveBeenCalledTimes(1);
    expect(clickHandle.remove).toHaveBeenCalledTimes(1);
    expect(bridge.setState).not.toHaveBeenCalled();
    expect(selectionCallback).not.toHaveBeenCalled();
  });

  test('publishes explicit supported measurement contracts', () => {
    expect(createSceneMeasureContract('height')).toMatchObject({
      kind: 'height',
      supported: true,
      useArcGISMeasurement: true,
    });
    expect(createSceneMeasureContract('volume')).toMatchObject({
      kind: 'volume',
      supported: false,
    });
  });
});
