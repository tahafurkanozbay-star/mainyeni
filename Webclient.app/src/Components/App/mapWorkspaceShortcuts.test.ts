import { describe, expect, it } from 'vitest';
import { MAP_WORKSPACE_SHORTCUTS, resolveMapWorkspaceShortcut, shortcutHelpText } from './mapWorkspaceShortcuts';

const keyboard = (key: string, init: KeyboardEventInit = {}, target?: HTMLElement): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, ...init });
  if (target) Object.defineProperty(event, 'target', { configurable: true, value: target });
  return event;
};

describe('mapWorkspaceShortcuts', () => {
  it('keeps shortcut identities unique and user-facing help complete', () => {
    expect(new Set(MAP_WORKSPACE_SHORTCUTS.map((item) => item.id)).size).toBe(MAP_WORKSPACE_SHORTCUTS.length);
    const help = shortcutHelpText();
    for (const shortcut of MAP_WORKSPACE_SHORTCUTS) {
      expect(help).toContain(shortcut.label);
      expect(help).toContain(shortcut.description);
    }
  });

  it('resolves only exact modifier chords', () => {
    expect(resolveMapWorkspaceShortcut(keyboard('M', { altKey: true }))?.action).toBe('focus-map');
    expect(resolveMapWorkspaceShortcut(keyboard('k', { ctrlKey: true }))?.action).toBe('open-command-center');
    expect(resolveMapWorkspaceShortcut(keyboard('m'))).toBeNull();
    expect(resolveMapWorkspaceShortcut(keyboard('m', { altKey: true, shiftKey: true }))).toBeNull();
  });

  it('does not steal keyboard input from editable controls', () => {
    expect(resolveMapWorkspaceShortcut(keyboard('m', { altKey: true }, document.createElement('input')))).toBeNull();
    expect(resolveMapWorkspaceShortcut(keyboard('b', { altKey: true }, document.createElement('textarea')))).toBeNull();
    expect(resolveMapWorkspaceShortcut(keyboard('f', { altKey: true }, document.createElement('select')))).toBeNull();
  });

  it('ignores repeated and already-consumed keyboard events', () => {
    expect(resolveMapWorkspaceShortcut(keyboard('l', { altKey: true, repeat: true }))).toBeNull();
    const consumed = keyboard('l', { altKey: true });
    consumed.preventDefault();
    expect(resolveMapWorkspaceShortcut(consumed)).toBeNull();
  });
});
