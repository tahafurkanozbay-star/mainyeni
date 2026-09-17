import {
  AdaptiveClusterRuntime,
  type AdaptiveClusterInput,
  type AdaptiveClusterResult,
  type AdaptiveClusterConfiguration,
} from './adaptiveClusterRuntime';
import {
  ArcGisQuerySession,
  type ArcGisQueryRequestOptions,
  type ArcGisQuerySessionConfiguration,
  type ArcGisQueryAllResult,
} from './arcgisQuerySessionRuntime';
import {
  RenderParityRuntime,
  type DesiredRenderLayerState,
  type RenderParityResult,
  type RenderReconcileContext,
} from './renderParityRuntime';
import {
  SpatialIntegrityRuntime,
  configurationFromCapabilities,
  type ArcGisFeatureLike,
  type SpatialIntegrityBatchResult,
  type SpatialIntegrityConfiguration,
} from './spatialIntegrityRuntime';
import {
  SpatialWorkloadGovernor,
  type SpatialAdmissionResult,
  type SpatialPerformanceSample,
  type SpatialWorkloadGovernorConfiguration,
  type SpatialWorkloadRequest,
} from './spatialWorkloadGovernor';

export interface ModernGisHardeningConfiguration {
  workload?: SpatialWorkloadGovernorConfiguration;
  clustering?: AdaptiveClusterConfiguration;
  integrity?: SpatialIntegrityConfiguration;
}

export interface RegisteredGisServiceSnapshot {
  key: string;
  serviceUrl: string;
  revision: number;
  disposed: boolean;
  inFlight: number;
}

export interface ModernGisHardeningSnapshot {
  revision: number;
  disposed: boolean;
  services: readonly RegisteredGisServiceSnapshot[];
  cluster: ReturnType<AdaptiveClusterRuntime['snapshot']>;
  integrity: ReturnType<SpatialIntegrityRuntime['snapshot']>;
  render: ReturnType<RenderParityRuntime['snapshot']>;
  workload: ReturnType<SpatialWorkloadGovernor['snapshot']>;
}

export interface SafeQueryAllResult<TFeature extends ArcGisFeatureLike> {
  query: ArcGisQueryAllResult<TFeature>;
  integrity: SpatialIntegrityBatchResult<TFeature>;
  features: readonly TFeature[];
}

interface RegisteredService<TFeature extends ArcGisFeatureLike = ArcGisFeatureLike> {
  key: string;
  session: ArcGisQuerySession<TFeature>;
  integrity: SpatialIntegrityRuntime;
}

const normalizeKey = (value: unknown, label = 'key'): string => {
  const key = String(value ?? '').trim();
  if (!key) throw new Error(`GIS ${label} is required.`);
  return key;
};

const workloadId = (serviceKey: string, operation: string, revision: number): string => (
  `${serviceKey}:${operation}:${revision}`
);

export class ModernGisHardeningRuntime {
  #workload: SpatialWorkloadGovernor;
  #cluster: AdaptiveClusterRuntime;
  #render = new RenderParityRuntime();
  #globalIntegrity: SpatialIntegrityRuntime;
  #services = new Map<string, RegisteredService>();
  #revision = 0;
  #disposed = false;

  constructor(configuration: ModernGisHardeningConfiguration = {}) {
    this.#workload = new SpatialWorkloadGovernor(configuration.workload);
    this.#cluster = new AdaptiveClusterRuntime(configuration.clustering);
    this.#globalIntegrity = new SpatialIntegrityRuntime(configuration.integrity);
  }

  registerService<TFeature extends ArcGisFeatureLike>(
    keyInput: string,
    configuration: ArcGisQuerySessionConfiguration<TFeature>,
    integrityOverrides: SpatialIntegrityConfiguration = {},
  ): ArcGisQuerySession<TFeature> {
    this.#assertActive();
    const key = normalizeKey(keyInput, 'service key');
    if (this.#services.has(key)) {
      throw Object.assign(new Error(`GIS service ${key} is already registered.`), {
        code: 'GIS_SERVICE_ALREADY_REGISTERED',
      });
    }
    const session = new ArcGisQuerySession(configuration);
    const integrity = new SpatialIntegrityRuntime(configurationFromCapabilities(
      session.capabilities,
      integrityOverrides,
    ));
    this.#services.set(key, { key, session, integrity } as RegisteredService);
    this.#revision += 1;
    return session;
  }

  unregisterService(keyInput: string): boolean {
    this.#assertActive();
    const key = normalizeKey(keyInput, 'service key');
    const service = this.#services.get(key);
    if (!service) return false;
    service.session.dispose();
    service.integrity.dispose();
    this.#services.delete(key);
    this.#revision += 1;
    return true;
  }

  getService<TFeature extends ArcGisFeatureLike = ArcGisFeatureLike>(
    keyInput: string,
  ): ArcGisQuerySession<TFeature> | null {
    const key = normalizeKey(keyInput, 'service key');
    return (this.#services.get(key)?.session as ArcGisQuerySession<TFeature> | undefined) ?? null;
  }

  async queryAllSafe<TFeature extends ArcGisFeatureLike>(
    keyInput: string,
    options: ArcGisQueryRequestOptions = {},
  ): Promise<SafeQueryAllResult<TFeature>> {
    this.#assertActive();
    const key = normalizeKey(keyInput, 'service key');
    const service = this.#services.get(key) as RegisteredService<TFeature> | undefined;
    if (!service) {
      throw Object.assign(new Error(`GIS service ${key} is not registered.`), {
        code: 'GIS_SERVICE_NOT_REGISTERED',
      });
    }

    const requestId = workloadId(key, 'query-all', this.#revision + 1);
    const admission = this.#workload.admit({
      id: requestId,
      lane: 'query',
      priority: options.priority === 'background'
        ? 'background'
        : options.priority === 'interactive'
          ? 'interactive'
          : 'normal',
      estimatedBytes: Math.max(1_024, Number(options.maxRecords ?? 1_000) * 256),
      cancellable: true,
    });
    if (admission.decision === 'reject' || admission.decision === 'queue') {
      if (admission.decision === 'queue') this.#workload.cancel(requestId);
      throw Object.assign(new Error(`GIS query workload was not admitted: ${admission.reason}`), {
        code: 'GIS_WORKLOAD_NOT_ADMITTED',
        reason: admission.reason,
      });
    }

    try {
      const query = await service.session.queryAll(options);
      const integrity = service.integrity.inspectBatch(query.features);
      this.#workload.complete(requestId, { success: true });
      this.#revision += 1;
      return Object.freeze({
        query,
        integrity,
        features: integrity.accepted,
      });
    } catch (error) {
      this.#workload.complete(requestId, { success: false });
      throw error;
    }
  }

  inspectFeatures<TFeature extends ArcGisFeatureLike>(
    features: readonly TFeature[],
  ): SpatialIntegrityBatchResult<TFeature> {
    this.#assertActive();
    const result = this.#globalIntegrity.inspectBatch(features);
    this.#revision += 1;
    return result;
  }

  evaluateClusters(input: AdaptiveClusterInput): AdaptiveClusterResult {
    this.#assertActive();
    const requestId = workloadId('cluster', 'evaluate', this.#revision + 1);
    const admission = this.#workload.admit({
      id: requestId,
      lane: 'cluster',
      priority: 'interactive',
      estimatedBytes: Math.max(1_024, input.features.length * 64),
      estimatedCpuMs: Math.max(1, input.features.length / 2_000),
      cancellable: false,
    });
    if (admission.decision === 'reject' || admission.decision === 'queue') {
      if (admission.decision === 'queue') this.#workload.cancel(requestId);
      throw Object.assign(new Error(`Cluster workload was not admitted: ${admission.reason}`), {
        code: 'GIS_CLUSTER_WORKLOAD_NOT_ADMITTED',
      });
    }

    try {
      const result = this.#cluster.evaluate(input);
      this.#workload.complete(requestId, { success: true });
      this.#revision += 1;
      return result;
    } catch (error) {
      this.#workload.complete(requestId, { success: false });
      throw error;
    }
  }

  reconcileLayer(
    desired: DesiredRenderLayerState,
    context: RenderReconcileContext,
  ): RenderParityResult {
    this.#assertActive();
    const result = this.#render.reconcile(desired, context);
    this.#revision += 1;
    return result;
  }

  admitWorkload(request: SpatialWorkloadRequest): SpatialAdmissionResult {
    this.#assertActive();
    return this.#workload.admit(request);
  }

  samplePerformance(sample: SpatialPerformanceSample): ReturnType<SpatialWorkloadGovernor['samplePerformance']> {
    this.#assertActive();
    return this.#workload.samplePerformance(sample);
  }

  snapshot(): ModernGisHardeningSnapshot {
    const services = [...this.#services.values()]
      .map((service) => {
        const snapshot = service.session.snapshot();
        return Object.freeze({
          key: service.key,
          serviceUrl: snapshot.serviceUrl,
          revision: snapshot.revision,
          disposed: snapshot.disposed,
          inFlight: snapshot.inFlight,
        });
      })
      .sort((left, right) => left.key.localeCompare(right.key));

    return Object.freeze({
      revision: this.#revision,
      disposed: this.#disposed,
      services: Object.freeze(services),
      cluster: this.#cluster.snapshot(),
      integrity: this.#globalIntegrity.snapshot(),
      render: this.#render.snapshot(),
      workload: this.#workload.snapshot(),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const service of this.#services.values()) {
      service.session.dispose();
      service.integrity.dispose();
    }
    this.#services.clear();
    this.#cluster.dispose();
    this.#globalIntegrity.dispose();
    this.#workload.dispose();
    this.#render.reset();
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw Object.assign(new Error('Modern GIS hardening runtime has been disposed.'), {
        code: 'MODERN_GIS_RUNTIME_DISPOSED',
      });
    }
  }
}

export const createModernGisHardeningRuntime = (
  configuration: ModernGisHardeningConfiguration = {},
): ModernGisHardeningRuntime => new ModernGisHardeningRuntime(configuration);
