import { RequestCache } from '../cache/requestCache';
import { createNetworkDiagnostics, recordNetworkEvent } from './networkDiagnostics';
import { createRequestKey, normalizeRequestConfig } from './requestPolicy';
import { executeWithRetry } from './retryPolicy';
import {
  getErrorCode,
  getErrorRetryable,
  getErrorStatus,
  isAbortSignalLike,
  normalizeRequestPriority,
  toBoundedInteger
} from './contracts';
import type {
  CoordinatedClient,
  DiagnosticsSnapshotOptions,
  NetworkDiagnosticsLike,
  NormalizedRequestConfig,
  RawRequestConfig,
  RequestBody,
  RequestPriority,
  RuntimeTuningProfile,
  SchedulerLike,
  SchedulerSnapshot,
  Transport,
  TransportResult
} from './contracts';
import {
  createRequestScheduler,
  getSchedulerGroupFromPath
} from './requestScheduler';
import { createRuntimeTuningProfile } from './runtimeCapabilities';

const DEFAULT_MAX_CACHE_ENTRIES = 150;
const DEFAULT_QUEUE_TIMEOUT_MS = 5000;

interface CoordinatorOptions {
  transport: Transport;
  timeoutMs?: number;
  maxRetries?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  cache?: InstanceType<typeof RequestCache>;
  diagnostics?: NetworkDiagnosticsLike;
  clock?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal | null) => Promise<void>;
  retryOptions?: Record<string, unknown>;
  scheduler?: SchedulerLike;
  tuningProfile?: RuntimeTuningProfile;
  schedulerOptions?: Record<string, unknown>;
}

interface CoordinatorDefaults {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly cacheTtlMs: number;
}

interface TransportAttemptConfig extends NormalizedRequestConfig {
  readonly attempt: number;
}

const now = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) ? value : Date.now();
};

const cloneCachedResult = <T>(entry: TransportResult<T>): TransportResult<T> => Object.freeze({
  ...entry,
  metadata: entry?.metadata
    ? Object.freeze({ ...entry.metadata, cache: 'hit' })
    : Object.freeze({ cache: 'hit' }),
  fromCache: true
});

const getDefaultPriority = (config: NormalizedRequestConfig): RequestPriority => {
  const explicit = config.priority;
  if (explicit) return normalizeRequestPriority(explicit);
  if (config.method === 'head') return 'low';
  if (config.safeMethod) return 'normal';
  return 'high';
};

const getQueueTimeout = (config: NormalizedRequestConfig): number => {
  if (config.schedulerTimeoutMs !== undefined) {
    return toBoundedInteger(config.schedulerTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS, 0, 120000);
  }
  const requestTimeout = toBoundedInteger(config.timeout, 15000, 1, 60000);
  return Math.max(1000, Math.min(DEFAULT_QUEUE_TIMEOUT_MS, Math.round(requestTimeout * 0.4)));
};

const createSchedulerEventBridge = (diagnostics: NetworkDiagnosticsLike) =>
  (eventName: string, metadata: Record<string, unknown>): void => {
    recordNetworkEvent(diagnostics, eventName, metadata);
  };

const getRuntimeSignal = (config: NormalizedRequestConfig): AbortSignal | undefined =>
  isAbortSignalLike(config.signal) ? config.signal : undefined;

export class RequestCoordinator {
  readonly transport: Transport;
  readonly defaults: CoordinatorDefaults;
  readonly cache: InstanceType<typeof RequestCache>;
  readonly diagnostics: NetworkDiagnosticsLike;
  readonly scheduler: SchedulerLike;
  readonly tuningProfile: RuntimeTuningProfile;

  private readonly inFlight = new Map<string, Promise<TransportResult<unknown>>>();
  private readonly clock: () => number;
  private readonly wait?: (milliseconds: number, signal?: AbortSignal | null) => Promise<void>;
  private readonly retryOptions: Record<string, unknown>;

  constructor(options: CoordinatorOptions) {
    if (!options?.transport || typeof options.transport.request !== 'function') {
      throw new TypeError('RequestCoordinator requires transport.request');
    }

    this.transport = options.transport;
    this.defaults = Object.freeze({
      timeoutMs: options.timeoutMs ?? options.transport.defaults?.timeoutMs ?? 15000,
      maxRetries: options.maxRetries ?? options.transport.defaults?.maxRetries ?? 0,
      cacheTtlMs: options.cacheTtlMs ?? options.transport.defaults?.cacheTtlMs ?? 0
    });
    this.cache = options.cache || new RequestCache({
      ttlMs: this.defaults.cacheTtlMs,
      maxEntries: options.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES
    });
    this.diagnostics = options.diagnostics || createNetworkDiagnostics();
    this.clock = options.clock || Date.now;
    this.wait = options.wait;
    this.retryOptions = options.retryOptions || {};
    this.tuningProfile = options.tuningProfile || createRuntimeTuningProfile();
    this.scheduler = options.scheduler || createRequestScheduler({
      ...this.tuningProfile.scheduler,
      ...(options.schedulerOptions || {}),
      clock: this.clock,
      onEvent: createSchedulerEventBridge(this.diagnostics)
    });
  }

  normalize(config: RawRequestConfig = {}): NormalizedRequestConfig {
    return normalizeRequestConfig(config, this.defaults) as NormalizedRequestConfig;
  }

  getKey(config: NormalizedRequestConfig): string {
    return createRequestKey(config);
  }

  readCache<T>(config: NormalizedRequestConfig, key: string): TransportResult<T> | undefined {
    if (!config.cache) return undefined;

    const cached = this.cache.get(key) as TransportResult<T> | undefined;
    if (cached === undefined) {
      recordNetworkEvent(this.diagnostics, 'network.cache.miss', {
        method: config.method,
        url: config.url
      });
      return undefined;
    }

    recordNetworkEvent(this.diagnostics, 'network.cache.hit', {
      method: config.method,
      url: config.url
    });
    return cloneCachedResult(cached);
  }

  writeCache<T>(config: NormalizedRequestConfig, key: string, result: TransportResult<T>): void {
    if (!config.cache || !result || result.status < 200 || result.status >= 300) return;
    this.cache.set(key, result, config.cacheTtlMs);
    recordNetworkEvent(this.diagnostics, 'network.cache.write', {
      method: config.method,
      url: config.url,
      status: result.status,
      cacheTtlMs: config.cacheTtlMs
    });
  }

  private scheduleTransportAttempt<T>(
    config: NormalizedRequestConfig,
    attempt: number
  ): Promise<TransportResult<T>> {
    const priority = getDefaultPriority(config);
    const safePathGroup = getSchedulerGroupFromPath(config.url);
    const groupKey = config.schedulerGroup
      ? String(config.schedulerGroup)
      : safePathGroup;
    const queueTimeoutMs = getQueueTimeout(config);
    const signal = getRuntimeSignal(config);
    const transportConfig: TransportAttemptConfig = {
      ...config,
      signal,
      attempt
    };

    return this.scheduler.schedule(
      () => this.transport.request(transportConfig) as Promise<TransportResult<T>>,
      {
        priority,
        groupKey,
        label: `${config.method}:${safePathGroup}:attempt-${attempt}`,
        signal,
        queueTimeoutMs,
        bypass: config.schedulerBypass === true
      }
    );
  }

  async execute<T>(
    config: NormalizedRequestConfig,
    key: string
  ): Promise<TransportResult<T>> {
    const startedAt = now(this.clock);
    const signal = getRuntimeSignal(config);
    recordNetworkEvent(this.diagnostics, 'network.request.started', {
      method: config.method,
      url: config.url,
      timeoutMs: config.timeout,
      maxRetries: config.maxRetries,
      cache: config.cache,
      dedupe: config.dedupe,
      priority: getDefaultPriority(config),
      schedulerGroup: config.schedulerGroup || getSchedulerGroupFromPath(config.url)
    });

    try {
      const result = await executeWithRetry(
        ({ attempt }: { attempt: number }) => this.scheduleTransportAttempt<T>(config, attempt),
        {
          maxRetries: config.maxRetries,
          retryAllowed: config.retryAllowed,
          signal,
          retryOptions: this.retryOptions,
          wait: this.wait,
          onAttempt: ({ attempt }: { attempt: number }) => {
            recordNetworkEvent(this.diagnostics, 'network.request.attempt', {
              method: config.method,
              url: config.url,
              attempt
            });
          },
          onRetry: ({ error, attempt, nextAttempt, delayMs }: {
            error: unknown;
            attempt: number;
            nextAttempt: number;
            delayMs: number;
          }) => {
            recordNetworkEvent(this.diagnostics, 'network.request.retry', {
              method: config.method,
              url: config.url,
              status: getErrorStatus(error),
              code: getErrorCode(error),
              attempt,
              nextAttempt,
              delayMs
            });
          }
        }
      ) as TransportResult<T>;

      const durationMs = Math.max(0, now(this.clock) - startedAt);
      const completed: TransportResult<T> = Object.freeze({
        ...result,
        durationMs: result?.durationMs ?? durationMs,
        fromCache: false
      });

      this.writeCache(config, key, completed);
      recordNetworkEvent(this.diagnostics, 'network.request.completed', {
        method: config.method,
        url: config.url,
        status: completed.status,
        durationMs
      });
      return completed;
    } catch (error) {
      const durationMs = Math.max(0, now(this.clock) - startedAt);
      recordNetworkEvent(this.diagnostics, 'network.request.failed', {
        method: config.method,
        url: config.url,
        status: getErrorStatus(error),
        code: getErrorCode(error),
        retryable: getErrorRetryable(error),
        durationMs
      });
      throw error;
    }
  }

  request<T = unknown>(rawConfig: RawRequestConfig = {}): Promise<TransportResult<T>> {
    let config: NormalizedRequestConfig;
    let key: string;
    let cached: TransportResult<T> | undefined;

    try {
      config = this.normalize(rawConfig);
      key = this.getKey(config);
      cached = this.readCache<T>(config, key);
    } catch (error) {
      return Promise.reject(error);
    }

    if (cached !== undefined) return Promise.resolve(cached);

    if (config.dedupe && this.inFlight.has(key)) {
      recordNetworkEvent(this.diagnostics, 'network.dedupe.join', {
        method: config.method,
        url: config.url
      });
      return this.inFlight.get(key) as Promise<TransportResult<T>>;
    }

    let promise: Promise<TransportResult<T>>;
    promise = this.execute<T>(config, key)
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
          recordNetworkEvent(this.diagnostics, 'network.dedupe.release', {
            method: config.method,
            url: config.url
          });
        }
      });

    if (config.dedupe) {
      this.inFlight.set(key, promise as Promise<TransportResult<unknown>>);
      recordNetworkEvent(this.diagnostics, 'network.dedupe.start', {
        method: config.method,
        url: config.url
      });
    }

    return promise;
  }

  clearCache(): number {
    const sizeBefore = this.cache.size();
    this.cache.clear();
    recordNetworkEvent(this.diagnostics, 'network.cache.clear', { removed: sizeBefore });
    return sizeBefore;
  }

  invalidateCache(prefix = ''): number {
    const removed = prefix ? this.cache.invalidatePrefix(prefix) : this.clearCache();
    if (prefix) {
      recordNetworkEvent(this.diagnostics, 'network.cache.invalidate', { prefix, removed });
    }
    return removed;
  }

  getCacheSize(): number {
    return this.cache.size();
  }

  getInFlightSize(): number {
    return this.inFlight.size;
  }

  getDiagnostics(options: DiagnosticsSnapshotOptions = {}): readonly unknown[] {
    return this.diagnostics.snapshot(options);
  }

  getDiagnosticSummary(): Readonly<Record<string, unknown>> {
    return this.diagnostics.summary() as Readonly<Record<string, unknown>>;
  }

  getSchedulerSnapshot(): SchedulerSnapshot {
    return this.scheduler.snapshot();
  }

  clearDiagnostics(): void {
    this.diagnostics.clear();
  }
}

export const createRequestCoordinator = (options: CoordinatorOptions): RequestCoordinator =>
  new RequestCoordinator(options);

export const createCoordinatedClient = (options: CoordinatorOptions): CoordinatedClient => {
  const coordinator = createRequestCoordinator(options);

  const requestRaw = <T = unknown>(config: RawRequestConfig = {}) => coordinator.request<T>(config);
  const request = async <T = unknown>(config: RawRequestConfig = {}): Promise<T> => {
    const result = await requestRaw<T>(config);
    return result.data;
  };

  return Object.freeze({
    request,
    requestRaw,
    get: <T = unknown>(url: string, config: RawRequestConfig = {}) =>
      request<T>({ ...config, url, method: 'get' }),
    head: <T = unknown>(url: string, config: RawRequestConfig = {}) =>
      request<T>({ ...config, url, method: 'head' }),
    post: <T = unknown>(url: string, data?: RequestBody, config: RawRequestConfig = {}) =>
      request<T>({ ...config, url, data, method: 'post', cache: false, dedupe: false }),
    put: <T = unknown>(url: string, data?: RequestBody, config: RawRequestConfig = {}) =>
      request<T>({ ...config, url, data, method: 'put', cache: false, dedupe: false }),
    patch: <T = unknown>(url: string, data?: RequestBody, config: RawRequestConfig = {}) =>
      request<T>({ ...config, url, data, method: 'patch', cache: false, dedupe: false }),
    delete: <T = unknown>(url: string, config: RawRequestConfig = {}) =>
      request<T>({ ...config, url, method: 'delete', cache: false, dedupe: false }),
    clearCache: () => coordinator.clearCache(),
    invalidateCache: (prefix?: string) => coordinator.invalidateCache(prefix),
    getCacheSize: () => coordinator.getCacheSize(),
    getInFlightSize: () => coordinator.getInFlightSize(),
    getDiagnostics: (optionsArg?: DiagnosticsSnapshotOptions) => coordinator.getDiagnostics(optionsArg),
    getDiagnosticSummary: () => coordinator.getDiagnosticSummary(),
    clearDiagnostics: () => coordinator.clearDiagnostics(),
    getSchedulerSnapshot: () => coordinator.getSchedulerSnapshot(),
    coordinator
  });
};
