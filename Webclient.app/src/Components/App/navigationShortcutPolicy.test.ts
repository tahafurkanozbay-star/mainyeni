import { describe, expect, it } from 'vitest';
import { resolveNavigationShortcut } from './navigationShortcutPolicy';

describe('resolveNavigationShortcut', () => {
  it.each([
    ['Control', { key: 'k', ctrlKey: true }],
    ['Meta', { key: 'K', metaKey: true }],
  ])('accepts %s+K as the global search focus shortcut', (_name, event) => {
    expect(resolveNavigationShortcut(event)).toEqual({
      intent: 'focus-search',
      preventDefault: true,
      reason: 'accepted',
    });
  });

  it.each([
    ['plain K', { key: 'k' }],
    ['Alt+K', { key: 'k', ctrlKey: true, altKey: true }],
    ['Shift+K', { key: 'k', ctrlKey: true, shiftKey: true }],
    ['Control+Meta+K', { key: 'k', ctrlKey: true, metaKey: true }],
  ])('rejects unsupported modifier shape: %s', (_name, event) => {
    expect(resolveNavigationShortcut(event)).toMatchObject({
      intent: 'none',
      preventDefault: false,
      reason: 'unsupported-modifier',
    });
  });

  it('does not steal a shortcut another handler already consumed', () => {
    expect(resolveNavigationShortcut({ key: 'k', ctrlKey: true, defaultPrevented: true })).toEqual({
      intent: 'none',
      preventDefault: false,
      reason: 'already-prevented',
    });
  });

  it('does not intercept shortcuts during IME composition', () => {
    expect(resolveNavigationShortcut({ key: 'k', ctrlKey: true, isComposing: true })).toEqual({
      intent: 'none',
      preventDefault: false,
      reason: 'composition',
    });
  });

  it('does not repeatedly move focus while the shortcut is held', () => {
    expect(resolveNavigationShortcut({ key: 'k', ctrlKey: true, repeat: true })).toEqual({
      intent: 'none',
      preventDefault: false,
      reason: 'repeat',
    });
  });

  it('does not treat unrelated keys as shell shortcuts', () => {
    expect(resolveNavigationShortcut({ key: 'p', ctrlKey: true })).toEqual({
      intent: 'none',
      preventDefault: false,
      reason: 'unsupported-key',
    });
  });

  it('does not steal Control+K from text inputs', () => {
    const input = document.createElement('input');
    input.type = 'text';
    expect(resolveNavigationShortcut({ key: 'k', ctrlKey: true, target: input })).toEqual({
      intent: 'none',
      preventDefault: false,
      reason: 'editable-target',
    });
  });

  it('does not steal Meta+K from a textarea', () => {
    const textarea = document.createElement('textarea');
    expect(resolveNavigationShortcut({ key: 'k', metaKey: true, target: textarea })).toEqual({
      intent: 'none',
      preventDefault: false,
      reason: 'editable-target',
    });
  });

  it('does not steal Control+K from contenteditable descendants', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    const child = document.createElement('span');
    editor.append(child);
    document.body.append(editor);
    try {
      expect(resolveNavigationShortcut({ key: 'k', ctrlKey: true, target: child })).toEqual({
        intent: 'none',
        preventDefault: false,
        reason: 'editable-target',
      });
    } finally {
      editor.remove();
    }
  });

  it.each(['checkbox', 'radio', 'button', 'submit', 'range'])('allows shell focus shortcut from non-text input type %s', (type) => {
    const input = document.createElement('input');
    input.type = type;
    expect(resolveNavigationShortcut({ key: 'k', ctrlKey: true, target: input })).toMatchObject({
      intent: 'focus-search',
      preventDefault: true,
    });
  });

  it('classifies Escape from an editable target as clear-search', () => {
    const input = document.createElement('input');
    expect(resolveNavigationShortcut({ key: 'Escape', target: input })).toEqual({
      intent: 'clear-search',
      preventDefault: false,
      reason: 'accepted',
    });
  });

  it('leaves Escape from non-editable content alone', () => {
    const button = document.createElement('button');
    expect(resolveNavigationShortcut({ key: 'Escape', target: button })).toEqual({
      intent: 'none',
      preventDefault: false,
      reason: 'unsupported-key',
    });
  });
});
