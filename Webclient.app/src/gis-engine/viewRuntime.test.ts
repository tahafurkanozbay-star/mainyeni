import { createViewStateBridge } from './viewState';
import {
  applyViewStateToMapView,
  bindMapViewState,
  createMapViewOptions,
  createResponsivePadding,
  createViewCoordinator,
  createViewPerformanceMonitor,
  normalizeInitialCenter,
  normalizeViewConstraints,
  snapshotMapViewState,
  viewStateApproximatelyEqual,
} from './viewRuntime';

const createWatchableView = (overrides = {}) => {
  const watchers = new Map();
  const handles = [];
  const view = {
    center: { longitude: 32.85, latitude: 39.93 },
    zoom: 11,
    scale: 100000,
    rotation: 0,
    extent: {
      xmin: 1,
      ymin: 2,
      xmax: 3,
      ymax: 4,
      spatialReference: { wkid: 4326 },
    },
    map: {
      basemap: { id: 'osm' },
      watch: jest.fn((property, callback) => {
        const handle = { remove: jest.fn() };
        watchers.set(`map:${property}`, callback);
        handles.push(handle);
        return handle;
      }),
    },
    watch: jest.fn((property, callback) => {
      const handle = { remove: jest.fn() };
      watchers.set(property, callback);
      handles.push(handle);
      return handle;
    }),
    goTo: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return {
    view,
    watchers,
    handles,
    emit: (property, value) => {
      if (property.startsWith('map:')) watchers.get(property)?.(value);
      else watchers.get(property)?.(value);
    },
  };
};

describe('viewRuntime', () => {
  test('normalizes legacy zoom constraints into a bounded ArcGIS range', () => {
    expect(normalizeViewConstraints({ minZoom: -5, maxZoom: 221 })).toEqual({
      minZoom: 0,
      maxZoom: 24,
      rotationEnabled: false,
      snapToZoom: false,
    });
  });

  test('keeps maxZoom strictly greater than minZoom', () => {
    expect(normalizeViewConstraints({ minZoom: 20, maxZoom: 2 })).toMatchObject({
      minZoom: 20,
      maxZoom: 21,
    });
  });

  test('reads rotation and snap flags only when explicitly enabled', () => {
    expect(normalizeViewConstraints({ RotationEnabled: true, SnapToZoom: true })).toMatchObject({
      rotationEnabled: true,
      snapToZoom: true,
    });
    expect(normalizeViewConstraints({ RotationEnabled: 'true', SnapToZoom: 1 })).toMatchObject({
      rotationEnabled: false,
      snapToZoom: false,
    });
  });

  test('normalizes initial center from the existing map configuration contract', () => {
    expect(normalizeInitialCenter({ Centerx: '32.85', Centery: 39.93 })).toEqual([32.85, 39.93]);
    expect(normalizeInitialCenter({ center: [31, 40] })).toEqual([31, 40]);
    expect(normalizeInitialCenter({ center: ['x', 40] })).toEqual([34, 39]);
  });

  test('uses mobile bottom padding without desktop sidebar offset', () => {
    expect(createResponsivePadding(480)).toEqual({
      top: 0,
      bottom: 200,
      left: 0,
      right: 0,
    });
  });

  test('uses desktop sidebar padding above the mobile breakpoint', () => {
    expect(createResponsivePadding(1024)).toEqual({
      top: 0,
      bottom: 0,
      left: 400,
      right: 0,
    });
  });

  test('supports explicit responsive padding configuration', () => {
    expect(createResponsivePadding(700, {
      mobileBreakpoint: 800,
      sidebarWidth: 300,
      mobileBottom: 160,
    })).toEqual({
      top: 0,
      bottom: 160,
      left: 0,
      right: 0,
    });
  });

  test('builds MapView options from the existing repository configuration', () => {
    const map = { id: 'map' };
    const container = { id: 'map-div' };
    const options = createMapViewOptions({
      map,
      container,
      viewportWidth: 1280,
      configuration: {
        Centerx: 32.85,
        Centery: 39.93,
        Zoom: 12,
        MinZoom: 2,
        MaxZoom: 20,
      },
    });

    expect(options).toMatchObject({
      map,
      container,
      zoom: 12,
      center: [32.85, 39.93],
      padding: { top: 0, bottom: 0, left: 400, right: 0 },
      constraints: {
        minZoom: 2,
        maxZoom: 20,
        rotationEnabled: false,
      },
    });
  });

  test('snapshots geographic MapView state into the shared contract', () => {
    const { view } = createWatchableView();

    expect(snapshotMapViewState(view)).toMatchObject({
      mode: '2d',
      center: [32.85, 39.93],
      zoom: 11,
      scale: 100000,
      heading: 0,
      tilt: 0,
      extent: {
        xmin: 1,
        ymin: 2,
        xmax: 3,
        ymax: 4,
        wkid: 4326,
      },
      basemapId: 'osm',
    });
  });

  test('falls back to projected center x/y when longitude/latitude are unavailable', () => {
    const { view } = createWatchableView({
      center: { x: 100, y: 200 },
    });

    expect(snapshotMapViewState(view).center).toEqual([100, 200]);
  });

  test('preserves previous state when the view has temporarily unavailable geometry', () => {
    const { view } = createWatchableView({
      center: null,
      extent: null,
      zoom: undefined,
      scale: undefined,
    });

    const state = snapshotMapViewState(view, {
      center: [30, 40],
      extent: { xmin: 1, ymin: 1, xmax: 2, ymax: 2, wkid: 4326 },
      zoom: 9,
      scale: 250000,
    });

    expect(state).toMatchObject({
      center: [30, 40],
      zoom: 9,
      scale: 250000,
    });
  });

  test('compares noisy map state with configurable numeric tolerance', () => {
    expect(viewStateApproximatelyEqual(
      { mode: '2d', center: [32.8500001, 39.9300001], zoom: 11.0001, scale: 100000.5 },
      { mode: '2d', center: [32.85, 39.93], zoom: 11, scale: 100000 },
    )).toBe(true);

    expect(viewStateApproximatelyEqual(
      { mode: '2d', center: [32.9, 39.93], zoom: 11 },
      { mode: '2d', center: [32.85, 39.93], zoom: 11 },
    )).toBe(false);
  });

  test('applies center zoom and heading through one MapView goTo', async () => {
    const { view } = createWatchableView();

    await expect(applyViewStateToMapView(view, {
      mode: '2d',
      center: [33, 40],
      zoom: 14,
      heading: 12,
    }, { duration: 120, animate: true })).resolves.toBe(true);

    expect(view.goTo).toHaveBeenCalledWith({
      center: [33, 40],
      zoom: 14,
      rotation: 12,
    }, {
      duration: 120,
      animate: true,
    });
  });

  test('uses scale when no zoom is available', async () => {
    const { view } = createWatchableView();

    await applyViewStateToMapView(view, {
      mode: '2d',
      center: [33, 40],
      scale: 25000,
      heading: 0,
    });

    expect(view.goTo).toHaveBeenCalledWith(expect.objectContaining({
      scale: 25000,
    }), expect.anything());
  });

  test('uses an extent-only target when camera values are absent', async () => {
    const { view } = createWatchableView();

    await applyViewStateToMapView(view, {
      mode: '2d',
      extent: { xmin: 1, ymin: 2, xmax: 3, ymax: 4, wkid: 3857 },
      heading: null,
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

  test('does not apply a 3d state to a 2d view unless explicitly allowed', async () => {
    const { view } = createWatchableView();

    await expect(applyViewStateToMapView(view, {
      mode: '3d',
      center: [33, 40],
      zoom: 12,
    })).resolves.toBe(false);
    expect(view.goTo).not.toHaveBeenCalled();
  });

  test('bindMapViewState coalesces multiple SDK watches into one bridge update per frame', () => {
    const { view, emit } = createWatchableView();
    const bridge = createViewStateBridge({ mode: '2d' });
    const scheduled = [];
    const scheduleFrame = jest.fn((callback) => {
      scheduled.push(callback);
      return jest.fn();
    });
    const listener = jest.fn();
    bridge.subscribe(listener);

    const unbind = bindMapViewState(view, bridge, {
      scheduleFrame,
      publishInitial: false,
    });

    view.center = { longitude: 33, latitude: 40 };
    emit('center', view.center);
    view.zoom = 12;
    emit('zoom', 12);
    view.scale = 50000;
    emit('scale', 50000);

    expect(scheduleFrame).toHaveBeenCalledTimes(1);
    scheduled[0]();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge.getState()).toMatchObject({
      center: [33, 40],
      zoom: 12,
      scale: 50000,
    });

    unbind();
  });

  test('publishes the initial MapView snapshot by default', () => {
    const { view } = createWatchableView();
    const bridge = createViewStateBridge();
    const scheduled = [];
    const listener = jest.fn();
    bridge.subscribe(listener);

    bindMapViewState(view, bridge, {
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return jest.fn();
      },
    });

    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge.getState().center).toEqual([32.85, 39.93]);
  });

  test('does not republish state when SDK noise stays inside tolerance', () => {
    const { view, emit } = createWatchableView();
    const bridge = createViewStateBridge(snapshotMapViewState(view));
    const scheduled = [];
    const listener = jest.fn();
    bridge.subscribe(listener);

    bindMapViewState(view, bridge, {
      publishInitial: false,
      scheduleFrame: (callback) => {
        scheduled.push(callback);
        return jest.fn();
      },
    });

    view.center = { longitude: 32.85000001, latitude: 39.93000001 };
    emit('center', view.center);
    scheduled[0]();

    expect(listener).not.toHaveBeenCalled();
  });

  test('optionally applies incoming bridge state to MapView', async () => {
    const { view } = createWatchableView();
    const bridge = createViewStateBridge(snapshotMapViewState(view));
    const errors = [];

    const unbind = bindMapViewState(view, bridge, {
      publishInitial: false,
      applyIncoming: true,
      onApplyError: (error) => errors.push(error),
    });

    bridge.setState({
      mode: '2d',
      center: [31, 41],
      zoom: 13,
      scale: null,
      heading: 0,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(view.goTo).toHaveBeenCalledWith(expect.objectContaining({
      center: [31, 41],
      zoom: 13,
    }), expect.anything());
    expect(errors).toEqual([]);
    unbind();
  });

  test('ignores incoming 3d state in a MapView binding', async () => {
    const { view } = createWatchableView();
    const bridge = createViewStateBridge(snapshotMapViewState(view));

    const unbind = bindMapViewState(view, bridge, {
      publishInitial: false,
      applyIncoming: true,
    });
    bridge.setState({ mode: '3d', center: [31, 41], zoom: 13 });
    await Promise.resolve();

    expect(view.goTo).not.toHaveBeenCalled();
    unbind();
  });

  test('unbind removes all ArcGIS and basemap watch handles', () => {
    const { view, handles } = createWatchableView();
    const bridge = createViewStateBridge();

    const unbind = bindMapViewState(view, bridge, { publishInitial: false });
    expect(handles.length).toBe(6);
    unbind();
    unbind();

    handles.forEach((handle) => expect(handle.remove).toHaveBeenCalledTimes(1));
  });

  test('unbind cancels a scheduled but unpublished frame', () => {
    const { view, emit } = createWatchableView();
    const bridge = createViewStateBridge();
    const cancel = jest.fn();
    const scheduleFrame = jest.fn(() => cancel);

    const unbind = bindMapViewState(view, bridge, {
      scheduleFrame,
      publishInitial: false,
    });
    emit('zoom', 12);
    unbind();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('performance monitor measures completed update cycles', () => {
    const { view, emit, handles } = createWatchableView();
    let clock = 100;
    const monitor = createViewPerformanceMonitor(view, {
      now: () => clock,
      slowThresholdMs: 50,
    });

    emit('updating', true);
    clock = 140;
    emit('updating', false);
    clock = 200;
    emit('updating', true);
    clock = 280;
    emit('updating', false);
    emit('scale', 25000);
    emit('zoom', 14);

    expect(monitor.snapshot()).toEqual({
      updateCycles: 2,
      completedCycles: 2,
      slowCycles: 1,
      totalUpdatingMs: 120,
      longestUpdatingMs: 80,
      averageUpdatingMs: 60,
      active: false,
      lastScale: 25000,
      lastZoom: 14,
    });

    monitor.dispose();
    handles.slice(-3).forEach((handle) => expect(handle.remove).toHaveBeenCalledTimes(1));
  });

  test('performance monitor ignores duplicate updating=true transitions', () => {
    const { view, emit } = createWatchableView();
    let clock = 0;
    const monitor = createViewPerformanceMonitor(view, { now: () => clock });

    emit('updating', true);
    clock = 10;
    emit('updating', true);
    clock = 20;
    emit('updating', false);

    expect(monitor.snapshot()).toMatchObject({
      updateCycles: 1,
      completedCycles: 1,
      totalUpdatingMs: 20,
    });
  });

  test('coordinator switches modes through the shared bridge and applies target state', async () => {
    const bridge = createViewStateBridge({ mode: '2d', center: [32, 39], zoom: 10 });
    const coordinator = createViewCoordinator(bridge);
    const sceneView = { id: 'scene' };
    const applyState = jest.fn().mockResolvedValue(true);

    coordinator.register('3d', { view: sceneView, applyState });
    await expect(coordinator.switchTo('3d', { duration: 0 })).resolves.toBe(true);

    expect(bridge.getState().mode).toBe('3d');
    expect(coordinator.getActiveMode()).toBe('3d');
    expect(coordinator.getView('3d')).toBe(sceneView);
    expect(applyState).toHaveBeenCalledWith(
      sceneView,
      expect.objectContaining({ mode: '3d', center: [32, 39], zoom: 10 }),
      { duration: 0 },
    );
  });

  test('coordinator allows a mode without a registered target view', async () => {
    const bridge = createViewStateBridge({ mode: '3d' });
    const coordinator = createViewCoordinator(bridge);

    await expect(coordinator.switchTo('2d')).resolves.toBe(true);
    expect(bridge.getState().mode).toBe('2d');
  });

  test('coordinator reports apply failures without throwing mode state away', async () => {
    const bridge = createViewStateBridge({ mode: '2d' });
    const onError = jest.fn();
    const coordinator = createViewCoordinator(bridge, { onError });
    coordinator.register('3d', {
      view: {},
      applyState: jest.fn().mockRejectedValue(new Error('goTo failed')),
    });

    await expect(coordinator.switchTo('3d')).resolves.toBe(false);
    expect(bridge.getState().mode).toBe('3d');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), '3d');
  });

  test('coordinator publishCamera writes mode and camera atomically', () => {
    const bridge = createViewStateBridge({ mode: '2d' });
    const coordinator = createViewCoordinator(bridge);

    coordinator.publishCamera('3d', {
      center: [33, 40],
      scale: 20000,
      heading: 30,
      tilt: 45,
    });

    expect(bridge.getState()).toMatchObject({
      mode: '3d',
      center: [33, 40],
      scale: 20000,
      heading: 30,
      tilt: 45,
    });
  });

  test('registering a replacement view unbinds the previous registration', () => {
    const bridge = createViewStateBridge();
    const coordinator = createViewCoordinator(bridge);
    const firstUnbind = jest.fn();
    const secondUnbind = jest.fn();

    coordinator.register('2d', { view: { id: 1 }, unbind: firstUnbind });
    coordinator.register('2d', { view: { id: 2 }, unbind: secondUnbind });

    expect(firstUnbind).toHaveBeenCalledTimes(1);
    expect(coordinator.getView('2d')).toEqual({ id: 2 });
    expect(secondUnbind).not.toHaveBeenCalled();
  });

  test('destroy disposes every registered view binding', () => {
    const bridge = createViewStateBridge();
    const coordinator = createViewCoordinator(bridge);
    const unbind2d = jest.fn();
    const unbind3d = jest.fn();
    coordinator.register('2d', { view: {}, unbind: unbind2d });
    coordinator.register('3d', { view: {}, unbind: unbind3d });

    coordinator.destroy();
    coordinator.destroy();

    expect(unbind2d).toHaveBeenCalledTimes(1);
    expect(unbind3d).toHaveBeenCalledTimes(1);
    expect(coordinator.getView('2d')).toBeNull();
    expect(coordinator.getView('3d')).toBeNull();
  });
});
