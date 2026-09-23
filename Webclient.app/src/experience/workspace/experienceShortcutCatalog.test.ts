import { vi } from 'vitest';
import { createShortcutRuntime } from '../shortcutRuntime';
import { experienceBus } from '../experienceSession';
import { createWorkspaceShortcuts, WORKSPACE_SHORTCUT_HINTS } from './experienceShortcutCatalog';

const createRuntime = () => createShortcutRuntime({
  document,
  shortcuts: createWorkspaceShortcuts(document),
});

describe('experienceShortcutCatalog', () => {
  test('publishes a deterministic unique shortcut catalog', () => {
    const shortcuts = createWorkspaceShortcuts(document);
    expect(shortcuts.map((shortcut) => shortcut.id)).toEqual([
      'experience-command-palette', 'experience-focus-map', 'experience-focus-sidebar', 'experience-help',
    ]);
    expect(new Set(shortcuts.map((shortcut) => shortcut.id)).size).toBe(shortcuts.length);
    expect(Object.isFrozen(shortcuts)).toBe(true);
    expect(shortcuts.every(Object.isFrozen)).toBe(true);
  });

  test('keeps visible hints aligned with registered shortcut ids', () => {
    const ids = new Set(createWorkspaceShortcuts(document).map((shortcut) => shortcut.id));
    expect(WORKSPACE_SHORTCUT_HINTS.every((hint) => ids.has(hint.id))).toBe(true);
    expect(Object.isFrozen(WORKSPACE_SHORTCUT_HINTS)).toBe(true);
  });

  test('routes command palette through the shared experience command bus', () => {
    const listener = vi.fn();
    const release = experienceBus.on('kentrehberi:command', listener);
    const runtime = createRuntime();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: 'command-palette', source: 'experience-keyboard' }));
    runtime.dispose();
    release();
  });

  test('routes help through the shared experience command bus', () => {
    const listener = vi.fn();
    const release = experienceBus.on('kentrehberi:command', listener);
    const runtime = createRuntime();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true, cancelable: true }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: 'help', source: 'experience-keyboard' }));
    runtime.dispose();
    release();
  });

  test('focuses the map and sidebar using the same deterministic catalog', () => {
    const map = document.createElement('div'); map.id = 'esri-map-container';
    const sidebar = document.createElement('aside'); sidebar.id = 'sidebar';
    document.body.append(map, sidebar);
    const runtime = createRuntime();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', altKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(map);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', altKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(sidebar);
    runtime.dispose(); map.remove(); sidebar.remove();
  });

  test('announces unavailable focus targets instead of failing silently', () => {
    document.querySelector('#esri-map-container')?.remove();
    const listener = vi.fn();
    const release = experienceBus.on('kentrehberi:announcement', listener);
    const runtime = createRuntime();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', altKey: true, bubbles: true, cancelable: true }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ message: 'harita şu anda kullanılamıyor.', politeness: 'polite' }));
    runtime.dispose(); release();
  });

  test('does not hijack map focus shortcut from editable controls', () => {
    const input = document.createElement('input');
    const map = document.createElement('div'); map.id = 'esri-map-container';
    document.body.append(input, map); input.focus();
    const runtime = createRuntime();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', altKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(input);
    runtime.dispose(); input.remove(); map.remove();
  });
});
