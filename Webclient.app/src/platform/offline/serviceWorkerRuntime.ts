import type {
  OfflinePolicy,
  OfflineRequestDecision,
  OfflineWorkerRequest,
  OfflineWorkerResponse,
  OfflineWorkerStatus,
} from './contracts';
import {
  canCacheOfflineResponse,
  classifyOfflineRequest,
  createOfflinePolicy,
  limitsForOfflineRequest,
  offlineCacheName,
  timeoutForOfflineRequest,
} from './offlinePolicy';
import { createOfflineCacheStore, type OfflineCacheStore } from './cacheStore';
import {
  isOfflineWorkerRequest,
  offlineWorkerClearResponse,
  offlineWorkerError,
  offlineWorkerPongResponse,
  offlineWorkerSkipWaitingResponse,
  offlineWorkerStatusResponse,
} from './serviceWorkerProtocol';

export interface WaitUntilEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface FetchEventLike extends WaitUntilEventLike {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

export interface MessageSourceLike {
  postMessage(message: unknown): void;
}

export interface MessageEventLike extends WaitUntilEventLike {
  readonly data: unknown;
  readonly source?: MessageSourceLike | null;
  readonly ports?: readonly MessagePort[];
}

export interface WorkerClientLike {
  readonly id?: string;
  readonly url?: string;
  postMessage?(message: unknown): void;
}

export interface WorkerClientsLike {
  claim(): Promise<void>;
  matchAll(options?: { readonly type?: string; readonly includeUncontrolled?: boolean }): Promise<readonly WorkerClientLike[]>;
}

export interface WorkerRegistrationLike {
  readonly scope: string;
  readonly waiting?: unknown;
}

export interface ServiceWorkerScopeLike {
  readonly caches: CacheStorage;
  readonly clients: WorkerClientsLike;
  readonly registration: WorkerRegistrationLike;
  readonly location: Location;
  readonly navigator?: { readonly onLine?: boolean };
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install', listener: (event: WaitUntilEventLike) => void): void;
  addEventListener(type: 'activate', listener: (event: WaitUntilEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}

export interface ServiceWorkerRuntimeOptions {
  readonly scope: ServiceWorkerScopeLike;
  readonly policy?: OfflinePolicy;
  readonly now?: () => number;
}

export interface ServiceWorkerRuntime {
  readonly install: () => Promise<void>;
  readonly activate: () => Promise<void>;
  readonly handleFetch: (event: FetchEventLike) => Promise<Response>;
  readonly handleMessage: (event: MessageEventLike) => Promise<void>;
  readonly status: () => Promise<OfflineWorkerStatus>;
  readonly clearCaches: (target?: 'static' | 'api' | 'all') => Promise<number>;
  readonly attach: () => void;
  readonly policy: OfflinePolicy;
}

const offlineResponse = (request: Request, reason: string): Response => {
  const acceptsJson = request.headers.get('accept')?.includes('application/json') === true;
  if (acceptsJson || new URL(request.url).pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({
      error: 'OFFLINE_UNAVAILABLE',
      message: 'Requested resource is unavailable while offline.',
      reason,
    }), {
      status: 503,
      statusText: 'Offline',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-kent-rehberi-offline': 'miss',
      },
    });
  }
  return new Response(
    '<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Çevrimdışı</title></head><body><main><h1>Bağlantı yok</h1><p>Bu içerik daha önce çevrimdışı kullanım için kaydedilmemiş.</p></main></body></html>',
    {
      status: 503,
      statusText: 'Offline',
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-kent-rehberi-offline': 'miss',
      },
    },
  );
};

const responseWithOfflineHeader = (response: Response, value: string): Response => {
  try {
    const headers = new Headers(response.headers);
    headers.set('x-kent-rehberi-offline', value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
};

const networkWithTimeout = async (
  scope: ServiceWorkerScopeLike,
  request: Request,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const abortFromRequest = (): void => controller.abort(request.signal.reason);
  if (request.signal.aborted) controller.abort(request.signal.reason);
  else request.signal.addEventListener('abort', abortFromRequest, { once: true });

  const timer = setTimeout(
    () => controller.abort(new DOMException('Offline network timeout.', 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await scope.fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abortFromRequest);
  }
};

const safeStore = async (
  store: OfflineCacheStore,
  request: Request,
  response: Response,
  decision: OfflineRequestDecision,
  scopeOrigin: string,
  policy: OfflinePolicy,
): Promise<void> => {
  if (decision.kind === 'bypass') return;
  if (!canCacheOfflineResponse(request, response, decision.kind, scopeOrigin, policy)) return;
  await store.put(request, response, decision.kind);
};

export const createServiceWorkerRuntime = (
  options: ServiceWorkerRuntimeOptions,
): ServiceWorkerRuntime => {
  const scope = options.scope;
  const now = options.now ?? (() => Date.now());
  const policy = options.policy ?? createOfflinePolicy({
    cacheVersion: String(import.meta.env.VITE_VERSION ?? import.meta.env.MODE ?? 'v1'),
  });
  const staticName = offlineCacheName(policy, 'static');
  const apiName = offlineCacheName(policy, 'api');
  const staticStore = createOfflineCacheStore({
    cacheStorage: scope.caches,
    cacheName: staticName,
    limits: policy.staticCache,
    now,
  });
  const apiStore = createOfflineCacheStore({
    cacheStorage: scope.caches,
    cacheName: apiName,
    limits: policy.apiCache,
    now,
  });

  const scopeOrigin = new URL(scope.registration.scope).origin;

  const storeFor = (decision: OfflineRequestDecision): OfflineCacheStore =>
    decision.kind === 'api-read' ? apiStore : staticStore;

  const matchCached = async (
    request: Request,
    decision: OfflineRequestDecision,
  ): Promise<Response | null> => {
    if (!decision.cacheName || decision.kind === 'bypass') return null;
    return storeFor(decision).match(request);
  };

  const networkFirst = async (
    event: FetchEventLike,
    decision: OfflineRequestDecision,
  ): Promise<Response> => {
    try {
      const response = await networkWithTimeout(
        scope,
        event.request,
        timeoutForOfflineRequest(decision.kind, policy),
      );
      if (decision.kind !== 'bypass') {
        const storePromise = safeStore(
          storeFor(decision),
          event.request,
          response.clone(),
          decision,
          scopeOrigin,
          policy,
        ).catch(() => undefined);
        event.waitUntil(storePromise);
      }
      return responseWithOfflineHeader(response, 'network');
    } catch {
      const cached = await matchCached(event.request, decision);
      if (cached) return responseWithOfflineHeader(cached, 'cache-fallback');

      if (decision.kind === 'navigation') {
        const shellRequest = new Request(scope.registration.scope, {
          method: 'GET',
          headers: { accept: 'text/html' },
        });
        const shell = await staticStore.match(shellRequest);
        if (shell) return responseWithOfflineHeader(shell, 'shell-fallback');
      }
      return offlineResponse(event.request, 'network-failed-cache-miss');
    }
  };

  const staleWhileRevalidate = async (
    event: FetchEventLike,
    decision: OfflineRequestDecision,
  ): Promise<Response> => {
    const cached = await matchCached(event.request, decision);
    const refresh = (async (): Promise<Response | null> => {
      try {
        const response = await networkWithTimeout(
          scope,
          event.request,
          timeoutForOfflineRequest(decision.kind, policy),
        );
        if (decision.kind !== 'bypass') {
          await safeStore(
            storeFor(decision),
            event.request,
            response.clone(),
            decision,
            scopeOrigin,
            policy,
          );
        }
        return response;
      } catch {
        return null;
      }
    })();

    if (cached) {
      event.waitUntil(refresh.then(() => undefined));
      return responseWithOfflineHeader(cached, 'stale');
    }
    const response = await refresh;
    return response
      ? responseWithOfflineHeader(response, 'network')
      : offlineResponse(event.request, 'static-network-failed');
  };

  const handleFetch = async (event: FetchEventLike): Promise<Response> => {
    const decision = classifyOfflineRequest(event.request, scopeOrigin, policy);
    if (decision.strategy === 'network-first') return networkFirst(event, decision);
    if (decision.strategy === 'stale-while-revalidate') return staleWhileRevalidate(event, decision);
    if (decision.strategy === 'cache-first') {
      const cached = await matchCached(event.request, decision);
      if (cached) return responseWithOfflineHeader(cached, 'cache');
    }
    try {
      return await scope.fetch(event.request);
    } catch {
      return offlineResponse(event.request, 'network-only-failed');
    }
  };

  const deleteOldVersionCaches = async (): Promise<number> => {
    const names = await scope.caches.keys();
    const prefix = policy.cachePrefix + '-';
    const current = new Set([staticName, apiName]);
    const stale = names.filter((name) => name.startsWith(prefix) && !current.has(name));
    const results = await Promise.all(stale.map((name) => scope.caches.delete(name)));
    return results.filter(Boolean).length;
  };

  const install = async (): Promise<void> => {
    const rootRequest = new Request(scope.registration.scope, {
      method: 'GET',
      headers: { accept: 'text/html' },
      cache: 'reload',
      credentials: 'same-origin',
    });
    try {
      const response = await networkWithTimeout(scope, rootRequest, policy.navigationTimeoutMs);
      const decision = classifyOfflineRequest(rootRequest, scopeOrigin, policy);
      if (canCacheOfflineResponse(rootRequest, response, 'navigation', scopeOrigin, policy)) {
        await staticStore.put(rootRequest, response, decision.kind === 'bypass' ? 'navigation' : decision.kind);
      }
    } catch {
      // First install may occur while offline. Registration remains usable and
      // the next successful navigation can seed the shell cache.
    }
  };

  const activate = async (): Promise<void> => {
    await deleteOldVersionCaches();
    await Promise.all([staticStore.hydrate(), apiStore.hydrate()]);
    await scope.clients.claim();
  };

  const clearCaches = async (
    target: 'static' | 'api' | 'all' = 'all',
  ): Promise<number> => {
    let deleted = 0;
    if (target === 'static' || target === 'all') deleted += await staticStore.clear();
    if (target === 'api' || target === 'all') deleted += await apiStore.clear();
    return deleted;
  };

  const status = async (): Promise<OfflineWorkerStatus> => {
    const names = (await scope.caches.keys())
      .filter((name) => name.startsWith(policy.cachePrefix + '-'))
      .sort();
    const clients = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return Object.freeze({
      protocolVersion: 1,
      cacheVersion: policy.cacheVersion,
      scope: scope.registration.scope,
      online: typeof scope.navigator?.onLine === 'boolean' ? scope.navigator.onLine : null,
      cacheNames: Object.freeze(names),
      staticEntries: staticStore.ledger.snapshot().entries,
      apiEntries: apiStore.ledger.snapshot().entries,
      controlledClients: clients.length,
      waiting: Boolean(scope.registration.waiting),
    });
  };

  const reply = (
    event: MessageEventLike,
    response: OfflineWorkerResponse,
  ): void => {
    const port = event.ports?.[0];
    if (port) {
      port.postMessage(response);
      return;
    }
    event.source?.postMessage(response);
  };

  const executeMessage = async (
    request: OfflineWorkerRequest,
  ): Promise<OfflineWorkerResponse> => {
    if (request.type === 'status') return offlineWorkerStatusResponse(request.id, await status());
    if (request.type === 'ping') return offlineWorkerPongResponse(request.id, now());
    if (request.type === 'clear-cache') {
      const deleted = await clearCaches(request.cache ?? 'all');
      return offlineWorkerClearResponse(request.id, deleted);
    }
    if (request.type === 'skip-waiting') {
      await scope.skipWaiting();
      return offlineWorkerSkipWaitingResponse(request.id);
    }
    return offlineWorkerError(request.id, 'UNSUPPORTED_MESSAGE', 'Unsupported offline worker operation.');
  };

  const handleMessage = async (event: MessageEventLike): Promise<void> => {
    if (!isOfflineWorkerRequest(event.data)) return;
    try {
      reply(event, await executeMessage(event.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Offline worker operation failed.';
      reply(event, offlineWorkerError(event.data.id, 'WORKER_OPERATION_FAILED', message));
    }
  };

  let attached = false;
  const attach = (): void => {
    if (attached) return;
    attached = true;
    scope.addEventListener('install', (event) => {
      event.waitUntil(install());
    });
    scope.addEventListener('activate', (event) => {
      event.waitUntil(activate());
    });
    scope.addEventListener('fetch', (event) => {
      event.respondWith(handleFetch(event));
    });
    scope.addEventListener('message', (event) => {
      event.waitUntil(handleMessage(event));
    });
  };

  return Object.freeze({
    install,
    activate,
    handleFetch,
    handleMessage,
    status,
    clearCaches,
    attach,
    policy,
  });
};
