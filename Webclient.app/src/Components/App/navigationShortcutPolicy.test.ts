import { describe, expect, it } from 'vitest';
import { resolveNavigationShortcut } from './navigationShortcutPolicy';

describe('resolveNavigationShortcut', () => {
  it('accepts / as the independent global search focus shortcut', () => {
    expect(resolveNavigationShortcut({ key: '/' })).toEqual({
      intent: 'focus-search', preventDefault: true, reason: 'accepted',
    });
  });

  it.each(['ctrlKey', 'metaKey', 'altKey'])('rejects / with %s', (modifier) => {
    expect(resolveNavigationShortcut({ key: '/', [modifier]: true })).toMatchObject({
      intent: 'none', preventDefault: false, reason: 'unsupported-modifier',
    });
  });

  it('accepts a slash produced with Shift on a keyboard layout', () => {
    expect(resolveNavigationShortcut({ key: '/', shiftKey: true }).intent).toBe('focus-search');
  });

  it('does not steal slash from a dialog button', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.append(button);
    expect(resolveNavigationShortcut({ key: '/', target: button }).intent).toBe('none');
  });

  it('does not steal a shortcut another handler already consumed', () => {
    expect(resolveNavigationShortcut({ key: '/', defaultPrevented: true })).toEqual({
      intent: 'none',
      preventDefault: false,
      reason: 'already-prevented',
    });
  });

  it('does not intercept shortcuts during IME composition', () => {
    expect(resolveNavigationShortcut({ key: '/', isComposing: true })).toEqual({
      intent: 'none',
      preventDefault: false,
      reason: 'composition',
    });
  });

  it('does not repeatedly move focus while the shortcut is held', () => {
    expect(resolveNavigationShortcut({ key: '/', repeat: true })).toEqual({
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

  it('does not steal / from text inputs', () => {
    const input = document.createElement('input');
    input.type = 'text';
    expect(resolveNavigationShortcut({ key: '/', target: input })).toEqual({
      intent: 'none',
      preventDefault: false,
      reason: 'editable-target',
    });
  });

  it('does not steal / from a textarea', () => {
    const textarea = document.createElement('textarea');
    expect(resolveNavigationShortcut({ key: '/', target: textarea })).toEqual({
      intent: 'none',
      preventDefault: false,
      reason: 'editable-target',
    });
  });

  it('does not steal / from contenteditable descendants', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    const child = document.createElement('span');
    editor.append(child);
    document.body.append(editor);
    try {
      expect(resolveNavigationShortcut({ key: '/', target: child })).toEqual({
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
    expect(resolveNavigationShortcut({ key: '/', target: input })).toMatchObject({
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

// The command center keeps its existing Ctrl/Meta+K authority.
describe('command shortcut ownership', () => {
  it.each([{ key: 'k', ctrlKey: true }, { key: 'K', metaKey: true }])('leaves %j to the command center', event => {
    expect(resolveNavigationShortcut(event)).toMatchObject({ intent: 'none', preventDefault: false });
  });
});
