import { createLayerDescriptor, createLayerTree, flattenLayerTree, isScaleVisible, layerReducer, LAYER_STATUS, serializeLayerRuntime } from './layerRuntime';
import { createViewState, fromShareableQuery, toShareableQuery, updateCamera, updateSelection } from './viewState';
import { inferServiceType, isDisallowedServiceType, sanitizeService } from './serviceCatalog';

describe('GIS runtime regression contracts', () => {
  test('keeps nested layer tree deterministic', () => {
    const tree = createLayerTree([
      { id: 'root', title: 'Root', type: 'group' },
      { id: 'parks', title: 'Parks', parentId: 'root', visible: true, opacity: 0.75 },
      { id: 'roads', title: 'Roads', type: 'MapServer', minScale: 1000000, maxScale: 10000 },
    ]);
    expect(tree.roots).toEqual(['root', 'roads']);
    expect(tree.byId.get('root').children).toEqual(['parks']);
    expect(flattenLayerTree(tree, { includeGroups: false }).map((item) => item.node.id)).toEqual(['parks', 'roads']);
  });

  test('applies load lifecycle and serializes user layer state', () => {
    let tree = createLayerTree([{ id: 'a', visible: true }]);
    tree = layerReducer(tree, { type: 'LOAD_START', layerId: 'a', requestId: 'r1' });
    expect(tree.byId.get('a').runtime.status).toBe(LAYER_STATUS.LOADING);
    tree = layerReducer(tree, { type: 'LOAD_SUCCESS', layerId: 'a', featureCount: 0 });
    expect(tree.byId.get('a').runtime.status).toBe(LAYER_STATUS.EMPTY);
    tree = layerReducer(tree, { type: 'SET_OPACITY', layerId: 'a', opacity: 2 });
    expect(tree.byId.get('a').runtime.opacity).toBe(1);
    expect(serializeLayerRuntime(tree).layers[0].id).toBe('a');
  });

  test('uses ArcGIS scale direction correctly', () => {
    const layer = createLayerDescriptor({ id: 'x', minScale: 1000000, maxScale: 10000 });
    expect(isScaleVisible(2000000, layer)).toBe(false);
    expect(isScaleVisible(500000, layer)).toBe(true);
    expect(isScaleVisible(5000, layer)).toBe(false);
  });

  test('round trips compact shareable state', () => {
    const state = createViewState({ mode: '3d', center: [32.85, 39.92], zoom: 12, heading: 30, tilt: 45, basemapId: 'city' });
    const restored = fromShareableQuery(toShareableQuery(state));
    expect(restored.mode).toBe('3d');
    expect(restored.center).toEqual([32.85, 39.92]);
    expect(restored.zoom).toBe(12);
    expect(restored.heading).toBe(30);
    expect(restored.tilt).toBe(45);
  });

  test('keeps camera and selection state immutable', () => {
    const initial = createViewState({ mode: '2d' });
    const camera = updateCamera(initial, { heading: 90, tilt: 20 });
    const selected = updateSelection(camera, { layerId: 'parks', objectId: 42 });
    expect(initial.heading).toBe(0);
    expect(selected.heading).toBe(90);
    expect(selected.selectedObjectId).toBe(42);
  });

  test('rejects disallowed service types', () => {
    expect(isDisallowedServiceType('WMS')).toBe(true);
    expect(isDisallowedServiceType('WFS')).toBe(true);
    expect(inferServiceType({ url: 'https://example.test/arcgis/rest/services/parks/MapServer/0' })).toBe('MapServer');
    expect(() => sanitizeService({ id: 'wms', type: 'WMS', url: 'https://example.test/service' })).toThrow();
  });
});
