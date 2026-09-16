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
});

export class LayerLifecycleRuntimeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LayerLifecycleRuntimeError';
    this.code = details.code || 'LAYER_LIFECYCLE_ERROR';
    this.layerId = details.layerId || null;
    this.cause = details.cause;
  }
}

const DEFAULTS = Object.freeze({
  maxResidentLayers: 16,
  maxResidentBytes: 96 * 1024 * 1024,
  maxVisibleLayers: 12,
  defaultEstimatedBytes: 1024 * 1024,
  idleTtlMs: 2 * 60 * 1000,
});

const finite = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = finite(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const nonNegative = (value, fallback = 0) => {
  const numeric = finite(value);
  return numeric !== null && numeric >= 0 ? numeric : fallback;
};

const normalizeLayerId = (value) => {
  const raw = typeof value === 'object' ? value?.id ?? value?.layerId : value;
  const id = String(raw ?? '').trim();
  if (!id) {
    throw new LayerLifecycleRuntimeError('A stable GIS layer id is required.', {
      code: 'INVALID_LAYER_ID',
    });
  }
  return id;
};

const normalizeOwner = (value) => {
  const owner = String(value ?? '').trim();
  if (!owner) {
    throw new LayerLifecycleRuntimeError('Layer ownership requires a stable owner id.', {
      code: 'INVALID_OWNER_ID',
    });
  }
  return owner;
};

const viewIdentity = (view) => {
  if (view === null || view === undefined) return null;
  if (typeof view === 'string' || typeof view === 'number') return String(view);
  return String(view.id ?? view.uid ?? view.type ?? view.viewType ?? 'anonymous-view');
};

const createEventBus = (onListenerError) => {
  const listeners = new Set();
  return {
    emit(event) {
      [...listeners].forEach((listener) => {
        try {
          listener(event);
        } catch (error) {
          onListenerError?.(error, event);
        }
      });
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
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

const defaultAdapters = Object.freeze({
  create: async (descriptor) => descriptor.instance || descriptor.layer || { id: descriptor.id },
  attach: async () => {},
  detach: async () => {},
  destroy: async () => {},
  setVisible: async (instance, visible) => {
    if (instance && typeof instance === 'object' && 'visible' in instance) instance.visible = visible;
  },
  suspend: async () => {},
  resume: async () => {},
});

const cloneEntry = (entry) => Object.freeze({
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
  lastErrorCode: entry.lastError?.code || null,
});

export const createLayerLifecycleRuntime = (configuration = {}) => {
  const clock = typeof configuration.now === 'function' ? configuration.now : () => Date.now();
  const eventBus = createEventBus(configuration.onListenerError);
  const layers = new Map();
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
  const metrics = {
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

  const assertActive = () => {
    if (destroyed) {
      throw new LayerLifecycleRuntimeError('Layer lifecycle runtime has been destroyed.', {
        code: 'RUNTIME_DESTROYED',
      });
    }
  };

  const emit = (type, entry, details = {}) => {
    const event = Object.freeze({
      type,
      timestamp: clock(),
      layerId: entry?.id || details.layerId || null,
      state: entry?.state || null,
      ...details,
    });
    eventBus.emit(event);
    try {
      configuration.onEvent?.(event);
    } catch (error) {
      configuration.onListenerError?.(error, event);
    }
    return event;
  };

  const requireEntry = (layerId) => {
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

  const adaptersFor = (entry) => ({
    ...defaultAdapters,
    ...(configuration.adapters || {}),
    ...(entry.descriptor.adapters || {}),
  });

  const setState = (entry, state, details = {}) => {
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

  const failTransition = (entry, error, operation) => {
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

  const serialize = (entry, operation, task) => {
    const previous = entry.transition || Promise.resolve();
    let current;
    current = previous
      .catch(() => {})
      .then(async () => {
        if (entry.state === GIS_LAYER_STATE.DISPOSED) {
          throw new LayerLifecycleRuntimeError('Disposed GIS layer cannot transition.', {
            code: 'LAYER_DISPOSED',
            layerId: entry.id,
          });
        }
        try {
          return await task();
        } catch (error) {
          throw failTransition(entry, error, operation);
        }
      })
      .finally(() => {
        if (entry.transition === current) entry.transition = null;
      });
    entry.transition = current;
    return current;
  };

  const createResidentUnsafe = async (entry) => {
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

  const detachUnsafe = async (entry, reason = 'detach') => {
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

  const evictUnsafe = async (entry, options = {}) => {
    if (!entry.instance) {
      if (entry.state !== GIS_LAYER_STATE.EVICTED) setState(entry, GIS_LAYER_STATE.EVICTED);
      return false;
    }
    if (!options.force && (entry.pinned || entry.owners.size > 0)) return false;
    setState(entry, GIS_LAYER_STATE.EVICTING, { reason: options.reason || 'evict' });
    if (entry.attachedViewKey !== null || entry.state === GIS_LAYER_STATE.SUSPENDED) {
      await detachUnsafe(entry, options.reason || 'evict');
      setState(entry, GIS_LAYER_STATE.EVICTING, { reason: options.reason || 'evict' });
    }
    const instance = entry.instance;
    entry.instance = null;
    entry.attachedViewKey = null;
    entry.visible = false;
    await adaptersFor(entry).destroy(instance, {
      layerId: entry.id,
      reason: options.reason || 'evict',
    });
    metrics.evicted += 1;
    setState(entry, GIS_LAYER_STATE.EVICTED, { reason: options.reason || 'evict' });
    emit('layer-evicted', entry, { reason: options.reason || 'evict' });
    return true;
  };

  const residentEntries = () => [...layers.values()].filter((entry) => Boolean(entry.instance));

  const residentBytes = () => residentEntries().reduce((sum, entry) => sum + entry.estimatedBytes, 0);

  const visibleEntries = () => [...layers.values()].filter((entry) => (
    entry.instance
    && entry.visible
    && (entry.state === GIS_LAYER_STATE.ATTACHED || entry.state === GIS_LAYER_STATE.SUSPENDED)
  ));

  const evictionCandidates = (nowValue = clock()) => [...layers.values()]
    .filter((entry) => (
      entry.instance
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

  const visibilityCandidates = () => visibleEntries()
    .filter((entry) => !entry.pinned && entry.owners.size === 0)
    .sort((left, right) => {
      if (left.priority !== right.priority) return right.priority - left.priority;
      if (left.lastAccessAt !== right.lastAccessAt) return left.lastAccessAt - right.lastAccessAt;
      return left.id.localeCompare(right.id);
    });

  const demoteVisibility = async () => {
    let visible = visibleEntries();
    if (visible.length <= maxVisibleLayers) return 0;
    let changed = 0;
    const candidates = visibilityCandidates();
    for (const entry of candidates) {
      if (visible.length <= maxVisibleLayers) break;
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

  const sweep = async (options = {}) => {
    assertActive();
    metrics.budgetSweeps += 1;
    const nowValue = clock();
    const reason = options.reason || 'budget-sweep';
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
          candidate.instance
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
    return Object.freeze({
      evicted,
      residentLayers: residents,
      residentBytes: bytes,
    });
  };

  const registerLayer = (layerId, descriptor = {}) => {
    assertActive();
    const id = normalizeLayerId(layerId);
    const resourceUrl = descriptor.resourceUrl || descriptor.url
      ? assertAllowedArcGisResourceUrl(descriptor.resourceUrl || descriptor.url)
      : null;
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
      existing.resourceUrl = resourceUrl || existing.resourceUrl;
      existing.descriptor = {
        ...existing.descriptor,
        ...descriptor,
        id,
      };
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
    const entry = {
      id,
      resourceUrl,
      descriptor: { ...descriptor, id },
      state: GIS_LAYER_STATE.REGISTERED,
      instance: descriptor.instance || null,
      owners: new Set(),
      visible: descriptor.visible === true,
      pinned: descriptor.pinned === true,
      priority: finite(descriptor.priority, 100),
      estimatedBytes: positiveInteger(
        descriptor.estimatedBytes,
        DEFAULTS.defaultEstimatedBytes,
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
    if (entry.instance) entry.state = GIS_LAYER_STATE.DETACHED;
    layers.set(id, entry);
    metrics.registered += 1;
    emit('layer-registered', entry, {
      resourceUrl,
      estimatedBytes: entry.estimatedBytes,
    });
    return cloneEntry(entry);
  };

  const retain = (layerId, ownerId) => {
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

  const release = (layerId, ownerId) => {
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

  const ensureResident = (layerId) => {
    assertActive();
    const entry = requireEntry(layerId);
    return serialize(entry, 'create', () => createResidentUnsafe(entry));
  };

  const attach = (layerId, view, options = {}) => {
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
      if (
        entry.state === GIS_LAYER_STATE.ATTACHED
        && entry.attachedViewKey === viewKey
      ) {
        entry.lastAccessAt = clock();
        return entry.instance;
      }
      if (entry.attachedViewKey !== null && entry.attachedViewKey !== viewKey) {
        await detachUnsafe(entry, 'view-switch');
      }
      setState(entry, GIS_LAYER_STATE.ATTACHING, { viewKey });
      await adaptersFor(entry).attach(entry.instance, view, {
        layerId: entry.id,
        signal: options.signal,
      });
      entry.attachedViewKey = viewKey;
      entry.visible = options.visible === undefined ? true : options.visible === true;
      await adaptersFor(entry).setVisible(entry.instance, entry.visible, {
        layerId: entry.id,
        reason: 'attach',
      });
      entry.lastError = null;
      metrics.attached += 1;
      setState(entry, GIS_LAYER_STATE.ATTACHED, { viewKey });
      emit('layer-attached', entry, { viewKey, visible: entry.visible });
      return entry.instance;
    }).then(async (instance) => {
      await sweep({ reason: 'post-attach' });
      return instance;
    });
  };

  const detach = (layerId, reason = 'manual') => {
    assertActive();
    const entry = requireEntry(layerId);
    return serialize(entry, 'detach', () => detachUnsafe(entry, reason));
  };

  const setVisible = (layerId, visible, options = {}) => {
    assertActive();
    const entry = requireEntry(layerId);
    const nextVisible = visible === true;
    return serialize(entry, 'visibility', async () => {
      await createResidentUnsafe(entry);
      await adaptersFor(entry).setVisible(entry.instance, nextVisible, {
        layerId: entry.id,
        reason: options.reason || 'manual',
      });
      entry.visible = nextVisible;
      entry.lastAccessAt = clock();
      emit('layer-visibility', entry, {
        visible: nextVisible,
        reason: options.reason || 'manual',
      });
      return nextVisible;
    }).then(async (result) => {
      if (result) await demoteVisibility();
      return result;
    });
  };

  const suspend = (layerId, reason = 'pressure') => {
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

  const resume = (layerId, options = {}) => {
    assertActive();
    const entry = requireEntry(layerId);
    return serialize(entry, 'resume', async () => {
      if (!entry.instance) await createResidentUnsafe(entry);
      if (entry.state !== GIS_LAYER_STATE.SUSPENDED) {
        entry.lastAccessAt = clock();
        return false;
      }
      await adaptersFor(entry).resume(entry.instance, {
        layerId: entry.id,
        viewKey: entry.attachedViewKey,
        reason: options.reason || 'manual',
      });
      const nextVisible = options.visible === undefined ? true : options.visible === true;
      await adaptersFor(entry).setVisible(entry.instance, nextVisible, {
        layerId: entry.id,
        reason: options.reason || 'manual',
      });
      entry.visible = nextVisible;
      metrics.resumed += 1;
      setState(
        entry,
        entry.attachedViewKey ? GIS_LAYER_STATE.ATTACHED : GIS_LAYER_STATE.DETACHED,
        { reason: options.reason || 'manual' },
      );
      emit('layer-resumed', entry, { visible: nextVisible });
      return true;
    });
  };

  const evict = (layerId, options = {}) => {
    assertActive();
    const entry = requireEntry(layerId);
    return serialize(entry, 'evict', () => evictUnsafe(entry, options));
  };

  const dispose = (layerId, options = {}) => {
    assertActive();
    const entry = requireEntry(layerId);
    return serialize(entry, 'dispose', async () => {
      await evictUnsafe(entry, {
        force: true,
        reason: options.reason || 'dispose',
      });
      entry.owners.clear();
      entry.descriptor = {};
      entry.lastError = null;
      entry.state = GIS_LAYER_STATE.DISPOSED;
      entry.lastStateChangeAt = clock();
      metrics.disposed += 1;
      layers.delete(entry.id);
      emit('layer-disposed', entry, { reason: options.reason || 'dispose' });
      return true;
    });
  };

  const updateBudgets = (next = {}) => {
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

  const touch = (layerId) => {
    assertActive();
    const entry = requireEntry(layerId);
    entry.lastAccessAt = clock();
    return cloneEntry(entry);
  };

  const getLayer = (layerId) => {
    const id = normalizeLayerId(layerId);
    const entry = layers.get(id);
    return entry ? cloneEntry(entry) : null;
  };

  const snapshot = () => Object.freeze({
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

  const destroy = async () => {
    if (destroyed) return;
    const entries = [...layers.values()];
    for (const entry of entries) {
      try {
        if (entry.transition) await entry.transition.catch(() => {});
        await evictUnsafe(entry, { force: true, reason: 'runtime-destroy' });
      } catch (error) {
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
