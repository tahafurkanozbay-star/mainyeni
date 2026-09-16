import {
  GIS_PERFORMANCE_PROFILE,
  createAdaptivePerformanceRuntime,
  performanceBudgetForProfile,
} from './adaptivePerformanceRuntime';
import {
  createQueryRuntime,
} from './queryRuntime';
import {
  createLayerLoadScheduler,
} from './layerScheduler';
import {
  assessGeometryCollection,
  normalizeGeometry,
} from './geometryIntegrityRuntime';
import {
  createSpatialMemoKey,
  createSpatialMemoRuntime,
} from './spatialMemoRuntime';
import {
  createPresentationState,
} from './renderPolicyRuntime';
import {
  buildArcGisCapabilityContract,
  capabilityContractToPaginationMetadata,
} from './serviceCapabilityRuntime';
import {
  executeArcGisPagination,
} from './arcgisPaginationRuntime';

export class GisRuntimeOrchestratorError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GisRuntimeOrchestratorError';
    this.code = details.code || 'GIS_RUNTIME_ORCHESTRATOR_ERROR';
    this.layerId = details.layerId || null;
    this.cause = details.cause;
  }
}

const finite = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const positiveInteger = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const numeric = finite(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(numeric)));
};

const normalizeLayerId = (value) => {
  const raw = typeof value === 'object' ? value?.id ?? value?.layerId : value;
  const id = String(raw ?? '').trim();
  if (!id) {
    throw new GisRuntimeOrchestratorError('A layer id is required.', {
      code: 'INVALID_LAYER_ID',
    });
  }
  return id;
};

const runtimeQueryKey = (layerId, queryKey) => {
  const normalizedQueryKey = String(queryKey ?? '').trim();
  if (!normalizedQueryKey) {
    throw new GisRuntimeOrchestratorError('A stable layer query key is required.', {
      code: 'INVALID_QUERY_KEY',
      layerId,
    });
  }
  return `gis-layer:${layerId}:${normalizedQueryKey}`;
};

const cloneBudget = (budget) => ({ ...budget });

const spatialMemoBudget = (budget) => ({
  maxEntries: Math.max(32, positiveInteger(budget.maxResidentLayers, 16) * 16),
  maxBytes: Math.max(1024 * 1024, Math.floor(positiveInteger(budget.maxQueryCacheBytes, 8 * 1024 * 1024) * 0.75)),
});

const queryEntryBudget = (budget) => Math.max(64, positiveInteger(budget.maxResidentLayers, 16) * 16);

const createEventBus = (onListenerError) => {
  const listeners = new Set();
  return {
    emit(event) {
      [...listeners].forEach((listener) => {
        try {
          listener(event);
        } catch (error) {
          onListenerError?.(error, event);
        }
      });
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
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

export const createGisRuntimeOrchestrator = (configuration = {}) => {
  const eventBus = createEventBus(configuration.onListenerError);
  const capabilities = new Map();
  const layerMetadata = new Map();
  const metrics = {
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
  let currentBudget;

  const performanceRuntime = configuration.performanceRuntime || createAdaptivePerformanceRuntime({
    environment: configuration.environment,
    capabilities: configuration.deviceCapabilities,
    profile: configuration.profile,
    settings: configuration.performanceSettings,
    now: configuration.performanceNow,
    onListenerError: configuration.onListenerError,
  });
  currentBudget = performanceRuntime.getBudget?.() || performanceBudgetForProfile(
    configuration.profile || GIS_PERFORMANCE_PROFILE.BALANCED,
    configuration.deviceCapabilities || {},
  );

  const queryRuntime = configuration.queryRuntime || createQueryRuntime({
    ttlMs: configuration.queryTtlMs,
    maxEntries: queryEntryBudget(currentBudget),
    maxBytes: currentBudget.maxQueryCacheBytes,
  });
  const layerScheduler = configuration.layerScheduler || createLayerLoadScheduler({
    maxConcurrent: currentBudget.maxConcurrentLayers,
    now: configuration.schedulerNow,
    onEvent: (event) => eventBus.emit({ source: 'layer-scheduler', ...event }),
  });
  const memoBudget = spatialMemoBudget(currentBudget);
  const spatialMemo = configuration.spatialMemo || createSpatialMemoRuntime({
    ttlMs: configuration.spatialMemoTtlMs,
    maxEntries: memoBudget.maxEntries,
    maxBytes: memoBudget.maxBytes,
    now: configuration.memoNow,
  });
  const presentationState = configuration.presentationState || createPresentationState({
    performanceBudget: currentBudget,
  });

  const assertActive = () => {
    if (destroyed) {
      throw new GisRuntimeOrchestratorError('GIS runtime orchestrator has been destroyed.', {
        code: 'RUNTIME_DESTROYED',
      });
    }
  };

  const emit = (type, details = {}) => {
    const event = Object.freeze({
      type,
      timestamp: Date.now(),
      ...details,
    });
    eventBus.emit(event);
    try {
      configuration.onEvent?.(event);
    } catch (error) {
      configuration.onListenerError?.(error, event);
    }
    return event;
  };

  const applyBudget = (budget, reason = 'budget-update') => {
    currentBudget = budget || currentBudget;
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
      profile: performanceRuntime.getProfile?.() || null,
      budget: cloneBudget(currentBudget),
    });
    return cloneBudget(currentBudget);
  };

  const unsubscribePerformance = performanceRuntime.subscribe?.((snapshot, reason) => {
    applyBudget(snapshot.budget, reason);
  }) || (() => {});

  const registerLayer = (layerId, descriptor = {}) => {
    assertActive();
    const id = normalizeLayerId(layerId);
    const metadata = descriptor.metadata || {};
    const contract = buildArcGisCapabilityContract({
      url: descriptor.url,
      metadata,
      serviceId: descriptor.serviceId || id,
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

  const unregisterLayer = (layerId, options = {}) => {
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

  const getCapability = (layerId) => {
    const id = normalizeLayerId(layerId);
    return capabilities.get(id) || null;
  };

  const requireCapability = (layerId) => {
    const id = normalizeLayerId(layerId);
    const contract = capabilities.get(id);
    if (!contract) {
      throw new GisRuntimeOrchestratorError('Layer capability contract is not registered.', {
        code: 'LAYER_NOT_REGISTERED',
        layerId: id,
      });
    }
    return { id, contract };
  };

  const executeLayerQuery = async (layerId, queryKey, factory, options = {}) => {
    assertActive();
    const { id } = requireCapability(layerId);
    metrics.queries += 1;
    try {
      return await queryRuntime.execute(
        runtimeQueryKey(id, queryKey),
        factory,
        {
          ...options,
          tags: [...new Set([...(options.tags || []), `layer:${id}`])],
        },
      );
    } catch (error) {
      metrics.errors += 1;
      emit('query-error', { layerId: id, error });
      throw error;
    }
  };

  const executePagedLayerQuery = async (layerId, adapters = {}, options = {}) => {
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
      const result = await executeArcGisPagination({
        metadata: capabilityContractToPaginationMetadata(contract),
        fetchPage: adapters.fetchPage,
        fetchObjectIds: adapters.fetchObjectIds,
        options,
      });
      emit('paged-query-complete', {
        layerId: id,
        pageCount: result.pageCount,
        featureCount: result.features.length,
        incomplete: result.incomplete === true,
      });
      return result;
    } catch (error) {
      metrics.errors += 1;
      emit('paged-query-error', { layerId: id, error });
      throw error;
    }
  };

  const assessLayerGeometry = (layerId, features, options = {}) => {
    assertActive();
    const { id, contract } = requireCapability(layerId);
    metrics.geometryAssessments += 1;
    const result = assessGeometryCollection(features, {
      defaultWkid: contract.spatialReference?.wkid,
      ...options,
    });
    emit('geometry-assessed', {
      layerId: id,
      total: result.total,
      invalid: result.invalid,
      repaired: result.repaired,
    });
    return result;
  };

  const normalizeLayerGeometry = (layerId, geometry, options = {}) => {
    assertActive();
    const { contract } = requireCapability(layerId);
    return normalizeGeometry(geometry, {
      defaultWkid: contract.spatialReference?.wkid,
      ...options,
    });
  };

  const executeSpatial = async (layerId, operation, args, factory, options = {}) => {
    assertActive();
    const { id } = requireCapability(layerId);
    const key = options.key || createSpatialMemoKey(operation, args, {
      namespace: `layer:${id}`,
      version: options.version,
    });
    metrics.spatialComputations += 1;
    try {
      return await spatialMemo.execute(key, factory, {
        ...options,
        tags: [...new Set([...(options.tags || []), `layer:${id}`])],
      });
    } catch (error) {
      metrics.errors += 1;
      emit('spatial-error', { layerId: id, operation, error });
      throw error;
    }
  };

  const planPresentation = (layerId, input = {}) => {
    assertActive();
    const { id, contract } = requireCapability(layerId);
    metrics.presentationPlans += 1;
    const result = presentationState.plan({
      layer: {
        ...input.layer,
        id,
      },
      featureStats: {
        geometryType: contract.geometryType,
        serviceMaxRecordCount: contract.maxRecordCount,
        ...input.featureStats,
      },
      view: input.view || {},
      performanceBudget: currentBudget,
      options: {
        objectIdField: contract.objectIdField,
        ...input.options,
      },
    });
    if (result.changed) {
      emit('presentation-changed', {
        layerId: id,
        tier: result.next.tier,
        strategy: result.next.renderPlan.strategy,
      });
    }
    return result;
  };

  const scheduleLayerLoad = async (layer, loader, options = {}) => {
    assertActive();
    const id = normalizeLayerId(layer);
    requireCapability(id);
    metrics.layerLoads += 1;
    return layerScheduler.schedule(layer, loader, options);
  };

  const recordFrame = (durationMs) => {
    assertActive();
    return performanceRuntime.recordFrame(durationMs);
  };

  const setPerformanceProfile = (profile, reason = 'manual') => {
    assertActive();
    return performanceRuntime.setProfile(profile, reason);
  };

  const invalidateLayerCaches = (layerId) => {
    assertActive();
    const id = normalizeLayerId(layerId);
    const queryRemoved = queryRuntime.invalidateTag?.(`layer:${id}`) || 0;
    const spatialRemoved = spatialMemo.invalidateTag?.(`layer:${id}`) || 0;
    emit('layer-cache-invalidated', { layerId: id, queryRemoved, spatialRemoved });
    return { queryRemoved, spatialRemoved };
  };

  const snapshot = () => ({
    destroyed,
    profile: performanceRuntime.getProfile?.() || null,
    budget: cloneBudget(currentBudget),
    registeredLayerCount: capabilities.size,
    presentationLayerCount: presentationState.size?.() || 0,
    listenerCount: eventBus.size(),
    metrics: { ...metrics },
    query: queryRuntime.getStats?.() || null,
    spatialMemo: spatialMemo.getStats?.() || null,
    layerScheduler: layerScheduler.snapshot?.() || null,
  });

  const destroy = () => {
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
    getProfile: () => performanceRuntime.getProfile?.() || null,
    destroy,
  });
};
