import type { CacheDataClassification } from '../cache/cachePolicy';

export const REQUEST_PRIORITIES = [
  'critical',
  'high',
  'normal',
  'low',
  'background'
] as const;

export type RequestPriority = typeof REQUEST_PRIORITIES[number];

export const HTTP_METHODS = [
  'get',
  'head',
  'post',
  'put',
  'patch',
  'delete',
  'options'
] as const;

export type HttpMethod = typeof HTTP_METHODS[number] | string;

export type ResponseType =
  | 'auto'
  | 'json'
  | 'text'
  | 'blob'
  | 'arraybuffer'
  | 'response';

export type QueryPrimitive = string | number | boolean | bigint | Date | null | undefined;
export type QueryValue = QueryPrimitive | QueryPrimitive[] | Record<string, unknown>;
export type QueryParams = Record<string, QueryValue> | URLSearchParams;

export type RequestBody =
  | string
  | number
  | boolean
  | Record<string, unknown>
  | unknown[]
  | FormData
  | Blob
  | ArrayBuffer
  | URLSearchParams
  | null
  | undefined;

export type RequestHeaders = Record<string, string | number | boolean | null | undefined> | Headers;

export interface RuntimeDefaults {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  cacheTtlMs?: number;
}

export interface RawRequestConfig<TBody = RequestBody> {
  method?: HttpMethod;
  url?: string;
  params?: QueryParams | Record<string, unknown>;
  data?: TBody;
  headers?: RequestHeaders | Record<string, unknown>;
  timeout?: number;
  maxRetries?: number;
  cache?: boolean;
  dedupe?: boolean;
  retryUnsafe?: boolean;
  cacheTtlMs?: number;
  cacheStaleWhileRevalidateMs?: number;
  cacheClassification?: CacheDataClassification;
  cacheNamespace?: string;
  cacheTags?: readonly string[];
  cacheVary?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  signal?: AbortSignal | null;
  responseType?: ResponseType | string;
  includeResponseHeaders?: boolean;
  maxResponseBytes?: number;
  maxRequestBodyBytes?: number;
  credentials?: RequestCredentials;
  fetchCache?: RequestCache;
  redirect?: RequestRedirect;
  integrity?: string;
  keepalive?: boolean;
  priority?: RequestPriority | string;
  schedulerGroup?: string;
  schedulerBypass?: boolean;
  schedulerTimeoutMs?: number;
}

export interface NormalizedRequestConfig<TBody = RequestBody>
  extends Omit<RawRequestConfig<TBody>, 'method' | 'url' | 'headers' | 'timeout' | 'maxRetries' | 'cache' | 'dedupe' | 'cacheTtlMs'> {
  method: string;
  url: string;
  headers: Record<string, string>;
  timeout: number;
  maxRetries: number;
  cache: boolean;
  dedupe: boolean;
  retryAllowed: boolean;
  safeMethod: boolean;
  idempotentMethod: boolean;
  containsSensitiveMetadata: boolean;
  cacheTtlMs: number;
  cacheStaleWhileRevalidateMs: number;
  cacheClassification: CacheDataClassification;
  cacheNamespace: string;
  cacheTags: readonly string[];
  cacheVary: Readonly<Record<string, string | number | boolean | null | undefined>>;
  maxResponseBytes: number;
  maxRequestBodyBytes: number;
}

export interface ResponseMetadata {
  status: number;
  ok?: boolean;
  contentType?: string | null;
  requestId?: string | null;
  url?: string | null;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  cache?: string;
  scheduler?: SchedulerTaskMetadataSnapshot;
  [key: string]: unknown;
}

export interface TransportResult<TData = unknown> {
  data: TData;
  status: number;
  statusText?: string;
  headers?: Headers | Record<string, string> | null;
  metadata?: ResponseMetadata | Readonly<Record<string, unknown>>;
  durationMs?: number;
  fromCache?: boolean;
}

export interface ErrorLike {
  name?: string;
  message?: string;
  code?: string;
  status?: number | null;
  retryable?: boolean;
  response?: {
    status?: number | null;
    headers?: Headers | Record<string, string> | null;
    data?: unknown;
  };
  headers?: Headers | Record<string, string> | null;
}

export interface RetryOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  retryAfterMaxMs?: number;
  now?: number;
  random?: () => number;
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly reason: string;
  readonly attempt: number;
  readonly delayMs: number;
}

export interface RetryOperationContext {
  attempt: number;
  signal?: AbortSignal | null;
}

export interface RetryNotification {
  error: unknown;
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  reason: string;
}

export interface RetryExecutionConfiguration {
  maxRetries?: number;
  retryAllowed?: boolean;
  signal?: AbortSignal | null;
  onAttempt?: (context: RetryOperationContext) => void;
  onRetry?: (notification: RetryNotification) => void;
  retryOptions?: RetryOptions;
  wait?: (milliseconds: number, signal?: AbortSignal | null) => Promise<void>;
}

export interface TransportDefaults extends RuntimeDefaults {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  cacheTtlMs: number;
}

export interface Transport<TData = unknown> {
  defaults?: RuntimeDefaults;
  request: (config: NormalizedRequestConfig | RawRequestConfig) => Promise<TransportResult<TData>>;
  get: (url: string, config?: RawRequestConfig) => Promise<TransportResult<TData>>;
  head: (url: string, config?: RawRequestConfig) => Promise<TransportResult<TData>>;
  post: (url: string, data: RequestBody, config?: RawRequestConfig) => Promise<TransportResult<TData>>;
  put: (url: string, data: RequestBody, config?: RawRequestConfig) => Promise<TransportResult<TData>>;
  patch: (url: string, data: RequestBody, config?: RawRequestConfig) => Promise<TransportResult<TData>>;
  delete: (url: string, config?: RawRequestConfig) => Promise<TransportResult<TData>>;
}

export type RequestTransport<TData = unknown> = Pick<Transport<TData>, 'defaults' | 'request'>;

export interface DiagnosticEvent {
  readonly id: number;
  readonly name: string;
  readonly timestamp: number;
  readonly elapsedMs: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DiagnosticSummary {
  readonly startedAt: number;
  readonly retainedEvents: number;
  readonly totalRecorded: number;
  readonly droppedEvents: number;
  readonly counters: Readonly<Record<string, number>>;
  readonly statusCounters: Readonly<Record<string, number>>;
  readonly durationBuckets: Readonly<Record<string, number>>;
}

export interface DiagnosticsSnapshotOptions {
  eventName?: string;
  sinceId?: number;
  limit?: number;
}

export interface NetworkDiagnosticsLike {
  record: (eventName: string, metadata?: Record<string, unknown>) => DiagnosticEvent | unknown;
  snapshot: (options?: DiagnosticsSnapshotOptions) => readonly DiagnosticEvent[] | readonly unknown[];
  summary: () => DiagnosticSummary | Readonly<Record<string, unknown>>;
  clear: () => void;
}

export interface SchedulerTaskMetadata {
  priority?: RequestPriority | string;
  groupKey?: string;
  label?: string;
  signal?: AbortSignal | null;
  queueTimeoutMs?: number;
  bypass?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SchedulerTaskMetadataSnapshot {
  readonly id: number;
  readonly priority: RequestPriority;
  readonly groupKey: string;
  readonly label: string | null;
  readonly queuedAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly queueWaitMs: number | null;
  readonly runDurationMs: number | null;
}

export interface SchedulerOptions {
  maxConcurrent?: number;
  maxConcurrentPerGroup?: number;
  maxQueued?: number;
  highPriorityReserve?: number;
  agingIntervalMs?: number;
  starvationThresholdMs?: number;
  clock?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  onEvent?: (eventName: string, metadata: Record<string, unknown>) => void;
}

export interface SchedulerCounters {
  scheduled: number;
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  rejected: number;
  bypassed: number;
}

export interface SchedulerSnapshot {
  readonly maxConcurrent: number;
  readonly maxConcurrentPerGroup: number;
  readonly maxQueued: number;
  readonly running: number;
  readonly queued: number;
  readonly peakRunning: number;
  readonly peakQueued: number;
  readonly groups: Readonly<Record<string, { running: number; queued: number }>>;
  readonly priorities: Readonly<Record<RequestPriority, number>>;
  readonly counters: Readonly<SchedulerCounters>;
}

export interface SchedulerLike {
  schedule<T>(task: () => Promise<T> | T, options?: SchedulerTaskMetadata): Promise<T>;
  snapshot(): SchedulerSnapshot;
  getQueuedCount(): number;
  getRunningCount(): number;
  cancelQueued(reason?: string): number;
}

export interface RuntimeCapabilityReport {
  readonly generatedAt: number;
  readonly essential: Readonly<Record<string, boolean>>;
  readonly optional: Readonly<Record<string, boolean>>;
  readonly missingEssential: readonly string[];
  readonly supported: boolean;
}

export type NetworkQuality = 'offline' | 'constrained' | 'limited' | 'normal' | 'fast';

export interface CoarseConnectionProfile {
  readonly quality: NetworkQuality;
  readonly saveData: boolean;
  readonly effectiveType: 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';
  readonly downlinkBucket: 'unknown' | 'lt-1' | '1-4' | '4-10' | 'gte-10';
  readonly rttBucket: 'unknown' | 'lt-100' | '100-299' | '300-999' | 'gte-1000';
  readonly online: boolean;
}

export interface RuntimeTuningProfile {
  readonly network: CoarseConnectionProfile;
  readonly hardwareConcurrency: number;
  readonly memoryClass: 'unknown' | 'low' | 'medium' | 'high';
  readonly scheduler: Readonly<{
    maxConcurrent: number;
    maxConcurrentPerGroup: number;
    maxQueued: number;
    highPriorityReserve: number;
    agingIntervalMs: number;
    starvationThresholdMs: number;
  }>;
  readonly prefetchAllowed: boolean;
  readonly backgroundWorkAllowed: boolean;
  readonly timeoutMultiplier: number;
}

export interface CoordinatedClient {
  request<T = unknown>(config?: RawRequestConfig): Promise<T>;
  requestRaw<T = unknown>(config?: RawRequestConfig): Promise<TransportResult<T>>;
  get<T = unknown>(url: string, config?: RawRequestConfig): Promise<T>;
  head<T = unknown>(url: string, config?: RawRequestConfig): Promise<T>;
  post<T = unknown>(url: string, data?: RequestBody, config?: RawRequestConfig): Promise<T>;
  put<T = unknown>(url: string, data?: RequestBody, config?: RawRequestConfig): Promise<T>;
  patch<T = unknown>(url: string, data?: RequestBody, config?: RawRequestConfig): Promise<T>;
  delete<T = unknown>(url: string, config?: RawRequestConfig): Promise<T>;
  clearCache(): number;
  invalidateCache(prefix?: string): number;
  getCacheSize(): number;
  getInFlightSize(): number;
  invalidateCacheTags(tags: readonly string[]): number;
  invalidateCacheNamespace(namespace: string): number;
  getCacheRuntimeSnapshot(): Readonly<Record<string, unknown>>;
  getRequestScopeSnapshot(): Readonly<Record<string, unknown>>;
  drain(options?: {
    readonly cancelActive?: boolean;
    readonly reason?: unknown;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  dispose(reason?: unknown): void;
  getDiagnostics(options?: DiagnosticsSnapshotOptions): readonly unknown[];
  getDiagnosticSummary(): Readonly<Record<string, unknown>>;
  clearDiagnostics(): void;
  getSchedulerSnapshot(): SchedulerSnapshot;
  coordinator: unknown;
}

const PRIORITY_SET = new Set<string>(REQUEST_PRIORITIES);

export const isRequestPriority = (value: unknown): value is RequestPriority =>
  typeof value === 'string' && PRIORITY_SET.has(value.trim().toLowerCase());

export const normalizeRequestPriority = (
  value: unknown,
  fallback: RequestPriority = 'normal'
): RequestPriority => {
  if (!isRequestPriority(value)) return fallback;
  return value.trim().toLowerCase() as RequestPriority;
};

export const isAbortSignalLike = (value: unknown): value is AbortSignal => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AbortSignal> & {
    addEventListener?: unknown;
    removeEventListener?: unknown;
  };
  return typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function';
};

export const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const toFiniteNumber = (
  value: unknown,
  fallback: number,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

export const toBoundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number => Math.round(toFiniteNumber(value, fallback, minimum, maximum));

export const normalizeSchedulerGroup = (value: unknown): string => {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:/-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (text || 'default').slice(0, 96);
};

export const normalizeSchedulerLabel = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const queryIndex = raw.search(/[?#]/);
  const safe = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  return (safe.trim() || 'request').slice(0, 120);
};

export const freezeShallow = <T extends Record<string, unknown>>(value: T): Readonly<T> =>
  Object.freeze({ ...value });

export const readErrorLike = (error: unknown): ErrorLike => {
  if (!error || typeof error !== 'object') return {};
  return error as ErrorLike;
};

export const getErrorCode = (error: unknown): string | null => {
  const code = readErrorLike(error).code;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
};

export const getErrorStatus = (error: unknown): number | null => {
  const candidate = readErrorLike(error);
  const status = candidate.status ?? candidate.response?.status;
  const numeric = Number(status);
  return Number.isFinite(numeric) ? numeric : null;
};

export const getErrorRetryable = (error: unknown): boolean =>
  readErrorLike(error).retryable === true;

export const assertNever = (value: never, message = 'Unexpected value'): never => {
  throw new TypeError(`${message}: ${String(value)}`);
};
