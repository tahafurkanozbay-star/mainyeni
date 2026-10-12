import { useEffect, useMemo, useReducer } from 'react';
import { LoggingBusiness } from '../../Business/LoggingBusiness';
import type { UnknownRecord } from '../../Business/contracts';
import { DebugHelper } from '../../Toolbox/DebugHelper';
import { CommonReducer_ActionTypes } from '../Reducers/CommonReducer';
import { MapReducer_ActionTypes } from '../Reducers/MapReducer';
import Store from '../Store';
import type { MessageState, WindowRegistration } from '../contracts';

export interface ManagedWindowHandle {
  readonly id: string;
  readonly title?: string;
  readonly visible?: boolean;
  readonly minimized?: boolean;
  readonly OnShow?: () => void;
  readonly OnClose?: () => void;
  readonly [key: string]: unknown;
}

export interface ManagedWindowRef {
  readonly current?: ManagedWindowHandle | null;
}

export interface RegisterPlaceholderDefaults {
  readonly title?: string;
  readonly visible?: boolean;
  readonly minimized?: boolean;
  readonly query?: UnknownRecord | null;
}

export interface ManagedWindowSnapshotRecord {
  readonly id: string;
  readonly title: string | null;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly lazy: boolean;
}

export interface WindowManagerSnapshot {
  readonly revision: number;
  readonly activeWindowId: string | null;
  readonly visibleCount: number;
  readonly minimizedCount: number;
  readonly windows: readonly ManagedWindowSnapshotRecord[];
}

export interface WindowManagerObserverDiagnostics {
  readonly activeListenerCount: number;
  readonly listenerFailureCount: number;
  readonly disposed: boolean;
}

export interface WindowManagerApi {
  readonly RegisterPlaceholder: (windowid: string, defaults?: RegisterPlaceholderDefaults) => boolean;
  readonly RegisterWindow: (windowRef: ManagedWindowRef | null | undefined) => boolean;
  readonly UnregisterWindow: (windowid: string, windowRef?: ManagedWindowRef | null) => boolean;
  readonly ToggleWindow: (windowid: string, query?: UnknownRecord | null) => boolean;
  readonly ShowWindow: (windowid: string, query?: UnknownRecord | null) => boolean;
  readonly GetQueryParams: (windowid: string) => UnknownRecord | null | undefined;
  readonly HideWindow: (windowid: string) => boolean;
  readonly ToggleMinimiseWindow: (windowid: string) => boolean;
  readonly IsVisible: (windowid: string) => boolean;
  readonly IsMinimized: (windowid: string) => boolean;
  readonly GetMessage: () => MessageState | null;
  readonly ShowMessage: (type: string | number, text: string, durationSeconds?: number) => void;
  readonly RemoveMessage: () => void;
  readonly SetMapUpdating: (value: boolean) => void;
  readonly GetMapUpdating: () => boolean;
  readonly GetWindowSnapshot: () => WindowManagerSnapshot;
  readonly SubscribeWindows: (listener: () => void) => () => void;
  readonly GetWindowObserverDiagnostics: () => WindowManagerObserverDiagnostics;
  readonly Dispose: () => void;
}

const noop = (): void => undefined;

const callSafely = (callback: (() => unknown) | null | undefined): void => {
  try {
    void Promise.resolve(callback?.()).catch((error: unknown) => DebugHelper.Log(error));
  } catch (error) {
    DebugHelper.Log(error);
  }
};

const schedule = (callback: () => void): void => {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(callback);
    return;
  }
  void Promise.resolve().then(callback);
};

const toWindowRef = (value: unknown): ManagedWindowRef | null => {
  if (!value || typeof value !== 'object') return null;
  return value as ManagedWindowRef;
};

const readWindowHandle = (registration: WindowRegistration | undefined): ManagedWindowHandle | null =>
  toWindowRef(registration?.ref)?.current ?? null;

const sanitizeDuration = (value: number): number => {
  if (!Number.isFinite(value)) return 5;
  return Math.min(3600, Math.max(0, value));
};

const sanitizeWindowTitle = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, 180) : null;
};

const snapshotSignature = (windows: readonly WindowRegistration[]): string =>
  windows.map((item) => [
    String(item.id ?? ''),
    sanitizeWindowTitle(item.title) ?? '',
    item.visible === true ? '1' : '0',
    item.minimized === true ? '1' : '0',
    item.lazy === true ? '1' : '0',
  ].join(':')).join('|');

const createWindowSnapshot = (
  revision: number,
  windows: readonly WindowRegistration[],
): WindowManagerSnapshot => {
  const records = Object.freeze(windows.map((item) => Object.freeze({
    id: String(item.id ?? '').trim(),
    title: sanitizeWindowTitle(item.title),
    visible: item.visible === true,
    minimized: item.minimized === true,
    lazy: item.lazy === true,
  })));
  const active = records.find((item) => item.visible && !item.minimized) ?? null;
  return Object.freeze({
    revision,
    activeWindowId: active?.id ?? null,
    visibleCount: records.filter((item) => item.visible).length,
    minimizedCount: records.filter((item) => item.visible && item.minimized).length,
    windows: records,
  });
};

export const createWindowManager = (requestRender: () => void = noop): WindowManagerApi => {
  let messageTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let disposed = false;
  let windowSnapshotRevision = 0;
  let windowSnapshotSignature = '';
  let windowSnapshot = createWindowSnapshot(0, Store.getState().Common.WindowList ?? []);
  let storeUnsubscribe: (() => void) | null = null;
  let windowListenerFailures = 0;
  const windowListeners = new Set<() => void>();

  const getWindowList = (): readonly WindowRegistration[] => Store.getState().Common.WindowList ?? [];

  const refreshWindowSnapshot = (notify = true): void => {
    const windows = getWindowList();
    const signature = snapshotSignature(windows);
    if (signature === windowSnapshotSignature) return;
    windowSnapshotSignature = signature;
    windowSnapshotRevision += 1;
    windowSnapshot = createWindowSnapshot(windowSnapshotRevision, windows);
    if (!notify) return;
    for (const listener of Array.from(windowListeners)) {
      try {
        listener();
      } catch (error) {
        windowListenerFailures += 1;
        DebugHelper.Log(error);
      }
    }
  };

  const ensureStoreSubscription = (): void => {
    if (storeUnsubscribe || disposed || windowListeners.size === 0) return;
    storeUnsubscribe = Store.subscribe(() => refreshWindowSnapshot(true));
  };

  const releaseStoreSubscriptionIfIdle = (): void => {
    if (windowListeners.size > 0 || !storeUnsubscribe) return;
    storeUnsubscribe();
    storeUnsubscribe = null;
  };
  const getWindow = (windowid: string): WindowRegistration | undefined =>
    getWindowList().find((item) => item.id === windowid);
  const refresh = (): void => {
    if (!disposed) requestRender();
  };

  const manager: WindowManagerApi = {
    RegisterPlaceholder: (windowid, defaults = {}) => {
      const normalizedId = String(windowid ?? '').trim();
      if (!normalizedId || getWindow(normalizedId)) return false;

      Store.dispatch({
        type: CommonReducer_ActionTypes.RegisterWindow,
        payload: {
          id: normalizedId,
          title: sanitizeWindowTitle(defaults.title),
          ref: null,
          visible: Boolean(defaults.visible),
          minimized: Boolean(defaults.minimized),
          query: defaults.query ?? {},
          lazy: true,
        },
      });
      return true;
    },

    RegisterWindow: (windowRef) => {
      const current = windowRef?.current;
      const id = String(current?.id ?? '').trim();
      if (!id) return false;

      const existing = getWindow(id);
      Store.dispatch({
        type: CommonReducer_ActionTypes.RegisterWindow,
        payload: {
          id,
          title: existing?.title ?? sanitizeWindowTitle(current?.title),
          ref: windowRef,
          visible: existing?.visible ?? Boolean(current?.visible),
          minimized: existing?.minimized ?? Boolean(current?.minimized),
          query: existing?.query ?? {},
          lazy: false,
        },
      });

      if (existing?.visible && existing.ref !== windowRef && current?.OnShow) {
        schedule(() => callSafely(current.OnShow));
      }
      return true;
    },

    UnregisterWindow: (windowid, windowRef = null) => {
      const targetId = String(windowid ?? '').trim();
      const existing = getWindow(targetId);
      if (!existing) return false;
      if (windowRef && existing.ref && existing.ref !== windowRef) return false;

      Store.dispatch({
        type: CommonReducer_ActionTypes.RemoveWindow,
        payload: { windowid: targetId },
      });
      return true;
    },

    ToggleWindow: (windowid, query) => {
      const target = getWindow(windowid);
      if (!target) return false;
      return target.visible ? manager.HideWindow(windowid) : manager.ShowWindow(windowid, query);
    },

    ShowWindow: (windowid, query = {}) => {
      const target = getWindow(windowid);
      if (!target) {
        DebugHelper.Log(`Window not registered: ${windowid}`);
        return false;
      }

      callSafely(() => LoggingBusiness.CreateClientLog('Pencere Aç', windowid));
      getWindowList().forEach((item) => {
        if (item.id === windowid || !item.visible) return;
        callSafely(readWindowHandle(item)?.OnClose);
      });

      Store.dispatch({
        type: CommonReducer_ActionTypes.ActivateWindow,
        payload: { windowid, query: query ?? {} },
      });

      callSafely(readWindowHandle(target)?.OnShow);
      refresh();
      return true;
    },

    GetQueryParams: (windowid) => getWindow(windowid)?.query,

    HideWindow: (windowid) => {
      const target = getWindow(windowid);
      if (!target) return false;

      callSafely(readWindowHandle(target)?.OnClose);
      Store.dispatch({
        type: CommonReducer_ActionTypes.SetWindowVisibility,
        payload: { windowid, visible: false, query: {} },
      });
      refresh();
      return true;
    },

    ToggleMinimiseWindow: (windowid) => {
      const target = getWindow(windowid);
      if (!target) return false;

      Store.dispatch({
        type: CommonReducer_ActionTypes.SetWindowMinimized,
        payload: { windowid, minimized: !target.minimized },
      });
      refresh();
      return true;
    },

    IsVisible: (windowid) => Boolean(getWindow(windowid)?.visible),
    IsMinimized: (windowid) => Boolean(getWindow(windowid)?.minimized),
    GetMessage: () => Store.getState().Common.Message,

    ShowMessage: (type, text, durationSeconds = 5) => {
      if (messageTimer !== null) globalThis.clearTimeout(messageTimer);
      Store.dispatch({
        type: CommonReducer_ActionTypes.SetMessage,
        payload: {
          messageType: type,
          messageText: String(text ?? ''),
        },
      });
      refresh();

      messageTimer = globalThis.setTimeout(() => {
        manager.RemoveMessage();
      }, sanitizeDuration(durationSeconds) * 1000);
    },

    RemoveMessage: () => {
      if (messageTimer !== null) {
        globalThis.clearTimeout(messageTimer);
        messageTimer = null;
      }
      Store.dispatch({ type: CommonReducer_ActionTypes.SetMessage, payload: null });
      refresh();
    },

    SetMapUpdating: (value) => {
      const normalized = Boolean(value);
      if (Store.getState().Map.IsUpdating === normalized) return;
      Store.dispatch({ type: MapReducer_ActionTypes.SetMapUpdating, payload: normalized });
      refresh();
    },

    GetMapUpdating: () => Boolean(Store.getState().Map.IsUpdating),

    GetWindowSnapshot: () => {
      refreshWindowSnapshot(false);
      return windowSnapshot;
    },

    SubscribeWindows: (listener) => {
      if (disposed || typeof listener !== 'function') return () => undefined;
      windowListeners.add(listener);
      refreshWindowSnapshot(false);
      ensureStoreSubscription();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        windowListeners.delete(listener);
        releaseStoreSubscriptionIfIdle();
      };
    },

    GetWindowObserverDiagnostics: () => Object.freeze({
      activeListenerCount: windowListeners.size,
      listenerFailureCount: windowListenerFailures,
      disposed,
    }),

    Dispose: () => {
      if (disposed) return;
      disposed = true;
      if (messageTimer !== null) globalThis.clearTimeout(messageTimer);
      messageTimer = null;
      storeUnsubscribe?.();
      storeUnsubscribe = null;
      windowListeners.clear();
    },
  };

  Object.freeze(manager);
  return manager;
};

// Backward-compatible factory for non-React callers. React components should use useWindowManager.
export const WindowManager = (): WindowManagerApi => createWindowManager();

export const useWindowManager = (): WindowManagerApi => {
  const [, forceRender] = useReducer((value: number) => value + 1, 0);
  const manager = useMemo(() => createWindowManager(forceRender), [forceRender]);
  useEffect(() => () => manager.Dispose(), [manager]);
  return manager;
};
