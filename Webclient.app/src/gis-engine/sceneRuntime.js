import { loadModules } from 'esri-loader';
import { createViewState, updateCamera, updateSelection } from './viewState';
import { create3DLayer } from './layerFactory';

const moduleCache = new Map();
const load = (name) => {
  if (!moduleCache.has(name)) moduleCache.set(name, loadModules([name]).then((modules) => modules[0]));
  return moduleCache.get(name);
};

export const createSceneView = async (container, options = {}) => {
  const [Map, SceneView] = await Promise.all([load('esri/Map'), load('esri/views/SceneView')]);
  const mapOptions = {};
  if (options.basemap) mapOptions.basemap = options.basemap;
  if (options.ground) mapOptions.ground = options.ground;
  const map = new Map(mapOptions);
  const view = new SceneView({ container, map, camera: options.camera, qualityProfile: options.qualityProfile || 'medium', environment: options.environment, ui: { components: [] } });
  return { map, view };
};

export const configureGround = async (view, options = {}) => {
  if (!view?.map?.ground) return view;
  if (options.opacity !== undefined) view.map.ground.opacity = Math.max(0, Math.min(1, Number(options.opacity) || 1));
  if (options.navigationConstraint) view.map.ground.navigationConstraint = options.navigationConstraint;
  return view;
};

export const addSceneLayer = async (view, service, options = {}) => {
  const layer = await create3DLayer(service);
  if (options.featureReduction) layer.featureReduction = options.featureReduction;
  view?.map?.add(layer);
  return layer;
};

export const pickScene = async (view, screenPoint) => {
  if (!view?.hitTest || !screenPoint) return [];
  const response = await view.hitTest(screenPoint);
  return (response?.results || []).map((result) => ({ graphic: result.graphic || null, layer: result.graphic?.layer || null, mapPoint: result.mapPoint || null }));
};

export const focusPickedGraphic = async (view, graphic, options = {}) => {
  if (!graphic?.geometry || !view?.goTo) return false;
  await view.goTo(graphic.geometry, { duration: Number.isFinite(options.duration) ? options.duration : 500 });
  return true;
};

export const bindSceneState = (view, bridge, selectionCallback) => {
  if (!view || !bridge) return () => {};
  const handles = [];
  const sync = () => {
    const camera = view.camera;
    const next = updateCamera(bridge.getState(), { center: camera?.position ? [camera.position.longitude, camera.position.latitude] : undefined, heading: camera?.heading, tilt: camera?.tilt, scale: view.scale });
    bridge.setState({ ...next, mode: '3d' });
  };
  if (typeof view.watch === 'function') handles.push(view.watch('camera', sync));
  const clickHandle = view.on?.('click', async (event) => {
    const hits = await pickScene(view, event.screenPoint || event);
    const first = hits[0];
    if (!first?.graphic) {
      bridge.setState((state) => updateSelection(state, { layerId: null, objectId: null }));
      selectionCallback?.(null, hits);
      return;
    }
    const objectId = first.graphic.attributes?.OBJECTID ?? first.graphic.attributes?.ObjectID ?? first.graphic.uid ?? first.graphic.id ?? null;
    bridge.setState((state) => updateSelection(state, { layerId: first.layer?.id, objectId }));
    selectionCallback?.(first, hits);
  });
  if (clickHandle) handles.push(clickHandle);
  return () => handles.forEach((handle) => handle?.remove?.());
};

export const buildSceneBookmark = (view, id, title) => {
  const camera = view?.camera;
  return { id: String(id), title: String(title || id), mode: '3d', camera: camera ? { position: camera.position?.toJSON ? camera.position.toJSON() : camera.position, heading: camera.heading, tilt: camera.tilt } : null };
};

export const applySceneBookmark = async (view, bookmark) => {
  if (!view?.goTo || !bookmark?.camera) return false;
  await view.goTo({ camera: bookmark.camera }, { duration: 600 });
  return true;
};

export const createSceneMeasureContract = (kind = 'distance') => Object.freeze({ kind, supported: ['distance', 'area', 'height'].includes(kind), useArcGISMeasurement: true, units: kind === 'area' ? ['square-meters', 'square-kilometers'] : ['meters', 'kilometers'] });

export const create2D3DSyncState = (initial = {}) => createViewState({ ...initial, mode: initial.mode === '3d' ? '3d' : '2d' });
