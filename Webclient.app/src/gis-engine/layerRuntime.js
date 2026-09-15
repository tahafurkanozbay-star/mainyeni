export const LAYER_STATUS = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR: 'error',
  DISABLED: 'disabled',
});

export const DEFAULT_LAYER_RUNTIME = Object.freeze({
  status: LAYER_STATUS.IDLE,
  visible: true,
  opacity: 1,
  minScale: 0,
  maxScale: 0,
  featureCount: null,
  lastLoadedAt: null,
  requestId: null,
  error: null,
});

const normalizeOpacity = (value) => {
  const numeric = Number(value);
  return Math.min(1, Math.max(0, Number.isFinite(numeric) ? numeric : 1));
};

const normalizeScale = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
};

const normalizeScaleRange = (minScale, maxScale) => ({
  minScale: normalizeScale(minScale),
  maxScale: normalizeScale(maxScale),
});

const uniqueIds = (values = []) => Array.from(new Set(values.map(String).filter(Boolean)));

export const createLayerDescriptor = (config = {}) => ({
  id: String(config.id ?? ''),
  title: String(config.title ?? config.name ?? config.id ?? 'Katman'),
  type: String(config.type ?? 'operational'),
  serviceId: config.serviceId ?? config.id ?? null,
  parentId: config.parentId ?? null,
  children: uniqueIds(Array.isArray(config.children) ? config.children : []),
  iconKey: config.iconKey ?? config.category ?? config.type ?? 'default',
  metadata: { ...(config.metadata || {}) },
  runtime: {
    ...DEFAULT_LAYER_RUNTIME,
    visible: config.visible !== false,
    opacity: normalizeOpacity(config.opacity),
    ...normalizeScaleRange(config.minScale, config.maxScale),
  },
  sdkLayer: null,
});

export const createLayerTree = (layers = []) => {
  const byId = new Map();

  layers.forEach((layer) => {
    const descriptor = createLayerDescriptor(layer);
    if (descriptor.id && !byId.has(descriptor.id)) byId.set(descriptor.id, descriptor);
  });

  byId.forEach((layer) => {
    layer.children = uniqueIds(layer.children).filter((childId) => childId !== layer.id && byId.has(childId));
  });

  byId.forEach((layer) => {
    if (!layer.parentId || !byId.has(String(layer.parentId)) || String(layer.parentId) === layer.id) return;
    layer.parentId = String(layer.parentId);
    const parent = byId.get(layer.parentId);
    parent.children = uniqueIds([...parent.children, layer.id]);
  });

  byId.forEach((parent) => {
    parent.children.forEach((childId) => {
      const child = byId.get(childId);
      if (child && !child.parentId) child.parentId = parent.id;
    });
  });

  const roots = [];
  byId.forEach((layer) => {
    if (!layer.parentId || !byId.has(String(layer.parentId))) roots.push(layer.id);
  });

  return { byId, roots: uniqueIds(roots) };
};

const updateNode = (state, layerId, update) => {
  const current = state?.byId?.get(layerId);
  if (!current) return state;
  const next = update({ ...current, runtime: { ...current.runtime } });
  const byId = new Map(state.byId);
  byId.set(layerId, next);
  return { ...state, byId };
};

export const layerReducer = (state, action = {}) => {
  if (!state?.byId) return state;

  switch (action.type) {
    case 'LOAD_START':
      return updateNode(state, action.layerId, (layer) => ({
        ...layer,
        runtime: {
          ...layer.runtime,
          status: LAYER_STATUS.LOADING,
          error: null,
          requestId: action.requestId ?? null,
        },
      }));
    case 'LOAD_SUCCESS':
      return updateNode(state, action.layerId, (layer) => ({
        ...layer,
        runtime: {
          ...layer.runtime,
          status: action.featureCount === 0 ? LAYER_STATUS.EMPTY : LAYER_STATUS.READY,
          featureCount: Number.isFinite(action.featureCount) ? action.featureCount : null,
          lastLoadedAt: action.loadedAt || new Date().toISOString(),
          requestId: null,
          error: null,
        },
      }));
    case 'LOAD_ERROR':
      return updateNode(state, action.layerId, (layer) => ({
        ...layer,
        runtime: {
          ...layer.runtime,
          status: LAYER_STATUS.ERROR,
          error: {
            code: action.error?.code || 'LAYER_LOAD_ERROR',
            message: action.error?.message || 'Katman yüklenemedi.',
          },
          requestId: null,
        },
      }));
    case 'SET_VISIBLE':
      return updateNode(state, action.layerId, (layer) => ({
        ...layer,
        runtime: { ...layer.runtime, visible: Boolean(action.visible) },
      }));
    case 'SET_OPACITY':
      return updateNode(state, action.layerId, (layer) => ({
        ...layer,
        runtime: { ...layer.runtime, opacity: normalizeOpacity(action.opacity) },
      }));
    case 'SET_SCALE_RANGE':
      return updateNode(state, action.layerId, (layer) => ({
        ...layer,
        runtime: {
          ...layer.runtime,
          ...normalizeScaleRange(action.minScale, action.maxScale),
        },
      }));
    case 'SET_SDK_LAYER':
      return updateNode(state, action.layerId, (layer) => ({ ...layer, sdkLayer: action.sdkLayer || null }));
    case 'SET_DISABLED':
      return updateNode(state, action.layerId, (layer) => ({
        ...layer,
        runtime: {
          ...layer.runtime,
          status: action.disabled ? LAYER_STATUS.DISABLED : LAYER_STATUS.IDLE,
        },
      }));
    default:
      return state;
  }
};

export const isScaleVisible = (scaleValue, layer) => {
  const viewScale = Number(scaleValue);
  if (!Number.isFinite(viewScale) || viewScale <= 0) return true;

  const { minScale = 0, maxScale = 0 } = layer?.runtime || {};

  // ArcGIS scale denominators become larger while zooming out. A valid range
  // therefore normally has minScale > maxScale. Invalid legacy ranges are
  // treated as unrestricted rather than making a layer permanently invisible.
  if (minScale > 0 && maxScale > 0 && minScale <= maxScale) return true;
  if (minScale > 0 && viewScale > minScale) return false;
  if (maxScale > 0 && viewScale < maxScale) return false;
  return true;
};

const areAncestorsVisible = (tree, layer) => {
  const visited = new Set([layer.id]);
  let parentId = layer.parentId;

  while (parentId && tree.byId.has(String(parentId))) {
    const normalizedParentId = String(parentId);
    if (visited.has(normalizedParentId)) return false;
    visited.add(normalizedParentId);
    const parent = tree.byId.get(normalizedParentId);
    if (parent.runtime.visible === false || parent.runtime.status === LAYER_STATUS.DISABLED) return false;
    parentId = parent.parentId;
  }
  return true;
};

export const flattenLayerTree = (tree, options = {}) => {
  const output = [];
  const includeGroups = options.includeGroups !== false;
  const visited = new Set();

  const walk = (id, depth) => {
    if (visited.has(id)) return;
    const node = tree?.byId?.get(id);
    if (!node) return;
    visited.add(id);
    const isGroup = node.children.length > 0;
    if (includeGroups || !isGroup) output.push({ node, depth, isGroup });
    node.children.forEach((childId) => walk(childId, depth + 1));
  };

  (tree?.roots || []).forEach((id) => walk(id, 0));

  // Malformed/cyclic configuration must not make otherwise valid layers vanish
  // from diagnostics and serialization.
  tree?.byId?.forEach((_, id) => {
    if (!visited.has(id)) walk(id, 0);
  });

  return output;
};

export const visibleLayersAtScale = (tree, scaleValue) =>
  flattenLayerTree(tree, { includeGroups: false })
    .filter(({ node }) =>
      node.runtime.visible &&
      node.runtime.status !== LAYER_STATUS.DISABLED &&
      areAncestorsVisible(tree, node) &&
      isScaleVisible(scaleValue, node),
    )
    .map(({ node }) => node);

export const serializeLayerRuntime = (tree) => ({
  layers: flattenLayerTree(tree).map(({ node }) => ({
    id: node.id,
    visible: node.runtime.visible,
    opacity: Number(node.runtime.opacity.toFixed(3)),
    minScale: node.runtime.minScale,
    maxScale: node.runtime.maxScale,
    status: node.runtime.status,
  })),
});

export const hydrateLayerRuntime = (tree, snapshot = {}) =>
  (Array.isArray(snapshot.layers) ? snapshot.layers : []).reduce((state, persisted) => {
    if (!persisted?.id || !state?.byId?.has(persisted.id)) return state;
    let next = state;
    if (typeof persisted.visible === 'boolean') {
      next = layerReducer(next, { type: 'SET_VISIBLE', layerId: persisted.id, visible: persisted.visible });
    }
    if (Number.isFinite(Number(persisted.opacity))) {
      next = layerReducer(next, { type: 'SET_OPACITY', layerId: persisted.id, opacity: Number(persisted.opacity) });
    }
    if (persisted.minScale !== undefined || persisted.maxScale !== undefined) {
      next = layerReducer(next, {
        type: 'SET_SCALE_RANGE',
        layerId: persisted.id,
        minScale: persisted.minScale,
        maxScale: persisted.maxScale,
      });
    }
    return next;
  }, tree);
