import {
  normalizeViewState,
  serializeViewState,
  viewStatesEquivalent,
  type SerializedViewState,
  type ViewMode,
  type ViewState,
  type ViewStatePolicy,
  DEFAULT_VIEW_STATE_POLICY,
} from "./viewStateContract";

export interface ViewStateHistoryPolicy {
  readonly maxEntries: number;
  readonly maxBookmarks: number;
  readonly equivalenceTolerance: number;
  readonly maxBookmarkNameLength: number;
}

export interface ViewStateHistoryEntry {
  readonly id: number;
  readonly state: SerializedViewState;
  readonly reason: string;
  readonly recordedAt: number;
}

export interface ViewStateBookmark {
  readonly id: string;
  readonly name: string;
  readonly state: SerializedViewState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ViewStateHistorySnapshot {
  readonly entries: readonly ViewStateHistoryEntry[];
  readonly cursor: number;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly bookmarks: readonly ViewStateBookmark[];
  readonly revision: number;
}

export interface ViewStateHistoryMetrics {
  readonly recorded: number;
  readonly deduplicated: number;
  readonly evicted: number;
  readonly backNavigations: number;
  readonly forwardNavigations: number;
  readonly bookmarkWrites: number;
  readonly bookmarkDeletes: number;
  readonly rejected: number;
}

export interface ViewStateHistoryRuntime {
  record(state: ViewState, reason?: string): ViewStateHistoryEntry | null;
  current(): ViewStateHistoryEntry | null;
  back(): ViewStateHistoryEntry | null;
  forward(): ViewStateHistoryEntry | null;
  jump(entryId: number): ViewStateHistoryEntry | null;
  saveBookmark(id: string, name: string, state?: ViewState): ViewStateBookmark | null;
  deleteBookmark(id: string): boolean;
  getBookmark(id: string): ViewStateBookmark | null;
  listBookmarks(mode?: ViewMode): readonly ViewStateBookmark[];
  restoreBookmark(id: string): ViewStateHistoryEntry | null;
  clearHistory(): void;
  snapshot(): ViewStateHistorySnapshot;
  metrics(): ViewStateHistoryMetrics;
  dispose(): void;
}

export const DEFAULT_VIEW_STATE_HISTORY_POLICY: ViewStateHistoryPolicy = Object.freeze({
  maxEntries: 64,
  maxBookmarks: 32,
  equivalenceTolerance: 1e-7,
  maxBookmarkNameLength: 96,
});

function finiteInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value);
}

function validatePolicy(policy: ViewStateHistoryPolicy): void {
  if (!finiteInteger(policy.maxEntries) || policy.maxEntries < 2 || policy.maxEntries > 512) {
    throw new Error("Invalid GIS history maxEntries");
  }
  if (!finiteInteger(policy.maxBookmarks) || policy.maxBookmarks < 1 || policy.maxBookmarks > 256) {
    throw new Error("Invalid GIS history maxBookmarks");
  }
  if (!Number.isFinite(policy.equivalenceTolerance) || policy.equivalenceTolerance < 0 || policy.equivalenceTolerance > 1) {
    throw new Error("Invalid GIS history equivalenceTolerance");
  }
  if (!finiteInteger(policy.maxBookmarkNameLength) || policy.maxBookmarkNameLength < 1 || policy.maxBookmarkNameLength > 256) {
    throw new Error("Invalid GIS history maxBookmarkNameLength");
  }
}

function normalizeReason(value: string | undefined): string {
  const normalized = value?.trim().replace(/\s+/g, " ") ?? "navigation";
  return normalized.length === 0 ? "navigation" : normalized.slice(0, 64);
}

function normalizeBookmarkId(value: string): string | null {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 96) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) return null;
  return normalized;
}

function normalizeBookmarkName(value: string, maxLength: number): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return null;
  return normalized.slice(0, maxLength);
}

function serializedToViewState(value: SerializedViewState): ViewState {
  const center = {
    x: value.x,
    y: value.y,
    ...(value.z === undefined ? {} : { z: value.z }),
    spatialReference: { wkid: value.wkid },
  };
  return value.mode === "2d"
    ? { mode: "2d", center, scale: value.scale, rotation: value.heading }
    : { mode: "3d", center, scale: value.scale, heading: value.heading, tilt: value.tilt };
}

export function createViewStateHistoryRuntime(options: {
  readonly historyPolicy?: ViewStateHistoryPolicy;
  readonly viewStatePolicy?: ViewStatePolicy;
  readonly now?: () => number;
} = {}): ViewStateHistoryRuntime {
  const historyPolicy = options.historyPolicy ?? DEFAULT_VIEW_STATE_HISTORY_POLICY;
  const viewStatePolicy = options.viewStatePolicy ?? DEFAULT_VIEW_STATE_POLICY;
  validatePolicy(historyPolicy);

  const now = options.now ?? Date.now;
  let entries: ViewStateHistoryEntry[] = [];
  let cursor = -1;
  let nextId = 1;
  let revision = 0;
  let disposed = false;
  const bookmarks = new Map<string, ViewStateBookmark>();
  const counters = {
    recorded: 0,
    deduplicated: 0,
    evicted: 0,
    backNavigations: 0,
    forwardNavigations: 0,
    bookmarkWrites: 0,
    bookmarkDeletes: 0,
    rejected: 0,
  };

  function ensureActive(): boolean {
    if (!disposed) return true;
    counters.rejected += 1;
    return false;
  }

  function canonical(state: ViewState): ViewState | null {
    return normalizeViewState(state, viewStatePolicy);
  }

  function equivalent(left: SerializedViewState, right: SerializedViewState): boolean {
    return viewStatesEquivalent(
      serializedToViewState(left),
      serializedToViewState(right),
      historyPolicy.equivalenceTolerance,
      viewStatePolicy,
    );
  }

  function record(state: ViewState, reason?: string): ViewStateHistoryEntry | null {
    if (!ensureActive()) return null;
    const normalized = canonical(state);
    if (!normalized) {
      counters.rejected += 1;
      return null;
    }
    const serialized = serializeViewState(normalized, viewStatePolicy);
    if (!serialized) {
      counters.rejected += 1;
      return null;
    }
    const active = cursor >= 0 ? entries[cursor] : undefined;
    if (active && equivalent(active.state, serialized)) {
      counters.deduplicated += 1;
      return active;
    }

    if (cursor >= 0 && cursor < entries.length - 1) {
      entries = entries.slice(0, cursor + 1);
      revision += 1;
    }

    const entry: ViewStateHistoryEntry = Object.freeze({
      id: nextId++,
      state: Object.freeze({ ...serialized }),
      reason: normalizeReason(reason),
      recordedAt: now(),
    });
    entries.push(entry);
    cursor = entries.length - 1;
    counters.recorded += 1;
    revision += 1;

    if (entries.length > historyPolicy.maxEntries) {
      const excess = entries.length - historyPolicy.maxEntries;
      entries = entries.slice(excess);
      cursor = Math.max(0, cursor - excess);
      counters.evicted += excess;
      revision += 1;
    }
    return entry;
  }

  function current(): ViewStateHistoryEntry | null {
    return cursor >= 0 && cursor < entries.length ? entries[cursor] ?? null : null;
  }

  function back(): ViewStateHistoryEntry | null {
    if (!ensureActive() || cursor <= 0) return null;
    cursor -= 1;
    counters.backNavigations += 1;
    revision += 1;
    return current();
  }

  function forward(): ViewStateHistoryEntry | null {
    if (!ensureActive() || cursor < 0 || cursor >= entries.length - 1) return null;
    cursor += 1;
    counters.forwardNavigations += 1;
    revision += 1;
    return current();
  }

  function jump(entryId: number): ViewStateHistoryEntry | null {
    if (!ensureActive() || !finiteInteger(entryId) || entryId <= 0) return null;
    const index = entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) return null;
    cursor = index;
    revision += 1;
    return current();
  }

  function saveBookmark(id: string, name: string, state?: ViewState): ViewStateBookmark | null {
    if (!ensureActive()) return null;
    const bookmarkId = normalizeBookmarkId(id);
    const bookmarkName = normalizeBookmarkName(name, historyPolicy.maxBookmarkNameLength);
    if (!bookmarkId || !bookmarkName) {
      counters.rejected += 1;
      return null;
    }

    let serialized: SerializedViewState | null = null;
    if (state) {
      const normalized = canonical(state);
      serialized = normalized ? serializeViewState(normalized, viewStatePolicy) : null;
    } else {
      serialized = current()?.state ?? null;
    }
    if (!serialized) {
      counters.rejected += 1;
      return null;
    }

    const existing = bookmarks.get(bookmarkId);
    if (!existing && bookmarks.size >= historyPolicy.maxBookmarks) {
      counters.rejected += 1;
      return null;
    }
    const timestamp = now();
    const bookmark: ViewStateBookmark = Object.freeze({
      id: bookmarkId,
      name: bookmarkName,
      state: Object.freeze({ ...serialized }),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    bookmarks.set(bookmarkId, bookmark);
    counters.bookmarkWrites += 1;
    revision += 1;
    return bookmark;
  }

  function deleteBookmark(id: string): boolean {
    if (!ensureActive()) return false;
    const bookmarkId = normalizeBookmarkId(id);
    if (!bookmarkId || !bookmarks.delete(bookmarkId)) return false;
    counters.bookmarkDeletes += 1;
    revision += 1;
    return true;
  }

  function getBookmark(id: string): ViewStateBookmark | null {
    const bookmarkId = normalizeBookmarkId(id);
    return bookmarkId ? bookmarks.get(bookmarkId) ?? null : null;
  }

  function listBookmarks(mode?: ViewMode): readonly ViewStateBookmark[] {
    const values = [...bookmarks.values()];
    const filtered = mode ? values.filter((bookmark) => bookmark.state.mode === mode) : values;
    return Object.freeze(filtered.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)));
  }

  function restoreBookmark(id: string): ViewStateHistoryEntry | null {
    if (!ensureActive()) return null;
    const bookmark = getBookmark(id);
    return bookmark ? record(serializedToViewState(bookmark.state), `bookmark:${bookmark.id}`) : null;
  }

  function clearHistory(): void {
    if (!ensureActive()) return;
    if (entries.length === 0) return;
    entries = [];
    cursor = -1;
    revision += 1;
  }

  function snapshot(): ViewStateHistorySnapshot {
    return Object.freeze({
      entries: Object.freeze([...entries]),
      cursor,
      canGoBack: cursor > 0,
      canGoForward: cursor >= 0 && cursor < entries.length - 1,
      bookmarks: listBookmarks(),
      revision,
    });
  }

  function metrics(): ViewStateHistoryMetrics {
    return Object.freeze({ ...counters });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    entries = [];
    cursor = -1;
    bookmarks.clear();
    revision += 1;
  }

  return Object.freeze({
    record,
    current,
    back,
    forward,
    jump,
    saveBookmark,
    deleteBookmark,
    getBookmark,
    listBookmarks,
    restoreBookmark,
    clearHistory,
    snapshot,
    metrics,
    dispose,
  });
}
