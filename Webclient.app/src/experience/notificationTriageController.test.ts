import {
  createNotificationTriageCommandDefinitions,
  resolveNotificationTriageIntent,
} from './notificationTriageController';
import type { NotificationTriageSnapshot } from './notificationTriageModel';

const snapshot = (overrides: Partial<NotificationTriageSnapshot> = {}): NotificationTriageSnapshot => Object.freeze({
  revision: 1,
  query: '',
  normalizedQuery: '',
  scope: 'all',
  sort: 'newest',
  activeId: 'one',
  activeIndex: 0,
  entries: Object.freeze([
    Object.freeze({
      id: 'one',
      title: 'Bir',
      message: '',
      category: 'general',
      tone: 'info',
      read: false,
      important: false,
      urgent: false,
      dismissible: true,
      actionable: false,
      createdAt: 2,
      occurrenceCount: 1,
      position: 1,
      setSize: 2,
      selected: true,
    }),
    Object.freeze({
      id: 'two',
      title: 'İki',
      message: '',
      category: 'general',
      tone: 'warning',
      read: true,
      important: true,
      urgent: false,
      dismissible: false,
      actionable: true,
      createdAt: 1,
      occurrenceCount: 1,
      position: 2,
      setSize: 2,
      selected: false,
    }),
  ]),
  resultCount: 2,
  totalCount: 2,
  unreadCount: 1,
  importantCount: 1,
  urgentCount: 0,
  actionableCount: 1,
  announcement: '2 bildirim hızlı erişime hazır.',
  emptyReason: 'none',
  ...overrides,
});

const inputTarget = Object.freeze({ tagName: 'INPUT', role: 'combobox' });

describe('notificationTriageController', () => {
  test('focuses search with slash outside editable controls', () => {
    expect(resolveNotificationTriageIntent({ key: '/' }, snapshot())).toEqual({ type: 'focus-search' });
  });

  test('does not hijack slash in editable controls', () => {
    expect(resolveNotificationTriageIntent({ key: '/', target: inputTarget }, snapshot())).toEqual({ type: 'none' });
  });

  test('moves next and previous from search using arrow keys', () => {
    expect(resolveNotificationTriageIntent({ key: 'ArrowDown', target: inputTarget }, snapshot())).toEqual({ type: 'move', move: 'next' });
    expect(resolveNotificationTriageIntent({ key: 'ArrowUp', target: inputTarget }, snapshot())).toEqual({ type: 'move', move: 'previous' });
  });

  test('supports vim-style j and k only outside editable controls', () => {
    expect(resolveNotificationTriageIntent({ key: 'j' }, snapshot())).toEqual({ type: 'move', move: 'next' });
    expect(resolveNotificationTriageIntent({ key: 'K' }, snapshot())).toEqual({ type: 'move', move: 'previous' });
    expect(resolveNotificationTriageIntent({ key: 'j', target: inputTarget }, snapshot())).toEqual({ type: 'none' });
  });

  test('supports Home End PageUp and PageDown outside editable controls', () => {
    expect(resolveNotificationTriageIntent({ key: 'Home' }, snapshot())).toEqual({ type: 'move', move: 'first' });
    expect(resolveNotificationTriageIntent({ key: 'End' }, snapshot())).toEqual({ type: 'move', move: 'last' });
    expect(resolveNotificationTriageIntent({ key: 'PageDown' }, snapshot())).toEqual({ type: 'move', move: 'page-next' });
    expect(resolveNotificationTriageIntent({ key: 'PageUp' }, snapshot())).toEqual({ type: 'move', move: 'page-previous' });
    expect(resolveNotificationTriageIntent({ key: 'Home', target: inputTarget }, snapshot())).toEqual({ type: 'none' });
  });

  test('clears a query with Escape even from the search input', () => {
    expect(resolveNotificationTriageIntent({ key: 'Escape', target: inputTarget }, snapshot({ query: 'katman' }))).toEqual({ type: 'clear-query' });
  });

  test('does nothing for Escape when query is already empty', () => {
    expect(resolveNotificationTriageIntent({ key: 'Escape' }, snapshot())).toEqual({ type: 'none' });
  });

  test('marks the active unread item with Enter or Space', () => {
    expect(resolveNotificationTriageIntent({ key: 'Enter' }, snapshot())).toEqual({ type: 'mark-active-read', id: 'one' });
    expect(resolveNotificationTriageIntent({ key: ' ' }, snapshot())).toEqual({ type: 'mark-active-read', id: 'one' });
  });

  test('does not mark read while typing in search', () => {
    expect(resolveNotificationTriageIntent({ key: 'Enter', target: inputTarget }, snapshot())).toEqual({ type: 'none' });
  });

  test('does not emit mark-read when active item is already read', () => {
    expect(resolveNotificationTriageIntent({ key: 'Enter' }, snapshot({ activeId: 'two', activeIndex: 1 }))).toEqual({ type: 'none' });
  });

  test('dismisses only a dismissible active item', () => {
    expect(resolveNotificationTriageIntent({ key: 'Delete' }, snapshot())).toEqual({ type: 'dismiss-active', id: 'one' });
    expect(resolveNotificationTriageIntent({ key: 'Backspace' }, snapshot())).toEqual({ type: 'dismiss-active', id: 'one' });
    expect(resolveNotificationTriageIntent({ key: 'Delete' }, snapshot({ activeId: 'two', activeIndex: 1 }))).toEqual({ type: 'none' });
  });

  test('keeps destructive keys inactive in editable controls', () => {
    expect(resolveNotificationTriageIntent({ key: 'Delete', target: inputTarget }, snapshot())).toEqual({ type: 'none' });
    expect(resolveNotificationTriageIntent({ key: 'Backspace', target: inputTarget }, snapshot())).toEqual({ type: 'none' });
  });

  test('supports bounded bulk actions with shift chords', () => {
    expect(resolveNotificationTriageIntent({ key: 'a', shiftKey: true }, snapshot())).toEqual({ type: 'mark-all-read' });
    expect(resolveNotificationTriageIntent({ key: 'C', shiftKey: true }, snapshot())).toEqual({ type: 'clear-read' });
  });

  test('does not emit disabled bulk actions', () => {
    expect(resolveNotificationTriageIntent({ key: 'a', shiftKey: true }, snapshot({ unreadCount: 0 }))).toEqual({ type: 'none' });
    expect(resolveNotificationTriageIntent({ key: 'c', shiftKey: true }, snapshot({ unreadCount: 2, totalCount: 2 }))).toEqual({ type: 'none' });
  });

  test('ignores repeated, composing and already-consumed events', () => {
    expect(resolveNotificationTriageIntent({ key: 'ArrowDown', repeat: true }, snapshot())).toEqual({ type: 'none' });
    expect(resolveNotificationTriageIntent({ key: 'ArrowDown', isComposing: true }, snapshot())).toEqual({ type: 'none' });
    expect(resolveNotificationTriageIntent({ key: 'ArrowDown', defaultPrevented: true }, snapshot())).toEqual({ type: 'none' });
  });

  test('ignores movement when there are no results', () => {
    const empty = snapshot({ entries: Object.freeze([]), resultCount: 0, activeId: null, activeIndex: -1 });
    expect(resolveNotificationTriageIntent({ key: 'ArrowDown' }, empty)).toEqual({ type: 'none' });
    expect(resolveNotificationTriageIntent({ key: 'End' }, empty)).toEqual({ type: 'none' });
  });

  test('does not allow unrelated modifiers to trigger plain commands', () => {
    expect(resolveNotificationTriageIntent({ key: 'j', ctrlKey: true }, snapshot())).toEqual({ type: 'none' });
    expect(resolveNotificationTriageIntent({ key: 'Delete', altKey: true }, snapshot())).toEqual({ type: 'none' });
    expect(resolveNotificationTriageIntent({ key: 'a', shiftKey: true, ctrlKey: true }, snapshot())).toEqual({ type: 'none' });
  });

  test('creates deterministic command definitions from current state', () => {
    const definitions = createNotificationTriageCommandDefinitions(snapshot());
    expect(definitions.map((definition) => definition.id)).toEqual([
      'triage-focus-search',
      'triage-next',
      'triage-previous',
      'triage-read',
      'triage-dismiss',
      'triage-mark-all',
      'triage-clear-read',
    ]);
    expect(definitions.find((definition) => definition.id === 'triage-read')).toMatchObject({ enabled: true, shortcut: 'Enter' });
    expect(definitions.find((definition) => definition.id === 'triage-mark-all')).toMatchObject({ enabled: true, shortcut: 'Shift+A' });
  });

  test('disables command definitions that have no valid target', () => {
    const definitions = createNotificationTriageCommandDefinitions(snapshot({
      activeId: 'two',
      activeIndex: 1,
      unreadCount: 0,
      totalCount: 1,
      entries: Object.freeze([snapshot().entries[1]!]),
      resultCount: 1,
    }));
    expect(definitions.find((definition) => definition.id === 'triage-read')?.enabled).toBe(false);
    expect(definitions.find((definition) => definition.id === 'triage-dismiss')?.enabled).toBe(false);
    expect(definitions.find((definition) => definition.id === 'triage-mark-all')?.enabled).toBe(false);
    expect(definitions.find((definition) => definition.id === 'triage-clear-read')?.enabled).toBe(true);
  });
});
