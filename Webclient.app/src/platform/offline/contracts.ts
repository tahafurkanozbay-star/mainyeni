export type OfflinePhase =
  | 'idle'
  | 'unsupported'
  | 'registering'
  | 'ready'
  | 'update-available'
  | 'offline'
  | 'error'
  | 'stopped'
  | 'disposed';

export type OfflineRequestKind = 'navigation' | 'static' | 'api-read' | 'bypass';
export type OfflineStrategy = 'network-first' | 'stale-while-revalidate' | 'cache-first' | 'network-only';

export interface OfflineCacheLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  readonly maxAgeMs: number;
}

export interface OfflinePolicy {
  readonly cachePrefix: string;
  readonly cacheVersion: string;
  readonly staticCache: OfflineCacheLimits;
  readonly apiCache: OfflineCacheLimits;
  readonly navigationTimeoutMs: number;
  readonly apiTimeoutMs: number;
  readonly staticTimeoutMs: number;
  readonly sensitiveQueryKeys: readonly string[];
  readonly publicApiHeader: string;
  readonly publicApiHeaderValue: string;
  readonly allowedStaticExtensions: readonly string[];
}

export interface OfflineRequestDecision {
  readonly kind: OfflineRequestKind;
  readonly strategy: OfflineStrategy;
  readonly cacheName: string | null;
  readonly cacheable: boolean;
  readonly reason: string;
  readonly url: string | null;
}

export interface OfflineCacheRecord {
  readonly key: string;
  readonly kind: Exclude<OfflineRequestKind, 'bypass'>;
  readonly bytes: number;
  readonly measured: boolean;
  readonly createdAt: number;
  readonly accessedAt: number;
  readonly expiresAt: number;
  readonly hits: number;
}

export interface OfflineCacheLedgerSnapshot {
  readonly entries: number;
  readonly bytes: number;
  readonly measuredEntries: number;
  readonly unmeasuredEntries: number;
  readonly hits: number;
  readonly writes: number;
  readonly evictions: number;
  readonly rejections: number;
  readonly records: readonly OfflineCacheRecord[];
}

export interface OfflineCachePutResult {
  readonly stored: boolean;
  readonly reason: string;
  readonly bytes: number;
  readonly evicted: readonly string[];
}

export interface OfflineRuntimeEvent {
  readonly id: number;
  readonly timestamp: number;
  readonly type: string;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export interface OfflineWorkerStatus {
  readonly protocolVersion: 1;
  readonly cacheVersion: string;
  readonly scope: string;
  readonly online: boolean | null;
  readonly cacheNames: readonly string[];
  readonly staticEntries: number;
  readonly apiEntries: number;
  readonly controlledClients: number;
  readonly waiting: boolean;
}

export interface OfflineRuntimeSnapshot {
  readonly phase: OfflinePhase;
  readonly supported: boolean;
  readonly secureContext: boolean;
  readonly online: boolean;
  readonly controlled: boolean;
  readonly registered: boolean;
  readonly updateAvailable: boolean;
  readonly scope: string | null;
  readonly scriptUrl: string | null;
  readonly lastErrorCode: string | null;
  readonly startedAt: number | null;
  readonly lastChangedAt: number;
  readonly workerStatus: OfflineWorkerStatus | null;
  readonly events: readonly OfflineRuntimeEvent[];
}

export type OfflineWorkerRequest =
  | Readonly<{ protocolVersion: 1; id: string; type: 'status' }>
  | Readonly<{ protocolVersion: 1; id: string; type: 'clear-cache'; cache?: 'static' | 'api' | 'all' }>
  | Readonly<{ protocolVersion: 1; id: string; type: 'skip-waiting' }>
  | Readonly<{ protocolVersion: 1; id: string; type: 'ping' }>;

export type OfflineWorkerResponse =
  | Readonly<{ protocolVersion: 1; id: string; ok: true; type: 'status'; status: OfflineWorkerStatus }>
  | Readonly<{ protocolVersion: 1; id: string; ok: true; type: 'clear-cache'; deleted: number }>
  | Readonly<{ protocolVersion: 1; id: string; ok: true; type: 'skip-waiting' }>
  | Readonly<{ protocolVersion: 1; id: string; ok: true; type: 'pong'; timestamp: number }>
  | Readonly<{ protocolVersion: 1; id: string; ok: false; type: 'error'; code: string; message: string }>;

export interface OfflineRuntimeModuleSnapshot {
  readonly phase: OfflinePhase;
  readonly runtime: OfflineRuntimeSnapshot;
  readonly startCount: number;
  readonly suspendCount: number;
  readonly resumeCount: number;
  readonly stopCount: number;
}

export const OFFLINE_PROTOCOL_VERSION = 1 as const;
