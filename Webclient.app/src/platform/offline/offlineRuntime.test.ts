import { vi } from 'vitest';
import { createOfflineRuntime } from './offlineRuntime';
import type { OfflineWorkerResponse, OfflineWorkerStatus } from './contracts';

type Listener = () => void;

class FakeWorker {
  state: ServiceWorkerState = 'activated';
  readonly listeners = new Map<string, Set<Listener>>();
  readonly responder: (message: unknown) => OfflineWorkerResponse;

  constructor(responder: (message: unknown) => OfflineWorkerResponse) {
    this.responder = responder;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener as Listener);
    this.listeners.set(type, set);
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    const port = transfer[0] as MessagePort | undefined;
    port?.postMessage(this.responder(message));
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakeRegistration {
  readonly scope = 'https://example.test/';
  installing: ServiceWorker | null = null;
  waiting: ServiceWorker | null = null;
  active: ServiceWorker | null;
  readonly listeners = new Map<string, Set<Listener>>();
  readonly update = vi.fn(async () => undefined);
  readonly unregister = vi.fn(async () => true);

  constructor(active: ServiceWorker) {
    this.active = active;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener as Listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener as Listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const status: OfflineWorkerStatus = Object.freeze({
  protocolVersion: 1,
  cacheVersion: 'v1',
  scope: 'https://example.test/',
  online: true,
  cacheNames: Object.freeze(['kent-v1-static']),
  staticEntries: 2,
  apiEntries: 1,
  controlledClients: 1,
  waiting: false,
});

const responder = (message: unknown): OfflineWorkerResponse => {
  const value = message as { readonly id: string; readonly type: string; readonly cache?: string };
  if (value.type === 'status') {
    return { protocolVersion: 1, id: value.id, ok: true, type: 'status', status };
  }
  if (value.type === 'clear-cache') {
    return { protocolVersion: 1, id: value.id, ok: true, type: 'clear-cache', deleted: 3 };
  }
  if (value.type === 'skip-waiting') {
    return { protocolVersion: 1, id: value.id, ok: true, type: 'skip-waiting' };
  }
  return { protocolVersion: 1, id: value.id, ok: true, type: 'pong', timestamp: 1 };
};

const createEnvironment = () => {
  const worker = new FakeWorker(responder);
  const registration = new FakeRegistration(worker as unknown as ServiceWorker);
  const containerListeners = new Map<string, Set<Listener>>();
  const windowListeners = new Map<string, Set<Listener>>();

  const serviceWorker = {
    controller: worker as unknown as ServiceWorker,
    register: vi.fn(async () => registration as unknown as ServiceWorkerRegistration),
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      const set = containerListeners.get(type) ?? new Set<Listener>();
      set.add(listener as Listener);
      containerListeners.set(type, set);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      containerListeners.get(type)?.delete(listener as Listener);
    },
  };

  const navigatorRef = {
    onLine: true,
    serviceWorker,
  } as unknown as Navigator;

  const windowRef = {
    location: { hostname: 'localhost' },
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      const set = windowListeners.get(type) ?? new Set<Listener>();
      set.add(listener as Listener);
      windowListeners.set(type, set);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      windowListeners.get(type)?.delete(listener as Listener);
    },
  } as unknown as Window;

  return {
    worker,
    registration,
    serviceWorker,
    navigatorRef,
    windowRef,
    containerListeners,
    windowListeners,
    emitContainer: (type: string) => {
      for (const listener of containerListeners.get(type) ?? []) listener();
    },
    emitWindow: (type: string) => {
      for (const listener of windowListeners.get(type) ?? []) listener();
    },
  };
};

describe('offline runtime', () => {
  test('registers module service worker and loads status', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
      scriptUrl: '/service-worker.js',
      scope: '/',
      now: () => 100,
    });
    const snapshot = await runtime.start();
    expect(env.serviceWorker.register).toHaveBeenCalledWith('/service-worker.js', {
      scope: '/',
      type: 'module',
      updateViaCache: 'none',
    });
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.registered).toBe(true);
    expect(snapshot.controlled).toBe(true);
    expect(snapshot.workerStatus?.staticEntries).toBe(2);
  });

  test('deduplicates concurrent start operations', async () => {
    const env = createEnvironment();
    let resolveRegistration: ((value: ServiceWorkerRegistration) => void) | null = null;
    env.serviceWorker.register.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRegistration = resolve;
    }));
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    const first = runtime.start();
    const second = runtime.start();
    expect(first).toBe(second);
    resolveRegistration?.(env.registration as unknown as ServiceWorkerRegistration);
    await first;
    expect(env.serviceWorker.register).toHaveBeenCalledTimes(1);
  });

  test('unsupported environment degrades without throwing', async () => {
    const runtime = createOfflineRuntime({
      navigatorRef: { onLine: true } as Navigator,
      windowRef: { location: { hostname: 'example.test' } } as unknown as Window,
    });
    const snapshot = await runtime.start();
    expect(snapshot.phase).toBe('unsupported');
    expect(snapshot.supported).toBe(false);
  });

  test('registration failure is captured as local error code', async () => {
    const env = createEnvironment();
    env.serviceWorker.register.mockRejectedValueOnce(new DOMException('denied', 'SecurityError'));
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    const snapshot = await runtime.start();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.lastErrorCode).toBe('SecurityError');
    expect(snapshot.events.some((event) => event.type === 'registration-failed')).toBe(true);
  });

  test('offline and online events update phase without polling', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    await runtime.start();
    Object.defineProperty(env.navigatorRef, 'onLine', { value: false, configurable: true });
    env.emitWindow('offline');
    expect(runtime.snapshot().phase).toBe('offline');

    Object.defineProperty(env.navigatorRef, 'onLine', { value: true, configurable: true });
    env.emitWindow('online');
    expect(runtime.snapshot().phase).toBe('ready');
  });

  test('subscribers receive immutable snapshots and can unsubscribe', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    await runtime.start();
    expect(listener).toHaveBeenCalled();
    expect(Object.isFrozen(listener.mock.calls.at(-1)?.[0])).toBe(true);
    const before = listener.mock.calls.length;
    unsubscribe();
    runtime.stop();
    expect(listener.mock.calls.length).toBe(before);
  });

  test('clear cache uses worker protocol and refreshes status', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    await runtime.start();
    await expect(runtime.clearCache('static')).resolves.toBe(3);
    expect(runtime.snapshot().events.some((event) => event.type === 'cache-cleared')).toBe(true);
  });

  test('checkForUpdate remains explicit and reports waiting worker', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    await runtime.start();
    env.registration.waiting = env.worker as unknown as ServiceWorker;
    await expect(runtime.checkForUpdate()).resolves.toBe(true);
    expect(env.registration.update).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().phase).toBe('update-available');
  });

  test('activateUpdate returns false with no waiting worker', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    await runtime.start();
    await expect(runtime.activateUpdate()).resolves.toBe(false);
  });

  test('activateUpdate sends explicit skip-waiting request', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    await runtime.start();
    env.registration.waiting = env.worker as unknown as ServiceWorker;
    await expect(runtime.activateUpdate()).resolves.toBe(true);
    expect(runtime.snapshot().events.some((event) => event.type === 'update-activation-requested')).toBe(true);
  });

  test('controller change clears update marker', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    await runtime.start();
    env.registration.waiting = env.worker as unknown as ServiceWorker;
    await runtime.checkForUpdate();
    expect(runtime.snapshot().updateAvailable).toBe(true);
    env.emitContainer('controllerchange');
    expect(runtime.snapshot().updateAvailable).toBe(false);
  });

  test('stop detaches browser listeners but keeps registration', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    await runtime.start();
    const snapshot = runtime.stop();
    expect(snapshot.phase).toBe('stopped');
    expect(snapshot.registered).toBe(true);
    expect(env.windowListeners.get('online')?.size ?? 0).toBe(0);
    expect(env.containerListeners.get('controllerchange')?.size ?? 0).toBe(0);
  });

  test('unregister explicitly removes worker registration', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    await runtime.start();
    await expect(runtime.unregister()).resolves.toBe(true);
    expect(env.registration.unregister).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().registered).toBe(false);
  });

  test('event journal is bounded', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
      eventCapacity: 10,
    });
    await runtime.start();
    for (let index = 0; index < 30; index += 1) {
      runtime.stop();
      await runtime.start();
    }
    expect(runtime.snapshot().events.length).toBeLessThanOrEqual(10);
  });

  test('dispose is idempotent and forbids restart', async () => {
    const env = createEnvironment();
    const runtime = createOfflineRuntime({
      navigatorRef: env.navigatorRef,
      windowRef: env.windowRef,
    });
    await runtime.start();
    await runtime.dispose();
    await runtime.dispose();
    expect(runtime.snapshot().phase).toBe('disposed');
    await expect(runtime.start()).rejects.toThrow(/disposed/u);
  });
});
