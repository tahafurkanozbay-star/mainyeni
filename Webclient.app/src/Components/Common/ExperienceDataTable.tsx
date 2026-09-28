import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  createDataTableAccessibilityController,
  type DataTableAccessibilityController,
} from '../../experience/dataTableAccessibilityController';
import {
  createDataTableInteractionModel,
  type DataTableInteractionModel,
  type DataTableSelectionMode,
  type DataTableSnapshot,
} from '../../experience/dataTableInteractionModel';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import './ExperiencePrimitives.css';
import './experience-data-table-modern.css';

export type ExperienceColumnAlign = 'start' | 'center' | 'end';
export type ExperienceSortDirection = 'ascending' | 'descending' | 'none';

export interface ExperienceDataColumn<Row> {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: Row, index: number) => ReactNode;
  readonly align?: ExperienceColumnAlign;
  readonly width?: string;
  readonly sortDirection?: ExperienceSortDirection;
  readonly onSort?: () => void;
}

export interface ExperienceDataTableProps<Row> {
  readonly rows: readonly Row[];
  readonly columns: readonly ExperienceDataColumn<Row>[];
  readonly getRowKey: (row: Row, index: number) => string | number;
  readonly caption: string;
  readonly description?: string;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly busy?: boolean;
  readonly busyLabel?: string;
  readonly selectedRowKey?: string | number | null;
  readonly selectedRowKeys?: readonly (string | number)[];
  readonly selectionMode?: DataTableSelectionMode;
  readonly onSelectionChange?: (selectedRowIds: readonly string[]) => void;
  readonly onRowActivate?: (row: Row, index: number) => void;
  readonly getRowLabel?: (row: Row, index: number) => string;
  readonly pageSize?: number;
  readonly stackOnCompact?: boolean;
  readonly className?: string;
}

interface IndexedExperienceRow<Row> {
  readonly id: string;
  readonly sourceIndex: number;
  readonly value: Row;
}

const MAX_TABLE_PAGE_SIZE = 250;

const normalizeToken = (value: string): string => value
  .trim()
  .replace(/[^a-zA-Z0-9_-]+/g, '-');

const normalizePageSize = (requested: number | undefined, rowCount: number): number => {
  if (requested === undefined) return Math.max(1, Math.min(MAX_TABLE_PAGE_SIZE, rowCount || 1));
  if (!Number.isFinite(requested)) return Math.max(1, Math.min(MAX_TABLE_PAGE_SIZE, rowCount || 1));
  return Math.max(1, Math.min(MAX_TABLE_PAGE_SIZE, Math.trunc(requested)));
};

const toRowId = (key: string | number): string => String(key).trim();

const selectedIdSet = (
  selectedRowKey: string | number | null,
  selectedRowKeys: readonly (string | number)[] | undefined,
): ReadonlySet<string> => {
  if (selectedRowKeys) return new Set(selectedRowKeys.map(toRowId).filter(Boolean));
  if (selectedRowKey === null) return new Set<string>();
  const id = toRowId(selectedRowKey);
  return id ? new Set([id]) : new Set<string>();
};

const selectionModeFor = <Row,>(
  explicit: DataTableSelectionMode | undefined,
  onRowActivate: ExperienceDataTableProps<Row>['onRowActivate'],
  selectedRowKey: string | number | null,
  selectedRowKeys: readonly (string | number)[] | undefined,
): DataTableSelectionMode => {
  if (explicit) return explicit;
  if (selectedRowKeys) return 'multiple';
  if (onRowActivate || selectedRowKey !== null) return 'single';
  return 'none';
};

const formatCount = (value: number): string => value.toLocaleString('tr-TR');

export function ExperienceDataTable<Row>({
  rows,
  columns,
  getRowKey,
  caption,
  description,
  emptyTitle = 'Sonuç bulunamadı',
  emptyDescription = 'Filtreleri değiştirip yeniden deneyin.',
  busy = false,
  busyLabel = 'Veriler yükleniyor',
  selectedRowKey = null,
  selectedRowKeys,
  selectionMode: explicitSelectionMode,
  onSelectionChange,
  onRowActivate,
  getRowLabel,
  pageSize: requestedPageSize,
  stackOnCompact = true,
  className = '',
}: ExperienceDataTableProps<Row>): ReactNode {
  const reactId = useId();
  const tableId = useMemo(
    () => `experience-table-${normalizeToken(reactId.replace(/:/g, '')) || 'data'}`,
    [reactId],
  );
  const descriptionId = `${tableId}-description`;
  const instructionsId = `${tableId}-instructions`;
  const liveId = `${tableId}-status`;
  const pageSize = normalizePageSize(requestedPageSize, rows.length);
  const selectionMode = selectionModeFor(
    explicitSelectionMode,
    onRowActivate,
    selectedRowKey,
    selectedRowKeys,
  );
  const rowElementById = useRef(new Map<string, HTMLTableRowElement>());

  const indexedRows = useMemo<readonly IndexedExperienceRow<Row>[]>(() => rows.map((value, sourceIndex) => ({
    id: toRowId(getRowKey(value, sourceIndex)),
    sourceIndex,
    value,
  })), [getRowKey, rows]);

  const interactionModel = useMemo<DataTableInteractionModel<IndexedExperienceRow<Row>>>(() => {
    const model = createDataTableInteractionModel<IndexedExperienceRow<Row>>({
      rowId: (row) => row.id,
      columns: columns.map((column) => ({
        id: column.id,
        label: typeof column.header === 'string' ? column.header : column.id,
        value: (row: IndexedExperienceRow<Row>) => row.sourceIndex,
      })),
      selectionMode,
      pageSize,
      maxRows: 100_000,
      onObserverError(error) {
        runtimeDiagnostics.captureError(error, {
          source: 'experience.data-table.interaction-observer',
        }, 'warn');
      },
    });
    model.setRows(indexedRows);
    return model;
  }, [columns, indexedRows, pageSize, selectionMode]);

  const focusRow = useCallback((rowDomId: string): void => {
    const direct = document.getElementById(rowDomId);
    if (direct instanceof HTMLElement) {
      direct.focus({ preventScroll: true });
      direct.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    requestAnimationFrame(() => {
      const deferred = document.getElementById(rowDomId);
      if (!(deferred instanceof HTMLElement)) return;
      deferred.focus({ preventScroll: true });
      deferred.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }, []);

  const accessibilityController = useMemo<DataTableAccessibilityController>(() => (
    createDataTableAccessibilityController({
      model: interactionModel,
      tableId,
      selectionMode,
      onFocusRequest: focusRow,
      onObserverError(error) {
        runtimeDiagnostics.captureError(error, {
          source: 'experience.data-table.accessibility-observer',
        }, 'warn');
      },
    })
  ), [focusRow, interactionModel, selectionMode, tableId]);

  const [snapshot, setSnapshot] = useState<DataTableSnapshot<IndexedExperienceRow<Row>>>(
    () => interactionModel.snapshot(),
  );
  const [announcement, setAnnouncement] = useState(() => accessibilityController.snapshot().announcement);

  useEffect(() => {
    const unsubscribeModel = interactionModel.subscribe(setSnapshot);
    const unsubscribeAccessibility = accessibilityController.subscribe((facts) => {
      setAnnouncement(facts.announcement);
    });
    return () => {
      unsubscribeAccessibility();
      unsubscribeModel();
      accessibilityController.dispose();
      interactionModel.dispose();
    };
  }, [accessibilityController, interactionModel]);

  useEffect(() => {
    if (snapshot.activeRowId || snapshot.rows.length === 0) return;
    interactionModel.setActive(snapshot.rows[0]?.id ?? null);
  }, [interactionModel, snapshot.activeRowId, snapshot.rows]);

  useEffect(() => {
    const controlled = selectedIdSet(selectedRowKey, selectedRowKeys);
    if (selectionMode === 'none') return;
    interactionModel.clearSelection();
    if (selectionMode === 'single') {
      const first = controlled.values().next().value as string | undefined;
      if (first) interactionModel.selectOnly(first);
      return;
    }
    for (const id of controlled) interactionModel.toggleSelection(id);
  }, [interactionModel, selectedRowKey, selectedRowKeys, selectionMode]);

  const emitSelection = useCallback((): void => {
    onSelectionChange?.(interactionModel.snapshot().selectedIds);
  }, [interactionModel, onSelectionChange]);

  const activateRow = useCallback((rowId: string): void => {
    const current = interactionModel.snapshot();
    const rendered = current.rows.find((row) => row.id === rowId);
    if (!rendered) return;
    accessibilityController.activate(rowId);
    if (selectionMode !== 'none') {
      if (selectionMode === 'single') interactionModel.selectOnly(rowId);
      else interactionModel.toggleSelection(rowId);
      emitSelection();
    }
    onRowActivate?.(rendered.value.value, rendered.value.sourceIndex);
  }, [accessibilityController, emitSelection, interactionModel, onRowActivate, selectionMode]);

  const onRowKeyDown = useCallback((event: KeyboardEvent<HTMLTableRowElement>): void => {
    const before = interactionModel.snapshot().activeRowId;
    const action = accessibilityController.handleKey(event);
    if (!action) return;

    if (action === 'select-active') {
      emitSelection();
      const current = interactionModel.snapshot();
      const active = current.rows.find((row) => row.id === current.activeRowId);
      if (active) onRowActivate?.(active.value.value, active.value.sourceIndex);
      return;
    }
    if (action === 'select-visible' || action === 'clear-selection') emitSelection();

    const after = interactionModel.snapshot().activeRowId;
    if (before !== after && after) {
      runtimeDiagnostics.record('experience.data-table.active-row.changed', {
        tableId,
        rowId: after,
        action,
      });
    }
  }, [accessibilityController, emitSelection, interactionModel, onRowActivate, tableId]);

  const changePage = useCallback((direction: -1 | 1): void => {
    if (direction < 0) interactionModel.previousPage();
    else interactionModel.nextPage();
    const next = interactionModel.snapshot();
    const first = next.rows[0]?.id ?? null;
    interactionModel.setActive(first);
  }, [interactionModel]);

  if (busy) {
    return (
      <div
        className="experience-table-state"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <span className="experience-table-state__spinner" aria-hidden="true" />
        <span>{busyLabel}</span>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="experience-table-state" role="status">
        <strong>{emptyTitle}</strong>
        <span>{emptyDescription}</span>
      </div>
    );
  }

  return (
    <section
      className={`experience-managed-table ${className}`.trim()}
      aria-labelledby={`${tableId}-caption`}
    >
      <header className="experience-managed-table__header">
        <div className="experience-managed-table__heading-copy">
          <h2 id={`${tableId}-caption`} className="experience-managed-table__caption">{caption}</h2>
          {description ? (
            <p id={descriptionId} className="experience-managed-table__description">{description}</p>
          ) : null}
        </div>
        <output className="experience-managed-table__count" aria-live="polite">
          {formatCount(snapshot.totalRows)} kayıt
          {snapshot.selectedIds.length > 0 ? ` · ${formatCount(snapshot.selectedIds.length)} seçili` : ''}
        </output>
      </header>

      <p id={instructionsId} className="experience-sr-only">
        Satırlar arasında yukarı ve aşağı ok tuşlarıyla ilerleyin. Ctrl ile Home veya End ilk ve son kayda gider.
        Page Up ve Page Down sayfalar arasında ilerler. Enter veya boşluk etkin kaydı seçer.
        {selectionMode === 'multiple' ? ' Ctrl+A görünür kayıtları seçer, Escape seçimi temizler.' : ''}
      </p>

      <div
        className="experience-table-wrap experience-table-wrap--managed"
        role="region"
        aria-label={`${caption} tablosu`}
        aria-describedby={`${description ? `${descriptionId} ` : ''}${instructionsId}`}
      >
        <table
          className="experience-data-table"
          data-stack-on-compact={stackOnCompact ? 'true' : 'false'}
          aria-rowcount={snapshot.totalRows + 1}
        >
          <caption className="experience-sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => {
                const style: CSSProperties | undefined = column.width
                  ? { inlineSize: column.width }
                  : undefined;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    data-align={column.align ?? 'start'}
                    aria-sort={column.onSort ? column.sortDirection ?? 'none' : undefined}
                    style={style}
                  >
                    {column.onSort ? (
                      <button
                        type="button"
                        className="experience-data-table__sort"
                        onClick={column.onSort}
                        aria-label={`${typeof column.header === 'string' ? column.header : column.id} sütununu sırala`}
                      >
                        <span>{column.header}</span>
                        <span aria-hidden="true">
                          {column.sortDirection === 'ascending'
                            ? '↑'
                            : column.sortDirection === 'descending'
                              ? '↓'
                              : '↕'}
                        </span>
                      </button>
                    ) : column.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {snapshot.rows.map((managedRow) => {
              const row = managedRow.value.value;
              const sourceIndex = managedRow.value.sourceIndex;
              const facts = accessibilityController.row(managedRow.id);
              const selected = facts?.ariaSelected ?? false;
              return (
                <tr
                  id={facts?.id}
                  key={managedRow.id}
                  ref={(node) => {
                    if (node) rowElementById.current.set(managedRow.id, node);
                    else rowElementById.current.delete(managedRow.id);
                  }}
                  data-selected={selected ? 'true' : undefined}
                  data-active={facts?.active ? 'true' : undefined}
                  tabIndex={facts?.tabIndex ?? -1}
                  onFocus={() => interactionModel.setActive(managedRow.id)}
                  onClick={onRowActivate || selectionMode !== 'none'
                    ? () => activateRow(managedRow.id)
                    : undefined}
                  onKeyDown={onRowKeyDown}
                  aria-selected={facts?.ariaSelected}
                  aria-posinset={facts?.ariaPosInSet}
                  aria-setsize={facts?.ariaSetSize}
                  aria-label={getRowLabel?.(row, sourceIndex)}
                >
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      data-label={typeof column.header === 'string' ? column.header : column.id}
                      data-align={column.align ?? 'start'}
                    >
                      {column.cell(row, sourceIndex)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div id={liveId} className="experience-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {snapshot.pageCount > 1 ? (
        <nav className="experience-managed-table__pager" aria-label={`${caption} sayfalama`}>
          <button
            type="button"
            className="experience-pagination__button"
            disabled={!snapshot.canPreviousPage}
            onClick={() => changePage(-1)}
          >
            Önceki
          </button>
          <span className="experience-managed-table__page-status" aria-live="polite">
            Sayfa <strong>{snapshot.pageIndex + 1}</strong> / {snapshot.pageCount}
          </span>
          <button
            type="button"
            className="experience-pagination__button"
            disabled={!snapshot.canNextPage}
            onClick={() => changePage(1)}
          >
            Sonraki
          </button>
        </nav>
      ) : null}
    </section>
  );
}
