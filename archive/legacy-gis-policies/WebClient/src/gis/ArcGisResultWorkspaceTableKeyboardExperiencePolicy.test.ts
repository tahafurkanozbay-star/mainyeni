import { describe, expect, it } from 'vitest';
import { createArcGisResultWorkspaceExperience } from './ArcGisResultWorkspaceExperiencePolicy';
import { createArcGisResultWorkspaceTableExperience } from './ArcGisResultWorkspaceTableExperiencePolicy';
import {
  dispatchArcGisResultWorkspaceTableKeyboard,
  resolveArcGisResultWorkspaceTableKeyboard,
} from './ArcGisResultWorkspaceTableKeyboardExperiencePolicy';

const workspace = () => createArcGisResultWorkspaceExperience({
  heading: 'Sonuçlar',
  status: 'ready',
  rows: [
    { key: 'a', title: 'A', fields: [] },
    { key: 'b', title: 'B', fields: [] },
    { key: 'c', title: 'C', fields: [] },
  ],
}, { viewportWidth: 1280, viewportHeight: 800 });

const table = () => createArcGisResultWorkspaceTableExperience(workspace(), [
  { key: 'name', label: 'Ad', sortable: true },
  { key: 'district', label: 'İlçe', sortable: true },
  { key: 'note', label: 'Not', sortable: false },
]);

describe('ArcGisResultWorkspaceTableKeyboardExperiencePolicy', () => {
  it('maps arrow keys to bounded two-dimensional movement', () => {
    const current = table();
    expect(resolveArcGisResultWorkspaceTableKeyboard(current, { key: 'ArrowDown' }).intent).toEqual({ type: 'move', rowDelta: 1, columnDelta: 0 });
    expect(resolveArcGisResultWorkspaceTableKeyboard(current, { key: 'ArrowUp' }).intent).toEqual({ type: 'move', rowDelta: -1, columnDelta: 0 });
    expect(resolveArcGisResultWorkspaceTableKeyboard(current, { key: 'ArrowRight' }).intent).toEqual({ type: 'move', rowDelta: 0, columnDelta: 1 });
    expect(resolveArcGisResultWorkspaceTableKeyboard(current, { key: 'ArrowLeft' }).intent).toEqual({ type: 'move', rowDelta: 0, columnDelta: -1 });
  });

  it('uses Home and End for row navigation and command-modified variants for grid navigation', () => {
    const current = table();
    expect(resolveArcGisResultWorkspaceTableKeyboard(current, { key: 'Home' }).intent).toEqual({ type: 'home', scope: 'row' });
    expect(resolveArcGisResultWorkspaceTableKeyboard(current, { key: 'End' }).intent).toEqual({ type: 'end', scope: 'row' });
    expect(resolveArcGisResultWorkspaceTableKeyboard(current, { key: 'Home', ctrlKey: true }).intent).toEqual({ type: 'home', scope: 'grid' });
    expect(resolveArcGisResultWorkspaceTableKeyboard(current, { key: 'End', metaKey: true }).intent).toEqual({ type: 'end', scope: 'grid' });
  });

  it('dispatches movement through the canonical table authority', () => {
    const current = table();
    const moved = dispatchArcGisResultWorkspaceTableKeyboard(current, { key: 'ArrowDown' });
    expect(moved.handled).toBe(true);
    expect(moved.preventDefault).toBe(true);
    expect(moved.transition?.next.focus.rowIndex).toBe(1);
    expect(moved.transition?.action).toBe('focus-cell');
    expect(moved.transition?.next.revision).toBe(1);
  });

  it('does not let repeated keys mutate table state', () => {
    const result = dispatchArcGisResultWorkspaceTableKeyboard(table(), { key: 'ArrowDown', repeat: true });
    expect(result.reason).toBe('repeat');
    expect(result.handled).toBe(false);
    expect(result.preventDefault).toBe(false);
    expect(result.transition).toBeNull();
  });

  it('suppresses all table shortcuts while editing or composing', () => {
    for (const context of [{ editable: true }, { composing: true }]) {
      const result = resolveArcGisResultWorkspaceTableKeyboard(table(), { key: 'ArrowDown' }, context);
      expect(result.handled).toBe(false);
      expect(result.preventDefault).toBe(false);
      expect(result.intent).toBeNull();
    }
  });

  it('suppresses table shortcuts behind a modal or disabled surface', () => {
    expect(resolveArcGisResultWorkspaceTableKeyboard(table(), { key: 'ArrowDown' }, { modalOpen: true }).reason).toBe('modal');
    expect(resolveArcGisResultWorkspaceTableKeyboard(table(), { key: 'ArrowDown' }, { disabled: true }).reason).toBe('disabled');
  });

  it('does not steal Alt or unrelated command-modified browser shortcuts', () => {
    expect(resolveArcGisResultWorkspaceTableKeyboard(table(), { key: 'ArrowDown', altKey: true }).reason).toBe('modified');
    expect(resolveArcGisResultWorkspaceTableKeyboard(table(), { key: 'r', ctrlKey: true }).reason).toBe('modified');
    expect(resolveArcGisResultWorkspaceTableKeyboard(table(), { key: 'k', metaKey: true }).reason).toBe('modified');
  });

  it('toggles focused row selection with Space', () => {
    const result = dispatchArcGisResultWorkspaceTableKeyboard(table(), { key: ' ' });
    expect(result.intent).toEqual({ type: 'toggle-selection' });
    expect(result.transition?.next.selectedIds).toEqual(['a']);
    expect(result.transition?.announcement).toContain('1 sonuç seçili');
  });

  it('supports the legacy Spacebar key value without broad key normalization', () => {
    expect(resolveArcGisResultWorkspaceTableKeyboard(table(), { key: 'Spacebar' }).intent).toEqual({ type: 'toggle-selection' });
  });

  it('selects visible rows with Ctrl+A only in multiple-selection row context', () => {
    const current = table();
    const resolution = resolveArcGisResultWorkspaceTableKeyboard(current, { key: 'a', ctrlKey: true });
    expect(resolution.intent).toEqual({ type: 'select-all-visible' });
    expect(resolution.preventDefault).toBe(true);
  });

  it('accepts Meta+A for platform-equivalent visible selection', () => {
    expect(resolveArcGisResultWorkspaceTableKeyboard(table(), { key: 'A', metaKey: true }).intent).toEqual({ type: 'select-all-visible' });
  });

  it('clears an existing selection with Escape without closing unrelated surfaces', () => {
    const selected = dispatchArcGisResultWorkspaceTableKeyboard(table(), { key: ' ' }).transition!.next;
    const cleared = dispatchArcGisResultWorkspaceTableKeyboard(selected, { key: 'Escape' });
    expect(cleared.intent).toEqual({ type: 'clear-selection' });
    expect(cleared.transition?.next.selectedIds).toEqual([]);
  });

  it('leaves Escape untouched when there is no table selection to clear', () => {
    const result = resolveArcGisResultWorkspaceTableKeyboard(table(), { key: 'Escape' });
    expect(result.reason).toBe('unsupported');
    expect(result.preventDefault).toBe(false);
  });

  it('sorts the focused sortable header with Enter', () => {
    const header = dispatchArcGisResultWorkspaceTableKeyboard(table(), { key: 'Home', ctrlKey: true }).transition!.next;
    const sortableHeader = { ...header, focus: Object.freeze({ rowIndex: 0, columnIndex: 0, inHeader: true }) };
    const sorted = dispatchArcGisResultWorkspaceTableKeyboard(sortableHeader, { key: 'Enter' });
    expect(sorted.intent).toEqual({ type: 'sort', columnKey: 'name' });
    expect(sorted.transition?.next.sort).toEqual({ columnKey: 'name', direction: 'ascending' });
  });

  it('does not consume Enter on a non-sortable header', () => {
    const current = table();
    const header = { ...current, focus: Object.freeze({ rowIndex: 0, columnIndex: 2, inHeader: true }) };
    const result = resolveArcGisResultWorkspaceTableKeyboard(header, { key: 'Enter' });
    expect(result.reason).toBe('unavailable');
    expect(result.preventDefault).toBe(false);
  });

  it('does not toggle row selection while header focus is active', () => {
    const current = table();
    const header = { ...current, focus: Object.freeze({ rowIndex: 0, columnIndex: 0, inHeader: true }) };
    expect(resolveArcGisResultWorkspaceTableKeyboard(header, { key: ' ' }).reason).toBe('unsupported');
    expect(resolveArcGisResultWorkspaceTableKeyboard(header, { key: 'a', ctrlKey: true }).reason).toBe('unsupported');
  });

  it('does not consume unknown keys', () => {
    for (const key of ['Tab', 'PageUp', 'PageDown', 'F6', 'x']) {
      const result = resolveArcGisResultWorkspaceTableKeyboard(table(), { key });
      expect(result.handled).toBe(false);
      expect(result.preventDefault).toBe(false);
      expect(result.intent).toBeNull();
    }
  });

  it('sanitizes control characters from key admission', () => {
    const result = resolveArcGisResultWorkspaceTableKeyboard(table(), { key: '\u0000ArrowDown\u0007' });
    expect(result.intent).toEqual({ type: 'move', rowDelta: 1, columnDelta: 0 });
  });
});
