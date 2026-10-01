import { describe, expect, it } from 'vitest';
import {
  createArcGisResultTableExperienceModel,
  resolveNextResultTableRowIndex,
  resolveResultTableKeyboardIntent,
  type ResultTableColumnInput,
} from './ArcGisResultTableExperiencePolicy';

const columns: readonly ResultTableColumnInput[] = [
  { id: 'title', label: 'Başlık', pinned: true, sortable: true, priority: 0, minimumWidth: 120, preferredWidth: 220 },
  { id: 'category', label: 'Kategori', sortable: true, priority: 1, minimumWidth: 100, preferredWidth: 160 },
  { id: 'district', label: 'İlçe', sortable: true, priority: 2, minimumWidth: 100, preferredWidth: 140 },
  { id: 'address', label: 'Adres', priority: 3, minimumWidth: 140, preferredWidth: 260 },
  { id: 'status', label: 'Durum', priority: 4, minimumWidth: 90, preferredWidth: 110 },
  { id: 'updated', label: 'Güncelleme', priority: 5, minimumWidth: 120, preferredWidth: 160 },
  { id: 'owner', label: 'Sorumlu', priority: 6, minimumWidth: 100, preferredWidth: 140 },
];

const rows = [
  { key: '1', selected: true, cells: { title: 'Atatürk Parkı', category: 'Park', district: 'Çankaya', address: 'Merkez', status: true } },
  { key: '2', cells: { title: 'Gençlik Parkı', category: 'Park', district: 'Altındağ', address: 'Ulus', status: false } },
] as const;

describe('createArcGisResultTableExperienceModel', () => {
  it('keeps a pinned identity column visible on narrow phones', () => {
    const model = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 390, availableWidth: 340 });
    expect(model.viewport).toBe('phone');
    expect(model.columns[0].id).toBe('title');
    expect(model.columns.length).toBeLessThanOrEqual(3);
    expect(model.hiddenColumnIds.length).toBeGreaterThan(0);
    expect(model.announcement).toContain('sütun gizlendi');
  });

  it('allows a richer projection on tablets without exceeding the column budget', () => {
    const model = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 820, availableWidth: 760 });
    expect(model.viewport).toBe('tablet');
    expect(model.columns.length).toBeLessThanOrEqual(6);
    expect(model.columns.some((column) => column.id === 'title')).toBe(true);
  });

  it('exposes all fitting columns on desktop', () => {
    const model = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 1440, availableWidth: 1400 });
    expect(model.viewport).toBe('desktop');
    expect(model.columns.length).toBe(columns.length);
    expect(model.hiddenColumnIds).toEqual([]);
  });

  it('deduplicates malformed column identities and rejects empty labels', () => {
    const model = createArcGisResultTableExperienceModel({
      columns: [
        { id: 'title', label: 'Başlık', pinned: true },
        { id: ' title ', label: 'Tekrar' },
        { id: 'empty', label: '   ' },
        { id: '', label: 'Kimliksiz' },
      ],
      rows,
      viewportWidth: 1200,
    });
    expect(model.columns.map((column) => column.id)).toEqual(['title']);
  });

  it('bounds hostile column cardinality', () => {
    const hostile = Array.from({ length: 200 }, (_, index) => ({ id: `c-${index}`, label: `Kolon ${index}` }));
    const model = createArcGisResultTableExperienceModel({ columns: hostile, rows: [], viewportWidth: 4000, availableWidth: 100000 });
    expect(model.columns.length).toBeLessThanOrEqual(32);
  });

  it('bounds hostile row cardinality and preserves deterministic row indices', () => {
    const hostileRows = Array.from({ length: 1000 }, (_, index) => ({ key: `row-${index}`, cells: { title: index } }));
    const model = createArcGisResultTableExperienceModel({ columns, rows: hostileRows, viewportWidth: 1400, availableWidth: 1200, totalCount: 5000 });
    expect(model.rows).toHaveLength(500);
    expect(model.rows[0].rowIndex).toBe(2);
    expect(model.rows[499].rowIndex).toBe(501);
    expect(model.rows[499].setSize).toBe(5000);
  });

  it('deduplicates rows by normalized key', () => {
    const model = createArcGisResultTableExperienceModel({
      columns,
      rows: [
        { key: '42', cells: { title: 'Bir' } },
        { key: ' 42 ', cells: { title: 'İki' } },
      ],
      viewportWidth: 1200,
    });
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].cells[0].text).toBe('Bir');
  });

  it('tracks the active row without inventing focus for a stale key', () => {
    const active = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 1200, activeRowKey: '2' });
    expect(active.activeRowIndex).toBe(1);
    expect(active.rows[1].active).toBe(true);
    const stale = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 1200, activeRowKey: 'missing' });
    expect(stale.activeRowIndex).toBeNull();
    expect(stale.rows.every((row) => !row.active)).toBe(true);
  });

  it('preserves selection as presentation state', () => {
    const model = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 1200 });
    expect(model.rows[0].selected).toBe(true);
    expect(model.rows[1].selected).toBe(false);
  });

  it('normalizes page positions for screen readers', () => {
    const model = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 1200, totalCount: 120, pageOffset: 50 });
    expect(model.rows[0].positionInSet).toBe(51);
    expect(model.rows[1].positionInSet).toBe(52);
    expect(model.rows[0].setSize).toBe(120);
  });

  it('clamps impossible page offsets', () => {
    const model = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 1200, totalCount: 2, pageOffset: 99999 });
    expect(model.rows[0].positionInSet).toBe(2);
    expect(model.rows[1].positionInSet).toBe(2);
  });

  it('maps sortable state only to an allowed sortable column', () => {
    const sorted = createArcGisResultTableExperienceModel({
      columns,
      rows,
      viewportWidth: 1400,
      availableWidth: 1400,
      sort: { columnId: 'category', direction: 'descending' },
    });
    expect(sorted.columns.find((column) => column.id === 'category')?.ariaSort).toBe('descending');
    expect(sorted.columns.find((column) => column.id === 'title')?.ariaSort).toBe('none');
    const denied = createArcGisResultTableExperienceModel({
      columns,
      rows,
      viewportWidth: 1400,
      availableWidth: 1400,
      sort: { columnId: 'address', direction: 'ascending' },
    });
    expect(denied.columns.every((column) => column.ariaSort === 'none')).toBe(true);
  });

  it('does not expose sort state for a hidden column', () => {
    const model = createArcGisResultTableExperienceModel({
      columns,
      rows,
      viewportWidth: 390,
      availableWidth: 250,
      sort: { columnId: 'district', direction: 'ascending' },
    });
    expect(model.columns.every((column) => column.id !== 'district' || column.ariaSort === 'ascending')).toBe(true);
  });

  it('uses bounded readable fallbacks for missing and non-finite cell values', () => {
    const model = createArcGisResultTableExperienceModel({
      columns: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      rows: [{ key: '1', cells: { a: null, b: Number.NaN, c: false } }],
      viewportWidth: 1200,
    });
    expect(model.rows[0].cells.map((cell) => cell.text)).toEqual(['—', '—', 'Hayır']);
  });

  it('truncates hostile cell content instead of exposing unbounded text', () => {
    const model = createArcGisResultTableExperienceModel({
      columns: [{ id: 'title', label: 'Başlık' }],
      rows: [{ key: '1', cells: { title: 'x'.repeat(10000) } }],
      viewportWidth: 1200,
    });
    expect(model.rows[0].cells[0].text.length).toBeLessThanOrEqual(180);
    expect(model.rows[0].cells[0].text.endsWith('…')).toBe(true);
  });

  it('keeps boolean presentation localized', () => {
    const model = createArcGisResultTableExperienceModel({
      columns: [{ id: 'active', label: 'Aktif' }],
      rows: [{ key: '1', cells: { active: true } }, { key: '2', cells: { active: false } }],
      viewportWidth: 1200,
    });
    expect(model.rows[0].cells[0].text).toBe('Evet');
    expect(model.rows[1].cells[0].text).toBe('Hayır');
  });

  it('uses semantic header offset for aria row indices', () => {
    const model = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 1200 });
    expect(model.rows[0].cells.every((cell) => cell.rowIndex === 2)).toBe(true);
    expect(model.rows[1].cells.every((cell) => cell.rowIndex === 3)).toBe(true);
    expect(model.columns.map((column) => column.columnIndex)).toEqual(model.columns.map((_, index) => index + 1));
  });

  it('reports empty tables without misleading result counts', () => {
    const model = createArcGisResultTableExperienceModel({ columns, rows: [], viewportWidth: 1200, totalCount: 0 });
    expect(model.announcement).toBe('Tabloda gösterilecek sonuç yok.');
    expect(model.activeRowIndex).toBeNull();
  });

  it('reports responsive column reduction to assistive technology', () => {
    const model = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 390, availableWidth: 240, totalCount: 10 });
    expect(model.announcement).toContain('10 sonuçtan 2 satır');
    expect(model.announcement).toContain('sütun gizlendi');
  });

  it('keeps table labels stable and concise', () => {
    const model = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 1200 });
    expect(model.tableLabel).toBe('Harita sonuçları tablosu');
    expect(model.tableLabel.length).toBeLessThan(80);
  });

  it('never allocates widths below normalized minimums', () => {
    const model = createArcGisResultTableExperienceModel({
      columns: [{ id: 'title', label: 'Başlık', pinned: true, minimumWidth: -500, preferredWidth: -20 }],
      rows,
      viewportWidth: 100,
      availableWidth: 10,
    });
    expect(model.columns[0].width).toBeGreaterThanOrEqual(88);
    expect(model.horizontalOverflow).toBe(true);
  });

  it('caps extreme preferred widths', () => {
    const model = createArcGisResultTableExperienceModel({
      columns: [{ id: 'title', label: 'Başlık', preferredWidth: 999999 }],
      rows,
      viewportWidth: 2000,
      availableWidth: 2000,
    });
    expect(model.columns[0].width).toBeLessThanOrEqual(420);
  });

  it('returns frozen top-level presentation collections', () => {
    const model = createArcGisResultTableExperienceModel({ columns, rows, viewportWidth: 1200 });
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.columns)).toBe(true);
    expect(Object.isFrozen(model.rows)).toBe(true);
    expect(Object.isFrozen(model.hiddenColumnIds)).toBe(true);
  });
});

describe('result table keyboard governance', () => {
  it('maps vertical arrows to bounded row movement', () => {
    expect(resolveResultTableKeyboardIntent('ArrowDown')).toEqual({ type: 'row', delta: 1 });
    expect(resolveResultTableKeyboardIntent('ArrowUp')).toEqual({ type: 'row', delta: -1 });
    expect(resolveNextResultTableRowIndex(0, 3, { type: 'row', delta: -1 })).toBe(0);
    expect(resolveNextResultTableRowIndex(2, 3, { type: 'row', delta: 1 })).toBe(2);
  });

  it('maps Home and End to row boundaries by default', () => {
    expect(resolveResultTableKeyboardIntent('Home')).toEqual({ type: 'first-row' });
    expect(resolveResultTableKeyboardIntent('End')).toEqual({ type: 'last-row' });
    expect(resolveNextResultTableRowIndex(2, 5, { type: 'first-row' })).toBe(0);
    expect(resolveNextResultTableRowIndex(0, 5, { type: 'last-row' })).toBe(4);
  });

  it('reserves Shift+Home and Shift+End for column boundaries', () => {
    expect(resolveResultTableKeyboardIntent('Home', true)).toEqual({ type: 'first-column' });
    expect(resolveResultTableKeyboardIntent('End', true)).toEqual({ type: 'last-column' });
  });

  it('separates activation from selection toggling', () => {
    expect(resolveResultTableKeyboardIntent('Enter')).toEqual({ type: 'activate' });
    expect(resolveResultTableKeyboardIntent(' ')).toEqual({ type: 'toggle-selection' });
  });

  it('ignores browser and text-editing keys it does not own', () => {
    expect(resolveResultTableKeyboardIntent('Tab')).toBeNull();
    expect(resolveResultTableKeyboardIntent('Escape')).toBeNull();
    expect(resolveResultTableKeyboardIntent('ArrowLeft')).toBeNull();
  });

  it('returns null for row movement in an empty table', () => {
    expect(resolveNextResultTableRowIndex(0, 0, { type: 'row', delta: 1 })).toBeNull();
  });

  it('clamps hostile current indices before movement', () => {
    expect(resolveNextResultTableRowIndex(-999, 4, { type: 'row', delta: 1 })).toBe(1);
    expect(resolveNextResultTableRowIndex(999, 4, { type: 'row', delta: -1 })).toBe(2);
  });
});
