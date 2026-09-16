import {
  LAYER_STATUS,
  isScaleVisible,
  layerReducer,
  visibleLayersAtScale,
} from './layerRuntime';

export const LAYER_LOAD_PRIORITY = Object.freeze({
  BACKGROUND: 10,
  PREFETCH: 25,
  VISIBLE: 100,
  USER_REQUESTED: 250,
  SELECTED: 500,
});

export class LayerSchedulerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LayerSchedulerError';
    this.code = details.code || 'LAYER_SCHEDULER_ERROR';
    this.layerId = details.layerId || null;
    this.cause = details.cause;
  }
}

const finite = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const now = () => Date.now();

const cancelledError = (layerId) => new LayerSchedulerError('Layer request cancelled.', {
  code: 'CANCELLED',
  layerId,
});

const normalizeLayerId = (layerOrId) => {
  const raw = typeof layerOrId === 'object' ? layerOrId?.id : layerOrId;
  const id = String(raw ?? '').trim();
  if (!id) {
    throw new LayerSchedulerError('A layer id is required.', {
      code: 'INVALID_LAYER_ID',
    });
  }
  return id;
};

const normalizePriority = (value, fallback = LAYER_LOAD_PRIORITY.VISIBLE) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const safeAbort = (controller) => {
  try {
    if (controller && !controller.signal.aborted) controller.abort();
  } catch (_) {
    // Abort is best-effort for SDK implementations that partially polyfill signals.
  }
};

const createController = () => (
  typeof AbortController === 'undefined' ? null : new AbortController()
);

const eventSnapshot = (entry) => ({
  layerId: entry.layerId,
  priority: entry.priority,
  state: entry.state,
  subscribers: entry.subscribers.size,
  enqueuedAt: entry.enqueuedAt,
  startedAt: entry.startedAt,
  completedAt: entry.completedAt,
});

export const computeLayerPriority = (layer, context = {}) => {
  const id = normalizeLayerId(layer);
  if (id === String(context.selectedLayerId ?? '')) return LAYER_LOAD_PRIORITY.SELECTED;
  if ((context.userRequestedIds || []).map(String).includes(id)) return LAYER_LOAD_PRIORITY.USER_REQUESTED;
  if ((context.visibleIds || []).map(String).includes(id)) return LAYER_LOAD_PRIORITY.VISIBLE;
  if ((context.prefetchIds || []).map(String).includes(id)) return LAYER_LOAD_PRIORITY.PREFETCH;
  return LAYER_LOAD_PRIORITY.BACKGROUND;
};

export const createLayerLoadPlan = (tree, scale, context = {}) => {
  const visible = visibleLayersAtScale(tree, scale);
  const visibleIds = visible.map((layer) => layer.id);
  const selectedLayerId = context.selectedLayerId == null ? null : String(context.selectedLayerId);
  const userRequestedIds = Array.from(new Set((context.userRequestedIds || []).map(String)));
  const prefetchIds = Array.from(new Set((context.prefetchIds || []).map(String)));
  const byId = tree?.byId || new Map();
  const desiredIds = new Set([...visibleIds, ...userRequestedIds, ...prefetchIds]);
  if (selectedLayerId && byId.has(selectedLayerId)) desiredIds.add(selectedLayerId);

  const load = [];
  desiredIds.forEach((id) => {
    const layer = byId.get(id);
    if (!layer) return;
    if (layer.runtime?.status === LAYER_STATUS.DISABLED) return;
    const visibleAtScale = isScaleVisible(scale, layer);
    const requested = userRequestedIds.includes(id) || id === selectedLayerId;
    if (!visibleAtScale && !requested) return;
    load.push({
      layer,
      priority: computeLayerPriority(layer, {
        ...context,
        visibleIds,
        userRequestedIds,
        prefetchIds,
        selectedLayerId,
      }),
      visibleAtScale,
      selected: id === selectedLayerId,
      userRequested: userRequestedIds.includes(id),
      prefetch: prefetchIds.includes(id),
    });
  });

  load.sort((left, right) => (
    right.priority - left.priority || left.layer.id.localeCompare(right.layer.id)
  ));

  const unload = [];
  byId.forEach((layer, id) => {
    if (!layer?.sdkLayer) return;
    if (desiredIds.has(id)) return;
    unload.push(layer);
  });

  return {
    scale: finite(scale),
    visibleIds,
    desiredIds: [...desiredIds],
    load,
    unload,
  };
};

export const applyRuntimeToSdkLayer = (descriptor, sdkLayer = descriptor?.sdkLayer) => {
  if (!descriptor || !sdkLayer) return false;
  const runtime = descriptor.runtime || {};
  if (typeof runtime.visible === 'boolean') sdkLayer.visible = runtime.visible;
  if (Number.isFinite(Number(runtime.opacity))) sdkLayer.opacity = Math.min(1, Math.max(0, Number(runtime.opacity)));
  if (Number.isFinite(Number(runtime.minScale)) && Number(runtime.minScale) >= 0) {
    sdkLayer.minScale = Number(runtime.minScale);
  }
  if (Number.isFinite(Number(runtime.maxScale)) && Number(runtime.maxScale) >= 0) {
    sdkLayer.maxScale = Number(runtime.maxScale);
  }
  return true;
};

export const createLayerResidencyTracker = (options = {}) => {
  const clock = typeof options.now === 'function' ? options.now : now;
  const idleMs = positiveInteger(options.idleMs, 120000, 24 * 60 * 60 * 1000);
  const records = new Map();

  const touch = (layerId, metadata = {}) => {
    const id = normalizeLayerId(layerId);
    const previous = records.get(id) || {};
    const record = {
      ...previous,
      ...metadata,
      layerId: id,
      lastUsedAt: clock(),
      pinned: metadata.pinned ?? previous.pinned ?? false,
    };
    records.set(id, record);
    return { ...record };
  };

  const pin = (layerId, pinned = true) => touch(layerId, { pinned: Boolean(pinned) });

  const forget = (layerId) => records.delete(normalizeLayerId(layerId));

  const get = (layerId) => {
    const record = records.get(normalizeLayerId(layerId));
    return record ? { ...record } : null;
  };

  const idleCandidates = (activeIds = []) => {
    const active = new Set(activeIds.map(String));
    const current = clock();
    return [...records.values()]
      .filter((record) => (
        !record.pinned &&
        !active.has(record.layerId) &&
        current - record.lastUsedAt >= idleMs
      ))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
      .map((record) => ({ ...record }));
  };

  return {
    touch,
    pin,
    forget,
    get,
    idleCandidates,
    clear: () => records.clear(),
    size: () => records.size,
    settings: () => ({ idleMs }),
  };
};

export const createLayerLoadScheduler = (configuration = {}) => {
  const settings = {
    maxConcurrent: positiveInteger(configuration.maxConcurrent, 4, 16),
  };
  const clock = typeof configuration.now === 'function' ? configuration.now : now;
  const onEvent = typeof configuration.onEvent === 'function' ? configuration.onEvent : () => {};
  const queue = [];
  const entries = new Map();
  let sequence = 0;
  let active = 0;
  let destroyed = false;
  let draining = false;

  const metrics = {
    enqueued: 0,
    deduped: 0,
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    underlyingAborts: 0,
    reprioritized: 0,
    peakConcurrent: 0,
    totalLoadMs: 0,
    lastLoadMs: null,
  };

  const emit = (type, entry, extra = {}) => {
    try {
      onEvent({ type, ...eventSnapshot(entry), ...extra });
    } catch (_) {
      // Observability listeners must never break the scheduler.
    }
  };

  const sortQueue = () => {
    queue.sort((left, right) => (
      right.priority - left.priority || left.sequence - right.sequence
    ));
  };

  const removeFromQueue = (entry) => {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  };

  const finishSubscriber = (entry, subscriber, callback, value, reason = null) => {
    if (subscriber.done) return;
    subscriber.done = true;
    if (subscriber.abortHandler && subscriber.signal) {
      subscriber.signal.removeEventListener('abort', subscriber.abortHandler);
    }
    entry.subscribers.delete(subscriber);
    if (reason === 'cancelled') metrics.cancelled += 1;
    callback(value);

    if (entry.subscribers.size === 0 && !entry.settled) {
      if (entry.state === 'queued') {
        removeFromQueue(entry);
        entries.delete(entry.layerId);
        entry.state = 'cancelled';
        entry.settled = true;
        emit('cancelled', entry, { phase: 'queued' });
      } else if (entry.state === 'running') {
        safeAbort(entry.controller);
        metrics.underlyingAborts += 1;
        emit('abort', entry, { phase: 'running' });
      }
    }
  };

  const subscribe = (entry, signal) => new Promise((resolve, reject) => {
    const subscriber = {
      signal,
      resolve,
      reject,
      done: false,
      abortHandler: null,
    };
    entry.subscribers.add(subscriber);

    const cancel = () => finishSubscriber(
      entry,
      subscriber,
      reject,
      cancelledError(entry.layerId),
      'cancelled',
    );

    if (signal) {
      subscriber.abortHandler = cancel;
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener('abort', cancel, { once: true });
    }

    if (entry.settled) {
      if (entry.error) finishSubscriber(entry, subscriber, reject, entry.error);
      else finishSubscriber(entry, subscriber, resolve, entry.value);
    }
  });

  const settleEntry = (entry, error, value) => {
    entry.settled = true;
    entry.error = error || null;
    entry.value = value;
    entry.completedAt = clock();
    const duration = Math.max(0, entry.completedAt - entry.startedAt);
    metrics.totalLoadMs += duration;
    metrics.lastLoadMs = duration;

    if (error) {
      entry.state = error?.code === 'CANCELLED' || error?.name === 'AbortError'
        ? 'cancelled'
        : 'failed';
      if (entry.state === 'failed') metrics.failed += 1;
    } else {
      entry.state = 'completed';
      metrics.completed += 1;
    }

    [...entry.subscribers].forEach((subscriber) => {
      if (error) finishSubscriber(entry, subscriber, subscriber.reject, error);
      else finishSubscriber(entry, subscriber, subscriber.resolve, value);
    });
    entries.delete(entry.layerId);
    emit(entry.state, entry, error ? { error } : { value });
  };

  const startEntry = (entry) => {
    if (destroyed || entry.settled || entry.subscribers.size === 0) return;
    entry.state = 'running';
    entry.startedAt = clock();
    entry.controller = createController();
    active += 1;
    metrics.started += 1;
    metrics.peakConcurrent = Math.max(metrics.peakConcurrent, active);
    emit('started', entry);

    Promise.resolve()
      .then(() => entry.loader({
        layer: entry.layer,
        layerId: entry.layerId,
        signal: entry.controller?.signal,
        priority: entry.priority,
        metadata: { ...entry.metadata },
      }))
      .then(
        (value) => settleEntry(entry, null, value),
        (error) => settleEntry(entry, error, undefined),
      )
      .finally(() => {
        active = Math.max(0, active - 1);
        drain();
      });
  };

  const drain = () => {
    if (destroyed || draining) return;
    draining = true;
    try {
      sortQueue();
      while (active < settings.maxConcurrent && queue.length) {
        const entry = queue.shift();
        if (!entry || entry.settled || entry.subscribers.size === 0) continue;
        startEntry(entry);
      }
    } finally {
      draining = false;
    }
  };

  const schedule = (layer, loader, options = {}) => {
    if (destroyed) {
      return Promise.reject(new LayerSchedulerError('Layer scheduler has been destroyed.', {
        code: 'SCHEDULER_DESTROYED',
        layerId: typeof layer === 'object' ? layer?.id : layer,
      }));
    }
    const layerId = normalizeLayerId(layer);
    if (typeof loader !== 'function') {
      return Promise.reject(new LayerSchedulerError('A layer loader function is required.', {
        code: 'INVALID_LAYER_LOADER',
        layerId,
      }));
    }
    if (options.signal?.aborted) return Promise.reject(cancelledError(layerId));

    const requestedPriority = normalizePriority(options.priority);
    let entry = entries.get(layerId);
    if (entry && !entry.settled) {
      metrics.deduped += 1;
      if (requestedPriority > entry.priority && entry.state === 'queued') {
        entry.priority = requestedPriority;
        metrics.reprioritized += 1;
        sortQueue();
        emit('reprioritized', entry);
      }
      return subscribe(entry, options.signal);
    }

    entry = {
      layerId,
      layer: typeof layer === 'object' ? layer : { id: layerId },
      loader,
      priority: requestedPriority,
      metadata: { ...(options.metadata || {}) },
      sequence: sequence++,
      state: 'queued',
      enqueuedAt: clock(),
      startedAt: null,
      completedAt: null,
      controller: null,
      subscribers: new Set(),
      settled: false,
      error: null,
      value: undefined,
    };
    entries.set(layerId, entry);
    queue.push(entry);
    metrics.enqueued += 1;
    emit('enqueued', entry);
    const promise = subscribe(entry, options.signal);
    drain();
    return promise;
  };

  const cancel = (layerId, reason = 'cancelled') => {
    const id = normalizeLayerId(layerId);
    const entry = entries.get(id);
    if (!entry || entry.settled) return false;
    const error = new LayerSchedulerError(`Layer request ${reason}.`, {
      code: 'CANCELLED',
      layerId: id,
    });
    if (entry.state === 'queued') removeFromQueue(entry);
    if (entry.state === 'running') {
      safeAbort(entry.controller);
      metrics.underlyingAborts += 1;
    }
    settleEntry(entry, error, undefined);
    return true;
  };

  const cancelExcept = (desiredIds = []) => {
    const desired = new Set(desiredIds.map(String));
    let count = 0;
    [...entries.keys()].forEach((id) => {
      if (!desired.has(id) && cancel(id, 'no longer needed')) count += 1;
    });
    return count;
  };

  const reprioritize = (layerId, priority) => {
    const id = normalizeLayerId(layerId);
    const entry = entries.get(id);
    if (!entry || entry.settled || entry.state !== 'queued') return false;
    const next = normalizePriority(priority, entry.priority);
    if (next === entry.priority) return false;
    entry.priority = next;
    metrics.reprioritized += 1;
    sortQueue();
    emit('reprioritized', entry);
    drain();
    return true;
  };

  const setMaxConcurrent = (value) => {
    settings.maxConcurrent = positiveInteger(value, settings.maxConcurrent, 16);
    drain();
    return settings.maxConcurrent;
  };

  const snapshot = () => ({
    ...metrics,
    queued: queue.filter((entry) => !entry.settled).length,
    active,
    tracked: entries.size,
    maxConcurrent: settings.maxConcurrent,
    queue: queue
      .filter((entry) => !entry.settled)
      .map((entry) => eventSnapshot(entry)),
    running: [...entries.values()]
      .filter((entry) => entry.state === 'running')
      .map((entry) => eventSnapshot(entry)),
  });

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    [...entries.keys()].forEach((id) => cancel(id, 'scheduler destroyed'));
    queue.length = 0;
    entries.clear();
  };

  return {
    schedule,
    cancel,
    cancelExcept,
    reprioritize,
    setMaxConcurrent,
    snapshot,
    destroy,
    has: (layerId) => entries.has(String(layerId)),
    getState: (layerId) => entries.get(String(layerId))?.state || null,
  };
};

export const createLayerRuntimeLoader = ({
  scheduler,
  getTree,
  setTree,
  loadLayer,
  unloadLayer,
  residency,
  now: clock = now,
} = {}) => {
  if (!scheduler?.schedule) throw new Error('A layer scheduler is required.');
  if (typeof getTree !== 'function' || typeof setTree !== 'function') {
    throw new Error('Layer tree getter/setter functions are required.');
  }
  if (typeof loadLayer !== 'function') throw new Error('A layer loader is required.');

  let requestSequence = 0;

  const update = (action) => {
    const current = getTree();
    const next = layerReducer(current, action);
    if (next !== current) setTree(next);
    return next;
  };

  const load = (layer, options = {}) => {
    const layerId = normalizeLayerId(layer);
    const requestId = `${layerId}:${++requestSequence}`;
    update({ type: 'LOAD_START', layerId, requestId });

    return scheduler.schedule(layer, async ({ signal, priority, metadata }) => {
      const sdkLayer = await loadLayer(layer, { signal, priority, metadata });
      if (signal?.aborted) throw cancelledError(layerId);
      applyRuntimeToSdkLayer(layer, sdkLayer);
      residency?.touch?.(layerId, { loadedAt: clock() });
      return sdkLayer;
    }, options).then((sdkLayer) => {
      update({ type: 'SET_SDK_LAYER', layerId, sdkLayer });
      update({
        type: 'LOAD_SUCCESS',
        layerId,
        featureCount: Number.isFinite(options.featureCount) ? options.featureCount : null,
        loadedAt: new Date(clock()).toISOString(),
      });
      return sdkLayer;
    }).catch((error) => {
      if (error?.code === 'CANCELLED' || error?.name === 'AbortError') {
        update({ type: 'SET_DISABLED', layerId, disabled: false });
        throw error;
      }
      update({ type: 'LOAD_ERROR', layerId, error });
      throw error;
    });
  };

  const unload = async (layerId, reason = 'idle') => {
    const id = normalizeLayerId(layerId);
    const tree = getTree();
    const descriptor = tree?.byId?.get(id);
    scheduler.cancel(id, reason);
    if (descriptor?.sdkLayer && typeof unloadLayer === 'function') {
      await unloadLayer(descriptor.sdkLayer, descriptor, reason);
    }
    residency?.forget?.(id);
    update({ type: 'SET_SDK_LAYER', layerId: id, sdkLayer: null });
    return true;
  };

  const reconcile = async (scale, context = {}) => {
    const tree = getTree();
    const plan = createLayerLoadPlan(tree, scale, context);
    scheduler.cancelExcept(plan.desiredIds);

    const loadPromises = plan.load.map(({ layer, priority }) => {
      residency?.touch?.(layer.id, { desired: true, scale });
      if (layer.sdkLayer) {
        applyRuntimeToSdkLayer(layer);
        return Promise.resolve(layer.sdkLayer);
      }
      return load(layer, { priority, metadata: { scale } });
    });

    const unloadIds = new Set(plan.unload.map((layer) => layer.id));
    residency?.idleCandidates?.(plan.desiredIds).forEach((record) => unloadIds.add(record.layerId));
    const unloadPromises = [...unloadIds].map((id) => unload(id));

    const [loaded, unloaded] = await Promise.all([
      Promise.allSettled(loadPromises),
      Promise.allSettled(unloadPromises),
    ]);
    return { plan, loaded, unloaded };
  };

  return { load, unload, reconcile };
};
