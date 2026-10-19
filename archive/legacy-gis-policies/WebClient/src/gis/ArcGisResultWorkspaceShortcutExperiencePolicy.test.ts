import { describe, expect, it } from 'vitest';
import {
  createArcGisResultWorkspaceShortcutDescriptors,
  resolveArcGisResultWorkspaceShortcut,
  type ResultWorkspaceShortcutContext,
} from './ArcGisResultWorkspaceShortcutExperiencePolicy';

const context = (overrides: Partial<ResultWorkspaceShortcutContext> = {}): ResultWorkspaceShortcutContext => ({
  detailOpen: false,
  filterOpen: false,
  hasFocusedResult: true,
  hasResults: true,
  viewport: 'desktop',
  ...overrides,
});

describe('ArcGisResultWorkspaceShortcutExperiencePolicy', () => {
  it('cycles landmarks in both directions with F6', () => {
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'F6' }, context()).action).toBe('next-landmark');
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'F6', shiftKey: true }, context()).action).toBe('previous-landmark');
  });

  it('suppresses shortcuts while editing or composing', () => {
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'F6', editable: true }, context()).reason).toBe('editable');
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'F6', composing: true }, context()).reason).toBe('composing');
  });

  it('does not steal modified browser shortcuts or repeated keys', () => {
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'r', shiftKey: true, ctrlKey: true }, context()).reason).toBe('modified');
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'r', shiftKey: true, repeat: true }, context()).reason).toBe('repeat');
  });

  it('routes map, result and filter shortcuts deterministically', () => {
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'M', shiftKey: true }, context()).action).toBe('focus-map');
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'R', shiftKey: true }, context()).action).toBe('focus-results');
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'F', shiftKey: true }, context()).action).toBe('toggle-filters');
  });

  it('requires a focused result for detail and selection actions', () => {
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'Enter', shiftKey: true }, context()).action).toBe('open-detail');
    expect(resolveArcGisResultWorkspaceShortcut({ key: ' ', shiftKey: true }, context()).action).toBe('toggle-selection');
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'Enter', shiftKey: true }, context({ hasFocusedResult: false })).reason).toBe('unavailable');
    expect(resolveArcGisResultWorkspaceShortcut({ key: ' ', shiftKey: true }, context({ hasFocusedResult: false })).reason).toBe('unavailable');
  });

  it('uses Escape only when a dismissible surface is open', () => {
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'Escape' }, context()).reason).toBe('unavailable');
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'Escape' }, context({ detailOpen: true })).action).toBe('close-surface');
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'Escape' }, context({ filterOpen: true })).action).toBe('close-surface');
  });

  it('does not claim unknown or unshifted mnemonic keys', () => {
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'x', shiftKey: true }, context()).reason).toBe('unknown');
    expect(resolveArcGisResultWorkspaceShortcut({ key: 'm' }, context()).reason).toBe('unknown');
  });

  it('publishes a bounded immutable shortcut inventory', () => {
    const descriptors = createArcGisResultWorkspaceShortcutDescriptors(context());
    expect(descriptors).toHaveLength(8);
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(descriptors.every(Object.isFrozen)).toBe(true);
    expect(descriptors.map((item) => item.keys)).toEqual([
      'F6', 'Shift+F6', 'Shift+M', 'Shift+R', 'Shift+F', 'Shift+Enter', 'Shift+Space', 'Escape',
    ]);
  });

  it('reflects availability without removing discoverable commands', () => {
    const descriptors = createArcGisResultWorkspaceShortcutDescriptors(context({ hasResults: false, hasFocusedResult: false }));
    expect(descriptors.find((item) => item.action === 'focus-results')?.available).toBe(false);
    expect(descriptors.find((item) => item.action === 'open-detail')?.available).toBe(false);
    expect(descriptors.find((item) => item.action === 'toggle-selection')?.available).toBe(false);
    expect(descriptors.find((item) => item.action === 'next-landmark')?.available).toBe(true);
  });

  it('changes filter and dismiss labels from current state', () => {
    const descriptors = createArcGisResultWorkspaceShortcutDescriptors(context({ filterOpen: true }));
    expect(descriptors.find((item) => item.action === 'toggle-filters')?.label).toBe('Filtreleri kapat');
    expect(descriptors.find((item) => item.action === 'close-surface')?.available).toBe(true);
  });

  it('never requests preventDefault for suppressed input', () => {
    for (const event of [
      { key: 'F6', editable: true },
      { key: 'F6', composing: true },
      { key: 'F6', repeat: true },
      { key: 'F6', ctrlKey: true },
      { key: 'Unknown' },
    ]) {
      const result = resolveArcGisResultWorkspaceShortcut(event, context());
      expect(result.handled).toBe(false);
      expect(result.preventDefault).toBe(false);
    }
  });
});
