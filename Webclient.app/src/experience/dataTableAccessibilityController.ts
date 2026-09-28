import type { DataTableInteractionModel, DataTableSnapshot } from './dataTableInteractionModel';

export type DataTableKeyboardAction =
  | 'activate-first'
  | 'activate-last'
  | 'activate-next'
  | 'activate-previous'
  | 'clear-selection'
  | 'next-page'
  | 'previous-page'
  | 'select-active'
  | 'select-visible';

export interface DataTableKeyboardEventLike {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  preventDefault(): void;
}

export interface DataTableAccessibilityFacts {
  readonly activeDescendant: string | null;
  readonly announcement: string;
  readonly canNextPage: boolean;
  readonly canPreviousPage: boolean;
  readonly pageLabel: string;
  readonly rowCount: number;
  readonly selectedCount: number;
  readonly visibleRowCount: number;
}

export interface DataTableRowAccessibilityFacts {
  readonly active: boolean;
  readonly ariaPosInSet: number;
  readonly ariaSelected: boolean | undefined;
  readonly ariaSetSize: number;
  readonly id: string;
  readonly rowId: string;
  readonly tabIndex: 0 | -1;
}

export interface DataTableAccessibilityOptions<Row> {
  readonly model: DataTableInteractionModel<Row>;
  readonly tableId: string;
  readonly selectionMode?: 'none' | 'single' | 'multiple';
  readonly onFocusRequest?: (rowDomId: string) => void;
  readonly onObserverError?: (error: unknown) => void;
}

export interface DataTableAccessibilityController {
  snapshot(): DataTableAccessibilityFacts;
  row(rowId: string): DataTableRowAccessibilityFacts | null;
  handleKey(event: DataTableKeyboardEventLike): DataTableKeyboardAction | null;
  activate(rowId: string): void;
  toggle(rowId: string): void;
  subscribe(observer: (facts: DataTableAccessibilityFacts) => void): () => void;
  dispose(): void;
}

const normalizeToken = (value: string): string => value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-');

const reportSafely = (reporter: ((error: unknown) => void) | undefined, error: unknown): void => {
  if (!reporter) return;
  try {
    reporter(error);
  } catch (reportingError) {
    void reportingError;
  }
};

const keyboardAction = (event: DataTableKeyboardEventLike): DataTableKeyboardAction | null => {
  if (event.altKey || event.metaKey) return null;
  switch (event.key) {
    case 'ArrowDown': return 'activate-next';
    case 'ArrowUp': return 'activate-previous';
    case 'Home': return event.ctrlKey ? 'activate-first' : null;
    case 'End': return event.ctrlKey ? 'activate-last' : null;
    case 'PageDown': return 'next-page';
    case 'PageUp': return 'previous-page';
    case ' ':
    case 'Enter': return 'select-active';
    case 'a':
    case 'A': return event.ctrlKey ? 'select-visible' : null;
    case 'Escape': return 'clear-selection';
    default: return null;
  }
};

export const createDataTableAccessibilityController = <Row>(
  options: DataTableAccessibilityOptions<Row>,
): DataTableAccessibilityController => {
  const tableId = normalizeToken(options.tableId);
  if (!tableId) throw new Error('Erişilebilir tablo kimliği boş olamaz.');
  const selectionMode = options.selectionMode ?? 'multiple';
  let disposed = false;
  let latest = options.model.snapshot();
  const observers = new Set<(facts: DataTableAccessibilityFacts) => void>();

  const assertActive = (): void => {
    if (disposed) throw new Error('DataTableAccessibilityController dispose edildikten sonra kullanılamaz.');
  };

  const rowDomId = (rowId: string): string => `${tableId}-row-${normalizeToken(rowId)}`;

  const facts = (): DataTableAccessibilityFacts => Object.freeze({
    activeDescendant: latest.activeRowId ? rowDomId(latest.activeRowId) : null,
    announcement: latest.announcement,
    canNextPage: latest.canNextPage,
    canPreviousPage: latest.canPreviousPage,
    pageLabel: `${latest.pageIndex + 1} / ${latest.pageCount}`,
    rowCount: latest.totalRows,
    selectedCount: latest.selectedIds.length,
    visibleRowCount: latest.visibleRows,
  });

  const notify = (): void => {
    const next = facts();
    observers.forEach((observer) => {
      try {
        observer(next);
      } catch (error) {
        reportSafely(options.onObserverError, error);
      }
    });
  };

  const focusActive = (): void => {
    const id = latest.activeRowId;
    if (!id || !options.onFocusRequest) return;
    try {
      options.onFocusRequest(rowDomId(id));
    } catch (error) {
      reportSafely(options.onObserverError, error);
    }
  };

  const unsubscribeModel = options.model.subscribe((snapshot: DataTableSnapshot<Row>) => {
    latest = snapshot;
    notify();
  });

  const perform = (action: DataTableKeyboardAction): void => {
    switch (action) {
      case 'activate-first':
        options.model.moveActiveToBoundary('first');
        focusActive();
        break;
      case 'activate-last':
        options.model.moveActiveToBoundary('last');
        focusActive();
        break;
      case 'activate-next':
        options.model.moveActive(1);
        focusActive();
        break;
      case 'activate-previous':
        options.model.moveActive(-1);
        focusActive();
        break;
      case 'clear-selection':
        options.model.clearSelection();
        break;
      case 'next-page':
        if (latest.canNextPage) options.model.nextPage();
        break;
      case 'previous-page':
        if (latest.canPreviousPage) options.model.previousPage();
        break;
      case 'select-active':
        if (latest.activeRowId && selectionMode !== 'none') options.model.toggleSelection(latest.activeRowId);
        break;
      case 'select-visible':
        if (selectionMode === 'multiple') options.model.selectAllVisible();
        break;
    }
  };

  return {
    snapshot() {
      assertActive();
      return facts();
    },
    row(rowId) {
      assertActive();
      const id = rowId.trim();
      const found = latest.rows.find((entry) => entry.id === id);
      if (!found) return null;
      return Object.freeze({
        active: found.active,
        ariaPosInSet: found.position,
        ariaSelected: selectionMode === 'none' ? undefined : found.selected,
        ariaSetSize: latest.totalRows,
        id: rowDomId(found.id),
        rowId: found.id,
        tabIndex: found.active ? 0 : -1,
      });
    },
    handleKey(event) {
      assertActive();
      const action = keyboardAction(event);
      if (!action) return null;
      event.preventDefault();
      perform(action);
      return action;
    },
    activate(rowId) {
      assertActive();
      options.model.setActive(rowId);
      focusActive();
    },
    toggle(rowId) {
      assertActive();
      if (selectionMode === 'none') return;
      options.model.toggleSelection(rowId);
    },
    subscribe(observer) {
      assertActive();
      observers.add(observer);
      try {
        observer(facts());
      } catch (error) {
        reportSafely(options.onObserverError, error);
      }
      return () => observers.delete(observer);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeModel();
      observers.clear();
    },
  };
};
