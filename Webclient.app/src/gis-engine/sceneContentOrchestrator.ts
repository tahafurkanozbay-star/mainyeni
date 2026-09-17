import {
  createSceneResourceBudget,
  type SceneAdmissionReason,
  type SceneBudgetLimits,
  type SceneBudgetSnapshot,
  type ScenePriority,
  type SceneResourceKind,
  type SceneResourceRequest,
} from './sceneResourceBudget';

export type SceneContentKind =
  | 'feature'
  | 'scene'
  | 'building'
  | 'integrated-mesh'
  | 'point-cloud'
  | 'voxel'
  | 'imagery'
  | 'elevation'
  | 'graphics';

export type SceneContentLoadPolicy = 'eager' | 'visible' | 'manual';
export type SceneContentStatus =
  | 'registered'
  | 'queued'
  | 'loading'
  | 'ready'
  | 'hidden'
  | 'blocked'
  | 'failed'
  | 'disposed';

export interface SceneContentEstimate {
  cpuBytes?: number;
  gpuBytes?: number;
  drawCalls?: number;
  features?: number;
  distance?: number;
  screenCoverage?: number;
}

export interface SceneContentDefinition {
  id: string;
  title?: string;
  kind: SceneContentKind;
  source?: string | Record<string, unknown>;
  visible?: boolean;
  opacity?: number;
  minScale?: number;
  maxScale?: number;
  priority?: ScenePriority;
  loadPolicy?: SceneContentLoadPolicy;
  elevationMode?: 'on-the-ground' | 'relative-to-ground' | 'absolute-height';
  estimate?: SceneContentEstimate;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface SceneContentLayerLike {
  id?: string;
  title?: string;
  visible?: boolean;
  opacity?: number;
  minScale?: number;
  maxScale?: number;
  elevationInfo?: unknown;
  loaded?: boolean;
  destroyed?: boolean;
  load?: () => Promise<unknown>;
  cancelLoad?: () => void;
  destroy?: () => void;
}

export interface SceneContentMapLike {
  add?: (layer: SceneContentLayerLike, index?: number) => unknown;
  remove?: (layer: SceneContentLayerLike) => unknown;
  findLayerById?: (id: string) => SceneContentLayerLike | null | undefined;
}

export interface SceneContentViewLike {
  map?: SceneContentMapLike | null;
  scale?: number;
  stationary?: boolean;
  destroyed?: boolean;
}

export interface SceneContentFactoryContext {
  signal: AbortSignal;
  definition: Readonly<SceneContentDefinition>;
}

export type SceneContentLayerFactory = (
  context: SceneContentFactoryContext,
) => Promise<SceneContentLayerLike>;

export interface SceneContentRecordSnapshot {
  id: string;
  title: string;
  kind: SceneContentKind;
  status: SceneContentStatus;
  requestedVisible: boolean;
  effectiveVisible: boolean;
  admitted: boolean;
  admissionReason: SceneAdmissionReason | null;
  attempts: number;
  lastError: unknown;
  layerAttached: boolean;
  loadPolicy: SceneContentLoadPolicy;
  priority: ScenePriority;
}

export interface SceneContentSnapshot {
  active: boolean;
  disposed: boolean;
  registered: number;
  loading: number;
  ready: number;
  visible: number;
  blocked: number;
  failed: number;
  queueDepth: number;
  inFlight: number;
  budget: SceneBudgetSnapshot;
  records: readonly SceneContentRecordSnapshot[];
}

export interface SceneContentOrchestratorOptions {
  concurrency?: number;
  limits?: Partial<SceneBudgetLimits>;
  maximumAttempts?: number;
  ownLayers?: boolean;
  onSnapshot?: (snapshot: SceneContentSnapshot, reason: string) => void;
  onError?: (error: unknown, context: string, id: string) => void;
}

export interface SceneContentOrchestrator {
  register: (definition: SceneContentDefinition) => SceneContentSnapshot;
  registerMany: (definitions: readonly SceneContentDefinition[]) => SceneContentSnapshot;
  unregister: (id: string) => boolean;
  setActive: (active: boolean) => SceneContentSnapshot;
  setVisibility: (id: string, visible: boolean) => SceneContentSnapshot;
  setScale: (scale: unknown) => SceneContentSnapshot;
  updateBudget: (limits: Partial<SceneBudgetLimits>) => SceneContentSnapshot;
  reconcile: (reason?: string) => Promise<SceneContentSnapshot>;
  retry: (id: string) => Promise<boolean>;
  getSnapshot: () => SceneContentSnapshot;
  subscribe: (listener: (snapshot: SceneContentSnapshot, reason: string) => void) => () => boolean;
  dispose: () => void;
}

interface MutableSceneContentRecord {
  definition: Readonly<SceneContentDefinition>;
  status: SceneContentStatus;
  layer: SceneContentLayerLike | null;
  controller: AbortController | null;
  admitted: boolean;
  admissionReason: SceneAdmissionReason | null;
  resourceId: string | null;
  attempts: number;
  lastError: unknown;
  queued: boolean;
}

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAXIMUM_ATTEMPTS = 3;
const PRIORITY_WEIGHT: Readonly<Record<ScenePriority, number>> = Object.freeze({
  critical: 4,
  interactive: 3,
  visible: 2,
  prefetch: 1,
});

const finiteNonNegative = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
};

const integerNonNegative = (value: unknown, fallback = 0): number => {
  const numeric = Math.floor(Number(value));
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
};

const clampOpacity = (value: unknown): number => Math.max(0, Math.min(1, finiteNonNegative(value, 1)));
const normalizedId = (value: unknown): string => String(value ?? '').trim();

const normalizeDefinition = (input: SceneContentDefinition): Readonly<SceneContentDefinition> => {
  const id = normalizedId(input.id);
  if (!id) throw new Error('Scene content requires a non-empty id.');

  const minScale = finiteNonNegative(input.minScale, 0);
  const maxScale = finiteNonNegative(input.maxScale, Number.MAX_SAFE_INTEGER);
  if (minScale > 0 && maxScale > 0 && minScale > maxScale) {
    throw new Error(`Invalid scene scale range for ${id}.`);
  }

  return Object.freeze({
    ...input,
    id,
    title: String(input.title || id),
    visible: input.visible !== false,
    opacity: clampOpacity(input.opacity),
    minScale,
    maxScale,
    priority: input.priority ?? 'visible',
    loadPolicy: input.loadPolicy ?? 'visible',
    metadata: Object.freeze(Object.assign({}, input.metadata)),
    estimate: Object.freeze(Object.assign({}, input.estimate)),
  });
};

const resourceKindForContent = (kind: SceneContentKind): SceneResourceKind => {
  if (kind === 'elevation') return 'terrain';
  if (kind === 'imagery') return 'texture';
  if (kind === 'feature' || kind === 'graphics') return 'feature';
  return 'mesh';
};

const defaultEstimateForKind = (kind: SceneContentKind): Required<Pick<SceneContentEstimate, 'cpuBytes' | 'gpuBytes' | 'drawCalls' | 'features'>> => {
  switch (kind) {
    case 'elevation':
      return { cpuBytes: 24 * 1024 * 1024, gpuBytes: 48 * 1024 * 1024, drawCalls: 60, features: 0 };
    case 'integrated-mesh':
    case 'building':
      return { cpuBytes: 64 * 1024 * 1024, gpuBytes: 96 * 1024 * 1024, drawCalls: 300, features: 20_000 };
    case 'point-cloud':
      return { cpuBytes: 72 * 1024 * 1024, gpuBytes: 96 * 1024 * 1024, drawCalls: 180, features: 80_000 };
    case 'voxel':
      return { cpuBytes: 48 * 1024 * 1024, gpuBytes: 80 * 1024 * 1024, drawCalls: 120, features: 12_000 };
    case 'imagery':
      return { cpuBytes: 16 * 1024 * 1024, gpuBytes: 48 * 1024 * 1024, drawCalls: 40, features: 0 };
    case 'scene':
      return { cpuBytes: 48 * 1024 * 1024, gpuBytes: 72 * 1024 * 1024, drawCalls: 220, features: 30_000 };
    case 'graphics':
      return { cpuBytes: 12 * 1024 * 1024, gpuBytes: 16 * 1024 * 1024, drawCalls: 80, features: 5_000 };
    case 'feature':
    default:
      return { cpuBytes: 24 * 1024 * 1024, gpuBytes: 24 * 1024 * 1024, drawCalls: 120, features: 20_000 };
  }
};

const resourceRequestFor = (definition: Readonly<SceneContentDefinition>): SceneResourceRequest => {
  const defaults = defaultEstimateForKind(definition.kind);
  const estimate = definition.estimate ?? {};
  return Object.freeze({
    id: `scene-content:${definition.id}`,
    layerId: definition.id,
    kind: resourceKindForContent(definition.kind),
    priority: definition.priority ?? 'visible',
    estimatedCpuBytes: integerNonNegative(estimate.cpuBytes, defaults.cpuBytes),
    estimatedGpuBytes: integerNonNegative(estimate.gpuBytes, defaults.gpuBytes),
    estimatedDrawCalls: integerNonNegative(estimate.drawCalls, defaults.drawCalls),
    estimatedFeatures: integerNonNegative(estimate.features, defaults.features),
    distance: estimate.distance === undefined ? undefined : finiteNonNegative(estimate.distance),
    screenCoverage: estimate.screenCoverage === undefined
      ? undefined
      : Math.max(0, Math.min(1, finiteNonNegative(estimate.screenCoverage))),
  });
};

const withinScale = (definition: Readonly<SceneContentDefinition>, scale: number): boolean => {
  if (!Number.isFinite(scale) || scale <= 0) return true;
  const minScale = finiteNonNegative(definition.minScale, 0);
  const maxScale = finiteNonNegative(definition.maxScale, Number.MAX_SAFE_INTEGER);
  if (minScale > 0 && scale < minScale) return false;
  if (maxScale > 0 && scale > maxScale) return false;
  return true;
};

const desiredVisible = (record: MutableSceneContentRecord, active: boolean, scale: number): boolean => (
  active
  && record.definition.visible !== false
  && withinScale(record.definition, scale)
);

const shouldLoad = (record: MutableSceneContentRecord, active: boolean, scale: number): boolean => {
  if (record.definition.loadPolicy === 'manual') return false;
  if (record.definition.loadPolicy === 'eager') return active;
  return desiredVisible(record, active, scale);
};

const snapshotRecord = (
  record: MutableSceneContentRecord,
  active: boolean,
  scale: number,
): SceneContentRecordSnapshot => Object.freeze({
  id: record.definition.id,
  title: String(record.definition.title || record.definition.id),
  kind: record.definition.kind,
  status: record.status,
  requestedVisible: record.definition.visible !== false,
  effectiveVisible: desiredVisible(record, active, scale) && record.layer?.visible !== false,
  admitted: record.admitted,
  admissionReason: record.admissionReason,
  attempts: record.attempts,
  lastError: record.lastError,
  layerAttached: Boolean(record.layer),
  loadPolicy: record.definition.loadPolicy ?? 'visible',
  priority: record.definition.priority ?? 'visible',
});

const applyLayerPresentation = (
  layer: SceneContentLayerLike,
  definition: Readonly<SceneContentDefinition>,
  visible: boolean,
): void => {
  layer.id = definition.id;
  layer.title = String(definition.title || definition.id);
  layer.visible = visible;
  layer.opacity = clampOpacity(definition.opacity);
  if (finiteNonNegative(definition.minScale, 0) > 0) layer.minScale = Number(definition.minScale);
  if (finiteNonNegative(definition.maxScale, 0) > 0) layer.maxScale = Number(definition.maxScale);
  if (definition.elevationMode) layer.elevationInfo = { mode: definition.elevationMode };
};

export const createSceneContentOrchestrator = (
  view: SceneContentViewLike,
  layerFactory: SceneContentLayerFactory,
  options: SceneContentOrchestratorOptions = {},
): SceneContentOrchestrator => {
  if (!view?.map) throw new Error('Scene content orchestrator requires a view with a map.');
  if (typeof layerFactory !== 'function') throw new Error('Scene content orchestrator requires a layer factory.');

  const concurrency = Math.max(1, Math.min(8, Math.floor(Number(options.concurrency) || DEFAULT_CONCURRENCY)));
  const maximumAttempts = Math.max(1, Math.min(8, Math.floor(Number(options.maximumAttempts) || DEFAULT_MAXIMUM_ATTEMPTS)));
  const ownLayers = options.ownLayers !== false;
  const budget = createSceneResourceBudget('3d', options.limits);
  const records = new Map<string, MutableSceneContentRecord>();
  const queue: string[] = [];
  const listeners = new Set<(snapshot: SceneContentSnapshot, reason: string) => void>();

  let active = false;
  let disposed = false;
  let scale = finiteNonNegative(view.scale, 0);
  let inFlight = 0;
  let drainPromise: Promise<void> | null = null;

  const buildSnapshot = (): SceneContentSnapshot => {
    const recordSnapshots = [...records.values()]
      .map((record) => snapshotRecord(record, active, scale))
      .sort((left, right) => left.id.localeCompare(right.id));
    return Object.freeze({
      active,
      disposed,
      registered: recordSnapshots.length,
      loading: recordSnapshots.filter((record) => record.status === 'loading').length,
      ready: recordSnapshots.filter((record) => record.status === 'ready' || record.status === 'hidden').length,
      visible: recordSnapshots.filter((record) => record.effectiveVisible).length,
      blocked: recordSnapshots.filter((record) => record.status === 'blocked').length,
      failed: recordSnapshots.filter((record) => record.status === 'failed').length,
      queueDepth: queue.length,
      inFlight,
      budget: budget.snapshot(),
      records: Object.freeze(recordSnapshots),
    });
  };

  const emit = (reason: string): SceneContentSnapshot => {
    const snapshot = buildSnapshot();
    listeners.forEach((listener) => {
      try {
        listener(snapshot, reason);
      } catch (error) {
        options.onError?.(error, 'scene-content-listener', 'runtime');
      }
    });
    options.onSnapshot?.(snapshot, reason);
    return snapshot;
  };

  const detachLayer = (record: MutableSceneContentRecord): void => {
    if (!record.layer) return;
    try {
      view.map?.remove?.(record.layer);
    } catch (error) {
      options.onError?.(error, 'scene-content-remove', record.definition.id);
    }
    if (ownLayers) {
      try {
        record.layer.destroy?.();
      } catch (error) {
        options.onError?.(error, 'scene-content-destroy', record.definition.id);
      }
    }
    record.layer = null;
  };

  const releaseAdmission = (record: MutableSceneContentRecord): void => {
    if (record.resourceId) budget.release(record.resourceId);
    record.resourceId = null;
    record.admitted = false;
  };

  const cancelRecord = (record: MutableSceneContentRecord): void => {
    record.controller?.abort();
    record.controller = null;
    record.queued = false;
  };

  const applyVisibility = (record: MutableSceneContentRecord): void => {
    const visible = desiredVisible(record, active, scale);
    if (record.layer) {
      applyLayerPresentation(record.layer, record.definition, visible);
      record.status = visible ? 'ready' : 'hidden';
    }
  };

  const enqueue = (record: MutableSceneContentRecord): boolean => {
    if (disposed || record.queued || record.status === 'loading' || record.layer) return false;
    if (record.attempts >= maximumAttempts && record.status === 'failed') return false;
    record.queued = true;
    record.status = 'queued';
    queue.push(record.definition.id);
    queue.sort((leftId, rightId) => {
      const left = records.get(leftId)?.definition.priority ?? 'visible';
      const right = records.get(rightId)?.definition.priority ?? 'visible';
      return PRIORITY_WEIGHT[right] - PRIORITY_WEIGHT[left] || leftId.localeCompare(rightId);
    });
    return true;
  };

  const ensureAdmission = (record: MutableSceneContentRecord): boolean => {
    if (record.admitted) return true;
    const request = resourceRequestFor(record.definition);
    const admission = budget.admit(request);
    record.admissionReason = admission.reason;
    record.admitted = admission.admitted;
    record.resourceId = admission.admitted ? request.id : null;
    if (!admission.admitted) record.status = 'blocked';

    admission.evicted.forEach((resourceId) => {
      const evicted = [...records.values()].find((candidate) => candidate.resourceId === resourceId);
      if (!evicted) return;
      evicted.resourceId = null;
      evicted.admitted = false;
      evicted.admissionReason = 'lower-priority';
      if (evicted.layer) evicted.layer.visible = false;
      evicted.status = 'blocked';
    });
    return admission.admitted;
  };

  const loadRecord = async (id: string): Promise<void> => {
    const record = records.get(id);
    if (!record || disposed) return;
    record.queued = false;
    if (!shouldLoad(record, active, scale)) {
      record.status = record.layer ? 'hidden' : 'registered';
      return;
    }
    if (!ensureAdmission(record)) return;

    const controller = new AbortController();
    record.controller = controller;
    record.status = 'loading';
    record.attempts += 1;
    record.lastError = null;
    inFlight += 1;
    emit('load-start');

    try {
      const layer = await layerFactory({ signal: controller.signal, definition: record.definition });
      if (disposed || controller.signal.aborted || records.get(id) !== record) {
        if (ownLayers) layer.destroy?.();
        return;
      }
      record.layer = layer;
      applyLayerPresentation(layer, record.definition, desiredVisible(record, active, scale));
      view.map?.add?.(layer);
      if (typeof layer.load === 'function' && layer.loaded !== true) await layer.load();
      if (controller.signal.aborted || disposed) return;
      record.status = desiredVisible(record, active, scale) ? 'ready' : 'hidden';
      record.lastError = null;
      emit('load-success');
    } catch (error) {
      if (controller.signal.aborted || disposed) {
        record.status = record.layer ? 'hidden' : 'registered';
      } else {
        record.lastError = error;
        record.status = 'failed';
        releaseAdmission(record);
        options.onError?.(error, 'scene-content-load', id);
        emit('load-failure');
      }
    } finally {
      record.controller = null;
      inFlight = Math.max(0, inFlight - 1);
    }
  };

  const drain = async (): Promise<void> => {
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, async () => {
      while (!disposed) {
        const id = queue.shift();
        if (!id) return;
        await loadRecord(id);
      }
    });
    await Promise.all(workers);
  };

  const scheduleDrain = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    drainPromise = drain().finally(() => {
      drainPromise = null;
      if (!disposed && queue.length > 0) void scheduleDrain();
    });
    return drainPromise;
  };

  const register = (definition: SceneContentDefinition): SceneContentSnapshot => {
    if (disposed) return buildSnapshot();
    const normalized = normalizeDefinition(definition);
    const existing = records.get(normalized.id);
    if (existing) {
      cancelRecord(existing);
      releaseAdmission(existing);
      existing.definition = normalized;
      existing.lastError = null;
      existing.attempts = 0;
      existing.status = existing.layer ? 'ready' : 'registered';
      if (existing.layer) applyVisibility(existing);
    } else {
      records.set(normalized.id, {
        definition: normalized,
        status: 'registered',
        layer: null,
        controller: null,
        admitted: false,
        admissionReason: null,
        resourceId: null,
        attempts: 0,
        lastError: null,
        queued: false,
      });
    }
    emit(existing ? 'register-update' : 'register');
    return buildSnapshot();
  };

  const registerMany = (definitions: readonly SceneContentDefinition[]): SceneContentSnapshot => {
    definitions.forEach((definition) => register(definition));
    return emit('register-many');
  };

  const unregister = (idInput: string): boolean => {
    const id = normalizedId(idInput);
    const record = records.get(id);
    if (!record) return false;
    cancelRecord(record);
    releaseAdmission(record);
    detachLayer(record);
    record.status = 'disposed';
    records.delete(id);
    const queueIndex = queue.indexOf(id);
    if (queueIndex >= 0) queue.splice(queueIndex, 1);
    emit('unregister');
    return true;
  };

  const setActive = (nextActive: boolean): SceneContentSnapshot => {
    if (disposed) return buildSnapshot();
    active = nextActive;
    records.forEach((record) => applyVisibility(record));
    emit(active ? 'activate' : 'deactivate');
    if (active) void reconcile('activate');
    return buildSnapshot();
  };

  const setVisibility = (idInput: string, visible: boolean): SceneContentSnapshot => {
    const id = normalizedId(idInput);
    const record = records.get(id);
    if (!record || disposed) return buildSnapshot();
    record.definition = Object.freeze({ ...record.definition, visible });
    applyVisibility(record);
    if (visible && shouldLoad(record, active, scale)) {
      enqueue(record);
      void scheduleDrain();
    }
    return emit('visibility');
  };

  const setScale = (value: unknown): SceneContentSnapshot => {
    const nextScale = finiteNonNegative(value, 0);
    if (nextScale === scale || disposed) return buildSnapshot();
    scale = nextScale;
    records.forEach((record) => applyVisibility(record));
    void reconcile('scale');
    return emit('scale');
  };

  const reconcile = async (reason = 'reconcile'): Promise<SceneContentSnapshot> => {
    if (disposed) return buildSnapshot();
    records.forEach((record) => {
      applyVisibility(record);
      if (shouldLoad(record, active, scale) && !record.layer) enqueue(record);
    });
    emit(`${reason}:queued`);
    await scheduleDrain();
    records.forEach((record) => applyVisibility(record));
    return emit(`${reason}:complete`);
  };

  const retry = async (idInput: string): Promise<boolean> => {
    const id = normalizedId(idInput);
    const record = records.get(id);
    if (!record || disposed || record.status !== 'failed') return false;
    record.attempts = 0;
    record.lastError = null;
    record.status = 'registered';
    enqueue(record);
    await scheduleDrain();
    return record.status === 'ready' || record.status === 'hidden';
  };

  const updateBudget = (limits: Partial<SceneBudgetLimits>): SceneContentSnapshot => {
    if (disposed) return buildSnapshot();
    const evicted = budget.updateLimits(limits);
    evicted.forEach((resourceId) => {
      const record = [...records.values()].find((candidate) => candidate.resourceId === resourceId);
      if (!record) return;
      record.resourceId = null;
      record.admitted = false;
      record.admissionReason = 'lower-priority';
      if (record.layer) record.layer.visible = false;
      record.status = 'blocked';
    });
    void reconcile('budget');
    return emit('budget-update');
  };

  const subscribe = (listener: (snapshot: SceneContentSnapshot, reason: string) => void): (() => boolean) => {
    if (disposed) return () => false;
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    active = false;
    queue.length = 0;
    records.forEach((record) => {
      cancelRecord(record);
      releaseAdmission(record);
      detachLayer(record);
      record.status = 'disposed';
    });
    budget.clear();
    listeners.clear();
  };

  return Object.freeze({
    register,
    registerMany,
    unregister,
    setActive,
    setVisibility,
    setScale,
    updateBudget,
    reconcile,
    retry,
    getSnapshot: buildSnapshot,
    subscribe,
    dispose,
  });
};