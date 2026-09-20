import type { RawRequestConfig } from '../../platform/http/contracts';
import type { ArcGisQueryOptions, QueryExecutionControl, ServiceDescriptor } from '../contracts';

export type BusinessPrimitive = string | number | boolean | null;
export type BusinessRecord = Readonly<Record<string, unknown>>;
export type MutableBusinessRecord = Record<string, unknown>;

export type BusinessDiagnosticStatus =
  | 'planned'
  | 'started'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'empty'
  | 'rejected';

export interface BusinessRuntimePolicy {
  readonly maxTextLength: number;
  readonly maxIdentifierLength: number;
  readonly maxIdentifierCount: number;
  readonly maxWhereLength: number;
  readonly maxDiagnosticEntries: number;
  readonly defaultCacheTtlMs: number;
  readonly maxCacheTtlMs: number;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly minNearbyDistance: number;
  readonly maxNearbyDistance: number;
}

export interface BusinessDiagnosticEvent {
  readonly sequence: number;
  readonly operation: string;
  readonly status: BusinessDiagnosticStatus;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly serviceKey?: string;
  readonly code?: string;
  readonly featureCount?: number;
  readonly metadata?: BusinessRecord;
}

export interface BusinessDiagnosticSnapshot {
  readonly capacity: number;
  readonly sequence: number;
  readonly events: readonly BusinessDiagnosticEvent[];
  readonly counts: Readonly<Record<BusinessDiagnosticStatus, number>>;
}

export interface BusinessDiagnostics {
  readonly begin: (
    operation: string,
    details?: {
      readonly serviceKey?: string;
      readonly metadata?: BusinessRecord;
    },
  ) => BusinessDiagnosticHandle;
  readonly record: (
    operation: string,
    status: BusinessDiagnosticStatus,
    details?: BusinessDiagnosticRecordInput,
  ) => BusinessDiagnosticEvent;
  readonly snapshot: () => BusinessDiagnosticSnapshot;
  readonly clear: () => number;
}

export interface BusinessDiagnosticHandle {
  readonly operation: string;
  readonly startedAt: number;
  readonly finish: (
    status: Exclude<BusinessDiagnosticStatus, 'planned' | 'started'>,
    details?: BusinessDiagnosticRecordInput,
  ) => BusinessDiagnosticEvent;
}

export interface BusinessDiagnosticRecordInput {
  readonly serviceKey?: string;
  readonly code?: string;
  readonly featureCount?: number;
  readonly metadata?: BusinessRecord;
  readonly startedAt?: number;
  readonly completedAt?: number;
}

export interface ServiceRegistry {
  readonly list: () => readonly ServiceDescriptor[];
  readonly find: (serviceKey: string) => ServiceDescriptor | null;
  readonly require: (serviceKey: string) => ServiceDescriptor;
  readonly resolveUrl: (service: ServiceDescriptor) => string | null;
  readonly requireUrl: (serviceKey: string) => string;
  readonly snapshot: () => readonly ServiceRegistryEntry[];
}

export interface ServiceRegistryEntry {
  readonly key: string;
  readonly url: string | null;
  readonly index: number;
}

export interface ServiceRegistryDependencies {
  readonly listServices: () => readonly ServiceDescriptor[] | unknown;
}

export interface NormalizedIdentifier {
  readonly value: string;
  readonly source: unknown;
}

export interface NormalizedIdentifierList {
  readonly values: readonly string[];
  readonly rejected: number;
  readonly duplicates: number;
  readonly truncated: boolean;
}

export interface NormalizedBusinessQuery {
  readonly name: string | null;
  readonly districtId: string | null;
  readonly neighborhoodId: string | null;
  readonly objectId: string | null;
  readonly showNearby: boolean;
  readonly bufferDistance: number;
  readonly userLocation: unknown;
}

export interface RouteBusinessQuery extends NormalizedBusinessQuery {
  readonly showCultureWalkingRoute: boolean;
  readonly showNatureWalkingRoute: boolean;
  readonly routeLevel: number | null;
}

export interface NumberingSearchQuery {
  readonly districtName: string | null;
  readonly neighborhoodName: string | null;
}

export interface TkgmParcelQuery {
  readonly district: string;
  readonly neighborhood: string;
  readonly cityBlock: string;
  readonly parcel: string;
}

export interface GeographicPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export interface SqlPredicatePlan {
  readonly predicates: readonly string[];
  readonly where: string;
  readonly truncated: boolean;
}

export interface QueryPlan {
  readonly serviceKey: string;
  readonly options: ArcGisQueryOptions;
  readonly spatial: boolean;
  readonly fingerprint: string;
}

export interface QueryPlanner {
  readonly plan: (input: QueryPlannerInput) => QueryPlan;
}

export interface QueryPlannerInput {
  readonly serviceKey: string;
  readonly returnGeometry?: boolean;
  readonly where?: string;
  readonly orderByFields?: readonly string[];
  readonly outFields?: readonly string[];
  readonly spatial?: {
    readonly geometry: unknown;
    readonly distance?: unknown;
    readonly distanceMeters?: unknown;
    readonly units?: 'meters';
    readonly spatialRelationship?: 'intersects';
  };
}

export interface QueryRuntimeDependencies {
  readonly services: ServiceRegistry;
  readonly diagnostics: BusinessDiagnostics;
  readonly executeQuery: (options: ArcGisQueryOptions) => Promise<unknown>;
  readonly executeSpatialQuery: (options: ArcGisQueryOptions) => Promise<unknown>;
}

export interface QueryRuntime {
  readonly execute: (
    plan: QueryPlan,
    control?: QueryExecutionControl,
  ) => Promise<unknown>;
}

export interface ApiRequestControl {
  readonly signal?: AbortSignal;
  readonly cacheTtlMs?: unknown;
  readonly timeoutMs?: unknown;
  readonly cache?: boolean;
  readonly dedupe?: boolean;
}

export interface NormalizedApiRequestControl {
  readonly signal?: AbortSignal;
  readonly cacheTtlMs: number;
  readonly timeoutMs: number;
  readonly cache: boolean;
  readonly dedupe: boolean;
}

export interface ApiClientLike {
  readonly get: <TResult = unknown>(
    url: string,
    options?: RawRequestConfig,
  ) => Promise<TResult>;
}

export interface ApiRuntimeDependencies {
  readonly client: ApiClientLike;
  readonly diagnostics: BusinessDiagnostics;
}

export interface ApiRuntime {
  readonly get: <TResult = unknown>(
    operation: string,
    url: string,
    options?: {
      readonly params?: Readonly<Record<string, unknown>>;
      readonly control?: ApiRequestControl;
      readonly serviceKey?: string;
    },
  ) => Promise<TResult>;
}

export class BusinessRuntimeError extends Error {
  readonly code: string;
  readonly metadata: BusinessRecord;

  constructor(
    code: string,
    message: string,
    metadata: BusinessRecord = Object.freeze({}),
  ) {
    super(message);
    this.name = 'BusinessRuntimeError';
    this.code = code;
    this.metadata = metadata;
  }
}

export class MissingBusinessServiceError extends BusinessRuntimeError {
  readonly serviceKey: string;

  constructor(serviceKey: string) {
    super(
      'BUSINESS_SERVICE_NOT_FOUND',
      `Servis bulunamadı (${serviceKey})`,
      Object.freeze({ serviceKey }),
    );
    this.name = 'MissingBusinessServiceError';
    this.serviceKey = serviceKey;
  }
}

export class InvalidBusinessInputError extends BusinessRuntimeError {
  constructor(code: string, message: string, metadata: BusinessRecord = Object.freeze({})) {
    super(code, message, metadata);
    this.name = 'InvalidBusinessInputError';
  }
}

export class BusinessQueryPlanError extends BusinessRuntimeError {
  constructor(code: string, message: string, metadata: BusinessRecord = Object.freeze({})) {
    super(code, message, metadata);
    this.name = 'BusinessQueryPlanError';
  }
}
