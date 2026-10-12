import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../Business/LoggingBusiness', () => ({
  LoggingBusiness: {
    CreateClientLog: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock('../../Toolbox/DebugHelper', () => ({ DebugHelper: { Log: vi.fn() } }));

import { LoggingBusiness } from '../../Business/LoggingBusiness';
import { DebugHelper } from '../../Toolbox/DebugHelper';
import Store from '../Store';
import { createWindowManager } from './WindowManager';

type CallbackRef = {
  current: {
    id: string;
    visible?: boolean;
    minimized?: boolean;
    OnShow?: ReturnType<typeof vi.fn>;
    OnClose?: ReturnType<typeof vi.fn>;
  };
};

const uniqueId = (label: string): string => `${label}-${Math.random().toString(36).slice(2)}`;

const createRef = (id: string): CallbackRef => ({
  current: {
    id,
    OnShow: vi.fn(),
    OnClose: vi.fn(),
  },
});

const cleanupWindow = (id: string): void => {
  const manager = createWindowManager();
  manager.UnregisterWindow(id);
  manager.Dispose();
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('typed WindowManager registration lifecycle', () => {
  test('keeps window activation usable when async logging and OnShow callbacks reject', async () => {
    const id = uniqueId('async-failure');
    const manager = createWindowManager();
    const ref = createRef(id);
    const logFailure = new Error('Logging unavailable');
    const showFailure = new Error('Content unavailable');
    vi.mocked(LoggingBusiness.CreateClientLog).mockRejectedValueOnce(logFailure);
    ref.current.OnShow = vi.fn(async () => { throw showFailure; });
    manager.RegisterWindow(ref);
    expect(manager.ShowWindow(id)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.IsVisible(id)).toBe(true);
    expect(DebugHelper.Log).toHaveBeenCalledWith(logFailure);
    expect(DebugHelper.Log).toHaveBeenCalledWith(showFailure);
    cleanupWindow(id);
    manager.Dispose();
  });
  test('registers a placeholder only once', () => {
    const id = uniqueId('placeholder');
    const manager = createWindowManager();

    expect(manager.RegisterPlaceholder(id, {
      visible: true,
      minimized: true,
      query: { name: 'Ankara' },
    })).toBe(true);
    expect(manager.RegisterPlaceholder(id)).toBe(false);

    const registered = Store.getState().Common.WindowList.find((item) => item.id === id);
    expect(registered).toMatchObject({
      id,
      visible: true,
      minimized: true,
      query: { name: 'Ankara' },
      lazy: true,
    });

    manager.Dispose();
    cleanupWindow(id);
  });

  test('upgrades a placeholder to a live ref without losing state', () => {
    const id = uniqueId('upgrade');
    const manager = createWindowManager();
    const ref = createRef(id);

    manager.RegisterPlaceholder(id, {
      visible: true,
      minimized: true,
      query: { page: 4 },
    });
    expect(manager.RegisterWindow(ref)).toBe(true);

    const registered = Store.getState().Common.WindowList.find((item) => item.id === id);
    expect(registered).toMatchObject({
      id,
      ref,
      visible: true,
      minimized: true,
      query: { page: 4 },
      lazy: false,
    });

    manager.Dispose();
    cleanupWindow(id);
  });

  test('rejects refs without a usable id', () => {
    const manager = createWindowManager();
    expect(manager.RegisterWindow(null)).toBe(false);
    expect(manager.RegisterWindow({ current: null })).toBe(false);
    expect(manager.RegisterWindow({ current: { id: '' } })).toBe(false);
    manager.Dispose();
  });

  test('refuses unregister when caller does not own current ref', () => {
    const id = uniqueId('ownership');
    const manager = createWindowManager();
    const first = createRef(id);
    const foreign = createRef(id);

    manager.RegisterWindow(first);
    expect(manager.UnregisterWindow(id, foreign)).toBe(false);
    expect(Store.getState().Common.WindowList.some((item) => item.id === id)).toBe(true);
    expect(manager.UnregisterWindow(id, first)).toBe(true);
    expect(Store.getState().Common.WindowList.some((item) => item.id === id)).toBe(false);
    manager.Dispose();
  });
});

describe('typed WindowManager visibility and query lifecycle', () => {
  test('shows target, logs the action and calls OnShow', () => {
    const id = uniqueId('show');
    const render = vi.fn();
    const manager = createWindowManager(render);
    const ref = createRef(id);
    manager.RegisterWindow(ref);

    expect(manager.ShowWindow(id, { name: 'Park' })).toBe(true);
    expect(manager.IsVisible(id)).toBe(true);
    expect(manager.GetQueryParams(id)).toEqual({ name: 'Park' });
    expect(ref.current.OnShow).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(LoggingBusiness.CreateClientLog).toHaveBeenCalledWith('Pencere Aç', id);

    manager.Dispose();
    cleanupWindow(id);
  });

  test('hides previously visible window and runs its close callback', () => {
    const firstId = uniqueId('first');
    const secondId = uniqueId('second');
    const manager = createWindowManager();
    const first = createRef(firstId);
    const second = createRef(secondId);
    manager.RegisterWindow(first);
    manager.RegisterWindow(second);

    manager.ShowWindow(firstId);
    expect(manager.ShowWindow(secondId)).toBe(true);

    expect(manager.IsVisible(firstId)).toBe(false);
    expect(manager.IsVisible(secondId)).toBe(true);
    expect(first.current.OnClose).toHaveBeenCalledTimes(1);
    expect(second.current.OnShow).toHaveBeenCalledTimes(1);

    manager.Dispose();
    cleanupWindow(firstId);
    cleanupWindow(secondId);
  });

  test('hide calls close and clears query', () => {
    const id = uniqueId('hide');
    const manager = createWindowManager();
    const ref = createRef(id);
    manager.RegisterWindow(ref);
    manager.ShowWindow(id, { objectId: 0 });

    expect(manager.HideWindow(id)).toBe(true);
    expect(manager.IsVisible(id)).toBe(false);
    expect(manager.GetQueryParams(id)).toEqual({});
    expect(ref.current.OnClose).toHaveBeenCalledTimes(1);

    manager.Dispose();
    cleanupWindow(id);
  });

  test('toggle alternates visibility', () => {
    const id = uniqueId('toggle');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id);

    expect(manager.ToggleWindow(id, { page: 1 })).toBe(true);
    expect(manager.IsVisible(id)).toBe(true);
    expect(manager.ToggleWindow(id)).toBe(true);
    expect(manager.IsVisible(id)).toBe(false);

    manager.Dispose();
    cleanupWindow(id);
  });

  test('unknown window operations fail without state mutation', () => {
    const id = uniqueId('missing');
    const manager = createWindowManager();
    const before = Store.getState().Common.WindowList;

    expect(manager.ShowWindow(id)).toBe(false);
    expect(manager.HideWindow(id)).toBe(false);
    expect(manager.ToggleWindow(id)).toBe(false);
    expect(manager.ToggleMinimiseWindow(id)).toBe(false);
    expect(manager.IsVisible(id)).toBe(false);
    expect(manager.IsMinimized(id)).toBe(false);
    expect(Store.getState().Common.WindowList).toBe(before);
    manager.Dispose();
  });
});

describe('typed WindowManager minimized/message/map state', () => {
  test('toggles minimized state deterministically', () => {
    const id = uniqueId('minimize');
    const manager = createWindowManager();
    manager.RegisterPlaceholder(id);

    expect(manager.IsMinimized(id)).toBe(false);
    expect(manager.ToggleMinimiseWindow(id)).toBe(true);
    expect(manager.IsMinimized(id)).toBe(true);
    expect(manager.ToggleMinimiseWindow(id)).toBe(true);
    expect(manager.IsMinimized(id)).toBe(false);

    manager.Dispose();
    cleanupWindow(id);
  });

  test('sets and clears map updating without redundant render', () => {
    const render = vi.fn();
    const manager = createWindowManager(render);
    const initial = manager.GetMapUpdating();

    manager.SetMapUpdating(!initial);
    expect(manager.GetMapUpdating()).toBe(!initial);
    expect(render).toHaveBeenCalledTimes(1);

    manager.SetMapUpdating(!initial);
    expect(render).toHaveBeenCalledTimes(1);

    manager.SetMapUpdating(initial);
    expect(manager.GetMapUpdating()).toBe(initial);
    manager.Dispose();
  });

  test('shows message and automatically removes it', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const manager = createWindowManager(render);

    manager.ShowMessage('success', 'Kaydedildi', 2);
    expect(manager.GetMessage()).toMatchObject({
      messageType: 'success',
      messageText: 'Kaydedildi',
    });
    expect(render).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1999);
    expect(manager.GetMessage()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(manager.GetMessage()).toBeNull();
    expect(render).toHaveBeenCalledTimes(2);
    manager.Dispose();
  });

  test('replacing a message cancels old timer', () => {
    vi.useFakeTimers();
    const manager = createWindowManager();

    manager.ShowMessage('info', 'first', 1);
    vi.advanceTimersByTime(500);
    manager.ShowMessage('warning', 'second', 2);
    vi.advanceTimersByTime(600);
    expect(manager.GetMessage()).toMatchObject({ messageText: 'second' });
    vi.advanceTimersByTime(1400);
    expect(manager.GetMessage()).toBeNull();
    manager.Dispose();
  });

  test('dispose cancels outstanding message timer and future render callbacks', () => {
    vi.useFakeTimers();
    const render = vi.fn();
    const manager = createWindowManager(render);
    manager.ShowMessage('info', 'pending', 1);
    expect(render).toHaveBeenCalledTimes(1);

    manager.Dispose();
    vi.advanceTimersByTime(2000);
    expect(render).toHaveBeenCalledTimes(1);
    // Dispose intentionally does not mutate message state; another mounted manager may own it.
    manager.RemoveMessage();
  });
});

describe('lazy placeholder ownership and current activation', () => {
  test('activates the latest React handle when callbacks change before its scheduled opening', async () => {
    const id = uniqueId('latest-handle'); const manager = createWindowManager(); const ref = createRef(id);
    manager.RegisterPlaceholder(id, { visible: true }); manager.RegisterWindow(ref);
    const latestShow = vi.fn(); ref.current = { ...ref.current, OnShow: latestShow };
    await Promise.resolve(); expect(latestShow).toHaveBeenCalledTimes(1);
    manager.UnregisterWindow(id); manager.Dispose();
  });
  test('does not run a scheduled OnShow after the user closes the tool', async () => {
    const id = uniqueId('late-show'); const manager = createWindowManager(); const ref = createRef(id);
    manager.RegisterPlaceholder(id, { visible: true }); manager.RegisterWindow(ref);
    manager.HideWindow(id); await Promise.resolve();
    expect(ref.current.OnShow).not.toHaveBeenCalled();
    manager.UnregisterWindow(id); manager.Dispose();
  });
  test('does not run a scheduled OnShow after another tool is selected', async () => {
    const id = uniqueId('superseded-show'); const other = uniqueId('other-tool');
    const manager = createWindowManager(); const ref = createRef(id);
    manager.RegisterPlaceholder(id, { visible: true }); manager.RegisterWindow(ref); manager.RegisterPlaceholder(other);
    manager.ShowWindow(other); await Promise.resolve();
    expect(ref.current.OnShow).not.toHaveBeenCalled();
    manager.UnregisterWindow(id); manager.UnregisterWindow(other); manager.Dispose();
  });
  test('retains the host placeholder when the mounted component unregisters', () => {
    const id = uniqueId('retained-placeholder'); const manager = createWindowManager(); const ref = createRef(id);
    manager.RegisterPlaceholder(id); manager.RegisterWindow(ref); manager.ShowWindow(id, { mode: 'legend' });
    manager.UnregisterWindow(id, ref);
    expect(Store.getState().Common.WindowList.find(item => item.id === id)).toMatchObject({ ref: null, lazy: true, visible: true, query: { mode: 'legend' } });
    expect(manager.ShowWindow(id)).toBe(true);
    manager.UnregisterWindow(id); manager.Dispose();
  });
  test('reopening expands a previously minimized tool', () => {
    const id = uniqueId('reopen-minimized'); const manager = createWindowManager();
    manager.RegisterPlaceholder(id); manager.ShowWindow(id); manager.ToggleMinimiseWindow(id); manager.HideWindow(id); manager.ShowWindow(id);
    expect(manager.IsVisible(id)).toBe(true); expect(manager.IsMinimized(id)).toBe(false);
    manager.UnregisterWindow(id); manager.Dispose();
  });
});

describe('navigation and query coexistence', () => {
  test('keeps a lazy query active when its OnShow reveals the sidebar', async () => {
    const manager = createWindowManager();
    const id = uniqueId('lazy-with-navigation');
    const sidebar = createRef('sidebar');
    const query = createRef(id);
    query.current.OnShow = vi.fn(() => manager.ShowWindow('sidebar'));
    try {
      manager.RegisterWindow(sidebar);
      manager.RegisterPlaceholder(id);
      manager.ShowWindow(id, { objectId: 0, name: 'Kızılay' });
      manager.RegisterWindow(query);
      await Promise.resolve();
      expect(manager.IsVisible(id)).toBe(true);
      expect(manager.IsVisible('sidebar')).toBe(true);
      expect(manager.GetQueryParams(id)).toEqual({ objectId: 0, name: 'Kızılay' });
      expect(query.current.OnShow).toHaveBeenCalledOnce();
      expect(query.current.OnClose).not.toHaveBeenCalled();
      expect(sidebar.current.OnShow).toHaveBeenCalledOnce();
    } finally {
      manager.UnregisterWindow(id);
      manager.UnregisterWindow('sidebar');
      manager.Dispose();
    }
  });

  test('restores navigation without changing the active query minimization or payload', () => {
    const manager = createWindowManager();
    const id = uniqueId('preserved-query');
    const query = createRef(id);
    try {
      manager.RegisterWindow(createRef('sidebar'));
      manager.RegisterWindow(query);
      manager.ShowWindow(id, { name: 'Çankaya' });
      manager.ToggleMinimiseWindow(id);
      manager.ToggleMinimiseWindow('sidebar');
      manager.ShowWindow('sidebar');
      expect(manager.IsVisible(id)).toBe(true);
      expect(manager.IsMinimized(id)).toBe(true);
      expect(manager.IsMinimized('sidebar')).toBe(false);
      expect(manager.GetQueryParams(id)).toEqual({ name: 'Çankaya' });
      expect(query.current.OnClose).not.toHaveBeenCalled();
    } finally {
      manager.UnregisterWindow(id);
      manager.UnregisterWindow('sidebar');
      manager.Dispose();
    }
  });

  test('still switches exclusively between query windows after revealing navigation', () => {
    const manager = createWindowManager();
    const first = uniqueId('first-query');
    const second = uniqueId('second-query');
    try {
      manager.RegisterWindow(createRef('sidebar'));
      manager.RegisterWindow(createRef(first));
      manager.RegisterWindow(createRef(second));
      manager.ShowWindow(first);
      manager.ShowWindow('sidebar');
      manager.ShowWindow(second);
      expect(manager.IsVisible(first)).toBe(false);
      expect(manager.IsVisible(second)).toBe(true);
    } finally {
      manager.UnregisterWindow(first);
      manager.UnregisterWindow(second);
      manager.UnregisterWindow('sidebar');
      manager.Dispose();
    }
  });
});
