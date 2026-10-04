import { describe, expect, it } from 'vitest';
import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';
import { createArcGisResultWorkspaceSelectionExperience } from './ArcGisResultWorkspaceSelectionExperiencePolicy';
import type { WorkspaceTableSnapshot } from './ArcGisResultWorkspaceTableExperiencePolicy';
import { createArcGisResultWorkspaceViewportExperience } from './ArcGisResultWorkspaceViewportExperiencePolicy';
import {
  coordinateArcGisResultWorkspaceSelectionViewport,
  getArcGisResultWorkspaceSelectionViewportState,
} from './ArcGisResultWorkspaceSelectionViewportExperiencePolicy';

const rowIds = Array.from({ length: 100 }, (_, index) => `row-${index}`);
const workspace = (): ResultWorkspaceSnapshot => ({
  model: { status: 'ready', heading: 'Sonuçlar' },
  interaction: { resultIds: rowIds, selectedIds: [], focusedId: 'row-0' },
  modality: 'keyboard',
  accessibility: { minimumTargetSize: 44, reducedMotion: false },
} as ResultWorkspaceSnapshot);
const table = (): WorkspaceTableSnapshot => ({
  columns: [], rowIds, selectedIds: [],
  focus: { rowIndex: 0, columnIndex: 0, inHeader: false },
  sort: { columnKey: null, direction: 'none' }, selectionMode: 'multiple',
  accessibility: { role: 'grid', rowCount: rowIds.length, columnCount: 0, ariaMultiSelectable: true, ariaBusy: false, ariaLabel: 'Sonuçlar', keyboardHint: '', focusVisible: true, minimumTargetSize: 44 },
  revision: 0,
});
const viewport = () => createArcGisResultWorkspaceViewportExperience(workspace(), table(), { viewportHeight: 260, rowHeight: 52, overscanRows: 2 });

describe('ArcGisResultWorkspaceSelectionViewportExperiencePolicy', () => {
  it('does not scroll for an empty selection', () => {
    const selection = createArcGisResultWorkspaceSelectionExperience({ selectedIds: [] });
    const result = coordinateArcGisResultWorkspaceSelectionViewport(workspace(), viewport(), selection);
    expect(result.reason).toBe('selection-empty');
    expect(result.scrollRequired).toBe(false);
    expect(result.targetId).toBeNull();
  });

  it('keeps an already visible focused selection stable', () => {
    const selection = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['row-2'], focusedId: 'row-2', visibleIds: rowIds.slice(0, 5) });
    const result = coordinateArcGisResultWorkspaceSelectionViewport(workspace(), viewport(), selection);
    expect(result.reason).toBe('selection-visible');
    expect(result.scrollRequired).toBe(false);
    expect(result.visible).toBe(true);
  });

  it('reveals an admitted selection outside the visible range', () => {
    const selection = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['row-80'], focusedId: 'row-80' });
    const result = coordinateArcGisResultWorkspaceSelectionViewport(workspace(), viewport(), selection, { alignment: 'center' });
    expect(result.reason).toBe('selection-reveal');
    expect(result.transition).not.toBeNull();
    expect(result.visible).toBe(true);
    expect(result.scrollTop).toBeGreaterThan(0);
  });

  it('prefers the explicit selected focus over selected inventory order', () => {
    const selection = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['row-2', 'row-75'], focusedId: 'row-75' });
    const result = coordinateArcGisResultWorkspaceSelectionViewport(workspace(), viewport(), selection);
    expect(result.targetId).toBe('row-75');
    expect(result.reason).toBe('selection-reveal');
  });

  it('falls back to the first admitted selected id', () => {
    const selection = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['missing', 'row-3'] });
    const result = coordinateArcGisResultWorkspaceSelectionViewport(workspace(), viewport(), selection);
    expect(result.targetId).toBe('row-3');
    expect(result.reason).toBe('selection-visible');
  });

  it('fails closed when selected ids are not admitted by the viewport', () => {
    const selection = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['missing'] });
    const result = coordinateArcGisResultWorkspaceSelectionViewport(workspace(), viewport(), selection);
    expect(result.reason).toBe('selection-not-admitted');
    expect(result.scrollRequired).toBe(false);
    expect(result.admitted).toBe(false);
  });

  it('reports admitted, rendered, visible and hidden selection pressure', () => {
    const selection = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['row-1', 'row-6', 'row-50', 'missing'] });
    const state = getArcGisResultWorkspaceSelectionViewportState(selection, viewport());
    expect(state.selectedCount).toBe(4);
    expect(state.admittedSelectedCount).toBe(3);
    expect(state.renderedSelectedCount).toBe(2);
    expect(state.visibleSelectedCount).toBe(1);
    expect(state.hiddenSelectedCount).toBe(3);
  });

  it('bounds reveal announcements and strips control characters from upstream text', () => {
    const selection = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['row-99'], focusedId: 'row-99' });
    const result = coordinateArcGisResultWorkspaceSelectionViewport(workspace(), viewport(), selection, { announceReveal: true });
    expect(result.announcement.length).toBeLessThanOrEqual(240);
    expect(result.announcement).toContain('Seçili sonuç görünür alana getirildi');
    expect(result.announcement).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('honors start and end alignment through the existing viewport authority', () => {
    const selection = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['row-50'], focusedId: 'row-50' });
    const start = coordinateArcGisResultWorkspaceSelectionViewport(workspace(), viewport(), selection, { alignment: 'start' });
    const end = coordinateArcGisResultWorkspaceSelectionViewport(workspace(), viewport(), selection, { alignment: 'end' });
    expect(start.visible).toBe(true);
    expect(end.visible).toBe(true);
    expect(start.scrollTop).not.toBe(end.scrollTop);
  });

  it('keeps returned coordination immutable', () => {
    const selection = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['row-2'] });
    const result = coordinateArcGisResultWorkspaceSelectionViewport(workspace(), viewport(), selection);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
