import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveRegionRuntime } from './liveRegionRuntime';

describe('liveRegionRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('creates separate semantic polite and assertive regions', () => {
    const runtime = createLiveRegionRuntime({ document });
    const polite = document.querySelector('[data-experience-live-region="polite"]');
    const assertive = document.querySelector('[data-experience-live-region="assertive"]');
    expect(polite).toMatchObject({ textContent: '' });
    expect(polite?.getAttribute('role')).toBe('status');
    expect(polite?.getAttribute('aria-live')).toBe('polite');
    expect(polite?.getAttribute('aria-atomic')).toBe('true');
    expect(assertive?.getAttribute('role')).toBe('alert');
    expect(assertive?.getAttribute('aria-live')).toBe('assertive');
    runtime.dispose();
  });

  it('normalizes whitespace and announces politely by default', () => {
    const runtime = createLiveRegionRuntime({ document });
    expect(runtime.announce('  12   sonuç bulundu  ')).toBe(true);
    expect(runtime.getSnapshot().queued).toBe(1);
    vi.advanceTimersByTime(0);
    expect(document.querySelector('[data-experience-live-region="polite"]')?.textContent).toBe('12 sonuç bulundu');
    expect(runtime.getSnapshot()).toMatchObject({ queued: 0, delivered: 1, dropped: 0 });
  });

  it('routes urgent announcements to the assertive region', () => {
    const runtime = createLiveRegionRuntime({ document });
    runtime.announce('Bağlantı kesildi', { priority: 'assertive' });
    vi.advanceTimersByTime(0);
    expect(document.querySelector('[data-experience-live-region="assertive"]')?.textContent).toBe('Bağlantı kesildi');
  });

  it('rejects empty announcements without consuming queue capacity', () => {
    const runtime = createLiveRegionRuntime({ document, maxQueue: 1 });
    expect(runtime.announce('   ')).toBe(false);
    expect(runtime.getSnapshot()).toMatchObject({ queued: 0, delivered: 0, dropped: 0 });
  });

  it('deduplicates repeated announcements inside the configured window', () => {
    let now = 1000;
    const runtime = createLiveRegionRuntime({ document, now: () => now, dedupeWindowMs: 500 });
    expect(runtime.announce('Katman açıldı')).toBe(true);
    now = 1200;
    expect(runtime.announce('Katman açıldı')).toBe(false);
    expect(runtime.getSnapshot().dropped).toBe(1);
    now = 1600;
    expect(runtime.announce('Katman açıldı')).toBe(true);
  });

  it('supports explicit dedupe keys for semantically equivalent messages', () => {
    let now = 10;
    const runtime = createLiveRegionRuntime({ document, now: () => now, dedupeWindowMs: 1000 });
    expect(runtime.announce('1 kayıt seçildi', { dedupeKey: 'selection' })).toBe(true);
    now += 10;
    expect(runtime.announce('Bir kayıt seçildi', { dedupeKey: 'selection' })).toBe(false);
  });

  it('bounds queue growth and prefers dropping older polite work', () => {
    const runtime = createLiveRegionRuntime({ document, maxQueue: 2, dedupeWindowMs: 0 });
    runtime.announce('Polite one');
    runtime.announce('Critical', { priority: 'assertive' });
    runtime.announce('Polite two');
    expect(runtime.getSnapshot()).toMatchObject({ queued: 2, dropped: 1 });
    vi.runOnlyPendingTimers();
    expect(runtime.getSnapshot().delivered).toBe(2);
  });

  it('drops oldest work when a full queue contains only assertive messages', () => {
    const runtime = createLiveRegionRuntime({ document, maxQueue: 2, dedupeWindowMs: 0 });
    runtime.announce('Critical one', { priority: 'assertive' });
    runtime.announce('Critical two', { priority: 'assertive' });
    runtime.announce('Critical three', { priority: 'assertive' });
    expect(runtime.getSnapshot()).toMatchObject({ queued: 2, dropped: 1 });
    vi.runOnlyPendingTimers();
    expect(document.querySelector('[data-experience-live-region="assertive"]')?.textContent).toBe('');
    expect(runtime.getSnapshot().delivered).toBe(2);
  });

  it('clears delivered text after the configured delay', () => {
    const runtime = createLiveRegionRuntime({ document, clearDelayMs: 250 });
    runtime.announce('Hazır');
    vi.advanceTimersByTime(0);
    const region = document.querySelector('[data-experience-live-region="polite"]');
    expect(region?.textContent).toBe('Hazır');
    vi.advanceTimersByTime(249);
    expect(region?.textContent).toBe('Hazır');
    vi.advanceTimersByTime(1);
    expect(region?.textContent).toBe('');
  });

  it('restarts clear timing when a newer message uses the same region', () => {
    const runtime = createLiveRegionRuntime({ document, clearDelayMs: 100, dedupeWindowMs: 0 });
    runtime.announce('İlk');
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(50);
    runtime.announce('İkinci');
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(60);
    expect(document.querySelector('[data-experience-live-region="polite"]')?.textContent).toBe('İkinci');
    vi.advanceTimersByTime(40);
    expect(document.querySelector('[data-experience-live-region="polite"]')?.textContent).toBe('');
  });

  it('clear removes queued and visible announcements while keeping runtime reusable', () => {
    const runtime = createLiveRegionRuntime({ document, dedupeWindowMs: 0 });
    runtime.announce('Bir');
    vi.advanceTimersByTime(0);
    runtime.announce('İki');
    runtime.clear();
    expect(runtime.getSnapshot().queued).toBe(0);
    expect(document.querySelector('[data-experience-live-region="polite"]')?.textContent).toBe('');
    expect(runtime.announce('Üç')).toBe(true);
    vi.runOnlyPendingTimers();
    expect(runtime.getSnapshot().delivered).toBe(2);
  });

  it('dispose removes regions, clears timers and becomes idempotent', () => {
    const runtime = createLiveRegionRuntime({ document });
    runtime.announce('Bekleyen');
    runtime.dispose();
    runtime.dispose();
    expect(document.querySelectorAll('[data-experience-live-region]')).toHaveLength(0);
    expect(runtime.getSnapshot()).toMatchObject({ queued: 0, disposed: true });
    expect(runtime.announce('Sonraki')).toBe(false);
    vi.runOnlyPendingTimers();
    expect(runtime.getSnapshot().delivered).toBe(0);
  });

  it('validates queue and timing configuration', () => {
    expect(() => createLiveRegionRuntime({ document, maxQueue: 0 })).toThrow(RangeError);
    expect(() => createLiveRegionRuntime({ document, maxQueue: 1.5 })).toThrow(RangeError);
    expect(() => createLiveRegionRuntime({ document, dedupeWindowMs: -1 })).toThrow(RangeError);
    expect(() => createLiveRegionRuntime({ document, clearDelayMs: -1 })).toThrow(RangeError);
  });

  it('keeps polite and assertive clear timers independent', () => {
    const runtime = createLiveRegionRuntime({ document, clearDelayMs: 100, dedupeWindowMs: 0 });
    runtime.announce('Polite');
    runtime.announce('Assertive', { priority: 'assertive' });
    vi.advanceTimersByTime(0);
    expect(runtime.getSnapshot().delivered).toBe(2);
    expect(document.querySelector('[data-experience-live-region="polite"]')?.textContent).toBe('Polite');
    expect(document.querySelector('[data-experience-live-region="assertive"]')?.textContent).toBe('Assertive');
    vi.advanceTimersByTime(100);
    expect(document.querySelector('[data-experience-live-region="polite"]')?.textContent).toBe('');
    expect(document.querySelector('[data-experience-live-region="assertive"]')?.textContent).toBe('');
  });
});
