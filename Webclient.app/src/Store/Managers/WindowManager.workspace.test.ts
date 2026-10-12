import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../Business/LoggingBusiness', () => ({
  LoggingBusiness: { CreateClientLog: vi.fn(async () => ({ ok: true })) },
}));
vi.mock('../../Toolbox/DebugHelper', () => ({
  DebugHelper: { Log: vi.fn() },
}));

import { DebugHelper } from '../../Toolbox/DebugHelper';
import Store from '../Store';
import { createWindowManager } from './WindowManager';

const ids: string[] = [];
const createId = (label: string): string => {
  const id = `workspace-${label}-${Math.random().toString(36).slice(2)}`;
  ids.push(id);
  return id;
};

const cleanup = (): void => {
  const manager = createWindowManager();
  for (const id of ids.splice(0)) manager.UnregisterWindow(id);
  manager.Dispose();
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WindowManager external workspace snapshot', () => {
  it('returns a stable immutable empty snapshot until window state changes', () => {
    const manager = createWindowManager();
    const first = manager.GetWindowSnapshot();
    const second = manager.GetWindowSnapshot();
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.windows)).toBe(true);
    manager.Dispose();
  });

  it('publishes placeholder titles without query payloads', () => {
    const id = createId('title');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id, {
      title: 'Parklar',
      query: { token: 'not-for-ui', objectId: 42 },
    });

    const snapshot = manager.GetWindowSnapshot();
    const record = snapshot.windows.find((item) => item.id === id);
    expect(record).toEqual({
      id,
      title: 'Parklar',
      visible: false,
      minimized: false,
      lazy: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain('not-for-ui');
    manager.Dispose();
  });

  it('trims and bounds long placeholder titles', () => {
    const id = createId('long-title');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id, {
      title: `   ${'X'.repeat(240)}   `,
    });
    const title = manager.GetWindowSnapshot().windows.find((item) => item.id === id)?.title;
    expect(title?.length).toBe(180);
    expect(title?.startsWith('X')).toBe(true);
    manager.Dispose();
  });

  it('normalizes whitespace in titles', () => {
    const id = createId('spaces');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id, { title: '  Ada   Parsel\n Sorgusu  ' });
    expect(manager.GetWindowSnapshot().windows.find((item) => item.id === id)?.title)
      .toBe('Ada Parsel Sorgusu');
    manager.Dispose();
  });

  it('preserves placeholder title while upgrading to a live ref', () => {
    const id = createId('upgrade-title');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id, { title: 'Kütüphaneler' });
    manager.RegisterWindow({ current: { id } });
    expect(manager.GetWindowSnapshot().windows.find((item) => item.id === id)).toMatchObject({
      title: 'Kütüphaneler',
      lazy: false,
    });
    manager.Dispose();
  });

  it('uses live ref title when no placeholder title exists', () => {
    const id = createId('ref-title');
    const manager = createWindowManager();
    manager.RegisterWindow({ current: { id, title: 'Ölçüm araçları' } });
    expect(manager.GetWindowSnapshot().windows.find((item) => item.id === id)?.title)
      .toBe('Ölçüm araçları');
    manager.Dispose();
  });

  it('increments snapshot revision only after meaningful window state changes', () => {
    const id = createId('revision');
    const manager = createWindowManager();
    const initial = manager.GetWindowSnapshot();
    manager.GetWindowSnapshot();
    expect(manager.GetWindowSnapshot().revision).toBe(initial.revision);

    manager.RegisterPlaceholder(id, { title: 'Rapor' });
    const registered = manager.GetWindowSnapshot();
    expect(registered.revision).toBe(initial.revision + 1);

    manager.GetWindowSnapshot();
    expect(manager.GetWindowSnapshot()).toBe(registered);
    manager.Dispose();
  });

  it('publishes active, visible and minimized counts', () => {
    const first = createId('first');
    const second = createId('second');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(first, { title: 'Bir' });
    manager.RegisterPlaceholder(second, { title: 'İki' });

    manager.ShowWindow(first);
    expect(manager.GetWindowSnapshot()).toMatchObject({
      activeWindowId: first,
      visibleCount: 1,
      minimizedCount: 0,
    });

    manager.ToggleMinimiseWindow(first);
    const minimized = manager.GetWindowSnapshot();
    expect(minimized).toMatchObject({
      activeWindowId: null,
      visibleCount: 1,
      minimizedCount: 1,
    });

    manager.ShowWindow(second);
    expect(manager.GetWindowSnapshot()).toMatchObject({
      activeWindowId: second,
      visibleCount: 1,
      minimizedCount: 0,
    });
    manager.Dispose();
  });

  it('restores minimized target when ShowWindow activates it', () => {
    const id = createId('restore');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id, { title: 'Parklar', visible: true, minimized: true });
    expect(manager.IsMinimized(id)).toBe(true);

    expect(manager.ShowWindow(id)).toBe(true);
    expect(manager.IsVisible(id)).toBe(true);
    expect(manager.IsMinimized(id)).toBe(false);
    expect(manager.GetWindowSnapshot().activeWindowId).toBe(id);
    manager.Dispose();
  });

  it('removes unregistered windows from the published snapshot', () => {
    const id = createId('remove');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id);
    expect(manager.GetWindowSnapshot().windows.some((item) => item.id === id)).toBe(true);

    manager.UnregisterWindow(id);
    expect(manager.GetWindowSnapshot().windows.some((item) => item.id === id)).toBe(false);
    manager.Dispose();
  });
});

describe('WindowManager workspace subscriptions', () => {
  it('notifies subscribers for registration changes', () => {
    const id = createId('subscribe-register');
    const manager = createWindowManager();
    const listener = vi.fn();
    manager.SubscribeWindows(listener);

    manager.RegisterPlaceholder(id, { title: 'Parklar' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.GetWindowSnapshot().windows.some((item) => item.id === id)).toBe(true);
    manager.Dispose();
  });

  it('notifies subscribers for visibility changes', () => {
    const id = createId('subscribe-show');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id);
    const listener = vi.fn();
    manager.SubscribeWindows(listener);

    manager.ShowWindow(id);
    manager.HideWindow(id);
    expect(listener).toHaveBeenCalledTimes(2);
    manager.Dispose();
  });

  it('notifies subscribers for minimized changes', () => {
    const id = createId('subscribe-minimize');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id, { visible: true });
    const listener = vi.fn();
    manager.SubscribeWindows(listener);

    manager.ToggleMinimiseWindow(id);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.GetWindowSnapshot().minimizedCount).toBe(1);
    manager.Dispose();
  });

  it('unsubscribe is idempotent and stops notifications', () => {
    const id = createId('unsubscribe');
    const manager = createWindowManager();
    const listener = vi.fn();
    const unsubscribe = manager.SubscribeWindows(listener);
    unsubscribe();
    unsubscribe();

    manager.RegisterPlaceholder(id);
    expect(listener).not.toHaveBeenCalled();
    expect(manager.GetWindowObserverDiagnostics().activeListenerCount).toBe(0);
    manager.Dispose();
  });

  it('tracks active subscription count', () => {
    const manager = createWindowManager();
    const releaseA = manager.SubscribeWindows(() => undefined);
    const releaseB = manager.SubscribeWindows(() => undefined);
    expect(manager.GetWindowObserverDiagnostics().activeListenerCount).toBe(2);
    releaseA();
    expect(manager.GetWindowObserverDiagnostics().activeListenerCount).toBe(1);
    releaseB();
    expect(manager.GetWindowObserverDiagnostics().activeListenerCount).toBe(0);
    manager.Dispose();
  });

  it('isolates listener failures and continues healthy listeners', () => {
    const id = createId('listener-failure');
    const manager = createWindowManager();
    const healthy = vi.fn();
    manager.SubscribeWindows(() => { throw new Error('observer'); });
    manager.SubscribeWindows(healthy);

    expect(() => manager.RegisterPlaceholder(id)).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(manager.GetWindowObserverDiagnostics().listenerFailureCount).toBe(1);
    expect(DebugHelper.Log).toHaveBeenCalled();
    manager.Dispose();
  });

  it('dispose clears workspace listeners and marks diagnostics disposed', () => {
    const manager = createWindowManager();
    manager.SubscribeWindows(() => undefined);
    expect(manager.GetWindowObserverDiagnostics().activeListenerCount).toBe(1);
    manager.Dispose();
    expect(manager.GetWindowObserverDiagnostics()).toMatchObject({
      activeListenerCount: 0,
      disposed: true,
    });
  });

  it('does not accept live workspace subscriptions after dispose', () => {
    const manager = createWindowManager();
    manager.Dispose();
    const listener = vi.fn();
    const release = manager.SubscribeWindows(listener);
    release();
    expect(manager.GetWindowObserverDiagnostics()).toMatchObject({
      activeListenerCount: 0,
      disposed: true,
    });
  });

  it('does not notify when unrelated store state changes', () => {
    const manager = createWindowManager();
    const listener = vi.fn();
    manager.SubscribeWindows(listener);
    const before = manager.GetWindowSnapshot();

    Store.dispatch({ type: 'MapReducer/SetMapUpdating', payload: true });
    expect(listener).not.toHaveBeenCalled();
    expect(manager.GetWindowSnapshot()).toBe(before);

    Store.dispatch({ type: 'MapReducer/SetMapUpdating', payload: false });
    manager.Dispose();
  });
});

describe('WindowManager snapshot privacy and ownership', () => {
  it('does not expose refs or callbacks', () => {
    const id = createId('private-ref');
    const manager = createWindowManager();
    const onShow = vi.fn();
    const onClose = vi.fn();
    manager.RegisterWindow({
      current: {
        id,
        title: 'Özel pencere',
        OnShow: onShow,
        OnClose: onClose,
      },
    });

    const serialized = JSON.stringify(manager.GetWindowSnapshot());
    expect(serialized).not.toContain('OnShow');
    expect(serialized).not.toContain('OnClose');
    expect(serialized).not.toContain('current');
    manager.Dispose();
  });

  it('freezes each public snapshot record', () => {
    const id = createId('frozen');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id);
    const record = manager.GetWindowSnapshot().windows.find((item) => item.id === id);
    expect(record).toBeDefined();
    expect(Object.isFrozen(record)).toBe(true);
    manager.Dispose();
  });

  it('keeps previous snapshots detached from later mutations', () => {
    const id = createId('detached');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id);
    const before = manager.GetWindowSnapshot();
    const previousRecord = before.windows.find((item) => item.id === id);
    manager.ShowWindow(id);
    const after = manager.GetWindowSnapshot();

    expect(previousRecord?.visible).toBe(false);
    expect(after.windows.find((item) => item.id === id)?.visible).toBe(true);
    expect(after).not.toBe(before);
    manager.Dispose();
  });

  it('publishes lazy=false after a placeholder upgrades to a component ref', () => {
    const id = createId('lazy-upgrade');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id, { title: 'Sorgu' });
    expect(manager.GetWindowSnapshot().windows.find((item) => item.id === id)?.lazy).toBe(true);

    manager.RegisterWindow({ current: { id } });
    expect(manager.GetWindowSnapshot().windows.find((item) => item.id === id)?.lazy).toBe(false);
    manager.Dispose();
  });
});
