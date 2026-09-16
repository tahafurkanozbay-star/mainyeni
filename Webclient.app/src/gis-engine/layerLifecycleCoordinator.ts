import type { GisViewMode } from './viewStateCoordinator';

export type LayerLifecycleState =
  | 'registered'
  | 'creating'
  | 'ready'
  | 'suspended'
  | 'error'
  | 'disposed';

export type LayerViewHandle = Readonly<{
  mode: GisViewMode;
  layerId: string;
  setVisible?(visible: boolean): void | Promise<void>;
  setOpacity?(opacity: number): void | Promise<void>;
  setSelection?(objectIds: readonly (string | number)[]): void | Promise<void>;
  clearSelection?(): void | Promise<void>;
  suspend?(): void | Promise<void>;
  resume?(): void | Promise<void>;
  destroy?(): void | Promise<void>;
}>;

export type LayerRuntimeFactory = Readonly<{
  createLayerView(input: Readonly<{
    layerId: string;
    mode: GisViewMode;
    generation: number;
    signal: AbortSignal;
    visible: boolean;
    opacity: number;
  }>): Promise<LayerViewHandle>;
}>;

export type LayerLifecycleDescriptor = Readonly<{
  layerId: string;
  serviceId?: string | null;
  visible?: boolean;
  opacity?: number;
  retainWhenHidden?: boolean;
  allow2d?: boolean;
  allow3d?: boolean;
}>;

export type LayerLifecycleSnapshot = Readonly<{
  layerId: string;
  serviceId: string | null;
  state: LayerLifecycleState;
  visible: boolean;
  opacity: number;
  retainWhenHidden: boolean;
  generation: number;
  selectedObjectIds: readonly (string | number)[];
  handles: Readonly<{ mode2d: boolean; mode3d: boolean }>;
  lastError: Readonly<{ message: string; code: string }> | null;
}>;

export type LayerLifecycleEvent = Readonly<{
  type: string;
  layerId: string;
  mode?: GisViewMode;
  generation: number;
  timestamp: number;
  error?: unknown;
}>;

export class LayerLifecycleError extends Error {
  readonly code: string;
  readonly layerId: string | null;

  constructor(message: string, code = 'LAYER_LIFECYCLE_ERROR', layerId: string | null = null) {
    super(message);
    this.name = 'LayerLifecycleError';
    this.code = code;
    this.layerId = layerId;
  }
}

type MutableLayerEntry = {
  layerId: string;
  serviceId: string | null;
  state: LayerLifecycleState;
  visible: boolean;
  opacity: number;
  retainWhenHidden: boolean;
  allow2d: boolean;
  allow3d: boolean;
  generation: number;
  selectedObjectIds: (string | number)[];
  handles: Map<GisViewMode, LayerViewHandle>;
  controllers: Map<GisViewMode, AbortController>;
  createPromises: Map<GisViewMode, Promise<LayerViewHandle>>;
  lastError: { message: string; code: string } | null;
};

const normalizeLayerId = (value: unknown): string => {
  const layerId = String(value ?? '').trim();
  if (!layerId) throw new LayerLifecycleError('Layer lifecycle requires a stable layer id.', 'INVALID_LAYER_ID');
  return layerId;
};

const normalizeOpacity = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(0, Math.min(1, numeric));
};

const stableObjectIds = (values: readonly (string | number)[]): (string | number)[] => {
  const output: (string | number)[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
};

const errorInfo = (error: unknown): { message: string; code: string } => {
  if (error instanceof LayerLifecycleError) return { message: error.message, code: error.code };
  if (error instanceof Error) return { message: error.message || 'Layer lifecycle operation failed.', code: error.name || 'ERROR' };
  return { message: String(error ?? 'Layer lifecycle operation failed.'), code: 'UNKNOWN_ERROR' };
};

const modeAllowed = (entry: MutableLayerEntry, mode: GisViewMode): boolean => (
  mode === '2d' ? entry.allow2d : entry.allow3d
);

const snapshotEntry = (entry: MutableLayerEntry): LayerLifecycleSnapshot => Object.freeze({
  layerId: entry.layerId,
  serviceId: entry.serviceId,
  state: entry.state,
  visible: entry.visible,
  opacity: entry.opacity,
  retainWhenHidden: entry.retainWhenHidden,
  generation: entry.generation,
  selectedObjectIds: Object.freeze([...entry.selectedObjectIds]),
  handles: Object.freeze({
    mode2d: entry.handles.has('2d'),
    mode3d: entry.handles.has('3d'),
  }),
  lastError: entry.lastError ? Object.freeze({ ...entry.lastError }) : null,
});

const safeCall = async (operation: (() => void | Promise<void>) | undefined): Promise<void> => {
  if (!operation) return;
  await operation();
};

export const createLayerLifecycleCoordinator = (dependencies: Readonly<{
  factory: LayerRuntimeFactory;
  now?: () => number;
  onEvent?: (event: LayerLifecycleEvent) => void;
  onListenerError?: (error: unknown, event: LayerLifecycleEvent) => void;
}>): Readonly<{
  register(descriptor: LayerLifecycleDescriptor): LayerLifecycleSnapshot;
  unregister(layerId: string): Promise<boolean>;
  ensure(layerId: string, mode: GisViewMode): Promise<LayerViewHandle>;
  activateMode(mode: GisViewMode, visibleLayerIds?: readonly string[]): Promise<void>;
  setVisible(layerId: string, visible: boolean): Promise<LayerLifecycleSnapshot>;
  setOpacity(layerId: string, opacity: number): Promise<LayerLifecycleSnapshot>;
  setSelection(layerId: string, objectIds: readonly (string | number)[]): Promise<LayerLifecycleSnapshot>;
  clearSelection(layerId: string): Promise<LayerLifecycleSnapshot>;
  suspend(layerId: string, mode?: GisViewMode): Promise<LayerLifecycleSnapshot>;
  resume(layerId: string, mode?: GisViewMode): Promise<LayerLifecycleSnapshot>;
  snapshot(layerId: string): LayerLifecycleSnapshot | null;
  snapshots(): readonly LayerLifecycleSnapshot[];
  subscribe(listener: (event: LayerLifecycleEvent) => void): () => void;
  destroy(): Promise<void>;
}> => {
  if (!dependencies?.factory || typeof dependencies.factory.createLayerView !== 'function') {
    throw new LayerLifecycleError('Layer lifecycle coordinator requires a layer-view factory.', 'MISSING_FACTORY');
  }
  const entries = new Map<string, MutableLayerEntry>();
  const listeners = new Set<(event: LayerLifecycleEvent) => void>();
  const now = typeof dependencies.now === 'function' ? dependencies.now : () => Date.now();
  let destroyed = false;
  let activeMode: GisViewMode = '2d';

  const assertActive = (): void => {
    if (destroyed) throw new LayerLifecycleError('Layer lifecycle coordinator has been destroyed.', 'COORDINATOR_DESTROYED');
  };

  const emit = (type: string, entry: MutableLayerEntry, details: Partial<LayerLifecycleEvent> = {}): void => {
    const event: LayerLifecycleEvent = Object.freeze({
      type,
      layerId: entry.layerId,
      generation: entry.generation,
      timestamp: now(),
      ...details,
    });
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        dependencies.onListenerError?.(error, event);
      }
    }
    try {
      dependencies.onEvent?.(event);
    } catch (error) {
      dependencies.onListenerError?.(error, event);
    }
  };

  const getEntry = (layerId: string): MutableLayerEntry => {
    const normalized = normalizeLayerId(layerId);
    const entry = entries.get(normalized);
    if (!entry) throw new LayerLifecycleError(`Unknown GIS layer: ${normalized}`, 'LAYER_NOT_REGISTERED', normalized);
    return entry;
  };

  const abortCreation = (entry: MutableLayerEntry, mode: GisViewMode, reason: string): void => {
    const controller = entry.controllers.get(mode);
    if (controller && !controller.signal.aborted) controller.abort(reason);
    entry.controllers.delete(mode);
    entry.createPromises.delete(mode);
  };

  const destroyHandle = async (entry: MutableLayerEntry, mode: GisViewMode): Promise<void> => {
    abortCreation(entry, mode, 'Layer view destroyed');
    const handle = entry.handles.get(mode);
    if (!handle) return;
    entry.handles.delete(mode);
    try {
      await safeCall(handle.destroy ? () => handle.destroy?.() : undefined);
      emit('handle-destroyed', entry, { mode });
    } catch (error) {
      entry.lastError = errorInfo(error);
      emit('handle-destroy-failed', entry, { mode, error });
    }
  };

  const applyStateToHandle = async (entry: MutableLayerEntry, handle: LayerViewHandle): Promise<void> => {
    await safeCall(handle.setOpacity ? () => handle.setOpacity?.(entry.opacity) : undefined);
    await safeCall(handle.setVisible ? () => handle.setVisible?.(entry.visible) : undefined);
    if (entry.selectedObjectIds.length) {
      await safeCall(handle.setSelection ? () => handle.setSelection?.(entry.selectedObjectIds) : undefined);
    } else {
      await safeCall(handle.clearSelection ? () => handle.clearSelection?.() : undefined);
    }
  };

  const ensure = async (layerId: string, mode: GisViewMode): Promise<LayerViewHandle> => {
    assertActive();
    const entry = getEntry(layerId);
    if (!modeAllowed(entry, mode)) {
      throw new LayerLifecycleError(`Layer ${entry.layerId} is not enabled for ${mode}.`, 'VIEW_MODE_NOT_ALLOWED', entry.layerId);
    }
    const existing = entry.handles.get(mode);
    if (existing) {
      await applyStateToHandle(entry, existing);
      return existing;
    }
    const pending = entry.createPromises.get(mode);
    if (pending) return pending;

    const generation = entry.generation + 1;
    entry.generation = generation;
    entry.state = 'creating';
    entry.lastError = null;
    const controller = new AbortController();
    entry.controllers.set(mode, controller);
    emit('create-started', entry, { mode });

    const promise = Promise.resolve(dependencies.factory.createLayerView({
      layerId: entry.layerId,
      mode,
      generation,
      signal: controller.signal,
      visible: entry.visible,
      opacity: entry.opacity,
    })).then(async (handle) => {
      if (destroyed || controller.signal.aborted || entry.generation !== generation || !entries.has(entry.layerId)) {
        await safeCall(handle.destroy ? () => handle.destroy?.() : undefined);
        throw new LayerLifecycleError('Stale layer-view creation was discarded.', 'STALE_LAYER_VIEW', entry.layerId);
      }
      if (handle.layerId !== entry.layerId || handle.mode !== mode) {
        await safeCall(handle.destroy ? () => handle.destroy?.() : undefined);
        throw new LayerLifecycleError('Layer-view factory returned a mismatched handle.', 'MISMATCHED_LAYER_VIEW', entry.layerId);
      }
      entry.handles.set(mode, handle);
      entry.controllers.delete(mode);
      entry.createPromises.delete(mode);
      entry.state = 'ready';
      await applyStateToHandle(entry, handle);
      emit('create-completed', entry, { mode });
      return handle;
    }).catch((error: unknown) => {
      entry.controllers.delete(mode);
      entry.createPromises.delete(mode);
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        if (entry.state !== 'disposed') entry.state = entry.handles.size ? 'ready' : 'registered';
        emit('create-cancelled', entry, { mode, error });
        throw error;
      }
      entry.state = entry.handles.size ? 'ready' : 'error';
      entry.lastError = errorInfo(error);
      emit('create-failed', entry, { mode, error });
      throw error;
    });
    entry.createPromises.set(mode, promise);
    return promise;
  };

  const register = (descriptor: LayerLifecycleDescriptor): LayerLifecycleSnapshot => {
    assertActive();
    const layerId = normalizeLayerId(descriptor.layerId);
    const existing = entries.get(layerId);
    if (existing) {
      existing.serviceId = descriptor.serviceId == null ? existing.serviceId : String(descriptor.serviceId);
      existing.visible = descriptor.visible ?? existing.visible;
      existing.opacity = descriptor.opacity === undefined ? existing.opacity : normalizeOpacity(descriptor.opacity);
      existing.retainWhenHidden = descriptor.retainWhenHidden ?? existing.retainWhenHidden;
      existing.allow2d = descriptor.allow2d ?? existing.allow2d;
      existing.allow3d = descriptor.allow3d ?? existing.allow3d;
      emit('descriptor-updated', existing);
      return snapshotEntry(existing);
    }
    const entry: MutableLayerEntry = {
      layerId,
      serviceId: descriptor.serviceId == null ? null : String(descriptor.serviceId),
      state: 'registered',
      visible: descriptor.visible !== false,
      opacity: normalizeOpacity(descriptor.opacity),
      retainWhenHidden: descriptor.retainWhenHidden !== false,
      allow2d: descriptor.allow2d !== false,
      allow3d: descriptor.allow3d !== false,
      generation: 0,
      selectedObjectIds: [],
      handles: new Map(),
      controllers: new Map(),
      createPromises: new Map(),
      lastError: null,
    };
    entries.set(layerId, entry);
    emit('registered', entry);
    return snapshotEntry(entry);
  };

  const unregister = async (layerId: string): Promise<boolean> => {
    assertActive();
    const normalized = normalizeLayerId(layerId);
    const entry = entries.get(normalized);
    if (!entry) return false;
    entry.generation += 1;
    entry.state = 'disposed';
    abortCreation(entry, '2d', 'Layer unregistered');
    abortCreation(entry, '3d', 'Layer unregistered');
    await Promise.all([destroyHandle(entry, '2d'), destroyHandle(entry, '3d')]);
    entries.delete(normalized);
    emit('unregistered', entry);
    return true;
  };

  const activateMode = async (mode: GisViewMode, visibleLayerIds: readonly string[] = []): Promise<void> => {
    assertActive();
    activeMode = mode;
    const requested = new Set(visibleLayerIds.map((value) => String(value).trim()).filter(Boolean));
    const jobs: Promise<unknown>[] = [];
    for (const entry of entries.values()) {
      const shouldExist = entry.visible && modeAllowed(entry, mode) && (!requested.size || requested.has(entry.layerId));
      if (shouldExist) jobs.push(ensure(entry.layerId, mode));
      const otherMode: GisViewMode = mode === '2d' ? '3d' : '2d';
      const otherHandle = entry.handles.get(otherMode);
      if (otherHandle) {
        if (entry.retainWhenHidden) jobs.push(safeCall(otherHandle.suspend ? () => otherHandle.suspend?.() : undefined));
        else jobs.push(destroyHandle(entry, otherMode));
      }
    }
    await Promise.all(jobs);
  };

  const setVisible = async (layerId: string, visible: boolean): Promise<LayerLifecycleSnapshot> => {
    assertActive();
    const entry = getEntry(layerId);
    entry.visible = Boolean(visible);
    const jobs: Promise<unknown>[] = [];
    for (const [mode, handle] of entry.handles.entries()) {
      jobs.push(safeCall(handle.setVisible ? () => handle.setVisible?.(entry.visible) : undefined));
      if (!entry.visible && !entry.retainWhenHidden) jobs.push(destroyHandle(entry, mode));
    }
    if (entry.visible && modeAllowed(entry, activeMode)) jobs.push(ensure(entry.layerId, activeMode));
    await Promise.all(jobs);
    emit('visibility-changed', entry);
    return snapshotEntry(entry);
  };

  const setOpacity = async (layerId: string, opacity: number): Promise<LayerLifecycleSnapshot> => {
    assertActive();
    const entry = getEntry(layerId);
    entry.opacity = normalizeOpacity(opacity);
    await Promise.all([...entry.handles.values()].map((handle) => (
      safeCall(handle.setOpacity ? () => handle.setOpacity?.(entry.opacity) : undefined)
    )));
    emit('opacity-changed', entry);
    return snapshotEntry(entry);
  };

  const setSelection = async (
    layerId: string,
    objectIds: readonly (string | number)[],
  ): Promise<LayerLifecycleSnapshot> => {
    assertActive();
    const entry = getEntry(layerId);
    entry.selectedObjectIds = stableObjectIds(objectIds);
    await Promise.all([...entry.handles.values()].map((handle) => (
      entry.selectedObjectIds.length
        ? safeCall(handle.setSelection ? () => handle.setSelection?.(entry.selectedObjectIds) : undefined)
        : safeCall(handle.clearSelection ? () => handle.clearSelection?.() : undefined)
    )));
    emit('selection-changed', entry);
    return snapshotEntry(entry);
  };

  const clearSelection = (layerId: string): Promise<LayerLifecycleSnapshot> => setSelection(layerId, []);

  const suspend = async (layerId: string, mode?: GisViewMode): Promise<LayerLifecycleSnapshot> => {
    assertActive();
    const entry = getEntry(layerId);
    const modes: readonly GisViewMode[] = mode ? [mode] : ['2d', '3d'];
    await Promise.all(modes.map(async (candidate) => {
      const handle = entry.handles.get(candidate);
      if (handle) await safeCall(handle.suspend ? () => handle.suspend?.() : undefined);
    }));
    entry.state = 'suspended';
    emit('suspended', entry, mode ? { mode } : {});
    return snapshotEntry(entry);
  };

  const resume = async (layerId: string, mode?: GisViewMode): Promise<LayerLifecycleSnapshot> => {
    assertActive();
    const entry = getEntry(layerId);
    const modes: readonly GisViewMode[] = mode ? [mode] : ['2d', '3d'];
    await Promise.all(modes.map(async (candidate) => {
      const handle = entry.handles.get(candidate);
      if (handle) await safeCall(handle.resume ? () => handle.resume?.() : undefined);
    }));
    entry.state = entry.handles.size ? 'ready' : 'registered';
    emit('resumed', entry, mode ? { mode } : {});
    return snapshotEntry(entry);
  };

  const snapshot = (layerId: string): LayerLifecycleSnapshot | null => {
    const entry = entries.get(String(layerId ?? '').trim());
    return entry ? snapshotEntry(entry) : null;
  };

  const snapshots = (): readonly LayerLifecycleSnapshot[] => Object.freeze(
    [...entries.values()].map(snapshotEntry).sort((left, right) => left.layerId.localeCompare(right.layerId)),
  );

  const subscribe = (listener: (event: LayerLifecycleEvent) => void): (() => void) => {
    assertActive();
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    const current = [...entries.values()];
    for (const entry of current) {
      entry.generation += 1;
      entry.state = 'disposed';
      abortCreation(entry, '2d', 'Coordinator destroyed');
      abortCreation(entry, '3d', 'Coordinator destroyed');
    }
    await Promise.all(current.flatMap((entry) => [destroyHandle(entry, '2d'), destroyHandle(entry, '3d')]));
    entries.clear();
    listeners.clear();
  };

  return Object.freeze({
    register,
    unregister,
    ensure,
    activateMode,
    setVisible,
    setOpacity,
    setSelection,
    clearSelection,
    suspend,
    resume,
    snapshot,
    snapshots,
    subscribe,
    destroy,
  });
};
