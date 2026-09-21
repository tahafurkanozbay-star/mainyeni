import { createDataGridRuntime, type DataGridColumn } from "./dataGridRuntime";

interface Row {
  id: string;
  name: string;
  district: string;
  score: number;
  updatedAt: Date;
}

const rows: readonly Row[] = Object.freeze([
  { id: "r1", name: "Anıtkabir", district: "Çankaya", score: 90, updatedAt: new Date("2026-01-05") },
  { id: "r2", name: "Ankara Kalesi", district: "Altındağ", score: 75, updatedAt: new Date("2026-01-02") },
  { id: "r3", name: "Atatürk Orman Çiftliği", district: "Yenimahalle", score: 82, updatedAt: new Date("2026-01-03") },
  { id: "r4", name: "Kuğulu Park", district: "Çankaya", score: 65, updatedAt: new Date("2026-01-04") },
  { id: "r5", name: "Roma Hamamı", district: "Altındağ", score: 70, updatedAt: new Date("2026-01-01") },
]);

const columns: readonly DataGridColumn<Row>[] = Object.freeze([
  { id: "name", label: "Ad", getValue: (row) => row.name, sortable: true },
  { id: "district", label: "İlçe", getValue: (row) => row.district, sortable: true },
  { id: "score", label: "Puan", getValue: (row) => row.score, sortable: true, align: "end" },
  { id: "updatedAt", label: "Güncelleme", getValue: (row) => row.updatedAt, sortable: true },
]);

const runtime = (overrides: Partial<Parameters<typeof createDataGridRuntime<Row>>[0]> = {}) =>
  createDataGridRuntime<Row>({
    rows,
    columns,
    getRowId: (row) => row.id,
    selectionMode: "multiple",
    pageSize: 3,
    initialViewport: { height: 88, rowHeight: 44, overscan: 0 },
    ...overrides,
  });

describe("DataGridRuntime", () => {
  test("requires at least one column", () => {
    expect(() => createDataGridRuntime<Row>({
      rows,
      columns: [],
      getRowId: (row) => row.id,
    })).toThrow(/en az bir kolon/);
  });

  test("rejects empty column ids", () => {
    expect(() => createDataGridRuntime<Row>({
      rows,
      columns: [{ id: " ", label: "X", getValue: () => "" }],
      getRowId: (row) => row.id,
    })).toThrow(/id alanı boş/);
  });

  test("rejects duplicate column ids", () => {
    expect(() => createDataGridRuntime<Row>({
      rows,
      columns: [
        { id: "name", label: "Ad", getValue: (row) => row.name },
        { id: "name", label: "Ad 2", getValue: (row) => row.name },
      ],
      getRowId: (row) => row.id,
    })).toThrow(/benzersiz/);
  });

  test("builds a paged immutable snapshot", () => {
    const grid = runtime();
    expect(grid.snapshot.rowCount).toBe(5);
    expect(grid.snapshot.pageCount).toBe(2);
    expect(grid.snapshot.rows.map((row) => row.id)).toEqual(["r1", "r2", "r3"]);
    expect(grid.snapshot.visibleRows.map((row) => row.id)).toEqual(["r1", "r2"]);
    expect(grid.snapshot.visibleRange).toEqual({
      start: 0,
      end: 2,
      offsetTop: 0,
      totalHeight: 132,
    });
    expect(Object.isFrozen(grid.snapshot)).toBe(true);
    grid.dispose();
  });

  test("keeps stable sort order for equal values", () => {
    const grid = runtime();
    grid.setSort({ columnId: "district", direction: "asc" });
    expect(grid.snapshot.rows.map((row) => row.id)).toEqual(["r2", "r1", "r4"]);
    grid.dispose();
  });

  test("sorts numeric values descending", () => {
    const grid = runtime();
    grid.setSort({ columnId: "score", direction: "desc" });
    expect(grid.snapshot.rows.map((row) => row.id)).toEqual(["r1", "r3", "r2"]);
    grid.dispose();
  });

  test("sorts Date values", () => {
    const grid = runtime();
    grid.setSort({ columnId: "updatedAt", direction: "asc" });
    expect(grid.snapshot.rows.map((row) => row.id)).toEqual(["r5", "r2", "r3"]);
    grid.dispose();
  });

  test("ignores sort requests for non-sortable columns", () => {
    const grid = runtime({
      columns: [{ id: "name", label: "Ad", getValue: (row) => row.name }],
    });
    grid.setSort({ columnId: "name", direction: "asc" });
    expect(grid.snapshot.sort).toBeNull();
    grid.dispose();
  });

  test("cycles sortable columns asc desc none", () => {
    const grid = runtime();
    grid.toggleSort("name");
    expect(grid.snapshot.sort).toEqual({ columnId: "name", direction: "asc" });
    grid.toggleSort("name");
    expect(grid.snapshot.sort).toEqual({ columnId: "name", direction: "desc" });
    grid.toggleSort("name");
    expect(grid.snapshot.sort).toBeNull();
    grid.dispose();
  });

  test("resets page when sort changes", () => {
    const grid = runtime();
    grid.setPage(1);
    expect(grid.snapshot.page).toBe(1);
    grid.setSort({ columnId: "score", direction: "desc" });
    expect(grid.snapshot.page).toBe(0);
    grid.dispose();
  });

  test("clamps requested page to page count", () => {
    const grid = runtime();
    grid.setPage(99);
    expect(grid.snapshot.page).toBe(1);
    expect(grid.snapshot.rows.map((row) => row.id)).toEqual(["r4", "r5"]);
    grid.dispose();
  });

  test("preserves approximate absolute position when page size changes", () => {
    const grid = runtime({ pageSize: 2 });
    grid.setPage(2);
    expect(grid.snapshot.rows.map((row) => row.id)).toEqual(["r5"]);
    grid.setPageSize(3);
    expect(grid.snapshot.page).toBe(1);
    expect(grid.snapshot.rows.map((row) => row.id)).toEqual(["r4", "r5"]);
    grid.dispose();
  });

  test("normalizes page size to safe bounds", () => {
    const grid = runtime({ pageSize: 10_000 });
    expect(grid.snapshot.pageSize).toBe(500);
    grid.setPageSize(0);
    expect(grid.snapshot.pageSize).toBe(50);
    grid.dispose();
  });

  test("supports single selection", () => {
    const grid = runtime({ selectionMode: "single" });
    grid.selectRow("r1");
    grid.selectRow("r2");
    expect(grid.snapshot.selectedIds).toEqual(["r2"]);
    grid.dispose();
  });

  test("supports additive multiple selection", () => {
    const grid = runtime();
    grid.selectRow("r1");
    grid.selectRow("r2", true, true);
    expect(grid.snapshot.selectedIds).toEqual(["r1", "r2"]);
    grid.dispose();
  });

  test("non-additive selection replaces multiple selection", () => {
    const grid = runtime();
    grid.selectRow("r1");
    grid.selectRow("r2", true, true);
    grid.selectRow("r3", true, false);
    expect(grid.snapshot.selectedIds).toEqual(["r3"]);
    grid.dispose();
  });

  test("can deselect and clear", () => {
    const grid = runtime();
    grid.selectRow("r1");
    grid.selectRow("r2", true, true);
    grid.selectRow("r1", false);
    expect(grid.snapshot.selectedIds).toEqual(["r2"]);
    grid.clearSelection();
    expect(grid.snapshot.selectedIds).toEqual([]);
    grid.dispose();
  });

  test("ignores unknown row ids", () => {
    const grid = runtime();
    const before = grid.snapshot.revision;
    grid.selectRow("missing");
    expect(grid.snapshot.revision).toBe(before);
    grid.dispose();
  });

  test("none selection mode never stores selection", () => {
    const grid = runtime({ selectionMode: "none", initialSelectedIds: ["r1"] });
    grid.selectRow("r2");
    expect(grid.snapshot.selectedIds).toEqual([]);
    grid.dispose();
  });

  test("reconciles selected ids when rows change", () => {
    const grid = runtime({ initialSelectedIds: ["r1", "r2"] });
    grid.setRows(rows.filter((row) => row.id !== "r1"));
    expect(grid.snapshot.selectedIds).toEqual(["r2"]);
    grid.dispose();
  });

  test("initializes active cell at first row and column", () => {
    const grid = runtime();
    expect(grid.snapshot.activeCell).toEqual({ rowId: "r1", columnId: "name" });
    grid.dispose();
  });

  test("moves active cell with arrow keys", () => {
    const grid = runtime();
    expect(grid.handleKey("ArrowDown").activeCell).toEqual({ rowId: "r2", columnId: "name" });
    expect(grid.handleKey("ArrowRight").activeCell).toEqual({ rowId: "r2", columnId: "district" });
    expect(grid.handleKey("ArrowUp").activeCell).toEqual({ rowId: "r1", columnId: "district" });
    grid.dispose();
  });

  test("clamps keyboard navigation at edges", () => {
    const grid = runtime();
    grid.handleKey("ArrowUp");
    grid.handleKey("ArrowLeft");
    expect(grid.snapshot.activeCell).toEqual({ rowId: "r1", columnId: "name" });
    grid.handleKey("End", { ctrl: true });
    expect(grid.snapshot.activeCell).toEqual({ rowId: "r3", columnId: "updatedAt" });
    grid.handleKey("ArrowDown");
    grid.handleKey("ArrowRight");
    expect(grid.snapshot.activeCell).toEqual({ rowId: "r3", columnId: "updatedAt" });
    grid.dispose();
  });

  test("supports Home and End within the current row", () => {
    const grid = runtime();
    grid.setActiveCell({ rowId: "r2", columnId: "score" });
    grid.handleKey("Home");
    expect(grid.snapshot.activeCell).toEqual({ rowId: "r2", columnId: "name" });
    grid.handleKey("End");
    expect(grid.snapshot.activeCell).toEqual({ rowId: "r2", columnId: "updatedAt" });
    grid.dispose();
  });

  test("supports PageUp and PageDown using viewport capacity", () => {
    const grid = runtime({ pageSize: 5, initialViewport: { height: 88, rowHeight: 44, overscan: 0 } });
    grid.setActiveCell({ rowId: "r1", columnId: "name" });
    grid.handleKey("PageDown");
    expect(grid.snapshot.activeCell?.rowId).toBe("r3");
    grid.handleKey("PageDown");
    expect(grid.snapshot.activeCell?.rowId).toBe("r5");
    grid.handleKey("PageUp");
    expect(grid.snapshot.activeCell?.rowId).toBe("r3");
    grid.dispose();
  });

  test("Space toggles active row selection", () => {
    const grid = runtime();
    grid.handleKey(" ");
    expect(grid.snapshot.selectedIds).toEqual(["r1"]);
    grid.handleKey(" ");
    expect(grid.snapshot.selectedIds).toEqual([]);
    grid.dispose();
  });

  test("Enter can add selection with modifier", () => {
    const grid = runtime();
    grid.handleKey("Enter");
    grid.handleKey("ArrowDown");
    grid.handleKey("Enter", { ctrl: true });
    expect(grid.snapshot.selectedIds).toEqual(["r1", "r2"]);
    grid.dispose();
  });

  test("returns handled false for unrelated keys", () => {
    const grid = runtime();
    const result = grid.handleKey("F8");
    expect(result.handled).toBe(false);
    expect(grid.snapshot.activeCell).toEqual({ rowId: "r1", columnId: "name" });
    grid.dispose();
  });

  test("moves scroll window when active cell leaves viewport", () => {
    const grid = runtime({ pageSize: 5, initialViewport: { height: 44, rowHeight: 44, overscan: 0 } });
    grid.setActiveCell({ rowId: "r4", columnId: "name" });
    expect(grid.snapshot.visibleRange.start).toBe(3);
    expect(grid.snapshot.visibleRows.map((row) => row.id)).toEqual(["r4"]);
    grid.dispose();
  });

  test("updates virtualization window with scroll position", () => {
    const grid = runtime({ pageSize: 5, initialViewport: { height: 88, rowHeight: 44, overscan: 1 } });
    grid.setViewport({ scrollTop: 88 });
    expect(grid.snapshot.visibleRange.start).toBe(1);
    expect(grid.snapshot.visibleRange.end).toBe(5);
    expect(grid.snapshot.visibleRange.offsetTop).toBe(44);
    grid.dispose();
  });

  test("caps row height and overscan", () => {
    const grid = runtime({ initialViewport: { rowHeight: 500, overscan: 500 } });
    grid.setViewport({ height: 120, scrollTop: 0 });
    expect(grid.snapshot.visibleRange.totalHeight).toBe(360);
    expect(grid.snapshot.visibleRows).toHaveLength(3);
    grid.dispose();
  });

  test("notifies subscribers with revision transitions", () => {
    const grid = runtime();
    const listener = vi.fn();
    grid.subscribe(listener, true);
    grid.setPage(1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]?.[0].revision).toBe(1);
    expect(listener.mock.calls[1]?.[1].revision).toBe(0);
    grid.dispose();
  });

  test("isolates subscriber errors", () => {
    const errors: unknown[] = [];
    const healthy = vi.fn();
    const grid = runtime({ onError: (error) => errors.push(error) });
    grid.subscribe(() => { throw new Error("listener"); });
    grid.subscribe(healthy);
    grid.setPage(1);
    expect(errors).toHaveLength(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    grid.dispose();
  });

  test("reports getRowId failures and remains operational", () => {
    const errors: unknown[] = [];
    const grid = createDataGridRuntime<Row>({
      rows,
      columns,
      getRowId: (row) => {
        if (row.id === "r2") throw new Error("bad id");
        return row.id;
      },
      selectionMode: "multiple",
      onError: (error) => errors.push(error),
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(grid.snapshot.rowCount).toBe(5);
    grid.dispose();
  });

  test("reports accessor failures while preserving stable row order", () => {
    const errors: unknown[] = [];
    const grid = runtime({
      columns: [
        {
          id: "broken",
          label: "Kırık",
          sortable: true,
          getValue: (row) => {
            if (row.id === "r2") throw new Error("accessor");
            return row.name;
          },
        },
      ],
      onError: (error) => errors.push(error),
    });
    grid.setSort({ columnId: "broken", direction: "asc" });
    expect(errors.length).toBeGreaterThan(0);
    expect(grid.snapshot.rows).toHaveLength(3);
    grid.dispose();
  });

  test("reconciles active cell when current row disappears", () => {
    const grid = runtime();
    grid.setActiveCell({ rowId: "r2", columnId: "district" });
    grid.setRows(rows.filter((row) => row.id !== "r2"));
    expect(grid.snapshot.activeCell).toEqual({ rowId: "r1", columnId: "name" });
    grid.dispose();
  });

  test("reconciles active cell when page changes", () => {
    const grid = runtime();
    grid.setActiveCell({ rowId: "r3", columnId: "score" });
    grid.setPage(1);
    expect(grid.snapshot.activeCell).toEqual({ rowId: "r4", columnId: "name" });
    grid.dispose();
  });

  test("dispose clears listeners and blocks mutations", () => {
    const grid = runtime();
    const listener = vi.fn();
    grid.subscribe(listener);
    grid.dispose();
    expect(grid.isDisposed).toBe(true);
    expect(() => grid.setPage(1)).toThrow(/dispose/);
    expect(listener).not.toHaveBeenCalled();
  });
});
