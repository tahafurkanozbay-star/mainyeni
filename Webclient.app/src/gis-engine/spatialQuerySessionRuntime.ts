import type { ArcGisCapabilityContract } from "./serviceCapabilityRuntime";
import {
  type SpatialQueryAdmissionController,
  type SpatialQueryBudgetPolicy,
  type SpatialQueryCapabilities,
  type SpatialQueryExecutionResult,
  type SpatialQueryPagePlan,
  type SpatialQueryPageResult,
  type SpatialQueryPlan,
  createSpatialQueryAdmissionController,
  executeSpatialQueryPlan,
  planSpatialQuery,
} from "./spatialQueryBudgetRuntime";
import {
  type CompiledSpatialQueryContract,
  type SpatialQueryContractInput,
  compileSpatialQueryContract,
  spatialQueryContractCacheKey,
} from "./spatialQueryContractRuntime";
import {
  type SpatialFeature,
  type SpatialFeatureIntegrityOptions,
  type SpatialFeatureIntegrityResult,
  inspectSpatialFeatures,
} from "./spatialReferenceFeatureRuntime";

export interface SpatialQueryMemoContext {
  readonly key: string;
  readonly signal?: AbortSignal;
  readonly startedAt: number;
}

export interface SpatialQueryMemo {
  readonly execute: <T>(
    key: string,
    factory: (context: SpatialQueryMemoContext) => Promise<T> | T,
    options?: Readonly<{
      signal?: AbortSignal;
      cache?: boolean;
      dedupe?: boolean;
      ttlMs?: unknown;
      tags?: Array<string | number | null | undefined>;
    }>,
  ) => Promise<T>;
  readonly invalidateTag: (tag: string | number) => number;
}

export interface SpatialQueryTransportContext {
  readonly capability: ArcGisCapabilityContract;
  readonly contract: CompiledSpatialQueryContract;
  readonly plan: SpatialQueryPlan;
  readonly page: SpatialQueryPagePlan;
  readonly signal: AbortSignal;
}

export interface SpatialQueryTransport {
  readonly executePage: (
    context: SpatialQueryTransportContext,
  ) => Promise<SpatialQueryPageResult<SpatialFeature>>;
}

export interface SpatialQuerySessionRequest {
  readonly contract?: SpatialQueryContractInput;
  readonly budget: SpatialQueryBudgetPolicy;
  readonly integrity?: SpatialFeatureIntegrityOptions;
  readonly cache?: boolean;
  readonly dedupe?: boolean;
  readonly cacheTtlMs?: number;
  readonly signal?: AbortSignal;
}

export interface SpatialQuerySessionResult {
  readonly contract: CompiledSpatialQueryContract;
  readonly plan: SpatialQueryPlan;
  readonly execution: SpatialQueryExecutionResult<SpatialFeature>;
  readonly integrity: SpatialFeatureIntegrityResult;
  readonly cacheKey: string;
  readonly generation: number;
}

export interface SpatialQuerySessionStats {
  readonly requests: number;
  readonly successes: number;
  readonly failures: number;
  readonly cancellations: number;
  readonly invalidations: number;
  readonly generation: number;
  readonly admittedFeatures: number;
  readonly returnedFeatures: number;
  readonly pagesRead: number;
}

export interface SpatialQuerySessionOptions {
  readonly capability: ArcGisCapabilityContract;
  readonly transport: SpatialQueryTransport;
  readonly memo?: SpatialQueryMemo;
  readonly admission?: SpatialQueryAdmissionController;
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  readonly cacheNamespace?: string;
  readonly cacheTtlMs?: number;
  readonly defaultIntegrity?: SpatialFeatureIntegrityOptions;
}

export interface SpatialQuerySession {
  readonly capability: ArcGisCapabilityContract;
  readonly query: (request: SpatialQuerySessionRequest) => Promise<SpatialQuerySessionResult>;
  readonly invalidate: (reason?: string) => number;
  readonly stats: () => SpatialQuerySessionStats;
  readonly dispose: (reason?: unknown) => void;
}

function capabilityBudgetInput(capability: ArcGisCapabilityContract): SpatialQueryCapabilities {
  return Object.freeze({
    maxRecordCount: capability.maxRecordCount,
    supportsPagination: capability.supportsPagination,
    supportsOrderBy: capability.supportsOrderBy,
    supportsStatistics: capability.supportsStatistics,
    supportsDistinct: capability.queryCapabilities.includes("distinct"),
    supportsReturningGeometryCentroid: capability.queryCapabilities.includes("centroid"),
    supportsQuantization: capability.queryCapabilities.includes("quantization"),
  });
}

function positiveTtl(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError("cacheTtlMs must be a finite positive number");
  }
  return Math.floor(resolved);
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("spatial query session aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function mergeIntegrityOptions(
  base: SpatialFeatureIntegrityOptions | undefined,
  override: SpatialFeatureIntegrityOptions | undefined,
  signal: AbortSignal,
): SpatialFeatureIntegrityOptions {
  return {
    ...base,
    ...override,
    signal,
  };
}

export function createSpatialQuerySession(
  options: SpatialQuerySessionOptions,
): SpatialQuerySession {
  const capability = options.capability;
  if (!capability.supportsQuery) {
    throw new Error("cannot create query session without verified ArcGIS query capability");
  }
  const admission =
    options.admission ??
    createSpatialQueryAdmissionController(options.maxConcurrent ?? 4, options.maxQueued ?? 32);
  const ownsAdmission = options.admission === undefined;
  const namespace = (options.cacheNamespace ?? "spatial-query-session").trim();
  if (!namespace) {
    throw new TypeError("cache namespace must not be empty");
  }
  const defaultTtl = positiveTtl(options.cacheTtlMs, 60_000);
  const tag = `${namespace}:${capability.resourceUrl ?? capability.serviceId ?? capability.name ?? "anonymous"}`;

  let generation = 0;
  let disposed = false;
  let requests = 0;
  let successes = 0;
  let failures = 0;
  let cancellations = 0;
  let invalidations = 0;
  let admittedFeatures = 0;
  let returnedFeatures = 0;
  let pagesRead = 0;

  const runQuery = async (
    request: SpatialQuerySessionRequest,
    contract: CompiledSpatialQueryContract,
    plan: SpatialQueryPlan,
    signal: AbortSignal,
    cacheKey: string,
  ): Promise<SpatialQuerySessionResult> => {
    const execution = await executeSpatialQueryPlan(
      plan,
      async (page, pageSignal) =>
        options.transport.executePage({
          capability,
          contract,
          plan,
          page,
          signal: pageSignal,
        }),
      signal,
    );

    const integrity = inspectSpatialFeatures(
      execution.features,
      mergeIntegrityOptions(options.defaultIntegrity, request.integrity, signal),
    );

    return Object.freeze({
      contract,
      plan,
      execution: Object.freeze({
        ...execution,
        features: integrity.features,
      }),
      integrity,
      cacheKey,
      generation,
    });
  };

  const query = async (
    request: SpatialQuerySessionRequest,
  ): Promise<SpatialQuerySessionResult> => {
    if (disposed) {
      throw new Error("spatial query session is disposed");
    }
    if (request.signal?.aborted) {
      cancellations += 1;
      throw abortError(request.signal.reason);
    }
    requests += 1;

    const contract = compileSpatialQueryContract(capability, request.contract);
    const plan = planSpatialQuery(capabilityBudgetInput(capability), {
      ...request.budget,
      includeGeometry: contract.returnGeometry,
      geometryPrecision: contract.geometryPrecision,
      requireStableOrder:
        request.budget.requireStableOrder ?? contract.stablePagination,
      objectIdField: request.budget.objectIdField ?? contract.objectIdField,
    });
    admittedFeatures += plan.admittedFeatures;

    const baseKey = spatialQueryContractCacheKey(capability, contract, namespace);
    const cacheKey = `${baseKey}:g${generation}:m${plan.mode}:n${plan.admittedFeatures}`;

    const execute = async (signal: AbortSignal): Promise<SpatialQuerySessionResult> =>
      runQuery(request, contract, plan, signal, cacheKey);

    try {
      let result: SpatialQuerySessionResult;
      if (options.memo) {
        const memoOptions = {
          cache: request.cache !== false,
          dedupe: request.dedupe !== false,
          ttlMs: positiveTtl(request.cacheTtlMs, defaultTtl),
          tags: [tag, `${tag}:generation:${generation}`],
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        };
        result = await options.memo.execute(
          cacheKey,
          ({ signal }) =>
            admission.run(
              (admissionSignal) => execute(admissionSignal),
              signal,
            ),
          memoOptions,
        );
      } else {
        result = await admission.run(execute, request.signal);
      }
      successes += 1;
      returnedFeatures += result.integrity.acceptedCount;
      pagesRead += result.execution.pagesRead;
      return result;
    } catch (error) {
      if (isAbort(error, request.signal)) {
        cancellations += 1;
      } else {
        failures += 1;
      }
      throw error;
    }
  };

  const invalidate = (): number => {
    generation += 1;
    invalidations += 1;
    return options.memo?.invalidateTag(tag) ?? 0;
  };

  const stats = (): SpatialQuerySessionStats =>
    Object.freeze({
      requests,
      successes,
      failures,
      cancellations,
      invalidations,
      generation,
      admittedFeatures,
      returnedFeatures,
      pagesRead,
    });

  const dispose = (reason: unknown = new Error("spatial query session disposed")): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    generation += 1;
    options.memo?.invalidateTag(tag);
    if (ownsAdmission) {
      admission.dispose(reason);
    }
  };

  return Object.freeze({
    capability,
    query,
    invalidate,
    stats,
    dispose,
  });
}
