import { describe, expect, it } from 'vitest';
import {
  applyArcGisResultWorkspaceTableIntent,
  createArcGisResultWorkspaceTableExperience,
  type WorkspaceTableTransition,
} from './ArcGisResultWorkspaceTableExperiencePolicy';
import {
  createArcGisResultWorkspaceViewportExperience,
  getArcGisResultWorkspaceViewportRowIds,
} from './ArcGisResultWorkspaceViewportExperiencePolicy';
import {
  coordinateArcGisResultWorkspaceTableViewport,
  getArcGisResultWorkspaceTableViewportFocusState,
} from './ArcGisResultWorkspaceTableViewportExperiencePolicy';
import { createArcGisResultWorkspaceExperience } from './ArcGisResultWorkspaceExperiencePolicy';
import { createArcGisResultExperience } from './ArcGisResultExperiencePolicy';
import { createArcGisResultInteractionExperience } from './ArcGisResultInteractionExperiencePolicy';

const rows = Array.from({ length: 200 }, (_, index) => `row-${index + 1}`);

const workspace = () => {
  const model = createArcGisResultExperience({
    status: 'ready',
    heading: 'Kent rehberi sonuçları',
    resultCount: rows.length,
    page: 1,
    pageSize: 200,
  });
  const interaction = createArcGisResultInteractionExperience(model, {
    resultIds: rows,
    focusedId: rows[0],
    selectedIds: [],
  });
  return createArcGisResultWorkspaceExperience(model, interaction, {
    viewportWidth: 1440,
    viewportHeight: 900,
    pointer: 'fine',
    modality: 'keyboard',
  });
};

const fixture = () => {
  const ws = workspace();
  const table = createArcGisResultWorkspaceTableExperience(ws, [
    { key: 'name', label: 'Ad', sortable: true },
    { key: 'district', label: 'İlçe', sortable: true },
  ]);
  const viewport = createArcGisResultWorkspaceViewportExperience(ws, table, {
    viewportHeight: 260,
    rowHeight: 52,
    stickyHeaderHeight: 52,
    overscanRows: 2,
  });
  return { ws, table, viewport };
};

const transitionToRow = (table: ReturnType<typeof fixture>['table'], rowIndex: number): WorkspaceTableTransition => {
  let current = table;
  let transition = applyArcGisResultWorkspaceTableIntent(current, { type: 'move', rowDelta: rowIndex, columnDelta: 0 });
  current = transition.next;
  return transition;
};

describe('ArcGisResultWorkspaceTableViewportExperiencePolicy', () => {
  it('does not scroll when table focus remains in the visible viewport', () => {
    const { ws, table, viewport } = fixture();
    const tableTransition = transitionToRow(table, 2);
    const coordinated = coordinateArcGisResultWorkspaceTableViewport(ws, viewport, tableTransition);

    expect(coordinated.reason).toBe('focus-visible');
    expect(coordinated.focusedRowId).toBe('row-3');
    expect(coordinated.scrollRequired).toBe(false);
    expect(coordinated.scrollTop).toBe(0);
    expect(coordinated.viewportTransition).toBeNull();
  });

  it('reveals keyboard focus that moves outside the visible viewport', () => {
    const { ws, table, viewport } = fixture();
    const tableTransition = transitionToRow(table, 20);
    const coordinated = coordinateArcGisResultWorkspaceTableViewport(ws, viewport, tableTransition, { announceReveal: true });

    expect(coordinated.reason).toBe('focus-reveal');
    expect(coordinated.focusedRowId).toBe('row-21');
    expect(coordinated.scrollRequired).toBe(true);
    expect(coordinated.scrollTop).toBeGreaterThan(0);
    expect(getArcGisResultWorkspaceViewportRowIds(coordinated.viewport)).toContain('row-21');
    expect(coordinated.announcement).toContain('görünür alana getirildi');
  });

  it('supports explicit center alignment while preserving viewport bounds', () => {
    const { ws, table, viewport } = fixture();
    const tableTransition = transitionToRow(table, 100);
    const coordinated = coordinateArcGisResultWorkspaceTableViewport(ws, viewport, tableTransition, { alignment: 'center' });

    expect(coordinated.reason).toBe('focus-reveal');
    expect(coordinated.scrollTop).toBeGreaterThan(0);
    expect(coordinated.scrollTop).toBeLessThanOrEqual(coordinated.viewport.maximumScrollTop);
    expect(getArcGisResultWorkspaceTableViewportFocusState(coordinated.viewport, 'row-101').visible).toBe(true);
  });

  it('keeps header focus from forcing a row scroll', () => {
    const { ws, table, viewport } = fixture();
    const tableTransition = applyArcGisResultWorkspaceTableIntent(table, { type: 'focus-header', columnIndex: 1 });
    const coordinated = coordinateArcGisResultWorkspaceTableViewport(ws, viewport, tableTransition);

    expect(coordinated.reason).toBe('header-focus');
    expect(coordinated.focusedRowId).toBeNull();
    expect(coordinated.scrollRequired).toBe(false);
    expect(coordinated.scrollTop).toBe(0);
  });

  it('reconciles viewport rows before resolving focus after result refresh', () => {
    const { ws, table, viewport } = fixture();
    const refreshed = rows.slice(50, 150);
    const tableTransition = applyArcGisResultWorkspaceTableIntent(table, { type: 'reconcile', rowIds: refreshed });
    const coordinated = coordinateArcGisResultWorkspaceTableViewport(ws, viewport, tableTransition);

    expect(coordinated.viewport.rowIds).toEqual(refreshed);
    expect(coordinated.viewport.rowIds).toHaveLength(100);
    expect(coordinated.focusedRowId).toBe('row-51');
    expect(coordinated.viewport.maximumScrollTop).toBeGreaterThan(0);
  });

  it('preserves bounded row admission when adversarial refresh exceeds table limits', () => {
    const { ws, table, viewport } = fixture();
    const excessive = Array.from({ length: 25_000 }, (_, index) => `refresh-${index}`);
    const tableTransition = applyArcGisResultWorkspaceTableIntent(table, { type: 'reconcile', rowIds: excessive });
    const coordinated = coordinateArcGisResultWorkspaceTableViewport(ws, viewport, tableTransition);

    expect(tableTransition.next.rowIds).toHaveLength(20_000);
    expect(coordinated.viewport.rowIds).toHaveLength(20_000);
    expect(coordinated.viewport.accessibility.ariaRowCount).toBe(20_000);
  });

  it('reports focus admission, render and visibility independently', () => {
    const { viewport } = fixture();

    expect(getArcGisResultWorkspaceTableViewportFocusState(viewport, 'row-1')).toEqual({
      admitted: true,
      rendered: true,
      visible: true,
      rowIndex: 0,
    });
    expect(getArcGisResultWorkspaceTableViewportFocusState(viewport, 'row-7')).toEqual({
      admitted: true,
      rendered: true,
      visible: false,
      rowIndex: 6,
    });
    expect(getArcGisResultWorkspaceTableViewportFocusState(viewport, 'row-100')).toEqual({
      admitted: true,
      rendered: false,
      visible: false,
      rowIndex: 99,
    });
    expect(getArcGisResultWorkspaceTableViewportFocusState(viewport, 'missing')).toEqual({
      admitted: false,
      rendered: false,
      visible: false,
      rowIndex: -1,
    });
    expect(getArcGisResultWorkspaceTableViewportFocusState(viewport, null).admitted).toBe(false);
  });

  it('does not announce a reveal when focused row is already rendered by overscan', () => {
    const { ws, table, viewport } = fixture();
    const tableTransition = transitionToRow(table, 5);
    const coordinated = coordinateArcGisResultWorkspaceTableViewport(ws, viewport, tableTransition, { announceReveal: true });

    expect(coordinated.reason).toBe('focus-reveal');
    expect(getArcGisResultWorkspaceTableViewportFocusState(viewport, 'row-6').rendered).toBe(true);
    expect(coordinated.announcement).not.toContain('görünür alana getirildi');
  });

  it('returns immutable coordination snapshots', () => {
    const { ws, table, viewport } = fixture();
    const tableTransition = transitionToRow(table, 20);
    const coordinated = coordinateArcGisResultWorkspaceTableViewport(ws, viewport, tableTransition);

    expect(Object.isFrozen(coordinated)).toBe(true);
    expect(Object.isFrozen(coordinated.viewport)).toBe(true);
  });
});
