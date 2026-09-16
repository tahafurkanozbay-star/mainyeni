import { loadModules } from 'esri-loader';
import {
  createViewState,
  updateCamera,
  updateSelection,
} from './viewState';
import { create3DLayer } from './layerFactory';

const moduleCache = new Map();

const load = (name) => {
  if (!moduleCache.has(name)) {
    const promise = loadModules([name])
      .then((modules) => modules[0])
      .catch((error) => {
        moduleCache.delete(name);
        throw error;
      });
    moduleCache.set(name, promise);
  }
  return moduleCache.get(name);
};

const finite = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const safeRemove = (handle) => {
  try {
    handle?.remove?.();
  } catch (_) {
    // Scene cleanup is deliberately idempotent.
  }
};

const sceneCenter = (view) => {
  const position = view?.camera?.position;
  const longitude = finite(position?.longitude);
  const latitude = finite(position?.latitude);
  if (longitude !== null && latitude !== null) return [longitude, latitude];
  const x = finite(position?.x);
  const y = finite(position?.y);
  return x !== null && y !== null ? [x, y] : null;
};

const sceneExtent = (view) => {
  const extent = view?.extent;
  if (!extent) return null;
  const xmin = finite(extent.xmin);
  const ymin = finite(extent.ymin);
  const xmax = finite(extent.xmax);
  const ymax = finite(extent.ymax);
  if ([xmin, ymin, xmax, ymax].some((value) => value === null)) return null;
  return {
    xmin,
    ymin,
    xmax,
    ymax,
    wkid: finite(extent.spatialReference?.wkid),
  };
};

const createOwnedSceneMap = async (options = {}) => {
  const Map = await load('esri/Map');
  const mapOptions = {};
  // Do not silently opt users into ArcGIS Online basemap/elevation traffic.
  // A caller must explicitly request those resources or pass an existing map.
  if (options.basemap !== undefined) mapOptions.basemap = options.basemap;
  if (options.ground !== undefined) mapOptions.ground = options.ground;
  return new Map(mapOptions);
};

export const resetSceneRuntimeModuleCache = () => {
  moduleCache.clear();
};

export const createSceneView = async (container, options = {}) => {
  const SceneView = await load('esri/views/SceneView');
  const ownsMap = !options.map;
  const map = options.map || await createOwnedSceneMap(options);
  const viewOptions = {
    container,
    map,
    ui: { components: [] },
  };

  if (options.camera !== undefined) viewOptions.camera = options.camera;
  if (options.qualityProfile !== undefined) viewOptions.qualityProfile = options.qualityProfile;
  else viewOptions.qualityProfile = 'medium';
  if (options.environment !== undefined) viewOptions.environment = options.environment;
  if (options.constraints !== undefined) viewOptions.constraints = options.constraints;
  if (options.padding !== undefined) viewOptions.padding = options.padding;

  const view = new SceneView(viewOptions);
  return { map, view, ownsMap };
};

export const destroySceneView = (scene) => {
  const view = scene?.view || scene;
  if (!view) return;
  try {
    view.container = null;
    view.destroy?.();
  } catch (_) {
    // A partially initialized SceneView should not prevent teardown.
  }
};

export const configureGround = async (view, options = {}) => {
  if (!view?.map?.ground) return view;
  if (options.opacity !== undefined) {
    const numericOpacity = Number(options.opacity);
    view.map.ground.opacity = Number.isFinite(numericOpacity)
      ? Math.max(0, Math.min(1, numericOpacity))
      : 1;
  }
  if (options.navigationConstraint) {
    view.map.ground.navigationConstraint = options.navigationConstraint;
  }
  if (options.surfaceColor !== undefined) {
    view.map.ground.surfaceColor = options.surfaceColor;
  }
  return view;
};

export const addSceneLayer = async (view, service, options = {}) => {
  if (!view?.map?.add) throw new Error('A SceneView with an attached map is required.');
  const layer = await create3DLayer(service);
  if (options.featureReduction !== undefined) layer.featureReduction = options.featureReduction;
  if (options.elevationInfo !== undefined) layer.elevationInfo = options.elevationInfo;
  view.map.add(layer, Number.isInteger(options.index) ? options.index : undefined);
  return layer;
};

export const addSceneLayers = async (view, services = [], options = {}) => {
  const input = Array.isArray(services) ? services : [];
  const concurrency = Math.max(1, Math.min(8, Math.floor(Number(options.concurrency) || 2)));
  const results = new Array(input.length);
  let nextIndex = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped) {
      if (options.signal?.aborted) {
        stopped = true;
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.length) return;
      try {
        const layer = await addSceneLayer(view, input[index], options.layerOptions?.[index] || {});
        results[index] = { status: 'fulfilled', value: layer };
      } catch (error) {
        results[index] = { status: 'rejected', reason: error };
        if (options.stopOnError === true) {
          stopped = true;
          return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, worker));
  return results.filter(Boolean);
};

const raceHitTestWithAbort = (hitPromise, signal) => {
  if (!signal) return hitPromise;
  if (signal.aborted) return Promise.resolve({ results: [] });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(resolve, { results: [] });
    signal.addEventListener('abort', onAbort, { once: true });
    hitPromise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
};

export const pickScene = async (view, screenPoint, options = {}) => {
  if (!view?.hitTest || !screenPoint) return [];
  if (options.signal?.aborted) return [];

  const hitOptions = {};
  if (Array.isArray(options.include) && options.include.length) hitOptions.include = options.include;
  if (Array.isArray(options.exclude) && options.exclude.length) hitOptions.exclude = options.exclude;

  const hitPromise = Promise.resolve(view.hitTest(screenPoint, hitOptions));
  const response = await raceHitTestWithAbort(hitPromise, options.signal);

  if (options.signal?.aborted) return [];
  return (response?.results || []).map((result) => ({
    graphic: result.graphic || null,
    layer: result.graphic?.layer || null,
    mapPoint: result.mapPoint || null,
  }));
};

export const focusPickedGraphic = async (view, graphic, options = {}) => {
  if (!graphic?.geometry || !view?.goTo || options.signal?.aborted) return false;
  const target = options.targetFactory
    ? options.targetFactory(graphic)
    : graphic.geometry;
  try {
    await view.goTo(target, {
      duration: Number.isFinite(options.duration) ? options.duration : 500,
      animate: options.animate !== false,
    });
    return !options.signal?.aborted;
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') return false;
    throw error;
  }
};

export const snapshotSceneState = (view, previous = {}) => createViewState({
  ...previous,
  mode: '3d',
  center: sceneCenter(view) ?? previous.center,
  scale: finite(view?.scale, previous.scale),
  heading: finite(view?.camera?.heading, previous.heading ?? 0),
  tilt: finite(view?.camera?.tilt, previous.tilt ?? 0),
  extent: sceneExtent(view) ?? previous.extent,
  basemapId:
    view?.map?.basemap?.id
    ?? view?.map?.basemap?.portalItem?.id
    ?? view?.map?.basemap?.title
    ?? previous.basemapId
    ?? null,
});

export const applyViewStateToSceneView = async (view, inputState = {}, options = {}) => {
  if (!view?.goTo) return false;
  const state = createViewState(inputState);
  if (state.mode !== '3d' && options.allowCrossMode !== true) return false;

  const rawCenter = Array.isArray(inputState.center) && inputState.center.length >= 2;
  const target = {};
  if (rawCenter && state.center) target.center = [...state.center];
  if (inputState.scale !== null && inputState.scale !== undefined && Number.isFinite(state.scale)) {
    target.scale = state.scale;
  }
  if (
    inputState.heading !== null && inputState.heading !== undefined &&
    Number.isFinite(state.heading)
  ) {
    target.heading = state.heading;
  }
  if (inputState.tilt !== null && inputState.tilt !== undefined && Number.isFinite(state.tilt)) {
    target.tilt = state.tilt;
  }

  if (!Object.keys(target).length && state.extent) {
    target.extent = {
      xmin: state.extent.xmin,
      ymin: state.extent.ymin,
      xmax: state.extent.xmax,
      ymax: state.extent.ymax,
      ...(state.extent.wkid ? { spatialReference: { wkid: state.extent.wkid } } : {}),
    };
  }

  if (!Object.keys(target).length) return false;

  try {
    await view.goTo(target, {
      duration: Math.max(0, finite(options.duration, 0)),
      animate: options.animate === true,
    });
    return true;
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') return false;
    throw error;
  }
};

export const bindSceneState = (view, bridge, selectionCallback, options = {}) => {
  if (!view || !bridge) return () => {};
  const handles = [];
  let disposed = false;
  let selectionController = null;
  let applyingBridgeState = false;
  let unsubscribe = () => {};

  const sync = () => {
    if (disposed || applyingBridgeState) return;
    const next = snapshotSceneState(view, bridge.getState());
    bridge.setState(next);
    options.onState?.(next);
  };

  if (typeof view.watch === 'function') {
    handles.push(view.watch('camera', sync));
    handles.push(view.watch('scale', sync));
  }

  const clickHandle = view.on?.('click', async (event) => {
    selectionController?.abort?.();
    selectionController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const signal = selectionController?.signal;
    const hits = await pickScene(view, event, {
      signal,
      include: options.include,
      exclude: options.exclude,
    });
    if (disposed || signal?.aborted) return;
    const first = hits[0];
    if (!first?.graphic) {
      bridge.setState((state) => updateSelection(state, { layerId: null, objectId: null }));
      selectionCallback?.(null, hits);
      return;
    }

    const attributes = first.graphic.attributes || {};
    const objectId = attributes.OBJECTID
      ?? attributes.ObjectID
      ?? first.graphic.uid
      ?? first.graphic.id
      ?? null;
    bridge.setState((state) => updateSelection(state, {
      layerId: first.layer?.id,
      objectId,
    }));
    selectionCallback?.(first, hits);
  });
  if (clickHandle) handles.push(clickHandle);

  if (options.applyIncoming === true && typeof bridge.subscribe === 'function') {
    unsubscribe = bridge.subscribe(async (nextState) => {
      if (disposed || nextState.mode !== '3d') return;
      const current = snapshotSceneState(view, nextState);
      if (
        current.center?.[0] === nextState.center?.[0] &&
        current.center?.[1] === nextState.center?.[1] &&
        current.scale === nextState.scale &&
        current.heading === nextState.heading &&
        current.tilt === nextState.tilt
      ) return;

      applyingBridgeState = true;
      try {
        await applyViewStateToSceneView(view, nextState, options.goToOptions || {});
      } catch (error) {
        options.onApplyError?.(error);
      } finally {
        applyingBridgeState = false;
      }
    });
  }

  return () => {
    if (disposed) return;
    disposed = true;
    selectionController?.abort?.();
    unsubscribe();
    handles.forEach(safeRemove);
  };
};

export const buildSceneBookmark = (view, id, title) => {
  const camera = view?.camera;
  return {
    id: String(id),
    title: String(title || id),
    mode: '3d',
    camera: camera
      ? {
          position: camera.position?.toJSON ? camera.position.toJSON() : camera.position,
          heading: camera.heading,
          tilt: camera.tilt,
        }
      : null,
    scale: finite(view?.scale),
  };
};

export const applySceneBookmark = async (view, bookmark, options = {}) => {
  if (!view?.goTo || !bookmark?.camera) return false;
  try {
    await view.goTo({
      camera: bookmark.camera,
      ...(Number.isFinite(bookmark.scale) ? { scale: bookmark.scale } : {}),
    }, {
      duration: Number.isFinite(options.duration) ? options.duration : 600,
      animate: options.animate !== false,
    });
    return true;
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') return false;
    throw error;
  }
};

export const createSceneMeasureContract = (kind = 'distance') => Object.freeze({
  kind,
  supported: ['distance', 'area', 'height'].includes(kind),
  useArcGISMeasurement: true,
  units: kind === 'area'
    ? ['square-meters', 'square-kilometers']
    : ['meters', 'kilometers'],
});

export const create2D3DSyncState = (initial = {}) => createViewState({
  ...initial,
  mode: initial.mode === '3d' ? '3d' : '2d',
});
