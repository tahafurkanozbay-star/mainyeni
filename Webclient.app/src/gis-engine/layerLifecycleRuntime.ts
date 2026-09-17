import { assertAllowedArcGisResourceUrl } from './serviceCapabilityRuntime';

export const GIS_LAYER_STATE = Object.freeze({
  REGISTERED: 'registered',
  CREATING: 'creating',
  DETACHED: 'detached',
  ATTACHING: 'attaching',
  ATTACHED: 'attached',
  SUSPENDING: 'suspending',
  SUSPENDED: 'suspended',
  EVICTING: 'evicting',
  EVICTED: 'evicted',
  FAILED: 'failed',
  DISPOSED: 'disposed',
} as const);

export type GisLayerState = typeof GIS_LAYER_STATE[keyof typeof GIS_LAYER_STATE];

export interface LayerLifecycleRuntimeErrorDetails {
  code?: string;
  layerId?: string | null;
  cause?: unknown;
}

export class LayerLifecycleRuntimeError extends Error {
  readonly code: string;
  readonly layerId: string | null;
  override readonly cause: unknown;

  constructor(message: string, details: LayerLifecycleRuntimeErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'LayerLifecycleRuntimeError';
    this.code = details.code ?? 'LAYER_LIFECYCLE_ERROR';
    this.layerId = details.layerId ?? null;
    this.cause = details.cause;
  }
}

export interface LayerLifecycleViewLike extends Record<string, unknown> {
  id?: unknown;
  uid?: unknown;
  type?: unknown;
  viewType?: unknown;
}

export interface LayerLifecycleDescriptor extends Record<string, unknown> {
  id?: unknown;
  layerId?: unknown;
  resourceUrl?: unknown;
  url?: unknown;
  instance?: unknown;
  layer?: unknown;
  visible?: boolean;
  pinned?: boolean;
  priority?: number;
  estimatedBytes?: number;
  adapters?: Partial<LayerLifecycleAdapters>;
}

export interface LayerLifecycleAdapterContext extends Readonly<Record<string, unknown>> {
  readonly layerId: string;
}

export interface LayerLifecycleAttachContext extends LayerLifecycleAdapterContext {
  readonly signal?: AbortSignal;
}

export interface LayerLifecycleDetachContext extends LayerLifecycleAdapterContext {
  readonly viewKey: string | null;
  readonly reason: string;
}

export interface LayerLifecycleVisibilityContext extends LayerLifecycleAdapterContext {
  readonly reason: string;
}

export interface LayerLifecycleSuspendContext extends LayerLifecycleAdapterContext {
  readonly viewKey: string | null;
  readonly reason: string;
}

export interface LayerLifecycleAdapters {
  create: (descriptor: Readonly<LayerLifecycleDescriptor>) => Promise<unknown> | unknown;
  attach: (
    instance: unknown,
    view: unknown,
    context: LayerLifecycleAttachContext,
  ) => Promise<void> | void;
  detach: (
    instance: unknown,
    context: LayerLifecycleDetachContext,
  ) => Promise<void> | void;
  destroy: (
    instance: unknown,
    context: LayerLifecycleVisibilityContext,
  ) => Promise<void> | void;
  setVisible: (
    instance: unknown,
    visible: boolean,
    context: LayerLifecycleVisibilityContext,
  ) => Promise<void> | void;
  suspend: (
    instance: unknown,
    context: LayerLifecycleSuspendContext,
  ) => Promise<void> | void;
  resume: (
    instance: unknown,
    context: LayerLifecycleSuspendContext,
  ) => Promise<void> | void;
}

export interface LayerLifecycleEvent extends Readonly<Record<string, unknown>> {
  readonly type: string;
  readonly timestamp: number;
  readonly layerId: string | null;
  readonly state: GisLayerState | null;
}

export interface LayerLifecycleRuntimeConfiguration {
  maxResidentLayers?: number;
  maxResidentBytes?: number;
  maxVisibleLayers?: number;
  defaultEstimatedBytes?: number;
  idleTtlMs?: number;
  now?: () => number;
  adapters?: Partial<LayerLifecycleAdapters>;
  onEvent?: (event: Readonly<LayerLifecycleEvent>) => void;
  onListenerError?: (error: unknown, event: Readonly<Record<string, unknown>>) => void;
}

export interface LayerLifecycleEntrySnapshot {
  readonly id: string;
  readonly resourceUrl: string | null;
  readonly state: GisLayerState;
  readonly visible: boolean;
  readonly pinned: boolean;
  readonly priority: number;
  readonly estimatedBytes: number;
  readonly ownerCount: number;
  readonly owners: readonly string[];
  readonly resident: boolean;
  readonly attachedViewKey: string | null;
  readonly createdAt: number;
  readonly lastAccessAt: number;
  readonly lastStateChangeAt: number;
  readonly failureCount: number;
  readonly lastErrorCode: string | null;
}

export interface LayerLifecycleMetrics {
  registered: number;
  created: number;
  attached: number;
  detached: number;
  suspended: number;
  resumed: number;
  evicted: number;
  disposed: number;
  failedTransitions: number;
  retains: number;
  releases: number;
  budgetSweeps: number;
  budgetEvictions: number;
  visibilityDemotions: number;
}

export interface LayerLifecycleLimits {
  readonly maxResidentLayers: number;
  readonly maxResidentBytes: number;
  readonly maxVisibleLayers: number;
  readonly idleTtlMs: number;
}

export interface LayerLifecycleSnapshot {
  readonly destroyed: boolean;
  readonly layerCount: number;
  readonly residentLayers: number;
  readonly residentBytes: number;
  readonly visibleLayers: number;
  readonly limits: LayerLifecycleLimits;
  readonly metrics: Readonly<LayerLifecycleMetrics>;
  readonly layers: readonly LayerLifecycleEntrySnapshot[];
  readonly listenerCount: number;
}

export interface LayerLifecycleSweepOptions {
  reason?: string;
  aggressive?: boolean;
}

export interface LayerLifecycleSweepResult {
  readonly evicted: number;
  readonly residentLayers: number;
  readonly residentBytes: number;
}

export interface LayerLifecycleEvictOptions {
  force?: boolean;
  reason?: string;
}

export interface LayerLifecycleAttachOptions {
  signal?: AbortSignal;
  visible?: boolean;
}

export interface LayerLifecycleVisibilityOptions {
  reason?: string;
}

export interface LayerLifecycleResumeOptions extends LayerLifecycleVisibilityOptions {
  visible?: boolean;
}

export interface LayerLifecycleBudgetUpdate {
  maxResidentLayers?: number;
  maxResidentBytes?: number;
  maxBytes?: number;
  maxVisibleLayers?: number;
  idleTtlMs?: number;
}

export interface LayerLifecycleRuntime {
  registerLayer: (layerId: unknown, descriptor?: LayerLifecycleDescriptor) => LayerLifecycleEntrySnapshot;
  retain: (layerId: unknown, ownerId: unknown) => () => boolean;
  release: (layerId: unknown, ownerId: unknown) => boolean;
  ensureResident: (layerId: unknown) => Promise<unknown>;
  attach: (layerId: unknown, view: unknown, options?: LayerLifecycleAttachOptions) => Promise<unknown>;
  detach: (layerId: unknown, reason?: string) => Promise<boolean>;
  setVisible: (layerId: unknown, visible: unknown, options?: LayerLifecycleVisibilityOptions) => Promise<boolean>;
  suspend: (layerId: unknown, reason?: string) => Promise<boolean>;
  resume: (layerId: unknown, options?: LayerLifecycleResumeOptions) => Promise<boolean>;
  evict: (layerId: unknown, options?: LayerLifecycleEvictOptions) => Promise<boolean>;
  dispose: (layerId: unknown, options?: LayerLifecycleVisibilityOptions) => Promise<boolean>;
  sweep: (options?: LayerLifecycleSweepOptions) => Promise<LayerLifecycleSweepResult>;
  updateBudgets: (update?: LayerLifecycleBudgetUpdate) => Promise<LayerLifecycleSweepResult>;
  touch: (layerId: unknown) => LayerLifecycleEntrySnapshot;
  getLayer: (layerId: unknown) => LayerLifecycleEntrySnapshot | null;
  subscribe: (listener: (event: Readonly<LayerLifecycleEvent>) => void) => () => boolean;
  getSnapshot: () => LayerLifecycleSnapshot;
  destroy: () => Promise<void>;
}

interface InternalLayerEntry {
  id: string;
  resourceUrl: string | null;
  descriptor: LayerLifecycleDescriptor;
  state: GisLayerState;
  instance: unknown | null;
  owners: Set<string>;
  visible: boolean;
  pinned: boolean;
  priority: number;
  estimatedBytes: number;
  attachedViewKey: string | null;
  createdAt: number;
  lastAccessAt: number;
  lastStateChangeAt: number;
  failureCount: number;
  lastError: LayerLifecycleRuntimeError | null;
  transition: Promise<unknown> | null;
}

interface EventBus {
  emit: (event: Readonly<LayerLifecycleEvent>) => void;
  subscribe: (listener: (event: Readonly<LayerLifecycleEvent>) => void) => () => boolean;
  clear: () => void;
  size: () => number;
}

const DEFAULTS = Object.freeze({
  maxResidentLayers: 16,
  maxResidentBytes: 96 * 1024 * 1024,
  maxVisibleLayers: 12,
  defaultEstimatedBytes: 1024 * 1024,
  idleTtlMs: 2 * 60 * 1000,
});

const finite = (value: unknown, fallback: number | null = null): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : (fallback ?? 0);
};

const positiveInteger = (
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const nonNegative = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
};

const record = (value: unknown): Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const normalizeLayerId = (value: unknown): string => {
  const source = record(value);
  const raw = value !== null && typeof value === 'object' ? source.id ?? source.layerId : value;
  const id = String(raw ?? '').trim();
  if (!id) {
    throw new LayerLifecycleRuntimeError('A stable GIS layer id is required.', {
      code: 'INVALID_LAYER_ID',
    });
  }
  return id;
};

const normalizeOwner = (value: unknown): string => {
  const owner = String(value ?? '').trim();
  if (!owner) {
    throw new LayerLifecycleRuntimeError('Layer ownership requires a stable owner id.', {
      code: 'INVALID_OWNER_ID',
    });
  }
  return owner;
};

const viewIdentity = (view: unknown): string | null => {
  if (view === null || view === undefined) return null;
  if (typeof view === 'string' || typeof view === 'number') return String(view);
  const source = record(view);
  return String(source.id ?? source.uid ?? source.type ?? source.viewType ?? 'anonymous-view');
};

const createEventBus = (
  onListenerError: LayerLifecycleRuntimeConfiguration['onListenerError'],
): EventBus => {
  const listeners = new Set<(event: Readonly<LayerLifecycleEvent>) => void>();
  return {
    emit(event) {
      [...listeners].forEach((listener) => {
        try {
          listener(event);
        } catch (error: unknown) {
          onListenerError?.(error, event);
        }
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
    },
    size() {
      return listeners.size;
    },
  };
};

const defaultAdapters: Readonly<LayerLifecycleAdapters> = Object.freeze({
  create: async (descriptor) => descriptor.instance ?? descriptor.layer ?? { id: descriptor.id },
  attach: async () => undefined,
  detach: async () => undefined,
  destroy: async () => undefined,
  setVisible: async (instance, visible) => {
    if (instance && typeof instance === 'object' && 'visible' in instance) {
      (instance as { visible?: boolean }).visible = visible;
    }
  },
  suspend: async () => undefined,
  resume: async () => undefined,
});

const cloneEntry = (entry: InternalLayerEntry): LayerLifecycleEntrySnapshot => Object.freeze({
  id: entry.id,
  resourceUrl: entry.resourceUrl,
  state: entry.state,
  visible: entry.visible,
  pinned: entry.pinned,
  priority: entry.priority,
  estimatedBytes: entry.estimatedBytes,
  ownerCount: entry.owners.size,
  owners: Object.freeze([...entry.owners]),
  resident: Boolean(entry.instance),
  attachedViewKey: entry.attachedViewKey,
  createdAt: entry.createdAt,
  lastAccessAt: entry.lastAccessAt,
  lastStateChangeAt: entry.lastStateChangeAt,
  failureCount: entry.failureCount,
  lastErrorCode: entry.lastError?.code ?? null,
});

export const createLayerLifecycleRuntime = (
  configuration: LayerLifecycleRuntimeConfiguration = {},
): LayerLifecycleRuntime => {
  const clock = typeof configuration.now === 'function' ? configuration.now : () => Date.now();
  const eventBus = createEventBus(configuration.onListenerError);
  const layers = new Map<string, InternalLayerEntry>();
  let destroyed = false;
  let maxResidentLayers = positiveInteger(
    configuration.maxResidentLayers,
    DEFAULTS.maxResidentLayers,
    1000,
  );
  let maxResidentBytes = positiveInteger(
    configuration.maxResidentBytes,
    DEFAULTS.maxResidentBytes,
    4 * 1024 * 1024 * 1024,
  );
  let maxVisibleLayers = positiveInteger(
    configuration.maxVisibleLayers,
    DEFAULTS.maxVisibleLayers,
    1000,
  );
  let idleTtlMs = nonNegative(configuration.idleTtlMs, DEFAULTS.idleTtlMs);
  const metrics: LayerLifecycleMetrics = {
    registered: 0,
    created: 0,
    attached: 0,
    detached: 0,
    suspended: 0,
    resumed: 0,
    evicted: 0,
    disposed: 0,
    failedTransitions: 0,
    retains: 0,
    releases: 0,
    budgetSweeps: 0,
    budgetEvictions: 0,
    visibilityDemotions: 0,
  };

  const assertActive = (): void => {
    if (destroyed) {
      throw new LayerLifecycleRuntimeError('Layer lifecycle runtime has been destroyed.', {
        code: 'RUNTIME_DESTROYED',
      });
    }
  };

  const emit = (
    type: string,
    entry: InternalLayerEntry | null,
    details: Readonly<Record<string, unknown>> = {},
  ): Readonly<LayerLifecycleEvent> => {
    const detailLayerId = typeof details.layerId === 'string' ? details.layerId : null;
    const event: Readonly<LayerLifecycleEvent> = Object.freeze({
      type,
      timestamp: clock(),
      layerId: entry?.id ?? detailLayerId,
      state: entry?.state ?? null,
      ...details,
    });
    eventBus.emit(event);
    try {
      configuration.onEvent?.(event);
    } catch (error: unknown) {
      configuration.onListenerError?.(error, event);
    }
    return event;
  };

  const requireEntry = (layerId: unknown): InternalLayerEntry => {
    const id = normalizeLayerId(layerId);
    const entry = layers.get(id);
    if (!entry || entry.state === GIS_LAYER_STATE.DISPOSED) {
      throw new LayerLifecycleRuntimeError('GIS layer is not registered.', {
        code: 'LAYER_NOT_REGISTERED',
        layerId: id,
      });
    }
    return entry;
  };

  const adaptersFor = (entry: InternalLayerEntry): LayerLifecycleAdapters => ({
    ...defaultAdapters,
    ...configuration.adapters,
    ...entry.descriptor.adapters,
  });

  const setState = (
    entry: InternalLayerEntry,
    state: GisLayerState,
    details: Readonly<Record<string, unknown>> = {},
  ): void => {
    const previous = entry.state;
    entry.state = state;
    entry.lastStateChangeAt = clock();
    entry.lastAccessAt = entry.lastStateChangeAt;
    emit('layer-state', entry, {
      previous,
      next: state,
      ...details,
    });
  };

  const failTransition = (
    entry: InternalLayerEntry,
    error: unknown,
    operation: string,
  ): LayerLifecycleRuntimeError => {
    const wrapped = error instanceof LayerLifecycleRuntimeError
      ? error
      : new LayerLifecycleRuntimeError(`Layer lifecycle ${operation} failed.`, {
        code: 'LAYER_TRANSITION_FAILED',
        layerId: entry.id,
        cause: error,
      });
    entry.failureCount += 1;
    entry.lastError = wrapped;
    metrics.failedTransitions += 1;
    setState(entry, GIS_LAYER_STATE.FAILED, { operation, error: wrapped });
    return wrapped;
  };

  const serialize = <T>(
    entry: InternalLayerEntry,
    operation: string,
    task: () => Promise<T> | T,
  ): Promise<T> => {
    const previous = entry.transition ?? Promise.resolve();
    let current: Promise<T>;
    current = previous
      .catch(() => undefined)
      .then(async () => {
        if (entry.state === GIS_LAYER_STATE.DISPOSED) {
          throw new LayerLifecycleRuntimeError('Disposed GIS layer cannot transition.', {
            code: 'LAYER_DISPOSED',
            layerId: entry.id,
          });
        }
        try {
          return await task();
        } catch (error: unknown) {
          throw failTransition(entry, error, operation);
        }
      })
      .finally(() => {
        if (entry.transition === current) entry.transition = null;
      });
    entry.transition = current;
    return current;
  };

  const createResidentUnsafe = async (entry: InternalLayerEntry): Promise<unknown> => {
    if (entry.instance) return entry.instance;
    setState(entry, GIS_LAYER_STATE.CREATING);
    const adapters = adaptersFor(entry);
    const instance = await adapters.create({
      ...entry.descriptor,
      id: entry.id,
      resourceUrl: entry.resourceUrl,
    });
    if (!instance) {
      throw new LayerLifecycleRuntimeError('Layer create adapter returned no instance.', {
        code: 'EMPTY_LAYER_INSTANCE',
        layerId: entry.id,
      });
    }
    entry.instance = instance;
    entry.lastError = null;
    metrics.created += 1;
    setState(entry, GIS_LAYER_STATE.DETACHED);
    emit('layer-created', entry, { estimatedBytes: entry.estimatedBytes });
    return instance;
  };

  const detachUnsafe = async (entry: InternalLayerEntry, reason = 'detach'): Promise<boolean> => {
    if (!entry.instance) return false;
    if (
      entry.state !== GIS_LAYER_STATE.ATTACHED
      && entry.state !== GIS_LAYER_STATE.SUSPENDED
      && entry.attachedViewKey === null
    ) {
      entry.visible = false;
      return false;
    }
    const adapters = adaptersFor(entry);
    await adapters.detach(entry.instance, {
      layerId: entry.id,
      viewKey: entry.attachedViewKey,
      reason,
    });
    entry.visible = false;
    entry.attachedViewKey = null;
    metrics.detached += 1;
    setState(entry, GIS_LAYER_STATE.DETACHED, { reason });
    emit('layer-detached', entry, { reason });
    return true;
  };

  const evictUnsafe = async (
    entry: InternalLayerEntry,
    options: LayerLifecycleEvictOptions = {},
  ): Promise<boolean> => {
    if (!entry.instance) {
      if (entry.state !== GIS_LAYER_STATE.EVICTED) setState(entry, GIS_LAYER_STATE.EVICTED);
      return false;
    }
    if (!options.force && (entry.pinned || entry.owners.size > 0)) return false;
    const reason = options.reason ?? 'evict';
    setState(entry, GIS_LAYER_STATE.EVICTING, { reason });
    if (entry.attachedViewKey !== null || entry.state === GIS_LAYER_STATE.SUSPENDED) {
      await detachUnsafe(entry, reason);
      setState(entry, GIS_LAYER_STATE.EVICTING, { reason });
    }
    const instance = entry.instance;
    entry.instance = null;
    entry.attachedViewKey = null;
    entry.visible = false;
    await adaptersFor(entry).destroy(instance, { layerId: entry.id, reason });
    metrics.evicted += 1;
    setState(entry, GIS_LAYER_STATE.EVICTED, { reason });
    emit('layer-evicted', entry, { reason });
    return true;
  };

  const residentEntries = (): InternalLayerEntry[] => [...layers.values()].filter((entry) => Boolean(entry.instance));

  const residentBytes = (): number => residentEntries().reduce((sum, entry) => sum + entry.estimatedBytes, 0);

  const visibleEntries = (): InternalLayerEntry[] => [...layers.values()].filter((entry) => (
    Boolean(entry.instance)
    && entry.visible
    && (entry.state === GIS_LAYER_STATE.ATTACHED || entry.state === GIS_LAYER_STATE.SUSPENDED)
  ));

  const evictionCandidates = (nowValue = clock()): InternalLayerEntry[] => [...layers.values()]
    .filter((entry) => (
      Boolean(entry.instance)
      && !entry.pinned
      && entry.owners.size === 0
      && entry.state !== GIS_LAYER_STATE.CREATING
      && entry.state !== GIS_LAYER_STATE.ATTACHING
      && entry.state !== GIS_LAYER_STATE.EVICTING
    ))
    .sort((left, right) => {
      if (left.visible !== right.visible) return left.visible ? 1 : -1;
      if (left.priority !== right.priority) return right.priority - left.priority;
      const leftIdle = nowValue - left.lastAccessAt;
      const rightIdle = nowValue - right.lastAccessAt;
      if (leftIdle !== rightIdle) return rightIdle - leftIdle;
      return left.id.localeCompare(right.id);
    });

  const visibilityCandidates = (): InternalLayerEntry[] => visibleEntries()
    .filter((entry) => !entry.pinned && entry.owners.size === 0)
    .sort((left, right) => {
      if (left.priority !== right.priority) return right.priority - left.priority;
      if (left.lastAccessAt !== right.lastAccessAt) return left.lastAccessAt - right.lastAccessAt;
      return left.id.localeCompare(right.id);
    });

  const demoteVisibility = async (): Promise<number> => {
    let visible = visibleEntries();
    if (visible.length <= maxVisibleLayers) return 0;
    let changed = 0;
    const candidates = visibilityCandidates();
    for (const entry of candidates) {
      if (visible.length <= maxVisibleLayers) break;
      if (!entry.instance) continue;
      await adaptersFor(entry).setVisible(entry.instance, false, {
        layerId: entry.id,
        reason: 'visible-layer-budget',
      });
      entry.visible = false;
      entry.lastAccessAt = clock();
      metrics.visibilityDemotions += 1;
      changed += 1;
      emit('layer-visibility-demoted', entry, { maxVisibleLayers });
      visible = visibleEntries();
    }
    return changed;
  };

  const sweep = async (options: LayerLifecycleSweepOptions = {}): Promise<LayerLifecycleSweepResult> => {
    assertActive();
    metrics.budgetSweeps += 1;
    const nowValue = clock();
    const reason = options.reason ?? 'budget-sweep';
    await demoteVisibility();
    let residents = residentEntries().length;
    let bytes = residentBytes();
    let evicted = 0;
    const candidates = evictionCandidates(nowValue);
    for (const entry of candidates) {
      const idleExpired = idleTtlMs > 0 && nowValue - entry.lastAccessAt >= idleTtlMs;
      const overCount = residents > maxResidentLayers;
      const overBytes = bytes > maxResidentBytes;
      if (!idleExpired && !overCount && !overBytes && options.aggressive !== true) continue;
      const didEvict = await serialize(entry, 'budget-evict', () => evictUnsafe(entry, { reason }));
      if (didEvict) {
        residents -= 1;
        bytes = Math.max(0, bytes - entry.estimatedBytes);
        evicted += 1;
        metrics.budgetEvictions += 1;
      }
      if (
        options.aggressive !== true
        && residents <= maxResidentLayers
        && bytes <= maxResidentBytes
      ) {
        const remainingIdle = candidates.some((candidate) => (
          Boolean(candidate.instance)
          && !candidate.pinned
          && candidate.owners.size === 0
          && idleTtlMs > 0
          && nowValue - candidate.lastAccessAt >= idleTtlMs
        ));
        if (!remainingIdle) break;
      }
    }
    emit('layer-budget-sweep', null, {
      reason,
      evicted,
      residentLayers: residents,
      residentBytes: bytes,
    });
    return Object.freeze({ evicted, residentLayers: residents, residentBytes: bytes });
  };

  const registerLayer = (
    layerId: unknown,
    descriptor: LayerLifecycleDescriptor = {},
  ): LayerLifecycleEntrySnapshot => {
    assertActive();
    const id = normalizeLayerId(layerId);
    const urlInput = descriptor.resourceUrl ?? descriptor.url;
    const resourceUrl = urlInput ? assertAllowedArcGisResourceUrl(urlInput) : null;
    const existing = layers.get(id);
    if (existing) {
      if (
        existing.resourceUrl
        && resourceUrl
        && existing.resourceUrl !== resourceUrl
        && existing.instance
      ) {
        throw new LayerLifecycleRuntimeError('A resident layer resource URL cannot be replaced in place.', {
          code: 'RESOURCE_URL_CHANGE_REQUIRES_EVICTION',
          layerId: id,
        });
      }
      existing.resourceUrl = resourceUrl ?? existing.resourceUrl;
      existing.descriptor = { ...existing.descriptor, ...descriptor, id };
      existing.priority = finite(descriptor.priority, existing.priority);
      existing.pinned = descriptor.pinned === undefined ? existing.pinned : descriptor.pinned === true;
      existing.estimatedBytes = positiveInteger(
        descriptor.estimatedBytes,
        existing.estimatedBytes,
        1024 * 1024 * 1024,
      );
      existing.lastAccessAt = clock();
      emit('layer-registration-updated', existing);
      return cloneEntry(existing);
    }

    const timestamp = clock();
    const instance = descriptor.instance ?? null;
    const entry: InternalLayerEntry = {
      id,
      resourceUrl,
      descriptor: { ...descriptor, id },
      state: instance ? GIS_LAYER_STATE.DETACHED : GIS_LAYER_STATE.REGISTERED,
      instance,
      owners: new Set<string>(),
      visible: descriptor.visible === true,
      pinned: descriptor.pinned === true,
      priority: finite(descriptor.priority, 100),
      estimatedBytes: positiveInteger(
        descriptor.estimatedBytes,
        configuration.defaultEstimatedBytes ?? DEFAULTS.defaultEstimatedBytes,
        1024 * 1024 * 1024,
      ),
      attachedViewKey: null,
      createdAt: timestamp,
      lastAccessAt: timestamp,
      lastStateChangeAt: timestamp,
      failureCount: 0,
      lastError: null,
      transition: null,
    };
    layers.set(id, entry);
    metrics.registered += 1;
    emit('layer-registered', entry, { resourceUrl, estimatedBytes: entry.estimatedBytes });
    return cloneEntry(entry);
  };

  const retain = (layerId: unknown, ownerId: unknown): (() => boolean) => {
    assertActive();
    const entry = requireEntry(layerId);
    const owner = normalizeOwner(ownerId);
    const before = entry.owners.size;
    entry.owners.add(owner);
    entry.lastAccessAt = clock();
    if (entry.owners.size !== before) {
      metrics.retains += 1;
      emit('layer-retained', entry, { ownerId: owner });
    }
    let released = false;
    return () => {
      if (released || destroyed) return false;
      released = true;
      const removed = entry.owners.delete(owner);
      entry.lastAccessAt = clock();
      if (removed) {
        metrics.releases += 1;
        emit('layer-released', entry, { ownerId: owner });
      }
      return removed;
    };
  };

  const release = (layerId: unknown, ownerId: unknown): boolean => {
    assertActive();
    const entry = requireEntry(layerId);
    const owner = normalizeOwner(ownerId);
    const removed = entry.owners.delete(owner);
    entry.lastAccessAt = clock();
    if (removed) {
      metrics.releases += 1;
      emit('layer-released', entry, { ownerId: owner });
    }
    return removed;
  };

  const ensureResident = (layerId: unknown): Promise<unknown> => {
    assertActive();
    const entry = requireEntry(layerId);
    return serialize(entry, 'create', () => createResidentUnsafe(entry));
  };

  const attach = (
    layerId: unknown,
    view: unknown,
    options: LayerLifecycleAttachOptions = {},
  ): Promise<unknown> => {
    assertActive();
    const entry = requireEntry(layerId);
    const viewKey = viewIdentity(view);
    if (!viewKey) {
      return Promise.reject(new LayerLifecycleRuntimeError('Layer attach requires a stable view identity.', {
        code: 'INVALID_VIEW',
        layerId: entry.id,
      }));
    }
    return serialize(entry, 'attach', async () => {
      await createResidentUnsafe(entry);
      if (entry.state === GIS_LAYER_STATE.ATTACHED && entry.attachedViewKey === viewKey) {
        entry.lastAccessAt = clock();
        return entry.instance;
      }
      if (entry.attachedViewKey !== null && entry.attachedViewKey !== viewKey) {
        await detachUnsafe(entry, 'view-switch');
      }
      setState(entry, GIS_LAYER_STATE.ATTACHING, { viewKey });
      const instance = entry.instance;
      if (!instance) {
        throw new LayerLifecycleRuntimeError('Resident layer disappeared before attach.', {
          code: 'MISSING_RESIDENT_INSTANCE',
          layerId: entry.id,
        });
      }
      const attachContext: LayerLifecycleAttachContext = options.signal === undefined
        ? { layerId: entry.id }
        : { layerId: entry.id, signal: options.signal };
      await adaptersFor(entry).attach(instance, view, attachContext);
      entry.attachedViewKey = viewKey;
      entry.visible = options.visible === undefined ? true : options.visible === true;
      await adaptersFor(entry).setVisible(instance, entry.visible, {
        layerId: entry.id,
        reason: 'attach',
      });
      entry.lastError = null;
      metrics.attached += 1;
      setState(entry, GIS_LAYER_STATE.ATTACHED, { viewKey });
      emit('layer-attached', entry, { viewKey, visible: entry.visible });
      return instance;
    }).then(async (instance) => {
      await sweep({ reason: 'post-attach' });
      return instance;
    });
  };

  const detach = (layerId: unknown, reason = 'manual'): Promise<boolean> => {
    assertActive();
    const entry = requireEntry(layerId);
    return serialize(entry, 'detach', () => detachUnsafe(entry, reason));
  };

  const setVisible = (
    layerId: unknown,
    visible: unknown,
    options: LayerLifecycleVisibilityOptions = {},
  ): Promise<boolean> => {
    assertActive();
    const entry = requireEntry(layerId);
    const nextVisible = visible === true;
    const reason = options.reason ?? 'manual';
    return serialize(entry, 'visibility', async () => {
      await createResidentUnsafe(entry);
      if (!entry.instance) return false;
      await adaptersFor(entry).setVisible(entry.instance, nextVisible, {
        layerId: entry.id,
        reason,
      });
      entry.visible = nextVisible;
      entry.lastAccessAt = clock();
      emit('layer-visibility', entry, { visible: nextVisible, reason });
      return nextVisible;
    }).then(async (result) => {
      if (result) await demoteVisibility();
      return result;
    });
  };

  const suspend = (layerId: unknown, reason = 'pressure'): Promise<boolean> => {
    assertActive();
    const entry = requireEntry(layerId);
    return serialize(entry, 'suspend', async () => {
      if (!entry.instance) return false;
      if (entry.state === GIS_LAYER_STATE.SUSPENDED) return true;
      setState(entry, GIS_LAYER_STATE.SUSPENDING, { reason });
      await adaptersFor(entry).suspend(entry.instance, {
        layerId: entry.id,
        viewKey: entry.attachedViewKey,
        reason,
      });
      await adaptersFor(entry).setVisible(entry.instance, false, {
        layerId: entry.id,
        reason,
      });
      entry.visible = false;
      metrics.suspended += 1;
      setState(entry, GIS_LAYER_STATE.SUSPENDED, { reason });
      emit('layer-suspended', entry, { reason });
      return true;
    });
  };

  const resume = (
    layerId: unknown,
    options: LayerLifecycleResumeOptions = {},
  ): Promise<boolean> => {
    assertActive();
    const entry = requireEntry(layerId);
    return serialize(entry, 'resume', async () => {
      if (!entry.instance) await createResidentUnsafe(entry);
      if (entry.state !== GIS_LAYER_STATE.SUSPENDED) {
        entry.lastAccessAt = clock();
        return false;
      }
      if (!entry.instance) return false;
      const reason = options.reason ?? 'manual';
      await adaptersFor(entry).resume(entry.instance, {
        layerId: entry.id,
        viewKey: entry.attachedViewKey,
        reason,
      });
      const nextVisible = options.visible === undefined ? true : options.visible === true;
      await adaptersFor(entry).setVisible(entry.instance, nextVisible, {
        layerId: entry.id,
        reason,
      });
      entry.visible = nextVisible;
      metrics.resumed += 1;
      setState(
        entry,
        entry.attachedViewKey ? GIS_LAYER_STATE.ATTACHED : GIS_LAYER_STATE.DETACHED,
        { reason },
      );
      emit('layer-resumed', entry, { visible: nextVisible });
      return true;
    });
  };

  const evict = (
    layerId: unknown,
    options: LayerLifecycleEvictOptions = {},
  ): Promise<boolean> => {
    assertActive();
    const entry = requireEntry(layerId);
    return serialize(entry, 'evict', () => evictUnsafe(entry, options));
  };

  const dispose = (
    layerId: unknown,
    options: LayerLifecycleVisibilityOptions = {},
  ): Promise<boolean> => {
    assertActive();
    const entry = requireEntry(layerId);
    return serialize(entry, 'dispose', async () => {
      const reason = options.reason ?? 'dispose';
      await evictUnsafe(entry, { force: true, reason });
      entry.owners.clear();
      entry.descriptor = {};
      entry.lastError = null;
      entry.state = GIS_LAYER_STATE.DISPOSED;
      entry.lastStateChangeAt = clock();
      metrics.disposed += 1;
      layers.delete(entry.id);
      emit('layer-disposed', entry, { reason });
      return true;
    });
  };

  const updateBudgets = (
    next: LayerLifecycleBudgetUpdate = {},
  ): Promise<LayerLifecycleSweepResult> => {
    assertActive();
    maxResidentLayers = positiveInteger(next.maxResidentLayers, maxResidentLayers, 1000);
    maxResidentBytes = positiveInteger(
      next.maxResidentBytes ?? next.maxBytes,
      maxResidentBytes,
      4 * 1024 * 1024 * 1024,
    );
    maxVisibleLayers = positiveInteger(next.maxVisibleLayers, maxVisibleLayers, 1000);
    idleTtlMs = nonNegative(next.idleTtlMs, idleTtlMs);
    emit('layer-budgets-updated', null, {
      maxResidentLayers,
      maxResidentBytes,
      maxVisibleLayers,
      idleTtlMs,
    });
    return sweep({ reason: 'budget-update' });
  };

  const touch = (layerId: unknown): LayerLifecycleEntrySnapshot => {
    assertActive();
    const entry = requireEntry(layerId);
    entry.lastAccessAt = clock();
    return cloneEntry(entry);
  };

  const getLayer = (layerId: unknown): LayerLifecycleEntrySnapshot | null => {
    const id = normalizeLayerId(layerId);
    const entry = layers.get(id);
    return entry ? cloneEntry(entry) : null;
  };

  const snapshot = (): LayerLifecycleSnapshot => Object.freeze({
    destroyed,
    layerCount: layers.size,
    residentLayers: residentEntries().length,
    residentBytes: residentBytes(),
    visibleLayers: visibleEntries().length,
    limits: Object.freeze({
      maxResidentLayers,
      maxResidentBytes,
      maxVisibleLayers,
      idleTtlMs,
    }),
    metrics: Object.freeze({ ...metrics }),
    layers: Object.freeze(
      [...layers.values()]
        .map(cloneEntry)
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
    listenerCount: eventBus.size(),
  });

  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    const entries = [...layers.values()];
    for (const entry of entries) {
      try {
        if (entry.transition) await entry.transition.catch(() => undefined);
        await evictUnsafe(entry, { force: true, reason: 'runtime-destroy' });
      } catch (error: unknown) {
        configuration.onListenerError?.(error, {
          type: 'destroy-error',
          layerId: entry.id,
        });
      }
      entry.state = GIS_LAYER_STATE.DISPOSED;
      entry.owners.clear();
    }
    layers.clear();
    destroyed = true;
    eventBus.clear();
  };

  return Object.freeze({
    registerLayer,
    retain,
    release,
    ensureResident,
    attach,
    detach,
    setVisible,
    suspend,
    resume,
    evict,
    dispose,
    sweep,
    updateBudgets,
    touch,
    getLayer,
    subscribe: eventBus.subscribe,
    getSnapshot: snapshot,
    destroy,
  });
};
