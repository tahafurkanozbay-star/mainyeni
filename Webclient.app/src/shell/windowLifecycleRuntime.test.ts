import { describe, expect, it, vi } from 'vitest';
import { createWindowLifecycleRuntime } from './windowLifecycleRuntime';

describe('createWindowLifecycleRuntime', () => {
  it('registers normalized immutable windows', () => {
    const runtime = createWindowLifecycleRuntime({ now: () => 100 });
    const record = runtime.register({ id: '  map  ', label: ' Harita ', metadata: { owner: 'shell' } });
    expect(record).toMatchObject({
      id: 'map',
      label: 'Harita',
      visible: false,
      minimized: false,
      registeredAt: 100,
      updatedAt: 100,
      activationOrder: 0,
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.metadata)).toBe(true);
  });

  it('registers initially visible windows with activation order', () => {
    const runtime = createWindowLifecycleRuntime();
    const record = runtime.register({ id: 'visible', initiallyVisible: true });
    expect(record.visible).toBe(true);
    expect(record.activationOrder).toBeGreaterThan(0);
    expect(runtime.snapshot().activeWindowId).toBe('visible');
  });

  it('allows initially minimized only when visible', () => {
    const runtime = createWindowLifecycleRuntime();
    const hidden = runtime.register({ id: 'hidden', initiallyMinimized: true });
    const minimized = runtime.register({ id: 'min', initiallyVisible: true, initiallyMinimized: true });
    expect(hidden.minimized).toBe(false);
    expect(minimized.minimized).toBe(true);
  });

  it('rejects duplicate ids', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'same' });
    expect(() => runtime.register({ id: 'same' })).toThrow(/already registered/i);
  });

  it('rejects empty ids', () => {
    const runtime = createWindowLifecycleRuntime();
    expect(() => runtime.register({ id: '   ' })).toThrow(/empty/i);
  });

  it('rejects oversized ids', () => {
    const runtime = createWindowLifecycleRuntime();
    expect(() => runtime.register({ id: 'x'.repeat(129) })).toThrow(/128/i);
  });

  it('enforces capacity', () => {
    const runtime = createWindowLifecycleRuntime({ capacity: 1 });
    runtime.register({ id: 'one' });
    expect(() => runtime.register({ id: 'two' })).toThrow(/capacity/i);
  });

  it('clamps capacity to safe bounds', () => {
    expect(createWindowLifecycleRuntime({ capacity: 0 }).snapshot().capacity).toBe(1);
    expect(createWindowLifecycleRuntime({ capacity: 9999 }).snapshot().capacity).toBe(256);
  });

  it('show makes a hidden window visible and active', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a' });
    const shown = runtime.show('a');
    expect(shown.visible).toBe(true);
    expect(shown.minimized).toBe(false);
    expect(runtime.snapshot().activeWindowId).toBe('a');
  });

  it('showing an already-visible window reactivates it', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a', initiallyVisible: true });
    runtime.register({ id: 'b', initiallyVisible: true });
    expect(runtime.snapshot().activeWindowId).toBe('b');
    runtime.show('a');
    expect(runtime.snapshot().activeWindowId).toBe('a');
  });

  it('hide removes window from active focus', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a', initiallyVisible: true });
    runtime.register({ id: 'b', initiallyVisible: true });
    runtime.hide('b');
    expect(runtime.snapshot().activeWindowId).toBe('a');
    expect(runtime.get('b')).toMatchObject({ visible: false, minimized: false });
  });

  it('hiding hidden window is idempotent', () => {
    const runtime = createWindowLifecycleRuntime();
    const first = runtime.register({ id: 'a' });
    expect(runtime.hide('a')).toBe(first);
  });

  it('minimizes visible windows', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a', initiallyVisible: true });
    expect(runtime.minimize('a').minimized).toBe(true);
    expect(runtime.snapshot().activeWindowId).toBeNull();
    expect(runtime.snapshot().minimizedCount).toBe(1);
  });

  it('rejects minimizing hidden windows', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a' });
    expect(() => runtime.minimize('a')).toThrow(/hidden/i);
  });

  it('restore reactivates minimized windows', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a', initiallyVisible: true });
    runtime.minimize('a');
    const restored = runtime.restore('a');
    expect(restored).toMatchObject({ visible: true, minimized: false });
    expect(runtime.snapshot().activeWindowId).toBe('a');
  });

  it('restore shows hidden windows', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a' });
    expect(runtime.restore('a').visible).toBe(true);
  });

  it('activate restores minimized windows', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a', initiallyVisible: true });
    runtime.minimize('a');
    expect(runtime.activate('a').minimized).toBe(false);
  });

  it('activate shows hidden windows', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a' });
    expect(runtime.activate('a').visible).toBe(true);
  });

  it('unregister removes state', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a' });
    expect(runtime.unregister('a')).toBe(true);
    expect(runtime.unregister('a')).toBe(false);
    expect(runtime.has('a')).toBe(false);
  });

  it('throws for unknown lifecycle mutations', () => {
    const runtime = createWindowLifecycleRuntime();
    expect(() => runtime.show('missing')).toThrow(/not registered/i);
    expect(() => runtime.hide('missing')).toThrow(/not registered/i);
    expect(() => runtime.restore('missing')).toThrow(/not registered/i);
  });

  it('get returns null for missing windows', () => {
    expect(createWindowLifecycleRuntime().get('missing')).toBeNull();
  });

  it('snapshot counts visible and minimized windows', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a', initiallyVisible: true });
    runtime.register({ id: 'b', initiallyVisible: true, initiallyMinimized: true });
    runtime.register({ id: 'c' });
    expect(runtime.snapshot()).toMatchObject({ visibleCount: 2, minimizedCount: 1 });
  });

  it('snapshot arrays are detached from future mutations', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a' });
    const first = runtime.snapshot();
    runtime.register({ id: 'b' });
    expect(first.windows.map((item) => item.id)).toEqual(['a']);
    expect(runtime.snapshot().windows.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('redacts secret-like metadata keys', () => {
    const runtime = createWindowLifecycleRuntime();
    const record = runtime.register({
      id: 'a',
      metadata: { safe: 'yes', token: 'hidden', password: 'hidden', Authorization: 'hidden' },
    });
    expect(record.metadata).toEqual({ safe: 'yes' });
  });

  it('bounds metadata key count', () => {
    const metadata = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index]));
    const record = createWindowLifecycleRuntime().register({ id: 'a', metadata });
    expect(Object.keys(record.metadata)).toHaveLength(24);
  });

  it('emits lifecycle events in deterministic order', () => {
    const events: string[] = [];
    const runtime = createWindowLifecycleRuntime();
    runtime.subscribe((event) => events.push(event.type));
    runtime.register({ id: 'a' });
    runtime.show('a');
    runtime.minimize('a');
    runtime.restore('a');
    runtime.hide('a');
    runtime.unregister('a');
    expect(events).toEqual(['registered', 'shown', 'minimized', 'restored', 'hidden', 'unregistered']);
  });

  it('isolates observer failures', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.subscribe(() => { throw new Error('observer'); });
    expect(() => runtime.register({ id: 'a' })).not.toThrow();
  });

  it('supports unsubscribe', () => {
    const listener = vi.fn();
    const runtime = createWindowLifecycleRuntime();
    const unsubscribe = runtime.subscribe(listener);
    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);
    runtime.register({ id: 'a' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects invalid listeners', () => {
    expect(() => createWindowLifecycleRuntime().subscribe(null as never)).toThrow(/listener/i);
  });

  it('fails closed on invalid clocks', () => {
    const runtime = createWindowLifecycleRuntime({ now: () => Number.NaN });
    expect(() => runtime.register({ id: 'a' })).toThrow(/finite/i);
  });

  it('destroy is idempotent and blocks future operations', () => {
    const runtime = createWindowLifecycleRuntime();
    runtime.register({ id: 'a' });
    runtime.destroy();
    expect(() => runtime.destroy()).not.toThrow();
    expect(() => runtime.snapshot()).toThrow(/destroyed/i);
    expect(() => runtime.register({ id: 'b' })).toThrow(/destroyed/i);
  });

  it('increments revision for meaningful mutations', () => {
    const runtime = createWindowLifecycleRuntime();
    expect(runtime.snapshot().revision).toBe(0);
    runtime.register({ id: 'a' });
    expect(runtime.snapshot().revision).toBe(1);
    runtime.show('a');
    expect(runtime.snapshot().revision).toBe(2);
    runtime.hide('a');
    expect(runtime.snapshot().revision).toBe(3);
  });
});
