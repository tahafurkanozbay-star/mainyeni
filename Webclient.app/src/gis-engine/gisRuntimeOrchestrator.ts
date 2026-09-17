import {
  GIS_PERFORMANCE_PROFILE,
  createAdaptivePerformanceRuntime,
  performanceBudgetForProfile,
} from './adaptivePerformanceRuntime';
import { createQueryRuntime } from './queryRuntime';
import { createLayerLoadScheduler } from './layerScheduler';
import {
  assessGeometryCollection,
  normalizeGeometry,
  type GeometryCollectionAssessment,
  type GeometryNormalizationResult,
  type GeometryNormalizeOptions,
} from './geometryIntegrityRuntime';
import {
  createSpatialMemoKey,
  createSpatialMemoRuntime,
} from './spatialMemoRuntime';
import { createPresentationState } from './renderPolicyRuntime';
import {
  buildArcGisCapabilityContract,
  capabilityContractToPaginationMetadata,
  type ArcGisCapabilityContract,
} from './serviceCapabilityRuntime';
import {
  executeArcGisPagination,
  type ArcGisFeatureLike,
  type ArcGisObjectIdFetcher,
  type ArcGisPageFetcher,
  type ArcGisPaginationOptions,
  type ArcGisPaginationResult,
} from './arcgisPaginationRuntime';

type PerformanceRuntime = ReturnType<typeof createAdaptivePerformanceRuntime>;
type QueryRuntime = ReturnType<typeof createQueryRuntime>;
type LayerScheduler = ReturnType<typeof createLayerLoadScheduler>;
type SpatialMemoRuntime = ReturnType<typeof createSpatialMemoRuntime>;
type PresentationState = ReturnType<typeof createPresentationState>;
type PerformanceBudget = ReturnType<typeof performanceBudgetForProfile>;
type PerformanceRuntimeOptions = NonNullable<Parameters<typeof createAdaptivePerformanceRuntime>[0]>;
type QueryRuntimeOptions = NonNullable<Parameters<typeof createQueryRuntime>[0]>;
type LayerSchedulerOptions = NonNullable<Parameters<typeof createLayerLoadScheduler>[0]>;
type SpatialMemoOptions = NonNullable<Parameters<typeof createSpatialMemoRuntime>[0]>;
type PresentationStateOptions = NonNullable<Parameters<typeof createPresentationState>[0]>;

export interface GisRuntimeOrchestratorErrorDetails {
  code?: string;
  layerId?: string | null;
  cause?: unknown;
}

export class GisRuntimeOrchestratorError extends Error {
  readonly code: string;
  readonly layerId: string | null;
  override readonly cause: unknown;

  constructor(message: string, details: GisRuntimeOrchestratorErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'GisRuntimeOrchestratorError';
    this.code = details.code ?? 'GIS_RUNTIME_ORCHESTRATOR_ERROR';
    this.layerId = details.layerId ?? null;
    this.cause = details.cause;
  }
}

export interface GisRuntimeOrchestratorEvent extends Readonly<Record<string, unknown>> {
  readonly type: string;
  readonly timestamp: number;
}

export interface GisLayerRegistrationDescriptor extends Record<string, unknown> {
  url?: string | null;
  metadata?: Record<string, unknown>;
  serviceId?: string | null;
  allowUnknownUrl?: boolean;
}

export interface GisLayerUnregisterOptions {
  cancelLoads?: boolean;
}

export interface PagedLayerQueryAdapters<TFeature extends ArcGisFeatureLike = ArcGisFeatureLike> {
  fetchPage?: ArcGisPageFetcher<TFeature>;
  fetchObjectIds?: ArcGisObjectIdFetcher;
}

export interface GisPresentationInput extends Record<string, unknown> {
  layer?: Record<string, unknown>;
  featureStats?: Record<string, unknown>;
  view?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface GisRuntimeMetrics {
  registeredLayers: number;
  unregisteredLayers: number;
  queries: number;
  pagedQueries: number;
  spatialComputations: number;
  geometryAssessments: number;
  presentationPlans: number;
  layerLoads: number;
  budgetTransitions: number;
  errors: number;
}

export interface GisRuntimeSnapshot {
  readonly destroyed: boolean;
  readonly profile: unknown;
  readonly budget: PerformanceBudget;
  readonly registeredLayerCount: number;
  readonly presentationLayerCount: number;
  readonly listenerCount: number;
  readonly metrics: Readonly<GisRuntimeMetrics>;
  readonly query: unknown;
  readonly spatialMemo: unknown;
  readonly layerScheduler: unknown;
}

export interface GisRuntimeOrchestratorConfiguration {
  performanceRuntime?: PerformanceRuntime;
  queryRuntime?: QueryRuntime;
  layerScheduler?: LayerScheduler;
  spatialMemo?: SpatialMemoRuntime;
  presentationState?: PresentationState;
  environment?: unknown;
  deviceCapabilities?: unknown;
  profile?: unknown;
  performanceSettings?: unknown;
  performanceNow?: () => number;
  queryTtlMs?: number;
  schedulerNow?: () => number;
  spatialMemoTtlMs?: number;
  memoNow?: () => number;
  geometryMaxVertices?: number;
  onEvent?: (event: Readonly<GisRuntimeOrchestratorEvent>) => void;
  onListenerError?: (error: unknown, event: Readonly<Record<string, unknown>>) => void;
}

export interface GisRuntimeOrchestrator {
  registerLayer: (
    layerId: unknown,
    descriptor?: GisLayerRegistrationDescriptor,
  ) => Readonly<ArcGisCapabilityContract>;
  unregisterLayer: (layerId: unknown, options?: GisLayerUnregisterOptions) => boolean;
  getCapability: (layerId: unknown) => Readonly<ArcGisCapabilityContract> | null;
  executeLayerQuery: <T>(
    layerId: unknown,
    queryKey: unknown,
    factory: () => Promise<T> | T,
    options?: Record<string, unknown>,
  ) => Promise<T>;
  executePagedLayerQuery: <TFeature extends ArcGisFeatureLike = ArcGisFeatureLike>(
    layerId: unknown,
    adapters?: PagedLayerQueryAdapters<TFeature>,
    options?: ArcGisPaginationOptions,
  ) => Promise<ArcGisPaginationResult<TFeature>>;
  assessLayerGeometry: (
    layerId: unknown,
    features: readonly unknown[],
    options?: GeometryNormalizeOptions,
  ) => GeometryCollectionAssessment;
  normalizeLayerGeometry: (
    layerId: unknown,
    geometry: unknown,
    options?: GeometryNormalizeOptions,
  ) => GeometryNormalizationResult;
  executeSpatial: <T>(
    layerId: unknown,
    operation: string,
    args: unknown,
    factory: () => Promise<T> | T,
    options?: Record<string, unknown>,
  ) => Promise<T>;
  planPresentation: (layerId: unknown, input?: GisPresentationInput) => unknown;
  scheduleLayerLoad: (
    layer: Parameters<LayerScheduler['schedule']>[0],
    loader: Parameters<LayerScheduler['schedule']>[1],
    options?: Parameters<LayerScheduler['schedule']>[2],
  ) => ReturnType<LayerScheduler['schedule']>;
  recordFrame: (durationMs: number) => ReturnType<PerformanceRuntime['recordFrame']>;
  setPerformanceProfile: (
    profile: Parameters<PerformanceRuntime['setProfile']>[0],
    reason?: string,
  ) => ReturnType<PerformanceRuntime['setProfile']>;
  invalidateLayerCaches: (layerId: unknown) => Readonly<{
    queryRemoved: number;
    spatialRemoved: number;
  }>;
  subscribe: (listener: (event: Readonly<GisRuntimeOrchestratorEvent>) => void) => () => boolean;
  getSnapshot: () => GisRuntimeSnapshot;
  getBudget: () => PerformanceBudget;
  getProfile: () => unknown;
  destroy: () => void;
}

interface EventBus {
  emit: (event: Readonly<GisRuntimeOrchestratorEvent>) => void;
  subscribe: (listener: (event: Readonly<GisRuntimeOrchestratorEvent>) => void) => () => boolean;
  clear: () => void;
  size: () => number;
}

const finite = (value: unknown, fallback: number | null = null): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const numeric = finite(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const record = (value: unknown): Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const normalizeLayerId = (value: unknown): string => {
  const source = record(value);
  const raw = value !== null && typeof value === 'object' ? source.id ?? source.layerId : value;
  const id = String(raw ?? '').trim();
  if (!id) {
    throw new GisRuntimeOrchestratorError('A layer id is required.', {
      code: 'INVALID_LAYER_ID',
    });
  }
  return id;
};

const runtimeQueryKey = (layerId: string, queryKey: unknown): string => {
  const normalizedQueryKey = String(queryKey ?? '').trim();
  if (!normalizedQueryKey) {
    throw new GisRuntimeOrchestratorError('A stable layer query key is required.', {
      code: 'INVALID_QUERY_KEY',
      layerId,
    });
  }
  return `gis-layer:${layerId}:${normalizedQueryKey}`;
};

const cloneBudget = (budget: PerformanceBudget): PerformanceBudget => ({ ...budget });

const spatialMemoBudget = (budget: PerformanceBudget): Readonly<{ maxEntries: number; maxBytes: number }> => ({
  maxEntries: Math.max(32, positiveInteger(budget.maxResidentLayers, 16) * 16),
  maxBytes: Math.max(
    1024 * 1024,
    Math.floor(positiveInteger(budget.maxQueryCacheBytes, 8 * 1024 * 1024) * 0.75),
  ),
});

const queryEntryBudget = (budget: PerformanceBudget): number => (
  Math.max(64, positiveInteger(budget.maxResidentLayers, 16) * 16)
);

const createEventBus = (
  onListenerError: GisRuntimeOrchestratorConfiguration['onListenerError'],
): EventBus => {
  const listeners = new Set<(event: Readonly<GisRuntimeOrchestratorEvent>) => void>();
  return {
    emit(event) {
      [...listeners].forEach((listener) => {
        try {
          listener(event);
        } catch (error: unknown) {
          onListenerError?.(error, event);
        }
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      listeners.clear();
    },
    size() {
      return listeners.size;
    },
  };
};

const uniqueTags = (values: readonly unknown[]): string[] => [...new Set(
  values
    .filter((value) => value !== null && value !== undefined && String(value).trim().length > 0)
    .map((value) => String(value).trim()),
)];

const asRemovalCount = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
};

export const createGisRuntimeOrchestrator = (
  configuration: GisRuntimeOrchestratorConfiguration = {},
): GisRuntimeOrchestrator => {
  const eventBus = createEventBus(configuration.onListenerError);
  const capabilities = new Map<string, Readonly<ArcGisCapabilityContract>>();
  const layerMetadata = new Map<string, Record<string, unknown>>();
  const metrics: GisRuntimeMetrics = {
    registeredLayers: 0,
    unregisteredLayers: 0,
    queries: 0,
    pagedQueries: 0,
    spatialComputations: 0,
    geometryAssessments: 0,
    presentationPlans: 0,
    layerLoads: 0,
    budgetTransitions: 0,
    errors: 0,
  };
  let destroyed = false;

  const performanceRuntime: PerformanceRuntime = configuration.performanceRuntime
    ?? createAdaptivePerformanceRuntime({
      environment: configuration.environment,
      capabilities: configuration.deviceCapabilities,
      profile: configuration.profile,
      settings: configuration.performanceSettings,
      now: configuration.performanceNow,
      onListenerError: configuration.onListenerError,
    } as PerformanceRuntimeOptions);

  let currentBudget: PerformanceBudget = performanceRuntime.getBudget?.()
    ?? performanceBudgetForProfile(
      (configuration.profile ?? GIS_PERFORMANCE_PROFILE.BALANCED) as Parameters<typeof performanceBudgetForProfile>[0],
      record(configuration.deviceCapabilities) as Parameters<typeof performanceBudgetForProfile>[1],
    );

  const queryRuntime: QueryRuntime = configuration.queryRuntime ?? createQueryRuntime({
    ttlMs: configuration.queryTtlMs,
    maxEntries: queryEntryBudget(currentBudget),
    maxBytes: currentBudget.maxQueryCacheBytes,
  } as QueryRuntimeOptions);

  const layerScheduler: LayerScheduler = configuration.layerScheduler ?? createLayerLoadScheduler({
    maxConcurrent: currentBudget.maxConcurrentLayers,
    now: configuration.schedulerNow,
    onEvent: (event: Readonly<Record<string, unknown>>) => eventBus.emit(Object.freeze({
      type: 'layer-scheduler',
      timestamp: Date.now(),
      source: 'layer-scheduler',
      ...event,
    })),
  } as LayerSchedulerOptions);

  const memoBudget = spatialMemoBudget(currentBudget);
  const spatialMemo: SpatialMemoRuntime = configuration.spatialMemo ?? createSpatialMemoRuntime({
    ttlMs: configuration.spatialMemoTtlMs,
    maxEntries: memoBudget.maxEntries,
    maxBytes: memoBudget.maxBytes,
    now: configuration.memoNow,
  } as SpatialMemoOptions);

  const presentationState: PresentationState = configuration.presentationState ?? createPresentationState({
    performanceBudget: currentBudget,
  } as PresentationStateOptions);

  const assertActive = (): void => {
    if (destroyed) {
      throw new GisRuntimeOrchestratorError('GIS runtime orchestrator has been destroyed.', {
        code: 'RUNTIME_DESTROYED',
      });
    }
  };

  const emit = (
    type: string,
    details: Readonly<Record<string, unknown>> = {},
  ): Readonly<GisRuntimeOrchestratorEvent> => {
    const event: Readonly<GisRuntimeOrchestratorEvent> = Object.freeze({
      type,
      timestamp: Date.now(),
      ...details,
    });
    eventBus.emit(event);
    try {
      configuration.onEvent?.(event);
    } catch (error: unknown) {
      configuration.onListenerError?.(error, event);
    }
    return event;
  };

  const applyBudget = (budget: PerformanceBudget | null | undefined, reason = 'budget-update'): PerformanceBudget => {
    currentBudget = budget ?? currentBudget;
    queryRuntime.configure?.({
      maxBytes: currentBudget.maxQueryCacheBytes,
      maxEntries: queryEntryBudget(currentBudget),
    });
    layerScheduler.setMaxConcurrent?.(currentBudget.maxConcurrentLayers);
    const memo = spatialMemoBudget(currentBudget);
    spatialMemo.configure?.({
      maxEntries: memo.maxEntries,
      maxBytes: memo.maxBytes,
    });
    metrics.budgetTransitions += 1;
    emit('performance-budget', {
      reason,
      profile: performanceRuntime.getProfile?.() ?? null,
      budget: cloneBudget(currentBudget),
    });
    return cloneBudget(currentBudget);
  };

  const unsubscribePerformance = performanceRuntime.subscribe?.((snapshot, reason) => {
    applyBudget(snapshot.budget, reason);
  }) ?? (() => false);

  const registerLayer = (
    layerId: unknown,
    descriptor: GisLayerRegistrationDescriptor = {},
  ): Readonly<ArcGisCapabilityContract> => {
    assertActive();
    const id = normalizeLayerId(layerId);
    const metadata = descriptor.metadata ?? {};
    const contract = buildArcGisCapabilityContract({
      url: descriptor.url ?? null,
      metadata,
      serviceId: descriptor.serviceId ?? id,
      allowUnknownUrl: descriptor.allowUnknownUrl === true,
    });
    const existed = capabilities.has(id);
    capabilities.set(id, contract);
    layerMetadata.set(id, metadata);
    if (!existed) metrics.registeredLayers += 1;
    presentationState.forget?.(id);
    emit('layer-capabilities-registered', {
      layerId: id,
      resourceKind: contract.resourceKind,
      supportsQuery: contract.supportsQuery,
      supportsPagination: contract.supportsPagination,
    });
    return contract;
  };

  const unregisterLayer = (
    layerId: unknown,
    options: GisLayerUnregisterOptions = {},
  ): boolean => {
    assertActive();
    const id = normalizeLayerId(layerId);
    const existed = capabilities.delete(id);
    layerMetadata.delete(id);
    presentationState.forget?.(id);
    queryRuntime.invalidateTag?.(`layer:${id}`);
    spatialMemo.invalidateTag?.(`layer:${id}`);
    if (options.cancelLoads !== false) layerScheduler.cancel?.(id, 'layer unregistered');
    if (existed) {
      metrics.unregisteredLayers += 1;
      emit('layer-unregistered', { layerId: id });
    }
    return existed;
  };

  const getCapability = (layerId: unknown): Readonly<ArcGisCapabilityContract> | null => {
    const id = normalizeLayerId(layerId);
    return capabilities.get(id) ?? null;
  };

  const requireCapability = (
    layerId: unknown,
  ): Readonly<{ id: string; contract: Readonly<ArcGisCapabilityContract> }> => {
    const id = normalizeLayerId(layerId);
    const contract = capabilities.get(id);
    if (!contract) {
      throw new GisRuntimeOrchestratorError('Layer capability contract is not registered.', {
        code: 'LAYER_NOT_REGISTERED',
        layerId: id,
      });
    }
    return Object.freeze({ id, contract });
  };

  const executeLayerQuery = async <T>(
    layerId: unknown,
    queryKey: unknown,
    factory: () => Promise<T> | T,
    options: Record<string, unknown> = {},
  ): Promise<T> => {
    assertActive();
    const { id } = requireCapability(layerId);
    metrics.queries += 1;
    try {
      const optionTags = Array.isArray(options.tags) ? options.tags : [];
      return await queryRuntime.execute(
        runtimeQueryKey(id, queryKey),
        factory,
        {
          ...options,
          tags: uniqueTags([...optionTags, `layer:${id}`]),
        },
      ) as T;
    } catch (error: unknown) {
      metrics.errors += 1;
      emit('query-error', { layerId: id, error });
      throw error;
    }
  };

  const executePagedLayerQuery = async <TFeature extends ArcGisFeatureLike = ArcGisFeatureLike>(
    layerId: unknown,
    adapters: PagedLayerQueryAdapters<TFeature> = {},
    options: ArcGisPaginationOptions = {},
  ): Promise<ArcGisPaginationResult<TFeature>> => {
    assertActive();
    const { id, contract } = requireCapability(layerId);
    if (!contract.supportsQuery) {
      throw new GisRuntimeOrchestratorError('Registered ArcGIS layer does not advertise query capability.', {
        code: 'QUERY_NOT_SUPPORTED',
        layerId: id,
      });
    }
    metrics.pagedQueries += 1;
    try {
      const result = await executeArcGisPagination<TFeature>({
        metadata: capabilityContractToPaginationMetadata(contract),
        fetchPage: adapters.fetchPage,
        fetchObjectIds: adapters.fetchObjectIds,
        options,
      });
      emit('paged-query-complete', {
        layerId: id,
        pageCount: result.pageCount,
        featureCount: result.features.length,
        incomplete: result.incomplete,
      });
      return result;
    } catch (error: unknown) {
      metrics.errors += 1;
      emit('paged-query-error', { layerId: id, error });
      throw error;
    }
  };

  const geometryOptions = (options: GeometryNormalizeOptions): GeometryNormalizeOptions => {
    const configuredMax = positiveInteger(
      configuration.geometryMaxVertices,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    if (options.maxVertices !== undefined || configuredMax === Number.MAX_SAFE_INTEGER) return options;
    return { ...options, maxVertices: configuredMax };
  };

  const assessLayerGeometry = (
    layerId: unknown,
    features: readonly unknown[],
    options: GeometryNormalizeOptions = {},
  ): GeometryCollectionAssessment => {
    assertActive();
    const { id, contract } = requireCapability(layerId);
    metrics.geometryAssessments += 1;
    const result = assessGeometryCollection(features, {
      ...(contract.spatialReference?.wkid === undefined ? {} : { defaultWkid: contract.spatialReference.wkid }),
      ...geometryOptions(options),
    });
    emit('geometry-assessed', {
      layerId: id,
      total: result.total,
      invalid: result.invalid,
      repaired: result.repaired,
    });
    return result;
  };

  const normalizeLayerGeometry = (
    layerId: unknown,
    geometry: unknown,
    options: GeometryNormalizeOptions = {},
  ): GeometryNormalizationResult => {
    assertActive();
    const { contract } = requireCapability(layerId);
    return normalizeGeometry(geometry, {
      ...(contract.spatialReference?.wkid === undefined ? {} : { defaultWkid: contract.spatialReference.wkid }),
      ...geometryOptions(options),
    });
  };

  const executeSpatial = async <T>(
    layerId: unknown,
    operation: string,
    args: unknown,
    factory: () => Promise<T> | T,
    options: Record<string, unknown> = {},
  ): Promise<T> => {
    assertActive();
    const { id } = requireCapability(layerId);
    const optionTags = Array.isArray(options.tags) ? options.tags : [];
    const key = typeof options.key === 'string' && options.key.trim()
      ? options.key
      : createSpatialMemoKey(operation, args, {
        namespace: `layer:${id}`,
        ...(options.version === undefined ? {} : { version: options.version }),
      });
    metrics.spatialComputations += 1;
    try {
      return await spatialMemo.execute(key, factory, {
        ...options,
        tags: uniqueTags([...optionTags, `layer:${id}`]),
      }) as T;
    } catch (error: unknown) {
      metrics.errors += 1;
      emit('spatial-error', { layerId: id, operation, error });
      throw error;
    }
  };

  const planPresentation = (
    layerId: unknown,
    input: GisPresentationInput = {},
  ): unknown => {
    assertActive();
    const { id, contract } = requireCapability(layerId);
    metrics.presentationPlans += 1;
    const result = presentationState.plan({
      layer: { ...(input.layer ?? {}), id },
      featureStats: {
        geometryType: contract.geometryType,
        serviceMaxRecordCount: contract.maxRecordCount,
        ...(input.featureStats ?? {}),
      },
      view: input.view ?? {},
      performanceBudget: currentBudget,
      options: {
        objectIdField: contract.objectIdField,
        ...(input.options ?? {}),
      },
    } as Parameters<PresentationState['plan']>[0]);
    const resultRecord = record(result);
    const next = record(resultRecord.next);
    const renderPlan = record(next.renderPlan);
    if (resultRecord.changed === true) {
      emit('presentation-changed', {
        layerId: id,
        tier: next.tier ?? null,
        strategy: renderPlan.strategy ?? null,
      });
    }
    return result;
  };

  const scheduleLayerLoad = (
    layer: Parameters<LayerScheduler['schedule']>[0],
    loader: Parameters<LayerScheduler['schedule']>[1],
    options?: Parameters<LayerScheduler['schedule']>[2],
  ): ReturnType<LayerScheduler['schedule']> => {
    assertActive();
    const id = normalizeLayerId(layer);
    requireCapability(id);
    metrics.layerLoads += 1;
    return layerScheduler.schedule(layer, loader, options);
  };

  const recordFrame = (
    durationMs: number,
  ): ReturnType<PerformanceRuntime['recordFrame']> => {
    assertActive();
    return performanceRuntime.recordFrame(durationMs);
  };

  const setPerformanceProfile = (
    profile: Parameters<PerformanceRuntime['setProfile']>[0],
    reason = 'manual',
  ): ReturnType<PerformanceRuntime['setProfile']> => {
    assertActive();
    return performanceRuntime.setProfile(profile, reason);
  };

  const invalidateLayerCaches = (
    layerId: unknown,
  ): Readonly<{ queryRemoved: number; spatialRemoved: number }> => {
    assertActive();
    const id = normalizeLayerId(layerId);
    const queryRemoved = asRemovalCount(queryRuntime.invalidateTag?.(`layer:${id}`));
    const spatialRemoved = asRemovalCount(spatialMemo.invalidateTag?.(`layer:${id}`));
    emit('layer-cache-invalidated', { layerId: id, queryRemoved, spatialRemoved });
    return Object.freeze({ queryRemoved, spatialRemoved });
  };

  const snapshot = (): GisRuntimeSnapshot => Object.freeze({
    destroyed,
    profile: performanceRuntime.getProfile?.() ?? null,
    budget: cloneBudget(currentBudget),
    registeredLayerCount: capabilities.size,
    presentationLayerCount: presentationState.size?.() ?? 0,
    listenerCount: eventBus.size(),
    metrics: Object.freeze({ ...metrics }),
    query: queryRuntime.getStats?.() ?? null,
    spatialMemo: spatialMemo.getStats?.() ?? null,
    layerScheduler: layerScheduler.snapshot?.() ?? null,
  });

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    unsubscribePerformance();
    performanceRuntime.destroy?.();
    queryRuntime.destroy?.();
    spatialMemo.destroy?.();
    layerScheduler.destroy?.();
    presentationState.clear?.();
    capabilities.clear();
    layerMetadata.clear();
    eventBus.clear();
  };

  return Object.freeze({
    registerLayer,
    unregisterLayer,
    getCapability,
    executeLayerQuery,
    executePagedLayerQuery,
    assessLayerGeometry,
    normalizeLayerGeometry,
    executeSpatial,
    planPresentation,
    scheduleLayerLoad,
    recordFrame,
    setPerformanceProfile,
    invalidateLayerCaches,
    subscribe: eventBus.subscribe,
    getSnapshot: snapshot,
    getBudget: () => cloneBudget(currentBudget),
    getProfile: () => performanceRuntime.getProfile?.() ?? null,
    destroy,
  });
};
