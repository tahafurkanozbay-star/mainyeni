export interface LayerCollectionLike<TLayer = unknown> {
  items?: TLayer[];
  includes?: (layer: TLayer) => boolean;
  toArray?: () => TLayer[];
}

export interface LayerMapLike<TLayer = unknown> {
  layers?: LayerCollectionLike<TLayer> | TLayer[];
  allLayers?: LayerCollectionLike<TLayer>;
  add?: (layer: TLayer, index?: number) => unknown;
  remove?: (layer: TLayer) => unknown;
}

export interface LayerViewLike<TLayer = unknown> {
  map?: LayerMapLike<TLayer> | null;
}

export type MapOrView<TLayer = unknown> = LayerMapLike<TLayer> | LayerViewLike<TLayer> | null | undefined;
export interface OwnedLayerEntry<TLayer = unknown> { layer: TLayer; index?: number; }
export interface ReplaceOwnedLayerOptions { startIndex?: number; }
export interface LayerOwnershipStats { owners: number; layers: number; byOwner: Record<string, number>; }
export interface DisposableObject {
  remove?: () => unknown;
  destroy?: () => unknown;
  abort?: () => unknown;
}
export interface RemovableHandle extends DisposableObject {
  remove: () => unknown;
}
export type Disposable = DisposableObject | (() => unknown);

const mapRegistries = new WeakMap<object, Map<string, Set<unknown>>>();

const normalizeOwnerId = (ownerId: unknown): string => {
  const value = String(ownerId || '').trim();
  if (!value) throw new Error('A layer owner id is required.');
  return value;
};

const getMap = <TLayer>(mapOrView: MapOrView<TLayer>): LayerMapLike<TLayer> | null => {
  if (!mapOrView) return null;
  const maybeView = mapOrView as LayerViewLike<TLayer>;
  return maybeView.map || mapOrView as LayerMapLike<TLayer>;
};

const getRegistry = <TLayer>(mapOrView: MapOrView<TLayer>, create = true): Map<string, Set<TLayer>> | null => {
  const map = getMap(mapOrView);
  if (!map || (typeof map !== 'object' && typeof map !== 'function')) return null;
  let registry = mapRegistries.get(map as object) as Map<string, Set<TLayer>> | undefined;
  if (!registry && create) {
    registry = new Map<string, Set<TLayer>>();
    mapRegistries.set(map as object, registry as Map<string, Set<unknown>>);
  }
  return registry || null;
};

const getOwnerBucket = <TLayer>(mapOrView: MapOrView<TLayer>, ownerId: unknown, create = true): Set<TLayer> | null => {
  const registry = getRegistry(mapOrView, create);
  if (!registry) return null;
  const id = normalizeOwnerId(ownerId);
  let bucket = registry.get(id);
  if (!bucket && create) {
    bucket = new Set<TLayer>();
    registry.set(id, bucket);
  }
  return bucket || null;
};

const layerExistsOnMap = <TLayer>(map: LayerMapLike<TLayer> | null, layer: TLayer): boolean => {
  if (!map || !layer) return false;
  const layers = map.layers;
  if (layers && typeof (layers as LayerCollectionLike<TLayer>).includes === 'function') {
    return Boolean((layers as LayerCollectionLike<TLayer>).includes?.(layer));
  }
  if (Array.isArray(layers)) return layers.includes(layer);
  if (Array.isArray((layers as LayerCollectionLike<TLayer> | undefined)?.items)) {
    return Boolean((layers as LayerCollectionLike<TLayer>).items?.includes(layer));
  }
  if (Array.isArray(map.allLayers?.items)) return map.allLayers?.items?.includes(layer) === true;
  return true;
};

const safeRemove = <TLayer>(map: LayerMapLike<TLayer> | null, layer: TLayer): boolean => {
  if (!map || !layer || typeof map.remove !== 'function') return false;
  try {
    if (!layerExistsOnMap(map, layer)) return false;
    map.remove(layer);
    return true;
  } catch (_) { return false; }
};

const safeAdd = <TLayer>(map: LayerMapLike<TLayer> | null, layer: TLayer, index?: number): boolean => {
  if (!map || !layer || typeof map.add !== 'function') return false;
  try {
    if (Number.isInteger(index) && Number(index) >= 0) map.add(layer, index);
    else map.add(layer);
    return true;
  } catch (_) { return false; }
};

export const registerOwnedLayer = <TLayer>(mapOrView: MapOrView<TLayer>, ownerId: unknown, layer: TLayer): TLayer | null => {
  if (!layer) return null;
  getOwnerBucket(mapOrView, ownerId, true)?.add(layer);
  return layer;
};

export const unregisterOwnedLayer = <TLayer>(mapOrView: MapOrView<TLayer>, ownerId: unknown, layer: TLayer): boolean => {
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

export const addOwnedLayer = <TLayer>(mapOrView: MapOrView<TLayer>, ownerId: unknown, layer: TLayer, index?: number): TLayer | null => {
  const map = getMap(mapOrView);
  if (!map || !layer || !safeAdd(map, layer, index)) return null;
  registerOwnedLayer(map, ownerId, layer);
  return layer;
};

export const removeOwnedLayer = <TLayer>(mapOrView: MapOrView<TLayer>, ownerId: unknown, layer: TLayer): boolean => {
  const map = getMap(mapOrView);
  if (!map || !layer) return false;
  const removed = safeRemove(map, layer);
  unregisterOwnedLayer(map, ownerId, layer);
  return removed;
};

export const removeOwnedLayers = <TLayer>(mapOrView: MapOrView<TLayer>, ownerId: unknown): number => {
  const map = getMap(mapOrView);
  const registry = getRegistry(map, false);
  if (!map || !registry) return 0;
  const id = normalizeOwnerId(ownerId);
  const bucket = registry.get(id);
  if (!bucket) return 0;
  let removedCount = 0;
  Array.from(bucket).forEach((layer) => { if (safeRemove(map, layer)) removedCount += 1; });
  bucket.clear();
  registry.delete(id);
  return removedCount;
};

export const clearLayerOwner = <TLayer>(mapOrView: MapOrView<TLayer>, ownerId: unknown): boolean => {
  const registry = getRegistry(mapOrView, false);
  return registry ? registry.delete(normalizeOwnerId(ownerId)) : false;
};

export const replaceOwnedLayers = <TLayer>(
  mapOrView: MapOrView<TLayer>,
  ownerId: unknown,
  layers: Array<TLayer | OwnedLayerEntry<TLayer>> = [],
  options: ReplaceOwnedLayerOptions = {},
): TLayer[] => {
  const map = getMap(mapOrView);
  if (!map) return [];
  removeOwnedLayers(map, ownerId);
  const added: TLayer[] = [];
  layers.forEach((entry, entryIndex) => {
    const wrapper = entry as OwnedLayerEntry<TLayer>;
    const layer = wrapper && typeof wrapper === 'object' && Object.prototype.hasOwnProperty.call(wrapper, 'layer') ? wrapper.layer : entry as TLayer;
    const index = Number.isInteger(wrapper?.index)
      ? wrapper.index
      : Number.isInteger(options.startIndex) ? Number(options.startIndex) + entryIndex : undefined;
    if (addOwnedLayer(map, ownerId, layer, index)) added.push(layer);
  });
  return added;
};

export const listOwnedLayers = <TLayer>(mapOrView: MapOrView<TLayer>, ownerId: unknown): TLayer[] => {
  const bucket = getOwnerBucket(mapOrView, ownerId, false);
  return bucket ? Array.from(bucket) : [];
};

export const hasOwnedLayer = <TLayer>(mapOrView: MapOrView<TLayer>, ownerId: unknown, layer: TLayer): boolean =>
  Boolean(getOwnerBucket(mapOrView, ownerId, false)?.has(layer));

export const transferOwnedLayer = <TLayer>(mapOrView: MapOrView<TLayer>, fromOwnerId: unknown, toOwnerId: unknown, layer: TLayer): boolean => {
  if (!layer || !hasOwnedLayer(mapOrView, fromOwnerId, layer)) return false;
  unregisterOwnedLayer(mapOrView, fromOwnerId, layer);
  registerOwnedLayer(mapOrView, toOwnerId, layer);
  return true;
};

export const getLayerOwnershipStats = <TLayer>(mapOrView: MapOrView<TLayer>): LayerOwnershipStats => {
  const registry = getRegistry(mapOrView, false);
  if (!registry) return { owners: 0, layers: 0, byOwner: {} };
  const byOwner: Record<string, number> = {};
  let layers = 0;
  registry.forEach((bucket, ownerId) => { byOwner[ownerId] = bucket.size; layers += bucket.size; });
  return { owners: registry.size, layers, byOwner };
};

export const pruneLayerOwnership = <TLayer>(mapOrView: MapOrView<TLayer>): number => {
  const map = getMap(mapOrView);
  const registry = getRegistry(map, false);
  if (!map || !registry) return 0;
  let pruned = 0;
  registry.forEach((bucket, ownerId) => {
    Array.from(bucket).forEach((layer) => {
      if (!layerExistsOnMap(map, layer)) { bucket.delete(layer); pruned += 1; }
    });
    if (bucket.size === 0) registry.delete(ownerId);
  });
  return pruned;
};

export interface LayerOwner<TLayer = unknown> {
  readonly id: string;
  add: (layer: TLayer, index?: number) => TLayer | null;
  register: (layer: TLayer) => TLayer | null;
  remove: (layer: TLayer) => boolean;
  clear: () => number;
  list: () => TLayer[];
  has: (layer: TLayer) => boolean;
  replace: (layers: Array<TLayer | OwnedLayerEntry<TLayer>>, options?: ReplaceOwnedLayerOptions) => TLayer[];
  stats: () => LayerOwnershipStats;
}

export const createLayerOwner = <TLayer>(mapOrView: MapOrView<TLayer>, ownerId: unknown): Readonly<LayerOwner<TLayer>> => {
  const id = normalizeOwnerId(ownerId);
  return Object.freeze({
    id,
    add: (layer: TLayer, index?: number) => addOwnedLayer(mapOrView, id, layer, index),
    register: (layer: TLayer) => registerOwnedLayer(mapOrView, id, layer),
    remove: (layer: TLayer) => removeOwnedLayer(mapOrView, id, layer),
    clear: () => removeOwnedLayers(mapOrView, id),
    list: () => listOwnedLayers(mapOrView, id),
    has: (layer: TLayer) => hasOwnedLayer(mapOrView, id, layer),
    replace: (layers: Array<TLayer | OwnedLayerEntry<TLayer>>, options?: ReplaceOwnedLayerOptions) => replaceOwnedLayers(mapOrView, id, layers, options),
    stats: () => getLayerOwnershipStats(mapOrView),
  });
};

const disposeOne = (disposable: Disposable): void => {
  try {
    if (typeof disposable === 'function') disposable();
    else {
      disposable.remove?.();
      disposable.destroy?.();
      disposable.abort?.();
    }
  } catch (_) { /* cleanup is deliberately idempotent */ }
};

export interface DisposableBag {
  add: <T extends Disposable>(disposable: T) => T;
  remove: (disposable: Disposable, dispose?: boolean) => boolean;
  clear: () => void;
  dispose: () => void;
  readonly size: number;
  readonly disposed: boolean;
}

export const createDisposableBag = (): DisposableBag => {
  const disposables = new Set<Disposable>();
  let disposed = false;
  const add = <T extends Disposable>(disposable: T): T => {
    if (!disposable) return disposable;
    if (disposed) { disposeOne(disposable); return disposable; }
    disposables.add(disposable);
    return disposable;
  };
  const remove = (disposable: Disposable, dispose = false): boolean => {
    if (!disposables.delete(disposable)) return false;
    if (dispose) disposeOne(disposable);
    return true;
  };
  const clear = (): void => { Array.from(disposables).forEach(disposeOne); disposables.clear(); };
  const dispose = (): void => { if (disposed) return; disposed = true; clear(); };
  return { add, remove, clear, dispose, get size() { return disposables.size; }, get disposed() { return disposed; } };
};