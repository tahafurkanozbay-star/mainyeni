import {
  DEFAULT_VIEW_STATE_POLICY,
  normalizeViewState,
  transitionViewState,
  viewStatesEquivalent,
  type ViewMode,
  type ViewState,
  type ViewStatePolicy,
} from "./viewStateContract";

export type ViewSyncSource = "2d" | "3d" | "external";
export type ViewSyncReason = "navigation" | "mode-transition" | "restore" | "external";

export interface ViewStateSyncPolicy {
  readonly equivalenceTolerance: number;
  readonly maxPendingUpdates: number;
  readonly maxObservers: number;
  readonly maxRecentTransactions: number;
  readonly transactionTtlMs: number;
}

export interface ViewStateSyncUpdate {
  readonly transactionId: number;
  readonly source: ViewSyncSource;
  readonly target: ViewMode;
  readonly reason: ViewSyncReason;
  readonly state: ViewState;
  readonly createdAt: number;
}

export interface ViewStateSyncSnapshot {
  readonly activeMode: ViewMode;
  readonly state2d: ViewState | null;
  readonly state3d: ViewState | null;
  readonly pending: readonly ViewStateSyncUpdate[];
  readonly revision: number;
  readonly disposed: boolean;
}

export interface ViewStateSyncMetrics {
  readonly accepted: number;
  readonly deduplicated: number;
  readonly rejected: number;
  readonly evicted: number;
  readonly applied: number;
  readonly staleAcks: number;
  readonly modeTransitions: number;
  readonly observerErrors: number;
}

export type ViewStateSyncObserver = (snapshot: ViewStateSyncSnapshot, update: ViewStateSyncUpdate | null) => void;

export interface ViewStateSyncRuntime {
  publish(source: ViewSyncSource, state: ViewState, reason?: ViewSyncReason): ViewStateSyncUpdate | null;
  transition(targetMode: ViewMode): ViewStateSyncUpdate | null;
  acknowledge(transactionId: number, state?: ViewState): boolean;
  subscribe(observer: ViewStateSyncObserver): () => void;
  snapshot(): ViewStateSyncSnapshot;
  metrics(): ViewStateSyncMetrics;
  dispose(): void;
}

export const DEFAULT_VIEW_STATE_SYNC_POLICY: ViewStateSyncPolicy = Object.freeze({
  equivalenceTolerance: 1e-7,
  maxPendingUpdates: 16,
  maxObservers: 16,
  maxRecentTransactions: 64,
  transactionTtlMs: 15_000,
});

interface RecentTransaction {
  readonly id: number;
  readonly expiresAt: number;
}

function validInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validatePolicy(policy: ViewStateSyncPolicy): void {
  if (!Number.isFinite(policy.equivalenceTolerance) || policy.equivalenceTolerance < 0 || policy.equivalenceTolerance > 1) {
    throw new Error("Invalid GIS view sync equivalenceTolerance");
  }
  if (!validInteger(policy.maxPendingUpdates, 1, 128)) throw new Error("Invalid GIS view sync maxPendingUpdates");
  if (!validInteger(policy.maxObservers, 1, 128)) throw new Error("Invalid GIS view sync maxObservers");
  if (!validInteger(policy.maxRecentTransactions, 1, 1024)) throw new Error("Invalid GIS view sync maxRecentTransactions");
  if (!validInteger(policy.transactionTtlMs, 100, 300_000)) throw new Error("Invalid GIS view sync transactionTtlMs");
}

function targetFor(source: ViewSyncSource, state: ViewState): ViewMode {
  if (source === "2d") return "3d";
  if (source === "3d") return "2d";
  return state.mode;
}

export function createViewStateSyncRuntime(options: {
  readonly syncPolicy?: ViewStateSyncPolicy;
  readonly viewStatePolicy?: ViewStatePolicy;
  readonly initialMode?: ViewMode;
  readonly initialState?: ViewState;
  readonly now?: () => number;
} = {}): ViewStateSyncRuntime {
  const syncPolicy = options.syncPolicy ?? DEFAULT_VIEW_STATE_SYNC_POLICY;
  const viewStatePolicy = options.viewStatePolicy ?? DEFAULT_VIEW_STATE_POLICY;
  validatePolicy(syncPolicy);
  const now = options.now ?? Date.now;

  let activeMode: ViewMode = options.initialMode ?? "2d";
  let state2d: ViewState | null = null;
  let state3d: ViewState | null = null;
  let pending: ViewStateSyncUpdate[] = [];
  let recent: RecentTransaction[] = [];
  let revision = 0;
  let nextTransactionId = 1;
  let disposed = false;
  const observers = new Set<ViewStateSyncObserver>();
  const counters = {
    accepted: 0,
    deduplicated: 0,
    rejected: 0,
    evicted: 0,
    applied: 0,
    staleAcks: 0,
    modeTransitions: 0,
    observerErrors: 0,
  };

  function canonical(state: ViewState): ViewState | null {
    return normalizeViewState(state, viewStatePolicy);
  }

  function equivalent(left: ViewState | null, right: ViewState): boolean {
    return left !== null && viewStatesEquivalent(left, right, syncPolicy.equivalenceTolerance, viewStatePolicy);
  }

  function equivalentTarget(source: ViewState, targetState: ViewState | null, converted: ViewState): boolean {
    if (targetState === null) return false;
    if (source.mode !== "2d" || targetState.mode !== "3d" || converted.mode !== "3d") {
      return equivalent(targetState, converted);
    }
    const targetWithoutAltitude: ViewState = {
      ...targetState,
      center: {
        x: targetState.center.x,
        y: targetState.center.y,
        spatialReference: targetState.center.spatialReference,
      },
    };
    return equivalent(targetWithoutAltitude, converted);
  }

  function pruneRecent(timestamp: number): void {
    recent = recent.filter((transaction) => transaction.expiresAt > timestamp);
    if (recent.length > syncPolicy.maxRecentTransactions) {
      recent = recent.slice(recent.length - syncPolicy.maxRecentTransactions);
    }
  }

  function remember(transactionId: number, timestamp: number): void {
    pruneRecent(timestamp);
    recent.push({ id: transactionId, expiresAt: timestamp + syncPolicy.transactionTtlMs });
    if (recent.length > syncPolicy.maxRecentTransactions) recent.shift();
  }

  function isRecent(transactionId: number, timestamp: number): boolean {
    pruneRecent(timestamp);
    return recent.some((transaction) => transaction.id === transactionId);
  }

  function snapshot(): ViewStateSyncSnapshot {
    return Object.freeze({
      activeMode,
      state2d,
      state3d,
      pending: Object.freeze([...pending]),
      revision,
      disposed,
    });
  }

  function notify(update: ViewStateSyncUpdate | null): void {
    if (observers.size === 0) return;
    const current = snapshot();
    for (const observer of observers) {
      try {
        observer(current, update);
      } catch {
        counters.observerErrors += 1;
      }
    }
  }

  function storeState(state: ViewState): void {
    if (state.mode === "2d") state2d = state;
    else state3d = state;
  }

  function enqueue(source: ViewSyncSource, target: ViewMode, state: ViewState, reason: ViewSyncReason): ViewStateSyncUpdate {
    const timestamp = now();
    const update: ViewStateSyncUpdate = Object.freeze({
      transactionId: nextTransactionId++,
      source,
      target,
      reason,
      state,
      createdAt: timestamp,
    });
    pending.push(update);
    if (pending.length > syncPolicy.maxPendingUpdates) {
      const excess = pending.length - syncPolicy.maxPendingUpdates;
      const evicted = pending.splice(0, excess);
      for (const item of evicted) remember(item.transactionId, timestamp);
      counters.evicted += excess;
    }
    counters.accepted += 1;
    revision += 1;
    notify(update);
    return update;
  }

  function publish(source: ViewSyncSource, state: ViewState, reason: ViewSyncReason = source === "external" ? "external" : "navigation"): ViewStateSyncUpdate | null {
    if (disposed) {
      counters.rejected += 1;
      return null;
    }
    const normalized = canonical(state);
    if (!normalized) {
      counters.rejected += 1;
      return null;
    }

    storeState(normalized);
    const target = targetFor(source, normalized);
    const converted = normalized.mode === target
      ? normalized
      : transitionViewState(normalized, target, viewStatePolicy)?.state ?? null;
    if (!converted) {
      counters.rejected += 1;
      return null;
    }

    const targetState = target === "2d" ? state2d : state3d;
    if (equivalentTarget(normalized, targetState, converted)) {
      counters.deduplicated += 1;
      revision += 1;
      notify(null);
      return null;
    }
    return enqueue(source, target, converted, reason);
  }

  function transition(targetMode: ViewMode): ViewStateSyncUpdate | null {
    if (disposed) {
      counters.rejected += 1;
      return null;
    }
    if (activeMode === targetMode) {
      counters.deduplicated += 1;
      return null;
    }
    const sourceState = activeMode === "2d" ? state2d : state3d;
    if (!sourceState) {
      counters.rejected += 1;
      return null;
    }
    const transitionResult = transitionViewState(sourceState, targetMode, viewStatePolicy);
    if (!transitionResult) {
      counters.rejected += 1;
      return null;
    }
    activeMode = targetMode;
    storeState(transitionResult.state);
    counters.modeTransitions += 1;
    return enqueue(sourceState.mode, targetMode, transitionResult.state, "mode-transition");
  }

  function acknowledge(transactionId: number, state?: ViewState): boolean {
    if (disposed || !Number.isInteger(transactionId) || transactionId <= 0) {
      counters.rejected += 1;
      return false;
    }
    const timestamp = now();
    const index = pending.findIndex((update) => update.transactionId === transactionId);
    if (index < 0) {
      if (isRecent(transactionId, timestamp)) counters.staleAcks += 1;
      else counters.rejected += 1;
      return false;
    }
    const update = pending[index];
    if (!update) return false;
    let appliedState = update.state;
    if (state !== undefined) {
      const normalized = canonical(state);
      if (!normalized || normalized.mode !== update.target) {
        counters.rejected += 1;
        return false;
      }
      appliedState = normalized;
    }
    pending.splice(index, 1);
    remember(transactionId, timestamp);
    storeState(appliedState);
    counters.applied += 1;
    revision += 1;
    notify(null);
    return true;
  }

  function subscribe(observer: ViewStateSyncObserver): () => void {
    if (disposed) return () => undefined;
    if (observers.size >= syncPolicy.maxObservers) {
      counters.rejected += 1;
      return () => undefined;
    }
    observers.add(observer);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      observers.delete(observer);
    };
  }

  function metrics(): ViewStateSyncMetrics {
    return Object.freeze({ ...counters });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    pending = [];
    recent = [];
    observers.clear();
    state2d = null;
    state3d = null;
    revision += 1;
  }

  if (options.initialState) {
    const normalized = canonical(options.initialState);
    if (!normalized) throw new Error("Invalid GIS initial view state");
    storeState(normalized);
    activeMode = normalized.mode;
  }

  return Object.freeze({ publish, transition, acknowledge, subscribe, snapshot, metrics, dispose });
}
