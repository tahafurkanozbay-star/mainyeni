import { describe, expect, it } from 'vitest';
import { createArcGisResultWorkspaceExperience } from './ArcGisResultWorkspaceExperiencePolicy';
import {
  applyArcGisResultWorkspaceTableIntent,
  createArcGisResultWorkspaceTableExperience,
  getArcGisResultWorkspaceTableCellId,
  getArcGisResultWorkspaceTableHeaderId,
  resolveArcGisResultWorkspaceTableKeyboardIntent,
  shouldSuppressArcGisResultWorkspaceTableShortcut,
  type WorkspaceTableColumnInput,
} from './ArcGisResultWorkspaceTableExperiencePolicy';

const input = {
  status: 'ready' as const,
  heading: 'Adres sonuçları',
  totalCount: 3,
  rows: [
    { key: 'a', title: 'A' },
    { key: 'b', title: 'B' },
    { key: 'c', title: 'C' },
  ],
};
const desktop = { viewportWidth: 1440, viewportHeight: 900 };
const columns: readonly WorkspaceTableColumnInput[] = [
  { key: 'name', label: 'Ad', sortable: true, width: 240 },
  { key: 'district', label: 'İlçe', sortable: true, width: 160 },
  { key: 'distance', label: 'Mesafe', sortable: true, numeric: true, width: 120 },
];
const workspace = () => createArcGisResultWorkspaceExperience(input, desktop, 'keyboard');
const table = () => createArcGisResultWorkspaceTableExperience(workspace(), columns);

describe('ArcGisResultWorkspaceTableExperiencePolicy', () => {
  it('creates a bounded grid contract from workspace authority', () => {
    const value = table();
    expect(value.accessibility.role).toBe('grid');
    expect(value.accessibility.rowCount).toBe(3);
    expect(value.accessibility.columnCount).toBe(3);
    expect(value.accessibility.ariaLabel).toBe('Adres sonuçları');
  });

  it('inherits keyboard focus visibility and target size', () => {
    const value = table();
    expect(value.accessibility.focusVisible).toBe(true);
    expect(value.accessibility.minimumTargetSize).toBe(44);
  });

  it('uses coarse pointer target size from workspace', () => {
    const coarse = createArcGisResultWorkspaceExperience(input, { ...desktop, coarsePointer: true }, 'touch');
    const value = createArcGisResultWorkspaceTableExperience(coarse, columns);
    expect(value.accessibility.minimumTargetSize).toBe(48);
    expect(value.accessibility.focusVisible).toBe(false);
  });

  it('starts on the first result cell', () => {
    const value = table();
    expect(value.focus).toEqual({ rowIndex: 0, columnIndex: 0, inHeader: false });
    expect(getArcGisResultWorkspaceTableCellId(value, 0, 0)).toBe('result-grid-a-name');
  });

  it('creates deterministic header identifiers', () => {
    expect(getArcGisResultWorkspaceTableHeaderId(table(), 1)).toBe('result-grid-header-district');
  });

  it('moves right across columns', () => {
    const moved = applyArcGisResultWorkspaceTableIntent(table(), { type: 'move', rowDelta: 0, columnDelta: 1 });
    expect(moved.next.focus.columnIndex).toBe(1);
    expect(moved.focusId).toBe('result-grid-a-district');
    expect(moved.action).toBe('focus-cell');
  });

  it('moves down across rows', () => {
    const moved = applyArcGisResultWorkspaceTableIntent(table(), { type: 'move', rowDelta: 1, columnDelta: 0 });
    expect(moved.next.focus.rowIndex).toBe(1);
    expect(moved.focusId).toBe('result-grid-b-name');
  });

  it('announces row boundaries rather than wrapping', () => {
    const moved = applyArcGisResultWorkspaceTableIntent(table(), { type: 'move', rowDelta: -1, columnDelta: 0 });
    expect(moved.next.focus.rowIndex).toBe(0);
    expect(moved.action).toBe('announce-boundary');
    expect(moved.announcement).toContain('satırı');
  });

  it('announces column boundaries rather than wrapping', () => {
    const moved = applyArcGisResultWorkspaceTableIntent(table(), { type: 'move', rowDelta: 0, columnDelta: -1 });
    expect(moved.next.focus.columnIndex).toBe(0);
    expect(moved.announcement).toContain('Sütun');
  });

  it('moves to row home', () => {
    const right = applyArcGisResultWorkspaceTableIntent(table(), { type: 'move', rowDelta: 1, columnDelta: 2 }).next;
    const home = applyArcGisResultWorkspaceTableIntent(right, { type: 'home', scope: 'row' });
    expect(home.next.focus).toEqual({ rowIndex: 1, columnIndex: 0, inHeader: false });
  });

  it('moves to row end', () => {
    const end = applyArcGisResultWorkspaceTableIntent(table(), { type: 'end', scope: 'row' });
    expect(end.next.focus.columnIndex).toBe(2);
    expect(end.next.focus.rowIndex).toBe(0);
  });

  it('moves to grid end', () => {
    const end = applyArcGisResultWorkspaceTableIntent(table(), { type: 'end', scope: 'grid' });
    expect(end.next.focus).toEqual({ rowIndex: 2, columnIndex: 2, inHeader: false });
  });

  it('moves to grid home', () => {
    const end = applyArcGisResultWorkspaceTableIntent(table(), { type: 'end', scope: 'grid' }).next;
    const home = applyArcGisResultWorkspaceTableIntent(end, { type: 'home', scope: 'grid' });
    expect(home.next.focus).toEqual({ rowIndex: 0, columnIndex: 0, inHeader: false });
  });

  it('focuses a requested header safely', () => {
    const focused = applyArcGisResultWorkspaceTableIntent(table(), { type: 'focus-header', columnIndex: 1 });
    expect(focused.next.focus.inHeader).toBe(true);
    expect(focused.focusId).toBe('result-grid-header-district');
  });

  it('clamps an oversized header index', () => {
    const focused = applyArcGisResultWorkspaceTableIntent(table(), { type: 'focus-header', columnIndex: 999 });
    expect(focused.next.focus.columnIndex).toBe(2);
  });

  it('cycles sortable column ascending descending none', () => {
    const first = applyArcGisResultWorkspaceTableIntent(table(), { type: 'sort', columnKey: 'name' });
    expect(first.next.sort).toEqual({ columnKey: 'name', direction: 'ascending' });
    const second = applyArcGisResultWorkspaceTableIntent(first.next, { type: 'sort', columnKey: 'name' });
    expect(second.next.sort.direction).toBe('descending');
    const third = applyArcGisResultWorkspaceTableIntent(second.next, { type: 'sort', columnKey: 'name' });
    expect(third.next.sort).toEqual({ columnKey: null, direction: 'none' });
  });

  it('rejects sorting an unknown column', () => {
    const result = applyArcGisResultWorkspaceTableIntent(table(), { type: 'sort', columnKey: 'secret' });
    expect(result.next.sort.direction).toBe('none');
    expect(result.action).toBe('none');
  });

  it('rejects sorting a non-sortable column', () => {
    const value = createArcGisResultWorkspaceTableExperience(workspace(), [{ key: 'name', label: 'Ad' }]);
    expect(applyArcGisResultWorkspaceTableIntent(value, { type: 'sort', columnKey: 'name' }).next.sort.direction).toBe('none');
  });

  it('toggles focused row selection', () => {
    const selected = applyArcGisResultWorkspaceTableIntent(table(), { type: 'toggle-selection' });
    expect(selected.next.selectedIds).toEqual(['a']);
    expect(selected.announcement).toBe('1 sonuç seçili.');
  });

  it('toggles an explicit admitted row selection', () => {
    const selected = applyArcGisResultWorkspaceTableIntent(table(), { type: 'toggle-selection', rowId: 'c' });
    expect(selected.next.selectedIds).toEqual(['c']);
  });

  it('rejects selection outside the admitted result inventory', () => {
    const selected = applyArcGisResultWorkspaceTableIntent(table(), { type: 'toggle-selection', rowId: 'missing' });
    expect(selected.next.selectedIds).toEqual([]);
  });

  it('selects all visible rows in multiple mode', () => {
    const selected = applyArcGisResultWorkspaceTableIntent(table(), { type: 'select-all-visible' });
    expect(selected.next.selectedIds).toEqual(['a', 'b', 'c']);
  });

  it('does not select all in single mode', () => {
    const single = createArcGisResultWorkspaceTableExperience(workspace(), columns, 'single');
    const selected = applyArcGisResultWorkspaceTableIntent(single, { type: 'select-all-visible' });
    expect(selected.next.selectedIds).toEqual([]);
    expect(selected.next.accessibility.ariaMultiSelectable).toBe(false);
  });

  it('replaces selection in single mode', () => {
    const single = createArcGisResultWorkspaceTableExperience(workspace(), columns, 'single');
    const a = applyArcGisResultWorkspaceTableIntent(single, { type: 'toggle-selection', rowId: 'a' }).next;
    const b = applyArcGisResultWorkspaceTableIntent(a, { type: 'toggle-selection', rowId: 'b' }).next;
    expect(b.selectedIds).toEqual(['b']);
  });

  it('clears selection deterministically', () => {
    const selected = applyArcGisResultWorkspaceTableIntent(table(), { type: 'select-all-visible' }).next;
    const cleared = applyArcGisResultWorkspaceTableIntent(selected, { type: 'clear-selection' });
    expect(cleared.next.selectedIds).toEqual([]);
    expect(cleared.announcement).toBe('Seçim temizlendi.');
  });

  it('resizes a column inside its constraints', () => {
    const resized = applyArcGisResultWorkspaceTableIntent(table(), { type: 'resize-column', columnKey: 'name', width: 320 });
    expect(resized.next.columns[0]?.width).toBe(320);
  });

  it('clamps a column below minimum width', () => {
    const resized = applyArcGisResultWorkspaceTableIntent(table(), { type: 'resize-column', columnKey: 'name', width: 1 });
    expect(resized.next.columns[0]?.width).toBe(72);
  });

  it('clamps a column above maximum width', () => {
    const resized = applyArcGisResultWorkspaceTableIntent(table(), { type: 'resize-column', columnKey: 'name', width: 9999 });
    expect(resized.next.columns[0]?.width).toBe(640);
  });

  it('honors explicit column width constraints', () => {
    const value = createArcGisResultWorkspaceTableExperience(workspace(), [{ key: 'x', label: 'X', minimumWidth: 100, maximumWidth: 200, width: 150 }]);
    const low = applyArcGisResultWorkspaceTableIntent(value, { type: 'resize-column', columnKey: 'x', width: 50 });
    expect(low.next.columns[0]?.width).toBe(100);
  });

  it('deduplicates and sanitizes columns', () => {
    const value = createArcGisResultWorkspaceTableExperience(workspace(), [
      { key: ' name\u0000 ', label: ' Ad\u0000 ' },
      { key: 'name', label: 'Duplicate' },
      { key: '', label: 'Empty' },
    ]);
    expect(value.columns).toHaveLength(1);
    expect(value.columns[0]?.key).toBe('name');
    expect(value.columns[0]?.label).toBe('Ad');
  });

  it('bounds column inventory', () => {
    const many = Array.from({ length: 100 }, (_, index) => ({ key: `c-${index}`, label: `C ${index}` }));
    expect(createArcGisResultWorkspaceTableExperience(workspace(), many).columns).toHaveLength(32);
  });

  it('reconciles removed rows and drops stale selection', () => {
    const selected = applyArcGisResultWorkspaceTableIntent(table(), { type: 'toggle-selection', rowId: 'b' }).next;
    const reconciled = applyArcGisResultWorkspaceTableIntent(selected, { type: 'reconcile', rowIds: ['a', 'c'] });
    expect(reconciled.next.rowIds).toEqual(['a', 'c']);
    expect(reconciled.next.selectedIds).toEqual([]);
    expect(reconciled.announcement).toContain('1 eski seçim');
  });

  it('preserves focused row across reconciliation', () => {
    const focused = applyArcGisResultWorkspaceTableIntent(table(), { type: 'move', rowDelta: 1, columnDelta: 1 }).next;
    const reconciled = applyArcGisResultWorkspaceTableIntent(focused, { type: 'reconcile', rowIds: ['c', 'b', 'a'] });
    expect(reconciled.next.rowIds[reconciled.next.focus.rowIndex]).toBe('b');
    expect(reconciled.next.focus.columnIndex).toBe(1);
  });

  it('moves focus to header when results become empty', () => {
    const reconciled = applyArcGisResultWorkspaceTableIntent(table(), { type: 'reconcile', rowIds: [] });
    expect(reconciled.next.focus.inHeader).toBe(true);
    expect(reconciled.action).toBe('focus-header');
  });

  it('deduplicates reconciled row ids', () => {
    const reconciled = applyArcGisResultWorkspaceTableIntent(table(), { type: 'reconcile', rowIds: ['a', 'a', 'b', '', 'b'] });
    expect(reconciled.next.rowIds).toEqual(['a', 'b']);
  });

  it('increments revision for transitions', () => {
    const first = applyArcGisResultWorkspaceTableIntent(table(), { type: 'move', rowDelta: 1, columnDelta: 0 });
    const second = applyArcGisResultWorkspaceTableIntent(first.next, { type: 'move', rowDelta: 1, columnDelta: 0 });
    expect(first.next.revision).toBe(1);
    expect(second.next.revision).toBe(2);
  });

  it('maps arrow keys to two-dimensional movement', () => {
    expect(resolveArcGisResultWorkspaceTableKeyboardIntent('ArrowDown')).toEqual({ type: 'move', rowDelta: 1, columnDelta: 0 });
    expect(resolveArcGisResultWorkspaceTableKeyboardIntent('ArrowRight')).toEqual({ type: 'move', rowDelta: 0, columnDelta: 1 });
  });

  it('maps home and ctrl-home to distinct scopes', () => {
    expect(resolveArcGisResultWorkspaceTableKeyboardIntent('Home')).toEqual({ type: 'home', scope: 'row' });
    expect(resolveArcGisResultWorkspaceTableKeyboardIntent('Home', true)).toEqual({ type: 'home', scope: 'grid' });
  });

  it('maps end and ctrl-end to distinct scopes', () => {
    expect(resolveArcGisResultWorkspaceTableKeyboardIntent('End')).toEqual({ type: 'end', scope: 'row' });
    expect(resolveArcGisResultWorkspaceTableKeyboardIntent('End', true)).toEqual({ type: 'end', scope: 'grid' });
  });

  it('maps space to selection', () => {
    expect(resolveArcGisResultWorkspaceTableKeyboardIntent(' ')).toEqual({ type: 'toggle-selection' });
  });

  it('maps ctrl-a to bounded visible selection', () => {
    expect(resolveArcGisResultWorkspaceTableKeyboardIntent('a', true)).toEqual({ type: 'select-all-visible' });
  });

  it('maps shift-h to header focus', () => {
    expect(resolveArcGisResultWorkspaceTableKeyboardIntent('h', false, true)).toEqual({ type: 'focus-header' });
  });

  it('returns null for unrelated keyboard input', () => {
    expect(resolveArcGisResultWorkspaceTableKeyboardIntent('F12')).toBeNull();
  });

  it('suppresses shortcuts inside editable targets', () => {
    expect(shouldSuppressArcGisResultWorkspaceTableShortcut('keyboard', { editable: true })).toBe(true);
  });

  it('suppresses shortcuts during IME composition', () => {
    expect(shouldSuppressArcGisResultWorkspaceTableShortcut('keyboard', { composing: true })).toBe(true);
  });

  it('suppresses shortcuts on disabled surfaces', () => {
    expect(shouldSuppressArcGisResultWorkspaceTableShortcut('keyboard', { disabled: true })).toBe(true);
  });

  it('allows keyboard shortcuts while modal state is represented by keyboard authority', () => {
    expect(shouldSuppressArcGisResultWorkspaceTableShortcut('keyboard', { modalOpen: true })).toBe(false);
  });

  it('suppresses non-keyboard dispatch', () => {
    expect(shouldSuppressArcGisResultWorkspaceTableShortcut('pointer')).toBe(true);
    expect(shouldSuppressArcGisResultWorkspaceTableShortcut('touch')).toBe(true);
  });

  it('returns null ids for out-of-range cells', () => {
    const value = table();
    expect(getArcGisResultWorkspaceTableCellId(value, 99, 0)).toBeNull();
    expect(getArcGisResultWorkspaceTableCellId(value, 0, 99)).toBeNull();
    expect(getArcGisResultWorkspaceTableHeaderId(value, 99)).toBeNull();
  });

  it('keeps accessibility hints explicit and non-empty', () => {
    expect(table().accessibility.keyboardHint).toContain('Ctrl+Home');
  });

  it('marks loading workspace table as busy', () => {
    const loading = createArcGisResultWorkspaceExperience({ ...input, status: 'loading' }, desktop, 'keyboard');
    expect(createArcGisResultWorkspaceTableExperience(loading, columns).accessibility.ariaBusy).toBe(true);
  });

  it('falls back to a safe label when heading is empty', () => {
    const unnamed = createArcGisResultWorkspaceExperience({ ...input, heading: '' }, desktop, 'keyboard');
    expect(createArcGisResultWorkspaceTableExperience(unnamed, columns).accessibility.ariaLabel).toBeTruthy();
  });

  it('preserves numeric column metadata for renderers', () => {
    expect(table().columns[2]?.numeric).toBe(true);
  });
});
