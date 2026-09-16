import { LAYER_RUNTIME_STATUS } from './contracts';
import type {
  FlattenedLayer,
  LayerAction,
  LayerDescriptor,
  LayerDescriptorInput,
  LayerRuntimeSnapshot,
  LayerRuntimeState,
  LayerTree,
} from './contracts';

export const LAYER_STATUS = LAYER_RUNTIME_STATUS;

export const DEFAULT_LAYER_RUNTIME: Readonly<LayerRuntimeState> = Object.freeze({
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

const normalizeOpacity = (value: unknown): number => {
  const numeric = Number(value);
  return Math.min(1, Math.max(0, Number.isFinite(numeric) ? numeric : 1));
};

const normalizeScale = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
};

const normalizeScaleRange = (minScale: unknown, maxScale: unknown) => ({
  minScale: normalizeScale(minScale),
  maxScale: normalizeScale(maxScale),
});

const uniqueIds = (values: Array<string | number> = []): string[] => Array.from(
  new Set(values.map(String).filter(Boolean)),
);

export const createLayerDescriptor = (config: LayerDescriptorInput = {}): LayerDescriptor => ({
  id: String(config.id ?? ''),
  title: String(config.title ?? config.name ?? config.id ?? 'Katman'),
  type: String(config.type ?? 'operational'),
  serviceId: config.serviceId ?? config.id ?? null,
  parentId: config.parentId == null ? null : String(config.parentId),
  children: uniqueIds(Array.isArray(config.children) ? config.children : []),
  iconKey: String(config.iconKey ?? config.category ?? config.type ?? 'default'),
  metadata: { ...(config.metadata || {}) },
  runtime: {
    ...DEFAULT_LAYER_RUNTIME,
    visible: config.visible !== false,
    opacity: normalizeOpacity(config.opacity),
    ...normalizeScaleRange(config.minScale, config.maxScale),
  },
  sdkLayer: null,
});

export const createLayerTree = (layers: LayerDescriptorInput[] = []): LayerTree => {
  const byId = new Map<string, LayerDescriptor>();

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
    if (parent) parent.children = uniqueIds([...parent.children, layer.id]);
  });

  byId.forEach((layer) => {
    layer.children.forEach((childId) => {
      const child = byId.get(childId);
      if (child && !child.parentId) child.parentId = layer.id;
    });
  });

  const roots: string[] = [];
  byId.forEach((layer) => {
    if (!layer.parentId || !byId.has(String(layer.parentId))) roots.push(layer.id);
  });

  return { byId, roots: uniqueIds(roots) };
};

const updateNode = (
  state: LayerTree,
  layerId: string,
  update: (layer: LayerDescriptor) => LayerDescriptor,
): LayerTree => {
  const current = state?.byId?.get(layerId);
  if (!current) return state;
  const next = update({ ...current, runtime: { ...current.runtime } });
  if (next === current) return state;
  const byId = new Map(state.byId);
  byId.set(layerId, next);
  return { ...state, byId };
};

const actionRequestId = (action: LayerAction): string | null | undefined => (
  'requestId' in action ? action.requestId : undefined
);

const requestMatches = (layer: LayerDescriptor, action: LayerAction): boolean => {
  const requestId = actionRequestId(action);
  return !requestId || layer.runtime.requestId === requestId;
};

const updateRequestedNode = (
  state: LayerTree,
  action: LayerAction,
  update: (layer: LayerDescriptor) => LayerDescriptor,
): LayerTree => updateNode(
  state,
  action.layerId,
  (layer) => requestMatches(layer, action) ? update(layer) : layer,
);

export const layerReducer = (state: LayerTree, action?: LayerAction): LayerTree => {
  if (!state?.byId || !action) return state;

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
      return updateRequestedNode(state, action, (layer) => ({
        ...layer,
        runtime: {
          ...layer.runtime,
          status: action.featureCount === 0 ? LAYER_STATUS.EMPTY : LAYER_STATUS.READY,
          featureCount: Number.isFinite(action.featureCount) ? Number(action.featureCount) : null,
          lastLoadedAt: action.loadedAt || new Date().toISOString(),
          requestId: null,
          error: null,
        },
      }));
    case 'LOAD_ERROR':
      return updateRequestedNode(state, action, (layer) => ({
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
    case 'LOAD_CANCEL':
      return updateRequestedNode(state, action, (layer) => ({
        ...layer,
        runtime: {
          ...layer.runtime,
          status: LAYER_STATUS.IDLE,
          requestId: null,
          error: null,
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
      return updateRequestedNode(state, action, (layer) => ({
        ...layer,
        sdkLayer: action.sdkLayer || null,
      }));
    case 'SET_DISABLED':
      return updateNode(state, action.layerId, (layer) => ({
        ...layer,
        runtime: {
          ...layer.runtime,
          status: action.disabled ? LAYER_STATUS.DISABLED : LAYER_STATUS.IDLE,
          requestId: action.disabled ? null : layer.runtime.requestId,
        },
      }));
    default:
      return state;
  }
};

export const isScaleVisible = (scaleValue: unknown, layer: LayerDescriptor): boolean => {
  const viewScale = Number(scaleValue);
  if (!Number.isFinite(viewScale) || viewScale <= 0) return true;

  const { minScale = 0, maxScale = 0 } = layer?.runtime || {};
  if (minScale > 0 && maxScale > 0 && minScale <= maxScale) return true;
  if (minScale > 0 && viewScale > minScale) return false;
  if (maxScale > 0 && viewScale < maxScale) return false;
  return true;
};

const areAncestorsVisible = (tree: LayerTree, layer: LayerDescriptor): boolean => {
  const visited = new Set<string>([layer.id]);
  let parentId = layer.parentId;

  while (parentId && tree.byId.has(String(parentId))) {
    const normalizedParentId = String(parentId);
    if (visited.has(normalizedParentId)) return false;
    visited.add(normalizedParentId);
    const parent = tree.byId.get(normalizedParentId);
    if (!parent) return true;
    if (parent.runtime.visible === false || parent.runtime.status === LAYER_STATUS.DISABLED) return false;
    parentId = parent.parentId;
  }
  return true;
};

export const flattenLayerTree = (
  tree: LayerTree,
  options: { includeGroups?: boolean } = {},
): FlattenedLayer[] => {
  const output: FlattenedLayer[] = [];
  const includeGroups = options.includeGroups !== false;
  const visited = new Set<string>();

  const walk = (id: string, depth: number): void => {
    if (visited.has(id)) return;
    const node = tree?.byId?.get(id);
    if (!node) return;
    visited.add(id);
    const isGroup = node.children.length > 0;
    if (includeGroups || !isGroup) output.push({ node, depth, isGroup });
    node.children.forEach((childId) => walk(childId, depth + 1));
  };

  (tree?.roots || []).forEach((id) => walk(id, 0));
  tree?.byId?.forEach((_, id) => {
    if (!visited.has(id)) walk(id, 0);
  });

  return output;
};

export const visibleLayersAtScale = (tree: LayerTree, scaleValue: unknown): LayerDescriptor[] =>
  flattenLayerTree(tree, { includeGroups: false })
    .filter(({ node }) =>
      node.runtime.visible &&
      node.runtime.status !== LAYER_STATUS.DISABLED &&
      areAncestorsVisible(tree, node) &&
      isScaleVisible(scaleValue, node),
    )
    .map(({ node }) => node);

export const serializeLayerRuntime = (tree: LayerTree): LayerRuntimeSnapshot => ({
  layers: flattenLayerTree(tree).map(({ node }) => ({
    id: node.id,
    visible: node.runtime.visible,
    opacity: Number(node.runtime.opacity.toFixed(3)),
    minScale: node.runtime.minScale,
    maxScale: node.runtime.maxScale,
    status: node.runtime.status,
  })),
});

export const hydrateLayerRuntime = (
  tree: LayerTree,
  snapshot: LayerRuntimeSnapshot = {},
): LayerTree => (Array.isArray(snapshot.layers) ? snapshot.layers : []).reduce((state, persisted) => {
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
