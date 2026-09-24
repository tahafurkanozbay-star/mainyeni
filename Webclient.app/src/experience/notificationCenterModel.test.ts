import { describe, expect, it, vi } from 'vitest';
import { NotificationCenterModel } from './notificationCenterModel';

describe('NotificationCenterModel', () => {
  it('creates an immutable normalized notification snapshot', () => {
    const model = new NotificationCenterModel({ now: () => 100 });
    model.push({ id: ' notice ', title: ' Katman yüklendi ', message: '  Hazır   durumda  ' });
    const snapshot = model.snapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      id: 'notice',
      title: 'Katman yüklendi',
      message: 'Hazır durumda',
      tone: 'info',
      priority: 'normal',
      createdAt: 100,
      category: 'general',
      read: false,
      occurrenceCount: 1,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(Object.isFrozen(snapshot.items[0])).toBe(true);
  });

  it('uses assertive announcements for errors and urgent items', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'warning', title: 'Uyarı', tone: 'warning' });
    expect(model.snapshot().announcement?.politeness).toBe('polite');
    model.push({ id: 'urgent', title: 'Kritik', priority: 'urgent' });
    expect(model.snapshot().announcement?.politeness).toBe('assertive');
    model.push({ id: 'error', title: 'Bağlantı hatası', tone: 'error' });
    expect(model.snapshot().announcement).toMatchObject({
      politeness: 'assertive',
      notificationId: 'error',
    });
  });

  it('coalesces repeated notifications by dedupe key', () => {
    let now = 10;
    const model = new NotificationCenterModel({ now: () => now });
    model.push({ id: 'first', title: 'Senkronizasyon', dedupeKey: 'sync' });
    now = 20;
    const repeated = model.push({ id: 'second', title: 'Senkronizasyon', dedupeKey: 'sync' });
    expect(repeated.id).toBe('first');
    expect(repeated.createdAt).toBe(20);
    expect(repeated.occurrenceCount).toBe(2);
    expect(model.snapshot().items).toHaveLength(1);
    expect(model.snapshot().announcement?.text).toContain('2 kez tekrarlandı');
  });

  it('rejects duplicate ids without a dedupe contract', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'same', title: 'Bir' });
    expect(() => model.push({ id: 'same', title: 'İki' })).toThrow('already exists');
  });

  it('tracks unread and urgent unread totals', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'Bilgi' });
    model.push({ id: 'b', title: 'Hata', tone: 'error' });
    model.push({ id: 'c', title: 'Acil', priority: 'urgent' });
    expect(model.snapshot()).toMatchObject({ unreadCount: 3, urgentUnreadCount: 2 });
    expect(model.markRead('b')).toBe(true);
    expect(model.snapshot()).toMatchObject({ unreadCount: 2, urgentUnreadCount: 1 });
    expect(model.markUnread('b')).toBe(true);
    expect(model.snapshot()).toMatchObject({ unreadCount: 3, urgentUnreadCount: 2 });
  });

  it('marks all items as read with a deterministic count', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'A' });
    model.push({ id: 'b', title: 'B' });
    model.markRead('a');
    expect(model.markAllRead()).toBe(1);
    expect(model.markAllRead()).toBe(0);
    expect(model.snapshot().unreadCount).toBe(0);
  });

  it('dismisses only dismissible notifications', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'dismiss', title: 'Dismiss' });
    model.push({ id: 'protected', title: 'Protected', dismissible: false });
    expect(model.dismiss('protected')).toBe(false);
    expect(model.dismiss('missing')).toBe(false);
    expect(model.dismiss('dismiss')).toBe(true);
    expect(model.snapshot().items.map((item) => item.id)).toEqual(['protected']);
  });

  it('clears only read and dismissible items', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'A' });
    model.push({ id: 'b', title: 'B', dismissible: false });
    model.push({ id: 'c', title: 'C' });
    model.markRead('a');
    model.markRead('b');
    expect(model.clearRead()).toBe(1);
    expect(model.snapshot().items.map((item) => item.id)).toEqual(['c', 'b']);
  });

  it('prunes expired non-sticky notifications only when explicitly requested', () => {
    let now = 100;
    const model = new NotificationCenterModel({ now: () => now });
    model.push({ id: 'short', title: 'Kısa', expiresAt: 120 });
    model.push({ id: 'sticky', title: 'Kalıcı', sticky: true, expiresAt: 110 });
    now = 200;
    expect(model.snapshot().items.map((item) => item.id)).toEqual(['sticky', 'short']);
    expect(model.pruneExpired()).toBe(1);
    expect(model.snapshot().items.map((item) => item.id)).toEqual(['sticky']);
  });

  it('clears a matching announcement after acknowledgement', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'A' });
    expect(model.acknowledgeAnnouncement('wrong')).toBe(false);
    expect(model.acknowledgeAnnouncement('a')).toBe(true);
    expect(model.snapshot().announcement).toBeNull();
    expect(model.acknowledgeAnnouncement()).toBe(false);
  });

  it('bounds the queue by evicting older non-sticky items', () => {
    const model = new NotificationCenterModel({ capacity: 3 });
    model.push({ id: 'a', title: 'A' });
    model.push({ id: 'b', title: 'B', sticky: true });
    model.push({ id: 'c', title: 'C' });
    model.push({ id: 'd', title: 'D' });
    expect(model.snapshot().items.map((item) => item.id)).toEqual(['d', 'c', 'b']);
  });

  it('hard-bounds the queue even when every item is sticky', () => {
    const model = new NotificationCenterModel({ capacity: 2 });
    model.push({ id: 'a', title: 'A', sticky: true });
    model.push({ id: 'b', title: 'B', sticky: true });
    model.push({ id: 'c', title: 'C', sticky: true });
    expect(model.snapshot().items).toHaveLength(2);
    expect(model.snapshot().items.map((item) => item.id)).toEqual(['c', 'b']);
  });

  it('normalizes and sorts category names using Turkish collation', () => {
    const model = new NotificationCenterModel();
    model.push({ id: 'a', title: 'A', category: 'Zemin' });
    model.push({ id: 'b', title: 'B', category: 'Arama' });
    model.push({ id: 'c', title: 'C', category: 'Zemin' });
    expect(model.snapshot().categories).toEqual(['Arama', 'Zemin']);
  });

  it('validates action identifiers and action capacity', () => {
    const model = new NotificationCenterModel();
    expect(() => model.push({
      id: 'duplicate-actions',
      title: 'A',
      actions: [{ id: 'open', label: 'Aç' }, { id: 'open', label: 'Tekrar aç' }],
    })).toThrow('unique');
    expect(() => model.push({
      id: 'too-many',
      title: 'B',
      actions: Array.from({ length: 5 }, (_, index) => ({ id: String(index), label: String(index) })),
    })).toThrow('capacity');
  });

  it('validates required text and expiry timestamps', () => {
    const model = new NotificationCenterModel();
    expect(() => model.push({ id: ' ', title: 'A' })).toThrow('id is required');
    expect(() => model.push({ id: 'a', title: ' ' })).toThrow('title is required');
    expect(() => model.push({ id: 'b', title: 'B', expiresAt: Number.NaN })).toThrow('expiresAt');
    expect(() => model.push({ id: 'c', title: 'C', expiresAt: -1 })).toThrow('expiresAt');
  });

  it('notifies observers immediately and after revisions', () => {
    const model = new NotificationCenterModel();
    const observer = vi.fn();
    const unsubscribe = model.subscribe(observer);
    expect(observer).toHaveBeenCalledTimes(1);
    model.push({ id: 'a', title: 'A' });
    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer.mock.calls.at(-1)?.[0]).toMatchObject({ revision: 1, unreadCount: 1 });
    unsubscribe();
    model.push({ id: 'b', title: 'B' });
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('isolates observer failures and reports them through the diagnostic channel', () => {
    const reporter = vi.fn();
    const model = new NotificationCenterModel({ onObserverError: reporter });
    model.subscribe(() => { throw new Error('observer failed'); });
    expect(() => model.push({ id: 'a', title: 'A' })).not.toThrow();
    expect(reporter).toHaveBeenCalled();
    expect(model.snapshot().items).toHaveLength(1);
  });

  it('keeps business state intact when the diagnostic reporter itself fails', () => {
    const model = new NotificationCenterModel({
      onObserverError: () => { throw new Error('reporter failed'); },
    });
    model.subscribe(() => { throw new Error('observer failed'); });
    expect(() => model.push({ id: 'a', title: 'A' })).not.toThrow();
    expect(model.snapshot().items[0]?.id).toBe('a');
  });

  it('returns false for read mutations targeting unknown ids', () => {
    const model = new NotificationCenterModel();
    expect(model.markRead('missing')).toBe(false);
    expect(model.markUnread('missing')).toBe(false);
  });

  it('preserves normalized action metadata in snapshots', () => {
    const model = new NotificationCenterModel();
    model.push({
      id: 'actions',
      title: 'Katman hazır',
      actions: [{ id: ' open ', label: ' Haritada aç ' }],
    });
    expect(model.snapshot().items[0]?.actions).toEqual([{ id: 'open', label: 'Haritada aç' }]);
    expect(Object.isFrozen(model.snapshot().items[0]?.actions)).toBe(true);
  });
});