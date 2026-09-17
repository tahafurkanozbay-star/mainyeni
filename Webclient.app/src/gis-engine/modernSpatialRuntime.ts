import {
  createArcGisValidatedQueryPlan,
  deriveArcGisServiceCapabilities,
  type ArcGisLayerMetadataLike,
  type ArcGisQueryPlanInput,
  type ArcGisServiceCapabilities,
  type ArcGisValidatedQueryPlan,
} from './arcgisCapabilityAdapter';
import { createClusterLodDecision, type ClusterLodDecision, type ClusterLodInput } from './clusterLodPolicy';
import {
  createSceneLayerLifecycleRuntime,
  type SceneLayerAdapter,
  type SceneLayerDescriptor,
  type SceneLayerLifecycleRuntime,
  type SceneLayerRuntimeSnapshot,
} from './sceneLayerLifecycleRuntime';
import {
  createSpatialCacheCoordinator,
  type SpatialCacheCoordinator,
  type SpatialCacheOptions,
  type SpatialRequestOptions,
} from './spatialCacheCoordinator';
import { TerrainStreamGovernor, type TerrainGovernorSnapshot, type TerrainQuality, type TerrainTileSample } from './terrainStreamGovernor';

export interface ModernSpatialRuntimeOptions {
  cache?: SpatialCacheOptions;
  terrainQuality?: TerrainQuality;
  maxConcurrentLayerLoads?: number;
  maxLoadedLayers?: number;
  onEvent?: (event: ModernSpatialEvent) => void;
}

export interface ModernSpatialEvent {
  type:
    | 'service-registered'
    | 'service-unregistered'
    | 'query-planned'
    | 'query-completed'
    | 'query-failed'
    | 'cluster-policy'
    | 'terrain-policy'
    | 'layer-change';
  timestamp: number;
  subject: string;
  detail?: Readonly<Record<string, unknown>>;
}

export interface ModernSpatialServiceRegistration {
  id: string;
  metadata: ArcGisLayerMetadataLike;
  capabilities: ArcGisServiceCapabilities;
  queryEndpoint: string | null;
}

export interface ModernSpatialQueryRequest<TResponse = unknown> {
  serviceId: string;
  plan?: ArcGisQueryPlanInput;
  cacheKey?: string;
  cache?: SpatialRequestOptions;
  execute: (request: {
    service: ModernSpatialServiceRegistration;
    plan: ArcGisValidatedQueryPlan;
    signal: AbortSignal;
  }) => Promise<TResponse>;
}

export interface ModernSpatialRuntimeSnapshot {
  services: readonly ModernSpatialServiceRegistration[];
  cache: ReturnType<SpatialCacheCoordinator['getSnapshot']>;
  layers: SceneLayerRuntimeSnapshot;
  terrain: TerrainGovernorSnapshot;
  lastClusterDecision: ClusterLodDecision | null;
}

export interface ModernSpatialRuntime {
  registerService: (id: string, metadata: ArcGisLayerMetadataLike, queryEndpoint?: string | null) => ModernSpatialServiceRegistration;
  unregisterService: (id: string) => boolean;
  getService: (id: string) => ModernSpatialServiceRegistration | null;
  planQuery: (serviceId: string, input?: ArcGisQueryPlanInput) => ArcGisValidatedQueryPlan;
  executeQuery: <TResponse>(request: ModernSpatialQueryRequest<TResponse>) => Promise<TResponse>;
  registerLayer: <TResource>(descriptor: SceneLayerDescriptor, adapter: SceneLayerAdapter<TResource>) => void;
  unregisterLayer: (id: string, reason?: string) => Promise<boolean>;
  reconcileLayers: (viewport?: { scale?: number; zoom?: number }) => Promise<SceneLayerRuntimeSnapshot>;
  createClusterDecision: (input: ClusterLodInput) => ClusterLodDecision;
  planTerrain: (tiles: readonly TerrainTileSample[]) => TerrainGovernorSnapshot;
  recordTerrainFrame: (durationMs: unknown) => TerrainGovernorSnapshot;
  setTerrainQuality: (quality: TerrainQuality) => TerrainGovernorSnapshot;
  invalidateServiceCache: (serviceId: string) => number;
  getSnapshot: () => ModernSpatialRuntimeSnapshot;
  dispose: () => Promise<void>;
}

const normalizeId = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
};

const normalizeEndpoint = (endpoint?: string | null): string | null => {
  if (!endpoint) return null;
  const normalized = endpoint.trim();
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized, typeof window !== 'undefined' ? window.location.origin : 'https://localhost');
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Unsupported protocol');
    return normalized.replace(/\/+$/, '');
  } catch {
    throw new Error('Invalid ArcGIS query endpoint');
  }
};

const stablePlanKey = (serviceId: string, plan: ArcGisValidatedQueryPlan): string => {
  const entries = Object.entries(plan.params).sort(([left], [right]) => left.localeCompare(right));
  return `${serviceId}:${JSON.stringify(entries)}`;
};

export const createModernSpatialRuntime = (options: ModernSpatialRuntimeOptions = {}): ModernSpatialRuntime => {
  const services = new Map<string, ModernSpatialServiceRegistration>();
  const cache = createSpatialCacheCoordinator(options.cache);
  const terrain = new TerrainStreamGovernor({ quality: options.terrainQuality ?? 'balanced' });
  const layers: SceneLayerLifecycleRuntime<unknown> = createSceneLayerLifecycleRuntime({
    maxConcurrentLoads: options.maxConcurrentLayerLoads ?? 4,
    maxLoadedLayers: options.maxLoadedLayers ?? 32,
    onEvent: (event) => {
      options.onEvent?.(Object.freeze({
        type: 'layer-change',
        timestamp: Date.now(),
        subject: event.layerId,
        detail: Object.freeze({
          phaseEvent: event.type,
          generation: event.generation,
          reason: event.reason,
        }),
      }));
    },
  });

  let disposed = false;
  let lastClusterDecision: ClusterLodDecision | null = null;

  const ensureActive = (): void => {
    if (disposed) throw new Error('Modern spatial runtime is disposed');
  };

  const emit = (type: ModernSpatialEvent['type'], subject: string, detail?: Readonly<Record<string, unknown>>): void => {
    const event: ModernSpatialEvent = detail === undefined
      ? Object.freeze({ type, timestamp: Date.now(), subject })
      : Object.freeze({ type, timestamp: Date.now(), subject, detail });
    options.onEvent?.(event);
  };

  const registerService = (
    id: string,
    metadata: ArcGisLayerMetadataLike,
    queryEndpoint?: string | null,
  ): ModernSpatialServiceRegistration => {
    ensureActive();
    const serviceId = normalizeId(id, 'Service id');
    const capabilities = deriveArcGisServiceCapabilities(metadata);
    const registration: ModernSpatialServiceRegistration = Object.freeze({
      id: serviceId,
      metadata: Object.freeze({ ...metadata }),
      capabilities,
      queryEndpoint: normalizeEndpoint(queryEndpoint),
    });
    services.set(serviceId, registration);
    emit('service-registered', serviceId, Object.freeze({
      kind: capabilities.kind,
      geometryType: capabilities.geometryType,
      warningCount: capabilities.warnings.length,
    }));
    return registration;
  };

  const unregisterService = (id: string): boolean => {
    const serviceId = normalizeId(id, 'Service id');
    const existed = services.delete(serviceId);
    if (existed) {
      cache.invalidateTags([`service:${serviceId}`], 'service-unregister');
      emit('service-unregistered', serviceId);
    }
    return existed;
  };

  const getService = (id: string): ModernSpatialServiceRegistration | null => services.get(id.trim()) ?? null;

  const requireService = (id: string): ModernSpatialServiceRegistration => {
    const service = getService(id);
    if (!service) throw new Error(`Unknown spatial service: ${id}`);
    return service;
  };

  const planQuery = (serviceId: string, input: ArcGisQueryPlanInput = {}): ArcGisValidatedQueryPlan => {
    ensureActive();
    const service = requireService(serviceId);
    const plan = createArcGisValidatedQueryPlan(service.capabilities, input);
    emit('query-planned', service.id, Object.freeze({
      pageSize: plan.pageSize,
      paginationEnabled: plan.paginationEnabled,
      warningCount: plan.warnings.length,
    }));
    return plan;
  };

  const executeQuery = async <TResponse>(request: ModernSpatialQueryRequest<TResponse>): Promise<TResponse> => {
    ensureActive();
    const service = requireService(request.serviceId);
    const plan = planQuery(service.id, request.plan);
    const key = request.cacheKey?.trim() || stablePlanKey(service.id, plan);
    const tags = [
      ...(request.cache?.tags ?? []),
      `service:${service.id}`,
      `geometry:${service.capabilities.geometryType}`,
    ];

    try {
      const result = await cache.request<TResponse>(key, async (signal) => request.execute({
        service,
        plan,
        signal,
      }), {
        ...request.cache,
        tags,
      });
      emit('query-completed', service.id, Object.freeze({ cacheKey: key }));
      return result;
    } catch (error) {
      emit('query-failed', service.id, Object.freeze({
        cacheKey: key,
        message: error instanceof Error ? error.message : 'Unknown query error',
      }));
      throw error;
    }
  };

  const registerLayer = <TResource>(descriptor: SceneLayerDescriptor, adapter: SceneLayerAdapter<TResource>): void => {
    ensureActive();
    layers.register(descriptor, adapter as SceneLayerAdapter<unknown>);
  };

  const unregisterLayer = async (id: string, reason = 'manual'): Promise<boolean> => layers.unregister(id, reason);

  const reconcileLayers = async (viewport?: { scale?: number; zoom?: number }): Promise<SceneLayerRuntimeSnapshot> => {
    ensureActive();
    if (viewport) return layers.setViewport(viewport);
    return layers.reconcile();
  };

  const createClusterDecisionForInput = (input: ClusterLodInput): ClusterLodDecision => {
    ensureActive();
    lastClusterDecision = createClusterLodDecision(input);
    emit('cluster-policy', 'viewport', Object.freeze({
      mode: lastClusterDecision.mode,
      density: lastClusterDecision.density,
      maxVisibleFeatures: lastClusterDecision.maxVisibleFeatures,
    }));
    return lastClusterDecision;
  };

  const planTerrain = (tiles: readonly TerrainTileSample[]): TerrainGovernorSnapshot => {
    ensureActive();
    const snapshot = terrain.plan(tiles);
    emit('terrain-policy', 'terrain', Object.freeze({
      pressure: snapshot.pressure,
      decisionCount: snapshot.decisions.length,
    }));
    return snapshot;
  };

  const recordTerrainFrame = (durationMs: unknown): TerrainGovernorSnapshot => terrain.recordFrame(durationMs);
  const setTerrainQuality = (quality: TerrainQuality): TerrainGovernorSnapshot => terrain.setQuality(quality);
  const invalidateServiceCache = (serviceId: string): number => cache.invalidateTags([`service:${normalizeId(serviceId, 'Service id')}`]);

  const getSnapshot = (): ModernSpatialRuntimeSnapshot => Object.freeze({
    services: Object.freeze([...services.values()]),
    cache: cache.getSnapshot(),
    layers: layers.getSnapshot(),
    terrain: terrain.getSnapshot(),
    lastClusterDecision,
  });

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    cache.clear('runtime-dispose');
    services.clear();
    await layers.dispose('runtime-dispose');
  };

  return Object.freeze({
    registerService,
    unregisterService,
    getService,
    planQuery,
    executeQuery,
    registerLayer,
    unregisterLayer,
    reconcileLayers,
    createClusterDecision: createClusterDecisionForInput,
    planTerrain,
    recordTerrainFrame,
    setTerrainQuality,
    invalidateServiceCache,
    getSnapshot,
    dispose,
  });
};