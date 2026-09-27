import { describe, expect, it, vi } from 'vitest';
import { createDataTableInteractionModel } from './dataTableInteractionModel';

interface Row { id: string; name: string; score: number; }
const columns = [
  { id: 'name', label: 'Ad', sortable: true, value: (row: Row) => row.name },
  { id: 'score', label: 'Puan', sortable: true, value: (row: Row) => row.score },
  { id: 'static', label: 'Sabit', value: (row: Row) => row.id },
] as const;
const rows: Row[] = [
  { id: 'a', name: 'İzmir', score: 30 },
  { id: 'b', name: 'Ankara', score: 10 },
  { id: 'c', name: 'Bursa', score: 20 },
  { id: 'd', name: 'Çorum', score: 40 },
];
const model = (options: Partial<Parameters<typeof createDataTableInteractionModel<Row>>[0]> = {}) =>
  createDataTableInteractionModel<Row>({ rowId: (row) => row.id, columns, ...options });

describe('dataTableInteractionModel', () => {
  it('loads rows and exposes immutable paging facts', () => {
    const table = model({ pageSize: 2 });
    table.setRows(rows);
    const snapshot = table.snapshot();
    expect(snapshot.totalRows).toBe(4);
    expect(snapshot.visibleRows).toBe(2);
    expect(snapshot.pageCount).toBe(2);
    expect(snapshot.canPreviousPage).toBe(false);
    expect(snapshot.canNextPage).toBe(true);
    expect(snapshot.rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(snapshot.announcement).toContain('4 kayıt');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rows)).toBe(true);
  });

  it('rejects duplicate and blank row identities', () => {
    const table = model();
    expect(() => table.setRows([{ id: '', name: 'x', score: 1 }])).toThrow(/kimlik boş/);
    expect(() => table.setRows([{ id: 'x', name: 'x', score: 1 }, { id: ' x ', name: 'y', score: 2 }])).toThrow(/tekrarlanamaz/);
  });

  it('enforces bounded row capacity', () => {
    const table = model({ maxRows: 2 });
    expect(() => table.setRows(rows)).toThrow(/en fazla 2/);
  });

  it('moves between pages with bounded indices', () => {
    const table = model({ pageSize: 2 });
    table.setRows(rows);
    table.nextPage();
    expect(table.snapshot().rows.map((row) => row.id)).toEqual(['c', 'd']);
    table.nextPage();
    expect(table.snapshot().pageIndex).toBe(1);
    table.previousPage();
    table.previousPage();
    expect(table.snapshot().pageIndex).toBe(0);
  });

  it('keeps first visible record near the viewport when page size changes', () => {
    const table = model({ pageSize: 2 });
    table.setRows(rows);
    table.setPage(1);
    table.setPageSize(3);
    expect(table.snapshot().pageIndex).toBe(0);
    expect(table.snapshot().pageSize).toBe(3);
  });

  it('sorts ascending then descending and returns to source order', () => {
    const table = model();
    table.setRows(rows);
    table.sortBy('score');
    expect(table.snapshot().rows.map((row) => row.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(table.snapshot().sort?.direction).toBe('ascending');
    table.sortBy('score');
    expect(table.snapshot().rows.map((row) => row.id)).toEqual(['d', 'a', 'c', 'b']);
    table.clearSort();
    expect(table.snapshot().rows.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores unknown and non-sortable columns', () => {
    const table = model();
    table.setRows(rows);
    table.sortBy('missing');
    table.sortBy('static');
    expect(table.snapshot().sort).toBeNull();
  });

  it('uses Turkish-aware text sorting', () => {
    const table = model();
    table.setRows(rows);
    table.sortBy('name');
    expect(table.snapshot().rows.map((row) => row.value.name)).toEqual(['Ankara', 'Bursa', 'Çorum', 'İzmir']);
  });

  it('supports deterministic custom comparators', () => {
    const table = createDataTableInteractionModel<Row>({
      rowId: (row) => row.id,
      columns: [{ id: 'name-length', label: 'Uzunluk', sortable: true, value: (row) => row.name, compare: (a, b) => a.name.length - b.name.length }],
    });
    table.setRows(rows);
    table.sortBy('name-length');
    expect(table.snapshot().rows[0]?.value.name).toBe('İzmir');
  });

  it('moves active row using keyboard-like deltas', () => {
    const table = model({ pageSize: 2 });
    table.setRows(rows);
    table.moveActive(1);
    expect(table.snapshot().activeRowId).toBe('a');
    table.moveActive(1);
    expect(table.snapshot().activeRowId).toBe('b');
    table.moveActive(1);
    expect(table.snapshot().activeRowId).toBe('c');
    expect(table.snapshot().pageIndex).toBe(1);
    table.moveActive(-1);
    expect(table.snapshot().activeRowId).toBe('b');
    expect(table.snapshot().pageIndex).toBe(0);
  });

  it('moves active row to boundaries', () => {
    const table = model({ pageSize: 2 });
    table.setRows(rows);
    table.moveActiveToBoundary('last');
    expect(table.snapshot().activeRowId).toBe('d');
    expect(table.snapshot().pageIndex).toBe(1);
    table.moveActiveToBoundary('first');
    expect(table.snapshot().activeRowId).toBe('a');
    expect(table.snapshot().pageIndex).toBe(0);
  });

  it('reveals an explicitly activated off-page row', () => {
    const table = model({ pageSize: 2 });
    table.setRows(rows);
    table.setActive('d');
    expect(table.snapshot().activeRowId).toBe('d');
    expect(table.snapshot().pageIndex).toBe(1);
    table.setActive('missing');
    expect(table.snapshot().activeRowId).toBeNull();
  });

  it('preserves active identity through sorting', () => {
    const table = model({ pageSize: 2 });
    table.setRows(rows);
    table.setActive('d');
    table.sortBy('score');
    expect(table.snapshot().activeRowId).toBe('d');
  });

  it('supports multiple selection', () => {
    const table = model({ selectionMode: 'multiple' });
    table.setRows(rows);
    table.toggleSelection('a');
    table.toggleSelection('b');
    expect(table.snapshot().selectedIds).toEqual(['a', 'b']);
    expect(table.snapshot().announcement).toContain('2 kayıt');
    table.toggleSelection('a');
    expect(table.snapshot().selectedIds).toEqual(['b']);
  });

  it('supports single selection', () => {
    const table = model({ selectionMode: 'single' });
    table.setRows(rows);
    table.toggleSelection('a');
    table.toggleSelection('b');
    expect(table.snapshot().selectedIds).toEqual(['b']);
    table.toggleSelection('b');
    expect(table.snapshot().selectedIds).toEqual([]);
  });

  it('disables selection in none mode', () => {
    const table = model({ selectionMode: 'none' });
    table.setRows(rows);
    table.toggleSelection('a');
    table.selectOnly('b');
    table.selectAllVisible();
    expect(table.snapshot().selectedIds).toEqual([]);
  });

  it('selects all visible rows without selecting hidden pages', () => {
    const table = model({ pageSize: 2 });
    table.setRows(rows);
    table.selectAllVisible();
    expect(table.snapshot().selectedIds).toEqual(['a', 'b']);
    table.nextPage();
    table.selectAllVisible();
    expect(table.snapshot().selectedIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('selectOnly replaces existing selection', () => {
    const table = model();
    table.setRows(rows);
    table.toggleSelection('a');
    table.toggleSelection('b');
    table.selectOnly('c');
    expect(table.snapshot().selectedIds).toEqual(['c']);
  });

  it('clears selection with an accessible announcement', () => {
    const table = model();
    table.setRows(rows);
    table.toggleSelection('a');
    table.clearSelection();
    expect(table.snapshot().selectedIds).toEqual([]);
    expect(table.snapshot().announcement).toMatch(/temizlendi/);
  });

  it('reconciles selection and active row when data changes', () => {
    const table = model();
    table.setRows(rows);
    table.toggleSelection('a');
    table.toggleSelection('b');
    table.setActive('a');
    table.setRows(rows.slice(1));
    expect(table.snapshot().selectedIds).toEqual(['b']);
    expect(table.snapshot().activeRowId).toBeNull();
  });

  it('handles an empty dataset', () => {
    const table = model();
    table.setRows([]);
    const snapshot = table.snapshot();
    expect(snapshot.totalRows).toBe(0);
    expect(snapshot.pageCount).toBe(1);
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.announcement).toMatch(/kayıt yok/);
    table.moveActive(1);
    expect(table.snapshot().activeRowId).toBeNull();
  });

  it('notifies subscribers immediately and after mutations', () => {
    const table = model();
    const observer = vi.fn();
    const unsubscribe = table.subscribe(observer);
    expect(observer).toHaveBeenCalledTimes(1);
    table.setRows(rows);
    expect(observer).toHaveBeenCalledTimes(2);
    unsubscribe();
    table.clearSelection();
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('isolates observer failures', () => {
    const onObserverError = vi.fn();
    const table = model({ onObserverError });
    table.subscribe(() => { throw new Error('observer failed'); });
    expect(onObserverError).toHaveBeenCalledTimes(1);
    expect(() => table.setRows(rows)).not.toThrow();
    expect(onObserverError).toHaveBeenCalledTimes(2);
  });

  it('isolates diagnostics reporter failures', () => {
    const table = model({ onObserverError: () => { throw new Error('reporter failed'); } });
    expect(() => table.subscribe(() => { throw new Error('observer failed'); })).not.toThrow();
  });

  it('disposes deterministically and rejects later writes', () => {
    const table = model();
    table.setRows(rows);
    table.toggleSelection('a');
    table.dispose();
    table.dispose();
    expect(() => table.setRows(rows)).toThrow(/dispose/);
    expect(() => table.setPage(0)).toThrow(/dispose/);
  });

  it('keeps stable source order when sort values tie', () => {
    const table = model();
    table.setRows([
      { id: 'x', name: 'A', score: 1 },
      { id: 'y', name: 'B', score: 1 },
      { id: 'z', name: 'C', score: 1 },
    ]);
    table.sortBy('score');
    expect(table.snapshot().rows.map((row) => row.id)).toEqual(['x', 'y', 'z']);
  });

  it('clamps invalid page sizes to safe bounds', () => {
    const table = model({ pageSize: 0 });
    table.setRows(rows);
    expect(table.snapshot().pageSize).toBe(1);
    table.setPageSize(Number.POSITIVE_INFINITY);
    expect(table.snapshot().pageSize).toBe(1);
    table.setPageSize(9999);
    expect(table.snapshot().pageSize).toBe(250);
  });

  it('ignores unknown selection identities', () => {
    const table = model();
    table.setRows(rows);
    table.toggleSelection('missing');
    table.selectOnly('missing');
    expect(table.snapshot().selectedIds).toEqual([]);
  });

  it('tracks monotonically increasing revisions', () => {
    const table = model();
    const first = table.snapshot().revision;
    table.setRows(rows);
    const second = table.snapshot().revision;
    table.toggleSelection('a');
    const third = table.snapshot().revision;
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });
});
