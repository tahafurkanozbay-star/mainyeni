import { describe, expect, it, vi } from 'vitest';
import { createNotificationCenter } from './notificationCenter';

describe('createNotificationCenter', () => {
  it('publishes immutable normalized records', () => {
    const center = createNotificationCenter({ now: () => 100 });
    const record = center.publish({ message: '  Merhaba  ', severity: 'success', scope: ' map ' });
    expect(record).toMatchObject({
      id: 'notification-1',
      message: 'Merhaba',
      severity: 'success',
      scope: 'map',
      createdAt: 100,
      updatedAt: 100,
      occurrences: 1,
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.metadata)).toBe(true);
  });

  it('generates deterministic ids', () => {
    const center = createNotificationCenter();
    expect(center.publish({ message: 'one' }).id).toBe('notification-1');
    expect(center.publish({ message: 'two' }).id).toBe('notification-2');
  });

  it('preserves explicit ids', () => {
    const center = createNotificationCenter();
    expect(center.publish({ id: 'server-warning', message: 'warning' }).id).toBe('server-warning');
  });

  it('rejects duplicate explicit ids', () => {
    const center = createNotificationCenter();
    center.publish({ id: 'same', message: 'one', ttlMs: null });
    expect(() => center.publish({ id: 'same', message: 'two', ttlMs: null })).toThrow(/already exists/i);
  });

  it('collapses duplicate messages inside the dedupe window', () => {
    let now = 1_000;
    const center = createNotificationCenter({ now: () => now, dedupeWindowMs: 500 });
    const first = center.publish({ message: 'same', severity: 'warning' });
    now += 300;
    const second = center.publish({ message: 'same', severity: 'warning' });
    expect(second.id).toBe(first.id);
    expect(second.occurrences).toBe(2);
    expect(center.snapshot().active).toHaveLength(1);
    expect(center.snapshot().duplicateCollapses).toBe(1);
    expect(center.snapshot().totalPublished).toBe(2);
  });

  it('does not collapse duplicates outside the window', () => {
    let now = 1_000;
    const center = createNotificationCenter({ now: () => now, dedupeWindowMs: 100 });
    center.publish({ message: 'same' });
    now += 101;
    center.publish({ message: 'same' });
    expect(center.snapshot().active).toHaveLength(2);
  });

  it('does not collapse different scopes or severities', () => {
    const center = createNotificationCenter({ dedupeWindowMs: 60_000 });
    center.publish({ message: 'same', severity: 'info', scope: 'a' });
    center.publish({ message: 'same', severity: 'error', scope: 'a' });
    center.publish({ message: 'same', severity: 'info', scope: 'b' });
    expect(center.snapshot().active).toHaveLength(3);
  });

  it('enforces FIFO capacity', () => {
    const center = createNotificationCenter({ capacity: 2, defaultTtlMs: null });
    center.publish({ id: 'one', message: '1' });
    center.publish({ id: 'two', message: '2' });
    center.publish({ id: 'three', message: '3' });
    expect(center.snapshot().active.map((item) => item.id)).toEqual(['two', 'three']);
    expect(center.snapshot().totalDropped).toBe(1);
  });

  it('clamps capacity to safe bounds', () => {
    expect(createNotificationCenter({ capacity: 0 }).snapshot().capacity).toBe(1);
    expect(createNotificationCenter({ capacity: 9_999 }).snapshot().capacity).toBe(500);
  });

  it('expires records without background timers', () => {
    let now = 0;
    const center = createNotificationCenter({ now: () => now, defaultTtlMs: 250 });
    center.publish({ message: 'temporary' });
    now = 249;
    expect(center.snapshot().active).toHaveLength(1);
    now = 250;
    expect(center.snapshot().active).toHaveLength(0);
    expect(center.snapshot().totalExpired).toBe(1);
  });

  it('supports persistent notifications with null ttl', () => {
    let now = 0;
    const center = createNotificationCenter({ now: () => now });
    center.publish({ message: 'persistent', ttlMs: null });
    now = 10_000_000;
    expect(center.snapshot().active).toHaveLength(1);
  });

  it('refreshes duplicate expiry without changing identity', () => {
    let now = 0;
    const center = createNotificationCenter({ now: () => now, defaultTtlMs: 500, dedupeWindowMs: 1_000 });
    const first = center.publish({ message: 'x' });
    now = 400;
    const updated = center.publish({ message: 'x' });
    expect(updated.id).toBe(first.id);
    now = 700;
    expect(center.snapshot().active).toHaveLength(1);
    now = 900;
    expect(center.snapshot().active).toHaveLength(0);
  });

  it('dismisses by id', () => {
    const center = createNotificationCenter({ defaultTtlMs: null });
    const item = center.publish({ message: 'x' });
    expect(center.dismiss(item.id)).toBe(true);
    expect(center.dismiss(item.id)).toBe(false);
    expect(center.snapshot().totalDismissed).toBe(1);
  });

  it('clears all active notifications', () => {
    const center = createNotificationCenter({ defaultTtlMs: null, dedupeWindowMs: 0 });
    center.publish({ message: 'a' });
    center.publish({ message: 'b' });
    expect(center.clear()).toBe(2);
    expect(center.clear()).toBe(0);
    expect(center.snapshot().active).toEqual([]);
  });

  it('returns null for unknown ids', () => {
    expect(createNotificationCenter().get('missing')).toBeNull();
  });

  it('redacts secret-like metadata keys', () => {
    const center = createNotificationCenter();
    const record = center.publish({
      message: 'x',
      metadata: {
        safe: 'yes',
        accessToken: 'hidden',
        password: 'hidden',
        Authorization: 'hidden',
      },
    });
    expect(record.metadata).toEqual({ safe: 'yes' });
  });

  it('drops unsupported metadata value types', () => {
    const center = createNotificationCenter();
    const record = center.publish({
      message: 'x',
      metadata: {
        fn: () => 1,
        symbol: Symbol('x'),
        bigint: 1n,
        number: 1,
      },
    });
    expect(record.metadata).toEqual({ number: 1 });
  });

  it('bounds metadata key count', () => {
    const metadata = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key-${index}`, index]));
    const record = createNotificationCenter().publish({ message: 'x', metadata });
    expect(Object.keys(record.metadata)).toHaveLength(24);
  });

  it('rejects empty and oversized messages', () => {
    const center = createNotificationCenter();
    expect(() => center.publish({ message: '   ' })).toThrow(/empty/i);
    expect(() => center.publish({ message: 'x'.repeat(2_001) })).toThrow(/2000/i);
  });

  it('defaults unknown severities to info', () => {
    const center = createNotificationCenter();
    const record = center.publish({ message: 'x', severity: 'other' as never });
    expect(record.severity).toBe('info');
  });

  it('emits lifecycle events', () => {
    const events: string[] = [];
    const center = createNotificationCenter({ defaultTtlMs: null });
    center.subscribe((event) => events.push(event.type));
    const item = center.publish({ message: 'x' });
    center.dismiss(item.id);
    center.publish({ message: 'y' });
    center.clear();
    expect(events).toEqual(['published', 'dismissed', 'published', 'cleared']);
  });

  it('isolates listener failures from publishing', () => {
    const center = createNotificationCenter();
    center.subscribe(() => { throw new Error('observer'); });
    expect(() => center.publish({ message: 'still works' })).not.toThrow();
    expect(center.snapshot().observerFailures).toBe(1);
  });

  it('unsubscribe is idempotent', () => {
    const center = createNotificationCenter();
    const listener = vi.fn();
    const unsubscribe = center.subscribe(listener);
    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);
    center.publish({ message: 'x' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects invalid listeners', () => {
    const center = createNotificationCenter();
    expect(() => center.subscribe(null as never)).toThrow(/listener/i);
  });

  it('fails closed on invalid clocks', () => {
    const center = createNotificationCenter({ now: () => Number.NaN });
    expect(() => center.publish({ message: 'x' })).toThrow(/finite timestamp/i);
  });

  it('destroy clears state and rejects later operations', () => {
    const center = createNotificationCenter({ defaultTtlMs: null });
    center.publish({ message: 'x' });
    center.destroy();
    expect(() => center.snapshot()).toThrow(/destroyed/i);
    expect(() => center.publish({ message: 'y' })).toThrow(/destroyed/i);
    expect(() => center.dismiss('x')).toThrow(/destroyed/i);
  });

  it('destroy is idempotent', () => {
    const center = createNotificationCenter();
    center.destroy();
    expect(() => center.destroy()).not.toThrow();
  });

  it('snapshots are detached from future updates', () => {
    const center = createNotificationCenter({ defaultTtlMs: null, dedupeWindowMs: 0 });
    center.publish({ message: 'one' });
    const first = center.snapshot();
    center.publish({ message: 'two' });
    expect(first.active.map((item) => item.message)).toEqual(['one']);
    expect(center.snapshot().active.map((item) => item.message)).toEqual(['one', 'two']);
  });
});
