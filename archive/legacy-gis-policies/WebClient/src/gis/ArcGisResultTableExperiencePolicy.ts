export type ResultTableViewport = 'phone' | 'tablet' | 'desktop';
export type ResultTableAlign = 'start' | 'center' | 'end';
export type ResultTableSortDirection = 'ascending' | 'descending';

export interface ResultTableColumnInput {
  readonly id: string;
  readonly label: string;
  readonly priority?: number;
  readonly minimumWidth?: number;
  readonly preferredWidth?: number;
  readonly pinned?: boolean;
  readonly sortable?: boolean;
  readonly align?: ResultTableAlign;
}

export interface ResultTableRowInput {
  readonly key: string;
  readonly selected?: boolean;
  readonly cells: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

export interface ResultTableSortInput {
  readonly columnId: string;
  readonly direction: ResultTableSortDirection;
}

export interface ResultTableExperienceInput {
  readonly columns: readonly ResultTableColumnInput[];
  readonly rows: readonly ResultTableRowInput[];
  readonly viewportWidth: number;
  readonly availableWidth?: number;
  readonly activeRowKey?: string | null;
  readonly sort?: ResultTableSortInput | null;
  readonly totalCount?: number;
  readonly pageOffset?: number;
}

export interface ResultTableColumnModel {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly pinned: boolean;
  readonly sortable: boolean;
  readonly align: ResultTableAlign;
  readonly ariaSort: 'none' | ResultTableSortDirection;
  readonly columnIndex: number;
}

export interface ResultTableCellModel {
  readonly columnId: string;
  readonly text: string;
  readonly columnIndex: number;
  readonly rowIndex: number;
}

export interface ResultTableRowModel {
  readonly key: string;
  readonly selected: boolean;
  readonly active: boolean;
  readonly rowIndex: number;
  readonly positionInSet: number;
  readonly setSize: number;
  readonly cells: readonly ResultTableCellModel[];
}

export interface ResultTableExperienceModel {
  readonly viewport: ResultTableViewport;
  readonly columns: readonly ResultTableColumnModel[];
  readonly hiddenColumnIds: readonly string[];
  readonly rows: readonly ResultTableRowModel[];
  readonly activeRowIndex: number | null;
  readonly horizontalOverflow: boolean;
  readonly tableWidth: number;
  readonly availableWidth: number;
  readonly announcement: string;
  readonly tableLabel: string;
}

export interface ResultTableKeyboardIntent {
  readonly type: 'row' | 'first-row' | 'last-row' | 'first-column' | 'last-column' | 'activate' | 'toggle-selection';
  readonly delta?: number;
}

const MAX_COLUMNS = 32;
const MAX_ROWS = 500;
const MAX_TEXT = 180;
const MIN_COLUMN_WIDTH = 88;
const MAX_COLUMN_WIDTH = 420;
const DEFAULT_COLUMN_WIDTH = 160;
const PHONE_BREAKPOINT = 640;
const TABLET_BREAKPOINT = 1024;

const clampInteger = (value: number | undefined, minimum: number, maximum: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value as number)));
};

const normalizeText = (value: unknown, maximum = MAX_TEXT): string => {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

const normalizeId = (value: unknown): string => normalizeText(value, 80);

const resolveViewport = (width: number): ResultTableViewport => {
  const safeWidth = clampInteger(width, 0, 100_000, 0);
  if (safeWidth < PHONE_BREAKPOINT) return 'phone';
  if (safeWidth < TABLET_BREAKPOINT) return 'tablet';
  return 'desktop';
};

const resolveAvailableWidth = (input: ResultTableExperienceInput): number => {
  const viewport = clampInteger(input.viewportWidth, 0, 100_000, 0);
  return clampInteger(input.availableWidth, 0, 100_000, viewport);
};

const normalizeColumns = (columns: readonly ResultTableColumnInput[]): readonly ResultTableColumnInput[] => {
  const seen = new Set<string>();
  const normalized: ResultTableColumnInput[] = [];
  for (const column of columns) {
    if (normalized.length >= MAX_COLUMNS) break;
    const id = normalizeId(column.id);
    const label = normalizeText(column.label, 100);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    normalized.push(Object.freeze({
      id,
      label,
      priority: clampInteger(column.priority, -10_000, 10_000, 0),
      minimumWidth: clampInteger(column.minimumWidth, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH),
      preferredWidth: clampInteger(column.preferredWidth, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH),
      pinned: column.pinned === true,
      sortable: column.sortable === true,
      align: column.align === 'center' || column.align === 'end' ? column.align : 'start',
    }));
  }
  return Object.freeze(normalized.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    const priority = (left.priority ?? 0) - (right.priority ?? 0);
    return priority !== 0 ? priority : 0;
  }));
};

const columnBudget = (viewport: ResultTableViewport): number => viewport === 'phone' ? 3 : viewport === 'tablet' ? 6 : MAX_COLUMNS;

const chooseColumns = (
  columns: readonly ResultTableColumnInput[],
  viewport: ResultTableViewport,
  availableWidth: number,
): readonly ResultTableColumnInput[] => {
  const limit = columnBudget(viewport);
  const pinned = columns.filter((column) => column.pinned).slice(0, limit);
  const candidates = columns.filter((column) => !column.pinned);
  const chosen = [...pinned];
  let used = pinned.reduce((sum, column) => sum + (column.minimumWidth ?? MIN_COLUMN_WIDTH), 0);
  for (const column of candidates) {
    if (chosen.length >= limit) break;
    const minimum = column.minimumWidth ?? MIN_COLUMN_WIDTH;
    const shouldFit = used + minimum <= Math.max(availableWidth, MIN_COLUMN_WIDTH);
    if (!shouldFit && chosen.length > 0) continue;
    chosen.push(column);
    used += minimum;
  }
  if (chosen.length === 0 && columns.length > 0) chosen.push(columns[0]);
  return Object.freeze(chosen);
};

const allocateWidths = (
  columns: readonly ResultTableColumnInput[],
  availableWidth: number,
): readonly number[] => {
  if (columns.length === 0) return Object.freeze([]);
  const minimums = columns.map((column) => column.minimumWidth ?? MIN_COLUMN_WIDTH);
  const preferred = columns.map((column, index) => Math.max(minimums[index], column.preferredWidth ?? DEFAULT_COLUMN_WIDTH));
  const minimumTotal = minimums.reduce((sum, width) => sum + width, 0);
  if (availableWidth <= minimumTotal) return Object.freeze(minimums);
  const preferredTotal = preferred.reduce((sum, width) => sum + width, 0);
  if (preferredTotal <= availableWidth) {
    const spare = availableWidth - preferredTotal;
    const share = Math.floor(spare / columns.length);
    return Object.freeze(preferred.map((width) => Math.min(MAX_COLUMN_WIDTH, width + share)));
  }
  const flexible = preferred.map((width, index) => width - minimums[index]);
  const flexibleTotal = flexible.reduce((sum, width) => sum + width, 0);
  const distributable = availableWidth - minimumTotal;
  return Object.freeze(minimums.map((minimum, index) => {
    if (flexibleTotal <= 0) return minimum;
    return minimum + Math.floor(distributable * (flexible[index] / flexibleTotal));
  }));
};

const normalizeSort = (
  sort: ResultTableSortInput | null | undefined,
  columns: readonly ResultTableColumnInput[],
): ResultTableSortInput | null => {
  if (!sort) return null;
  const column = columns.find((candidate) => candidate.id === sort.columnId && candidate.sortable === true);
  if (!column) return null;
  return Object.freeze({ columnId: column.id, direction: sort.direction === 'descending' ? 'descending' : 'ascending' });
};

const formatCell = (value: string | number | boolean | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  return normalizeText(value);
};

const normalizeRows = (rows: readonly ResultTableRowInput[]): readonly ResultTableRowInput[] => {
  const seen = new Set<string>();
  const normalized: ResultTableRowInput[] = [];
  for (const row of rows) {
    if (normalized.length >= MAX_ROWS) break;
    const key = normalizeId(row.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(Object.freeze({ key, selected: row.selected === true, cells: row.cells }));
  }
  return Object.freeze(normalized);
};

const buildAnnouncement = (
  rows: readonly ResultTableRowModel[],
  visibleColumns: number,
  hiddenColumns: number,
  totalCount: number,
): string => {
  if (rows.length === 0) return 'Tabloda gösterilecek sonuç yok.';
  const hidden = hiddenColumns > 0 ? ` Dar görünüm nedeniyle ${hiddenColumns} sütun gizlendi.` : '';
  return `${totalCount} sonuçtan ${rows.length} satır, ${visibleColumns} sütun gösteriliyor.${hidden}`;
};

export const createArcGisResultTableExperienceModel = (
  input: ResultTableExperienceInput,
): ResultTableExperienceModel => {
  const viewport = resolveViewport(input.viewportWidth);
  const availableWidth = resolveAvailableWidth(input);
  const allColumns = normalizeColumns(input.columns);
  const visible = chooseColumns(allColumns, viewport, availableWidth);
  const widths = allocateWidths(visible, availableWidth);
  const sort = normalizeSort(input.sort, allColumns);
  const columns: readonly ResultTableColumnModel[] = Object.freeze(visible.map((column, index) => Object.freeze({
    id: column.id,
    label: column.label,
    width: widths[index],
    pinned: column.pinned === true,
    sortable: column.sortable === true,
    align: column.align === 'center' || column.align === 'end' ? column.align : 'start',
    ariaSort: sort?.columnId === column.id ? sort.direction : 'none',
    columnIndex: index + 1,
  })));
  const visibleIds = new Set(columns.map((column) => column.id));
  const hiddenColumnIds = Object.freeze(allColumns.filter((column) => !visibleIds.has(column.id)).map((column) => column.id));
  const sourceRows = normalizeRows(input.rows);
  const activeKey = input.activeRowKey == null ? null : normalizeId(input.activeRowKey);
  const totalCount = clampInteger(input.totalCount, sourceRows.length, Number.MAX_SAFE_INTEGER, sourceRows.length);
  const pageOffset = clampInteger(input.pageOffset, 0, Math.max(0, totalCount - 1), 0);
  const rows: readonly ResultTableRowModel[] = Object.freeze(sourceRows.map((row, rowIndex) => Object.freeze({
    key: row.key,
    selected: row.selected === true,
    active: activeKey === row.key,
    rowIndex: rowIndex + 2,
    positionInSet: Math.min(totalCount, pageOffset + rowIndex + 1),
    setSize: totalCount,
    cells: Object.freeze(columns.map((column) => Object.freeze({
      columnId: column.id,
      text: formatCell(row.cells[column.id]),
      columnIndex: column.columnIndex,
      rowIndex: rowIndex + 2,
    }))),
  })));
  const activeIndex = rows.findIndex((row) => row.active);
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  return Object.freeze({
    viewport,
    columns,
    hiddenColumnIds,
    rows,
    activeRowIndex: activeIndex >= 0 ? activeIndex : null,
    horizontalOverflow: tableWidth > availableWidth,
    tableWidth,
    availableWidth,
    announcement: buildAnnouncement(rows, columns.length, hiddenColumnIds.length, totalCount),
    tableLabel: 'Harita sonuçları tablosu',
  });
};

export const resolveResultTableKeyboardIntent = (
  key: string,
  shiftKey = false,
): ResultTableKeyboardIntent | null => {
  if (key === 'ArrowDown') return Object.freeze({ type: 'row', delta: 1 });
  if (key === 'ArrowUp') return Object.freeze({ type: 'row', delta: -1 });
  if (key === 'Home') return Object.freeze({ type: shiftKey ? 'first-column' : 'first-row' });
  if (key === 'End') return Object.freeze({ type: shiftKey ? 'last-column' : 'last-row' });
  if (key === 'Enter') return Object.freeze({ type: 'activate' });
  if (key === ' ') return Object.freeze({ type: 'toggle-selection' });
  return null;
};

export const resolveNextResultTableRowIndex = (
  currentIndex: number,
  rowCount: number,
  intent: ResultTableKeyboardIntent,
): number | null => {
  if (rowCount <= 0) return null;
  const current = clampInteger(currentIndex, 0, rowCount - 1, 0);
  if (intent.type === 'first-row') return 0;
  if (intent.type === 'last-row') return rowCount - 1;
  if (intent.type !== 'row') return current;
  return Math.min(rowCount - 1, Math.max(0, current + (intent.delta ?? 0)));
};
