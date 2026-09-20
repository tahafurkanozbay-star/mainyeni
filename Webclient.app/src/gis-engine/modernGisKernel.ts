import { createArcGisRequestScheduler } from './arcgisRequestScheduler';
import {
  createLayerLifecycleRuntime,
  type LayerLifecycleDescriptor,
} from './layerLifecycleRuntime';
import {
  buildArcGisCapabilityContract,
  assessCapabilityContract,
} from './serviceCapabilityRuntime';
import {
  compileArcGisQueryPlan,
  createArcGisPageRequest,
  type ArcGisCapabilityContractLike,
  type ArcGisPageInput,
  type ArcGisQueryPlan,
  type ArcGisQueryPlanInput,
  type ArcGisQueryRequest,
} from './spatialQueryPlanner.ts';
import { createServiceHealthRuntime } from './serviceHealthRuntime';
import { createRenderGovernor, type GisLayerRenderInput } from './renderGovernorRuntime';
import { createSceneStreamingPlanner, type GisSceneStreamingPlanInput } from './sceneStreamingPlanner';
import { createGisObservabilityRuntime } from './gisObservabilityRuntime';
import { createTemporalLayerRuntime } from './temporalLayerRuntime';
import { createGisEditTransactionRuntime } from './editTransactionRuntime';
import { createGisMapStatePersistenceRuntime } from './mapStatePersistenceRuntime';
import { createGisExportRuntime } from './exportPlanRuntime';
import { createViewportQueryExecutionRuntime } from './viewportQueryExecutionRuntime';
import {
  createDeterministicFingerprint,
  finiteNumber,
  normalizeIdentifier,
  positiveInteger,
  type GisDeviceSnapshot,
  type GisKernelSnapshot,
  type GisLayerDescriptor,
  type GisQualityTier,
  type GisRenderBudget,
  type GisServiceHealthSnapshot,
  type GisViewSnapshot,
} from './runtimeContracts';

export interface ModernGisKernelConfiguration {
  readonly now?: () => number;
  readonly device?: GisDeviceSnapshot;
  readonly initialTier?: GisQualityTier;
  readonly scheduler?: ReturnType<typeof createArcGisRequestScheduler>;
  readonly lifecycle?: ReturnType<typeof createLayerLifecycleRuntime>;
  readonly serviceHealth?: ReturnType<typeof createServiceHealthRuntime>;
  readonly renderGovernor?: ReturnType<typeof createRenderGovernor>;
  readonly streamingPlanner?: ReturnType<typeof createSceneStreamingPlanner>;
  readonly observability?: ReturnType<typeof createGisObservabilityRuntime>;
  readonly temporal?: ReturnType<typeof createTemporalLayerRuntime>;
  readonly edits?: ReturnType<typeof createGisEditTransactionRuntime>;
  readonly mapState?: ReturnType<typeof createGisMapStatePersistenceRuntime>;
  readonly exports?: ReturnType<typeof createGisExportRuntime>;
  readonly viewportQueries?: ReturnType<typeof createViewportQueryExecutionRuntime>;
  readonly lifecycleAdapters?: Record<string, unknown>;
  readonly schedulerOptions?: Record<string, unknown>;
  readonly layerBudget?: {
    readonly maxVisibleLayers?: number;
    readonly idleTtlMs?: number;
  };
  readonly onListenerError?: (error: unknown, context?: unknown) => void;
}

export interface GisKernelServiceRegistration {
  readonly serviceId: string;
  readonly url: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly allowUnknownUrl?: boolean;
  readonly metadataRevision?: string | number | null;
}

export interface GisKernelLayerRegistration extends GisLayerDescriptor {
  readonly serviceId: string;
  readonly lifecycle?: Readonly<Record<string, unknown>>;
}

export interface GisKernelQueryExecutionContext<T = unknown> {
  readonly serviceId: string;
  readonly layerId?: string | null;
  readonly requestKey?: string | null;
  readonly planInput?: ArcGisQueryPlanInput;
  readonly page?: ArcGisPageInput;
  readonly priority?: number | string | null;
  readonly cache?: boolean;
  readonly cacheTtlMs?: number | null;
  readonly staleTtlMs?: number | null;
  readonly allowStale?: boolean;
  readonly allowStaleOnError?: boolean;
  readonly signal?: AbortSignal | null;
  readonly estimatedBytes?: number | null;
  readonly tags?: readonly string[];
  readonly execute: (
    request: Readonly<ArcGisQueryRequest>,
    context: Readonly<{
      signal: AbortSignal;
      requestKey: string;
      resourceUrl: string;
      serviceId: string;
      layerId: string | null;
      plan: ArcGisQueryPlan;
    }>,
  ) => Promise<T> | T;
}

export interface GisKernelQueryResult<T = unknown> {
  readonly value: T;
  readonly plan: ArcGisQueryPlan;
  readonly request: Readonly<ArcGisQueryRequest>;
  readonly requestKey: string;
  readonly fromScheduler: true;
}

interface ServiceEntry {
  readonly id: string;
  readonly url: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly contract: ArcGisCapabilityContractLike;
  readonly assessment: Readonly<Record<string, unknown>>;
  readonly metadataRevision: string | number | null;
}

interface LayerEntry {
  readonly id: string;
  readonly serviceId: string;
  descriptor: GisKernelLayerRegistration;
}

const estimateValueBytes = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try {
    return Math.max(1, JSON.stringify(value).length * 2);
  } catch {
    return 4096;
  }
};

const extractStatus = (value: unknown): number | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const nested = record.response && typeof record.response === 'object'
    ? record.response as Record<string, unknown>
    : null;
  const candidate = record.status ?? record.statusCode ?? nested?.status;
  const status = finiteNumber(candidate);
  return status === null ? null : Math.max(0, Math.min(999, Math.floor(status)));
};

const transferLimitExceeded = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.exceededTransferLimit === true
    || record.transferLimitExceeded === true
    || Boolean(record.properties && typeof record.properties === 'object'
      && (record.properties as Record<string, unknown>).exceededTransferLimit === true);
};

const errorCode = (error: unknown): string | null => {
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const code = record.code ?? record.name;
  return code == null ? null : String(code).slice(0, 128);
};

const isAbortError = (error: unknown): boolean => (
  Boolean(error)
  && typeof error === 'object'
  && String((error as Record<string, unknown>).name || '') === 'AbortError'
);

const isTimeoutError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code || record.name || '').toUpperCase();
  return code.includes('TIMEOUT') || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
};

const uniqueTags = (values: readonly unknown[] = []): string[] => [...new Set(
  values
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map((value) => String(value).trim()),
)];

export const createModernGisKernel = (configuration: ModernGisKernelConfiguration = {}) => {
  const clock = typeof configuration.now === 'function' ? configuration.now : () => Date.now();
  const services = new Map<string, ServiceEntry>();
  const layers = new Map<string, LayerEntry>();
  let destroyed = false;
  const metrics = {
    serviceRegistrations: 0,
    layerRegistrations: 0,
    queriesPlanned: 0,
    queriesExecuted: 0,
    queryFailures: 0,
    queryCancellations: 0,
    renderPlans: 0,
    frameSamples: 0,
    streamingPlans: 0,
    cacheInvalidations: 0,
    budgetPropagations: 0,
  };

  const observability = configuration.observability || createGisObservabilityRuntime({
    now: clock,
    ...(configuration.onListenerError ? { onListenerError: configuration.onListenerError } : {}),
  });
  const serviceHealth = configuration.serviceHealth || createServiceHealthRuntime({
    now: clock,
    ...(configuration.onListenerError ? { onListenerError: configuration.onListenerError } : {}),
    onEvent: (event) => {
      observability.record({
        type: `health.${event.type}`,
        severity: event.snapshot.state === 'unavailable' ? 'warning' : 'debug',
        serviceId: event.serviceId,
        fields: {
          state: event.snapshot.state,
          circuit: event.snapshot.circuit,
          healthScore: event.snapshot.healthScore,
          reason: event.reason || null,
        },
      });
    },
  });
  const renderGovernor = configuration.renderGovernor || createRenderGovernor({
    now: clock,
    ...(configuration.device ? { device: configuration.device } : {}),
    ...(configuration.initialTier ? { initialTier: configuration.initialTier } : {}),
    ...(configuration.onListenerError ? { onListenerError: configuration.onListenerError } : {}),
  });
  const streamingPlanner = configuration.streamingPlanner || createSceneStreamingPlanner({ now: clock });
  const initialBudget = renderGovernor.getBudget();
  const scheduler = configuration.scheduler || createArcGisRequestScheduler({
    ...configuration.schedulerOptions,
    now: clock,
    maxConcurrent: initialBudget.maxConcurrentRequests,
    maxConcurrentPerOrigin: Math.max(1, Math.min(4, initialBudget.maxConcurrentRequests)),
    maxCacheBytes: Math.max(4 * 1024 * 1024, Math.floor(initialBudget.maxResidentBytes * 0.12)),
    ...(configuration.onListenerError ? { onListenerError: configuration.onListenerError } : {}),
  });
  const temporal = configuration.temporal || createTemporalLayerRuntime({ now: clock });
  const edits = configuration.edits || createGisEditTransactionRuntime({ now: clock });
  const mapState = configuration.mapState || createGisMapStatePersistenceRuntime({ now: clock });
  const exports = configuration.exports || createGisExportRuntime();
  const viewportQueries = configuration.viewportQueries || createViewportQueryExecutionRuntime({ now: clock });
  const lifecycle = configuration.lifecycle || createLayerLifecycleRuntime({
    ...configuration.lifecycleAdapters,
    now: clock,
    maxResidentLayers: Math.max(8, initialBudget.maxConcurrentLayerLoads * 4),
    maxResidentBytes: Math.max(32 * 1024 * 1024, Math.floor(initialBudget.maxResidentBytes * 0.6)),
    maxVisibleLayers: positiveInteger(configuration.layerBudget?.maxVisibleLayers, 24, 500),
    idleTtlMs: positiveInteger(configuration.layerBudget?.idleTtlMs, 60000, 60 * 60 * 1000),
    ...(configuration.onListenerError ? { onListenerError: configuration.onListenerError } : {}),
  });

  const assertActive = (): void => {
    if (destroyed) throw new Error('Modern GIS kernel has been destroyed.');
  };

  const requireService = (serviceId: unknown): ServiceEntry => {
    const id = normalizeIdentifier(serviceId, 'serviceId');
    const service = services.get(id);
    if (!service) throw new Error(`ArcGIS service is not registered in the modern GIS kernel: ${id}`);
    return service;
  };

  const requireLayer = (layerId: unknown): LayerEntry => {
    const id = normalizeIdentifier(layerId, 'layerId');
    const layer = layers.get(id);
    if (!layer) throw new Error(`GIS layer is not registered in the modern GIS kernel: ${id}`);
    return layer;
  };

  const propagateBudget = (budget: GisRenderBudget, reason: string): void => {
    scheduler.configure?.({
      maxConcurrent: budget.maxConcurrentRequests,
      maxConcurrentPerOrigin: Math.max(1, Math.min(4, budget.maxConcurrentRequests)),
      maxCacheBytes: Math.max(4 * 1024 * 1024, Math.floor(budget.maxResidentBytes * 0.12)),
    });
    Promise.resolve(lifecycle.updateBudgets?.({
      maxResidentLayers: Math.max(8, budget.maxConcurrentLayerLoads * 4),
      maxResidentBytes: Math.max(32 * 1024 * 1024, Math.floor(budget.maxResidentBytes * 0.6)),
    })).catch((error) => configuration.onListenerError?.(error, { type: 'budget-propagation' }));
    metrics.budgetPropagations += 1;
    observability.record({
      type: 'kernel.budget-propagated',
      severity: 'debug',
      fields: {
        reason,
        tier: budget.tier,
        framePressure: budget.framePressure,
        memoryPressure: budget.memoryPressure,
        maxConcurrentRequests: budget.maxConcurrentRequests,
        maxResidentBytes: budget.maxResidentBytes,
      },
    });
  };

  let lastBudgetFingerprint = createDeterministicFingerprint('render-budget', initialBudget);
  const synchronizeBudget = (reason: string): GisRenderBudget => {
    const budget = renderGovernor.getBudget();
    const fingerprint = createDeterministicFingerprint('render-budget', budget);
    if (fingerprint !== lastBudgetFingerprint) {
      lastBudgetFingerprint = fingerprint;
      propagateBudget(budget, reason);
    }
    return budget;
  };

  const registerService = (registration: GisKernelServiceRegistration) => {
    assertActive();
    const id = normalizeIdentifier(registration.serviceId, 'serviceId');
    const contract = buildArcGisCapabilityContract({
      serviceId: id,
      url: registration.url,
      metadata: registration.metadata,
      allowUnknownUrl: registration.allowUnknownUrl === true,
    }) as ArcGisCapabilityContractLike;
    const assessment = assessCapabilityContract(contract) as Readonly<Record<string, unknown>>;
    const existing = services.get(id);
    if (existing && existing.url !== contract.resourceUrl) {
      throw new Error(`Registered GIS service ${id} cannot change resource URL in place.`);
    }
    const resourceUrl = String(contract.resourceUrl || registration.url);
    const entry: ServiceEntry = Object.freeze({
      id,
      url: resourceUrl,
      metadata: Object.freeze({ ...registration.metadata }),
      contract,
      assessment,
      metadataRevision: registration.metadataRevision ?? null,
    });
    services.set(id, entry);
    serviceHealth.registerService({
      serviceId: id,
      resourceUrl,
      resourceKind: String(contract.resourceKind || ''),
      ...(contract.maxRecordCount !== undefined ? { maxRecordCount: contract.maxRecordCount } : {}),
      ...(registration.metadataRevision !== undefined
        ? { metadataRevision: registration.metadataRevision }
        : {}),
    });
    metrics.serviceRegistrations += existing ? 0 : 1;
    observability.record({
      type: existing ? 'kernel.service-updated' : 'kernel.service-registered',
      severity: assessment.valid === false ? 'warning' : 'info',
      serviceId: id,
      fields: {
        resourceKind: String(contract.resourceKind || 'unknown'),
        supportsQuery: contract.supportsQuery === true,
        supportsPagination: contract.supportsPagination === true,
        assessmentValid: assessment.valid !== false,
      },
    });
    return Object.freeze({ contract, assessment });
  };

  const unregisterService = async (serviceId: unknown): Promise<boolean> => {
    assertActive();
    const service = requireService(serviceId);
    const dependentLayers = [...layers.values()].filter((layer) => layer.serviceId === service.id);
    if (dependentLayers.length) {
      throw new Error(`Cannot unregister service ${service.id}; ${dependentLayers.length} layer(s) still depend on it.`);
    }
    scheduler.invalidateTag?.(`service:${service.id}`);
    const removed = services.delete(service.id);
    if (removed) serviceHealth.unregisterService(service.id);
    observability.record({
      type: 'kernel.service-unregistered',
      severity: 'info',
      serviceId: service.id,
    });
    return removed;
  };

  const registerLayer = (registration: GisKernelLayerRegistration) => {
    assertActive();
    const id = normalizeIdentifier(registration.id, 'layerId');
    const service = requireService(registration.serviceId);
    const descriptor: GisKernelLayerRegistration = Object.freeze({
      ...registration,
      id,
      serviceId: service.id,
      resourceUrl: registration.resourceUrl || service.url,
      resourceKind: registration.resourceKind || String(service.contract.resourceKind || ''),
      geometryType: registration.geometryType || service.contract.geometryType || null,
    });
    const existed = layers.has(id);
    const lifecycleResourceUrl = descriptor.resourceUrl || service.url;
    const lifecycleDescriptor: LayerLifecycleDescriptor = {
      ...registration.lifecycle,
      id,
      resourceUrl: lifecycleResourceUrl,
      url: lifecycleResourceUrl,
      priority: 100 - Math.round(
        Math.max(0, Math.min(100, finiteNumber(descriptor.importance, 50) ?? 50)),
      ),
      ...(descriptor.visible === undefined ? {} : { visible: descriptor.visible }),
      ...(descriptor.pinned === undefined ? {} : { pinned: descriptor.pinned }),
      ...(descriptor.estimatedBytes == null ? {} : { estimatedBytes: descriptor.estimatedBytes }),
    };
    lifecycle.registerLayer(id, lifecycleDescriptor);
    layers.set(id, { id, serviceId: service.id, descriptor });
    metrics.layerRegistrations += existed ? 0 : 1;
    observability.record({
      type: existed ? 'kernel.layer-updated' : 'kernel.layer-registered',
      severity: 'info',
      serviceId: service.id,
      layerId: id,
      fields: {
        resourceKind: descriptor.resourceKind || null,
        geometryType: descriptor.geometryType || null,
        visible: descriptor.visible !== false,
      },
    });
    return descriptor;
  };

  const unregisterLayer = async (layerId: unknown): Promise<boolean> => {
    assertActive();
    const layer = requireLayer(layerId);
    scheduler.invalidateTag?.(`layer:${layer.id}`);
    await lifecycle.dispose?.(layer.id, { reason: 'kernel-unregister' });
    const removed = layers.delete(layer.id);
    observability.record({
      type: 'kernel.layer-unregistered',
      severity: 'info',
      serviceId: layer.serviceId,
      layerId: layer.id,
    });
    return removed;
  };

  const planQuery = (
    serviceId: unknown,
    input: ArcGisQueryPlanInput = {},
  ): ArcGisQueryPlan => {
    assertActive();
    const service = requireService(serviceId);
    const plan = compileArcGisQueryPlan(service.contract, input);
    metrics.queriesPlanned += 1;
    observability.record({
      type: 'query.planned',
      severity: plan.warnings.length ? 'warning' : 'debug',
      serviceId: service.id,
      fields: {
        strategy: plan.strategy,
        pageSize: plan.pageSize,
        warnings: plan.warnings,
        spatial: plan.diagnostics.spatial,
        statistics: plan.diagnostics.statistics,
        fieldCount: plan.diagnostics.fieldCount,
      },
    });
    return plan;
  };

  const executeQuery = async <T = unknown>(
    context: GisKernelQueryExecutionContext<T>,
  ): Promise<GisKernelQueryResult<T>> => {
    assertActive();
    const service = requireService(context.serviceId);
    const layer = context.layerId == null ? null : requireLayer(context.layerId);
    if (layer && layer.serviceId !== service.id) {
      throw new Error(`Layer ${layer.id} is not owned by service ${service.id}.`);
    }
    const availability = serviceHealth.getAvailability(service.id);
    if (!availability.allowed) {
      observability.record({
        type: 'query.rejected-by-service-health',
        severity: 'warning',
        serviceId: service.id,
        layerId: layer?.id || null,
        fields: { reason: availability.reason, circuit: availability.circuit },
      });
      throw new Error(`ArcGIS service ${service.id} is temporarily unavailable (${availability.reason}).`);
    }
    const plan = planQuery(service.id, context.planInput || {});
    const request = createArcGisPageRequest(plan, context.page || {});
    const requestKey = context.requestKey
      ? normalizeIdentifier(context.requestKey, 'requestKey')
      : createDeterministicFingerprint('gis-request', {
        serviceId: service.id,
        layerId: layer?.id || null,
        identity: plan.identity,
        page: context.page || null,
      });
    const trace = observability.startTrace({
      type: 'query.execute',
      serviceId: service.id,
      layerId: layer?.id || null,
      fields: {
        requestKey,
        strategy: plan.strategy,
        pageSize: plan.pageSize,
      },
    });
    metrics.queriesExecuted += 1;
    try {
      const value = await scheduler.schedule({
        key: requestKey,
        resourceUrl: service.url,
        ...(context.priority === undefined ? {} : { priority: context.priority }),
        ...(context.cache === undefined ? {} : { cache: context.cache }),
        ...(context.cacheTtlMs === undefined ? {} : { cacheTtlMs: context.cacheTtlMs }),
        ...(context.staleTtlMs === undefined ? {} : { staleTtlMs: context.staleTtlMs }),
        ...(context.allowStale === undefined ? {} : { allowStale: context.allowStale }),
        ...(context.allowStaleOnError === undefined
          ? {}
          : { allowStaleOnError: context.allowStaleOnError }),
        ...(context.estimatedBytes === undefined
          ? {}
          : { estimatedBytes: context.estimatedBytes }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        tags: uniqueTags([
          ...(context.tags || []),
          `service:${service.id}`,
          layer ? `layer:${layer.id}` : null,
        ]),
        execute: async ({ signal, requestKey: scheduledKey, resourceUrl }: {
          signal: AbortSignal;
          requestKey: string;
          resourceUrl: string;
        }) => {
          const ticket = serviceHealth.beginRequest(service.id);
          const startedAt = clock();
          try {
            const result = await context.execute(request, {
              signal,
              requestKey: scheduledKey,
              resourceUrl,
              serviceId: service.id,
              layerId: layer?.id || null,
              plan,
            });
            serviceHealth.completeRequest(ticket, {
              ok: true,
              status: extractStatus(result),
              bytes: estimateValueBytes(result),
              transferLimitExceeded: transferLimitExceeded(result),
              durationMs: Math.max(0, clock() - startedAt),
            });
            return result;
          } catch (error) {
            serviceHealth.completeRequest(ticket, {
              ok: false,
              cancelled: isAbortError(error),
              timeout: isTimeoutError(error),
              errorCode: errorCode(error),
              durationMs: Math.max(0, clock() - startedAt),
            });
            throw error;
          }
        },
      }) as T;
      trace.complete({
        ok: true,
        fields: {
          resultBytes: estimateValueBytes(value),
          transferLimitExceeded: transferLimitExceeded(value),
        },
      });
      return Object.freeze({
        value,
        plan,
        request,
        requestKey,
        fromScheduler: true as const,
      });
    } catch (error) {
      if (isAbortError(error)) metrics.queryCancellations += 1;
      else metrics.queryFailures += 1;
      trace.complete({
        ok: false,
        cancelled: isAbortError(error),
        errorCode: errorCode(error),
      });
      throw error;
    }
  };

  const invalidateLayer = (layerId: unknown): Readonly<{ queryCache: number }> => {
    assertActive();
    const layer = requireLayer(layerId);
    const queryCache = Number(scheduler.invalidateTag?.(`layer:${layer.id}`) || 0);
    metrics.cacheInvalidations += queryCache;
    observability.record({
      type: 'kernel.layer-cache-invalidated',
      severity: 'debug',
      serviceId: layer.serviceId,
      layerId: layer.id,
      fields: { queryCache },
    });
    return Object.freeze({ queryCache });
  };

  const updateView = (view: GisViewSnapshot) => {
    assertActive();
    const state = renderGovernor.updateView(view);
    synchronizeBudget('view-update');
    return state;
  };

  const recordFrame = (durationMs: unknown) => {
    assertActive();
    metrics.frameSamples += 1;
    const state = renderGovernor.recordFrame(durationMs);
    synchronizeBudget('frame-sample');
    return state;
  };

  const setResidentBytes = (bytes: unknown) => {
    assertActive();
    const state = renderGovernor.setResidentBytes(bytes);
    synchronizeBudget('resident-bytes');
    return state;
  };

  const planLayerRender = (layerId: unknown, input: Omit<GisLayerRenderInput, 'layer'> = {}) => {
    assertActive();
    const layer = requireLayer(layerId);
    metrics.renderPlans += 1;
    const plan = renderGovernor.planLayer({ ...input, layer: layer.descriptor });
    observability.record({
      type: 'render.layer-planned',
      severity: plan.defer ? 'debug' : 'info',
      serviceId: layer.serviceId,
      layerId: layer.id,
      fields: {
        tier: plan.tier,
        visible: plan.visible,
        cluster: plan.cluster,
        labels: plan.labels,
        defer: plan.defer,
        reason: plan.reason,
      },
    });
    return plan;
  };

  const planSceneStreamingForView = (
    input: Omit<GisSceneStreamingPlanInput, 'budget' | 'view'> & { readonly view?: GisViewSnapshot },
  ) => {
    assertActive();
    metrics.streamingPlans += 1;
    const renderState = renderGovernor.getSnapshot();
    const decision = streamingPlanner.plan({
      ...input,
      view: input.view || renderState.view,
      budget: renderState.budget,
    });
    observability.record({
      type: 'scene.streaming-planned',
      severity: decision.skipped.length > decision.load.length + decision.prefetch.length ? 'debug' : 'info',
      fields: {
        loads: decision.load.length,
        prefetch: decision.prefetch.length,
        retain: decision.retain.length,
        evict: decision.evict.length,
        skipped: decision.skipped.length,
        estimatedLoadBytes: decision.estimatedLoadBytes,
      },
    });
    return decision;
  };

  const setQualityTier = (tier: GisQualityTier, reason = 'manual') => {
    assertActive();
    const state = renderGovernor.setTier(tier, reason);
    synchronizeBudget(`tier:${reason}`);
    return state;
  };

  const attachLayer = async (layerId: unknown, view: unknown, options: Record<string, unknown> = {}) => {
    assertActive();
    const layer = requireLayer(layerId);
    const trace = observability.startTrace({
      type: 'layer.attach',
      serviceId: layer.serviceId,
      layerId: layer.id,
    });
    try {
      const result = await lifecycle.attach(layer.id, view, options);
      trace.complete({ ok: true });
      return result;
    } catch (error) {
      trace.complete({ ok: false, errorCode: errorCode(error) });
      throw error;
    }
  };

  const detachLayer = async (layerId: unknown, reason = 'manual') => {
    assertActive();
    const layer = requireLayer(layerId);
    return lifecycle.detach(layer.id, reason);
  };

  const setLayerVisible = async (layerId: unknown, visible: boolean, reason = 'manual') => {
    assertActive();
    const layer = requireLayer(layerId);
    layer.descriptor = Object.freeze({ ...layer.descriptor, visible: visible === true });
    return lifecycle.setVisible(layer.id, visible, { reason });
  };

  const sweepLayers = async (reason = 'kernel-sweep') => {
    assertActive();
    synchronizeBudget(reason);
    return lifecycle.sweep({ reason });
  };

  const getSnapshot = (): GisKernelSnapshot => {
    const render = renderGovernor.getSnapshot();
    const schedulerSnapshot = scheduler.getSnapshot?.() || {};
    const servicesSnapshot = serviceHealth.getSnapshot() as readonly GisServiceHealthSnapshot[];
    return Object.freeze({
      destroyed,
      registeredServices: services.size,
      registeredLayers: layers.size,
      inFlightRequests: Number((schedulerSnapshot as Record<string, unknown>).inFlightCount || 0),
      qualityTier: render.tier,
      renderBudget: render.budget,
      metrics: Object.freeze({ ...metrics }),
      services: servicesSnapshot,
    });
  };

  const getDiagnostics = () => Object.freeze({
    kernel: getSnapshot(),
    observability: observability.getSnapshot(),
    scheduler: scheduler.getSnapshot?.() || null,
    lifecycle: lifecycle.getSnapshot?.() || null,
    health: serviceHealth.getSummary(),
    render: renderGovernor.getSnapshot(),
    streaming: streamingPlanner.getMetrics(),
    viewportQueries: viewportQueries.snapshot(),
  });

  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    scheduler.destroy?.('Modern GIS kernel destroyed');
    await lifecycle.destroy?.();
    serviceHealth.destroy();
    renderGovernor.destroy();
    streamingPlanner.destroy();
    temporal.destroy();
    edits.destroy();
    viewportQueries.dispose();
    observability.destroy();
    services.clear();
    layers.clear();
  };

  return Object.freeze({
    registerService,
    unregisterService,
    registerLayer,
    unregisterLayer,
    planQuery,
    executeQuery,
    invalidateLayer,
    updateView,
    recordFrame,
    setResidentBytes,
    planLayerRender,
    planSceneStreaming: planSceneStreamingForView,
    setQualityTier,
    attachLayer,
    detachLayer,
    setLayerVisible,
    sweepLayers,
    getSnapshot,
    getDiagnostics,
    temporal,
    edits,
    mapState,
    exports,
    viewportQueries,
    getService: (serviceId: unknown) => requireService(serviceId),
    getLayer: (layerId: unknown) => requireLayer(layerId).descriptor,
    destroy,
    isDestroyed: () => destroyed,
  });
};
