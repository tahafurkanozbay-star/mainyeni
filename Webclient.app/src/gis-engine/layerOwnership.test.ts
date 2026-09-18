import {
  addOwnedLayer,
  createDisposableBag,
  createLayerOwner,
  getLayerOwnershipStats,
  hasOwnedLayer,
  listOwnedLayers,
  pruneLayerOwnership,
  registerOwnedLayer,
  removeOwnedLayer,
  removeOwnedLayers,
  replaceOwnedLayers,
  transferOwnedLayer,
} from './layerOwnership';

const createMap = () => {
  const layers = [];
  return {
    layers,
    allLayers: { items: layers },
    add: jest.fn((layer, index) => {
      if (Number.isInteger(index)) layers.splice(index, 0, layer);
      else layers.push(layer);
    }),
    remove: jest.fn((layer) => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
    }),
  };
};

describe('layerOwnership', () => {
  test('removes only layers owned by the requesting consumer', () => {
    const map = createMap();
    const basemapOperational = { id: 'base-boundary' };
    const layerListA = { id: 'roads' };
    const layerListB = { id: 'parks' };
    const queryLayer = { id: 'park-query' };

    map.add(basemapOperational);
    addOwnedLayer(map, 'layer-list', layerListA);
    addOwnedLayer(map, 'layer-list', layerListB);
    addOwnedLayer(map, 'park-query', queryLayer);

    expect(removeOwnedLayers(map, 'layer-list')).toBe(2);
    expect(map.layers).toEqual([basemapOperational, queryLayer]);
    expect(hasOwnedLayer(map, 'park-query', queryLayer)).toBe(true);
  });

  test('registers externally-added layers without adding them twice', () => {
    const map = createMap();
    const layer = { id: 'external' };
    map.add(layer);

    registerOwnedLayer(map, 'consumer', layer);

    expect(map.add).toHaveBeenCalledTimes(1);
    expect(listOwnedLayers(map, 'consumer')).toEqual([layer]);
  });

  test('supports indexed additions while tracking ownership', () => {
    const map = createMap();
    const first = { id: 'first' };
    const second = { id: 'second' };
    const inserted = { id: 'inserted' };
    map.add(first);
    map.add(second);

    addOwnedLayer(map, 'widget', inserted, 1);

    expect(map.layers).toEqual([first, inserted, second]);
    expect(listOwnedLayers(map, 'widget')).toEqual([inserted]);
  });

  test('replaceOwnedLayers clears prior owned layers but preserves unrelated layers', () => {
    const map = createMap();
    const unrelated = { id: 'unrelated' };
    const oldLayer = { id: 'old' };
    const nextA = { id: 'next-a' };
    const nextB = { id: 'next-b' };
    map.add(unrelated);
    addOwnedLayer(map, 'owner', oldLayer);

    const added = replaceOwnedLayers(map, 'owner', [nextA, { layer: nextB, index: 0 }]);

    expect(added).toEqual([nextA, nextB]);
    expect(map.layers).toContain(unrelated);
    expect(map.layers).not.toContain(oldLayer);
    expect(map.layers).toContain(nextA);
    expect(map.layers).toContain(nextB);
  });

  test('removing one owned layer also removes it from the ownership registry', () => {
    const map = createMap();
    const layer = { id: 'layer' };
    addOwnedLayer(map, 'owner', layer);

    expect(removeOwnedLayer(map, 'owner', layer)).toBe(true);
    expect(listOwnedLayers(map, 'owner')).toEqual([]);
    expect(map.layers).toEqual([]);
  });

  test('transfers ownership without touching the map', () => {
    const map = createMap();
    const layer = { id: 'shared' };
    addOwnedLayer(map, 'first-owner', layer);
    const addCallsBeforeTransfer = map.add.mock.calls.length;
    const removeCallsBeforeTransfer = map.remove.mock.calls.length;

    expect(transferOwnedLayer(map, 'first-owner', 'second-owner', layer)).toBe(true);
    expect(hasOwnedLayer(map, 'first-owner', layer)).toBe(false);
    expect(hasOwnedLayer(map, 'second-owner', layer)).toBe(true);
    expect(map.add).toHaveBeenCalledTimes(addCallsBeforeTransfer);
    expect(map.remove).toHaveBeenCalledTimes(removeCallsBeforeTransfer);
  });

  test('reports ownership statistics by owner', () => {
    const map = createMap();
    addOwnedLayer(map, 'a', { id: '1' });
    addOwnedLayer(map, 'a', { id: '2' });
    addOwnedLayer(map, 'b', { id: '3' });

    expect(getLayerOwnershipStats(map)).toEqual({
      owners: 2,
      layers: 3,
      byOwner: { a: 2, b: 1 },
    });
  });

  test('prunes registry entries for layers removed by another subsystem', () => {
    const map = createMap();
    const alive = { id: 'alive' };
    const stale = { id: 'stale' };
    addOwnedLayer(map, 'owner', alive);
    addOwnedLayer(map, 'owner', stale);
    map.remove(stale);

    expect(pruneLayerOwnership(map)).toBe(1);
    expect(listOwnedLayers(map, 'owner')).toEqual([alive]);
  });

  test('createLayerOwner exposes a scoped facade', () => {
    const map = createMap();
    const owner = createLayerOwner({ map }, 'query-window');
    const layer = { id: 'result' };

    owner.add(layer);
    expect(owner.has(layer)).toBe(true);
    expect(owner.list()).toEqual([layer]);
    expect(owner.stats().byOwner['query-window']).toBe(1);
    expect(owner.clear()).toBe(1);
    expect(map.layers).toEqual([]);
  });

  test('disposable bag removes handles, functions, abort controllers and widgets', () => {
    const bag = createDisposableBag();
    const handle = { remove: jest.fn() };
    const widget = { destroy: jest.fn() };
    const controller = { abort: jest.fn() };
    const callback = jest.fn();

    bag.add(handle);
    bag.add(widget);
    bag.add(controller);
    bag.add(callback);
    expect(bag.size).toBe(4);

    bag.dispose();

    expect(handle.remove).toHaveBeenCalledTimes(1);
    expect(widget.destroy).toHaveBeenCalledTimes(1);
    expect(controller.abort).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(bag.size).toBe(0);
    expect(bag.disposed).toBe(true);
  });

  test('adding a disposable after disposal disposes it immediately', () => {
    const bag = createDisposableBag();
    bag.dispose();
    const handle = { remove: jest.fn() };

    bag.add(handle);

    expect(handle.remove).toHaveBeenCalledTimes(1);
    expect(bag.size).toBe(0);
  });
});
