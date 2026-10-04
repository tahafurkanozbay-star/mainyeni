import { describe, expect, it } from 'vitest';
import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';
import type { WorkspaceTableSnapshot } from './ArcGisResultWorkspaceTableExperiencePolicy';
import {
  applyArcGisResultWorkspaceViewportIntent,
  createArcGisResultWorkspaceViewportExperience,
  getArcGisResultWorkspaceViewportOffsets,
  getArcGisResultWorkspaceViewportRowIds,
} from './ArcGisResultWorkspaceViewportExperiencePolicy';

const rowIds = Array.from({ length: 100 }, (_, index) => `row-${index}`);

const workspace = (overrides: Partial<ResultWorkspaceSnapshot> = {}): ResultWorkspaceSnapshot => ({
  model: {
    status: 'ready',
    heading: 'Sonuçlar',
  },
  interaction: {
    resultIds: rowIds,
    selectedIds: [],
    focusedId: 'row-0',
  },
  modality: 'keyboard',
  accessibility: {
    minimumTargetSize: 44,
    reducedMotion: false,
  },
  ...overrides,
} as ResultWorkspaceSnapshot);

const table = (ids: readonly string[] = rowIds): WorkspaceTableSnapshot => ({
  columns: [],
  rowIds: ids,
  selectedIds: [],
  focus: { rowIndex: 0, columnIndex: 0, inHeader: false },
  sort: { columnKey: null, direction: 'none' },
  selectionMode: 'multiple',
  accessibility: {
    role: 'grid',
    rowCount: ids.length,
    columnCount: 0,
    ariaMultiSelectable: true,
    ariaBusy: false,
    ariaLabel: 'Sonuçlar',
    keyboardHint: '',
    focusVisible: true,
    minimumTargetSize: 44,
  },
  revision: 0,
});

describe('ArcGisResultWorkspaceViewportExperiencePolicy', () => {
  it('creates a bounded initial render window', () => {
    const snapshot = createArcGisResultWorkspaceViewportExperience(workspace(), table(), {
      viewportHeight: 260,
      rowHeight: 52,
      overscanRows: 2,
    });
    expect(snapshot.range.visibleStartIndex).toBe(0);
    expect(snapshot.range.visibleEndIndex).toBe(4);
    expect(snapshot.range.startIndex).toBe(0);
    expect(snapshot.range.endIndex).toBe(6);
    expect(snapshot.range.count).toBe(7);
  });

  it('accounts for sticky header height when calculating visible rows', () => {
    const snapshot = createArcGisResultWorkspaceViewportExperience(workspace(), table(), {
      viewportHeight: 300,
      stickyHeaderHeight: 40,
      rowHeight: 52,
      overscanRows: 0,
    });
    expect(snapshot.range.visibleEndIndex).toBe(4);
  });

  it('clamps adversarial viewport dimensions and row heights', () => {
    const tiny = createArcGisResultWorkspaceViewportExperience(workspace(), table(), {
      viewportHeight: -Infinity,
      rowHeight: -200,
      stickyHeaderHeight: 9_999,
      overscanRows: 999,
    });
    expect(tiny.viewportHeight).toBe(480);
    expect(tiny.rowHeight).toBe(32);
    expect(tiny.stickyHeaderHeight).toBe(256);
    expect(tiny.overscanRows).toBe(24);

    const huge = createArcGisResultWorkspaceViewportExperience(workspace(), table(), {
      viewportHeight: 999_999,
      rowHeight: 999_999,
    });
    expect(huge.viewportHeight).toBe(16_384);
    expect(huge.rowHeight).toBe(160);
  });

  it('deduplicates and bounds row inventory', () => {
    const ids = Array.from({ length: 21_000 }, (_, index) => index === 1 ? 'row-0' : `row-${index}`);
    const snapshot = createArcGisResultWorkspaceViewportExperience(workspace(), table(ids), { viewportHeight: 300 });
    expect(snapshot.rowIds.length).toBe(20_000);
    expect(snapshot.rowIds.filter((id) => id === 'row-0')).toHaveLength(1);
  });

  it('sanitizes empty and control-character identifiers', () => {
    const snapshot = createArcGisResultWorkspaceViewportExperience(workspace(), table(['', '\u0000', ' good ', 'good']), { viewportHeight: 300 });
    expect(snapshot.rowIds).toEqual(['good']);
  });

  it('clamps initial scroll position to content bounds', () => {
    const snapshot = createArcGisResultWorkspaceViewportExperience(workspace(), table(), {
      viewportHeight: 260,
      rowHeight: 52,
      scrollTop: 999_999,
    });
    expect(snapshot.scrollTop).toBe(snapshot.maximumScrollTop);
    expect(snapshot.range.visibleEndIndex).toBe(99);
  });

  it('normalizes non-finite initial scroll position', () => {
    const snapshot = createArcGisResultWorkspaceViewportExperience(workspace(), table(), {
      viewportHeight: 260,
      scrollTop: Number.NaN,
    });
    expect(snapshot.scrollTop).toBe(0);
  });

  it('inherits workspace loading and accessibility preferences', () => {
    const snapshot = createArcGisResultWorkspaceViewportExperience(workspace({
      model: { status: 'loading', heading: 'Yükleniyor' },
      accessibility: { minimumTargetSize: 48, reducedMotion: true },
    } as Partial<ResultWorkspaceSnapshot>), table(), { viewportHeight: 260 });
    expect(snapshot.accessibility.busy).toBe(true);
    expect(snapshot.accessibility.minimumTargetSize).toBe(48);
    expect(snapshot.accessibility.reducedMotion).toBe(true);
  });

  it('announces the visible ordinal range', () => {
    const snapshot = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 104, rowHeight: 52, overscanRows: 0 });
    expect(snapshot.accessibility.announcement).toBe('1-2 arası sonuçlar gösteriliyor. Toplam 100 sonuç.');
  });

  it('announces an empty collection', () => {
    const snapshot = createArcGisResultWorkspaceViewportExperience(workspace(), table([]), { viewportHeight: 200 });
    expect(snapshot.accessibility.announcement).toBe('Gösterilecek sonuç yok.');
    expect(snapshot.range.count).toBe(0);
    expect(snapshot.range.endIndex).toBe(-1);
  });

  it('scrolls deterministically and updates render range', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260, rowHeight: 52, overscanRows: 1 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'scroll', scrollTop: 520 });
    expect(result.reason).toBe('scroll');
    expect(result.scrollRequired).toBe(true);
    expect(result.next.range.visibleStartIndex).toBe(10);
    expect(result.next.range.startIndex).toBe(9);
  });

  it('does not request scrolling when normalized position is unchanged', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'scroll', scrollTop: 0 });
    expect(result.scrollRequired).toBe(false);
  });

  it('clamps negative scroll attempts', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260, scrollTop: 520 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'scroll', scrollTop: -999 });
    expect(result.next.scrollTop).toBe(0);
  });

  it('preserves scroll on non-finite scroll intents', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260, scrollTop: 520 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'scroll', scrollTop: Number.NaN });
    expect(result.next.scrollTop).toBe(520);
  });

  it('resizes and clamps scroll when viewport grows', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 104, rowHeight: 52, scrollTop: 5_000 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'resize', viewportHeight: 5_000 });
    expect(result.reason).toBe('resize');
    expect(result.next.viewportHeight).toBe(5_000);
    expect(result.next.scrollTop).toBeLessThanOrEqual(result.next.maximumScrollTop);
  });

  it('focuses an already-visible row without moving scroll', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260, rowHeight: 52 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'focus-row', rowId: 'row-3' });
    expect(result.next.focusedRowId).toBe('row-3');
    expect(result.next.scrollTop).toBe(0);
    expect(result.scrollRequired).toBe(false);
  });

  it('scrolls the nearest edge to reveal a row below viewport', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260, rowHeight: 52 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'focus-row', rowId: 'row-10' });
    expect(result.next.scrollTop).toBe(312);
    expect(result.next.focusedRowId).toBe('row-10');
  });

  it('supports start focus alignment', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260, rowHeight: 52 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'focus-row', rowId: 'row-10', alignment: 'start' });
    expect(result.next.scrollTop).toBe(520);
  });

  it('supports center focus alignment', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260, rowHeight: 52 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'focus-row', rowId: 'row-10', alignment: 'center' });
    expect(result.next.scrollTop).toBe(416);
  });

  it('supports end focus alignment', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260, rowHeight: 52 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'focus-row', rowId: 'row-10', alignment: 'end' });
    expect(result.next.scrollTop).toBe(312);
  });

  it('ignores focus requests for absent rows', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'focus-row', rowId: 'missing' });
    expect(result.next.focusedRowId).toBe('row-0');
    expect(result.next.scrollTop).toBe(0);
  });

  it('reconciles while preserving a surviving focus anchor', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260, rowHeight: 52 });
    const focused = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'focus-row', rowId: 'row-20', alignment: 'start' }).next;
    const ids = ['new-0', 'row-20', 'new-1'];
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), focused, { type: 'reconcile', rowIds: ids });
    expect(result.next.focusedRowId).toBe('row-20');
    expect(result.next.anchorRowId).toBe('row-20');
    expect(result.next.scrollTop).toBe(0);
  });

  it('drops stale focus and anchor on reconciliation', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'reconcile', rowIds: ['new-a', 'new-b'] });
    expect(result.next.focusedRowId).toBeNull();
    expect(result.next.anchorRowId).toBeNull();
  });

  it('deduplicates reconciled inventories', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260 });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'reconcile', rowIds: ['a', 'a', 'b', '', 'b'] });
    expect(result.next.rowIds).toEqual(['a', 'b']);
  });

  it('keeps an anchor stable when row height changes', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260, rowHeight: 52 });
    const focused = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'focus-row', rowId: 'row-20', alignment: 'start' }).next;
    const resized = applyArcGisResultWorkspaceViewportIntent(workspace(), focused, { type: 'set-row-height', rowHeight: 64 });
    expect(resized.next.rowHeight).toBe(64);
    expect(resized.next.scrollTop).toBe(20 * 64);
  });

  it('clamps row-height intents', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260 });
    expect(applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'set-row-height', rowHeight: 1 }).next.rowHeight).toBe(32);
    expect(applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'set-row-height', rowHeight: 999 }).next.rowHeight).toBe(160);
  });

  it('returns only the overscanned render inventory', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 104, rowHeight: 52, overscanRows: 1, scrollTop: 520 });
    const rendered = getArcGisResultWorkspaceViewportRowIds(initial);
    expect(rendered).toEqual(['row-9', 'row-10', 'row-11', 'row-12']);
  });

  it('returns no rendered ids for an empty collection', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table([]), { viewportHeight: 104 });
    expect(getArcGisResultWorkspaceViewportRowIds(initial)).toEqual([]);
  });

  it('calculates spacer offsets without retaining row payloads', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 104, rowHeight: 52, overscanRows: 1, scrollTop: 520 });
    const offsets = getArcGisResultWorkspaceViewportOffsets(initial);
    expect(offsets.before).toBe(9 * 52);
    expect(offsets.total).toBe(100 * 52);
    expect(offsets.after).toBe(offsets.total - offsets.before - 4 * 52);
  });

  it('returns zero offsets for empty inventory', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table([]), { viewportHeight: 104 });
    expect(getArcGisResultWorkspaceViewportOffsets(initial)).toEqual({ before: 0, after: 0, total: 0 });
  });

  it('increments revision for every governed transition', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260 });
    const first = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'scroll', scrollTop: 100 }).next;
    const second = applyArcGisResultWorkspaceViewportIntent(workspace(), first, { type: 'resize', viewportHeight: 300 }).next;
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
  });

  it('never renders more than viewport rows plus bounded overscan', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(Array.from({ length: 20_000 }, (_, index) => `id-${index}`)), {
      viewportHeight: 520,
      rowHeight: 52,
      overscanRows: 24,
      scrollTop: 400_000,
    });
    expect(initial.range.count).toBeLessThanOrEqual(10 + 48);
  });

  it('keeps visible range inside inventory near the final row', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), {
      viewportHeight: 260,
      rowHeight: 52,
      overscanRows: 4,
      scrollTop: 99_999,
    });
    expect(initial.range.visibleEndIndex).toBe(99);
    expect(initial.range.endIndex).toBe(99);
    expect(initial.range.startIndex).toBeGreaterThanOrEqual(0);
  });

  it('accounts for sticky header when aligning focused rows', () => {
    const initial = createArcGisResultWorkspaceViewportExperience(workspace(), table(), {
      viewportHeight: 300,
      stickyHeaderHeight: 40,
      rowHeight: 52,
    });
    const result = applyArcGisResultWorkspaceViewportIntent(workspace(), initial, { type: 'focus-row', rowId: 'row-10', alignment: 'end' });
    expect(result.next.scrollTop).toBe(312);
  });
});
