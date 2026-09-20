export type DataGridSortDirection = 'ascending' | 'descending';
export type DataGridSelectionMode = 'none' | 'single' | 'multiple';
export type DataGridNavigationIntent =
  | 'first-row'
  | 'last-row'
  | 'next-row'
  | 'previous-row'
  | 'page-forward'
  | 'page-backward'
  | 'activate'
  | 'toggle-selection'
  | 'clear-selection';

export interface DataGridSortState {
  readonly columnId: string;
  readonly direction: DataGridSortDirection;
}

export interface DataGridViewport {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly rowHeight: number;
  readonly overscan: number;
}

export interface DataGridVisibleRange {
  readonly start: number;
  readonly end: number;
  readonly offsetTop: number;
  readonly totalHeight: number;
}

export interface DataGridRuntimeConfig<Row> {
  readonly rows: readonly Row[];
  readonly getRowKey: (row: Row, index: number) => string;
  readonly selectionMode?: DataGridSelectionMode;
  readonly pageSize?: number;
  readonly maxSelection?: number;
  readonly initialSort?: DataGridSortState | null;
  readonly initialFocusedKey?: string | null;
  readonly initialSelectedKeys?: readonly string[];
}

export interface DataGridRuntimeSnapshot {
  readonly rowCount: number;
  readonly pageSize: number;
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly focusedKey: string | null;
  readonly focusedIndex: number;
  readonly selectedKeys: readonly string[];
  readonly sort: DataGridSortState | null;
  readonly selectionMode: DataGridSelectionMode;
  readonly canPageBackward: boolean;
  readonly canPageForward: boolean;
  readonly revision: number;
}

export interface DataGridRuntime<Row> {
  readonly snapshot: () => DataGridRuntimeSnapshot;
  readonly rows: () => readonly Row[];
  readonly pageRows: () => readonly Row[];
  readonly focus: (key: string | null) => DataGridRuntimeSnapshot;
  readonly navigate: (intent: DataGridNavigationIntent) => DataGridRuntimeSnapshot;
  readonly select: (key: string, selected?: boolean) => DataGridRuntimeSnapshot;
  readonly clearSelection: () => DataGridRuntimeSnapshot;
  readonly setPage: (pageIndex: number) => DataGridRuntimeSnapshot;
  readonly setSort: (sort: DataGridSortState | null) => DataGridRuntimeSnapshot;
  readonly replaceRows: (rows: readonly Row[]) => DataGridRuntimeSnapshot;
  readonly visibleRange: (viewport: DataGridViewport) => DataGridVisibleRange;
  readonly subscribe: (listener: (snapshot: DataGridRuntimeSnapshot) => void) => () => void;
  readonly dispose: () => void;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const positiveInteger = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
};

const normalizeKey = (value: string): string => value.trim();

const uniqueKeys = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalizeKey(value);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return Object.freeze(result);
};

const freezeSort = (value: DataGridSortState | null): DataGridSortState | null =>
  value === null
    ? null
    : Object.freeze({ columnId: value.columnId, direction: value.direction });

export const navigationIntentFromKeyboard = (
  key: string,
  options: { readonly ctrlKey?: boolean; readonly metaKey?: boolean; readonly shiftKey?: boolean } = {},
): DataGridNavigationIntent | null => {
  const command = options.ctrlKey === true || options.metaKey === true;
  if (key === 'ArrowDown') return 'next-row';
  if (key === 'ArrowUp') return 'previous-row';
  if (key === 'PageDown') return 'page-forward';
  if (key === 'PageUp') return 'page-backward';
  if (key === 'Home') return command ? 'first-row' : 'first-row';
  if (key === 'End') return command ? 'last-row' : 'last-row';
  if (key === 'Enter') return 'activate';
  if (key === ' ' && options.shiftKey !== true) return 'toggle-selection';
  if (key === 'Escape') return 'clear-selection';
  return null;
};

export const calculateVisibleDataGridRange = (
  rowCount: number,
  viewport: DataGridViewport,
): DataGridVisibleRange => {
  const safeCount = Math.max(0, Math.floor(rowCount));
  const rowHeight = Math.max(1, viewport.rowHeight);
  const viewportHeight = Math.max(0, viewport.viewportHeight);
  const scrollTop = Math.max(0, viewport.scrollTop);
  const overscan = Math.max(0, Math.floor(viewport.overscan));
  if (safeCount === 0) {
    return Object.freeze({ start: 0, end: 0, offsetTop: 0, totalHeight: 0 });
  }
  const firstVisible = clamp(Math.floor(scrollTop / rowHeight), 0, safeCount - 1);
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(safeCount, firstVisible + visibleCount + overscan);
  return Object.freeze({
    start,
    end,
    offsetTop: start * rowHeight,
    totalHeight: safeCount * rowHeight,
  });
};

export const createDataGridRuntime = <Row>(config: DataGridRuntimeConfig<Row>): DataGridRuntime<Row> => {
  let rows = [...config.rows];
  const getRowKey = config.getRowKey;
  const selectionMode = config.selectionMode ?? 'none';
  const pageSize = positiveInteger(config.pageSize, 25);
  const maxSelection = positiveInteger(config.maxSelection, 500);
  let sort = freezeSort(config.initialSort ?? null);
  let focusedKey = config.initialFocusedKey ? normalizeKey(config.initialFocusedKey) : null;
  let selectedKeys = uniqueKeys(config.initialSelectedKeys ?? []);
  let pageIndex = 0;
  let revision = 0;
  let disposed = false;
  const listeners = new Set<(snapshot: DataGridRuntimeSnapshot) => void>();

  const keys = (): readonly string[] => rows.map((row, index) => normalizeKey(getRowKey(row, index)));
  const keySet = (): ReadonlySet<string> => new Set(keys());
  const rowCount = (): number => rows.length;
  const pageCount = (): number => Math.max(1, Math.ceil(rowCount() / pageSize));

  const reconcile = (): void => {
    const available = keySet();
    selectedKeys = selectedKeys.filter((key) => available.has(key));
    if (selectionMode === 'none') selectedKeys = [];
    if (selectionMode === 'single' && selectedKeys.length > 1) selectedKeys = selectedKeys.slice(0, 1);
    if (selectedKeys.length > maxSelection) selectedKeys = selectedKeys.slice(0, maxSelection);
    if (focusedKey !== null && !available.has(focusedKey)) focusedKey = null;
    pageIndex = clamp(pageIndex, 0, pageCount() - 1);
  };

  const snapshot = (): DataGridRuntimeSnapshot => {
    reconcile();
    const allKeys = keys();
    const focusedIndex = focusedKey === null ? -1 : allKeys.indexOf(focusedKey);
    const pages = pageCount();
    return Object.freeze({
      rowCount: rowCount(),
      pageSize,
      pageIndex,
      pageCount: pages,
      focusedKey,
      focusedIndex,
      selectedKeys: Object.freeze([...selectedKeys]),
      sort,
      selectionMode,
      canPageBackward: pageIndex > 0,
      canPageForward: pageIndex < pages - 1,
      revision,
    });
  };

  const emit = (): DataGridRuntimeSnapshot => {
    revision += 1;
    const next = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // Observer isolation is intentional: UI diagnostics must not break interaction state.
      }
    }
    return next;
  };

  const ensureActive = (): boolean => !disposed;

  const focusIndex = (index: number): DataGridRuntimeSnapshot => {
    if (!ensureActive()) return snapshot();
    const allKeys = keys();
    if (allKeys.length === 0) {
      focusedKey = null;
      return emit();
    }
    const nextIndex = clamp(index, 0, allKeys.length - 1);
    focusedKey = allKeys[nextIndex] ?? null;
    pageIndex = Math.floor(nextIndex / pageSize);
    return emit();
  };

  const focus = (key: string | null): DataGridRuntimeSnapshot => {
    if (!ensureActive()) return snapshot();
    if (key === null) {
      focusedKey = null;
      return emit();
    }
    const normalized = normalizeKey(key);
    const index = keys().indexOf(normalized);
    if (index < 0) return snapshot();
    return focusIndex(index);
  };

  const select = (key: string, selected?: boolean): DataGridRuntimeSnapshot => {
    if (!ensureActive() || selectionMode === 'none') return snapshot();
    const normalized = normalizeKey(key);
    if (!keySet().has(normalized)) return snapshot();
    const exists = selectedKeys.includes(normalized);
    const shouldSelect = selected ?? !exists;
    if (selectionMode === 'single') {
      selectedKeys = shouldSelect ? [normalized] : [];
      focusedKey = normalized;
      return emit();
    }
    if (shouldSelect && !exists) {
      selectedKeys = [...selectedKeys, normalized].slice(-maxSelection);
    } else if (!shouldSelect && exists) {
      selectedKeys = selectedKeys.filter((item) => item !== normalized);
    }
    focusedKey = normalized;
    return emit();
  };

  const clearSelection = (): DataGridRuntimeSnapshot => {
    if (!ensureActive() || selectedKeys.length === 0) return snapshot();
    selectedKeys = [];
    return emit();
  };

  const navigate = (intent: DataGridNavigationIntent): DataGridRuntimeSnapshot => {
    if (!ensureActive()) return snapshot();
    const allKeys = keys();
    if (allKeys.length === 0) return snapshot();
    const currentIndex = focusedKey === null ? -1 : allKeys.indexOf(focusedKey);
    switch (intent) {
      case 'first-row': return focusIndex(0);
      case 'last-row': return focusIndex(allKeys.length - 1);
      case 'next-row': return focusIndex(currentIndex < 0 ? 0 : currentIndex + 1);
      case 'previous-row': return focusIndex(currentIndex < 0 ? allKeys.length - 1 : currentIndex - 1);
      case 'page-forward': return focusIndex(currentIndex < 0 ? 0 : currentIndex + pageSize);
      case 'page-backward': return focusIndex(currentIndex < 0 ? 0 : currentIndex - pageSize);
      case 'toggle-selection': {
        const key = currentIndex >= 0 ? allKeys[currentIndex] : allKeys[0];
        return key ? select(key) : snapshot();
      }
      case 'clear-selection': return clearSelection();
      case 'activate': return snapshot();
    }
  };

  const setPage = (nextPage: number): DataGridRuntimeSnapshot => {
    if (!ensureActive()) return snapshot();
    pageIndex = clamp(Math.floor(nextPage), 0, pageCount() - 1);
    const firstIndex = Math.min(rows.length - 1, pageIndex * pageSize);
    if (rows.length > 0) focusedKey = keys()[firstIndex] ?? focusedKey;
    return emit();
  };

  const setSort = (nextSort: DataGridSortState | null): DataGridRuntimeSnapshot => {
    if (!ensureActive()) return snapshot();
    sort = freezeSort(nextSort);
    pageIndex = 0;
    return emit();
  };

  const replaceRows = (nextRows: readonly Row[]): DataGridRuntimeSnapshot => {
    if (!ensureActive()) return snapshot();
    rows = [...nextRows];
    reconcile();
    return emit();
  };

  const pageRows = (): readonly Row[] => {
    const start = pageIndex * pageSize;
    return Object.freeze(rows.slice(start, start + pageSize));
  };

  const subscribe = (listener: (value: DataGridRuntimeSnapshot) => void): (() => void) => {
    if (disposed) return () => undefined;
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const dispose = (): void => {
    disposed = true;
    listeners.clear();
  };

  reconcile();
  return Object.freeze({
    snapshot,
    rows: () => Object.freeze([...rows]),
    pageRows,
    focus,
    navigate,
    select,
    clearSelection,
    setPage,
    setSort,
    replaceRows,
    visibleRange: (viewport) => calculateVisibleDataGridRange(rows.length, viewport),
    subscribe,
    dispose,
  });
};
