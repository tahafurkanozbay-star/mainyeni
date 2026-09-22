import { vi } from 'vitest';
import { createShortcutRuntime } from '../shortcutRuntime';
import { experienceBus } from '../experienceSession';
import { createWorkspaceShortcuts, WORKSPACE_SHORTCUT_HINTS } from './experienceShortcutCatalog';

const dispatch = (target: Document | HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('experienceShortcutCatalog', () => {
  afterEach(() => document.body.replaceChildren());

  test('exposes deterministic user-facing shortcut hints', () => {
    expect(WORKSPACE_SHORTCUT_HINTS).toEqual([
      { id: 'experience-command-palette', label: 'Komut merkezi', keys: 'Ctrl/⌘ + K' },
      { id: 'experience-focus-map', label: 'Haritaya odaklan', keys: 'Alt + M' },
      { id: 'experience-focus-sidebar', label: 'Araç paneline odaklan', keys: 'Alt + S' },
      { id: 'experience-help', label: 'Kısayollar ve yardım', keys: '?' },
    ]);
  });

  test('opens command palette with Control+K and Meta+K', () => {
    const listener = vi.fn();
    const release = experienceBus.on('kentrehberi:command', listener);
    const runtime = createShortcutRuntime({ document, shortcuts: createWorkspaceShortcuts(document) });

    dispatch(document, 'k', { ctrlKey: true });
    dispatch(document, 'k', { metaKey: true });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: 'command-palette', source: 'experience-keyboard' }));
    runtime.dispose();
    release();
  });

  test('allows command palette shortcut while focus is in a text field', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const listener = vi.fn();
    const release = experienceBus.on('kentrehberi:command', listener);
    const runtime = createShortcutRuntime({ document, shortcuts: createWorkspaceShortcuts(document) });

    const event = dispatch(input, 'k', { ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: 'command-palette' }));
    runtime.dispose();
    release();
  });

  test('focuses map with Alt+M', () => {
    const map = document.createElement('div');
    map.id = 'esri-map-container';
    document.body.append(map);
    const runtime = createShortcutRuntime({ document, shortcuts: createWorkspaceShortcuts(document) });

    dispatch(document, 'm', { altKey: true });

    expect(document.activeElement).toBe(map);
    expect(map.tabIndex).toBe(-1);
    runtime.dispose();
  });

  test('focuses sidebar with Alt+S', () => {
    const sidebar = document.createElement('aside');
    sidebar.id = 'sidebar';
    document.body.append(sidebar);
    const runtime = createShortcutRuntime({ document, shortcuts: createWorkspaceShortcuts(document) });

    dispatch(document, 's', { altKey: true });

    expect(document.activeElement).toBe(sidebar);
    runtime.dispose();
  });

  test('announces unavailable focus targets instead of silently failing', () => {
    const listener = vi.fn();
    const release = experienceBus.on('kentrehberi:announcement', listener);
    const runtime = createShortcutRuntime({ document, shortcuts: createWorkspaceShortcuts(document) });

    dispatch(document, 'm', { altKey: true });
    dispatch(document, 's', { altKey: true });

    expect(listener).toHaveBeenNthCalledWith(1, { message: 'harita şu anda kullanılamıyor.', politeness: 'polite' });
    expect(listener).toHaveBeenNthCalledWith(2, { message: 'araç paneli şu anda kullanılamıyor.', politeness: 'polite' });
    runtime.dispose();
    release();
  });

  test('does not steal map focus shortcut while typing', () => {
    const input = document.createElement('input');
    const map = document.createElement('div');
    map.id = 'esri-map-container';
    document.body.append(input, map);
    input.focus();
    const runtime = createShortcutRuntime({ document, shortcuts: createWorkspaceShortcuts(document) });

    const event = dispatch(input, 'm', { altKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    runtime.dispose();
  });

  test('dispatches help command for question mark', () => {
    const listener = vi.fn();
    const release = experienceBus.on('kentrehberi:command', listener);
    const runtime = createShortcutRuntime({ document, shortcuts: createWorkspaceShortcuts(document) });

    dispatch(document, '?', { shiftKey: true });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: 'help', source: 'experience-keyboard' }));
    runtime.dispose();
    release();
  });

  test('rejects near-miss modifier combinations', () => {
    const listener = vi.fn();
    const release = experienceBus.on('kentrehberi:command', listener);
    const runtime = createShortcutRuntime({ document, shortcuts: createWorkspaceShortcuts(document) });

    dispatch(document, 'k');
    dispatch(document, 'k', { ctrlKey: true, altKey: true });
    dispatch(document, 'k', { metaKey: true, shiftKey: true });
    dispatch(document, 'm', { altKey: true, shiftKey: true });
    dispatch(document, 's', { altKey: true, ctrlKey: true });

    expect(listener).not.toHaveBeenCalled();
    runtime.dispose();
    release();
  });
});
