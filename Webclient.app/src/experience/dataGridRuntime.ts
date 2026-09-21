export type DataGridSelectionMode = "none" | "single" | "multiple";
export type DataGridSortDirection = "asc" | "desc";

export interface DataGridColumn<Row> {
  readonly id: string;
  readonly label: string;
  readonly getValue: (row: Row) => unknown;
  readonly sortable?: boolean;
  readonly width?: number;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly align?: "start" | "center" | "end";
}

export interface DataGridSort {
  readonly columnId: string;
  readonly direction: DataGridSortDirection;
}

export interface DataGridActiveCell {
  readonly rowId: string;
  readonly columnId: string;
}

export interface DataGridViewport {
  readonly scrollTop: number;
  readonly height: number;
  readonly rowHeight: number;
  readonly overscan: number;
}

export interface DataGridVisibleRange {
  readonly start: number;
  readonly end: number;
  readonly offsetTop: number;
  readonly totalHeight: number;
}

export interface DataGridSnapshot<Row> {
  readonly rows: readonly Row[];
  readonly visibleRows: readonly Row[];
  readonly columns: readonly DataGridColumn<Row>[];
  readonly sort: DataGridSort | null;
  readonly selectedIds: readonly string[];
  readonly activeCell: DataGridActiveCell | null;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly rowCount: number;
  readonly visibleRange: DataGridVisibleRange;
  readonly revision: number;
}

export interface DataGridRuntimeOptions<Row> {
  readonly rows?: readonly Row[];
  readonly columns: readonly DataGridColumn<Row>[];
  readonly getRowId: (row: Row) => string;
  readonly selectionMode?: DataGridSelectionMode;
  readonly pageSize?: number;
  readonly initialSort?: DataGridSort | null;
  readonly initialSelectedIds?: readonly string[];
  readonly initialViewport?: Partial<DataGridViewport>;
  readonly onError?: (error: unknown) => void;
}

export type DataGridListener<Row> = (
  snapshot: Readonly<DataGridSnapshot<Row>>,
  previous: Readonly<DataGridSnapshot<Row>>,
) => void;

export interface DataGridKeyboardResult {
  readonly handled: boolean;
  readonly activeCell: DataGridActiveCell | null;
  readonly selectedIds: readonly string[];
}

const DEFAULT_VIEWPORT: DataGridViewport = Object.freeze({
  scrollTop: 0,
  height: 480,
  rowHeight: 44,
  overscan: 5,
});

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const finitePositive = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const finiteNonNegative = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

const normalizeId = (value: string): string => String(value ?? "").trim();

const normalizePageSize = (value: unknown): number =>
  clamp(Math.floor(finitePositive(value, 50)), 1, 500);

const normalizeViewport = (value: Partial<DataGridViewport> | undefined): DataGridViewport => Object.freeze({
  scrollTop: finiteNonNegative(value?.scrollTop, DEFAULT_VIEWPORT.scrollTop),
  height: finitePositive(value?.height, DEFAULT_VIEWPORT.height),
  rowHeight: clamp(finitePositive(value?.rowHeight, DEFAULT_VIEWPORT.rowHeight), 24, 120),
  overscan: clamp(Math.floor(finiteNonNegative(value?.overscan, DEFAULT_VIEWPORT.overscan)), 0, 50),
});

const freezeIds = (values: Iterable<string>): readonly string[] =>
  Object.freeze(Array.from(values));

const freezeRows = <Row>(rows: readonly Row[]): readonly Row[] =>
  Object.freeze([...rows]);

const freezeColumns = <Row>(columns: readonly DataGridColumn<Row>[]): readonly DataGridColumn<Row>[] =>
  Object.freeze(columns.map((column) => Object.freeze({ ...column })));

const comparePrimitive = (left: unknown, right: unknown): number => {
  if (Object.is(left, right)) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  if (typeof left === "number" && typeof right === "number") {
    const l = Number.isNaN(left) ? Number.NEGATIVE_INFINITY : left;
    const r = Number.isNaN(right) ? Number.NEGATIVE_INFINITY : right;
    return l === r ? 0 : l < r ? -1 : 1;
  }
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  const l = String(left);
  const r = String(right);
  return l.localeCompare(r, "tr-TR", { numeric: true, sensitivity: "base" });
};

const sameSort = (left: DataGridSort | null, right: DataGridSort | null): boolean =>
  left?.columnId === right?.columnId && left?.direction === right?.direction;

const sameCell = (left: DataGridActiveCell | null, right: DataGridActiveCell | null): boolean =>
  left?.rowId === right?.rowId && left?.columnId === right?.columnId;

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const calculateVisibleRange = (
  rowCount: number,
  viewport: DataGridViewport,
): DataGridVisibleRange => {
  if (rowCount <= 0) {
    return Object.freeze({ start: 0, end: 0, offsetTop: 0, totalHeight: 0 });
  }
  const start = clamp(
    Math.floor(viewport.scrollTop / viewport.rowHeight) - viewport.overscan,
    0,
    Math.max(0, rowCount - 1),
  );
  const visibleCount = Math.ceil(viewport.height / viewport.rowHeight) + viewport.overscan * 2;
  const end = clamp(start + visibleCount, start + 1, rowCount);
  return Object.freeze({
    start,
    end,
    offsetTop: start * viewport.rowHeight,
    totalHeight: rowCount * viewport.rowHeight,
  });
};

export class DataGridRuntime<Row> {
  private readonly getRowId: (row: Row) => string;
  private readonly selectionMode: DataGridSelectionMode;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly listeners = new Set<DataGridListener<Row>>();
  private readonly columns: readonly DataGridColumn<Row>[];
  private readonly columnById: ReadonlyMap<string, DataGridColumn<Row>>;
  private rows: readonly Row[];
  private viewport: DataGridViewport;
  private pageSize: number;
  private page = 0;
  private sort: DataGridSort | null;
  private selected = new Set<string>();
  private activeCell: DataGridActiveCell | null = null;
  private revision = 0;
  private disposed = false;
  private snapshotValue: DataGridSnapshot<Row>;

  constructor(options: DataGridRuntimeOptions<Row>) {
    if (!options.columns.length) throw new Error("DataGridRuntime en az bir kolon gerektirir.");
    options.columns.reduce((seen, column) => {
      const id = normalizeId(column.id);
      if (!id) throw new Error("DataGrid kolon id alanı boş olamaz.");
      if (seen.has(id)) throw new Error(`DataGrid kolon id benzersiz olmalıdır: ${id}`);
      seen.add(id);
      return seen;
    }, new Set<string>());
    this.columns = freezeColumns(options.columns);
    this.columnById = new Map(this.columns.map((column) => [column.id, column]));
    this.getRowId = options.getRowId;
    this.selectionMode = options.selectionMode ?? "none";
    this.onError = options.onError;
    this.rows = freezeRows(options.rows ?? []);
    this.pageSize = normalizePageSize(options.pageSize);
    this.viewport = normalizeViewport(options.initialViewport);
    this.sort = this.normalizeSort(options.initialSort ?? null);
    this.reconcileSelection(options.initialSelectedIds ?? []);
    this.activeCell = this.firstCell();
    this.snapshotValue = this.buildSnapshot();
  }

  get snapshot(): Readonly<DataGridSnapshot<Row>> {
    return this.snapshotValue;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  subscribe(listener: DataGridListener<Row>, emitCurrent = false): () => void {
    this.assertActive();
    this.listeners.add(listener);
    if (emitCurrent) this.notifyOne(listener, this.snapshotValue, this.snapshotValue);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setRows(rows: readonly Row[]): Readonly<DataGridSnapshot<Row>> {
    this.assertActive();
    const previousRows = this.rows;
    this.rows = freezeRows(rows);
    this.page = clamp(this.page, 0, Math.max(0, this.pageCount() - 1));
    this.reconcileSelection(this.selected);
    this.reconcileActiveCell();
    if (previousRows === this.rows) return this.snapshotValue;
    return this.commit();
  }

  setPageSize(pageSize: number): Readonly<DataGridSnapshot<Row>> {
    this.assertActive();
    const next = normalizePageSize(pageSize);
    if (next === this.pageSize) return this.snapshotValue;
    const absoluteStart = this.page * this.pageSize;
    this.pageSize = next;
    this.page = Math.floor(absoluteStart / next);
    this.reconcileActiveCell();
    return this.commit();
  }

  setPage(page: number): Readonly<DataGridSnapshot<Row>> {
    this.assertActive();
    const next = clamp(Math.floor(finiteNonNegative(page)), 0, Math.max(0, this.pageCount() - 1));
    if (next === this.page) return this.snapshotValue;
    this.page = next;
    this.reconcileActiveCell();
    return this.commit();
  }

  setSort(sort: DataGridSort | null): Readonly<DataGridSnapshot<Row>> {
    this.assertActive();
    const next = this.normalizeSort(sort);
    if (sameSort(next, this.sort)) return this.snapshotValue;
    this.sort = next;
    this.page = 0;
    this.reconcileActiveCell();
    return this.commit();
  }

  toggleSort(columnId: string): Readonly<DataGridSnapshot<Row>> {
    this.assertActive();
    const column = this.columnById.get(columnId);
    if (!column?.sortable) return this.snapshotValue;
    if (this.sort?.columnId !== columnId) return this.setSort({ columnId, direction: "asc" });
    if (this.sort.direction === "asc") return this.setSort({ columnId, direction: "desc" });
    return this.setSort(null);
  }

  setViewport(patch: Partial<DataGridViewport>): Readonly<DataGridSnapshot<Row>> {
    this.assertActive();
    const next = normalizeViewport({ ...this.viewport, ...patch });
    if (
      next.scrollTop === this.viewport.scrollTop &&
      next.height === this.viewport.height &&
      next.rowHeight === this.viewport.rowHeight &&
      next.overscan === this.viewport.overscan
    ) return this.snapshotValue;
    this.viewport = next;
    return this.commit();
  }

  clearSelection(): Readonly<DataGridSnapshot<Row>> {
    this.assertActive();
    if (!this.selected.size) return this.snapshotValue;
    this.selected.clear();
    return this.commit();
  }

  selectRow(rowId: string, selected = true, additive = false): Readonly<DataGridSnapshot<Row>> {
    this.assertActive();
    if (this.selectionMode === "none") return this.snapshotValue;
    const id = normalizeId(rowId);
    if (!id || !this.rowIds().has(id)) return this.snapshotValue;
    const before = freezeIds(this.selected);
    if (this.selectionMode === "single") {
      this.selected.clear();
      if (selected) this.selected.add(id);
    } else if (selected) {
      if (!additive) this.selected.clear();
      this.selected.add(id);
    } else {
      this.selected.delete(id);
    }
    return sameIds(before, freezeIds(this.selected)) ? this.snapshotValue : this.commit();
  }

  toggleRow(rowId: string, additive = true): Readonly<DataGridSnapshot<Row>> {
    this.assertActive();
    const id = normalizeId(rowId);
    return this.selectRow(id, !this.selected.has(id), additive);
  }

  setActiveCell(cell: DataGridActiveCell | null): Readonly<DataGridSnapshot<Row>> {
    this.assertActive();
    const next = this.normalizeCell(cell);
    if (sameCell(next, this.activeCell)) return this.snapshotValue;
    this.activeCell = next;
    this.ensureActiveCellVisible();
    return this.commit();
  }

  handleKey(key: string, options: { shift?: boolean; ctrl?: boolean; meta?: boolean } = {}): DataGridKeyboardResult {
    this.assertActive();
    const rows = this.pageRows();
    if (!rows.length) return { handled: false, activeCell: this.activeCell, selectedIds: freezeIds(this.selected) };
    const current = this.activeCell ?? this.firstCell();
    if (!current) return { handled: false, activeCell: null, selectedIds: freezeIds(this.selected) };

    const rowIndex = Math.max(0, rows.findIndex((row) => this.safeRowId(row) === current.rowId));
    const columnIndex = Math.max(0, this.columns.findIndex((column) => column.id === current.columnId));
    let nextRow = rowIndex;
    let nextColumn = columnIndex;
    let handled = true;

    switch (key) {
      case "ArrowUp": nextRow = Math.max(0, rowIndex - 1); break;
      case "ArrowDown": nextRow = Math.min(rows.length - 1, rowIndex + 1); break;
      case "ArrowLeft": nextColumn = Math.max(0, columnIndex - 1); break;
      case "ArrowRight": nextColumn = Math.min(this.columns.length - 1, columnIndex + 1); break;
      case "Home":
        if (options.ctrl || options.meta) nextRow = 0;
        nextColumn = 0;
        break;
      case "End":
        if (options.ctrl || options.meta) nextRow = rows.length - 1;
        nextColumn = this.columns.length - 1;
        break;
      case "PageUp":
        nextRow = Math.max(0, rowIndex - Math.max(1, Math.floor(this.viewport.height / this.viewport.rowHeight)));
        break;
      case "PageDown":
        nextRow = Math.min(rows.length - 1, rowIndex + Math.max(1, Math.floor(this.viewport.height / this.viewport.rowHeight)));
        break;
      case " ":
      case "Enter":
        if (this.selectionMode !== "none") {
          this.toggleRow(current.rowId, options.shift === true || options.ctrl === true || options.meta === true);
        }
        return { handled: true, activeCell: this.activeCell, selectedIds: freezeIds(this.selected) };
      default:
        handled = false;
    }

    if (handled) {
      const row = rows[nextRow];
      const column = this.columns[nextColumn];
      if (row && column) this.setActiveCell({ rowId: this.safeRowId(row), columnId: column.id });
    }
    return { handled, activeCell: this.activeCell, selectedIds: freezeIds(this.selected) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.selected.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("DataGridRuntime dispose edildikten sonra kullanılamaz.");
  }

  private normalizeSort(sort: DataGridSort | null): DataGridSort | null {
    if (!sort) return null;
    const column = this.columnById.get(sort.columnId);
    if (!column?.sortable) return null;
    return Object.freeze({
      columnId: column.id,
      direction: sort.direction === "desc" ? "desc" : "asc",
    });
  }

  private normalizeCell(cell: DataGridActiveCell | null): DataGridActiveCell | null {
    if (!cell) return null;
    if (!this.columnById.has(cell.columnId)) return this.firstCell();
    const id = normalizeId(cell.rowId);
    if (!this.pageRows().some((row) => this.safeRowId(row) === id)) return this.firstCell();
    return Object.freeze({ rowId: id, columnId: cell.columnId });
  }

  private rowIds(): Set<string> {
    return new Set(this.rows.map((row) => this.safeRowId(row)).filter(Boolean));
  }

  private safeRowId(row: Row): string {
    try {
      return normalizeId(this.getRowId(row));
    } catch (error) {
      this.report(error);
      return "";
    }
  }

  private reconcileSelection(values: Iterable<string>): void {
    if (this.selectionMode === "none") {
      this.selected = new Set<string>();
      return;
    }
    const valid = this.rowIds();
    const normalized = Array.from(values, (raw) => normalizeId(raw))
      .filter((id) => id.length > 0 && valid.has(id));
    this.selected = new Set(this.selectionMode === "single" ? normalized.slice(0, 1) : normalized);
  }

  private sortedRows(): readonly Row[] {
    if (!this.sort) return this.rows;
    const column = this.columnById.get(this.sort.columnId);
    if (!column) return this.rows;
    const direction = this.sort.direction === "desc" ? -1 : 1;
    return this.rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        try {
          const compared = comparePrimitive(column.getValue(left.row), column.getValue(right.row));
          return compared === 0 ? left.index - right.index : compared * direction;
        } catch (error) {
          this.report(error);
          return left.index - right.index;
        }
      })
      .map((entry) => entry.row);
  }

  private pageCount(): number {
    return Math.max(1, Math.ceil(this.rows.length / this.pageSize));
  }

  private pageRows(): readonly Row[] {
    const sorted = this.sortedRows();
    const start = this.page * this.pageSize;
    return sorted.slice(start, start + this.pageSize);
  }

  private firstCell(): DataGridActiveCell | null {
    const row = this.pageRows()[0];
    const column = this.columns[0];
    if (!row || !column) return null;
    return Object.freeze({ rowId: this.safeRowId(row), columnId: column.id });
  }

  private reconcileActiveCell(): void {
    this.activeCell = this.normalizeCell(this.activeCell);
    if (!this.activeCell) this.activeCell = this.firstCell();
    this.ensureActiveCellVisible();
  }

  private ensureActiveCellVisible(): void {
    if (!this.activeCell) return;
    const rows = this.pageRows();
    const index = rows.findIndex((row) => this.safeRowId(row) === this.activeCell?.rowId);
    if (index < 0) return;
    const top = index * this.viewport.rowHeight;
    const bottom = top + this.viewport.rowHeight;
    let scrollTop = this.viewport.scrollTop;
    if (top < scrollTop) scrollTop = top;
    else if (bottom > scrollTop + this.viewport.height) scrollTop = Math.max(0, bottom - this.viewport.height);
    if (scrollTop !== this.viewport.scrollTop) {
      this.viewport = Object.freeze({ ...this.viewport, scrollTop });
    }
  }

  private buildSnapshot(): DataGridSnapshot<Row> {
    const pageRows = this.pageRows();
    const range = calculateVisibleRange(pageRows.length, this.viewport);
    const visibleRows = freezeRows(pageRows.slice(range.start, range.end));
    return Object.freeze({
      rows: freezeRows(pageRows),
      visibleRows,
      columns: this.columns,
      sort: this.sort,
      selectedIds: freezeIds(this.selected),
      activeCell: this.activeCell,
      page: this.page,
      pageSize: this.pageSize,
      pageCount: this.pageCount(),
      rowCount: this.rows.length,
      visibleRange: range,
      revision: this.revision,
    });
  }

  private commit(): Readonly<DataGridSnapshot<Row>> {
    const previous = this.snapshotValue;
    this.revision += 1;
    this.snapshotValue = this.buildSnapshot();
    this.listeners.forEach((listener) => this.notifyOne(listener, this.snapshotValue, previous));
    return this.snapshotValue;
  }

  private notifyOne(
    listener: DataGridListener<Row>,
    snapshot: DataGridSnapshot<Row>,
    previous: DataGridSnapshot<Row>,
  ): void {
    try {
      listener(snapshot, previous);
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    if (!this.onError) {
      queueMicrotask(() => { throw error; });
      return;
    }
    try {
      this.onError(error);
    } catch (reportingError) {
      queueMicrotask(() => { throw reportingError; });
    }
  }
}

export const createDataGridRuntime = <Row>(
  options: DataGridRuntimeOptions<Row>,
): DataGridRuntime<Row> => new DataGridRuntime(options);
