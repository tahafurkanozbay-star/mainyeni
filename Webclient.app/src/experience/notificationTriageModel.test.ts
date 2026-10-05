import { NotificationTriageModel, normalizeNotificationTriageText } from './notificationTriageModel';
import type { NotificationItem } from './notificationCenterModel';

const item = (overrides: Partial<NotificationItem> & Pick<NotificationItem, 'id' | 'title'>): NotificationItem => Object.freeze({
  id: overrides.id,
  title: overrides.title,
  message: overrides.message ?? '',
  tone: overrides.tone ?? 'info',
  priority: overrides.priority ?? 'normal',
  category: overrides.category ?? 'general',
  dismissible: overrides.dismissible ?? true,
  sticky: overrides.sticky ?? false,
  createdAt: overrides.createdAt ?? 1_000,
  expiresAt: overrides.expiresAt ?? null,
  dedupeKey: overrides.dedupeKey ?? null,
  actions: overrides.actions ?? Object.freeze([]),
  read: overrides.read ?? false,
  occurrenceCount: overrides.occurrenceCount ?? 1,
});

const items: readonly NotificationItem[] = Object.freeze([
  item({ id: 'measure', title: 'Ölçüm tamamlandı', message: 'Alan ölçümü hazır', category: 'Harita', createdAt: 4_000, tone: 'success' }),
  item({ id: 'offline', title: 'Bağlantı kesildi', message: 'Çevrimdışı çalışıyorsunuz', category: 'Bağlantı', createdAt: 3_000, tone: 'warning', priority: 'urgent' }),
  item({ id: 'query', title: 'Sorgu sonucu hazır', message: '12 kayıt bulundu', category: 'Sorgu', createdAt: 2_000, read: true, actions: Object.freeze([{ id: 'open', label: 'Sonuçları aç' }]) }),
  item({ id: 'error', title: 'Katman yüklenemedi', message: 'Daha sonra yeniden deneyin', category: 'Katman', createdAt: 1_000, tone: 'error', dismissible: false }),
]);

describe('notificationTriageModel', () => {
  test('normalizes Turkish characters, accents and whitespace for discovery', () => {
    expect(normalizeNotificationTriageText('  ÖLÇÜM   İÇİN  ')).toBe('olcum icin');
    expect(normalizeNotificationTriageText('Çevrimdışı / BAĞLANTI')).toBe('cevrimdisi / baglanti');
  });

  test('starts with an immutable empty snapshot', () => {
    const model = new NotificationTriageModel();
    const snapshot = model.getSnapshot();
    expect(snapshot).toMatchObject({
      revision: 0,
      query: '',
      scope: 'all',
      sort: 'newest',
      activeId: null,
      resultCount: 0,
      totalCount: 0,
      announcement: 'Henüz bildirim yok.',
      emptyReason: 'no-items',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
  });

  test('reconciles notifications and derives deterministic metrics', () => {
    const model = new NotificationTriageModel();
    model.reconcile(items);
    expect(model.getSnapshot()).toMatchObject({
      totalCount: 4,
      resultCount: 4,
      unreadCount: 3,
      importantCount: 2,
      urgentCount: 2,
      actionableCount: 1,
      activeId: 'measure',
      announcement: '4 bildirim hızlı erişime hazır.',
    });
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['measure', 'offline', 'query', 'error']);
  });

  test('searches title, message, category and action labels', () => {
    const model = new NotificationTriageModel();
    model.reconcile(items);
    model.setQuery('OLCUM');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['measure']);
    model.setQuery('çevrimdışı');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['offline']);
    model.setQuery('katman');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['error']);
    model.setQuery('sonuçları aç');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['query']);
  });

  test('composes query and unread scope without losing stable active state', () => {
    const model = new NotificationTriageModel();
    model.reconcile(items);
    model.setScope('unread');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['measure', 'offline', 'error']);
    model.setQuery('bağlantı');
    expect(model.getSnapshot()).toMatchObject({ resultCount: 1, activeId: 'offline' });
    model.setQuery('');
    expect(model.getSnapshot().activeId).toBe('offline');
  });

  test('supports important, urgent and actionable scopes', () => {
    const model = new NotificationTriageModel();
    model.reconcile(items);
    model.setScope('important');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['offline', 'error']);
    model.setScope('urgent');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['offline', 'error']);
    model.setScope('actionable');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['query']);
  });

  test('sorts oldest and priority views deterministically', () => {
    const model = new NotificationTriageModel();
    model.reconcile(items);
    model.setSort('oldest');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['error', 'query', 'offline', 'measure']);
    model.setSort('priority');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['error', 'offline', 'measure', 'query']);
  });

  test('moves active entry with wrap-around and page navigation', () => {
    const model = new NotificationTriageModel({ pageSize: 2 });
    model.reconcile(items);
    expect(model.getSnapshot().activeId).toBe('measure');
    model.moveActive('previous');
    expect(model.getSnapshot().activeId).toBe('error');
    model.moveActive('next');
    expect(model.getSnapshot().activeId).toBe('measure');
    model.moveActive('page-next');
    expect(model.getSnapshot().activeId).toBe('query');
    model.moveActive('page-previous');
    expect(model.getSnapshot().activeId).toBe('measure');
    model.moveActive('last');
    expect(model.getSnapshot().activeId).toBe('error');
    model.moveActive('first');
    expect(model.getSnapshot().activeId).toBe('measure');
  });

  test('reconciles active id when source item disappears', () => {
    const model = new NotificationTriageModel();
    model.reconcile(items);
    model.setActive('query');
    model.reconcile(items.filter((candidate) => candidate.id !== 'query'));
    expect(model.getSnapshot().activeId).toBe('measure');
  });

  test('reconciles read state without resetting query or scope', () => {
    const model = new NotificationTriageModel();
    model.reconcile(items);
    model.setScope('unread');
    model.setQuery('ölçüm');
    const updated = items.map((candidate) => candidate.id === 'measure' ? item({ ...candidate, read: true }) : candidate);
    model.reconcile(updated);
    expect(model.getSnapshot()).toMatchObject({
      query: 'ölçüm',
      scope: 'unread',
      resultCount: 0,
      emptyReason: 'query',
    });
  });

  test('caps admitted items and preserves the first unique canonical ids', () => {
    const model = new NotificationTriageModel({ maxItems: 3 });
    model.reconcile([
      item({ id: 'one', title: 'One', createdAt: 1 }),
      item({ id: 'one', title: 'Duplicate', createdAt: 5 }),
      item({ id: 'two', title: 'Two', createdAt: 2 }),
      item({ id: 'three', title: 'Three', createdAt: 3 }),
      item({ id: 'four', title: 'Four', createdAt: 4 }),
    ]);
    expect(model.getSnapshot().totalCount).toBe(3);
    expect(model.getSnapshot().entries.map((entry) => entry.id).sort()).toEqual(['one', 'three', 'two']);
  });

  test('bounds and sanitizes query text without control-regex dependence', () => {
    const model = new NotificationTriageModel({ maxQueryLength: 8 });
    model.reconcile(items);
    model.setQuery('ölçüm\u0000\u0007    abcdef');
    expect(model.getSnapshot().query.length).toBeLessThanOrEqual(8);
    expect(model.getSnapshot().query).not.toContain('\u0000');
    expect(model.getSnapshot().query).not.toContain('\u0007');
  });

  test('reports query and scope empty reasons independently', () => {
    const model = new NotificationTriageModel();
    model.reconcile(items);
    model.setScope('actionable');
    model.setQuery('mevcut değil');
    expect(model.getSnapshot().emptyReason).toBe('query');
    model.setQuery('');
    model.reconcile(items.filter((candidate) => candidate.actions.length === 0));
    expect(model.getSnapshot().emptyReason).toBe('scope');
  });

  test('reset restores discovery defaults while retaining source items', () => {
    const model = new NotificationTriageModel();
    model.reconcile(items);
    model.setQuery('katman');
    model.setScope('important');
    model.setSort('oldest');
    model.reset();
    expect(model.getSnapshot()).toMatchObject({
      query: '',
      scope: 'all',
      sort: 'newest',
      resultCount: 4,
      activeId: 'measure',
    });
  });

  test('notifies healthy listeners even when an earlier listener throws', () => {
    const errors: unknown[] = [];
    const model = new NotificationTriageModel({ onObserverError: (error) => errors.push(error) });
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('observer failed'); });
    model.subscribe(healthy);
    model.reconcile(items);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(model.diagnostics()).toMatchObject({
      activeListenerCount: 2,
      listenerFailureCount: 1,
      reporterFailureCount: 0,
      lastFailureKind: 'TypeError',
    });
  });

  test('contains reporter failure and records bounded diagnostics', () => {
    const model = new NotificationTriageModel({
      onObserverError: () => { throw new RangeError('reporter failed with private detail'); },
    });
    model.subscribe(() => { throw new Error('listener failed'); });
    expect(() => model.reconcile(items)).not.toThrow();
    expect(model.diagnostics()).toMatchObject({
      listenerFailureCount: 1,
      reporterFailureCount: 1,
      lastFailureKind: 'reporter:RangeError',
    });
  });

  test('enforces listener budget and records rejected subscriptions', () => {
    const model = new NotificationTriageModel({ maxListeners: 2 });
    const one = () => undefined;
    const two = () => undefined;
    const three = () => undefined;
    model.subscribe(one);
    model.subscribe(two);
    const unsubscribeRejected = model.subscribe(three);
    expect(model.diagnostics()).toMatchObject({ activeListenerCount: 2, rejectedListenerCount: 1 });
    unsubscribeRejected();
    expect(model.diagnostics().activeListenerCount).toBe(2);
  });

  test('unsubscribe updates diagnostics and is idempotent', () => {
    const model = new NotificationTriageModel();
    const unsubscribe = model.subscribe(() => undefined);
    expect(model.diagnostics().activeListenerCount).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(model.diagnostics().activeListenerCount).toBe(0);
  });

  test('dispose clears listeners, freezes future mutations and records rejected subscribe', () => {
    const model = new NotificationTriageModel();
    model.reconcile(items);
    const before = model.getSnapshot();
    model.subscribe(() => undefined);
    model.dispose();
    model.setQuery('ölçüm');
    model.setScope('urgent');
    model.reconcile([]);
    model.subscribe(() => undefined);
    expect(model.getSnapshot()).toBe(before);
    expect(model.diagnostics()).toMatchObject({
      activeListenerCount: 0,
      rejectedListenerCount: 1,
      disposed: true,
    });
  });
});
