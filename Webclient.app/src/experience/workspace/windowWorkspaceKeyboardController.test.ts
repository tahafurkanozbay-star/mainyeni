import { describe, expect, it } from 'vitest';
import {
  WINDOW_WORKSPACE_ARIA_SHORTCUT,
  WINDOW_WORKSPACE_SHORTCUT_LABEL,
  createWindowWorkspaceKeyboardPolicy,
  evaluateWindowWorkspaceKeyboard,
  windowWorkspaceKeyboardHelp,
  type WindowWorkspaceKeyboardContext,
  type WindowWorkspaceKeyboardEventLike,
} from './windowWorkspaceKeyboardController';
import type { WindowWorkspaceSnapshot } from './windowWorkspaceModel';

const snapshot = (overrides: Partial<WindowWorkspaceSnapshot> = {}): WindowWorkspaceSnapshot => Object.freeze({
  revision: 1,
  sourceRevision: 1,
  query: '',
  normalizedQuery: '',
  scope: 'all',
  activeEntryId: 'park-query-window',
  activeWindowId: 'park-query-window',
  totalCount: 2,
  resultCount: 2,
  openCount: 1,
  minimizedCount: 0,
  recentCount: 1,
  entries: Object.freeze([
    Object.freeze({
      id: 'park-query-window',
      domId: 'experience-window-dock-item-park-query-window',
      title: 'Parklar',
      kind: 'query',
      kindLabel: 'Sorgu',
      state: 'active',
      stateLabel: 'Açık',
      visible: true,
      minimized: false,
      lazy: true,
      recentRank: 0,
      selected: true,
      position: 1,
      setSize: 2,
      searchableText: 'parklar',
    }),
    Object.freeze({
      id: 'measurement-widget',
      domId: 'experience-window-dock-item-measurement-widget',
      title: 'Ölçüm araçları',
      kind: 'tool',
      kindLabel: 'Harita aracı',
      state: 'hidden',
      stateLabel: 'Kapalı',
      visible: false,
      minimized: false,
      lazy: false,
      recentRank: null,
      selected: false,
      position: 2,
      setSize: 2,
      searchableText: 'olcum araclari',
    }),
  ]),
  announcement: '2 çalışma penceresi gösteriliyor.',
  emptyReason: 'none',
  ...overrides,
});

const context = (
  source: WindowWorkspaceKeyboardContext['source'],
  overrides: Partial<WindowWorkspaceKeyboardContext> = {},
): WindowWorkspaceKeyboardContext => ({
  open: true,
  snapshot: snapshot(),
  source,
  ...overrides,
});

const event = (
  key: string,
  overrides: Partial<WindowWorkspaceKeyboardEventLike> = {},
): WindowWorkspaceKeyboardEventLike => ({
  key,
  code: key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  defaultPrevented: false,
  isComposing: false,
  target: null,
  ...overrides,
});

describe('windowWorkspaceKeyboardController global discovery', () => {
  it('exposes a stable visual and ARIA shortcut label', () => {
    expect(WINDOW_WORKSPACE_SHORTCUT_LABEL).toBe('Alt+W');
    expect(WINDOW_WORKSPACE_ARIA_SHORTCUT).toBe('Alt+W');
    const policy = createWindowWorkspaceKeyboardPolicy();
    expect(policy.shortcutLabel).toBe('Alt+W');
    expect(policy.ariaKeyShortcut).toBe('Alt+W');
  });

  it('opens the dock from Alt+W while closed', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true }),
      context('global', { open: false }),
    )).toEqual({ kind: 'open-dock' });
  });

  it('accepts upper-case W from the same chord', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('W', { altKey: true }),
      context('global', { open: false }),
    )).toEqual({ kind: 'open-dock' });
  });

  it('closes the dock from Alt+W while open', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true }),
      context('global', { open: true }),
    )).toEqual({ kind: 'close-dock' });
  });

  it('ignores plain W', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('w'),
      context('global', { open: false }),
    )).toEqual({ kind: 'none' });
  });

  it('ignores Ctrl+Alt+W conflicts', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true, ctrlKey: true }),
      context('global', { open: false }),
    )).toEqual({ kind: 'none' });
  });

  it('ignores Meta+Alt+W conflicts', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true, metaKey: true }),
      context('global', { open: false }),
    )).toEqual({ kind: 'none' });
  });

  it('ignores Shift+Alt+W conflicts', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true, shiftKey: true }),
      context('global', { open: false }),
    )).toEqual({ kind: 'none' });
  });

  it('ignores key repeats for the global toggle', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true, repeat: true }),
      context('global', { open: false }),
    )).toEqual({ kind: 'none' });
  });

  it('ignores globally consumed events', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true, defaultPrevented: true }),
      context('global', { open: false }),
    )).toEqual({ kind: 'none' });
  });

  it('ignores composing global events', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true, isComposing: true }),
      context('global', { open: false }),
    )).toEqual({ kind: 'none' });
  });

  it('ignores native composing global events', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true, nativeEvent: { isComposing: true } }),
      context('global', { open: false }),
    )).toEqual({ kind: 'none' });
  });

  it('ignores dead-key and process-key events', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('Dead'), context('global'))).toEqual({ kind: 'none' });
    expect(evaluateWindowWorkspaceKeyboard(event('Process'), context('global'))).toEqual({ kind: 'none' });
  });

  it('ignores global shortcut while a text input owns the event', () => {
    const input = document.createElement('input');
    input.type = 'text';
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true, target: input }),
      context('global', { open: false }),
    )).toEqual({ kind: 'none' });
  });

  it('ignores global shortcut while a textarea owns the event', () => {
    const target = document.createElement('textarea');
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true, target }),
      context('global', { open: false }),
    )).toEqual({ kind: 'none' });
  });

  it('ignores global shortcut while contenteditable owns the event', () => {
    const target = document.createElement('div');
    target.contentEditable = 'true';
    Object.defineProperty(target, 'isContentEditable', { configurable: true, value: true });
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true, target }),
      context('global', { open: false }),
    )).toEqual({ kind: 'none' });
  });

  it('allows the global shortcut when a button owns the event', () => {
    const target = document.createElement('button');
    expect(evaluateWindowWorkspaceKeyboard(
      event('w', { altKey: true, target }),
      context('global', { open: false }),
    )).toEqual({ kind: 'open-dock' });
  });
});

describe('windowWorkspaceKeyboardController search navigation', () => {
  it('maps ArrowDown to next movement', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('ArrowDown'), context('search')))
      .toEqual({ kind: 'move', move: 'next' });
  });

  it('maps ArrowUp to previous movement', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('ArrowUp'), context('search')))
      .toEqual({ kind: 'move', move: 'previous' });
  });

  it('maps Home and End to collection edges', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('Home'), context('search')))
      .toEqual({ kind: 'move', move: 'first' });
    expect(evaluateWindowWorkspaceKeyboard(event('End'), context('search')))
      .toEqual({ kind: 'move', move: 'last' });
  });

  it('maps PageDown and PageUp to bounded paging', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('PageDown'), context('search')))
      .toEqual({ kind: 'move', move: 'page-next' });
    expect(evaluateWindowWorkspaceKeyboard(event('PageUp'), context('search')))
      .toEqual({ kind: 'move', move: 'page-previous' });
  });

  it('returns no movement for an empty result set', () => {
    const empty = snapshot({ entries: Object.freeze([]), resultCount: 0, activeEntryId: null });
    expect(evaluateWindowWorkspaceKeyboard(event('ArrowDown'), context('search', { snapshot: empty })))
      .toEqual({ kind: 'none' });
  });

  it('activates the selected entry with Enter', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('Enter'), context('search')))
      .toEqual({ kind: 'activate', windowId: 'park-query-window' });
  });

  it('activates the selected entry with Space', () => {
    expect(evaluateWindowWorkspaceKeyboard(event(' '), context('search')))
      .toEqual({ kind: 'activate', windowId: 'park-query-window' });
  });

  it('rejects repeated activation keys', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('Enter', { repeat: true }), context('search')))
      .toEqual({ kind: 'none' });
    expect(evaluateWindowWorkspaceKeyboard(event(' ', { repeat: true }), context('search')))
      .toEqual({ kind: 'none' });
  });

  it('clears a non-empty query before closing on Escape', () => {
    const filtered = snapshot({ query: 'park', normalizedQuery: 'park' });
    expect(evaluateWindowWorkspaceKeyboard(event('Escape'), context('search', { snapshot: filtered })))
      .toEqual({ kind: 'clear-query' });
  });

  it('closes on Escape when the query is already empty', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('Escape'), context('search')))
      .toEqual({ kind: 'close-dock' });
  });

  it('ignores Ctrl-modified movement keys', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('ArrowDown', { ctrlKey: true }), context('search')))
      .toEqual({ kind: 'none' });
  });

  it('ignores Meta-modified activation keys', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('Enter', { metaKey: true }), context('search')))
      .toEqual({ kind: 'none' });
  });

  it('ignores Alt-modified collection navigation', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('Home', { altKey: true }), context('search')))
      .toEqual({ kind: 'none' });
  });
});

describe('windowWorkspaceKeyboardController entry navigation', () => {
  it('activates the current row when one is supplied', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('Enter'),
      context('entry', { currentWindowId: 'measurement-widget' }),
    )).toEqual({ kind: 'activate', windowId: 'measurement-widget' });
  });

  it('falls back to the snapshot selection when current row is unknown', () => {
    expect(evaluateWindowWorkspaceKeyboard(
      event('Enter'),
      context('entry', { currentWindowId: 'missing' }),
    )).toEqual({ kind: 'activate', windowId: 'park-query-window' });
  });

  it('focuses search from slash', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('/'), context('entry')))
      .toEqual({ kind: 'focus-search' });
  });

  it('does not repeat the slash focus shortcut', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('/', { repeat: true }), context('entry')))
      .toEqual({ kind: 'none' });
  });

  it('retains Arrow navigation on entries', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('ArrowDown'), context('entry')))
      .toEqual({ kind: 'move', move: 'next' });
  });

  it('closes from entry Escape when no query is active', () => {
    expect(evaluateWindowWorkspaceKeyboard(event('Escape'), context('entry')))
      .toEqual({ kind: 'close-dock' });
  });

  it('clears search first from entry Escape when a query is active', () => {
    const filtered = snapshot({ query: 'ölçüm', normalizedQuery: 'olcum' });
    expect(evaluateWindowWorkspaceKeyboard(event('Escape'), context('entry', { snapshot: filtered })))
      .toEqual({ kind: 'clear-query' });
  });

  it('returns none when no selected result exists', () => {
    const empty = snapshot({
      activeEntryId: null,
      resultCount: 0,
      entries: Object.freeze([]),
    });
    expect(evaluateWindowWorkspaceKeyboard(
      event('Enter'),
      context('entry', { snapshot: empty, currentWindowId: null }),
    )).toEqual({ kind: 'none' });
  });
});

describe('windowWorkspaceKeyboardController help contracts', () => {
  it('documents search keyboard behavior', () => {
    expect(windowWorkspaceKeyboardHelp.search).toMatch(/Aşağı ve yukarı/);
    expect(windowWorkspaceKeyboardHelp.search).toMatch(/Enter/);
  });

  it('documents entry keyboard behavior', () => {
    expect(windowWorkspaceKeyboardHelp.entry).toMatch(/eğik çizgi/);
  });

  it('documents the global discovery chord', () => {
    expect(windowWorkspaceKeyboardHelp.global).toContain('Alt+W');
  });

  it('returns a frozen reusable policy', () => {
    const policy = createWindowWorkspaceKeyboardPolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.evaluate(event('ArrowDown'), context('search')))
      .toEqual({ kind: 'move', move: 'next' });
  });
});
