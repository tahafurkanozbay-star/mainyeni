import type { ViewMode, ViewState, ViewStateInput } from './contracts';
import { createViewState, viewStateEquals } from './viewState';

export type ViewStateSyncAdapter = Readonly<{
  id: string;
  mode: ViewMode;
  apply(input: Readonly<{ state: ViewState; revision: number; signal: AbortSignal }>): void | Promise<void>;
}>;

export type ViewStateSyncSnapshot = Readonly<{
  revision: number;
  state: ViewState;
  adapterCount: number;
  activeMode: ViewMode;
  pendingAdapters: readonly string[];
  lastOrigin: string | null;
}>;

export class ViewStateSyncError extends Error {
  readonly code: string;

  constructor(message: string, code = 'VIEW_STATE_SYNC_ERROR') {
    super(message);
    this.name = 'ViewStateSyncError';
    this.code = code;
  }
}

type OwnedAdapter = {
  adapter: ViewStateSyncAdapter;
  controller: AbortController | null;
  revision: number;
};

const boundedId = (value: unknown): string => {
  const id = String(value ?? '').trim();
  if (!id || id.length > 256) throw new ViewStateSyncError('View adapter id must be non-empty and bounded.', 'INVALID_ADAPTER_ID');
  return id;
};

const assertMode = (mode: unknown): ViewMode => {
  if (mode === '2d' || mode === '3d') return mode;
  throw new ViewStateSyncError('View adapter mode must be 2d or 3d.', 'INVALID_VIEW_MODE');
};

const mergeState = (current: ViewState, patch: ViewStateInput): ViewState => createViewState({
  ...current,
  ...patch,
});

export type ViewStateSyncCoordinator = Readonly<{
  register(adapter: ViewStateSyncAdapter): () => boolean;
  unregister(id: string): boolean;
  publish(originId: string, patch: ViewStateInput): Promise<ViewStateSyncSnapshot>;
  setState(patch: ViewStateInput, originId?: string): Promise<ViewStateSyncSnapshot>;
  switchMode(mode: ViewMode, originId?: string): Promise<ViewStateSyncSnapshot>;
  state(): ViewState;
  snapshot(): ViewStateSyncSnapshot;
  adapters(): readonly Readonly<{ id: string; mode: ViewMode }>[];
  dispose(): void;
}>;

/**
 * Coordinates one canonical camera/selection state across independent 2D and
 * 3D views. Renderer adapters are injected, bounded, revision-owned and
 * cancellable. A newer state aborts stale apply work so slow SceneView updates
 * cannot overwrite a newer MapView intent or resurrect an unregistered view.
 */
export const createViewStateSyncCoordinator = (options: Readonly<{
  initialState?: ViewStateInput;
  maximumAdapters?: number;
  onAdapterError?: (input: Readonly<{ id: string; revision: number; error: unknown }>) => void;
}> = {}): ViewStateSyncCoordinator => {
  const maximumAdapters = options.maximumAdapters ?? 8;
  if (!Number.isSafeInteger(maximumAdapters) || maximumAdapters <= 0 || maximumAdapters > 64) {
    throw new ViewStateSyncError('View adapter budget must be between 1 and 64.', 'INVALID_ADAPTER_BUDGET');
  }

  const owned = new Map<string, OwnedAdapter>();
  let current = createViewState(options.initialState ?? {});
  let revision = 0;
  let lastOrigin: string | null = null;
  let disposed = false;

  const assertLive = (): void => {
    if (disposed) throw new ViewStateSyncError('View state sync coordinator is disposed.', 'DISPOSED');
  };

  const snapshot = (): ViewStateSyncSnapshot => Object.freeze({
    revision,
    state: current,
    adapterCount: owned.size,
    activeMode: current.mode,
    pendingAdapters: Object.freeze(Array.from(owned.entries())
      .filter(([, entry]) => entry.controller !== null)
      .map(([id]) => id)
      .sort()),
    lastOrigin,
  });

  const register = (adapter: ViewStateSyncAdapter): (() => boolean) => {
    assertLive();
    const id = boundedId(adapter.id);
    const mode = assertMode(adapter.mode);
    if (typeof adapter.apply !== 'function') throw new ViewStateSyncError('View adapter apply callback is required.', 'MISSING_ADAPTER_APPLY');
    if (owned.has(id)) throw new ViewStateSyncError(`Duplicate view adapter id: ${id}`, 'DUPLICATE_ADAPTER_ID');
    if (owned.size >= maximumAdapters) throw new ViewStateSyncError('View adapter budget exceeded.', 'ADAPTER_BUDGET_EXCEEDED');
    owned.set(id, {
      adapter: Object.freeze({ ...adapter, id, mode }),
      controller: null,
      revision: 0,
    });
    return () => unregister(id);
  };

  const unregister = (rawId: string): boolean => {
    const id = boundedId(rawId);
    const entry = owned.get(id);
    if (!entry) return false;
    owned.delete(id);
    entry.revision += 1;
    entry.controller?.abort('view adapter unregistered');
    entry.controller = null;
    return true;
  };

  const applyToAdapter = async (id: string, entry: OwnedAdapter, stateRevision: number): Promise<void> => {
    entry.controller?.abort('newer view state superseded this apply');
    const controller = new AbortController();
    entry.controller = controller;
    entry.revision = stateRevision;
    try {
      await entry.adapter.apply({ state: current, revision: stateRevision, signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted && owned.get(id) === entry && entry.revision === stateRevision) {
        options.onAdapterError?.(Object.freeze({ id, revision: stateRevision, error }));
      }
    } finally {
      if (owned.get(id) === entry && entry.revision === stateRevision && entry.controller === controller) {
        entry.controller = null;
      }
    }
  };

  const distribute = async (originId: string | null, stateRevision: number): Promise<void> => {
    const tasks: Promise<void>[] = [];
    for (const [id, entry] of owned) {
      if (id === originId) continue;
      tasks.push(applyToAdapter(id, entry, stateRevision));
    }
    await Promise.all(tasks);
  };

  const commit = async (patch: ViewStateInput, originId: string | null): Promise<ViewStateSyncSnapshot> => {
    assertLive();
    if (originId !== null && !owned.has(originId)) {
      throw new ViewStateSyncError(`Unknown view adapter: ${originId}`, 'UNKNOWN_ADAPTER');
    }
    const next = mergeState(current, patch);
    lastOrigin = originId;
    if (viewStateEquals(current, next)) return snapshot();
    current = next;
    revision += 1;
    const stateRevision = revision;
    await distribute(originId, stateRevision);
    return snapshot();
  };

  const publish = async (rawOriginId: string, patch: ViewStateInput): Promise<ViewStateSyncSnapshot> => {
    const originId = boundedId(rawOriginId);
    const entry = owned.get(originId);
    if (!entry) throw new ViewStateSyncError(`Unknown view adapter: ${originId}`, 'UNKNOWN_ADAPTER');
    const mode = entry.adapter.mode;
    return commit({ ...patch, mode }, originId);
  };

  const setState = (patch: ViewStateInput, originId?: string): Promise<ViewStateSyncSnapshot> => (
    commit(patch, originId === undefined ? null : boundedId(originId))
  );

  const switchMode = (mode: ViewMode, originId?: string): Promise<ViewStateSyncSnapshot> => (
    commit({ mode: assertMode(mode) }, originId === undefined ? null : boundedId(originId))
  );

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const entry of owned.values()) {
      entry.revision += 1;
      entry.controller?.abort('view state sync coordinator disposed');
      entry.controller = null;
    }
    owned.clear();
  };

  return Object.freeze({
    register,
    unregister,
    publish,
    setState,
    switchMode,
    state: () => current,
    snapshot,
    adapters: () => Object.freeze(Array.from(owned.values(), (entry) => Object.freeze({
      id: entry.adapter.id,
      mode: entry.adapter.mode,
    }))),
    dispose,
  });
};
