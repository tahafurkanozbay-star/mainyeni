import type {
  OfflinePhase,
  OfflineRuntimeEvent,
  OfflineRuntimeSnapshot,
  OfflineWorkerResponse,
  OfflineWorkerStatus,
} from './contracts';
import {
  createOfflineWorkerRequest,
  isOfflineWorkerResponse,
} from './serviceWorkerProtocol';

export interface OfflineRuntimeOptions {
  readonly navigatorRef?: Navigator;
  readonly windowRef?: Window;
  readonly scriptUrl?: string;
  readonly scope?: string;
  readonly eventCapacity?: number;
  readonly messageTimeoutMs?: number;
  readonly now?: () => number;
}

export interface OfflineRuntime {
  readonly start: () => Promise<OfflineRuntimeSnapshot>;
  readonly stop: () => OfflineRuntimeSnapshot;
  readonly dispose: () => Promise<void>;
  readonly snapshot: () => OfflineRuntimeSnapshot;
  readonly subscribe: (listener: (snapshot: OfflineRuntimeSnapshot) => void) => () => void;
  readonly refreshStatus: () => Promise<OfflineWorkerStatus | null>;
  readonly clearCache: (target?: 'static' | 'api' | 'all') => Promise<number>;
  readonly activateUpdate: () => Promise<boolean>;
  readonly checkForUpdate: () => Promise<boolean>;
  readonly unregister: () => Promise<boolean>;
}

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const isLocalhost = (hostname: string): boolean =>
  hostname === 'localhost'
  || hostname === '127.0.0.1'
  || hostname === '[::1]';

const errorCode = (error: unknown): string => {
  if (!error || typeof error !== 'object') return 'OFFLINE_RUNTIME_ERROR';
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  const value = candidate.code ?? candidate.name ?? 'OFFLINE_RUNTIME_ERROR';
  return String(value).replace(/[^a-zA-Z0-9_:-]+/gu, '_').slice(0, 80);
};

const eventDetail = (
  detail: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, string | number | boolean | null>> => {
  const safe: Record<string, string | number | boolean | null> = {};
  Object.entries(detail).slice(0, 16).forEach(([key, value]) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      safe[key.slice(0, 60)] = typeof value === 'string' ? value.slice(0, 160) : value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      safe[key.slice(0, 60)] = value;
    }
  });
  return Object.freeze(safe);
};

export const createOfflineRuntime = (
  options: OfflineRuntimeOptions = {},
): OfflineRuntime => {
  const navigatorRef = options.navigatorRef ?? globalThis.navigator;
  const windowRef = options.windowRef ?? globalThis.window;
  const now = options.now ?? (() => Date.now());
  const eventCapacity = clampInteger(options.eventCapacity, 80, 10, 500);
  const messageTimeoutMs = clampInteger(options.messageTimeoutMs, 4000, 500, 30_000);
  const scriptUrl = options.scriptUrl ?? '/service-worker.js';
  const scopePath = options.scope ?? '/';
  const listeners = new Set<(snapshot: OfflineRuntimeSnapshot) => void>();
  const events: OfflineRuntimeEvent[] = [];

  let sequence = 0;
  let phase: OfflinePhase = 'idle';
  let registration: ServiceWorkerRegistration | null = null;
  let workerStatus: OfflineWorkerStatus | null = null;
  let updateAvailable = false;
  let startedAt: number | null = null;
  let lastChangedAt = now();
  let lastErrorCode: string | null = null;
  let disposed = false;
  let attached = false;
  let startPromise: Promise<OfflineRuntimeSnapshot> | null = null;

  const secureContext = Boolean(
    globalThis.isSecureContext
    || isLocalhost(windowRef?.location?.hostname ?? ''),
  );
  const supported = Boolean(
    secureContext
    && navigatorRef
    && 'serviceWorker' in navigatorRef,
  );

  const online = (): boolean => navigatorRef?.onLine !== false;
  const controlled = (): boolean => Boolean(navigatorRef?.serviceWorker?.controller);

  const remember = (
    type: string,
    detail: Readonly<Record<string, unknown>> = {},
  ): void => {
    events.push(Object.freeze({
      id: ++sequence,
      timestamp: now(),
      type: String(type).slice(0, 80),
      detail: eventDetail(detail),
    }));
    while (events.length > eventCapacity) events.shift();
  };

  const snapshot = (): OfflineRuntimeSnapshot => Object.freeze({
    phase,
    supported,
    secureContext,
    online: online(),
    controlled: controlled(),
    registered: Boolean(registration),
    updateAvailable,
    scope: registration?.scope ?? null,
    scriptUrl: registration ? scriptUrl : null,
    lastErrorCode,
    startedAt,
    lastChangedAt,
    workerStatus,
    events: Object.freeze([...events]),
  });

  const publish = (): void => {
    lastChangedAt = now();
    const value = snapshot();
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        // Subscriber isolation is intentional. Runtime state must not be
        // destabilized by diagnostics/UI observers.
      }
    }
  };

  const setPhase = (
    next: OfflinePhase,
    type: string,
    detail: Readonly<Record<string, unknown>> = {},
  ): void => {
    phase = next;
    remember(type, detail);
    publish();
  };

  const controllerChange = (): void => {
    updateAvailable = false;
    remember('controller-changed', { controlled: controlled() });
    publish();
  };

  const onlineChange = (): void => {
    if (!online()) {
      setPhase('offline', 'network-offline');
      return;
    }
    if (registration) setPhase(updateAvailable ? 'update-available' : 'ready', 'network-online');
  };

  const observeInstalling = (worker: ServiceWorker | null): void => {
    if (!worker) return;
    const stateChange = (): void => {
      if (worker.state !== 'installed') return;
      if (controlled()) {
        updateAvailable = true;
        setPhase('update-available', 'update-installed');
      }
    };
    worker.addEventListener('statechange', stateChange);
  };

  const updateFound = (): void => {
    observeInstalling(registration?.installing ?? null);
  };

  const attach = (): void => {
    if (attached || !supported) return;
    attached = true;
    navigatorRef.serviceWorker.addEventListener('controllerchange', controllerChange);
    windowRef.addEventListener('online', onlineChange);
    windowRef.addEventListener('offline', onlineChange);
  };

  const detach = (): void => {
    if (!attached || !supported) return;
    attached = false;
    navigatorRef.serviceWorker.removeEventListener('controllerchange', controllerChange);
    windowRef.removeEventListener('online', onlineChange);
    windowRef.removeEventListener('offline', onlineChange);
    registration?.removeEventListener('updatefound', updateFound);
  };

  const targetWorker = (): ServiceWorker | null =>
    registration?.waiting
    ?? registration?.active
    ?? navigatorRef?.serviceWorker?.controller
    ?? null;

  const send = async (
    type: 'status' | 'clear-cache' | 'skip-waiting' | 'ping',
    target?: 'static' | 'api' | 'all',
  ): Promise<OfflineWorkerResponse> => {
    const worker = targetWorker();
    if (!worker) throw new Error('Offline service worker is not active.');
    const id = 'offline-' + String(now()) + '-' + String(sequence + 1);
    const request = createOfflineWorkerRequest(
      id,
      type,
      type === 'clear-cache' ? { cache: target ?? 'all' } : {},
    );

    return new Promise<OfflineWorkerResponse>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new DOMException('Offline worker message timed out.', 'TimeoutError'));
      }, messageTimeoutMs);

      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        clearTimeout(timer);
        channel.port1.close();
        if (!isOfflineWorkerResponse(event.data)) {
          reject(new TypeError('Offline worker returned an invalid protocol message.'));
          return;
        }
        if (!event.data.ok) {
          const error = new Error(event.data.message);
          Object.assign(error, { code: event.data.code });
          reject(error);
          return;
        }
        resolve(event.data);
      };
      worker.postMessage(request, [channel.port2]);
    });
  };

  const refreshStatus = async (): Promise<OfflineWorkerStatus | null> => {
    if (!registration) return null;
    try {
      const response = await send('status');
      if (response.ok && response.type === 'status') {
        workerStatus = response.status;
        remember('status-refreshed', {
          staticEntries: response.status.staticEntries,
          apiEntries: response.status.apiEntries,
        });
        publish();
        return response.status;
      }
    } catch (error) {
      lastErrorCode = errorCode(error);
      remember('status-failed', { code: lastErrorCode });
      publish();
    }
    return null;
  };

  const start = (): Promise<OfflineRuntimeSnapshot> => {
    if (disposed) return Promise.reject(new Error('Offline runtime is disposed.'));
    if (!supported) {
      setPhase('unsupported', 'unsupported', { secureContext });
      return Promise.resolve(snapshot());
    }
    if (registration && (phase === 'ready' || phase === 'offline' || phase === 'update-available')) {
      return Promise.resolve(snapshot());
    }
    if (startPromise) return startPromise;

    startPromise = (async () => {
      setPhase('registering', 'registration-started');
      attach();
      try {
        registration = await navigatorRef.serviceWorker.register(scriptUrl, {
          scope: scopePath,
          type: 'module',
          updateViaCache: 'none',
        });
        registration.addEventListener('updatefound', updateFound);
        observeInstalling(registration.installing);
        updateAvailable = Boolean(registration.waiting && controlled());
        startedAt = startedAt ?? now();
        lastErrorCode = null;
        setPhase(
          !online() ? 'offline' : updateAvailable ? 'update-available' : 'ready',
          'registration-ready',
          { scope: registration.scope },
        );
        await refreshStatus();
        return snapshot();
      } catch (error) {
        lastErrorCode = errorCode(error);
        setPhase('error', 'registration-failed', { code: lastErrorCode });
        return snapshot();
      } finally {
        startPromise = null;
      }
    })();

    return startPromise;
  };

  const stop = (): OfflineRuntimeSnapshot => {
    if (disposed) return snapshot();
    detach();
    setPhase('stopped', 'runtime-stopped');
    return snapshot();
  };

  const clearCache = async (
    target: 'static' | 'api' | 'all' = 'all',
  ): Promise<number> => {
    const response = await send('clear-cache', target);
    if (response.ok && response.type === 'clear-cache') {
      remember('cache-cleared', { target, deleted: response.deleted });
      await refreshStatus();
      return response.deleted;
    }
    return 0;
  };

  const activateUpdate = async (): Promise<boolean> => {
    if (!registration?.waiting) return false;
    const response = await send('skip-waiting');
    const activated = response.ok && response.type === 'skip-waiting';
    if (activated) remember('update-activation-requested');
    publish();
    return activated;
  };

  const checkForUpdate = async (): Promise<boolean> => {
    if (!registration) return false;
    try {
      await registration.update();
      updateAvailable = Boolean(registration.waiting && controlled());
      if (updateAvailable) setPhase('update-available', 'update-available');
      else {
        remember('update-checked', { available: false });
        publish();
      }
      return updateAvailable;
    } catch (error) {
      lastErrorCode = errorCode(error);
      remember('update-check-failed', { code: lastErrorCode });
      publish();
      return false;
    }
  };

  const unregister = async (): Promise<boolean> => {
    if (!registration) return false;
    const current = registration;
    detach();
    const removed = await current.unregister();
    if (removed) {
      registration = null;
      workerStatus = null;
      updateAvailable = false;
      setPhase('stopped', 'registration-removed');
    }
    return removed;
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    detach();
    listeners.clear();
    disposed = true;
    phase = 'disposed';
    remember('runtime-disposed');
    lastChangedAt = now();
  };

  const subscribe = (
    listener: (snapshot: OfflineRuntimeSnapshot) => void,
  ): (() => void) => {
    if (disposed) throw new Error('Offline runtime is disposed.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return Object.freeze({
    start,
    stop,
    dispose,
    snapshot,
    subscribe,
    refreshStatus,
    clearCache,
    activateUpdate,
    checkForUpdate,
    unregister,
  });
};
