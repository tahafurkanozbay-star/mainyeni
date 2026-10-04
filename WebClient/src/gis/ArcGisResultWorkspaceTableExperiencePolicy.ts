import type { ResultWorkspaceInputModality, ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';

export type WorkspaceTableSortDirection = 'ascending' | 'descending' | 'none';
export type WorkspaceTableSelectionMode = 'single' | 'multiple';
export type WorkspaceTableNavigationAction = 'none' | 'focus-cell' | 'focus-header' | 'announce-boundary';

export interface WorkspaceTableColumnInput {
  readonly key: string;
  readonly label: string;
  readonly sortable?: boolean;
  readonly width?: number;
  readonly minimumWidth?: number;
  readonly maximumWidth?: number;
  readonly numeric?: boolean;
}

export interface WorkspaceTableColumn {
  readonly key: string;
  readonly label: string;
  readonly sortable: boolean;
  readonly width: number;
  readonly minimumWidth: number;
  readonly maximumWidth: number;
  readonly numeric: boolean;
}

export interface WorkspaceTableSort {
  readonly columnKey: string | null;
  readonly direction: WorkspaceTableSortDirection;
}

export interface WorkspaceTableFocus {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly inHeader: boolean;
}

export interface WorkspaceTableAccessibility {
  readonly role: 'grid';
  readonly rowCount: number;
  readonly columnCount: number;
  readonly ariaMultiSelectable: boolean;
  readonly ariaBusy: boolean;
  readonly ariaLabel: string;
  readonly keyboardHint: string;
  readonly focusVisible: boolean;
  readonly minimumTargetSize: 44 | 48;
}

export interface WorkspaceTableSnapshot {
  readonly columns: readonly WorkspaceTableColumn[];
  readonly rowIds: readonly string[];
  readonly selectedIds: readonly string[];
  readonly focus: WorkspaceTableFocus;
  readonly sort: WorkspaceTableSort;
  readonly selectionMode: WorkspaceTableSelectionMode;
  readonly accessibility: WorkspaceTableAccessibility;
  readonly revision: number;
}

export type WorkspaceTableIntent =
  | { readonly type: 'move'; readonly rowDelta: number; readonly columnDelta: number }
  | { readonly type: 'home'; readonly scope: 'row' | 'grid' }
  | { readonly type: 'end'; readonly scope: 'row' | 'grid' }
  | { readonly type: 'focus-header'; readonly columnIndex?: number }
  | { readonly type: 'sort'; readonly columnKey: string }
  | { readonly type: 'toggle-selection'; readonly rowId?: string }
  | { readonly type: 'select-all-visible' }
  | { readonly type: 'clear-selection' }
  | { readonly type: 'resize-column'; readonly columnKey: string; readonly width: number }
  | { readonly type: 'reconcile'; readonly rowIds: readonly string[] };

export interface WorkspaceTableTransition {
  readonly next: WorkspaceTableSnapshot;
  readonly action: WorkspaceTableNavigationAction;
  readonly focusId: string | null;
  readonly announcement: string;
}

export interface WorkspaceTableShortcutContext {
  readonly editable?: boolean;
  readonly composing?: boolean;
  readonly disabled?: boolean;
  readonly modalOpen?: boolean;
}

const MAX_COLUMNS = 32;
const MAX_ROWS = 20_000;
const MAX_SELECTION = 1_000;
const MAX_LABEL = 120;
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 640;
const DEFAULT_COLUMN_WIDTH = 180;
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;

const cleanText = (value: unknown, limit = MAX_LABEL): string => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit);

const finite = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
const integer = (value: number, fallback = 0): number => Math.trunc(finite(value, fallback));

const nextRevision = (revision: number): number => {
  const safe = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  return safe >= MAX_REVISION ? 0 : safe + 1;
};

const normalizeIds = (values: readonly string[], limit: number): readonly string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values) {
    if (output.length >= limit) break;
    const value = cleanText(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return Object.freeze(output);
};

const normalizeColumns = (inputs: readonly WorkspaceTableColumnInput[]): readonly WorkspaceTableColumn[] => {
  const seen = new Set<string>();
  const columns: WorkspaceTableColumn[] = [];
  for (const input of inputs) {
    if (columns.length >= MAX_COLUMNS) break;
    const key = cleanText(input.key, 80);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const minimumWidth = clamp(integer(input.minimumWidth ?? MIN_COLUMN_WIDTH, MIN_COLUMN_WIDTH), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
    const maximumWidth = clamp(integer(input.maximumWidth ?? MAX_COLUMN_WIDTH, MAX_COLUMN_WIDTH), minimumWidth, MAX_COLUMN_WIDTH);
    const width = clamp(integer(input.width ?? DEFAULT_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH), minimumWidth, maximumWidth);
    columns.push(Object.freeze({
      key,
      label: cleanText(input.label) || key,
      sortable: Boolean(input.sortable),
      width,
      minimumWidth,
      maximumWidth,
      numeric: Boolean(input.numeric),
    }));
  }
  return Object.freeze(columns);
};

const normalizeFocus = (
  focus: WorkspaceTableFocus,
  rowCount: number,
  columnCount: number,
): WorkspaceTableFocus => {
  const maxColumn = Math.max(0, columnCount - 1);
  if (focus.inHeader) {
    return Object.freeze({ rowIndex: 0, columnIndex: clamp(integer(focus.columnIndex), 0, maxColumn), inHeader: true });
  }
  const maxRow = Math.max(0, rowCount - 1);
  return Object.freeze({
    rowIndex: clamp(integer(focus.rowIndex), 0, maxRow),
    columnIndex: clamp(integer(focus.columnIndex), 0, maxColumn),
    inHeader: false,
  });
};

const deriveAccessibility = (
  workspace: ResultWorkspaceSnapshot,
  rowCount: number,
  columnCount: number,
  selectionMode: WorkspaceTableSelectionMode,
): WorkspaceTableAccessibility => Object.freeze({
  role: 'grid',
  rowCount,
  columnCount,
  ariaMultiSelectable: selectionMode === 'multiple',
  ariaBusy: workspace.model.status === 'loading',
  ariaLabel: cleanText(workspace.model.heading) || 'Harita sonuçları tablosu',
  keyboardHint: 'Ok tuşları hücreler arasında gezinir. Home ve End satır sınırlarına gider. Ctrl+Home ve Ctrl+End tablo sınırlarına gider.',
  focusVisible: workspace.modality === 'keyboard',
  minimumTargetSize: workspace.accessibility.minimumTargetSize,
});

const cellId = (rowId: string, columnKey: string): string => {
  const safe = `${cleanText(rowId, 48)}-${cleanText(columnKey, 48)}`
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9çğıöşü_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return safe ? `result-grid-${safe}` : 'result-grid-cell';
};

const headerId = (columnKey: string): string => `result-grid-header-${cleanText(columnKey, 64)
  .toLocaleLowerCase('tr-TR')
  .replace(/[^a-z0-9çğıöşü_-]+/gi, '-')
  .replace(/^-+|-+$/g, '')}`;

const focusId = (snapshot: WorkspaceTableSnapshot): string | null => {
  const column = snapshot.columns[snapshot.focus.columnIndex];
  if (!column) return null;
  if (snapshot.focus.inHeader) return headerId(column.key);
  const rowId = snapshot.rowIds[snapshot.focus.rowIndex];
  return rowId ? cellId(rowId, column.key) : null;
};

const selectedFromWorkspace = (workspace: ResultWorkspaceSnapshot, rowIds: readonly string[]): readonly string[] => {
  const admitted = new Set(rowIds);
  return normalizeIds(workspace.interaction.selectedIds.filter((id) => admitted.has(id)), MAX_SELECTION);
};

export function createArcGisResultWorkspaceTableExperience(
  workspace: ResultWorkspaceSnapshot,
  columnInputs: readonly WorkspaceTableColumnInput[],
  selectionMode: WorkspaceTableSelectionMode = 'multiple',
): WorkspaceTableSnapshot {
  const columns = normalizeColumns(columnInputs);
  const rowIds = normalizeIds(workspace.interaction.resultIds, MAX_ROWS);
  const focusedIndex = workspace.interaction.focusedId ? rowIds.indexOf(workspace.interaction.focusedId) : -1;
  const focus = normalizeFocus({ rowIndex: Math.max(0, focusedIndex), columnIndex: 0, inHeader: rowIds.length === 0 }, rowIds.length, columns.length);
  return Object.freeze({
    columns,
    rowIds,
    selectedIds: selectedFromWorkspace(workspace, rowIds),
    focus,
    sort: Object.freeze({ columnKey: null, direction: 'none' as const }),
    selectionMode,
    accessibility: deriveAccessibility(workspace, rowIds.length, columns.length, selectionMode),
    revision: 0,
  });
}

const transition = (
  current: WorkspaceTableSnapshot,
  patch: Partial<WorkspaceTableSnapshot>,
  action: WorkspaceTableNavigationAction,
  announcement = '',
): WorkspaceTableTransition => {
  const next = Object.freeze({ ...current, ...patch, revision: nextRevision(current.revision) });
  return Object.freeze({ next, action, focusId: focusId(next), announcement: cleanText(announcement, 240) });
};

const boundaryAnnouncement = (rowBoundary: boolean, columnBoundary: boolean): string => {
  if (rowBoundary && columnBoundary) return 'Tablo sınırına ulaşıldı.';
  if (rowBoundary) return 'Sonuç satırı sınırına ulaşıldı.';
  if (columnBoundary) return 'Sütun sınırına ulaşıldı.';
  return '';
};

const moveFocus = (snapshot: WorkspaceTableSnapshot, rowDelta: number, columnDelta: number): WorkspaceTableTransition => {
  if (snapshot.columns.length === 0) return transition(snapshot, {}, 'none');
  const rowCount = snapshot.rowIds.length;
  if (rowCount === 0) {
    const nextColumn = clamp(snapshot.focus.columnIndex + integer(columnDelta), 0, snapshot.columns.length - 1);
    return transition(snapshot, { focus: Object.freeze({ rowIndex: 0, columnIndex: nextColumn, inHeader: true }) }, 'focus-header');
  }
  const requestedRow = snapshot.focus.inHeader ? Math.max(0, integer(rowDelta) - 1) : snapshot.focus.rowIndex + integer(rowDelta);
  const requestedColumn = snapshot.focus.columnIndex + integer(columnDelta);
  const nextRow = clamp(requestedRow, 0, rowCount - 1);
  const nextColumn = clamp(requestedColumn, 0, snapshot.columns.length - 1);
  const rowBoundary = nextRow !== requestedRow;
  const columnBoundary = nextColumn !== requestedColumn;
  return transition(
    snapshot,
    { focus: Object.freeze({ rowIndex: nextRow, columnIndex: nextColumn, inHeader: false }) },
    rowBoundary || columnBoundary ? 'announce-boundary' : 'focus-cell',
    boundaryAnnouncement(rowBoundary, columnBoundary),
  );
};

const applySort = (snapshot: WorkspaceTableSnapshot, rawKey: string): WorkspaceTableTransition => {
  const key = cleanText(rawKey, 80);
  const column = snapshot.columns.find((candidate) => candidate.key === key);
  if (!column?.sortable) return transition(snapshot, {}, 'none');
  let direction: WorkspaceTableSortDirection = 'ascending';
  if (snapshot.sort.columnKey === key && snapshot.sort.direction === 'ascending') direction = 'descending';
  else if (snapshot.sort.columnKey === key && snapshot.sort.direction === 'descending') direction = 'none';
  const sort = Object.freeze({ columnKey: direction === 'none' ? null : key, direction });
  const suffix = direction === 'ascending' ? 'artan' : direction === 'descending' ? 'azalan' : 'sıralama kaldırıldı';
  return transition(snapshot, { sort }, 'focus-header', `${column.label}: ${suffix}.`);
};

const toggleSelection = (snapshot: WorkspaceTableSnapshot, requestedId?: string): WorkspaceTableTransition => {
  const focused = snapshot.rowIds[snapshot.focus.rowIndex] ?? '';
  const id = cleanText(requestedId ?? focused);
  if (!id || !snapshot.rowIds.includes(id)) return transition(snapshot, {}, 'none');
  const selected = new Set(snapshot.selectedIds);
  if (snapshot.selectionMode === 'single') {
    const next = selected.has(id) && selected.size === 1 ? [] : [id];
    return transition(snapshot, { selectedIds: Object.freeze(next) }, 'focus-cell', next.length ? '1 sonuç seçildi.' : 'Seçim temizlendi.');
  }
  if (selected.has(id)) selected.delete(id);
  else if (selected.size < MAX_SELECTION) selected.add(id);
  const next = Object.freeze(Array.from(selected));
  return transition(snapshot, { selectedIds: next }, 'focus-cell', `${next.length} sonuç seçili.`);
};

const resizeColumn = (snapshot: WorkspaceTableSnapshot, keyValue: string, widthValue: number): WorkspaceTableTransition => {
  const key = cleanText(keyValue, 80);
  const index = snapshot.columns.findIndex((column) => column.key === key);
  if (index < 0) return transition(snapshot, {}, 'none');
  const columns = snapshot.columns.slice();
  const column = columns[index]!;
  const width = clamp(integer(widthValue, column.width), column.minimumWidth, column.maximumWidth);
  columns[index] = Object.freeze({ ...column, width });
  return transition(snapshot, { columns: Object.freeze(columns) }, 'none', `${column.label} sütunu ${width} piksel.`);
};

const reconcileRows = (snapshot: WorkspaceTableSnapshot, values: readonly string[]): WorkspaceTableTransition => {
  const rowIds = normalizeIds(values, MAX_ROWS);
  const admitted = new Set(rowIds);
  const selectedIds = Object.freeze(snapshot.selectedIds.filter((id) => admitted.has(id)).slice(0, MAX_SELECTION));
  const previousFocusedId = snapshot.focus.inHeader ? null : snapshot.rowIds[snapshot.focus.rowIndex] ?? null;
  const preservedIndex = previousFocusedId ? rowIds.indexOf(previousFocusedId) : -1;
  const focus = normalizeFocus({
    rowIndex: preservedIndex >= 0 ? preservedIndex : snapshot.focus.rowIndex,
    columnIndex: snapshot.focus.columnIndex,
    inHeader: rowIds.length === 0,
  }, rowIds.length, snapshot.columns.length);
  const removedSelectionCount = snapshot.selectedIds.length - selectedIds.length;
  return transition(snapshot, { rowIds, selectedIds, focus }, rowIds.length ? 'focus-cell' : 'focus-header', removedSelectionCount > 0 ? `${removedSelectionCount} eski seçim kaldırıldı.` : '');
};

export function applyArcGisResultWorkspaceTableIntent(
  snapshot: WorkspaceTableSnapshot,
  intent: WorkspaceTableIntent,
): WorkspaceTableTransition {
  if (intent.type === 'move') return moveFocus(snapshot, intent.rowDelta, intent.columnDelta);
  if (intent.type === 'focus-header') {
    const columnIndex = clamp(integer(intent.columnIndex ?? snapshot.focus.columnIndex), 0, Math.max(0, snapshot.columns.length - 1));
    return transition(snapshot, { focus: Object.freeze({ rowIndex: 0, columnIndex, inHeader: true }) }, 'focus-header');
  }
  if (intent.type === 'home') {
    const focus = intent.scope === 'grid'
      ? Object.freeze({ rowIndex: 0, columnIndex: 0, inHeader: snapshot.rowIds.length === 0 })
      : Object.freeze({ ...snapshot.focus, columnIndex: 0 });
    return transition(snapshot, { focus }, focus.inHeader ? 'focus-header' : 'focus-cell');
  }
  if (intent.type === 'end') {
    const columnIndex = Math.max(0, snapshot.columns.length - 1);
    const focus = intent.scope === 'grid'
      ? Object.freeze({ rowIndex: Math.max(0, snapshot.rowIds.length - 1), columnIndex, inHeader: snapshot.rowIds.length === 0 })
      : Object.freeze({ ...snapshot.focus, columnIndex });
    return transition(snapshot, { focus }, focus.inHeader ? 'focus-header' : 'focus-cell');
  }
  if (intent.type === 'sort') return applySort(snapshot, intent.columnKey);
  if (intent.type === 'toggle-selection') return toggleSelection(snapshot, intent.rowId);
  if (intent.type === 'select-all-visible') {
    if (snapshot.selectionMode === 'single') return transition(snapshot, {}, 'none');
    const selectedIds = Object.freeze(snapshot.rowIds.slice(0, MAX_SELECTION));
    return transition(snapshot, { selectedIds }, 'focus-cell', `${selectedIds.length} görünür sonuç seçildi.`);
  }
  if (intent.type === 'clear-selection') return transition(snapshot, { selectedIds: Object.freeze([]) }, 'focus-cell', 'Seçim temizlendi.');
  if (intent.type === 'resize-column') return resizeColumn(snapshot, intent.columnKey, intent.width);
  return reconcileRows(snapshot, intent.rowIds);
}

export function resolveArcGisResultWorkspaceTableKeyboardIntent(
  key: string,
  ctrlKey = false,
  shiftKey = false,
): WorkspaceTableIntent | null {
  if (key === 'ArrowDown') return Object.freeze({ type: 'move', rowDelta: 1, columnDelta: 0 });
  if (key === 'ArrowUp') return Object.freeze({ type: 'move', rowDelta: -1, columnDelta: 0 });
  if (key === 'ArrowRight') return Object.freeze({ type: 'move', rowDelta: 0, columnDelta: 1 });
  if (key === 'ArrowLeft') return Object.freeze({ type: 'move', rowDelta: 0, columnDelta: -1 });
  if (key === 'Home') return Object.freeze({ type: 'home', scope: ctrlKey ? 'grid' : 'row' });
  if (key === 'End') return Object.freeze({ type: 'end', scope: ctrlKey ? 'grid' : 'row' });
  if (key === ' ' || key === 'Spacebar') return Object.freeze({ type: 'toggle-selection' });
  if (ctrlKey && key.toLocaleLowerCase('tr-TR') === 'a') return Object.freeze({ type: 'select-all-visible' });
  if (shiftKey && key.toLocaleLowerCase('tr-TR') === 'h') return Object.freeze({ type: 'focus-header' });
  return null;
}

export function shouldSuppressArcGisResultWorkspaceTableShortcut(
  modality: ResultWorkspaceInputModality,
  context: WorkspaceTableShortcutContext = {},
): boolean {
  if (context.disabled || context.editable || context.composing) return true;
  if (context.modalOpen && modality !== 'keyboard') return true;
  return modality !== 'keyboard';
}

export function getArcGisResultWorkspaceTableCellId(
  snapshot: WorkspaceTableSnapshot,
  rowIndex: number,
  columnIndex: number,
): string | null {
  const rowId = snapshot.rowIds[integer(rowIndex, -1)];
  const column = snapshot.columns[integer(columnIndex, -1)];
  return rowId && column ? cellId(rowId, column.key) : null;
}

export function getArcGisResultWorkspaceTableHeaderId(
  snapshot: WorkspaceTableSnapshot,
  columnIndex: number,
): string | null {
  const column = snapshot.columns[integer(columnIndex, -1)];
  return column ? headerId(column.key) : null;
}
