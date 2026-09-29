import { describe, expect, it, vi } from 'vitest';
import {
  MAP_WORKSPACE_SHORTCUTS,
  executeMapWorkspaceShortcut,
  handleMapWorkspaceKeyDown,
  resolveMapWorkspaceShortcut,
  shortcutHelpText,
} from './mapWorkspaceShortcuts';

const keyboard = (key: string, init: KeyboardEventInit = {}, target?: HTMLElement): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
  if (target) Object.defineProperty(event, 'target', { configurable: true, value: target });
  return event;
};

const shortcut = (id: string) => {
  const value = MAP_WORKSPACE_SHORTCUTS.find((item) => item.id === id);
  if (!value) throw new Error(`Missing shortcut: ${id}`);
  return value;
};

describe('mapWorkspaceShortcuts', () => {
  it('keeps shortcut identities unique and user-facing help complete', () => {
    expect(new Set(MAP_WORKSPACE_SHORTCUTS.map((item) => item.id)).size).toBe(MAP_WORKSPACE_SHORTCUTS.length);
    const help = shortcutHelpText();
    for (const item of MAP_WORKSPACE_SHORTCUTS) {
      expect(help).toContain(item.label);
      expect(help).toContain(item.description);
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

  it('executes window actions through the existing window manager authority', () => {
    const ToggleWindow = vi.fn(() => true);
    const ShowWindow = vi.fn(() => true);
    const announce = vi.fn();
    const environment = { mapElement: null, navigationElement: null, windowManager: { ToggleWindow, ShowWindow }, announce };

    expect(executeMapWorkspaceShortcut(shortcut('toggle-sidebar'), environment).handled).toBe(true);
    expect(ToggleWindow).toHaveBeenCalledWith('sidebar');

    expect(executeMapWorkspaceShortcut(shortcut('basemap'), environment).handled).toBe(true);
    expect(ShowWindow).toHaveBeenCalledWith('basemap-widget');
    expect(executeMapWorkspaceShortcut(shortcut('measurement'), environment).handled).toBe(true);
    expect(ShowWindow).toHaveBeenCalledWith('measurement-widget');
    expect(executeMapWorkspaceShortcut(shortcut('feedback'), environment).handled).toBe(true);
    expect(ShowWindow).toHaveBeenCalledWith('feedback-widget');
    expect(announce).toHaveBeenCalled();
  });

  it('focuses only connected workspace landmarks and announces successful focus', () => {
    const map = document.createElement('div');
    map.tabIndex = -1;
    const navigation = document.createElement('header');
    navigation.tabIndex = -1;
    document.body.append(map, navigation);
    const announce = vi.fn();
    const environment = {
      mapElement: map,
      navigationElement: navigation,
      windowManager: { ToggleWindow: vi.fn(() => false), ShowWindow: vi.fn(() => false) },
      announce,
    };

    expect(executeMapWorkspaceShortcut(shortcut('focus-map'), environment).handled).toBe(true);
    expect(document.activeElement).toBe(map);
    expect(executeMapWorkspaceShortcut(shortcut('focus-navigation'), environment).handled).toBe(true);
    expect(document.activeElement).toBe(navigation);
    expect(announce).toHaveBeenCalledTimes(2);

    map.remove();
    navigation.remove();
    expect(executeMapWorkspaceShortcut(shortcut('focus-map'), environment).handled).toBe(false);
  });

  it('prevents browser behavior only after an action is actually handled', () => {
    const event = keyboard('b', { altKey: true });
    const success = handleMapWorkspaceKeyDown(event, {
      mapElement: null,
      navigationElement: null,
      windowManager: { ToggleWindow: vi.fn(() => false), ShowWindow: vi.fn(() => true) },
    });
    expect(success.handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);

    const unavailable = keyboard('b', { altKey: true });
    const failure = handleMapWorkspaceKeyDown(unavailable, {
      mapElement: null,
      navigationElement: null,
      windowManager: { ToggleWindow: vi.fn(() => false), ShowWindow: vi.fn(() => false) },
    });
    expect(failure.handled).toBe(false);
    expect(unavailable.defaultPrevented).toBe(false);
  });
});
