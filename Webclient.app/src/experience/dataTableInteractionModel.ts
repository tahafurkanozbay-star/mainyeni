export type DataTableSortDirection = 'ascending' | 'descending';
export type DataTableSelectionMode = 'none' | 'single' | 'multiple';

export interface DataTableColumn<Row> {
  readonly id: string;
  readonly label: string;
  readonly sortable?: boolean;
  readonly value: (row: Row) => unknown;
  readonly compare?: (left: Row, right: Row) => number;
}

export interface DataTableRow<Row> {
  readonly id: string;
  readonly value: Row;
  readonly selected: boolean;
  readonly active: boolean;
  readonly position: number;
}

export interface DataTableSort {
  readonly columnId: string;
  readonly direction: DataTableSortDirection;
}

export interface DataTableSnapshot<Row> {
  readonly rows: readonly DataTableRow<Row>[];
  readonly totalRows: number;
  readonly visibleRows: number;
  readonly selectedIds: readonly string[];
  readonly activeRowId: string | null;
  readonly sort: DataTableSort | null;
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly canPreviousPage: boolean;
  readonly canNextPage: boolean;
  readonly announcement: string;
  readonly revision: number;
}

export interface DataTableInteractionOptions<Row> {
  readonly rowId: (row: Row) => string;
  readonly columns: readonly DataTableColumn<Row>[];
  readonly selectionMode?: DataTableSelectionMode;
  readonly pageSize?: number;
  readonly maxRows?: number;
  readonly onObserverError?: (error: unknown) => void;
}

export interface DataTableInteractionModel<Row> {
  snapshot(): DataTableSnapshot<Row>;
  setRows(rows: readonly Row[]): void;
  setPage(index: number): void;
  nextPage(): void;
  previousPage(): void;
  setPageSize(size: number): void;
  sortBy(columnId: string): void;
  clearSort(): void;
  setActive(rowId: string | null): void;
  moveActive(delta: number): void;
  moveActiveToBoundary(boundary: 'first' | 'last'): void;
  toggleSelection(rowId: string): void;
  selectOnly(rowId: string): void;
  selectAllVisible(): void;
  clearSelection(): void;
  subscribe(observer: (snapshot: DataTableSnapshot<Row>) => void): () => void;
  dispose(): void;
}

interface IndexedRow<Row> {
  readonly id: string;
  readonly value: Row;
  readonly sourceIndex: number;
}

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_ROWS = 10_000;
const MAX_PAGE_SIZE = 250;

const normalizeId = (value: string): string => value.trim();
const clampInteger = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

const defaultCompare = (left: unknown, right: unknown): number => {
  if (Object.is(left, right)) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'bigint' && typeof right === 'bigint') return left < right ? -1 : 1;
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  return String(left).localeCompare(String(right), 'tr', { numeric: true, sensitivity: 'base' });
};

export const createDataTableInteractionModel = <Row>(
  options: DataTableInteractionOptions<Row>,
): DataTableInteractionModel<Row> => {
  const selectionMode = options.selectionMode ?? 'multiple';
  const maxRows = clampInteger(options.maxRows ?? DEFAULT_MAX_ROWS, 1, 100_000);
  let pageSize = clampInteger(options.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  let pageIndex = 0;
  let rows: IndexedRow<Row>[] = [];
  let sort: DataTableSort | null = null;
  let activeRowId: string | null = null;
  let announcement = '';
  let revision = 0;
  let disposed = false;
  const selected = new Set<string>();
  const observers = new Set<(snapshot: DataTableSnapshot<Row>) => void>();
  const columns = new Map<string, DataTableColumn<Row>>();

  for (const column of options.columns) {
    const id = normalizeId(column.id);
    if (!id) throw new Error('Tablo sütunu kimliği boş olamaz.');
    if (columns.has(id)) throw new Error(`Tablo sütunu kimliği tekrarlanamaz: ${id}`);
    columns.set(id, column);
  }

  const assertActive = (): void => {
    if (disposed) throw new Error('DataTableInteractionModel dispose edildikten sonra kullanılamaz.');
  };

  const report = (error: unknown): void => {
    const reporter = options.onObserverError;
    if (!reporter) return;
    try { reporter(error); } catch (reportingError) { void reportingError; }
  };

  const orderedRows = (): readonly IndexedRow<Row>[] => {
    if (!sort) return rows;
    const column = columns.get(sort.columnId);
    if (!column) return rows;
    const direction = sort.direction === 'ascending' ? 1 : -1;
    return [...rows].sort((left, right) => {
      const compared = column.compare
        ? column.compare(left.value, right.value)
        : defaultCompare(column.value(left.value), column.value(right.value));
      if (compared !== 0) return compared * direction;
      return left.sourceIndex - right.sourceIndex;
    });
  };

  const pageCount = (): number => Math.max(1, Math.ceil(rows.length / pageSize));

  const normalizePage = (): void => {
    pageIndex = clampInteger(pageIndex, 0, pageCount() - 1);
  };

  const visibleIndexedRows = (): readonly IndexedRow<Row>[] => {
    normalizePage();
    const ordered = orderedRows();
    const start = pageIndex * pageSize;
    return ordered.slice(start, start + pageSize);
  };

  const buildSnapshot = (): DataTableSnapshot<Row> => {
    const visible = visibleIndexedRows();
    const rendered = visible.map((row, index): DataTableRow<Row> => Object.freeze({
      id: row.id,
      value: row.value,
      selected: selected.has(row.id),
      active: activeRowId === row.id,
      position: pageIndex * pageSize + index + 1,
    }));
    const pages = pageCount();
    return Object.freeze({
      rows: Object.freeze(rendered),
      totalRows: rows.length,
      visibleRows: rendered.length,
      selectedIds: Object.freeze(Array.from(selected)),
      activeRowId,
      sort: sort ? Object.freeze({ ...sort }) : null,
      pageIndex,
      pageSize,
      pageCount: pages,
      canPreviousPage: pageIndex > 0,
      canNextPage: pageIndex < pages - 1,
      announcement,
      revision,
    });
  };

  const notify = (): void => {
    revision += 1;
    const snapshot = buildSnapshot();
    observers.forEach((observer) => {
      try { observer(snapshot); } catch (error) { report(error); }
    });
  };

  const rowExists = (id: string): boolean => rows.some((row) => row.id === id);

  const setAnnouncementForSelection = (): void => {
    if (selected.size === 0) announcement = 'Tablo seçimi temizlendi.';
    else if (selected.size === 1) announcement = '1 kayıt seçildi.';
    else announcement = `${selected.size} kayıt seçildi.`;
  };

  const setRows = (nextRows: readonly Row[]): void => {
    assertActive();
    if (nextRows.length > maxRows) throw new Error(`Tablo en fazla ${maxRows} kayıt kabul eder.`);
    const next: IndexedRow<Row>[] = [];
    const ids = new Set<string>();
    nextRows.forEach((value, sourceIndex) => {
      const id = normalizeId(options.rowId(value));
      if (!id) throw new Error(`Tablo satırı ${sourceIndex + 1} için kimlik boş olamaz.`);
      if (ids.has(id)) throw new Error(`Tablo satırı kimliği tekrarlanamaz: ${id}`);
      ids.add(id);
      next.push({ id, value, sourceIndex });
    });
    rows = next;
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    if (activeRowId && !ids.has(activeRowId)) activeRowId = null;
    normalizePage();
    announcement = rows.length === 0 ? 'Tabloda kayıt yok.' : `${rows.length} kayıt yüklendi.`;
    notify();
  };

  return {
    snapshot: buildSnapshot,
    setRows,
    setPage(index) {
      assertActive();
      const next = clampInteger(index, 0, pageCount() - 1);
      if (next === pageIndex) return;
      pageIndex = next;
      announcement = `Sayfa ${pageIndex + 1} / ${pageCount()}.`;
      notify();
    },
    nextPage() {
      assertActive();
      this.setPage(pageIndex + 1);
    },
    previousPage() {
      assertActive();
      this.setPage(pageIndex - 1);
    },
    setPageSize(size) {
      assertActive();
      const next = clampInteger(size, 1, MAX_PAGE_SIZE);
      if (next === pageSize) return;
      const firstVisibleIndex = pageIndex * pageSize;
      pageSize = next;
      pageIndex = Math.floor(firstVisibleIndex / pageSize);
      normalizePage();
      announcement = `Sayfa başına ${pageSize} kayıt gösteriliyor.`;
      notify();
    },
    sortBy(columnId) {
      assertActive();
      const id = normalizeId(columnId);
      const column = columns.get(id);
      if (!column || column.sortable !== true) return;
      if (sort?.columnId === id) {
        sort = { columnId: id, direction: sort.direction === 'ascending' ? 'descending' : 'ascending' };
      } else {
        sort = { columnId: id, direction: 'ascending' };
      }
      pageIndex = 0;
      announcement = `${column.label} sütunu ${sort.direction === 'ascending' ? 'artan' : 'azalan'} sıralandı.`;
      notify();
    },
    clearSort() {
      assertActive();
      if (!sort) return;
      sort = null;
      pageIndex = 0;
      announcement = 'Tablo sıralaması temizlendi.';
      notify();
    },
    setActive(rowId) {
      assertActive();
      const id = rowId == null ? null : normalizeId(rowId);
      const next = id && rowExists(id) ? id : null;
      if (next === activeRowId) return;
      activeRowId = next;
      if (activeRowId) {
        const ordered = orderedRows();
        const index = ordered.findIndex((row) => row.id === activeRowId);
        if (index >= 0) pageIndex = Math.floor(index / pageSize);
      }
      notify();
    },
    moveActive(delta) {
      assertActive();
      const ordered = orderedRows();
      if (ordered.length === 0) return;
      const current = activeRowId ? ordered.findIndex((row) => row.id === activeRowId) : -1;
      const start = current >= 0 ? current : delta < 0 ? ordered.length : -1;
      const index = clampInteger(start + Math.trunc(delta || 0), 0, ordered.length - 1);
      activeRowId = ordered[index]?.id ?? null;
      pageIndex = Math.floor(index / pageSize);
      announcement = `Aktif kayıt ${index + 1} / ${ordered.length}.`;
      notify();
    },
    moveActiveToBoundary(boundary) {
      assertActive();
      const ordered = orderedRows();
      if (ordered.length === 0) return;
      const index = boundary === 'first' ? 0 : ordered.length - 1;
      activeRowId = ordered[index]?.id ?? null;
      pageIndex = Math.floor(index / pageSize);
      announcement = `Aktif kayıt ${index + 1} / ${ordered.length}.`;
      notify();
    },
    toggleSelection(rowId) {
      assertActive();
      if (selectionMode === 'none') return;
      const id = normalizeId(rowId);
      if (!rowExists(id)) return;
      if (selectionMode === 'single') {
        if (selected.has(id) && selected.size === 1) selected.clear();
        else { selected.clear(); selected.add(id); }
      } else if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      setAnnouncementForSelection();
      notify();
    },
    selectOnly(rowId) {
      assertActive();
      if (selectionMode === 'none') return;
      const id = normalizeId(rowId);
      if (!rowExists(id)) return;
      selected.clear();
      selected.add(id);
      setAnnouncementForSelection();
      notify();
    },
    selectAllVisible() {
      assertActive();
      if (selectionMode !== 'multiple') return;
      visibleIndexedRows().forEach((row) => selected.add(row.id));
      setAnnouncementForSelection();
      notify();
    },
    clearSelection() {
      assertActive();
      if (selected.size === 0) return;
      selected.clear();
      setAnnouncementForSelection();
      notify();
    },
    subscribe(observer) {
      assertActive();
      observers.add(observer);
      try { observer(buildSnapshot()); } catch (error) { report(error); }
      return () => observers.delete(observer);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      rows = [];
      selected.clear();
      activeRowId = null;
      observers.clear();
    },
  };
};
