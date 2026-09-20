import { createNetworkDiagnostics, recordNetworkEvent } from './networkDiagnostics';
import { normalizeRequestConfig } from './requestPolicy';
import { executeWithRetry } from './retryPolicy';
import {
  getErrorCode,
  getErrorRetryable,
  getErrorStatus,
  isAbortSignalLike,
  normalizeRequestPriority,
  toBoundedInteger,
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
  TransportResult,
} from './contracts';
import {
  createRequestScheduler,
  getSchedulerGroupFromPath,
} from './requestScheduler';
import { createRuntimeTuningProfile } from './runtimeCapabilities';
import {
  createHttpCacheRuntime,
  type HttpCacheRuntime,
  type HttpCacheRuntimeOptions,
} from './httpCacheRuntime';

const DEFAULT_MAX_CACHE_ENTRIES = 150;
const DEFAULT_QUEUE_TIMEOUT_MS = 5000;

interface CoordinatorOptions {
  readonly transport: Transport;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly cacheTtlMs?: number;
  readonly maxCacheEntries?: number;
  readonly cacheRuntime?: HttpCacheRuntime;
  readonly cacheRuntimeOptions?: Omit<HttpCacheRuntimeOptions, 'onEvent'>;
  readonly diagnostics?: NetworkDiagnosticsLike;
  readonly clock?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal | null) => Promise<void>;
  readonly retryOptions?: Record<string, unknown>;
  readonly scheduler?: SchedulerLike;
  readonly tuningProfile?: RuntimeTuningProfile;
  readonly schedulerOptions?: Record<string, unknown>;
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

const withOperationSignal = (
  config: NormalizedRequestConfig,
  signal?: AbortSignal,
): NormalizedRequestConfig => {
  const { signal: _configuredSignal, ...withoutSignal } = config;
  return Object.freeze({
    ...withoutSignal,
    ...(signal ? { signal } : {}),
  }) as NormalizedRequestConfig;
};

export class RequestCoordinator {
  readonly transport: Transport;
  readonly defaults: CoordinatorDefaults;
  readonly diagnostics: NetworkDiagnosticsLike;
  readonly scheduler: SchedulerLike;
  readonly tuningProfile: RuntimeTuningProfile;
  readonly cacheRuntime: HttpCacheRuntime;

  private readonly clock: () => number;
  private readonly wait: ((milliseconds: number, signal?: AbortSignal | null) => Promise<void>) | undefined;
  private readonly retryOptions: Record<string, unknown>;

  constructor(options: CoordinatorOptions) {
    if (!options?.transport || typeof options.transport.request !== 'function') {
      throw new TypeError('RequestCoordinator requires transport.request');
    }

    this.transport = options.transport;
    this.defaults = Object.freeze({
      timeoutMs: options.timeoutMs ?? options.transport.defaults?.timeoutMs ?? 15000,
      maxRetries: options.maxRetries ?? options.transport.defaults?.maxRetries ?? 0,
      cacheTtlMs: options.cacheTtlMs ?? options.transport.defaults?.cacheTtlMs ?? 0,
    });
    this.diagnostics = options.diagnostics || createNetworkDiagnostics();
    this.clock = options.clock || (() => Date.now());
    this.wait = options.wait;
    this.retryOptions = options.retryOptions || {};
    this.tuningProfile = options.tuningProfile || createRuntimeTuningProfile();
    this.scheduler = options.scheduler || createRequestScheduler({
      ...this.tuningProfile.scheduler,
      ...(options.schedulerOptions || {}),
      clock: this.clock,
      onEvent: createSchedulerEventBridge(this.diagnostics),
    });

    const maxCacheEntries = toBoundedInteger(
      options.maxCacheEntries,
      DEFAULT_MAX_CACHE_ENTRIES,
      1,
      10000,
    );
    this.cacheRuntime = options.cacheRuntime ?? createHttpCacheRuntime({
      ...(options.cacheRuntimeOptions ?? {}),
      ...(options.cacheRuntimeOptions?.coordinator
        ? {}
        : options.cacheRuntimeOptions?.coordinatorOptions
          ? {}
          : {
              coordinatorOptions: {
                storeOptions: {
                  maxEntries: maxCacheEntries,
                  maxEntriesPerNamespace: Math.min(192, maxCacheEntries),
                  clock: Object.freeze({ now: this.clock }),
                },
              },
            }),
      onEvent: createSchedulerEventBridge(this.diagnostics),
    });
  }

  normalize(config: RawRequestConfig = {}): NormalizedRequestConfig {
    return normalizeRequestConfig(config, this.defaults);
  }

  private scheduleTransportAttempt<T>(
    config: NormalizedRequestConfig,
    attempt: number,
  ): Promise<TransportResult<T>> {
    const priority = getDefaultPriority(config);
    const safePathGroup = getSchedulerGroupFromPath(config.url);
    const groupKey = config.schedulerGroup
      ? String(config.schedulerGroup)
      : safePathGroup;
    const queueTimeoutMs = getQueueTimeout(config);
    const signal = getRuntimeSignal(config);
    const { signal: _configuredSignal, ...configWithoutSignal } = config;
    const transportConfig: TransportAttemptConfig = {
      ...configWithoutSignal,
      ...(signal ? { signal } : {}),
      attempt,
    };

    return this.scheduler.schedule(
      () => this.transport.request(transportConfig) as Promise<TransportResult<T>>,
      {
        priority,
        groupKey,
        label: `${config.method}:${safePathGroup}:attempt-${attempt}`,
        ...(signal ? { signal } : {}),
        queueTimeoutMs,
        bypass: config.schedulerBypass === true,
      },
    );
  }

  async execute<T>(config: NormalizedRequestConfig): Promise<TransportResult<T>> {
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
      schedulerGroup: config.schedulerGroup || getSchedulerGroupFromPath(config.url),
    });

    try {
      const result = await executeWithRetry(
        ({ attempt }: { attempt: number }) => this.scheduleTransportAttempt<T>(config, attempt),
        {
          maxRetries: config.maxRetries,
          retryAllowed: config.retryAllowed,
          ...(signal ? { signal } : {}),
          retryOptions: this.retryOptions,
          ...(this.wait ? { wait: this.wait } : {}),
          onAttempt: ({ attempt }: { attempt: number }) => {
            recordNetworkEvent(this.diagnostics, 'network.request.attempt', {
              method: config.method,
              url: config.url,
              attempt,
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
              delayMs,
            });
          },
        },
      ) as TransportResult<T>;

      const durationMs = Math.max(0, now(this.clock) - startedAt);
      const completed: TransportResult<T> = Object.freeze({
        ...result,
        durationMs: result?.durationMs ?? durationMs,
        fromCache: false,
      });

      recordNetworkEvent(this.diagnostics, 'network.request.completed', {
        method: config.method,
        url: config.url,
        status: completed.status,
        durationMs,
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
        durationMs,
      });
      throw error;
    }
  }

  request<T = unknown>(rawConfig: RawRequestConfig = {}): Promise<TransportResult<T>> {
    let config: NormalizedRequestConfig;
    try {
      config = this.normalize(rawConfig);
    } catch (error) {
      return Promise.reject(error);
    }

    return this.cacheRuntime.resolve<T>(
      config,
      (operationSignal) => this.execute<T>(withOperationSignal(config, operationSignal)),
    );
  }

  clearCache(): number {
    return this.cacheRuntime.clear();
  }

  invalidateCache(prefix = ''): number {
    return this.cacheRuntime.invalidatePrefix(prefix);
  }

  invalidateCacheTags(tags: readonly string[]): number {
    return this.cacheRuntime.invalidateTags(tags);
  }

  invalidateCacheNamespace(namespace: string): number {
    return this.cacheRuntime.invalidateNamespace(namespace);
  }

  getCacheSize(): number {
    return this.cacheRuntime.cacheSize();
  }

  getInFlightSize(): number {
    return this.cacheRuntime.inFlightSize();
  }

  getCacheRuntimeSnapshot(): Readonly<Record<string, unknown>> {
    return this.cacheRuntime.snapshot() as unknown as Readonly<Record<string, unknown>>;
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
    invalidateCacheTags: (tags: readonly string[]) => coordinator.invalidateCacheTags(tags),
    invalidateCacheNamespace: (namespace: string) => coordinator.invalidateCacheNamespace(namespace),
    getCacheSize: () => coordinator.getCacheSize(),
    getInFlightSize: () => coordinator.getInFlightSize(),
    getCacheRuntimeSnapshot: () => coordinator.getCacheRuntimeSnapshot(),
    getDiagnostics: (optionsArg?: DiagnosticsSnapshotOptions) => coordinator.getDiagnostics(optionsArg),
    getDiagnosticSummary: () => coordinator.getDiagnosticSummary(),
    clearDiagnostics: () => coordinator.clearDiagnostics(),
    getSchedulerSnapshot: () => coordinator.getSchedulerSnapshot(),
    coordinator,
  });
};
