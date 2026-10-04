import { describe, expect, it } from 'vitest';
import {
  createArcGisResultWorkspaceSelectionExperience,
} from './ArcGisResultWorkspaceSelectionExperiencePolicy';
import {
  createArcGisResultWorkspaceSelectionAccessibilityExperience,
  reconcileWorkspaceSelectionAccessibilityExperience,
  resolveWorkspaceSelectionAccessibilityKey,
} from './ArcGisResultWorkspaceSelectionAccessibilityExperiencePolicy';

const selection = (ids: readonly string[], focusedId?: string, coarsePointer = false) =>
  createArcGisResultWorkspaceSelectionExperience(
    { selectedIds: ids, focusedId, visibleIds: ids, exportAllowed: true },
    { coarsePointer },
  );

describe('ArcGisResultWorkspaceSelectionAccessibilityExperiencePolicy', () => {
  it('derives a semantic toolbar without duplicating selection state', () => {
    const source = selection(['a', 'b'], 'b');
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({
      snapshot: source,
      resultIds: ['a', 'b', 'c'],
      triggerElementId: 'results-grid',
    });
    expect(model.toolbarRole).toBe('toolbar');
    expect(model.toolbarLabel).toBe('Sonuç seçim işlemleri');
    expect(model.toolbarHidden).toBe(false);
    expect(model.selectedResultIds).toEqual(['a', 'b']);
    expect(model.focusedResultId).toBe('b');
    expect(model.statusRole).toBe('status');
    expect(model.statusLive).toBe('polite');
    expect(model.statusAtomic).toBe(true);
  });

  it('filters selected ids against admitted result inventory when supplied', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({
      snapshot: selection(['a', 'missing', 'b'], 'missing'),
      resultIds: ['a', 'b'],
    });
    expect(model.selectedResultIds).toEqual(['a', 'b']);
    expect(model.focusedResultId).toBe('a');
    expect(model.setSize).toBe(2);
  });

  it('keeps source selection inventory when result inventory is omitted', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({
      snapshot: selection(['a', 'b'], 'b'),
    });
    expect(model.selectedResultIds).toEqual(['a', 'b']);
    expect(model.focusedResultId).toBe('b');
  });

  it('uses one roving tab stop among enabled actions', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({
      snapshot: selection(['a']),
      preferredAction: 'zoom',
    });
    expect(model.activeAction).toBe('zoom');
    expect(model.actions.filter((action) => action.tabIndex === 0).map((action) => action.action)).toEqual(['zoom']);
  });

  it('does not activate a disabled preferred action', () => {
    const source = createArcGisResultWorkspaceSelectionExperience(
      { selectedIds: ['a', 'b'], visibleIds: ['a', 'b'], exportAllowed: false },
    );
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({
      snapshot: source,
      preferredAction: 'inspect',
    });
    expect(model.activeAction).toBe('zoom');
    expect(model.actions.find((action) => action.action === 'inspect')?.ariaDisabled).toBe('true');
    expect(model.actions.find((action) => action.action === 'export')?.ariaDisabled).toBe('true');
  });

  it('inherits coarse pointer target sizing and accessibility media preferences', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({
      snapshot: selection(['a'], 'a', true),
      environment: { coarsePointer: true, reducedMotion: true, forcedColors: true },
      modality: 'touch',
    });
    expect(model.touchTargetPx).toBe(48);
    expect(model.motionDurationMs).toBe(0);
    expect(model.forcedColors).toBe(true);
    expect(model.focusVisible).toBe(false);
  });

  it('keeps keyboard focus visibly represented', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a']) });
    expect(model.modality).toBe('keyboard');
    expect(model.focusVisible).toBe(true);
  });

  it('rotates right through enabled actions and skips disabled actions', () => {
    const source = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a', 'b'], exportAllowed: false });
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: source, preferredAction: 'zoom' });
    const decision = resolveWorkspaceSelectionAccessibilityKey(model, { key: 'ArrowRight' });
    expect(decision).toEqual({
      accepted: true,
      preventDefault: true,
      intent: 'focus-toolbar',
      action: 'clear',
      focusElementId: 'result-selection-action-clear',
    });
  });

  it('wraps left across the enabled action inventory', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a']), preferredAction: 'inspect' });
    const decision = resolveWorkspaceSelectionAccessibilityKey(model, { key: 'ArrowLeft' });
    expect(decision.action).toBe('clear');
  });

  it('supports vertical arrows for toolbar implementations that wrap visually', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a']), preferredAction: 'inspect' });
    expect(resolveWorkspaceSelectionAccessibilityKey(model, { key: 'ArrowDown' }).action).toBe('zoom');
    expect(resolveWorkspaceSelectionAccessibilityKey(model, { key: 'ArrowUp' }).action).toBe('clear');
  });

  it('supports Home and End over enabled actions', () => {
    const source = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a', 'b'], exportAllowed: false });
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: source });
    expect(resolveWorkspaceSelectionAccessibilityKey(model, { key: 'Home' }).action).toBe('zoom');
    expect(resolveWorkspaceSelectionAccessibilityKey(model, { key: 'End' }).action).toBe('clear');
  });

  it('invokes the current enabled action with Enter', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a']), preferredAction: 'zoom' });
    expect(resolveWorkspaceSelectionAccessibilityKey(model, { key: 'Enter' })).toEqual({
      accepted: true,
      preventDefault: true,
      intent: 'invoke-action',
      action: 'zoom',
      focusElementId: 'result-selection-action-zoom',
    });
  });

  it('invokes the current enabled action with Space', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a']), preferredAction: 'clear' });
    expect(resolveWorkspaceSelectionAccessibilityKey(model, { key: ' ' }).action).toBe('clear');
  });

  it('returns focus to the selected result on Escape', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a'], 'a') });
    const decision = resolveWorkspaceSelectionAccessibilityKey(model, { key: 'Escape' });
    expect(decision.intent).toBe('dismiss-toolbar');
    expect(decision.focusElementId).toBe('a');
  });

  it('falls back to an explicit trigger for Escape focus restoration', () => {
    const source = createArcGisResultWorkspaceSelectionExperience({ selectedIds: [] });
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: source, triggerElementId: 'results-grid' });
    expect(model.restoreFocusId).toBe('results-grid');
  });

  it.each([
    { editable: true },
    { composing: true },
    { defaultPrevented: true },
    { repeat: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
  ])('suppresses unsafe keyboard context %#', (context) => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a']) });
    expect(resolveWorkspaceSelectionAccessibilityKey(model, { key: 'ArrowRight', ...context })).toEqual({
      accepted: false,
      preventDefault: false,
    });
  });

  it('does not consume unrelated keys', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a']) });
    expect(resolveWorkspaceSelectionAccessibilityKey(model, { key: 'Tab' })).toEqual({ accepted: false, preventDefault: false });
  });

  it('does not consume toolbar keys for pointer modality', () => {
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a']), modality: 'pointer' });
    expect(resolveWorkspaceSelectionAccessibilityKey(model, { key: 'ArrowRight' }).accepted).toBe(false);
  });

  it('does not consume toolbar keys while toolbar is hidden', () => {
    const source = createArcGisResultWorkspaceSelectionExperience({ selectedIds: [] });
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: source });
    expect(model.toolbarHidden).toBe(true);
    expect(resolveWorkspaceSelectionAccessibilityKey(model, { key: 'Escape' }).accepted).toBe(false);
  });

  it('bounds and sanitizes result identifiers', () => {
    const source = selection(['safe']);
    const ids = ['safe', ...Array.from({ length: 1100 }, (_, index) => `row-${index}\u0000`)];
    const model = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: source, resultIds: ids });
    expect(model.selectedResultIds).toEqual(['safe']);
    expect(model.selectedResultIds.every((id) => !id.includes('\u0000'))).toBe(true);
  });

  it('announces changed selection status during reconciliation', () => {
    const previous = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a']) });
    const nextSelection = selection(['a', 'b']);
    const reconciled = reconcileWorkspaceSelectionAccessibilityExperience(previous, { snapshot: nextSelection });
    expect(reconciled.announcement).toContain('2 sonuç seçili');
  });

  it('does not repeat identical status announcements', () => {
    const source = selection(['a']);
    const previous = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: source });
    const reconciled = reconcileWorkspaceSelectionAccessibilityExperience(previous, { snapshot: source });
    expect(reconciled.announcement).toBe('');
  });

  it('requests toolbar focus when selection becomes visible', () => {
    const hidden = createArcGisResultWorkspaceSelectionAccessibilityExperience({
      snapshot: createArcGisResultWorkspaceSelectionExperience({ selectedIds: [] }),
      triggerElementId: 'results-grid',
    });
    const reconciled = reconcileWorkspaceSelectionAccessibilityExperience(hidden, {
      snapshot: selection(['a']),
      triggerElementId: 'results-grid',
    });
    expect(reconciled.focusElementId).toBe('result-selection-action-inspect');
  });

  it('restores result focus when selection toolbar disappears', () => {
    const visible = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a'], 'a') });
    const reconciled = reconcileWorkspaceSelectionAccessibilityExperience(visible, {
      snapshot: createArcGisResultWorkspaceSelectionExperience({ selectedIds: [] }),
      triggerElementId: 'results-grid',
    });
    expect(reconciled.next.toolbarHidden).toBe(true);
    expect(reconciled.focusElementId).toBe('results-grid');
  });

  it('reconciles a now-disabled active action to the next enabled action', () => {
    const previous = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a']), preferredAction: 'inspect' });
    const many = createArcGisResultWorkspaceSelectionExperience({ selectedIds: ['a', 'b'], exportAllowed: true });
    const reconciled = reconcileWorkspaceSelectionAccessibilityExperience(previous, { snapshot: many });
    expect(reconciled.next.activeAction).toBe('zoom');
    expect(reconciled.focusElementId).toBe('result-selection-action-zoom');
  });

  it('keeps instructions bounded and state-derived', () => {
    const populated = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: selection(['a']) });
    const empty = createArcGisResultWorkspaceSelectionAccessibilityExperience({ snapshot: createArcGisResultWorkspaceSelectionExperience({ selectedIds: [] }) });
    expect(populated.instructions.length).toBeLessThan(256);
    expect(populated.instructions).toContain('Escape');
    expect(empty.instructions).toContain('Sonuç seçildiğinde');
  });
});