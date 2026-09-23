import { describe, expect, it, vi } from 'vitest';
import { createLiveAnnouncementQueue } from './liveAnnouncementQueue';

describe('liveAnnouncementQueue', () => {
  it('normalizes messages and sequences polite announcements', () => {
    const queue = createLiveAnnouncementQueue();
    const first = queue.enqueue({ message: '  Harita   hazır  ' });
    const second = queue.enqueue({ message: 'Katmanlar yüklendi' });

    expect(first?.message).toBe('Harita hazır');
    expect(queue.snapshot().current?.id).toBe(first?.id);
    expect(queue.snapshot().pending.map((item) => item.id)).toEqual([second?.id]);

    expect(queue.acknowledge(first!.id)).toBe(true);
    expect(queue.snapshot().current?.id).toBe(second?.id);
  });

  it('promotes assertive feedback without losing interrupted polite feedback', () => {
    const queue = createLiveAnnouncementQueue();
    const polite = queue.enqueue({ message: 'Arama tamamlandı' })!;
    const urgent = queue.enqueue({ message: 'Bağlantı kesildi', politeness: 'assertive' })!;

    expect(queue.snapshot().current).toMatchObject({ id: urgent.id, politeness: 'assertive' });
    expect(queue.snapshot().pending[0]?.id).toBe(polite.id);

    queue.acknowledge(urgent.id);
    expect(queue.snapshot().current?.id).toBe(polite.id);
  });

  it('deduplicates active and pending semantic events', () => {
    const queue = createLiveAnnouncementQueue();
    queue.enqueue({ message: 'Seçim değişti', dedupeKey: 'selection' });
    expect(queue.enqueue({ message: 'Başka seçim', dedupeKey: 'selection' })).toBeNull();
    queue.enqueue({ message: 'Yakınlaştırıldı', dedupeKey: 'zoom' });
    expect(queue.enqueue({ message: 'Tekrar zoom', dedupeKey: 'zoom' })).toBeNull();
  });

  it('bounds pending work and keeps the earliest queued feedback', () => {
    const queue = createLiveAnnouncementQueue({ maxPending: 2 });
    queue.enqueue({ message: 'current' });
    queue.enqueue({ message: 'one' });
    queue.enqueue({ message: 'two' });
    queue.enqueue({ message: 'three' });

    expect(queue.snapshot().pending.map((item) => item.message)).toEqual(['one', 'two']);
  });

  it('expires stale feedback only when explicitly swept', () => {
    let clock = 100;
    const queue = createLiveAnnouncementQueue({ now: () => clock, defaultTtlMs: 50 });
    const first = queue.enqueue({ message: 'Geçici durum' })!;
    queue.enqueue({ message: 'Sonraki durum', ttlMs: 200 });

    clock = 151;
    expect(queue.sweep()).toBe(true);
    expect(queue.snapshot().current?.message).toBe('Sonraki durum');
    expect(queue.acknowledge(first.id)).toBe(false);
  });

  it('does not create background timers for expiry', () => {
    vi.useFakeTimers();
    try {
      const queue = createLiveAnnouncementQueue({ defaultTtlMs: 100 });
      queue.enqueue({ message: 'Bekleyen mesaj' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports targeted dismissal and clear without disturbing unrelated entries', () => {
    const queue = createLiveAnnouncementQueue();
    const current = queue.enqueue({ message: 'current' })!;
    const remove = queue.enqueue({ message: 'remove' })!;
    const keep = queue.enqueue({ message: 'keep' })!;

    expect(queue.dismiss(remove.id)).toBe(true);
    expect(queue.snapshot().pending.map((item) => item.id)).toEqual([keep.id]);
    expect(queue.dismiss(9999)).toBe(false);
    expect(queue.snapshot().current?.id).toBe(current.id);

    queue.clear();
    expect(queue.snapshot()).toMatchObject({ current: null, pending: [] });
  });

  it('isolates observer failures and returns immutable snapshots', () => {
    const queue = createLiveAnnouncementQueue();
    const observer = vi.fn();
    queue.subscribe(() => { throw new Error('observer failure'); });
    const unsubscribe = queue.subscribe(observer);

    expect(() => queue.enqueue({ message: 'Harita odağı değişti' })).not.toThrow();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(queue.snapshot())).toBe(true);
    expect(Object.isFrozen(queue.snapshot().pending)).toBe(true);

    unsubscribe();
    queue.enqueue({ message: 'İkinci mesaj' });
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('rejects blank messages and clamps unsafe configuration', () => {
    const queue = createLiveAnnouncementQueue({ maxPending: Number.POSITIVE_INFINITY });
    expect(queue.enqueue({ message: '   ' })).toBeNull();

    const long = 'a'.repeat(700);
    expect(queue.enqueue({ message: long })?.message).toHaveLength(500);
  });

  it('increments revisions only for observable mutations', () => {
    const queue = createLiveAnnouncementQueue();
    expect(queue.snapshot().revision).toBe(0);
    const item = queue.enqueue({ message: 'Hazır' })!;
    expect(queue.snapshot().revision).toBe(1);
    expect(queue.dismiss(999)).toBe(false);
    expect(queue.snapshot().revision).toBe(1);
    expect(queue.acknowledge(item.id)).toBe(true);
    expect(queue.snapshot().revision).toBe(2);
  });
});
