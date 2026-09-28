import { describe, expect, test, vi } from 'vitest';
import { createDataTableAccessibilityController } from './dataTableAccessibilityController';
import { createDataTableInteractionModel } from './dataTableInteractionModel';

interface Row {
  readonly id: string;
  readonly label: string;
}

const rows: readonly Row[] = [
  { id: 'row-1', label: 'Bir' },
  { id: 'row-2', label: 'İki' },
  { id: 'row-3', label: 'Üç' },
  { id: 'row-4', label: 'Dört' },
  { id: 'row-5', label: 'Beş' },
];

const keyboardEvent = (key: string) => ({
  key,
  preventDefault: vi.fn(),
});

describe('dataTableAccessibilityController keyboard paging', () => {
  test('PageDown moves to the next page and establishes a visible active row', () => {
    const model = createDataTableInteractionModel<Row>({
      rowId: (row) => row.id,
      columns: [{ id: 'label', label: 'Etiket', value: (row) => row.label }],
      pageSize: 2,
    });
    model.setRows(rows);
    model.setActive('row-1');
    const focus = vi.fn();
    const controller = createDataTableAccessibilityController({
      model,
      tableId: 'example-table',
      onFocusRequest: focus,
    });

    const event = keyboardEvent('PageDown');
    expect(controller.handleKey(event)).toBe('next-page');

    const snapshot = model.snapshot();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(snapshot.pageIndex).toBe(1);
    expect(snapshot.rows.map((row) => row.id)).toEqual(['row-3', 'row-4']);
    expect(snapshot.activeRowId).toBe('row-3');
    expect(controller.row('row-3')).toMatchObject({ active: true, tabIndex: 0 });
    expect(controller.row('row-4')).toMatchObject({ active: false, tabIndex: -1 });
    expect(focus).toHaveBeenLastCalledWith('example-table-row-row-3');

    controller.dispose();
    model.dispose();
  });

  test('PageUp restores a visible active row on the previous page', () => {
    const model = createDataTableInteractionModel<Row>({
      rowId: (row) => row.id,
      columns: [{ id: 'label', label: 'Etiket', value: (row) => row.label }],
      pageSize: 2,
    });
    model.setRows(rows);
    model.setPage(2);
    model.setActive('row-5');
    const focus = vi.fn();
    const controller = createDataTableAccessibilityController({
      model,
      tableId: 'example-table',
      onFocusRequest: focus,
    });

    const event = keyboardEvent('PageUp');
    expect(controller.handleKey(event)).toBe('previous-page');

    const snapshot = model.snapshot();
    expect(snapshot.pageIndex).toBe(1);
    expect(snapshot.rows.map((row) => row.id)).toEqual(['row-3', 'row-4']);
    expect(snapshot.activeRowId).toBe('row-3');
    expect(controller.row('row-3')?.tabIndex).toBe(0);
    expect(focus).toHaveBeenLastCalledWith('example-table-row-row-3');

    controller.dispose();
    model.dispose();
  });

  test('does not emit a focus request when paging is unavailable', () => {
    const model = createDataTableInteractionModel<Row>({
      rowId: (row) => row.id,
      columns: [{ id: 'label', label: 'Etiket', value: (row) => row.label }],
      pageSize: 10,
    });
    model.setRows(rows.slice(0, 2));
    model.setActive('row-1');
    const focus = vi.fn();
    const controller = createDataTableAccessibilityController({
      model,
      tableId: 'example-table',
      onFocusRequest: focus,
    });

    const event = keyboardEvent('PageDown');
    expect(controller.handleKey(event)).toBe('next-page');
    expect(model.snapshot().pageIndex).toBe(0);
    expect(model.snapshot().activeRowId).toBe('row-1');
    expect(focus).not.toHaveBeenCalled();

    controller.dispose();
    model.dispose();
  });
});
