import { describe, expect, it } from 'vitest';
import type { NotificationCenterSnapshot, NotificationItem } from './notificationCenterModel';
import {
  NOTIFICATION_TRIAGE_SCOPES,
  createNotificationTriageSnapshot,
  createNotificationTriageState,
  notificationTriageKeyboardHelp,
  resolveNotificationTriageEffect,
  setNotificationTriageActive,
  setNotificationTriageExpanded,
  setNotificationTriageScope,
  toggleNotificationTriage,
} from './notificationTriageExperience';

const item = (
  id: string,
  options: Partial<NotificationItem> = {},
): NotificationItem => Object.freeze({
  id,
  title: `Bildirim ${id}`,
  message: `${id} ayrıntısı`,
  tone: 'info',
  priority: 'normal',
  category: 'general',
  dismissible: true,
  sticky: false,
  createdAt: 100,
  expiresAt: null,
  dedupeKey: null,
  actions: Object.freeze([]),
  read: false,
  occurrenceCount: 1,
  ...options,
});

const center = (
  items: readonly NotificationItem[],
  revision = 1,
): NotificationCenterSnapshot => {
  const unread = items.filter((candidate) => !candidate.read);
  return Object.freeze({
    items: Object.freeze([...items]),
    unreadCount: unread.length,
    urgentUnreadCount: unread.filter((candidate) => candidate.priority === 'urgent' || candidate.tone === 'error').length,
    categories: Object.freeze([...new Set(items.map((candidate) => candidate.category))]),
    announcement: null,
    revision,
  });
};

const keyboard = (
  key: string,
  options: Partial<Parameters<typeof resolveNotificationTriageEffect>[0]> = {},
) => ({ key, ...options });

describe('notificationTriageExperience', () => {
  it('creates a collapsed all-scope state by default', () => {
    expect(createNotificationTriageState()).toEqual({
      revision: 0,
      expanded: false,
      scope: 'all',
      activeId: null,
    });
  });

  it('publishes stable scope metadata for the UI', () => {
    expect(NOTIFICATION_TRIAGE_SCOPES).toEqual([
      { id: 'all', label: 'Tüm bildirimler', shortLabel: 'Tümü' },
      { id: 'unread', label: 'Okunmamış bildirimler', shortLabel: 'Okunmamış' },
      { id: 'important', label: 'Önemli bildirimler', shortLabel: 'Önemli' },
    ]);
    expect(Object.isFrozen(NOTIFICATION_TRIAGE_SCOPES)).toBe(true);
  });

  it('toggles expansion with monotonic revisions', () => {
    const initial = createNotificationTriageState();
    const opened = toggleNotificationTriage(initial);
    expect(opened.expanded).toBe(true);
    expect(opened.revision).toBe(1);
    const closed = setNotificationTriageExpanded(opened, false);
    expect(closed.expanded).toBe(false);
    expect(closed.revision).toBe(2);
    expect(setNotificationTriageExpanded(closed, false)).toBe(closed);
  });

  it('resets active identity when scope changes', () => {
    const active = setNotificationTriageActive(createNotificationTriageState(), 'b');
    const filtered = setNotificationTriageScope(active, 'unread');
    expect(filtered).toMatchObject({ scope: 'unread', activeId: null });
    expect(filtered.revision).toBe(2);
    expect(setNotificationTriageScope(filtered, 'unread')).toBe(filtered);
  });

  it('derives unread, important and total metrics from the canonical center snapshot', () => {
    const snapshot = createNotificationTriageSnapshot(center([
      item('a'),
      item('b', { read: true }),
      item('c', { tone: 'warning' }),
      item('d', { priority: 'urgent' }),
    ]), createNotificationTriageState());
    expect(snapshot).toMatchObject({
      totalCount: 4,
      visibleCount: 4,
      unreadCount: 3,
      importantCount: 2,
      activeId: 'a',
      shouldSurface: true,
    });
    expect(snapshot.command.summary).toBe('4 bildirim, 3 okunmamış, 2 önemli.');
  });

  it('treats warning, error and urgent notifications as important', () => {
    const source = center([
      item('info'),
      item('warning', { tone: 'warning' }),
      item('error', { tone: 'error' }),
      item('urgent', { priority: 'urgent' }),
    ]);
    const state = setNotificationTriageScope(createNotificationTriageState(), 'important');
    const snapshot = createNotificationTriageSnapshot(source, state);
    expect(snapshot.command.itemIds).toEqual(['warning', 'error', 'urgent']);
    expect(snapshot.visibleCount).toBe(3);
    expect(snapshot.importantCount).toBe(3);
  });

  it('filters unread notifications without mutating the canonical source', () => {
    const sourceItems = [item('a', { read: true }), item('b'), item('c')];
    const source = center(sourceItems);
    const state = setNotificationTriageScope(createNotificationTriageState(), 'unread');
    const snapshot = createNotificationTriageSnapshot(source, state);
    expect(snapshot.command.itemIds).toEqual(['b', 'c']);
    expect(snapshot.items.map((candidate) => candidate.id)).toEqual(['b', 'c']);
    expect(source.items.map((candidate) => candidate.id)).toEqual(['a', 'b', 'c']);
  });

  it('shows a scope-specific empty message', () => {
    const allRead = center([item('a', { read: true })]);
    const unreadState = setNotificationTriageScope(createNotificationTriageState(), 'unread');
    expect(createNotificationTriageSnapshot(allRead, unreadState).emptyText).toContain('Tüm bildirimler okundu');

    const normal = center([item('a')]);
    const importantState = setNotificationTriageScope(createNotificationTriageState(), 'important');
    expect(createNotificationTriageSnapshot(normal, importantState).emptyText).toContain('önemli veya acil');

    expect(createNotificationTriageSnapshot(center([]), createNotificationTriageState()).emptyText).toContain('Henüz');
  });

  it('surfaces only when unread or urgent unread work exists', () => {
    expect(createNotificationTriageSnapshot(center([]), createNotificationTriageState()).shouldSurface).toBe(false);
    expect(createNotificationTriageSnapshot(center([item('read', { read: true })]), createNotificationTriageState()).shouldSurface).toBe(false);
    expect(createNotificationTriageSnapshot(center([item('unread')]), createNotificationTriageState()).shouldSurface).toBe(true);
    expect(createNotificationTriageSnapshot(center([item('urgent', { priority: 'urgent' })]), createNotificationTriageState()).shouldSurface).toBe(true);
  });

  it('bounds preview size while preserving full collection metadata', () => {
    const source = center(Array.from({ length: 12 }, (_, index) => item(`n-${index + 1}`)));
    const snapshot = createNotificationTriageSnapshot(source, createNotificationTriageState());
    expect(snapshot.items).toHaveLength(6);
    expect(snapshot.visibleCount).toBe(12);
    expect(snapshot.previewStart).toBe(0);
    expect(snapshot.previewEnd).toBe(6);
    expect(snapshot.items[0]).toMatchObject({ position: 1, setSize: 12 });
    expect(snapshot.items[5]).toMatchObject({ position: 6, setSize: 12 });
    expect(snapshot.statusText).toContain('1-6 arası hızlı listede');
  });

  it('centers the preview window around an active item when possible', () => {
    const source = center(Array.from({ length: 12 }, (_, index) => item(`n-${index + 1}`)));
    const state = setNotificationTriageActive(createNotificationTriageState(), 'n-9');
    const snapshot = createNotificationTriageSnapshot(source, state);
    expect(snapshot.activeId).toBe('n-9');
    expect(snapshot.previewStart).toBeGreaterThan(0);
    expect(snapshot.items.some((candidate) => candidate.id === 'n-9' && candidate.active)).toBe(true);
    expect(snapshot.items).toHaveLength(6);
  });

  it('keeps the end of a large collection in a bounded final window', () => {
    const source = center(Array.from({ length: 10 }, (_, index) => item(`n-${index + 1}`)));
    const state = setNotificationTriageActive(createNotificationTriageState(), 'n-10');
    const snapshot = createNotificationTriageSnapshot(source, state, { previewLimit: 4 });
    expect(snapshot.previewStart).toBe(6);
    expect(snapshot.previewEnd).toBe(10);
    expect(snapshot.items.map((candidate) => candidate.id)).toEqual(['n-7', 'n-8', 'n-9', 'n-10']);
  });

  it('clamps preview limits to the supported range', () => {
    const source = center(Array.from({ length: 12 }, (_, index) => item(`n-${index}`)));
    expect(createNotificationTriageSnapshot(source, createNotificationTriageState(), { previewLimit: 1 }).previewLimit).toBe(3);
    expect(createNotificationTriageSnapshot(source, createNotificationTriageState(), { previewLimit: 200 }).previewLimit).toBe(8);
    expect(createNotificationTriageSnapshot(source, createNotificationTriageState(), { previewLimit: Number.NaN }).previewLimit).toBe(6);
  });

  it('creates deterministic semantic ids without leaking unsafe notification ids into DOM ids', () => {
    const snapshot = createNotificationTriageSnapshot(center([item('  Çalışma/Alanı:42  ')]), createNotificationTriageState());
    expect(snapshot.items[0]?.semanticId).toMatch(/^experience-notification-triage-/u);
    expect(snapshot.items[0]?.semanticId).not.toContain('/');
    expect(snapshot.items[0]?.semanticId).not.toContain(':');
  });

  it('preserves presentation details required by quick triage cards', () => {
    const snapshot = createNotificationTriageSnapshot(center([
      item('a', {
        message: 'Katman yüklenemedi',
        category: 'Katmanlar',
        tone: 'error',
        priority: 'urgent',
        occurrenceCount: 3,
        dismissible: false,
      }),
    ]), createNotificationTriageState());
    expect(snapshot.items[0]).toMatchObject({
      title: 'Bildirim a',
      message: 'Katman yüklenemedi',
      category: 'Katmanlar',
      tone: 'error',
      priority: 'urgent',
      important: true,
      occurrenceCount: 3,
      dismissible: false,
      active: true,
    });
  });

  it('resolves next and previous navigation through the shared command policy', () => {
    const snapshot = createNotificationTriageSnapshot(center([item('a'), item('b'), item('c')]), createNotificationTriageState());
    expect(resolveNotificationTriageEffect(keyboard('j'), snapshot)).toEqual({ type: 'focus', id: 'b' });
    expect(resolveNotificationTriageEffect(keyboard('ArrowUp'), snapshot)).toEqual({ type: 'focus', id: 'c' });
  });

  it('resolves first and last focus commands', () => {
    const state = setNotificationTriageActive(createNotificationTriageState(), 'b');
    const snapshot = createNotificationTriageSnapshot(center([item('a'), item('b'), item('c')]), state);
    expect(resolveNotificationTriageEffect(keyboard('Home'), snapshot)).toEqual({ type: 'focus', id: 'a' });
    expect(resolveNotificationTriageEffect(keyboard('End'), snapshot)).toEqual({ type: 'focus', id: 'c' });
  });

  it('resolves mark-read only for an unread active notification', () => {
    const unread = createNotificationTriageSnapshot(center([item('a')]), createNotificationTriageState());
    expect(resolveNotificationTriageEffect(keyboard('Enter'), unread)).toEqual({ type: 'mark-read', id: 'a' });

    const read = createNotificationTriageSnapshot(center([item('a', { read: true })]), createNotificationTriageState());
    expect(resolveNotificationTriageEffect(keyboard('Enter'), read)).toEqual({ type: 'none' });
  });

  it('resolves bulk mark-read and clear-read capabilities from live state', () => {
    const mixed = createNotificationTriageSnapshot(center([item('a'), item('b', { read: true })]), createNotificationTriageState());
    expect(resolveNotificationTriageEffect(keyboard('A', { shiftKey: true }), mixed)).toEqual({ type: 'mark-all-read' });
    expect(resolveNotificationTriageEffect(keyboard('C', { shiftKey: true }), mixed)).toEqual({ type: 'clear-read' });

    const unreadOnly = createNotificationTriageSnapshot(center([item('a')]), createNotificationTriageState());
    expect(resolveNotificationTriageEffect(keyboard('C', { shiftKey: true }), unreadOnly)).toEqual({ type: 'none' });
  });

  it('resolves dismiss only for dismissible active items', () => {
    const removable = createNotificationTriageSnapshot(center([item('a')]), createNotificationTriageState());
    expect(resolveNotificationTriageEffect(keyboard('Delete'), removable)).toEqual({ type: 'dismiss', id: 'a' });

    const protectedItem = createNotificationTriageSnapshot(center([item('a', { dismissible: false })]), createNotificationTriageState());
    expect(resolveNotificationTriageEffect(keyboard('Delete'), protectedItem)).toEqual({ type: 'none' });
  });

  it('resolves the global Alt+N discovery command even from editable targets', () => {
    const snapshot = createNotificationTriageSnapshot(center([item('a')]), createNotificationTriageState());
    expect(resolveNotificationTriageEffect(keyboard('n', {
      altKey: true,
      target: { tagName: 'INPUT' },
    }), snapshot)).toEqual({ type: 'open-center' });
  });

  it('ignores navigation commands from editable targets', () => {
    const snapshot = createNotificationTriageSnapshot(center([item('a'), item('b')]), createNotificationTriageState());
    expect(resolveNotificationTriageEffect(keyboard('j', {
      target: { tagName: 'TEXTAREA' },
    }), snapshot)).toEqual({ type: 'none' });
  });

  it('ignores repeated, composing and default-prevented events', () => {
    const snapshot = createNotificationTriageSnapshot(center([item('a')]), createNotificationTriageState());
    expect(resolveNotificationTriageEffect(keyboard('j', { repeat: true }), snapshot)).toEqual({ type: 'none' });
    expect(resolveNotificationTriageEffect(keyboard('j', { isComposing: true }), snapshot)).toEqual({ type: 'none' });
    expect(resolveNotificationTriageEffect(keyboard('j', { defaultPrevented: true }), snapshot)).toEqual({ type: 'none' });
  });

  it('returns immutable triage items and collections', () => {
    const snapshot = createNotificationTriageSnapshot(center([item('a'), item('b')]), createNotificationTriageState());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(Object.isFrozen(snapshot.items[0])).toBe(true);
  });

  it('publishes dynamic keyboard guidance from capabilities', () => {
    const mixed = createNotificationTriageSnapshot(center([item('a'), item('b', { read: true, dismissible: false })]), createNotificationTriageState());
    const help = notificationTriageKeyboardHelp(mixed);
    expect(help).toHaveLength(5);
    expect(help.join(' ')).toContain('J / K');
    expect(help.join(' ')).toContain('Shift+A');
    expect(help.join(' ')).toContain('Shift+C');
    expect(Object.isFrozen(help)).toBe(true);
  });

  it('uses the center revision when it is newer than local interaction state', () => {
    const state = setNotificationTriageExpanded(createNotificationTriageState(), true);
    const snapshot = createNotificationTriageSnapshot(center([item('a')], 42), state);
    expect(snapshot.revision).toBe(42);
  });
});
