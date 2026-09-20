import { describe, expect, it, vi } from 'vitest';
import {
  calculateVisibleDataGridRange,
  createDataGridRuntime,
  navigationIntentFromKeyboard,
} from './dataGridRuntime';

interface Row {
  readonly id: string;
  readonly name: string;
}

const rows = (count: number): readonly Row[] => Array.from({ length: count }, (_, index) => ({
  id: `row-${index + 1}`,
  name: `Kayıt ${index + 1}`,
}));

const createRuntime = (count = 12) => createDataGridRuntime({
  rows: rows(count),
  getRowKey: (row) => row.id,
  selectionMode: 'multiple',
  pageSize: 5,
  maxSelection: 3,
});

describe('data grid keyboard intent', () => {
  it.each([
    ['ArrowDown', 'next-row'],
    ['ArrowUp', 'previous-row'],
    ['PageDown', 'page-forward'],
    ['PageUp', 'page-backward'],
    ['Home', 'first-row'],
    ['End', 'last-row'],
    ['Enter', 'activate'],
    [' ', 'toggle-selection'],
    ['Escape', 'clear-selection'],
  ] as const)('maps %s to %s', (key, expected) => {
    expect(navigationIntentFromKeyboard(key)).toBe(expected);
  });

  it('does not capture unrelated keys', () => {
    expect(navigationIntentFromKeyboard('Tab')).toBeNull();
    expect(navigationIntentFromKeyboard('a')).toBeNull();
    expect(navigationIntentFromKeyboard('F6')).toBeNull();
  });

  it('does not turn shifted space into a selection command', () => {
    expect(navigationIntentFromKeyboard(' ', { shiftKey: true })).toBeNull();
  });
});

describe('data grid visible range', () => {
  it('returns an empty range for an empty data set', () => {
    expect(calculateVisibleDataGridRange(0, {
      scrollTop: 100,
      viewportHeight: 200,
      rowHeight: 40,
      overscan: 2,
    })).toEqual({ start: 0, end: 0, offsetTop: 0, totalHeight: 0 });
  });

  it('includes overscan around the visible rows', () => {
    expect(calculateVisibleDataGridRange(100, {
      scrollTop: 400,
      viewportHeight: 200,
      rowHeight: 40,
      overscan: 2,
    })).toEqual({ start: 8, end: 17, offsetTop: 320, totalHeight: 4000 });
  });

  it('clamps the range at the start of the data set', () => {
    expect(calculateVisibleDataGridRange(10, {
      scrollTop: 0,
      viewportHeight: 80,
      rowHeight: 40,
      overscan: 4,
    })).toEqual({ start: 0, end: 6, offsetTop: 0, totalHeight: 400 });
  });

  it('clamps the range at the end of the data set', () => {
    expect(calculateVisibleDataGridRange(10, {
      scrollTop: 999,
      viewportHeight: 120,
      rowHeight: 40,
      overscan: 3,
    })).toEqual({ start: 6, end: 10, offsetTop: 240, totalHeight: 400 });
  });

  it('normalizes unsafe viewport values', () => {
    expect(calculateVisibleDataGridRange(3, {
      scrollTop: -10,
      viewportHeight: -1,
      rowHeight: 0,
      overscan: -2,
    })).toEqual({ start: 0, end: 1, offsetTop: 0, totalHeight: 3 });
  });
});

describe('data grid runtime focus and paging', () => {
  it('starts with a stable empty focus', () => {
    const runtime = createRuntime();
    expect(runtime.snapshot()).toMatchObject({
      rowCount: 12,
      pageSize: 5,
      pageIndex: 0,
      pageCount: 3,
      focusedKey: null,
      focusedIndex: -1,
      canPageBackward: false,
      canPageForward: true,
    });
  });

  it('focuses a known row and derives its page', () => {
    const runtime = createRuntime();
    expect(runtime.focus('row-8')).toMatchObject({ focusedKey: 'row-8', focusedIndex: 7, pageIndex: 1 });
  });

  it('ignores focus requests for unknown rows', () => {
    const runtime = createRuntime();
    const before = runtime.snapshot();
    const after = runtime.focus('missing');
    expect(after.focusedKey).toBeNull();
    expect(after.revision).toBe(before.revision);
  });

  it('clears focus explicitly', () => {
    const runtime = createRuntime();
    runtime.focus('row-2');
    expect(runtime.focus(null).focusedKey).toBeNull();
  });

  it('moves to the first row from an unfocused state', () => {
    const runtime = createRuntime();
    expect(runtime.navigate('next-row')).toMatchObject({ focusedKey: 'row-1', focusedIndex: 0 });
  });

  it('moves to the last row when navigating upward from an unfocused state', () => {
    const runtime = createRuntime();
    expect(runtime.navigate('previous-row')).toMatchObject({ focusedKey: 'row-12', focusedIndex: 11, pageIndex: 2 });
  });

  it('clamps next-row navigation at the final row', () => {
    const runtime = createRuntime();
    runtime.focus('row-12');
    expect(runtime.navigate('next-row')).toMatchObject({ focusedKey: 'row-12', focusedIndex: 11 });
  });

  it('clamps previous-row navigation at the first row', () => {
    const runtime = createRuntime();
    runtime.focus('row-1');
    expect(runtime.navigate('previous-row')).toMatchObject({ focusedKey: 'row-1', focusedIndex: 0 });
  });

  it('supports first and last row navigation', () => {
    const runtime = createRuntime();
    expect(runtime.navigate('last-row').focusedKey).toBe('row-12');
    expect(runtime.navigate('first-row').focusedKey).toBe('row-1');
  });

  it('moves by one configured page', () => {
    const runtime = createRuntime();
    runtime.focus('row-2');
    expect(runtime.navigate('page-forward').focusedKey).toBe('row-7');
    expect(runtime.navigate('page-backward').focusedKey).toBe('row-2');
  });

  it('sets pages and focuses their first row', () => {
    const runtime = createRuntime();
    expect(runtime.setPage(2)).toMatchObject({ pageIndex: 2, focusedKey: 'row-11' });
  });

  it('clamps page requests', () => {
    const runtime = createRuntime();
    expect(runtime.setPage(99).pageIndex).toBe(2);
    expect(runtime.setPage(-5).pageIndex).toBe(0);
  });

  it('returns only rows in the active page', () => {
    const runtime = createRuntime();
    runtime.setPage(1);
    expect(runtime.pageRows().map((row) => row.id)).toEqual(['row-6', 'row-7', 'row-8', 'row-9', 'row-10']);
  });

  it('returns a partial final page', () => {
    const runtime = createRuntime();
    runtime.setPage(2);
    expect(runtime.pageRows().map((row) => row.id)).toEqual(['row-11', 'row-12']);
  });
});

describe('data grid runtime selection', () => {
  it('toggles multiple selection', () => {
    const runtime = createRuntime();
    expect(runtime.select('row-2').selectedKeys).toEqual(['row-2']);
    expect(runtime.select('row-3').selectedKeys).toEqual(['row-2', 'row-3']);
    expect(runtime.select('row-2').selectedKeys).toEqual(['row-3']);
  });

  it('honors explicit selected state', () => {
    const runtime = createRuntime();
    runtime.select('row-2', true);
    runtime.select('row-2', true);
    expect(runtime.snapshot().selectedKeys).toEqual(['row-2']);
    runtime.select('row-2', false);
    expect(runtime.snapshot().selectedKeys).toEqual([]);
  });

  it('bounds multiple selection cardinality', () => {
    const runtime = createRuntime();
    runtime.select('row-1');
    runtime.select('row-2');
    runtime.select('row-3');
    expect(runtime.select('row-4').selectedKeys).toEqual(['row-2', 'row-3', 'row-4']);
  });

  it('ignores unknown selection keys', () => {
    const runtime = createRuntime();
    expect(runtime.select('missing').selectedKeys).toEqual([]);
  });

  it('clears selection', () => {
    const runtime = createRuntime();
    runtime.select('row-1');
    runtime.select('row-2');
    expect(runtime.clearSelection().selectedKeys).toEqual([]);
  });

  it('toggles focused selection from keyboard intent', () => {
    const runtime = createRuntime();
    runtime.focus('row-5');
    expect(runtime.navigate('toggle-selection').selectedKeys).toEqual(['row-5']);
    expect(runtime.navigate('toggle-selection').selectedKeys).toEqual([]);
  });

  it('clears selection from keyboard intent', () => {
    const runtime = createRuntime();
    runtime.select('row-1');
    expect(runtime.navigate('clear-selection').selectedKeys).toEqual([]);
  });

  it('does not select when selection mode is none', () => {
    const runtime = createDataGridRuntime({
      rows: rows(2),
      getRowKey: (row) => row.id,
      selectionMode: 'none',
    });
    expect(runtime.select('row-1').selectedKeys).toEqual([]);
  });

  it('enforces single selection mode', () => {
    const runtime = createDataGridRuntime({
      rows: rows(3),
      getRowKey: (row) => row.id,
      selectionMode: 'single',
      initialSelectedKeys: ['row-1', 'row-2'],
    });
    expect(runtime.snapshot().selectedKeys).toEqual(['row-1']);
    expect(runtime.select('row-3').selectedKeys).toEqual(['row-3']);
  });
});

describe('data grid runtime row replacement', () => {
  it('reconciles focus when the focused row disappears', () => {
    const runtime = createRuntime();
    runtime.focus('row-8');
    expect(runtime.replaceRows(rows(4))).toMatchObject({ focusedKey: null, focusedIndex: -1, pageIndex: 0 });
  });

  it('reconciles selection when selected rows disappear', () => {
    const runtime = createRuntime();
    runtime.select('row-2');
    runtime.select('row-8');
    expect(runtime.replaceRows(rows(4)).selectedKeys).toEqual(['row-2']);
  });

  it('clamps the active page after row count shrinks', () => {
    const runtime = createRuntime();
    runtime.setPage(2);
    expect(runtime.replaceRows(rows(3)).pageIndex).toBe(0);
  });

  it('preserves valid focus and selection after replacement', () => {
    const runtime = createRuntime();
    runtime.focus('row-3');
    runtime.select('row-3');
    expect(runtime.replaceRows(rows(6))).toMatchObject({ focusedKey: 'row-3', selectedKeys: ['row-3'] });
  });
});

describe('data grid runtime sorting contract', () => {
  it('stores an initial sort contract', () => {
    const runtime = createDataGridRuntime({
      rows: rows(2),
      getRowKey: (row) => row.id,
      initialSort: { columnId: 'name', direction: 'ascending' },
    });
    expect(runtime.snapshot().sort).toEqual({ columnId: 'name', direction: 'ascending' });
  });

  it('updates sort state and returns to the first page', () => {
    const runtime = createRuntime();
    runtime.setPage(2);
    expect(runtime.setSort({ columnId: 'name', direction: 'descending' })).toMatchObject({
      pageIndex: 0,
      sort: { columnId: 'name', direction: 'descending' },
    });
  });

  it('clears sort state', () => {
    const runtime = createRuntime();
    runtime.setSort({ columnId: 'name', direction: 'ascending' });
    expect(runtime.setSort(null).sort).toBeNull();
  });
});

describe('data grid runtime observers and lifecycle', () => {
  it('notifies subscribers after mutations', () => {
    const runtime = createRuntime();
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.focus('row-2');
    runtime.select('row-2');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ focusedKey: 'row-2', selectedKeys: ['row-2'] });
  });

  it('allows subscriptions to be removed', () => {
    const runtime = createRuntime();
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    unsubscribe();
    runtime.focus('row-2');
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates observer failures', () => {
    const runtime = createRuntime();
    const healthy = vi.fn();
    runtime.subscribe(() => { throw new Error('observer failure'); });
    runtime.subscribe(healthy);
    expect(() => runtime.focus('row-2')).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('stops mutations after disposal', () => {
    const runtime = createRuntime();
    runtime.focus('row-2');
    const before = runtime.snapshot();
    runtime.dispose();
    expect(runtime.focus('row-3')).toEqual(before);
    expect(runtime.select('row-3')).toEqual(before);
  });

  it('clears subscribers on disposal', () => {
    const runtime = createRuntime();
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.dispose();
    runtime.focus('row-2');
    expect(listener).not.toHaveBeenCalled();
  });
});
