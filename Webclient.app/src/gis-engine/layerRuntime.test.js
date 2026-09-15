import {
  LAYER_STATUS,
  createLayerTree,
  flattenLayerTree,
  hydrateLayerRuntime,
  isScaleVisible,
  layerReducer,
  visibleLayersAtScale,
} from './layerRuntime';

describe('layerRuntime', () => {
  test('uses ArcGIS scale denominator semantics', () => {
    const tree = createLayerTree([
      { id: 'roads', minScale: 500000, maxScale: 10000 },
    ]);
    const roads = tree.byId.get('roads');

    expect(isScaleVisible(600000, roads)).toBe(false);
    expect(isScaleVisible(250000, roads)).toBe(true);
    expect(isScaleVisible(5000, roads)).toBe(false);
  });

  test('hidden and disabled parent groups suppress child operational layers', () => {
    let tree = createLayerTree([
      { id: 'transport', children: ['roads'] },
      { id: 'roads', minScale: 500000, maxScale: 10000 },
    ]);

    expect(visibleLayersAtScale(tree, 100000).map((layer) => layer.id)).toEqual(['roads']);

    tree = layerReducer(tree, { type: 'SET_VISIBLE', layerId: 'transport', visible: false });
    expect(visibleLayersAtScale(tree, 100000)).toEqual([]);

    tree = layerReducer(tree, { type: 'SET_VISIBLE', layerId: 'transport', visible: true });
    tree = layerReducer(tree, { type: 'SET_DISABLED', layerId: 'transport', disabled: true });
    expect(tree.byId.get('transport').runtime.status).toBe(LAYER_STATUS.DISABLED);
    expect(visibleLayersAtScale(tree, 100000)).toEqual([]);
  });

  test('deduplicates parent-child links and survives cyclic configuration', () => {
    const tree = createLayerTree([
      { id: 'a', parentId: 'b', children: ['b', 'b'] },
      { id: 'b', parentId: 'a', children: ['a'] },
    ]);

    expect(tree.byId.get('a').children).toEqual(['b']);
    expect(tree.byId.get('b').children).toEqual(['a']);
    expect(flattenLayerTree(tree).map(({ node }) => node.id).sort()).toEqual(['a', 'b']);
  });

  test('hydrates visibility, opacity and persisted scale limits', () => {
    const tree = createLayerTree([{ id: 'parks' }]);
    const hydrated = hydrateLayerRuntime(tree, {
      layers: [{ id: 'parks', visible: false, opacity: 0.35, minScale: 250000, maxScale: 5000 }],
    });
    const parks = hydrated.byId.get('parks');

    expect(parks.runtime).toMatchObject({
      visible: false,
      opacity: 0.35,
      minScale: 250000,
      maxScale: 5000,
    });
  });
});
