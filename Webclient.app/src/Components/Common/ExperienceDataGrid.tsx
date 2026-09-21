import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  createDataGridRuntime,
  type DataGridColumn,
  type DataGridSelectionMode,
  type DataGridSort,
} from "../../experience/dataGridRuntime";
import "./experience-data-grid-modern.css";

export interface ExperienceDataGridColumn<Row> extends DataGridColumn<Row> {
  readonly renderCell?: (row: Row, value: unknown) => ReactNode;
  readonly description?: string;
}

export interface ExperienceDataGridProps<Row> {
  readonly rows: readonly Row[];
  readonly columns: readonly ExperienceDataGridColumn<Row>[];
  readonly getRowId: (row: Row) => string;
  readonly caption: string;
  readonly description?: string;
  readonly selectionMode?: DataGridSelectionMode;
  readonly selectedIds?: readonly string[];
  readonly pageSize?: number;
  readonly rowHeight?: number;
  readonly height?: number;
  readonly overscan?: number;
  readonly emptyState?: ReactNode;
  readonly loading?: boolean;
  readonly loadingLabel?: string;
  readonly onSelectionChange?: (selectedIds: readonly string[]) => void;
  readonly onSortChange?: (sort: DataGridSort | null) => void;
  readonly onActivateRow?: (row: Row) => void;
  readonly className?: string;
}

const alignmentClass = (align: DataGridColumn<unknown>["align"]): string =>
  align === "center" ? "is-center" : align === "end" ? "is-end" : "is-start";

const formatCellValue = (value: unknown): string => {
  if (value == null) return "—";
  if (value instanceof Date) {
    const options: Intl.DateTimeFormatOptions =
      value.getHours() || value.getMinutes() || value.getSeconds()
        ? { dateStyle: "medium", timeStyle: "short" }
        : { dateStyle: "medium" };
    return new Intl.DateTimeFormat("tr-TR", options).format(value);
  }
  if (typeof value === "boolean") return value ? "Evet" : "Hayır";
  if (typeof value === "number") {
    return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 4 }).format(value);
  }
  return String(value);
};

const sortLabel = (label: string, sort: DataGridSort | null, columnId: string): string => {
  if (sort?.columnId !== columnId) return `${label} sütununa göre sırala`;
  return sort.direction === "asc"
    ? `${label}: artan sıralı, azalan sıraya geçir`
    : `${label}: azalan sıralı, sıralamayı kaldır`;
};

export function ExperienceDataGrid<Row>({
  rows,
  columns,
  getRowId,
  caption,
  description,
  selectionMode = "none",
  selectedIds,
  pageSize = 50,
  rowHeight = 44,
  height = 480,
  overscan = 5,
  emptyState,
  loading = false,
  loadingLabel = "Veriler yükleniyor",
  onSelectionChange,
  onSortChange,
  onActivateRow,
  className = "",
}: ExperienceDataGridProps<Row>): ReactNode {
  const reactId = useId();
  const descriptionId = useMemo(
    () => `experience-grid-description-${reactId.replace(/:/g, "")}`,
    [reactId],
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const columnDefinitionById = useMemo(
    () => new Map(columns.map((column) => [column.id, column] as const)),
    [columns],
  );
  const runtime = useMemo(() => createDataGridRuntime<Row>({
    rows,
    columns,
    getRowId,
    selectionMode,
    pageSize,
    ...(selectedIds ? { initialSelectedIds: selectedIds } : {}),
    initialViewport: { height, rowHeight, overscan },
  }), [columns, getRowId, height, overscan, pageSize, rowHeight, selectionMode]);

  useEffect(() => () => runtime.dispose(), [runtime]);

  useEffect(() => {
    runtime.setRows(rows);
  }, [rows, runtime]);

  useEffect(() => {
    runtime.setViewport({ height, rowHeight, overscan });
  }, [height, overscan, rowHeight, runtime]);

  useEffect(() => {
    if (!selectedIds || selectionMode === "none") return;
    runtime.clearSelection();
    for (const [index, id] of selectedIds.entries()) {
      runtime.selectRow(id, true, index > 0);
    }
  }, [runtime, selectedIds, selectionMode]);

  const subscribe = useCallback(
    (notify: () => void) => runtime.subscribe(() => notify()),
    [runtime],
  );
  const getSnapshot = useCallback(() => runtime.snapshot, [runtime]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const emitSelection = useCallback(() => {
    onSelectionChange?.(runtime.snapshot.selectedIds);
  }, [onSelectionChange, runtime]);

  const onScroll = useCallback(() => {
    const node = viewportRef.current;
    if (!node) return;
    runtime.setViewport({ scrollTop: node.scrollTop, height: node.clientHeight || height });
  }, [height, runtime]);

  const onGridKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTableElement>) => {
    const result = runtime.handleKey(event.key, {
      shift: event.shiftKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
    });
    if (!result.handled) return;
    event.preventDefault();
    if (event.key === " " || event.key === "Enter") emitSelection();
    queueMicrotask(() => {
      const active = runtime.snapshot.activeCell;
      if (!active) return;
      const selector = `[data-grid-row="${CSS.escape(active.rowId)}"][data-grid-column="${CSS.escape(active.columnId)}"]`;
      viewportRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    });
  }, [emitSelection, runtime]);

  const toggleSort = useCallback((columnId: string) => {
    const before = runtime.snapshot.sort;
    runtime.toggleSort(columnId);
    if (
      before?.columnId !== runtime.snapshot.sort?.columnId ||
      before?.direction !== runtime.snapshot.sort?.direction
    ) {
      onSortChange?.(runtime.snapshot.sort);
    }
  }, [onSortChange, runtime]);

  const activateRow = useCallback((row: Row) => {
    onActivateRow?.(row);
  }, [onActivateRow]);

  const selectedSet = useMemo(() => new Set(snapshot.selectedIds), [snapshot.selectedIds]);
  const pageStart = snapshot.page * snapshot.pageSize;
  const topSpacer = snapshot.visibleRange.offsetTop;
  const bottomSpacer = Math.max(
    0,
    snapshot.visibleRange.totalHeight
      - topSpacer
      - snapshot.visibleRows.length * rowHeight,
  );

  if (!loading && snapshot.rowCount === 0) {
    return (
      <section className={`experience-data-grid experience-data-grid--empty ${className}`.trim()}>
        <h2 className="experience-data-grid__caption">{caption}</h2>
        {description ? <p className="experience-data-grid__description">{description}</p> : null}
        {emptyState ?? (
          <div className="experience-data-grid__empty" role="status">
            <strong>Gösterilecek kayıt yok</strong>
            <span>Filtreleri değiştirin veya farklı bir arama deneyin.</span>
          </div>
        )}
      </section>
    );
  }

  const rowStyle: CSSProperties = { height: rowHeight };
  return (
    <section
      className={`experience-data-grid ${className}`.trim()}
      aria-busy={loading || undefined}
    >
      <div className="experience-data-grid__heading">
        <div>
          <h2 className="experience-data-grid__caption">{caption}</h2>
          {description ? (
            <p id={descriptionId} className="experience-data-grid__description">{description}</p>
          ) : null}
        </div>
        <output className="experience-data-grid__count" aria-live="polite">
          {snapshot.rowCount.toLocaleString("tr-TR")} kayıt
        </output>
      </div>

      {loading ? (
        <div className="experience-data-grid__loading" role="status" aria-live="polite">
          <span className="experience-data-grid__spinner" aria-hidden="true" />
          <span>{loadingLabel}</span>
        </div>
      ) : null}

      <div
        ref={viewportRef}
        className="experience-data-grid__viewport"
        style={{ maxHeight: height }}
        onScroll={onScroll}
        tabIndex={-1}
      >
        <table
          className="experience-data-grid__table"
          aria-describedby={description ? descriptionId : undefined}
          aria-rowcount={snapshot.rowCount + 1}
          aria-colcount={snapshot.columns.length + (selectionMode === "none" ? 0 : 1)}
          onKeyDown={onGridKeyDown}
        >
          <caption className="experience-sr-only">{caption}</caption>
          <thead>
            <tr>
              {selectionMode !== "none" ? (
                <th scope="col" className="experience-data-grid__selection-column">
                  <span className="experience-sr-only">Seçim</span>
                </th>
              ) : null}
              {snapshot.columns.map((column) => {
                const definition = columnDefinitionById.get(column.id);
                const activeSort = snapshot.sort?.columnId === column.id;
                const ariaSort = activeSort
                  ? snapshot.sort?.direction === "asc" ? "ascending" : "descending"
                  : undefined;
                const width = column.width
                  ? clampColumnWidth(column.width, column.minWidth, column.maxWidth)
                  : undefined;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={ariaSort}
                    className={alignmentClass(column.align)}
                    style={width ? { width } : undefined}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        className="experience-data-grid__sort"
                        onClick={() => toggleSort(column.id)}
                        aria-label={sortLabel(column.label, snapshot.sort, column.id)}
                        title={definition?.description}
                      >
                        <span>{column.label}</span>
                        <span className="experience-data-grid__sort-icon" aria-hidden="true">
                          {activeSort ? snapshot.sort?.direction === "asc" ? "↑" : "↓" : "↕"}
                        </span>
                      </button>
                    ) : (
                      <span title={definition?.description}>{column.label}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {topSpacer > 0 ? (
              <tr aria-hidden="true" className="experience-data-grid__spacer">
                <td colSpan={snapshot.columns.length + (selectionMode === "none" ? 0 : 1)} style={{ height: topSpacer }} />
              </tr>
            ) : null}
            {snapshot.visibleRows.map((row, visibleIndex) => {
              const rowId = getRowId(row);
              const selected = selectedSet.has(rowId);
              const absoluteRowIndex = pageStart + snapshot.visibleRange.start + visibleIndex;
              return (
                <tr
                  key={rowId}
                  aria-selected={selectionMode === "none" ? undefined : selected}
                  aria-rowindex={absoluteRowIndex + 2}
                  className={selected ? "is-selected" : undefined}
                  style={rowStyle}
                  onDoubleClick={() => activateRow(row)}
                >
                  {selectionMode !== "none" ? (
                    <td className="experience-data-grid__selection-cell">
                      <input
                        type={selectionMode === "single" ? "radio" : "checkbox"}
                        name={selectionMode === "single" ? `experience-grid-${descriptionId}` : undefined}
                        checked={selected}
                        aria-label={`${absoluteRowIndex + 1}. kaydı ${selected ? "seçimden çıkar" : "seç"}`}
                        onChange={() => {
                          runtime.toggleRow(rowId, selectionMode === "multiple");
                          emitSelection();
                        }}
                      />
                    </td>
                  ) : null}
                  {snapshot.columns.map((column) => {
                    const definition = columnDefinitionById.get(column.id);
                    const active = snapshot.activeCell?.rowId === rowId
                      && snapshot.activeCell.columnId === column.id;
                    let value: unknown;
                    try {
                      value = column.getValue(row);
                    } catch {
                      value = undefined;
                    }
                    return (
                      <td
                        key={column.id}
                        data-grid-row={rowId}
                        data-grid-column={column.id}
                        className={`${alignmentClass(column.align)} ${active ? "is-active" : ""}`.trim()}
                        tabIndex={active ? 0 : -1}
                        onFocus={() => runtime.setActiveCell({ rowId, columnId: column.id })}
                        onDoubleClick={() => activateRow(row)}
                      >
                        {definition?.renderCell ? definition.renderCell(row, value) : formatCellValue(value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {bottomSpacer > 0 ? (
              <tr aria-hidden="true" className="experience-data-grid__spacer">
                <td colSpan={snapshot.columns.length + (selectionMode === "none" ? 0 : 1)} style={{ height: bottomSpacer }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {snapshot.pageCount > 1 ? (
        <nav className="experience-data-grid__pager" aria-label={`${caption} sayfalama`}>
          <button
            type="button"
            className="experience-btn experience-btn--secondary"
            disabled={snapshot.page === 0}
            onClick={() => runtime.setPage(snapshot.page - 1)}
          >
            Önceki
          </button>
          <span aria-live="polite">
            Sayfa <strong>{snapshot.page + 1}</strong> / {snapshot.pageCount}
          </span>
          <button
            type="button"
            className="experience-btn experience-btn--secondary"
            disabled={snapshot.page >= snapshot.pageCount - 1}
            onClick={() => runtime.setPage(snapshot.page + 1)}
          >
            Sonraki
          </button>
        </nav>
      ) : null}
    </section>
  );
}

const clampColumnWidth = (
  value: number,
  minWidth = 80,
  maxWidth = 720,
): number => Math.min(
  Math.max(Number.isFinite(value) ? value : minWidth, Math.max(48, minWidth)),
  Math.max(minWidth, maxWidth),
);

export default ExperienceDataGrid;
