import {
  LAYER_STATUS,
  createLayerTree,
  flattenLayerTree,
  hydrateLayerRuntime,
  isScaleVisible,
  layerReducer,
  serializeLayerRuntime,
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

  test('treats malformed legacy scale ranges as unrestricted', () => {
    const tree = createLayerTree([
      { id: 'legacy', minScale: 1000, maxScale: 5000 },
    ]);

    expect(isScaleVisible(500000, tree.byId.get('legacy'))).toBe(true);
    expect(isScaleVisible(100, tree.byId.get('legacy'))).toBe(true);
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

  test('ignores duplicate layer ids after the first descriptor', () => {
    const tree = createLayerTree([
      { id: 'parks', title: 'First' },
      { id: 'parks', title: 'Second' },
    ]);

    expect(tree.byId.size).toBe(1);
    expect(tree.byId.get('parks').title).toBe('First');
  });

  test('LOAD_START records request id and clears previous error', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    tree = layerReducer(tree, {
      type: 'LOAD_ERROR',
      layerId: 'parks',
      error: new Error('previous'),
    });
    tree = layerReducer(tree, {
      type: 'LOAD_START',
      layerId: 'parks',
      requestId: 'request-1',
    });

    expect(tree.byId.get('parks').runtime).toMatchObject({
      status: LAYER_STATUS.LOADING,
      requestId: 'request-1',
      error: null,
    });
  });

  test('matching LOAD_SUCCESS clears request id and stores count/time', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    tree = layerReducer(tree, {
      type: 'LOAD_START', layerId: 'parks', requestId: 'request-1',
    });
    tree = layerReducer(tree, {
      type: 'LOAD_SUCCESS',
      layerId: 'parks',
      requestId: 'request-1',
      featureCount: 12,
      loadedAt: '2026-09-16T05:00:00.000Z',
    });

    expect(tree.byId.get('parks').runtime).toMatchObject({
      status: LAYER_STATUS.READY,
      featureCount: 12,
      lastLoadedAt: '2026-09-16T05:00:00.000Z',
      requestId: null,
      error: null,
    });
  });

  test('zero feature success becomes EMPTY rather than READY', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    tree = layerReducer(tree, {
      type: 'LOAD_START', layerId: 'parks', requestId: 'request-1',
    });
    tree = layerReducer(tree, {
      type: 'LOAD_SUCCESS',
      layerId: 'parks',
      requestId: 'request-1',
      featureCount: 0,
    });

    expect(tree.byId.get('parks').runtime.status).toBe(LAYER_STATUS.EMPTY);
  });

  test('stale LOAD_SUCCESS cannot overwrite a newer active request', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    tree = layerReducer(tree, {
      type: 'LOAD_START', layerId: 'parks', requestId: 'old-request',
    });
    tree = layerReducer(tree, {
      type: 'LOAD_START', layerId: 'parks', requestId: 'new-request',
    });
    tree = layerReducer(tree, {
      type: 'LOAD_SUCCESS',
      layerId: 'parks',
      requestId: 'old-request',
      featureCount: 999,
    });

    expect(tree.byId.get('parks').runtime).toMatchObject({
      status: LAYER_STATUS.LOADING,
      requestId: 'new-request',
      featureCount: null,
    });
  });

  test('stale LOAD_ERROR cannot overwrite a newer successful request', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    tree = layerReducer(tree, {
      type: 'LOAD_START', layerId: 'parks', requestId: 'new-request',
    });
    tree = layerReducer(tree, {
      type: 'LOAD_ERROR',
      layerId: 'parks',
      requestId: 'old-request',
      error: new Error('stale failure'),
    });

    expect(tree.byId.get('parks').runtime).toMatchObject({
      status: LAYER_STATUS.LOADING,
      requestId: 'new-request',
      error: null,
    });
  });

  test('LOAD_CANCEL returns only the matching active request to idle', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    tree = layerReducer(tree, {
      type: 'LOAD_START', layerId: 'parks', requestId: 'request-1',
    });
    tree = layerReducer(tree, {
      type: 'LOAD_CANCEL', layerId: 'parks', requestId: 'request-1',
    });

    expect(tree.byId.get('parks').runtime).toMatchObject({
      status: LAYER_STATUS.IDLE,
      requestId: null,
      error: null,
    });
  });

  test('stale LOAD_CANCEL cannot cancel a newer request', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    tree = layerReducer(tree, {
      type: 'LOAD_START', layerId: 'parks', requestId: 'request-2',
    });
    tree = layerReducer(tree, {
      type: 'LOAD_CANCEL', layerId: 'parks', requestId: 'request-1',
    });

    expect(tree.byId.get('parks').runtime).toMatchObject({
      status: LAYER_STATUS.LOADING,
      requestId: 'request-2',
    });
  });

  test('stale SET_SDK_LAYER cannot replace a newer request layer', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    tree = layerReducer(tree, {
      type: 'LOAD_START', layerId: 'parks', requestId: 'new-request',
    });
    tree = layerReducer(tree, {
      type: 'SET_SDK_LAYER',
      layerId: 'parks',
      requestId: 'old-request',
      sdkLayer: { id: 'stale-sdk' },
    });

    expect(tree.byId.get('parks').sdkLayer).toBeNull();
  });

  test('matching SET_SDK_LAYER stores SDK layer while request is active', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    const sdkLayer = { id: 'parks-sdk' };
    tree = layerReducer(tree, {
      type: 'LOAD_START', layerId: 'parks', requestId: 'request-1',
    });
    tree = layerReducer(tree, {
      type: 'SET_SDK_LAYER',
      layerId: 'parks',
      requestId: 'request-1',
      sdkLayer,
    });

    expect(tree.byId.get('parks').sdkLayer).toBe(sdkLayer);
    expect(tree.byId.get('parks').runtime.requestId).toBe('request-1');
  });

  test('SET_DISABLED clears an active request id when disabling', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    tree = layerReducer(tree, {
      type: 'LOAD_START', layerId: 'parks', requestId: 'request-1',
    });
    tree = layerReducer(tree, {
      type: 'SET_DISABLED', layerId: 'parks', disabled: true,
    });

    expect(tree.byId.get('parks').runtime).toMatchObject({
      status: LAYER_STATUS.DISABLED,
      requestId: null,
    });
  });

  test('normalizes visibility opacity and scale changes', () => {
    let tree = createLayerTree([{ id: 'parks' }]);
    tree = layerReducer(tree, { type: 'SET_VISIBLE', layerId: 'parks', visible: 0 });
    tree = layerReducer(tree, { type: 'SET_OPACITY', layerId: 'parks', opacity: 7 });
    tree = layerReducer(tree, {
      type: 'SET_SCALE_RANGE', layerId: 'parks', minScale: -1, maxScale: '5000',
    });

    expect(tree.byId.get('parks').runtime).toMatchObject({
      visible: false,
      opacity: 1,
      minScale: 0,
      maxScale: 5000,
    });
  });

  test('unknown layer actions return the original tree', () => {
    const tree = createLayerTree([{ id: 'parks' }]);
    expect(layerReducer(tree, { type: 'SET_VISIBLE', layerId: 'unknown', visible: false })).toBe(tree);
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

  test('hydrate ignores unknown ids and malformed snapshot rows', () => {
    const tree = createLayerTree([{ id: 'parks' }]);
    const hydrated = hydrateLayerRuntime(tree, {
      layers: [null, { id: 'unknown', visible: false }],
    });

    expect(hydrated.byId.get('parks').runtime.visible).toBe(true);
  });

  test('serialize emits stable runtime fields without SDK layer objects', () => {
    let tree = createLayerTree([{ id: 'parks', opacity: 0.33333 }]);
    tree = layerReducer(tree, {
      type: 'SET_SDK_LAYER', layerId: 'parks', sdkLayer: { huge: true },
    });

    expect(serializeLayerRuntime(tree)).toEqual({
      layers: [{
        id: 'parks',
        visible: true,
        opacity: 0.333,
        minScale: 0,
        maxScale: 0,
        status: LAYER_STATUS.IDLE,
      }],
    });
  });
});
