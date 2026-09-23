import { vi } from 'vitest';
import type { ShortcutContext, ShortcutDefinition } from '../shortcutRuntime';
import { createExperienceBus } from '../experienceRuntime';
import { createWorkspaceShortcuts, WORKSPACE_SHORTCUT_HINTS } from './experienceShortcutCatalog';

const shortcutById = (id: string, bus = createExperienceBus(window)): ShortcutDefinition => {
  const shortcut = createWorkspaceShortcuts(document, bus).find((candidate) => candidate.id === id);
  if (!shortcut) throw new Error(`Missing workspace shortcut: ${id}`);
  return shortcut;
};

const invoke = (shortcut: ShortcutDefinition, target: EventTarget = document): void => {
  const event = new KeyboardEvent('keydown', { key: shortcut.key, bubbles: true, cancelable: true });
  shortcut.handler(Object.freeze({ event, target, editable: false } satisfies ShortcutContext));
};

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

  test('routes command palette through the injected experience command bus', () => {
    const bus = createExperienceBus(new EventTarget());
    const listener = vi.fn();
    const release = bus.on('kentrehberi:command', listener);
    invoke(shortcutById('experience-command-palette', bus));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: 'command-palette', source: 'experience-keyboard' }), expect.any(Event));
    release();
  });

  test('routes help through the injected experience command bus', () => {
    const bus = createExperienceBus(new EventTarget());
    const listener = vi.fn();
    const release = bus.on('kentrehberi:command', listener);
    invoke(shortcutById('experience-help', bus));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: 'help', source: 'experience-keyboard' }), expect.any(Event));
    release();
  });

  test('focuses the map and sidebar using the same deterministic catalog', () => {
    const map = document.createElement('div'); map.id = 'esri-map-container';
    const sidebar = document.createElement('aside'); sidebar.id = 'sidebar';
    document.body.append(map, sidebar);
    invoke(shortcutById('experience-focus-map'));
    expect(document.activeElement).toBe(map);
    expect(map.tabIndex).toBe(-1);
    invoke(shortcutById('experience-focus-sidebar'));
    expect(document.activeElement).toBe(sidebar);
    expect(sidebar.tabIndex).toBe(-1);
    map.remove(); sidebar.remove();
  });

  test('announces unavailable focus targets instead of failing silently', () => {
    document.querySelector('#esri-map-container')?.remove();
    const bus = createExperienceBus(new EventTarget());
    const listener = vi.fn();
    const release = bus.on('kentrehberi:announcement', listener);
    invoke(shortcutById('experience-focus-map', bus));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ message: 'harita şu anda kullanılamıyor.', politeness: 'polite' }), expect.any(Event));
    release();
  });

  test('leaves editable-control ownership to the shared shortcut runtime', () => {
    const mapShortcut = shortcutById('experience-focus-map');
    const paletteShortcut = shortcutById('experience-command-palette');
    expect(mapShortcut.allowInEditable).not.toBe(true);
    expect(paletteShortcut.allowInEditable).toBe(true);
  });
});
