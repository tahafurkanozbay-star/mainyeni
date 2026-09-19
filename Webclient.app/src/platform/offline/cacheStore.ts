import type {
  OfflineCacheLimits,
  OfflineCachePutResult,
  OfflineRequestKind,
} from './contracts';
import {
  createOfflineCacheLedger,
  type OfflineCacheLedger,
} from './cacheLedger';

export interface OfflineCacheStoreOptions {
  readonly cacheStorage: CacheStorage;
  readonly cacheName: string;
  readonly limits: OfflineCacheLimits;
  readonly now?: () => number;
  readonly ledger?: OfflineCacheLedger;
}

export interface OfflineCacheStore {
  readonly match: (request: Request) => Promise<Response | null>;
  readonly put: (
    request: Request,
    response: Response,
    kind: Exclude<OfflineRequestKind, 'bypass'>,
  ) => Promise<OfflineCachePutResult>;
  readonly delete: (request: Request) => Promise<boolean>;
  readonly clear: () => Promise<number>;
  readonly hydrate: () => Promise<number>;
  readonly ledger: OfflineCacheLedger;
}

const requestKey = (request: Request): string => request.url;

const contentLength = (response: Response): number | null => {
  const raw = response.headers.get('content-length');
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const responseBytes = async (
  response: Response,
  limit: number,
): Promise<number> => {
  const declared = contentLength(response);
  if (declared !== null) {
    if (declared > limit) throw new RangeError('Offline response exceeds maxEntryBytes.');
    return declared;
  }
  const buffer = await response.clone().arrayBuffer();
  if (buffer.byteLength > limit) throw new RangeError('Offline response exceeds maxEntryBytes.');
  return buffer.byteLength;
};

export const createOfflineCacheStore = (
  options: OfflineCacheStoreOptions,
): OfflineCacheStore => {
  const ledger = options.ledger ?? createOfflineCacheLedger({
    limits: options.limits,
    ...(options.now ? { now: options.now } : {}),
  });

  const open = (): Promise<Cache> => options.cacheStorage.open(options.cacheName);

  const removeEvicted = async (keys: readonly string[]): Promise<void> => {
    if (keys.length === 0) return;
    const cache = await open();
    await Promise.all(keys.map((key) => cache.delete(key)));
  };

  const match = async (request: Request): Promise<Response | null> => {
    const cache = await open();
    const response = await cache.match(request);
    if (!response) {
      ledger.remove(requestKey(request));
      return null;
    }
    const existing = ledger.touch(requestKey(request));
    if (!existing) {
      const declared = contentLength(response) ?? 0;
      ledger.record(requestKey(request), {
        kind: 'static',
        bytes: Math.min(declared, options.limits.maxEntryBytes),
        measured: declared > 0,
      });
    }
    return response;
  };

  const put = async (
    request: Request,
    response: Response,
    kind: Exclude<OfflineRequestKind, 'bypass'>,
  ): Promise<OfflineCachePutResult> => {
    let bytes = 0;
    try {
      bytes = await responseBytes(response, options.limits.maxEntryBytes);
    } catch {
      return Object.freeze({
        stored: false,
        reason: 'entry-too-large',
        bytes: 0,
        evicted: Object.freeze([]),
      });
    }

    const cache = await open();
    await cache.put(request, response.clone());
    ledger.record(requestKey(request), { kind, bytes, measured: true });
    const evicted = ledger.prune();
    await removeEvicted(evicted);
    return Object.freeze({
      stored: true,
      reason: 'stored',
      bytes,
      evicted,
    });
  };

  const remove = async (request: Request): Promise<boolean> => {
    ledger.remove(requestKey(request));
    const cache = await open();
    return cache.delete(request);
  };

  const clear = async (): Promise<number> => {
    const count = ledger.clear();
    await options.cacheStorage.delete(options.cacheName);
    return count;
  };

  const hydrate = async (): Promise<number> => {
    const cache = await open();
    const keys = await cache.keys();
    let added = 0;
    for (const request of keys) {
      if (ledger.get(requestKey(request))) continue;
      const response = await cache.match(request);
      if (!response) continue;
      const declared = contentLength(response) ?? 0;
      ledger.record(requestKey(request), {
        kind: 'static',
        bytes: Math.min(declared, options.limits.maxEntryBytes),
        measured: declared > 0,
      });
      added += 1;
    }
    const evicted = ledger.prune();
    await removeEvicted(evicted);
    return added;
  };

  return Object.freeze({
    match,
    put,
    delete: remove,
    clear,
    hydrate,
    ledger,
  });
};
