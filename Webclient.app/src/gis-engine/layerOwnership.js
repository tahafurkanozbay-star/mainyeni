const mapRegistries = new WeakMap();

const normalizeOwnerId = (ownerId) => {
  const value = String(ownerId || '').trim();
  if (!value) throw new Error('A layer owner id is required.');
  return value;
};

const getMap = (mapOrView) => mapOrView?.map || mapOrView || null;

const getRegistry = (mapOrView, create = true) => {
  const map = getMap(mapOrView);
  if (!map) return null;
  let registry = mapRegistries.get(map);
  if (!registry && create) {
    registry = new Map();
    mapRegistries.set(map, registry);
  }
  return registry || null;
};

const getOwnerBucket = (mapOrView, ownerId, create = true) => {
  const registry = getRegistry(mapOrView, create);
  if (!registry) return null;
  const id = normalizeOwnerId(ownerId);
  let bucket = registry.get(id);
  if (!bucket && create) {
    bucket = new Set();
    registry.set(id, bucket);
  }
  return bucket || null;
};

const layerExistsOnMap = (map, layer) => {
  if (!map || !layer) return false;
  if (typeof map.layers?.includes === 'function') return map.layers.includes(layer);
  if (Array.isArray(map.layers)) return map.layers.includes(layer);
  if (Array.isArray(map.layers?.items)) return map.layers.items.includes(layer);
  if (Array.isArray(map.allLayers?.items)) return map.allLayers.items.includes(layer);
  return true;
};

const safeRemove = (map, layer) => {
  if (!map || !layer || typeof map.remove !== 'function') return false;
  try {
    if (!layerExistsOnMap(map, layer)) return false;
    map.remove(layer);
    return true;
  } catch (_) {
    return false;
  }
};

const safeAdd = (map, layer, index) => {
  if (!map || !layer || typeof map.add !== 'function') return false;
  try {
    if (Number.isInteger(index) && index >= 0) map.add(layer, index);
    else map.add(layer);
    return true;
  } catch (_) {
    return false;
  }
};

export const registerOwnedLayer = (mapOrView, ownerId, layer) => {
  if (!layer) return null;
  const bucket = getOwnerBucket(mapOrView, ownerId, true);
  bucket?.add(layer);
  return layer;
};

export const unregisterOwnedLayer = (mapOrView, ownerId, layer) => {
  if (!layer) return false;
  const registry = getRegistry(mapOrView, false);
  if (!registry) return false;
  const id = normalizeOwnerId(ownerId);
  const bucket = registry.get(id);
  if (!bucket) return false;
  const removed = bucket.delete(layer);
  if (bucket.size === 0) registry.delete(id);
  return removed;
};

export const addOwnedLayer = (mapOrView, ownerId, layer, index) => {
  const map = getMap(mapOrView);
  if (!map || !layer) return null;
  if (!safeAdd(map, layer, index)) return null;
  registerOwnedLayer(map, ownerId, layer);
  return layer;
};

export const removeOwnedLayer = (mapOrView, ownerId, layer) => {
  const map = getMap(mapOrView);
  if (!map || !layer) return false;
  const removed = safeRemove(map, layer);
  unregisterOwnedLayer(map, ownerId, layer);
  return removed;
};

export const removeOwnedLayers = (mapOrView, ownerId) => {
  const map = getMap(mapOrView);
  const registry = getRegistry(map, false);
  if (!map || !registry) return 0;
  const id = normalizeOwnerId(ownerId);
  const bucket = registry.get(id);
  if (!bucket) return 0;

  let removedCount = 0;
  Array.from(bucket).forEach((layer) => {
    if (safeRemove(map, layer)) removedCount += 1;
  });
  bucket.clear();
  registry.delete(id);
  return removedCount;
};

export const clearLayerOwner = (mapOrView, ownerId) => {
  const registry = getRegistry(mapOrView, false);
  if (!registry) return false;
  return registry.delete(normalizeOwnerId(ownerId));
};

export const replaceOwnedLayers = (mapOrView, ownerId, layers = [], options = {}) => {
  const map = getMap(mapOrView);
  if (!map) return [];
  removeOwnedLayers(map, ownerId);

  const added = [];
  (Array.isArray(layers) ? layers : []).forEach((entry, entryIndex) => {
    const layer = entry?.layer || entry;
    const index = Number.isInteger(entry?.index)
      ? entry.index
      : Number.isInteger(options.startIndex)
        ? options.startIndex + entryIndex
        : undefined;
    if (addOwnedLayer(map, ownerId, layer, index)) added.push(layer);
  });
  return added;
};

export const listOwnedLayers = (mapOrView, ownerId) => {
  const bucket = getOwnerBucket(mapOrView, ownerId, false);
  return bucket ? Array.from(bucket) : [];
};

export const hasOwnedLayer = (mapOrView, ownerId, layer) => {
  const bucket = getOwnerBucket(mapOrView, ownerId, false);
  return Boolean(bucket?.has(layer));
};

export const transferOwnedLayer = (mapOrView, fromOwnerId, toOwnerId, layer) => {
  if (!layer || !hasOwnedLayer(mapOrView, fromOwnerId, layer)) return false;
  unregisterOwnedLayer(mapOrView, fromOwnerId, layer);
  registerOwnedLayer(mapOrView, toOwnerId, layer);
  return true;
};

export const getLayerOwnershipStats = (mapOrView) => {
  const registry = getRegistry(mapOrView, false);
  if (!registry) return { owners: 0, layers: 0, byOwner: {} };

  const byOwner = {};
  let layers = 0;
  registry.forEach((bucket, ownerId) => {
    byOwner[ownerId] = bucket.size;
    layers += bucket.size;
  });
  return { owners: registry.size, layers, byOwner };
};

export const pruneLayerOwnership = (mapOrView) => {
  const map = getMap(mapOrView);
  const registry = getRegistry(map, false);
  if (!map || !registry) return 0;

  let pruned = 0;
  registry.forEach((bucket, ownerId) => {
    Array.from(bucket).forEach((layer) => {
      if (!layerExistsOnMap(map, layer)) {
        bucket.delete(layer);
        pruned += 1;
      }
    });
    if (bucket.size === 0) registry.delete(ownerId);
  });
  return pruned;
};

export const createLayerOwner = (mapOrView, ownerId) => {
  const id = normalizeOwnerId(ownerId);
  return Object.freeze({
    id,
    add: (layer, index) => addOwnedLayer(mapOrView, id, layer, index),
    register: (layer) => registerOwnedLayer(mapOrView, id, layer),
    remove: (layer) => removeOwnedLayer(mapOrView, id, layer),
    clear: () => removeOwnedLayers(mapOrView, id),
    list: () => listOwnedLayers(mapOrView, id),
    has: (layer) => hasOwnedLayer(mapOrView, id, layer),
    replace: (layers, options) => replaceOwnedLayers(mapOrView, id, layers, options),
    stats: () => getLayerOwnershipStats(mapOrView),
  });
};

export const createDisposableBag = () => {
  const disposables = new Set();
  let disposed = false;

  const add = (disposable) => {
    if (!disposable) return disposable;
    if (disposed) {
      try {
        if (typeof disposable === 'function') disposable();
        else disposable.remove?.();
        disposable.destroy?.();
        disposable.abort?.();
      } catch (_) {}
      return disposable;
    }
    disposables.add(disposable);
    return disposable;
  };

  const remove = (disposable, dispose = false) => {
    if (!disposables.delete(disposable)) return false;
    if (dispose) {
      try {
        if (typeof disposable === 'function') disposable();
        else disposable.remove?.();
        disposable.destroy?.();
        disposable.abort?.();
      } catch (_) {}
    }
    return true;
  };

  const clear = () => {
    Array.from(disposables).forEach((disposable) => {
      try {
        if (typeof disposable === 'function') disposable();
        else disposable.remove?.();
        disposable.destroy?.();
        disposable.abort?.();
      } catch (_) {}
    });
    disposables.clear();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clear();
  };

  return {
    add,
    remove,
    clear,
    dispose,
    get size() { return disposables.size; },
    get disposed() { return disposed; },
  };
};
