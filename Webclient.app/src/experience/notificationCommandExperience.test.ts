import {
  createNotificationCommandDefinitions,
  createNotificationCommandSnapshot,
  moveNotificationCommandFocus,
  resolveNotificationCommandIntent,
  type NotificationCommandItem,
} from './notificationCommandExperience';

const items: readonly NotificationCommandItem[] = [
  { id: 'one', title: 'Birinci bildirim', read: false, important: false, dismissible: true },
  { id: 'two', title: 'İkinci bildirim', read: true, important: true, dismissible: false },
  { id: 'three', title: 'Üçüncü bildirim', read: false, important: true, dismissible: true },
];

describe('notificationCommandExperience', () => {
  test('creates a bounded all-items snapshot with deterministic metrics', () => {
    const snapshot = createNotificationCommandSnapshot(items);
    expect(snapshot).toMatchObject({
      scope: 'all',
      itemIds: ['one', 'two', 'three'],
      activeId: 'one',
      activeIndex: 0,
      count: 3,
      unreadCount: 2,
      importantCount: 2,
      canMarkActiveRead: true,
      canMarkAllRead: true,
      canClearRead: true,
      canDismissActive: true,
      summary: '3 bildirim, 2 okunmamış, 2 önemli.',
    });
  });

  test('preserves a valid requested active item', () => {
    const snapshot = createNotificationCommandSnapshot(items, { activeId: 'three' });
    expect(snapshot.activeId).toBe('three');
    expect(snapshot.activeIndex).toBe(2);
  });

  test('falls back to the first visible item when active id is absent', () => {
    const snapshot = createNotificationCommandSnapshot(items, { activeId: 'missing' });
    expect(snapshot.activeId).toBe('one');
    expect(snapshot.activeIndex).toBe(0);
  });

  test('filters unread items before active reconciliation', () => {
    const snapshot = createNotificationCommandSnapshot(items, {
      scope: 'unread',
      activeId: 'two',
    });
    expect(snapshot.itemIds).toEqual(['one', 'three']);
    expect(snapshot.activeId).toBe('one');
    expect(snapshot.unreadCount).toBe(2);
    expect(snapshot.canClearRead).toBe(false);
  });

  test('filters important items without changing source order', () => {
    const snapshot = createNotificationCommandSnapshot(items, { scope: 'important' });
    expect(snapshot.itemIds).toEqual(['two', 'three']);
    expect(snapshot.activeId).toBe('two');
    expect(snapshot.importantCount).toBe(2);
  });

  test('returns a stable empty snapshot', () => {
    const snapshot = createNotificationCommandSnapshot([]);
    expect(snapshot).toMatchObject({
      itemIds: [],
      activeId: null,
      activeIndex: -1,
      count: 0,
      unreadCount: 0,
      importantCount: 0,
      canMarkActiveRead: false,
      canMarkAllRead: false,
      canClearRead: false,
      canDismissActive: false,
      summary: 'Bildirim yok.',
    });
  });

  test('rejects duplicate and unsafe ids while preserving first valid item', () => {
    const snapshot = createNotificationCommandSnapshot([
      ...items,
      { id: 'one', title: 'Duplicate', read: false, important: false, dismissible: true },
      { id: 'bad\nvalue', title: 'Unsafe', read: false, important: false, dismissible: true },
      { id: '   ', title: 'Blank id', read: false, important: false, dismissible: true },
    ]);
    expect(snapshot.itemIds).toEqual(['one', 'two', 'three']);
  });

  test('rejects blank titles and normalizes bounded whitespace', () => {
    const snapshot = createNotificationCommandSnapshot([
      { id: 'blank', title: '   ', read: false, important: false, dismissible: true },
      { id: 'valid', title: '  Geçerli   bildirim  ', read: false, important: false, dismissible: true },
    ]);
    expect(snapshot.itemIds).toEqual(['valid']);
  });

  test('caps admitted command items to the notification center budget', () => {
    const many = Array.from({ length: 140 }, (_, index): NotificationCommandItem => ({
      id: `item-${index}`,
      title: `Bildirim ${index}`,
      read: false,
      important: false,
      dismissible: true,
    }));
    const snapshot = createNotificationCommandSnapshot(many);
    expect(snapshot.count).toBe(96);
    expect(snapshot.itemIds.at(-1)).toBe('item-95');
  });

  test.each([
    ['ArrowDown', 'next'],
    ['j', 'next'],
    ['ArrowUp', 'previous'],
    ['k', 'previous'],
    ['Home', 'first'],
    ['End', 'last'],
  ] as const)('maps %s to bounded focus direction %s', (key, direction) => {
    const snapshot = createNotificationCommandSnapshot(items);
    expect(resolveNotificationCommandIntent({ key }, snapshot)).toEqual({
      type: 'focus',
      direction,
    });
  });

  test('maps Enter and Space to mark-active-read only when useful', () => {
    const unread = createNotificationCommandSnapshot(items);
    expect(resolveNotificationCommandIntent({ key: 'Enter' }, unread)).toEqual({ type: 'mark-active-read' });
    expect(resolveNotificationCommandIntent({ key: ' ' }, unread)).toEqual({ type: 'mark-active-read' });

    const read = createNotificationCommandSnapshot(items, { activeId: 'two' });
    expect(resolveNotificationCommandIntent({ key: 'Enter' }, read)).toEqual({ type: 'none' });
  });

  test('maps Shift+A to mark-all-read only when unread items exist', () => {
    const snapshot = createNotificationCommandSnapshot(items);
    expect(resolveNotificationCommandIntent({ key: 'A', shiftKey: true }, snapshot)).toEqual({ type: 'mark-all-read' });
    const allRead = createNotificationCommandSnapshot(items.map((item) => ({ ...item, read: true })));
    expect(resolveNotificationCommandIntent({ key: 'a', shiftKey: true }, allRead)).toEqual({ type: 'none' });
  });

  test('maps Shift+C to clear-read only when read items exist', () => {
    const snapshot = createNotificationCommandSnapshot(items);
    expect(resolveNotificationCommandIntent({ key: 'C', shiftKey: true }, snapshot)).toEqual({ type: 'clear-read' });
    const unread = createNotificationCommandSnapshot(items.map((item) => ({ ...item, read: false })));
    expect(resolveNotificationCommandIntent({ key: 'c', shiftKey: true }, unread)).toEqual({ type: 'none' });
  });

  test('maps Delete and Backspace only for dismissible active items', () => {
    const dismissible = createNotificationCommandSnapshot(items);
    expect(resolveNotificationCommandIntent({ key: 'Delete' }, dismissible)).toEqual({ type: 'dismiss-active' });
    expect(resolveNotificationCommandIntent({ key: 'Backspace' }, dismissible)).toEqual({ type: 'dismiss-active' });
    const fixed = createNotificationCommandSnapshot(items, { activeId: 'two' });
    expect(resolveNotificationCommandIntent({ key: 'Delete' }, fixed)).toEqual({ type: 'none' });
  });

  test('maps Alt+N to center discovery even from an editable field', () => {
    const snapshot = createNotificationCommandSnapshot(items);
    expect(resolveNotificationCommandIntent({
      key: 'n',
      altKey: true,
      target: { tagName: 'INPUT' },
    }, snapshot)).toEqual({ type: 'open-center' });
  });

  test.each(['INPUT', 'TEXTAREA', 'SELECT'])('ignores list commands in %s', (tagName) => {
    const snapshot = createNotificationCommandSnapshot(items);
    expect(resolveNotificationCommandIntent({
      key: 'ArrowDown',
      target: { tagName },
    }, snapshot)).toEqual({ type: 'none' });
  });

  test.each(['textbox', 'searchbox', 'combobox'])('ignores list commands for %s roles', (role) => {
    const snapshot = createNotificationCommandSnapshot(items);
    expect(resolveNotificationCommandIntent({
      key: 'ArrowDown',
      target: { tagName: 'DIV', role },
    }, snapshot)).toEqual({ type: 'none' });
  });

  test('ignores list commands in contenteditable content', () => {
    const snapshot = createNotificationCommandSnapshot(items);
    expect(resolveNotificationCommandIntent({
      key: 'ArrowDown',
      target: { tagName: 'DIV', isContentEditable: true },
    }, snapshot)).toEqual({ type: 'none' });
  });

  test.each([
    { key: 'ArrowDown', isComposing: true },
    { key: 'ArrowDown', repeat: true },
    { key: 'ArrowDown', defaultPrevented: true },
    { key: 'ArrowDown', ctrlKey: true },
    { key: 'ArrowDown', metaKey: true },
    { key: 'ArrowDown', altKey: true },
    { key: 'ArrowDown', shiftKey: true },
  ])('rejects unsafe or modified navigation event %#', (event) => {
    const snapshot = createNotificationCommandSnapshot(items);
    expect(resolveNotificationCommandIntent(event, snapshot)).toEqual({ type: 'none' });
  });

  test('does not trigger Alt+N with conflicting modifiers', () => {
    const snapshot = createNotificationCommandSnapshot(items);
    expect(resolveNotificationCommandIntent({ key: 'n', altKey: true, ctrlKey: true }, snapshot)).toEqual({ type: 'none' });
    expect(resolveNotificationCommandIntent({ key: 'n', altKey: true, shiftKey: true }, snapshot)).toEqual({ type: 'none' });
  });

  test('does not navigate an empty collection', () => {
    const snapshot = createNotificationCommandSnapshot([]);
    expect(resolveNotificationCommandIntent({ key: 'ArrowDown' }, snapshot)).toEqual({ type: 'none' });
    expect(moveNotificationCommandFocus(snapshot, 'next')).toBeNull();
  });

  test('moves focus next with wrap-around', () => {
    const snapshot = createNotificationCommandSnapshot(items, { activeId: 'three' });
    expect(moveNotificationCommandFocus(snapshot, 'next')).toBe('one');
  });

  test('moves focus previous with wrap-around', () => {
    const snapshot = createNotificationCommandSnapshot(items, { activeId: 'one' });
    expect(moveNotificationCommandFocus(snapshot, 'previous')).toBe('three');
  });

  test('moves focus directly to first and last', () => {
    const snapshot = createNotificationCommandSnapshot(items, { activeId: 'two' });
    expect(moveNotificationCommandFocus(snapshot, 'first')).toBe('one');
    expect(moveNotificationCommandFocus(snapshot, 'last')).toBe('three');
  });

  test('publishes deterministic command definitions and enabled state', () => {
    const snapshot = createNotificationCommandSnapshot(items);
    const definitions = createNotificationCommandDefinitions(snapshot);
    expect(definitions.map((definition) => definition.action)).toEqual([
      'open-center',
      'focus-next',
      'focus-previous',
      'mark-active-read',
      'mark-all-read',
      'clear-read',
      'dismiss-active',
    ]);
    expect(definitions[0]).toMatchObject({
      id: 'notification-open-center',
      shortcut: 'Alt+N',
      enabled: true,
    });
    expect(definitions.find((definition) => definition.action === 'clear-read')?.enabled).toBe(true);
  });

  test('disables item commands for an empty snapshot while preserving discovery', () => {
    const definitions = createNotificationCommandDefinitions(createNotificationCommandSnapshot([]));
    expect(definitions[0]?.enabled).toBe(true);
    expect(definitions.slice(1).every((definition) => !definition.enabled)).toBe(true);
  });
});
