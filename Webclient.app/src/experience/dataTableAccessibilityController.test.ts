import { describe, expect, it, vi } from 'vitest';
import { createDataTableInteractionModel } from './dataTableInteractionModel';
import { createDataTableAccessibilityController, type DataTableKeyboardEventLike } from './dataTableAccessibilityController';

interface Row { id: string; name: string; }
const rows: Row[] = [
  { id: 'a', name: 'Ankara' },
  { id: 'b', name: 'Bursa' },
  { id: 'c', name: 'Çorum' },
];

const setup = (selectionMode: 'none' | 'single' | 'multiple' = 'multiple') => {
  const model = createDataTableInteractionModel<Row>({
    rowId: (row) => row.id,
    columns: [{ id: 'name', label: 'Ad', sortable: true, value: (row) => row.name }],
    pageSize: 2,
    selectionMode,
  });
  model.setRows(rows);
  const focus = vi.fn();
  const controller = createDataTableAccessibilityController({ model, tableId: 'search-results', selectionMode, onFocusRequest: focus });
  return { model, controller, focus };
};

const key = (value: string, modifiers: Partial<DataTableKeyboardEventLike> = {}) => {
  const preventDefault = vi.fn();
  return { event: { key: value, preventDefault, ...modifiers } as DataTableKeyboardEventLike, preventDefault };
};

describe('dataTableAccessibilityController', () => {
  it('exposes bounded table facts', () => {
    const { controller } = setup();
    expect(controller.snapshot()).toEqual({
      activeDescendant: null,
      announcement: '3 kayıt yüklendi.',
      canNextPage: true,
      canPreviousPage: false,
      pageLabel: '1 / 2',
      rowCount: 3,
      selectedCount: 0,
      visibleRowCount: 2,
    });
  });

  it('creates semantic row facts for visible rows', () => {
    const { controller } = setup();
    expect(controller.row('a')).toEqual({
      active: false,
      ariaPosInSet: 1,
      ariaSelected: false,
      ariaSetSize: 3,
      id: 'search-results-row-a',
      rowId: 'a',
      tabIndex: -1,
    });
    expect(controller.row('c')).toBeNull();
  });

  it('omits aria-selected when selection is disabled', () => {
    const { controller } = setup('none');
    expect(controller.row('a')?.ariaSelected).toBeUndefined();
  });

  it('moves active row with ArrowDown and requests focus', () => {
    const { controller, focus } = setup();
    const input = key('ArrowDown');
    expect(controller.handleKey(input.event)).toBe('activate-next');
    expect(input.preventDefault).toHaveBeenCalledOnce();
    expect(controller.snapshot().activeDescendant).toBe('search-results-row-a');
    expect(focus).toHaveBeenLastCalledWith('search-results-row-a');
  });

  it('moves active row backwards from the end when none is active', () => {
    const { controller } = setup();
    controller.handleKey(key('ArrowUp').event);
    expect(controller.snapshot().activeDescendant).toBe('search-results-row-c');
  });

  it('supports Ctrl+Home and Ctrl+End boundaries', () => {
    const { controller } = setup();
    expect(controller.handleKey(key('Home').event)).toBeNull();
    controller.handleKey(key('End', { ctrlKey: true }).event);
    expect(controller.snapshot().activeDescendant).toBe('search-results-row-c');
    controller.handleKey(key('Home', { ctrlKey: true }).event);
    expect(controller.snapshot().activeDescendant).toBe('search-results-row-a');
  });

  it('pages with PageDown and PageUp', () => {
    const { controller, model } = setup();
    controller.handleKey(key('PageDown').event);
    expect(model.snapshot().pageIndex).toBe(1);
    expect(controller.snapshot().pageLabel).toBe('2 / 2');
    controller.handleKey(key('PageDown').event);
    expect(model.snapshot().pageIndex).toBe(1);
    controller.handleKey(key('PageUp').event);
    expect(model.snapshot().pageIndex).toBe(0);
  });

  it('selects active row with Space', () => {
    const { controller, model } = setup();
    controller.activate('b');
    controller.handleKey(key(' ').event);
    expect(model.snapshot().selectedIds).toEqual(['b']);
    expect(controller.snapshot().selectedCount).toBe(1);
  });

  it('selects active row with Enter', () => {
    const { controller, model } = setup();
    controller.activate('a');
    controller.handleKey(key('Enter').event);
    expect(model.snapshot().selectedIds).toEqual(['a']);
  });

  it('does not select when selection is disabled', () => {
    const { controller, model } = setup('none');
    controller.activate('a');
    controller.handleKey(key('Enter').event);
    controller.toggle('a');
    expect(model.snapshot().selectedIds).toEqual([]);
  });

  it('selects visible rows with Ctrl+A only in multiple mode', () => {
    const multiple = setup('multiple');
    multiple.controller.handleKey(key('a', { ctrlKey: true }).event);
    expect(multiple.model.snapshot().selectedIds).toEqual(['a', 'b']);
    const single = setup('single');
    single.controller.handleKey(key('a', { ctrlKey: true }).event);
    expect(single.model.snapshot().selectedIds).toEqual([]);
  });

  it('clears selection with Escape', () => {
    const { controller, model } = setup();
    controller.toggle('a');
    controller.handleKey(key('Escape').event);
    expect(model.snapshot().selectedIds).toEqual([]);
  });

  it('ignores modified navigation that belongs to browser or platform', () => {
    const { controller } = setup();
    const alt = key('ArrowDown', { altKey: true });
    const meta = key('ArrowDown', { metaKey: true });
    expect(controller.handleKey(alt.event)).toBeNull();
    expect(controller.handleKey(meta.event)).toBeNull();
    expect(alt.preventDefault).not.toHaveBeenCalled();
    expect(meta.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores unrelated keys without suppressing defaults', () => {
    const { controller } = setup();
    const input = key('Tab');
    expect(controller.handleKey(input.event)).toBeNull();
    expect(input.preventDefault).not.toHaveBeenCalled();
  });

  it('updates row tabindex after activation', () => {
    const { controller } = setup();
    controller.activate('b');
    expect(controller.row('a')?.tabIndex).toBe(-1);
    expect(controller.row('b')?.tabIndex).toBe(0);
    expect(controller.row('b')?.active).toBe(true);
  });

  it('sanitizes DOM identity tokens', () => {
    const model = createDataTableInteractionModel<Row>({
      rowId: (row) => row.id,
      columns: [{ id: 'name', label: 'Ad', value: (row) => row.name }],
    });
    model.setRows([{ id: 'ankara merkez', name: 'Ankara' }]);
    const controller = createDataTableAccessibilityController({ model, tableId: 'sonuç tablosu' });
    expect(controller.row('ankara merkez')?.id).toBe('sonu-tablosu-row-ankara-merkez');
  });

  it('rejects an unusable table identity', () => {
    const { model } = setup();
    expect(() => createDataTableAccessibilityController({ model, tableId: '   ' })).toThrow(/kimliği boş/);
  });

  it('notifies subscribers immediately and after model changes', () => {
    const { controller, model } = setup();
    const observer = vi.fn();
    const unsubscribe = controller.subscribe(observer);
    expect(observer).toHaveBeenCalledOnce();
    model.nextPage();
    expect(observer).toHaveBeenCalledTimes(2);
    unsubscribe();
    model.previousPage();
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('isolates observer failures through diagnostics', () => {
    const model = createDataTableInteractionModel<Row>({ rowId: (row) => row.id, columns: [] });
    model.setRows(rows);
    const diagnostic = vi.fn();
    const controller = createDataTableAccessibilityController({ model, tableId: 'rows', onObserverError: diagnostic });
    controller.subscribe(() => { throw new Error('observer'); });
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(() => model.setPageSize(2)).not.toThrow();
    expect(diagnostic).toHaveBeenCalledTimes(2);
  });

  it('isolates focus-request failures through diagnostics', () => {
    const model = createDataTableInteractionModel<Row>({ rowId: (row) => row.id, columns: [] });
    model.setRows(rows);
    const diagnostic = vi.fn();
    const controller = createDataTableAccessibilityController({
      model,
      tableId: 'rows',
      onObserverError: diagnostic,
      onFocusRequest: () => { throw new Error('focus'); },
    });
    expect(() => controller.activate('a')).not.toThrow();
    expect(diagnostic).toHaveBeenCalledOnce();
  });

  it('isolates a failing diagnostics reporter', () => {
    const model = createDataTableInteractionModel<Row>({ rowId: (row) => row.id, columns: [] });
    model.setRows(rows);
    const controller = createDataTableAccessibilityController({
      model,
      tableId: 'rows',
      onObserverError: () => { throw new Error('reporter'); },
    });
    expect(() => controller.subscribe(() => { throw new Error('observer'); })).not.toThrow();
  });

  it('stops observing model changes after disposal', () => {
    const { controller, model } = setup();
    const observer = vi.fn();
    controller.subscribe(observer);
    controller.dispose();
    model.nextPage();
    expect(observer).toHaveBeenCalledOnce();
  });

  it('disposes idempotently and rejects later interaction', () => {
    const { controller } = setup();
    controller.dispose();
    controller.dispose();
    expect(() => controller.snapshot()).toThrow(/dispose/);
    expect(() => controller.activate('a')).toThrow(/dispose/);
    expect(() => controller.handleKey(key('ArrowDown').event)).toThrow(/dispose/);
  });

  it('returns null for unknown row identities', () => {
    const { controller } = setup();
    expect(controller.row('missing')).toBeNull();
  });

  it('reflects absolute aria positions on later pages', () => {
    const { controller, model } = setup();
    model.nextPage();
    expect(controller.row('c')).toMatchObject({ ariaPosInSet: 3, ariaSetSize: 3 });
  });

  it('keeps active descendant synchronized through paging activation', () => {
    const { controller } = setup();
    controller.activate('c');
    expect(controller.snapshot()).toMatchObject({ activeDescendant: 'search-results-row-c', pageLabel: '2 / 2' });
  });

  it('reports model announcements through controller facts', () => {
    const { controller, model } = setup();
    controller.toggle('a');
    expect(controller.snapshot().announcement).toBe('1 kayıt seçildi.');
    model.clearSelection();
    expect(controller.snapshot().announcement).toBe('Tablo seçimi temizlendi.');
  });
});
