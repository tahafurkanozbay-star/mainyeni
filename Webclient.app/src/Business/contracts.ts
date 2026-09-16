export type UnknownRecord = Readonly<Record<string, unknown>>;
export type MutableRecord = Record<string, unknown>;

export type QueryPrimitive = string | number | boolean | null;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];

export interface PointLike {
  readonly x?: number;
  readonly y?: number;
  readonly longitude?: number;
  readonly latitude?: number;
  readonly spatialReference?: UnknownRecord;
}

export interface ServiceDescriptor extends UnknownRecord {
  readonly id?: string | number;
  readonly title?: string;
  readonly Title?: string;
  readonly eg?: string;
  readonly Eg?: string;
  readonly url?: string;
  readonly Url?: string;
  readonly layerType?: number;
  readonly visible?: boolean;
  readonly opacity?: number;
}

export interface FastAccessQuery {
  readonly ObjectId?: number | string | null;
  readonly objectId?: number | string | null;
  readonly name?: string | null;
  readonly districtId?: string | number | null;
  readonly nbhoodId?: string | number | null;
  readonly showNearby?: boolean;
  readonly bufferDistance?: number | string | null;
  readonly userLocation?: unknown;
}

export interface ArcGisQueryOptions extends MutableRecord {
  url: string;
  where?: string;
  returnGeometry?: boolean;
  orderByFields?: readonly string[];
  outFields?: readonly string[];
  geometry?: unknown;
  distance?: number;
  units?: string;
  spatialRelationship?: string;
  objectIds?: readonly number[];
  resultOffset?: number;
  resultRecordCount?: number;
}

export interface ArcGisField {
  readonly name?: string;
  readonly alias?: string;
  readonly type?: string;
  readonly domain?: {
    readonly codedValues?: readonly CodedValue[];
  } | null;
}

export interface CodedValue {
  readonly code?: QueryPrimitive;
  readonly name?: string;
}

export interface ArcGisFeature<TAttributes extends UnknownRecord = UnknownRecord> {
  readonly attributes?: TAttributes;
  readonly geometry?: unknown;
  readonly layer?: unknown;
  readonly sourceLayer?: unknown;
}

export interface ArcGisFeatureSet<TAttributes extends UnknownRecord = UnknownRecord> {
  readonly features?: readonly ArcGisFeature<TAttributes>[];
  readonly fields?: readonly ArcGisField[];
  readonly exceededTransferLimit?: boolean;
  readonly spatialReference?: unknown;
  readonly displayFieldName?: string;
}

export type ServiceResultType = 10 | 20;

export interface ServiceSuccess<TData> {
  readonly type: 10;
  readonly data: TData;
  readonly message?: string;
}

export interface ServiceFailure {
  readonly type: 20;
  readonly data?: unknown;
  readonly message: string;
  readonly code?: string;
}

export type ServiceResult<TData> = ServiceSuccess<TData> | ServiceFailure;

export interface LegacyServiceResult<TData = unknown> {
  readonly Type?: number | string;
  readonly Data?: TData;
  readonly Message?: string;
  readonly type?: number | string;
  readonly data?: TData;
  readonly message?: string;
}

export interface QueryExecutionResult<TAttributes extends UnknownRecord = UnknownRecord> {
  readonly features: readonly ArcGisFeature<TAttributes>[];
  readonly fields: readonly ArcGisField[];
  readonly exceededTransferLimit: boolean;
  readonly raw: unknown;
}

export interface QueryBusiness<TQuery extends FastAccessQuery = FastAccessQuery> {
  readonly Query: (
    query?: TQuery,
    returnGeometry?: boolean,
    options?: QueryExecutionControl,
  ) => Promise<unknown>;
}

export interface QueryExecutionControl {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly deduplicate?: boolean;
  readonly cache?: boolean;
  readonly requestKey?: string;
}

export type BusinessOperationStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timeout'
  | 'cache-hit'
  | 'deduplicated';

export interface BusinessDiagnostic {
  readonly id: string;
  readonly operation: string;
  readonly status: BusinessOperationStatus;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly serviceKey?: string;
  readonly cacheKey?: string;
  readonly featureCount?: number;
  readonly code?: string;
}

export interface BusinessRuntimeSnapshot {
  readonly startedAt: number;
  readonly active: number;
  readonly queued: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly timedOut: number;
  readonly cacheHits: number;
  readonly deduplicated: number;
  readonly diagnostics: readonly BusinessDiagnostic[];
}

export interface BusinessCacheEntry<TValue> {
  readonly key: string;
  readonly value: TValue;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly serviceKey: string;
}

export interface QueryPolicy {
  readonly maxWhereLength: number;
  readonly maxNameLength: number;
  readonly maxIdLength: number;
  readonly minNearbyDistance: number;
  readonly maxNearbyDistance: number;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly defaultCacheTtlMs: number;
  readonly maxCacheTtlMs: number;
}

export interface QueryRuntimeClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
}

export interface QueryExecutor {
  readonly execute: (options: ArcGisQueryOptions, control?: QueryExecutionControl) => Promise<unknown>;
  readonly executeSpatial: (options: ArcGisQueryOptions, control?: QueryExecutionControl) => Promise<unknown>;
}

export interface ServiceResolver {
  readonly list: () => readonly ServiceDescriptor[];
  readonly find: (serviceKey: string) => ServiceDescriptor | null;
  readonly resolveUrl: (service: ServiceDescriptor) => string | null;
}

export interface BusinessRuntimeDependencies {
  readonly resolveService: ServiceResolver;
  readonly executor: QueryExecutor;
  readonly clock?: QueryRuntimeClock;
  readonly maxDiagnostics?: number;
  readonly maxCacheEntries?: number;
  readonly maxConcurrent?: number;
}

export interface NormalizedFastAccessQuery {
  readonly objectId: number | null;
  readonly name: string | null;
  readonly districtId: string | null;
  readonly neighborhoodId: string | null;
  readonly showNearby: boolean;
  readonly bufferDistance: number;
  readonly userLocation: unknown;
}

export interface CompiledQuery {
  readonly where: string;
  readonly spatial: boolean;
  readonly geometry?: unknown;
  readonly distance?: number;
  readonly units?: 'meters';
  readonly spatialRelationship?: 'intersects';
  readonly fingerprint: string;
}

export interface QueryFingerprintInput {
  readonly serviceKey: string;
  readonly query: NormalizedFastAccessQuery;
  readonly returnGeometry: boolean;
}

export class BusinessContractError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'BusinessContractError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class BusinessAbortError extends BusinessContractError {
  constructor(message = 'İşlem iptal edildi.') {
    super('ABORTED', message, false);
    this.name = 'AbortError';
  }
}

export class BusinessTimeoutError extends BusinessContractError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super('TIMEOUT', `İşlem ${timeoutMs} ms içinde tamamlanamadı.`, true);
    this.name = 'BusinessTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class ServiceNotFoundError extends BusinessContractError {
  readonly serviceKey: string;

  constructor(serviceKey: string) {
    super('SERVICE_NOT_FOUND', `Servis bulunamadı (${serviceKey})`, false);
    this.name = 'ServiceNotFoundError';
    this.serviceKey = serviceKey;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

export const asString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

export const asFiniteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export const asBoolean = (value: unknown): boolean => value === true;

export const normalizeString = (
  value: unknown,
  maximumLength = 256,
): string | null => {
  const text = asString(value);
  if (!text) return null;
  return text.slice(0, Math.max(1, maximumLength));
};

export const normalizeServiceDescriptor = (value: unknown): ServiceDescriptor | null => {
  if (!isRecord(value)) return null;
  return value as ServiceDescriptor;
};

export const serviceTitle = (service: ServiceDescriptor): string | null =>
  normalizeString(service.title ?? service.Title, 256);

export const serviceUrl = (service: ServiceDescriptor): string | null =>
  normalizeString(service.eg ?? service.Eg ?? service.url ?? service.Url, 2048);

export const isServiceSuccess = <TData>(result: ServiceResult<TData>): result is ServiceSuccess<TData> =>
  result.type === 10;

export const toReadonlyArray = <TValue>(value: unknown): readonly TValue[] =>
  Array.isArray(value) ? Object.freeze([...value]) as readonly TValue[] : Object.freeze([]) as readonly TValue[];

export const freezeRecord = <TValue extends Record<string, unknown>>(value: TValue): Readonly<TValue> =>
  Object.freeze({ ...value });

export const normalizeFeatureSet = <TAttributes extends UnknownRecord = UnknownRecord>(
  value: unknown,
): QueryExecutionResult<TAttributes> => {
  const root = isRecord(value) ? value : {};
  const data = isRecord(root.data) ? root.data : root;
  const features = Array.isArray(data.features)
    ? data.features.filter(isRecord).map((feature) => Object.freeze(feature) as ArcGisFeature<TAttributes>)
    : [];
  const fields = Array.isArray(data.fields)
    ? data.fields.filter(isRecord).map((field) => Object.freeze(field) as ArcGisField)
    : [];
  return Object.freeze({
    features: Object.freeze(features),
    fields: Object.freeze(fields),
    exceededTransferLimit: data.exceededTransferLimit === true,
    raw: value,
  });
};

export const queryFeatureCount = (value: unknown): number => normalizeFeatureSet(value).features.length;

export const errorCode = (error: unknown): string => {
  if (error instanceof BusinessContractError) return error.code;
  if (isRecord(error) && typeof error.code === 'string') return error.code.slice(0, 80);
  if (isRecord(error) && typeof error.name === 'string') return error.name.slice(0, 80);
  return 'ERROR';
};

export const isAbortError = (error: unknown): boolean => {
  if (error instanceof BusinessAbortError) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (!isRecord(error)) return false;
  return error.name === 'AbortError' || error.code === 'ABORTED' || error.code === 'ERR_CANCELED';
};

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new BusinessAbortError();
};

export const DEFAULT_QUERY_POLICY: Readonly<QueryPolicy> = Object.freeze({
  maxWhereLength: 4096,
  maxNameLength: 160,
  maxIdLength: 64,
  minNearbyDistance: 0,
  maxNearbyDistance: 100,
  defaultTimeoutMs: 15000,
  maxTimeoutMs: 120000,
  defaultCacheTtlMs: 15000,
  maxCacheTtlMs: 300000,
});

export const DEFAULT_QUERY_CLOCK: QueryRuntimeClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
});
