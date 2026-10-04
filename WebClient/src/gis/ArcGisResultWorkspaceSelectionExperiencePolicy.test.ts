import { describe, expect, it } from 'vitest';
import {
  createArcGisResultWorkspaceSelectionExperience,
  reconcileArcGisResultWorkspaceSelection,
  resolveWorkspaceSelectionAction,
  shouldSuppressWorkspaceSelectionShortcut,
} from './ArcGisResultWorkspaceSelectionExperiencePolicy';

describe('ArcGisResultWorkspaceSelectionExperiencePolicy', () => {
  it('hides the toolbar when selection is empty', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: [] });
    expect(snapshot.toolbarVisible).toBe(false);
    expect(snapshot.statusMessage).toBe('Seçili sonuç yok.');
  });

  it('shows semantic toolbar for a selection', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'] });
    expect(snapshot.toolbarVisible).toBe(true);
    expect(snapshot.toolbarRole).toBe('toolbar');
    expect(snapshot.toolbarLabel).toContain('seçim');
  });

  it('deduplicates selection ids', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a', 'a', 'b'] });
    expect(snapshot.selectedIds).toEqual(['a', 'b']);
  });

  it('drops empty and control-only ids', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['', '\u0000', 'a'] });
    expect(snapshot.selectedIds).toEqual(['a']);
  });

  it('bounds selection inventory', () => {
    const ids = Array.from({ length: 1500 }, (_, index) => `id-${index}`);
    expect(createArcGisResultWorkspaceSelectionExperience({ selectedIds: ids }).selectedCount).toBe(1000);
  });

  it('bounds identifier length', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['x'.repeat(500)] });
    expect(snapshot.selectedIds[0].length).toBeLessThanOrEqual(96);
  });

  it('counts visible and hidden selections', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a', 'b', 'c'], visibleIds: ['a', 'c'] });
    expect(snapshot.visibleSelectedCount).toBe(2);
    expect(snapshot.hiddenSelectedCount).toBe(1);
    expect(snapshot.statusMessage).toContain('1 görünür alan dışında');
  });

  it('uses 48px targets for coarse pointers', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'] }, { coarsePointer: true });
    expect(snapshot.touchTargetPx).toBe(48);
    expect(snapshot.actions.every((action) => action.touchTargetPx === 48)).toBe(true);
  });

  it('uses 44px targets for fine pointers', () => {
    expect(createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'] }).touchTargetPx).toBe(44);
  });

  it('removes motion for reduced motion', () => {
    expect(createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'] }, { reducedMotion: true }).motionDurationMs).toBe(0);
  });

  it('preserves forced colors', () => {
    expect(createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'] }, { forcedColors: true }).forcedColors).toBe(true);
  });

  it('enables inspect only for one selection', () => {
    const one = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'] });
    const two = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a', 'b'] });
    expect(one.actions.find((action) => action.action === 'inspect')?.disabled).toBe(false);
    expect(two.actions.find((action) => action.action === 'inspect')?.disabled).toBe(true);
  });

  it('requires explicit export permission', () => {
    const denied = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'] });
    const allowed = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'], exportAllowed: true });
    expect(denied.actions.find((action) => action.action === 'export')?.disabled).toBe(true);
    expect(allowed.actions.find((action) => action.action === 'export')?.disabled).toBe(false);
  });

  it('accepts inspect for a single selection', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'] });
    expect(resolveWorkspaceSelectionAction(snapshot, 'inspect')).toEqual({ accepted: true, ids: ['a'], focusId: 'a' });
  });

  it('rejects inspect for multiple selections', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a', 'b'] });
    expect(resolveWorkspaceSelectionAction(snapshot, 'inspect').accepted).toBe(false);
  });

  it('accepts zoom with bounded selected ids', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a', 'b'] });
    expect(resolveWorkspaceSelectionAction(snapshot, 'zoom')).toEqual({ accepted: true, ids: ['a', 'b'] });
  });

  it('clear returns an empty selection intent', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'] });
    expect(resolveWorkspaceSelectionAction(snapshot, 'clear')).toEqual({ accepted: true, ids: [] });
  });

  it('rejects disabled actions on empty state', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: [] });
    expect(resolveWorkspaceSelectionAction(snapshot, 'zoom').accepted).toBe(false);
    expect(resolveWorkspaceSelectionAction(snapshot, 'clear').accepted).toBe(false);
  });

  it('announces selection-count reconciliation', () => {
    const before = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'] });
    const result = reconcileArcGisResultWorkspaceSelection(before, { selectedIds: ['a', 'b'] });
    expect(result.announcement).toContain('2 sonuç seçili');
  });

  it('restores focus to a surviving selected id', () => {
    const before = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a', 'b'], focusedId: 'b' });
    const result = reconcileArcGisResultWorkspaceSelection(before, { selectedIds: ['b', 'c'] });
    expect(result.restoreFocusId).toBe('b');
  });

  it('falls back focus to first surviving selection', () => {
    const before = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a', 'b'], focusedId: 'a' });
    const result = reconcileArcGisResultWorkspaceSelection(before, { selectedIds: ['b', 'c'] });
    expect(result.restoreFocusId).toBe('b');
  });

  it('drops focus when selection becomes empty', () => {
    const before = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'], focusedId: 'a' });
    const result = reconcileArcGisResultWorkspaceSelection(before, { selectedIds: [] });
    expect(result.restoreFocusId).toBeUndefined();
  });

  it('ignores focused ids outside selection', () => {
    const snapshot = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a'], focusedId: 'b' });
    expect(snapshot.focusedId).toBeUndefined();
  });

  it('suppresses shortcuts in editable controls', () => {
    expect(shouldSuppressWorkspaceSelectionShortcut('keyboard', { editable: true })).toBe(true);
  });

  it('suppresses shortcuts during composition', () => {
    expect(shouldSuppressWorkspaceSelectionShortcut('keyboard', { composing: true })).toBe(true);
  });

  it('suppresses touch shortcut dispatch', () => {
    expect(shouldSuppressWorkspaceSelectionShortcut('touch')).toBe(true);
  });

  it('allows ordinary keyboard shortcut dispatch', () => {
    expect(shouldSuppressWorkspaceSelectionShortcut('keyboard')).toBe(false);
  });
});
